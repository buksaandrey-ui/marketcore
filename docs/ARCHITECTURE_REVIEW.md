# MarketCore — Обзор проекта для архитектурной ревизии

> **Документ подготовлен для:** внешнего эксперта, проводящего ревизию архитектуры, кода и инфраструктуры  
> **Дата:** Апрель 2026  
> **Статус проекта:** MVP в продакшене, активная разработка  
> **Конфиденциальность:** NDA

---

## 1. О продукте

### 1.1 Миссия

**MarketCore** — SaaS-платформа автоматизации продаж на Wildberries и Ozon. Целевая аудитория — продавцы (селлеры) на российских маркетплейсах. Платформа решает три ключевые боли:

1. **Непрозрачная экономика**: продавец не понимает, прибыльны ли его товары с учётом всех расходов (комиссия, логистика, хранение, реклама, возвраты)
2. **Ручное управление рекламой**: ставки меняются часто, вручную не успеть — теряются позиции и деньги
3. **Нехватка аналитики**: нет единого места, где видны заказы, остатки, выручка, ДРР по всем кабинетам сразу

### 1.2 Целевые сегменты

| Сегмент | Оборот/мес | Ключевая боль |
|---------|-----------|---------------|
| Starter | до 1 млн ₽ | Не понимает юнит-экономику, пропускает OOS (Out of Stock) |
| Growth | 1–10 млн ₽ | Не успевает управлять ставками, теряет позиции в выдаче |
| Pro | 10–50 млн ₽ | Много SKU, нужна централизация и командный доступ |
| Enterprise | 50+ млн ₽ | Кастомные интеграции, SLA, white-label |

### 1.3 Конкуренты-ориентиры

MPSTATS, MarketPapa, Eggheads, Seller24 — MarketCore позиционируется как более глубокая аналитическая платформа с упором на автоматизацию действий (не только дашборды).

---

## 2. Текущее состояние MVP

### 2.1 Что уже работает в продакшене

| Функциональность | Статус | Примечания |
|-----------------|--------|-----------|
| Регистрация и авторизация (JWT) | ✅ Работает | Access 15 мин / Refresh 30 дней |
| Подключение WB-кабинета (API-ключ) | ✅ Работает | Шифрование AES-256 |
| Подключение Ozon-кабинета (Client-ID + API-key) | ✅ Работает | |
| Синхронизация заказов WB | ✅ Работает | 30 дней истории |
| Синхронизация заказов Ozon | ✅ Работает | FBO + FBS (оба типа) |
| Синхронизация остатков | ✅ Работает | WB + Ozon |
| Синхронизация цен | ✅ Работает | WB + Ozon |
| Синхронизация рекламной статистики | ✅ Работает | WB + Ozon, 403 обрабатывается gracefully |
| Дашборд с KPI | ✅ Работает | Заказы, выручка, ДРР, топ SKU |
| Юнит-экономика | ✅ Работает | Одиночный SKU + группы + сцепки |
| Отчёт по продажам | ✅ Работает | Период / склад / артикул |
| Тепловая карта заказов | ✅ Работает | 7×24, московское время |
| Поставки (SupplyForecast) | 🔶 UI есть, бэкенд в разработке | |
| Почасовые ставки (ScheduleGrid) | 🔶 UI есть, бэкенд в разработке | |
| Автоматическое изменение ставок | 🔶 DSL + API есть, исполнение в разработке | |
| Индекс локализации (LI) | 🔶 Бэкенд есть, UI нет | |

### 2.2 Деплой

| Компонент | Платформа | URL |
|-----------|----------|-----|
| Backend (FastAPI) | Railway | `https://marketcore-production-3718.up.railway.app` |
| Frontend (React) | Vercel | `https://marketcore-nu.vercel.app` |
| PostgreSQL | Railway (managed) | Приватная сеть Railway |
| Redis | Не подключён в prod | Локально через docker-compose |

---

