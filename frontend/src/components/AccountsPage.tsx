import { useState, useEffect } from 'react'
import { accountsApi, type Account } from '../api'

// ── Confirm dialog (MD3 Basic Dialog) ─────────────────────────────────────
function ConfirmModal({ title, message, onOk, onCancel }: {
  title: string; message: string; onOk: () => void; onCancel: () => void
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'rgba(0,0,0,0.32)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 9999, padding: 24,
      backdropFilter: 'blur(2px)',
    }}>
      <div style={{
        background: 'var(--md-sys-color-surface-container-high)',
        borderRadius: 'var(--md-sys-shape-corner-extra-large)',
        padding: '24px 24px 20px',
        maxWidth: 400, width: '100%',
        boxShadow: 'var(--md-sys-elevation-level3)',
        animation: 'card-in 200ms cubic-bezier(0.05,0.7,0.1,1)',
      }}>
        <div style={{ fontSize: 'var(--md-sys-typescale-headline-small-size)', fontWeight: 400, color: 'var(--md-sys-color-on-surface)', marginBottom: 12 }}>
          {title}
        </div>
        <div style={{ fontSize: 'var(--md-sys-typescale-body-medium-size)', color: 'var(--md-sys-color-on-surface-variant)', lineHeight: 1.6, marginBottom: 24, whiteSpace: 'pre-line' }}>
          {message}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="md3-btn md3-btn-text md3-ripple" onClick={onCancel}>Отмена</button>
          <button className="md3-btn md3-btn-error md3-ripple" onClick={onOk}>
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>delete</span>
            Удалить
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Field wrapper ──────────────────────────────────────────────────────────
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="md3-field">
      <span className="md3-field-label">{label}</span>
      {children}
    </div>
  )
}

