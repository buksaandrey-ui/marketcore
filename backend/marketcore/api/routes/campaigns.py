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
from marketcore.models import AdStat, CampaignAutoSchedule, CampaignName, Order, SkuName, SkuPrice, SkuStock, User

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


# ─── helpers: кеш имён кампаний ──────────────────────────────────────────────

async def _save_campaign_names_cache(
    db: AsyncSession, account_id: uuid.UUID, campaigns: list[dict]
) -> None:
    """Сохраняет имена кампаний в таблицу campaign_names (INSERT ON CONFLICT DO UPDATE)."""
    from sqlalchemy.dialects.postgresql import insert as pg_insert
    from datetime import datetime, timezone

    if not campaigns:
        return
    rows = [
        {
            "account_id": account_id,
            "advert_id": c["advert_id"],
            "name": c["name"],
            "campaign_type": c.get("type"),
            "status": c.get("status"),
            "updated_at": datetime.now(timezone.utc),
        }
        for c in campaigns
    ]
    stmt = pg_insert(CampaignName).values(rows).on_conflict_do_update(
        index_elements=["account_id", "advert_id"],
        set_={"name": pg_insert(CampaignName).excluded.name,
              "campaign_type": pg_insert(CampaignName).excluded.campaign_type,
              "status": pg_insert(CampaignName).excluded.status,
              "updated_at": pg_insert(CampaignName).excluded.updated_at},
    )
    try:
        await db.execute(stmt)
        await db.commit()
    except Exception:
        await db.rollback()


async def _load_cached_names(
    db: AsyncSession, account_id: uuid.UUID
) -> dict[int, dict]:
    """Читает имена кампаний из БД-кеша. Возвращает {advert_id: {name, type, status}}."""
    stmt = select(CampaignName).where(CampaignName.account_id == account_id)
    rows = (await db.execute(stmt)).scalars().all()
    return {
        r.advert_id: {"name": r.name, "type": r.campaign_type, "status": r.status}
        for r in rows
    }


# ─── endpoints ───────────────────────────────────────────────────────────────

