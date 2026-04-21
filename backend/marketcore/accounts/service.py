import uuid

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from marketcore.accounts.encryption import decrypt_api_key, encrypt_api_key
from marketcore.models import Account

WB_VERIFY_URL = "https://common-api.wildberries.ru/api/v1/info"
OZON_VERIFY_URL = "https://api-seller.ozon.ru/v3/product/info/list"


async def create_account(
    db: AsyncSession,
    user_id: uuid.UUID,
    marketplace: str,
    name: str,
    seller_id: str,
    api_key: str,
) -> Account:
    if marketplace not in ("wb", "ozon"):
        raise ValueError("marketplace должен быть 'wb' или 'ozon'")

    account = Account(
        user_id=user_id,
        marketplace=marketplace,
        name=name,
        seller_id=seller_id,
        api_key_cipher=encrypt_api_key(api_key),
        status="pending",
    )
    db.add(account)
    await db.commit()
    await db.refresh(account)
    return account


async def get_user_accounts(db: AsyncSession, user_id: uuid.UUID) -> list[Account]:
    result = await db.scalars(select(Account).where(Account.user_id == user_id))
    return list(result.all())


async def get_account(db: AsyncSession, account_id: uuid.UUID, user_id: uuid.UUID) -> Account:
    account = await db.scalar(
        select(Account).where(Account.id == account_id, Account.user_id == user_id)
    )
    if not account:
        raise ValueError("Кабинет не найден")
    return account


async def delete_account(db: AsyncSession, account_id: uuid.UUID, user_id: uuid.UUID) -> None:
    account = await get_account(db, account_id, user_id)
    await db.delete(account)
    await db.commit()


async def verify_account(db: AsyncSession, account_id: uuid.UUID, user_id: uuid.UUID) -> Account:
    account = await get_account(db, account_id, user_id)
    api_key = decrypt_api_key(account.api_key_cipher)

    try:
        if account.marketplace == "wb":
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(
                    WB_VERIFY_URL,
                    headers={"Authorization": api_key},
                )
            account.status = "active" if resp.status_code == 200 else "invalid"
        else:  # ozon
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(
                    OZON_VERIFY_URL,
                    headers={"Client-Id": account.seller_id, "Api-Key": api_key},
                    json={"filter": {"offer_id": [], "product_id": [], "visibility": "ALL"}, "limit": 1},
                )
            account.status = "active" if resp.status_code in (200, 400) else "invalid"
    except httpx.RequestError:
        account.status = "invalid"

    await db.commit()
    await db.refresh(account)
    return account
