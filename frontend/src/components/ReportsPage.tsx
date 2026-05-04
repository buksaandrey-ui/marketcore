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

const fmt  = (n: number) => n.toLocaleString('ru', { maximumFractionDigits: 0 })
const fmtR = (n: number) => `₽ ${fmt(n)}`
const drrColor = (v: number) =>
  v < 10 ? 'var(--md-sys-color-success)' : v < 20 ? 'var(--md-sys-color-warning)' : 'var(--md-sys-color-error)'

// ── Shared table card ──────────────────────────────────────────────────────
function TableCard({ title, icon, children }: { title: string; icon: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--md-sys-color-surface-container-low)',
      borderRadius: 'var(--md-sys-shape-corner-large)',
      border: '1px solid var(--md-sys-color-outline-variant)',
      boxShadow: 'var(--md-sys-elevation-level1)',
      overflow: 'hidden',
    }}>
      <div style={{ padding: '14px 18px 10px', borderBottom: '1px solid var(--md-sys-color-outline-variant)', display: 'flex', gap: 8, alignItems: 'center' }}>
        <span className="material-symbols-outlined" style={{ fontSize: 18, color: 'var(--md-sys-color-primary)', fontVariationSettings: "'FILL' 1" }}>{icon}</span>
        <span style={{ fontWeight: 500, fontSize: 'var(--md-sys-typescale-title-small-size)', color: 'var(--md-sys-color-on-surface)' }}>{title}</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          {children}
        </table>
      </div>
    </div>
  )
}

const Th = ({ children, right }: { children: React.ReactNode; right?: boolean }) => (
  <th style={{
    padding: '10px 14px',
    textAlign: right ? 'right' : 'left',
    fontSize: 11, fontWeight: 600,
    color: 'var(--md-sys-color-on-surface-variant)',
    textTransform: 'uppercase', letterSpacing: '0.5px',
    background: 'var(--md-sys-color-surface-container-high)',
    borderBottom: '1px solid var(--md-sys-color-outline-variant)',
    whiteSpace: 'nowrap',
  }}>{children}</th>
)

const Td = ({ children, right, style, colSpan }: { children: React.ReactNode; right?: boolean; style?: React.CSSProperties; colSpan?: number }) => (
  <td colSpan={colSpan} style={{
    padding: '10px 14px',
    textAlign: right ? 'right' : 'left',
    borderBottom: '1px solid var(--md-sys-color-outline-variant)',
    color: 'var(--md-sys-color-on-surface)',
    verticalAlign: 'middle',
    fontVariantNumeric: right ? 'tabular-nums' : undefined,
    whiteSpace: right ? 'nowrap' : undefined,
    ...style,
  }}>{children}</td>
)

