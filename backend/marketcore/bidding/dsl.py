"""Валидация, компиляция и исполнение правил биддинга."""
from __future__ import annotations

import json
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, ClassVar
from zoneinfo import ZoneInfo

from jsonschema import Draft202012Validator

SCHEMA_PATH = Path(__file__).parent / "bidding-rule.schema.json"


@dataclass
class EvaluationContext:
    now_utc: datetime
    timezone: str
    metrics: dict[str, float]
    current_cpm: Decimal
    sku_id: str | None = None
    campaign_id: int | None = None
    last_change_at: datetime | None = None
    daily_spend_today: Decimal = Decimal("0")


@dataclass
class RuleDecision:
    matched: bool
    action_type: str | None = None
    new_cpm: Decimal | None = None
    reason: str = ""
    requires_approval: bool = False
    guardrail_violations: list[str] = field(default_factory=list)


class ConditionNode(ABC):
    @abstractmethod
    def evaluate(self, ctx: EvaluationContext) -> bool: ...


@dataclass
class AndNode(ConditionNode):
    children: list[ConditionNode]
    def evaluate(self, ctx: EvaluationContext) -> bool:
        return all(c.evaluate(ctx) for c in self.children)


@dataclass
class OrNode(ConditionNode):
    children: list[ConditionNode]
    def evaluate(self, ctx: EvaluationContext) -> bool:
        return any(c.evaluate(ctx) for c in self.children)


@dataclass
class NotNode(ConditionNode):
    child: ConditionNode
    def evaluate(self, ctx: EvaluationContext) -> bool:
        return not self.child.evaluate(ctx)


@dataclass
class MetricNode(ConditionNode):
    metric: str
    op: str
    value: float | list[float] | str
    window: str | None = None

    _OPS: ClassVar[dict[str, Callable[[Any, Any], bool]]] = {
        ">":  lambda a, b: a > b,
        ">=": lambda a, b: a >= b,
        "<":  lambda a, b: a < b,
        "<=": lambda a, b: a <= b,
        "==": lambda a, b: a == b,
        "!=": lambda a, b: a != b,
        "in":     lambda a, b: a in b,
        "not_in": lambda a, b: a not in b,
        "between": lambda a, b: b[0] <= a <= b[1],
    }

    def evaluate(self, ctx: EvaluationContext) -> bool:
        key = f"{self.metric}__{self.window}" if self.window else self.metric
        if key in ctx.metrics:
            actual = ctx.metrics[key]
        elif self.metric in ctx.metrics:
            actual = ctx.metrics[self.metric]
        else:
            return False
        return self._OPS[self.op](actual, self.value)


@dataclass
class TimeNode(ConditionNode):
    hours: set[int] | None = None
    days_of_week: set[int] | None = None
    dates: set[str] | None = None
    exclude_dates: set[str] | None = None

    DOW_MAP: ClassVar[dict[str, int]] = {
        "MON": 0, "TUE": 1, "WED": 2, "THU": 3, "FRI": 4, "SAT": 5, "SUN": 6,
    }

    def evaluate(self, ctx: EvaluationContext) -> bool:
        local_dt = ctx.now_utc.astimezone(ZoneInfo(ctx.timezone))
        iso_date = local_dt.date().isoformat()
        if self.exclude_dates and iso_date in self.exclude_dates:
            return False
        if self.dates is not None and iso_date not in self.dates:
            return False
        if self.hours is not None and local_dt.hour not in self.hours:
            return False
        if self.days_of_week is not None and local_dt.weekday() not in self.days_of_week:
            return False
        return True


class SchemaValidator:
    def __init__(self, schema_path: Path = SCHEMA_PATH) -> None:
        with open(schema_path, "r", encoding="utf-8") as f:
            schema = json.load(f)
        self._validator = Draft202012Validator(schema)

    def validate(self, rule: dict) -> list[str]:
        errors = []
        for err in self._validator.iter_errors(rule):
            path = ".".join(str(p) for p in err.absolute_path) or "<root>"
            errors.append(f"{path}: {err.message}")
        return errors


@dataclass
class CompiledRule:
    rule_id: str
    name: str
    priority: int
    dry_run: bool
    enabled: bool
    timezone: str
    active_from: datetime | None
    active_until: datetime | None
    condition: ConditionNode
    action: dict
    guardrails: dict

    def is_active_at(self, now_utc: datetime) -> bool:
        if not self.enabled:
            return False
        if self.active_from and now_utc < self.active_from:
            return False
        if self.active_until and now_utc >= self.active_until:
            return False
        return True


