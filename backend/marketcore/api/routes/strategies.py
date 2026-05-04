"""
/strategies — управление стратегией «2 пика» для рекламных кампаний WB.

Эндпоинты:
  POST   /strategies/two-peaks          — создать/обновить стратегию для кампании
  GET    /strategies?account_id=        — список стратегий аккаунта
  GET    /strategies/{id}               — стратегия по ID
  DELETE /strategies/{id}               — удалить стратегию
  PATCH  /strategies/{id}/toggle        — вкл/выкл
  POST   /strategies/{id}/run           — запустить немедленно (dry-run)
  GET    /strategies/{id}/schedule      — расписание на неделю (тепловая карта)
  GET    /strategies/{id}/log?limit=100 — лог изменений ставок
  GET    /strategies/categories         — список доступных профилей категорий
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from marketcore.accounts import service as acc_service
from marketcore.accounts.encryption import decrypt_api_key
from marketcore.auth.dependencies import get_current_user
from marketcore.database import get_db
from marketcore.models import Account, BidChangeLog, CampaignStrategy, User
from marketcore.strategy.models import CampaignStrategyConfig
from marketcore.strategy.two_peaks.default_profiles import DEFAULT_PROFILES
from marketcore.strategy.two_peaks.schedule_builder import build_weekly_schedule
from marketcore.strategy.two_peaks.default_profiles import get_default_profile

router = APIRouter(prefix="/strategies", tags=["strategies"])


# ─── Schemas ─────────────────────────────────────────────────────────────────

class TwoPeaksBody(BaseModel):
    account_id: uuid.UUID
    campaign_id: int
    category: str = "universal"
    cpm_min: int = 100
    cpm_cap: int = 5000
    drr_threshold_pct: float = 15.0
    min_stock: int = 5
    budget_warning_pct: float = 80.0
    budget_stop_pct: float = 95.0
    dry_run: bool = True
    use_history: bool = True
    history_min_days: int = 14


class StrategyOut(BaseModel):
    id: uuid.UUID
    account_id: uuid.UUID
    campaign_id: int
    strategy_type: str
    category: str
    cpm_min: int
    cpm_cap: int
    drr_threshold_pct: float
    min_stock: int
    budget_warning_pct: float
    budget_stop_pct: float
    dry_run: bool
    use_history: bool
    history_min_days: int
    enabled: bool
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class BidLogOut(BaseModel):
    id: uuid.UUID
    campaign_id: int
    computed_at: datetime
    day_type: str
    hour: int
    demand_level: str
    bid_type: str
    cpm_min: int
    cpm_target: int
    cpm_prev: int
    applied: bool
    dry_run: bool
    skip_reason: str

    class Config:
        from_attributes = True


# ─── Helpers ─────────────────────────────────────────────────────────────────

async def _get_strategy_or_404(
    strategy_id: uuid.UUID,
    user: User,
    db: AsyncSession,
) -> CampaignStrategy:
    stmt = select(CampaignStrategy).where(
        CampaignStrategy.id == strategy_id,
        CampaignStrategy.user_id == user.id,
    )
    row = (await db.execute(stmt)).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Стратегия не найдена")
    return row


async def _get_wb_client(account_id: uuid.UUID, user: User, db: AsyncSession):
    from marketcore.ingestor.wb_client import WBClient

    try:
        account = await acc_service.get_account(db, account_id, user.id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    if account.marketplace != "wb":
        raise HTTPException(status_code=400, detail="Только для WB аккаунтов")

    advert_key = (
        decrypt_api_key(account.advert_api_key_cipher)
        if account.advert_api_key_cipher
        else decrypt_api_key(account.api_key_cipher)
    )
    return WBClient(advert_key)


# ─── Routes ──────────────────────────────────────────────────────────────────

@router.get("/categories")
async def list_categories(
    current_user: User = Depends(get_current_user),
):
    """Список доступных профилей категорий."""
    return {
        "categories": [
            {"key": key, "label": _category_label(key)}
            for key in DEFAULT_PROFILES
        ]
    }


@router.post("/two-peaks", response_model=StrategyOut)
async def create_or_update_strategy(
    body: TwoPeaksBody,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Создаёт или обновляет стратегию «2 пика» для кампании."""
    # Проверяем принадлежность аккаунта
    try:
        await acc_service.get_account(db, body.account_id, current_user.id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Аккаунт не найден")

    # Ищем существующую запись
    stmt = select(CampaignStrategy).where(
        CampaignStrategy.account_id == body.account_id,
        CampaignStrategy.campaign_id == body.campaign_id,
    )
    existing = (await db.execute(stmt)).scalar_one_or_none()

    if existing:
        existing.category = body.category
        existing.cpm_min = body.cpm_min
        existing.cpm_cap = body.cpm_cap
        existing.drr_threshold_pct = body.drr_threshold_pct
        existing.min_stock = body.min_stock
        existing.budget_warning_pct = body.budget_warning_pct
        existing.budget_stop_pct = body.budget_stop_pct
        existing.dry_run = body.dry_run
        existing.use_history = body.use_history
        existing.history_min_days = body.history_min_days
        existing.updated_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(existing)
        return existing

    new_strategy = CampaignStrategy(
        user_id=current_user.id,
        account_id=body.account_id,
        campaign_id=body.campaign_id,
        strategy_type="two_peaks",
        category=body.category,
        cpm_min=body.cpm_min,
        cpm_cap=body.cpm_cap,
        drr_threshold_pct=body.drr_threshold_pct,
        min_stock=body.min_stock,
        budget_warning_pct=body.budget_warning_pct,
        budget_stop_pct=body.budget_stop_pct,
        dry_run=body.dry_run,
        use_history=body.use_history,
        history_min_days=body.history_min_days,
        enabled=True,
    )
    db.add(new_strategy)
    await db.commit()
    await db.refresh(new_strategy)
    return new_strategy


@router.post("/two-peaks/bulk")
async def bulk_create_or_update_strategy(
    body: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Массовое создание/обновление стратегий «2 пика» сразу для N кампаний.

    body: {
      account_id: str,
      campaign_ids: list[int],        # список ID кампаний
      category: str,
      cpm_min: int, cpm_cap: int,
      drr_threshold_pct: float,
      min_stock: int,
      dry_run: bool,
      ...
    }
    Возвращает: {created: int, updated: int, total: int}
    """
    from pydantic import BaseModel as BM

    # Валидируем вручную
    account_id_raw = body.get("account_id")
    campaign_ids = body.get("campaign_ids", [])

    if not account_id_raw or not campaign_ids:
        raise HTTPException(status_code=400, detail="account_id и campaign_ids обязательны")

    try:
        account_id_uuid = uuid.UUID(str(account_id_raw))
    except ValueError:
        raise HTTPException(status_code=400, detail="Неверный account_id")

    try:
        await acc_service.get_account(db, account_id_uuid, current_user.id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Аккаунт не найден")

    now = datetime.now(timezone.utc)
    created = 0
    updated = 0

    for campaign_id in campaign_ids:
        campaign_id = int(campaign_id)

        stmt = select(CampaignStrategy).where(
            CampaignStrategy.account_id == account_id_uuid,
            CampaignStrategy.campaign_id == campaign_id,
        )
        existing = (await db.execute(stmt)).scalar_one_or_none()

        params = dict(
            category=body.get("category", "universal"),
            cpm_min=int(body.get("cpm_min", 100)),
            cpm_cap=int(body.get("cpm_cap", 5000)),
            drr_threshold_pct=float(body.get("drr_threshold_pct", 15.0)),
            min_stock=int(body.get("min_stock", 5)),
            budget_warning_pct=float(body.get("budget_warning_pct", 80.0)),
            budget_stop_pct=float(body.get("budget_stop_pct", 95.0)),
            dry_run=bool(body.get("dry_run", True)),
            use_history=bool(body.get("use_history", True)),
            history_min_days=int(body.get("history_min_days", 14)),
        )

        if existing:
            for k, v in params.items():
                setattr(existing, k, v)
            existing.updated_at = now
            updated += 1
        else:
            new_s = CampaignStrategy(
                user_id=current_user.id,
                account_id=account_id_uuid,
                campaign_id=campaign_id,
                strategy_type="two_peaks",
                enabled=True,
                **params,
            )
            db.add(new_s)
            created += 1

    await db.commit()
    return {"created": created, "updated": updated, "total": created + updated}


@router.get("", response_model=list[StrategyOut])
async def list_strategies(
    account_id: uuid.UUID = Query(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Список всех стратегий аккаунта."""
    stmt = select(CampaignStrategy).where(
        CampaignStrategy.user_id == current_user.id,
        CampaignStrategy.account_id == account_id,
    ).order_by(CampaignStrategy.created_at.desc())
    rows = (await db.execute(stmt)).scalars().all()
    return rows


@router.get("/{strategy_id}", response_model=StrategyOut)
async def get_strategy(
    strategy_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await _get_strategy_or_404(strategy_id, current_user, db)


@router.delete("/{strategy_id}", status_code=204)
async def delete_strategy(
    strategy_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    s = await _get_strategy_or_404(strategy_id, current_user, db)
    await db.execute(delete(CampaignStrategy).where(CampaignStrategy.id == s.id))
    await db.commit()


@router.patch("/{strategy_id}/toggle", response_model=StrategyOut)
async def toggle_strategy(
    strategy_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Включить / выключить стратегию."""
    s = await _get_strategy_or_404(strategy_id, current_user, db)
    s.enabled = not s.enabled
    s.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(s)
    return s


@router.post("/{strategy_id}/run")
async def run_strategy_now(
    strategy_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Немедленно запускает расчёт ставки для кампании.
    Режим (dry_run / боевой) берётся из настроек стратегии.
    В dry_run=True — только логирует, ставку НЕ применяет.
    В dry_run=False — применяет ставку через WB Advert API.
    """
    from marketcore.strategy.two_peaks.strategy import TwoPeaksStrategy

    s = await _get_strategy_or_404(strategy_id, current_user, db)
    wb_client = await _get_wb_client(s.account_id, current_user, db)

    config = CampaignStrategyConfig(
        campaign_id=s.campaign_id,
        account_id=str(s.account_id),
        category=s.category,
        cpm_min=s.cpm_min,
        cpm_cap=s.cpm_cap,
        drr_threshold_pct=s.drr_threshold_pct,
        min_stock=s.min_stock,
        budget_warning_pct=s.budget_warning_pct,
        budget_stop_pct=s.budget_stop_pct,
        dry_run=s.dry_run,   # берём из настроек стратегии, не хардкодим True
        use_history=s.use_history,
        history_min_days=s.history_min_days,
    )

    strategy = TwoPeaksStrategy(config=config, wb_client=wb_client, db=db)
    result = await strategy.execute()

    return {
        "campaign_id": result.campaign_id,
        "day_type": result.day_type.value,
        "hour": result.hour,
        "demand_level": result.demand_level.value,
        "cpm_min": result.cpm_min,
        "cpm_target": result.cpm_target,
        "cpm_prev": result.cpm_prev,
        "applied": result.applied,
        "skip_reason": result.skip_reason,
        "dry_run": result.dry_run,
    }


@router.get("/{strategy_id}/schedule")
async def get_strategy_schedule(
    strategy_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Возвращает расписание ставок на неделю — 7 типов дня × 24 часа.
    Используется для тепловой карты на фронтенде.
    """
    s = await _get_strategy_or_404(strategy_id, current_user, db)

    # Пробуем построить профиль из истории
    category_profile = None
    if s.use_history:
        try:
            from marketcore.strategy.two_peaks.profile_builder import build_profile_from_history
            category_profile = await build_profile_from_history(
                db=db,
                account_id=str(s.account_id),
                campaign_ids=[str(s.campaign_id)],
                category=s.category,
                days=28,
                min_days=s.history_min_days,
            )
        except Exception:
            pass

    if category_profile is None:
        category_profile = get_default_profile(s.category)

    weekly = build_weekly_schedule(category_profile)

    return {
        "strategy_id": str(strategy_id),
        "campaign_id": s.campaign_id,
        "category": s.category,
        "source": "history" if category_profile.category != "universal" and s.use_history else "default",
        **weekly.to_dict(),
    }


@router.get("/{strategy_id}/log", response_model=list[BidLogOut])
async def get_strategy_log(
    strategy_id: uuid.UUID,
    limit: int = Query(100, le=500),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Лог последних изменений ставок для кампании."""
    s = await _get_strategy_or_404(strategy_id, current_user, db)

    stmt = (
        select(BidChangeLog)
        .where(
            BidChangeLog.account_id == s.account_id,
            BidChangeLog.campaign_id == s.campaign_id,
        )
        .order_by(BidChangeLog.computed_at.desc())
        .limit(limit)
    )
    rows = (await db.execute(stmt)).scalars().all()
    return rows


# ─── Utils ───────────────────────────────────────────────────────────────────

def _category_label(key: str) -> str:
    labels = {
        "fertilizers_plants": "Удобрения и товары для сада",
        "home_household":     "Товары для дома и быта",
        "beauty_care":        "Красота и уход",
        "sports_outdoor":     "Спорт и активный отдых",
        "universal":          "Универсальный (все категории)",
    }
    return labels.get(key, key)
