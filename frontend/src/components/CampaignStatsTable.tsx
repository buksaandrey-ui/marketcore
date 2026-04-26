import { useState, useEffect } from 'react'
import { accountsApi, campaignsApi, accountPrefs, type Account, type CampaignStat, type WbCampaign, type OverallDrrData } from '../api'

type SortKey = keyof CampaignStat
type SortDir = 'asc' | 'desc'

const STATUS_LABEL: Record<number, string> = { 9: '▶ Активна', 11: '⏸ Пауза', 7: '■ Завершена' }
const STATUS_COLOR: Record<number, string> = { 9: '#22c55e', 11: '#f59e0b', 7: '#64748b' }

function drrColor(drr: number | null): string {
  if (drr === null) return '#64748b'
  if (drr <= 10) return '#22c55e'
  if (drr <= 20) return '#f59e0b'
  return '#ef4444'
}

function fmt(n: number, decimals = 0): string {
  return n.toLocaleString('ru-RU', { maximumFractionDigits: decimals })
}

export function CampaignStatsTable() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [accountId, setAccountId] = useState('')
  const [days, setDays] = useState(7)
  const [stats, setStats] = useState<CampaignStat[]>([])
  const [campaigns, setCampaigns] = useState<WbCampaign[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('spend')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [editId, setEditId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [editBudget, setEditBudget] = useState('')
  const [actionMsg, setActionMsg] = useState('')
  const [overallDrr, setOverallDrr] = useState<OverallDrrData | null>(null)
  const [overallDays, setOverallDays] = useState(30)
  const [overallOpen, setOverallOpen] = useState(false)

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

  useEffect(() => {
    if (accountId) { loadStats(); loadCampaigns() }
  }, [accountId, days])

  useEffect(() => {
    if (accountId) loadOverallDrr()
  }, [accountId, overallDays])

  async function loadOverallDrr() {
    try { setOverallDrr(await campaignsApi.overallDrr(accountId, overallDays)) } catch { /* silent */ }
  }

  async function loadStats() {
    setLoading(true); setError('')
    try {
      setStats(await campaignsApi.stats(accountId, days))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Ошибка загрузки статистики')
    } finally { setLoading(false) }
  }

  async function loadCampaigns() {
    try { setCampaigns(await campaignsApi.list(accountId)) } catch { /* silent */ }
  }

  function flash(msg: string) { setActionMsg(msg); setTimeout(() => setActionMsg(''), 3500) }

  async function handlePause(id: number) {
    try { await campaignsApi.pause(id, accountId); flash('⏸ Кампания приостановлена'); loadStats() }
    catch (e: unknown) { flash(e instanceof Error ? e.message : 'Ошибка') }
  }
  async function handleResume(id: number) {
    try { await campaignsApi.resume(id, accountId); flash('▶ Кампания запущена'); loadStats() }
    catch (e: unknown) { flash(e instanceof Error ? e.message : 'Ошибка') }
  }
  async function handleUpdate(id: number) {
    try {
      const body: { name?: string; budget_add?: number } = {}
      if (editName.trim()) body.name = editName.trim()
      if (editBudget && +editBudget > 0) body.budget_add = +editBudget
      await campaignsApi.update(id, accountId, body)
      flash('✅ Сохранено'); setEditId(null); loadStats()
    } catch (e: unknown) { flash(e instanceof Error ? e.message : 'Ошибка') }
  }

  function sort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
  }

  const sorted = [...stats].sort((a, b) => {
    const av = a[sortKey] ?? 0, bv = b[sortKey] ?? 0
    const diff = typeof av === 'string' ? (av as string).localeCompare(bv as string) : (av as number) - (bv as number)
    return sortDir === 'asc' ? diff : -diff
  })

  const totalSpend   = stats.reduce((s, r) => s + r.spend, 0)
  const totalRevenue = stats.reduce((s, r) => s + r.revenue, 0)
  const totalDrr     = totalRevenue > 0 ? totalSpend / totalRevenue * 100 : null

  const th = (label: string, key: SortKey, align: 'left'|'right' = 'right') => (
    <th
      onClick={() => sort(key)}
      style={{
        padding: '10px 12px', textAlign: align, cursor: 'pointer', userSelect: 'none',
        background: '#1e293b', color: sortKey === key ? '#38bdf8' : '#94a3b8',
        fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 1,
        borderBottom: '1px solid #334155',
      }}
    >
      {label} {sortKey === key ? (sortDir === 'asc' ? '↑' : '↓') : ''}
    </th>
  )

  const td = (children: React.ReactNode, align: 'left'|'right' = 'right', color = '#f1f5f9') => (
    <td style={{ padding: '9px 12px', textAlign: align, color, fontSize: 13, borderBottom: '1px solid #1e293b', whiteSpace: 'nowrap' }}>
      {children}
    </td>
  )

  return (
    <div style={{ padding: '0 0 32px' }}>
      {/* Шапка */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <h2 style={{ color: '#f1f5f9', margin: 0, fontSize: 18, fontWeight: 700 }}>Рекламные кампании WB</h2>

        <select
          value={accountId}
          onChange={e => pickAccount(e.target.value)}
          style={{ background: '#1e293b', color: '#f1f5f9', border: '1px solid #334155', borderRadius: 6, padding: '6px 10px', fontSize: 13 }}
        >
          {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>

        <div style={{ display: 'flex', gap: 4 }}>
          {[7, 14, 30].map(d => (
            <button key={d} onClick={() => setDays(d)} style={{
              padding: '5px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontWeight: 600,
              background: days === d ? '#38bdf8' : '#1e293b',
              color: days === d ? '#0f172a' : '#64748b',
              border: `1px solid ${days === d ? '#38bdf8' : '#334155'}`,
            }}>{d} дней</button>
          ))}
        </div>

        <button onClick={loadStats} style={{ background: '#1e293b', color: '#38bdf8', border: '1px solid #38bdf8', borderRadius: 6, padding: '5px 14px', cursor: 'pointer', fontSize: 12, marginLeft: 'auto' }}>
          {loading ? '⟳ Загрузка...' : '⟳ Обновить'}
        </button>
      </div>

      {actionMsg && (
        <div style={{ background: '#052e16', color: '#86efac', padding: '8px 14px', borderRadius: 8, marginBottom: 12, fontSize: 13 }}>
          {actionMsg}
        </div>
      )}
      {error && (
        <div style={{ background: '#450a0a', color: '#fca5a5', padding: '8px 14px', borderRadius: 8, marginBottom: 12, fontSize: 13 }}>
          {error}
        </div>
      )}

      {/* Итого по рекламным кампаниям */}
      {stats.length > 0 && (
        <div style={{ display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
          {[
            { label: 'Расход (реклама)', val: `${fmt(totalSpend)} ₽`, color: '#ef4444' },
            { label: 'Доход (реклама)', val: `${fmt(totalRevenue)} ₽`, color: '#22c55e' },
            { label: 'ДРР по рекламе', val: totalDrr != null ? `${totalDrr.toFixed(1)}%` : '—', color: drrColor(totalDrr) },
            { label: 'Кампаний', val: String(stats.length), color: '#94a3b8' },
          ].map(s => (
            <div key={s.label} style={{ background: '#1e293b', borderRadius: 8, padding: '8px 14px', border: '1px solid #334155' }}>
              <div style={{ color: '#64748b', fontSize: 11 }}>{s.label}</div>
              <div style={{ color: s.color, fontWeight: 700, fontSize: 16 }}>{s.val}</div>
            </div>
          ))}
        </div>
      )}

      {/* Общий ДРР (реальные данные) */}
      {overallDrr && (
        <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 10, marginBottom: 16 }}>
          {/* Шапка виджета */}
          <div
            onClick={() => setOverallOpen(o => !o)}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', cursor: 'pointer' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <span style={{ color: '#94a3b8', fontSize: 13, fontWeight: 700 }}>📊 ОБЩИЙ ДРР</span>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {[30, 60, 90].map(d => (
                  <button key={d} onClick={e => { e.stopPropagation(); setOverallDays(d) }} style={{
                    padding: '2px 10px', borderRadius: 4, fontSize: 11, cursor: 'pointer', fontWeight: 600,
                    background: overallDays === d ? '#38bdf8' : '#1e293b',
                    color: overallDays === d ? '#0f172a' : '#64748b',
                    border: `1px solid ${overallDays === d ? '#38bdf8' : '#334155'}`,
                  }}>{d} дн.</button>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
              <div style={{ textAlign: 'right' }}>
                <div style={{ color: '#64748b', fontSize: 11 }}>ДРР только реклама</div>
                <div style={{ color: drrColor(overallDrr.drr_ad), fontWeight: 700, fontSize: 18 }}>
                  {overallDrr.drr_ad != null ? `${overallDrr.drr_ad}%` : '—'}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ color: '#64748b', fontSize: 11 }}>Общий ДРР (всё вкл.)</div>
                <div style={{ color: drrColor(overallDrr.drr_total), fontWeight: 700, fontSize: 22 }}>
                  {overallDrr.drr_total != null ? `${overallDrr.drr_total}%` : '—'}
                </div>
              </div>
              <span style={{ color: '#475569', fontSize: 16 }}>{overallOpen ? '▲' : '▼'}</span>
            </div>
          </div>

          {/* Разворачиваемые детали */}
          {overallOpen && (
            <div style={{ padding: '0 16px 16px', borderTop: '1px solid #1e293b' }}>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 12 }}>
                {[
                  { label: 'Рекл. расход', val: `${fmt(overallDrr.ad_spend, 2)} ₽`, color: '#ef4444' },
                  { label: 'Услуги WB (продвижение)', val: `${fmt(overallDrr.service_costs, 2)} ₽`, color: '#f59e0b' },
                  { label: 'Итого расходов', val: `${fmt(overallDrr.total_costs, 2)} ₽`, color: '#f97316' },
                  { label: 'Вся выручка (органика+реклама)', val: `${fmt(overallDrr.total_revenue, 2)} ₽`, color: '#22c55e' },
                ].map(s => (
                  <div key={s.label} style={{ background: '#1e293b', borderRadius: 8, padding: '8px 14px', border: '1px solid #334155', minWidth: 160 }}>
                    <div style={{ color: '#64748b', fontSize: 11 }}>{s.label}</div>
                    <div style={{ color: s.color, fontWeight: 700, fontSize: 15 }}>{s.val}</div>
                  </div>
                ))}
              </div>
              {Object.keys(overallDrr.by_service).length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ color: '#64748b', fontSize: 11, marginBottom: 6 }}>РАЗБИВКА УСЛУГ WB</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {Object.entries(overallDrr.by_service).map(([name, val]) => (
                      <div key={name} style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 6, padding: '5px 10px', fontSize: 12 }}>
                        <span style={{ color: '#94a3b8' }}>{name}: </span>
                        <span style={{ color: '#f59e0b', fontWeight: 700 }}>{fmt(val as number, 2)} ₽</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {overallDrr.services_error && (
                <div style={{ color: '#64748b', fontSize: 11, marginTop: 8 }}>
                  ⚠ Услуги WB недоступны: {overallDrr.services_error}
                </div>
              )}
              <div style={{ color: '#475569', fontSize: 11, marginTop: 10 }}>
                Общий ДРР = (рекл. расход + услуги WB) / вся выручка × 100% · период {overallDrr.period_days} дн.
              </div>
            </div>
          )}
        </div>
      )}

      {/* Таблица */}
      <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid #334155', maxHeight: 480, overflowY: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 980 }}>
          <thead>
            <tr>
              {th('Название / РК', 'name', 'left')}
              {th('Статус', 'status', 'left')}
              {th('Расход ₽', 'spend')}
              {th('Доход ₽', 'revenue')}
              {th('В корзину', 'atbs')}
              {th('Заказы', 'orders')}
              {th('Выкуплено', 'shks')}
              {th('Ср. стоим.', 'shks')}
              {th('ДРР %', 'drr')}
              <th style={{ padding: '10px 12px', background: '#1e293b', borderBottom: '1px solid #334155', position: 'sticky', top: 0 }} />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={10} style={{ textAlign: 'center', color: '#64748b', padding: 40 }}>Загрузка данных WB...</td></tr>
            ) : sorted.length === 0 ? (
              <tr><td colSpan={10} style={{ textAlign: 'center', color: '#64748b', padding: 40 }}>
                Нет данных. Выбери аккаунт или увеличь период.
              </td></tr>
            ) : sorted.map(row => {
              const isEdit = editId === row.advert_id
              const avgPrice = row.shks > 0 ? row.revenue / row.shks : null
              const campaign = campaigns.find(c => c.advert_id === row.advert_id)

              return (
                <>
                  <tr key={row.advert_id} style={{ background: isEdit ? '#0f2744' : 'transparent' }}>
                    {/* Название */}
                    <td style={{ padding: '9px 12px', borderBottom: '1px solid #1e293b', minWidth: 220 }}>
                      <div style={{ color: '#f1f5f9', fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 300 }}>
                        {row.name}
                      </div>
                      <div style={{ color: '#475569', fontSize: 11 }}>#{row.advert_id}</div>
                    </td>
                    {/* Статус */}
                    <td style={{ padding: '9px 12px', borderBottom: '1px solid #1e293b' }}>
                      <span style={{ color: STATUS_COLOR[row.status ?? 0] ?? '#64748b', fontSize: 12, fontWeight: 600 }}>
                        {STATUS_LABEL[row.status ?? 0] ?? '—'}
                      </span>
                    </td>
                    {td(<span style={{ color: '#ef4444' }}>{fmt(row.spend, 2)}</span>)}
                    {td(<span style={{ color: '#22c55e' }}>{fmt(row.revenue, 2)}</span>)}
                    {td(fmt(row.atbs), 'right', '#94a3b8')}
                    {td(fmt(row.orders), 'right', '#94a3b8')}
                    {td(fmt(row.shks), 'right', '#94a3b8')}
                    {td(avgPrice != null ? `${fmt(avgPrice, 0)} ₽` : '—', 'right', '#94a3b8')}
                    {/* ДРР */}
                    <td style={{ padding: '9px 12px', textAlign: 'right', borderBottom: '1px solid #1e293b' }}>
                      <span style={{
                        color: drrColor(row.drr), fontWeight: 700, fontSize: 13,
                        background: row.drr != null ? `${drrColor(row.drr)}22` : 'transparent',
                        padding: '2px 6px', borderRadius: 4,
                      }}>
                        {row.drr != null ? `${row.drr}%` : '—'}
                      </span>
                    </td>
                    {/* Действия */}
                    <td style={{ padding: '9px 12px', borderBottom: '1px solid #1e293b', whiteSpace: 'nowrap' }}>
                      <div style={{ display: 'flex', gap: 4 }}>
                        {row.status === 9 && (
                          <button onClick={() => handlePause(row.advert_id)}
                            style={{ background: '#451a03', color: '#f59e0b', border: '1px solid #f59e0b', borderRadius: 4, padding: '3px 8px', cursor: 'pointer', fontSize: 11 }}>
                            ⏸
                          </button>
                        )}
                        {row.status === 11 && (
                          <button onClick={() => handleResume(row.advert_id)}
                            style={{ background: '#052e16', color: '#22c55e', border: '1px solid #22c55e', borderRadius: 4, padding: '3px 8px', cursor: 'pointer', fontSize: 11 }}>
                            ▶
                          </button>
                        )}
                        <button
                          onClick={() => { setEditId(isEdit ? null : row.advert_id); setEditName(''); setEditBudget('') }}
                          style={{ background: isEdit ? '#4c1d95' : '#2e1065', color: '#a78bfa', border: '1px solid #7c3aed', borderRadius: 4, padding: '3px 8px', cursor: 'pointer', fontSize: 11 }}>
                          ✏️
                        </button>
                      </div>
                    </td>
                  </tr>

                  {/* Строка редактирования */}
                  {isEdit && (
                    <tr key={`edit-${row.advert_id}`} style={{ background: '#0c1f3a' }}>
                      <td colSpan={10} style={{ padding: '12px 16px', borderBottom: '1px solid #334155' }}>
                        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                          <div>
                            <div style={{ color: '#64748b', fontSize: 11, marginBottom: 4 }}>НОВОЕ НАЗВАНИЕ</div>
                            <input
                              value={editName} onChange={e => setEditName(e.target.value)}
                              placeholder="Оставь пустым чтобы не менять"
                              style={{ background: '#0f172a', color: '#f1f5f9', border: '1px solid #334155', borderRadius: 6, padding: '6px 10px', fontSize: 13, width: 280 }}
                            />
                          </div>
                          <div>
                            <div style={{ color: '#64748b', fontSize: 11, marginBottom: 4 }}>ПОПОЛНИТЬ БЮДЖЕТ, ₽</div>
                            <input
                              type="number" value={editBudget} onChange={e => setEditBudget(e.target.value)}
                              placeholder="0" min="0"
                              style={{ background: '#0f172a', color: '#f1f5f9', border: '1px solid #334155', borderRadius: 6, padding: '6px 10px', fontSize: 13, width: 120 }}
                            />
                          </div>
                          <button onClick={() => handleUpdate(row.advert_id)}
                            style={{ background: '#38bdf8', color: '#0f172a', border: 'none', borderRadius: 6, padding: '7px 18px', fontWeight: 700, cursor: 'pointer', fontSize: 13 }}>
                            Сохранить
                          </button>
                          <button onClick={() => setEditId(null)}
                            style={{ background: 'transparent', color: '#64748b', border: '1px solid #334155', borderRadius: 6, padding: '7px 14px', cursor: 'pointer', fontSize: 13 }}>
                            Отмена
                          </button>
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

      {stats.length > 0 && (
        <div style={{ color: '#475569', fontSize: 11, marginTop: 8 }}>
          * Данные за {days} дней · Расход из WB Advert API · ДРР = Расход / Доход × 100%
        </div>
      )}
    </div>
  )
}
