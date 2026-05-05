import uuid
from datetime import datetime, date, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from marketcore.analytics.formulas import (
    drr_to_orders as _drr_orders,
    drr_to_revenue as _drr_revenue,
    drr_to_payouts as _drr_payouts,
    real_drr as _real_drr,
    amount_to_pay as _amount_to_pay,
)
from marketcore.analytics.localization import LIZone, LocalizationService
from marketcore.auth.dependencies import get_current_user
from marketcore.database import get_db
from marketcore.models import Account, AdStat, Order, SkuName, SkuStock, User

router = APIRouter(prefix="/analytics", tags=["analytics"])


# ─── Response-модели (документация + валидация) ───────────────────────────────

class AccountBrief(BaseModel):
    id: str
    name: str
    marketplace: str
    last_sync_at: str | None


class TopSkuItem(BaseModel):
    sku: str
    name: str
    orders_count: int
    revenue: float


class DashboardResponse(BaseModel):
    has_data: bool
    accounts: list[AccountBrief] = []
    orders_count: int | None = None
    orders_sum: float | None = None
    revenue: float | None = None
    ad_spend: float | None = None
    drr_to_orders: float | None = None
    drr_to_revenue: float | None = None
    drr_to_payouts: float | None = None
    payout_sum: float | None = None
    top_skus: list[TopSkuItem] = []


class WarehouseRow(BaseModel):
    warehouse: str
    units: int
    sum: float


class StockRow(BaseModel):
    warehouse: str
    qty: int


class SkuRow(BaseModel):
    sku: str
    units: int
    orders_sum: float


class SalesReportResponse(BaseModel):
    has_data: bool
    period: dict | None = None
    units: int | None = None
    orders_sum: float | None = None
    wb_services: float | None = None
    ad_spend: float | None = None
    amount_to_pay: float | None = None
    payout_sum: float | None = None
    drr_to_orders: float | None = None
    drr_to_revenue: float | None = None
    drr_to_payouts: float | None = None
    real_drr: float | None = None
    by_warehouse: list[WarehouseRow] = []
    stock_by_warehouse: list[StockRow] = []
    by_sku: list[SkuRow] = []


class PayoutsResponse(BaseModel):
    has_data: bool
    payout_sum: float
    period_from: str
    period_to: str
    api_error: str | None
    note: str


class HeatmapResponse(BaseModel):
    has_data: bool
    matrix: list[list[int]]
    max_val: int


class SupplyForecastItem(BaseModel):
    sku: str
    name: str
    stock: int
    vel_7d: float
    vel_14d: float
    vel_30d: float
    days_oos: int | None
    status: str


class SupplyForecastResponse(BaseModel):
    has_data: bool
    items: list[SupplyForecastItem] = []


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


