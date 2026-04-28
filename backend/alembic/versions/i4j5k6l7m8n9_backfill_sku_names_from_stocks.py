"""backfill sku_names from sku_stocks for existing accounts

Revision ID: i4j5k6l7m8n9
Revises: h3i4j5k6l7m8
Create Date: 2026-04-28 12:00:00.000000
"""
from alembic import op
import sqlalchemy as sa

revision = 'i4j5k6l7m8n9'
down_revision = 'h3i4j5k6l7m8'
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()

    # Заполняем sku_names из sku_stocks для всех существующих аккаунтов.
    # Берём первое непустое имя для каждой пары (account_id, sku).
    # ON CONFLICT DO NOTHING — не перезаписываем уже существующие записи.
    conn.execute(sa.text("""
        INSERT INTO sku_names (account_id, sku, name, updated_at)
        SELECT DISTINCT ON (account_id, sku)
            account_id,
            sku,
            name,
            NOW()
        FROM sku_stocks
        WHERE name IS NOT NULL AND name != ''
        ORDER BY account_id, sku, recorded_at DESC
        ON CONFLICT DO NOTHING
    """))


def downgrade() -> None:
    # Откат не делаем — нельзя отличить данные из stocks от данных из ad API
    pass
