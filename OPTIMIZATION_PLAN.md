# OPTIMIZATION_PLAN.md
> Создан: 2026-05-03 | Фаза 0 — Инвентаризация

---

## INVENTORY — Карта проекта

### UI ↔ API ↔ БД

| Компонент | Эндпоинты API | Таблицы БД | Примечания |
|---|---|---|---|
| `Dashboard.tsx` | `/analytics/dashboard`, `/analytics/payouts` | `orders`, `ad_stats`, `sku_names` | ❗ Также читает `demo.ts` (SKUS, buildCategories, globalDrr) |
| `UnitEcon.tsx` | — | — | ❗ 100% демо (только `demo.ts`, нет API-вызовов) |
| `BehaviorPage.tsx` | `/analytics/orders/heatmap` | `orders` | ❗ Fallback на `makeDemoMatrix()` с рандомными данными |
| `ReportsPage.tsx` | `/analytics/report`, `/analytics/payouts` | `orders`, `ad_stats`, `sku_stocks`, `sku_names` | ✅ Реальные данные |
| `SupplyForecast.tsx` | `/analytics/supply-forecast` | `sku_stocks`, `orders`, `sku_names` | ✅ Реальные данные |
| `WbCampaignManager.tsx` | `/campaigns/*`, `/strategies/*`, `/campaigns/auto-schedules` | `campaign_names`, `sku_names`, `ad_stats`, `campaign_strategies`, `bid_change_log` | 5 вкладок + стратегия |
| `ScheduleGrid.tsx` | `/schedules`, `/accounts` | `schedules` | ❗ Дублирует вкладку расписания в WbCampaignManager |
| `AccountsPage.tsx` | `/accounts`, `/accounts/{id}/sync`, `/accounts/{id}/verify` | `accounts` | ✅ |
| `BotHistoryPage.tsx` | `/bidding/executions` | `rule_executions` | ❗ Показывает старый биддинг (DSL-правила), не стратегии |

### Файлы бэкенда

| Файл | Строк | Статус |
|---|---|---|
| `api/routes/accounts.py` | 333 | sync_account монолит, 2 debug-эндпоинта |
| `api/routes/analytics.py` | 509 | нет response_model, DRR инлайн |
| `api/routes/campaigns.py` | 848 | большой, кэш есть но не TTL |
| `api/routes/strategies.py` | 466 | ✅ чистый |
| `strategy/models.py` | 173 | BID_MULTIPLIERS — единственный источник ✅ |
| `strategy/two_peaks/bid_calculator.py` | 102 | ✅ компактный |

---

## ISSUES — Найденные проблемы

### I-01: ДЕМО-ДАННЫЕ В ПРОДАКШН-КОМПОНЕНТАХ
**Файлы:** `Dashboard.tsx:1-460`, `UnitEcon.tsx`, `BehaviorPage.tsx`
**Проблема:** `Dashboard.tsx` импортирует `SKUS` из `demo.ts` и показывает фейковые SKU, категории, ДРР прямо рядом с реальными KPI-карточками. `UnitEcon.tsx` — 100% демо. `BehaviorPage.tsx` генерирует случайную тепловую матрицу как fallback.
**Риск:** Пользователь видит поддельные цифры в продакшне.

### I-02: ИМЕНОВАНИЕ ДРР НЕ СОВПАДАЕТ С ЭТАЛОННЫМ СЛОВАРЁМ
**Файлы:** `campaigns.py:462-463`, `api.ts:325-326`, `OverallDrrData`
**Проблема:** Эндпоинт `/campaigns/overall-drr` возвращает `drr_ad` и `drr_total` — не `drr_to_revenue`/`drr_to_orders`. TS-тип `OverallDrrData` использует `drr_ad | null` вместо канонических имён.
**Канон:** `drr_ad` → `drr_to_revenue`, `drr_total` → нужно уточнить (вероятно `drr_all_costs`).

### I-03: ПОЛЕ `buyout_sum` — ДУБЛИРУЕТ `orders_sum`
**Файлы:** `analytics.py:331`, `api.ts:229`
**Проблема:** В `/analytics/report` `buyout_sum = orders_sum` (строка 331). В TS-типе `SalesReport` оба поля одновременно. Значит два имени для одного значения.
**Канон:** оставить только `orders_sum`, убрать `buyout_sum`.

### I-04: ФОРМУЛА ДРР ДУБЛИРУЕТСЯ В 4+ МЕСТАХ
**Файлы:** `analytics.py:138`, `analytics.py:342-343`, `campaigns.py:342`, `campaigns.py:462-463`
**Проблема:** `ad_spend / orders_sum * 100` написано вручную в каждом эндпоинте. Нет единого модуля `formulas.py`.
**Канон:** вынести в `backend/marketcore/analytics/formulas.py`.

### I-05: `get_campaign_stats` ИГНОРИРУЕТ КЭШ ИМЁН
**Файл:** `campaigns.py:308`
**Проблема:** `/campaigns/stats` вызывает `client.list_campaigns()` (WB API) для получения имён и статусов вместо чтения из `campaign_names`. Это означает вызов WB API при каждом открытии вкладки статистики.
**Принцип:** Cache-first — читать из `campaign_names`, WB API только при `refresh=true` или пустом кэше.

