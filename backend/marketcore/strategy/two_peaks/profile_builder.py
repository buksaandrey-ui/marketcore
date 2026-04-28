"""
Построение профиля спроса из исторических данных ad_stats.

Алгоритм:
1. Берём данные за последние N дней (по умолчанию 28).
2. Для каждого часа каждого дня агрегируем: clicks (главный), views, spend.
3. Нормализуем clicks по типу дня (workday, saturday и т.д.) → значение 0..1.
4. Делим на 3 квантиля → LOW / MEDIUM / HIGH.
5. Применяем сглаживание: нет перехода LOW→HIGH без MEDIUM.

Если данных < min_days → возвращает None (использовать дефолтный профиль).
"""
from __future__ import annotations

import logging
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from statistics import mean
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func as sa_func

from marketcore.models import AdStat
from marketcore.strategy.calendar.ru_holidays import RuHolidayCalendar
from marketcore.strategy.models import CategoryProfile, DayProfile, DayType, DemandLevel

logger = logging.getLogger(__name__)


def _smooth(levels: list[DemandLevel]) -> list[DemandLevel]:
    """Убираем резкие переходы LOW→HIGH и HIGH→LOW без промежуточного MEDIUM."""
    result = list(levels)
    for i in range(1, len(result) - 1):
        prev_ = result[i - 1]
        curr  = result[i]
        next_ = result[i + 1]
        # HIGH между двумя LOW → понижаем до MEDIUM
        if curr == DemandLevel.HIGH and prev_ == DemandLevel.LOW and next_ == DemandLevel.LOW:
            result[i] = DemandLevel.MEDIUM
        # LOW между двумя HIGH → повышаем до MEDIUM
        if curr == DemandLevel.LOW and prev_ == DemandLevel.HIGH and next_ == DemandLevel.HIGH:
            result[i] = DemandLevel.MEDIUM
    return result


def _levels_from_values(values: list[float]) -> list[DemandLevel]:
    """Нормализует 24 значения → 24 уровня DemandLevel по квантилям 33%/66%."""
    if not any(v > 0 for v in values):
        return [DemandLevel.LOW] * 24

    max_v = max(values) or 1.0
    norm = [v / max_v for v in values]

    # Порог: bottom 33% → LOW, top 33% → HIGH, остальное → MEDIUM
    sorted_non_zero = sorted(v for v in norm if v > 0)
    if len(sorted_non_zero) >= 3:
        q33 = sorted_non_zero[len(sorted_non_zero) // 3]
        q66 = sorted_non_zero[2 * len(sorted_non_zero) // 3]
    else:
        q33, q66 = 0.33, 0.66

    result = []
    for v in norm:
        if v >= q66:
            result.append(DemandLevel.HIGH)
        elif v >= q33:
            result.append(DemandLevel.MEDIUM)
        else:
            result.append(DemandLevel.LOW)

    return _smooth(result)


async def build_profile_from_history(
    db: AsyncSession,
    account_id: str,
    campaign_ids: list[str],
    category: str,
    days: int = 28,
    min_days: int = 14,
    calendar: Optional[RuHolidayCalendar] = None,
) -> Optional[CategoryProfile]:
    """
    Строит CategoryProfile из ad_stats за последние `days` дней.
    Возвращает None если данных недостаточно.
    """
    import uuid as _uuid

    if calendar is None:
        from marketcore.strategy.calendar.ru_holidays import calendar as _cal
        calendar = _cal

    date_from = datetime.now(timezone.utc) - timedelta(days=days)

    # Тянем из БД: campaign_id, stat_date, clicks, views
    stmt = (
        select(
            AdStat.campaign_id,
            AdStat.stat_date,
            sa_func.sum(AdStat.clicks).label("clicks"),
            sa_func.sum(AdStat.views).label("views"),
        )
        .where(
            AdStat.account_id == _uuid.UUID(account_id),
            AdStat.stat_date >= date_from,
            AdStat.campaign_id.in_(campaign_ids),
        )
        .group_by(AdStat.campaign_id, AdStat.stat_date)
    )
    rows = (await db.execute(stmt)).fetchall()

    if not rows:
        logger.info("profile_builder: нет данных ad_stats для %s", campaign_ids)
        return None

    # Группируем по типу дня и часу
    # stat_date у нас хранится как datetime (UTC) → используем час из него
    by_day_type: dict[DayType, dict[int, list[float]]] = defaultdict(lambda: defaultdict(list))
    unique_dates: set[date] = set()

    for row in rows:
        dt: datetime = row.stat_date
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        d = dt.date()
        hour = dt.hour
        day_type = calendar.classify(d)
        unique_dates.add(d)
        by_day_type[day_type][hour].append(float(row.clicks or 0))

    # Проверяем достаточность данных
    actual_days = len(unique_dates)
    if actual_days < min_days:
        logger.info(
            "profile_builder: только %d дней данных (нужно >= %d) — используем дефолтный профиль",
            actual_days, min_days
        )
        return None

    # Строим профили для каждого типа дня
    profiles: dict[DayType, DayProfile] = {}
    for day_type, hour_data in by_day_type.items():
        # Усредняем clicks по каждому часу
        avg_clicks = [mean(hour_data.get(h, [0.0])) for h in range(24)]
        levels = _levels_from_values(avg_clicks)
        profiles[day_type] = DayProfile.from_levels(day_type, levels)

    if not profiles:
        return None

    return CategoryProfile(category=category, profiles=profiles)
