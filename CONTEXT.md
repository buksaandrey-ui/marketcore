# MarketCore — Контекст проекта

> Этот файл — единая точка правды о состоянии проекта.
> Обновлять после каждой значимой сессии разработки.
> Последнее обновление: 2026-04-28

---

## Стек

| Слой | Технология |
|---|---|
| Frontend | React + TypeScript + Vite, порт **5174** (зафиксирован в vite.config.ts) |
| Backend | FastAPI + Python 3.12, порт **8000** |
| БД | PostgreSQL (TimescaleDB) в Docker, порт 5432 |
| Кэш | Redis в Docker, порт 6379 |
| Деплой фронт | Vercel → `https://marketcore-nu.vercel.app` |
| Деплой бэкенд | Railway (настраивается) |
| Репозиторий | `https://github.com/buksaandrey-ui/marketcore.git` |

---

## Запуск локально

```bash
# 1. БД и Redis
docker compose up -d postgres redis

# 2. Бэкенд
cd backend
.venv/bin/uvicorn marketcore.api.main:app --host 127.0.0.1 --port 8000 --reload

# 3. Фронтенд
cd frontend
npm run dev   # → http://localhost:5174
```

---

## Переменные окружения бэкенда (production)

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
JWT_SECRET_KEY=<случайный hex>
ENCRYPTION_KEY=<32 символа>
ALLOWED_ORIGINS=https://marketcore-nu.vercel.app,http://localhost:5174
ENVIRONMENT=production
DEBUG=false
```

---

## Архитектура бэкенда

```
backend/marketcore/
├── api/
│   ├── main.py              — точка входа FastAPI, CORS, роутеры
│   └── routes/
│       ├── accounts.py      — CRUD аккаунтов WB/Ozon + синхронизация данных
│       ├── analytics.py     — дашборд, отчёт, тепловая карта, прогноз поставок
│       ├── auth.py          — login, register, logout, refresh
│       ├── benchmarks.py    — CPM/CPC ставки рынка
│       ├── bidding.py       — автобот ставок (правила)
│       ├── bidding_executions.py — история автобота
│       ├── campaigns.py     — управление РК WB (600+ строк)
│       └── schedules.py     — сохранённые расписания UI
├── ingestor/
│   ├── db.py                — запись данных в PostgreSQL
│   ├── wb_client.py         — клиент WB API (статистика, реклама, карточки)
│   └── ozon_client.py       — клиент Ozon API
├── models.py                — все SQLAlchemy модели
├── config.py                — настройки из env
└── accounts/
    ├── service.py           — бизнес-логика аккаунтов
    └── encryption.py        — шифрование API-ключей (AES)
