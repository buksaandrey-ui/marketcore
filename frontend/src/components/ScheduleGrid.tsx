import { useEffect, useRef, useState } from 'react'
import { accountsApi, benchmarksApi, schedulesApi, type Account } from '../api'
import './ScheduleGrid.css'

const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'] as const
const HOURS = Array.from({ length: 24 }, (_, i) => i)
const PALETTE = [0, 30, 50, 80, 100, 120, 150, 200]

type Grid = number[][]
type Platform = 'wb' | 'ozon'
type PayModel = 'cpc' | 'cpm'

type Benchmarks = {
  min: number
  competitor: number
  top: number
  aggressive: number
}

type Category = {
  label: string
  tone: 'muted' | 'ok' | 'good' | 'hot' | 'danger'
}

const DEFAULTS: Record<PayModel, { base: number; bench: Benchmarks }> = {
  cpc: { base: 25, bench: { min: 5, competitor: 25, top: 40, aggressive: 80 } },
  cpm: { base: 200, bench: { min: 50, competitor: 180, top: 250, aggressive: 400 } },
}

const PLACEMENTS: Record<Platform, string[]> = {
  wb: ['Поиск', 'Каталог', 'Карточка товара', 'Главная', 'Рекомендации'],
  ozon: ['Поиск', 'Категория', 'Карточка товара', 'Похожие товары'],
}

// Относительная «плотность спроса» 0..100 по часам (0 = спрос отсутствует, 100 = пик)
const DEMAND_WEEKDAY = [
  8, 4, 3, 2, 2, 3, 6, 15, 30, 45, 60, 75, 85, 90, 80, 65, 55, 60, 80, 95, 100, 85, 55, 25,
]
const DEMAND_WEEKEND = [
  15, 8, 5, 3, 3, 4, 5, 10, 18, 30, 45, 60, 75, 80, 78, 72, 70, 75, 85, 90, 85, 75, 55, 30,
]

// Масштаб трафика: сколько показов/кликов в часе-пике (заглушка, потом из бэкенда)
const PEAK_IMPRESSIONS_PER_HOUR = 2000
const PEAK_CLICKS_PER_HOUR = 80

// Допущения по воронке (пока зашиты, потом — из реальных данных аккаунта)
const ASSUMED_CTR = 0.04 // 4% показов → клики (для модели CPM)
const ASSUMED_CR = 0.05 // 5% кликов → заказы
const ASSUMED_AOV = 2000 // средний чек, ₽

function demandAt(d: number, h: number): number {
  const table = d >= 5 ? DEMAND_WEEKEND : DEMAND_WEEKDAY
  return table[h] / 100 // 0..1
}

function makeGrid(value = 100): Grid {
  return DAYS.map(() => HOURS.map(() => value))
}

function cellColor(pct: number): string {
  if (pct === 0) return '#f3f4f6'
  if (pct < 40) return '#e8f5e9'
  if (pct < 70) return '#c8e6c9'
  if (pct < 110) return '#81c784'
  if (pct < 140) return '#ffe082'
  if (pct < 170) return '#ffcc80'
  return '#ffb74d'
}

function textColor(pct: number): string {
  return pct >= 70 && pct < 110 ? '#fff' : '#1f2937'
}

function categorize(price: number, b: Benchmarks): Category {
  if (price <= 0) return { label: 'реклама выключена', tone: 'muted' }
  if (price < b.min) return { label: 'ниже минимума — не пустят в аукцион', tone: 'danger' }
  if (price < b.competitor)
    return { label: 'эконом — ниже средней по конкурентам', tone: 'muted' }
  if (price < b.top) return { label: 'конкурентная — на уровне рынка', tone: 'ok' }
  if (price < b.aggressive) return { label: 'ТОП-10 — сильная позиция', tone: 'good' }
  return { label: 'агрессивная — максимальный охват', tone: 'hot' }
}

type AppliesTo = 'all' | 'skus' | 'category'

const CATEGORIES = [
  'Одежда',
  'Обувь',
  'Электроника',
  'Красота',
  'Дом и сад',
  'Детские товары',
  'Спорт',
  'Продукты',
]

// ─── Предустановленные паттерны расписания ───
type Preset = {
  key: string
  label: string
  hint: string
  make: (current: Grid) => Grid
}

const SCHEDULE_PRESETS: Preset[] = [
  {
    key: 'workday',
    label: '🕐 Рабочее время',
    hint: 'Пн–Пт 9–18 → 100%, вечер → 60%, ночь 0–5 → 0%',
    make: () =>
      DAYS.map((_, d) =>
        HOURS.map((h) => {
          if (h <= 5) return 0
          if (d < 5 && h >= 9 && h <= 18) return 100
          return 60
        })
      ),
  },
  {
    key: 'prime',
    label: '🌆 Вечерний прайм',
    hint: '19–22 → 150%, 10–18 → 100%, остальное → 60%',
    make: () =>
      DAYS.map(() =>
        HOURS.map((h) => {
          if (h <= 5) return 0
          if (h >= 19 && h <= 22) return 150
          if (h >= 10 && h <= 18) return 100
          return 60
        })
      ),
  },
  {
    key: 'weekend',
    label: '📅 Выходные+',
    hint: 'Сб–Вс → 130%, будни → 90%, ночь → 0%',
    make: () =>
      DAYS.map((_, d) =>
        HOURS.map((h) => {
          if (h <= 5) return 0
          return d >= 5 ? 130 : 90
        })
      ),
  },
  {
    key: 'nonight',
    label: '🌙 Без ночи',
    hint: 'Часы 0–5 → 0%, остальные ячейки не трогаем',
    make: (g) => g.map((row) => row.map((v, h) => (h <= 5 ? 0 : v))),
  },
  {
    key: 'peak',
    label: '📈 Двойной пик',
    hint: 'Будни 10–13 и 19–22 → 200%, Сб–Вс 12–20 → 150%, ночь → 0%',
    make: () =>
      DAYS.map((_, d) =>
        HOURS.map((h) => {
          if (h <= 5) return 0
          if (d < 5 && ((h >= 10 && h <= 13) || (h >= 19 && h <= 22))) return 200
          if (d >= 5 && h >= 12 && h <= 20) return 150
          return 80
        })
      ),
  },
]

