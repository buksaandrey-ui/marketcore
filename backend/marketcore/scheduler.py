"""Внутрипроцессный планировщик фоновых задач на APScheduler.

На Неделе 1 делает одно: каждые 15 минут обходит все включённые расписания
и записывает в rule_executions, какая ставка должна быть сейчас. Реальной
записи в WB/Ozon ЕЩЁ НЕТ — это задача Недели 2.

Без Redis и Celery. Планировщик живёт прямо в процессе FastAPI.
Для MVP этого достаточно. Когда нагрузка вырастет — вынесем в отдельный воркер.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from marketcore.bidding.executor import evaluate_schedule
from marketcore.config import settings
from marketcore.models import RuleExecution, Schedule

logger = logging.getLogger(__name__)

_engine = create_async_engine(settings.database_url)
_session_factory = async_sessionmaker(_engine, expire_on_commit=False)

_scheduler: AsyncIOScheduler | None = None


async def tick_bidding_schedules() -> None:
    """Однократный проход по всем расписаниям: вычислить целевую ставку и залогировать."""
    now = datetime.now(tz=timezone.utc)
    async with _session_factory() as session:
        schedules = list((await session.execute(select(Schedule))).scalars().all())

        if not schedules:
            logger.info("[bidding.tick] нет расписаний, пропуск")
            return

        logged = 0
        for sch in schedules:
            try:
                # schedule_json может быть сохранён как строка или как dict — нормализуем
                payload = sch.schedule_json
                if isinstance(payload, str):
                    import json as _json
                    payload = _json.loads(payload)
                if not isinstance(payload, dict):
                    logger.warning(
                        "[bidding.tick] schedule_id=%s: не dict, пропуск", sch.id
                    )
                    continue

                result = evaluate_schedule(payload, now=now)

                # Режим из расписания: если dryRun=False → mode=live (на Неделе 1
                # мы всё равно только логируем, но уважаем поле чтобы фронт видел намерение)
                mode = "dry_run" if payload.get("dryRun", True) else "live"

                row = RuleExecution(
                    user_id=sch.user_id,
                    schedule_id=sch.id,
                    account_id=(
                        __import__("uuid").UUID(result.account_id)
                        if result.account_id else None
                    ),
                    computed_at=now,
                    platform=result.platform,
                    pay_model=result.pay_model,
                    base_cpm=result.base_cpm,
                    multiplier_pct=result.multiplier_pct,
                    target_cpm=result.target_cpm,
                    mode=mode,
                    status=result.status,
                    reason=result.reason[:500],
                    details=result.details,
                )
                session.add(row)
                logged += 1
            except Exception as exc:  # noqa: BLE001 — логируем и идём дальше
                logger.exception(
                    "[bidding.tick] schedule_id=%s ошибка: %s", sch.id, exc
                )

        await session.commit()
        logger.info("[bidding.tick] залогировано %d из %d расписаний", logged, len(schedules))


def start_scheduler() -> None:
    """Запустить APScheduler внутри текущего asyncio event loop."""
    global _scheduler
    if _scheduler is not None:
        return
    _scheduler = AsyncIOScheduler(timezone="UTC")
    # Каждые 15 минут: :00, :15, :30, :45
    _scheduler.add_job(
        tick_bidding_schedules,
        CronTrigger(minute="0,15,30,45"),
        id="bidding_tick",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
    )
    _scheduler.start()
    logger.info("[scheduler] APScheduler запущен (каждые 15 минут)")


def stop_scheduler() -> None:
    global _scheduler
    if _scheduler is None:
        return
    _scheduler.shutdown(wait=False)
    _scheduler = None
    logger.info("[scheduler] APScheduler остановлен")
