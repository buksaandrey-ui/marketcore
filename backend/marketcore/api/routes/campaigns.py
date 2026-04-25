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
from marketcore.models import AdStat, SkuPrice, SkuStock, User

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

    account_id_str = str(account_id)

    # Берём уникальные SKU с последней ценой
    prices_q = (
        select(SkuPrice.sku, func.max(SkuPrice.price).label("price"))
        .where(SkuPrice.account_id == account_id_str)
        .group_by(SkuPrice.sku)
    )
    prices_rows = (await db.execute(prices_q)).all()
    price_map: dict[str, float] = {r.sku: r.price for r in prices_rows}

    # Суммарный остаток по всем складам
    stocks_q = (
        select(SkuStock.sku, func.sum(SkuStock.quantity).label("stock"))
        .where(SkuStock.account_id == account_id_str)
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
