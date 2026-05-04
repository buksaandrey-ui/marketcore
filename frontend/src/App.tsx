import { useState } from 'react'
import { Dashboard }         from './components/Dashboard'
import { SupplyForecast }    from './components/SupplyForecast'
import { WbCampaignManager } from './components/WbCampaignManager'
import { LoginPage }         from './components/LoginPage'
import AccountsPage          from './components/AccountsPage'
import { BehaviorPage }      from './components/BehaviorPage'
import { ReportsPage }       from './components/ReportsPage'
// UnitEcon, ScheduleGrid, BotHistoryPage убраны из навигации (demo / дублирует / устарел)
import './App.css'

// Убраны из навигации:
// - 'unit-econ'   → 100% демо-данные, реального API нет
// - 'schedule'    → дублирует вкладку «Расписание» в Кампаниях WB
// - 'bot-history' → показывал старый DSL-биддинг (всегда пустая таблица)
type Page = 'dashboard' | 'supply' | 'bidding' | 'accounts' | 'behavior' | 'reports'

const NAV: { id: Page; icon: string; label: string }[] = [
  { id: 'dashboard', icon: '📊', label: 'Дашборд'     },
  { id: 'supply',    icon: '📦', label: 'Поставки'    },
  { id: 'reports',   icon: '📋', label: 'Отчёты'      },
  { id: 'bidding',   icon: '📣', label: 'Кампании WB' },
  { id: 'behavior',  icon: '📈', label: 'Поведение'   },
  { id: 'accounts',  icon: '🏪', label: 'Аккаунты'    },
]

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
        {page === 'dashboard' && <Dashboard onNavigate={navigate} />}
        {page === 'supply'    && <SupplyForecast />}
        {page === 'reports'   && <ReportsPage />}
        {page === 'accounts'  && <AccountsPage />}
        {page === 'behavior'  && <BehaviorPage />}
        {page === 'bidding'   && <WbCampaignManager />}
      </main>
    </div>
  )
}