class RuleCompiler:
    def compile(self, rule_dict: dict) -> CompiledRule:
        schedule = rule_dict["schedule"]
        return CompiledRule(
            rule_id=rule_dict["rule_id"],
            name=rule_dict["name"],
            priority=rule_dict.get("priority", 100),
            dry_run=rule_dict.get("dry_run", False),
            enabled=rule_dict.get("enabled", True),
            timezone=schedule["timezone"],
            active_from=self._parse_dt(schedule.get("active_from")),
            active_until=self._parse_dt(schedule.get("active_until")),
            condition=self._compile_condition(rule_dict["when"]),
            action=rule_dict["then"],
            guardrails=rule_dict.get("guardrails", {}),
        )

    def _compile_condition(self, node: dict) -> ConditionNode:
        if "and" in node:
            return AndNode(children=[self._compile_condition(c) for c in node["and"]])
        if "or" in node:
            return OrNode(children=[self._compile_condition(c) for c in node["or"]])
        if "not" in node:
            return NotNode(child=self._compile_condition(node["not"]))
        if "metric" in node:
            return MetricNode(
                metric=node["metric"], op=node["op"],
                value=node["value"], window=node.get("window"),
            )
        if "time" in node:
            t = node["time"]
            dow = {TimeNode.DOW_MAP[d] for d in t.get("days_of_week", [])}
            return TimeNode(
                hours=set(t["hours"]) if "hours" in t else None,
                days_of_week=dow if dow else None,
                dates=set(t["dates"]) if "dates" in t else None,
                exclude_dates=set(t["exclude_dates"]) if "exclude_dates" in t else None,
            )
        raise ValueError(f"Unknown condition node: {list(node.keys())}")

    @staticmethod
    def _parse_dt(s: str | None) -> datetime | None:
        return datetime.fromisoformat(s) if s else None


