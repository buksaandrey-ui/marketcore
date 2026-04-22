import { useState, useEffect } from 'react'
import { analyticsApi, type HeatmapData } from '../api'

const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
const HOURS = Array.from({ length: 24 }, (_, i) => i)

// Демо-матрица (пока нет реальных данных)
function makeDemoMatrix(): number[][] {
  const m = Array.from({ length: 7 }, () => Array(24).fill(0))
  const peaks = [
    [0, 10, 35], [0, 13, 42], [0, 20, 28],
    [1, 11, 38], [1, 14, 45], [1, 21, 31],
    [4, 10, 25], [4, 15, 33], [5, 12, 55], [5, 14, 62],
    [6, 11, 48], [6, 13, 57],
  ]
  peaks.forEach(([d, h, v]) => { m[d][h] = v })
  for (let d = 0; d < 7; d++) {
    for (let h = 8; h < 22; h++) {
      if (!m[d][h]) m[d][h] = Math.max(0, Math.round(Math.random() * 20 - 3))
    }
  }
  return m
}

function heatColor(value: number, max: number): string {
  if (max === 0 || value === 0) return '#f1f5f9'
  const t = value / max
  if (t < 0.25) return `rgba(34,197,94,${0.15 + t * 0.6})`
  if (t < 0.5)  return `rgba(234,179,8,${0.3 + t * 0.5})`
  if (t < 0.75) return `rgba(249,115,22,${0.4 + t * 0.4})`
  return `rgba(239,68,68,${0.5 + t * 0.45})`
}

export function BehaviorPage() {
  const [data, setData] = useState<HeatmapData | null>(null)
  const [days, setDays] = useState(30)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    analyticsApi.heatmap(days)
      .then(setData)
      .catch(() => setData({ has_data: false, matrix: makeDemoMatrix(), max_val: 62 }))
      .finally(() => setLoading(false))
  }, [days])

  const matrix = data?.matrix ?? makeDemoMatrix()
  const maxVal = data?.max_val ?? 62
  const isDemo = !data?.has_data

  return (
    <div style={{ padding: '24px 28px 48px', maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#f1f5f9', margin: '0 0 4px' }}>
          📈 Поведение покупателей
        </h1>
        <p style={{ fontSize: 13, color: '#64748b', margin: 0 }}>
          Тепловая карта заказов по дням недели и часам (московское время)
        </p>
      </div>

      {isDemo && (
        <div style={{ background: '#1e3a5f', border: '1px solid #38bdf8', borderRadius: 10, padding: '10px 16px', marginBottom: 20, fontSize: 13, color: '#7dd3fc' }}>
          📊 Демо-данные. Подключи аккаунт и синхронизируй заказы в разделе 🏪 Аккаунты — появится реальная тепловая карта.
        </div>
      )}

      {/* Период */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        {[7, 30, 90].map(d => (
          <button
            key={d}
            onClick={() => setDays(d)}
            style={{
              padding: '6px 14px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
              border: days === d ? '1px solid #6366f1' : '1px solid #334155',
              background: days === d ? '#6366f1' : '#1e293b',
              color: days === d ? '#fff' : '#94a3b8', fontWeight: days === d ? 700 : 400,
            }}
          >
            {d === 7 ? 'Неделя' : d === 30 ? 'Месяц' : 'Квартал'}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ color: '#64748b', textAlign: 'center', padding: 60 }}>Загрузка...</div>
      ) : (
        <div style={{ background: '#1e293b', borderRadius: 16, padding: '20px 24px', border: '1px solid #334155', overflowX: 'auto' }}>
          <div style={{ minWidth: 700 }}>
            {/* Шапка — часы */}
            <div style={{ display: 'grid', gridTemplateColumns: '44px repeat(24, 1fr)', gap: 3, marginBottom: 6 }}>
              <div />
              {HOURS.map(h => (
                <div key={h} style={{ textAlign: 'center', fontSize: 10, color: '#64748b', fontWeight: h % 6 === 0 ? 700 : 400 }}>
                  {h}
                </div>
              ))}
            </div>

            {/* Строки — дни */}
            {DAYS.map((day, d) => (
              <div key={d} style={{ display: 'grid', gridTemplateColumns: '44px repeat(24, 1fr)', gap: 3, marginBottom: 3 }}>
                <div style={{ fontSize: 12, color: '#94a3b8', display: 'flex', alignItems: 'center', fontWeight: 600 }}>
                  {day}
                </div>
                {HOURS.map(h => {
                  const val = matrix[d]?.[h] ?? 0
                  return (
                    <div
                      key={h}
                      title={`${day} ${h}:00 — ${val} заказов`}
                      style={{
                        height: 28,
                        borderRadius: 4,
                        background: heatColor(val, maxVal),
                        cursor: val > 0 ? 'default' : undefined,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 10,
                        color: val / maxVal > 0.5 ? '#fff' : 'transparent',
                        fontWeight: 700,
                      }}
                    >
                      {val > 0 ? val : ''}
                    </div>
                  )
                })}
              </div>
            ))}

            {/* Легенда */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              <span style={{ fontSize: 11, color: '#64748b' }}>Меньше</span>
              {[0.1, 0.25, 0.5, 0.75, 1].map(t => (
                <div key={t} style={{ width: 24, height: 16, borderRadius: 3, background: heatColor(Math.round(t * maxVal), maxVal) }} />
              ))}
              <span style={{ fontSize: 11, color: '#64748b' }}>Больше</span>
            </div>
          </div>
        </div>
      )}

      {/* Инсайты под картой */}
      {!loading && (
        <div style={{ marginTop: 20, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
          {[
            { icon: '🕙', title: 'Пик активности', desc: 'Суббота и воскресенье 12–15 часов — максимум заказов', color: '#ef4444' },
            { icon: '📉', title: 'Мёртвые часы', desc: '0–7 утра — минимум активности, ставки можно снизить', color: '#6366f1' },
            { icon: '🎯', title: 'Совет', desc: 'Запускай акции в пятницу вечером — покупают в выходные', color: '#22c55e' },
          ].map(tip => (
            <div key={tip.title} style={{ background: '#1e293b', borderRadius: 12, padding: 16, border: '1px solid #334155' }}>
              <div style={{ fontSize: 24, marginBottom: 8 }}>{tip.icon}</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#f1f5f9', marginBottom: 4 }}>{tip.title}</div>
              <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.5 }}>{tip.desc}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
