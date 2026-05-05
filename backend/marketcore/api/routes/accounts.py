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

    results: dict = {}
    account_id_str = str(account_id)
    api_key = decrypt_api_key(account.api_key_cipher)

    # Инкрементальность: тянем только то что изменилось с последней синхронизации.
    # Overlap 24ч защищает от пропуска данных при задержках WB API.
    now = datetime.now(timezone.utc)
    if account.last_sync_at:
        since = account.last_sync_at - timedelta(hours=24)
    else:
        since = now - timedelta(days=90)   # первый синк — 90 дней истории

    # WB обновляет рекламную статистику ретроактивно до 14 дней.
    # Для заказов смотрим с since (инкремент), для рекламы — всегда 14 дней назад.
    ad_since = now - timedelta(days=14)
    date_str_from = ad_since.strftime("%Y-%m-%d")
    date_str_to   = now.strftime("%Y-%m-%d")

    try:
        if account.marketplace == "wb":
            results = await _sync_wb(db, account, account_id_str, api_key, since, date_str_from, date_str_to)
        else:
            results = await _sync_ozon(account, account_id_str, api_key, since, date_str_from, date_str_to)
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Ошибка API маркетплейса: {e}")

    account.status = "active"
    account.last_sync_at = now
    await db.commit()

    return {"status": "ok", "synced": results}


async def _sync_wb(
    db: AsyncSession,
    account,
    account_id_str: str,
    api_key: str,
    since: datetime,
    date_str_from: str,
    date_str_to: str,
) -> dict:
    """Синхронизация WB-аккаунта: заказы, остатки, цены, реклама, имена."""
    from marketcore.ingestor.db import (
        enrich_sku_names_with_params, save_ad_stats_wb, save_orders_wb,
        save_prices_wb, save_sku_names, save_sku_names_from_stocks, save_stocks_wb,
    )
    from marketcore.ingestor.wb_client import WBClient

    results: dict = {}
    client = WBClient(api_key)

    results["orders"] = await _sync_orders(client.get_orders, save_orders_wb, account_id_str, since)
    stocks = await _sync_stocks(client.get_stocks, save_stocks_wb, account_id_str, since)
    results["stocks"] = stocks["count"]
    results["sku_names_stocks"] = await _safe(save_sku_names_from_stocks, account_id_str, stocks["raw"])

    results["prices"] = await _safe(
        lambda: client.get_prices(),
        __save=lambda p: save_prices_wb(account_id_str, p),
    )

    advert_key = (
        decrypt_api_key(account.advert_api_key_cipher)
        if account.advert_api_key_cipher
        else api_key
    )
    advert_client = WBClient(advert_key)

    results["campaign_names_cached"] = await _sync_campaign_names(db, account.id, advert_client)
    ad_result = await _sync_ad_stats(advert_client, account_id_str, date_str_from, date_str_to)
    results.update(ad_result)

    results["sku_params"] = await _safe(enrich_sku_names_with_params, account_id_str)
    return results


async def _sync_ozon(
    account,
    account_id_str: str,
    api_key: str,
    since: datetime,
    date_str_from: str,
    date_str_to: str,
) -> dict:
    """Синхронизация Ozon-аккаунта."""
    from marketcore.ingestor.db import (
        save_ad_stats_ozon, save_orders_ozon, save_prices_ozon, save_stocks_ozon,
    )
    from marketcore.ingestor.ozon_client import OzonClient

    results: dict = {}
    client = OzonClient(account.seller_id, api_key)

    results["orders"] = await _sync_orders(client.get_orders, save_orders_ozon, account_id_str, since)
    stocks = await _sync_stocks(client.get_stocks, save_stocks_ozon, account_id_str, since)
    results["stocks"] = stocks["count"]

    results["prices"] = await _safe(
        lambda: client.get_prices(),
        __save=lambda p: save_prices_ozon(account_id_str, p),
    )
    ad_result = await _sync_ad_stats_generic(client, account_id_str, date_str_from, date_str_to, save_ad_stats_ozon)
    results.update(ad_result)
    return results


async def _sync_orders(get_fn, save_fn, account_id_str: str, since: datetime) -> int:
    """Тянет заказы с момента since и сохраняет в БД."""
    try:
        raw = await get_fn(since)
        return await save_fn(account_id_str, raw)
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning("[sync] orders error: %s", e)
        return 0


async def _sync_stocks(get_fn, save_fn, account_id_str: str, since: datetime) -> dict:
    """Тянет остатки (снапшот) и сохраняет."""
    try:
        raw = await get_fn(since)
        count = await save_fn(account_id_str, raw)
        return {"count": count, "raw": raw}
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning("[sync] stocks error: %s", e)
        return {"count": 0, "raw": []}


async def _sync_campaign_names(db: AsyncSession, account_id: uuid.UUID, advert_client) -> int:
    """Обновляет кэш имён кампаний в campaign_names."""
    try:
        from marketcore.api.routes.campaigns import _save_campaign_names_cache
        campaigns_list = await advert_client.list_campaigns(statuses=[7, 9, 11])
        await _save_campaign_names_cache(db, account_id, campaigns_list)
        return len(campaigns_list)
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning("[sync] campaign_names error: %s", e)
        return 0


