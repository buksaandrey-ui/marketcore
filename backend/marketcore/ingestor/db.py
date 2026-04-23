import uuid
from datetime import datetime, timezone

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from marketcore.accounts.encryption import decrypt_api_key
from marketcore.analytics.districts import (
    normalize_district,
    ozon_warehouse_district,
    wb_warehouse_district,
)
from marketcore.config import settings
from marketcore.models import Account, AdStat, Order, SkuPrice, SkuStock

_engine = create_async_engine(settings.database_url)
_session_factory = async_sessionmaker(_engine, expire_on_commit=False)


async def get_active_accounts() -> list[Account]:
    async with _session_factory() as session:
        result = await session.execute(select(Account).where(Account.status == "active"))
        return list(result.scalars().all())


async def get_account_with_key(account_id: str) -> tuple[Account, str]:
    async with _session_factory() as session:
        result = await session.execute(select(Account).where(Account.id == uuid.UUID(account_id)))
        account = result.scalar_one()
        return account, decrypt_api_key(account.api_key_cipher)


async def save_orders_wb(account_id: str, raw_orders: list[dict]) -> int:
    now = datetime.now(timezone.utc)
    rows = [
        {
            "id": uuid.uuid4(),
            "account_id": uuid.UUID(account_id),
            "external_id": str(o.get("gNumber", o.get("srid", ""))),
            "sku": str(o.get("nmId", "")),
            "quantity": int(o.get("quantity", 1)),
            "price": float(o.get("totalPrice", 0)),
            "status": str(o.get("orderType", "unknown")),
            "warehouse": str(o.get("warehouseName", "")),
            "warehouse_district": wb_warehouse_district(o.get("warehouseName")),
            "customer_district": normalize_district(o.get("oblastOkrugName") or o.get("regionName")),
            "ordered_at": _parse_dt(o.get("date", now.isoformat())),
        }
        for o in raw_orders
        if o.get("gNumber") or o.get("srid")
    ]
    if not rows:
        return 0
    async with _session_factory() as session:
        stmt = insert(Order).values(rows).on_conflict_do_nothing(
            constraint="uq_orders_account_external"
        )
        result = await session.execute(stmt)
        await session.commit()
        return result.rowcount


async def save_orders_ozon(account_id: str, raw_postings: list[dict]) -> int:
    now = datetime.now(timezone.utc)
    rows = []
    for posting in raw_postings:
        analytics = posting.get("analytics_data", {}) or {}
        warehouse_name = analytics.get("warehouse_name")
        for product in posting.get("products", []):
            rows.append({
                "id": uuid.uuid4(),
                "account_id": uuid.UUID(account_id),
                "external_id": f"{posting['posting_number']}_{product.get('sku', '')}",
                "sku": str(product.get("sku", "")),
                "quantity": int(product.get("quantity", 1)),
                "price": float(product.get("price", 0)),
                "status": str(posting.get("status", "unknown")),
                "warehouse": warehouse_name,
                "warehouse_district": ozon_warehouse_district(warehouse_name),
                "customer_district": normalize_district(analytics.get("region")),
                "ordered_at": _parse_dt(posting.get("created_at", now.isoformat())),
            })
    if not rows:
        return 0
    async with _session_factory() as session:
        stmt = insert(Order).values(rows).on_conflict_do_nothing(
            constraint="uq_orders_account_external"
        )
        result = await session.execute(stmt)
        await session.commit()
        return result.rowcount


async def save_stocks_wb(account_id: str, raw_stocks: list[dict]) -> int:
    now = datetime.now(timezone.utc)
    acc_uuid = uuid.UUID(account_id)
    rows = [
        {
            "id": uuid.uuid4(),
            "account_id": acc_uuid,
            "sku": str(s.get("nmId", "")),
            "warehouse": str(s.get("warehouseName", "")),
            "quantity": int(s.get("quantity", 0)),
            "recorded_at": now,
        }
        for s in raw_stocks
    ]
    async with _session_factory() as session:
        # Replace snapshot: delete old rows so every sync reflects current state
        await session.execute(delete(SkuStock).where(SkuStock.account_id == acc_uuid))
        if not rows:
            await session.commit()
            return 0
        result = await session.execute(insert(SkuStock).values(rows))
        await session.commit()
        return result.rowcount


