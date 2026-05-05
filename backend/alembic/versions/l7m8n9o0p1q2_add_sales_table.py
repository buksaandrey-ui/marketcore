"""add sales table for wb redemptions (выкупы)

Revision ID: l7m8n9o0p1q2
Revises: k6l7m8n9o0p1
Create Date: 2026-05-05

Таблица sales хранит факты выкупа товаров покупателями.
WB API /api/v1/supplier/sales:
  saleID начинается с "S" = продажа, с "R" = возврат.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "l7m8n9o0p1q2"
down_revision: Union[str, None] = "k6l7m8n9o0p1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "sales",
        sa.Column("id",               sa.UUID(),                       nullable=False),
        sa.Column("account_id",       sa.UUID(),                       nullable=False),
        sa.Column("external_id",      sa.String(length=255),           nullable=False),
        sa.Column("sku",              sa.String(length=255),           nullable=False),
        sa.Column("quantity",         sa.Integer(),                    nullable=False, server_default="1"),
        sa.Column("price_buyer",      sa.Float(),                      nullable=False),
        sa.Column("price_seller",     sa.Float(),                      nullable=False),
        sa.Column("is_return",        sa.Boolean(),                    nullable=False, server_default="false"),
        sa.Column("warehouse",        sa.String(length=255),           nullable=True),
        sa.Column("customer_district",sa.String(length=100),           nullable=True),
        sa.Column("sold_at",          sa.DateTime(timezone=True),      nullable=False),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"]),
        sa.PrimaryKeyConstraint("id", "sold_at"),
        sa.UniqueConstraint(
            "account_id", "external_id", "sold_at",
            name="uq_sales_account_external",
        ),
    )
    # Индексы для быстрых запросов по периоду и аккаунту
    op.create_index("ix_sales_account_sold_at", "sales", ["account_id", "sold_at"])
    op.create_index("ix_sales_sku", "sales", ["sku"])


def downgrade() -> None:
    op.drop_index("ix_sales_sku",              table_name="sales")
    op.drop_index("ix_sales_account_sold_at",  table_name="sales")
    op.drop_table("sales")
