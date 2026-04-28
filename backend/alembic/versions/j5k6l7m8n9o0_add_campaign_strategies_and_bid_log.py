"""add_campaign_strategies_and_bid_log

Revision ID: j5k6l7m8n9o0
Revises: i4j5k6l7m8n9
Create Date: 2026-04-28
"""
from alembic import op
import sqlalchemy as sa

revision = "j5k6l7m8n9o0"
down_revision = "i4j5k6l7m8n9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS campaign_strategies (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            campaign_id     INTEGER NOT NULL,
            strategy_type   VARCHAR(50) NOT NULL DEFAULT 'two_peaks',
            category        VARCHAR(100) NOT NULL DEFAULT 'universal',
            cpm_min         INTEGER NOT NULL DEFAULT 100,
            cpm_cap         INTEGER NOT NULL DEFAULT 5000,
            drr_threshold_pct FLOAT NOT NULL DEFAULT 15.0,
            min_stock       INTEGER NOT NULL DEFAULT 5,
            budget_warning_pct FLOAT NOT NULL DEFAULT 80.0,
            budget_stop_pct FLOAT NOT NULL DEFAULT 95.0,
            dry_run         BOOLEAN NOT NULL DEFAULT TRUE,
            use_history     BOOLEAN NOT NULL DEFAULT TRUE,
            history_min_days INTEGER NOT NULL DEFAULT 14,
            enabled         BOOLEAN NOT NULL DEFAULT TRUE,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT uq_campaign_strategies_account_campaign UNIQUE (account_id, campaign_id)
        )
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS bid_change_log (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            campaign_id     INTEGER NOT NULL,
            computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            day_type        VARCHAR(30) NOT NULL,
            hour            INTEGER NOT NULL,
            demand_level    VARCHAR(10) NOT NULL,
            bid_type        VARCHAR(15) NOT NULL,
            cpm_min         INTEGER NOT NULL,
            cpm_target      INTEGER NOT NULL,
            cpm_prev        INTEGER NOT NULL,
            applied         BOOLEAN NOT NULL DEFAULT FALSE,
            dry_run         BOOLEAN NOT NULL DEFAULT TRUE,
            skip_reason     VARCHAR(255) NOT NULL DEFAULT ''
        )
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_bid_change_log_campaign
            ON bid_change_log(campaign_id, computed_at DESC)
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_bid_change_log_account
            ON bid_change_log(account_id, computed_at DESC)
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS bid_change_log")
    op.execute("DROP TABLE IF EXISTS campaign_strategies")
