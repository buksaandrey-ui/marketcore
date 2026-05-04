import { useState } from 'react'
import { authApi } from '../api'
import './LoginPage.css'

type Props = { onLogin: () => void }

export function LoginPage({ onLogin }: Props) {
  const [mode, setMode]       = useState<'login' | 'register'>('login')
  const [email, setEmail]     = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(null)
    if (!email.trim() || !password.trim()) { setError('Заполните email и пароль'); return }
    if (password.length < 6) { setError('Пароль — минимум 6 символов'); return }
    setLoading(true)
    try {
      if (mode === 'login') {
        const tokens = await authApi.login(email.trim(), password)
        localStorage.setItem('mc_token', tokens.access_token)
        localStorage.setItem('mc_refresh_token', tokens.refresh_token)
        onLogin()
      } else {
        await authApi.register(email.trim(), password)
        setSuccess('Аккаунт создан! Теперь войдите.')
        setMode('login')
        setPassword('')
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('400') || msg.includes('already')) setError('Этот email уже зарегистрирован')
      else if (msg.includes('401') || msg.includes('Invalid')) setError('Неверный email или пароль')
      else setError('Сервер недоступен — попробуйте позже')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-bg">
      <div className="login-card">

        {/* Brand */}
        <div className="login-logo">
          <div className="login-logo-icon">
            <span className="material-symbols-outlined">bolt</span>
          </div>
          <span className="login-logo-text">MarketCore</span>
        </div>
        <p className="login-tagline">Автоматизация продаж на Wildberries и Ozon</p>

        {/* Login / Register tabs */}
        <div className="login-tabs" role="tablist">
          {(['login', 'register'] as const).map(m => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              className={`login-tab${mode === m ? ' active' : ''}`}
              onClick={() => { setMode(m); setError(null); setSuccess(null) }}
            >
              {m === 'login' ? 'Войти' : 'Регистрация'}
            </button>
          ))}
        </div>

        {/* Form */}
        <form className="login-form" onSubmit={handleSubmit} noValidate>

          {/* Email */}
          <div className="login-field">
            <div className="login-field-inner">
              <span className="material-symbols-outlined login-field-icon"
                style={{ fontVariationSettings: "'FILL' 0, 'wght' 300, 'GRAD' 0, 'opsz' 20" }}>
                mail
              </span>
              <input
                className="login-input"
                type="email"
                placeholder="email@example.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                disabled={loading}
                autoComplete="email"
                aria-label="Email"
              />
            </div>
            <span className="login-label">Email</span>
          </div>

          {/* Password */}
          <div className="login-field">
            <div className="login-field-inner">
              <span className="material-symbols-outlined login-field-icon"
                style={{ fontVariationSettings: "'FILL' 0, 'wght' 300, 'GRAD' 0, 'opsz' 20" }}>
                lock
              </span>
              <input
                className="login-input"
                type="password"
                placeholder="Минимум 6 символов"
                value={password}
                onChange={e => setPassword(e.target.value)}
                disabled={loading}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                aria-label="Пароль"
              />
            </div>
            <span className="login-label">Пароль</span>
          </div>

          {/* Messages */}
          {error && (
            <div className="login-error" role="alert">
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>error</span>
              {error}
            </div>
          )}
          {success && (
            <div className="login-success" role="status">
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>check_circle</span>
              {success}
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            className="login-submit"
            disabled={loading}
          >
            {loading
              ? <span className="login-spinner" />
              : <>
                  <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
                    {mode === 'login' ? 'login' : 'person_add'}
                  </span>
                  {mode === 'login' ? 'Войти' : 'Создать аккаунт'}
                </>
            }
          </button>
        </form>

        <p className="login-footer">
          Входя, вы соглашаетесь с условиями использования сервиса
        </p>
      </div>
    </div>
  )
}
