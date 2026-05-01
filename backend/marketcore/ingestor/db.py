import re
import uuid
from datetime import datetime, timezone

from sqlalchemy import delete, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from marketcore.accounts.encryption import decrypt_api_key
from marketcore.analytics.districts import (
    normalize_district,
    ozon_warehouse_district,
    wb_warehouse_district,
)
from marketcore.config import settings
from marketcore.models import Account, AdStat, Order, SkuName, SkuPrice, SkuStock

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


def _wb_order_price(o: dict) -> float:
    """Сколько реально заплатил покупатель = finishedPrice × (1 − spp/100).

    WB API: finishedPrice = цена после скидки ПРОДАВЦА, но до СПП (субсидия WB).
    СПП (скидка постоянного покупателя) — это скидка которую WB даёт покупателю
    за свой счёт, продавец её не платит → но «оплатили покупатели» = цена минус СПП.

    Приоритет полей:
      finishedPrice × (1 − spp/100)  — основной расчёт
      priceWithDisc × (1 − spp/100)  — запасной
      totalPrice × (1 − discountPercent/100) × (1 − spp/100)  — крайний запасной
    """
    spp = float(o.get("spp") or 0)
    spp_mult = (1 - spp / 100) if spp > 0 else 1.0

    fp = o.get("finishedPrice")
    if fp is not None:
        return round(float(fp) * spp_mult, 2)

    pwd = o.get("priceWithDisc")
    if pwd is not None:
        return round(float(pwd) * spp_mult, 2)

    total = float(o.get("totalPrice") or 0)
    disc = float(o.get("discountPercent") or 0)
    disc_mult = (1 - disc / 100) if disc > 0 else 1.0
    return round(total * disc_mult * spp_mult, 2)


async def save_orders_wb(account_id: str, raw_orders: list[dict]) -> int:
    now = datetime.now(timezone.utc)
    rows = [
        {
            "id": uuid.uuid4(),
            "account_id": uuid.UUID(account_id),
            "external_id": str(o.get("gNumber", o.get("srid", ""))),
            "sku": str(o.get("nmId", "")),
            "quantity": int(o.get("quantity", 1)),
            "price": _wb_order_price(o),   # finishedPrice × (1 − spp/100) — что заплатил покупатель
            "status": str(o.get("orderType", "unknown")),
            "warehouse": str(o.get("warehouseName", "")),
            "warehouse_district": wb_warehouse_district(o.get("warehouseName")),
            "customer_district": normalize_district(o.get("oblastOkrugName") or o.get("regionName")),
            "ordered_at": _parse_dt(o.get("date", now.isoformat())),
        }
        for o in raw_orders
        # Исключаем отменённые заказы (isCancel=True) — они не должны влиять на выручку
        if (o.get("gNumber") or o.get("srid")) and not o.get("isCancel")
    ]
    if not rows:
        return 0
    async with _session_factory() as session:
        # TimescaleDB (гипертаблица) не поддерживает ON CONFLICT DO UPDATE.
        # Решение: удаляем заказы за тот же период, потом вставляем свежие.
        # Это пересчитывает старые записи с обновлённой формулой цены (СПП-вычет).
        min_date = min(r["ordered_at"] for r in rows)
        await session.execute(
            delete(Order)
            .where(Order.account_id == uuid.UUID(account_id))
            .where(Order.ordered_at >= min_date)
        )
        # on_conflict_do_nothing нужен на случай если несколько товаров
        # в одном заказе WB имеют одинаковый gNumber (одинаковый external_id)
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
            "name": str(s.get("name") or s.get("subject") or ""),
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


