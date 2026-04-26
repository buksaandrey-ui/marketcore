"""
/campaigns — управление рекламными кампаниями WB:
  список, создание (в т.ч. массовое), пауза/запуск, смена имени и бюджета.
  Также /skus — список артикулов из БД для выбора при создании кампании.
"""
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import distinct, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from marketcore.accounts.encryption import decrypt_api_key
from marketcore.accounts import service as acc_service
from marketcore.auth.dependencies import get_current_user
from marketcore.database import get_db
from marketcore.models import AdStat, Order, SkuPrice, SkuStock, User

router = APIRouter(prefix="/campaigns", tags=["campaigns"])


# ─── helpers ─────────────────────────────────────────────────────────────────

async def _get_advert_client(
    account_id: uuid.UUID,
    current_user: User,
    db: AsyncSession,
):
    """Возвращает (account, WBClient) с рекламным ключом."""
    from marketcore.ingestor.wb_client import WBClient

    try:
        account = await acc_service.get_account(db, account_id, current_user.id)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))

    if account.marketplace != "wb":
        raise HTTPException(status_code=400, detail="Только для WB аккаунтов")

    advert_key = (
        decrypt_api_key(account.advert_api_key_cipher)
        if account.advert_api_key_cipher
        else decrypt_api_key(account.api_key_cipher)
    )
    return account, WBClient(advert_key)


# ─── schemas ─────────────────────────────────────────────────────────────────

class CampaignOut(BaseModel):
    advert_id: int
    name: str
    type: int | None
    status: int | None
    cpm: int


class CreateCampaignBody(BaseModel):
    account_id: uuid.UUID
    name: str
    nm_ids: list[int]
    budget: int = 500  # рублей


class UpdateCampaignBody(BaseModel):
    name: str | None = None
    budget_add: int | None = None  # пополнить на N рублей


class BulkScheduleBody(BaseModel):
    account_id: uuid.UUID
    advert_ids: list[int]
    hours: list[int]  # 24 значения 0-100


class SkuOut(BaseModel):
    sku: str
    name: str | None = None   # название товара из WB Content API
    price: float | None = None
    stock: int | None = None


# ─── endpoints ───────────────────────────────────────────────────────────────