## 3. Архитектура

### 3.1 Технологический стек (фактический)

| Слой | Технология | Версия |
|------|-----------|--------|
| **Backend** | Python + FastAPI | Python 3.12, FastAPI 0.111+ |
| **ORM** | SQLAlchemy (async) | 2.0+ |
| **Миграции** | Alembic | — |
| **База данных** | PostgreSQL | 16 (Railway managed) |
| **Async HTTP** | httpx | — |
| **Шифрование** | cryptography (AES) | — |
| **Авторизация** | python-jose + bcrypt | JWT HS256 |
| **Конфигурация** | pydantic-settings | — |
| **Валидация правил** | jsonschema | JSON Schema Draft 7 |
| **Контейнеризация** | Docker | python:3.12-slim |
| **Frontend** | React + TypeScript | React 19, TS 6 |
| **Сборка** | Vite | 8.x |
| **Стили** | CSS Modules | Тёмная тема (dark mode) |

### 3.2 Целевой стек (по ТЗ, в разработке)

По замыслу архитектуры платформа должна включать:
- **TimescaleDB** — расширение PostgreSQL для временных рядов (в prod пока обычный PG из-за ограничений Railway)
- **ClickHouse** — OLAP-аналитика для агрегаций по миллиардам строк
- **Apache Kafka** — event-driven шина между микросервисами
- **Redis Cluster** — кэш + rate limiting
- **Celery / Temporal** — фоновые задачи и saga-паттерны
- **Kubernetes (EKS)** — оркестрация в production
- **OpenSearch** — поиск конкурентов по ключевым запросам
- **Prophet + LightGBM** — ML-ансамбль для прогноза спроса
- **OpenTelemetry + Grafana** — наблюдаемость

### 3.3 Схема взаимодействия (текущая)

```
Browser (Vercel)
      │
      │ HTTPS + JWT
      ▼
FastAPI (Railway)
      │
      ├─── PostgreSQL ──── accounts / orders / stocks / prices / ad_stats
      │
      ├─── WB API ──────── статистика, остатки, цены, реклама
      │    statistics-api.wildberries.ru
      │    discounts-prices-api.wb.ru
      │    advert-api.wildberries.ru
      │
      └─── Ozon API ─────── заказы (FBO+FBS), остатки, цены
           api-seller.ozon.ru
           performance.ozon.ru (реклама — в разработке)
```

### 3.4 Структура каталогов (бэкенд)

```
backend/
└── marketcore/
    ├── api/
    │   ├── main.py              # FastAPI app + CORS middleware
    │   ├── routes/
    │   │   ├── auth.py          # /auth/register, /login, /refresh
    │   │   ├── accounts.py      # /accounts + /sync endpoint
    │   │   ├── analytics.py     # /analytics/dashboard, /report, /heatmap, /localization
    │   │   ├── bidding.py       # /bidding/rules CRUD + validation
    │   │   ├── schedules.py     # /schedules CRUD
    │   │   └── benchmarks.py    # /benchmarks (ставки CPM/CPC)
    │   └── schemas/             # Pydantic request/response models
    ├── auth/
    │   ├── service.py           # JWT encode/decode, bcrypt
    │   └── dependencies.py      # get_current_user dependency
    ├── accounts/
    │   ├── service.py           # CRUD аккаунтов
    │   └── encryption.py        # AES-256 шифрование API-ключей
    ├── ingestor/
    │   ├── wb_client.py         # Wildberries API client
    │   ├── ozon_client.py       # Ozon API client (FBO + FBS)
    │   ├── db.py                # Bulk upsert функции
    │   ├── tasks.py             # Celery задачи (подготовлены)
    │   ├── rate_limiter.py      # Token bucket throttling
    │   └── circuit_breaker.py   # Fault tolerance pattern
    ├── analytics/
    │   ├── localization.py      # Индекс локализации (LI)
    │   └── districts.py         # Маппинг складов → федеральные округа
    ├── bidding/
    │   ├── dsl.py               # JSON DSL → правила биддинга
    │   └── bidding-rule.schema.json
    ├── models.py                # SQLAlchemy ORM модели
    ├── database.py              # AsyncSession factory
    ├── config.py                # Настройки через pydantic-settings
    └── celery_app.py            # Конфигурация Celery
```