async def save_sku_names_from_stocks(account_id: str, raw_stocks: list[dict]) -> int:
    """Запасной вариант: сохраняет имена SKU из WB Stocks API (поле name / subject).

    Вызывается после save_stocks_wb. Заполняет sku_names только для тех SKU,
    у которых ещё нет записи — не перезаписывает лучшие имена из рекламного API.
    Поле «name» в ответе WB Stats API = название товара / категория.
    """
    acc_uuid = uuid.UUID(account_id)
    now = datetime.now(timezone.utc)
    names: dict[str, str] = {}
    for s in raw_stocks:
        sku = str(s.get("nmId", ""))
        # WB Stats API: поле name = название товара, subject = категория
        name = str(s.get("name") or s.get("subject") or "").strip()
        if sku and name and sku not in names:
            names[sku] = name
    if not names:
        return 0
    rows = [{"account_id": acc_uuid, "sku": sku, "name": name, "updated_at": now}
            for sku, name in names.items()]
    async with _session_factory() as session:
        # on_conflict_do_nothing: не перезаписываем записи из рекламного API
        stmt = insert(SkuName).values(rows).on_conflict_do_nothing()
        result = await session.execute(stmt)
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
                for nm in (app.get("nms") or app.get("nm") or []):
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


async def save_sku_names(account_id: str, raw_stats: list[dict]) -> int:
    """Сохраняет имена товаров nmId→name из ответа WB fullstats API."""
    acc_uuid = uuid.UUID(account_id)
    now = datetime.now(timezone.utc)
    names: dict[str, str] = {}
    for campaign in raw_stats:
        for day in campaign.get("days", []):
            for app in day.get("apps", []):
                for nm in (app.get("nms") or app.get("nm") or []):
                    sku = str(nm.get("nmId", ""))
                    name = str(nm.get("name") or "").strip()
                    if sku and name and sku not in names:
                        names[sku] = name
    if not names:
        return 0
    rows = [{"account_id": acc_uuid, "sku": sku, "name": name, "updated_at": now}
            for sku, name in names.items()]
    async with _session_factory() as session:
        stmt = insert(SkuName).values(rows).on_conflict_do_update(
            index_elements=["account_id", "sku"],
            set_={"name": insert(SkuName).excluded.name, "updated_at": insert(SkuName).excluded.updated_at},
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


_WEIGHT_RE = re.compile(r'\d+[\.,]?\d*\s*(г|гр|кг|мл|л)\b', re.IGNORECASE)


async def enrich_sku_names_with_params(account_id: str) -> int:
    """Дополняет названия SKU параметрами объёма/веса из публичного WB API.

    Пример: "Корневин удобрение для корней" → "Корневин удобрение для корней, 30 г"
    Пропускает SKU, в названии которых уже есть числовой параметр (г/кг/мл/л).
    Возвращает количество обновлённых строк.
    """
    from marketcore.ingestor.wb_client import WBClient

    acc_uuid = uuid.UUID(account_id)
    now = datetime.now(timezone.utc)

    # Загружаем все sku_names для аккаунта
    async with _session_factory() as session:
        result = await session.execute(
            select(SkuName).where(SkuName.account_id == acc_uuid)
        )
        sku_rows = list(result.scalars().all())

    if not sku_rows:
        return 0

    # Только числовые артикулы WB (nmId)
    nm_ids = [int(r.sku) for r in sku_rows if r.sku.isdigit()]
    if not nm_ids:
        return 0

    # Запрашиваем параметры через публичный WB API (без ключа)
    params_map = await WBClient.get_card_params(nm_ids)
    if not params_map:
        return 0

    updated = 0
    async with _session_factory() as session:
        for row in sku_rows:
            if not row.sku.isdigit():
                continue
            param = params_map.get(int(row.sku))
            if not param:
                continue
            # Не добавляем если в названии уже есть вес/объём
            if _WEIGHT_RE.search(row.name):
                continue
            # Не добавляем если параметр уже содержится в названии дословно
            if param.lower() in row.name.lower():
                continue
            new_name = f"{row.name}, {param}"
            await session.execute(
                update(SkuName)
                .where(SkuName.account_id == acc_uuid, SkuName.sku == row.sku)
                .values(name=new_name, updated_at=now)
            )
            updated += 1
        if updated:
            await session.commit()

    return updated


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
