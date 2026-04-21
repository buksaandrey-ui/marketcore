import { useState, useMemo } from 'react'
import { SKUS, WB_COMMISSION, BUYOUT_RATE, wbLogistics, totalSpend } from '../data/demo'
import './UnitEcon.css'

// ─── Налоговые системы ────────────────────────────────────────────────────────

type TaxSystem = 'usn6' | 'usn15' | 'self'
const TAX_LABELS: Record<TaxSystem, string> = {
  usn6:  'УСН 6% (с выручки)',
  usn15: 'УСН 15% (доходы − расходы)',
  self:  'Самозанятый 6%',
}

// ─── Расчёт экономики ─────────────────────────────────────────────────────────

function calcUnit(params: {
  price: number; cogs: number; weightKg: number; volumeLiters: number
  category: string; taxSystem: TaxSystem; buyoutPct: number; drrPct: number
  storageDays: number; platform: 'wb' | 'ozon'
}) {
  const {
    price, cogs, weightKg, volumeLiters,
    category, taxSystem, buyoutPct, drrPct, storageDays,
  } = params

  const buyout        = buyoutPct / 100
  const commRate      = (WB_COMMISSION[category] ?? 12) / 100
  const logFwd        = wbLogistics(weightKg)
  const logRet        = 60                              // стоимость возврата
  const commission    = price * commRate                // комиссия WB
  const logEffective  = (logFwd + logRet * (1 - buyout)) / buyout  // на 1 продажу
  const storagePerUnit = volumeLiters * 0.07 * storageDays          // хранение за период
  const promoSpend    = price * (drrPct / 100)          // рекламные расходы
  const grossBeforeTax = price - commission - logEffective - cogs - storagePerUnit - promoSpend

  let tax = 0
  if (taxSystem === 'usn6')  tax = Math.max(0, price * 0.06)
  if (taxSystem === 'usn15') tax = Math.max(0, (price - commission - logEffective - cogs) * 0.15)
  if (taxSystem === 'self')  tax = Math.max(0, price * 0.06)

  const netProfit   = grossBeforeTax - tax
  const margin      = (netProfit / price) * 100
  const roi         = cogs > 0 ? (netProfit / cogs) * 100 : 0
  const breakeven   = price - netProfit  // сумма всех затрат = точка безубыточности цена

  return { commission, logFwd, logRet, logEffective, storagePerUnit, promoSpend, tax, netProfit, margin, roi, breakeven, grossBeforeTax }
}

// ─── Водопад (Waterfall chart) ────────────────────────────────────────────────

type WFRow = { label: string; value: number; color: string; isTotal?: boolean }

