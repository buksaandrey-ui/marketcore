# MarketCore × Claude Code
## Полный гайд: как построить продукт с Claude Code как центром разработки

> **Для кого:** Solo-разработчик или Tech Lead команды до 5 человек, который хочет строить
> MarketCore не «с AI-помощью», а **с AI как основным инженером**.
> **Результат:** рабочий продукт за 9 месяцев вместо 18, без архитектурного хаоса.

---

## 📑 Оглавление

1. [Ментальная модель: как думать о Claude Code](#1-ментальная-модель)
2. [Установка и первоначальная настройка](#2-установка-и-настройка)
3. [Структура репозитория под Claude Code](#3-структура-репозитория)
4. [CLAUDE.md — мозг проекта](#4-claudemd--мозг-проекта)
5. [Рабочий процесс: цикл разработки фичи](#5-рабочий-процесс)
6. [Параллельные агенты: как разрабатывать несколько модулей одновременно](#6-параллельные-агенты)
7. [MCP-серверы для MarketCore](#7-mcp-серверы)
8. [Hooks: автоматическое качество кода](#8-hooks)
9. [Кастомные команды (Custom Commands)](#9-кастомные-команды)
10. [Пошаговый план по модулям (9 месяцев)](#10-пошаговый-план-по-модулям)
11. [Управление контекстом на большом проекте](#11-управление-контекстом)
12. [CI/CD с Claude Code](#12-cicd-с-claude-code)
13. [Типичные ошибки и как их избежать](#13-типичные-ошибки)

---

## 1. Ментальная модель

### 1.1. Claude Code — не автодополнение, а инженер

Большинство разработчиков используют AI-инструменты как «умный Ctrl+Space»: написал половину функции — AI дописал. Claude Code — другая парадигма.

```
❌ Старая модель:
   Ты пишешь код → AI помогает

✓ Новая модель с Claude Code:
   Ты описываешь задачу + задаёшь критерии → Claude исследует кодовую базу
   → Claude планирует → Claude реализует → Claude верифицирует → Ты ревьюишь
```

Это сдвигает твою роль: **от разработчика к техническому директору**. Ты принимаешь архитектурные решения, ставишь задачи, ревьюишь PR. Claude пишет, тестирует, рефакторит.

### 1.2. Главное ограничение: контекстное окно

Понять это — значит на 80% освоить Claude Code.

```
Context window = вся твоя беседа + каждый прочитанный файл + вывод каждой команды

0────────────────────────────────────────────────── 200K токенов
│                    │           │         │
│                    │           │         └── 90%+ → хаотичные ответы
│                    │           └──────────── 70%+ → /compact обязательно
│                    └────────────────────────── 50%  → повышенное внимание
└──────────────────────────────────────────────────── 0%  = начало сессии
```

Управление контекстом — это не технический нюанс, это **основной скилл** работы с Claude Code.

### 1.3. Три режима работы

| Режим | Когда | Как активировать |
|---|---|---|
| **Plan Mode** | Исследование архитектуры, планирование фичи | `Ctrl+Shift+P` или кнопка в UI |
| **Normal Mode** | Реализация, отладка | По умолчанию |
| **Auto Mode** | Длительные задачи без надзора (тесты, рефакторинг) | `claude --auto` или в настройках |

---

## 2. Установка и настройка

### 2.1. Установка Claude Code

```bash
# macOS / Linux / WSL (рекомендуемый метод)
curl -fsSL https://claude.ai/install.sh | bash

# Windows PowerShell
irm https://claude.ai/install.ps1 | iex

# Проверка установки
claude --version
```

> Нативная установка обновляется автоматически в фоне — это важно,
> так как Claude Code активно развивается.

### 2.2. Требования к подписке

Для MarketCore нужен план **Claude Max** — он даёт максимальные лимиты на токены и позволяет параллельные сессии. При команде 2-5 человек — **Claude Team** с совместным использованием.

### 2.3. Начальная конфигурация `~/.claude/settings.json`

```json
{
  "model": "claude-opus-4",
  "permissions": {
    "allow": [
      "Bash(git:*)",
      "Bash(python:*)",
      "Bash(pytest:*)",
      "Bash(ruff:*)",
      "Bash(mypy:*)",
      "Bash(docker:*)",
      "Bash(make:*)",
      "Read(*)",
      "Write(*)"
    ],
    "deny": [
      "Bash(rm -rf /*)",
      "Bash(curl * | bash)"
    ]
  },
  "env": {
    "PYTHONDONTWRITEBYTECODE": "1"
  }
}
```

### 2.4. Установка расширений IDE

**VS Code / Cursor** (рекомендуется):
```
Cmd+Shift+X → поиск "Claude Code" → Install
Cmd+Shift+P → "Claude Code: Open in New Tab"
```

**Зачем?** Расширение добавляет:
- Inline diff прямо в редакторе (видишь изменения до применения)
- @-упоминания файлов из дерева проекта
- Предпросмотр плана перед выполнением
- Параллельные сессии в разных панелях

---

## 3. Структура репозитория под Claude Code

Claude Code работает значительно лучше, если структура проекта предсказуема и документирована. Создаём репозиторий сразу правильно.

### 3.1. Инициализация

```bash
mkdir marketcore && cd marketcore
git init

# Создаём структуру
mkdir -p backend/marketcore/{api,bidding,economics,forecasting,parser,pricing,ranking,solvers,supply,analytics,tests}
mkdir -p frontend/{app,components,lib,public}
mkdir -p schemas sql/migrations infra/{terraform,k8s} .claude/{commands,rules}
mkdir -p docs

# Первый коммит — структура
git add .
git commit -m "chore: init project structure"
```

### 3.2. Расположение `.claude/` директории

```
marketcore/
├── CLAUDE.md                    ← главный файл инструкций (в git)
├── CLAUDE.local.md              ← твои личные настройки (.gitignore)
├── .claude/
│   ├── commands/                ← кастомные slash-команды
│   │   ├── new-module.md
│   │   ├── run-tests.md
│   │   ├── review-pr.md
│   │   └── deploy-stage.md
│   └── rules/                   ← правила для конкретных путей
│       ├── python.md            ← для *.py файлов
│       ├── frontend.md          ← для frontend/**
│       └── tests.md             ← для tests/**
├── backend/
├── frontend/
└── ...
```

---

## 4. CLAUDE.md — мозг проекта

Это самый важный файл. Claude читает его в начале каждой сессии. Думай о нём как о **онбординг-документе для нового инженера** — только этот инженер всегда новый (нет памяти между сессиями без CLAUDE.md).

### 4.1. Структура CLAUDE.md

```markdown
# MarketCore: Intelligence & Control — Developer Guide

## ОБЯЗАТЕЛЬНО ПРОЧИТАЙ ПЕРЕД ЛЮБОЙ ЗАДАЧЕЙ
Это SaaS-платформа автоматизации Wildberries и Ozon.
Архитектурное ТЗ: docs/MarketCore_TZ.md
Технический deep-dive: docs/MarketCore_Deep_Dive.md

---

## Быстрый старт

### Запуск окружения
```bash
make dev          # запуск всех сервисов через docker-compose
make test         # pytest с покрытием
make lint         # ruff + mypy
make migrate      # alembic upgrade head
```

### Стек
- Backend: Python 3.12 + FastAPI + asyncpg
- ML: Prophet + LightGBM + ortools
- DB: PostgreSQL 16 + TimescaleDB + ClickHouse
- Queue: Kafka + Celery
- Frontend: Next.js 14 + TypeScript + Tailwind

---

## Архитектурные принципы (НЕ НАРУШАТЬ)

1. **Async-first**: все I/O операции через async/await, никаких синхронных блокирующих вызовов
2. **Idempotency**: все внешние вызовы (WB/Ozon API) идут с Idempotency-Key
3. **Guardrails**: любое автоматическое действие имеет min/max guardrail
4. **Fail-safe**: ошибки логируются, НЕ замалчиваются; Circuit Breaker на внешних API
5. **Explainable**: каждое автодействие должно содержать human-readable reason

---

## Структура модулей

- `marketcore/api/` — FastAPI routers, каждый bounded context = отдельный router
- `marketcore/bidding/` — DSL правил, scheduler, executor
- `marketcore/economics/` — unit-экономика, калькулятор
- `marketcore/forecasting/` — Prophet + LightGBM ансамбль
- `marketcore/parser/` — stealth-парсер конкурентов
- `marketcore/pricing/` — decision engine
- `marketcore/ranking/` — модель факторов ранжирования
- `marketcore/solvers/` — ILP для распределения поставок
- `marketcore/supply/` — OOS калькулятор
- `marketcore/analytics/` — индекс локализации, воронка

---

## Кодовые стандарты

### Python
- Типизация обязательна везде (`mypy --strict` должен проходить)
- Dataclass > dict для structured data
- Pydantic v2 для API схем, dataclasses для внутренних моделей
- Названия: snake_case для переменных/функций, PascalCase для классов
- Docstring: Google-style для публичных методов
- Исключения: всегда конкретные (ValueError, не Exception)

### Тесты
- Каждый новый модуль = тесты в `tests/<module_name>/`
- Минимум 80% покрытие на критических path
- Fixtures в `tests/conftest.py` — переиспользуй, не дублируй
- Unit-тесты без I/O — мокать asyncpg и внешние API через pytest-mock
- Именование: `test_<что_тестируем>_<условие>_<ожидаемый_результат>`

### Коммиты (Conventional Commits)
- `feat:` — новая фича
- `fix:` — баг-фикс
- `test:` — только тесты
- `refactor:` — рефакторинг без изменения поведения
- `docs:` — документация
- `chore:` — инфраструктура, зависимости

---

## База данных

- Миграции через Alembic: `alembic revision --autogenerate -m "описание"`
- Никогда не изменяй существующую миграцию — только новая поверх
- TimescaleDB: все time-series таблицы через `create_hypertable()`
- Индексы: всегда добавляй `idx_` префикс

---

## Внешние API

- WB API: базовый URL `https://suppliers-api.wildberries.ru`
- Ozon Seller API: базовый URL `https://api-seller.ozon.ru`
- Rate-limiting реализован в `marketcore/integrations/rate_limiter.py`
- Все токены через Vault — НЕ хардкодить в коде и конфигах

---

## Что НЕ ДЕЛАТЬ

- НЕ использовать `requests` (только `httpx` async)
- НЕ писать SQL строками (только SQLAlchemy ORM или именованные параметры)
- НЕ коммитить `.env` файлы, токены, пароли
- НЕ игнорировать mypy ошибки через `# type: ignore` без объяснения
- НЕ создавать God-классы (один класс = одна ответственность)
- НЕ писать комментарии «что делает код» — пиши «почему»
```

### 4.2. Path-scoped rules (`.claude/rules/`)

```markdown
<!-- .claude/rules/python.md — применяется ко всем *.py файлам -->

## Python Rules

Применяй при работе с любыми .py файлами:

1. Запускай `ruff check --fix` после каждого изменения файла
2. Запускай `mypy --strict <file>` чтобы убедиться в типах
3. Если добавляешь новую зависимость — добавь её в pyproject.toml
4. Prefer composition over inheritance
5. Async functions должны называться с глаголом: `get_`, `create_`, `update_`, `delete_`
```

```markdown
<!-- .claude/rules/tests.md — применяется к tests/** -->

## Test Rules

1. После написания теста — ОБЯЗАТЕЛЬНО запусти его: `pytest <path_to_test> -v`
2. Если тест упал — исправь реализацию, а не тест (если тест корректен)
3. Используй parametrize для похожих тест-кейсов
4. Тесты должны быть независимыми (не зависеть от порядка выполнения)
5. Мок внешних сервисов через `respx` (для httpx), `pytest-mock` для внутренних
```

---

## 5. Рабочий процесс

### 5.1. Четырёхфазный цикл (обязательный для каждой фичи)

```
┌─────────────────────────────────────────────────────────────────┐
│                    ЦИКЛ РАЗРАБОТКИ ФИЧИ                          │
├──────────┬──────────┬──────────────┬─────────────────────────────┤
│  PHASE 1 │  PHASE 2 │   PHASE 3    │         PHASE 4             │
│ EXPLORE  │  PLAN    │  IMPLEMENT   │      COMMIT + PR            │
│(Plan Mode│(Plan Mode│(Normal Mode) │    (Normal Mode)            │
├──────────┴──────────┴──────────────┴─────────────────────────────┤
```

**Фаза 1: Исследование (Plan Mode)**

```
# Включаем Plan Mode — Claude только читает, не изменяет
> Прочитай docs/MarketCore_Deep_Dive.md секцию про OOS Calculator.
  Затем посмотри на существующую структуру marketcore/supply/ и
  marketcore/forecasting/. Какие зависимости есть между модулями?
  Что уже реализовано, что нужно добавить?
```

**Фаза 2: Планирование (Plan Mode)**

```
> Мне нужно реализовать HTTP endpoint POST /supply/optimize который:
  1. Принимает sku_id и total_supply
  2. Использует OOSCalculator из marketcore/supply/oos_calculator.py
  3. Вызывает SupplyDistributionSolver из marketcore/solvers/supply_distribution.py
  4. Возвращает полный SupplyPlan с разбивкой по складам

  Создай детальный план реализации:
  - какие файлы создать/изменить
  - порядок реализации
  - какие тесты нужны
  - возможные проблемы
```

**Фаза 3: Реализация (Normal Mode)**

```
> Реализуй по плану. Начни с:
  1. Pydantic-схемы запроса/ответа в marketcore/api/schemas/supply.py
  2. Router в marketcore/api/routes/supply.py
  3. Юнит-тесты в tests/api/test_supply_optimize.py

  После каждого шага запускай pytest tests/api/ и ruff check.
  Если тест упал — разберись с причиной, не пропускай.
```

**Фаза 4: Коммит (Normal Mode)**

```
> Все тесты зелёные, mypy чистый. Сделай git commit с
  Conventional Commits форматом. Затем создай PR с описанием:
  - что реализовано
  - как протестировать
  - что не входит в этот PR (scope creep)
```

### 5.2. Debugging workflow

```
> У меня падает тест tests/solvers/test_supply_distribution.py::test_localization_constraint_is_enforced
  Вот traceback:
  [вставляешь traceback]

  Сначала воспроизведи ошибку, запустив тест.
  Исследуй SupplyDistributionSolver._build_variable_index() и constraint №4.
  Найди root cause и исправь — НЕ меняй тест, если он логически корректен.
  После фикса запусти весь suite: pytest tests/solvers/ -v
```

### 5.3. Refactoring workflow

```
> Прочитай marketcore/bidding/dsl.py.
  В Plan Mode оцени: что можно улучшить в структуре?
  Особенно интересует: можно ли упростить RuleExecutor._apply_action()?

  Затем предложи план рефакторинга. Я дам добро — и тогда реализуй.
  Тесты должны остаться зелёными после рефакторинга.
```

---

## 6. Параллельные агенты

Это главный козырь Claude Code для команды из одного человека — ты запускаешь несколько сессий параллельно на разных задачах.

### 6.1. Git worktrees — основа параллельности

```bash
# Создаём отдельные рабочие деревья для каждого агента
# (каждый агент работает в своей ветке, не конфликтуя с другими)

git worktree add ../marketcore-bidding feature/bidding-scheduler
git worktree add ../marketcore-forecasting feature/demand-forecasting
git worktree add ../marketcore-frontend feature/frontend-dashboard

# Структура в файловой системе:
~/
├── marketcore/              ← main (ты здесь)
├── marketcore-bidding/      ← агент 1
├── marketcore-forecasting/  ← агент 2
└── marketcore-frontend/     ← агент 3
```

### 6.2. Запуск параллельных сессий

**Вариант A: Terminal (tmux)**
```bash
# Окно 1: агент на bidding
cd ~/marketcore-bidding && claude

# Окно 2: агент на forecasting
cd ~/marketcore-forecasting && claude

# Окно 3: агент на frontend
cd ~/marketcore-frontend && claude
```

**Вариант B: VS Code (рекомендуется)**
- Открываешь три панели Claude Code рядом
- Каждая панель — свой worktree
- Видишь дифы всех агентов одновременно

**Вариант C: Desktop App**
- Несколько вкладок в Claude Desktop
- Идеально для длительных фоновых задач

### 6.3. AGENTS.md для субагентов

Когда Claude Code использует субагентов (автоматически для сложных задач), он читает `AGENTS.md` если существует:

```markdown
# AGENTS.md — инструкции для субагентов MarketCore

## Субагент по умолчанию: запрещено
- Не запускать docker-compose down
- Не удалять таблицы БД
- Не коммитить в main ветку напрямую
- Не изменять .env файлы

## Проверки качества перед финалом
1. pytest <changed_module>/  — тесты должны быть зелёными
2. ruff check <changed_files> — линтер должен быть чистым
3. mypy --strict <changed_files> — типы должны проходить

## При ошибках
Если падает тест который не был изменён — это регрессия.
Остановись и сообщи пользователю перед продолжением.
```

### 6.4. Пример параллельного спринта

```
Пятница вечер, ставишь трёх агентов на выходные:

Агент 1 (marketcore-forecasting):
"Реализуй полный DemandForecaster из docs/MarketCore_Deep_Dive.md §3.
 Включая fit(), predict(), _engineer_features().
 Напиши walk-forward backtest из §3.3.
 Все тесты должны проходить. Зафиксируй PR когда готово."

Агент 2 (marketcore-bidding):
"Реализуй RuleCompiler и RuleExecutor из docs/MarketCore_Deep_Dive.md §2.5.
 JSON Schema валидатор из §2.3.
 Все 4 примера из §2.4 должны работать как integration test.
 PR когда готово."

Агент 3 (marketcore-frontend):
"Создай дашборд страницу /dashboard в Next.js.
 Используй Tailwind + shadcn/ui.
 Четыре KPI карточки: выручка, ДРР, маржа, алерты OOS.
 Mock данные пока нет бэкенда.
 Стиль: Luxe Noir из docs/MarketCore_TZ.md §8."

Понедельник утром: три готовых PR на ревью.
```

---

## 7. MCP-серверы для MarketCore

MCP (Model Context Protocol) — способ подключить внешние инструменты к Claude Code. Для MarketCore критически полезны:

### 7.1. Настройка MCP в `~/.claude/settings.json`

```json
{
  "mcpServers": {
    "postgresql": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-postgres"],
      "env": {
        "DATABASE_URL": "postgresql://marketcore:dev@localhost:5432/marketcore_dev"
      }
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-github"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      }
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-filesystem",
               "/home/user/marketcore",
               "/home/user/marketcore-docs"]
    },
    "docker": {
      "command": "npx",
      "args": ["-y", "mcp-server-docker"]
    }
  }
}
```

### 7.2. Сценарии использования MCP

**PostgreSQL MCP** — Claude напрямую работает с БД:
```
> Посмотри на таблицу sku_metrics в PostgreSQL.
  Какие индексы есть? Напиши EXPLAIN ANALYZE для самого частого запроса
  (получение метрик по sku_id за последние 30 дней).
  Предложи оптимизацию.
```

**GitHub MCP** — автоматизация PR:
```
> Изучи открытые PR в репозитории. Для каждого проверь:
  1. Есть ли тесты на новый код
  2. Нет ли нарушений архитектурных принципов из CLAUDE.md
  3. Оставь комментарий с code review
```

**Docker MCP** — работа с сервисами:
```
> Запусти docker-compose up -d postgres redis kafka.
  Подожди пока они поднимутся (проверь healthcheck).
  Затем запусти alembic upgrade head.
  Сообщи статус.
```

### 7.3. Кастомный MCP для WB/Ozon API (создаём сами)

```python
# mcp/wb_api_server.py
# Устанавливаем: pip install mcp
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent
import httpx

server = Server("wildberries-api")

@server.list_tools()
async def list_tools():
    return [
        Tool(
            name="get_wb_stocks",
            description="Получить остатки товаров на складах WB",
            inputSchema={
                "type": "object",
                "properties": {
                    "seller_id": {"type": "string"},
                    "sku_ids": {"type": "array", "items": {"type": "string"}}
                },
                "required": ["seller_id"]
            }
        ),
        Tool(
            name="update_wb_price",
            description="Обновить цену товара на WB",
            inputSchema={
                "type": "object",
                "properties": {
                    "nm_id": {"type": "integer"},
                    "price": {"type": "number"}
                },
                "required": ["nm_id", "price"]
            }
        )
    ]

@server.call_tool()
async def call_tool(name: str, arguments: dict):
    if name == "get_wb_stocks":
        # реальный вызов WB API
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                "https://suppliers-api.wildberries.ru/api/v3/stocks/...",
                headers={"Authorization": f"Bearer {WB_API_KEY}"}
            )
        return [TextContent(type="text", text=resp.text)]

if __name__ == "__main__":
    import asyncio
    asyncio.run(stdio_server(server))
```

Добавляем в настройки:
```json
{
  "mcpServers": {
    "wildberries": {
      "command": "python",
      "args": ["/path/to/mcp/wb_api_server.py"]
    }
  }
}
```

Теперь можно:
```
> Используй WB API инструмент и получи остатки для seller_id=12345.
  Сравни с данными в нашей БД. Найди расхождения > 10%.
```

---

## 8. Hooks

Hooks — это команды, которые Claude Code запускает автоматически **до** или **после** определённых действий. Это механизм автоматического контроля качества.

### 8.1. Настройка hooks в `.claude/settings.json` проекта

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write",
        "hooks": [
          {
            "type": "command",
            "command": "bash -c 'if echo \"$CLAUDE_TOOL_INPUT_PATH\" | grep -q \"\\.py$\"; then ruff check --fix \"$CLAUDE_TOOL_INPUT_PATH\" && mypy --strict \"$CLAUDE_TOOL_INPUT_PATH\"; fi'"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash -c 'echo \"[HOOK] Running: $CLAUDE_TOOL_INPUT_COMMAND\" >> /tmp/claude_audit.log'"
          }
        ]
      }
    ]
  }
}
```

### 8.2. Практические hooks для MarketCore

**Hook 1: Автоформатирование Python после записи**
```json
{
  "PostToolUse": [{
    "matcher": "Write(*.py)",
    "hooks": [{
      "type": "command",
      "command": "ruff format $CLAUDE_TOOL_INPUT_PATH && ruff check --fix $CLAUDE_TOOL_INPUT_PATH"
    }]
  }]
}
```

**Hook 2: Запуск тестов после изменения модуля**
```json
{
  "PostToolUse": [{
    "matcher": "Write(backend/marketcore/**/*.py)",
    "hooks": [{
      "type": "command",
      "command": "bash -c 'MODULE=$(echo $CLAUDE_TOOL_INPUT_PATH | sed \"s|backend/||;s|/__init__.py||\" | tr \"/\" \".\"); pytest tests/ -k \"${MODULE##*.}\" --tb=short -q 2>&1 | tail -5'"
    }]
  }]
}
```

**Hook 3: Проверка что секреты не утекают в код**
```json
{
  "PreToolUse": [{
    "matcher": "Write",
    "hooks": [{
      "type": "command",
      "command": "bash -c 'if grep -iE \"(api_key|password|secret|token)\\s*=\\s*['\\''\\\"]\" \"$CLAUDE_TOOL_INPUT_PATH\" 2>/dev/null; then echo \"ERROR: Hardcoded secret detected!\"; exit 1; fi'"
    }]
  }]
}
```

**Hook 4: Автообновление CLAUDE.md после важных изменений архитектуры**
```json
{
  "PostToolUse": [{
    "matcher": "Write(CLAUDE.md)",
    "hooks": [{
      "type": "command",
      "command": "echo \"[$(date)] CLAUDE.md updated\" >> /tmp/claude_md_changelog.log"
    }]
  }]
}
```

---

## 9. Кастомные команды (Custom Commands)

Команды — это slash-команды, которые ты создаёшь сам. Они живут в `.claude/commands/` как Markdown-файлы. Claude выполняет их содержимое при вызове.

### 9.1. Команда `/new-module`

```markdown
<!-- .claude/commands/new-module.md -->

# Создание нового модуля MarketCore

Пользователь запрашивает создание нового модуля: $ARGUMENTS

## Шаги

1. **Создай директорию** `backend/marketcore/$ARGUMENTS/`

2. **Создай файлы:**
   - `__init__.py` (пустой)
   - `models.py` (dataclasses для сущностей модуля)
   - `service.py` (основная бизнес-логика)
   - `repository.py` (работа с БД если нужно)

3. **Создай тесты** `tests/$ARGUMENTS/`:
   - `__init__.py`
   - `test_service.py` с базовыми тест-кейсами

4. **Добавь router** если это API-модуль:
   - `marketcore/api/routes/$ARGUMENTS.py`
   - Зарегистрируй в `marketcore/api/main.py`

5. **Обнови CLAUDE.md**:
   - Добавь описание нового модуля в секцию "Структура модулей"

6. Запусти `pytest tests/$ARGUMENTS/ -v` чтобы убедиться что тесты работают.

7. Сделай git commit: `feat: scaffold $ARGUMENTS module`
```

Использование:
```
/new-module notifications
```

### 9.2. Команда `/run-tests`

```markdown
<!-- .claude/commands/run-tests.md -->

# Запуск тестов MarketCore

## Аргументы: $ARGUMENTS
(опционально: имя модуля или путь к файлу теста)

1. Если $ARGUMENTS пустой — запусти все тесты:
   ```
   pytest backend/tests/ -v --tb=short --cov=marketcore --cov-report=term-missing
   ```

2. Если указан модуль — запусти только его тесты:
   ```
   pytest backend/tests/$ARGUMENTS/ -v --tb=long
   ```

3. Выведи итог:
   - Сколько тестов прошло/упало
   - Покрытие по модулям
   - Если есть падения — покажи traceback и предложи план фикса
```

### 9.3. Команда `/review-pr`

```markdown
<!-- .claude/commands/review-pr.md -->

# Code Review Pull Request

PR для ревью: $ARGUMENTS

## Процесс

1. Получи diff PR через git или GitHub MCP:
   ```
   git diff main...$ARGUMENTS --stat
   git diff main...$ARGUMENTS
   ```

2. Проверь по чеклисту:
   - [ ] Тесты на новый код написаны?
   - [ ] Типы расставлены (mypy чистый)?
   - [ ] Нет нарушений архитектурных принципов из CLAUDE.md?
   - [ ] Нет хардкода секретов?
   - [ ] Коммит-сообщения в Conventional Commits?
   - [ ] Нет god-классов / функций длиннее 50 строк?
   - [ ] Идемпотентность соблюдена для API-вызовов?

3. Выведи структурированный отчёт:
   **Одобрено:** [список хорошего]
   **Требует исправления:** [список проблем с указанием строк]
   **Предложения:** [что улучшить но необязательно]
```

### 9.4. Команда `/deploy-stage`

```markdown
<!-- .claude/commands/deploy-stage.md -->

# Деплой на staging

1. Убедись что все тесты зелёные: `make test`
2. Проверь что нет незакоммиченных изменений: `git status`
3. Собери Docker образы: `make build`
4. Запушь в registry: `make push-stage`
5. Примени Kubernetes конфиги: `kubectl apply -f infra/k8s/staging/`
6. Проверь статус деплоя: `kubectl rollout status deployment/marketcore-api -n staging`
7. Запусти smoke tests: `pytest tests/smoke/ --base-url=https://staging.marketcore.io`
8. Сообщи результат.
```

---

## 10. Пошаговый план по модулям (9 месяцев)

Применяем ТЗ к реальному workflow с Claude Code. Каждый месяц — набор задач в виде промптов для Claude.

### Месяц 1: Foundation (M1)

**Неделя 1: Инфраструктура**
```
Задача для Claude (Plan Mode сначала):

"Создай полную docker-compose.yml для локальной разработки:
- PostgreSQL 16 с TimescaleDB extension
- Redis 7 (cluster off, single node для dev)
- Kafka + Zookeeper (последние версии)
- ClickHouse

Для каждого сервиса:
- healthcheck
- named volume
- env переменные через .env файл

Создай .env.example с заполнителями.
Создай Makefile с командами: dev, test, lint, migrate, logs.
Создай README.md с инструкцией запуска."
```

**Неделя 2: Auth + Account модель**
```
"Реализуй модуль auth из ТЗ:

1. Pydantic-схемы: UserCreate, UserLogin, TokenPair, RefreshToken
2. SQLAlchemy модели: users, sessions (в backend/marketcore/models.py)
3. Alembic миграция для этих таблиц
4. FastAPI router: POST /auth/register, POST /auth/login, POST /auth/refresh
5. JWT middleware для защищённых endpoint'ов
6. Тесты: test_register, test_login_success, test_login_wrong_password, test_refresh_token

Используй python-jose для JWT, passlib для хэширования паролей.
Тест: pytest tests/auth/ -v — все должны быть зелёными."
```

**Неделя 3-4: Account + Ingestor**
```
"Реализуй Account модуль (подключение кабинета WB/Ozon):

1. Модель Account с зашифрованным api_key_cipher (используй Fernet из cryptography)
2. CRUD endpoint'ы: POST /accounts, GET /accounts, DELETE /accounts/{id}
3. Endpoint верификации токена: POST /accounts/{id}/verify
   - Делает тестовый вызов к WB/Ozon API
   - Если ответ 200 → статус 'active', иначе 'invalid'

4. Базовый Ingestor (Celery task):
   - pull_stocks_wb(account_id) — вызывает GET /api/v3/stocks/{warehouseId}
   - Сохраняет в таблицу sku_metrics (TimescaleDB)
   - Rate-limit логика через Redis: максимум 60 req/min на токен

Тесты с моком WB API (respx для httpx)."
```

### Месяц 2-3: MVP-1 (Observability)

```
Sprint: Полный Ingestor

"Добавь к Ingestor:
1. pull_orders_wb(account_id) — заказы за последние 24 часа
2. pull_prices_wb(account_id) — текущие цены по всем SKU
3. pull_ad_stats_wb(account_id) — CPM, показы, клики за сутки

Планировщик Celery Beat:
- stocks: каждые 10 минут
- orders: каждые 5 минут
- prices: каждые 15 минут
- ad_stats: каждые 30 минут

Все tasks должны быть идемпотентными (повторный запуск = нет дублей в БД).
Circuit Breaker: после 5 consecutive ошибок → задача ставится в cooldown 5 минут."
```

```
Sprint: Индекс локализации

"Реализуй LocalizationService из docs/MarketCore_Deep_Dive.md §6:

1. SQL materialized view mv_localization_index (файл sql/migrations/create_mv_li.sql)
2. Python класс LocalizationService с методами get_account_li() и get_sku_li()
3. API endpoint GET /analytics/localization?sku_id={id}
4. pg_cron задача для обновления materialized view каждый час
   (добавь в миграцию через CREATE EXTENSION IF NOT EXISTS pg_cron)

Тесты: fixtures с тестовыми заказами по разным ФО, проверка расчёта ИЛ."
```

### Месяц 4-5: Beta (Automation)

```
Sprint: Bidding DSL (самый сложный, 2 недели)

"Реализуй полный Bidding DSL из docs/MarketCore_Deep_Dive.md §2:

Неделя 1:
1. Классы AST: ConditionNode, AndNode, OrNode, NotNode, MetricNode, TimeNode
2. SchemaValidator с JSON Schema из §2.3 (сохрани схему в schemas/bidding-rule.schema.json)
3. RuleCompiler.compile() → CompiledRule
4. Тесты: test_compile_simple, test_compile_and, test_compile_time_condition

Неделя 2:
5. RuleExecutor.execute() с полной guardrails логикой
6. Strategy implementations: max_coverage, economy_mode, target_drr
7. Conflict resolution policy
8. API endpoint'ы: CRUD для bidding_rules
9. Тесты из §2.6: все должны проходить

Dry-run режим обязателен."
```

```
Sprint: Forecasting Ensemble (2 недели)

"Реализуй DemandForecaster из docs/MarketCore_Deep_Dive.md §3:

Неделя 1:
1. SEASONAL_COEFFICIENTS константа
2. Базовый fit() с Prophet: seasonal_k и promo_flag как regressors
3. Базовый predict() только с Prophet + seasonal blend
4. ForecastPoint и ForecastConfig dataclasses
5. Тесты с синтетическими данными (генерируй через numpy)

Неделя 2:
6. LightGBM на residuals: _engineer_features() с лагами и MA
7. _blend() ансамбль с весами из ForecastConfig
8. walk_forward_backtest() из §3.3
9. API endpoint: POST /forecast/sku/{id}
10. Тесты приёмочного качества: WAPE < 25% на синтетических данных"
```

```
Sprint: Supply Solver + OOS Calculator

"Реализуй из docs/MarketCore_Deep_Dive.md:
§1: SupplyDistributionSolver — полный код с тестами
§4: OOSCalculator — полный код с тестами

Затем свяжи их в Supply Planner:
- GET /supply/oos-report?account_id={id} — список всех SKU с urgency
- POST /supply/optimize — ILP оптимизация для конкретного SKU
- Сортировка по urgency: black → red → yellow → green

Убедись что тесты из Deep Dive §1.3 и §4.2 все проходят."
```

### Месяц 5-6: Публичный запуск

```
Sprint: Unit Economics

"Реализуй UnitEconomicsCalculator из docs/MarketCore_Deep_Dive.md §8:

1. Все датаклассы: EconomicsInputs, EconomicsBreakdown
2. calculate() с полной формулой
3. break_even_price() — аналитическое решение
4. what_if(new_price) — симулятор
5. Поддержка всех налоговых режимов: usn_income_6, usn_income_exp_15, osno_profit_20

API:
- POST /economics/calculate — расчёт по входным данным
- POST /economics/breakeven — точка безубыточности
- POST /economics/simulate — what-if анализ

Тесты должны включать: test_break_even_equals_zero_profit,
test_usn15_correctly_deducts_expenses, test_what_if_lower_price"
```

---

## 11. Управление контекстом на большом проекте

Это самая важная практическая часть. MarketCore — большой проект. Неправильное управление контекстом = медленная деградация качества.

### 11.1. Мониторинг заполненности окна

```bash
# Добавь в ~/.claude/settings.json
{
  "statusLine": "Context: {context_pct}% | Cost: ${session_cost} | {model}"
}
```

Ты всегда видишь процент заполнения в строке статуса.

### 11.2. Правило трёх порогов

```
0—50%  → Работаем спокойно, всё нормально.

50—70% → Внимание. Начинаем следить.
          Не добавляем много новых файлов в контекст.

70—90% → /compact НЕМЕДЛЕННО.
          Claude начинает "забывать" ранние инструкции.
          Команда: /compact

90%+   → /clear ОБЯЗАТЕЛЬНО.
          Заводим новую сессию.
          Перед этим: "Напомни что мы сделали в этой сессии, в 5 bullet points"
          — сохраняем summary и начинаем заново.
```

### 11.3. Правила работы с большими файлами

```
❌ Плохо:
"Прочитай весь наш проект и пойми архитектуру"
(Claude читает 100+ файлов = моментальное заполнение окна)

✓ Хорошо:
"Прочитай только marketcore/bidding/dsl.py и tests/bidding/test_dsl.py.
 Мне нужно добавить поддержку нового типа условия: 'between'"
```

```
❌ Плохо:
"Посмотри на ошибку" (без контекста — Claude начинает читать всё подряд)

✓ Хорошо:
"Файл: backend/marketcore/solvers/supply_distribution.py, строка 87.
 Ошибка: TypeError: unsupported operand type(s) for *: 'int' and 'Decimal'
 Посмотри только на метод _apply_action и его вызовы."
```

### 11.4. Структура сессии для новой задачи

```
Начало каждой сессии (шаблон):

1. "Прочитай CLAUDE.md для контекста проекта."
   (100-200 токенов — мало, зато Claude знает стандарты)

2. "Задача: [конкретная задача]"
   "Файлы которые нужно прочитать: [только релевантные]"
   "Файлы которые нужно создать/изменить: [конкретно]"

3. Работаем.

4. При 70% контекста:
   "Сделай /compact и продолжай."
   (Claude компактифицирует историю, сохраняя ключевой контекст)

5. При завершении задачи:
   "Сделай git commit и закончим сессию.
    В следующей сессии продолжим с [следующей задачи]."
```

### 11.5. CLAUDE.md как кэш контекста

Когда Claude что-то важное узнаёт о проекте, попроси его сохранить это в CLAUDE.md:

```
> Ты только что разобрался как работает наш rate limiter.
  Добавь это понимание в CLAUDE.md в секцию "Внешние API",
  чтобы следующая сессия не повторяла это исследование.
```

Это и есть **Auto Memory** — Claude сам накапливает знания о проекте между сессиями.

---

## 12. CI/CD с Claude Code

### 12.1. GitHub Actions + Claude Code (@claude в PR)

```yaml
# .github/workflows/claude-review.yml
name: Claude Code Review

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Claude Code Review
        uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            Проведи code review этого PR согласно CLAUDE.md.
            Проверь:
            1. Типизация (mypy --strict)
            2. Тесты написаны на новый код
            3. Нет нарушений архитектурных принципов
            4. Нет хардкода секретов
            5. Conventional Commits
            Оставь review комментарий на GitHub.
```

```yaml
# .github/workflows/claude-tests.yml
name: Automated Tests with Claude

on:
  push:
    branches: [main, develop]

jobs:
  test-and-fix:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run tests
        id: tests
        run: |
          pip install -e ".[dev]"
          pytest backend/tests/ --tb=short -q > test_output.txt 2>&1
          echo "exit_code=$?" >> $GITHUB_OUTPUT

      - name: Claude fixes failing tests
        if: steps.tests.outputs.exit_code != '0'
        uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            Тесты упали. Вот вывод:
            $(cat test_output.txt)

            Найди root cause. Если проблема в коде (не в тестах) — исправь.
            Если проблема в тесте (неправильное ожидание) — тоже исправь.
            Коммить фикс в эту ветку.
```

### 12.2. Тегирование @claude в GitHub Issues

После `/install-github-app` команды в Claude Code, ты можешь в любом Issue написать:

```
@claude Реализуй этот feature request согласно ТЗ в CLAUDE.md.
Создай PR когда готово.
```

Claude создаст ветку, реализует, откроет PR.

---

## 13. Типичные ошибки и как их избежать

### ❌ Ошибка 1: Задача без критериев верификации

```
Плохо:
"Добавь Forecasting модуль"

Хорошо:
"Добавь DemandForecaster. Критерии готовности:
1. pytest tests/forecasting/ — все 8 тестов зелёные
2. mypy --strict backend/marketcore/forecasting/ — без ошибок
3. walk_forward_backtest() возвращает avg_wape < 0.30 на synthetic data"
```

### ❌ Ошибка 2: Слишком большой scope задачи

```
Плохо:
"Реализуй весь Bidding модуль"
(Claude берётся за 500 строк кода → теряет нить → деградирует к концу)

Хорошо:
"Реализуй только AST ноды (ConditionNode, AndNode, MetricNode).
Не трогай Compiler и Executor пока."
Потом: "Теперь добавь RuleCompiler."
Потом: "Теперь RuleExecutor."
```

### ❌ Ошибка 3: Не использовать Plan Mode для новой задачи

```
Плохо:
Начинать кодить сразу без Plan Mode →
Claude не понял структуру проекта → пишет код в стиле "hello world"

Хорошо:
Сначала Plan Mode: "Изучи существующие файлы,
предложи план до того как писать что-то."
```

### ❌ Ошибка 4: Игнорировать деградацию при 70%+

```
Симптомы деградации:
- Claude "забывает" требования из CLAUDE.md
- Начинает нарушать архитектурные принципы
- Тесты пишутся без запуска
- Появляются заглушки вместо реальной логики

Решение: /compact при 70%, /clear при 90%
```

### ❌ Ошибка 5: Нет CLAUDE.md для критичных решений

```
Всё что Claude узнаёт должно быть записано в CLAUDE.md.
Иначе следующая сессия повторяет то же исследование.

После каждой 2-недельной итерации:
"Обнови CLAUDE.md — что нового мы узнали о проекте?
Добавь в соответствующие секции."
```

### ❌ Ошибка 6: Не верифицировать результат

```
Плохо:
Принять код от Claude без запуска тестов.

Хорошо:
Всегда заканчивать промпт:
"После реализации запусти pytest <module>/ и убедись что всё зелёное.
Если есть падения — разберись и исправь ПЕРЕД тем как сообщить о завершении."
```

### ❌ Ошибка 7: Параллельные агенты без изоляции (worktrees)

```
Плохо:
Два агента в одной рабочей директории →
конфликты файлов, потерянные изменения

Хорошо:
git worktree для каждого агента + merge через PR
```

---

## Приложение A: Шпаргалка промптов для MarketCore

```
# Начало новой фичи
"Прочитай CLAUDE.md. Задача: [описание]. 
Сначала в Plan Mode изучи [файлы] и предложи план."

# Дебаггинг
"Файл [path], строка [N], ошибка: [error].
Воспроизведи: pytest [test] -v.
Найди root cause. Не меняй тест если он логически верный."

# Рефакторинг
"В Plan Mode оцени [файл]. Предложи улучшения.
Жду аппрув — потом реализуй. Тесты должны остаться зелёными."

# Code review
/review-pr [branch_name]

# Новый модуль
/new-module [module_name]

# Деплой
/deploy-stage

# При близком контексте (70%)
"Compact и продолжай задачу."

# Конец сессии
"Сделай git commit. Что доделать в следующей сессии?"
```

## Приложение B: Метрики успеха по месяцам

| Месяц | Milestone | Критерий |
|---|---|---|
| 1 | Foundation | docker-compose up работает, auth endpoint'ы отвечают |
| 2-3 | Ingestor | Данные из WB/Ozon реально льются в TimescaleDB |
| 3 | ИЛ | Materialized view считается, API отвечает |
| 4 | Bidding DSL | 4 sample-правила работают корректно |
| 5 | Forecasting | WAPE < 25% на real seller data |
| 5 | Supply Solver | ILP даёт feasible план за < 500ms |
| 6 | Unit Econ | break_even_price() корректен на 10 тест-кейсах |
| 6 | Public launch | Первые 10 beta-users подключились |

---

**Документ живой.** После каждого спринта добавляй найденные паттерны в CLAUDE.md и в этот гайд. Лучшие промпты — те что ты нашёл сам в процессе работы над MarketCore.
