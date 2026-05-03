import { useState, useEffect } from 'react'
import { analyticsApi, type SalesReport } from '../api'

type Period = 'today' | 'yesterday' | 'week' | 'month' | 'quarter' | 'custom'

const PERIOD_LABELS: Record<Period, string> = {
  today:     'Сегодня',
  yesterday: 'Вчера',
  week:      'Неделя',
  month:     'Месяц',
  quarter:   'Квартал',
  custom:    'Свой период',
}

function fmt(n: number) {
  return n.toLocaleString('ru', { maximumFractionDigits: 0 })
}
function fmtR(n: number) {
  return `₽ ${fmt(n)}`
}

export function ReportsPage() {
  const [period, setPeriod]       = useState<Period>('week')
  const [dateFrom, setDateFrom]   = useState('')
  const [dateTo, setDateTo]       = useState('')
  const [skuFilter, setSkuFilter] = useState('')
  const [data, setData]           = useState<SalesReport | null>(null)
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState('')

  function load() {
    setLoading(true)
    setError('')
    analyticsApi.report({
      period,
      date_from: period === 'custom' ? dateFrom : undefined,
      date_to:   period === 'custom' ? dateTo   : undefined,
      sku:       skuFilter || undefined,
    })
      .then(setData)
      .catch(e => setError(e instanceof Error ? e.message : 'Ошибка загрузки'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [period])

  const isDemo = !data?.has_data

  // Заглушка для демонстрации
  const demo: Required<SalesReport> = {
    has_data: false,
    period: { from: '2025-03-16', to: '2025-03-22' },
    units: 401,
    orders_sum: 1537500,
    wb_services: 76875,
    ad_spend: 62500,
    amount_to_pay: 1213625,
    payout_sum: null,
    drr_to_orders: 4.1,
    drr_to_revenue: 4.1,
    drr_to_payouts: null,
    real_drr: 4.6,
    by_warehouse: [
      { warehouse: 'Коледино', units: 198, sum: 783000 },
      { warehouse: 'Подольск', units: 112, sum: 430500 },
      { warehouse: 'Электросталь', units: 91, sum: 324000 },
    ],
    stock_by_warehouse: [
      { warehouse: 'Коледино', qty: 210 },
      { warehouse: 'Подольск', qty: 98 },
      { warehouse: 'Электросталь', qty: 43 },
    ],
    by_sku: [
      { sku: '12345678', units: 214, orders_sum: 1070000 },
      { sku: '23456789', units: 187, orders_sum: 467500 },
    ],
  }

  const d = (isDemo ? demo : data) as Required<SalesReport>

  return (
    <div style={{ padding: '24px 28px 48px', maxWidth: 1200, margin: '0 auto' }}>
      {/* Заголовок */}
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#f1f5f9', margin: '0 0 4px' }}>
          📋 Отчёт по продажам
        </h1>
        <p style={{ fontSize: 13, color: '#64748b', margin: 0 }}>
          Полная финансовая разбивка за выбранный период
        </p>
      </div>

      {isDemo && (
        <div style={{ background: '#1e3a5f', border: '1px solid #38bdf8', borderRadius: 10, padding: '10px 16px', marginBottom: 20, fontSize: 13, color: '#7dd3fc' }}>
          📊 Демо-данные. Подключи аккаунт и синхронизируй данные в разделе 🏪 Аккаунты.
        </div>
      )}

      {error && (
        <div style={{ background: '#450a0a', color: '#fca5a5', padding: 12, borderRadius: 8, marginBottom: 16, fontSize: 13 }}>
          {error}
        </div>
      )}

      {/* Фильтры */}
      <div style={{ background: '#1e293b', borderRadius: 12, padding: '16px 20px', marginBottom: 20, border: '1px solid #334155' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
          {/* Период */}
          <div>
            <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Период</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {(Object.entries(PERIOD_LABELS) as [Period, string][]).map(([p, label]) => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  style={{
                    padding: '6px 12px', borderRadius: 6, fontSize: 13, cursor: 'pointer',
                    border: period === p ? '1px solid #6366f1' : '1px solid #334155',
                    background: period === p ? '#6366f1' : '#0f172a',
                    color: period === p ? '#fff' : '#94a3b8',
                    fontWeight: period === p ? 700 : 400,
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Свой период */}
          {period === 'custom' && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <div>
                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>С</div>
                <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
                  style={{ background: '#0f172a', color: '#f1f5f9', border: '1px solid #334155', borderRadius: 6, padding: '6px 10px', fontSize: 13 }} />
              </div>
              <div>
                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>По</div>
                <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
                  style={{ background: '#0f172a', color: '#f1f5f9', border: '1px solid #334155', borderRadius: 6, padding: '6px 10px', fontSize: 13 }} />
              </div>
              <button onClick={load} style={{ padding: '7px 16px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 13 }}>
                Применить
              </button>
            </div>
          )}

          {/* Фильтр SKU */}
          <div style={{ marginLeft: 'auto' }}>
            <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Артикул</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                value={skuFilter}
                onChange={e => setSkuFilter(e.target.value)}
                placeholder="Все товары"
                style={{ background: '#0f172a', color: '#f1f5f9', border: '1px solid #334155', borderRadius: 6, padding: '6px 10px', fontSize: 13, width: 140 }}
              />
              <button onClick={load} style={{ padding: '6px 12px', background: '#334155', color: '#94a3b8', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
                ↵
              </button>
            </div>
          </div>
        </div>
      </div>

      {loading ? (
        <div style={{ color: '#64748b', textAlign: 'center', padding: 60 }}>Загрузка...</div>
      ) : (
        <>
          {/* Период */}
          {d.period && (
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 16 }}>
              Период: <b style={{ color: '#94a3b8' }}>{d.period.from}</b> — <b style={{ color: '#94a3b8' }}>{d.period.to}</b>
            </div>
          )}

          {/* KPI карточки */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, marginBottom: 20 }}>
            {[
              { label: 'Заказы (шт.)', value: fmt(d.units), color: '#38bdf8' },
              { label: 'Выручка (с СПП)', value: fmtR(d.orders_sum), color: '#22c55e' },
              { label: 'Реклама', value: fmtR(d.ad_spend), color: '#ec4899' },
              { label: 'К выплате (−реклама)', value: fmtR(d.amount_to_pay), color: d.amount_to_pay >= 0 ? '#22c55e' : '#ef4444' },
              { label: 'Реальный ДРР', value: `${d.real_drr}%`, color: d.real_drr < 15 ? '#22c55e' : d.real_drr < 25 ? '#f59e0b' : '#ef4444' },
            ].map(card => (
              <div key={card.label} style={{ background: '#1e293b', borderRadius: 12, padding: '14px 16px', border: '1px solid #334155' }}>
                <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 6 }}>{card.label}</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: card.color }}>{card.value}</div>
              </div>
            ))}
          </div>

          {/* Разбивка по складам */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
            <div style={{ background: '#1e293b', borderRadius: 12, padding: '16px 20px', border: '1px solid #334155' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#f1f5f9', marginBottom: 12 }}>📦 Продажи по складам</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', color: '#64748b', fontWeight: 600, paddingBottom: 8, fontSize: 11, textTransform: 'uppercase' }}>Склад</th>
                    <th style={{ textAlign: 'right', color: '#64748b', fontWeight: 600, paddingBottom: 8, fontSize: 11, textTransform: 'uppercase' }}>Шт.</th>
                    <th style={{ textAlign: 'right', color: '#64748b', fontWeight: 600, paddingBottom: 8, fontSize: 11, textTransform: 'uppercase' }}>Сумма</th>
                  </tr>
                </thead>
                <tbody>
                  {(d.by_warehouse ?? []).map(r => (
                    <tr key={r.warehouse} style={{ borderTop: '1px solid #334155' }}>
                      <td style={{ padding: '8px 0', color: '#cbd5e1' }}>{r.warehouse}</td>
                      <td style={{ padding: '8px 0', textAlign: 'right', color: '#f1f5f9', fontWeight: 600 }}>{fmt(r.units)}</td>
                      <td style={{ padding: '8px 0', textAlign: 'right', color: '#22c55e' }}>{fmtR(r.sum)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ background: '#1e293b', borderRadius: 12, padding: '16px 20px', border: '1px solid #334155' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#f1f5f9', marginBottom: 12 }}>🏭 Остатки по складам</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', color: '#64748b', fontWeight: 600, paddingBottom: 8, fontSize: 11, textTransform: 'uppercase' }}>Склад</th>
                    <th style={{ textAlign: 'right', color: '#64748b', fontWeight: 600, paddingBottom: 8, fontSize: 11, textTransform: 'uppercase' }}>Остаток</th>
                  </tr>
                </thead>
                <tbody>
                  {(d.stock_by_warehouse ?? []).map(r => (
                    <tr key={r.warehouse} style={{ borderTop: '1px solid #334155' }}>
                      <td style={{ padding: '8px 0', color: '#cbd5e1' }}>{r.warehouse}</td>
                      <td style={{ padding: '8px 0', textAlign: 'right', color: r.qty < 20 ? '#f59e0b' : '#f1f5f9', fontWeight: 600 }}>
                        {fmt(r.qty)} {r.qty < 20 ? '⚠️' : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* По артикулам */}
          {(d.by_sku ?? []).length > 0 && (
            <div style={{ background: '#1e293b', borderRadius: 12, padding: '16px 20px', border: '1px solid #334155' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#f1f5f9', marginBottom: 12 }}>🔖 Топ артикулов</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', color: '#64748b', fontWeight: 600, paddingBottom: 8, fontSize: 11, textTransform: 'uppercase' }}>Артикул</th>
                    <th style={{ textAlign: 'right', color: '#64748b', fontWeight: 600, paddingBottom: 8, fontSize: 11, textTransform: 'uppercase' }}>Шт.</th>
                    <th style={{ textAlign: 'right', color: '#64748b', fontWeight: 600, paddingBottom: 8, fontSize: 11, textTransform: 'uppercase' }}>Сумма заказов</th>
                  </tr>
                </thead>
                <tbody>
                  {(d.by_sku ?? []).map(r => (
                    <tr key={r.sku} style={{ borderTop: '1px solid #334155' }}>
                      <td style={{ padding: '8px 0', color: '#38bdf8', fontFamily: 'monospace' }}>{r.sku}</td>
                      <td style={{ padding: '8px 0', textAlign: 'right', color: '#f1f5f9', fontWeight: 600 }}>{fmt(r.units)}</td>
                      <td style={{ padding: '8px 0', textAlign: 'right', color: '#22c55e' }}>{fmtR(r.orders_sum)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
