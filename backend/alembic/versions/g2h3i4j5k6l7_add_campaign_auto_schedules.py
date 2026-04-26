"""add campaign_auto_schedules table

Revision ID: g2h3i4j5k6l7
Revises: f1e2d3c4b5a6
Create Date: 2026-04-26 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = 'g2h3i4j5k6l7'
down_revision = 'f1e2d3c4b5a6'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'campaign_auto_schedules',
        sa.Column('id', UUID(as_uuid=True), primary_key=True),
        sa.Column('user_id', UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('account_id', UUID(as_uuid=True), sa.ForeignKey('accounts.id', ondelete='CASCADE'), nullable=False),
        sa.Column('name', sa.String(255), nullable=False),
        sa.Column('advert_ids', sa.JSON, nullable=False, server_default='[]'),
        sa.Column('weekday_hours', sa.JSON, nullable=False),
        sa.Column('weekend_hours', sa.JSON, nullable=False),
        sa.Column('is_active', sa.Boolean, nullable=False, server_default='true'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index('ix_campaign_auto_schedules_account', 'campaign_auto_schedules', ['account_id'])
    op.create_index('ix_campaign_auto_schedules_user', 'campaign_auto_schedules', ['user_id'])


def downgrade() -> None:
    op.drop_table('campaign_auto_schedules')
