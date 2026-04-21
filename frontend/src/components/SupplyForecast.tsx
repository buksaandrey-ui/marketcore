import { useState, useMemo } from 'react'
import { SKUS, SEASONAL_COEFF } from '../data/demo'
import './SupplyForecast.css'

// ─── Симуляция исторических продаж ───────────────────────────────────────────
// Детерминированная псевдо-рандомизация (без Math.random() — стабильные данные)

function fakeDailySales(skuId: string, dailyAvg: number, daysBack: number): number[] {
  return Array.from({ length: daysBack }, (_, i) => {
    const seed = (skuId.charCodeAt(i % skuId.length) * (i + 1)) % 17
    const noise = 0.7 + (seed / 17) * 0.6  // 0.7 – 1.3
    return Math.max(0, Math.round(dailyAvg * noise))
  })
}

function velocity(sales: number[], days: number): number {
  const slice = sales.slice(0, days)
  return slice.reduce((s, v) => s + v, 0) / days
}

// ─── Расчёт прогноза ─────────────────────────────────────────────────────────

const currentMonth = new Date().getMonth() + 1  // 1-12

function calcForecast(sku: typeof SKUS[0], leadDays: number, safetyDays: number) {
  const dailyAvg30 = sku.orders / 30
  const history    = fakeDailySales(sku.id, dailyAvg30, 30)

  const vel7   = velocity(history, 7)
  const vel14  = velocity(history, 14)
  const vel30  = velocity(history, 30)

  const seasonCoeff    = SEASONAL_COEFF[currentMonth] ?? 1.0
  const nextMonthCoeff = SEASONAL_COEFF[(currentMonth % 12) + 1] ?? 1.0
  const adjVel         = vel30 * seasonCoeff      // скорость с сезонной поправкой

  const daysUntilOOS   = adjVel > 0 ? Math.floor(sku.stock / adjVel) : 999
  const neededQty      = Math.max(0, Math.ceil(adjVel * (leadDays + safetyDays) - sku.stock))
  const neededQtyNext  = Math.ceil(adjVel * nextMonthCoeff * safetyDays)

  let status: 'critical' | 'soon' | 'ok' | 'overstock'
  if (sku.stock === 0)         status = 'critical'
  else if (daysUntilOOS <= leadDays) status = 'critical'
  else if (daysUntilOOS <= leadDays + safetyDays) status = 'soon'
  else if (sku.stock > adjVel * 90) status = 'overstock'
  else status = 'ok'

  return { vel7, vel14, vel30, adjVel, seasonCoeff, daysUntilOOS, neededQty, neededQtyNext, status }
}

// ─── Сезонный календарь ───────────────────────────────────────────────────────

const MONTH_NAMES = ['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек']

function SeasonCalendar() {
  return (
    <div className="season-calendar">
      <div className="season-title">Сезонные коэффициенты по месяцам</div>
      <div className="season-grid">
        {Object.entries(SEASONAL_COEFF).map(([m, coeff]) => {
          const month = Number(m)
          const isCurrent = month === currentMonth
          const level = coeff >= 1.3 ? 'hot' : coeff >= 1.05 ? 'warm' : coeff < 0.85 ? 'cold' : 'neutral'
          return (
            <div key={m} className={`season-cell ${level} ${isCurrent ? 'current' : ''}`}>
              <div className="season-month">{MONTH_NAMES[month - 1]}</div>
              <div className="season-coeff">×{coeff.toFixed(2)}</div>
              <div className="season-bar">
                <div className="season-bar-fill" style={{ height: `${Math.min(100, coeff * 60)}%` }} />
              </div>
            </div>
          )
        })}
      </div>
      <div className="season-legend">
        <span className="sl hot">🔥 Всплеск (×1.3+)</span>
        <span className="sl warm">↑ Рост (×1.05–1.3)</span>
        <span className="sl neutral">→ Норма</span>
        <span className="sl cold">↓ Спад (&lt;×0.85)</span>
      </div>
    </div>
  )
}

// ─── Основной компонент ───────────────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  critical:  '🔴 Срочно',
  soon:      '🟡 Скоро',
  ok:        '🟢 Норма',
  overstock: '🔵 Избыток',
}

