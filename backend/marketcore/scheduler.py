"""Внутрипроцессный планировщик фоновых задач на APScheduler.

Каждые 15 минут обходит все включённые расписания:
  - Вычисляет целевую ставку (execute_schedule).
  - Если mode=dry_run — только пишет в rule_executions (без записи на WB).
  - Если mode=live — реально ставит CPM через WB Advert API (apply_to_wb).
  - При 3 ошибках подряд по одному расписанию — авто-пауза.

Без Redis и Celery. Работает прямо в процессе FastAPI.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from sqlalchemy import select

from marketcore.bidding.executor import evaluate_schedule
from marketcore.database import AsyncSessionLocal
from marketcore.models import Account, CampaignAutoSchedule, RuleExecution, Schedule

logger = logging.getLogger(__name__)

_session_factory = AsyncSessionLocal

_scheduler: AsyncIOScheduler | None = None

# Счётчик последовательных ошибок по каждому schedule_id.
# Сбрасывается при успешном тике. Хранится в памяти — ок для MVP.
_consecutive_failures: dict[str, int] = {}
MAX_CONSECUTIVE_FAILURES = 3


async def tick_bidding_schedules() -> None:
    """Однократный проход: вычислить ставку и залогировать (+ опционально применить)."""
    now = datetime.now(tz=timezone.utc)
    async with _session_factory() as session:
        schedules = list((await session.execute(select(Schedule))).scalars().all())

        if not schedules:
            logger.info("[bidding.tick] нет расписаний, пропуск")
            return

        logged = 0
        for sch in schedules:
            try:
                # Нормализуем schedule_json
                payload = sch.schedule_json
                if isinstance(payload, str):
                    import json as _json
                    payload = _json.loads(payload)
                if not isinstance(payload, dict):
                    logger.warning("[bidding.tick] schedule_id=%s: не dict, пропуск", sch.id)
                    continue

                # Авто-пауза при повторных ошибках (хранится в details предыдущих записей)
                sch_key = str(sch.id)
                if _consecutive_failures.get(sch_key, 0) >= MAX_CONSECUTIVE_FAILURES:
                    logger.warning(
                        "[bidding.tick] schedule_id=%s: авто-пауза после %d ошибок подряд",
                        sch.id, MAX_CONSECUTIVE_FAILURES,
                    )
                    continue

                result = evaluate_schedule(payload, now=now)
                mode = "dry_run" if payload.get("dryRun", True) else "live"

                # ── Если боевой режим и ставка посчитана — применяем ─────────
                apply_result = None
                if mode == "live" and result.status == "computed" and result.target_cpm > 0:
                    apply_result = await _apply_live(sch, payload, result, session)

                # Финальный статус строки в лог
                if apply_result is not None:
                    final_status = apply_result.status
                    final_reason = apply_result.reason
                    final_details = {**result.details, **apply_result.details}
                else:
                    final_status = result.status
                    final_reason = result.reason
                    final_details = result.details

                # Обновляем счётчик ошибок
                if final_status == "failed":
                    _consecutive_failures[sch_key] = _consecutive_failures.get(sch_key, 0) + 1
                    if _consecutive_failures[sch_key] >= MAX_CONSECUTIVE_FAILURES:
                        logger.error(
                            "[bidding.tick] schedule_id=%s: %d ошибок подряд — включаю авто-паузу",
                            sch.id, MAX_CONSECUTIVE_FAILURES,
                        )
                else:
                    _consecutive_failures.pop(sch_key, None)

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
                    status=final_status,
                    reason=final_reason[:500],
                    details=final_details,
                )
                session.add(row)
                logged += 1

            except Exception as exc:  # noqa: BLE001
                logger.exception("[bidding.tick] schedule_id=%s ошибка: %s", sch.id, exc)

        await session.commit()
        logger.info("[bidding.tick] залогировано %d из %d расписаний", logged, len(schedules))


async def _apply_live(sch: Schedule, payload: dict, result, session) -> object:
    """Расшифровать ключ аккаунта и вызвать applier."""
    from sqlalchemy import select as _select
    from marketcore.accounts.encryption import decrypt_api_key
    from marketcore.bidding.applier import apply_to_wb
    from marketcore.models import Account, RuleExecution

    account_id_str = result.account_id
    if not account_id_str:
        from marketcore.bidding.applier import ApplyResult
        return ApplyResult(
            success=False, status="guardrail",
            reason="Аккаунт не привязан к расписанию",
            details={},
        )

    import uuid
    acc = (await session.execute(
        _select(Account).where(Account.id == uuid.UUID(account_id_str))
    )).scalar_one_or_none()

    if acc is None:
        from marketcore.bidding.applier import ApplyResult
        return ApplyResult(
            success=False, status="failed",
            reason=f"Аккаунт {account_id_str} не найден в БД",
            details={},
        )

    # Последняя реально применённая ставка по этой кампании
    last_cpm: float | None = None
    last_exec = (await session.execute(
        _select(RuleExecution)
        .where(
            RuleExecution.schedule_id == sch.id,
            RuleExecution.status == "applied",
        )
        .order_by(RuleExecution.computed_at.desc())
        .limit(1)
    )).scalar_one_or_none()
    if last_exec is not None:
        last_cpm = last_exec.target_cpm

    # Для WB ставок используем рекламный ключ (если задан), иначе основной
    if acc.advert_api_key_cipher:
        api_key = decrypt_api_key(acc.advert_api_key_cipher)
    else:
        api_key = decrypt_api_key(acc.api_key_cipher)
    return await apply_to_wb(api_key, payload, result, last_applied_cpm=last_cpm)


async def refresh_campaign_names_cache() -> None:
    """Каждый час обновляет campaign_names для всех активных WB-аккаунтов.

    Идёт в WB Advert API и сохраняет свежие имена/статусы кампаний в БД.
    Так пользователь всегда видит актуальные имена без ручного нажатия «Обновить».
    """
    logger.info("[cache.campaign_names] запуск фонового обновления")
    from marketcore.accounts.encryption import decrypt_api_key
    from marketcore.ingestor.wb_client import WBClient
    from marketcore.api.routes.campaigns import _save_campaign_names_cache

    async with _session_factory() as session:
        accounts = list(
            (await session.execute(
                select(Account).where(Account.status == "active", Account.marketplace == "wb")
            )).scalars().all()
        )
        if not accounts:
            logger.info("[cache.campaign_names] нет активных WB-аккаунтов")
            return

        updated_total = 0
        for acc in accounts:
            try:
                advert_key = (
                    decrypt_api_key(acc.advert_api_key_cipher)
                    if acc.advert_api_key_cipher
                    else decrypt_api_key(acc.api_key_cipher)
                )
                client = WBClient(advert_key)
                campaigns = await client.list_campaigns(statuses=[7, 9, 11])
                await _save_campaign_names_cache(session, acc.id, campaigns)
                updated_total += len(campaigns)
                logger.debug("[cache.campaign_names] аккаунт %s: %d кампаний", acc.id, len(campaigns))
            except Exception as e:
                logger.warning("[cache.campaign_names] аккаунт %s: %s", acc.id, e)

        logger.info("[cache.campaign_names] обновлено %d записей по %d аккаунтам", updated_total, len(accounts))


async def refresh_sku_names_cache() -> None:
    """Раз в 24 часа обогащает sku_names граммовкой/объёмом для всех активных аккаунтов.

    Запускает enrich_sku_names_with_params — тянет параметры из публичного WB basket CDN.
    """
    logger.info("[cache.sku_names] запуск фонового обогащения")
    from marketcore.ingestor.db import enrich_sku_names_with_params

    async with _session_factory() as session:
        accounts = list(
            (await session.execute(
                select(Account).where(Account.status == "active", Account.marketplace == "wb")
            )).scalars().all()
        )
        if not accounts:
            return

        total = 0
        for acc in accounts:
            try:
                n = await enrich_sku_names_with_params(str(acc.id))
                total += n
            except Exception as e:
                logger.warning("[cache.sku_names] аккаунт %s: %s", acc.id, e)

        logger.info("[cache.sku_names] обогащено %d записей по %d аккаунтам", total, len(accounts))


async def apply_week_schedules(is_weekend: bool) -> None:
    """Пятница 22:00 UTC → weekend_hours; Понедельник 06:00 UTC → weekday_hours."""
    label = "выходные" if is_weekend else "будни"
    logger.info("[week_schedule] Применяю расписание: %s", label)

    async with _session_factory() as session:
        configs = list(
            (await session.execute(
                select(CampaignAutoSchedule).where(CampaignAutoSchedule.is_active == True)  # noqa: E712
            )).scalars().all()
        )

        if not configs:
            logger.info("[week_schedule] нет активных конфигов, пропуск")
            return

        from marketcore.accounts.encryption import decrypt_api_key
        from marketcore.ingestor.wb_client import WBClient

        for cfg in configs:
            try:
                acc = (await session.execute(
                    select(Account).where(Account.id == cfg.account_id)
                )).scalar_one_or_none()
                if not acc:
                    logger.warning("[week_schedule] аккаунт %s не найден, пропуск", cfg.account_id)
                    continue

                advert_key = (
                    decrypt_api_key(acc.advert_api_key_cipher)
                    if acc.advert_api_key_cipher
                    else decrypt_api_key(acc.api_key_cipher)
                )
                client = WBClient(advert_key)
                hours = cfg.weekend_hours if is_weekend else cfg.weekday_hours

                ok = 0
                for advert_id in (cfg.advert_ids or []):
                    try:
                        await client.set_campaign_hours(int(advert_id), hours)
                        ok += 1
                    except Exception as exc:
                        logger.warning("[week_schedule] кампания %s: %s", advert_id, exc)

                logger.info(
                    "[week_schedule] конфиг «%s» (%s): %d/%d кампаний обновлено",
                    cfg.name, label, ok, len(cfg.advert_ids or []),
                )
            except Exception as exc:
                logger.exception("[week_schedule] конфиг %s: %s", cfg.id, exc)


def start_scheduler() -> None:
    """Запустить APScheduler внутри текущего asyncio event loop."""
    global _scheduler
    if _scheduler is not None:
        return
    _scheduler = AsyncIOScheduler(timezone="UTC")
    _scheduler.add_job(
        tick_bidding_schedules,
        CronTrigger(minute="0,15,30,45"),
        id="bidding_tick",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
    )
    # Пятница 22:00 UTC → включить выходное расписание
    _scheduler.add_job(
        lambda: apply_week_schedules(True),
        CronTrigger(day_of_week="fri", hour=22, minute=0),
        id="weekend_schedule_on",
        replace_existing=True,
        max_instances=1,
    )
    # Понедельник 06:00 UTC → вернуть будничное расписание
    _scheduler.add_job(
        lambda: apply_week_schedules(False),
        CronTrigger(day_of_week="mon", hour=6, minute=0),
        id="weekday_schedule_on",
        replace_existing=True,
        max_instances=1,
    )
    # Кэш имён кампаний: каждый час для всех WB-аккаунтов
    _scheduler.add_job(
        refresh_campaign_names_cache,
        CronTrigger(minute=0),          # каждый час в 0 минут
        id="campaign_names_refresh",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
    )
    # Кэш имён SKU с граммовкой/объёмом: раз в сутки в 03:00 UTC
    _scheduler.add_job(
        refresh_sku_names_cache,
        CronTrigger(hour=3, minute=0),
        id="sku_names_refresh",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
    )
    _scheduler.start()
    logger.info(
        "[scheduler] APScheduler запущен "
        "(bidding 15мин | авто-расписание пт/пн | campaign_names 1ч | sku_names 24ч)"
    )


def stop_scheduler() -> None:
    global _scheduler
    if _scheduler is None:
        return
    _scheduler.shutdown(wait=False)
    _scheduler = None
    logger.info("[scheduler] APScheduler остановлен")
