import { useState, useEffect } from 'react'
import { analyticsApi, type SupplyForecastData } from '../api'
import { SEASONAL_COEFF } from '../data/demo'
import './SupplyForecast.css'

const currentMonth = new Date().getMonth() + 1
const MONTH_NAMES = ['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек']

const STATUS_LABEL: Record<string, string> = {
  critical:  '🔴 Срочно',
  soon:      '🟡 Скоро',
  ok:        '🟢 Норма',
  overstock: '🔵 Избыток',
}

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

export function SupplyForecast() {
  const [data, setData]    = useState<SupplyForecastData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]  = useState('')
  const [filterStatus, setFilterStatus] = useState<string>('all')
  const [search, setSearch] = useState('')

  useEffect(() => {
    analyticsApi.supplyForecast()
      .then(setData)
      .catch(() => setError('Ошибка загрузки данных'))
      .finally(() => setLoading(false))
  }, [])

  const items = data?.items ?? []
  const seasonCoeff = SEASONAL_COEFF[currentMonth] ?? 1.0

  const filtered = items
    .filter(r => filterStatus === 'all' || r.status === filterStatus)
    .filter(r =>
      r.sku.includes(search) ||
      (r.name || '').toLowerCase().includes(search.toLowerCase())
    )

  const criticalCount  = items.filter(r => r.status === 'critical').length
  const soonCount      = items.filter(r => r.status === 'soon').length
  const overstockCount = items.filter(r => r.status === 'overstock').length

  if (loading) return (
    <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>Загрузка данных поставок…</div>
  )

  if (error || !data?.has_data) return (
    <div className="sf-page">
      <div className="sf-header">
        <div>
          <h1 className="sf-title">📦 Прогноз поставок</h1>
          <p className="sf-subtitle">Скорость продаж · Дней до обнуления · Рекомендации по заказу</p>
        </div>
      </div>
      <div style={{
        background: '#f8fafc', borderRadius: 12, padding: 40, textAlign: 'center',
        border: '1px dashed #cbd5e1', color: '#64748b',
      }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>📦</div>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Нет данных об остатках</div>
        <div style={{ fontSize: 13 }}>
          Нажми <strong>Синхронизировать</strong> в разделе <strong>🏪 Аккаунты</strong> — данные появятся автоматически.
        </div>
      </div>
      <SeasonCalendar />
    </div>
  )

  return (
    <div className="sf-page">
      <div className="sf-header">
        <div>
          <h1 className="sf-title">📦 Прогноз поставок</h1>
          <p className="sf-subtitle">Скорость продаж · Дней до обнуления · Рекомендации по заказу · реальные данные</p>
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
          <span className="sf-sum-num">{items.length}</span>
          <span className="sf-sum-label">Всего позиций</span>
        </div>
      </div>

      {/* Настройки */}
      <div className="sf-controls">
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
              <th>Дней до нуля</th>
              <th>Статус</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(r => (
              <tr key={r.sku} className={`sf-row sf-row-${r.status}`}>
                <td className="sf-col-name">
                  {r.name
                    ? <><div className="sf-sku-name">{r.name}</div><div className="sf-sku-id">#{r.sku}</div></>
                    : <div className="sf-sku-name">#{r.sku}</div>
                  }
                </td>
                <td className={`sf-num ${r.stock === 0 ? 'zero' : r.stock < 10 ? 'low' : ''}`}>
                  {r.stock === 0 ? '⚠ 0' : r.stock}
                </td>
                <td className="sf-num">{r.vel_7d.toFixed(1)}/д</td>
                <td className="sf-num">{r.vel_14d.toFixed(1)}/д</td>
                <td className="sf-num">{r.vel_30d.toFixed(1)}/д</td>
                <td className={`sf-num sf-days sf-days-${r.status}`}>
                  {r.days_oos === null ? '∞' : r.days_oos}
                </td>
                <td>
                  <span className={`sf-badge sf-badge-${r.status}`}>{STATUS_LABEL[r.status]}</span>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={7} className="sf-empty">Нет товаров по фильтру</td></tr>
            )}
          </tbody>
        </table>
        <div className="sf-footer">
          Показано {filtered.length} из {items.length} позиций · реальные данные WB
        </div>
      </div>

      {/* Сезонный календарь */}
      <SeasonCalendar />
    </div>
  )
}