function Waterfall({ rows, price }: { rows: WFRow[]; price: number }) {
  const maxAbs = Math.max(...rows.map(r => Math.abs(r.value)), price)
  return (
    <div className="waterfall">
      {rows.map((row) => {
        const pct = Math.abs(row.value) / maxAbs * 100
        const isPos = row.value >= 0
        return (
          <div key={row.label} className={`wf-row ${row.isTotal ? 'wf-total' : ''}`}>
            <div className="wf-label">{row.label}</div>
            <div className="wf-bar-wrap">
              <div
                className="wf-bar"
                style={{
                  width: `${pct}%`,
                  background: row.color,
                  marginLeft: isPos ? 0 : undefined,
                }}
              />
            </div>
            <div className={`wf-value ${isPos ? 'pos' : 'neg'}`}>
              {isPos ? '+' : ''}₽ {Math.abs(row.value).toLocaleString('ru', { maximumFractionDigits: 0 })}
            </div>
            <div className="wf-pct">
              {isPos ? '+' : ''}{((row.value / price) * 100).toFixed(1)}%
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Основной компонент ───────────────────────────────────────────────────────

export function UnitEcon() {
  // Выбор SKU или ручной ввод
  const [selectedSkuId, setSelectedSkuId] = useState<string>('__manual__')

  // Входные параметры
  const [price,       setPrice]       = useState(5000)
  const [cogs,        setCogs]        = useState(1500)
  const [weightKg,    setWeightKg]    = useState(0.8)
  const [volumeL,     setVolumeL]     = useState(2.0)
  const [category,    setCategory]    = useState('Обувь')
  const [taxSystem,   setTaxSystem]   = useState<TaxSystem>('usn6')
  const [buyoutPct,   setBuyoutPct]   = useState(55)
  const [drrPct,      setDrrPct]      = useState(10)
  const [storageDays, setStorageDays] = useState(30)
  const [platform]                    = useState<'wb' | 'ozon'>('wb')

  // Загрузка параметров из выбранного SKU
  const handleSkuSelect = (id: string) => {
    setSelectedSkuId(id)
    if (id === '__manual__') return
    const sku = SKUS.find(s => s.id === id)
    if (!sku) return
    setPrice(sku.price)
    setCogs(sku.cogs)
    setWeightKg(sku.weightKg)
    setCategory(sku.category)
    setBuyoutPct(BUYOUT_RATE[sku.category] ?? 70)
    const spend = totalSpend(sku.promo)
    setDrrPct(Math.round((spend / sku.revenue) * 100))
  }

  // Расчёт
  const result = useMemo(() => calcUnit({
    price, cogs, weightKg, volumeLiters: volumeL,
    category, taxSystem, buyoutPct, drrPct, storageDays, platform,
  }), [price, cogs, weightKg, volumeL, category, taxSystem, buyoutPct, drrPct, storageDays, platform])

  const { commission, logEffective, storagePerUnit, promoSpend, tax, netProfit, margin, roi } = result

  // Ряды для водопада
  const wfRows: WFRow[] = [
    { label: 'Цена продажи',        value: price,            color: '#22c55e' },
    { label: `Комиссия WB ${WB_COMMISSION[category] ?? 12}%`, value: -commission,  color: '#ef4444' },
    { label: 'Логистика (с возвратами)', value: -logEffective,color: '#f97316' },
    { label: 'Себестоимость',        value: -cogs,            color: '#f43f5e' },
    { label: 'Хранение',             value: -storagePerUnit,  color: '#a855f7' },
    { label: `Реклама ДРР ${drrPct}%`,  value: -promoSpend,  color: '#ec4899' },
    { label: `Налог (${TAX_LABELS[taxSystem].split(' ')[0]})`, value: -tax, color: '#64748b' },
    { label: 'Чистая прибыль',       value: netProfit,        color: netProfit >= 0 ? '#16a34a' : '#dc2626', isTotal: true },
  ]

  // Прогноз на месяц
  const selectedSku = SKUS.find(s => s.id === selectedSkuId)
  const monthlyOrders = selectedSku ? selectedSku.orders : Math.round(price > 0 ? 5000 / price * 10 : 50)
  const monthlyProfit = netProfit * monthlyOrders

  return (
    <div className="ue-page">
      <div className="ue-header">
        <h1 className="ue-title">📐 Юнит-экономика</h1>
        <p className="ue-subtitle">Полный расчёт прибыльности с учётом всех расходов</p>
      </div>

      <div className="ue-body">

        {/* ── Левая панель: ввод ───────────────────────────── */}
        <div className="ue-inputs">

          {/* Выбор SKU */}
          <div className="ue-section">
            <div className="ue-section-title">Товар</div>
            <select className="ue-select" value={selectedSkuId} onChange={e => handleSkuSelect(e.target.value)}>
              <option value="__manual__">— Ввести вручную —</option>
              {SKUS.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>

          {/* Основные параметры */}
          <div className="ue-section">
            <div className="ue-section-title">Параметры</div>
            <div className="ue-fields">

              <div className="ue-field">
                <label>Площадка</label>
                <div className="ue-platform-tabs">
                  <span className="ue-platform-tab active">WB</span>
                  <span className="ue-platform-tab disabled">Ozon</span>
                </div>
              </div>

              <div className="ue-field">
                <label>Категория</label>
                <select className="ue-select-sm" value={category} onChange={e => {
                  setCategory(e.target.value)
                  setBuyoutPct(BUYOUT_RATE[e.target.value] ?? 70)
                }}>
                  {Object.keys(WB_COMMISSION).map(c => <option key={c}>{c}</option>)}
                </select>
              </div>

              <div className="ue-field">
                <label>Цена продажи, ₽</label>
                <input className="ue-input" type="number" min={1} value={price}
                  onChange={e => setPrice(Number(e.target.value))} />
              </div>

              <div className="ue-field">
                <label>Себестоимость, ₽</label>
                <input className="ue-input" type="number" min={0} value={cogs}
                  onChange={e => setCogs(Number(e.target.value))} />
              </div>

              <div className="ue-field">
                <label>Вес товара, кг</label>
                <input className="ue-input" type="number" min={0.1} step={0.1} value={weightKg}
                  onChange={e => setWeightKg(Number(e.target.value))} />
              </div>

              <div className="ue-field">
                <label>Объём (для хранения), л</label>
                <input className="ue-input" type="number" min={0.1} step={0.1} value={volumeL}
                  onChange={e => setVolumeL(Number(e.target.value))} />
              </div>

              <div className="ue-field">
                <label>Дней на складе</label>
                <input className="ue-input" type="number" min={1} value={storageDays}
                  onChange={e => setStorageDays(Number(e.target.value))} />
              </div>
            </div>
          </div>

          {/* Финансовые параметры */}
          <div className="ue-section">
            <div className="ue-section-title">Финансы</div>
            <div className="ue-fields">

              <div className="ue-field full">
                <label>Система налогообложения</label>
                <div className="ue-tax-tabs">
                  {(Object.entries(TAX_LABELS) as [TaxSystem, string][]).map(([k, v]) => (
                    <button key={k} className={`ue-tax-tab ${taxSystem===k?'active':''}`}
                      onClick={() => setTaxSystem(k)}>
                      {v}
                    </button>
                  ))}
                </div>
              </div>

              <div className="ue-field">
                <label>% выкупа <span className="ue-hint">(по категории)</span></label>
                <div className="ue-slider-wrap">
                  <input type="range" min={10} max={100} value={buyoutPct}
                    onChange={e => setBuyoutPct(Number(e.target.value))} />
                  <span className="ue-slider-val">{buyoutPct}%</span>
                </div>
              </div>

              <div className="ue-field">
                <label>ДРР (реклама), % от выручки</label>
                <div className="ue-slider-wrap">
                  <input type="range" min={0} max={50} value={drrPct}
                    onChange={e => setDrrPct(Number(e.target.value))} />
                  <span className="ue-slider-val">{drrPct}%</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Правая панель: результат ─────────────────────── */}
        <div className="ue-results">

          {/* Метрики */}
          <div className="ue-metrics">
            <div className={`ue-metric ${netProfit >= 0 ? 'ok' : 'bad'}`}>
              <span className="ue-metric-label">Чистая прибыль / ед</span>
              <span className="ue-metric-value">
                {netProfit >= 0 ? '+' : ''}₽ {Math.abs(netProfit).toLocaleString('ru', { maximumFractionDigits: 0 })}
              </span>
            </div>
            <div className={`ue-metric ${margin >= 15 ? 'ok' : margin >= 0 ? 'warn' : 'bad'}`}>
              <span className="ue-metric-label">Маржа</span>
              <span className="ue-metric-value">{margin.toFixed(1)}%</span>
            </div>
            <div className={`ue-metric ${roi >= 30 ? 'ok' : roi >= 0 ? 'warn' : 'bad'}`}>
              <span className="ue-metric-label">ROI</span>
              <span className="ue-metric-value">{roi.toFixed(0)}%</span>
            </div>
            <div className="ue-metric neutral">
              <span className="ue-metric-label">Прибыль / месяц</span>
              <span className="ue-metric-value">
                {monthlyProfit >= 0 ? '+' : ''}₽ {Math.abs(monthlyProfit).toLocaleString('ru', { maximumFractionDigits: 0 })}
              </span>
            </div>
          </div>

          {/* Водопад */}
          <div className="ue-waterfall-wrap">
            <div className="ue-section-title" style={{ marginBottom: 12 }}>Разбивка по статьям</div>
            <Waterfall rows={wfRows} price={price} />
          </div>

          {/* Точка безубыточности */}
          <div className="ue-breakeven">
            <div className="ue-be-label">Точка безубыточности (мин. цена продажи)</div>
            <div className="ue-be-value">₽ {(price - netProfit).toLocaleString('ru', { maximumFractionDigits: 0 })}</div>
            <div className="ue-be-sub">
              Текущая цена выше точки безубыточности на{' '}
              <b>₽ {Math.max(0, netProfit).toLocaleString('ru', { maximumFractionDigits: 0 })}</b>
            </div>
          </div>

          {/* Комиссия и условия */}
          <div className="ue-conditions">
            <div className="ue-cond-title">Условия WB (категория: {category})</div>
            <div className="ue-cond-row"><span>Комиссия</span><b>{WB_COMMISSION[category] ?? 12}%</b></div>
            <div className="ue-cond-row"><span>Логистика (прямая)</span><b>₽ {wbLogistics(weightKg)}</b></div>
            <div className="ue-cond-row"><span>Логистика (возврат)</span><b>₽ 60</b></div>
            <div className="ue-cond-row"><span>% выкупа (типичный)</span><b>{BUYOUT_RATE[category] ?? 70}%</b></div>
            <div className="ue-cond-row"><span>Хранение (за период)</span><b>₽ {storagePerUnit.toFixed(0)}</b></div>
          </div>
        </div>
      </div>
    </div>
  )
}
