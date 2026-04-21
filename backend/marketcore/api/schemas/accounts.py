import uuid
from datetime import datetime

from pydantic import BaseModel


class AccountCreate(BaseModel):
    marketplace: str
    name: str
    seller_id: str
    api_key: str


class AccountResponse(BaseModel):
    id: uuid.UUID
    marketplace: str
    name: str
    seller_id: str
    status: str
    last_sync_at: datetime | None
    created_at: datetime

    model_config = {"from_attributes": True}
