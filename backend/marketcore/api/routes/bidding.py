import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from marketcore.auth.dependencies import get_current_user
from marketcore.bidding.dsl import RuleCompiler, SchemaValidator
from marketcore.database import get_db
from marketcore.models import Account, BiddingRule, User

router = APIRouter(prefix="/bidding/rules", tags=["bidding"])
_validator = SchemaValidator()
_compiler = RuleCompiler()


class RuleCreate(BaseModel):
    account_id: uuid.UUID
    rule: dict


class RuleResponse(BaseModel):
    id: uuid.UUID
    account_id: uuid.UUID
    rule_id: str
    name: str
    version: int
    priority: int
    enabled: bool
    dry_run: bool
    rule_json: dict
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


async def _owned_account(db: AsyncSession, account_id: uuid.UUID, user_id: uuid.UUID) -> Account:
    result = await db.execute(select(Account).where(Account.id == account_id))
    acc = result.scalar_one_or_none()
    if acc is None or acc.user_id != user_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Аккаунт не найден")
    return acc


def _validate_and_compile(rule: dict) -> None:
    errors = _validator.validate(rule)
    if errors:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail={"validation_errors": errors})
    try:
        _compiler.compile(rule)
    except (ValueError, KeyError) as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=f"compile_error: {e}")


@router.post("", response_model=RuleResponse, status_code=status.HTTP_201_CREATED)
async def create_rule(
    body: RuleCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> RuleResponse:
    await _owned_account(db, body.account_id, current_user.id)
    _validate_and_compile(body.rule)
    row = BiddingRule(
        account_id=body.account_id,
        rule_id=body.rule["rule_id"],
        name=body.rule["name"],
        version=body.rule["version"],
        priority=body.rule.get("priority", 100),
        enabled=body.rule.get("enabled", True),
        dry_run=body.rule.get("dry_run", False),
        rule_json=body.rule,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return RuleResponse.model_validate(row)


@router.get("", response_model=list[RuleResponse])
async def list_rules(
    account_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[RuleResponse]:
    await _owned_account(db, account_id, current_user.id)
    result = await db.execute(
        select(BiddingRule).where(BiddingRule.account_id == account_id).order_by(BiddingRule.priority.desc())
    )
    return [RuleResponse.model_validate(r) for r in result.scalars().all()]


@router.put("/{rule_pk}", response_model=RuleResponse)
async def update_rule(
    rule_pk: uuid.UUID,
    body: RuleCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> RuleResponse:
    row = (await db.execute(select(BiddingRule).where(BiddingRule.id == rule_pk))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Правило не найдено")
    await _owned_account(db, row.account_id, current_user.id)
    _validate_and_compile(body.rule)
    row.rule_id = body.rule["rule_id"]
    row.name = body.rule["name"]
    row.version = body.rule["version"]
    row.priority = body.rule.get("priority", 100)
    row.enabled = body.rule.get("enabled", True)
    row.dry_run = body.rule.get("dry_run", False)
    row.rule_json = body.rule
    await db.commit()
    await db.refresh(row)
    return RuleResponse.model_validate(row)


@router.delete("/{rule_pk}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_rule(
    rule_pk: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    row = (await db.execute(select(BiddingRule).where(BiddingRule.id == rule_pk))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Правило не найдено")
    await _owned_account(db, row.account_id, current_user.id)
    await db.delete(row)
    await db.commit()


class ValidateRequest(BaseModel):
    rule: dict


class ValidateResponse(BaseModel):
    valid: bool
    errors: list[str] = []


@router.post("/validate", response_model=ValidateResponse)
async def validate_rule(body: ValidateRequest, _: User = Depends(get_current_user)) -> ValidateResponse:
    errors = _validator.validate(body.rule)
    if not errors:
        try:
            _compiler.compile(body.rule)
        except (ValueError, KeyError) as e:
            errors.append(f"compile_error: {e}")
    return ValidateResponse(valid=not errors, errors=errors)
