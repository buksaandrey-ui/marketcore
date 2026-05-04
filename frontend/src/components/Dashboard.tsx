import { useState, useEffect } from 'react'
import { analyticsApi, type DashboardSummary, type PayoutsData } from '../api'
import './Dashboard.css'

// demo.ts убран (I-01) — Dashboard показывает только реальные данные

type Period = 'today' | 'yesterday' | '7d' | 'month' | 'custom'
const PERIOD_LABELS: Record<Period, string> = {
  today:     'Сегодня',
  yesterday: 'Вчера',
  '7d':      '7 дней',
  month:     'Месяц',
  custom:    'Свой период',
}

const fmt      = (n: number) => n.toLocaleString('ru')
const fmtPct   = (n: number) => n.toFixed(1) + '%'
const drrClass = (v: number) => v < 10 ? 'drr-ok' : v < 15 ? 'drr-warn' : 'drr-bad'

// ─── Онбординг-баннер (нет аккаунтов) ────────────────────────────────────────

function OnboardingBanner({ onGoAccounts }: { onGoAccounts?: () => void }) {
  return (
    <div style={{
      background: 'linear-gradient(135deg, #1e3a5f 0%, #1e3a2e 100%)',
      border: '1px solid #2d6a9f',
      borderRadius: 12,
      padding: '32px 36px',
      textAlign: 'center',
      color: '#e2e8f0',
      maxWidth: 560,
      margin: '60px auto',
    }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>⚡</div>
      <h2 style={{ margin: '0 0 12px', fontSize: 22, color: '#f1f5f9' }}>
        Добро пожаловать в MarketCore
      </h2>
      <p style={{ margin: '0 0 8px', fontSize: 15, color: '#94a3b8', lineHeight: 1.6 }}>
        Чтобы увидеть реальную аналитику по вашим продажам,
        подключите Wildberries-аккаунт и нажмите «Синхронизировать».
      </p>
      <p style={{ margin: '0 0 24px', fontSize: 13, color: '#64748b' }}>
        Данные появятся в течение 1–2 минут после синхронизации
      </p>
      <button
        onClick={onGoAccounts}
        style={{
          background: '#6366f1', color: '#fff', border: 'none',
          borderRadius: 8, padding: '12px 28px', fontSize: 15,
          cursor: 'pointer', fontWeight: 600,
        }}
      >
        🏪 Подключить аккаунт
      </button>
    </div>
  )
}

// ─── Основной компонент ───────────────────────────────────────────────────────

interface DashboardProps {
  onNavigate?: (page: string) => void
}

export function Dashboard({ onNavigate }: DashboardProps) {
  const [realData, setRealData] = useState<DashboardSummary | null>(null)
  const [payouts, setPayouts]   = useState<PayoutsData | null>(null)
  const [loading, setLoading]   = useState(false)
  const [payoutsLoading, setPayoutsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [period, setPeriod]     = useState<Period>('month')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo,   setCustomTo]   = useState('')

  const loadData = (p: Period, from?: string, to?: string) => {
    setLoading(true)
    setError(null)
    const params: { period: string; date_from?: string; date_to?: string } = { period: p }
    if (p === 'custom' && from && to) { params.date_from = from; params.date_to = to }
    analyticsApi.dashboard(params)
      .then(setRealData)
      .catch(() => setError('Не удалось загрузить данные. Проверьте подключение к интернету.'))
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

  const handleCustomApply = () => {
    if (customFrom && customTo) loadData('custom', customFrom, customTo)
  }

  const hasData     = realData?.has_data === true
  const noAccounts  = !loading && realData && !hasData && (!realData.accounts || realData.accounts.length === 0)
  const noData      = !loading && realData && !hasData && realData.accounts && realData.accounts.length > 0

  const ordersCount = realData?.orders_count ?? 0
  const revenue     = realData?.revenue      ?? 0
  const adSpend     = realData?.ad_spend     ?? 0
  const drrO        = realData?.drr_to_orders  ?? 0
  const drrR        = realData?.drr_to_revenue ?? 0
  const drrP        = realData?.drr_to_payouts != null
    ? realData.drr_to_payouts
    : (adSpend > 0 && payouts?.has_data && payouts.payout_sum > 0)
      ? adSpend / payouts.payout_sum * 100
      : null

  return (
    <div className="dash">

      {/* ── Выбор периода ───────────��─────────────────────────── */}
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

      {/* ── Ошибка загрузки ───────────────────────────────────── */}
      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8, padding: '10px 16px', marginBottom: 16, color: '#991b1b', fontSize: 13 }}>
          ⚠ {error}
        </div>
      )}

      {/* ── Онбординг: нет аккаунта ──────────────���────────────── */}
      {noAccounts && (
        <OnboardingBanner onGoAccounts={() => onNavigate?.('accounts')} />
      )}

      {/* ── Есть аккаунт, но нет данных → подсказка синхронизации */}
      {noData && (
        <div style={{
          background: '#fffbeb', border: '1px solid #fcd34d',
          borderRadius: 10, padding: '24px 28px', marginBottom: 20,
          display: 'flex', alignItems: 'center', gap: 16,
        }}>
          <span style={{ fontSize: 32 }}>📡</span>
          <div>
            <div style={{ fontWeight: 600, color: '#78350f', marginBottom: 4 }}>Аккаунт подключён, данных нет</div>
            <div style={{ color: '#92400e', fontSize: 13 }}>
              Перейдите в раздел <strong>🏪 Аккаунты</strong> и нажмите «Синхронизировать»,
              чтобы загрузить данные с WB. Это займёт 1–2 минуты.
            </div>
          </div>
        </div>
      )}

      {/* ── Пояснение формул (только когда есть реальные данные) */}
      {hasData && (
        <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, padding: '10px 16px', marginBottom: 16, fontSize: 12, color: '#78350f', lineHeight: 1.6 }}>
          <b>📐 Формулы расчёта:</b><br/>
          <b>Оплатили покупатели</b> = <code>finishedPrice × (1 − spp/100) × кол-во</code> — финальная цена после скидки продавца и СПП. Отменённые заказы исключены.<br/>
          <b>Начислено WB</b> = <code>ppvz_for_pay</code> из финансового отчёта WB = Выручка − комиссия WB − логистика − хранение. WB закрывает расчёты раз в неделю (по понедельникам).<br/>
          <span style={{ color: '#92400e' }}>⚠ Если числа расходятся с WB-кабинетом — это нормально: WB в кабинете показывает «Сумму заказов» (до СПП), а мы — «Оплачено покупателями» (после СПП).</span>
        </div>
      )}

      {/* ── KPI-карточки ──────────────��──────────────────────── */}
      {(hasData || loading) && (
        <div className="kpi-row">
          <div className="kpi-card">
            <div className="kpi-top"><span className="kpi-icon">📦</span><span className="kpi-label">Заказы</span></div>
            <div className="kpi-value">{fmt(ordersCount)} <span className="kpi-unit">шт</span></div>
            <div className="kpi-sub">всего оформлено</div>
          </div>

          <div className="kpi-card">
            <div className="kpi-top"><span className="kpi-icon">💳</span><span className="kpi-label">Оплатили покупатели</span></div>
            <div className="kpi-value">₽ {fmt(revenue)}</div>
            <div className="kpi-sub" title="finishedPrice × (1 − spp/100) × количество">
              finishedPrice · с учётом СПП ℹ
            </div>
          </div>

          <div className="kpi-card" title="ppvz_for_pay из WB финансового отчёта. WB закрывает расчёты раз в неделю.">
            <div className="kpi-top"><span className="kpi-icon">🏦</span><span className="kpi-label">Начислено WB</span></div>
            {payoutsLoading ? (
              <div className="kpi-value" style={{ fontSize: 14, color: '#9ca3af' }}>загрузка…</div>
            ) : payouts?.has_data ? (
              <div className="kpi-value">₽ {fmt(payouts.payout_sum)}</div>
            ) : payouts && !payouts.has_data && !payouts.api_error ? (
              <div>
                <div className="kpi-value" style={{ fontSize: 18 }}>—</div>
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

          <div className="kpi-card kpi-drr">
            <div className="kpi-top"><span className="kpi-icon">📊</span><span className="kpi-label">ДРР</span></div>
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
                  : <span className="kpi-drr-val" style={{ color: '#6b7280', fontSize: 13 }}>нет данных</span>
                }
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Топ товаров ───────────────���──────────────────────── */}
      {hasData && realData?.top_skus && realData.top_skus.length > 0 && (
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
            Топ-20 товаров за период
            {!realData.top_skus[0]?.name && (
              <span style={{ color: '#f59e0b', marginLeft: 8 }}>
                · Нажми «Синхронизировать» в Аккаунтах для загрузки названий
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── Нет топ-товаров после загрузки ────────────���─────── */}
      {hasData && realData?.top_skus?.length === 0 && (
        <div style={{ background: '#f8fafc', borderRadius: 10, padding: 32, textAlign: 'center', color: '#64748b', border: '1px dashed #cbd5e1' }}>
          Нет данных по товарам за выбранный период.
        </div>
      )}

    </div>
  )
}
