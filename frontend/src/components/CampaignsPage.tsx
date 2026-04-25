import { useState, useEffect } from 'react'
import { accountsApi, campaignsApi, type Account, type WbCampaign, type SkuItem } from '../api'

type Tab = 'list' | 'create'

const STATUS_LABEL: Record<number, string> = { 9: '▶ Активна', 11: '⏸ Пауза', 7: '■ Завершена' }
const STATUS_COLOR: Record<number, string> = { 9: '#22c55e', 11: '#f59e0b', 7: '#64748b' }
const TYPE_LABEL: Record<number, string> = { 4: 'Каталог', 5: 'Карточка', 6: 'Поиск', 7: 'Рекоменд.', 8: 'Авто', 9: 'Поиск+Каталог' }

export function CampaignsPage() {
  const [tab, setTab] = useState<Tab>('list')
  const [accounts, setAccounts] = useState<Account[]>([])
  const [accountId, setAccountId] = useState('')
  const [campaigns, setCampaigns] = useState<WbCampaign[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [actionMsg, setActionMsg] = useState('')

  // Редактирование
  const [editId, setEditId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [editBudget, setEditBudget] = useState('')

  // Создание
  const [skus, setSkus] = useState<SkuItem[]>([])
  const [skusLoading, setSkusLoading] = useState(false)
  const [selectedSkus, setSelectedSkus] = useState<Set<string>>(new Set())
  const [newName, setNewName] = useState('')
  const [newBudget, setNewBudget] = useState('500')
  const [creating, setCreating] = useState(false)
  const [skuSearch, setSkuSearch] = useState('')
  const [createMode, setCreateMode] = useState<'one' | 'bulk'>('bulk')

  useEffect(() => {
    accountsApi.list().then(a => {
      const wb = a.filter(x => x.marketplace === 'wb')
      setAccounts(wb)
      if (wb.length > 0) setAccountId(wb[0].id)
    })
  }, [])

  useEffect(() => {
    if (accountId) {
      loadCampaigns()
      loadSkus()
    }
  }, [accountId])

  async function loadCampaigns() {
    if (!accountId) return
    setLoading(true)
    setError('')
    try {
      const data = await campaignsApi.list(accountId)
      setCampaigns(data)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Ошибка загрузки')
    } finally {
      setLoading(false)
    }
  }

  async function loadSkus() {
    if (!accountId) return
    setSkusLoading(true)
    try {
      const data = await campaignsApi.skus(accountId)
      setSkus(data)
    } finally {
      setSkusLoading(false)
    }
  }

  function flash(msg: string) {
    setActionMsg(msg)
    setTimeout(() => setActionMsg(''), 3000)
  }

  async function handlePause(id: number) {
    try {
      await campaignsApi.pause(id, accountId)
      flash('Кампания приостановлена')
      await loadCampaigns()
    } catch (e: unknown) {
      flash(e instanceof Error ? e.message : 'Ошибка')
    }
  }

  async function handleResume(id: number) {
    try {
      await campaignsApi.resume(id, accountId)
      flash('Кампания запущена')
      await loadCampaigns()
    } catch (e: unknown) {
      flash(e instanceof Error ? e.message : 'Ошибка')
    }
  }

  async function handleUpdate(id: number) {
    try {
      const body: { name?: string; budget_add?: number } = {}
      if (editName.trim()) body.name = editName.trim()
      if (editBudget && parseInt(editBudget) > 0) body.budget_add = parseInt(editBudget)
      await campaignsApi.update(id, accountId, body)
      flash('Кампания обновлена')
      setEditId(null)
      await loadCampaigns()
    } catch (e: unknown) {
      flash(e instanceof Error ? e.message : 'Ошибка')
    }
  }

  async function handleCreate() {
    if (!newName.trim() || selectedSkus.size === 0) return
    setCreating(true)
    try {
      if (createMode === 'bulk') {
        // Одна кампания для всех выбранных SKU
        const nm_ids = [...selectedSkus].map(Number).filter(Boolean)
        await campaignsApi.create({ account_id: accountId, name: newName.trim(), nm_ids, budget: parseInt(newBudget) || 500 })
        flash(`Кампания «${newName}» создана для ${nm_ids.length} товаров`)
      } else {
        // 1 кампания на 1 товар
        let created = 0
        for (const sku of selectedSkus) {
          const nm = Number(sku)
          if (!nm) continue
          await campaignsApi.create({
            account_id: accountId,
            name: `${newName.trim()} — ${sku}`,
            nm_ids: [nm],
            budget: parseInt(newBudget) || 500,
          })
          created++
        }
        flash(`Создано ${created} кампаний (1 товар = 1 кампания)`)
      }
      setSelectedSkus(new Set())
      setNewName('')
      setTab('list')
      await loadCampaigns()
    } catch (e: unknown) {
      flash(e instanceof Error ? e.message : 'Ошибка создания')
    } finally {
      setCreating(false)
    }
  }

  const filteredSkus = skus.filter(s =>
    s.sku.toLowerCase().includes(skuSearch.toLowerCase())
  )

  const toggleSku = (sku: string) => {
    setSelectedSkus(prev => {
      const next = new Set(prev)
      next.has(sku) ? next.delete(sku) : next.add(sku)
      return next
    })
  }

  const toggleAll = () => {
    if (selectedSkus.size === filteredSkus.length) {
      setSelectedSkus(new Set())
    } else {
      setSelectedSkus(new Set(filteredSkus.map(s => s.sku)))
    }
  }

  const card: React.CSSProperties = {
    background: '#1e293b', borderRadius: 12, padding: 20, border: '1px solid #334155', marginBottom: 12,
  }
  const btn = (color = '#38bdf8', bg = '#0c4a6e'): React.CSSProperties => ({
    background: bg, color, border: `1px solid ${color}`, borderRadius: 6,
    padding: '5px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
  })
  const input: React.CSSProperties = {
    background: '#0f172a', color: '#f1f5f9', border: '1px solid #334155',
    borderRadius: 6, padding: '6px 10px', fontSize: 13, width: '100%', boxSizing: 'border-box',
  }

  return (
    <div style={{ padding: 24, maxWidth: 960, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h2 style={{ color: '#f1f5f9', margin: 0, fontSize: 20, fontWeight: 700 }}>Рекламные кампании WB</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setTab('list')} style={{ ...btn(tab === 'list' ? '#0f172a' : '#94a3b8', tab === 'list' ? '#38bdf8' : 'transparent'), border: '1px solid #38bdf8' }}>
            Список
          </button>
          <button onClick={() => setTab('create')} style={{ ...btn(tab === 'create' ? '#0f172a' : '#94a3b8', tab === 'create' ? '#a78bfa' : 'transparent'), border: '1px solid #a78bfa' }}>
            + Создать кампанию
          </button>
        </div>
      </div>

      {/* Аккаунт */}
      <div style={{ marginBottom: 16 }}>
        <label style={{ color: '#94a3b8', fontSize: 12 }}>АККАУНТ WB</label>
        <select
          value={accountId}
          onChange={e => setAccountId(e.target.value)}
          style={{ ...input, marginTop: 4, width: 260 }}
        >
          {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>

      {actionMsg && (
        <div style={{ background: '#052e16', color: '#86efac', padding: 10, borderRadius: 8, marginBottom: 12, fontSize: 13 }}>
          {actionMsg}
        </div>
      )}

      {/* ── Список кампаний ── */}
      {tab === 'list' && (
        <>
          {error && <div style={{ color: '#fca5a5', background: '#450a0a', padding: 10, borderRadius: 8, marginBottom: 12, fontSize: 13 }}>{error}</div>}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ color: '#64748b', fontSize: 13 }}>{campaigns.length} кампаний</span>
            <button onClick={loadCampaigns} style={btn()} disabled={loading}>
              {loading ? '⟳ Загрузка...' : '⟳ Обновить'}
            </button>
          </div>

          {loading ? (
            <div style={{ color: '#64748b', textAlign: 'center', padding: 40 }}>Загрузка...</div>
          ) : campaigns.length === 0 ? (
            <div style={{ ...card, textAlign: 'center', color: '#64748b', padding: 40 }}>
              Нет кампаний. Нажми «+ Создать кампанию»
            </div>
          ) : (
            campaigns.map(c => (
              <div key={c.advert_id} style={card}>
                {editId === c.advert_id ? (
                  // Режим редактирования
                  <div>
                    <div style={{ color: '#94a3b8', fontSize: 11, marginBottom: 8 }}>РЕДАКТИРОВАНИЕ #{c.advert_id}</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                      <div>
                        <label style={{ color: '#94a3b8', fontSize: 11, display: 'block', marginBottom: 4 }}>НОВОЕ НАЗВАНИЕ</label>
                        <input style={input} value={editName} onChange={e => setEditName(e.target.value)} placeholder="Оставь пустым чтобы не менять" />
                      </div>
                      <div>
                        <label style={{ color: '#94a3b8', fontSize: 11, display: 'block', marginBottom: 4 }}>ПОПОЛНИТЬ БЮДЖЕТ, ₽</label>
                        <input style={input} type="number" value={editBudget} onChange={e => setEditBudget(e.target.value)} placeholder="0" min="0" />
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={() => handleUpdate(c.advert_id)} style={btn('#0f172a', '#38bdf8')}>Сохранить</button>
                      <button onClick={() => setEditId(null)} style={btn('#94a3b8', 'transparent')}>Отмена</button>
                    </div>
                  </div>
                ) : (
                  // Обычный вид
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                        <span style={{ color: STATUS_COLOR[c.status ?? 0] ?? '#64748b', fontSize: 13, fontWeight: 700 }}>
                          {STATUS_LABEL[c.status ?? 0] ?? '?'}
                        </span>
                        <span style={{ color: '#f1f5f9', fontWeight: 600, fontSize: 14 }}>{c.name}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 16 }}>
                        <span style={{ color: '#64748b', fontSize: 12 }}>ID: {c.advert_id}</span>
                        <span style={{ color: '#64748b', fontSize: 12 }}>Тип: {TYPE_LABEL[c.type ?? 0] ?? c.type}</span>
                        {c.cpm > 0 && <span style={{ color: '#94a3b8', fontSize: 12 }}>CPM: {c.cpm}₽</span>}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {c.status === 9 ? (
                        <button onClick={() => handlePause(c.advert_id)} style={btn('#f59e0b', '#451a03')}>⏸ Пауза</button>
                      ) : c.status === 11 ? (
                        <button onClick={() => handleResume(c.advert_id)} style={btn('#22c55e', '#052e16')}>▶ Запустить</button>
                      ) : null}
                      <button
                        onClick={() => { setEditId(c.advert_id); setEditName(''); setEditBudget('') }}
                        style={btn('#a78bfa', '#2e1065')}
                      >
                        ✏️ Изменить
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </>
      )}

      {/* ── Создание кампаний ── */}
      {tab === 'create' && (
        <div>
          <div style={card}>
            <h3 style={{ color: '#f1f5f9', margin: '0 0 16px', fontSize: 16 }}>Параметры кампании</h3>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
              <div>
                <label style={{ color: '#94a3b8', fontSize: 11, display: 'block', marginBottom: 4 }}>НАЗВАНИЕ КАМПАНИИ</label>
                <input style={input} value={newName} onChange={e => setNewName(e.target.value)} placeholder="Например: Весенняя реклама" />
              </div>
              <div>
                <label style={{ color: '#94a3b8', fontSize: 11, display: 'block', marginBottom: 4 }}>НАЧАЛЬНЫЙ БЮДЖЕТ, ₽</label>
                <input style={input} type="number" value={newBudget} onChange={e => setNewBudget(e.target.value)} min="500" step="100" />
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ color: '#94a3b8', fontSize: 11, display: 'block', marginBottom: 8 }}>РЕЖИМ СОЗДАНИЯ</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => setCreateMode('bulk')}
                  style={{ ...btn(createMode === 'bulk' ? '#0f172a' : '#94a3b8', createMode === 'bulk' ? '#38bdf8' : 'transparent'), border: '1px solid #38bdf8' }}
                >
                  Одна кампания (все выбранные товары)
                </button>
                <button
                  onClick={() => setCreateMode('one')}
                  style={{ ...btn(createMode === 'one' ? '#0f172a' : '#94a3b8', createMode === 'one' ? '#a78bfa' : 'transparent'), border: '1px solid #a78bfa' }}
                >
                  1 кампания = 1 товар (массовое)
                </button>
              </div>
              <div style={{ color: '#64748b', fontSize: 11, marginTop: 6 }}>
                {createMode === 'bulk'
                  ? 'Все выбранные товары попадут в одну кампанию'
                  : 'Для каждого товара создаётся отдельная кампания с названием «Название — артикул»'}
              </div>
            </div>
          </div>

          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <h3 style={{ color: '#f1f5f9', margin: 0, fontSize: 15 }}>
                Выбери товары ({selectedSkus.size} выбрано из {skus.length})
              </h3>
              <button onClick={toggleAll} style={btn()}>
                {selectedSkus.size === filteredSkus.length && filteredSkus.length > 0 ? 'Снять всё' : 'Выбрать всё'}
              </button>
            </div>

            <input
              style={{ ...input, marginBottom: 12 }}
              placeholder="Поиск по артикулу..."
              value={skuSearch}
              onChange={e => setSkuSearch(e.target.value)}
            />

            {skusLoading ? (
              <div style={{ color: '#64748b', textAlign: 'center', padding: 20 }}>Загрузка товаров...</div>
            ) : filteredSkus.length === 0 ? (
              <div style={{ color: '#64748b', textAlign: 'center', padding: 20 }}>
                Нет товаров. Сначала синхронизируй аккаунт в разделе «Аккаунты».
              </div>
            ) : (
              <div style={{ maxHeight: 360, overflowY: 'auto', display: 'grid', gap: 6 }}>
                {filteredSkus.map(s => (
                  <label
                    key={s.sku}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                      background: selectedSkus.has(s.sku) ? '#1e3a5f' : '#0f172a',
                      borderRadius: 6, cursor: 'pointer',
                      border: selectedSkus.has(s.sku) ? '1px solid #38bdf8' : '1px solid #1e293b',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedSkus.has(s.sku)}
                      onChange={() => toggleSku(s.sku)}
                      style={{ accentColor: '#38bdf8', flexShrink: 0 }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {s.name ? (
                        <>
                          <div style={{ color: '#f1f5f9', fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {s.name}
                          </div>
                          <div style={{ color: '#64748b', fontSize: 11 }}>Арт. {s.sku}</div>
                        </>
                      ) : (
                        <div style={{ color: '#f1f5f9', fontSize: 13, fontWeight: 600 }}>Арт. {s.sku}</div>
                      )}
                    </div>
                    {s.price != null && (
                      <span style={{ color: '#94a3b8', fontSize: 12, flexShrink: 0 }}>{s.price.toLocaleString('ru')}₽</span>
                    )}
                    {s.stock != null && (
                      <span style={{ color: s.stock > 0 ? '#22c55e' : '#ef4444', fontSize: 12, flexShrink: 0 }}>
                        {s.stock} шт.
                      </span>
                    )}
                  </label>
                ))}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button
              onClick={handleCreate}
              disabled={creating || !newName.trim() || selectedSkus.size === 0}
              style={{
                background: creating || !newName.trim() || selectedSkus.size === 0 ? '#1e293b' : '#a78bfa',
                color: '#0f172a', border: 'none', borderRadius: 8,
                padding: '10px 24px', fontWeight: 700, cursor: 'pointer', fontSize: 14,
              }}
            >
              {creating
                ? '⟳ Создание...'
                : createMode === 'bulk'
                  ? `Создать кампанию (${selectedSkus.size} товаров)`
                  : `Создать ${selectedSkus.size} кампаний`}
            </button>
            {selectedSkus.size === 0 && (
              <span style={{ color: '#64748b', fontSize: 12 }}>Выбери хотя бы один товар</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
