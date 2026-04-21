.PHONY: dev stop test lint migrate build logs help worker beat ingest-once

help:
	@echo "MarketCore — доступные команды:"
	@echo "  make dev      — запустить все сервисы (БД, Redis, Kafka...)"
	@echo "  make stop     — остановить все сервисы"
	@echo "  make test     — запустить тесты"
	@echo "  make lint     — проверить качество кода"
	@echo "  make migrate  — применить миграции базы данных"
	@echo "  make logs     — смотреть логи сервисов"
	@echo "  make build    — собрать Docker-образы"

dev:
	docker compose up -d
	@echo "✅ Сервисы запущены. Подождите 10-15 секунд пока всё поднимется."

stop:
	docker compose down
	@echo "⛔ Сервисы остановлены."

logs:
	docker compose logs -f

test:
	cd backend && pytest tests/ -v --tb=short

lint:
	cd backend && ruff check marketcore/ && mypy --strict marketcore/

migrate:
	cd backend && alembic upgrade head
	@echo "✅ Миграции применены."

build:
	docker compose build

worker:
	cd backend && celery -A marketcore.celery_app worker --loglevel=info

beat:
	cd backend && celery -A marketcore.celery_app beat --loglevel=info

ingest-once:
	cd backend && python -c "from marketcore.ingestor.tasks import dispatch_pull_stocks, dispatch_pull_prices, dispatch_pull_orders; dispatch_pull_stocks(); dispatch_pull_prices(); dispatch_pull_orders(); print('Dispatched')"
