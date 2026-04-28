import { useState, useEffect, useCallback } from 'react'
import {
  accountsApi, campaignsApi, accountPrefs, autoSchedulesApi,
  type Account, type CampaignStat, type OverallDrrData, type ProductSubject, type CategoryPackResult, type AutoSchedule,
} from '../api'

// ─── Константы ────────────────────────────────────────────────────────────────
const STATUS_LABEL: Record<number, string> = { 9: 'Активна', 11: 'Пауза', 7: 'Завершена' }
const TYPE_LABEL: Record<number, string> = { 4: 'Каталог', 5: 'Карточка', 6: 'Поиск', 7: 'Рекоменд.', 8: 'Авто', 9: 'Поиск+Кат.' }

const SCHEDULE_2PEAKS = [0,0,0,0,0,0,80,80,80,80,100,100,100,100,80,80,80,80,80,100,100,100,100,0]
const SCHEDULE_DAY    = [0,0,0,0,0,0,0,80,100,100,100,100,100,100,100,100,100,80,60,30,0,0,0,0]
const SCHEDULE_24H    = Array(24).fill(100)
const WEEKEND_HOURS   = [0,0,0,0,0,0,80,80,80,80,80,80,100,100,100,100,100,100,100,100,80,80,0,0]

type Tab = 'stats' | 'manage' | 'sku' | 'schedule' | 'create'
type SortKey = keyof CampaignStat

// ─── Цветовые токены ──────────────────────────────────────────────────────────
const C = {
  bg: '#f8fafc',
  surface: '#ffffff',
  surfaceHover: '#f8fafc',
  border: '#e2e8f0',
  borderStrong: '#cbd5e1',
  primary: '#6366f1',
  primaryHover: '#4f46e5',
  primaryLight: '#eef2ff',
  primaryMid: '#a5b4fc',
  text: '#0f172a',
  textSec: '#475569',
  textMuted: '#94a3b8',
  success: '#059669',
  successBg: '#ecfdf5',
  successBorder: '#a7f3d0',
  warning: '#d97706',
  warningBg: '#fffbeb',
  warningBorder: '#fcd34d',
  danger: '#dc2626',
  dangerBg: '#fef2f2',
  dangerBorder: '#fecaca',
  shadow: '0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
  shadowMd: '0 4px 6px -1px rgba(0,0,0,0.07), 0 2px 4px -1px rgba(0,0,0,0.04)',
}

// ─── Хелперы ──────────────────────────────────────────────────────────────────
function fmt(n: number, d = 0) { return n.toLocaleString('ru-RU', { maximumFractionDigits: d }) }

function drrColor(v: number | null): string {
  if (v == null) return C.textMuted
  if (v <= 10) return C.success
  if (v <= 20) return C.warning
  return C.danger
}

function drrBadge(v: number | null): React.CSSProperties {
  if (v == null) return { background: '#f1f5f9', color: C.textMuted }
  if (v <= 10) return { background: C.successBg, color: C.success }
  if (v <= 20) return { background: C.warningBg, color: C.warning }
  return { background: C.dangerBg, color: C.danger }
}

// ─── Общие стили ──────────────────────────────────────────────────────────────
const card: React.CSSProperties = {
  background: C.surface, borderRadius: 12, border: `1px solid ${C.border}`,
  boxShadow: C.shadow,
}

function btn(active: boolean, variant: 'primary' | 'default' | 'danger' | 'success' = 'default'): React.CSSProperties {
  if (active && variant === 'primary') return {
    background: C.primary, color: '#fff', border: `1px solid ${C.primary}`,
    borderRadius: 8, padding: '6px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600,
  }
  if (variant === 'danger') return {
    background: C.dangerBg, color: C.danger, border: `1px solid ${C.dangerBorder}`,
    borderRadius: 8, padding: '6px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600,
  }
  if (variant === 'success') return {
    background: C.successBg, color: C.success, border: `1px solid ${C.successBorder}`,
    borderRadius: 8, padding: '6px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600,
  }
  return {
    background: active ? '#f1f5f9' : C.surface, color: active ? C.text : C.textSec,
    border: `1px solid ${active ? C.borderStrong : C.border}`,
    borderRadius: 8, padding: '6px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 500,
  }
}

const inputStyle: React.CSSProperties = {
  background: C.surface, color: C.text, border: `1px solid ${C.border}`,
  borderRadius: 8, padding: '8px 12px', fontSize: 13, width: '100%',
  boxSizing: 'border-box', outline: 'none', transition: 'border-color 0.15s',
}

