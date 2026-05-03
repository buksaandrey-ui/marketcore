"""
Политики TTL для кэш-таблиц.

Единственное место, где задаётся «срок жизни» кэшированных данных.
Если нужно изменить TTL — меняй только здесь.
"""
from datetime import timedelta

# Имена товаров — меняются редко (переименование SKU)
SKU_NAMES_TTL = timedelta(hours=24)

# Имена и статусы рекламных кампаний — меняются при создании/паузе
CAMPAIGN_NAMES_TTL = timedelta(hours=1)

# Финансовые отчёты WB — закрытый период не меняется
REPORT_CACHE_TTL = timedelta(days=7)

# Расписание стратегии — пересчитывается при смене профиля
STRATEGY_SCHEDULE_TTL = timedelta(hours=1)


def is_stale(updated_at, ttl: timedelta) -> bool:
    """Возвращает True если запись устарела (updated_at + ttl < сейчас).

    updated_at может быть None (запись ещё не создавалась) → считаем устаревшей.
    """
    from datetime import datetime, timezone
    if updated_at is None:
        return True
    now = datetime.now(timezone.utc)
    # Приводим к aware если naive
    if updated_at.tzinfo is None:
        updated_at = updated_at.replace(tzinfo=timezone.utc)
    return (now - updated_at) > ttl
