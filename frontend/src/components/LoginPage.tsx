import { useState } from 'react'
import { authApi } from '../api'
import './LoginPage.css'

type Props = {
  onLogin: () => void
}

export function LoginPage({ onLogin }: Props) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(null)

    if (!email.trim() || !password.trim()) {
      setError('Заполни email и пароль')
      return
    }
    if (password.length < 6) {
      setError('Пароль — минимум 6 символов')
      return
    }

    setLoading(true)
    try {
      if (mode === 'login') {
        const tokens = await authApi.login(email.trim(), password)
        localStorage.setItem('mc_token', tokens.access_token)
        localStorage.setItem('mc_refresh_token', tokens.refresh_token)
        onLogin()
      } else {
        await authApi.register(email.trim(), password)
        setSuccess('Аккаунт создан! Теперь войди.')
        setMode('login')
        setPassword('')
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('400') || msg.includes('already')) {
        setError('Этот email уже зарегистрирован')
      } else if (msg.includes('401') || msg.includes('Invalid')) {
        setError('Неверный email или пароль')
      } else {
        setError('Сервер недоступен — попробуй позже')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-bg">
      <div className="login-card">
        {/* Лого */}
        <div className="login-logo">
          <span className="login-logo-icon">⚡</span>
          <span className="login-logo-text">MarketCore</span>
        </div>
        <p className="login-tagline">Автоматизация продаж на WB и Ozon</p>

        {/* Переключатель режима */}
        <div className="login-tabs">
          <button
            className={`login-tab ${mode === 'login' ? 'active' : ''}`}
            onClick={() => { setMode('login'); setError(null); setSuccess(null) }}
          >
            Войти
          </button>
          <button
            className={`login-tab ${mode === 'register' ? 'active' : ''}`}
            onClick={() => { setMode('register'); setError(null); setSuccess(null) }}
          >
            Регистрация
          </button>
        </div>

        {/* Форма */}
        <form className="login-form" onSubmit={handleSubmit} noValidate>
          <div className="login-field">
            <label className="login-label">Email</label>
            <input
              className="login-input"
              type="email"
              placeholder="seller@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              disabled={loading}
            />
          </div>

          <div className="login-field">
            <label className="login-label">Пароль</label>
            <input
              className="login-input"
              type="password"
              placeholder={mode === 'register' ? 'Минимум 6 символов' : '••••••••'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              disabled={loading}
            />
          </div>

          {error && <div className="login-error">⚠ {error}</div>}
          {success && <div className="login-success">✓ {success}</div>}

          <button
            className="login-submit"
            type="submit"
            disabled={loading}
          >
            {loading
              ? '...'
              : mode === 'login' ? 'Войти' : 'Создать аккаунт'
            }
          </button>
        </form>

        <p className="login-footer">
          Нажимая «{mode === 'login' ? 'Войти' : 'Создать аккаунт'}», ты соглашаешься
          с условиями использования сервиса.
        </p>
      </div>
    </div>
  )
}