// ─── Демо-каталог товаров (заглушка, потом придёт с бэкенда) ───
type SkuItem = { id: string; name: string }
const DEMO_CATALOG: SkuItem[] = [
  { id: '12345678', name: 'Кроссовки Nike Air Max 270 белые' },
  { id: '23456789', name: 'Футболка Adidas Originals мужская' },
  { id: '34567890', name: 'Джинсы Levi\'s 501 синие' },
  { id: '45678901', name: 'Куртка зимняя Columbia Omni-Heat' },
  { id: '56789012', name: 'Наушники Sony WH-1000XM5' },
  { id: '67890123', name: 'Смартфон Samsung Galaxy A54' },
  { id: '78901234', name: 'Платье летнее в горошек' },
  { id: '89012345', name: 'Рюкзак городской HIKE 30L серый' },
  { id: '90123456', name: 'Крем для лица SPF50 увлажняющий' },
  { id: '11223344', name: 'Кофе в зёрнах Lavazza 1кг' },
  { id: '22334455', name: 'Игрушка конструктор LEGO City' },
  { id: '33445566', name: 'Книга «Атомные привычки» Джеймс Клир' },
  { id: '44556677', name: 'Кастрюля нержавеющая 5л Tefal' },
  { id: '55667788', name: 'Коврик для йоги 10мм TPE фиолетовый' },
  { id: '66778899', name: 'Протеин Optimum Nutrition Gold Standard' },
]

function searchSkus(query: string): SkuItem[] {
  if (!query.trim()) return []
  const q = query.toLowerCase().trim()
  return DEMO_CATALOG.filter(
    (s) => s.id.includes(q) || s.name.toLowerCase().includes(q)
  ).slice(0, 6)
}

function todayISO(offsetDays = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  return d.toISOString().slice(0, 10)
}

