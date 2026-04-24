import { useState, useEffect } from 'react'
import { accountsApi, type Account } from '../api'

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [syncingId, setSyncingId] = useState<string | null>(null)
  const [syncResult, setSyncResult] = useState<string>('')

  const [form, setForm] = useState({
    marketplace: 'wb' as 'wb' | 'ozon',
    name: '',
    seller_id: '',
    api_key: '',
    advert_api_key: '',
  })

  useEffect(() => { load() }, [])

  async function load() {
    try {
      const data = await accountsApi.list()
      setAccounts(data)
    } catch {
      setError('Не удалось загрузить аккаунты')
    } finally {
      setLoading(false)
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    try {
      await accountsApi.create(form)
      setForm({ marketplace: 'wb', name: '', seller_id: '', api_key: '', advert_api_key: '' })
      setShowForm(false)
      await load()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Ошибка создания')
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Удалить аккаунт?')) return
    try {
      await accountsApi.delete(id)
      await load()
    } catch {
      setError('Ошибка удаления')
    }
  }

  async function handleSync(id: string) {
    setSyncingId(id)
    setSyncResult('')
    try {
      const res = await accountsApi.sync(id)
      const s = res.synced
      const parts = [
        `заказов ${s.orders ?? 0}`,
        `остатков ${s.stocks ?? 0}`,
        ...(s.prices   != null ? [`цен ${s.prices}`]         : []),
        ...(s.ad_stats != null ? [`рекл. статистики ${s.ad_stats}`] : []),
      ]
      setSyncResult(`✅ Синхронизировано: ${parts.join(', ')}`)
      await load()
    } catch (err: unknown) {
      setSyncResult(err instanceof Error ? err.message : 'Ошибка синхронизации')
    } finally {
      setSyncingId(null)
    }
  }

  const statusLabel: Record<string, string> = {
    pending: '⏳ Не проверен',
    active: '✅ Активен',
    invalid: '❌ Ошибка ключа',
  }
  const statusColor: Record<string, string> = {
    pending: '#f59e0b',
    active: '#22c55e',
    invalid: '#ef4444',
  }

  return (
    <div style={{ padding: '24px', maxWidth: 800, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h2 style={{ color: '#f1f5f9', margin: 0, fontSize: 20, fontWeight: 700 }}>
          Подключённые маркетплейсы
        </h2>
        <button
          onClick={() => setShowForm(!showForm)}
          style={{
            background: '#38bdf8', color: '#0f172a', border: 'none',
            borderRadius: 8, padding: '8px 16px', fontWeight: 700, cursor: 'pointer', fontSize: 14,
          }}
        >
          + Добавить аккаунт
        </button>
      </div>

      {error && (
        <div style={{ background: '#450a0a', color: '#fca5a5', padding: 12, borderRadius: 8, marginBottom: 16, fontSize: 14 }}>
          {error}
        </div>
      )}

      {syncResult && (
        <div style={{ background: '#052e16', color: '#86efac', padding: 12, borderRadius: 8, marginBottom: 16, fontSize: 14 }}>
          {syncResult}
        </div>
      )}

      {showForm && (
        <form onSubmit={handleCreate} style={{
          background: '#1e293b', borderRadius: 12, padding: 20, marginBottom: 24,
          border: '1px solid #334155',
        }}>
          <h3 style={{ color: '#f1f5f9', margin: '0 0 16px', fontSize: 16 }}>Новый аккаунт</h3>

          <div style={{ display: 'grid', gap: 12 }}>
            <div>
              <label style={{ color: '#94a3b8', fontSize: 12, display: 'block', marginBottom: 4 }}>МАРКЕТПЛЕЙС</label>
              <select
                value={form.marketplace}
                onChange={e => setForm(f => ({ ...f, marketplace: e.target.value as 'wb' | 'ozon' }))}
                style={{ width: '100%', background: '#0f172a', color: '#f1f5f9', border: '1px solid #334155', borderRadius: 6, padding: '8px 12px', fontSize: 14 }}
              >
                <option value="wb">Wildberries</option>
                <option value="ozon">Ozon</option>
              </select>
            </div>

            <div>
              <label style={{ color: '#94a3b8', fontSize: 12, display: 'block', marginBottom: 4 }}>НАЗВАНИЕ (для себя)</label>
              <input
                required
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Например: Мой магазин WB"
                style={{ width: '100%', background: '#0f172a', color: '#f1f5f9', border: '1px solid #334155', borderRadius: 6, padding: '8px 12px', fontSize: 14, boxSizing: 'border-box' }}
              />
            </div>

            {form.marketplace === 'ozon' && (
              <div>
                <label style={{ color: '#94a3b8', fontSize: 12, display: 'block', marginBottom: 4 }}>CLIENT-ID (Ozon)</label>
                <input
                  required
                  value={form.seller_id}
                  onChange={e => setForm(f => ({ ...f, seller_id: e.target.value }))}
                  placeholder="Числовой ID продавца Ozon"
                  style={{ width: '100%', background: '#0f172a', color: '#f1f5f9', border: '1px solid #334155', borderRadius: 6, padding: '8px 12px', fontSize: 14, boxSizing: 'border-box' }}
                />
              </div>
            )}

            {form.marketplace === 'wb' && (
              <input type="hidden" value={form.seller_id} onChange={e => setForm(f => ({ ...f, seller_id: e.target.value }))} />
            )}

            <div>
              <label style={{ color: '#94a3b8', fontSize: 12, display: 'block', marginBottom: 4 }}>
                {form.marketplace === 'wb' ? 'API-КЛЮЧ СТАТИСТИКИ (seller.wildberries.ru → Настройки → Доступ к API)' : 'API-КЛЮЧ (из личного кабинета Ozon)'}
              </label>
              <input
                required
                type="password"
                value={form.api_key}
                onChange={e => setForm(f => ({ ...f, api_key: e.target.value }))}
                placeholder="Вставь API-ключ"
                style={{ width: '100%', background: '#0f172a', color: '#f1f5f9', border: '1px solid #334155', borderRadius: 6, padding: '8px 12px', fontSize: 14, boxSizing: 'border-box' }}
              />
            </div>

            {form.marketplace === 'wb' && (
              <div>
                <label style={{ color: '#94a3b8', fontSize: 12, display: 'block', marginBottom: 4 }}>
                  API-КЛЮЧ РЕКЛАМЫ — необязательно (cmp.wildberries.ru → имя → Настройки → Доступ к API)
                </label>
                <input
                  type="password"
                  value={form.advert_api_key}
                  onChange={e => setForm(f => ({ ...f, advert_api_key: e.target.value }))}
                  placeholder="Рекламный ключ из кабинета cmp.wildberries.ru"
                  style={{ width: '100%', background: '#0f172a', color: '#f1f5f9', border: '1px solid #334155', borderRadius: 6, padding: '8px 12px', fontSize: 14, boxSizing: 'border-box' }}
                />
                <div style={{ color: '#64748b', fontSize: 11, marginTop: 4 }}>
                  Нужен только для управления ставками. Без него статистика продолжает работать.
                </div>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button
              type="submit"
              style={{ background: '#38bdf8', color: '#0f172a', border: 'none', borderRadius: 6, padding: '8px 20px', fontWeight: 700, cursor: 'pointer', fontSize: 14 }}
            >
              Сохранить
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              style={{ background: '#334155', color: '#94a3b8', border: 'none', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontSize: 14 }}
            >
              Отмена
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div style={{ color: '#64748b', textAlign: 'center', padding: 40 }}>Загрузка...</div>
      ) : accounts.length === 0 ? (
        <div style={{
          background: '#1e293b', borderRadius: 12, padding: 40, textAlign: 'center',
          border: '1px dashed #334155',
        }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🏪</div>
          <div style={{ color: '#94a3b8', fontSize: 15, marginBottom: 8 }}>Нет подключённых аккаунтов</div>
          <div style={{ color: '#64748b', fontSize: 13 }}>Нажми «Добавить аккаунт» чтобы подключить WB или Ozon</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {accounts.map(acc => (
            <div key={acc.id} style={{
              background: '#1e293b', borderRadius: 12, padding: 20,
              border: '1px solid #334155', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 20 }}>{acc.marketplace === 'wb' ? '🟣' : '🔵'}</span>
                  <span style={{ color: '#f1f5f9', fontWeight: 700, fontSize: 15 }}>{acc.name}</span>
                  <span style={{ color: '#64748b', fontSize: 12 }}>{acc.marketplace.toUpperCase()}</span>
                </div>
                <div style={{ color: statusColor[acc.status], fontSize: 12, marginBottom: 4 }}>
                  {statusLabel[acc.status]}
                </div>
                {acc.last_sync_at && (
                  <div style={{ color: '#64748b', fontSize: 12 }}>
                    Синхронизирован: {new Date(acc.last_sync_at).toLocaleString('ru')}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => handleSync(acc.id)}
                  disabled={syncingId === acc.id}
                  style={{
                    background: syncingId === acc.id ? '#1e3a5f' : '#0c4a6e',
                    color: '#38bdf8', border: '1px solid #38bdf8',
                    borderRadius: 6, padding: '6px 14px', cursor: syncingId === acc.id ? 'wait' : 'pointer', fontSize: 13,
                  }}
                >
                  {syncingId === acc.id ? '⟳ Синхронизация...' : '⟳ Синхронизировать'}
                </button>
                <button
                  onClick={() => handleDelete(acc.id)}
                  style={{ background: 'transparent', color: '#ef4444', border: '1px solid #ef4444', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', fontSize: 13 }}
                >
                  Удалить
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 32, background: '#1e293b', borderRadius: 12, padding: 20, border: '1px solid #334155' }}>
        <h3 style={{ color: '#f1f5f9', margin: '0 0 12px', fontSize: 15 }}>Как получить API-ключ?</h3>
        <div style={{ color: '#94a3b8', fontSize: 13, lineHeight: 1.6 }}>
          <p><strong style={{ color: '#f1f5f9' }}>Wildberries:</strong> Личный кабинет WB → Настройки → Доступ к API → Создать новый токен (выбери категории: Статистика, Цены и скидки, Реклама)</p>
          <p><strong style={{ color: '#f1f5f9' }}>Ozon:</strong> Личный кабинет Ozon → Настройки → Seller API → Сгенерировать ключ. Client-ID найдёшь там же.</p>
        </div>
      </div>
    </div>
  )
}
