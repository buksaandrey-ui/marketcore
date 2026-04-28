"""
Дефолтные профили спроса по часам для каждой категории.

Структура: category_key → {DayType → [24 × DemandLevel]}

Каждое значение — список из 24 элементов (для часов 0..23).
L = LOW, M = MEDIUM, H = HIGH.

Доступные категории:
  fertilizers_plants  — Удобрения и товары для сада (весна/лето пиковый сезон)
  home_household      — Товары для дома и быта
  beauty_care         — Красота и уход
  sports_outdoor      — Спорт и активный отдых
  universal           — Универсальный профиль (если категория не определена)
"""
from __future__ import annotations

from marketcore.strategy.models import CategoryProfile, DayProfile, DayType, DemandLevel

L = DemandLevel.LOW
M = DemandLevel.MEDIUM
H = DemandLevel.HIGH


def _profile(day_type: DayType, levels: list) -> DayProfile:
    return DayProfile.from_levels(day_type, levels)


# ─── Удобрения и товары для сада ─────────────────────────────────────────────
_FERTILIZERS_WORKDAY = [
    # 00  01  02  03  04  05  06  07  08  09  10  11
      L,  L,  L,  L,  L,  L,  M,  M,  M,  H,  H,  H,
    # 12  13  14  15  16  17  18  19  20  21  22  23
      M,  M,  M,  M,  M,  H,  H,  H,  M,  M,  L,  L,
]

_FERTILIZERS_FRIDAY = [
    # 00  01  02  03  04  05  06  07  08  09  10  11
      L,  L,  L,  L,  L,  L,  M,  M,  M,  H,  H,  H,
    # 12  13  14  15  16  17  18  19  20  21  22  23
      M,  M,  M,  M,  H,  H,  H,  H,  M,  M,  L,  L,
]

_FERTILIZERS_SATURDAY = [
    # 00  01  02  03  04  05  06  07  08  09  10  11
      L,  L,  L,  L,  L,  M,  M,  M,  H,  H,  H,  H,
    # 12  13  14  15  16  17  18  19  20  21  22  23
      M,  M,  M,  M,  H,  H,  H,  M,  M,  L,  L,  L,
]

_FERTILIZERS_SUNDAY = [
    # 00  01  02  03  04  05  06  07  08  09  10  11
      L,  L,  L,  L,  L,  M,  M,  H,  H,  H,  H,  M,
    # 12  13  14  15  16  17  18  19  20  21  22  23
      M,  M,  M,  H,  H,  H,  M,  M,  M,  L,  L,  L,
]

FERTILIZERS_PLANTS = CategoryProfile(
    category="fertilizers_plants",
    profiles={
        DayType.WORKDAY:  _profile(DayType.WORKDAY,  _FERTILIZERS_WORKDAY),
        DayType.FRIDAY:   _profile(DayType.FRIDAY,   _FERTILIZERS_FRIDAY),
        DayType.SATURDAY: _profile(DayType.SATURDAY, _FERTILIZERS_SATURDAY),
        DayType.SUNDAY:   _profile(DayType.SUNDAY,   _FERTILIZERS_SUNDAY),
    }
)


# ─── Товары для дома ──────────────────────────────────────────────────────────
_HOME_WORKDAY = [
    L, L, L, L, L, L, L,  M,  M,  M,  H,  H,
    M, M, M, M, M, H,  H,  H,  M,  M,  L,  L,
]

_HOME_WEEKEND = [
    L, L, L, L, L, L, M,  M,  H,  H,  H,  H,
    H, H, M, M, H, H,  M,  M,  M,  L,  L,  L,
]

HOME_HOUSEHOLD = CategoryProfile(
    category="home_household",
    profiles={
        DayType.WORKDAY:  _profile(DayType.WORKDAY,  _HOME_WORKDAY),
        DayType.FRIDAY:   _profile(DayType.FRIDAY,   _HOME_WORKDAY),
        DayType.SATURDAY: _profile(DayType.SATURDAY, _HOME_WEEKEND),
        DayType.SUNDAY:   _profile(DayType.SUNDAY,   _HOME_WEEKEND),
    }
)


