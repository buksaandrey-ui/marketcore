"""add advert_api_key_cipher to accounts — optional WB Advertising API key

Revision ID: b1c2d3e4f5a6
Revises: a7b8c9d0e1f2
Create Date: 2026-04-24 12:00:00.000000

WB использует ДВА отдельных API-ключа:
  1. api_key_cipher          — Statistics API (заказы, остатки, цены)
  2. advert_api_key_cipher   — Advert API (кампании, ставки, аукцион)

Ключ 2 опциональный: если не задан, кампании и ставки недоступны,
но статистика продолжает работать.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'b1c2d3e4f5a6'
down_revision: Union[str, None] = 'a7b8c9d0e1f2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'accounts',
        sa.Column('advert_api_key_cipher', sa.LargeBinary(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('accounts', 'advert_api_key_cipher')