@router.get("", response_model=list[CampaignOut])
async def list_campaigns(
    account_id: uuid.UUID = Query(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[CampaignOut]:
    _, client = await _get_advert_client(account_id, current_user, db)
    try:
        campaigns = await client.list_campaigns(statuses=[9, 11])
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"WB API: {e}")
    return [CampaignOut(**c) for c in campaigns]


@router.post("", response_model=dict, status_code=status.HTTP_201_CREATED)
async def create_campaign(
    body: CreateCampaignBody,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    _, client = await _get_advert_client(body.account_id, current_user, db)
    try:
        advert_id = await client.create_auto_campaign(body.nm_ids, body.budget, body.name)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"WB API: {e}")
    return {"advert_id": advert_id, "name": body.name}


@router.post("/{advert_id}/pause", status_code=204)
async def pause_campaign(
    advert_id: int,
    account_id: uuid.UUID = Query(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    _, client = await _get_advert_client(account_id, current_user, db)
    try:
        await client.pause_campaign(advert_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"WB API: {e}")


@router.post("/{advert_id}/resume", status_code=204)
async def resume_campaign(
    advert_id: int,
    account_id: uuid.UUID = Query(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    _, client = await _get_advert_client(account_id, current_user, db)
    try:
        await client.resume_campaign(advert_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"WB API: {e}")


@router.put("/{advert_id}", status_code=204)
async def update_campaign(
    advert_id: int,
    body: UpdateCampaignBody,
    account_id: uuid.UUID = Query(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    _, client = await _get_advert_client(account_id, current_user, db)
    try:
        if body.name is not None:
            await client.rename_campaign(advert_id, body.name)
        if body.budget_add is not None and body.budget_add > 0:
            await client.set_campaign_budget(advert_id, body.budget_add)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"WB API: {e}")


class SetCpmBody(BaseModel):
    account_id: uuid.UUID
    cpm: int
    advert_type: int = 8    # 8=авто, 5=поиск, 9=поиск+каталог
    param: int = 0          # subject_id для поиска, 0 для авто


class CreateCategoryPackBody(BaseModel):
    account_id: uuid.UUID
    nm_ids: list[int]           # один nm_id = одна кампания
    name_prefix: str            # «Удобрение» → «Удобрение — {nm_id}»
    budget: int = 500
    cpm: int = 150              # стартовая ставка
    schedule_hours: list[int]   # 24 значения 0-100


class CampaignStatOut(BaseModel):
    advert_id: int
    name: str
    status: int | None = None
    views: int = 0
    clicks: int = 0
    spend: float = 0.0        # расход (уже с НДС в данных WB)
    atbs: int = 0             # положили в корзину
    orders: int = 0           # заказов
    shks: int = 0             # выкуплено (оплачено)
    revenue: float = 0.0      # доход
    drr: float | None = None  # ДРР этой кампании, %


@router.get("/stats", response_model=list[CampaignStatOut])
async def get_campaign_stats(
    account_id: uuid.UUID = Query(...),
    days: int = Query(7, ge=1, le=30),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[CampaignStatOut]:
    """Статистика РК за последние N дней с данными WB: расход, доход, корзина, выкуп, ДРР."""
    from datetime import datetime as _dt, timedelta as _td, timezone as _tz
    _, client = await _get_advert_client(account_id, current_user, db)

    # Получаем список ID кампаний
    try:
        campaigns = await client.list_campaigns(statuses=[9, 11, 7])
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"WB API (список кампаний): {e}")

    if not campaigns:
        return []

    advert_ids = [c["advert_id"] for c in campaigns]
    status_map = {c["advert_id"]: c.get("status") for c in campaigns}

    date_to   = _dt.now(_tz.utc).strftime("%Y-%m-%d")
    date_from = (_dt.now(_tz.utc) - _td(days=days)).strftime("%Y-%m-%d")

    try:
        stats = await client.get_campaign_detailed_stats(advert_ids, date_from, date_to)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"WB API (статистика): {e}")

    result = []
    for s in stats:
        drr = round(s["spend"] / s["revenue"] * 100, 1) if s["revenue"] > 0 else None
        result.append(CampaignStatOut(
            advert_id=s["advert_id"],
            name=s["name"],
            status=status_map.get(s["advert_id"]),
            views=s["views"],
            clicks=s["clicks"],
            spend=round(s["spend"], 2),
            atbs=s["atbs"],
            orders=s["orders"],
            shks=s["shks"],
            revenue=round(s["revenue"], 2),
            drr=drr,
        ))

    # Кампании без статистики тоже показываем (нулями)
    stats_ids = {s["advert_id"] for s in stats}
    for c in campaigns:
        if c["advert_id"] not in stats_ids:
            result.append(CampaignStatOut(
                advert_id=c["advert_id"],
                name=c["name"],
                status=c.get("status"),
            ))

    return result


@router.post("/bulk-schedule", response_model=dict)
async def bulk_set_schedule(
    body: BulkScheduleBody,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Установить расписание показов (24 коэффициента) сразу для нескольких кампаний."""
    if len(body.hours) != 24:
        raise HTTPException(status_code=400, detail="hours должен содержать ровно 24 элемента")

    _, client = await _get_advert_client(body.account_id, current_user, db)

    results: dict[str, str] = {}
    for advert_id in body.advert_ids:
        try:
            await client.set_campaign_hours(advert_id, body.hours)
            results[str(advert_id)] = "ok"
        except Exception as e:
            results[str(advert_id)] = f"error: {e}"

    ok_count = sum(1 for v in results.values() if v == "ok")
    return {"applied": ok_count, "total": len(body.advert_ids), "details": results}


@router.get("/overall-drr")
async def get_overall_drr(
    account_id: uuid.UUID = Query(...),
    days: int = Query(30, ge=1, le=90),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Общий ДРР = (рекламный расход + WB-услуги продвижения) / вся выручка × 100%.

    Компоненты:
      ad_spend      — рекламный расход из таблицы ad_stats за период
      service_costs — доп. услуги WB (Продвижение, Реклама WB и т.п.) из финотчёта
      total_revenue — вся выручка из таблицы orders (органика + реклама)
      drr_ad        — ДРР только рекламы
      drr_total     — Общий ДРР (реклама + услуги) / вся выручка
      by_service    — разбивка доп. расходов по типу услуги
    """
    from datetime import datetime as _dt, timedelta as _td, timezone as _tz

    since = _dt.now(_tz.utc) - _td(days=days)
    date_from = since.strftime("%Y-%m-%d")
    date_to   = _dt.now(_tz.utc).strftime("%Y-%m-%d")
    # 1. Рекламный расход из нашей БД (уже синхронизирован)
    ad_spend_q = await db.execute(
        select(func.coalesce(func.sum(AdStat.spend), 0.0))
        .where(AdStat.account_id == account_id)
        .where(AdStat.stat_date >= since)
    )
    ad_spend = float(ad_spend_q.scalar() or 0)

    # 2. Вся выручка из заказов (органика + реклама)
    revenue_q = await db.execute(
        select(func.coalesce(func.sum(Order.price * Order.quantity), 0.0))
        .where(Order.account_id == account_id)
        .where(Order.ordered_at >= since)
    )
    total_revenue = float(revenue_q.scalar() or 0)

    # 3. Доп. услуги WB из финансового отчёта (тихо падаем если нет доступа)
    service_costs = 0.0
    by_service: dict[str, float] = {}
    services_error: str | None = None
    try:
        account = await acc_service.get_account(db, account_id, current_user.id)
        from marketcore.ingestor.wb_client import WBClient
        client = WBClient(decrypt_api_key(account.api_key_cipher))
        svc = await client.get_wb_services_costs(date_from, date_to)
        service_costs = svc["total"]
        by_service = svc["by_type"]
    except Exception as e:
        services_error = str(e)

    total_costs = ad_spend + service_costs
    drr_ad    = round(ad_spend / total_revenue * 100, 2) if total_revenue > 0 else None
    drr_total = round(total_costs / total_revenue * 100, 2) if total_revenue > 0 else None

    return {
        "period_days":    days,
        "ad_spend":       round(ad_spend, 2),
        "service_costs":  round(service_costs, 2),
        "total_costs":    round(total_costs, 2),
        "total_revenue":  round(total_revenue, 2),
        "drr_ad":         drr_ad,
        "drr_total":      drr_total,
        "by_service":     by_service,
        "services_error": services_error,
    }


@router.get("/skus", response_model=list[SkuOut])
async def list_skus(
    account_id: uuid.UUID = Query(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[SkuOut]:
    """Список артикулов аккаунта из БД — для выбора при создании кампании."""
    try:
        account = await acc_service.get_account(db, account_id, current_user.id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

    # Берём уникальные SKU с последней ценой
    prices_q = (
        select(SkuPrice.sku, func.max(SkuPrice.price).label("price"))
        .where(SkuPrice.account_id == account_id)
        .group_by(SkuPrice.sku)
    )
    prices_rows = (await db.execute(prices_q)).all()
    price_map: dict[str, float] = {r.sku: r.price for r in prices_rows}

    # Суммарный остаток по всем складам
    stocks_q = (
        select(SkuStock.sku, func.sum(SkuStock.quantity).label("stock"))
        .where(SkuStock.account_id == account_id)
        .group_by(SkuStock.sku)
    )
    stocks_rows = (await db.execute(stocks_q)).all()
    stock_map: dict[str, int] = {r.sku: r.stock for r in stocks_rows}

    # Пытаемся получить названия из WB Content API (тихо падаем если нет доступа)
    all_skus = sorted(set(price_map) | set(stock_map))
    name_map: dict[int, str] = {}
    try:
        from marketcore.ingestor.wb_client import WBClient
        main_key = decrypt_api_key(account.api_key_cipher)
        client = WBClient(main_key)
        nm_ids = [int(s) for s in all_skus if s.isdigit()]
        name_map = await client.get_nm_titles(nm_ids)
    except Exception:
        pass

    return [
        SkuOut(
            sku=s,
            name=name_map.get(int(s)) if s.isdigit() else None,
            price=price_map.get(s),
            stock=stock_map.get(s),
        )
        for s in all_skus
    ]


@router.post("/{advert_id}/set-cpm", status_code=204)
async def set_campaign_cpm(
    advert_id: int,
    body: SetCpmBody,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    """Установить ставку CPM для кампании."""
    _, client = await _get_advert_client(body.account_id, current_user, db)
    try:
        await client.set_campaign_cpm(
            advert_id=advert_id,
            advert_type=body.advert_type,
            cpm=body.cpm,
            param=body.param,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"WB API: {e}")


@router.get("/products-by-subject", response_model=list[dict])
async def list_products_by_subject(
    account_id: uuid.UUID = Query(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[dict]:
    """Все товары аккаунта с категориями из WB Content API.
    Возвращает список категорий, каждая содержит список товаров.
    """
    try:
        account = await acc_service.get_account(db, account_id, current_user.id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

    from marketcore.ingestor.wb_client import WBClient
    client = WBClient(decrypt_api_key(account.api_key_cipher))
    try:
        products = await client.get_all_products_with_subjects()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"WB Content API: {e}")

    # Группируем по категории
    subjects: dict[str, dict] = {}
    for p in products:
        subj = p["subject_name"]
        if subj not in subjects:
            subjects[subj] = {
                "subject_name": subj,
                "subject_id": p["subject_id"],
                "products": [],
            }
        subjects[subj]["products"].append({
            "nm_id": p["nm_id"],
            "name": p["name"],
            "vendor_code": p["vendor_code"],
        })

    return sorted(subjects.values(), key=lambda x: x["subject_name"])


@router.post("/create-category-pack", response_model=dict, status_code=201)
async def create_category_pack(
    body: CreateCategoryPackBody,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Создать одну кампанию на каждый товар: авто-кампания + CPM + расписание.

    Для каждого nm_id:
      1. Создаёт авто-кампанию
      2. Устанавливает ставку CPM
      3. Применяет расписание показов
    """
    if len(body.schedule_hours) != 24:
        raise HTTPException(status_code=400, detail="schedule_hours должен содержать ровно 24 элемента")

    _, client = await _get_advert_client(body.account_id, current_user, db)

    created: list[dict] = []
    errors: list[dict] = []

    for nm_id in body.nm_ids:
        name = f"{body.name_prefix} — {nm_id}"
        try:
            advert_id = await client.create_auto_campaign([nm_id], body.budget, name)
        except Exception as e:
            errors.append({"nm_id": nm_id, "step": "create", "error": str(e)})
            continue

        # Ставка CPM
        try:
            await client.set_campaign_cpm(
                advert_id=advert_id,
                advert_type=8,  # авто-кампания
                cpm=body.cpm,
                param=0,
            )
        except Exception as e:
            errors.append({"nm_id": nm_id, "advert_id": advert_id, "step": "set_cpm", "error": str(e)})

        # Расписание
        try:
            await client.set_campaign_hours(advert_id, body.schedule_hours)
        except Exception as e:
            errors.append({"nm_id": nm_id, "advert_id": advert_id, "step": "schedule", "error": str(e)})

        created.append({"nm_id": nm_id, "advert_id": advert_id, "name": name})

    return {
        "created_count": len(created),
        "error_count": len(errors),
        "campaigns": created,
        "errors": errors,
    }