### 3.5 Структура каталогов (фронтенд)

```
frontend/src/
├── api.ts                # Единый HTTP-клиент, авто-logout на 401
├── App.tsx               # Shell: навигация + роутинг по page state
├── data/
│   └── demo.ts           # Демо-данные (SKU, комиссии, buyout rates)
└── components/
    ├── LoginPage.tsx      # Авторизация и регистрация
    ├── Dashboard.tsx      # KPI-дашборд (реальные данные + demo fallback)
    ├── AccountsPage.tsx   # Управление маркетплейс-кабинетами
    ├── UnitEcon.tsx       # Юнит-экономика (single / category / bundle)
    ├── ReportsPage.tsx    # Отчёт по продажам с периодом + фильтрами
    ├── BehaviorPage.tsx   # Тепловая карта заказов 7×24
    ├── SupplyForecast.tsx # Прогноз поставок (UI)
    └── ScheduleGrid.tsx   # Управление почасовыми ставками (UI)
```

---

## 4. Модель данных

### 4.1 Таблицы PostgreSQL

#### `users`
| Поле | Тип | Описание |
|------|-----|---------|
| id | UUID PK | |
| email | VARCHAR(255) UNIQUE | |
| phone | VARCHAR(20) UNIQUE NULL | |
| hashed_password | VARCHAR(255) | bcrypt |
| is_active | BOOLEAN | Флаг блокировки |
| is_verified | BOOLEAN | Email-верификация (не реализована) |
| created_at / updated_at | TIMESTAMPTZ | |

#### `sessions`
| Поле | Тип | Описание |
|------|-----|---------|
| id | UUID PK | |
| user_id | UUID FK → users | |
| refresh_token | VARCHAR(512) UNIQUE | |
| is_active | BOOLEAN | |
| expires_at | TIMESTAMPTZ | |

#### `accounts`
| Поле | Тип | Описание |
|------|-----|---------|
| id | UUID PK | |
| user_id | UUID FK → users | Multi-tenant изоляция |
| marketplace | VARCHAR(10) | 'wb' или 'ozon' |
| name | VARCHAR(255) | Пользовательское название |
| seller_id | VARCHAR(255) | Client-ID для Ozon (пустая строка для WB) |
| api_key_cipher | BYTES | AES-256 зашифрованный API-ключ |
| status | VARCHAR(20) | 'pending' / 'active' / 'invalid' |
| last_sync_at | TIMESTAMPTZ NULL | |

#### `orders` (партиционирована по `ordered_at`)
| Поле | Тип | Описание |
|------|-----|---------|
| id | UUID | |
| account_id | UUID FK | |
| external_id | VARCHAR(255) | gNumber (WB) / posting_number (Ozon) |
| sku | VARCHAR(255) | nmId (WB) / sku (Ozon) |
| quantity | INTEGER | |
| price | FLOAT | Цена за единицу |
| status | VARCHAR(50) | Статус заказа |
| warehouse | VARCHAR(255) | Название склада |
| warehouse_district | VARCHAR(100) | Нормализованный ФО склада |
| customer_district | VARCHAR(100) | ФО покупателя |
| ordered_at | TIMESTAMPTZ | PK component |
| **PK** | (id, ordered_at) | Составной — для партиционирования |
| **UNIQUE** | (account_id, external_id, ordered_at) | Дедупликация при re-sync |

#### `sku_stocks` (партиционирована по `recorded_at`)
| Поле | Тип |
|------|-----|
| id | UUID |
| account_id | UUID FK |
| sku | VARCHAR(255) |
| warehouse | VARCHAR(255) |
| quantity | INTEGER |
| recorded_at | TIMESTAMPTZ |

