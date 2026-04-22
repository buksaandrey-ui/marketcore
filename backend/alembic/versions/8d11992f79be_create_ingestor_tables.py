"""create ingestor tables

Revision ID: 8d11992f79be
Revises: 921319a89702
Create Date: 2026-04-20 22:34:20.860395

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '8d11992f79be'
down_revision: Union[str, None] = '921319a89702'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'orders',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('account_id', sa.UUID(), nullable=False),
        sa.Column('external_id', sa.String(length=255), nullable=False),
        sa.Column('sku', sa.String(length=255), nullable=False),
        sa.Column('quantity', sa.Integer(), nullable=False),
        sa.Column('price', sa.Float(), nullable=False),
        sa.Column('status', sa.String(length=50), nullable=False),
        sa.Column('warehouse', sa.String(length=255), nullable=True),
        sa.Column('ordered_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['account_id'], ['accounts.id']),
        sa.PrimaryKeyConstraint('id', 'ordered_at'),
        sa.UniqueConstraint('account_id', 'external_id', 'ordered_at', name='uq_orders_account_external'),
    )
    op.create_table(
        'sku_stocks',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('account_id', sa.UUID(), nullable=False),
        sa.Column('sku', sa.String(length=255), nullable=False),
        sa.Column('warehouse', sa.String(length=255), nullable=False),
        sa.Column('quantity', sa.Integer(), nullable=False),
        sa.Column('recorded_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['account_id'], ['accounts.id']),
        sa.PrimaryKeyConstraint('id', 'recorded_at'),
    )
    op.create_table(
        'sku_prices',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('account_id', sa.UUID(), nullable=False),
        sa.Column('sku', sa.String(length=255), nullable=False),
        sa.Column('price', sa.Float(), nullable=False),
        sa.Column('discount_percent', sa.Integer(), nullable=False),
        sa.Column('recorded_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['account_id'], ['accounts.id']),
        sa.PrimaryKeyConstraint('id', 'recorded_at'),
    )
    op.create_table(
        'ad_stats',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('account_id', sa.UUID(), nullable=False),
        sa.Column('campaign_id', sa.String(length=255), nullable=False),
        sa.Column('sku', sa.String(length=255), nullable=True),
        sa.Column('cpm', sa.Float(), nullable=False),
        sa.Column('views', sa.Integer(), nullable=False),
        sa.Column('clicks', sa.Integer(), nullable=False),
        sa.Column('spend', sa.Float(), nullable=False),
        sa.Column('stat_date', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['account_id'], ['accounts.id']),
        sa.PrimaryKeyConstraint('id', 'stat_date'),
        sa.UniqueConstraint('account_id', 'campaign_id', 'sku', 'stat_date', name='uq_ad_stats_unique'),
    )



def downgrade() -> None:
    op.drop_table('ad_stats')
    op.drop_table('sku_prices')
    op.drop_table('sku_stocks')
    op.drop_table('orders')
