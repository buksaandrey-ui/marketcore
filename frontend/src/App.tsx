import { useState } from 'react'
import { Dashboard }         from './components/Dashboard'
import { SupplyForecast }    from './components/SupplyForecast'
import { WbCampaignManager } from './components/WbCampaignManager'
import { LoginPage }         from './components/LoginPage'
import AccountsPage          from './components/AccountsPage'
import { BehaviorPage }      from './components/BehaviorPage'
import { ReportsPage }       from './components/ReportsPage'
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

export default function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(() =>
    Boolean(localStorage.getItem('mc_token'))
  )
  const [page, setPage] = useState<Page>('dashboard')

  const navigate = (p: string) => {
    if (NAV.some(n => n.id === p)) setPage(p as Page)
  }

  const handleLogin  = () => setIsLoggedIn(true)
  const handleLogout = () => {
    localStorage.removeItem('mc_token')
    localStorage.removeItem('mc_refresh_token')
    setIsLoggedIn(false)
  }

  if (!isLoggedIn) return <LoginPage onLogin={handleLogin} />

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

        {/* Logout */}
        <div className="app-rail-bottom">
          <button
            className="rail-logout-btn md3-ripple"
            onClick={handleLogout}
            title="Выйти"
            aria-label="Выйти"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 20 }}>logout</span>
          </button>
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

        {/* Pages */}
        {page === 'dashboard' && <Dashboard onNavigate={navigate} />}
        {page === 'supply'    && <SupplyForecast />}
        {page === 'reports'   && <ReportsPage />}
        {page === 'accounts'  && <AccountsPage />}
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
