import { useState } from 'react'
import { Dashboard }       from './components/Dashboard'
import { UnitEcon }        from './components/UnitEcon'
import { SupplyForecast }  from './components/SupplyForecast'
import { ScheduleGrid }    from './components/ScheduleGrid'
import { LoginPage }       from './components/LoginPage'
import AccountsPage        from './components/AccountsPage'
import { BehaviorPage }    from './components/BehaviorPage'
import { ReportsPage }     from './components/ReportsPage'
import { BotHistoryPage }  from './components/BotHistoryPage'
import './App.css'

type Page = 'dashboard' | 'unit-econ' | 'supply' | 'bidding' | 'bot-history' | 'accounts' | 'behavior' | 'reports'

const NAV: { id: Page; icon: string; label: string }[] = [
  { id: 'dashboard',   icon: '📊', label: 'Дашборд'        },
  { id: 'unit-econ',   icon: '📐', label: 'Юнит-экономика' },
  { id: 'supply',      icon: '📦', label: 'Поставки'       },
  { id: 'bidding',     icon: '⏱',  label: 'Ставки'         },
  { id: 'bot-history', icon: '🤖', label: 'История бота'   },
  { id: 'behavior',    icon: '📈', label: 'Поведение'      },
  { id: 'reports',     icon: '📋', label: 'Отчёты'         },
  { id: 'accounts',    icon: '🏪', label: 'Аккаунты'       },
]

export default function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(() =>
    Boolean(localStorage.getItem('mc_token'))
  )
  const [page, setPage] = useState<Page>('dashboard')

  const handleLogin  = () => setIsLoggedIn(true)
  const handleLogout = () => {
    localStorage.removeItem('mc_token')
    localStorage.removeItem('mc_refresh_token')
    setIsLoggedIn(false)
  }

  if (!isLoggedIn) return <LoginPage onLogin={handleLogin} />

  return (
    <div className="app-shell">
      <header className="app-nav">
        <div className="app-nav-left">
          <span className="app-nav-logo">⚡ MarketCore</span>
          <nav className="app-nav-links">
            {NAV.map(n => (
              <button
                key={n.id}
                className={`app-nav-link ${page === n.id ? 'active' : ''}`}
                onClick={() => setPage(n.id)}
              >
                {n.icon} {n.label}
              </button>
            ))}
          </nav>
        </div>
        <div className="app-nav-right">
          <span className="app-nav-user">👤 мой аккаунт</span>
          <button className="app-nav-logout" onClick={handleLogout}>Выйти</button>
        </div>
      </header>

      <main className="app-main">
        {page === 'dashboard' && <Dashboard />}
        {page === 'unit-econ' && <UnitEcon />}
        {page === 'supply'    && <SupplyForecast />}
        {page === 'bidding'   && <ScheduleGrid />}
        {page === 'bot-history' && <BotHistoryPage />}
        {page === 'behavior'  && <BehaviorPage />}
        {page === 'reports'   && <ReportsPage />}
        {page === 'accounts'  && <AccountsPage />}
      </main>
    </div>
  )
}