async def save_stocks_ozon(account_id: str, raw_stocks: list[dict]) -> int:
    now = datetime.now(timezone.utc)
    acc_uuid = uuid.UUID(account_id)
    rows = [
        {
            "id": uuid.uuid4(),
            "account_id": acc_uuid,
            "sku": str(s.get("item_code", "")),
            "warehouse": str(s.get("warehouse_name", "")),
            "quantity": int(s.get("free_to_sell_amount", 0)),
            "recorded_at": now,
        }
        for s in raw_stocks
    ]
    async with _session_factory() as session:
        await session.execute(delete(SkuStock).where(SkuStock.account_id == acc_uuid))
        if not rows:
            await session.commit()
            return 0
        result = await session.execute(insert(SkuStock).values(rows))
        await session.commit()
        return result.rowcount


async def save_prices_wb(account_id: str, raw_goods: list[dict]) -> int:
    now = datetime.now(timezone.utc)
    acc_uuid = uuid.UUID(account_id)
    rows = [
        {
            "id": uuid.uuid4(),
            "account_id": acc_uuid,
            "sku": str(g.get("nmID", "")),
            "price": float(g.get("price", 0)),
            "discount_percent": int(g.get("discount", 0)),
            "recorded_at": now,
        }
        for g in raw_goods
    ]
    async with _session_factory() as session:
        await session.execute(delete(SkuPrice).where(SkuPrice.account_id == acc_uuid))
        if not rows:
            await session.commit()
            return 0
        result = await session.execute(insert(SkuPrice).values(rows))
        await session.commit()
        return result.rowcount


async def save_prices_ozon(account_id: str, raw_items: list[dict]) -> int:
    now = datetime.now(timezone.utc)
    acc_uuid = uuid.UUID(account_id)
    rows = [
        {
            "id": uuid.uuid4(),
            "account_id": acc_uuid,
            "sku": str(item.get("offer_id", "")),
            "price": float(item.get("price", {}).get("price", 0)),
            "discount_percent": 0,
            "recorded_at": now,
        }
        for item in raw_items
    ]
    async with _session_factory() as session:
        await session.execute(delete(SkuPrice).where(SkuPrice.account_id == acc_uuid))
        if not rows:
            await session.commit()
            return 0
        result = await session.execute(insert(SkuPrice).values(rows))
        await session.commit()
        return result.rowcount


async def save_ad_stats_wb(account_id: str, raw_stats: list[dict]) -> int:
    now = datetime.now(timezone.utc)
    rows = []
    for campaign in raw_stats:
        campaign_id = str(campaign.get("advertId", ""))
        for day in campaign.get("days", []):
            stat_date = _parse_dt(day.get("date", now.isoformat()))
            for app in day.get("apps", []):
                for nm in app.get("nm", []):
                    rows.append({
                        "id": uuid.uuid4(),
                        "account_id": uuid.UUID(account_id),
                        "campaign_id": campaign_id,
                        "sku": str(nm.get("nmId", "")),
                        "cpm": float(nm.get("cpm", 0)),
                        "views": int(nm.get("views", 0)),
                        "clicks": int(nm.get("clicks", 0)),
                        "spend": float(nm.get("sum", 0)),
                        "stat_date": stat_date,
                    })
    if not rows:
        return 0
    async with _session_factory() as session:
        stmt = insert(AdStat).values(rows).on_conflict_do_nothing(
            constraint="uq_ad_stats_unique"
        )
        result = await session.execute(stmt)
        await session.commit()
        return result.rowcount


async def save_ad_stats_ozon(account_id: str, raw_stats: list[dict]) -> int:
    now = datetime.now(timezone.utc)
    rows = []
    for stat in raw_stats:
        rows.append({
            "id": uuid.uuid4(),
            "account_id": uuid.UUID(account_id),
            "campaign_id": str(stat.get("campaign_id", "")),
            "sku": str(stat.get("sku", "")),
            "cpm": float(stat.get("cpm", 0)),
            "views": int(stat.get("views", 0)),
            "clicks": int(stat.get("clicks", 0)),
            "spend": float(stat.get("money_spent", 0)),
            "stat_date": _parse_dt(stat.get("date", now.isoformat())),
        })
    if not rows:
        return 0
    async with _session_factory() as session:
        stmt = insert(AdStat).values(rows).on_conflict_do_nothing(
            constraint="uq_ad_stats_unique"
        )
        result = await session.execute(stmt)
        await session.commit()
        return result.rowcount


async def _bulk_insert(model: type, rows: list[dict]) -> int:
    if not rows:
        return 0
    async with _session_factory() as session:
        stmt = insert(model).values(rows)
        result = await session.execute(stmt)
        await session.commit()
        return result.rowcount


def _parse_dt(value: str) -> datetime:
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%S%z"):
        try:
            dt = datetime.strptime(value[:26], fmt[:len(fmt)])
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except ValueError:
            continue
    return datetime.now(timezone.utc)
