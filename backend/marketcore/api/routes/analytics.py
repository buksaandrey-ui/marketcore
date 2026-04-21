import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from marketcore.analytics.localization import LIZone, LocalizationService
from marketcore.auth.dependencies import get_current_user
from marketcore.database import get_db
from marketcore.models import Account, User

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
