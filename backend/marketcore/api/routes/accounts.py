import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from marketcore.accounts import service
from marketcore.accounts.encryption import decrypt_api_key
from marketcore.api.schemas.accounts import AccountCreate, AccountResponse
from marketcore.auth.dependencies import get_current_user
from marketcore.database import get_db
from marketcore.models import User

router = APIRouter(prefix="/accounts", tags=["accounts"])


@router.post("", response_model=AccountResponse, status_code=status.HTTP_201_CREATED)
async def create_account(
    body: AccountCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> AccountResponse:
    try:
        account = await service.create_account(
            db, current_user.id, body.marketplace, body.name, body.seller_id, body.api_key,
            advert_api_key=body.advert_api_key,
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    return AccountResponse.model_validate(account)


@router.get("", response_model=list[AccountResponse])
async def list_accounts(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[AccountResponse]:
    accounts = await service.get_user_accounts(db, current_user.id)
    return [AccountResponse.model_validate(a) for a in accounts]


@router.delete("/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_account(
    account_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    try:
        await service.delete_account(db, account_id, current_user.id)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))


@router.post("/{account_id}/verify", response_model=AccountResponse)
async def verify_account(
    account_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> AccountResponse:
    try:
        account = await service.verify_account(db, account_id, current_user.id)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))
    return AccountResponse.model_validate(account)


@router.post("/{account_id}/sync")
async def sync_account(
    account_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    try:
        account = await service.get_account(db, account_id, current_user.id)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))

    api_key = decrypt_api_key(account.api_key_cipher)
    account_id_str = str(account_id)
    date_from = datetime.now(timezone.utc) - timedelta(days=30)
    results: dict = {}

    date_str_from = (datetime.now(timezone.utc) - timedelta(days=30)).strftime("%Y-%m-%d")
    date_str_to   = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    try:
        if account.marketplace == "wb":
            from marketcore.ingestor.db import save_ad_stats_wb, save_orders_wb, save_prices_wb, save_stocks_wb
            from marketcore.ingestor.wb_client import WBClient
            client = WBClient(api_key)
            orders = await client.get_orders(date_from)
            results["orders"] = await save_orders_wb(account_id_str, orders)
            stocks = await client.get_stocks(date_from)
            results["stocks"] = await save_stocks_wb(account_id_str, stocks)
            try:
                prices = await client.get_prices()
                results["prices"] = await save_prices_wb(account_id_str, prices)
            except Exception:
                results["prices"] = 0
            try:
                ad_stats = await client.get_ad_stats(date_str_from, date_str_to)
                results["ad_stats"] = await save_ad_stats_wb(account_id_str, ad_stats)
            except Exception:
                results["ad_stats"] = 0
        else:
            from marketcore.ingestor.db import save_ad_stats_ozon, save_orders_ozon, save_prices_ozon, save_stocks_ozon
            from marketcore.ingestor.ozon_client import OzonClient
            client = OzonClient(account.seller_id, api_key)
            orders = await client.get_orders(date_from)
            results["orders"] = await save_orders_ozon(account_id_str, orders)
            stocks = await client.get_stocks()
            results["stocks"] = await save_stocks_ozon(account_id_str, stocks)
            try:
                prices = await client.get_prices()
                results["prices"] = await save_prices_ozon(account_id_str, prices)
            except Exception:
                results["prices"] = 0
            try:
                ad_stats = await client.get_ad_stats(date_str_from, date_str_to)
                results["ad_stats"] = await save_ad_stats_ozon(account_id_str, ad_stats)
            except Exception:
                results["ad_stats"] = 0
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Ошибка API маркетплейса: {e}")

    # Mark account as active after successful sync
    account.status = "active"
    account.last_sync_at = datetime.now(timezone.utc)
    await db.commit()

    return {"status": "ok", "synced": results}


@router.get("/{account_id}/debug-wb-advert")
async def debug_wb_advert(
    account_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Отладочный endpoint: возвращает сырой ответ WB Advert API."""
    try:
        account = await service.get_account(db, account_id, current_user.id)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))

    if account.marketplace != "wb":
        return {"error": "Только для WB аккаунтов"}

    advert_key = (
        decrypt_api_key(account.advert_api_key_cipher)
        if account.advert_api_key_cipher
        else decrypt_api_key(account.api_key_cipher)
    )

    import httpx as _httpx
    import json as _json
    results: dict = {}
    async with _httpx.AsyncClient(timeout=20.0) as client:
        try:
            r = await client.get(
                "https://advert-api.wildberries.ru/adv/v1/promotion/count",
                headers={"Authorization": advert_key},
            )
            results["count_status"] = r.status_code
            results["count_body"] = r.text[:3000]
            # Попробуем второй шаг если первый успешен
            if r.status_code == 200:
                data = r.json()
                # Извлечь первые несколько ID из любого вложенного уровня
                ids = []
                for group in (data.get("adverts") or []):
                    if isinstance(group, dict):
                        for k, v in group.items():
                            results[f"group_keys"] = list(group.keys())
                            break
                        for item in (group.get("advert_list") or []):
                            if isinstance(item, dict):
                                results["advert_list_item_keys"] = list(item.keys())
                                results["advert_list_item_sample"] = str(item)[:200]
                            else:
                                results["advert_list_item_type"] = type(item).__name__
                                results["advert_list_item_sample"] = str(item)
                            if len(ids) < 3:
                                if isinstance(item, dict):
                                    for key in ("advertId", "id", "advert_id", "rcid"):
                                        if item.get(key):
                                            ids.append(item[key])
                                            break
                                elif item:
                                    ids.append(item)
                            break
                results["extracted_ids"] = ids
        except Exception as e:
            results["count_error"] = str(e)

    return results


@router.get("/{account_id}/campaigns")
async def list_campaigns(
    account_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[dict]:
    """Список активных рекламных кампаний аккаунта WB.

    Дёргает WB Advert API и возвращает:
      advert_id, name, type, cpm, subject_id, menu_id.
    Нужно для того, чтобы пользователь мог выбрать кампанию в расписании.
    Только для WB (Ozon будет отдельно в Неделе 3).
    """
    try:
        account = await service.get_account(db, account_id, current_user.id)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))

    if account.marketplace != "wb":
        return []

    # Рекламный API использует отдельный ключ (если задан), иначе — основной
    if account.advert_api_key_cipher:
        advert_key = decrypt_api_key(account.advert_api_key_cipher)
    else:
        advert_key = decrypt_api_key(account.api_key_cipher)

    try:
        from marketcore.ingestor.wb_client import WBClient
        client = WBClient(advert_key)
        # Активные (9) + приостановленные (11) — один двухшаговый вызов
        return await client.list_campaigns(statuses=[9, 11])
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Ошибка WB Advert API при получении кампаний: {e}. "
                   f"Убедись что добавлен рекламный API-ключ из cmp.wildberries.ru",
        )
