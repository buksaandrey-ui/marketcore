"""
Построение расписания ставок на неделю (WeeklySchedule).

Алгоритм:
1. Берём CategoryProfile (из истории или дефолтный).
2. Для каждого типа дня строим 24 уровня спроса.
3. Применяем сглаживание пиков: перед H и после H ставим M (нет прыжков LOW→HIGH).
4. Ограничиваем количество пиков (HIGH-блоков): максимум 2 «пика» в сутках.
5. Возвращаем WeeklySchedule.
"""
from __future__ import annotations

from marketcore.strategy.models import (
    CategoryProfile, DayType, DemandLevel, WeeklySchedule,
)


MAX_PEAK_BLOCKS = 2  # максимум 2 пика HIGH в сутках


def _add_transitions(levels: list[DemandLevel]) -> list[DemandLevel]:
    """
    Добавляем MEDIUM-переходы вокруг HIGH-блоков.
    Правило: если час[i] = HIGH, то час[i-1] и час[i+1] не могут быть LOW.
    """
    result = list(levels)
    n = len(result)

    for i in range(n):
        if result[i] == DemandLevel.HIGH:
            if i > 0 and result[i - 1] == DemandLevel.LOW:
                result[i - 1] = DemandLevel.MEDIUM
            if i < n - 1 and result[i + 1] == DemandLevel.LOW:
                result[i + 1] = DemandLevel.MEDIUM
    return result


def _count_high_blocks(levels: list[DemandLevel]) -> list[tuple[int, int]]:
    """Возвращает список (start, end) непрерывных HIGH-блоков."""
    blocks: list[tuple[int, int]] = []
    in_block = False
    start = 0
    for i, lv in enumerate(levels):
        if lv == DemandLevel.HIGH and not in_block:
            in_block = True
            start = i
        elif lv != DemandLevel.HIGH and in_block:
            in_block = False
            blocks.append((start, i - 1))
    if in_block:
        blocks.append((start, len(levels) - 1))
    return blocks


def _trim_to_max_peaks(levels: list[DemandLevel], max_peaks: int) -> list[DemandLevel]:
    """
    Если HIGH-блоков больше max_peaks — оставляем только самые «высокие»
    (с наибольшим количеством HIGH-часов), остальные понижаем до MEDIUM.
    """
    blocks = _count_high_blocks(levels)
    if len(blocks) <= max_peaks:
        return levels

    # Сортируем по размеру блока (больший = важнее), берём топ max_peaks
    blocks_sorted = sorted(blocks, key=lambda b: b[1] - b[0], reverse=True)
    keep = set()
    for start, end in blocks_sorted[:max_peaks]:
        for h in range(start, end + 1):
            keep.add(h)

    result = list(levels)
    for i in range(len(result)):
        if result[i] == DemandLevel.HIGH and i not in keep:
            result[i] = DemandLevel.MEDIUM
    return result


def build_weekly_schedule(
    profile: CategoryProfile,
    max_peak_blocks: int = MAX_PEAK_BLOCKS,
) -> WeeklySchedule:
    """
    Строит расписание на неделю из CategoryProfile.
    Охватывает все 7 типов дня, применяя фолбэки из CategoryProfile.get().
    """
    schedule: dict[str, list[str]] = {}

    day_types_to_cover = [
        DayType.WORKDAY,
        DayType.FRIDAY,
        DayType.SATURDAY,
        DayType.SUNDAY,
        DayType.HOLIDAY,
        DayType.PRE_HOLIDAY,
        DayType.TRANSFERRED_OFF,
    ]

    for day_type in day_types_to_cover:
        day_profile = profile.get(day_type)
        levels = [day_profile.demand_at(h) for h in range(24)]

        # Ограничиваем пики
        levels = _trim_to_max_peaks(levels, max_peak_blocks)

        # Добавляем переходы MEDIUM вокруг HIGH
        levels = _add_transitions(levels)

        schedule[day_type.value] = [lv.value for lv in levels]

    return WeeklySchedule(category=profile.category, schedule=schedule)