```

---

## Модели БД (таблицы)

| Таблица | Назначение |
|---|---|
| `users` | Пользователи |
| `sessions` | JWT refresh-токены |
| `accounts` | Подключённые WB/Ozon аккаунты (зашифрованные API-ключи) |
| `schedules` | Сохранённые расписания ставок (JSON состояние UI) |
| `orders` | Заказы (price = **finishedPrice** — после скидки продавца + СПП) |
| `sku_stocks` | Остатки по складам |
| `sku_prices` | Цены и скидки по SKU |
| `ad_stats` | Рекламная статистика (spend, views, clicks по дням) |
| `sku_names` | Реальные названия товаров (из WB Advert API v3) + граммовка/объём |
| `bidding_rules` | Правила автобота ставок |
| `rule_executions` | Лог действий автобота |
| `campaign_auto_schedules` | Авторасписание показов (будни/выходные) |

---

## Фронтенд — страницы и компоненты

| Файл | Страница | Статус |
|---|---|---|
| `Dashboard.tsx` | Дашборд — KPI, выручка, ДРР, топ-SKU, тепловая карта | ✅ Готово |
| `ReportsPage.tsx` | Юнит-экономика — отчёт за период, по складам, по SKU | ✅ Готово |
| `SupplyForecast.tsx` | Поставки — прогноз ООС, критические/нормальные/перегруз | ✅ Готово |
| `WbCampaignManager.tsx` | Кампании WB — 5 вкладок (см. ниже) | ✅ Готово |
| `AccountsPage.tsx` | Аккаунты — подключение WB/Ozon, синхронизация | ✅ Готово |
| `BotHistoryPage.tsx` | История автобота | ✅ Готово |
| `UnitEcon.tsx` | Юнит-экономика демо | ✅ Готово |
| `BehaviorPage.tsx` | Поведенческая аналитика (демо) | ✅ Готово |
| `LoginPage.tsx` | Авторизация / регистрация | ✅ Готово |

### WbCampaignManager.tsx — 5 вкладок

| Вкладка | Функционал |
|---|---|
| **Статистика** | Таблица РК: показы, клики, расход, доход, ДРР + **ставки рынка (МИН/КОНК/ТОП)** |
| **Управление** | Пауза/запуск, смена CPM, переименование, пополнение бюджета |
| **Массовое создание** | Один товар → одна авто-кампания CPM, названия из `sku_names` + граммовка |
| **Расписание** | 7×24 интерактивная сетка, два пика, применить к N кампаниям |
| **По категории** | Создание кампаний по subject_id (устаревший режим) |

---

## API — ключевые эндпоинты

### Аккаунты `/accounts`
- `POST /accounts` — создать аккаунт (marketplace, name, seller_id, api_key, advert_api_key?)
- `GET /accounts` — список аккаунтов
- `DELETE /accounts/{id}` — удалить
- `POST /accounts/{id}/verify` — проверить ключ
- `POST /accounts/{id}/sync` — синхронизировать данные (заказы, остатки, цены, рекл. статистика)

### Аналитика `/analytics`
- `GET /analytics/dashboard?period=month` — KPI дашборда
- `GET /analytics/report?period=month&sku=...` — юнит-отчёт
- `GET /analytics/orders/heatmap?days=30` — тепловая карта заказов
- `GET /analytics/supply-forecast` — прогноз поставок

### Кампании `/campaigns`
- `GET /campaigns?account_id=` — список РК
- `GET /campaigns/stats?account_id=&days=7` — статистика + **cpm_min/cpm_competitive/cpm_top10**
- `GET /campaigns/sku-names?account_id=` — SKU с реальными названиями + граммовка
- `POST /campaigns/create-sku-pack` — массовое создание (1 товар = 1 кампания)
- `POST /campaigns/bulk-schedule` — массовое расписание (24 коэффициента)
- `POST /campaigns/{id}/pause` — пауза
- `POST /campaigns/{id}/resume` — запуск
- `POST /campaigns/{id}/set-cpm` — установить ставку
- `GET /campaigns/overall-drr?account_id=&days=30` — общий ДРР аккаунта
- `GET /campaigns/auto-schedules?account_id=` — авторасписания
- `POST /campaigns/auto-schedules` — создать авторасписание
- `PATCH /campaigns/auto-schedules/{id}/toggle` — вкл/выкл
- `DELETE /campaigns/auto-schedules/{id}` — удалить

---

## Формула выручки (важно!)

```
price в таблице orders = finishedPrice из WB API
                       = totalPrice × (1 - discountPercent/100) × (1 - spp/100)
