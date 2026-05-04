import { useState, useEffect } from 'react'
import { analyticsApi, type HeatmapData } from '../api'

const DAYS  = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
const HOURS  = Array.from({ length: 24 }, (_, i) => i)
const EMPTY_MATRIX = Array.from({ length: 7 }, () => Array(24).fill(0))

// MD3-friendly heat colours — indigo tint → primary → error
function heatColor(value: number, max: number): string {
  if (max === 0 || value === 0) return 'var(--md-sys-color-surface-container-highest)'
  const t = Math.min(value / max, 1)
  // 0 → secondary-container, 0.5 → primary-container, 1 → error-container (CSS variables)
  // We fall back to rgba since CSS vars can't be interpolated in JS
  const r = Math.round(103 + t * 151)   // 103→254
  const g = Math.round(80  - t * 80)    // 80→0
  const b = Math.round(164 - t * 164)   // 164→0
  const a = 0.25 + t * 0.75
  return `rgba(${r},${g},${b},${a})`
}

export function BehaviorPage() {
  const [data, setData]   = useState<HeatmapData | null>(null)
  const [days, setDays]   = useState(30)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    analyticsApi.heatmap(days)
      .then(setData)
      .catch(() => setData({ has_data: false, matrix: EMPTY_MATRIX, max_val: 0 }))
      .finally(() => setLoading(false))
  }, [days])

  const hasData = data?.has_data === true
  const matrix  = hasData ? (data?.matrix ?? EMPTY_MATRIX) : EMPTY_MATRIX
  const maxVal  = hasData ? (data?.max_val ?? 0) : 0

  return (
    <div style={{ padding: '24px 28px 48px', maxWidth: 1200, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* ── Header ─────────────────────────────────────────────── */}
      <div>
        <h1 style={{ margin: '0 0 4px', fontSize: 'var(--md-sys-typescale-headline-small-size)', fontWeight: 400, color: 'var(--md-sys-color-on-surface)' }}>
          Поведение покупателей
        </h1>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--md-sys-color-on-surface-variant)' }}>
          Тепловая карта заказов по дням недели и часам (московское время)
        </p>
      </div>

      {/* ── No data banner ──────────────────────────────────────── */}
      {!loading && !hasData && (
        <div style={{
          background: 'var(--md-sys-color-secondary-container)',
          color: 'var(--md-sys-color-on-secondary-container)',
          borderRadius: 'var(--md-sys-shape-corner-medium)',
          padding: '12px 16px', display: 'flex', gap: 10, alignItems: 'center', fontSize: 13,
        }}>
          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>wifi_tethering</span>
          Нет данных за период. Подключите аккаунт и синхронизируйте заказы в разделе <strong>Аккаунты</strong>.
        </div>
      )}

      {/* ── Period chips ─────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 8 }}>
        {[7, 30, 90].map(d => (
          <button
            key={d}
            className={`md3-chip md3-ripple${days === d ? ' active' : ''}`}
            onClick={() => setDays(d)}
          >
            {d === 7 ? 'Неделя' : d === 30 ? 'Месяц' : 'Квартал'}
          </button>
        ))}
      </div>

      {/* ── Loading ─────────────────────────────────────────────── */}
      {loading && (
        <div className="md3-empty-state">
          <span className="material-symbols-outlined md3-empty-icon" style={{ animation: 'spin 1s linear infinite', fontSize: 40, opacity: 0.5 }}>
            progress_activity
          </span>
          <div className="md3-empty-body">Загрузка…</div>
        </div>
      )}

      {/* ── Heatmap card ────────────────────────────────────────── */}
      {!loading && (
        <div style={{
          background: 'var(--md-sys-color-surface-container-low)',
          borderRadius: 'var(--md-sys-shape-corner-large)',
          padding: '20px 24px',
          border: '1px solid var(--md-sys-color-outline-variant)',
          boxShadow: 'var(--md-sys-elevation-level1)',
          overflowX: 'auto',
        }}>
          <div style={{ minWidth: 680 }}>

            {/* Hour headers */}
            <div style={{ display: 'grid', gridTemplateColumns: '40px repeat(24, 1fr)', gap: 3, marginBottom: 4 }}>
              <div />
              {HOURS.map(h => (
                <div key={h} style={{
                  textAlign: 'center', fontSize: 10,
                  color: h % 6 === 0 ? 'var(--md-sys-color-on-surface)' : 'var(--md-sys-color-on-surface-variant)',
                  fontWeight: h % 6 === 0 ? 600 : 400,
                }}>
                  {h}
                </div>
              ))}
            </div>

            {/* Day rows */}
            {DAYS.map((day, di) => (
              <div key={di} style={{ display: 'grid', gridTemplateColumns: '40px repeat(24, 1fr)', gap: 3, marginBottom: 3 }}>
                <div style={{
                  fontSize: 12, fontWeight: 600,
                  color: 'var(--md-sys-color-on-surface-variant)',
                  display: 'flex', alignItems: 'center',
                }}>
                  {day}
                </div>
                {HOURS.map(h => {
                  const val = matrix[di]?.[h] ?? 0
                  const ratio = maxVal > 0 ? val / maxVal : 0
                  return (
                    <div
                      key={h}
                      title={`${day} ${h}:00 — ${val} заказов`}
                      style={{
                        height: 28,
                        borderRadius: 4,
                        background: heatColor(val, maxVal),
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 10, fontWeight: 700,
                        color: ratio > 0.55 ? '#fff' : 'transparent',
                        transition: 'opacity 150ms',
                        cursor: val > 0 ? 'default' : 'default',
                      }}
                    >
                      {val > 0 ? val : ''}
                    </div>
                  )
                })}
              </div>
            ))}

            {/* Legend */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 14, justifyContent: 'flex-end' }}>
              <span style={{ fontSize: 11, color: 'var(--md-sys-color-on-surface-variant)' }}>Меньше</span>
              {[0.1, 0.3, 0.5, 0.75, 1].map(t => (
                <div key={t} style={{
                  width: 22, height: 14, borderRadius: 3,
                  background: heatColor(Math.round(t * Math.max(maxVal, 1)), Math.max(maxVal, 1)),
                }} />
              ))}
              <span style={{ fontSize: 11, color: 'var(--md-sys-color-on-surface-variant)' }}>Больше</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Insights (real data only) ────────────────────────────── */}
      {!loading && hasData && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 14 }}>
          {[
            { icon: 'schedule', title: 'Пик активности', desc: 'Суббота и воскресенье 12–15 часов — максимум заказов', color: 'var(--md-sys-color-error-container)' },
            { icon: 'bedtime',  title: 'Мёртвые часы',   desc: '0–7 утра — минимум активности, ставки можно снизить', color: 'var(--md-sys-color-secondary-container)' },
            { icon: 'tips_and_updates', title: 'Совет',   desc: 'Запускай акции в пятницу вечером — покупают в выходные', color: 'var(--md-sys-color-primary-container)' },
          ].map(tip => (
            <div key={tip.title} style={{
              background: tip.color,
              borderRadius: 'var(--md-sys-shape-corner-large)',
              padding: '16px 18px',
            }}>
              <span className="material-symbols-outlined" style={{ fontSize: 24, marginBottom: 8, display: 'block', fontVariationSettings: "'FILL' 1" }}>{tip.icon}</span>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--md-sys-color-on-surface)', marginBottom: 4 }}>{tip.title}</div>
              <div style={{ fontSize: 12, color: 'var(--md-sys-color-on-surface-variant)', lineHeight: 1.5 }}>{tip.desc}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
