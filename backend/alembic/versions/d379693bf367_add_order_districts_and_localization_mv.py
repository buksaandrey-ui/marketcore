"""add order districts and localization mv

Revision ID: d379693bf367
Revises: 8d11992f79be
Create Date: 2026-04-20 23:15:23.573067

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd379693bf367'
down_revision: Union[str, None] = '8d11992f79be'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('orders', sa.Column('warehouse_district', sa.String(length=100), nullable=True))
    op.add_column('orders', sa.Column('customer_district', sa.String(length=100), nullable=True))

    op.execute("""
        CREATE MATERIALIZED VIEW mv_localization_index AS
        WITH order_regions AS (
            SELECT
                account_id,
                sku,
                warehouse_district,
                customer_district,
                quantity,
                (warehouse_district = customer_district)::int AS is_local
            FROM orders
            WHERE ordered_at > NOW() - INTERVAL '30 days'
              AND status NOT IN ('cancelled', 'returned')
              AND warehouse_district IS NOT NULL
              AND customer_district IS NOT NULL
        ),
        account_li AS (
            SELECT
                account_id,
                'account'::varchar AS level,
                NULL::varchar AS entity_id,
                SUM(quantity * is_local)::float / NULLIF(SUM(quantity), 0) AS li,
                SUM(quantity)::bigint AS total_units,
                COUNT(*)::bigint AS orders_count
            FROM order_regions
            GROUP BY account_id
        ),
        sku_li AS (
            SELECT
                account_id,
                'sku'::varchar AS level,
                sku AS entity_id,
                SUM(quantity * is_local)::float / NULLIF(SUM(quantity), 0) AS li,
                SUM(quantity)::bigint AS total_units,
                COUNT(*)::bigint AS orders_count
            FROM order_regions
            GROUP BY account_id, sku
        )
        SELECT * FROM account_li
        UNION ALL
        SELECT * FROM sku_li
    """)
    op.execute("CREATE INDEX idx_mv_li_account_level ON mv_localization_index (account_id, level)")
    op.execute("CREATE INDEX idx_mv_li_entity ON mv_localization_index (account_id, level, entity_id)")


def downgrade() -> None:
    op.execute("DROP MATERIALIZED VIEW IF EXISTS mv_localization_index")
    op.drop_column('orders', 'customer_district')
    op.drop_column('orders', 'warehouse_district')
