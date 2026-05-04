import { useState, useEffect } from 'react'
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

const fmt    = (n: number) => n.toLocaleString('ru')
const fmtPct = (n: number) => n.toFixed(1) + '%'
const drrClass = (v: number) =>
  v === 0 ? '' : v < 10 ? 'drr-ok' : v < 15 ? 'drr-warn' : 'drr-bad'

// ── Skeleton placeholder ───────────────────────────────────────────────────
function KpiSkeleton() {
  return (
    <div className="kpi-card">
      <div className="kpi-skel-line kpi-skeleton" style={{ width: '50%' }} />
      <div className="kpi-skel-val  kpi-skeleton" />
      <div className="kpi-skel-line kpi-skeleton" style={{ width: '70%' }} />
    </div>
  )
}

// ── Onboarding banner ──────────────────────────────────────────────────────
function OnboardingBanner({ onGoAccounts }: { onGoAccounts?: () => void }) {
  return (
    <div className="dash-onboarding">
      <div className="dash-onboarding-icon">
        <span className="material-symbols-outlined" style={{ fontSize: 56, fontVariationSettings: "'FILL' 1, 'wght' 300, 'GRAD' 0, 'opsz' 48" }}>
          store
        </span>
      </div>
      <h2>Добро пожаловать в MarketCore</h2>
      <p>
        Чтобы увидеть реальную аналитику по продажам,
        подключите Wildberries-аккаунт и нажмите «Синхронизировать».
      </p>
      <small>Данные появятся в течение 1–2 минут после синхронизации</small>
      <button className="md3-btn md3-btn-filled md3-ripple" onClick={onGoAccounts}>
        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>add_circle</span>
        Подключить аккаунт
      </button>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────
interface DashboardProps { onNavigate?: (page: string) => void }

export function Dashboard({ onNavigate }: DashboardProps) {
  const [realData, setRealData]   = useState<DashboardSummary | null>(null)
  const [payouts,  setPayouts]    = useState<PayoutsData | null>(null)
  const [loading,  setLoading]    = useState(false)
  const [payoutsLoading, setPayoutsLoading] = useState(false)
  const [error,    setError]      = useState<string | null>(null)
  const [period,   setPeriod]     = useState<Period>('month')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo,   setCustomTo]   = useState('')

  const loadData = (p: Period, from?: string, to?: string) => {
    setLoading(true)
    setError(null)
    const params: { period: string; date_from?: string; date_to?: string } = { period: p }
    if (p === 'custom' && from && to) { params.date_from = from; params.date_to = to }

    analyticsApi.dashboard(params)
      .then(setRealData)
      .catch(() => setError('Не удалось загрузить данные. Проверьте подключение.'))
      .finally(() => setLoading(false))

    setPayouts(null)
    setPayoutsLoading(true)
    analyticsApi.payouts(params)
      .then(setPayouts)
      .catch(() => setPayouts(null))
      .finally(() => setPayoutsLoading(false))
  }

  useEffect(() => { loadData('month') }, [])

  const handlePeriod = (p: Period) => {
    setPeriod(p)
    if (p !== 'custom') loadData(p)
  }

  const hasData    = realData?.has_data === true
  const noAccounts = !loading && realData && !hasData && (!realData.accounts || realData.accounts.length === 0)
  const noData     = !loading && realData && !hasData && realData.accounts && realData.accounts.length > 0

  const ordersCount = realData?.orders_count   ?? 0
  const revenue     = realData?.revenue        ?? 0
  const adSpend     = realData?.ad_spend       ?? 0
  const drrO        = realData?.drr_to_orders  ?? 0
  const drrR        = realData?.drr_to_revenue ?? 0
  const drrP        = realData?.drr_to_payouts != null
    ? realData.drr_to_payouts
    : (adSpend > 0 && payouts?.has_data && payouts.payout_sum > 0)
      ? adSpend / payouts.payout_sum * 100
      : null

  return (
    <div className="dash">

      {/* ── Period selector ─────────────────────────────────────── */}
      <div className="dash-period-row">
        {(Object.keys(PERIOD_LABELS) as Period[]).map(p => (
          <button
            key={p}
            className={`md3-chip md3-ripple${period === p ? ' active' : ''}`}
            onClick={() => handlePeriod(p)}
          >
            {PERIOD_LABELS[p]}
          </button>
        ))}
        {period === 'custom' && (
          <>
            <input
              type="date"
              className="md3-field-input"
              style={{ padding: '6px 10px', minHeight: 36, fontSize: 13, width: 'auto' }}
              value={customFrom}
              onChange={e => setCustomFrom(e.target.value)}
            />
            <span style={{ color: 'var(--md-sys-color-on-surface-variant)' }}>—</span>
            <input
              type="date"
              className="md3-field-input"
              style={{ padding: '6px 10px', minHeight: 36, fontSize: 13, width: 'auto' }}
              value={customTo}
              onChange={e => setCustomTo(e.target.value)}
            />
            <button
              className="md3-btn md3-btn-tonal md3-ripple"
              style={{ padding: '6px 16px', minHeight: 36 }}
              onClick={() => { if (customFrom && customTo) loadData('custom', customFrom, customTo) }}
            >
              Применить
            </button>
          </>
        )}
        {loading && (
          <span style={{ fontSize: 13, color: 'var(--md-sys-color-on-surface-variant)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="material-symbols-outlined" style={{ fontSize: 16, animation: 'spin 1s linear infinite' }}>progress_activity</span>
            Загрузка…
          </span>
        )}
      </div>

      {/* ── Error banner ────────────────────────────────────────── */}
      {error && (
        <div className="dash-banner dash-banner-error">
          <span className="material-symbols-outlined">error</span>
          <span>{error}</span>
        </div>
      )}

      {/* ── Onboarding: no accounts ─────────────────────────────── */}
      {noAccounts && <OnboardingBanner onGoAccounts={() => onNavigate?.('accounts')} />}

      {/* ── Account connected but no sync yet ───────────────────── */}
      {noData && (
        <div className="dash-banner dash-banner-warn">
          <span className="material-symbols-outlined">wifi_tethering</span>
          <div>
            <div style={{ fontWeight: 500, marginBottom: 2 }}>Аккаунт подключён, данных нет</div>
            <div>
              Перейдите в раздел <strong>Аккаунты</strong> и нажмите «Синхронизировать»,
              чтобы загрузить данные с WB. Это займёт 1–2 минуты.
            </div>
          </div>
        </div>
      )}

      {/* ── Formula note (only when real data) ──────────────────── */}
      {hasData && (
        <div className="dash-formula-note">
          <b>Формулы расчёта:</b>{' '}
          <b>Оплатили покупатели</b> = <code>finishedPrice × (1 − spp/100) × кол-во</code> — цена после СПП, отменённые исключены.{' '}
          <b>Начислено WB</b> = <code>ppvz_for_pay</code> = Выручка − комиссия − логистика − хранение.
          WB закрывает расчёты по понедельникам.
        </div>
      )}

      {/* ── KPI cards ───────────────────────────────────────────── */}
      {loading && !realData && (
        <div className="kpi-row">
          <KpiSkeleton /><KpiSkeleton /><KpiSkeleton /><KpiSkeleton />
        </div>
      )}

      {(hasData || (realData && loading)) && (
        <div className="kpi-row">

          {/* Orders */}
          <div className="kpi-card">
            <div className="kpi-top">
              <div className="kpi-icon-wrap">
                <span className="material-symbols-outlined">shopping_bag</span>
              </div>
              <span className="kpi-label">Заказы</span>
            </div>
            <div className="kpi-value">{fmt(ordersCount)} <span className="kpi-unit">шт</span></div>
            <div className="kpi-sub">всего оформлено за период</div>
          </div>

          {/* Revenue (buyer paid) */}
          <div className="kpi-card">
            <div className="kpi-top">
              <div className="kpi-icon-wrap">
                <span className="material-symbols-outlined">payments</span>
              </div>
              <span className="kpi-label">Оплатили покупатели</span>
            </div>
            <div className="kpi-value">₽ {fmt(revenue)}</div>
            <div className="kpi-sub" title="finishedPrice × (1 − spp/100) × количество">
              finishedPrice · с учётом СПП ℹ
            </div>
          </div>

          {/* WB payouts */}
          <div className="kpi-card" title="ppvz_for_pay из финансового отчёта WB">
            <div className="kpi-top">
              <div className="kpi-icon-wrap">
                <span className="material-symbols-outlined">account_balance</span>
              </div>
              <span className="kpi-label">Начислено WB</span>
            </div>
            {payoutsLoading ? (
              <div className="kpi-skel-val kpi-skeleton" />
            ) : payouts?.has_data ? (
              <div className="kpi-value">₽ {fmt(payouts.payout_sum)}</div>
            ) : payouts && !payouts.has_data && !payouts.api_error ? (
              <>
                <div className="kpi-value" style={{ fontSize: 18, color: 'var(--md-sys-color-on-surface-variant)' }}>—</div>
                <div style={{ fontSize: 11, color: 'var(--md-sys-color-warning)', marginTop: 2 }}>
                  WB закрывает отчёт по пн — данные появятся после расчёта
                </div>
              </>
            ) : (
              <div className="kpi-value" style={{ fontSize: 14, color: 'var(--md-sys-color-on-surface-variant)' }}>
                {payouts?.api_error ? '⚠ ошибка API' : 'нет данных'}
              </div>
            )}
            <div className="kpi-sub">ppvz_for_pay · после комиссии WB ℹ</div>
          </div>

          {/* DRR triple */}
          <div className="kpi-card">
            <div className="kpi-top">
              <div className="kpi-icon-wrap">
                <span className="material-symbols-outlined">analytics</span>
              </div>
              <span className="kpi-label">ДРР (доля рекл. расходов)</span>
            </div>
            <div className="kpi-drr-split">
              <div className="kpi-drr-col">
                <span className="kpi-drr-sublabel">к заказам</span>
                <span className={`kpi-drr-val ${drrClass(drrO)}`}>{fmtPct(drrO)}</span>
              </div>
              <div className="kpi-drr-divider" />
              <div className="kpi-drr-col">
                <span className="kpi-drr-sublabel">к выручке</span>
                <span className={`kpi-drr-val ${drrClass(drrR)}`}>{fmtPct(drrR)}</span>
              </div>
              <div className="kpi-drr-divider" />
              <div className="kpi-drr-col">
                <span className="kpi-drr-sublabel">к начислениям</span>
                {drrP !== null
                  ? <span className={`kpi-drr-val ${drrClass(drrP)}`}>{fmtPct(drrP)}</span>
                  : <span className="kpi-drr-val" style={{ fontSize: 12, color: 'var(--md-sys-color-on-surface-variant)' }}>нет данных</span>
                }
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Top SKUs table ──────────────────────────────────────── */}
      {hasData && realData?.top_skus && realData.top_skus.length > 0 && (
        <div className="sku-table-wrap">
          <div className="sku-table-header">
            <h2 className="sku-table-title">Топ товаров за период</h2>
          </div>
          <div className="sku-table-scroll">
            <table className="sku-table">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>#</th>
                  <th className="col-name">Товар / SKU</th>
                  <th className="col-num">Заказов</th>
                  <th className="col-num">Выручка</th>
                </tr>
              </thead>
              <tbody>
                {realData.top_skus.map((s, i) => (
                  <tr key={s.sku} className="sku-row">
                    <td>
                      <span className={`sku-rank${i === 0 ? ' sku-rank-1' : ''}`}>{i + 1}</span>
                    </td>
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
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>info</span>
            Топ-20 товаров за период
            {!realData.top_skus[0]?.name && (
              <span style={{ color: 'var(--md-sys-color-warning)', marginLeft: 4 }}>
                · Нажмите «Синхронизировать» в Аккаунтах для загрузки названий
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── No SKUs after load ───────────────────────────────────── */}
      {hasData && realData?.top_skus?.length === 0 && (
        <div className="md3-empty-state">
          <span className="material-symbols-outlined md3-empty-icon">inventory_2</span>
          <div className="md3-empty-title">Нет данных по товарам</div>
          <div className="md3-empty-body">За выбранный период заказов не найдено.</div>
        </div>
      )}

    </div>
  )
}
