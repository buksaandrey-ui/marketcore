import { useState, useEffect, useCallback } from 'react'
import {
  accountsApi, campaignsApi, accountPrefs, autoSchedulesApi,
  type Account, type CampaignStat, type OverallDrrData, type ProductSubject, type CategoryPackResult, type AutoSchedule,
} from '../api'

// ─── Константы ───────────────────────────────────────────────────────────────
const STATUS_LABEL: Record<number, string> = { 9: '▶ Активна', 11: '⏸ Пауза', 7: '■ Завершена' }
const STATUS_COLOR: Record<number, string> = { 9: '#22c55e', 11: '#f59e0b', 7: '#64748b' }
const TYPE_LABEL: Record<number, string> = { 4: 'Каталог', 5: 'Карточка', 6: 'Поиск', 7: 'Рекоменд.', 8: 'Авто', 9: 'Поиск+Кат.' }

// Двойной пик: ночь 0-5=0%, утро 6-9=80%, пик1 10-13=100%, день 14-18=80%, пик2 19-22=100%, поздно 23=0%
const SCHEDULE_2PEAKS = [0,0,0,0,0,0,80,80,80,80,100,100,100,100,80,80,80,80,80,100,100,100,100,0]
const SCHEDULE_DAY    = [0,0,0,0,0,0,0,80,100,100,100,100,100,100,100,100,100,80,60,30,0,0,0,0]
const SCHEDULE_24H    = Array(24).fill(100)

type Tab = 'stats' | 'manage' | 'create'
type SortKey = keyof CampaignStat

function drrColor(v: number | null) {
  if (v == null) return '#64748b'
  if (v <= 10) return '#22c55e'
  if (v <= 20) return '#f59e0b'
  return '#ef4444'
}
function fmt(n: number, d = 0) { return n.toLocaleString('ru-RU', { maximumFractionDigits: d }) }

// ─── Стили ───────────────────────────────────────────────────────────────────
const S = {
  card: { background: '#1e293b', borderRadius: 10, padding: 16, border: '1px solid #334155', marginBottom: 12 } as React.CSSProperties,
  input: { background: '#0f172a', color: '#f1f5f9', border: '1px solid #334155', borderRadius: 6, padding: '6px 10px', fontSize: 13, width: '100%', boxSizing: 'border-box' } as React.CSSProperties,
  btn: (active = false, color = '#38bdf8') => ({
    background: active ? color : 'transparent', color: active ? '#0f172a' : color,
    border: `1px solid ${color}`, borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
  } as React.CSSProperties),
}

// ─── Расписание — визуальный редактор ────────────────────────────────────────
function SchedulePreview({ hours }: { hours: number[] }) {
  return (
    <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 36, marginTop: 6 }}>
      {hours.map((h, i) => (
        <div key={i} title={`${i}:00 — ${h}%`} style={{
          flex: 1, height: `${Math.max(4, h * 0.36)}px`,
          background: h >= 80 ? '#22c55e' : h >= 40 ? '#f59e0b' : h > 0 ? '#334155' : '#1e293b',
          borderRadius: 2,
        }} />
      ))}
    </div>
  )
}

// ─── Главный компонент ────────────────────────────────────────────────────────
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

  const tabStyle = (t: Tab) => ({
    padding: '11px 22px', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 600,
    background: tab === t ? '#1e293b' : 'transparent',
    color: tab === t ? '#f1f5f9' : '#64748b',
    borderBottom: tab === t ? '2px solid #38bdf8' : '2px solid transparent',
  } as React.CSSProperties)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Шапка с аккаунтом и вкладками */}
      <div style={{ background: '#0f172a', borderBottom: '1px solid #334155', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '10px 24px' }}>
          <span style={{ color: '#f1f5f9', fontWeight: 700, fontSize: 17 }}>📣 Рекламные кампании WB</span>
          <select
            value={accountId}
            onChange={e => pickAccount(e.target.value)}
            style={{ background: '#1e293b', color: '#f1f5f9', border: '1px solid #334155', borderRadius: 6, padding: '5px 10px', fontSize: 13 }}
          >
            {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex' }}>
          <button style={tabStyle('stats')}    onClick={() => setTab('stats')}>📊 Статистика</button>
          <button style={tabStyle('manage')}   onClick={() => setTab('manage')}>⚙️ Управление</button>
          <button style={tabStyle('create')}   onClick={() => setTab('create')}>🎯 Создать по категории</button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        {accountId && tab === 'stats'  && <StatsTab  accountId={accountId} />}
        {accountId && tab === 'manage' && <ManageTab accountId={accountId} />}
        {accountId && tab === 'create' && <CreateTab accountId={accountId} />}
        {!accountId && <div style={{ color: '#64748b', textAlign: 'center', padding: 60 }}>Добавь WB аккаунт в разделе «Аккаунты»</div>}
      </div>
    </div>
  )
}

