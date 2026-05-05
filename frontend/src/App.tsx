import { useState, useEffect, useCallback } from 'react'
import { Dashboard }         from './components/Dashboard'
import { SupplyForecast }    from './components/SupplyForecast'
import { WbCampaignManager } from './components/WbCampaignManager'
import { LoginPage }         from './components/LoginPage'
import AccountsPage          from './components/AccountsPage'
import { BehaviorPage }      from './components/BehaviorPage'
import { ReportsPage }       from './components/ReportsPage'
import { accountsApi, authApi, accountPrefs, type Account, type UserResponse } from './api'
import './App.css'

type Page = 'dashboard' | 'supply' | 'bidding' | 'accounts' | 'behavior' | 'reports'

const NAV: { id: Page; icon: string; label: string }[] = [
  { id: 'dashboard', icon: 'dashboard',   label: 'Дашборд'  },
  { id: 'reports',   icon: 'bar_chart',   label: 'Отчёты'   },
  { id: 'supply',    icon: 'inventory_2', label: 'Поставки' },
  { id: 'bidding',   icon: 'campaign',    label: 'Кампании' },
  { id: 'behavior',  icon: 'trending_up', label: 'Поведение'},
  { id: 'accounts',  icon: 'store',       label: 'Аккаунты' },
]

const PAGE_TITLES: Record<Page, string> = {
  dashboard: 'Дашборд',
  reports:   'Отчёты',
  supply:    'Поставки',
  bidding:   'Кампании WB',
  behavior:  'Поведение',
  accounts:  'Аккаунты',
}