#### `sku_prices` (партиционирована по `recorded_at`)
| Поле | Тип |
|------|-----|
| id | UUID |
| account_id | UUID FK |
| sku | VARCHAR(255) |
| price | FLOAT |
| discount_percent | INTEGER |
| recorded_at | TIMESTAMPTZ |

#### `ad_stats` (партиционирована по `stat_date`)
| Поле | Тип | Описание |
|------|-----|---------|
| id | UUID | |
| account_id | UUID FK | |
| campaign_id | VARCHAR(255) | ID рекламной кампании |
| sku | VARCHAR(255) NULL | |
| cpm | FLOAT | Ставка CPM |
| views | INTEGER | Показы |
| clicks | INTEGER | Клики |
| spend | FLOAT | Расходы в рублях |
| stat_date | TIMESTAMPTZ | |
| **UNIQUE** | (account_id, campaign_id, sku, stat_date) | |

#### `bidding_rules`
| Поле | Тип | Описание |
|------|-----|---------|
| id | UUID PK | |
| account_id | UUID FK | |
| rule_id | VARCHAR(64) | Уникальный slug правила |
| name | VARCHAR(120) | Человекочитаемое название |
| version | INTEGER | Версионирование |
| priority | INTEGER | Порядок применения (меньше = выше) |
| enabled | BOOLEAN | |
| dry_run | BOOLEAN | Режим симуляции без изменений |
| rule_json | JSONB | DSL-правило в формате JSON Schema |

#### `schedules`
| Поле | Тип | Описание |
|------|-----|---------|
| id | UUID PK | |
| user_id | UUID FK | |
| name | VARCHAR(255) | |
| schedule_json | JSONB | Полное состояние UI (7×24 почасовая сетка) |

### 4.2 Индексы (планируемые / отсутствующие)

> ⚠️ **Критично для ревизии:** В текущих миграциях отсутствуют индексы на `orders(account_id, ordered_at)`, `sku_stocks(account_id)`, `ad_stats(account_id, stat_date)`. При росте данных это станет узким местом.

---

## 5. API-эндпоинты

### 5.1 Auth `/auth`

| Метод | Путь | Описание |
|-------|------|---------|
| POST | `/auth/register` | Создать аккаунт (email + password) |
| POST | `/auth/login` | Получить access + refresh токены |
| POST | `/auth/refresh` | Обновить токены по refresh |

**Особенности:** Access-токен живёт 15 минут. При истечении фронтенд получает 401 и автоматически очищает localStorage, перенаправляя на login.

### 5.2 Accounts `/accounts`

| Метод | Путь | Описание |
|-------|------|---------|
| GET | `/accounts` | Список кабинетов пользователя |
| POST | `/accounts` | Подключить новый маркетплейс |
| DELETE | `/accounts/{id}` | Удалить кабинет |
| POST | `/accounts/{id}/verify` | Проверить валидность API-ключа |
| POST | `/accounts/{id}/sync` | Полная синхронизация данных |

**Sync-эндпоинт** за один вызов получает: заказы (30 дней), остатки, цены, рекламную статистику. Каждый тип данных независим — ошибка на одном не прерывает остальные.

### 5.3 Analytics `/analytics`

| Метод | Путь | Описание |
|-------|------|---------|
| GET | `/analytics/dashboard` | KPI: заказы, выручка, ДРР, топ SKU |
| GET | `/analytics/report` | P&L по периоду с разбивкой по складам |
| GET | `/analytics/orders/heatmap` | Матрица 7×24 заказов (московское время) |
| GET | `/analytics/localization` | Индекс локализации (LI) по аккаунту или SKU |
| POST | `/analytics/localization/refresh` | Пересчитать LI |

**Параметры report:** `period` (today/yesterday/week/month/quarter/custom), `date_from`, `date_to`, `sku`

