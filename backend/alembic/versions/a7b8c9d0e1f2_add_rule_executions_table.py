"""add rule_executions table — log of bot actions

Revision ID: a7b8c9d0e1f2
Revises: f1e2d3c4b5a6
Create Date: 2026-04-23 14:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = 'a7b8c9d0e1f2'
down_revision: Union[str, None] = 'f1e2d3c4b5a6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'rule_executions',
        sa.Column('id', UUID(as_uuid=True), primary_key=True),
        sa.Column('user_id', UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('schedule_id', UUID(as_uuid=True), sa.ForeignKey('schedules.id'), nullable=True),
        sa.Column('account_id', UUID(as_uuid=True), sa.ForeignKey('accounts.id'), nullable=True),
        sa.Column('computed_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('platform', sa.String(length=10), nullable=False),
        sa.Column('pay_model', sa.String(length=10), nullable=False),
        sa.Column('base_cpm', sa.Float(), nullable=False),
        sa.Column('multiplier_pct', sa.Integer(), nullable=False),
        sa.Column('target_cpm', sa.Float(), nullable=False),
        sa.Column('mode', sa.String(length=10), nullable=False, server_default='dry_run'),
        sa.Column('status', sa.String(length=20), nullable=False, server_default='computed'),
        sa.Column('reason', sa.String(length=500), nullable=False, server_default=''),
        sa.Column('details', JSONB, nullable=False, server_default='{}'),
    )
    op.create_index(
        'idx_rule_executions_user_date',
        'rule_executions',
        ['user_id', 'computed_at'],
        postgresql_ops={'computed_at': 'DESC'},
    )


def downgrade() -> None:
    op.drop_index('idx_rule_executions_user_date', table_name='rule_executions')
    op.drop_table('rule_executions')