// ── Status chip ────────────────────────────────────────────────────────────
function StatusChip({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string; icon: string }> = {
    pending: { label: 'Не проверен', cls: 'md3-badge-warning', icon: 'schedule' },
    active:  { label: 'Активен',     cls: 'md3-badge-success', icon: 'check_circle' },
    invalid: { label: 'Ошибка ключа',cls: 'md3-badge-error',   icon: 'error' },
  }
  const { label, cls, icon } = map[status] ?? { label: status, cls: 'md3-badge-neutral', icon: 'info' }
  return (
    <span className={cls} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span className="material-symbols-outlined" style={{ fontSize: 12, fontVariationSettings: "'FILL' 1" }}>{icon}</span>
      {label}
    </span>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────
interface AccountsPageProps {
  onAccountsChange?: (list: Account[], active?: Account) => void
}

export default function AccountsPage({ onAccountsChange }: AccountsPageProps = {}) {
  const [accounts, setAccounts]       = useState<Account[]>([])
  const [loading, setLoading]         = useState(true)
  const [error, setError]             = useState('')
  const [showForm, setShowForm]       = useState(false)
  const [syncingId, setSyncingId]     = useState<string | null>(null)
  const [syncResult, setSyncResult]   = useState<{ ok: boolean; msg: string } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Account | null>(null)

  const [form, setForm] = useState({
    marketplace: 'wb' as 'wb' | 'ozon',
    name: '', seller_id: '', api_key: '', advert_api_key: '',
  })

  useEffect(() => { load() }, [])

  async function load() {
    try {
      const list = await accountsApi.list()
      setAccounts(list)
      onAccountsChange?.(list)
    }
    catch { setError('Не удалось загрузить аккаунты') }
    finally { setLoading(false) }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault(); setError('')
    try {
      const newAccount = await accountsApi.create(form)
      setForm({ marketplace: 'wb', name: '', seller_id: '', api_key: '', advert_api_key: '' })
      setShowForm(false)
      const list = await accountsApi.list()
      setAccounts(list)
      // Уведомляем родителя: передаём новый аккаунт как активный
      onAccountsChange?.(list, newAccount)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Ошибка создания')
    }
  }

  async function handleDeleteConfirmed() {
    if (!deleteTarget) return
    const id = deleteTarget.id; setDeleteTarget(null)
    try { await accountsApi.delete(id); await load() }
    catch { setError('Ошибка удаления') }
  }

  async function handleSync(id: string) {
    setSyncingId(id); setSyncResult(null)
    try {
      const res = await accountsApi.sync(id)
      const s = res.synced
      const parts = [
        `заказов ${s.orders ?? 0}`,
        `остатков ${s.stocks ?? 0}`,
        ...(s.prices   != null ? [`цен ${s.prices}`]              : []),
        ...(s.ad_stats != null ? [`рекл. статистики ${s.ad_stats}`] : []),
      ]
      setSyncResult({ ok: true, msg: `Синхронизировано: ${parts.join(', ')}` })
      await load()
    } catch (err: unknown) {
      setSyncResult({ ok: false, msg: err instanceof Error ? err.message : 'Ошибка синхронизации' })
    } finally { setSyncingId(null) }
  }

  // ── marketplace icon ─────────────────────────────────────────────────────
  const mpIcon = (mp: string) => (
    <div style={{
      width: 36, height: 36, borderRadius: 'var(--md-sys-shape-corner-small)',
      background: mp === 'wb' ? '#cb11ab' : '#005bff',
      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    }}>
      <span className="material-symbols-outlined" style={{ color: '#fff', fontSize: 18, fontVariationSettings: "'FILL' 1" }}>
        {mp === 'wb' ? 'storefront' : 'store'}
      </span>
    </div>
  )

  return (
    <div style={{ padding: '24px 28px', maxWidth: 840, margin: '0 auto' }}>

      {/* Confirm delete dialog */}
      {deleteTarget && (
        <ConfirmModal
          title="Удалить аккаунт?"
          message={`Аккаунт «${deleteTarget.name}» будет удалён.\nВся история синхронизации и расписания останутся в системе.`}
          onOk={handleDeleteConfirmed}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {/* ── Header ──────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 'var(--md-sys-typescale-title-large-size)', fontWeight: 400, color: 'var(--md-sys-color-on-surface)' }}>
          Подключённые маркетплейсы
        </h2>
        <button className="md3-btn md3-btn-filled md3-ripple" onClick={() => setShowForm(!showForm)}>
          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>add</span>
          Добавить аккаунт
        </button>
      </div>

      {/* ── Error banner ────────────────────────────────────────── */}
      {error && (
        <div style={{
          background: 'var(--md-sys-color-error-container)', color: 'var(--md-sys-color-on-error-container)',
          borderRadius: 'var(--md-sys-shape-corner-medium)', padding: '12px 16px',
          marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center',
          fontSize: 'var(--md-sys-typescale-body-medium-size)',
        }}>
          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>error</span>
          {error}
        </div>
      )}

      {/* ── Sync result snackbar-like ────────────────────────────── */}
      {syncResult && (
        <div style={{
          background: syncResult.ok ? 'var(--md-sys-color-success-container)' : 'var(--md-sys-color-error-container)',
          color: syncResult.ok ? 'var(--md-sys-color-on-success-container)' : 'var(--md-sys-color-on-error-container)',
          borderRadius: 'var(--md-sys-shape-corner-medium)', padding: '12px 16px',
          marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center',
          fontSize: 'var(--md-sys-typescale-body-medium-size)',
        }}>
          <span className="material-symbols-outlined" style={{ fontSize: 18, fontVariationSettings: "'FILL' 1" }}>
            {syncResult.ok ? 'check_circle' : 'error'}
          </span>
          {syncResult.msg}
        </div>
      )}

      {/* ── Add account form (MD3 outlined card) ────────────────── */}
      {showForm && (
        <form onSubmit={handleCreate} style={{
          background: 'var(--md-sys-color-surface-container)',
          borderRadius: 'var(--md-sys-shape-corner-large)',
          padding: 24, marginBottom: 24,
          border: '1px solid var(--md-sys-color-outline-variant)',
          display: 'flex', flexDirection: 'column', gap: 16,
        }}>
          <div style={{ fontSize: 'var(--md-sys-typescale-title-medium-size)', fontWeight: 500, color: 'var(--md-sys-color-on-surface)', marginBottom: 4 }}>
            Новый аккаунт
          </div>

          <Field label="МАРКЕТПЛЕЙС">
            <select
              className="md3-field-input"
              value={form.marketplace}
              onChange={e => setForm(f => ({ ...f, marketplace: e.target.value as 'wb' | 'ozon' }))}
            >
              <option value="wb">Wildberries</option>
              <option value="ozon">Ozon</option>
            </select>
          </Field>

          <Field label="НАЗВАНИЕ (для себя)">
            <input
              required className="md3-field-input"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="Например: Мой магазин WB"
            />
          </Field>

          {form.marketplace === 'ozon' && (
            <Field label="CLIENT-ID (Ozon)">
              <input
                required className="md3-field-input"
                value={form.seller_id}
                onChange={e => setForm(f => ({ ...f, seller_id: e.target.value }))}
                placeholder="Числовой ID продавца Ozon"
              />
            </Field>
          )}

          <Field label={form.marketplace === 'wb'
            ? 'API-КЛЮЧ СТАТИСТИКИ (seller.wildberries.ru → Профиль → Настройки → Доступ к API)'
            : 'API-КЛЮЧ (Личный кабинет Ozon → Настройки → Seller API)'
          }>
            <input
              required type="password" className="md3-field-input"
              value={form.api_key}
              onChange={e => setForm(f => ({ ...f, api_key: e.target.value }))}
              placeholder="Вставьте API-ключ"
            />
          </Field>

          {form.marketplace === 'wb' && (
            <Field label="API-КЛЮЧ РЕКЛАМЫ — необязательно (advertise.wildberries.ru → Профиль → Доступ к API)">
              <input
                type="password" className="md3-field-input"
                value={form.advert_api_key}
                onChange={e => setForm(f => ({ ...f, advert_api_key: e.target.value }))}
                placeholder="Рекламный ключ из advertise.wildberries.ru"
              />
              <span style={{ fontSize: 11, color: 'var(--md-sys-color-on-surface-variant)', marginTop: 2 }}>
                Нужен только для управления ставками. Без него статистика продолжает работать.
              </span>
            </Field>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button type="submit" className="md3-btn md3-btn-filled md3-ripple">
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>save</span>
              Сохранить
            </button>
            <button type="button" className="md3-btn md3-btn-outlined md3-ripple" onClick={() => setShowForm(false)}>
              Отмена
            </button>
          </div>
        </form>
      )}

      {/* ── Loading state ────────────────────────────────────────── */}
      {loading && (
        <div className="md3-empty-state">
          <span className="material-symbols-outlined md3-empty-icon" style={{ animation: 'spin 1s linear infinite', fontSize: 40, opacity: 0.5 }}>
            progress_activity
          </span>
          <div className="md3-empty-body">Загрузка аккаунтов…</div>
        </div>
      )}

      {/* ── Onboarding (no accounts) ─────────────────────────────── */}
      {!loading && accounts.length === 0 && (
        <div style={{
          background: 'var(--md-sys-color-primary-container)',
          borderRadius: 'var(--md-sys-shape-corner-extra-large)',
          padding: '32px 28px', marginBottom: 24,
        }}>
          <div style={{ fontSize: 28, marginBottom: 12 }}>👋</div>
          <div style={{ fontWeight: 500, fontSize: 18, color: 'var(--md-sys-color-on-primary-container)', marginBottom: 12 }}>
            Подключите аккаунт за 3 шага
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 24 }}>
            {[
              { step: '1', text: 'Получите API-ключ в личном кабинете WB (инструкция ниже)' },
              { step: '2', text: 'Нажмите «Добавить аккаунт» и введите ключ' },
              { step: '3', text: 'Нажмите «Синхронизировать» — данные загрузятся за 1–2 минуты' },
            ].map(({ step, text }) => (
              <div key={step} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 28, height: 28, borderRadius: '50%',
                  background: 'var(--md-sys-color-primary)',
                  color: 'var(--md-sys-color-on-primary)',
                  fontWeight: 700, fontSize: 13,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>{step}</div>
                <div style={{ fontSize: 14, color: 'var(--md-sys-color-on-primary-container)' }}>{text}</div>
              </div>
            ))}
          </div>
          <button className="md3-btn md3-btn-filled md3-ripple" onClick={() => setShowForm(true)}>
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>add_circle</span>
            Добавить первый аккаунт
          </button>
        </div>
      )}

      {/* ── Account cards ────────────────────────────────────────── */}
      {!loading && accounts.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Sync needed banner */}
          {accounts.some(a => !a.last_sync_at) && (
            <div style={{
              background: 'var(--md-sys-color-warning-container)',
              color: 'var(--md-sys-color-on-warning-container)',
              borderRadius: 'var(--md-sys-shape-corner-medium)',
              padding: '14px 18px', display: 'flex', gap: 12, alignItems: 'flex-start',
            }}>
              <span className="material-symbols-outlined" style={{ fontSize: 20, marginTop: 1, fontVariationSettings: "'FILL' 1" }}>wifi_tethering</span>
              <div>
                <div style={{ fontWeight: 500, marginBottom: 2 }}>Аккаунт добавлен — нажмите «Синхронизировать»</div>
                <div style={{ fontSize: 13, opacity: 0.85 }}>
                  Данные загрузятся за 1–2 минуты. После этого откроется аналитика на Дашборде.
                </div>
              </div>
            </div>
          )}

          {accounts.map(acc => (
            <div key={acc.id} style={{
              background: 'var(--md-sys-color-surface-container-low)',
              borderRadius: 'var(--md-sys-shape-corner-large)',
              padding: '16px 18px',
              border: '1px solid var(--md-sys-color-outline-variant)',
              boxShadow: 'var(--md-sys-elevation-level1)',
              display: 'flex', alignItems: 'center', gap: 14,
              flexWrap: 'wrap',
            }}>
              {/* Marketplace icon */}
              {mpIcon(acc.marketplace)}

              {/* Info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                  <span style={{ fontWeight: 500, fontSize: 15, color: 'var(--md-sys-color-on-surface)' }}>
                    {acc.name}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--md-sys-color-on-surface-variant)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    {acc.marketplace}
                  </span>
                  <StatusChip status={acc.status} />
                </div>
                {acc.last_sync_at ? (
                  <div style={{ fontSize: 12, color: 'var(--md-sys-color-on-surface-variant)' }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 12, verticalAlign: 'middle', marginRight: 3 }}>sync</span>
                    {new Date(acc.last_sync_at).toLocaleString('ru')}
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--md-sys-color-warning)' }}>Ещё не синхронизирован</div>
                )}
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <button
                  className="md3-btn md3-btn-tonal md3-ripple"
                  style={{ padding: '6px 14px', minHeight: 36, fontSize: 13 }}
                  onClick={() => handleSync(acc.id)}
                  disabled={syncingId === acc.id}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 16, animation: syncingId === acc.id ? 'spin 1s linear infinite' : 'none' }}>
                    sync
                  </span>
                  {syncingId === acc.id ? 'Синхронизация…' : 'Синхронизировать'}
                </button>
                <button
                  className="md3-btn md3-btn-outlined md3-ripple"
                  style={{ padding: '6px 12px', minHeight: 36, fontSize: 13, color: 'var(--md-sys-color-error)', borderColor: 'var(--md-sys-color-error)' }}
                  onClick={() => setDeleteTarget(acc)}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>delete</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── API key instructions ──────────────────────────────────── */}
      <div style={{
        marginTop: 32,
        background: 'var(--md-sys-color-surface-container)',
        borderRadius: 'var(--md-sys-shape-corner-large)',
        padding: 20,
        border: '1px solid var(--md-sys-color-outline-variant)',
      }}>
        <div style={{ fontWeight: 500, fontSize: 'var(--md-sys-typescale-title-small-size)', color: 'var(--md-sys-color-on-surface)', marginBottom: 10 }}>
          Как получить API-ключ?
        </div>
        <div style={{ color: 'var(--md-sys-color-on-surface-variant)', fontSize: 13, lineHeight: 1.7 }}>
          <p style={{ marginBottom: 8 }}>
            <strong style={{ color: 'var(--md-sys-color-on-surface)' }}>Wildberries:</strong>{' '}
            seller.wildberries.ru → Профиль → Настройки → Доступ к API → Создать новый токен
            (категории: Статистика, Цены и скидки). Для рекламы: advertise.wildberries.ru → Профиль → Доступ к API.
          </p>
          <p>
            <strong style={{ color: 'var(--md-sys-color-on-surface)' }}>Ozon:</strong>{' '}
            Личный кабинет Ozon → Настройки → Seller API → Сгенерировать ключ. Client-ID найдёте там же.
          </p>
        </div>
      </div>

    </div>
  )
}
