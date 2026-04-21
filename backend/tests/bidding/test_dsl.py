from datetime import datetime, timezone
from decimal import Decimal

import pytest

from marketcore.bidding.dsl import (
    EvaluationContext,
    RuleCompiler,
    RuleExecutor,
    SchemaValidator,
)

ACCOUNT_ID = "00000000-0000-0000-0000-000000000001"


@pytest.fixture
def executor() -> RuleExecutor:
    return RuleExecutor()


@pytest.fixture
def compiler() -> RuleCompiler:
    return RuleCompiler()


@pytest.fixture
def validator() -> SchemaValidator:
    return SchemaValidator()


def _base_rule(**overrides):
    rule = {
        "rule_id": "test_1", "name": "t", "version": 1,
        "scope": {"platform": "wb", "account_id": ACCOUNT_ID, "campaign_ids": [1]},
        "schedule": {"timezone": "Europe/Moscow"},
        "when": {"metric": "cpm", "op": ">", "value": 0},
        "then": {"type": "set_cpm", "value": 300},
        "guardrails": {"cooldown_minutes": 1},
    }
    rule.update(overrides)
    return rule


class TestSchemaValidator:
    def test_valid_rule_passes(self, validator):
        assert validator.validate(_base_rule()) == []

    def test_missing_required_fails(self, validator):
        errors = validator.validate({"rule_id": "r"})
        assert errors

    def test_bad_rule_id_pattern(self, validator):
        errors = validator.validate(_base_rule(rule_id="UPPERCASE"))
        assert any("rule_id" in e for e in errors)


class TestMetricConditions:
    def test_simple_metric_comparison(self, compiler, executor):
        rule = compiler.compile(_base_rule(
            when={"metric": "cr_card", "op": "<", "value": 2.0, "window": "4h"},
            then={"type": "scale_cpm", "factor": 0.7},
        ))
        ctx = EvaluationContext(
            now_utc=datetime(2026, 4, 20, 14, 0, tzinfo=timezone.utc),
            timezone="Europe/Moscow",
            metrics={"cr_card__4h": 1.5},
            current_cpm=Decimal("200"),
        )
        d = executor.execute(rule, ctx)
        assert d.matched
        assert d.new_cpm == Decimal("140.0")

    def test_and_combination(self, compiler, executor):
        rule = compiler.compile(_base_rule(
            when={"and": [
                {"metric": "cr_card", "op": ">=", "value": 3.0, "window": "24h"},
                {"metric": "daily_budget_remaining_pct", "op": ">", "value": 20},
            ]},
            then={"type": "set_cpm", "value": 350},
        ))
        ctx = EvaluationContext(
            now_utc=datetime(2026, 4, 20, 14, 0, tzinfo=timezone.utc),
            timezone="Europe/Moscow",
            metrics={"cr_card__24h": 3.5, "daily_budget_remaining_pct": 30},
            current_cpm=Decimal("200"),
        )
        assert executor.execute(rule, ctx).matched is True

        ctx.metrics["daily_budget_remaining_pct"] = 10
        assert executor.execute(rule, ctx).matched is False


class TestGuardrails:
    def test_max_cpm_clamps(self, compiler, executor):
        rule = compiler.compile(_base_rule(
            then={"type": "set_cpm", "value": 1000},
            guardrails={"max_cpm": 500, "cooldown_minutes": 1},
        ))
        ctx = EvaluationContext(
            now_utc=datetime(2026, 4, 20, 14, 0, tzinfo=timezone.utc),
            timezone="Europe/Moscow",
            metrics={"cpm": 250},
            current_cpm=Decimal("250"),
        )
        d = executor.execute(rule, ctx)
        assert d.new_cpm == Decimal("500")
        assert any("above_max_cpm" in v for v in d.guardrail_violations)

    def test_daily_budget_hard_block(self, compiler, executor):
        rule = compiler.compile(_base_rule(
            then={"type": "set_cpm", "value": 400},
            guardrails={"max_daily_spend_rub": 1000, "cooldown_minutes": 1},
        ))
        ctx = EvaluationContext(
            now_utc=datetime(2026, 4, 20, 14, 0, tzinfo=timezone.utc),
            timezone="Europe/Moscow",
            metrics={"cpm": 200},
            current_cpm=Decimal("200"),
            daily_spend_today=Decimal("1100"),
        )
        d = executor.execute(rule, ctx)
        assert "hard:daily_budget_exhausted" in " ".join(d.guardrail_violations)


class TestTimeConditions:
    def test_hour_match(self, compiler, executor):
        rule = compiler.compile(_base_rule(
            when={"time": {"hours": [18, 19, 20]}},
            then={"type": "set_cpm", "value": 400},
        ))
        # 17:00 UTC = 20:00 МСК
        ctx = EvaluationContext(
            now_utc=datetime(2026, 4, 20, 17, 0, tzinfo=timezone.utc),
            timezone="Europe/Moscow",
            metrics={}, current_cpm=Decimal("200"),
        )
        assert executor.execute(rule, ctx).matched
        ctx.now_utc = datetime(2026, 4, 20, 15, 0, tzinfo=timezone.utc)
        assert executor.execute(rule, ctx).matched
        ctx.now_utc = datetime(2026, 4, 20, 10, 0, tzinfo=timezone.utc)
        assert executor.execute(rule, ctx).matched is False

    def test_days_of_week(self, compiler, executor):
        rule = compiler.compile(_base_rule(
            when={"time": {"days_of_week": ["MON", "TUE"]}},
            then={"type": "set_cpm", "value": 300},
        ))
        # 2026-04-20 — понедельник
        ctx = EvaluationContext(
            now_utc=datetime(2026, 4, 20, 12, 0, tzinfo=timezone.utc),
            timezone="Europe/Moscow",
            metrics={}, current_cpm=Decimal("200"),
        )
        assert executor.execute(rule, ctx).matched
        # 2026-04-19 — воскресенье
        ctx.now_utc = datetime(2026, 4, 19, 12, 0, tzinfo=timezone.utc)
        assert executor.execute(rule, ctx).matched is False


class TestCooldown:
    def test_cooldown_blocks(self, compiler, executor):
        rule = compiler.compile(_base_rule(guardrails={"cooldown_minutes": 30}))
        now = datetime(2026, 4, 20, 14, 0, tzinfo=timezone.utc)
        ctx = EvaluationContext(
            now_utc=now,
            timezone="Europe/Moscow",
            metrics={"cpm": 100},
            current_cpm=Decimal("200"),
            last_change_at=datetime(2026, 4, 20, 13, 50, tzinfo=timezone.utc),
        )
        d = executor.execute(rule, ctx)
        assert d.matched is False
        assert "cooldown" in d.reason


class TestApproval:
    def test_requires_approval(self, compiler, executor):
        rule = compiler.compile(_base_rule(
            then={"type": "set_cpm", "value": 1000},
            guardrails={"require_approval_above_rub": 200, "cooldown_minutes": 1},
        ))
        ctx = EvaluationContext(
            now_utc=datetime(2026, 4, 20, 14, 0, tzinfo=timezone.utc),
            timezone="Europe/Moscow",
            metrics={"cpm": 100},
            current_cpm=Decimal("300"),
        )
        d = executor.execute(rule, ctx)
        assert d.matched
        assert d.requires_approval is True