### I-06: МОНОЛИТНЫЙ `sync_account` — 80+ СТРОК, НЕТ ИНКРЕМЕНТАЛЬНОСТИ
**Файл:** `accounts.py:68-158`
**Проблема:** Одна функция делает всё (заказы, остатки, цены, рекламу, имена). Период всегда `-30d` — не учитывает `last_sync_at`. Повторный sync перезагружает всё с нуля.
**Канон:** разбить на `_sync_*` функции, инкрементальность через `last_sync_at - 24h overlap`.

### I-07: ДВА ЭНДПОИНТА ДУБЛИРУЮТ СПИСОК КАМПАНИЙ
**Файлы:** `accounts.py:295-332` (`GET /accounts/{id}/campaigns`) и `campaigns.py:134-180` (`GET /campaigns?account_id=`)
**Проблема:** Оба возвращают список WB-кампаний. `/accounts/{id}/campaigns` всегда идёт в WB API (нет кэша), `campaigns.py` использует кэш. Фронтенд `api.ts:214` вызывает `/accounts/${id}/campaigns`.
**Решение:** Удалить дублирующий эндпоинт в accounts.py, фронтенд переключить на `/campaigns?account_id=`.

### I-08: НЕТ TTL ДЛЯ КЭШЕЙ `sku_names` И `campaign_names`
**Файлы:** `campaigns.py:120-130`, `accounts.py:128`
**Проблема:** Кэш читается без проверки свежести (`updated_at`). Если данные устарели на несколько дней — они всё равно отдаются. Нет политики TTL в одном месте.
**Канон:** TTL 24h для `sku_names`, 1h для `campaign_names`. Файл `cache/policies.py`.

### I-09: `strategiesApi.refreshNames()` — КНОПКА «ОБНОВИТЬ ИМЕНА» В ФРОНТЕНДЕ
**Файлы:** `api.ts:548`, `WbCampaignManager.tsx` (вкладка стратегий)
**Проблема:** Отдельная кнопка «Обновить имена кампаний» — это ручная операция которую должен делать фон. По принципу Фазы 2 — она должна исчезнуть.
**Решение:** Удалить кнопку, обновление фоном каждые 1h.

### I-10: `ScheduleGrid` — ОТДЕЛЬНАЯ СТРАНИЦА, ДУБЛИРУЮЩАЯ ВКЛАДКУ
**Файлы:** `App.tsx:18`, `ScheduleGrid.tsx`
**Проблема:** Страница «Ставки» (ScheduleGrid) — это тот же интерфейс расписания, который уже есть в `WbCampaignManager.tsx` вкладке «Расписание». Два входа к одному функционалу.
**Решение:** Убрать из nav, оставить только внутри WbCampaignManager.

### I-11: `UnitEcon` — ПОЛНОСТЬЮ ДЕМО-СТРАНИЦА В NAV
**Файлы:** `App.tsx:17`, `UnitEcon.tsx`
**Проблема:** Страница «Юнит-экономика» показывает только demo.ts данные, никакого реального API. Пользователь видит фейковые расчёты на Nike, Adidas.
**Решение:** Скрыть за флагом `?demo=1` или убрать из навигации до реализации реального функционала.

### I-12: `BotHistoryPage` — ПОКАЗЫВАЕТ УСТАРЕВШУЮ СИСТЕМУ БИДДИНГА
**Файлы:** `App.tsx:21`, `BotHistoryPage.tsx`, `bidding_executions.py`
**Проблема:** Страница «История бота» показывает `rule_executions` (старый DSL-биддинг), а не `bid_change_log` (новая стратегия «2 пика»). Пользователь видит пустую таблицу (DSL не работает).
**Решение:** Переключить на `bid_change_log` из стратегий, или объединить с вкладкой лога в WbCampaignManager.

### I-13: НАВИГАЦИЯ — 9 РАЗДЕЛОВ ВМЕСТО 7
**Файл:** `App.tsx:16-26`
**Проблема:** Текущие 9 разделов: dashboard, unit-econ, supply, bidding, schedule, bot-history, behavior, reports, accounts. Много дублей и устаревших вещей.
**Целевая структура (из промпта):** 7 разделов — Dashboard, Товары/остатки, Заказы/продажи, Реклама, Стратегии, Аккаунты, (Настройки).

### I-14: `analytics.py` СОЗДАЁТ `WBClient` НАПРЯМУЮ
**Файлы:** `analytics.py:181-199`, `analytics.py:386`
**Проблема:** `_fetch_payouts_90d` и `get_payouts` сами импортируют `WBClient` и `decrypt_api_key` и создают клиент. Это не через сервисный слой. Тот же паттерн дублируется в campaigns.py:452-456.
**Принцип:** Все WB/Ozon вызовы через `WBClient`/`OzonClient` — это уже выполнено, но создание клиента должно идти через единый хелпер.