export function ScheduleGrid() {
  const [enabled, setEnabled] = useState(true)
  const [dryRun, setDryRun] = useState(true)
  const [name, setName] = useState<string>('Основной режим')
  const [appliesTo, setAppliesTo] = useState<AppliesTo>('all')
  const [skuList, setSkuList] = useState<string>('')        // ID через запятую (для сохранения)
  const [skuItems, setSkuItems] = useState<SkuItem[]>([])   // выбранные товары (с именами)
  const [skuHasQuery, setSkuHasQuery] = useState(false)     // есть ли текст (для кнопки ✕)
  const [skuDropdown, setSkuDropdown] = useState<SkuItem[]>([])
  const [skuManual, setSkuManual] = useState(false)         // режим ручного ввода
  const skuInputRef = useRef<HTMLInputElement>(null)        // ref вместо controlled value
  const [category, setCategory] = useState<string>(CATEGORIES[0])
  const [periodUnlimited, setPeriodUnlimited] = useState(true)
  const [periodFrom, setPeriodFrom] = useState<string>(todayISO())
  const [periodTo, setPeriodTo] = useState<string>(todayISO(30))
  const [budgetType, setBudgetType] = useState<'daily' | 'weekly'>('daily')
  const [budgetAmount, setBudgetAmount] = useState<number>(3000)
  const [platform, setPlatform] = useState<Platform>('wb')
  const [payModel, setPayModel] = useState<PayModel>('cpm')
  const [placements, setPlacements] = useState<string[]>(['Поиск'])
  const [baseCpm, setBaseCpm] = useState<number>(DEFAULTS.cpm.base)
  const [bench, setBench] = useState<Benchmarks>(DEFAULTS.cpm.bench)
  const [grid, setGrid] = useState<Grid>(() => makeGrid(100))
  const [hover, setHover] = useState<{ d: number; h: number } | null>(null)
  const [activeValue, setActiveValue] = useState<number>(150)
  const [customValue, setCustomValue] = useState<string>('')
  const [painting, setPainting] = useState(false)

  // История для Undo/Redo
  const [past, setPast] = useState<Grid[]>([])
  const [future, setFuture] = useState<Grid[]>([])
  const paintStartSnapshot = useRef<Grid | null>(null)

  // Профили
  // serverId — UUID с сервера (если синхронизировано), иначе только локально
  type Profile = { name: string; state: string; savedAt: number; serverId?: string }
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [profilesOpen, setProfilesOpen] = useState(false)
  const [shareStatus, setShareStatus] = useState<string>('')
  const [syncStatus, setSyncStatus] = useState<string>('')
  const [copySrc, setCopySrc] = useState(0)
  const [benchLoading, setBenchLoading] = useState(false)
  const [benchSource, setBenchSource] = useState<string>('')
  const [apiKeysOpen, setApiKeysOpen] = useState(false)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [selectedAccountId, setSelectedAccountId] = useState<string>('')

  // Статистика
  type StatsPeriod = 'month' | 'quarter' | 'year'
  type StatsMetric = 'orders' | 'revenue' | 'ctr'
  const [statsOpen, setStatsOpen] = useState(false)
  const [statsPeriod, setStatsPeriod] = useState<StatsPeriod>('month')
  const [statsMetric, setStatsMetric] = useState<StatsMetric>('orders')

  const pushHistory = (prev: Grid) => {
    setPast((p) => [...p.slice(-49), prev])
    setFuture([])
  }

  const commitGrid = (updater: (g: Grid) => Grid) => {
    setGrid((g) => {
      const next = updater(g)
      pushHistory(g)
      return next
    })
  }

  const undo = () => {
    setPast((p) => {
      if (p.length === 0) return p
      const prev = p[p.length - 1]
      setFuture((f) => [grid, ...f])
      setGrid(prev)
      return p.slice(0, -1)
    })
  }

  const redo = () => {
    setFuture((f) => {
      if (f.length === 0) return f
      const next = f[0]
      setPast((p) => [...p, grid])
      setGrid(next)
      return f.slice(1)
    })
  }

  useEffect(() => {
    const up = () => {
      if (paintStartSnapshot.current) {
        const snap = paintStartSnapshot.current
        paintStartSnapshot.current = null
        // Зафиксировать историю только если что-то реально изменилось
        setGrid((g) => {
          const changed = snap.some((row, d) => row.some((v, h) => v !== g[d][h]))
          if (changed) pushHistory(snap)
          return g
        })
      }
      setPainting(false)
    }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Горячие клавиши Undo/Redo
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.metaKey || e.ctrlKey
      if (!ctrl) return
      if (e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
      } else if ((e.key === 'z' && e.shiftKey) || e.key === 'y') {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid, past, future])

  // При смене платформы чистим выбранные места показа (у разных платформ разные)
  // и сбрасываем выбранный аккаунт если он не подходит по платформе
  useEffect(() => {
    setPlacements((prev) => prev.filter((p) => PLACEMENTS[platform].includes(p)))
    setSelectedAccountId((id) => {
      const acc = accounts.find((a) => a.id === id)
      return acc && acc.marketplace === platform ? id : ''
    })
  }, [platform, accounts])

  // Загружаем список подключённых аккаунтов при монтировании
  useEffect(() => {
    accountsApi.list().then(setAccounts).catch(() => {})
    // Удаляем старые API-ключи из localStorage если они там ещё есть
    localStorage.removeItem('mc_wb_key')
    localStorage.removeItem('mc_oz_cid')
    localStorage.removeItem('mc_oz_key')
  }, [])

  const switchPayModel = (m: PayModel) => {
    setPayModel(m)
    setBaseCpm(DEFAULTS[m].base)
    setBench(DEFAULTS[m].bench)
  }

  const refreshBenchmarks = async () => {
    if (!selectedAccountId) {
      setApiKeysOpen(true)
      setBenchSource('⚠️ Выбери аккаунт в панели «🔗 Аккаунт для ставок» выше')
      setTimeout(() => setBenchSource(''), 4000)
      return
    }
    setBenchLoading(true)
    setBenchSource('')
    try {
      const result = await benchmarksApi.fetch({
        account_id: selectedAccountId,
        platform,
        pay_model: payModel,
        category,
        placement: placements[0] ?? 'Поиск',
      })
      setBench({ min: result.min, competitor: result.competitor, top: result.top, aggressive: result.aggressive })
      setBaseCpm(result.competitor)
      setBenchSource(result.is_real ? `✅ ${result.source}` : `ℹ️ ${result.source}`)
    } catch {
      setBenchSource('❌ Не удалось загрузить ставки — проверь подключение к серверу')
    } finally {
      setBenchLoading(false)
      setTimeout(() => setBenchSource(''), 7000)
    }
  }

  const togglePlacement = (p: string) => {
    setPlacements((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p],
    )
  }

  // Покраска одной клетки — во время drag-сессии без истории (историю пишем на mouseup)
  const paintCell = (d: number, h: number) => {
    setGrid((g) =>
      g.map((row, di) => (di === d ? row.map((v, hi) => (hi === h ? activeValue : v)) : row)),
    )
  }
  const paintRow = (d: number) =>
    commitGrid((g) => g.map((row, di) => (di === d ? row.map(() => activeValue) : row)))
  const paintCol = (h: number) =>
    commitGrid((g) => g.map((row) => row.map((v, hi) => (hi === h ? activeValue : v))))
  const paintAll = () => commitGrid(() => makeGrid(activeValue))
  const resetAll = () => commitGrid(() => makeGrid(100))

  const copyDay = (src: number, targets: number[]) => {
    commitGrid((g) => g.map((row, di) => (targets.includes(di) ? [...g[src]] : row)))
  }

  // Синхронизация skuItems ↔ skuList (ID через запятую)
  const syncSkuList = (items: SkuItem[]) => {
    setSkuItems(items)
    setSkuList(items.map((s) => s.id).join(', '))
  }

  const addSku = (item: SkuItem) => {
    if (skuItems.some((s) => s.id === item.id)) return
    syncSkuList([...skuItems, item])
    if (skuInputRef.current) skuInputRef.current.value = ''
    setSkuHasQuery(false)
    setSkuDropdown([])
  }

  const removeSku = (id: string) => syncSkuList(skuItems.filter((s) => s.id !== id))

  const applyManualList = (raw: string) => {
    // Парсим вручную введённые ID: берём каждое «слово» из цифр
    const ids = raw.match(/\d{5,}/g) ?? []
    const items = ids.map((id) => {
      const found = DEMO_CATALOG.find((s) => s.id === id)
      return found ?? { id, name: id }
    })
    syncSkuList(items)
  }

  const applyCustom = () => {
    const n = Math.max(0, Math.min(300, Math.round(Number(customValue))))
    if (!Number.isFinite(n)) return
    setActiveValue(n)
    setCustomValue('')
  }

  const pctToPrice = (pct: number) => Math.round((baseCpm * pct) / 100)
  const hoverPrice = hover !== null ? pctToPrice(grid[hover.d][hover.h]) : null
  const hoverCat = hoverPrice !== null ? categorize(hoverPrice, bench) : null
  const activeCat = categorize(pctToPrice(activeValue), bench)

  // Прогноз расходов: суммируем по всем клеткам (demand × pct × ставка)
  const forecast = (() => {
    let spend = 0
    let baseline = 0
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        const demand = demandAt(d, h)
        const pct = grid[d][h] / 100
        if (payModel === 'cpm') {
          const impressions = demand * PEAK_IMPRESSIONS_PER_HOUR
          spend += (impressions / 1000) * baseCpm * pct
          baseline += (impressions / 1000) * baseCpm
        } else {
          const clicks = demand * PEAK_CLICKS_PER_HOUR
          spend += clicks * baseCpm * pct
          baseline += clicks * baseCpm
        }
      }
    }
    return { weekly: Math.round(spend), daily: Math.round(spend / 7), baseline: Math.round(baseline) }
  })()

  const deltaPct = forecast.baseline
    ? Math.round(((forecast.weekly - forecast.baseline) / forecast.baseline) * 100)
    : 0
  const deltaTone: Category['tone'] =
    deltaPct > 10 ? 'hot' : deltaPct > 0 ? 'ok' : deltaPct < -10 ? 'good' : 'muted'
  const deltaLabel =
    deltaPct > 0 ? `на ${deltaPct}% дороже обычного` : deltaPct < 0 ? `на ${Math.abs(deltaPct)}% дешевле обычного` : 'как обычно'

  const budgetRisk =
    budgetAmount > 0 &&
    (budgetType === 'daily' ? forecast.daily > budgetAmount : forecast.weekly > budgetAmount)

  // ─── Mock-данные статистики (заглушка, потом — реальный API) ───
  const generateMockStats = (period: StatsPeriod, metric: StatsMetric): number[][] => {
    const periodMult = period === 'year' ? 52 : period === 'quarter' ? 13 : 4.3
    return DAYS.map((_, d) =>
      HOURS.map((h) => {
        const demand = demandAt(d, h)
        // детерминированный шум — одинаков при каждом рендере
        const noise = 0.65 + 0.7 * ((Math.sin(d * 7.3 + h * 13.1 + 42) + 1) / 2)
        const base = demand * noise
        if (metric === 'orders') return Math.round(base * 18 * periodMult)
        if (metric === 'revenue') return Math.round(base * 18 * ASSUMED_AOV * periodMult)
        return Math.round(base * ASSUMED_CTR * 100 * 10) / 10 // CTR %
      })
    )
  }
  const statsData = generateMockStats(statsPeriod, statsMetric)
  const statsMax = Math.max(...statsData.flat())
  const statsTotal = statsData.flat().reduce((a, b) => a + b, 0)

  const statsColor = (value: number): string => {
    if (statsMax === 0) return '#eff6ff'
    const r = value / statsMax
    if (r < 0.1) return '#eff6ff'
    if (r < 0.25) return '#bfdbfe'
    if (r < 0.45) return '#93c5fd'
    if (r < 0.65) return '#3b82f6'
    if (r < 0.85) return '#1d4ed8'
    return '#1e3a8a'
  }
  const statsTextColor = (value: number): string => {
    if (statsMax === 0) return '#9ca3af'
    return value / statsMax > 0.45 ? '#fff' : '#374151'
  }
  const fmtStats = (v: number): string => {
    if (statsMetric === 'ctr') return v.toFixed(1) + '%'
    if (statsMetric === 'revenue') return v >= 1000 ? Math.round(v / 1000) + 'k' : String(v)
    return String(v)
  }

  // ─── Расчёт сценариев (рекомендации бюджета) ───
  type Scenario = {
    key: string
    name: string
    emoji: string
    mult: number
    recommended?: boolean
    hint: string
  }
  const SCENARIOS: Scenario[] = [
    { key: 'econ', name: 'Эконом', emoji: '💰', mult: 0.6, hint: 'Минимум расходов, только самые горячие часы' },
    { key: 'bal', name: 'Сбалансированный', emoji: '🎯', mult: 1.0, recommended: true, hint: 'Стабильное присутствие в рынке' },
    { key: 'agg', name: 'Агрессивный', emoji: '🚀', mult: 1.5, hint: 'Максимальный охват и ТОП-позиции' },
  ]
  const scenarioMetrics = SCENARIOS.map((s) => {
    const spend = forecast.baseline * s.mult
    let impressions: number
    let clicks: number
    if (payModel === 'cpm') {
      impressions = (spend / baseCpm) * 1000
      clicks = impressions * ASSUMED_CTR
    } else {
      clicks = spend / baseCpm
      impressions = clicks / ASSUMED_CTR
    }
    const orders = clicks * ASSUMED_CR
    const revenue = orders * ASSUMED_AOV
    const roas = spend > 0 ? revenue / spend : 0
    return {
      ...s,
      spend: Math.round(spend),
      daily: Math.round(spend / 7),
      impressions: Math.round(impressions),
      clicks: Math.round(clicks),
      orders: Math.round(orders),
      revenue: Math.round(revenue),
      roas,
    }
  })

  const applyScenarioBudget = (daily: number, weekly: number) => {
    if (budgetType === 'daily') setBudgetAmount(daily)
    else setBudgetAmount(weekly)
  }

  // ─── Сериализация состояния (для профилей и share) ───
  const serializeState = () => ({
    name,
    appliesTo,
    skuList,
    category,
    periodUnlimited,
    periodFrom,
    periodTo,
    budgetType,
    budgetAmount,
    enabled,
    dryRun,
    platform,
    payModel,
    placements,
    baseCpm,
    bench,
    grid,
    activeValue,
  })

  type SavedState = ReturnType<typeof serializeState>

  const applyState = (s: Partial<SavedState>) => {
    if (s.name !== undefined) setName(s.name)
    if (s.appliesTo !== undefined) setAppliesTo(s.appliesTo)
    if (s.skuList !== undefined) {
      setSkuList(s.skuList)
      // Восстанавливаем skuItems из сохранённого списка ID
      const ids = (s.skuList.match(/\d{5,}/g) ?? [])
      setSkuItems(ids.map((id) => DEMO_CATALOG.find((c) => c.id === id) ?? { id, name: id }))
    }
    if (s.category !== undefined) setCategory(s.category)
    if (s.periodUnlimited !== undefined) setPeriodUnlimited(s.periodUnlimited)
    if (s.periodFrom !== undefined) setPeriodFrom(s.periodFrom)
    if (s.periodTo !== undefined) setPeriodTo(s.periodTo)
    if (s.budgetType !== undefined) setBudgetType(s.budgetType)
    if (s.budgetAmount !== undefined) setBudgetAmount(s.budgetAmount)
    if (s.enabled !== undefined) setEnabled(s.enabled)
    if (s.dryRun !== undefined) setDryRun(s.dryRun)
    if (s.platform !== undefined) setPlatform(s.platform)
    if (s.payModel !== undefined) setPayModel(s.payModel)
    if (s.placements !== undefined) setPlacements(s.placements)
    if (s.baseCpm !== undefined) setBaseCpm(s.baseCpm)
    if (s.bench !== undefined) setBench(s.bench)
    if (s.grid !== undefined) setGrid(s.grid)
    if (s.activeValue !== undefined) setActiveValue(s.activeValue)
    setPast([])
    setFuture([])
  }

  // Загрузка профилей из localStorage + с сервера + чтение URL-хэша при монтировании
  useEffect(() => {
    // 1. Сначала грузим локальные профили (мгновенно)
    try {
      const raw = localStorage.getItem('marketcore_schedules')
      if (raw) setProfiles(JSON.parse(raw))
    } catch {}

    // 2. Пробуем подтянуть профили с сервера (если пользователь залогинен)
    schedulesApi.list().then((serverList) => {
      setProfiles((local) => {
        // Мержим: серверные данные перезаписывают локальные с тем же именем
        const merged: Profile[] = [...local]
        for (const s of serverList) {
          const idx = merged.findIndex((p) => p.serverId === s.id || p.name === s.name)
          const entry: Profile = {
            name: s.name,
            state: JSON.stringify(s.schedule_json),
            savedAt: new Date(s.updated_at).getTime(),
            serverId: s.id,
          }
          if (idx >= 0) merged[idx] = entry
          else merged.push(entry)
        }
        try { localStorage.setItem('marketcore_schedules', JSON.stringify(merged)) } catch {}
        return merged
      })
    }).catch(() => { /* сервер недоступен — работаем только локально */ })

    // 3. Читаем URL-хэш (ссылка "Поделиться")
    try {
      const hash = window.location.hash
      if (hash.startsWith('#s=')) {
        const json = atob(decodeURIComponent(hash.slice(3)))
        applyState(JSON.parse(json))
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const persistProfiles = (list: Profile[]) => {
    setProfiles(list)
    try {
      localStorage.setItem('marketcore_schedules', JSON.stringify(list))
    } catch {}
  }

  const saveAsProfile = async () => {
    const pName = prompt('Название профиля:', name) || ''
    if (!pName.trim()) return
    const stateObj = serializeState()
    const json = JSON.stringify(stateObj)
    const existing = profiles.find((p) => p.name === pName)

    // Сохраняем на сервер (если недоступен — только локально)
    let serverId = existing?.serverId
    try {
      if (serverId) {
        const res = await schedulesApi.update(serverId, pName, stateObj as Record<string, unknown>)
        serverId = res.id
      } else {
        const res = await schedulesApi.create(pName, stateObj as Record<string, unknown>)
        serverId = res.id
      }
      setSyncStatus('☁️ Сохранено на сервере')
    } catch {
      setSyncStatus('💾 Сохранено локально (сервер недоступен)')
    }
    setTimeout(() => setSyncStatus(''), 3000)

    const entry: Profile = { name: pName, state: json, savedAt: Date.now(), serverId }
    const next = profiles.map((p) => p.name === pName ? entry : p)
    const updated = next.some((p) => p.name === pName) ? next : [...profiles, entry]
    persistProfiles(updated)
  }

  const loadProfile = (p: Profile) => {
    try {
      applyState(JSON.parse(p.state))
      setProfilesOpen(false)
    } catch {
      alert('Не удалось загрузить профиль')
    }
  }

  const deleteProfile = async (pName: string) => {
    if (!confirm(`Удалить профиль «${pName}»?`)) return
    const target = profiles.find((p) => p.name === pName)
    if (target?.serverId) {
      try {
        await schedulesApi.delete(target.serverId)
      } catch { /* удалим хотя бы локально */ }
    }
    persistProfiles(profiles.filter((p) => p.name !== pName))
  }

  const shareLink = async () => {
    const json = JSON.stringify(serializeState())
    const hash = '#s=' + encodeURIComponent(btoa(json))
    const url = window.location.origin + window.location.pathname + hash
    try {
      await navigator.clipboard.writeText(url)
      setShareStatus('Ссылка скопирована в буфер обмена ✓')
    } catch {
      window.location.hash = hash
      setShareStatus('Ссылка в адресной строке — скопируй её вручную')
    }
    setTimeout(() => setShareStatus(''), 3000)
  }
  const unitLabel = payModel === 'cpc' ? 'за клик' : 'за 1000 показов'
  const baseLabel =
    payModel === 'cpc' ? 'Базовая ставка за клик, ₽' : 'Базовая ставка за 1000 показов, ₽'

  return (
    <div className="schedule" onMouseLeave={() => setPainting(false)}>
      <div className="schedule-header">
        <div className="name-block">
          <input
            className="name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Название расписания"
          />
          <p className="muted">
            Настройте кампанию, выберите кисть и нарисуйте расписание.
          </p>
        </div>
        <div className="header-toggles">
          <div className="toolbar">
            <button
              className="tb-btn"
              onClick={undo}
              disabled={past.length === 0}
              title="Отменить (Cmd/Ctrl+Z)"
            >
              ↶
            </button>
            <button
              className="tb-btn"
              onClick={redo}
              disabled={future.length === 0}
              title="Вернуть (Cmd/Ctrl+Shift+Z)"
            >
              ↷
            </button>
            <div className="profiles-menu">
              <button className="tb-btn" onClick={() => setProfilesOpen((v) => !v)}>
                📁 Профили ({profiles.length})
              </button>
              {profilesOpen && (
                <div className="profiles-popover" onClick={(e) => e.stopPropagation()}>
                  <div className="profiles-header">
                    <b>Мои расписания</b>
                    <button className="tb-btn" onClick={saveAsProfile}>
                      + Сохранить текущее
                    </button>
                  </div>
                  {profiles.length === 0 ? (
                    <div className="muted" style={{ padding: '12px' }}>
                      Сохранённых профилей пока нет.
                    </div>
                  ) : (
                    <ul className="profiles-list">
                      {profiles.map((p) => (
                        <li key={p.name}>
                          <span
                            className="profile-name"
                            onClick={() => loadProfile(p)}
                            title="Кликни — загрузить профиль"
                          >
                            {p.name}
                          </span>
                          <span
                            className={`profile-sync-badge ${p.serverId ? 'synced' : 'local-only'}`}
                            title={p.serverId ? 'Сохранено на сервере' : 'Только локально'}
                          >
                            {p.serverId ? '☁️' : '💾'}
                          </span>
                          <span className="muted profile-date">
                            {new Date(p.savedAt).toLocaleDateString('ru-RU')}
                          </span>
                          <button
                            className="tb-btn tb-danger"
                            onClick={() => deleteProfile(p.name)}
                            title="Удалить"
                          >
                            ✕
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
            <button className="tb-btn" onClick={shareLink} title="Скопировать ссылку со всеми настройками">
              🔗 Поделиться
            </button>
            <button
              className={`tb-btn ${statsOpen ? 'active' : ''}`}
              onClick={() => setStatsOpen((v) => !v)}
              title="Тепловая карта реальных продаж по дням и часам"
            >
              📊 Статистика
            </button>
          </div>
          <label className={`toggle ${dryRun ? 'toggle-warn' : ''}`}>
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
            />
            <span title="В тестовом режиме правила считаются, но реальные ставки на WB/Ozon не меняются">
              {dryRun ? '🧪 Тестовый режим' : '⚡ Боевой режим'}
            </span>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <span>{enabled ? 'Включено' : 'Выключено'}</span>
          </label>
        </div>
      </div>

      <div className="general-settings">
        <div className="setting-group wide">
          <div className="setting-label">Применяется к</div>
          <div className="segmented">
            <button
              className={appliesTo === 'all' ? 'active' : ''}
              onClick={() => setAppliesTo('all')}
            >
              Все товары
            </button>
            <button
              className={appliesTo === 'skus' ? 'active' : ''}
              onClick={() => setAppliesTo('skus')}
            >
              Выбранные SKU
            </button>
            <button
              className={appliesTo === 'category' ? 'active' : ''}
              onClick={() => setAppliesTo('category')}
            >
              Категория
            </button>
          </div>
          {appliesTo === 'skus' && (
            <div className="sku-search-block">
              {/* Строка поиска */}
              <div className="sku-search-wrap">
                <span className="sku-search-icon">🔍</span>
                <input
                  ref={skuInputRef}
                  className="sku-search-input"
                  placeholder="Введи номер артикула или название товара…"
                  onChange={(e) => {
                    const val = e.target.value
                    setSkuHasQuery(val.length > 0)
                    setSkuDropdown(searchSkus(val))
                  }}
                  onCompositionEnd={(e) => {
                    const val = (e.target as HTMLInputElement).value
                    setSkuHasQuery(val.length > 0)
                    setSkuDropdown(searchSkus(val))
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && skuDropdown.length > 0) {
                      addSku(skuDropdown[0])
                    }
                    if (e.key === 'Escape') {
                      if (skuInputRef.current) skuInputRef.current.value = ''
                      setSkuHasQuery(false)
                      setSkuDropdown([])
                    }
                  }}
                  autoComplete="off"
                />
                {skuHasQuery && (
                  <button className="sku-search-clear" onClick={() => {
                    if (skuInputRef.current) skuInputRef.current.value = ''
                    setSkuHasQuery(false)
                    setSkuDropdown([])
                  }}>✕</button>
                )}
              </div>

              {/* Выпадающий список результатов */}
              {skuDropdown.length > 0 && (
                <ul className="sku-dropdown">
                  {skuDropdown.map((item) => (
                    <li
                      key={item.id}
                      className={`sku-dropdown-item ${skuItems.some((s) => s.id === item.id) ? 'already' : ''}`}
                      onClick={() => addSku(item)}
                    >
                      <span className="sku-dd-id">{item.id}</span>
                      <span className="sku-dd-name">{item.name}</span>
                      {skuItems.some((s) => s.id === item.id) && <span className="sku-dd-added">✓ добавлен</span>}
                    </li>
                  ))}
                </ul>
              )}

              {/* Чипсы выбранных товаров */}
              {skuItems.length > 0 && (
                <div className="sku-chips">
                  {skuItems.map((item) => (
                    <span key={item.id} className="sku-chip">
                      <span className="sku-chip-name" title={`Артикул: ${item.id}`}>{item.name !== item.id ? item.name : item.id}</span>
                      <span className="sku-chip-id">{item.id}</span>
                      <button className="sku-chip-remove" onClick={() => removeSku(item.id)}>✕</button>
                    </span>
                  ))}
                  <button className="sku-clear-all" onClick={() => syncSkuList([])}>Очистить всё</button>
                </div>
              )}

              {/* Ручной ввод */}
              <button className="sku-manual-toggle" onClick={() => setSkuManual((v) => !v)}>
                {skuManual ? '▲ Скрыть' : '▼ Вставить списком'}
              </button>
              {skuManual && (
                <div className="sku-manual-wrap">
                  <textarea
                    className="sku-input"
                    rows={2}
                    placeholder="Вставь артикулы через запятую или с новой строки:&#10;12345678, 23456789, 34567890"
                    defaultValue=""
                    onBlur={(e) => { applyManualList(e.target.value); e.target.value = '' }}
                  />
                  <span className="muted" style={{ fontSize: 11 }}>Нажми Tab или кликни в другое место — артикулы добавятся к выбранным</span>
                </div>
              )}
            </div>
          )}
          {appliesTo === 'category' && (
            <select
              className="category-select"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="setting-group">
          <div className="setting-label">Период действия</div>
          <div className="period-row">
            <label className="inline-check">
              <input
                type="checkbox"
                checked={periodUnlimited}
                onChange={(e) => setPeriodUnlimited(e.target.checked)}
              />
              <span>Бессрочно</span>
            </label>
            {!periodUnlimited && (
              <>
                <input
                  type="date"
                  value={periodFrom}
                  onChange={(e) => setPeriodFrom(e.target.value)}
                />
                <span className="muted">—</span>
                <input
                  type="date"
                  value={periodTo}
                  onChange={(e) => setPeriodTo(e.target.value)}
                />
              </>
            )}
          </div>
        </div>

        <div className="setting-group">
          <div className="setting-label">
            Бюджет, ₽{' '}
            <span
              className="hint-icon"
              title="0 = без ограничения. При достижении лимита реклама автоматически остановится."
            >
              ℹ︎
            </span>
          </div>
          <div className="budget-row">
            <div className="segmented">
              <button
                className={budgetType === 'daily' ? 'active' : ''}
                onClick={() => setBudgetType('daily')}
              >
                в день
              </button>
              <button
                className={budgetType === 'weekly' ? 'active' : ''}
                onClick={() => setBudgetType('weekly')}
              >
                в неделю
              </button>
            </div>
            <input
              type="number"
              min={0}
              value={budgetAmount}
              onChange={(e) => setBudgetAmount(Number(e.target.value) || 0)}
              className="budget-input"
            />
          </div>
        </div>
      </div>

      <div className="campaign-settings">
        <div className="setting-group">
          <div className="setting-label">Площадка</div>
          <div className="segmented">
            <button
              className={platform === 'wb' ? 'active' : ''}
              onClick={() => setPlatform('wb')}
            >
              Wildberries
            </button>
            <button
              className={platform === 'ozon' ? 'active' : ''}
              onClick={() => setPlatform('ozon')}
            >
              Ozon
            </button>
          </div>
        </div>

        <div className="setting-group">
          <div className="setting-label">
            Модель оплаты{' '}
            <span className="hint-icon" title="CPC — платишь за клик. CPM — за 1000 показов.">
              ℹ︎
            </span>
          </div>
          <div className="segmented">
            <button
              className={payModel === 'cpc' ? 'active' : ''}
              onClick={() => switchPayModel('cpc')}
              title="Cost Per Click — оплата за клик"
            >
              CPC (за клик)
            </button>
            <button
              className={payModel === 'cpm' ? 'active' : ''}
              onClick={() => switchPayModel('cpm')}
              title="Cost Per Mille — оплата за 1000 показов"
            >
              CPM (за 1000 показов)
            </button>
          </div>
        </div>

        <div className="setting-group wide">
          <div className="setting-label">
            Места показа ({placements.length} выбрано)
          </div>
          <div className="checks">
            {PLACEMENTS[platform].map((p) => (
              <label key={p} className={`check ${placements.includes(p) ? 'checked' : ''}`}>
                <input
                  type="checkbox"
                  checked={placements.includes(p)}
                  onChange={() => togglePlacement(p)}
                />
                <span>{p}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* ─── Аккаунт для получения ставок ─── */}
      <div className="api-keys-panel">
        <button className="api-keys-toggle" onClick={() => setApiKeysOpen((v) => !v)}>
          🔗 Аккаунт для ставок {apiKeysOpen ? '▲' : '▼'}
        </button>
        {apiKeysOpen && (
          <div className="api-keys-body">
            {accounts.filter((a) => a.marketplace === platform).length === 0 ? (
              <p className="muted api-keys-hint">
                Нет подключённых аккаунтов {platform.toUpperCase()}.
                Подключи аккаунт в разделе <strong>🏪 Аккаунты</strong>, затем вернись сюда.
              </p>
            ) : (
              <label className="api-key-field">
                <span>Аккаунт {platform.toUpperCase()}</span>
                <select
                  value={selectedAccountId}
                  onChange={(e) => setSelectedAccountId(e.target.value)}
                  style={{ background: '#0f172a', color: '#f1f5f9', border: '1px solid #334155', borderRadius: 6, padding: '6px 10px', fontSize: 13 }}
                >
                  <option value="">— Выбери аккаунт —</option>
                  {accounts
                    .filter((a) => a.marketplace === platform)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} {a.status === 'active' ? '✅' : '⏳'}
                      </option>
                    ))}
                </select>
              </label>
            )}
            <p className="muted api-keys-hint">
              🔒 API-ключи хранятся только на сервере в зашифрованном виде. После выбора аккаунта нажми «🔄 Обновить ставки».
            </p>
          </div>
        )}
      </div>

      <div className="benchmarks">
        <div className="bench-header">
          <span className="palette-label">Ориентиры рынка, ₽ ({unitLabel}):</span>
          <div className="bench-refresh">
            <button
              className={`bench-refresh-btn ${benchLoading ? 'loading' : ''}`}
              onClick={refreshBenchmarks}
              disabled={benchLoading}
              title="Подтянуть реальные ставки с площадки"
            >
              {benchLoading ? '⏳' : '🔄'} {benchLoading ? 'Загружаю...' : 'Обновить ставки'}
            </button>
          </div>
        </div>
        {benchSource && (
          <div className={`bench-source ${benchSource.startsWith('✅') ? 'real' : benchSource.startsWith('❌') ? 'error' : 'fallback'}`}>
            {benchSource}
          </div>
        )}
        <div className="bench-fields">
          <label className="bench-field">
            <span>Минимум</span>
            <input
              type="number"
              value={bench.min}
              onChange={(e) => setBench({ ...bench, min: Number(e.target.value) || 0 })}
            />
          </label>
          <label className="bench-field">
            <span>Средний конкурент</span>
            <input
              type="number"
              value={bench.competitor}
              onChange={(e) => setBench({ ...bench, competitor: Number(e.target.value) || 0 })}
            />
          </label>
          <label className="bench-field">
            <span>ТОП-10</span>
            <input
              type="number"
              value={bench.top}
              onChange={(e) => setBench({ ...bench, top: Number(e.target.value) || 0 })}
            />
          </label>
          <label className="bench-field">
            <span>Агрессивная</span>
            <input
              type="number"
              value={bench.aggressive}
              onChange={(e) => setBench({ ...bench, aggressive: Number(e.target.value) || 0 })}
            />
          </label>
        </div>
      </div>

      <div className="palette">
        <span className="palette-label">Кисть:</span>
        {PALETTE.map((v) => {
          const price = pctToPrice(v)
          const cat = categorize(price, bench)
          return (
            <button
              key={v}
              className={`swatch ${activeValue === v ? 'active' : ''}`}
              style={{ background: cellColor(v), color: textColor(v) }}
              onClick={() => setActiveValue(v)}
              title={`${v}% × ${baseCpm}₽ = ${price}₽ ${unitLabel} — ${cat.label}`}
            >
              <div className="swatch-pct">{v}%</div>
              <div className="swatch-cpm">{price}₽</div>
              <div className={`swatch-cat tone-${cat.tone}`}>{cat.label}</div>
            </button>
          )
        })}
        <span className="palette-custom">
          <input
            type="number"
            placeholder="своё"
            min={0}
            max={300}
            value={customValue}
            onChange={(e) => setCustomValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && applyCustom()}
            style={{ width: 70 }}
          />
          <button onClick={applyCustom}>OK</button>
        </span>
      </div>

      <div className="active-row">
        Текущая кисть: <b>{activeValue}%</b> = <b>{pctToPrice(activeValue)} ₽</b> {unitLabel}
        {' — '}
        <span className={`tag tone-${activeCat.tone}`}>{activeCat.label}</span>
      </div>

      {shareStatus && <div className="share-status">{shareStatus}</div>}
      {syncStatus && <div className="sync-status">{syncStatus}</div>}

      <div className="copy-panel">
        <span className="palette-label">Скопировать день →</span>
        <label className="inline-check" style={{ gap: 4 }}>
          <span className="muted">Источник:</span>
          <select
            value={copySrc}
            onChange={(e) => setCopySrc(Number(e.target.value))}
            className="category-select"
            style={{ width: 'auto', margin: 0, padding: '4px 8px' }}
          >
            {DAYS.map((d, i) => (
              <option key={d} value={i}>{d}</option>
            ))}
          </select>
        </label>
        <button onClick={() => copyDay(copySrc, [0, 1, 2, 3, 4].filter((i) => i !== copySrc))}>
          → Все будни (Пн–Пт)
        </button>
        <button onClick={() => copyDay(copySrc, [5, 6].filter((i) => i !== copySrc))}>
          → Выходные (Сб–Вс)
        </button>
        <button onClick={() => copyDay(copySrc, [0, 1, 2, 3, 4, 5, 6].filter((i) => i !== copySrc))}>
          → Все дни
        </button>
        <button onClick={() => copyDay(copySrc, [(copySrc + 1) % 7])}>
          → Следующий день
        </button>
      </div>

      {statsOpen && (
        <div className="stats-panel">
          <div className="stats-header">
            <b>📊 Статистика продаж</b>
            <span className="stats-demo-badge">Демо-данные</span>
            <div className="stats-controls">
              <div className="segmented">
                {(['month', 'quarter', 'year'] as const).map((p) => (
                  <button key={p} className={statsPeriod === p ? 'active' : ''} onClick={() => setStatsPeriod(p)}>
                    {p === 'month' ? 'Месяц' : p === 'quarter' ? 'Квартал' : 'Год'}
                  </button>
                ))}
              </div>
              <div className="segmented">
                {(['orders', 'revenue', 'ctr'] as const).map((m) => (
                  <button key={m} className={statsMetric === m ? 'active' : ''} onClick={() => setStatsMetric(m)}>
                    {m === 'orders' ? 'Заказы' : m === 'revenue' ? 'Выручка' : 'CTR'}
                  </button>
                ))}
              </div>
              <span className="muted stats-total">
                Итого: {statsMetric === 'revenue'
                  ? statsTotal.toLocaleString('ru-RU') + ' ₽'
                  : statsMetric === 'ctr'
                  ? (statsTotal / 168).toFixed(1) + '% avg'
                  : statsTotal.toLocaleString('ru-RU')}
              </span>
            </div>
          </div>
          <div className="grid-wrapper stats-grid-wrapper">
            <table className="grid stats-grid">
              <thead>
                <tr>
                  <th className="corner" />
                  {HOURS.map((h) => (
                    <th key={h} className="hour-head">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {DAYS.map((day, d) => (
                  <tr key={day}>
                    <th className="day-head">{day}</th>
                    {HOURS.map((h) => {
                      const v = statsData[d][h]
                      return (
                        <td
                          key={h}
                          className="cell"
                          style={{ background: statsColor(v), color: statsTextColor(v) }}
                          title={`${day} ${h}:00 — ${fmtStats(v)}`}
                        >
                          {fmtStats(v)}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="stats-legend">
            <span className="muted">меньше</span>
            {['#eff6ff','#bfdbfe','#93c5fd','#3b82f6','#1d4ed8','#1e3a8a'].map((c) => (
              <span key={c} className="stats-legend-dot" style={{ background: c }} />
            ))}
            <span className="muted">больше</span>
          </div>
        </div>
      )}

      <div className="presets-panel">
        <span className="palette-label">Готовые паттерны:</span>
        {SCHEDULE_PRESETS.map((p) => (
          <button
            key={p.key}
            className="preset-btn"
            title={p.hint}
            onClick={() => commitGrid((g) => p.make(g))}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="schedule-controls">
        <label>
          {baseLabel}:{' '}
          <input
            type="number"
            min={0}
            value={baseCpm}
            onChange={(e) => setBaseCpm(Number(e.target.value) || 0)}
            style={{ width: 90 }}
          />
        </label>
        <div className="presets">
          <button onClick={resetAll}>Сбросить всё к 100%</button>
          <button onClick={paintAll}>Залить всё кистью ({activeValue}%)</button>
        </div>
      </div>

      <div
        className="grid-wrapper"
        style={{ opacity: enabled ? 1 : 0.4, pointerEvents: enabled ? 'auto' : 'none' }}
      >
        <table className="grid">
          <thead>
            <tr>
              <th
                className="corner clickable"
                title="Клик — залить всю таблицу кистью"
                onClick={paintAll}
              >
                ⬛
              </th>
              {HOURS.map((h) => (
                <th
                  key={h}
                  className="hour-head clickable"
                  title={`Клик — залить всю колонку ${h}:00 кистью ${activeValue}%`}
                  onClick={() => paintCol(h)}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DAYS.map((day, d) => (
              <tr key={day}>
                <th
                  className="day-head clickable"
                  title={`Клик — залить всю строку ${day} кистью ${activeValue}%`}
                  onClick={() => paintRow(d)}
                >
                  {day}
                </th>
                {HOURS.map((h) => {
                  const pct = grid[d][h]
                  const demand = demandAt(d, h)
                  return (
                    <td
                      key={h}
                      className="cell"
                      style={{ background: cellColor(pct), color: textColor(pct) }}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        paintStartSnapshot.current = grid.map((row) => [...row])
                        setPainting(true)
                        paintCell(d, h)
                      }}
                      onMouseEnter={() => {
                        setHover({ d, h })
                        if (painting) paintCell(d, h)
                      }}
                      onMouseLeave={() => setHover(null)}
                      title={`Спрос: ${Math.round(demand * 100)}%`}
                    >
                      <div
                        className="demand-bar"
                        style={{ width: `${Math.round(demand * 100)}%` }}
                      />
                      {pct}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="forecast">
        <div className="forecast-main">
          <div className="forecast-label">Прогноз расходов</div>
          <div className="forecast-value">
            ~{forecast.weekly.toLocaleString('ru-RU')} ₽ / неделя
          </div>
          <div className="forecast-sub muted">
            ≈ {forecast.daily.toLocaleString('ru-RU')} ₽/день
            {budgetRisk && (
              <span className="tag tone-danger" style={{ marginLeft: 8 }}>
                ⚠ превышает {budgetType === 'daily' ? 'дневной' : 'недельный'} бюджет ({budgetAmount.toLocaleString('ru-RU')} ₽)
              </span>
            )}
          </div>
        </div>
        <div className="forecast-compare">
          <div className="forecast-label">Сравнение с «обычным»</div>
          <div className={`tag tone-${deltaTone} forecast-delta`}>
            {deltaPct > 0 ? '▲' : deltaPct < 0 ? '▼' : '●'} {deltaLabel}
          </div>
          <div className="forecast-sub muted">
            Обычное = то же расписание, но со всеми клетками 100% ({forecast.baseline.toLocaleString('ru-RU')} ₽/нед)
          </div>
        </div>
      </div>

      <div className="recommendations">
        <span className="palette-label">Бюджетные сценарии:</span>
        <span className="muted" style={{ fontSize: 12 }}>
          CTR {Math.round(ASSUMED_CTR * 100)}% · CR {Math.round(ASSUMED_CR * 100)}% · чек {ASSUMED_AOV}₽
        </span>
        <div className="scenario-chips">
          {scenarioMetrics.map((s) => (
            <button
              key={s.key}
              className={`scenario-chip ${s.recommended ? 'recommended' : ''}`}
              onClick={() => applyScenarioBudget(s.daily, s.spend)}
              title={[
                s.hint,
                `Показы: ${s.impressions.toLocaleString('ru-RU')}`,
                `Клики: ${s.clicks.toLocaleString('ru-RU')}`,
                `Заказы: ${s.orders.toLocaleString('ru-RU')}`,
                `Выручка: ${s.revenue.toLocaleString('ru-RU')} ₽`,
                `ROAS: ${s.roas.toFixed(1)}×`,
              ].join('\n')}
            >
              <span className="chip-emoji">{s.emoji}</span>
              <span className="chip-name">{s.name}</span>
              <span className="chip-budget">{s.spend.toLocaleString('ru-RU')} ₽/нед</span>
              <span className={`chip-roas tone-${s.roas >= 3 ? 'good' : s.roas >= 1.5 ? 'ok' : 'danger'}`}>
                ROAS {s.roas.toFixed(1)}×
              </span>
              {s.recommended && <span className="chip-star">★</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="hover-info">
        {hover && hoverCat ? (
          <>
            <b>
              {DAYS[hover.d]}, {hover.h}:00
            </b>
            {' — '}
            {grid[hover.d][hover.h]}% × {baseCpm} ₽ = <b>{hoverPrice} ₽</b> {unitLabel}
            {' · '}
            <span className={`tag tone-${hoverCat.tone}`}>{hoverCat.label}</span>
          </>
        ) : (
          <span className="muted">
            Наведи на клетку — увидишь итоговую ставку и куда она попадает относительно рынка.
            Зажми и протяни — покрасишь сразу несколько клеток.
          </span>
        )}
      </div>
    </div>
  )
}
