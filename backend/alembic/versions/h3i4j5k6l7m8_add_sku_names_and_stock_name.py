"""add sku_names table and name column to sku_stocks

Revision ID: h3i4j5k6l7m8
Revises: g2h3i4j5k6l7
Create Date: 2026-04-28 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = 'h3i4j5k6l7m8'
down_revision = 'g2h3i4j5k6l7'
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()

    # 1. Добавляем колонку name в sku_stocks (IF NOT EXISTS — безопасно повторно)
    conn.execute(sa.text(
        "ALTER TABLE sku_stocks ADD COLUMN IF NOT EXISTS name VARCHAR(512) NOT NULL DEFAULT ''"
    ))

    # 2. Создаём таблицу sku_names (IF NOT EXISTS)
    conn.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS sku_names (
            account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            sku        VARCHAR(255) NOT NULL,
            name       VARCHAR(512) NOT NULL DEFAULT '',
            updated_at TIMESTAMPTZ DEFAULT now(),
            PRIMARY KEY (account_id, sku)
        )
    """))
    conn.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS ix_sku_names_account ON sku_names (account_id)"
    ))


def downgrade() -> None:
    op.drop_table('sku_names')
    op.drop_column('sku_stocks', 'name')
