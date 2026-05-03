"""
Единый модуль бизнес-формул MarketCore.

Принцип: каждый расчёт — ровно в одном месте.
Все остальные модули импортируют отсюда, а не дублируют логику.

Эталонный словарь (из OPTIMIZATION_PLAN.md):
  orders_sum      = Σ(finishedPrice × (1−spp/100) × qty)
  revenue         = orders_sum (для WB)
  ad_spend        = Σ(AdStat.spend) за период
  payout_sum      = ppvz_for_pay за 90 дней
  drr_to_orders   = ad_spend / orders_sum × 100
  drr_to_revenue  = ad_spend / revenue × 100
  drr_to_payouts  = ad_spend / payout_sum × 100
  real_drr        = drr_to_payouts если есть, иначе drr_to_revenue
"""
from __future__ import annotations

from typing import Optional


# ─── Цена покупателя ──────────────────────────────────────────────────────────

def buyer_paid(finished_price: float, spp: float = 0.0, qty: int = 1) -> float:
    """Сколько реально заплатил покупатель = finishedPrice × (1 − spp/100) × qty.

    WB API: finishedPrice = цена после скидки продавца, но до СПП.
    СПП (субсидия WB покупателю) вычитается отдельно.
    """
    spp_mult = (1 - spp / 100) if spp > 0 else 1.0
    return round(float(finished_price) * spp_mult * int(qty), 2)


# ─── ДРР ─────────────────────────────────────────────────────────────────────

def drr(ad_spend: float, denominator: float) -> Optional[float]:
    """ДРР (Доля Рекламных Расходов) = ad_spend / denominator × 100.

    Возвращает None если знаменатель = 0 (нет выручки/заказов/начислений).
    Никогда не возвращает 0 вместо None — это семантически разные значения.
    """
    if denominator <= 0:
        return None
    return round(ad_spend / denominator * 100, 1)


def drr_to_orders(ad_spend: float, orders_sum: float) -> Optional[float]:
    """ДРР к заказам = ad_spend / orders_sum × 100."""
    return drr(ad_spend, orders_sum)


def drr_to_revenue(ad_spend: float, revenue: float) -> Optional[float]:
    """ДРР к выручке = ad_spend / revenue × 100.
    Для WB revenue = orders_sum (finishedPrice учитывает СПП).
    """
    return drr(ad_spend, revenue)


def drr_to_payouts(ad_spend: float, payout_sum: Optional[float]) -> Optional[float]:
    """ДРР к начислениям = ad_spend / payout_sum × 100.
    payout_sum = ppvz_for_pay (что реально получит продавец).
    Возвращает None если payout_sum отсутствует или = 0.
    """
    if payout_sum is None:
        return None
    return drr(ad_spend, payout_sum)


def real_drr(
    ad_spend: float,
    payout_sum: Optional[float],
    revenue: float,
) -> Optional[float]:
    """«Реальный ДРР» — лучшая метрика для продавца.

    Приоритет:
      1. ДРР к начислениям (payout_sum) — точнее всего, но данные раз в неделю
      2. ДРР к выручке (revenue)         — всегда доступен

    Возвращает None только если нет ни payout_sum ни revenue.
    """
    p = drr_to_payouts(ad_spend, payout_sum)
    if p is not None:
        return p
    return drr_to_revenue(ad_spend, revenue)


# ─── Дополнительные метрики ───────────────────────────────────────────────────

def amount_to_pay(orders_sum: float, ad_spend: float) -> float:
    """Приблизительная сумма к получению = выручка − реклама.
    Не учитывает комиссию WB и логистику (они в отдельном финотчёте).
    """
    return round(orders_sum - ad_spend, 2)


def drr_all_costs(total_costs: float, revenue: float) -> Optional[float]:
    """Общий ДРР = (реклама + WB-услуги) / выручка × 100.
    Используется в /campaigns/overall-drr.
    """
    return drr(total_costs, revenue)