**Вычисляемые метрики в report:**
- `buyout_sum` = `orders_sum × 0.88` (оценка: −12% возвраты)
- `wb_services` = `orders_sum × 0.05` (оценка: хранение + логистика)
- `amount_to_pay` = `buyout_sum − wb_services − ad_spend`
- `real_drr` = `ad_spend / buyout_sum × 100`

> ⚠️ **Важная оговорка:** Финансовые коэффициенты (0.88, 0.05) — статичные оценки. В будущем требуется интеграция с WB Financial API и Ozon Finance API для точных данных.

### 5.4 Bidding `/bidding`

| Метод | Путь | Описание |
|-------|------|---------|
| GET | `/bidding/rules` | Правила по аккаунту (сортировка по priority) |
| POST | `/bidding/rules` | Создать правило (с JSON Schema валидацией) |
| PUT | `/bidding/rules/{id}` | Обновить правило |
| DELETE | `/bidding/rules/{id}` | Удалить правило |
| POST | `/bidding/rules/validate` | Dry-run проверка без сохранения |

### 5.5 Benchmarks `/benchmarks`

| Метод | Путь | Описание |
|-------|------|---------|
| GET | `/benchmarks` | Реальные ставки CPM/CPC с маркетплейса |
| POST | `/benchmarks/preview` | Проверить ставки по ключу без сохранения аккаунта |

**Fallback:** Если API маркетплейса недоступен — возвращаются статичные значения с флагом `is_real: false`.

---

## 6. Безопасность

### 6.1 Авторизация

- **Токены:** JWT HS256, хранятся в localStorage (НЕ HttpOnly cookie)
- **Access:** 15 минут, **Refresh:** 30 дней (хранится в таблице `sessions`)
- **Ротация:** При вызове `/auth/refresh` старый refresh-токен инвалидируется

> ⚠️ **Потенциальная уязвимость:** localStorage подвержен XSS. Рекомендуется перевод на HttpOnly cookie + CSRF-токены.

### 6.2 Шифрование API-ключей

- API-ключи маркетплейсов хранятся зашифрованными в PostgreSQL
- Алгоритм: AES-256 (библиотека `cryptography`)
- Ключ шифрования: переменная окружения `ENCRYPTION_KEY`

> ⚠️ **Риск:** Если `ENCRYPTION_KEY` скомпрометирован — все API-ключи раскрыты. Рекомендуется envelope encryption через HashiCorp Vault или AWS KMS.

### 6.3 CORS

- Whitelist: переменная `ALLOWED_ORIGINS` (через запятую)
- В prod: `https://marketcore-nu.vercel.app`
- Все методы (`*`) и заголовки (`*`) разрешены

### 6.4 Изоляция данных (Multi-tenancy)

- Каждый запрос к данным фильтруется по `user_id` через `get_current_user`
- Нет Row-Level Security в PostgreSQL — защита только на уровне приложения

> ⚠️ **Риск:** При ошибке в коде возможна утечка данных между пользователями. Рекомендуется PostgreSQL RLS как второй рубеж.

---

## 7. Внешние интеграции

### 7.1 Wildberries API

| Базовый URL | Что используем |
|-------------|---------------|
| `statistics-api.wildberries.ru` | Заказы, остатки (30 дней) |
| `discounts-prices-api.wb.ru` | Цены и скидки |
| `advert-api.wildberries.ru` | Рекламная статистика, CPM/CPC ставки |

**Требуемые разрешения API-ключа:** Статистика, Цены и скидки, Реклама

**Обработка ошибок:** 403 на рекламной статистике = пишем 0, не падаем

### 7.2 Ozon API

