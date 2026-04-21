FROM python:3.12-slim

WORKDIR /app

# Системные зависимости для asyncpg и cryptography
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Ставим только продакшн-зависимости (без ML-библиотек)
COPY requirements-prod.txt .
RUN pip install --no-cache-dir -r requirements-prod.txt

# Копируем код
COPY . .

# Устанавливаем сам пакет без его тяжёлых зависимостей
RUN pip install --no-cache-dir --no-deps -e .

EXPOSE 8000

# Railway сам подставляет $PORT; alembic прогоняет миграции при старте
CMD alembic upgrade head && uvicorn marketcore.api.main:app --host 0.0.0.0 --port ${PORT:-8000}
