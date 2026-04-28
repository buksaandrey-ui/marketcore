import { useState, useEffect } from 'react'
import {
  SKUS, totalSpend,
  type SkuItem, type PromoSpend,
} from '../data/demo'
import { analyticsApi, type DashboardSummary, type PayoutsData } from '../api'
import './Dashboard.css'

type Period = 'today' | 'yesterday' | '7d' | 'month' | 'custom'
const PERIOD_LABELS: Record<Period, string> = {
  today:     'Сегодня',
  yesterday: 'Вчера',
  '7d':      '7 дней',
  month:     'Месяц',
  custom:    'Свой период',
}

// ─── Вспомогательные функции ─────────────────────────────────────────────────

const drrToOrders  = (row: SkuItem) => (totalSpend(row.promo) / row.ordersSum) * 100
const drrToRevenue = (row: SkuItem) => (totalSpend(row.promo) / row.revenue)   * 100
const fmt          = (n: number)    => n.toLocaleString('ru')
const fmtPct       = (n: number)    => n.toFixed(1) + '%'
const drrClass     = (v: number)    => v < 10 ? 'drr-ok' : v < 15 ? 'drr-warn' : 'drr-bad'

// ─── Агрегация по категориям ─────────────────────────────────────────────────

type CatRow = { category: string; ordersSum: number; revenue: number; promo: PromoSpend; skuCount: number }

function buildCategories(): CatRow[] {
  const map = new Map<string, CatRow>()
  for (const s of SKUS) {
    const e = map.get(s.category)
    if (!e) {
      map.set(s.category, { category: s.category, ordersSum: s.ordersSum, revenue: s.revenue, promo: { ...s.promo }, skuCount: 1 })
    } else {
      e.ordersSum += s.ordersSum; e.revenue += s.revenue
      e.promo.cpm += s.promo.cpm; e.promo.cpc += s.promo.cpc
      e.promo.subscription += s.promo.subscription; e.promo.extra += s.promo.extra
      e.skuCount++
    }
  }
  return Array.from(map.values()).sort((a, b) => totalSpend(b.promo) - totalSpend(a.promo))
}
const CATEGORIES = buildCategories()

// Глобальные суммы
const totalOrders    = SKUS.reduce((s, r) => s + r.orders, 0)
const totalOrdersSum = SKUS.reduce((s, r) => s + r.ordersSum, 0)
const totalRevenue   = SKUS.reduce((s, r) => s + r.revenue, 0)
const totalPromo     = SKUS.reduce((s, r) => s + totalSpend(r.promo), 0)
const totalCpm       = SKUS.reduce((s, r) => s + r.promo.cpm, 0)
const totalCpc       = SKUS.reduce((s, r) => s + r.promo.cpc, 0)
const totalSub       = SKUS.reduce((s, r) => s + r.promo.subscription, 0)
const totalExtra     = SKUS.reduce((s, r) => s + r.promo.extra, 0)
const totalCtr       = SKUS.reduce((s, r) => s + r.ctr, 0) / SKUS.length
const globalDrrO     = (totalPromo / totalOrdersSum) * 100
const globalDrrR     = (totalPromo / totalRevenue)   * 100

// ─── Donut-диаграмма ─────────────────────────────────────────────────────────