@router.get("", response_model=list[CampaignOut])
async def list_campaigns(
    account_id: uuid.UUID = Query(...),
    refresh: bool = Query(False, description="Принудительно обновить имена из WB API"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[CampaignOut]:
    """Список рекламных кампаний.

    Стратегия: кеш-first.
    - Если в campaign_names есть данные и refresh=false → мгновенный ответ из БД (без WB API).
    - Если кеш пустой или refresh=true → обращаемся к WB API, сохраняем результат в кеш.
    - Если WB API недоступен и кеш непустой → отдаём кеш.
    """
    # 1. Пробуем кеш (всегда, кроме явного refresh)
    if not refresh:
        cached = await _load_cached_names(db, account_id)
        if cached:
            return [
                CampaignOut(
                    advert_id=aid,
                    name=info["name"],
                    type=info.get("type"),
                    status=info.get("status"),
                    cpm=0,
                )
                for aid, info in cached.items()
            ]

    # 2. Кеш пустой или refresh=true — идём в WB API
    _, client = await _get_advert_client(account_id, current_user, db)
    try:
        campaigns = await client.list_campaigns(statuses=[9, 11])
    except Exception as e:
        # WB API упал — последний шанс: кеш
        cached = await _load_cached_names(db, account_id)
        if cached:
            return [
                CampaignOut(advert_id=aid, name=info["name"], type=info.get("type"), status=info.get("status"), cpm=0)
                for aid, info in cached.items()
            ]
        raise HTTPException(status_code=502, detail=f"WB API недоступен: {e}")

    # 3. Сохраняем в кеш (блокирующий вызов — чтобы следующий запрос уже нашёл кеш)
    await _save_campaign_names_cache(db, account_id, campaigns)

    return [CampaignOut(**c) for c in campaigns]


@router.post("/names/refresh", status_code=200)
async def refresh_campaign_names(
    account_id: uuid.UUID = Query(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Принудительно обновить имена кампаний из WB API и сохранить в кеш.
    Используется кнопкой «Обновить имена» на фронтенде.
    """
    _, client = await _get_advert_client(account_id, current_user, db)
    try:
        campaigns = await client.list_campaigns(statuses=[7, 9, 11])
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"WB API: {e}")
    await _save_campaign_names_cache(db, account_id, campaigns)
    return {"updated": len(campaigns), "message": f"Сохранено {len(campaigns)} имён кампаний"}


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
    type: int | None = None            # тип: 4=Каталог, 5=Карточка, 6=Поиск, 8=Авто, 9=Поиск+Кат.
    cpm_min: int | None = None         # рынок: минимальная ставка
    cpm_competitive: int | None = None # рынок: конкурентная ставка (~3.5× от мин)
    cpm_top10: int | None = None       # рынок: ставка для топ-10 (~5.5× от мин)
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
    type_map   = {c["advert_id"]: c.get("type")   for c in campaigns}
    # Имена из list_campaigns (уже обогащены через get_campaign_names)
    name_map   = {c["advert_id"]: c["name"] for c in campaigns}

    date_to   = _dt.now(_tz.utc).strftime("%Y-%m-%d")
    date_from = (_dt.now(_tz.utc) - _td(days=days)).strftime("%Y-%m-%d")

    # Рыночные ориентиры ставок (один запрос на аккаунт, авто-кампании type=8)
    benchmark: dict | None = None
    try:
        benchmark = await client.get_market_cpm(advert_type=8, param=0)
    except Exception:
        pass

    try:
        stats = await client.get_campaign_detailed_stats(advert_ids, date_from, date_to)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"WB API (статистика): {e}")

    cpm_min         = benchmark["min"]         if benchmark else None
    cpm_competitive = benchmark["competitor"]  if benchmark else None
    cpm_top10       = benchmark["top"]         if benchmark else None

    result = []
    for s in stats:
        drr = round(s["spend"] / s["revenue"] * 100, 1) if s["revenue"] > 0 else None
        result.append(CampaignStatOut(
            advert_id=s["advert_id"],
            # Приоритет: реальное имя кампании → имя из статистики (первый товар) → fallback
            name=name_map.get(s["advert_id"]) or s["name"],
            status=status_map.get(s["advert_id"]),
            type=type_map.get(s["advert_id"]),
            cpm_min=cpm_min,
            cpm_competitive=cpm_competitive,
            cpm_top10=cpm_top10,
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
                type=c.get("type"),
                cpm_min=cpm_min,
                cpm_competitive=cpm_competitive,
                cpm_top10=cpm_top10,
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

    # Загружаем аккаунт отдельно — он понадобится и для услуг, и для начислений
    try:
        account = await acc_service.get_account(db, account_id, current_user.id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Аккаунт не найден")

    # 3. Доп. услуги WB из финансового отчёта (тихо падаем если нет доступа)
    service_costs = 0.0
    by_service: dict[str, float] = {}
    services_error: str | None = None
    try:
        from marketcore.ingestor.wb_client import WBClient
        client = WBClient(decrypt_api_key(account.api_key_cipher))
        svc = await client.get_wb_services_costs(date_from, date_to)
        service_costs = svc["total"]
        by_service = svc["by_type"]
    except Exception as e:
        services_error = str(e)

    total_costs = ad_spend + service_costs
    # drr_ad — ДРР к выручке заказов (orders_sum после SPP-фикса = что заплатили покупатели)
    drr_ad    = round(ad_spend / total_revenue * 100, 2) if total_revenue > 0 else None
    drr_total = round(total_costs / total_revenue * 100, 2) if total_revenue > 0 else None

    # ДРР к начислениям WB — отдельная метрика. Финотчёт закрывается еженедельно,
    # поэтому всегда смотрим 90 дней назад (а не за выбранный days-период).
    payout_sum: float | None = None
    drr_to_payouts: float | None = None
    try:
        from marketcore.api.routes.analytics import _fetch_payouts_90d
        ps, ok = await _fetch_payouts_90d([account])
        if ok:
            payout_sum = ps
            if ps > 0:
                drr_to_payouts = round(ad_spend / ps * 100, 2)
    except Exception:
        pass

    return {
        "period_days":    days,
        "ad_spend":       round(ad_spend, 2),
        "service_costs":  round(service_costs, 2),
        "total_costs":    round(total_costs, 2),
        "total_revenue":  round(total_revenue, 2),
        "payout_sum":     round(payout_sum, 2) if payout_sum is not None else None,
        "drr_ad":         drr_ad,
        "drr_total":      drr_total,
        "drr_to_payouts": drr_to_payouts,
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


@router.get("/sku-names", response_model=list[dict])
async def list_sku_names(
    account_id: uuid.UUID = Query(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[dict]:
    """SKU с реальными названиями (из таблицы sku_names) для массового создания кампаний."""
    await acc_service.get_account(db, account_id, current_user.id)
    rows = (await db.execute(
        select(SkuName)
        .where(SkuName.account_id == account_id, SkuName.name != "")
        .order_by(SkuName.name)
    )).scalars().all()
    return [{"sku": r.sku, "name": r.name} for r in rows]


class CreateSkuPackBody(BaseModel):
    account_id: uuid.UUID
    nm_ids: list[int]
    budget: int = 500
    cpm: int = 150
    schedule_hours: list[int]  # 24 значения 0–100


@router.post("/create-sku-pack", response_model=dict, status_code=201)
async def create_sku_pack(
    body: CreateSkuPackBody,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Создать одну авто-кампанию (CPM) на каждый выбранный SKU.

    Название кампании = реальное название товара из sku_names (с граммовкой/объёмом).
    Последовательно: создать кампанию → выставить CPM → применить расписание.
    """
    if len(body.schedule_hours) != 24:
        raise HTTPException(status_code=400, detail="schedule_hours должен содержать ровно 24 элемента")

    _, client = await _get_advert_client(body.account_id, current_user, db)

    # Загружаем названия из нашей таблицы sku_names
    nm_strs = [str(x) for x in body.nm_ids]
    name_rows = (await db.execute(
        select(SkuName).where(
            SkuName.account_id == body.account_id,
            SkuName.sku.in_(nm_strs),
        )
    )).scalars().all()
    name_map = {r.sku: r.name for r in name_rows}

    created: list[dict] = []
    errors:  list[dict] = []

    for nm_id in body.nm_ids:
        raw_name = name_map.get(str(nm_id), f"SKU {nm_id}")
        name = raw_name[:100]  # WB ограничивает до 100 символов

        try:
            advert_id = await client.create_auto_campaign([nm_id], body.budget, name)
        except Exception as e:
            errors.append({"nm_id": nm_id, "step": "create", "error": str(e)})
            continue

        try:
            await client.set_campaign_cpm(advert_id=advert_id, advert_type=8, cpm=body.cpm, param=0)
        except Exception as e:
            errors.append({"nm_id": nm_id, "advert_id": advert_id, "step": "set_cpm", "error": str(e)})

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


# ─── Авто-переключение расписания выходные/будни ─────────────────────────────

class AutoScheduleBody(BaseModel):
    account_id: uuid.UUID
    name: str
    advert_ids: list[int]
    weekday_hours: list[int]   # 24 значения
    weekend_hours: list[int]   # 24 значения


class AutoScheduleOut(BaseModel):
    id: str
    name: str
    advert_ids: list[int]
    weekday_hours: list[int]
    weekend_hours: list[int]
    is_active: bool
    created_at: str


@router.get("/auto-schedules", response_model=list[AutoScheduleOut])
async def list_auto_schedules(
    account_id: uuid.UUID = Query(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[AutoScheduleOut]:
    rows = list((await db.execute(
        select(CampaignAutoSchedule)
        .where(CampaignAutoSchedule.account_id == account_id)
        .where(CampaignAutoSchedule.user_id == current_user.id)
        .order_by(CampaignAutoSchedule.created_at.desc())
    )).scalars().all())
    return [AutoScheduleOut(
        id=str(r.id), name=r.name, advert_ids=r.advert_ids or [],
        weekday_hours=r.weekday_hours, weekend_hours=r.weekend_hours,
        is_active=r.is_active, created_at=r.created_at.isoformat(),
    ) for r in rows]


@router.post("/auto-schedules", response_model=AutoScheduleOut, status_code=201)
async def create_auto_schedule(
    body: AutoScheduleBody,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> AutoScheduleOut:
    if len(body.weekday_hours) != 24 or len(body.weekend_hours) != 24:
        raise HTTPException(status_code=400, detail="weekday_hours и weekend_hours должны содержать 24 элемента")
    row = CampaignAutoSchedule(
        user_id=current_user.id,
        account_id=body.account_id,
        name=body.name,
        advert_ids=body.advert_ids,
        weekday_hours=body.weekday_hours,
        weekend_hours=body.weekend_hours,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return AutoScheduleOut(
        id=str(row.id), name=row.name, advert_ids=row.advert_ids or [],
        weekday_hours=row.weekday_hours, weekend_hours=row.weekend_hours,
        is_active=row.is_active, created_at=row.created_at.isoformat(),
    )


@router.patch("/auto-schedules/{schedule_id}/toggle", response_model=AutoScheduleOut)
async def toggle_auto_schedule(
    schedule_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> AutoScheduleOut:
    row = (await db.execute(
        select(CampaignAutoSchedule)
        .where(CampaignAutoSchedule.id == schedule_id)
        .where(CampaignAutoSchedule.user_id == current_user.id)
    )).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Конфиг не найден")
    row.is_active = not row.is_active
    await db.commit()
    await db.refresh(row)
    return AutoScheduleOut(
        id=str(row.id), name=row.name, advert_ids=row.advert_ids or [],
        weekday_hours=row.weekday_hours, weekend_hours=row.weekend_hours,
        is_active=row.is_active, created_at=row.created_at.isoformat(),
    )


@router.delete("/auto-schedules/{schedule_id}", status_code=204)
async def delete_auto_schedule(
    schedule_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    row = (await db.execute(
        select(CampaignAutoSchedule)
        .where(CampaignAutoSchedule.id == schedule_id)
        .where(CampaignAutoSchedule.user_id == current_user.id)
    )).scalar_one_or_none()
    if row:
        await db.delete(row)
        await db.commit()
