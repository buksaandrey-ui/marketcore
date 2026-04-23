"""add performance indexes and mv_localization_index unique index for CONCURRENTLY refresh

Revision ID: f1e2d3c4b5a6
Revises: a1b2c3d4e5f6
Create Date: 2026-04-23 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op

revision: str = 'f1e2d3c4b5a6'
down_revision: Union[str, None] = 'a1b2c3d4e5f6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── orders: быстрый поиск по аккаунту + дате (dashboard, heatmap, report) ──
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_orders_account_date "
        "ON orders (account_id, ordered_at DESC)"
    )
    # ── orders: поиск по SKU внутри аккаунта ──
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_orders_account_sku "
        "ON orders (account_id, sku)"
    )
    # ── sku_stocks: поиск по аккаунту ──
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_sku_stocks_account "
        "ON sku_stocks (account_id, recorded_at DESC)"
    )
    # ── sku_prices: поиск по аккаунту ──
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_sku_prices_account "
        "ON sku_prices (account_id, recorded_at DESC)"
    )
    # ── ad_stats: поиск по аккаунту + дате ──
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_ad_stats_account_date "
        "ON ad_stats (account_id, stat_date DESC)"
    )
    # ── mv_localization_index: уникальный индекс нужен для REFRESH CONCURRENTLY ──
    # COALESCE(entity_id, '') нужен чтобы NULL (account-level строки) тоже были уникальны
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_li_unique "
        "ON mv_localization_index (account_id, level, COALESCE(entity_id, ''))"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_orders_account_date")
    op.execute("DROP INDEX IF EXISTS idx_orders_account_sku")
    op.execute("DROP INDEX IF EXISTS idx_sku_stocks_account")
    op.execute("DROP INDEX IF EXISTS idx_sku_prices_account")
    op.execute("DROP INDEX IF EXISTS idx_ad_stats_account_date")
    op.execute("DROP INDEX IF EXISTS idx_mv_li_unique")