export function SupplyForecast() {
  const [leadDays,   setLeadDays]   = useState(14)
  const [safetyDays, setSafetyDays] = useState(21)
  const [filterStatus, setFilterStatus] = useState<string>('all')
  const [search, setSearch] = useState('')

  const rows = useMemo(() =>
    SKUS.map(sku => ({ sku, ...calcForecast(sku, leadDays, safetyDays) })),
    [leadDays, safetyDays]
  )

  const filtered = rows
    .filter(r => filterStatus === 'all' || r.status === filterStatus)
    .filter(r =>
      r.sku.name.toLowerCase().includes(search.toLowerCase()) ||
      r.sku.id.includes(search)
    )
    .sort((a, b) => a.daysUntilOOS - b.daysUntilOOS)

  const criticalCount = rows.filter(r => r.status === 'critical').length
  const soonCount     = rows.filter(r => r.status === 'soon').length
  const overstockCount = rows.filter(r => r.status === 'overstock').length

  const totalNeeded   = rows.reduce((s, r) => s + r.neededQty, 0)
  const seasonCoeff   = SEASONAL_COEFF[currentMonth] ?? 1.0

  return (
    <div className="sf-page">
      <div className="sf-header">
        <div>
          <h1 className="sf-title">📦 Прогноз поставок</h1>
          <p className="sf-subtitle">Скорость продаж · Дней до обнуления · Рекомендации по заказу</p>
        </div>
        <div className="sf-season-badge">
          <span className="sf-sb-label">Сейчас ({MONTH_NAMES[currentMonth-1]})</span>
          <span className={`sf-sb-coeff ${seasonCoeff >= 1.1 ? 'hot' : seasonCoeff < 0.9 ? 'cold' : 'neutral'}`}>
            ×{seasonCoeff.toFixed(2)}
          </span>
        </div>
      </div>

      {/* Сводка */}
      <div className="sf-summary">
        <div className="sf-sum-card critical">
          <span className="sf-sum-num">{criticalCount}</span>
          <span className="sf-sum-label">Срочно заказать</span>
        </div>
        <div className="sf-sum-card soon">
          <span className="sf-sum-num">{soonCount}</span>
          <span className="sf-sum-label">Скоро закончится</span>
        </div>
        <div className="sf-sum-card overstock">
          <span className="sf-sum-num">{overstockCount}</span>
          <span className="sf-sum-label">Избыток на складе</span>
        </div>
        <div className="sf-sum-card total">
          <span className="sf-sum-num">{totalNeeded.toLocaleString('ru')}</span>
          <span className="sf-sum-label">Единиц к заказу (итого)</span>
        </div>
      </div>

      {/* Настройки */}
      <div className="sf-controls">
        <div className="sf-control-group">
          <label>Срок поставки (дней)</label>
          <div className="sf-ctrl-row">
            <input type="range" min={3} max={60} value={leadDays}
              onChange={e => setLeadDays(Number(e.target.value))} />
            <span className="sf-ctrl-val">{leadDays} дн</span>
          </div>
        </div>
        <div className="sf-control-group">
          <label>Страховой запас (дней)</label>
          <div className="sf-ctrl-row">
            <input type="range" min={7} max={90} value={safetyDays}
              onChange={e => setSafetyDays(Number(e.target.value))} />
            <span className="sf-ctrl-val">{safetyDays} дн</span>
          </div>
        </div>
        <div className="sf-control-group">
          <label>Поиск</label>
          <input className="sf-search" placeholder="Название или артикул…"
            value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="sf-filter-tabs">
          {[
            ['all',       'Все'],
            ['critical',  '🔴 Срочно'],
            ['soon',      '🟡 Скоро'],
            ['ok',        '🟢 Норма'],
            ['overstock', '🔵 Избыток'],
          ].map(([v, l]) => (
            <button key={v} className={`sf-filter-tab ${filterStatus===v?'active':''}`}
              onClick={() => setFilterStatus(v)}>
              {l}
            </button>
          ))}
        </div>
      </div>

      {/* Таблица */}
      <div className="sf-table-wrap">
        <table className="sf-table">
          <thead>
            <tr>
              <th>Товар</th>
              <th>Остаток</th>
              <th>Скорость 7д</th>
              <th>Скорость 14д</th>
              <th>Скорость 30д</th>
              <th>С сез. коэфф.</th>
              <th>Дней до нуля</th>
              <th>К заказу</th>
              <th>Статус</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(({ sku, vel7, vel14, vel30, adjVel, daysUntilOOS, neededQty, status }) => (
              <tr key={sku.id} className={`sf-row sf-row-${status}`}>
                <td className="sf-col-name">
                  <div className="sf-sku-name">{sku.name}</div>
                  <div className="sf-sku-id">#{sku.id} · {sku.category}</div>
                </td>
                <td className={`sf-num ${sku.stock === 0 ? 'zero' : sku.stock < 10 ? 'low' : ''}`}>
                  {sku.stock === 0 ? '⚠ 0' : sku.stock}
                </td>
                <td className="sf-num">{vel7.toFixed(1)}/д</td>
                <td className="sf-num">{vel14.toFixed(1)}/д</td>
                <td className="sf-num">{vel30.toFixed(1)}/д</td>
                <td className="sf-num sf-adj">
                  {adjVel.toFixed(1)}/д
                  <span className="sf-coeff-tag">×{SEASONAL_COEFF[currentMonth]?.toFixed(2)}</span>
                </td>
                <td className={`sf-num sf-days sf-days-${status}`}>
                  {daysUntilOOS >= 999 ? '∞' : daysUntilOOS}
                </td>
                <td className={`sf-num sf-order ${neededQty > 0 ? 'needed' : ''}`}>
                  {neededQty > 0 ? `+${neededQty}` : '—'}
                </td>
                <td>
                  <span className={`sf-badge sf-badge-${status}`}>{STATUS_LABEL[status]}</span>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={9} className="sf-empty">Нет товаров по фильтру</td></tr>
            )}
          </tbody>
        </table>
        <div className="sf-footer">
          Показано {filtered.length} из {SKUS.length} ·
          Срок поставки: {leadDays} дн · Страховой запас: {safetyDays} дн ·
          Сезонный коэффициент текущего месяца: ×{seasonCoeff.toFixed(2)} · Данные демо
        </div>
      </div>

      {/* Сезонный календарь */}
      <SeasonCalendar />
    </div>
  )
}