| Базовый URL | Что используем |
|-------------|---------------|
| `api-seller.ozon.ru/v3/posting/fbo/list` | Заказы FBO (со склада Ozon) |
| `api-seller.ozon.ru/v3/posting/fbs/list` | Заказы FBS (со своего склада) |
| `api-seller.ozon.ru/v2/analytics/stock_on_warehouses` | Остатки |
| `api-seller.ozon.ru/v5/product/info/prices` | Цены |
| `api-seller.ozon.ru/statistics/campaign/product/day` | Рекламная статистика |
| `performance.ozon.ru/api/client/campaign/cpm` | CPM ставки |

**Требуемые разрешения:** Чтение заказов, Аналитика, Цены

> ⚠️ **Известное ограничение:** Ozon Performance API (реклама) использует отдельные OAuth-credentials, которые отличаются от Seller API-ключа. Текущая реализация использует один ключ для обоих — это работает только если ключ имеет расширенные права.

### 7.3 Паттерны работы с API маркетплейсов

- **Rate Limiter:** `rate_limiter.py` — token bucket алгоритм (подготовлен, не применяется в sync)
- **Circuit Breaker:** `circuit_breaker.py` — fault tolerance (подготовлен, не применяется в sync)
- **Таймаут:** httpx timeout 30 сек для заказов/остатков, 60 сек для рекламной статистики
- **Пагинация:** Текущий лимит 1000 записей на запрос. При >1000 данные усекаются без предупреждения

> ⚠️ **Критичная проблема:** Отсутствует пагинация — продавцы с >1000 заказами за 30 дней получат неполные данные.

---

## 8. Фронтенд

### 8.1 Архитектурные решения

- **SPA** на React 19 + TypeScript, без роутера (управление страницами через `useState`)
- **Без state-менеджера** (Redux/Zustand) — состояние живёт локально в компонентах
- **Без React Query / SWR** — fetch запросы делаются вручную в `useEffect`
- **Тёмная тема** — единственная, переключения нет
- **Демо-режим** — все страницы показывают демо-данные если нет реального аккаунта

### 8.2 HTTP-клиент (`api.ts`)

- Единый `apiFetch` — добавляет Authorization заголовок из localStorage
- При 401 → очищает токены → `window.location.reload()` → страница входа
- Типизированные функции для каждого ресурса: `authApi`, `accountsApi`, `analyticsApi`, `schedulesApi`, `benchmarksApi`

### 8.3 Страницы

| Компонент | Описание |
|-----------|---------|
| `LoginPage` | Форма входа + регистрации, переключение между ними |
| `Dashboard` | KPI-карточки + топ SKU. Показывает реальные данные или demo-banner |
| `AccountsPage` | CRUD маркетплейс-кабинетов + кнопка синхронизации |
| `UnitEcon` | Калькулятор юнит-экономики. 3 режима: один SKU, по категории, сцепка |
| `ReportsPage` | Отчёт по продажам: период, фильтр по SKU, KPI-карточки, таблицы складов |
| `BehaviorPage` | Тепловая карта заказов 7×24 с легендой и инсайтами |
| `SupplyForecast` | Прогноз поставок (UI завершён, ML-бэкенд в разработке) |
| `ScheduleGrid` | Управление почасовыми ставками (сохранение в БД работает) |

---

## 9. Инфраструктура и деплой

### 9.1 Текущий prod (Railway + Vercel)

**Backend (Railway):**
```
railway.toml:
  build: Dockerfile
  healthcheckPath: /health
  healthcheckTimeout: 60
  restartPolicy: ON_FAILURE (max 3 retries)

Dockerfile:
  FROM python:3.12-slim
  RUN apt-get install gcc libpq-dev   # для asyncpg + cryptography
  COPY requirements-prod.txt
  RUN pip install -r requirements-prod.txt
  CMD: alembic upgrade head && uvicorn marketcore.api.main:app --port $PORT
```

**Переменные окружения в Railway:**
| Переменная | Примечание |
|-----------|-----------|
| `DATABASE_URL` | Ссылка на Railway Postgres |
| `JWT_SECRET_KEY` | Произвольная случайная строка |
| `ENCRYPTION_KEY` | 32 байта для AES |
| `ALLOWED_ORIGINS` | `https://marketcore-nu.vercel.app` |

