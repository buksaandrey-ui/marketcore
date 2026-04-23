"""История действий автобота — что он посчитал/сделал и почему.

На Неделе 1 здесь только результаты tick_bidding_schedules (dry-run, без записи на WB/Ozon).
На Неделе 2 сюда же будут писаться реальные применения ставок (mode=live).
"""
from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from marketcore.auth.dependencies import get_current_user
from marketcore.database import get_db
from marketcore.models import RuleExecution, User

router = APIRouter(prefix="/bidding/executions", tags=["bidding"])


class ExecutionRow(BaseModel):
    id: uuid.UUID
    schedule_id: uuid.UUID | None
    account_id: uuid.UUID | None
    computed_at: datetime
    platform: str
    pay_model: str
    base_cpm: float
    multiplier_pct: int
    target_cpm: float
    mode: str
    status: str
    reason: str

    model_config = {"from_attributes": True}


@router.get("", response_model=list[ExecutionRow])
async def list_executions(
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[ExecutionRow]:
    limit = max(1, min(limit, 500))
    result = await db.execute(
        select(RuleExecution)
        .where(RuleExecution.user_id == current_user.id)
        .order_by(RuleExecution.computed_at.desc())
        .limit(limit)
    )
    return [ExecutionRow.model_validate(r) for r in result.scalars().all()]