function Donut({ cpm, cpc, subscription, extra }: PromoSpend) {
  const total = cpm + cpc + subscription + extra
  const p = (v: number) => (v / total) * 100
  const p1 = p(cpm), p2 = p(cpc), p3 = p(subscription)
  const gradient = `conic-gradient(#38bdf8 0% ${p1}%,#818cf8 ${p1}% ${p1+p2}%,#34d399 ${p1+p2}% ${p1+p2+p3}%,#fb923c ${p1+p2+p3}% 100%)`
  return (
    <div className="donut-wrap">
      <div className="donut-ring" style={{ background: gradient }}>
        <div className="donut-hole">
          <span className="donut-total">₽{fmt(total)}</span>
          <span className="donut-label">расходы</span>
        </div>
      </div>
      <div className="donut-legend">
        {[['#38bdf8','CPM',cpm],['#818cf8','CPC',cpc],['#34d399','Подписка',subscription],['#fb923c','Доп.',extra]].map(([color, label, val]) => (
          <div key={label as string} className="legend-item">
            <span className="dot" style={{ background: color as string }} />
            {label as string} <b>{p(val as number).toFixed(0)}%</b>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Основной компонент ───────────────────────────────────────────────────────

type DrrView  = 'total' | 'category' | 'sku'
type SortKey  = 'ordersSum' | 'revenue' | 'spend' | 'drrOrders' | 'drrRevenue' | 'stock' | 'ctr'

export function Dashboard() {
  const [drrView, setDrrView] = useState<DrrView>('total')
  const [search,  setSearch]  = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('revenue')
  const [sortAsc, setSortAsc] = useState(false)
  const [realData, setRealData] = useState<DashboardSummary | null>(null)
  const [payouts, setPayouts] = useState<PayoutsData | null>(null)
  const [payoutsLoading, setPayoutsLoading] = useState(false)
  const [loading, setLoading] = useState(false)

  const [period, setPeriod] = useState<Period>('month')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo,   setCustomTo]   = useState('')

  const loadData = (p: Period, from?: string, to?: string) => {
    setLoading(true)
    const params: { period: string; date_from?: string; date_to?: string } = { period: p }
    if (p === 'custom' && from && to) { params.date_from = from; params.date_to = to }
    analyticsApi.dashboard(params).then(setRealData).catch(() => {}).finally(() => setLoading(false))
    // Начисления грузим параллельно — медленный запрос к WB API
    setPayouts(null)
    setPayoutsLoading(true)
    analyticsApi.payouts(params).then(setPayouts).catch(() => setPayouts(null)).finally(() => setPayoutsLoading(false))
  }

  useEffect(() => { loadData('month') }, [])

  const handlePeriod = (p: Period) => {
    setPeriod(p)
    if (p !== 'custom') loadData(p)
  }

  const handleCustomApply = () => {
    if (customFrom && customTo) loadData('custom', customFrom, customTo)
  }

  const ordersCount = realData?.has_data ? realData.orders_count ?? 0 : totalOrders
  const revenue     = realData?.has_data ? realData.revenue      ?? 0 : totalRevenue
  const drrO        = realData?.has_data ? realData.drr_to_orders ?? 0 : globalDrrO
  const drrR        = realData?.has_data ? realData.drr_to_revenue ?? 0 : globalDrrR
  const isDemo      = !realData?.has_data

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(v => !v)
    else { setSortKey(key); setSortAsc(false) }
  }
  const arr = (key: SortKey) => sortKey === key ? (sortAsc ? ' ↑' : ' ↓') : ''

  const getSortVal = (r: SkuItem): number => {
    if (sortKey === 'ordersSum')  return r.ordersSum
    if (sortKey === 'revenue')    return r.revenue
    if (sortKey === 'spend')      return totalSpend(r.promo)
    if (sortKey === 'drrOrders')  return drrToOrders(r)
    if (sortKey === 'drrRevenue') return drrToRevenue(r)
    if (sortKey === 'stock')      return r.stock
    if (sortKey === 'ctr')        return r.ctr
    return 0
  }

  const filtered = SKUS
    .filter(s => s.name.toLowerCase().includes(search.toLowerCase()) || s.id.includes(search) || s.category.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => sortAsc ? getSortVal(a) - getSortVal(b) : getSortVal(b) - getSortVal(a))

  return (
    <div className="dash">

      {/* ── Выбор периода ─────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {(Object.keys(PERIOD_LABELS) as Period[]).map(p => (
          <button
            key={p}
            onClick={() => handlePeriod(p)}
            style={{
              padding: '6px 14px', borderRadius: 6, fontSize: 13, cursor: 'pointer',
              border: period === p ? '1px solid #6366f1' : '1px solid #e2e8f0',
              background: period === p ? '#6366f1' : '#fff',
              color: period === p ? '#fff' : '#374151',
              fontWeight: period === p ? 700 : 400,
            }}
          >
            {PERIOD_LABELS[p]}
          </button>
        ))}
        {period === 'custom' && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
              style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13 }} />
            <span style={{ color: '#6b7280' }}>—</span>
            <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)}
              style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13 }} />
            <button onClick={handleCustomApply}
              style={{ padding: '5px 12px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, cursor: 'pointer' }}>
              Применить
            </button>
          </div>
        )}
        {loading && <span style={{ color: '#9ca3af', fontSize: 13 }}>Загрузка…</span>}
      </div>

      {isDemo && (
        <div style={{ background: '#1e3a2e', border: '1px solid #166534', borderRadius: 8, padding: '10px 16px', marginBottom: 16, color: '#86efac', fontSize: 13 }}>
          📊 Показаны демо-данные. Подключи реальный аккаунт в разделе <strong>🏪 Аккаунты</strong> для отображения твоей статистики.
        </div>
      )}
      {!isDemo && (
        <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, padding: '10px 16px', marginBottom: 16, fontSize: 12, color: '#78350f', lineHeight: 1.6 }}>
          <b>📐 Формулы расчёта:</b><br/>
          <b>Оплатили покупатели</b> = <code>finishedPrice × кол-во</code> — сумма после скидки продавца <em>и</em> скидки СПП. Отменённые заказы исключены.<br/>
          <b>Начислено WB</b> = <code>ppvz_for_pay</code> из финансового отчёта WB = Выручка − комиссия WB − логистика − хранение. Только завершённые расчёты (WB закрывает их раз в неделю, по понедельникам).<br/>
          <span style={{ color: '#92400e' }}>⚠ Если числа расходятся с WB-кабинетом — это нормально: WB в кабинете показывает «Сумму заказов» (до СПП), а мы — «Оплачено покупателями» (после СПП).</span>
        </div>
      )}

      {/* ── KPI ──────────────────────────────────────────────── */}
      <div className="kpi-row">
        <div className="kpi-card">
          <div className="kpi-top"><span className="kpi-icon">📦</span><span className="kpi-label">Заказы</span></div>
          <div className="kpi-value">{fmt(ordersCount)} <span className="kpi-unit">шт</span></div>
          <div className="kpi-sub" title="Количество оформленных заказов за период">всего оформлено</div>
          {isDemo && <div className="kpi-delta pos">▲ 12.4% vs вчера</div>}
        </div>
        <div className="kpi-card">
          <div className="kpi-top"><span className="kpi-icon">💳</span><span className="kpi-label">Оплатили покупатели</span></div>
          <div className="kpi-value">₽ {fmt(revenue)}</div>
          <div className="kpi-sub" title="finishedPrice × количество = цена после скидки продавца + скидка СПП. Именно эту сумму заплатили покупатели.">
            finishedPrice · с учётом СПП ℹ
          </div>
          {isDemo && <div className="kpi-delta pos">▲ 8.1% vs вчера</div>}
        </div>
        {!isDemo && (
          <div className="kpi-card" title="ppvz_for_pay из WB финансового отчёта = Выручка − комиссия WB − логистика − хранение. WB закрывает расчёты раз в неделю — данные за текущую неделю появятся в понедельник.">
            <div className="kpi-top"><span className="kpi-icon">🏦</span><span className="kpi-label">Начислено WB</span></div>
            {payoutsLoading ? (
              <div className="kpi-value" style={{ fontSize: 14, color: '#9ca3af' }}>загрузка…</div>
            ) : payouts?.has_data ? (
              <div className="kpi-value">₽ {fmt(payouts.payout_sum)}</div>
            ) : payouts && !payouts.has_data && !payouts.api_error ? (
              <div>
                <div className="kpi-value" style={{ fontSize: 18 }}>₽ 0</div>
                <div style={{ fontSize: 11, color: '#f59e0b', marginTop: 2 }}>
                  WB закрывает отчёт по пн — данные появятся после расчёта
                </div>
              </div>
            ) : (
              <div className="kpi-value" style={{ fontSize: 13, color: '#9ca3af' }}>
                {payouts?.api_error ? '⚠ ошибка API' : 'нет данных'}
              </div>
            )}
            <div className="kpi-sub">ppvz_for_pay · после комиссии WB ℹ</div>
          </div>
        )}
        {isDemo && (
          <div className="kpi-card">
            <div className="kpi-top"><span className="kpi-icon">👆</span><span className="kpi-label">CTR средний</span></div>
            <div className="kpi-value">{totalCtr.toFixed(1)} <span className="kpi-unit">%</span></div>
            <div className="kpi-sub">По всем SKU</div>
            <div className="kpi-delta neg">▼ 0.3 пп vs вчера</div>
          </div>
        )}
        <div className="kpi-card kpi-drr">
          <div className="kpi-top"><span className="kpi-icon">📊</span><span className="kpi-label">ДРР (полный)</span></div>
          <div className="kpi-drr-split">
            <div className="kpi-drr-col">
              <span className="kpi-drr-sublabel">к заказам</span>
              <span className={`kpi-drr-val ${drrClass(drrO)}`}>{fmtPct(drrO)}</span>
              {isDemo && <span className="kpi-delta neg" style={{ fontSize: 11 }}>▲ 0.9 пп</span>}
            </div>
            <div className="kpi-drr-divider" />
            <div className="kpi-drr-col">
              <span className="kpi-drr-sublabel">к выручке</span>
              <span className={`kpi-drr-val ${drrClass(drrR)}`}>{fmtPct(drrR)}</span>
              {isDemo && <span className="kpi-delta neg" style={{ fontSize: 11 }}>▲ 1.1 пп</span>}
            </div>
          </div>
          {isDemo && (
            <>
              <div className="kpi-drr-bar">
                {[
                  { v: totalCpm,   c: '#38bdf8' },
                  { v: totalCpc,   c: '#818cf8' },
                  { v: totalSub,   c: '#34d399' },
                  { v: totalExtra, c: '#fb923c' },
                ].map(({ v, c }) => (
                  <div key={c} className="kpi-drr-bar-seg" style={{ width: `${(v/totalPromo)*100}%`, background: c }} />
                ))}
              </div>
              <div className="kpi-drr-bar-labels">
                {[['#38bdf8','CPM'],['#818cf8','CPC'],['#34d399','Подписка'],['#fb923c','Доп.']].map(([c,l]) => (
                  <span key={l} style={{ color: c }}>{l}</span>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── ДРР Аналитика (только демо) ─────────────────────── */}
      {isDemo && <div className="drr-widget">
        <div className="drr-widget-header">
          <h2 className="drr-widget-title">📊 ДРР: Полная аналитика</h2>
          <div className="drr-tabs">
            {(['total','category','sku'] as DrrView[]).map(v => (
              <button key={v} className={`drr-tab ${drrView===v?'active':''}`} onClick={() => setDrrView(v)}>
                {v==='total'?'Все товары':v==='category'?'По категориям':'По SKU'}
              </button>
            ))}
          </div>
        </div>
        <div className="drr-widget-body">
          <Donut cpm={totalCpm} cpc={totalCpc} subscription={totalSub} extra={totalExtra} />
          <div className="drr-detail">

            {drrView === 'total' && (
              <table className="drr-table">
                <thead><tr><th>Статья расходов</th><th>Сумма</th><th>Доля</th><th>ДРР к заказам</th><th>ДРР к выручке</th></tr></thead>
                <tbody>
                  {[
                    { label:'Реклама CPM', value:totalCpm,   color:'#38bdf8' },
                    { label:'Реклама CPC', value:totalCpc,   color:'#818cf8' },
                    { label:'Подписка',    value:totalSub,   color:'#34d399' },
                    { label:'Доп. услуги', value:totalExtra, color:'#fb923c' },
                  ].map(r => (
                    <tr key={r.label}>
                      <td><span className="dot" style={{ background: r.color }} />{r.label}</td>
                      <td className="num">₽ {fmt(r.value)}</td>
                      <td className="num">{((r.value/totalPromo)*100).toFixed(0)}%</td>
                      <td className="num">{fmtPct((r.value/totalOrdersSum)*100)}</td>
                      <td className="num">{fmtPct((r.value/totalRevenue)*100)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="drr-total-row">
                    <td><b>ИТОГО</b></td>
                    <td className="num"><b>₽ {fmt(totalPromo)}</b></td>
                    <td className="num"><b>100%</b></td>
                    <td className={`num ${drrClass(globalDrrO)}-text`}><b>{fmtPct(globalDrrO)}</b></td>
                    <td className={`num ${drrClass(globalDrrR)}-text`}><b>{fmtPct(globalDrrR)}</b></td>
                  </tr>
                </tfoot>
              </table>
            )}

            {drrView === 'category' && (
              <table className="drr-table">
                <thead><tr><th>Категория</th><th>SKU</th><th>Расходы</th><th>ДРР к заказам</th><th>ДРР к выручке</th></tr></thead>
                <tbody>
                  {CATEGORIES.map(cat => {
                    const spend = totalSpend(cat.promo)
                    const dO = (spend/cat.ordersSum)*100
                    const dR = (spend/cat.revenue)*100
                    return (
                      <tr key={cat.category}>
                        <td><b>{cat.category}</b></td>
                        <td className="num">{cat.skuCount}</td>
                        <td className="num">₽ {fmt(spend)}</td>
                        <td className={`num ${drrClass(dO)}-text`}>{fmtPct(dO)}</td>
                        <td className={`num ${drrClass(dR)}-text`}>{fmtPct(dR)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}

            {drrView === 'sku' && (
              <table className="drr-table drr-table-sku">
                <thead><tr><th>Товар</th><th>Расходы</th><th>ДРР к заказам</th><th>ДРР к выручке</th></tr></thead>
                <tbody>
                  {[...SKUS].sort((a,b) => drrToRevenue(b)-drrToRevenue(a)).map(row => {
                    const spend = totalSpend(row.promo)
                    const dO = drrToOrders(row), dR = drrToRevenue(row)
                    return (
                      <tr key={row.id}>
                        <td>
                          <div className="sku-name-sm">{row.name}</div>
                          <div className="sku-id-sm">#{row.id} · {row.category}</div>
                        </td>
                        <td className="num">₽ {fmt(spend)}</td>
                        <td className={`num ${drrClass(dO)}-text`}>{fmtPct(dO)}</td>
                        <td className={`num ${drrClass(dR)}-text`}>{fmtPct(dR)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>}

      {/* ── Таблица SKU (демо) ───────────────────────────────── */}
      {isDemo && <div className="sku-table-wrap">
        <div className="sku-table-header">
          <h2 className="sku-table-title">Товары</h2>
          <div className="sku-search-box">
            <span className="sku-search-ico">🔍</span>
            <input className="sku-search-inp" placeholder="Поиск по названию, категории или артикулу…"
              value={search} onChange={e => setSearch(e.target.value)} />
            {search && <button className="sku-search-x" onClick={() => setSearch('')}>✕</button>}
          </div>
        </div>
        <div className="sku-table-scroll">
          <table className="sku-table">
            <thead>
              <tr>
                <th className="col-name">Товар</th>
                <th className="col-num sortable" onClick={() => handleSort('ordersSum')}>Сумма заказов{arr('ordersSum')}</th>
                <th className="col-num sortable" onClick={() => handleSort('revenue')}>Выручка{arr('revenue')}</th>
                <th className="col-num sortable" onClick={() => handleSort('stock')}>Остаток{arr('stock')}</th>
                <th className="col-num sortable" onClick={() => handleSort('ctr')}>CTR{arr('ctr')}</th>
                <th className="col-num sortable" onClick={() => handleSort('spend')}>Расходы{arr('spend')}</th>
                <th className="col-num sortable" onClick={() => handleSort('drrOrders')}>ДРР/заказы{arr('drrOrders')}</th>
                <th className="col-num sortable" onClick={() => handleSort('drrRevenue')}>ДРР/выручка{arr('drrRevenue')}</th>
                <th className="col-status">Статус</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(row => {
                const dO = drrToOrders(row), dR = drrToRevenue(row)
                return (
                  <tr key={row.id} className={`sku-row status-${row.status}`}>
                    <td className="col-name">
                      <div className="sku-name">{row.name}</div>
                      <div className="sku-id">#{row.id} · {row.category}</div>
                    </td>
                    <td className="col-num">₽ {fmt(row.ordersSum)}</td>
                    <td className="col-num">₽ {fmt(row.revenue)}</td>
                    <td className={`col-num ${row.stock===0?'zero-stock':row.stock<10?'low-stock':''}`}>
                      {row.stock===0?'⚠ 0':row.stock}
                    </td>
                    <td className="col-num">{row.ctr}%</td>
                    <td className="col-num">₽ {fmt(totalSpend(row.promo))}</td>
                    <td className={`col-num ${drrClass(dO)}-text`}>{fmtPct(dO)}</td>
                    <td className={`col-num ${drrClass(dR)}-text`}>{fmtPct(dR)}</td>
                    <td className="col-status">
                      <span className={`status-badge ${row.status}`}>
                        {row.status==='ok'?'✓ Норма':row.status==='warn'?'⚠ Внимание':'✕ Проблема'}
                      </span>
                    </td>
                  </tr>
                )
              })}
              {filtered.length===0 && <tr><td colSpan={9} className="no-results">Ничего не найдено</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="sku-table-footer">
          Показано {filtered.length} из {SKUS.length} товаров ·
          Расходы на продвижение: ₽ {fmt(totalPromo)} ·
          ДРР к выручке: <b>{fmtPct(globalDrrR)}</b> · Данные демо
        </div>
      </div>}

      {/* ── Топ товаров (реальные данные) ────────────────────── */}
      {!isDemo && realData?.top_skus && realData.top_skus.length > 0 && (
        <div className="sku-table-wrap">
          <div className="sku-table-header">
            <h2 className="sku-table-title">Топ товаров</h2>
          </div>
          <div className="sku-table-scroll">
            <table className="sku-table">
              <thead>
                <tr>
                  <th className="col-name">Товар / SKU</th>
                  <th className="col-num">Заказов</th>
                  <th className="col-num">Выручка</th>
                </tr>
              </thead>
              <tbody>
                {realData.top_skus.map(s => (
                  <tr key={s.sku} className="sku-row status-ok">
                    <td className="col-name">
                      {s.name
                        ? <><div className="sku-name">{s.name}</div><div className="sku-id">#{s.sku}</div></>
                        : <div className="sku-name">#{s.sku}</div>
                      }
                    </td>
                    <td className="col-num">{s.orders_count} шт</td>
                    <td className="col-num">₽ {fmt(s.revenue ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="sku-table-footer">
            Топ-20 товаров за период · реальные данные
            {!realData.top_skus[0]?.name && (
              <span style={{ color: '#f59e0b', marginLeft: 8 }}>
                · Нажми «Синхронизировать» в Аккаунтах для загрузки названий
              </span>
            )}
          </div>
        </div>
      )}
      {!isDemo && (!realData?.top_skus || realData.top_skus.length === 0) && (
        <div style={{ background: '#f8fafc', borderRadius: 10, padding: 32, textAlign: 'center', color: '#64748b', border: '1px dashed #cbd5e1' }}>
          Нет данных по товарам. Нажми <strong>Синхронизировать</strong> в разделе <strong>🏪 Аккаунты</strong>.
        </div>
      )}
    </div>
  )
}
