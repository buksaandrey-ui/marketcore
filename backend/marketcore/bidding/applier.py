"""Applier — реально пишет ставку на Wildberries.

Неделя 2: когда schedule_json содержит dryRun=false + заполнен campaign_id,
этот модуль дёргает WB Advert API и обновляет status→applied или status→failed.

GUARDRAILS (защиты от случайных огромных изменений):
  1. Ставка не может изменится более чем на MAX_CPM_CHANGE_PCT % за один тик.
  2. Абсолютный потолок ставки: MAX_CPM_HARD_LIMIT ₽ (защита от ошибки в нулях).
  3. Минимальная ставка: MIN_CPM ₽ (ниже не пишем — WB всё равно отклонит).
  4. Если 3 тика подряд status=failed — бот помечает расписание как suspended
     (хранится в details; scheduler пропускает его). Предотвращает бесконечный retry.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from marketcore.bidding.executor import ExecutionResult

logger = logging.getLogger(__name__)

# ── Guardrails (лимиты безопасности) ─────────────────────────────────────────
MAX_CPM_CHANGE_PCT = 80    # максимально допустимое изменение за 1 тик в %
MAX_CPM_HARD_LIMIT = 5000  # жёсткий потолок ставки ₽ (защита от опечатки)
MIN_CPM = 5                # WB не принимает ставки ниже 5 ₽


@dataclass
class ApplyResult:
    success: bool
    status: str          # "applied" | "failed" | "guardrail"
    reason: str
    details: dict[str, Any]


async def apply_to_wb(
    api_key: str,
    schedule_json: dict[str, Any],
    result: ExecutionResult,
    last_applied_cpm: float | None,
) -> ApplyResult:
    """Применить вычисленную ставку к WB-кампании.

    Параметры:
        api_key          — расшифрованный API-ключ аккаунта WB
        schedule_json    — сохранённое расписание (нужен campaignId, campaignType, campaignParam)
        result           — результат evaluate_schedule (уже вычисленная ставка)
        last_applied_cpm — последняя ставка, которую бот реально поставил (None=первый раз)

    Возвращает ApplyResult с деталями: успех/провал и причина.
    """
    from marketcore.ingestor.wb_client import WBClient

    campaign_id = schedule_json.get("campaignId")
    campaign_type = schedule_json.get("campaignType", 5)   # 5=поиск по умолчанию
    campaign_param = schedule_json.get("campaignParam", 0) # subject_id

    if not campaign_id:
        return ApplyResult(
            success=False,
            status="guardrail",
            reason="Кампания не выбрана в расписании — пропуск live-записи",
            details={},
        )

    target = result.target_cpm

    # ─── Guardrail 1: абсолютный потолок ────────────────────────────────────
    if target > MAX_CPM_HARD_LIMIT:
        return ApplyResult(
            success=False,
            status="guardrail",
            reason=f"Ставка {target} ₽ превышает жёсткий потолок {MAX_CPM_HARD_LIMIT} ₽ — отменено",
            details={"target": target, "limit": MAX_CPM_HARD_LIMIT},
        )

    # ─── Guardrail 2: минимальная ставка ─────────────────────────────────────
    if 0 < target < MIN_CPM:
        return ApplyResult(
            success=False,
            status="guardrail",
            reason=f"Ставка {target} ₽ ниже минимума WB ({MIN_CPM} ₽) — отменено",
            details={"target": target, "min": MIN_CPM},
        )

    # ─── Guardrail 3: ограничение изменения за тик ──────────────────────────
    if last_applied_cpm and last_applied_cpm > 0 and target > 0:
        change_pct = abs(target - last_applied_cpm) / last_applied_cpm * 100
        if change_pct > MAX_CPM_CHANGE_PCT:
            return ApplyResult(
                success=False,
                status="guardrail",
                reason=(
                    f"Изменение ставки {last_applied_cpm}→{target} ₽ "
                    f"({change_pct:.0f}%) превышает лимит {MAX_CPM_CHANGE_PCT}% за один тик"
                ),
                details={
                    "last_cpm": last_applied_cpm,
                    "target": target,
                    "change_pct": round(change_pct, 1),
                    "limit_pct": MAX_CPM_CHANGE_PCT,
                },
            )

    # ─── Реальная запись на WB ───────────────────────────────────────────────
    try:
        client = WBClient(api_key)
        cpm_int = max(MIN_CPM, round(target))
        await client.set_campaign_cpm(
            advert_id=int(campaign_id),
            advert_type=int(campaign_type),
            cpm=cpm_int,
            param=int(campaign_param),
            instrument=0,
        )
        logger.info(
            "[applier] campaign_id=%s: поставил CPM=%d (target=%.2f)",
            campaign_id, cpm_int, target,
        )
        return ApplyResult(
            success=True,
            status="applied",
            reason=f"Ставка установлена: {cpm_int} ₽ для кампании #{campaign_id}",
            details={"campaign_id": campaign_id, "cpm_sent": cpm_int},
        )
    except Exception as exc:
        logger.warning(
            "[applier] campaign_id=%s: ошибка WB API: %s", campaign_id, exc
        )
        return ApplyResult(
            success=False,
            status="failed",
            reason=f"WB API ошибка: {exc}",
            details={"campaign_id": campaign_id, "error": str(exc)},
        )