async def _sync_ad_stats(advert_client, account_id_str: str, date_from: str, date_to: str) -> dict:
    """Тянет рекламную статистику WB и обновляет sku_names из неё."""
    from marketcore.ingestor.db import save_ad_stats_wb, save_sku_names
    try:
        ad_stats = await advert_client.get_ad_stats(date_from, date_to)
        n_stats = await save_ad_stats_wb(account_id_str, ad_stats)
        n_names = await save_sku_names(account_id_str, ad_stats)
        return {"ad_stats": n_stats, "sku_names": n_names}
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning("[sync] ad_stats error: %s", e)
        return {"ad_stats": 0, "ad_stats_error": str(e)}


async def _sync_ad_stats_generic(client, account_id_str: str, date_from: str, date_to: str, save_fn) -> dict:
    try:
        ad_stats = await client.get_ad_stats(date_from, date_to)
        return {"ad_stats": await save_fn(account_id_str, ad_stats)}
    except Exception:
        return {"ad_stats": 0}


async def _safe(fn, *args, __save=None, **kwargs) -> int:
    """Безопасный вызов: тянет данные через fn(*args), сохраняет через __save если задан."""
    try:
        data = await fn(*args, **kwargs)
        if __save is not None:
            return await __save(data)
        return data if isinstance(data, int) else 0
    except Exception:
        return 0


@router.get("/{account_id}/debug-ad-stats")
async def debug_ad_stats(
    account_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Отладка: вызывает get_ad_stats напрямую и возвращает сырой результат."""
    try:
        account = await service.get_account(db, account_id, current_user.id)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))

    if account.marketplace != "wb":
        return {"error": "Только для WB"}

    advert_key = (
        decrypt_api_key(account.advert_api_key_cipher)
        if account.advert_api_key_cipher
        else decrypt_api_key(account.api_key_cipher)
    )

    from marketcore.ingestor.wb_client import WBClient
    import httpx as _httpx

    client = WBClient(advert_key)
    date_str_from = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d")
    date_str_to   = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # Шаг 1: список кампаний
    try:
        campaigns = await client.list_campaigns(statuses=[7, 9, 11])
    except Exception as e:
        return {"step": "list_campaigns", "error": str(e)}

    if not campaigns:
        return {"step": "list_campaigns", "result": "empty", "campaigns_count": 0}

    # Шаг 2: тестируем разные endpoint для статистики
    advert_ids = [c["advert_id"] for c in campaigns[:3]]
    payload = [{"id": aid, "dates": [date_str_from, date_str_to]} for aid in advert_ids]
    results_map: dict = {
        "campaigns_total": len(campaigns),
        "sample_ids": advert_ids,
        "date_from": date_str_from,
        "date_to": date_str_to,
        "endpoints_tested": {},
    }

    aid0 = advert_ids[0]
    # Тестируем правильный endpoint с верными параметрами
    async with _httpx.AsyncClient(timeout=30.0) as http:
        try:
            resp = await http.get(
                "https://advert-api.wildberries.ru/adv/v3/fullstats",
                headers={"Authorization": advert_key},
                params={"ids": str(aid0), "beginDate": date_str_from, "endDate": date_str_to},
            )
            results_map["v3_fullstats_test"] = {
                "campaign_id": aid0,
                "status": resp.status_code,
                "body": resp.text[:2000],
            }
        except Exception as e:
            results_map["v3_fullstats_test"] = {"error": str(e)}

    return results_map


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


@router.get("/{account_id}/sync-status")
async def get_sync_status(
    account_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Статус последней синхронизации и свежесть кэшей аккаунта."""
    from sqlalchemy import select as _select, func as _func
    from marketcore.models import AdStat, CampaignName, Order, SkuName, SkuStock

    try:
        account = await service.get_account(db, account_id, current_user.id)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))

    # Последняя дата заказа в БД
    last_order = (await db.execute(
        _select(_func.max(Order.ordered_at)).where(Order.account_id == account_id)
    )).scalar_one_or_none()

    # Последняя дата рекламной статистики
    last_ad_stat = (await db.execute(
        _select(_func.max(AdStat.stat_date)).where(AdStat.account_id == account_id)
    )).scalar_one_or_none()

    # Свежесть кэша имён кампаний
    last_campaign_names = (await db.execute(
        _select(_func.max(CampaignName.updated_at)).where(CampaignName.account_id == account_id)
    )).scalar_one_or_none()

    # Свежесть кэша имён SKU
    last_sku_names = (await db.execute(
        _select(_func.max(SkuName.updated_at)).where(SkuName.account_id == account_id)
    )).scalar_one_or_none()

    def _iso(dt) -> str | None:
        return dt.isoformat() if dt else None

    return {
        "account_id": str(account_id),
        "last_sync_at": _iso(account.last_sync_at),
        "last_order_at": _iso(last_order),
        "last_ad_stat_at": _iso(last_ad_stat),
        "campaign_names_updated_at": _iso(last_campaign_names),
        "sku_names_updated_at": _iso(last_sku_names),
    }