// ── Компактный переключатель аккаунтов ─────────────────────────────────────
function AccountSwitcher({
  accounts, active, onChange,
}: {
  accounts: Account[]
  active: Account | null
  onChange: (a: Account) => void
}) {
  const [open, setOpen] = useState(false)
  if (!accounts.length) return null

  const isOzon = active?.marketplace === 'ozon'
  const mkIcon = isOzon ? 'shopping_bag' : 'local_mall'
  const mkColor = isOzon ? 'var(--md-sys-color-ozon-primary)' : 'var(--md-sys-color-primary)'

  return (
    <div className="acct-switcher" style={{ position: 'relative' }}>
      <button
        className="acct-switcher-btn md3-ripple"
        onClick={() => setOpen(o => !o)}
        title={active ? `${active.name} (${active.marketplace.toUpperCase()})` : 'Выбрать аккаунт'}
        aria-expanded={open}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 18, color: mkColor, fontVariationSettings: "'FILL' 1" }}>
          {mkIcon}
        </span>
        <span className="acct-switcher-name">{active?.name ?? 'Аккаунт'}</span>
        <span className="material-symbols-outlined" style={{ fontSize: 14, color: 'var(--md-sys-color-on-surface-variant)' }}>
          {open ? 'expand_less' : 'expand_more'}
        </span>
      </button>

      {open && (
        <>
          {/* Клик вне — закрывает */}
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 99 }}
            onClick={() => setOpen(false)}
          />
          <div className="acct-switcher-menu" style={{ zIndex: 100 }}>
            {accounts.map(a => (
              <button
                key={a.id}
                className={`acct-menu-item md3-ripple${a.id === active?.id ? ' active' : ''}`}
                onClick={() => { onChange(a); setOpen(false) }}
              >
                <span className="material-symbols-outlined" style={{
                  fontSize: 15, fontVariationSettings: "'FILL' 1",
                  color: a.marketplace === 'ozon'
                    ? 'var(--md-sys-color-ozon-primary)'
                    : 'var(--md-sys-color-primary)',
                }}>
                  {a.marketplace === 'ozon' ? 'shopping_bag' : 'local_mall'}
                </span>
                <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {a.name}
                </span>
                <span style={{
                  fontSize: 10, fontWeight: 600,
                  color: a.marketplace === 'ozon'
                    ? 'var(--md-sys-color-ozon-primary)'
                    : 'var(--md-sys-color-primary)',
                  textTransform: 'uppercase', letterSpacing: '0.3px',
                }}>
                  {a.marketplace}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ── Аватар пользователя (первая буква email) ────────────────────────────────
function UserAvatar({ user, onLogout }: { user: UserResponse | null; onLogout: () => void }) {
  const [open, setOpen] = useState(false)
  const letter = user?.email?.[0]?.toUpperCase() ?? '?'

  return (
    <div style={{ position: 'relative' }}>
      <button
        className="user-avatar-btn md3-ripple"
        onClick={() => setOpen(o => !o)}
        title={user?.email ?? 'Профиль'}
        aria-label="Профиль"
      >
        {letter}
      </button>

      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 99 }} onClick={() => setOpen(false)} />
          <div className="user-menu" style={{ zIndex: 100 }}>
            <div className="user-menu-email">{user?.email ?? '...'}</div>
            <div className="user-menu-divider" />
            <button className="user-menu-item md3-ripple" onClick={() => { setOpen(false); onLogout() }}>
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>logout</span>
              Выйти
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// ── Главный компонент ───────────────────────────────────────────────────────
export default function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(() => Boolean(localStorage.getItem('mc_token')))
  const [page,       setPage]       = useState<Page>('dashboard')
  const [accounts,   setAccounts]   = useState<Account[]>([])
  const [activeAcct, setActiveAcct] = useState<Account | null>(null)
  const [user,       setUser]       = useState<UserResponse | null>(null)

  // Загружаем аккаунты и профиль при входе
  useEffect(() => {
    if (!isLoggedIn) return
    accountsApi.list()
      .then(list => {
        setAccounts(list)
        const savedId = accountPrefs.get()
        const found   = list.find(a => a.id === savedId) ?? list[0] ?? null
        setActiveAcct(found)
      })
      .catch(() => {})
    authApi.me()
      .then(setUser)
      .catch(() => {})
  }, [isLoggedIn])

  // Применяем тему в зависимости от маркетплейса активного аккаунта
  useEffect(() => {
    const root = document.documentElement
    if (activeAcct?.marketplace === 'ozon') {
      root.setAttribute('data-marketplace', 'ozon')
    } else {
      root.removeAttribute('data-marketplace')
    }
  }, [activeAcct])

  const handleAccountChange = useCallback((a: Account) => {
    setActiveAcct(a)
    accountPrefs.set(a.id)
  }, [])

  const navigate = (p: string) => {
    if (NAV.some(n => n.id === p)) setPage(p as Page)
  }

  const handleLogin  = () => setIsLoggedIn(true)
  const handleLogout = () => {
    document.documentElement.removeAttribute('data-marketplace')
    localStorage.removeItem('mc_token')
    localStorage.removeItem('mc_refresh_token')
    setIsLoggedIn(false)
    setUser(null)
  }

  if (!isLoggedIn) return <LoginPage onLogin={handleLogin} />

  const acctId = activeAcct?.id ?? ''

  return (
    <div className="app-shell">

      {/* ── Desktop: Navigation Rail ─────────────────────────────────────── */}
      <nav className="app-rail" aria-label="Основная навигация">
        {/* Логотип */}
        <div className="app-rail-logo" title="MarketCore">
          <span className="material-symbols-outlined">bolt</span>
        </div>

        <div className="app-rail-divider" />

        {/* Nav items */}
        <div className="app-rail-nav">
          {NAV.map(n => (
            <button
              key={n.id}
              className={`rail-item md3-ripple${page === n.id ? ' active' : ''}`}
              onClick={() => setPage(n.id)}
              aria-label={n.label}
              aria-current={page === n.id ? 'page' : undefined}
            >
              <div className="rail-item-indicator">
                <span className="material-symbols-outlined">{n.icon}</span>
              </div>
              <span className="rail-item-label">{n.label}</span>
            </button>
          ))}
        </div>

        {/* Профиль + выход */}
        <div className="app-rail-bottom">
          <UserAvatar user={user} onLogout={handleLogout} />
        </div>
      </nav>

      {/* ── Content ──────────────────────────────────────────────────────── */}
      <main className="app-main">

        {/* Mobile: TopAppBar */}
        <header className="app-topbar" aria-label="Верхняя панель">
          <div className="app-topbar-logo">
            <span className="material-symbols-outlined">bolt</span>
          </div>
          <span className="app-topbar-title">{PAGE_TITLES[page]}</span>
          <button
            className="md3-icon-btn md3-ripple"
            onClick={handleLogout}
            aria-label="Выйти"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 20 }}>logout</span>
          </button>
        </header>

        {/* Переключатель аккаунта — видна на всех страницах кроме Аккаунтов */}
        {page !== 'accounts' && accounts.length > 0 && (
          <div className="app-acct-bar">
            <AccountSwitcher
              accounts={accounts}
              active={activeAcct}
              onChange={handleAccountChange}
            />
          </div>
        )}

        {/* Pages */}
        {page === 'dashboard' && <Dashboard onNavigate={navigate} accountId={acctId} />}
        {page === 'supply'    && <SupplyForecast />}
        {page === 'reports'   && <ReportsPage accountId={acctId} />}
        {page === 'accounts'  && (
          <AccountsPage
            onAccountsChange={(list, active) => {
              setAccounts(list)
              if (active) handleAccountChange(active)
            }}
          />
        )}
        {page === 'behavior'  && <BehaviorPage />}
        {page === 'bidding'   && <WbCampaignManager />}
      </main>

      {/* ── Mobile: Navigation Bar ───────────────────────────────────────── */}
      <nav className="app-bottom-nav" aria-label="Нижняя навигация">
        {NAV.map(n => (
          <button
            key={n.id}
            className={`bottom-nav-item md3-ripple${page === n.id ? ' active' : ''}`}
            onClick={() => setPage(n.id)}
            aria-label={n.label}
            aria-current={page === n.id ? 'page' : undefined}
          >
            <div className="bottom-nav-indicator">
              <span className="material-symbols-outlined">{n.icon}</span>
            </div>
            <span className="bottom-nav-label">{n.label}</span>
          </button>
        ))}
      </nav>

    </div>
  )
}