export function ReportsPage() {
  const [period, setPeriod]       = useState<Period>('week')
  const [dateFrom, setDateFrom]   = useState('')
  const [dateTo, setDateTo]       = useState('')
  const [skuFilter, setSkuFilter] = useState('')
  const [data, setData]           = useState<SalesReport | null>(null)
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState('')

  function load() {
    setLoading(true); setError('')
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

  const hasData = data?.has_data === true
  const d = data as Required<SalesReport> | null

  return (
    <div style={{ padding: '24px 28px 48px', maxWidth: 1200, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* ── Header ─────────────────────────────────────────────── */}
      <div>
        <h1 style={{ margin: '0 0 4px', fontSize: 'var(--md-sys-typescale-headline-small-size)', fontWeight: 400, color: 'var(--md-sys-color-on-surface)' }}>
          Отчёт по продажам
        </h1>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--md-sys-color-on-surface-variant)' }}>
          Полная финансовая разбивка за выбранный период
        </p>
      </div>

      {/* ── No data banner ──────────────────────────────────────── */}
      {!loading && !hasData && data && (
        <div style={{
          background: 'var(--md-sys-color-secondary-container)',
          color: 'var(--md-sys-color-on-secondary-container)',
          borderRadius: 'var(--md-sys-shape-corner-medium)',
          padding: '12px 16px', display: 'flex', gap: 10, alignItems: 'center',
          fontSize: 13,
        }}>
          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>info</span>
          Нет данных за период. Подключите аккаунт и синхронизируйте в разделе <strong>Аккаунты</strong>.
        </div>
      )}

      {/* ── Error ───────────────────────────────────────────────── */}
      {error && (
        <div style={{
          background: 'var(--md-sys-color-error-container)', color: 'var(--md-sys-color-on-error-container)',
          borderRadius: 'var(--md-sys-shape-corner-medium)', padding: '12px 16px',
          display: 'flex', gap: 8, alignItems: 'center', fontSize: 13,
        }}>
          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>error</span>
          {error}
        </div>
      )}

      {/* ── Filters bar ─────────────────────────────────────────── */}
      <div style={{
        background: 'var(--md-sys-color-surface-container)',
        borderRadius: 'var(--md-sys-shape-corner-large)',
        padding: '16px 20px',
        border: '1px solid var(--md-sys-color-outline-variant)',
        display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end',
      }}>
        {/* Period chips */}
        <div>
          <div style={{ fontSize: 11, color: 'var(--md-sys-color-on-surface-variant)', marginBottom: 8, fontWeight: 500, letterSpacing: '0.5px', textTransform: 'uppercase' }}>Период</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(Object.entries(PERIOD_LABELS) as [Period, string][]).map(([p, label]) => (
              <button key={p} className={`md3-chip md3-ripple${period === p ? ' active' : ''}`} onClick={() => setPeriod(p)}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Custom date range */}
        {period === 'custom' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--md-sys-color-on-surface-variant)', marginBottom: 4 }}>С</div>
              <input type="date" className="md3-field-input" style={{ padding: '7px 10px', minHeight: 36, fontSize: 13, width: 'auto' }}
                value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
            </div>
            <span style={{ color: 'var(--md-sys-color-on-surface-variant)', paddingBottom: 8 }}>—</span>
            <div>
              <div style={{ fontSize: 11, color: 'var(--md-sys-color-on-surface-variant)', marginBottom: 4 }}>По</div>
              <input type="date" className="md3-field-input" style={{ padding: '7px 10px', minHeight: 36, fontSize: 13, width: 'auto' }}
                value={dateTo} onChange={e => setDateTo(e.target.value)} />
            </div>
            <button className="md3-btn md3-btn-tonal md3-ripple" style={{ padding: '7px 16px', minHeight: 36 }} onClick={load}>
              Применить
            </button>
          </div>
        )}

        {/* SKU filter */}
        <div style={{ marginLeft: 'auto' }}>
          <div style={{ fontSize: 11, color: 'var(--md-sys-color-on-surface-variant)', marginBottom: 4, fontWeight: 500, letterSpacing: '0.5px', textTransform: 'uppercase' }}>Артикул</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              className="md3-field-input"
              style={{ padding: '7px 12px', minHeight: 36, fontSize: 13, width: 140 }}
              value={skuFilter}
              onChange={e => setSkuFilter(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && load()}
              placeholder="Все товары"
            />
            <button className="md3-btn md3-btn-tonal md3-ripple" style={{ padding: '7px 12px', minHeight: 36 }} onClick={load}>
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>search</span>
            </button>
          </div>
        </div>
      </div>

      {/* ── Loading ─────────────────────────────────────────────── */}
      {loading && (
        <div className="md3-empty-state">
          <span className="material-symbols-outlined md3-empty-icon" style={{ animation: 'spin 1s linear infinite', fontSize: 40, opacity: 0.5 }}>
            progress_activity
          </span>
          <div className="md3-empty-body">Загрузка данных…</div>
        </div>
      )}

      {/* ── Content ─────────────────────────────────────────────── */}
      {!loading && hasData && d && (
        <>
          {/* Period label */}
          {d.period && (
            <div style={{ fontSize: 12, color: 'var(--md-sys-color-on-surface-variant)', display: 'flex', gap: 4, alignItems: 'center' }}>
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>calendar_today</span>
              Период: <strong>{d.period.from}</strong> — <strong>{d.period.to}</strong>
            </div>
          )}

          {/* KPI grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
            {[
              { label: 'Заказы', value: `${fmt(d.units)} шт`, icon: 'shopping_bag' },
              { label: 'Выручка (с СПП)', value: fmtR(d.orders_sum), icon: 'payments' },
              { label: 'Реклама', value: fmtR(d.ad_spend), icon: 'campaign' },
              { label: 'К выплате', value: fmtR(d.amount_to_pay), icon: 'account_balance' },
              { label: 'Реальный ДРР', value: `${d.real_drr}%`, icon: 'analytics', color: drrColor(d.real_drr) },
            ].map(c => (
              <div key={c.label} style={{
                background: 'var(--md-sys-color-surface-container-low)',
                borderRadius: 'var(--md-sys-shape-corner-large)',
                padding: '16px 18px',
                border: '1px solid var(--md-sys-color-outline-variant)',
                boxShadow: 'var(--md-sys-elevation-level1)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 16, color: 'var(--md-sys-color-primary)', fontVariationSettings: "'FILL' 1" }}>{c.icon}</span>
                  <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--md-sys-color-on-surface-variant)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{c.label}</span>
                </div>
                <div style={{ fontSize: 20, fontWeight: 500, color: c.color ?? 'var(--md-sys-color-on-surface)', letterSpacing: '-0.25px' }}>
                  {c.value}
                </div>
              </div>
            ))}
          </div>

          {/* Warehouse tables */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
            <TableCard title="Продажи по складам" icon="local_shipping">
              <thead>
                <tr><Th>Склад</Th><Th right>Шт.</Th><Th right>Сумма</Th></tr>
              </thead>
              <tbody>
                {(d.by_warehouse ?? []).map(r => (
                  <tr key={r.warehouse}>
                    <Td>{r.warehouse}</Td>
                    <Td right>{fmt(r.units)}</Td>
                    <Td right style={{ color: 'var(--md-sys-color-success)' }}>{fmtR(r.sum)}</Td>
                  </tr>
                ))}
                {(d.by_warehouse ?? []).length === 0 && (
                  <tr><Td colSpan={3} style={{ textAlign: 'center', color: 'var(--md-sys-color-on-surface-variant)' } as React.CSSProperties}>Нет данных</Td></tr>
                )}
              </tbody>
            </TableCard>

            <TableCard title="Остатки по складам" icon="inventory_2">
              <thead>
                <tr><Th>Склад</Th><Th right>Остаток</Th></tr>
              </thead>
              <tbody>
                {(d.stock_by_warehouse ?? []).map(r => (
                  <tr key={r.warehouse}>
                    <Td>{r.warehouse}</Td>
                    <Td right style={{ color: r.qty < 20 ? 'var(--md-sys-color-warning)' : 'var(--md-sys-color-on-surface)' }}>
                      {fmt(r.qty)} {r.qty < 20 ? '⚠' : ''}
                    </Td>
                  </tr>
                ))}
                {(d.stock_by_warehouse ?? []).length === 0 && (
                  <tr><Td colSpan={2} style={{ textAlign: 'center', color: 'var(--md-sys-color-on-surface-variant)' } as React.CSSProperties}>Нет данных</Td></tr>
                )}
              </tbody>
            </TableCard>
          </div>

          {/* Top SKUs */}
          {(d.by_sku ?? []).length > 0 && (
            <TableCard title="Топ артикулов" icon="label">
              <thead>
                <tr><Th>Артикул</Th><Th right>Шт.</Th><Th right>Сумма заказов</Th></tr>
              </thead>
              <tbody>
                {(d.by_sku ?? []).map(r => (
                  <tr key={r.sku}>
                    <Td style={{ fontFamily: 'monospace', color: 'var(--md-sys-color-primary)' }}>{r.sku}</Td>
                    <Td right>{fmt(r.units)}</Td>
                    <Td right style={{ color: 'var(--md-sys-color-success)' }}>{fmtR(r.orders_sum)}</Td>
                  </tr>
                ))}
              </tbody>
            </TableCard>
          )}
        </>
      )}
    </div>
  )
}
