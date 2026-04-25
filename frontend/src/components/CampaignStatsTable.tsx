import { useState, useEffect } from 'react'
import { accountsApi, campaignsApi, type Account, type CampaignStat, type WbCampaign } from '../api'

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

  useEffect(() => {
    accountsApi.list().then(a => {
      const wb = a.filter(x => x.marketplace === 'wb')
      setAccounts(wb)
      if (wb.length) setAccountId(wb[0].id)
    })
  }, [])

  useEffect(() => {
    if (accountId) { loadStats(); loadCampaigns() }
  }, [accountId, days])

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
          onChange={e => setAccountId(e.target.value)}
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

      {/* Итого */}
      {stats.length > 0 && (
        <div style={{ display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
          {[
            { label: 'Расход', val: `${fmt(totalSpend)} ₽`, color: '#ef4444' },
            { label: 'Доход', val: `${fmt(totalRevenue)} ₽`, color: '#22c55e' },
            { label: 'Общий ДРР', val: totalDrr != null ? `${totalDrr.toFixed(1)}%` : '—', color: drrColor(totalDrr) },
            { label: 'Кампаний', val: String(stats.length), color: '#94a3b8' },
          ].map(s => (
            <div key={s.label} style={{ background: '#1e293b', borderRadius: 8, padding: '8px 14px', border: '1px solid #334155' }}>
              <div style={{ color: '#64748b', fontSize: 11 }}>{s.label}</div>
              <div style={{ color: s.color, fontWeight: 700, fontSize: 16 }}>{s.val}</div>
            </div>
          ))}
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