**Frontend (Vercel):**
- Root Directory: `frontend`
- Build Command: `npm run build`
- `VITE_API_URL`: URL Railway бэкенда

### 9.2 Локальная разработка (docker-compose)

```yaml
services:
  postgres: TimescaleDB pg16 :5432
  redis:    Alpine 7         :6379
  kafka:    Confluent 7.5    :9092 (для будущей event-шины)
  zookeeper для kafka
  clickhouse: 23.8           :8123 (для будущей OLAP-аналитики)
```

> ⚠️ **Расхождение prod/dev:** В dev используется TimescaleDB (расширение для временных рядов), в prod — обычный PostgreSQL. Миграция удаляла вызовы `create_hypertable()` — при переходе на TimescaleDB в prod нужно пересоздавать таблицы.

### 9.3 Целевая инфраструктура (по ТЗ, не реализована)

В папке `/infra` подготовлены заготовки:
- `infra/k8s/production/` и `infra/k8s/staging/` — Kubernetes манифесты
- `infra/terraform/` — IaC для облачной инфраструктуры

---

## 10. Тестирование

### 10.1 Текущее состояние

В папке `backend/tests/` есть структура:
```
tests/
├── accounts/
├── auth/
└── bidding/
```

> ⚠️ **Критично:** Неизвестно наполнение тестов (требует проверки). В зависимостях есть `pytest`, `pytest-asyncio`, `respx` (HTTP мocking). Тесты не запускаются в CI.

### 10.2 Нет CI/CD пайплайна

Деплой происходит автоматически через Railway/Vercel при пуше в `main`. GitHub Actions не настроен — нет прогона тестов и линтера перед деплоем.

---

## 11. Известные технические долги и риски

### 🔴 Критично

1. **Нет пагинации** при загрузке заказов — продавцы с большим объёмом получат неполные данные
2. **Нет CI/CD** — тесты не запускаются автоматически, деплой не блокируется при ошибках
3. **JWT в localStorage** — уязвимость к XSS
4. **Нет RLS в PostgreSQL** — единственный рубеж защиты от межпользовательской утечки — код приложения

### 🟡 Важно

5. **Расхождение dev/prod БД** — TimescaleDB vs обычный PostgreSQL
6. **Rate limiter и circuit breaker не применяются** в sync — при перегрузке API маркетплейсов нет защиты
7. **Финансовые коэффициенты статичны** (0.88 выкуп, 0.05 услуги WB) — требуется реальный Financial API
8. **Sync — синхронный, блокирующий** — для больших объёмов нужен background task (Celery)
9. **Нет индексов** на часто запрашиваемых полях (account_id, ordered_at, stat_date)
10. **ENCRYPTION_KEY без envelope encryption** — единая точка компрометации всех API-ключей

### 🟢 Улучшения

11. Нет refresh-token rotation — refresh можно использовать многократно
12. Нет email-верификации (поле `is_verified` есть, логика не реализована)
13. Нет rate limiting на API-эндпоинты (защита от brute-force)
14. Нет логирования запросов и ошибок в структурированный лог
15. Нет метрик (Prometheus/Grafana) — невозможно мониторить производительность

---

## 12. Модули в разработке

### 12.1 Hourly Bidding (автоматические ставки)

**Задача:** Автоматически изменять ставки CPM/CPC в рекламных кампаниях по расписанию (7 дней × 24 часа) или по условиям (если CTR упал > 20% — снизить ставку).

**Текущее состояние:**
- `bidding_rules` таблица — готова
- DSL (JSON Schema для описания правил) — готов (`bidding/dsl.py`)
- API CRUD для правил — готов
- UI сетки 7×24 — готов (ScheduleGrid)
- **Исполнитель правил — не реализован** (нет Celery worker, нет вызова WB/Ozon change-bid API)