// ─── Компонент расписания (heatmap 24 часа) ───────────────────────────────────
function HourGrid({ hours }: { hours: number[] }) {
  return (
    <div style={{ display: 'flex', gap: 2, marginTop: 6 }}>
      {hours.map((pct, h) => {
        const alpha = pct / 100
        const bg = pct === 0
          ? '#f1f5f9'
          : `rgba(99, 102, 241, ${0.12 + alpha * 0.88})`
        const textColor = pct >= 60 ? '#fff' : C.primary
        return (
          <div key={h} title={`${h}:00 — ${pct}%`} style={{
            flex: 1, height: 26, borderRadius: 4, background: bg,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'background 0.15s',
          }}>
            {pct > 0 && (
              <span style={{ fontSize: 7, color: textColor, fontWeight: 700, lineHeight: 1 }}>
                {h}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Бейдж статуса ────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: number | null }) {
  const styles: Record<number, React.CSSProperties> = {
    9:  { background: C.successBg, color: C.success, border: `1px solid ${C.successBorder}` },
    11: { background: C.warningBg, color: C.warning, border: `1px solid ${C.warningBorder}` },
    7:  { background: '#f1f5f9', color: C.textMuted, border: `1px solid ${C.border}` },
  }
  const dots: Record<number, string> = { 9: '●', 11: '●', 7: '●' }
  const s = status ?? 0
  return (
    <span style={{
      ...(styles[s] ?? styles[7]),
      fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 6,
      display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap',
    }}>
      {dots[s] ?? '●'} {STATUS_LABEL[s] ?? 'Неизвестно'}
    </span>
  )
}

// ─── Toast-уведомление ────────────────────────────────────────────────────────
function Toast({ msg, type = 'success' }: { msg: string; type?: 'success' | 'error' }) {
  if (!msg) return null
  const colors = type === 'success'
    ? { background: C.successBg, color: C.success, border: C.successBorder }
    : { background: C.dangerBg, color: C.danger, border: C.dangerBorder }
  return (
    <div style={{
      background: colors.background, color: colors.color,
      border: `1px solid ${colors.border}`,
      borderRadius: 10, padding: '10px 16px', fontSize: 13, fontWeight: 500,
      marginBottom: 12,
    }}>
      {msg}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// ГЛАВНЫЙ КОМПОНЕНТ
// ══════════════════════════════════════════════════════════════════════════════
export function WbCampaignManager() {
  const [tab, setTab] = useState<Tab>('stats')
  const [accounts, setAccounts] = useState<Account[]>([])
  const [accountId, setAccountId] = useState('')

  function pickAccount(id: string) { setAccountId(id); accountPrefs.set(id) }

  useEffect(() => {
    accountsApi.list().then(a => {
      const wb = a.filter(x => x.marketplace === 'wb')
      setAccounts(wb)
      const saved = accountPrefs.get()
      const pick = wb.find(x => x.id === saved) ?? wb[0]
      if (pick) pickAccount(pick.id)
    })
  }, [])

  const tabs: { id: Tab; label: string }[] = [
    { id: 'stats',    label: 'Статистика'          },
    { id: 'manage',   label: 'Управление'           },
    { id: 'sku',      label: '🚀 Массовое создание' },
    { id: 'schedule', label: '📅 Расписание'        },
    { id: 'create',   label: 'По категории'         },
  ]

  return (
    <div style={{ background: C.bg, minHeight: '100%' }}>
      {/* Шапка */}
      <div style={{
        background: C.surface, borderBottom: `1px solid ${C.border}`,
        padding: '0 28px', position: 'sticky', top: 0, zIndex: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, height: 56 }}>
          <span style={{ color: C.text, fontWeight: 700, fontSize: 16, letterSpacing: '-0.3px' }}>
            Рекламные кампании WB
          </span>

          {accounts.length > 0 && (
            <select
              value={accountId}
              onChange={e => pickAccount(e.target.value)}
              style={{
                background: C.surface, color: C.text, border: `1px solid ${C.border}`,
                borderRadius: 8, padding: '5px 12px', fontSize: 13, outline: 'none',
                cursor: 'pointer',
              }}
            >
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          )}

          <nav style={{ display: 'flex', gap: 2, marginLeft: 8 }}>
            {tabs.map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  padding: '0 16px', height: 56, fontSize: 13, fontWeight: 500,
                  color: tab === t.id ? C.primary : C.textSec,
                  borderBottom: tab === t.id ? `2px solid ${C.primary}` : '2px solid transparent',
                  transition: 'all 0.15s',
                }}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>
      </div>

      {/* Контент */}
      <div style={{ padding: 28, maxWidth: 1400, margin: '0 auto' }}>
        {!accountId && (
          <div style={{ ...card, padding: 48, textAlign: 'center', color: C.textMuted }}>
            Добавьте WB аккаунт в разделе «Аккаунты»
          </div>
        )}
        {accountId && tab === 'stats'    && <StatsTab    accountId={accountId} />}
        {accountId && tab === 'manage'   && <ManageTab   accountId={accountId} />}
        {accountId && tab === 'sku'      && <SkuCreateTab accountId={accountId} />}
        {accountId && tab === 'schedule' && <ScheduleTab  accountId={accountId} />}
        {accountId && tab === 'create'   && <CreateTab    accountId={accountId} />}
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// ВКЛАДКА: СТАТИСТИКА
// ══════════════════════════════════════════════════════════════════════════════
function StatsTab({ accountId }: { accountId: string }) {
  const [days, setDays] = useState(7)
  const [stats, setStats] = useState<CampaignStat[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('spend')
  const [sortDir, setSortDir] = useState<'asc'|'desc'>('desc')
  const [editCpmId, setEditCpmId] = useState<number | null>(null)
  const [editCpmVal, setEditCpmVal] = useState('')
  const [editRowId, setEditRowId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [editBudget, setEditBudget] = useState('')
  const [msg, setMsg] = useState('')
  const [msgType, setMsgType] = useState<'success'|'error'>('success')
  const [overallDrr, setOverallDrr] = useState<OverallDrrData | null>(null)
  const [overallDays, setOverallDays] = useState(30)
  const [overallOpen, setOverallOpen] = useState(false)

  function flash(m: string, t: 'success'|'error' = 'success') {
    setMsg(m); setMsgType(t); setTimeout(() => setMsg(''), 4000)
  }

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { setStats(await campaignsApi.stats(accountId, days)) }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Ошибка загрузки') }
    finally { setLoading(false) }
  }, [accountId, days])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    campaignsApi.overallDrr(accountId, overallDays).then(setOverallDrr).catch(() => {})
  }, [accountId, overallDays])

  async function handlePause(id: number) {
    try { await campaignsApi.pause(id, accountId); flash('Кампания поставлена на паузу'); load() }
    catch (e: unknown) { flash(e instanceof Error ? e.message : 'Ошибка', 'error') }
  }
  async function handleResume(id: number) {
    try { await campaignsApi.resume(id, accountId); flash('Кампания запущена'); load() }
    catch (e: unknown) { flash(e instanceof Error ? e.message : 'Ошибка', 'error') }
  }
  async function handleSetCpm(advertId: number, typeNum: number) {
    const cpm = parseInt(editCpmVal)
    if (!cpm || cpm < 5) { flash('Ставка должна быть ≥ 5 ₽', 'error'); return }
    try {
      await campaignsApi.setCpm(advertId, { account_id: accountId, cpm, advert_type: typeNum || 8 })
      flash(`CPM установлен: ${cpm} ₽`); setEditCpmId(null); setEditCpmVal('')
    } catch (e: unknown) { flash(e instanceof Error ? e.message : 'Ошибка', 'error') }
  }
  async function handleUpdate(id: number) {
    try {
      const body: { name?: string; budget_add?: number } = {}
      if (editName.trim()) body.name = editName.trim()
      if (editBudget && +editBudget > 0) body.budget_add = +editBudget
      await campaignsApi.update(id, accountId, body)
      flash('Сохранено'); setEditRowId(null); load()
    } catch (e: unknown) { flash(e instanceof Error ? e.message : 'Ошибка', 'error') }
  }

  function sort(k: SortKey) {
    if (sortKey === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(k); setSortDir('desc') }
  }

  const sorted = [...stats].sort((a, b) => {
    const av = a[sortKey] ?? 0, bv = b[sortKey] ?? 0
    const diff = typeof av === 'string'
      ? (av as string).localeCompare(bv as string)
      : (av as number) - (bv as number)
    return sortDir === 'asc' ? diff : -diff
  })

  const totalSpend   = stats.reduce((s, r) => s + r.spend, 0)
  const totalRevenue = stats.reduce((s, r) => s + r.revenue, 0)
  const totalDrr     = totalRevenue > 0 ? totalSpend / totalRevenue * 100 : null

  const Th = ({ label, k, align = 'right' as const }: { label: string; k: SortKey; align?: 'left'|'right' }) => (
    <th
      onClick={() => sort(k)}
      style={{
        padding: '11px 14px', textAlign: align, cursor: 'pointer', userSelect: 'none',
        background: C.surface, color: sortKey === k ? C.primary : C.textMuted,
        fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
        borderBottom: `1px solid ${C.border}`, letterSpacing: '0.04em',
      }}
    >
      {label}{sortKey === k ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
    </th>
  )

  return (
    <div>
      {/* Тулбар */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 3 }}>
          {[7, 14, 30].map(d => (
            <button key={d} onClick={() => setDays(d)} style={{
              background: days === d ? C.primary : 'transparent',
              color: days === d ? '#fff' : C.textSec,
              border: 'none', borderRadius: 7, padding: '5px 14px',
              cursor: 'pointer', fontSize: 13, fontWeight: days === d ? 600 : 400,
              transition: 'all 0.15s',
            }}>
              {d} дней
            </button>
          ))}
        </div>
        <button
          onClick={load}
          style={{ ...btn(false), marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}
        >
          {loading ? '↻ Загрузка...' : '↻ Обновить'}
        </button>
      </div>

      <Toast msg={msg} type={msgType} />
      {error && <Toast msg={error} type="error" />}

      {/* Метрики */}
      {stats.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
          {[
            { label: 'Рекламный расход',  val: `${fmt(totalSpend)} ₽`,   sub: `за ${days} дней` },
            { label: 'Доход от рекламы',  val: `${fmt(totalRevenue)} ₽`, sub: `за ${days} дней` },
            { label: 'ДРР',               val: totalDrr != null ? `${totalDrr.toFixed(1)}%` : '—',
              valColor: drrColor(totalDrr) },
            { label: 'Активных кампаний', val: String(stats.filter(s => s.status === 9).length),
              sub: `из ${stats.length} всего` },
          ].map(s => (
            <div key={s.label} style={{ ...card, padding: '16px 20px' }}>
              <div style={{ color: C.textMuted, fontSize: 12, marginBottom: 4 }}>{s.label}</div>
              <div style={{ color: (s as { valColor?: string }).valColor ?? C.text, fontWeight: 700, fontSize: 22, letterSpacing: '-0.5px' }}>
                {s.val}
              </div>
              {(s as { sub?: string }).sub && (
                <div style={{ color: C.textMuted, fontSize: 11, marginTop: 2 }}>{(s as { sub?: string }).sub}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Общий ДРР */}
      {overallDrr && (
        <div style={{ ...card, marginBottom: 20, overflow: 'hidden' }}>
          <div
            onClick={() => setOverallOpen(o => !o)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '14px 20px', cursor: 'pointer',
              borderBottom: overallOpen ? `1px solid ${C.border}` : 'none',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <span style={{ color: C.text, fontWeight: 600, fontSize: 14 }}>Общий ДРР аккаунта</span>
              <div style={{ display: 'flex', gap: 4, background: '#f1f5f9', borderRadius: 8, padding: 3 }}>
                {[30, 60, 90].map(d => (
                  <button key={d} onClick={e => { e.stopPropagation(); setOverallDays(d) }} style={{
                    background: overallDays === d ? C.surface : 'transparent',
                    border: overallDays === d ? `1px solid ${C.border}` : '1px solid transparent',
                    borderRadius: 6, padding: '3px 10px', cursor: 'pointer', fontSize: 12,
                    color: overallDays === d ? C.text : C.textSec, fontWeight: overallDays === d ? 600 : 400,
                  }}>
                    {d} дн.
                  </button>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
              <div style={{ textAlign: 'right' }}>
                <div style={{ color: C.textMuted, fontSize: 11 }}>Реклама</div>
                <div style={{ color: drrColor(overallDrr.drr_ad), fontWeight: 700, fontSize: 18 }}>
                  {overallDrr.drr_ad != null ? `${overallDrr.drr_ad}%` : '—'}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ color: C.textMuted, fontSize: 11 }}>Общий</div>
                <div style={{ color: drrColor(overallDrr.drr_total), fontWeight: 700, fontSize: 22 }}>
                  {overallDrr.drr_total != null ? `${overallDrr.drr_total}%` : '—'}
                </div>
              </div>
              <span style={{ color: C.textMuted, fontSize: 16 }}>{overallOpen ? '▲' : '▼'}</span>
            </div>
          </div>
          {overallOpen && (
            <div style={{ padding: '16px 20px', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {[
                { label: 'Рекл. расход',  val: `${fmt(overallDrr.ad_spend, 2)} ₽`,     color: C.danger  },
                { label: 'Услуги WB',     val: `${fmt(overallDrr.service_costs, 2)} ₽`, color: C.warning },
                { label: 'Итого расходов',val: `${fmt(overallDrr.total_costs, 2)} ₽`,   color: C.text    },
                { label: 'Вся выручка',   val: `${fmt(overallDrr.total_revenue, 2)} ₽`, color: C.success },
              ].map(s => (
                <div key={s.label} style={{ background: C.bg, borderRadius: 8, padding: '10px 16px', border: `1px solid ${C.border}` }}>
                  <div style={{ color: C.textMuted, fontSize: 11 }}>{s.label}</div>
                  <div style={{ color: s.color, fontWeight: 700, fontSize: 16, marginTop: 2 }}>{s.val}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Таблица */}
      {loading && !stats.length ? (
        <div style={{ ...card, padding: 60, textAlign: 'center', color: C.textMuted }}>
          Загрузка данных...
        </div>
      ) : (
        <div style={{ ...card, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto', maxHeight: 520 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1120 }}>
              <thead>
                <tr>
                  <Th label="КАМПАНИЯ"  k="name"    align="left" />
                  <Th label="СТАТУС"    k="status"  align="left" />
                  <th style={{
                    padding: '11px 14px', textAlign: 'center', userSelect: 'none',
                    background: C.surface, color: C.textMuted,
                    fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
                    borderBottom: `1px solid ${C.border}`, letterSpacing: '0.04em',
                  }}>
                    СТАВКИ РЫНКА
                  </th>
                  <Th label="ПОКАЗЫ"    k="views"   />
                  <Th label="КЛИКИ"     k="clicks"  />
                  <Th label="КОРЗИНА"   k="atbs"    />
                  <Th label="ЗАКАЗЫ"    k="orders"  />
                  <Th label="ВЫКУПЫ"    k="shks"    />
                  <Th label="РАСХОД ₽"  k="spend"   />
                  <Th label="ДОХОД ₽"   k="revenue" />
                  <Th label="ДРР"       k="drr"     />
                  <th style={{ padding: '11px 14px', background: C.surface, borderBottom: `1px solid ${C.border}`, width: 140 }} />
                </tr>
              </thead>
              <tbody>
                {sorted.map((row, i) => (
                  <tr
                    key={row.advert_id}
                    style={{
                      background: i % 2 === 0 ? C.surface : '#fcfcfd',
                      transition: 'background 0.1s',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = C.bg)}
                    onMouseLeave={e => (e.currentTarget.style.background = i % 2 === 0 ? C.surface : '#fcfcfd')}
                  >
                    {editRowId === row.advert_id ? (
                      <td colSpan={12} style={{ padding: '12px 14px', borderBottom: `1px solid ${C.border}` }}>
                        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                          <input
                            style={{ ...inputStyle, width: 260 }}
                            value={editName}
                            onChange={e => setEditName(e.target.value)}
                            placeholder="Новое название"
                          />
                          <input
                            style={{ ...inputStyle, width: 140 }}
                            type="number"
                            value={editBudget}
                            onChange={e => setEditBudget(e.target.value)}
                            placeholder="Пополнить бюджет ₽"
                          />
                          <button onClick={() => handleUpdate(row.advert_id)} style={btn(true, 'primary')}>
                            Сохранить
                          </button>
                          <button onClick={() => setEditRowId(null)} style={btn(false)}>Отмена</button>
                        </div>
                      </td>
                    ) : (
                      <>
                        <td style={{ padding: '11px 14px', borderBottom: `1px solid ${C.border}` }}>
                          <div style={{ color: C.text, fontWeight: 500, fontSize: 13, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {row.name}
                          </div>
                          <div style={{ color: C.textMuted, fontSize: 11, marginTop: 1 }}>
                            #{row.advert_id} · {TYPE_LABEL[row.type ?? 0] ?? '—'}
                          </div>
                        </td>
                        <td style={{ padding: '11px 14px', borderBottom: `1px solid ${C.border}` }}>
                          <StatusBadge status={row.status} />
                        </td>
                        <td style={{ padding: '8px 14px', borderBottom: `1px solid ${C.border}`, minWidth: 140 }}>
                          {row.cpm_min != null ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                                <span style={{ fontSize: 10, color: C.textMuted, fontWeight: 600, letterSpacing: '0.04em' }}>МИН</span>
                                <span style={{ fontSize: 12, color: C.textSec, fontWeight: 600, background: '#f1f5f9', borderRadius: 4, padding: '1px 6px' }}>
                                  {row.cpm_min} ₽
                                </span>
                              </div>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                                <span style={{ fontSize: 10, color: C.warning, fontWeight: 600, letterSpacing: '0.04em' }}>КОНК</span>
                                <span style={{ fontSize: 12, color: C.warning, fontWeight: 600, background: C.warningBg, borderRadius: 4, padding: '1px 6px' }}>
                                  {row.cpm_competitive} ₽
                                </span>
                              </div>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                                <span style={{ fontSize: 10, color: C.primary, fontWeight: 600, letterSpacing: '0.04em' }}>ТОП</span>
                                <span style={{ fontSize: 12, color: C.primary, fontWeight: 600, background: C.primaryLight, borderRadius: 4, padding: '1px 6px' }}>
                                  {row.cpm_top10} ₽
                                </span>
                              </div>
                            </div>
                          ) : (
                            <span style={{ color: C.textMuted, fontSize: 12 }}>—</span>
                          )}
                        </td>
                        <td style={{ padding: '11px 14px', textAlign: 'right', color: C.textSec, fontSize: 13, borderBottom: `1px solid ${C.border}` }}>
                          {fmt(row.views)}
                        </td>
                        <td style={{ padding: '11px 14px', textAlign: 'right', color: C.textSec, fontSize: 13, borderBottom: `1px solid ${C.border}` }}>
                          {fmt(row.clicks)}
                        </td>
                        <td style={{ padding: '11px 14px', textAlign: 'right', color: C.textSec, fontSize: 13, borderBottom: `1px solid ${C.border}` }}>
                          {fmt(row.atbs)}
                        </td>
                        <td style={{ padding: '11px 14px', textAlign: 'right', color: C.text, fontWeight: 500, fontSize: 13, borderBottom: `1px solid ${C.border}` }}>
                          {fmt(row.orders)}
                        </td>
                        <td style={{ padding: '11px 14px', textAlign: 'right', color: C.textSec, fontSize: 13, borderBottom: `1px solid ${C.border}` }}>
                          {fmt(row.shks)}
                        </td>
                        <td style={{ padding: '11px 14px', textAlign: 'right', color: C.danger, fontWeight: 600, fontSize: 13, borderBottom: `1px solid ${C.border}` }}>
                          {fmt(row.spend, 2)}
                        </td>
                        <td style={{ padding: '11px 14px', textAlign: 'right', color: C.success, fontWeight: 600, fontSize: 13, borderBottom: `1px solid ${C.border}` }}>
                          {fmt(row.revenue, 2)}
                        </td>
                        <td style={{ padding: '11px 14px', textAlign: 'right', borderBottom: `1px solid ${C.border}` }}>
                          {editCpmId === row.advert_id ? (
                            <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                              <input
                                style={{ ...inputStyle, width: 70, padding: '4px 8px' }}
                                value={editCpmVal}
                                onChange={e => setEditCpmVal(e.target.value)}
                                type="number"
                                autoFocus
                                onKeyDown={e => { if (e.key === 'Enter') handleSetCpm(row.advert_id, row.type ?? 8) }}
                              />
                              <button onClick={() => handleSetCpm(row.advert_id, row.type ?? 8)} style={btn(true, 'primary')}>
                                ✓
                              </button>
                              <button onClick={() => setEditCpmId(null)} style={btn(false)}>✕</button>
                            </div>
                          ) : (
                            <span
                              onClick={() => { setEditCpmId(row.advert_id); setEditCpmVal('') }}
                              style={{
                                ...drrBadge(row.drr),
                                fontSize: 12, fontWeight: 700, padding: '2px 8px',
                                borderRadius: 6, cursor: 'pointer', display: 'inline-block',
                              }}
                            >
                              {row.drr != null ? `${row.drr}%` : '—'}
                            </span>
                          )}
                        </td>
                        <td style={{ padding: '11px 14px', textAlign: 'right', borderBottom: `1px solid ${C.border}` }}>
                          <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                            {row.status === 9 && (
                              <button onClick={() => handlePause(row.advert_id)} style={{ ...btn(false), padding: '4px 10px', fontSize: 12 }}>
                                ⏸ Пауза
                              </button>
                            )}
                            {row.status === 11 && (
                              <button onClick={() => handleResume(row.advert_id)} style={{ ...btn(false, 'success'), padding: '4px 10px', fontSize: 12 }}>
                                ▶ Пуск
                              </button>
                            )}
                            <button
                              onClick={() => { setEditRowId(row.advert_id); setEditName(''); setEditBudget('') }}
                              style={{ ...btn(false), padding: '4px 10px', fontSize: 12 }}
                            >
                              Изменить
                            </button>
                          </div>
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!stats.length && !loading && (
            <div style={{ padding: 48, textAlign: 'center', color: C.textMuted }}>
              Нет данных за выбранный период
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// ВКЛАДКА: УПРАВЛЕНИЕ
// ══════════════════════════════════════════════════════════════════════════════
function ManageTab({ accountId }: { accountId: string }) {
  const [campaigns, setCampaigns] = useState<Array<{
    advert_id: number; name: string; type: number | null; status: number | null; cpm: number
  }>>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [editId, setEditId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [editBudget, setEditBudget] = useState('')
  const [msg, setMsg] = useState('')
  const [msgType, setMsgType] = useState<'success'|'error'>('success')
  const [filterStatus, setFilterStatus] = useState<number | null>(null)

  function flash(m: string, t: 'success'|'error' = 'success') {
    setMsg(m); setMsgType(t); setTimeout(() => setMsg(''), 4000)
  }

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { setCampaigns(await campaignsApi.list(accountId)) }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Ошибка') }
    finally { setLoading(false) }
  }, [accountId])

  useEffect(() => { load() }, [load])

  async function handlePause(id: number) {
    try { await campaignsApi.pause(id, accountId); flash('Кампания поставлена на паузу'); load() }
    catch (e: unknown) { flash(e instanceof Error ? e.message : 'Ошибка', 'error') }
  }
  async function handleResume(id: number) {
    try { await campaignsApi.resume(id, accountId); flash('Кампания запущена'); load() }
    catch (e: unknown) { flash(e instanceof Error ? e.message : 'Ошибка', 'error') }
  }
  async function handleUpdate(id: number) {
    try {
      const body: { name?: string; budget_add?: number } = {}
      if (editName.trim()) body.name = editName.trim()
      if (editBudget && +editBudget > 0) body.budget_add = +editBudget
      await campaignsApi.update(id, accountId, body)
      flash('Сохранено'); setEditId(null); load()
    } catch (e: unknown) { flash(e instanceof Error ? e.message : 'Ошибка', 'error') }
  }

  const filtered = filterStatus != null ? campaigns.filter(c => c.status === filterStatus) : campaigns

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 24 }}>
      {/* Список кампаний */}
      <div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 4, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 3 }}>
            {[
              { label: 'Все', val: null },
              { label: 'Активные', val: 9 },
              { label: 'На паузе', val: 11 },
            ].map(f => (
              <button key={String(f.val)} onClick={() => setFilterStatus(f.val)} style={{
                background: filterStatus === f.val ? C.primary : 'transparent',
                color: filterStatus === f.val ? '#fff' : C.textSec,
                border: 'none', borderRadius: 7, padding: '5px 14px',
                cursor: 'pointer', fontSize: 13, fontWeight: filterStatus === f.val ? 600 : 400,
                transition: 'all 0.15s',
              }}>
                {f.label}
              </button>
            ))}
          </div>
          <span style={{ color: C.textMuted, fontSize: 13 }}>{filtered.length} кампаний</span>
          <button onClick={load} style={{ ...btn(false), marginLeft: 'auto' }}>
            {loading ? '↻ Загрузка...' : '↻ Обновить'}
          </button>
        </div>

        <Toast msg={msg} type={msgType} />
        {error && <Toast msg={error} type="error" />}

        {loading && !campaigns.length ? (
          <div style={{ ...card, padding: 48, textAlign: 'center', color: C.textMuted }}>
            Загрузка кампаний...
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ ...card, padding: 48, textAlign: 'center' }}>
            <div style={{ color: C.textMuted, marginBottom: 8 }}>Нет кампаний</div>
            <div style={{ color: C.textMuted, fontSize: 13 }}>Создайте кампании во вкладке «Создать по категории»</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {filtered.map(c => (
              <div key={c.advert_id} style={{
                background: C.surface, border: `1px solid ${C.border}`,
                borderRadius: 10, padding: '14px 16px',
                transition: 'box-shadow 0.15s',
              }}>
                {editId === c.advert_id ? (
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input
                      style={{ ...inputStyle, flex: 1, minWidth: 200 }}
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      placeholder={c.name}
                    />
                    <input
                      style={{ ...inputStyle, width: 180 }}
                      type="number"
                      value={editBudget}
                      onChange={e => setEditBudget(e.target.value)}
                      placeholder="Пополнить бюджет ₽"
                    />
                    <button onClick={() => handleUpdate(c.advert_id)} style={btn(true, 'primary')}>
                      Сохранить
                    </button>
                    <button onClick={() => setEditId(null)} style={btn(false)}>Отмена</button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    <StatusBadge status={c.status} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: C.text, fontWeight: 500, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.name}
                      </div>
                      <div style={{ color: C.textMuted, fontSize: 12, marginTop: 1 }}>
                        #{c.advert_id} · {TYPE_LABEL[c.type ?? 0] ?? '—'}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      {c.status === 9 && (
                        <button onClick={() => handlePause(c.advert_id)} style={{ ...btn(false), padding: '5px 12px', fontSize: 12 }}>
                          ⏸ Пауза
                        </button>
                      )}
                      {c.status === 11 && (
                        <button onClick={() => handleResume(c.advert_id)} style={{ ...btn(false, 'success'), padding: '5px 12px', fontSize: 12 }}>
                          ▶ Запустить
                        </button>
                      )}
                      <button
                        onClick={() => { setEditId(c.advert_id); setEditName(''); setEditBudget('') }}
                        style={{ ...btn(false), padding: '5px 12px', fontSize: 12 }}
                      >
                        Изменить
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Авто-расписание */}
      <AutoSchedulePanel accountId={accountId} />
    </div>
  )
}

// ─── Авто-расписание будни/выходные ───────────────────────────────────────────
function AutoSchedulePanel({ accountId }: { accountId: string }) {
  const [configs, setConfigs] = useState<AutoSchedule[]>([])
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [advertIdsInput, setAdvertIdsInput] = useState('')
  const [weekdayPreset, setWeekdayPreset] = useState<'2peaks'|'day'|'24h'>('2peaks')
  const [weekendPreset, setWeekendPreset] = useState<'weekend'|'day'|'24h'>('weekend')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [msgType, setMsgType] = useState<'success'|'error'>('success')

  const weekdayHours = weekdayPreset === '2peaks' ? SCHEDULE_2PEAKS
    : weekdayPreset === 'day' ? SCHEDULE_DAY : SCHEDULE_24H
  const weekendHours = weekendPreset === 'weekend' ? WEEKEND_HOURS
    : weekendPreset === 'day' ? SCHEDULE_DAY : SCHEDULE_24H

  function flash(m: string, t: 'success'|'error' = 'success') {
    setMsg(m); setMsgType(t); setTimeout(() => setMsg(''), 4000)
  }

  const load = useCallback(() => {
    autoSchedulesApi.list(accountId).then(setConfigs).catch(() => {})
  }, [accountId])

  useEffect(() => { load() }, [load])

  async function handleSave() {
    if (!name.trim() || !advertIdsInput.trim()) return
    const advert_ids = advertIdsInput.split(/[\s,]+/).map(Number).filter(Boolean)
    if (!advert_ids.length) { flash('Введите ID кампаний', 'error'); return }
    setSaving(true)
    try {
      await autoSchedulesApi.create({
        account_id: accountId, name: name.trim(), advert_ids,
        weekday_hours: weekdayHours, weekend_hours: weekendHours,
      })
      flash('Авто-расписание сохранено')
      setShowForm(false); setName(''); setAdvertIdsInput(''); load()
    } catch (e: unknown) { flash(e instanceof Error ? e.message : 'Ошибка', 'error') }
    finally { setSaving(false) }
  }

  const presetBtn = (active: boolean) => ({
    background: active ? C.primaryLight : C.surface,
    color: active ? C.primary : C.textSec,
    border: `1px solid ${active ? C.primaryMid : C.border}`,
    borderRadius: 8, padding: '5px 12px', cursor: 'pointer', fontSize: 12, fontWeight: active ? 600 : 400,
  } as React.CSSProperties)

  return (
    <div style={{ ...card, padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 15 }}>Авто-переключение расписания</div>
          <div style={{ color: C.textMuted, fontSize: 13, marginTop: 3 }}>
            Пятница 22:00 → выходной режим · Понедельник 06:00 → будни
          </div>
        </div>
        <button onClick={() => setShowForm(f => !f)} style={btn(showForm, showForm ? 'default' : 'primary')}>
          {showForm ? 'Отмена' : '+ Добавить'}
        </button>
      </div>

      <Toast msg={msg} type={msgType} />

      {showForm && (
        <div style={{ background: C.bg, borderRadius: 12, padding: 20, marginBottom: 20, border: `1px solid ${C.border}` }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 20 }}>
            <div>
              <label style={{ color: C.textMuted, fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>
                НАЗВАНИЕ ГРУППЫ
              </label>
              <input
                style={inputStyle}
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Удобрения — авто-расписание"
              />
            </div>
            <div>
              <label style={{ color: C.textMuted, fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>
                ID КАМПАНИЙ (через запятую)
              </label>
              <input
                style={inputStyle}
                value={advertIdsInput}
                onChange={e => setAdvertIdsInput(e.target.value)}
                placeholder="123456, 789012, 345678"
              />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
            {[
              { label: 'Будни (Пн–Пт)', presets: [['2peaks','2 Пика'],['day','Дневной'],['24h','24/7']] as [string,string][],
                val: weekdayPreset, set: setWeekdayPreset, hours: weekdayHours },
              { label: 'Выходные (Сб–Вс)', presets: [['weekend','Выходной'],['day','Дневной'],['24h','24/7']] as [string,string][],
                val: weekendPreset, set: setWeekendPreset, hours: weekendHours },
            ].map(col => (
              <div key={col.label}>
                <div style={{ color: C.textSec, fontSize: 12, fontWeight: 600, marginBottom: 10 }}>{col.label}</div>
                <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                  {col.presets.map(([v, l]) => (
                    <button key={v} onClick={() => col.set(v as never)} style={presetBtn(col.val === v)}>{l}</button>
                  ))}
                </div>
                <HourGrid hours={col.hours} />
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button
              onClick={handleSave}
              disabled={saving || !name.trim() || !advertIdsInput.trim()}
              style={{
                background: C.primary, color: '#fff', border: 'none', borderRadius: 8,
                padding: '9px 24px', fontWeight: 700, cursor: 'pointer', fontSize: 14,
                opacity: saving || !name.trim() || !advertIdsInput.trim() ? 0.5 : 1,
              }}
            >
              {saving ? 'Сохранение...' : 'Сохранить расписание'}
            </button>
          </div>
        </div>
      )}

      {configs.length === 0 ? (
        <div style={{ color: C.textMuted, fontSize: 13, textAlign: 'center', padding: '20px 0' }}>
          Нет сохранённых авто-расписаний
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {configs.map(c => (
            <div key={c.id} style={{
              background: c.is_active ? C.surface : '#fafafa',
              border: `1px solid ${c.is_active ? C.border : C.border}`,
              borderRadius: 10, padding: '14px 16px',
              opacity: c.is_active ? 1 : 0.7,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{
                    background: c.is_active ? C.successBg : '#f1f5f9',
                    color: c.is_active ? C.success : C.textMuted,
                    border: `1px solid ${c.is_active ? C.successBorder : C.border}`,
                    fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 6,
                  }}>
                    {c.is_active ? '● Активно' : '○ Выключено'}
                  </span>
                  <span style={{ color: C.text, fontWeight: 600, fontSize: 14 }}>{c.name}</span>
                  <span style={{ color: C.textMuted, fontSize: 12 }}>{c.advert_ids.length} кампаний</span>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={async () => { try { await autoSchedulesApi.toggle(c.id); load() } catch (e: unknown) { flash(e instanceof Error ? e.message : 'Ошибка', 'error') } }}
                    style={{ ...btn(false, c.is_active ? 'default' : 'success'), padding: '5px 12px', fontSize: 12 }}
                  >
                    {c.is_active ? '⏸ Выкл' : '▶ Вкл'}
                  </button>
                  <button
                    onClick={async () => { try { await autoSchedulesApi.delete(c.id); load() } catch (e: unknown) { flash(e instanceof Error ? e.message : 'Ошибка', 'error') } }}
                    style={{ ...btn(false, 'danger'), padding: '5px 10px', fontSize: 12 }}
                  >
                    Удалить
                  </button>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div>
                  <div style={{ color: C.textMuted, fontSize: 11, fontWeight: 600, marginBottom: 4 }}>БУДНИ</div>
                  <HourGrid hours={c.weekday_hours} />
                </div>
                <div>
                  <div style={{ color: C.textMuted, fontSize: 11, fontWeight: 600, marginBottom: 4 }}>ВЫХОДНЫЕ</div>
                  <HourGrid hours={c.weekend_hours} />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// ВКЛАДКА: СОЗДАТЬ ПО КАТЕГОРИИ
// ══════════════════════════════════════════════════════════════════════════════
function CreateTab({ accountId }: { accountId: string }) {
  const [subjects, setSubjects] = useState<ProductSubject[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [subjectSearch, setSubjectSearch] = useState('')
  const [selectedSubject, setSelectedSubject] = useState<ProductSubject | null>(null)
  const [selectedNmIds, setSelectedNmIds] = useState<Set<number>>(new Set())
  const [namePrefix, setNamePrefix] = useState('')
  const [budget, setBudget] = useState('500')
  const [cpm, setCpm] = useState('150')
  const [schedulePreset, setSchedulePreset] = useState<'2peaks'|'day'|'24h'>('2peaks')
  const [creating, setCreating] = useState(false)
  const [result, setResult] = useState<CategoryPackResult | null>(null)
  const [msg, setMsg] = useState('')
  const [msgType, setMsgType] = useState<'success'|'error'>('success')

  const scheduleHours = schedulePreset === '2peaks' ? SCHEDULE_2PEAKS
    : schedulePreset === 'day' ? SCHEDULE_DAY : SCHEDULE_24H

  function flash(m: string, t: 'success'|'error' = 'success') {
    setMsg(m); setMsgType(t); setTimeout(() => setMsg(''), 5000)
  }

  useEffect(() => {
    setLoading(true); setError('')
    campaignsApi.productsBySubject(accountId)
      .then(setSubjects)
      .catch(e => setError(e instanceof Error ? e.message : 'Ошибка загрузки товаров'))
      .finally(() => setLoading(false))
  }, [accountId])

  const filteredSubjects = subjects.filter(s =>
    s.subject_name.toLowerCase().includes(subjectSearch.toLowerCase())
  )

  function selectSubject(s: ProductSubject) {
    setSelectedSubject(s)
    setSelectedNmIds(new Set(s.products.map(p => p.nm_id)))
    if (!namePrefix) setNamePrefix(s.subject_name)
    setResult(null)
  }

  function toggleNm(id: number) {
    setSelectedNmIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  async function handleCreate() {
    if (!selectedSubject || selectedNmIds.size === 0 || !namePrefix.trim()) return
    setCreating(true); setResult(null)
    try {
      const res = await campaignsApi.createCategoryPack({
        account_id: accountId,
        nm_ids: [...selectedNmIds],
        name_prefix: namePrefix.trim(),
        budget: parseInt(budget) || 500,
        cpm: parseInt(cpm) || 150,
        schedule_hours: scheduleHours,
      })
      setResult(res)
      flash(`Создано ${res.created_count} кампаний${res.error_count ? `, ${res.error_count} ошибок` : ''}`,
        res.error_count > 0 ? 'error' : 'success')
    } catch (e: unknown) {
      flash(e instanceof Error ? e.message : 'Ошибка', 'error')
    } finally {
      setCreating(false)
    }
  }

  const scheduleOptions: { id: '2peaks'|'day'|'24h'; label: string; desc: string }[] = [
    { id: '2peaks', label: '2 Пика',  desc: 'Утро 10–14 и вечер 19–23 · Ночь выключена' },
    { id: 'day',    label: 'Дневной', desc: 'С 08:00 до 20:00 · Ночь выключена'          },
    { id: '24h',    label: '24/7',    desc: 'Реклама работает круглосуточно'              },
  ]

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 24, alignItems: 'start' }}>

      {/* ── Левая колонка: категории ── */}
      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '16px 16px 12px', borderBottom: `1px solid ${C.border}` }}>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 14, marginBottom: 10 }}>
            Категории товаров
          </div>
          <input
            style={inputStyle}
            placeholder="Поиск..."
            value={subjectSearch}
            onChange={e => setSubjectSearch(e.target.value)}
          />
        </div>

        <div style={{ maxHeight: 560, overflowY: 'auto' }}>
          {loading ? (
            <div style={{ padding: 32, textAlign: 'center', color: C.textMuted, fontSize: 13 }}>
              Загрузка из WB...
            </div>
          ) : error ? (
            <div style={{ padding: 16 }}>
              <Toast msg={error} type="error" />
            </div>
          ) : filteredSubjects.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: C.textMuted, fontSize: 13 }}>
              Нет категорий
            </div>
          ) : filteredSubjects.map(s => (
            <button
              key={s.subject_name}
              onClick={() => selectSubject(s)}
              style={{
                width: '100%', background: selectedSubject?.subject_name === s.subject_name ? C.primaryLight : 'transparent',
                border: 'none', borderBottom: `1px solid ${C.border}`,
                padding: '12px 16px', cursor: 'pointer', textAlign: 'left',
                transition: 'background 0.1s',
              }}
            >
              <div style={{
                color: selectedSubject?.subject_name === s.subject_name ? C.primary : C.text,
                fontWeight: selectedSubject?.subject_name === s.subject_name ? 600 : 400,
                fontSize: 13,
              }}>
                {s.subject_name}
              </div>
              <div style={{ color: C.textMuted, fontSize: 11, marginTop: 1 }}>
                {s.products.length} товаров
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* ── Правая колонка ── */}
      {!selectedSubject ? (
        <div style={{ ...card, padding: 60, textAlign: 'center' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>←</div>
          <div style={{ color: C.text, fontWeight: 600, fontSize: 16, marginBottom: 6 }}>
            Выберите категорию
          </div>
          <div style={{ color: C.textMuted, fontSize: 13 }}>
            Слева выберите категорию, чтобы начать создание кампаний
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Список товаров */}
          <div style={{ ...card, padding: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <div>
                <div style={{ color: C.text, fontWeight: 700, fontSize: 15 }}>
                  {selectedSubject.subject_name}
                </div>
                <div style={{ color: C.textMuted, fontSize: 12, marginTop: 2 }}>
                  {selectedNmIds.size} из {selectedSubject.products.length} товаров выбрано
                </div>
              </div>
              <button
                onClick={() => {
                  if (selectedNmIds.size === selectedSubject.products.length)
                    setSelectedNmIds(new Set())
                  else
                    setSelectedNmIds(new Set(selectedSubject.products.map(p => p.nm_id)))
                }}
                style={btn(false)}
              >
                {selectedNmIds.size === selectedSubject.products.length ? 'Снять все' : 'Выбрать все'}
              </button>
            </div>

            <div style={{ maxHeight: 240, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {selectedSubject.products.map(p => {
                const checked = selectedNmIds.has(p.nm_id)
                return (
                  <label key={p.nm_id} style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '9px 12px',
                    background: checked ? C.primaryLight : C.surface,
                    border: `1px solid ${checked ? C.primaryMid : C.border}`,
                    borderRadius: 8, cursor: 'pointer', transition: 'all 0.1s',
                  }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleNm(p.nm_id)}
                      style={{ accentColor: C.primary, flexShrink: 0, width: 16, height: 16 }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: C.text, fontSize: 13, fontWeight: checked ? 500 : 400,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p.name}
                      </div>
                      <div style={{ color: C.textMuted, fontSize: 11 }}>
                        Арт. {p.nm_id}{p.vendor_code ? ` · ${p.vendor_code}` : ''}
                      </div>
                    </div>
                  </label>
                )
              })}
            </div>
          </div>

          {/* Параметры кампаний */}
          <div style={{ ...card, padding: 20 }}>
            <div style={{ color: C.text, fontWeight: 700, fontSize: 15, marginBottom: 16 }}>
              Параметры кампаний
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px 140px', gap: 14, marginBottom: 20 }}>
              <div>
                <label style={{ color: C.textMuted, fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>
                  ПРЕФИКС НАЗВАНИЯ
                </label>
                <input
                  style={inputStyle}
                  value={namePrefix}
                  onChange={e => setNamePrefix(e.target.value)}
                  placeholder={selectedSubject.subject_name}
                />
                <div style={{ color: C.textMuted, fontSize: 11, marginTop: 4 }}>
                  Пример: «{namePrefix || selectedSubject.subject_name} — 12345678»
                </div>
              </div>
              <div>
                <label style={{ color: C.textMuted, fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>
                  БЮДЖЕТ, ₽
                </label>
                <input
                  style={inputStyle}
                  type="number"
                  value={budget}
                  onChange={e => setBudget(e.target.value)}
                  min="500" step="100"
                />
              </div>
              <div>
                <label style={{ color: C.textMuted, fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>
                  СТАРТОВЫЙ CPM, ₽
                </label>
                <input
                  style={inputStyle}
                  type="number"
                  value={cpm}
                  onChange={e => setCpm(e.target.value)}
                  min="5" step="10"
                />
              </div>
            </div>

            {/* Расписание */}
            <div>
              <label style={{ color: C.textMuted, fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', display: 'block', marginBottom: 10 }}>
                РАСПИСАНИЕ ПОКАЗОВ
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 12 }}>
                {scheduleOptions.map(opt => (
                  <button
                    key={opt.id}
                    onClick={() => setSchedulePreset(opt.id)}
                    style={{
                      background: schedulePreset === opt.id ? C.primaryLight : C.surface,
                      border: `1px solid ${schedulePreset === opt.id ? C.primary : C.border}`,
                      borderRadius: 10, padding: '12px 14px', cursor: 'pointer', textAlign: 'left',
                      transition: 'all 0.15s',
                    }}
                  >
                    <div style={{ color: schedulePreset === opt.id ? C.primary : C.text, fontWeight: 600, fontSize: 13, marginBottom: 3 }}>
                      {opt.label}
                    </div>
                    <div style={{ color: schedulePreset === opt.id ? C.primary : C.textMuted, fontSize: 11, opacity: 0.8 }}>
                      {opt.desc}
                    </div>
                  </button>
                ))}
              </div>

              <div style={{ background: C.bg, borderRadius: 10, padding: '10px 12px', border: `1px solid ${C.border}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  {['0', '6', '12', '18', '23'].map(h => (
                    <span key={h} style={{ color: C.textMuted, fontSize: 10 }}>{h}:00</span>
                  ))}
                </div>
                <HourGrid hours={scheduleHours} />
              </div>
            </div>
          </div>

          {/* CTA */}
          <div>
            <Toast msg={msg} type={msgType} />

            <button
              onClick={handleCreate}
              disabled={creating || selectedNmIds.size === 0 || !namePrefix.trim()}
              style={{
                width: '100%', background: C.primary, color: '#fff', border: 'none',
                borderRadius: 12, padding: '14px', fontWeight: 700, cursor: 'pointer',
                fontSize: 15, letterSpacing: '-0.2px',
                opacity: creating || selectedNmIds.size === 0 || !namePrefix.trim() ? 0.5 : 1,
                transition: 'opacity 0.15s, background 0.15s',
              }}
            >
              {creating
                ? 'Создание кампаний...'
                : selectedNmIds.size === 0
                  ? 'Выберите товары для запуска'
                  : `Создать ${selectedNmIds.size} кампаний · CPM ${cpm} ₽`}
            </button>
          </div>

          {/* Результат */}
          {result && (
            <div style={{ ...card, padding: 20 }}>
              <div style={{ display: 'flex', gap: 16, marginBottom: 14 }}>
                <div style={{ background: C.successBg, border: `1px solid ${C.successBorder}`, borderRadius: 8, padding: '8px 16px', flex: 1, textAlign: 'center' }}>
                  <div style={{ color: C.success, fontWeight: 700, fontSize: 22 }}>{result.created_count}</div>
                  <div style={{ color: C.success, fontSize: 12 }}>создано</div>
                </div>
                {result.error_count > 0 && (
                  <div style={{ background: C.dangerBg, border: `1px solid ${C.dangerBorder}`, borderRadius: 8, padding: '8px 16px', flex: 1, textAlign: 'center' }}>
                    <div style={{ color: C.danger, fontWeight: 700, fontSize: 22 }}>{result.error_count}</div>
                    <div style={{ color: C.danger, fontSize: 12 }}>ошибок</div>
                  </div>
                )}
              </div>

              <div style={{ maxHeight: 200, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {result.campaigns.map(c => (
                  <div key={c.advert_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
                    background: C.successBg, borderRadius: 6, fontSize: 12 }}>
                    <span style={{ color: C.success, fontWeight: 700 }}>✓</span>
                    <span style={{ color: C.textSec }}>#{c.advert_id}</span>
                    <span style={{ color: C.text }}>{c.name}</span>
                  </div>
                ))}
                {result.errors.map((e, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
                    background: C.dangerBg, borderRadius: 6, fontSize: 12 }}>
                    <span style={{ color: C.danger, fontWeight: 700 }}>✗</span>
                    <span style={{ color: C.textSec }}>nm_id {e.nm_id}</span>
                    <span style={{ color: C.danger }}>{e.error}</span>
                  </div>
                ))}
              </div>

              <div style={{ color: C.textMuted, fontSize: 12, marginTop: 10 }}>
                Перейдите во вкладку «Статистика» или «Управление» чтобы увидеть новые кампании
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}


// ══════════════════════════════════════════════════════════════════════════════
// ВКЛАДКА: МАССОВОЕ СОЗДАНИЕ ПО SKU
// ══════════════════════════════════════════════════════════════════════════════
function SkuCreateTab({ accountId }: { accountId: string }) {
  const [skus, setSkus] = useState<{ sku: string; name: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [budget, setBudget] = useState('500')
  const [cpm, setCpm] = useState('150')
  const [schedulePreset, setSchedulePreset] = useState<'2peaks'|'day'|'24h'>('2peaks')
  const [peak1From, setPeak1From] = useState(8)
  const [peak1To, setPeak1To] = useState(13)
  const [peak2From, setPeak2From] = useState(19)
  const [peak2To, setPeak2To] = useState(23)
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [result, setResult] = useState<CategoryPackResult | null>(null)
  const [msg, setMsg] = useState('')
  const [msgType, setMsgType] = useState<'success'|'error'>('success')

  function flash(m: string, t: 'success'|'error' = 'success') {
    setMsg(m); setMsgType(t); setTimeout(() => setMsg(''), 6000)
  }

  useEffect(() => {
    setLoading(true)
    campaignsApi.skuNames(accountId)
      .then(data => { setSkus(data); setSelected(new Set(data.map(s => s.sku))) })
      .catch(() => flash('Ошибка загрузки товаров. Запустите синхронизацию.', 'error'))
      .finally(() => setLoading(false))
  }, [accountId])

  function buildScheduleHours(): number[] {
    if (schedulePreset === '24h') return Array(24).fill(100)
    if (schedulePreset === 'day') return Array.from({ length: 24 }, (_, h) => h >= 8 && h < 21 ? 100 : 0)
    // 2 peaks: custom
    return Array.from({ length: 24 }, (_, h) =>
      (h >= peak1From && h < peak1To) || (h >= peak2From && h < peak2To) ? 100 : 0
    )
  }

  function toggleSku(sku: string) {
    setSelected(prev => { const n = new Set(prev); n.has(sku) ? n.delete(sku) : n.add(sku); return n })
  }
  function selectAll() { setSkus(s => { setSelected(new Set(s.map(x => x.sku))); return s }) }
  function clearAll() { setSelected(new Set()) }

  const filtered = skus.filter(s =>
    s.name.toLowerCase().includes(search.toLowerCase()) || s.sku.includes(search)
  )

  async function handleCreate() {
    const nmIds = [...selected].map(Number).filter(Boolean)
    if (!nmIds.length) { flash('Выберите хотя бы один товар', 'error'); return }
    const budgetN = parseInt(budget) || 500
    const cpmN = parseInt(cpm) || 150
    if (budgetN < 100) { flash('Минимальный бюджет 100 ₽', 'error'); return }
    if (cpmN < 5) { flash('Минимальная ставка CPM 5 ₽', 'error'); return }
    setCreating(true); setResult(null)
    try {
      const res = await campaignsApi.createSkuPack({
        account_id: accountId,
        nm_ids: nmIds,
        budget: budgetN,
        cpm: cpmN,
        schedule_hours: buildScheduleHours(),
      })
      setResult(res)
      flash(
        `✅ Создано ${res.created_count} кампаний${res.error_count ? ` · ${res.error_count} ошибок` : ''}`,
        res.error_count > 0 && res.created_count === 0 ? 'error' : 'success'
      )
    } catch (e: unknown) {
      flash(e instanceof Error ? e.message : 'Ошибка создания кампаний', 'error')
    } finally {
      setCreating(false)
    }
  }

  const hours = buildScheduleHours()

  const hourLabel = (h: number) => `${h}:00`

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 24, alignItems: 'start' }}>

      {/* ── Левая колонка: список SKU ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ ...card, padding: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: C.text }}>
              Выбор товаров
              <span style={{ fontWeight: 400, fontSize: 13, color: C.textMuted, marginLeft: 10 }}>
                {selected.size} из {skus.length} выбрано
              </span>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={selectAll} style={btn(false)}>Все</button>
              <button onClick={clearAll} style={btn(false)}>Снять</button>
            </div>
          </div>
          <input
            style={{ ...inputStyle, marginBottom: 12 }}
            placeholder="Поиск по названию или артикулу…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {loading ? (
            <div style={{ textAlign: 'center', color: C.textMuted, padding: 32 }}>Загрузка товаров…</div>
          ) : skus.length === 0 ? (
            <div style={{ textAlign: 'center', color: C.textMuted, padding: 32 }}>
              <div style={{ fontSize: 24, marginBottom: 8 }}>📦</div>
              <div>Нет данных о товарах</div>
              <div style={{ fontSize: 12, marginTop: 4 }}>Запустите синхронизацию в разделе «Аккаунты»</div>
            </div>
          ) : (
            <div style={{ maxHeight: 520, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {filtered.map(s => (
                <label key={s.sku} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '9px 12px', borderRadius: 8, cursor: 'pointer',
                  background: selected.has(s.sku) ? C.primaryLight : 'transparent',
                  border: `1px solid ${selected.has(s.sku) ? C.primaryMid : 'transparent'}`,
                  transition: 'all 0.12s',
                }}>
                  <input
                    type="checkbox"
                    checked={selected.has(s.sku)}
                    onChange={() => toggleSku(s.sku)}
                    style={{ accentColor: C.primary, width: 15, height: 15, flexShrink: 0 }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: C.text, fontWeight: 500, lineHeight: 1.3 }}>{s.name}</div>
                    <div style={{ fontSize: 11, color: C.textMuted, marginTop: 1 }}>#{s.sku}</div>
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Уведомления и результаты */}
        <Toast msg={msg} type={msgType} />
        {result && (
          <div style={{ ...card, padding: 20 }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 12 }}>Результат создания</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
              <div style={{ background: C.successBg, borderRadius: 8, padding: '12px 16px', border: `1px solid ${C.successBorder}` }}>
                <div style={{ fontSize: 24, fontWeight: 700, color: C.success }}>{result.created_count}</div>
                <div style={{ fontSize: 12, color: C.success }}>Создано кампаний</div>
              </div>
              {result.error_count > 0 && (
                <div style={{ background: C.dangerBg, borderRadius: 8, padding: '12px 16px', border: `1px solid ${C.dangerBorder}` }}>
                  <div style={{ fontSize: 24, fontWeight: 700, color: C.danger }}>{result.error_count}</div>
                  <div style={{ fontSize: 12, color: C.danger }}>Ошибок</div>
                </div>
              )}
            </div>
            {result.campaigns.length > 0 && (
              <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                {result.campaigns.map((c: { nm_id: number; advert_id: number; name: string }) => (
                  <div key={c.advert_id} style={{ padding: '6px 0', borderBottom: `1px solid ${C.border}`, fontSize: 12 }}>
                    <span style={{ color: C.success, fontWeight: 600 }}>✓</span>{' '}
                    <span style={{ color: C.text }}>{c.name}</span>{' '}
                    <span style={{ color: C.textMuted }}>→ #{c.advert_id}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Правая колонка: параметры ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, position: 'sticky', top: 80 }}>

        {/* Бюджет и CPM */}
        <div style={{ ...card, padding: 20 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 14 }}>Параметры кампаний</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label style={{ fontSize: 12, color: C.textMuted, fontWeight: 600, display: 'block', marginBottom: 5 }}>
                БЮДЖЕТ НА КАМПАНИЮ, ₽
              </label>
              <input type="number" style={inputStyle} value={budget} onChange={e => setBudget(e.target.value)} min="100" step="100" />
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 3 }}>Минимум 100 ₽</div>
            </div>
            <div>
              <label style={{ fontSize: 12, color: C.textMuted, fontWeight: 600, display: 'block', marginBottom: 5 }}>
                СТАВКА CPM, ₽ за 1000 показов
              </label>
              <input type="number" style={inputStyle} value={cpm} onChange={e => setCpm(e.target.value)} min="5" step="5" />
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 3 }}>Минимум 5 ₽</div>
            </div>
          </div>
        </div>

        {/* Расписание */}
        <div style={{ ...card, padding: 20 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 14 }}>Расписание показов</div>
          <div style={{ display: 'flex', gap: 4, marginBottom: 14 }}>
            {(['2peaks','day','24h'] as const).map(p => (
              <button key={p} onClick={() => setSchedulePreset(p)} style={{
                flex: 1, padding: '6px 0', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                background: schedulePreset === p ? C.primary : '#f1f5f9',
                color: schedulePreset === p ? '#fff' : C.textSec,
              }}>
                {p === '2peaks' ? '2 Пика' : p === 'day' ? 'День' : '24/7'}
              </button>
            ))}
          </div>

          {schedulePreset === '2peaks' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: C.textMuted, fontWeight: 600 }}>ПИК 1 (УТРО)</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <select style={{ ...inputStyle, flex: 1 }} value={peak1From} onChange={e => setPeak1From(+e.target.value)}>
                  {Array.from({length: 24}, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
                </select>
                <span style={{ color: C.textMuted, fontSize: 12 }}>—</span>
                <select style={{ ...inputStyle, flex: 1 }} value={peak1To} onChange={e => setPeak1To(+e.target.value)}>
                  {Array.from({length: 24}, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
                </select>
              </div>
              <div style={{ fontSize: 12, color: C.textMuted, fontWeight: 600 }}>ПИК 2 (ВЕЧЕР)</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <select style={{ ...inputStyle, flex: 1 }} value={peak2From} onChange={e => setPeak2From(+e.target.value)}>
                  {Array.from({length: 24}, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
                </select>
                <span style={{ color: C.textMuted, fontSize: 12 }}>—</span>
                <select style={{ ...inputStyle, flex: 1 }} value={peak2To} onChange={e => setPeak2To(+e.target.value)}>
                  {Array.from({length: 24}, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
                </select>
              </div>
            </div>
          )}
          {schedulePreset === 'day' && (
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 14, padding: '8px 10px', background: '#f8fafc', borderRadius: 6 }}>
              Показы с 08:00 до 21:00, ночь выключена
            </div>
          )}
          {schedulePreset === '24h' && (
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 14, padding: '8px 10px', background: '#f8fafc', borderRadius: 6 }}>
              Реклама работает круглосуточно
            </div>
          )}

          {/* Превью расписания */}
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 6 }}>ПРЕДПРОСМОТР (24 часа)</div>
          <HourGrid hours={hours} />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: C.textMuted, marginTop: 3 }}>
            <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:00</span>
          </div>
        </div>

        {/* Кнопка создать */}
        <button
          onClick={handleCreate}
          disabled={creating || selected.size === 0}
          style={{
            ...btn(true, 'primary'),
            padding: '14px 20px', fontSize: 14, borderRadius: 10,
            opacity: creating || selected.size === 0 ? 0.5 : 1,
            cursor: creating || selected.size === 0 ? 'not-allowed' : 'pointer',
          }}
        >
          {creating
            ? '⏳ Создаём кампании…'
            : `🚀 Создать ${selected.size} кампани${selected.size === 1 ? 'ю' : selected.size < 5 ? 'и' : 'й'}`
          }
        </button>
        <div style={{ fontSize: 11, color: C.textMuted, textAlign: 'center' }}>
          Каждая кампания: авто-режим · CPM · имя = название SKU
        </div>
      </div>
    </div>
  )
}


// ══════════════════════════════════════════════════════════════════════════════
// ВКЛАДКА: РАСПИСАНИЕ (7×24 СЕТКА + МАССОВОЕ ПРИМЕНЕНИЕ)
// ══════════════════════════════════════════════════════════════════════════════
const DAY_NAMES = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
const DAY_FULL  = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье']

type GridState = boolean[][]  // [day 0-6][hour 0-23]

function makeGrid(hours: number[]): GridState {
  return Array.from({ length: 7 }, () => hours.map(h => h > 0))
}

function gridToHours(grid: GridState): number[] {
  // Объединяем все дни: если хотя бы один день активен в этот час → 100
  return Array.from({ length: 24 }, (_, h) => grid.some(day => day[h]) ? 100 : 0)
}

function ScheduleTab({ accountId }: { accountId: string }) {
  const [grid, setGrid] = useState<GridState>(makeGrid(SCHEDULE_2PEAKS))
  const [campaigns, setCampaigns] = useState<Array<{ advert_id: number; name: string; status: number | null }>>([])
  const [selectedCamps, setSelectedCamps] = useState<Set<number>>(new Set())
  const [loadingCamps, setLoadingCamps] = useState(true)
  const [applying, setApplying] = useState(false)
  const [msg, setMsg] = useState('')
  const [msgType, setMsgType] = useState<'success'|'error'>('success')
  const [isDragging, setIsDragging] = useState(false)
  const [dragValue, setDragValue] = useState(true)
  const [peak1From, setPeak1From] = useState(8)
  const [peak1To, setPeak1To] = useState(13)
  const [peak2From, setPeak2From] = useState(19)
  const [peak2To, setPeak2To] = useState(23)
  const [activeDays, setActiveDays] = useState<Set<number>>(new Set([0,1,2,3,4,5,6]))

  function flash(m: string, t: 'success'|'error' = 'success') {
    setMsg(m); setMsgType(t); setTimeout(() => setMsg(''), 5000)
  }

  useEffect(() => {
    setLoadingCamps(true)
    campaignsApi.list(accountId)
      .then(data => {
        const active = data.filter((c: { status: number | null }) => c.status === 9 || c.status === 11)
        setCampaigns(active)
        setSelectedCamps(new Set(active.map((c: { advert_id: number }) => c.advert_id)))
      })
      .catch(() => {})
      .finally(() => setLoadingCamps(false))
  }, [accountId])

  function toggleCell(day: number, hour: number) {
    setGrid(g => g.map((row, d) => d === day ? row.map((v, h) => h === hour ? !v : v) : row))
  }

  function toggleDay(day: number) {
    const allOn = grid[day].every(v => v)
    setGrid(g => g.map((row, d) => d === day ? row.map(() => !allOn) : row))
  }

  function toggleHour(hour: number) {
    const allOn = grid.every(row => row[hour])
    setGrid(g => g.map(row => row.map((v, h) => h === hour ? !allOn : v)))
  }

  function applyPreset2Peaks() {
    const h = Array.from({ length: 24 }, (_, i) =>
      (i >= peak1From && i < peak1To) || (i >= peak2From && i < peak2To)
    )
    setGrid(Array.from({ length: 7 }, (_, d) => activeDays.has(d) ? [...h] : Array(24).fill(false)))
  }

  function applyPresetDay() {
    const h = Array.from({ length: 24 }, (_, i) => i >= 8 && i < 21)
    setGrid(Array.from({ length: 7 }, (_, d) => activeDays.has(d) ? [...h] : Array(24).fill(false)))
  }

  function applyPreset24h() {
    setGrid(Array.from({ length: 7 }, (_, d) => activeDays.has(d) ? Array(24).fill(true) : Array(24).fill(false)))
  }

  function clearGrid() { setGrid(Array.from({ length: 7 }, () => Array(24).fill(false))) }

  function toggleCamp(id: number) {
    setSelectedCamps(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  async function handleApply() {
    const ids = [...selectedCamps]
    if (!ids.length) { flash('Выберите хотя бы одну кампанию', 'error'); return }
    const hours = gridToHours(grid)
    if (hours.every(h => h === 0)) { flash('Расписание пустое — включите хотя бы один час', 'error'); return }
    setApplying(true)
    try {
      const res = await campaignsApi.bulkSchedule(accountId, ids, hours) as { applied: number; total: number }
      flash(`✅ Расписание применено к ${res.applied} из ${res.total} кампаний`)
    } catch (e: unknown) {
      flash(e instanceof Error ? e.message : 'Ошибка', 'error')
    } finally {
      setApplying(false)
    }
  }

  const totalActive = grid.flat().filter(Boolean).length

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 24, alignItems: 'start' }}>

      {/* ── Левая: расписание + кампании ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Пресеты и настройка пиков */}
        <div style={{ ...card, padding: 20 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 16 }}>Настройка расписания</div>

          {/* Дни недели */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: C.textMuted, fontWeight: 600, marginBottom: 8 }}>ДНИ НЕДЕЛИ</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {DAY_NAMES.map((d, i) => (
                <button key={i} onClick={() => {
                  setActiveDays(prev => {
                    const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n
                  })
                }} style={{
                  padding: '5px 10px', borderRadius: 7, border: 'none', cursor: 'pointer',
                  fontSize: 12, fontWeight: 600,
                  background: activeDays.has(i) ? (i >= 5 ? '#fef3c7' : C.primaryLight) : '#f1f5f9',
                  color: activeDays.has(i) ? (i >= 5 ? '#92400e' : C.primary) : C.textMuted,
                }}>
                  {d}
                </button>
              ))}
            </div>
          </div>

          {/* Пики */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 12, color: C.textMuted, fontWeight: 600, marginBottom: 6 }}>🌅 ПИК 1 (УТРО)</div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <select style={{ ...inputStyle, flex: 1 }} value={peak1From} onChange={e => setPeak1From(+e.target.value)}>
                  {Array.from({length: 24}, (_, h) => <option key={h} value={h}>{h}:00</option>)}
                </select>
                <span style={{ color: C.textMuted }}>—</span>
                <select style={{ ...inputStyle, flex: 1 }} value={peak1To} onChange={e => setPeak1To(+e.target.value)}>
                  {Array.from({length: 24}, (_, h) => <option key={h} value={h}>{h}:00</option>)}
                </select>
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: C.textMuted, fontWeight: 600, marginBottom: 6 }}>🌆 ПИК 2 (ВЕЧЕР)</div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <select style={{ ...inputStyle, flex: 1 }} value={peak2From} onChange={e => setPeak2From(+e.target.value)}>
                  {Array.from({length: 24}, (_, h) => <option key={h} value={h}>{h}:00</option>)}
                </select>
                <span style={{ color: C.textMuted }}>—</span>
                <select style={{ ...inputStyle, flex: 1 }} value={peak2To} onChange={e => setPeak2To(+e.target.value)}>
                  {Array.from({length: 24}, (_, h) => <option key={h} value={h}>{h}:00</option>)}
                </select>
              </div>
            </div>
          </div>

          {/* Пресеты */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={applyPreset2Peaks} style={{ ...btn(false), background: C.primaryLight, color: C.primary, border: `1px solid ${C.primaryMid}`, fontWeight: 600 }}>
              ⚡ Два пика
            </button>
            <button onClick={applyPresetDay} style={btn(false)}>☀️ Рабочий день</button>
            <button onClick={applyPreset24h} style={btn(false)}>🔄 24/7</button>
            <button onClick={clearGrid} style={{ ...btn(false, 'danger') }}>✕ Очистить</button>
          </div>
        </div>

        {/* 7×24 сетка */}
        <div style={{ ...card, padding: 20, overflow: 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: C.text }}>Сетка расписания</div>
            <div style={{ fontSize: 12, color: C.textMuted }}>
              Активно: <strong style={{ color: C.primary }}>{totalActive}</strong> ячеек из 168 · Нажмите на ячейку для переключения
            </div>
          </div>

          <div style={{ minWidth: 700 }}>
            {/* Шапка часов */}
            <div style={{ display: 'grid', gridTemplateColumns: '36px repeat(24, 1fr)', gap: 2, marginBottom: 2 }}>
              <div />
              {Array.from({ length: 24 }, (_, h) => (
                <div
                  key={h}
                  onClick={() => toggleHour(h)}
                  title={`${h}:00 — нажать чтобы переключить весь столбец`}
                  style={{
                    textAlign: 'center', fontSize: 9, color: C.textMuted,
                    cursor: 'pointer', padding: '2px 0', borderRadius: 3,
                    background: '#f8fafc', userSelect: 'none',
                  }}
                >
                  {h}
                </div>
              ))}
            </div>

            {/* Строки по дням */}
            {grid.map((dayRow, d) => (
              <div key={d} style={{ display: 'grid', gridTemplateColumns: '36px repeat(24, 1fr)', gap: 2, marginBottom: 2 }}>
                <div
                  onClick={() => toggleDay(d)}
                  title={`${DAY_FULL[d]} — нажать чтобы переключить весь день`}
                  style={{
                    fontSize: 10, fontWeight: 700, color: d >= 5 ? '#92400e' : C.textSec,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    cursor: 'pointer', userSelect: 'none',
                    background: d >= 5 ? '#fef9c3' : '#f8fafc', borderRadius: 4,
                  }}
                >
                  {DAY_NAMES[d]}
                </div>
                {dayRow.map((active, h) => (
                  <div
                    key={h}
                    onMouseDown={() => { setIsDragging(true); setDragValue(!active); toggleCell(d, h) }}
                    onMouseEnter={() => { if (isDragging) setGrid(g => g.map((row, rd) => rd === d ? row.map((v, rh) => rh === h ? dragValue : v) : row)) }}
                    onMouseUp={() => setIsDragging(false)}
                    title={`${DAY_FULL[d]} ${h}:00–${h+1}:00`}
                    style={{
                      height: 24, borderRadius: 3, cursor: 'pointer',
                      background: active
                        ? `rgba(99, 102, 241, ${0.7 + 0.3 * (h >= peak1From && h < peak1To || h >= peak2From && h < peak2To ? 1 : 0.5)})`
                        : '#f1f5f9',
                      border: active ? '1px solid rgba(99,102,241,0.3)' : '1px solid transparent',
                      transition: 'background 0.1s',
                      userSelect: 'none',
                    }}
                  />
                ))}
              </div>
            ))}
          </div>

          {/* Легенда */}
          <div style={{ display: 'flex', gap: 16, marginTop: 12, fontSize: 11, color: C.textMuted }}>
            <span>🟦 Реклама активна</span>
            <span>⬜ Реклама выключена</span>
            <span style={{ color: '#92400e' }}>Жёлтый = выходные</span>
          </div>
        </div>

        {/* Кампании */}
        <div style={{ ...card, padding: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: C.text }}>
              Кампании для применения
              <span style={{ fontWeight: 400, fontSize: 13, color: C.textMuted, marginLeft: 8 }}>
                {selectedCamps.size} выбрано
              </span>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => setSelectedCamps(new Set(campaigns.map(c => c.advert_id)))} style={btn(false)}>Все</button>
              <button onClick={() => setSelectedCamps(new Set())} style={btn(false)}>Снять</button>
            </div>
          </div>
          {loadingCamps ? (
            <div style={{ textAlign: 'center', color: C.textMuted, padding: 20 }}>Загрузка…</div>
          ) : campaigns.length === 0 ? (
            <div style={{ textAlign: 'center', color: C.textMuted, padding: 20, fontSize: 13 }}>
              Нет активных кампаний
            </div>
          ) : (
            <div style={{ maxHeight: 300, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {campaigns.map(c => (
                <label key={c.advert_id} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
                  borderRadius: 7, cursor: 'pointer',
                  background: selectedCamps.has(c.advert_id) ? C.primaryLight : 'transparent',
                }}>
                  <input
                    type="checkbox"
                    checked={selectedCamps.has(c.advert_id)}
                    onChange={() => toggleCamp(c.advert_id)}
                    style={{ accentColor: C.primary, flexShrink: 0 }}
                  />
                  <span style={{ fontSize: 13, color: C.text, flex: 1 }}>{c.name}</span>
                  <StatusBadge status={c.status} />
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Правая: итог + применить ── */}
      <div style={{ position: 'sticky', top: 80, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Превью */}
        <div style={{ ...card, padding: 20 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 10 }}>Итоговые часы WB</div>
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 8 }}>
            WB применяет единое расписание на все дни. Показываем объединение всех выбранных дней:
          </div>
          <HourGrid hours={gridToHours(grid)} />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: C.textMuted, marginTop: 3 }}>
            <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:00</span>
          </div>
          <div style={{ fontSize: 12, color: C.textMuted, marginTop: 10 }}>
            Активных часов: <strong>{gridToHours(grid).filter(h => h > 0).length}</strong>/24
          </div>
        </div>

        <Toast msg={msg} type={msgType} />

        <button
          onClick={handleApply}
          disabled={applying || selectedCamps.size === 0}
          style={{
            ...btn(true, 'primary'), padding: '14px 20px', fontSize: 14, borderRadius: 10,
            opacity: applying || selectedCamps.size === 0 ? 0.5 : 1,
            cursor: applying || selectedCamps.size === 0 ? 'not-allowed' : 'pointer',
          }}
        >
          {applying ? '⏳ Применяем…' : `📅 Применить к ${selectedCamps.size} кампани${selectedCamps.size === 1 ? 'и' : 'ям'}`}
        </button>

        <div style={{ fontSize: 11, color: C.textMuted, textAlign: 'center', lineHeight: 1.5 }}>
          Расписание будет применено немедленно.<br/>
          WB API принимает единый 24-часовой шаблон.
        </div>
      </div>
    </div>
  )
}
