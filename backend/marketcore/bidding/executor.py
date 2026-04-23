"""Schedule Executor — превращает сетку расписания в целевую ставку на ТЕКУЩИЙ момент.

Вход: schedule_json (то что сохраняет ScheduleGrid на фронте)
Выход: ExecutionResult — что должно быть установлено ПРЯМО СЕЙЧАС, с объяснением.

На Неделе 1 только ВЫЧИСЛЯЕМ и ЛОГИРУЕМ. Запись на площадку добавим на Неделе 2.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from typing import Any

# Московский часовой пояс — расписание нарисовано по МСК
MOSCOW = timezone(timedelta(hours=3))


@dataclass
class ExecutionResult:
    status: str                      # computed | skipped
    reason: str                      # человекочитаемое объяснение
    platform: str = "wb"
    pay_model: str = "cpm"
    base_cpm: float = 0.0
    multiplier_pct: int = 0
    target_cpm: float = 0.0
    account_id: str | None = None
    details: dict[str, Any] = field(default_factory=dict)


def evaluate_schedule(
    schedule_json: dict[str, Any],
    now: datetime | None = None,
) -> ExecutionResult:
    """Посчитать что должно быть сейчас для данного расписания.

    Никаких побочных эффектов — чистая функция.
    """
    # 0. Нормализуем now к московскому времени (сетка в МСК)
    if now is None:
        now = datetime.now(tz=timezone.utc)
    msk = now.astimezone(MOSCOW)

    platform = str(schedule_json.get("platform", "wb"))
    pay_model = str(schedule_json.get("payModel", "cpm"))
    base_cpm = float(schedule_json.get("baseCpm", 0))
    account_id = schedule_json.get("accountId") or None

    # 1. Включено ли расписание?
    if not schedule_json.get("enabled", True):
        return ExecutionResult(
            status="skipped",
            reason="Расписание выключено",
            platform=platform, pay_model=pay_model, base_cpm=base_cpm,
            account_id=account_id,
        )

    # 2. Период действия
    if not schedule_json.get("periodUnlimited", True):
        period_from = schedule_json.get("periodFrom")
        period_to = schedule_json.get("periodTo")
        today = msk.date().isoformat()
        if period_from and today < period_from:
            return ExecutionResult(
                status="skipped",
                reason=f"Период ещё не начался (с {period_from})",
                platform=platform, pay_model=pay_model, base_cpm=base_cpm,
                account_id=account_id,
            )
        if period_to and today > period_to:
            return ExecutionResult(
                status="skipped",
                reason=f"Период закончился ({period_to})",
                platform=platform, pay_model=pay_model, base_cpm=base_cpm,
                account_id=account_id,
            )

    # 3. Читаем сетку 7×24 (пн=0..вс=6)
    grid = schedule_json.get("grid")
    if not isinstance(grid, list) or len(grid) != 7:
        return ExecutionResult(
            status="skipped",
            reason="Сетка расписания невалидна (нет 7 дней)",
            platform=platform, pay_model=pay_model, base_cpm=base_cpm,
            account_id=account_id,
        )

    # ISO weekday: Пн=1..Вс=7 → массив Пн=0..Вс=6
    day_idx = msk.weekday()
    hour_idx = msk.hour

    try:
        row = grid[day_idx]
        multiplier_pct = int(row[hour_idx])
    except (IndexError, TypeError, ValueError):
        return ExecutionResult(
            status="skipped",
            reason="Не удалось прочитать ячейку расписания",
            platform=platform, pay_model=pay_model, base_cpm=base_cpm,
            account_id=account_id,
        )

    # 4. Счёт целевой ставки
    target = round(base_cpm * multiplier_pct / 100.0, 2)

    # Если 0% — реклама выключена на этот час
    if multiplier_pct == 0:
        return ExecutionResult(
            status="computed",
            reason=f"Ячейка 0% — реклама выключена в этот час ({_day_label(day_idx)} {hour_idx}:00 МСК)",
            platform=platform, pay_model=pay_model, base_cpm=base_cpm,
            multiplier_pct=0, target_cpm=0.0,
            account_id=account_id,
            details={"day": day_idx, "hour": hour_idx, "moscow_time": msk.isoformat()},
        )

    return ExecutionResult(
        status="computed",
        reason=f"{_day_label(day_idx)} {hour_idx}:00 МСК → множитель {multiplier_pct}% × база {base_cpm}₽",
        platform=platform, pay_model=pay_model, base_cpm=base_cpm,
        multiplier_pct=multiplier_pct, target_cpm=target,
        account_id=account_id,
        details={"day": day_idx, "hour": hour_idx, "moscow_time": msk.isoformat()},
    )


def _day_label(idx: int) -> str:
    return ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"][idx]