### I-15: ОТСУТСТВУЮТ PYDANTIC `response_model` НА КЛЮЧЕВЫХ РОУТАХ
**Файлы:** `analytics.py` (все GET-эндпоинты), `campaigns.py` (`get_overall_drr`)
**Проблема:** `get_dashboard_summary`, `sales_report`, `get_payouts`, `get_supply_forecast`, `get_overall_drr` — все возвращают `dict` без response_model. Нет автодокументации, нет валидации ответа.

### I-16: `WbCampaignManager.tsx` — 1000+ СТРОК, ВСЕ ЦВЕТА ДРР ИНЛАЙН
**Файл:** `WbCampaignManager.tsx`
**Проблема:** Компонент огромный (5 вкладок + стратегия = ~1000+ строк). Логика цвета ДРР, вероятно, написана inline (`v < 10 ? green : ...`). Нет единого `getDrrColor()`.

### I-17: `campaigns.py:skus` ВЫЗЫВАЕТ WB API ДЛЯ ИМЁН
**Файл:** `campaigns.py:524-534`
**Проблема:** `list_skus` пытается получить названия через `client.get_nm_titles()` (WB Content API), игнорируя `sku_names` таблицу. Content API часто недоступен (известное ограничение).
**Канон:** Читать из `sku_names` (кэш), WB Content API — только как fallback.

### I-18: ФОНОВОЕ ОБНОВЛЕНИЕ КЭШЕЙ НЕ РЕАЛИЗОВАНО
**Файлы:** весь бэкенд
**Проблема:** Нет планировщика для автоматического обновления `sku_names` (раз в 24h), `campaign_names` (раз в 1h). Всё обновляется только при явном sync через UI.
**Канон:** FastAPI lifespan + asyncio background tasks.

---

## DECISIONS — Решения по каждому Issue

| Issue | Решение | Фаза |
|---|---|---|
| I-01 | Dashboard: убрать импорт demo.ts, оставить только реальный API. UnitEcon: скрыть из nav. BehaviorPage: убрать makeDemoMatrix, показывать EmptyState если нет данных | 5 |
| I-02 | Переименовать `drr_ad` → `drr_to_revenue`, `drr_total` → `drr_all_costs` в campaigns.py и api.ts. Добавить deprecated alias на 2 недели | 4 |
| I-03 | Убрать `buyout_sum` из response `/analytics/report`, оставить только `orders_sum`. В api.ts убрать поле `buyout_sum` из `SalesReport` | 4 |
| I-04 | Создать `backend/marketcore/analytics/formulas.py` с функциями drr(), real_drr(), buyer_paid(). Заменить все inline-вычисления на вызовы хелперов | 3 |
| I-05 | В `get_campaign_stats` загружать имена из `_load_cached_names` вместо `list_campaigns`. WB API вызывать только при `?refresh=true` | 1 |
| I-06 | Разбить `sync_account` на `_sync_orders`, `_sync_stocks`, etc. Инкрементальность через `last_sync_at - 24h`. Добавить `GET /accounts/{id}/sync-status` | 2 |
| I-07 | Удалить `GET /accounts/{id}/campaigns` из accounts.py. Перевести фронтенд на `campaignsApi.list()` | 2 |
| I-08 | Создать `backend/marketcore/cache/policies.py` с TTL-константами. Добавить проверку свежести кэша при чтении | 1 |
| I-09 | Убрать `strategiesApi.refreshNames()` из фронтенда. Удалить кнопку из UI. Обновление только фоном | 2+5 |
| I-10 | Удалить `schedule` из NAV в App.tsx. Пользователь попадает в расписание через WbCampaignManager | 5 |
| I-11 | Убрать `unit-econ` из NAV в App.tsx (или скрыть за `?demo=1`) | 5 |
| I-12 | BotHistoryPage переключить на `bid_change_log`. Или объединить с вкладкой «Лог» в стратегиях и убрать отдельную страницу | 5 |
| I-13 | Новая структура nav: 7 разделов. Объединить supply+reports → «Заказы и продажи» | 5 |
| I-14 | Вынести создание WBClient для payouts в `accounts/service.py` или хелпер | 3 |
| I-15 | Добавить Pydantic response_model для analytics и campaigns эндпоинтов | 4 |
| I-16 | Вынести `getDrrColor(v)` в утилиту. При рефакторинге WbCampaignManager разбить на под-компоненты | 5 |
| I-17 | `list_skus` читает имена из `sku_names` (кэш), WB Content API как fallback если кэш пуст | 1 |
| I-18 | FastAPI lifespan + asyncio background task. Обновлять sku_names каждые 24h, campaign_names каждые 1h для всех активных аккаунтов | 2 |

---

## STATUS — Прогресс по фазам

- [ ] Фаза 0: Инвентаризация ✅ (этот файл)
- [ ] Фаза 1: Слой данных и кэши
- [ ] Фаза 2: Синхронизация и автообновление
- [ ] Фаза 3: Бизнес-логика и формулы
- [ ] Фаза 4: API-контракт и стандартизация ключей
- [ ] Фаза 5: UI/UX, структура разделов, демо
- [ ] Фаза 6: Интеграционная проверка

---

*Stuck at: —*