# ─── Красота и уход ───────────────────────────────────────────────────────────
_BEAUTY_WORKDAY = [
    L, L, L, L, L, L, L,  M,  M,  H,  H,  H,
    M, M, M, M, H, H,  H,  H,  M,  M,  L,  L,
]

_BEAUTY_WEEKEND = [
    L, L, L, L, L, L, M,  M,  H,  H,  H,  H,
    M, M, M, H, H, H,  M,  M,  L,  L,  L,  L,
]

BEAUTY_CARE = CategoryProfile(
    category="beauty_care",
    profiles={
        DayType.WORKDAY:  _profile(DayType.WORKDAY,  _BEAUTY_WORKDAY),
        DayType.FRIDAY:   _profile(DayType.FRIDAY,   _BEAUTY_WORKDAY),
        DayType.SATURDAY: _profile(DayType.SATURDAY, _BEAUTY_WEEKEND),
        DayType.SUNDAY:   _profile(DayType.SUNDAY,   _BEAUTY_WEEKEND),
    }
)


# ─── Спорт и активный отдых ───────────────────────────────────────────────────
_SPORTS_WORKDAY = [
    L, L, L, L, L, L, M,  M,  M,  M,  H,  H,
    M, M, M, M, M, M,  H,  H,  H,  M,  L,  L,
]

_SPORTS_WEEKEND = [
    L, L, L, L, L, M, M,  M,  H,  H,  H,  H,
    M, M, M, M, M, M,  M,  H,  M,  L,  L,  L,
]

SPORTS_OUTDOOR = CategoryProfile(
    category="sports_outdoor",
    profiles={
        DayType.WORKDAY:  _profile(DayType.WORKDAY,  _SPORTS_WORKDAY),
        DayType.FRIDAY:   _profile(DayType.FRIDAY,   _SPORTS_WORKDAY),
        DayType.SATURDAY: _profile(DayType.SATURDAY, _SPORTS_WEEKEND),
        DayType.SUNDAY:   _profile(DayType.SUNDAY,   _SPORTS_WEEKEND),
    }
)


# ─── Универсальный (фолбэк) ───────────────────────────────────────────────────
_UNIVERSAL_WORKDAY = [
    L, L, L, L, L, L, L,  M,  M,  H,  H,  H,
    M, M, M, M, M, H,  H,  H,  M,  M,  L,  L,
]

_UNIVERSAL_WEEKEND = [
    L, L, L, L, L, L, M,  M,  H,  H,  H,  H,
    M, M, M, M, H, H,  M,  M,  M,  L,  L,  L,
]

UNIVERSAL = CategoryProfile(
    category="universal",
    profiles={
        DayType.WORKDAY:  _profile(DayType.WORKDAY,  _UNIVERSAL_WORKDAY),
        DayType.FRIDAY:   _profile(DayType.FRIDAY,   _UNIVERSAL_WORKDAY),
        DayType.SATURDAY: _profile(DayType.SATURDAY, _UNIVERSAL_WEEKEND),
        DayType.SUNDAY:   _profile(DayType.SUNDAY,   _UNIVERSAL_WEEKEND),
    }
)


# ─── Реестр всех профилей ─────────────────────────────────────────────────────
DEFAULT_PROFILES: dict[str, CategoryProfile] = {
    "fertilizers_plants": FERTILIZERS_PLANTS,
    "home_household":     HOME_HOUSEHOLD,
    "beauty_care":        BEAUTY_CARE,
    "sports_outdoor":     SPORTS_OUTDOOR,
    "universal":          UNIVERSAL,
}


def get_default_profile(category: str) -> CategoryProfile:
    """Возвращает профиль для категории.
    Если категория не найдена — возвращает universal.
    """
    return DEFAULT_PROFILES.get(category, UNIVERSAL)
