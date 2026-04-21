from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


class LIZone(str, Enum):
    ELITE = "elite"
    GREEN = "green"
    YELLOW = "yellow"
    RED = "red"


@dataclass
class LIResult:
    li: float
    zone: LIZone
    total_units: int
    orders_count: int
    calculated_at: datetime


def classify_zone(li: float) -> LIZone:
    if li > 0.85:
        return LIZone.ELITE
    if li > 0.65:
        return LIZone.GREEN
    if li > 0.40:
        return LIZone.YELLOW
    return LIZone.RED


class LocalizationService:
    def __init__(self, db: AsyncSession) -> None:
        self._db = db

    async def get_account_li(self, account_id: str) -> LIResult | None:
        row = (
            await self._db.execute(
                text(
                    "SELECT li, total_units, orders_count "
                    "FROM mv_localization_index "
                    "WHERE account_id = :aid AND level = 'account'"
                ),
                {"aid": account_id},
            )
        ).first()
        return self._build(row)

    async def get_sku_li(self, account_id: str, sku: str) -> LIResult | None:
        row = (
            await self._db.execute(
                text(
                    "SELECT li, total_units, orders_count "
                    "FROM mv_localization_index "
                    "WHERE account_id = :aid AND level = 'sku' AND entity_id = :sku"
                ),
                {"aid": account_id, "sku": sku},
            )
        ).first()
        return self._build(row)

    async def top_regions_by_demand(self, account_id: str, sku: str, limit: int = 3) -> list[dict]:
        rows = (
            await self._db.execute(
                text(
                    "SELECT customer_district AS district, SUM(quantity)::bigint AS units "
                    "FROM orders "
                    "WHERE account_id = :aid AND sku = :sku "
                    "  AND ordered_at > NOW() - INTERVAL '30 days' "
                    "  AND customer_district IS NOT NULL "
                    "GROUP BY customer_district "
                    "ORDER BY units DESC LIMIT :lim"
                ),
                {"aid": account_id, "sku": sku, "lim": limit},
            )
        ).mappings().all()
        return [dict(r) for r in rows]

    async def recommendations(self, account_id: str, sku: str) -> list[str]:
        result = await self.get_sku_li(account_id, sku)
        if result is None:
            return ["Недостаточно данных для анализа (нужно минимум 30 дней продаж)."]

        recs: list[str] = []
        if result.zone == LIZone.RED:
            top = await self.top_regions_by_demand(account_id, sku)
            top_str = ", ".join(r["district"] for r in top) or "нет данных"
            recs.append(f"ИЛ критично низкий ({result.li:.0%}). Топ-3 ФО по спросу: {top_str}.")
            recs.append("Рекомендация: добавить склад в ЦФО или ПФО.")
            recs.append("Ожидаемый эффект: –35-50% логистики, +20% CR.")
        elif result.zone == LIZone.YELLOW:
            recs.append(f"ИЛ ниже целевого ({result.li:.0%} vs target 65%).")
            recs.append("При следующей поставке перераспределите 30% в ФО с высоким спросом.")
        elif result.zone == LIZone.GREEN:
            recs.append(f"ИЛ в хорошей зоне ({result.li:.0%}). Можно выжать ещё +10-15% перераспределением.")
        else:
            recs.append(f"ИЛ элитный ({result.li:.0%}). Поддерживайте текущее распределение.")
        return recs

    async def refresh(self) -> None:
        """Refresh the materialized view. Should be called periodically (hourly)."""
        await self._db.execute(text("REFRESH MATERIALIZED VIEW mv_localization_index"))
        await self._db.commit()

    @staticmethod
    def _build(row: tuple | None) -> LIResult | None:
        if not row or row[0] is None:
            return None
        li = float(row[0])
        return LIResult(
            li=li,
            zone=classify_zone(li),
            total_units=int(row[1]),
            orders_count=int(row[2]),
            calculated_at=datetime.now(timezone.utc),
        )
