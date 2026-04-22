import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from marketcore.analytics.localization import LIZone, LocalizationService
from marketcore.auth.dependencies import get_current_user
from marketcore.database import get_db
from marketcore.models import Account, AdStat, Order, SkuStock, User

router = APIRouter(prefix="/analytics", tags=["analytics"])


class LocalizationResponse(BaseModel):
    li: float
    zone: LIZone
    total_units: int
    orders_count: int
    recommendations: list[str]


async def _ensure_account_owned(db: AsyncSession, account_id: str, user_id: uuid.UUID) -> Account:
    result = await db.execute(select(Account).where(Account.id == uuid.UUID(account_id)))
    account = result.scalar_one_or_none()
    if account is None or account.user_id != user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Аккаунт не найден")
    return account


@router.get("/localization", response_model=LocalizationResponse)
async def get_localization(
    account_id: str = Query(...),
    sku: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> LocalizationResponse:
    await _ensure_account_owned(db, account_id, current_user.id)
    service = LocalizationService(db)
    result = await (service.get_sku_li(account_id, sku) if sku else service.get_account_li(account_id))
    if result is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Недостаточно данных: нужно минимум 30 дней продаж с заполненным ФО",
        )
    recs = await service.recommendations(account_id, sku) if sku else []
    return LocalizationResponse(
        li=result.li,
        zone=result.zone,
        total_units=result.total_units,
        orders_count=result.orders_count,
        recommendations=recs,
    )


@router.post("/localization/refresh", status_code=status.HTTP_204_NO_CONTENT)
async def refresh_localization(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    await LocalizationService(db).refresh()


@router.get("/dashboard")
async def get_dashboard_summary(
    days: int = Query(30),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    accounts_result = await db.execute(
        select(Account).where(Account.user_id == current_user.id, Account.status == "active")
    )
    accounts = list(accounts_result.scalars().all())
    if not accounts:
        return {"has_data": False, "accounts": []}

    account_ids = [a.id for a in accounts]
    date_from = datetime.now(timezone.utc) - timedelta(days=days)

    orders_row = (await db.execute(
        select(
            func.count(Order.id).label("cnt"),
            func.coalesce(func.sum(Order.price * Order.quantity), 0).label("orders_sum"),
        ).where(Order.account_id.in_(account_ids), Order.ordered_at >= date_from)
    )).one()

    ad_spend = float((await db.execute(
        select(func.coalesce(func.sum(AdStat.spend), 0)).where(
            AdStat.account_id.in_(account_ids), AdStat.stat_date >= date_from
        )
    )).scalar_one())

    stock_rows = (await db.execute(
        select(Order.sku, func.count(Order.id).label("cnt"), func.sum(Order.price * Order.quantity).label("revenue"))
        .where(Order.account_id.in_(account_ids), Order.ordered_at >= date_from)
        .group_by(Order.sku)
        .order_by(func.sum(Order.price * Order.quantity).desc())
        .limit(20)
    )).all()

    orders_sum = float(orders_row.orders_sum)
    revenue = orders_sum * 0.88
    drr_to_orders = (ad_spend / orders_sum * 100) if orders_sum > 0 else 0
    drr_to_revenue = (ad_spend / revenue * 100) if revenue > 0 else 0

    return {
        "has_data": True,
        "accounts": [{"id": str(a.id), "name": a.name, "marketplace": a.marketplace, "last_sync_at": a.last_sync_at.isoformat() if a.last_sync_at else None} for a in accounts],
        "orders_count": int(orders_row.cnt),
        "orders_sum": orders_sum,
        "revenue": revenue,
        "ad_spend": ad_spend,
        "drr_to_orders": round(drr_to_orders, 1),
        "drr_to_revenue": round(drr_to_revenue, 1),
        "top_skus": [{"sku": r.sku, "orders_count": r.cnt, "revenue": float(r.revenue)} for r in stock_rows],
    }