### 12.2 Supply Forecast (прогноз поставок)

**Задача:** Предсказать через сколько дней закончится товар на каждом складе с учётом текущего остатка и исторической скорости продаж. ML-модель (Prophet + LightGBM).

**Текущее состояние:**
- UI — готов
- ML-бэкенд — не реализован (стаб в `/economics`, `/forecasting`)
- Нет endpoint `/supply/forecast`

### 12.3 Индекс локализации (LI)

**Задача:** Измерить насколько товар "разлокализован" — продаётся с ближних складов или везётся издалека. Влияет на позицию в выдаче WB.

**Текущее состояние:**
- Алгоритм реализован (`analytics/localization.py`)
- Endpoint `/analytics/localization` — готов
- UI — **отсутствует**

---

## 13. Дорожная карта (по ТЗ)

| Этап | Функциональность | Статус |
|------|-----------------|--------|
| **MVP (завершён)** | Auth, аккаунты, синхронизация, дашборд, юнит-экономика, отчёты, тепловая карта | ✅ |
| **Этап 2** | Почасовые ставки (исполнитель), прогноз поставок (ML), LI в UI | 🔶 В работе |
| **Этап 3** | Мониторинг позиций, парсинг конкурентов, динамическое ценообразование | 📋 Запланировано |
| **Этап 4** | Командный доступ, роли, командная аналитика | 📋 Запланировано |
| **Этап 5** | White-label, API для ERP-интеграций, Kubernetes prod | 📋 Запланировано |

---

## 14. Вопросы для обсуждения с экспертом

1. **Архитектура sync:** Сейчас синхронизация синхронная и инициируется вручную. Правильная ли это стратегия на данном этапе? Когда переходить на фоновые задачи (Celery)?

2. **Монолит vs сервисы:** Сейчас всё в одном FastAPI приложении. Стоит ли уже выделять ingestor в отдельный сервис?

3. **PostgreSQL vs TimescaleDB:** Планируется использовать TimescaleDB для временных рядов. Насколько это оправдано с учётом объёмов (100–10000 SKU у продавца)?

4. **JWT в localStorage:** Насколько это критично на стадии MVP? Стоит ли уже переходить на httpOnly cookies?

5. **Индексы и производительность:** Нет составных индексов на time-series таблицах. При каком объёме данных это станет критично?

6. **Финансовые расчёты:** Коэффициенты (0.88 выкупа, 0.05 услуги) — статичные. Какой приоритет у интеграции с WB Financial API?

7. **Тестовое покрытие:** Что минимально необходимо для безопасного деплоя в prod?

8. **Secrets management:** ENCRYPTION_KEY в env var — достаточно ли это для MVP или нужен Vault/KMS прямо сейчас?

---

## 15. Как запустить локально

```bash
# 1. Поднять инфраструктуру
docker-compose up -d

# 2. Установить зависимости бэкенда
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements-prod.txt  # или: pip install -e ".[dev]"

# 3. Применить миграции
DATABASE_URL=postgresql+asyncpg://marketcore:devpassword@localhost:5432/marketcore_dev \
alembic upgrade head

# 4. Запустить бэкенд
uvicorn marketcore.api.main:app --reload --port 8100

# 5. Запустить фронтенд
cd ../frontend
npm install
npm run dev   # http://localhost:5173
```

**Переменные для локальной разработки (.env в папке backend):**
```env
DATABASE_URL=postgresql+asyncpg://marketcore:devpassword@localhost:5432/marketcore_dev
REDIS_URL=redis://localhost:6379/0
JWT_SECRET_KEY=local-dev-secret-key
ENCRYPTION_KEY=local-dev-32-bytes-key-________
ALLOWED_ORIGINS=http://localhost:5173
```

---

*Документ актуален по состоянию на апрель 2026. По вопросам обращаться к владельцу продукта.*
