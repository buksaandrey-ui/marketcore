import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from marketcore.auth.dependencies import get_current_user
from marketcore.database import get_db
from marketcore.models import Schedule, User

router = APIRouter(prefix="/schedules", tags=["schedules"])


class ScheduleCreate(BaseModel):
    name: str
    schedule_json: dict


class ScheduleResponse(BaseModel):
    id: uuid.UUID
    name: str
    schedule_json: dict
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


@router.get("", response_model=list[ScheduleResponse])
async def list_schedules(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[ScheduleResponse]:
    result = await db.execute(
        select(Schedule)
        .where(Schedule.user_id == current_user.id)
        .order_by(Schedule.updated_at.desc())
    )
    return [ScheduleResponse.model_validate(s) for s in result.scalars().all()]


@router.post("", response_model=ScheduleResponse, status_code=status.HTTP_201_CREATED)
async def create_schedule(
    body: ScheduleCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ScheduleResponse:
    row = Schedule(
        user_id=current_user.id,
        name=body.name,
        schedule_json=body.schedule_json,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return ScheduleResponse.model_validate(row)


@router.put("/{schedule_id}", response_model=ScheduleResponse)
async def update_schedule(
    schedule_id: uuid.UUID,
    body: ScheduleCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ScheduleResponse:
    row = (
        await db.execute(select(Schedule).where(Schedule.id == schedule_id))
    ).scalar_one_or_none()
    if row is None or row.user_id != current_user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Расписание не найдено")
    row.name = body.name
    row.schedule_json = body.schedule_json
    await db.commit()
    await db.refresh(row)
    return ScheduleResponse.model_validate(row)


@router.delete("/{schedule_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_schedule(
    schedule_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    row = (
        await db.execute(select(Schedule).where(Schedule.id == schedule_id))
    ).scalar_one_or_none()
    if row is None or row.user_id != current_user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Расписание не найдено")
    await db.delete(row)
    await db.commit()
