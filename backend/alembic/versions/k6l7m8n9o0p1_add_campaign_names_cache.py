"""add_campaign_names_cache

Revision ID: k6l7m8n9o0p1
Revises: j5k6l7m8n9o0
Create Date: 2026-04-28
"""
from alembic import op

revision = "k6l7m8n9o0p1"
down_revision = "j5k6l7m8n9o0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS campaign_names (
            account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            advert_id       INTEGER NOT NULL,
            name            VARCHAR(512) NOT NULL DEFAULT '',
            campaign_type   INTEGER,
            status          INTEGER,
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (account_id, advert_id)
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_campaign_names_account
            ON campaign_names(account_id)
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS campaign_names")