class RuleExecutor:
    def execute(self, rule: CompiledRule, ctx: EvaluationContext) -> RuleDecision:
        if not rule.is_active_at(ctx.now_utc):
            return RuleDecision(matched=False, reason="rule_inactive")

        cooldown = rule.guardrails.get("cooldown_minutes", 15)
        if ctx.last_change_at:
            elapsed = (ctx.now_utc - ctx.last_change_at).total_seconds() / 60
            if elapsed < cooldown:
                return RuleDecision(
                    matched=False,
                    reason=f"cooldown_active ({elapsed:.0f}/{cooldown} мин)",
                )

        if not rule.condition.evaluate(ctx):
            return RuleDecision(matched=False, reason="condition_false")

        new_cpm, action_type = self._apply_action(rule.action, ctx)
        if new_cpm is None:
            return RuleDecision(
                matched=True, action_type=action_type,
                reason=f"action={action_type} executed",
            )

        violations = self._check_guardrails(
            new_cpm=new_cpm, current_cpm=ctx.current_cpm,
            guardrails=rule.guardrails, daily_spend=ctx.daily_spend_today,
        )
        if violations:
            if any(v.startswith("hard:") for v in violations):
                return RuleDecision(
                    matched=True, guardrail_violations=violations,
                    reason=f"guardrail_blocked: {violations}",
                )
            new_cpm = self._clamp(new_cpm, rule.guardrails)

        requires_approval = self._requires_approval(
            new_cpm=new_cpm, current_cpm=ctx.current_cpm, guardrails=rule.guardrails,
        )
        return RuleDecision(
            matched=True,
            action_type=action_type,
            new_cpm=new_cpm,
            reason=self._explain(rule, ctx, new_cpm),
            requires_approval=requires_approval,
            guardrail_violations=violations,
        )

    def _apply_action(self, action: dict, ctx: EvaluationContext) -> tuple[Decimal | None, str]:
        t = action["type"]
        if t == "set_cpm":
            return Decimal(str(action["value"])), t
        if t == "scale_cpm":
            return ctx.current_cpm * Decimal(str(action["factor"])), t
        if t == "pause":
            return None, t
        if t == "strategy":
            return self._run_strategy(action["strategy"], action.get("params", {}), ctx), t
        if t == "sequence":
            last_cpm = ctx.current_cpm
            for sub in action["actions"]:
                result, _ = self._apply_action(sub, ctx)
                if result is not None:
                    last_cpm = result
                    ctx = EvaluationContext(**{**ctx.__dict__, "current_cpm": last_cpm})
            return last_cpm, t
        raise ValueError(f"Unknown action type: {t}")

    def _run_strategy(self, name: str, params: dict, ctx: EvaluationContext) -> Decimal:
        if name == "max_coverage":
            bench = ctx.metrics.get("competitor_p90_cpm", float(ctx.current_cpm) * 1.2)
            return Decimal(str(bench)) * Decimal("1.05")
        if name == "economy_mode":
            bench = ctx.metrics.get("competitor_p25_cpm", float(ctx.current_cpm) * 0.7)
            return Decimal(str(bench))
        if name == "target_drr":
            target = Decimal(str(params.get("target_drr_pct", 12)))
            current_drr = Decimal(str(ctx.metrics.get("drr", 15)))
            factor = target / current_drr if current_drr > 0 else Decimal("1")
            return ctx.current_cpm * factor
        if name == "target_position":
            target_cpm = ctx.metrics.get(f"position_{params.get('target_position', 5)}_cpm")
            return Decimal(str(target_cpm)) if target_cpm else ctx.current_cpm
        if name == "budget_pacing":
            remaining_pct = Decimal(str(ctx.metrics.get("daily_budget_remaining_pct", 50)))
            factor = remaining_pct / Decimal("50")
            return ctx.current_cpm * factor
        if name == "competitor_beat":
            bench = ctx.metrics.get("competitor_min_cpm", float(ctx.current_cpm))
            margin = Decimal(str(params.get("margin_pct", 5))) / Decimal("100")
            return Decimal(str(bench)) * (Decimal("1") + margin)
        raise ValueError(f"Unknown strategy: {name}")

    def _check_guardrails(self, *, new_cpm: Decimal, current_cpm: Decimal,
                          guardrails: dict, daily_spend: Decimal) -> list[str]:
        violations = []
        min_cpm = guardrails.get("min_cpm")
        max_cpm = guardrails.get("max_cpm")
        max_daily = guardrails.get("max_daily_spend_rub")
        max_change = guardrails.get("max_change_pct")

        if min_cpm is not None and new_cpm < Decimal(str(min_cpm)):
            violations.append(f"soft:below_min_cpm ({new_cpm} < {min_cpm})")
        if max_cpm is not None and new_cpm > Decimal(str(max_cpm)):
            violations.append(f"soft:above_max_cpm ({new_cpm} > {max_cpm})")
        if max_daily is not None and daily_spend >= Decimal(str(max_daily)):
            violations.append(f"hard:daily_budget_exhausted ({daily_spend}/{max_daily})")
        if max_change is not None and current_cpm > 0:
            pct = abs((new_cpm - current_cpm) / current_cpm * 100)
            if pct > Decimal(str(max_change)):
                violations.append(f"soft:change_exceeds_max_pct ({pct:.1f} > {max_change})")
        return violations

    @staticmethod
    def _clamp(cpm: Decimal, guardrails: dict) -> Decimal:
        if (m := guardrails.get("min_cpm")) is not None:
            cpm = max(cpm, Decimal(str(m)))
        if (m := guardrails.get("max_cpm")) is not None:
            cpm = min(cpm, Decimal(str(m)))
        return cpm

    @staticmethod
    def _requires_approval(*, new_cpm: Decimal, current_cpm: Decimal,
                           guardrails: dict) -> bool:
        threshold = guardrails.get("require_approval_above_rub")
        if threshold is None:
            return False
        return abs(new_cpm - current_cpm) >= Decimal(str(threshold))

    @staticmethod
    def _explain(rule: CompiledRule, ctx: EvaluationContext, new_cpm: Decimal) -> str:
        delta = new_cpm - ctx.current_cpm
        sign = "+" if delta >= 0 else ""
        return f"Правило '{rule.name}' сработало: CPM {ctx.current_cpm} → {new_cpm} ({sign}{delta})"


def resolve_conflicts(decisions: list[tuple[CompiledRule, RuleDecision]]) -> RuleDecision | None:
    """Конфликт-резолюция: pause > самое высокое priority > самое консервативное изменение."""
    matched = [(r, d) for r, d in decisions if d.matched and not d.guardrail_violations]
    if not matched:
        return None
    for r, d in matched:
        if d.action_type == "pause":
            return d
    matched.sort(key=lambda x: x[0].priority, reverse=True)
    return matched[0][1]