// ─── Вкладка: Статистика ──────────────────────────────────────────────────────
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
  const [overallDrr, setOverallDrr] = useState<OverallDrrData | null>(null)
  const [overallDays, setOverallDays] = useState(30)
  const [overallOpen, setOverallOpen] = useState(false)

  function flash(m: string) { setMsg(m); setTimeout(() => setMsg(''), 4000) }

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { setStats(await campaignsApi.stats(accountId, days)) }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Ошибка') }
    finally { setLoading(false) }
  }, [accountId, days])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    campaignsApi.overallDrr(accountId, overallDays).then(setOverallDrr).catch(() => {})
  }, [accountId, overallDays])

  async function handlePause(id: number) {
    try { await campaignsApi.pause(id, accountId); flash('⏸ Пауза'); load() }
    catch (e: unknown) { flash(e instanceof Error ? e.message : 'Ошибка') }
  }
  async function handleResume(id: number) {
    try { await campaignsApi.resume(id, accountId); flash('▶ Запущена'); load() }
    catch (e: unknown) { flash(e instanceof Error ? e.message : 'Ошибка') }
  }
  async function handleSetCpm(advertId: number, typeNum: number) {
    const cpm = parseInt(editCpmVal)
    if (!cpm || cpm < 5) { flash('Ставка должна быть ≥ 5 ₽'); return }
    try {
      await campaignsApi.setCpm(advertId, { account_id: accountId, cpm, advert_type: typeNum || 8 })
      flash(`✅ CPM установлен: ${cpm} ₽`); setEditCpmId(null); setEditCpmVal('')
    } catch (e: unknown) { flash(e instanceof Error ? e.message : 'Ошибка') }
  }
  async function handleUpdate(id: number) {
    try {
      const body: { name?: string; budget_add?: number } = {}
      if (editName.trim()) body.name = editName.trim()
      if (editBudget && +editBudget > 0) body.budget_add = +editBudget
      await campaignsApi.update(id, accountId, body)
      flash('✅ Сохранено'); setEditRowId(null); load()
    } catch (e: unknown) { flash(e instanceof Error ? e.message : 'Ошибка') }
  }

  function sort(k: SortKey) {
    if (sortKey === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(k); setSortDir('desc') }
  }
  const sorted = [...stats].sort((a, b) => {
    const av = a[sortKey] ?? 0, bv = b[sortKey] ?? 0
    const diff = typeof av === 'string' ? (av as string).localeCompare(bv as string) : (av as number) - (bv as number)
    return sortDir === 'asc' ? diff : -diff
  })
  const totalSpend   = stats.reduce((s, r) => s + r.spend, 0)
  const totalRevenue = stats.reduce((s, r) => s + r.revenue, 0)
  const totalDrr     = totalRevenue > 0 ? totalSpend / totalRevenue * 100 : null

  const Th = ({ label, k, align = 'right' as const }: { label: string; k: SortKey; align?: 'left'|'right' }) => (
    <th onClick={() => sort(k)} style={{
      padding: '9px 10px', textAlign: align, cursor: 'pointer', userSelect: 'none',
      background: '#1e293b', color: sortKey === k ? '#38bdf8' : '#94a3b8',
      fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 1,
      borderBottom: '1px solid #334155',
    }}>
      {label} {sortKey === k ? (sortDir === 'asc' ? '↑' : '↓') : ''}
    </th>
  )

  return (
    <div>
      {/* Итоговые карточки */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        {[7, 14, 30].map(d => (
          <button key={d} onClick={() => setDays(d)} style={S.btn(days === d)}>
            {d} дней
          </button>
        ))}
        <button onClick={load} style={{ ...S.btn(false), marginLeft: 'auto' }}>
          {loading ? '⟳ Загрузка...' : '⟳ Обновить'}
        </button>
      </div>

      {stats.length > 0 && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
          {[
            { label: 'Расход', val: `${fmt(totalSpend)} ₽`, color: '#ef4444' },
            { label: 'Доход', val: `${fmt(totalRevenue)} ₽`, color: '#22c55e' },
            { label: 'ДРР рекл.', val: totalDrr != null ? `${totalDrr.toFixed(1)}%` : '—', color: drrColor(totalDrr) },
            { label: 'Кампаний', val: String(stats.length), color: '#94a3b8' },
          ].map(s => (
            <div key={s.label} style={{ background: '#1e293b', borderRadius: 8, padding: '8px 14px', border: '1px solid #334155' }}>
              <div style={{ color: '#64748b', fontSize: 11 }}>{s.label}</div>
              <div style={{ color: s.color, fontWeight: 700, fontSize: 16 }}>{s.val}</div>
            </div>
          ))}
        </div>
      )}

      {msg && <div style={{ background: '#052e16', color: '#86efac', padding: '8px 14px', borderRadius: 8, marginBottom: 10, fontSize: 13 }}>{msg}</div>}
      {error && <div style={{ background: '#450a0a', color: '#fca5a5', padding: '8px 14px', borderRadius: 8, marginBottom: 10, fontSize: 13 }}>{error}</div>}

      {/* Общий ДРР */}
      {overallDrr && (
        <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 10, marginBottom: 14 }}>
          <div onClick={() => setOverallOpen(o => !o)}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', cursor: 'pointer' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ color: '#94a3b8', fontSize: 13, fontWeight: 700 }}>📊 ОБЩИЙ ДРР</span>
              {[30, 60, 90].map(d => (
                <button key={d} onClick={e => { e.stopPropagation(); setOverallDays(d) }} style={S.btn(overallDays === d)}>
                  {d} дн.
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
              <div style={{ textAlign: 'right' }}>
                <div style={{ color: '#64748b', fontSize: 11 }}>ДРР реклама</div>
                <div style={{ color: drrColor(overallDrr.drr_ad), fontWeight: 700, fontSize: 16 }}>
                  {overallDrr.drr_ad != null ? `${overallDrr.drr_ad}%` : '—'}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ color: '#64748b', fontSize: 11 }}>Общий ДРР</div>
                <div style={{ color: drrColor(overallDrr.drr_total), fontWeight: 700, fontSize: 20 }}>
                  {overallDrr.drr_total != null ? `${overallDrr.drr_total}%` : '—'}
                </div>
              </div>
              <span style={{ color: '#475569' }}>{overallOpen ? '▲' : '▼'}</span>
            </div>
          </div>
          {overallOpen && (
            <div style={{ padding: '0 14px 14px', borderTop: '1px solid #1e293b' }}>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 10 }}>
                {[
                  { label: 'Рекл. расход', val: `${fmt(overallDrr.ad_spend, 2)} ₽`, color: '#ef4444' },
                  { label: 'Услуги WB', val: `${fmt(overallDrr.service_costs, 2)} ₽`, color: '#f59e0b' },
                  { label: 'Итого расходов', val: `${fmt(overallDrr.total_costs, 2)} ₽`, color: '#f97316' },
                  { label: 'Вся выручка', val: `${fmt(overallDrr.total_revenue, 2)} ₽`, color: '#22c55e' },
                ].map(s => (
                  <div key={s.label} style={{ background: '#1e293b', borderRadius: 8, padding: '7px 12px', border: '1px solid #334155' }}>
                    <div style={{ color: '#64748b', fontSize: 11 }}>{s.label}</div>
                    <div style={{ color: s.color, fontWeight: 700, fontSize: 14 }}>{s.val}</div>
                  </div>
                ))}
              </div>
              {overallDrr.services_error && (
                <div style={{ color: '#64748b', fontSize: 11, marginTop: 8 }}>⚠ Услуги WB: {overallDrr.services_error}</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Таблица */}
      <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid #334155', maxHeight: 520, overflowY: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1060 }}>
          <thead>
            <tr>
              <Th label="Кампания" k="name" align="left" />
              <Th label="Статус" k="status" align="left" />
              <th style={{ padding: '9px 10px', background: '#1e293b', color: '#94a3b8', fontSize: 11, fontWeight: 700, borderBottom: '1px solid #334155', textAlign: 'right', position: 'sticky', top: 0 }}>
                CPM ₽
              </th>
              <Th label="Расход ₽" k="spend" />
              <Th label="Доход ₽" k="revenue" />
              <Th label="Показы" k="views" />
              <Th label="Клики" k="clicks" />
              <Th label="Корзина" k="atbs" />
              <Th label="Заказы" k="orders" />
              <Th label="ДРР %" k="drr" />
              <th style={{ padding: '9px 10px', background: '#1e293b', borderBottom: '1px solid #334155', position: 'sticky', top: 0 }} />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={11} style={{ textAlign: 'center', color: '#64748b', padding: 40 }}>Загрузка данных WB...</td></tr>
            ) : sorted.length === 0 ? (
              <tr><td colSpan={11} style={{ textAlign: 'center', color: '#64748b', padding: 40 }}>Нет данных — выбери аккаунт или увеличь период</td></tr>
            ) : sorted.map(row => {
              const isEdit = editRowId === row.advert_id
              const isCpmEdit = editCpmId === row.advert_id
              return (
                <>
                  <tr key={row.advert_id} style={{ background: isEdit ? '#0f2744' : 'transparent' }}>
                    <td style={{ padding: '9px 10px', borderBottom: '1px solid #1e293b', minWidth: 200 }}>
                      <div style={{ color: '#f1f5f9', fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 280 }}>
                        {row.name}
                      </div>
                      <div style={{ color: '#475569', fontSize: 11 }}>#{row.advert_id}</div>
                    </td>
                    <td style={{ padding: '9px 10px', borderBottom: '1px solid #1e293b' }}>
                      <span style={{ color: STATUS_COLOR[row.status ?? 0] ?? '#64748b', fontSize: 12, fontWeight: 600 }}>
                        {STATUS_LABEL[row.status ?? 0] ?? '—'}
                      </span>
                    </td>
                    {/* CPM inline edit */}
                    <td style={{ padding: '9px 10px', borderBottom: '1px solid #1e293b', textAlign: 'right' }}>
                      {isCpmEdit ? (
                        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                          <input
                            type="number" value={editCpmVal} onChange={e => setEditCpmVal(e.target.value)}
                            style={{ ...S.input, width: 70, padding: '3px 6px' }}
                            placeholder="₽" min="5" autoFocus
                            onKeyDown={e => { if (e.key === 'Enter') handleSetCpm(row.advert_id, 8) }}
                          />
                          <button onClick={() => handleSetCpm(row.advert_id, 8)} style={S.btn(true, '#22c55e')}>✓</button>
                          <button onClick={() => setEditCpmId(null)} style={S.btn(false, '#64748b')}>✕</button>
                        </div>
                      ) : (
                        <button onClick={() => { setEditCpmId(row.advert_id); setEditCpmVal('') }}
                          style={{ background: 'transparent', color: '#38bdf8', border: '1px solid #1e3a5f', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: 12 }}>
                          Задать
                        </button>
                      )}
                    </td>
                    <td style={{ padding: '9px 10px', borderBottom: '1px solid #1e293b', textAlign: 'right' }}>
                      <span style={{ color: '#ef4444', fontSize: 13 }}>{fmt(row.spend, 2)}</span>
                    </td>
                    <td style={{ padding: '9px 10px', borderBottom: '1px solid #1e293b', textAlign: 'right' }}>
                      <span style={{ color: '#22c55e', fontSize: 13 }}>{fmt(row.revenue, 2)}</span>
                    </td>
                    <td style={{ padding: '9px 10px', borderBottom: '1px solid #1e293b', textAlign: 'right', color: '#94a3b8', fontSize: 13 }}>{fmt(row.views)}</td>
                    <td style={{ padding: '9px 10px', borderBottom: '1px solid #1e293b', textAlign: 'right', color: '#94a3b8', fontSize: 13 }}>{fmt(row.clicks)}</td>
                    <td style={{ padding: '9px 10px', borderBottom: '1px solid #1e293b', textAlign: 'right', color: '#94a3b8', fontSize: 13 }}>{fmt(row.atbs)}</td>
                    <td style={{ padding: '9px 10px', borderBottom: '1px solid #1e293b', textAlign: 'right', color: '#94a3b8', fontSize: 13 }}>{fmt(row.orders)}</td>
                    <td style={{ padding: '9px 10px', borderBottom: '1px solid #1e293b', textAlign: 'right' }}>
                      <span style={{
                        color: drrColor(row.drr), fontWeight: 700, fontSize: 13,
                        background: row.drr != null ? `${drrColor(row.drr)}22` : 'transparent',
                        padding: '2px 6px', borderRadius: 4,
                      }}>
                        {row.drr != null ? `${row.drr}%` : '—'}
                      </span>
                    </td>
                    <td style={{ padding: '9px 10px', borderBottom: '1px solid #1e293b', whiteSpace: 'nowrap' }}>
                      <div style={{ display: 'flex', gap: 4 }}>
                        {row.status === 9 && <button onClick={() => handlePause(row.advert_id)} style={{ background: '#451a03', color: '#f59e0b', border: '1px solid #f59e0b', borderRadius: 4, padding: '3px 8px', cursor: 'pointer', fontSize: 11 }}>⏸</button>}
                        {row.status === 11 && <button onClick={() => handleResume(row.advert_id)} style={{ background: '#052e16', color: '#22c55e', border: '1px solid #22c55e', borderRadius: 4, padding: '3px 8px', cursor: 'pointer', fontSize: 11 }}>▶</button>}
                        <button onClick={() => { setEditRowId(isEdit ? null : row.advert_id); setEditName(''); setEditBudget('') }}
                          style={{ background: isEdit ? '#4c1d95' : '#2e1065', color: '#a78bfa', border: '1px solid #7c3aed', borderRadius: 4, padding: '3px 8px', cursor: 'pointer', fontSize: 11 }}>
                          ✏️
                        </button>
                      </div>
                    </td>
                  </tr>
                  {isEdit && (
                    <tr key={`e-${row.advert_id}`} style={{ background: '#0c1f3a' }}>
                      <td colSpan={11} style={{ padding: '10px 14px', borderBottom: '1px solid #334155' }}>
                        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                          <div style={{ width: 260 }}>
                            <div style={{ color: '#64748b', fontSize: 11, marginBottom: 4 }}>НОВОЕ НАЗВАНИЕ</div>
                            <input value={editName} onChange={e => setEditName(e.target.value)}
                              placeholder="Оставь пустым чтобы не менять"
                              style={{ background: '#0f172a', color: '#f1f5f9', border: '1px solid #334155', borderRadius: 6, padding: '6px 10px', fontSize: 13, width: '100%', boxSizing: 'border-box' }} />
                          </div>
                          <div style={{ width: 130 }}>
                            <div style={{ color: '#64748b', fontSize: 11, marginBottom: 4 }}>ПОПОЛНИТЬ БЮДЖЕТ, ₽</div>
                            <input type="number" value={editBudget} onChange={e => setEditBudget(e.target.value)}
                              placeholder="0" min="0"
                              style={{ background: '#0f172a', color: '#f1f5f9', border: '1px solid #334155', borderRadius: 6, padding: '6px 10px', fontSize: 13, width: '100%', boxSizing: 'border-box' }} />
                          </div>
                          <button onClick={() => handleUpdate(row.advert_id)} style={{ background: '#38bdf8', color: '#0f172a', border: 'none', borderRadius: 6, padding: '7px 16px', fontWeight: 700, cursor: 'pointer', fontSize: 13 }}>Сохранить</button>
                          <button onClick={() => setEditRowId(null)} style={{ background: 'transparent', color: '#64748b', border: '1px solid #334155', borderRadius: 6, padding: '7px 12px', cursor: 'pointer', fontSize: 13 }}>Отмена</button>
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              )
            })}
          </tbody>
        </table>
      </div>
      <div style={{ color: '#475569', fontSize: 11, marginTop: 6 }}>
        Данные за {days} дней из WB Advert API · ДРР = Расход / Доход × 100%
      </div>
    </div>
  )
}

// ─── Вкладка: Управление ─────────────────────────────────────────────────────
function ManageTab({ accountId }: { accountId: string }) {
  const [campaigns, setCampaigns] = useState<Array<{ advert_id: number; name: string; type: number | null; status: number | null; cpm: number }>>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [editId, setEditId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [editBudget, setEditBudget] = useState('')
  const [msg, setMsg] = useState('')
  const [filterStatus, setFilterStatus] = useState<number | null>(null)

  function flash(m: string) { setMsg(m); setTimeout(() => setMsg(''), 4000) }

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { setCampaigns(await campaignsApi.list(accountId)) }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Ошибка') }
    finally { setLoading(false) }
  }, [accountId])

  useEffect(() => { load() }, [load])

  async function handlePause(id: number) {
    try { await campaignsApi.pause(id, accountId); flash('⏸ Пауза'); load() }
    catch (e: unknown) { flash(e instanceof Error ? e.message : 'Ошибка') }
  }
  async function handleResume(id: number) {
    try { await campaignsApi.resume(id, accountId); flash('▶ Запущена'); load() }
    catch (e: unknown) { flash(e instanceof Error ? e.message : 'Ошибка') }
  }
  async function handleUpdate(id: number) {
    try {
      const body: { name?: string; budget_add?: number } = {}
      if (editName.trim()) body.name = editName.trim()
      if (editBudget && +editBudget > 0) body.budget_add = +editBudget
      await campaignsApi.update(id, accountId, body)
      flash('✅ Сохранено'); setEditId(null); load()
    } catch (e: unknown) { flash(e instanceof Error ? e.message : 'Ошибка') }
  }

  const filtered = filterStatus != null ? campaigns.filter(c => c.status === filterStatus) : campaigns

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ color: '#94a3b8', fontSize: 13 }}>{campaigns.length} кампаний</span>
        <button onClick={() => setFilterStatus(null)} style={S.btn(filterStatus === null)}>Все</button>
        <button onClick={() => setFilterStatus(9)}  style={S.btn(filterStatus === 9, '#22c55e')}>▶ Активные</button>
        <button onClick={() => setFilterStatus(11)} style={S.btn(filterStatus === 11, '#f59e0b')}>⏸ На паузе</button>
        <button onClick={load} style={{ ...S.btn(false), marginLeft: 'auto' }}>
          {loading ? '⟳ Загрузка...' : '⟳ Обновить'}
        </button>
      </div>

      {msg && <div style={{ background: '#052e16', color: '#86efac', padding: '8px 14px', borderRadius: 8, marginBottom: 10, fontSize: 13 }}>{msg}</div>}
      {error && <div style={{ background: '#450a0a', color: '#fca5a5', padding: '8px 14px', borderRadius: 8, marginBottom: 10, fontSize: 13 }}>{error}</div>}

      {loading ? (
        <div style={{ color: '#64748b', textAlign: 'center', padding: 60 }}>Загрузка кампаний...</div>
      ) : filtered.length === 0 ? (
        <div style={{ ...S.card, textAlign: 'center', color: '#64748b', padding: 40 }}>
          Нет кампаний. Перейди во вкладку «Создать по категории»
        </div>
      ) : filtered.map(c => (
        <div key={c.advert_id} style={S.card}>
          {editId === c.advert_id ? (
            <div>
              <div style={{ color: '#94a3b8', fontSize: 11, marginBottom: 8 }}>РЕДАКТИРОВАНИЕ #{c.advert_id}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                <div>
                  <label style={{ color: '#94a3b8', fontSize: 11, display: 'block', marginBottom: 4 }}>НОВОЕ НАЗВАНИЕ</label>
                  <input style={S.input} value={editName} onChange={e => setEditName(e.target.value)} placeholder={c.name} />
                </div>
                <div>
                  <label style={{ color: '#94a3b8', fontSize: 11, display: 'block', marginBottom: 4 }}>ПОПОЛНИТЬ БЮДЖЕТ, ₽</label>
                  <input style={S.input} type="number" value={editBudget} onChange={e => setEditBudget(e.target.value)} placeholder="0" min="0" />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => handleUpdate(c.advert_id)} style={{ background: '#38bdf8', color: '#0f172a', border: 'none', borderRadius: 6, padding: '7px 16px', fontWeight: 700, cursor: 'pointer', fontSize: 13 }}>Сохранить</button>
                <button onClick={() => setEditId(null)} style={{ background: 'transparent', color: '#64748b', border: '1px solid #334155', borderRadius: 6, padding: '7px 12px', cursor: 'pointer', fontSize: 13 }}>Отмена</button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 3 }}>
                  <span style={{ color: STATUS_COLOR[c.status ?? 0] ?? '#64748b', fontSize: 13, fontWeight: 700 }}>
                    {STATUS_LABEL[c.status ?? 0] ?? '?'}
                  </span>
                  <span style={{ color: '#f1f5f9', fontWeight: 600, fontSize: 14 }}>{c.name}</span>
                </div>
                <div style={{ display: 'flex', gap: 14 }}>
                  <span style={{ color: '#64748b', fontSize: 12 }}>#{c.advert_id}</span>
                  <span style={{ color: '#64748b', fontSize: 12 }}>Тип: {TYPE_LABEL[c.type ?? 0] ?? c.type}</span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {c.status === 9 && <button onClick={() => handlePause(c.advert_id)} style={{ background: '#451a03', color: '#f59e0b', border: '1px solid #f59e0b', borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>⏸ Пауза</button>}
                {c.status === 11 && <button onClick={() => handleResume(c.advert_id)} style={{ background: '#052e16', color: '#22c55e', border: '1px solid #22c55e', borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>▶ Запустить</button>}
                <button onClick={() => { setEditId(c.advert_id); setEditName(''); setEditBudget('') }}
                  style={{ background: '#2e1065', color: '#a78bfa', border: '1px solid #7c3aed', borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                  ✏️ Изменить
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ─── Панель: Авто-переключение выходные/будни ────────────────────────────────
function AutoSchedulePanel({ accountId }: { accountId: string }) {
  const [configs, setConfigs] = useState<AutoSchedule[]>([])
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [advertIdsInput, setAdvertIdsInput] = useState('')
  const [weekdayPreset, setWeekdayPreset] = useState<'2peaks'|'day'|'24h'>('2peaks')
  const [weekendPreset, setWeekendPreset] = useState<'weekend'|'day'|'24h'>('weekend')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  // Пресет выходного дня: пик 12-20 → 150%, остальное → 80%, ночь → 0
  const WEEKEND_HOURS = [0,0,0,0,0,0,80,80,80,80,80,80,100,100,100,100,100,100,100,100,80,80,0,0]

  const weekdayHours = weekdayPreset === '2peaks' ? SCHEDULE_2PEAKS
    : weekdayPreset === 'day' ? SCHEDULE_DAY : SCHEDULE_24H
  const weekendHours = weekendPreset === 'weekend' ? WEEKEND_HOURS
    : weekendPreset === 'day' ? SCHEDULE_DAY : SCHEDULE_24H

  function flash(m: string) { setMsg(m); setTimeout(() => setMsg(''), 4000) }

  const load = useCallback(() => {
    autoSchedulesApi.list(accountId).then(setConfigs).catch(() => {})
  }, [accountId])

  useEffect(() => { load() }, [load])

  async function handleSave() {
    if (!name.trim() || !advertIdsInput.trim()) return
    const advert_ids = advertIdsInput.split(/[\s,]+/).map(Number).filter(Boolean)
    if (!advert_ids.length) { flash('Введи ID кампаний'); return }
    setSaving(true)
    try {
      await autoSchedulesApi.create({ account_id: accountId, name: name.trim(), advert_ids, weekday_hours: weekdayHours, weekend_hours: weekendHours })
      flash('✅ Авто-расписание сохранено'); setShowForm(false); setName(''); setAdvertIdsInput(''); load()
    } catch (e: unknown) { flash(e instanceof Error ? e.message : 'Ошибка') }
    finally { setSaving(false) }
  }

  async function handleToggle(id: string) {
    try { await autoSchedulesApi.toggle(id); load() }
    catch (e: unknown) { flash(e instanceof Error ? e.message : 'Ошибка') }
  }

  async function handleDelete(id: string) {
    try { await autoSchedulesApi.delete(id); load() }
    catch (e: unknown) { flash(e instanceof Error ? e.message : 'Ошибка') }
  }

  return (
    <div style={{ marginTop: 24, borderTop: '1px solid #334155', paddingTop: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <span style={{ color: '#f1f5f9', fontWeight: 700, fontSize: 15 }}>🔄 Авто-переключение выходные / будни</span>
          <div style={{ color: '#64748b', fontSize: 12, marginTop: 2 }}>
            Бот сам меняет расписание: пятница 22:00 → выходной режим, понедельник 06:00 → будничный
          </div>
        </div>
        <button onClick={() => setShowForm(f => !f)} style={S.btn(showForm, '#a78bfa')}>
          {showForm ? 'Отмена' : '+ Добавить'}
        </button>
      </div>

      {msg && <div style={{ background: '#052e16', color: '#86efac', padding: '8px 12px', borderRadius: 8, marginBottom: 10, fontSize: 13 }}>{msg}</div>}

      {showForm && (
        <div style={{ ...S.card, marginBottom: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <label style={{ color: '#94a3b8', fontSize: 11, display: 'block', marginBottom: 4 }}>НАЗВАНИЕ ГРУППЫ</label>
              <input style={S.input} value={name} onChange={e => setName(e.target.value)} placeholder="Удобрения — авто-расписание" />
            </div>
            <div>
              <label style={{ color: '#94a3b8', fontSize: 11, display: 'block', marginBottom: 4 }}>ID КАМПАНИЙ (через запятую или пробел)</label>
              <input style={S.input} value={advertIdsInput} onChange={e => setAdvertIdsInput(e.target.value)} placeholder="123456, 789012, 345678" />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 14 }}>
            <div>
              <div style={{ color: '#94a3b8', fontSize: 11, marginBottom: 6 }}>📅 БУДНИ (Пн–Пт)</div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                <button onClick={() => setWeekdayPreset('2peaks')} style={S.btn(weekdayPreset === '2peaks', '#38bdf8')}>2 Пика</button>
                <button onClick={() => setWeekdayPreset('day')}    style={S.btn(weekdayPreset === 'day')}>Дневной</button>
                <button onClick={() => setWeekdayPreset('24h')}    style={S.btn(weekdayPreset === '24h', '#f59e0b')}>24/7</button>
              </div>
              <SchedulePreview hours={weekdayHours} />
            </div>
            <div>
              <div style={{ color: '#94a3b8', fontSize: 11, marginBottom: 6 }}>🎉 ВЫХОДНЫЕ (Сб–Вс)</div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                <button onClick={() => setWeekendPreset('weekend')} style={S.btn(weekendPreset === 'weekend', '#a78bfa')}>Выходной</button>
                <button onClick={() => setWeekendPreset('day')}     style={S.btn(weekendPreset === 'day')}>Дневной</button>
                <button onClick={() => setWeekendPreset('24h')}     style={S.btn(weekendPreset === '24h', '#f59e0b')}>24/7</button>
              </div>
              <SchedulePreview hours={weekendHours} />
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ color: '#475569', fontSize: 11, flex: 1 }}>
              Пятница 22:00 UTC = {new Date().toLocaleString('ru', { timeZoneName: 'short' }).split(',')[1]?.includes('UTC') ? '01:00 мск' : '01:00 мск (пятница → суббота)'}
            </div>
            <button onClick={handleSave} disabled={saving || !name.trim() || !advertIdsInput.trim()}
              style={{ background: '#a78bfa', color: '#0f172a', border: 'none', borderRadius: 6, padding: '8px 20px', fontWeight: 700, cursor: 'pointer', fontSize: 13,
                opacity: saving || !name.trim() || !advertIdsInput.trim() ? 0.5 : 1 }}>
              {saving ? '⟳ Сохраняю...' : 'Сохранить авто-расписание'}
            </button>
          </div>
        </div>
      )}

      {configs.length === 0 ? (
        <div style={{ color: '#475569', fontSize: 13 }}>Нет сохранённых авто-расписаний</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {configs.map(c => (
            <div key={c.id} style={{
              background: '#1e293b', borderRadius: 8, padding: '10px 14px',
              border: `1px solid ${c.is_active ? '#334155' : '#1e293b'}`,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: c.is_active ? '#22c55e' : '#64748b', fontSize: 12 }}>
                    {c.is_active ? '● Активно' : '○ Выключено'}
                  </span>
                  <span style={{ color: '#f1f5f9', fontWeight: 600, fontSize: 14 }}>{c.name}</span>
                </div>
                <div style={{ color: '#64748b', fontSize: 12, marginTop: 2 }}>
                  {c.advert_ids.length} кампаний · Пн-Пт и Сб-Вс разные расписания
                </div>
                <div style={{ display: 'flex', gap: 12, marginTop: 6 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ color: '#475569', fontSize: 10, marginBottom: 2 }}>БУДНИ</div>
                    <SchedulePreview hours={c.weekday_hours} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ color: '#475569', fontSize: 10, marginBottom: 2 }}>ВЫХОДНЫЕ</div>
                    <SchedulePreview hours={c.weekend_hours} />
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <button onClick={() => handleToggle(c.id)}
                  style={{ background: c.is_active ? '#451a03' : '#052e16', color: c.is_active ? '#f59e0b' : '#22c55e',
                    border: `1px solid ${c.is_active ? '#f59e0b' : '#22c55e'}`, borderRadius: 6, padding: '5px 10px', cursor: 'pointer', fontSize: 12 }}>
                  {c.is_active ? '⏸ Выкл' : '▶ Вкл'}
                </button>
                <button onClick={() => handleDelete(c.id)}
                  style={{ background: '#450a0a', color: '#fca5a5', border: '1px solid #ef4444', borderRadius: 6, padding: '5px 10px', cursor: 'pointer', fontSize: 12 }}>
                  🗑
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Вкладка: Создать по категории ───────────────────────────────────────────
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

  const scheduleHours = schedulePreset === '2peaks' ? SCHEDULE_2PEAKS
    : schedulePreset === 'day' ? SCHEDULE_DAY : SCHEDULE_24H

  function flash(m: string) { setMsg(m); setTimeout(() => setMsg(''), 5000) }

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
      flash(`✅ Создано ${res.created_count} кампаний${res.error_count ? `, ${res.error_count} ошибок` : ''}`)
    } catch (e: unknown) {
      flash(e instanceof Error ? e.message : 'Ошибка')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div>
    <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 20, alignItems: 'start', marginBottom: 8 }}>
      {/* Левая колонка: список категорий */}
      <div>
        <div style={{ color: '#94a3b8', fontSize: 12, fontWeight: 700, marginBottom: 8 }}>КАТЕГОРИИ ТОВАРОВ</div>
        <input
          style={{ ...S.input, marginBottom: 8 }}
          placeholder="Поиск категории..."
          value={subjectSearch}
          onChange={e => setSubjectSearch(e.target.value)}
        />
        {loading ? (
          <div style={{ color: '#64748b', fontSize: 13, padding: 20, textAlign: 'center' }}>Загрузка из WB...</div>
        ) : error ? (
          <div style={{ color: '#fca5a5', fontSize: 12, padding: 10, background: '#450a0a', borderRadius: 8 }}>{error}</div>
        ) : filteredSubjects.length === 0 ? (
          <div style={{ color: '#64748b', fontSize: 13, textAlign: 'center', padding: 20 }}>Нет категорий</div>
        ) : (
          <div style={{ maxHeight: 520, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {filteredSubjects.map(s => (
              <button
                key={s.subject_name}
                onClick={() => selectSubject(s)}
                style={{
                  background: selectedSubject?.subject_name === s.subject_name ? '#1e3a5f' : '#1e293b',
                  border: selectedSubject?.subject_name === s.subject_name ? '1px solid #38bdf8' : '1px solid #334155',
                  borderRadius: 8, padding: '10px 12px', cursor: 'pointer', textAlign: 'left', width: '100%',
                }}
              >
                <div style={{ color: '#f1f5f9', fontWeight: 600, fontSize: 13 }}>{s.subject_name}</div>
                <div style={{ color: '#64748b', fontSize: 11 }}>{s.products.length} товаров</div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Правая колонка: настройки и товары */}
      <div>
        {!selectedSubject ? (
          <div style={{ ...S.card, textAlign: 'center', color: '#64748b', padding: 60 }}>
            ← Выбери категорию слева
          </div>
        ) : (
          <>
            {/* Товары выбранной категории */}
            <div style={S.card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <div style={{ color: '#f1f5f9', fontWeight: 700, fontSize: 15 }}>
                  {selectedSubject.subject_name} — {selectedNmIds.size} из {selectedSubject.products.length} выбрано
                </div>
                <button
                  onClick={() => {
                    if (selectedNmIds.size === selectedSubject.products.length)
                      setSelectedNmIds(new Set())
                    else
                      setSelectedNmIds(new Set(selectedSubject.products.map(p => p.nm_id)))
                  }}
                  style={S.btn(false)}
                >
                  {selectedNmIds.size === selectedSubject.products.length ? 'Снять всё' : 'Выбрать всё'}
                </button>
              </div>
              <div style={{ maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {selectedSubject.products.map(p => (
                  <label key={p.nm_id} style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px',
                    background: selectedNmIds.has(p.nm_id) ? '#1e3a5f' : '#0f172a',
                    border: selectedNmIds.has(p.nm_id) ? '1px solid #38bdf8' : '1px solid #1e293b',
                    borderRadius: 6, cursor: 'pointer',
                  }}>
                    <input type="checkbox" checked={selectedNmIds.has(p.nm_id)} onChange={() => toggleNm(p.nm_id)}
                      style={{ accentColor: '#38bdf8', flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: '#f1f5f9', fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p.name}
                      </div>
                      <div style={{ color: '#64748b', fontSize: 11 }}>Арт. {p.nm_id}{p.vendor_code ? ` · ${p.vendor_code}` : ''}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* Параметры кампаний */}
            <div style={S.card}>
              <div style={{ color: '#f1f5f9', fontWeight: 700, fontSize: 15, marginBottom: 14 }}>Параметры кампаний</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
                <div>
                  <label style={{ color: '#94a3b8', fontSize: 11, display: 'block', marginBottom: 4 }}>ПРЕФИКС НАЗВАНИЯ</label>
                  <input style={S.input} value={namePrefix} onChange={e => setNamePrefix(e.target.value)}
                    placeholder={selectedSubject.subject_name} />
                  <div style={{ color: '#475569', fontSize: 10, marginTop: 3 }}>→ «{namePrefix || selectedSubject.subject_name} — 12345678»</div>
                </div>
                <div>
                  <label style={{ color: '#94a3b8', fontSize: 11, display: 'block', marginBottom: 4 }}>БЮДЖЕТ НА КАМ., ₽</label>
                  <input style={S.input} type="number" value={budget} onChange={e => setBudget(e.target.value)} min="500" step="100" />
                </div>
                <div>
                  <label style={{ color: '#94a3b8', fontSize: 11, display: 'block', marginBottom: 4 }}>СТАРТОВЫЙ CPM, ₽</label>
                  <input style={S.input} type="number" value={cpm} onChange={e => setCpm(e.target.value)} min="5" step="10" />
                  <div style={{ color: '#475569', fontSize: 10, marginTop: 3 }}>Рекомендуем: 100–300 ₽</div>
                </div>
              </div>

              {/* Расписание */}
              <div>
                <label style={{ color: '#94a3b8', fontSize: 11, display: 'block', marginBottom: 8 }}>РАСПИСАНИЕ ПОКАЗОВ</label>
                <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                  <button onClick={() => setSchedulePreset('2peaks')} style={S.btn(schedulePreset === '2peaks', '#a78bfa')}>
                    🌅 2 Пика (утро + вечер)
                  </button>
                  <button onClick={() => setSchedulePreset('day')} style={S.btn(schedulePreset === 'day')}>
                    ☀️ Дневной
                  </button>
                  <button onClick={() => setSchedulePreset('24h')} style={S.btn(schedulePreset === '24h', '#f59e0b')}>
                    🔄 24/7
                  </button>
                </div>
                <div style={{ background: '#0f172a', borderRadius: 8, padding: 12, border: '1px solid #1e293b' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ color: '#64748b', fontSize: 10 }}>0:00</span>
                    <span style={{ color: '#64748b', fontSize: 10 }}>6:00</span>
                    <span style={{ color: '#64748b', fontSize: 10 }}>12:00</span>
                    <span style={{ color: '#64748b', fontSize: 10 }}>18:00</span>
                    <span style={{ color: '#64748b', fontSize: 10 }}>23:00</span>
                  </div>
                  <SchedulePreview hours={scheduleHours} />
                  {schedulePreset === '2peaks' && (
                    <div style={{ color: '#64748b', fontSize: 11, marginTop: 6 }}>
                      Ночь (0-6): 30% · Утро (7-10): 100% · День (11-16): 50% · Вечер (17-20): 100% · Поздно (21-23): 30%
                    </div>
                  )}
                  {schedulePreset === 'day' && (
                    <div style={{ color: '#64748b', fontSize: 11, marginTop: 6 }}>
                      Ночь: выкл · День (8-18): 80-100% · Вечер спад
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Кнопка создания */}
            {msg && <div style={{ background: '#052e16', color: '#86efac', padding: '8px 14px', borderRadius: 8, marginBottom: 10, fontSize: 13 }}>{msg}</div>}

            <button
              onClick={handleCreate}
              disabled={creating || selectedNmIds.size === 0 || !namePrefix.trim()}
              style={{
                background: creating || selectedNmIds.size === 0 || !namePrefix.trim() ? '#1e293b' : '#a78bfa',
                color: '#0f172a', border: 'none', borderRadius: 8,
                padding: '12px 28px', fontWeight: 700, cursor: 'pointer', fontSize: 15,
                opacity: creating || selectedNmIds.size === 0 || !namePrefix.trim() ? 0.5 : 1,
              }}
            >
              {creating
                ? '⟳ Создаю кампании...'
                : `🚀 Создать ${selectedNmIds.size} кампаний (CPM ${cpm} ₽)`}
            </button>

            {/* Результат */}
            {result && (
              <div style={{ ...S.card, marginTop: 16 }}>
                <div style={{ color: '#22c55e', fontWeight: 700, fontSize: 15, marginBottom: 10 }}>
                  ✅ Создано {result.created_count} кампаний
                  {result.error_count > 0 && <span style={{ color: '#f59e0b' }}> · {result.error_count} ошибок</span>}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflowY: 'auto' }}>
                  {result.campaigns.map(c => (
                    <div key={c.advert_id} style={{ color: '#94a3b8', fontSize: 12 }}>
                      ✓ #{c.advert_id} — {c.name}
                    </div>
                  ))}
                  {result.errors.map((e, i) => (
                    <div key={i} style={{ color: '#fca5a5', fontSize: 12 }}>
                      ✗ nm_id {e.nm_id} [{e.step}]: {e.error}
                    </div>
                  ))}
                </div>
                <div style={{ color: '#475569', fontSize: 11, marginTop: 8 }}>
                  Перейди во вкладку «Статистика» или «Управление» чтобы увидеть новые кампании.
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
    <AutoSchedulePanel accountId={accountId} />
    </div>
  )
}
