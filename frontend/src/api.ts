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

  /** Выйти — деактивирует сессию на сервере, очищает localStorage */
  logout: async (): Promise<void> => {
    const rt = localStorage.getItem('mc_refresh_token')
    if (rt) {
      await apiFetch<null>('/auth/logout', {
        method: 'POST',
        body: JSON.stringify({ refresh_token: rt }),
      }).catch(() => {})
    }
    localStorage.removeItem('mc_token')
    localStorage.removeItem('mc_refresh_token')
  },
}

let _refreshing: Promise<boolean> | null = null

async function tryRefreshToken(): Promise<boolean> {
  if (_refreshing) return _refreshing
  _refreshing = (async () => {
    const rt = localStorage.getItem('mc_refresh_token')
    if (!rt) return false
    try {
      const res = await fetch(BASE_URL + '/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: rt }),
      })
      if (!res.ok) return false
      const data: TokenPair = await res.json()
      localStorage.setItem('mc_token', data.access_token)
      localStorage.setItem('mc_refresh_token', data.refresh_token)
      return true
    } catch {
      return false
    } finally {
      _refreshing = null
    }
  })()
  return _refreshing
}

async function apiFetch<T>(path: string, options: RequestInit = {}, _retry = true): Promise<T> {
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
    if (res.status === 401 && _retry) {
      const refreshed = await tryRefreshToken()
      if (refreshed) return apiFetch<T>(path, options, false)
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
  top_skus?: { sku: string; name: string; orders_count: number; revenue: number }[]
}

export type SupplyForecastData = {
  has_data: boolean
  items: {
    sku: string
    name: string
    stock: number
    vel_7d: number
    vel_14d: number
    vel_30d: number
    days_oos: number | null
    status: 'critical' | 'soon' | 'ok' | 'overstock'
  }[]
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

export type PayoutsData = {
  has_data: boolean
  payout_sum: number
  period_from: string
  period_to: string
  note: string
}

export const analyticsApi = {
  dashboard: (params: { period: string; date_from?: string; date_to?: string } = { period: 'month' }): Promise<DashboardSummary> => {
    const q = new URLSearchParams({ period: params.period })
    if (params.date_from) q.set('date_from', params.date_from)
    if (params.date_to) q.set('date_to', params.date_to)
    return apiFetch<DashboardSummary>(`/analytics/dashboard?${q}`)
  },

  payouts: (params: { period: string; date_from?: string; date_to?: string } = { period: 'month' }): Promise<PayoutsData> => {
    const q = new URLSearchParams({ period: params.period })
    if (params.date_from) q.set('date_from', params.date_from)
    if (params.date_to) q.set('date_to', params.date_to)
    return apiFetch<PayoutsData>(`/analytics/payouts?${q}`)
  },

  supplyForecast: (): Promise<SupplyForecastData> =>
    apiFetch<SupplyForecastData>('/analytics/supply-forecast'),

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

export type SkuItem = {
  sku: string
  name: string | null
  price: number | null
  stock: number | null
}

export type OverallDrrData = {
  period_days: number
  ad_spend: number
  service_costs: number
  total_costs: number
  total_revenue: number
  drr_ad: number | null
  drr_total: number | null
  by_service: Record<string, number>
  services_error: string | null
}

export type ProductSubject = {
  subject_name: string
  subject_id: number
  products: { nm_id: number; name: string; vendor_code: string }[]
}

export type CategoryPackResult = {
  created_count: number
  error_count: number
  campaigns: { nm_id: number; advert_id: number; name: string }[]
  errors: { nm_id: number; step: string; error: string; advert_id?: number }[]
}

export const campaignsApi = {
  list: (accountId: string): Promise<WbCampaign[]> =>
    apiFetch<WbCampaign[]>(`/campaigns?account_id=${accountId}`),

  skus: (accountId: string): Promise<SkuItem[]> =>
    apiFetch<SkuItem[]>(`/campaigns/skus?account_id=${accountId}`),

  create: (body: { account_id: string; name: string; nm_ids: number[]; budget: number }): Promise<{ advert_id: number; name: string }> =>
    apiFetch(`/campaigns`, { method: 'POST', body: JSON.stringify(body) }),

  pause: (advertId: number, accountId: string): Promise<null> =>
    apiFetch<null>(`/campaigns/${advertId}/pause?account_id=${accountId}`, { method: 'POST' }),

  resume: (advertId: number, accountId: string): Promise<null> =>
    apiFetch<null>(`/campaigns/${advertId}/resume?account_id=${accountId}`, { method: 'POST' }),

  update: (advertId: number, accountId: string, body: { name?: string; budget_add?: number }): Promise<null> =>
    apiFetch<null>(`/campaigns/${advertId}?account_id=${accountId}`, { method: 'PUT', body: JSON.stringify(body) }),

  setCpm: (advertId: number, body: { account_id: string; cpm: number; advert_type?: number; param?: number }): Promise<null> =>
    apiFetch<null>(`/campaigns/${advertId}/set-cpm`, { method: 'POST', body: JSON.stringify(body) }),

  bulkSchedule: (accountId: string, advertIds: number[], hours: number[]): Promise<{ applied: number; total: number; details: Record<string, string> }> =>
    apiFetch(`/campaigns/bulk-schedule`, { method: 'POST', body: JSON.stringify({ account_id: accountId, advert_ids: advertIds, hours }) }),

  stats: (accountId: string, days = 7): Promise<CampaignStat[]> =>
    apiFetch<CampaignStat[]>(`/campaigns/stats?account_id=${accountId}&days=${days}`),

  overallDrr: (accountId: string, days = 30): Promise<OverallDrrData> =>
    apiFetch<OverallDrrData>(`/campaigns/overall-drr?account_id=${accountId}&days=${days}`),

  productsBySubject: (accountId: string): Promise<ProductSubject[]> =>
    apiFetch<ProductSubject[]>(`/campaigns/products-by-subject?account_id=${accountId}`),

  createCategoryPack: (body: {
    account_id: string
    nm_ids: number[]
    name_prefix: string
    budget: number
    cpm: number
    schedule_hours: number[]
  }): Promise<CategoryPackResult> =>
    apiFetch<CategoryPackResult>('/campaigns/create-category-pack', { method: 'POST', body: JSON.stringify(body) }),

  /** Список SKU с реальными названиями из таблицы sku_names */
  skuNames: (accountId: string): Promise<{ sku: string; name: string }[]> =>
    apiFetch<{ sku: string; name: string }[]>(`/campaigns/sku-names?account_id=${accountId}`),

  /** Создать одну авто-кампанию (CPM) на каждый выбранный SKU */
  createSkuPack: (body: {
    account_id: string
    nm_ids: number[]
    budget: number
    cpm: number
    schedule_hours: number[]
  }): Promise<CategoryPackResult> =>
    apiFetch<CategoryPackResult>('/campaigns/create-sku-pack', { method: 'POST', body: JSON.stringify(body) }),
}

export type AutoSchedule = {
  id: string
  name: string
  advert_ids: number[]
  weekday_hours: number[]
  weekend_hours: number[]
  is_active: boolean
  created_at: string
}

export const autoSchedulesApi = {
  list: (accountId: string): Promise<AutoSchedule[]> =>
    apiFetch<AutoSchedule[]>(`/campaigns/auto-schedules?account_id=${accountId}`),

  create: (body: {
    account_id: string
    name: string
    advert_ids: number[]
    weekday_hours: number[]
    weekend_hours: number[]
  }): Promise<AutoSchedule> =>
    apiFetch<AutoSchedule>('/campaigns/auto-schedules', { method: 'POST', body: JSON.stringify(body) }),

  toggle: (id: string): Promise<AutoSchedule> =>
    apiFetch<AutoSchedule>(`/campaigns/auto-schedules/${id}/toggle`, { method: 'PATCH' }),

  delete: (id: string): Promise<null> =>
    apiFetch<null>(`/campaigns/auto-schedules/${id}`, { method: 'DELETE' }),
}

/** Запоминает последний выбранный аккаунт между разделами */
export const accountPrefs = {
  get: (): string => localStorage.getItem('mc_last_account') ?? '',
  set: (id: string) => localStorage.setItem('mc_last_account', id),
}

export type CampaignStat = {
  advert_id: number
  name: string
  status: number | null
  type: number | null           // тип: 4=Каталог, 5=Карточка, 6=Поиск, 8=Авто, 9=Поиск+Кат.
  cpm_min: number | null        // рынок: минимальная ставка
  cpm_competitive: number | null // рынок: конкурентная ставка
  cpm_top10: number | null      // рынок: ставка для топ-10
  views: number
  clicks: number
  spend: number
  atbs: number
  orders: number
  shks: number
  revenue: number
  drr: number | null
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
