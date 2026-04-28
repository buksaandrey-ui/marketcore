"""
Калькулятор ставок.

resolve_bid(demand, cpm_min, cpm_cap) → целевой CPM
apply_safeguards(ctx, config, target_cpm) → (final_cpm, skip_reason)

Гарантии (safeguards):
  1. Ставка не ниже cpm_min рынка
  2. Ставка не выше cpm_cap (жёсткий потолок)
  3. Если кампания неактивна → SKIP
  4. Если бюджет потрачен >= stop_pct → MINIMAL
  5. Если бюджет потрачен >= warning_pct → не повышать выше COMPETITIVE
  6. Если остаток < min_stock → MINIMAL (нет смысла гнать трафик)
  7. Если ДРР > drr_threshold → не повышать выше COMPETITIVE
  8. Ставка не меняется если разница < 5% (избегаем лишних вызовов API)
"""
from __future__ import annotations

import logging
from typing import Optional

from marketcore.strategy.models import (
    BID_MULTIPLIERS, DEMAND_TO_BID, BidType, CampaignStrategyConfig,
    DemandLevel, RuntimeContext,
)

logger = logging.getLogger(__name__)

# Статусы активной кампании WB
WB_ACTIVE_STATUSES = {4, 7, 9, 11}  # 9=активна, 4=готова, 7=завершена временно

# Минимальный порог изменения ставки в рублях, чтобы не триггерить API лишний раз
MIN_CPM_DELTA_RUB = 50


def resolve_bid(
    demand: DemandLevel,
    cpm_min: int,
    cpm_cap: int,
) -> int:
    """Базовый расчёт ставки по уровню спроса."""
    bid_type = DEMAND_TO_BID[demand]
    multiplier = BID_MULTIPLIERS[bid_type]
    raw = int(cpm_min * multiplier)
    # Не меньше минимума, не больше потолка
    return max(cpm_min, min(raw, cpm_cap))


def apply_safeguards(
    ctx: RuntimeContext,
    config: CampaignStrategyConfig,
    target_cpm: int,
    demand: DemandLevel,
) -> tuple[int, Optional[str]]:
    """
    Применяет защитные ограничения к целевой ставке.

    Returns:
        (final_cpm, skip_reason)
        skip_reason = None → применять ставку
        skip_reason = str  → пропустить применение с этой причиной
    """
    # 1. Кампания неактивна
    if ctx.campaign_status not in WB_ACTIVE_STATUSES:
        return target_cpm, f"campaign_inactive (status={ctx.campaign_status})"

    # 2. Критичное исчерпание бюджета → принудительно MINIMAL
    if ctx.budget_total > 0:
        budget_used_pct = ctx.budget_spent / ctx.budget_total * 100
        if budget_used_pct >= config.budget_stop_pct:
            minimal = resolve_bid(DemandLevel.LOW, ctx.cpm_min, config.cpm_cap)
            return minimal, f"budget_stop (used={budget_used_pct:.1f}%)"

        # 3. Предупреждение по бюджету → не выше COMPETITIVE
        if budget_used_pct >= config.budget_warning_pct:
            competitive = resolve_bid(DemandLevel.MEDIUM, ctx.cpm_min, config.cpm_cap)
            target_cpm = min(target_cpm, competitive)

    # 4. Мало остатков → MINIMAL
    if ctx.stock_qty < config.min_stock:
        minimal = resolve_bid(DemandLevel.LOW, ctx.cpm_min, config.cpm_cap)
        return minimal, f"low_stock (qty={ctx.stock_qty}, min={config.min_stock})"

    # 5. Высокий ДРР → не выше COMPETITIVE
    if ctx.drr_last7 > config.drr_threshold_pct and demand == DemandLevel.HIGH:
        competitive = resolve_bid(DemandLevel.MEDIUM, ctx.cpm_min, config.cpm_cap)
        target_cpm = min(target_cpm, competitive)
        logger.debug(
            "safeguard drr: %.1f%% > %.1f%% → capped at COMPETITIVE %d",
            ctx.drr_last7, config.drr_threshold_pct, target_cpm
        )

    # 6. Финальные границы
    target_cpm = max(ctx.cpm_min, min(target_cpm, config.cpm_cap))

    # 7. Незначимое изменение — не дёргаем API
    delta = abs(target_cpm - ctx.cpm_current)
    if delta < MIN_CPM_DELTA_RUB:
        return ctx.cpm_current, f"no_change (delta={delta} < {MIN_CPM_DELTA_RUB})"

    return target_cpm, None
