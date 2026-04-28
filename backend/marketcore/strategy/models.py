"""
Модели данных стратегии «2 пика».

Уровень спроса (DemandLevel) определяет, какую ставку выставлять в каждый час.
Тип ставки (BidType) задаёт коэффициент от минимума рынка.
DayType — тип дня для подбора профиля (будни / суббота / воскресенье / праздник / …).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class DemandLevel(str, Enum):
    LOW    = "LOW"      # низкий спрос — минимальная ставка
    MEDIUM = "MEDIUM"   # средний спрос — конкурентная ставка
    HIGH   = "HIGH"     # пик спроса — лидерская ставка


class BidType(str, Enum):
    MINIMAL     = "MINIMAL"     # cpm_min (рынок * 1)
    COMPETITIVE = "COMPETITIVE" # cpm_min * 3.5
    LEADER      = "LEADER"      # cpm_min * 5.5


class DayType(str, Enum):
    WORKDAY         = "workday"         # пн–чт
    FRIDAY          = "friday"          # пт — часто повышенный трафик
    SATURDAY        = "saturday"
    SUNDAY          = "sunday"
    HOLIDAY         = "holiday"         # официальный праздник
    TRANSFERRED_OFF = "transferred_off" # перенесённый выходной
    PRE_HOLIDAY     = "pre_holiday"     # рабочий день перед праздником


# Соответствие уровня спроса → типу ставки
DEMAND_TO_BID: dict[DemandLevel, BidType] = {
    DemandLevel.LOW:    BidType.MINIMAL,
    DemandLevel.MEDIUM: BidType.COMPETITIVE,
    DemandLevel.HIGH:   BidType.LEADER,
}

# Коэффициенты к cpm_min для каждого типа ставки
BID_MULTIPLIERS: dict[BidType, float] = {
    BidType.MINIMAL:     1.0,
    BidType.COMPETITIVE: 3.5,
    BidType.LEADER:      5.5,
}


@dataclass
class HourProfile:
    """Уровень спроса для одного часа (0–23)."""
    hour: int
    demand: DemandLevel


@dataclass
class DayProfile:
    """Профиль спроса на один тип дня — 24 часа."""
    day_type: DayType
    hours: list[HourProfile]   # len == 24, индекс == час

    @classmethod
    def from_levels(cls, day_type: DayType, levels: list[DemandLevel]) -> "DayProfile":
        assert len(levels) == 24, "Нужно ровно 24 уровня спроса"
        return cls(
            day_type=day_type,
            hours=[HourProfile(h, levels[h]) for h in range(24)]
        )

    def demand_at(self, hour: int) -> DemandLevel:
        return self.hours[hour].demand


@dataclass
class CategoryProfile:
    """Профиль категории — набор профилей по типам дней."""
    category: str
    profiles: dict[DayType, DayProfile] = field(default_factory=dict)

    def get(self, day_type: DayType) -> DayProfile:
        if day_type in self.profiles:
            return self.profiles[day_type]
        # Запасные: праздник → воскресенье → суббота → будни
        fallbacks = {
            DayType.HOLIDAY:         [DayType.SUNDAY, DayType.SATURDAY, DayType.WORKDAY],
            DayType.TRANSFERRED_OFF: [DayType.SUNDAY, DayType.SATURDAY, DayType.WORKDAY],
            DayType.PRE_HOLIDAY:     [DayType.FRIDAY, DayType.WORKDAY],
            DayType.FRIDAY:          [DayType.WORKDAY],
            DayType.SATURDAY:        [DayType.SUNDAY, DayType.WORKDAY],
            DayType.SUNDAY:          [DayType.SATURDAY, DayType.WORKDAY],
            DayType.WORKDAY:         [],
        }
        for fb in fallbacks.get(day_type, []):
            if fb in self.profiles:
                return self.profiles[fb]
        # Финальный фолбэк: первый доступный
        return next(iter(self.profiles.values()))


@dataclass
class CampaignStrategyConfig:
    """Конфигурация стратегии для одной кампании (хранится в БД как JSON)."""
    campaign_id: int
    account_id: str
    category: str                           # ключ профиля, напр. "fertilizers_plants"
    cpm_min: int                            # минимум ставки рынка на момент настройки
    cpm_cap: int                            # жёсткий потолок ставки
    drr_threshold_pct: float = 15.0         # порог ДРР, %
    min_stock: int = 5                      # минимальный остаток
    budget_warning_pct: float = 80.0        # % использования бюджета для предупреждения
    budget_stop_pct: float = 95.0           # % использования бюджета для остановки
    dry_run: bool = True                    # если True — считать но не применять
    use_history: bool = True                # использовать ли исторические данные
    history_min_days: int = 14              # минимум дней истории для анализа
    enabled: bool = True


@dataclass
class RuntimeContext:
    """Текущий контекст для применения стратегии."""
    now_utc: object                   # datetime
    cpm_min: int                      # актуальный cpm_min рынка
    cpm_current: int                  # текущая ставка кампании
    budget_total: float               # общий бюджет
    budget_spent: float               # потрачено
    campaign_status: int              # статус WB (9=активна, и т.д.)
    stock_qty: int                    # общий остаток
    drr_last7: float                  # ДРР за последние 7 дней, %


@dataclass
class BidChangeLog:
    """Запись о применении/расчёте ставки (хранится в bid_change_log)."""
    campaign_id: int
    account_id: str
    computed_at: object               # datetime
    day_type: DayType
    hour: int
    demand_level: DemandLevel
    bid_type: BidType
    cpm_min: int
    cpm_target: int
    cpm_prev: int
    applied: bool
    dry_run: bool
    skip_reason: Optional[str] = None  # если не применили — почему


@dataclass
class WeeklySchedule:
    """Результат расчёта — расписание на неделю.

    schedule[day_type][hour] = DemandLevel
    Сериализуется в JSON и отдаётся фронтенду для тепловой карты.
    """
    category: str
    schedule: dict[str, list[str]] = field(default_factory=dict)  # day_type → [24 × DemandLevel]

    def get(self, day_type: DayType, hour: int) -> DemandLevel:
        row = self.schedule.get(day_type.value, [])
        if not row:
            return DemandLevel.LOW
        return DemandLevel(row[hour])

    def to_dict(self) -> dict:
        return {
            "category": self.category,
            "schedule": self.schedule,
        }