@router.get("/dashboard", response_model=DashboardResponse)
async def get_dashboard_summary(
    days: int = Query(30),
    period: str = Query("custom"),
    date_from_str: str | None = Query(None, alias="date_from"),
    date_to_str: str | None = Query(None, alias="date_to"),
    account_id: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    # Если передан конкретный account_id — показываем только его данные
    if account_id:
        try:
            target_uuid = uuid.UUID(account_id)
        except ValueError:
            return {"has_data": False, "accounts": []}
        accounts_result = await db.execute(
            select(Account).where(
                Account.id == target_uuid,
                Account.user_id == current_user.id,
                Account.status == "active",
            )
        )
        accounts = list(accounts_result.scalars().all())
    else:
        accounts_result = await db.execute(
            select(Account).where(Account.user_id == current_user.id, Account.status == "active")
        )
        accounts = list(accounts_result.scalars().all())

    if not accounts:
        return {"has_data": False, "accounts": []}

    account_ids = [a.id for a in accounts]

    # Определяем период
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    if period == "today":
        date_from = today_start
        date_to = now
    elif period == "yesterday":
        date_from = today_start - timedelta(days=1)
        date_to = today_start
    elif period == "7d":
        date_from = today_start - timedelta(days=7)
        date_to = now
    elif period == "month":
        date_from = today_start - timedelta(days=30)
        date_to = now
    elif period == "custom" and date_from_str and date_to_str:
        date_from = datetime.fromisoformat(date_from_str).replace(tzinfo=timezone.utc)
        date_to = datetime.fromisoformat(date_to_str).replace(tzinfo=timezone.utc) + timedelta(days=1)
    else:
        date_from = now - timedelta(days=days)
        date_to = now

    orders_row = (await db.execute(
        select(
            func.count(Order.id).label("cnt"),
            func.coalesce(func.sum(Order.price * Order.quantity), 0).label("orders_sum"),
        ).where(Order.account_id.in_(account_ids), Order.ordered_at >= date_from, Order.ordered_at <= date_to)
    )).one()

    ad_spend = float((await db.execute(
        select(func.coalesce(func.sum(AdStat.spend), 0)).where(
            AdStat.account_id.in_(account_ids), AdStat.stat_date >= date_from, AdStat.stat_date <= date_to
        )
    )).scalar_one())

    stock_rows = (await db.execute(
        select(Order.sku, func.count(Order.id).label("cnt"), func.sum(Order.price * Order.quantity).label("revenue"))
        .where(Order.account_id.in_(account_ids), Order.ordered_at >= date_from, Order.ordered_at <= date_to)
        .group_by(Order.sku)
        .order_by(func.sum(Order.price * Order.quantity).desc())
        .limit(20)
    )).all()

    # Настоящие названия товаров из рекламного API (sku_names), не категории
    name_rows = (await db.execute(
        select(SkuName.sku, SkuName.name)
        .where(SkuName.account_id.in_(account_ids), SkuName.name != "")
    )).all()
    sku_names = {r.sku: r.name for r in name_rows}

    orders_sum = float(orders_row.orders_sum)
    # orders_sum = сумма (finishedPrice × (1 − spp/100)) × quantity
    # Это реальная сумма которую заплатили покупатели (с учётом СПП)
    revenue = orders_sum

    # ДРР к начислениям WB — единое место расчёта (за 90 дней, не зависит от UI-периода)
    wb_accounts = [a for a in accounts if a.marketplace == "wb"]
    payout_sum, payout_ok = await _fetch_payouts_90d(wb_accounts)

    # ДРР через единый модуль formulas.py
    calc_drr_orders  = _drr_orders(ad_spend, orders_sum)
    calc_drr_revenue = _drr_revenue(ad_spend, revenue)
    calc_drr_payouts = _drr_payouts(ad_spend, payout_sum if payout_ok else None)

    return {
        "has_data": True,
        "accounts": [{"id": str(a.id), "name": a.name, "marketplace": a.marketplace, "last_sync_at": a.last_sync_at.isoformat() if a.last_sync_at else None} for a in accounts],
        "orders_count": int(orders_row.cnt),
        "orders_sum": orders_sum,
        "revenue": revenue,
        "ad_spend": ad_spend,
        "drr_to_orders":  calc_drr_orders  if calc_drr_orders  is not None else 0,
        "drr_to_revenue": calc_drr_revenue if calc_drr_revenue is not None else 0,
        "drr_to_payouts": calc_drr_payouts,
        "payout_sum": round(payout_sum, 2) if payout_ok else None,
        "top_skus": [{"sku": r.sku, "name": sku_names.get(r.sku, ""), "orders_count": r.cnt, "revenue": float(r.revenue)} for r in stock_rows],
    }


async def _get_user_account_ids(db: AsyncSession, user_id: uuid.UUID) -> list:
    res = await db.execute(
        select(Account.id).where(Account.user_id == user_id, Account.status == "active")
    )
    return [r[0] for r in res.all()]


async def _fetch_payouts_90d(wb_accounts: list[Account]) -> tuple[float, bool]:
    """Сумма ppvz_for_pay за последние 90 дней по всем WB-аккаунтам.

    WB закрывает финансовый отчёт еженедельно (пн–вс) → текущая неделя всегда нулевая.
    Поэтому ВСЕГДА смотрим на 90 дней назад, чтобы захватить закрытые расчёты,
    независимо от выбранного пользователем периода.

    Возвращает: (сумма, был_ли_успешный_ответ_API).
    """
    from marketcore.accounts.encryption import decrypt_api_key
    from marketcore.ingestor.wb_client import WBClient

    if not wb_accounts:
        return 0.0, False

    now = datetime.now(timezone.utc)
    df = (now - timedelta(days=90)).strftime("%Y-%m-%d")
    dt = now.strftime("%Y-%m-%d")

    total = 0.0
    success = False
    for account in wb_accounts:
        try:
            api_key = decrypt_api_key(account.api_key_cipher)
            client = WBClient(api_key)
            total += await client.get_payouts_sum(df, dt)
            success = True
        except Exception:
            pass
    return total, success


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


@router.get("/orders/heatmap", response_model=HeatmapResponse)
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


@router.get("/report", response_model=SalesReportResponse)
async def sales_report(
    period: str = Query("week"),
    date_from_str: str | None = Query(None, alias="date_from"),
    date_to_str: str | None = Query(None, alias="date_to"),
    sku: str | None = Query(None),
    category: str | None = Query(None),
    account_id: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    if account_id:
        try:
            target_uuid = uuid.UUID(account_id)
            res = await db.execute(
                select(Account.id).where(
                    Account.id == target_uuid,
                    Account.user_id == current_user.id,
                    Account.status == "active",
                )
            )
            row = res.scalar_one_or_none()
            account_ids = [row] if row else []
        except ValueError:
            account_ids = []
    else:
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
    # orders_sum = выручка (finishedPrice × qty, с учётом СПП)
    wb_services = 0.0   # точные данные доступны через WB финансовый отчёт (раздел "Общий ДРР")

    # Начисления WB за 90 дней (единый источник, см. _fetch_payouts_90d)
    accounts_full = (await db.execute(
        select(Account).where(Account.id.in_(account_ids))
    )).scalars().all()
    wb_accounts = [a for a in accounts_full if a.marketplace == "wb"]
    payout_sum, payout_ok = await _fetch_payouts_90d(wb_accounts)
    payout_for_calc = payout_sum if payout_ok else None

    # ДРР через единый модуль formulas.py — никакого inline-расчёта
    calc_drr_orders  = _drr_orders(ad_spend, orders_sum)
    calc_drr_revenue = _drr_revenue(ad_spend, orders_sum)
    calc_drr_payouts = _drr_payouts(ad_spend, payout_for_calc)
    calc_real_drr    = _real_drr(ad_spend, payout_for_calc, orders_sum)
    calc_amount      = _amount_to_pay(orders_sum, ad_spend)

    return {
        "has_data": True,
        "period": {"from": df.date().isoformat(), "to": (dt - timedelta(days=1)).date().isoformat()},
        "units": units,
        "orders_sum": round(orders_sum, 2),
        "wb_services": round(wb_services, 2),
        "ad_spend": round(ad_spend, 2),
        "amount_to_pay": round(calc_amount, 2),
        "payout_sum": round(payout_sum, 2) if payout_ok else None,
        "drr_to_orders":  calc_drr_orders  if calc_drr_orders  is not None else 0,
        "drr_to_revenue": calc_drr_revenue if calc_drr_revenue is not None else 0,
        "drr_to_payouts": calc_drr_payouts,
        "real_drr": calc_real_drr if calc_real_drr is not None else 0,
        "by_warehouse": [{"warehouse": r.warehouse or "Неизвестно", "units": int(r.units), "sum": float(r.sum)} for r in wh_rows],
        "stock_by_warehouse": [{"warehouse": r.warehouse or "Неизвестно", "qty": int(r.qty)} for r in stock_rows],
        "by_sku": [{"sku": r.sku, "units": int(r.units), "orders_sum": float(r.orders_sum)} for r in sku_rows],
    }


@router.get("/payouts", response_model=PayoutsResponse)
async def get_payouts(
    period: str = Query("month"),
    date_from_str: str | None = Query(None, alias="date_from"),
    date_to_str: str | None = Query(None, alias="date_to"),
    account_id: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Сумма начислений от WB за период (ppvz_for_pay из финансового отчёта).

    Это реальные деньги которые WB перечислит продавцу:
    ppvz_for_pay = Выручка − комиссия WB − логистика − хранение.
    Данные берутся напрямую из WB Statistics API (не из нашей БД).
    """
    from marketcore.accounts.encryption import decrypt_api_key
    from marketcore.ingestor.wb_client import WBClient

    if account_id:
        try:
            target_uuid = uuid.UUID(account_id)
            accounts_result = await db.execute(
                select(Account).where(
                    Account.id == target_uuid,
                    Account.user_id == current_user.id,
                    Account.status == "active",
                )
            )
        except ValueError:
            accounts_result = await db.execute(
                select(Account).where(Account.id == None)  # noqa: E711 — пустой результат
            )
    else:
        accounts_result = await db.execute(
            select(Account).where(Account.user_id == current_user.id, Account.status == "active")
        )
    accounts = list(accounts_result.scalars().all())
    wb_accounts = [a for a in accounts if a.marketplace == "wb"]
    if not wb_accounts:
        return {
            "has_data": False,
            "payout_sum": 0.0,
            "period_from": "",
            "period_to": "",
            "api_error": "Нет аккаунтов WB",
            "note": "",
        }

    df, dt = _period_range(period, date_from_str, date_to_str)
    # Для отображения периода используем запрошенные даты, но данные тянем за 90 дней
    # (см. _fetch_payouts_90d — WB закрывает финотчёт еженедельно).
    display_from = df.strftime("%Y-%m-%d")
    display_to   = dt.strftime("%Y-%m-%d")

    total, api_success = await _fetch_payouts_90d(wb_accounts)

    return {
        # has_data=True даже если сумма=0 (API ответил, просто нет закрытых расчётов)
        "has_data": api_success,
        "payout_sum": total,
        "period_from": display_from,
        "period_to": display_to,
        "api_error": None if api_success else "WB Statistics API недоступен",
        # WB закрывает финансовый отчёт еженедельно (пн–вс).
        # Мы берём данные за 90 дней назад чтобы найти все закрытые расчёты.
        "note": "ppvz_for_pay из WB финотчёта за последние 90 дней (WB закрывает расчёты раз в неделю).",
    }


@router.get("/supply-forecast", response_model=SupplyForecastResponse)
async def get_supply_forecast(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Прогноз поставок на основе реальных остатков и заказов за 30 дней."""
    accounts_result = await db.execute(
        select(Account).where(Account.user_id == current_user.id, Account.status == "active")
    )
    accounts = list(accounts_result.scalars().all())
    if not accounts:
        return {"has_data": False, "items": []}

    account_ids = [a.id for a in accounts]
    now = datetime.now(timezone.utc)
    date_30d = now - timedelta(days=30)
    date_7d  = now - timedelta(days=7)
    date_14d = now - timedelta(days=14)

    # Остатки по SKU (агрегированные по всем складам)
    stock_rows = (await db.execute(
        select(SkuStock.sku, func.sum(SkuStock.quantity).label("stock"))
        .where(SkuStock.account_id.in_(account_ids))
        .group_by(SkuStock.sku)
    )).all()

    if not stock_rows:
        return {"has_data": False, "items": []}

    # Настоящие названия товаров из рекламного API
    sn_rows = (await db.execute(
        select(SkuName.sku, SkuName.name)
        .where(SkuName.account_id.in_(account_ids), SkuName.name != "")
    )).all()
    sku_name_map = {r.sku: r.name for r in sn_rows}

    # Заказы за 30 дней для расчёта скоростей
    order_rows = (await db.execute(
        select(Order.sku, func.count(Order.id).label("cnt"))
        .where(Order.account_id.in_(account_ids), Order.ordered_at >= date_30d)
        .group_by(Order.sku)
    )).all()

    order_rows_7d = (await db.execute(
        select(Order.sku, func.count(Order.id).label("cnt"))
        .where(Order.account_id.in_(account_ids), Order.ordered_at >= date_7d)
        .group_by(Order.sku)
    )).all()

    order_rows_14d = (await db.execute(
        select(Order.sku, func.count(Order.id).label("cnt"))
        .where(Order.account_id.in_(account_ids), Order.ordered_at >= date_14d)
        .group_by(Order.sku)
    )).all()

    vel30 = {r.sku: r.cnt / 30 for r in order_rows}
    vel7  = {r.sku: r.cnt / 7  for r in order_rows_7d}
    vel14 = {r.sku: r.cnt / 14 for r in order_rows_14d}

    items = []
    for row in stock_rows:
        sku = row.sku
        stock = int(row.stock)
        name = sku_name_map.get(sku, "")
        v30 = vel30.get(sku, 0.0)
        v7  = vel7.get(sku, 0.0)
        v14 = vel14.get(sku, 0.0)
        adj_vel = v30  # базовая скорость
        days_oos = int(stock / adj_vel) if adj_vel > 0 else 999

        if stock == 0:
            status = "critical"
        elif days_oos <= 14:
            status = "critical"
        elif days_oos <= 35:
            status = "soon"
        elif stock > adj_vel * 90:
            status = "overstock"
        else:
            status = "ok"

        items.append({
            "sku": sku,
            "name": name,
            "stock": stock,
            "vel_7d": round(v7, 2),
            "vel_14d": round(v14, 2),
            "vel_30d": round(v30, 2),
            "days_oos": days_oos if days_oos < 999 else None,
            "status": status,
        })

    items.sort(key=lambda x: (x["days_oos"] if x["days_oos"] is not None else 9999))
    return {"has_data": True, "items": items}
