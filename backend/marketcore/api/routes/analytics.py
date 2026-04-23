import uuid
from datetime import datetime, date, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import func, select, text
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


async def _get_user_account_ids(db: AsyncSession, user_id: uuid.UUID) -> list:
    res = await db.execute(
        select(Account.id).where(Account.user_id == user_id, Account.status == "active")
    )
    return [r[0] for r in res.all()]


def _period_range(period: str, date_from_str: str | None, date_to_str: str | None) -> tuple[datetime, datetime]:
    now = datetime.now(timezone.utc)
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    if period == "today":
        return today, now
    if period == "yesterday":
        return today - timedelta(days=1), today
    if period == "week":
        return today - timedelta(days=7), now
    if period == "month":
        return today - timedelta(days=30), now
    if period == "quarter":
        return today - timedelta(days=90), now
    if period == "custom" and date_from_str and date_to_str:
        df = datetime.fromisoformat(date_from_str).replace(tzinfo=timezone.utc)
        dt = datetime.fromisoformat(date_to_str).replace(tzinfo=timezone.utc) + timedelta(days=1)
        return df, dt
    return today - timedelta(days=30), now


@router.get("/orders/heatmap")
async def orders_heatmap(
    days: int = Query(30),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    account_ids = await _get_user_account_ids(db, current_user.id)
    if not account_ids:
        return {"has_data": False, "matrix": [[0] * 24 for _ in range(7)], "max_val": 0}

    date_from = datetime.now(timezone.utc) - timedelta(days=days)
    rows = (await db.execute(
        text("""
            SELECT
                ((EXTRACT(DOW FROM ordered_at AT TIME ZONE 'Europe/Moscow')::int + 6) % 7) AS dow,
                EXTRACT(HOUR FROM ordered_at AT TIME ZONE 'Europe/Moscow')::int AS hr,
                COUNT(*) AS cnt
            FROM orders
            WHERE account_id = ANY(:ids) AND ordered_at >= :df
            GROUP BY 1, 2
        """),
        {"ids": account_ids, "df": date_from},
    )).all()

    matrix = [[0] * 24 for _ in range(7)]
    for r in rows:
        matrix[int(r.dow)][int(r.hr)] = int(r.cnt)
    max_val = max((matrix[d][h] for d in range(7) for h in range(24)), default=1)
    return {"has_data": True, "matrix": matrix, "max_val": max_val}


@router.get("/report")
async def sales_report(
    period: str = Query("week"),
    date_from_str: str | None = Query(None, alias="date_from"),
    date_to_str: str | None = Query(None, alias="date_to"),
    sku: str | None = Query(None),
    category: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    account_ids = await _get_user_account_ids(db, current_user.id)
    if not account_ids:
        return {"has_data": False}

    df, dt = _period_range(period, date_from_str, date_to_str)

    # Base order filter
    order_filter = [Order.account_id.in_(account_ids), Order.ordered_at >= df, Order.ordered_at < dt]
    ad_filter = [AdStat.account_id.in_(account_ids), AdStat.stat_date >= df.date(), AdStat.stat_date < dt.date()]
    stock_filter = [SkuStock.account_id.in_(account_ids)]

    if sku:
        order_filter.append(Order.sku == sku)
        ad_filter.append(AdStat.sku == sku)
        stock_filter.append(SkuStock.sku == sku)

    # Totals
    totals = (await db.execute(
        select(
            func.coalesce(func.sum(Order.quantity), 0).label("units"),
            func.coalesce(func.sum(Order.price * Order.quantity), 0).label("orders_sum"),
        ).where(*order_filter)
    )).one()

    ad_spend = float((await db.execute(
        select(func.coalesce(func.sum(AdStat.spend), 0)).where(*ad_filter)
    )).scalar_one())

    # By warehouse (orders)
    wh_rows = (await db.execute(
        select(Order.warehouse, func.sum(Order.quantity).label("units"), func.sum(Order.price * Order.quantity).label("sum"))
        .where(*order_filter)
        .group_by(Order.warehouse)
        .order_by(func.sum(Order.quantity).desc())
    )).all()

    # Stock by warehouse — use only the latest snapshot per account
    # (each sync replaces the snapshot, but as a safety guard we take MAX recorded_at)
    latest_recorded = (
        select(func.max(SkuStock.recorded_at))
        .where(*stock_filter)
        .scalar_subquery()
    )
    stock_rows = (await db.execute(
        select(SkuStock.warehouse, func.sum(SkuStock.quantity).label("qty"))
        .where(*stock_filter, SkuStock.recorded_at == latest_recorded)
        .group_by(SkuStock.warehouse)
        .order_by(func.sum(SkuStock.quantity).desc())
    )).all()

    # Per-SKU breakdown
    sku_rows = (await db.execute(
        select(
            Order.sku,
            func.sum(Order.quantity).label("units"),
            func.sum(Order.price * Order.quantity).label("orders_sum"),
        )
        .where(*order_filter)
        .group_by(Order.sku)
        .order_by(func.sum(Order.price * Order.quantity).desc())
        .limit(50)
    )).all()

    orders_sum = float(totals.orders_sum)
    units = int(totals.units)
    buyout_sum = orders_sum * 0.88          # ~12% возвратов по умолчанию
    wb_services = orders_sum * 0.05         # ~5% хранение + логистика (оценка)
    amount_to_pay = buyout_sum - wb_services - ad_spend
    real_drr = (ad_spend / buyout_sum * 100) if buyout_sum > 0 else 0

    return {
        "has_data": True,
        "period": {"from": df.date().isoformat(), "to": (dt - timedelta(days=1)).date().isoformat()},
        "units": units,
        "orders_sum": round(orders_sum, 2),
        "buyout_sum": round(buyout_sum, 2),
        "wb_services": round(wb_services, 2),
        "ad_spend": round(ad_spend, 2),
        "amount_to_pay": round(amount_to_pay, 2),
        "real_drr": round(real_drr, 1),
        "by_warehouse": [{"warehouse": r.warehouse or "Неизвестно", "units": int(r.units), "sum": float(r.sum)} for r in wh_rows],
        "stock_by_warehouse": [{"warehouse": r.warehouse or "Неизвестно", "qty": int(r.qty)} for r in stock_rows],
        "by_sku": [{"sku": r.sku, "units": int(r.units), "orders_sum": float(r.orders_sum)} for r in sku_rows],
    }
