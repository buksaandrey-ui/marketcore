/**
 * api.ts — клиент для общения с бэкендом MarketCore.
 *
 * Принцип работы:
 * - Все запросы идут на BASE_URL (по умолчанию http://localhost:8100)
 * - Токен авторизации берётся из localStorage (ключ "mc_token")
 * - Если сервер недоступен или токена нет — функции бросают ошибку,
 *   и вызывающий код падает на localStorage как запасной вариант
 */

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8100'

function getToken(): string | null {
  return localStorage.getItem('mc_token')
}

// ─── Auth API ────────────────────────────────────────────────────────────────

export type TokenPair = {
  access_token: string
  refresh_token: string
}

export type UserResponse = {
  id: string
  email: string
  created_at: string
}

export const authApi = {
  /** Войти — возвращает пару токенов */
  login: (email: string, password: string): Promise<TokenPair> =>
    apiFetch<TokenPair>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  /** Зарегистрироваться — возвращает данные созданного пользователя */
  register: (email: string, password: string): Promise<UserResponse> =>
    apiFetch<UserResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
}

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken()
  const res = await fetch(BASE_URL + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers as Record<string, string> | undefined),
    },
  })
  if (!res.ok) {
    if (res.status === 401) {
      localStorage.removeItem('mc_token')
      localStorage.removeItem('mc_refresh_token')
      window.location.reload()
    }
    const text = await res.text().catch(() => '')
    throw new Error(`API ${res.status}: ${text}`)
  }
  if (res.status === 204) return null as T
  return res.json() as Promise<T>
}

export type BenchmarkResult = {
  min: number
  competitor: number
  top: number
  aggressive: number
  is_real: boolean   // true = реальные данные с площадки, false = заглушка
  source: string     // текстовое пояснение для пользователя
}

export const benchmarksApi = {
  /** Получить ставки через сохранённый аккаунт (требует авторизации) */
  fetch: (params: {
    account_id: string
    platform: 'wb' | 'ozon'
    pay_model: 'cpm' | 'cpc'
    category: string
    placement: string
  }): Promise<BenchmarkResult> => {
    const q = new URLSearchParams(params as Record<string, string>).toString()
    return apiFetch<BenchmarkResult>(`/benchmarks?${q}`)
  },

  /**
   * Получить ставки напрямую по API-ключу — без предварительного сохранения аккаунта.
   * Удобно для быстрого теста ключей.
   */
  preview: (params: {
    platform: 'wb' | 'ozon'
    pay_model: 'cpm' | 'cpc'
    api_key: string
    seller_id?: string
    category: string
    placement: string
  }): Promise<BenchmarkResult> =>
    apiFetch<BenchmarkResult>('/benchmarks/preview', {
      method: 'POST',
      body: JSON.stringify(params),
    }),
}

export type Account = {
  id: string
  marketplace: 'wb' | 'ozon'
  name: string
  seller_id: string
  status: 'pending' | 'active' | 'invalid'
  last_sync_at: string | null
  created_at: string
}

export type DashboardSummary = {
  has_data: boolean
  accounts?: { id: string; name: string; marketplace: string; last_sync_at: string | null }[]
  orders_count?: number
  orders_sum?: number
  revenue?: number
  ad_spend?: number
  drr_to_orders?: number
  drr_to_revenue?: number
  top_skus?: { sku: string; orders_count: number; revenue: number }[]
}

export type WbCampaign = {
  advert_id: number
  name: string
  type: number        // 5=поиск, 6=каталог, 8=авто, 9=поиск+каталог
  status: number      // 9=активна, 11=на паузе
  cpm: number
  subject_id: number | null
  menu_id: number | null
}

export const accountsApi = {
  list: (): Promise<Account[]> => apiFetch<Account[]>('/accounts'),

  create: (data: { marketplace: string; name: string; seller_id: string; api_key: string; advert_api_key?: string }): Promise<Account> =>
    apiFetch<Account>('/accounts', { method: 'POST', body: JSON.stringify(data) }),

  delete: (id: string): Promise<null> =>
    apiFetch<null>(`/accounts/${id}`, { method: 'DELETE' }),

  verify: (id: string): Promise<Account> =>
    apiFetch<Account>(`/accounts/${id}/verify`, { method: 'POST' }),

  sync: (id: string): Promise<{ status: string; synced: Record<string, number> }> =>
    apiFetch(`/accounts/${id}/sync`, { method: 'POST' }),

  campaigns: (id: string): Promise<WbCampaign[]> =>
    apiFetch<WbCampaign[]>(`/accounts/${id}/campaigns`),
}

export type HeatmapData = {
  has_data: boolean
  matrix: number[][]
  max_val: number
}

export type SalesReport = {
  has_data: boolean
  period?: { from: string; to: string }
  units?: number
  orders_sum?: number
  buyout_sum?: number
  wb_services?: number
  ad_spend?: number
  amount_to_pay?: number
  real_drr?: number
  by_warehouse?: { warehouse: string; units: number; sum: number }[]
  stock_by_warehouse?: { warehouse: string; qty: number }[]
  by_sku?: { sku: string; units: number; orders_sum: number }[]
}

export const analyticsApi = {
  dashboard: (days = 30): Promise<DashboardSummary> =>
    apiFetch<DashboardSummary>(`/analytics/dashboard?days=${days}`),

  heatmap: (days = 30): Promise<HeatmapData> =>
    apiFetch<HeatmapData>(`/analytics/orders/heatmap?days=${days}`),

  report: (params: { period: string; date_from?: string; date_to?: string; sku?: string }): Promise<SalesReport> => {
    const q = new URLSearchParams()
    q.set('period', params.period)
    if (params.date_from) q.set('date_from', params.date_from)
    if (params.date_to)   q.set('date_to',   params.date_to)
    if (params.sku)       q.set('sku',        params.sku)
    return apiFetch<SalesReport>(`/analytics/report?${q}`)
  },
}

export type ServerSchedule = {
  id: string
  name: string
  schedule_json: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type BotExecution = {
  id: string
  schedule_id: string | null
  account_id: string | null
  computed_at: string
  platform: string
  pay_model: string
  base_cpm: number
  multiplier_pct: number
  target_cpm: number
  mode: 'dry_run' | 'live'
  status: 'computed' | 'applied' | 'skipped' | 'failed'
  reason: string
}

export const biddingExecutionsApi = {
  /** История действий автобота — что он посчитал и почему */
  list: (limit = 50): Promise<BotExecution[]> =>
    apiFetch<BotExecution[]>(`/bidding/executions?limit=${limit}`),
}

export const schedulesApi = {
  /** Загрузить список всех расписаний пользователя с сервера */
  list: (): Promise<ServerSchedule[]> =>
    apiFetch<ServerSchedule[]>('/schedules'),

  /** Создать новое расписание на сервере */
  create: (name: string, state: Record<string, unknown>): Promise<ServerSchedule> =>
    apiFetch<ServerSchedule>('/schedules', {
      method: 'POST',
      body: JSON.stringify({ name, schedule_json: state }),
    }),

  /** Обновить существующее расписание на сервере */
  update: (id: string, name: string, state: Record<string, unknown>): Promise<ServerSchedule> =>
    apiFetch<ServerSchedule>(`/schedules/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ name, schedule_json: state }),
    }),

  /** Удалить расписание на сервере */
  delete: (id: string): Promise<null> =>
    apiFetch<null>(`/schedules/${id}`, { method: 'DELETE' }),
}