```

**НЕ умножать на 0.88 или любой другой коэффициент** — это было убрано.
`orders_sum = SUM(price × quantity)` уже является корректной выручкой.

При синхронизации: старые записи удаляются за тот же период, вставляются свежие
(TimescaleDB не поддерживает `ON CONFLICT DO UPDATE` на гипертаблицах).

---

## Источники данных WB

| Что | Эндпоинт | Ключ |
|---|---|---|
| Заказы | `statistics-api.wildberries.ru/api/v1/supplier/orders` | Статистика |
| Остатки | `statistics-api.wildberries.ru/api/v1/supplier/stocks` | Статистика |
| Цены | `discounts-prices-api.wb.ru` | Статистика |
| Рекл. статистика | `advert-api.wildberries.ru/adv/v3/fullstats` | **Рекламный** |
| Список кампаний | `advert-api.wildberries.ru/adv/v1/promotion/count` | Рекламный |
| Имена кампаний | `advert-api.wildberries.ru/adv/v1/promotion/adverts` | Рекламный |
| Ставки рынка | `advert-api.wildberries.ru/adv/v0/cpm` | Рекламный |
| Карточка товара | `basket-XX.wbbasket.ru/vol{}/part{}/{}/info/ru/card.json` | Без ключа |
| WB услуги | `statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod` | Статистика |

### Формула basket URL:
```python
vol  = nm_id // 100000
part = nm_id // 1000
center = max(1, vol // 200)  # начальный номер корзины
# пробуем center, center+1, center-1, center+2, ...
url = f"https://basket-{basket:02d}.wbbasket.ru/vol{vol}/part{part}/{nm_id}/info/ru/card.json"
```

---

## Названия SKU — как формируются

1. `save_ad_stats_wb()` → парсит `nms[].name` из `/adv/v3/fullstats` → записывает в `sku_names`
2. `enrich_sku_names_with_params()` → для каждого SKU без граммовки → запрашивает basket CDN → добавляет к названию: `"Корневин, 250 г"`, `"Пароочиститель, 1 л"`

Приоритет характеристик: `["объём","объем","вес товара без упаковки","масса нетто","вес","объём продукта"]`
Единица берётся из скобок в названии поля: `"Объем (л)"` → `"л"`

---

## Ставки рынка CPM

`GET /adv/v0/cpm?type=8&param=0` → `{"cpm": N}` — минимум для авто-кампаний

| Уровень | Формула | Цвет в UI |
|---|---|---|
| МИН | `cpm` | серый |
| КОНК | `cpm × 3.5` | жёлтый |
| ТОП | `cpm × 5.5` | синий |

---

## Что НЕ сделано из ТЗ (следующие приоритеты)

| Модуль из ТЗ | Статус | Примечание |
|---|---|---|
| ILP Solver распределения поставок | ❌ Не реализован | Спека в `MarketCore_Deep_Dive.md` |
| Прогноз спроса (Prophet + LightGBM) | ❌ Не реализован | Сейчас простой OOS-калькулятор |
| Автобот ставок (реальное применение) | ⚠️ Частично | DSL есть, планировщик не запущен |
| Ценовой движок (Price-Matching) | ❌ Не реализован | — |
| Индекс локализации | ❌ Не реализован | — |
| Конкурентный парсер | ❌ Не реализован | — |
| Ozon кампании | ❌ Не реализован | Только WB |
| Уведомления (Telegram/Email) | ❌ Не реализован | — |
| Мультипользовательские права | ❌ Не реализован | — |

---

## Известные ограничения

- **TimescaleDB**: не поддерживает `ON CONFLICT DO UPDATE` на гипертаблицах → используем DELETE + INSERT
- **WB Content API** (`content-suppliers.wildberries.ru`) — DNS не резолвится → используем basket CDN
- **`products-by-subject`** → 502 (WB Content API) — некритично, используется только для CreateTab
- **Автобот** работает только в `dry_run` режиме (логирует, не применяет)
- **Выручка** в статистике кампаний берётся из `sum_price` WB Advert API — уже корректная

---

## Последние изменения (2026-04-28)

- ✅ Формула выручки: `totalPrice` → `finishedPrice` во всём приложении
- ✅ Убраны коэффициенты `×0.88` и `×0.05` из аналитики
- ✅ Синхронизация: DELETE + INSERT вместо ON CONFLICT DO UPDATE (TimescaleDB fix)
- ✅ Ставки рынка CPM (МИН/КОНК/ТОП) в таблице статистики кампаний
- ✅ Имена кампаний: `name_map` из `list_campaigns` — приоритет над именем из статистики
- ✅ `get_market_cpm(advert_type, param)` в WBClient
- ✅ Фронтенд: порт 5174 зафиксирован в `vite.config.ts` (`strictPort: true`)
- ✅ Массовое создание кампаний (1 SKU = 1 авто-кампания CPM)
- ✅ Расписание 7×24: интерактивная сетка с двумя пиками
- ✅ SKU names: реальные названия из WB Advert API + граммовка/объём из basket CDN
