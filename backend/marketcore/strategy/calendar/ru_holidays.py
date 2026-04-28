"""
Российский производственный календарь.

Загружает данные из holidays_config.json рядом с этим файлом.
Метод classify(date) → DayType.
Метод get_holiday_block(date) → список дат непрерывного праздничного блока.
"""
from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

from marketcore.strategy.models import DayType

_CONFIG_PATH = Path(__file__).parent / "holidays_config.json"


def _load_config() -> dict:
    with open(_CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


class RuHolidayCalendar:
    """Кэширует конфиг при создании экземпляра."""

    def __init__(self) -> None:
        cfg = _load_config()
        self._holidays: set[date] = {
            date.fromisoformat(d) for d in cfg.get("holidays", [])
        }
        self._transferred_off: set[date] = {
            date.fromisoformat(d) for d in cfg.get("transferred_off", [])
        }
        self._pre_holiday: set[date] = {
            date.fromisoformat(d) for d in cfg.get("pre_holiday", [])
        }

    def classify(self, d: date) -> DayType:
        if d in self._holidays:
            return DayType.HOLIDAY
        if d in self._transferred_off:
            return DayType.TRANSFERRED_OFF
        if d in self._pre_holiday:
            return DayType.PRE_HOLIDAY
        weekday = d.weekday()  # 0=пн, 5=сб, 6=вс
        if weekday == 6:
            return DayType.SUNDAY
        if weekday == 5:
            return DayType.SATURDAY
        if weekday == 4:
            return DayType.FRIDAY
        return DayType.WORKDAY

    def is_off(self, d: date) -> bool:
        """Выходной или праздник?"""
        return self.classify(d) in (
            DayType.HOLIDAY, DayType.TRANSFERRED_OFF,
            DayType.SATURDAY, DayType.SUNDAY
        )

    def get_holiday_block(self, d: date) -> list[date]:
        """Возвращает непрерывный блок нерабочих дней, в который входит d.
        Если d — рабочий день, возвращает [d].
        """
        if not self.is_off(d):
            return [d]

        # Идём назад до начала блока
        start = d
        while self.is_off(start - timedelta(days=1)):
            start -= timedelta(days=1)

        # Идём вперёд до конца блока
        end = d
        while self.is_off(end + timedelta(days=1)):
            end += timedelta(days=1)

        block = []
        cur = start
        while cur <= end:
            block.append(cur)
            cur += timedelta(days=1)
        return block


# Singleton — один экземпляр на весь процесс
calendar = RuHolidayCalendar()
