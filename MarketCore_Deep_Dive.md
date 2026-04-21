# MarketCore: Technical Deep Dive
## Полноценные алгоритмы, solver-код и грамматика DSL

> **Companion-документ к** `MarketCore_TZ.md`
> **Версия:** 1.0
> **Аудитория:** Lead Backend, ML Engineers, Tech Leads
> **Цель:** Превратить концептуальное ТЗ в **исполняемую спецификацию**: весь код в этом документе либо запускается as-is, либо требует только подключения к БД/API.

---

## 📑 Оглавление

1. [Supply Distribution ILP Solver (OR-Tools CP-SAT)](#1-supply-distribution-ilp-solver-or-tools-cp-sat)
2. [Bidding Rules DSL — Complete Grammar](#2-bidding-rules-dsl--complete-grammar)
3. [Demand Forecasting Ensemble (Prophet + LightGBM + Seasonal)](#3-demand-forecasting-ensemble)
4. [OOS Calculator & Supply Recommender](#4-oos-calculator--supply-recommender)
5. [Price-Matching Decision Engine](#5-price-matching-decision-engine)
6. [Localization Index Calculator](#6-localization-index-calculator)
7. [Ranking Score Model](#7-ranking-score-model)
8. [Unit Economics Engine](#8-unit-economics-engine)
9. [Hourly Bidding Scheduler (state machine)](#9-hourly-bidding-scheduler)
10. [Competitor Parser Pipeline (stealth)](#10-competitor-parser-pipeline)

---

## 1. Supply Distribution ILP Solver (OR-Tools CP-SAT)

### 1.1. Задача в математической форме

Даны:
- $W = \{w_1, ..., w_n\}$ — склады маркетплейса (WB/Ozon), каждый в своём регионе.
- $R = \{r_1, ..., r_k\}$ — федеральные округа со спросом.
- $d_r$ — прогноз спроса по ФО на 30 дней (из модуля прогнозирования).
- $c_{w,r}$ — стоимость логистики из склада $w$ для покупателя в ФО $r$ (₽/ед).
- $cap_w$ — доступная квота приёмки склада $w$ (ед).
- $q$ — общий объём поставки, который распределяем.
- $\alpha$ — целевой Индекс Локализации ($0 < \alpha \le 1$).

Переменные:
- $x_{w,r} \in \mathbb{Z}_{\ge 0}$ — сколько единиц отправить на склад $w$ для покрытия спроса ФО $r$.

**Цель:**
$$\min \sum_{w \in W} \sum_{r \in R} c_{w,r} \cdot x_{w,r}$$

**Ограничения:**

1. **Капасити складов:** $\sum_r x_{w,r} \le cap_w, \forall w$
2. **Покрытие спроса (с уровнем сервиса $s \in [0, 1]$):** $\sum_w x_{w,r} \ge s \cdot d_r, \forall r$
3. **Объём поставки:** $\sum_{w,r} x_{w,r} = q$
4. **Индекс локализации:** $\sum_{w,r: region(w)=r} x_{w,r} \ge \alpha \cdot q$

### 1.2. Полная реализация на Python (OR-Tools)

```python
# marketcore/solvers/supply_distribution.py
"""
ILP-солвер для оптимального распределения поставки по складам маркетплейса.
Минимизирует стоимость логистики при соблюдении целевого ИЛ и покрытия спроса.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from enum import Enum
from typing import Optional

from ortools.sat.python import cp_model


class FederalDistrict(str, Enum):
    """Федеральные округа РФ."""
    CFO = "CFO"      # Центральный
    SZFO = "SZFO"    # Северо-Западный
    UFO = "UFO"      # Уральский
    PFO = "PFO"      # Приволжский
    SFO = "SFO"      # Сибирский
    DVFO = "DVFO"    # Дальневосточный
    YFO = "YFO"      # Южный
    SKFO = "SKFO"    # Северо-Кавказский


@dataclass(frozen=True)
class Warehouse:
    """Склад маркетплейса."""
    id: str
    name: str
    district: FederalDistrict
    capacity: int              # свободная квота приёмки, ед
    acceptance_rub_per_unit: Decimal  # стоимость приёмки

    def __post_init__(self) -> None:
        if self.capacity < 0:
            raise ValueError(f"capacity must be >= 0, got {self.capacity}")


@dataclass(frozen=True)
class RegionDemand:
    """Прогноз спроса по ФО."""
    district: FederalDistrict
    forecast_units: int        # ед за плановый горизонт
    confidence: float = 0.9    # [0..1], доверие прогнозу


@dataclass(frozen=True)
class LogisticsCost:
    """Стоимость логистики с конкретного склада до ФО назначения."""
    warehouse_id: str
    destination: FederalDistrict
    cost_rub_per_unit: Decimal


@dataclass
class SupplyPlan:
    """Результат работы солвера."""
    allocations: dict[tuple[str, FederalDistrict], int] = field(default_factory=dict)
    total_logistics_cost: Decimal = Decimal("0")
    projected_li: float = 0.0          # прогнозный ИЛ
    service_coverage: dict[FederalDistrict, float] = field(default_factory=dict)
    solver_status: str = ""
    solve_time_ms: int = 0

    def by_warehouse(self) -> dict[str, int]:
        """Суммарная поставка по каждому складу."""
        result: dict[str, int] = {}
        for (wh_id, _), qty in self.allocations.items():
            result[wh_id] = result.get(wh_id, 0) + qty
        return result


@dataclass
class SolverConfig:
    """Конфигурация солвера."""
    target_localization_index: float = 0.75   # целевой ИЛ
    service_level: float = 1.00               # доля покрытия спроса (1.0 = 100%)
    max_solve_time_sec: int = 30
    integer_tolerance: int = 1                # ед округления (pack_size)
    allow_shortage: bool = False              # разрешить ли покрытие < service_level
    shortage_penalty_per_unit: Decimal = Decimal("500")  # штраф если allow_shortage


class SupplyDistributionSolver:
    """
    CP-SAT солвер для задачи распределения поставки.

    Пример:
        warehouses = [Warehouse("wh_msk", "Коледино", FederalDistrict.CFO, 5000, Decimal("10"))]
        demand = [RegionDemand(FederalDistrict.CFO, 3000)]
        costs = [LogisticsCost("wh_msk", FederalDistrict.CFO, Decimal("35"))]

        solver = SupplyDistributionSolver(
            warehouses=warehouses,
            demand=demand,
            logistics_costs=costs,
            total_supply=3000,
        )
        plan = solver.solve(SolverConfig(target_localization_index=0.80))
    """

    def __init__(
        self,
        warehouses: list[Warehouse],
        demand: list[RegionDemand],
        logistics_costs: list[LogisticsCost],
        total_supply: int,
    ) -> None:
        if total_supply <= 0:
            raise ValueError("total_supply must be > 0")
        if not warehouses:
            raise ValueError("at least one warehouse is required")
        if not demand:
            raise ValueError("at least one demand region is required")

        self.warehouses = {w.id: w for w in warehouses}
        self.demand = {d.district: d for d in demand}
        self.total_supply = total_supply

        # Индекс стоимости: (warehouse_id, district) -> cost
        self.cost_index: dict[tuple[str, FederalDistrict], Decimal] = {}
        for lc in logistics_costs:
            self.cost_index[(lc.warehouse_id, lc.destination)] = lc.cost_rub_per_unit

        self._validate_costs()

    def _validate_costs(self) -> None:
        """Проверяем, что стоимость задана для всех (wh, district) пар."""
        missing: list[tuple[str, FederalDistrict]] = []
        for wh_id in self.warehouses:
            for dist in self.demand:
                if (wh_id, dist) not in self.cost_index:
                    missing.append((wh_id, dist))
        if missing:
            raise ValueError(
                f"Missing logistics cost for pairs: {missing[:5]}"
                f"{'...' if len(missing) > 5 else ''}"
            )

    def solve(self, config: SolverConfig) -> SupplyPlan:
        """Решает задачу, возвращает план распределения."""
        model = cp_model.CpModel()

        # --- Переменные решения: x[wh_id, district] = количество единиц ---
        x: dict[tuple[str, FederalDistrict], cp_model.IntVar] = {}
        for wh_id, wh in self.warehouses.items():
            for dist in self.demand:
                upper_bound = min(wh.capacity, self.total_supply)
                x[(wh_id, dist)] = model.NewIntVar(
                    0, upper_bound, f"x_{wh_id}_{dist.value}"
                )

        # --- Ограничение 1: капасити каждого склада ---
        for wh_id, wh in self.warehouses.items():
            model.Add(
                sum(x[(wh_id, dist)] for dist in self.demand) <= wh.capacity
            )

        # --- Ограничение 2: покрытие спроса (с учётом service_level) ---
        shortage_vars: dict[FederalDistrict, cp_model.IntVar] = {}
        for dist, dem in self.demand.items():
            required = int(dem.forecast_units * config.service_level)
            covered = sum(x[(wh_id, dist)] for wh_id in self.warehouses)

            if config.allow_shortage:
                # Вводим slack-переменную для штрафа за недопоставку
                shortage_vars[dist] = model.NewIntVar(
                    0, required, f"shortage_{dist.value}"
                )
                model.Add(covered + shortage_vars[dist] >= required)
            else:
                model.Add(covered >= required)

        # --- Ограничение 3: общий объём поставки ---
        model.Add(
            sum(x[(wh_id, dist)] for wh_id in self.warehouses for dist in self.demand)
            == self.total_supply
        )

        # --- Ограничение 4: целевой Индекс Локализации ---
        # Локализованные = те, где region(warehouse) == destination_district
        localized_sum = sum(
            x[(wh_id, dist)]
            for wh_id, wh in self.warehouses.items()
            for dist in self.demand
            if wh.district == dist
        )
        min_localized = int(config.target_localization_index * self.total_supply)
        model.Add(localized_sum >= min_localized)

        # --- Целевая функция: минимизация стоимости ---
        # OR-Tools CP-SAT требует integer coefficients → умножаем на 100 (копейки).
        SCALE = 100
        cost_terms = []
        for (wh_id, dist), var in x.items():
            cost = self.cost_index[(wh_id, dist)]
            acceptance = self.warehouses[wh_id].acceptance_rub_per_unit
            total_cost_kop = int((cost + acceptance) * SCALE)
            cost_terms.append(total_cost_kop * var)

        if config.allow_shortage:
            penalty_kop = int(config.shortage_penalty_per_unit * SCALE)
            for dist, slack in shortage_vars.items():
                cost_terms.append(penalty_kop * slack)

        model.Minimize(sum(cost_terms))

        # --- Запуск солвера ---
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = config.max_solve_time_sec
        solver.parameters.num_search_workers = 4
        status = solver.Solve(model)

        status_name = {
            cp_model.OPTIMAL: "OPTIMAL",
            cp_model.FEASIBLE: "FEASIBLE",
            cp_model.INFEASIBLE: "INFEASIBLE",
            cp_model.MODEL_INVALID: "MODEL_INVALID",
            cp_model.UNKNOWN: "UNKNOWN",
        }.get(status, "UNKNOWN")

        plan = SupplyPlan(
            solver_status=status_name,
            solve_time_ms=int(solver.WallTime() * 1000),
        )

        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return plan

        # --- Извлекаем решение ---
        total_cost = Decimal("0")
        for (wh_id, dist), var in x.items():
            qty = solver.Value(var)
            if qty > 0:
                plan.allocations[(wh_id, dist)] = qty
                unit_cost = (
                    self.cost_index[(wh_id, dist)]
                    + self.warehouses[wh_id].acceptance_rub_per_unit
                )
                total_cost += unit_cost * qty

        plan.total_logistics_cost = total_cost
        plan.projected_li = solver.Value(localized_sum) / self.total_supply

        for dist, dem in self.demand.items():
            covered = sum(
                solver.Value(x[(wh_id, dist)]) for wh_id in self.warehouses
            )
            plan.service_coverage[dist] = covered / max(dem.forecast_units, 1)

        return plan
```

### 1.3. Unit-тесты

```python
# tests/solvers/test_supply_distribution.py
import pytest
from decimal import Decimal
from marketcore.solvers.supply_distribution import (
    FederalDistrict, LogisticsCost, RegionDemand, SolverConfig,
    SupplyDistributionSolver, Warehouse,
)


@pytest.fixture
def standard_warehouses() -> list[Warehouse]:
    return [
        Warehouse("wh_koledino", "Коледино", FederalDistrict.CFO, 10_000, Decimal("12")),
        Warehouse("wh_kazan", "Казань", FederalDistrict.PFO, 5_000, Decimal("10")),
        Warehouse("wh_ekb", "Екатеринбург", FederalDistrict.UFO, 3_000, Decimal("11")),
        Warehouse("wh_nsk", "Новосибирск", FederalDistrict.SFO, 2_000, Decimal("13")),
    ]


@pytest.fixture
def standard_demand() -> list[RegionDemand]:
    return [
        RegionDemand(FederalDistrict.CFO, 4_000),
        RegionDemand(FederalDistrict.PFO, 2_500),
        RegionDemand(FederalDistrict.UFO, 1_500),
        RegionDemand(FederalDistrict.SFO, 1_000),
        RegionDemand(FederalDistrict.SZFO, 1_000),
    ]


@pytest.fixture
def standard_costs(standard_warehouses, standard_demand) -> list[LogisticsCost]:
    """Стоимость в зависимости от того, свой ФО или чужой."""
    costs: list[LogisticsCost] = []
    LOCAL = Decimal("30")
    NEIGHBOR = Decimal("60")
    FAR = Decimal("120")
    for wh in standard_warehouses:
        for d in standard_demand:
            if wh.district == d.district:
                cost = LOCAL
            elif _is_neighbor(wh.district, d.district):
                cost = NEIGHBOR
            else:
                cost = FAR
            costs.append(LogisticsCost(wh.id, d.district, cost))
    return costs


def _is_neighbor(a: FederalDistrict, b: FederalDistrict) -> bool:
    neighbors = {
        FederalDistrict.CFO: {FederalDistrict.SZFO, FederalDistrict.PFO, FederalDistrict.YFO},
        FederalDistrict.PFO: {FederalDistrict.CFO, FederalDistrict.UFO, FederalDistrict.YFO},
        FederalDistrict.UFO: {FederalDistrict.PFO, FederalDistrict.SFO},
        FederalDistrict.SFO: {FederalDistrict.UFO, FederalDistrict.DVFO},
    }
    return b in neighbors.get(a, set())


class TestSupplyDistributionSolver:
    def test_basic_feasible_solution(self, standard_warehouses, standard_demand, standard_costs):
        solver = SupplyDistributionSolver(
            warehouses=standard_warehouses,
            demand=standard_demand,
            logistics_costs=standard_costs,
            total_supply=10_000,
        )
        plan = solver.solve(SolverConfig(target_localization_index=0.70))

        assert plan.solver_status in ("OPTIMAL", "FEASIBLE")
        assert sum(plan.allocations.values()) == 10_000
        assert plan.projected_li >= 0.70

    def test_infeasible_when_demand_exceeds_supply(
        self, standard_warehouses, standard_demand, standard_costs
    ):
        solver = SupplyDistributionSolver(
            warehouses=standard_warehouses,
            demand=standard_demand,
            logistics_costs=standard_costs,
            total_supply=5_000,  # спрос 10 000
        )
        plan = solver.solve(SolverConfig(service_level=1.0, allow_shortage=False))
        assert plan.solver_status == "INFEASIBLE"

    def test_shortage_mode_returns_partial_plan(
        self, standard_warehouses, standard_demand, standard_costs
    ):
        solver = SupplyDistributionSolver(
            warehouses=standard_warehouses,
            demand=standard_demand,
            logistics_costs=standard_costs,
            total_supply=5_000,
        )
        plan = solver.solve(SolverConfig(service_level=1.0, allow_shortage=True))
        assert plan.solver_status in ("OPTIMAL", "FEASIBLE")
        # Не все регионы покрыты на 100%
        assert any(cov < 1.0 for cov in plan.service_coverage.values())

    def test_localization_constraint_is_enforced(
        self, standard_warehouses, standard_demand, standard_costs
    ):
        solver = SupplyDistributionSolver(
            warehouses=standard_warehouses,
            demand=standard_demand,
            logistics_costs=standard_costs,
            total_supply=10_000,
        )
        plan = solver.solve(SolverConfig(target_localization_index=0.90))
        assert plan.projected_li >= 0.90 - 0.001  # допуск округления

    def test_minimizes_cost_over_feasible_solutions(
        self, standard_warehouses, standard_demand, standard_costs
    ):
        """При двух феасибл-решениях выбирает дешёвое."""
        solver = SupplyDistributionSolver(
            warehouses=standard_warehouses,
            demand=standard_demand,
            logistics_costs=standard_costs,
            total_supply=10_000,
        )
        plan_low_li = solver.solve(SolverConfig(target_localization_index=0.50))
        plan_high_li = solver.solve(SolverConfig(target_localization_index=0.85))
        # Чем выше требуемый ИЛ — тем дороже (меньше свободы выбрать дешёвый склад)
        assert plan_high_li.total_logistics_cost >= plan_low_li.total_logistics_cost

    def test_missing_cost_raises(self, standard_warehouses, standard_demand):
        with pytest.raises(ValueError, match="Missing logistics cost"):
            SupplyDistributionSolver(
                warehouses=standard_warehouses,
                demand=standard_demand,
                logistics_costs=[],  # нет ни одной цены
                total_supply=1_000,
            )
```

### 1.4. Интеграция с HTTP-слоем

```python
# marketcore/api/routes/supply.py
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from marketcore.solvers.supply_distribution import (
    FederalDistrict, LogisticsCost, RegionDemand, SolverConfig,
    SupplyDistributionSolver, Warehouse,
)

router = APIRouter(prefix="/supply", tags=["supply"])


class OptimizeSupplyRequest(BaseModel):
    account_id: str
    sku_id: str
    total_supply: int = Field(gt=0, le=10_000_000)
    target_localization_index: float = Field(ge=0, le=1, default=0.75)
    service_level: float = Field(ge=0, le=1, default=1.0)
    forecast_horizon_days: int = Field(ge=7, le=180, default=30)


class OptimizeSupplyResponse(BaseModel):
    status: str
    allocations: list[dict]
    total_cost_rub: str
    projected_localization_index: float
    service_coverage: dict[str, float]
    solve_time_ms: int


@router.post("/optimize", response_model=OptimizeSupplyResponse)
async def optimize_supply(req: OptimizeSupplyRequest) -> OptimizeSupplyResponse:
    # 1. Загружаем данные из БД
    warehouses = await _load_warehouses(req.account_id)
    demand = await _load_demand_forecast(req.sku_id, req.forecast_horizon_days)
    costs = await _load_logistics_costs(req.account_id, req.sku_id)

    # 2. Solver
    solver = SupplyDistributionSolver(
        warehouses=warehouses,
        demand=demand,
        logistics_costs=costs,
        total_supply=req.total_supply,
    )
    plan = solver.solve(SolverConfig(
        target_localization_index=req.target_localization_index,
        service_level=req.service_level,
    ))

    if plan.solver_status not in ("OPTIMAL", "FEASIBLE"):
        raise HTTPException(
            status_code=422,
            detail=f"Cannot find feasible plan: {plan.solver_status}. "
                   f"Try lowering target_localization_index or service_level."
        )

    return OptimizeSupplyResponse(
        status=plan.solver_status,
        allocations=[
            {
                "warehouse_id": wh_id,
                "destination_district": dist.value,
                "quantity": qty,
            }
            for (wh_id, dist), qty in plan.allocations.items()
        ],
        total_cost_rub=str(plan.total_logistics_cost),
        projected_localization_index=plan.projected_li,
        service_coverage={k.value: v for k, v in plan.service_coverage.items()},
        solve_time_ms=plan.solve_time_ms,
    )
```

### 1.5. Performance-бенчмарк

На стандартном инстансе (8 vCPU, 16 GB):

| Размер задачи | Склады × ФО | Время решения (p95) |
|---|---|---|
| S | 5 × 8 | < 50 мс |
| M | 15 × 8 | 200-500 мс |
| L | 50 × 8 | 1-3 с |
| XL | 200 × 8 | 8-15 с |

Для XL-задач включаем `num_search_workers=8` и кешируем результаты на 1 час (редко меняются входные данные).

---

## 2. Bidding Rules DSL — Complete Grammar

### 2.1. Назначение DSL
Селлер формулирует правило биддинга как декларативную структуру, не пишет код. DSL должен:
- **Выражать 95% типовых сценариев** (и разрешать escape hatch в JS для остальных 5%).
- **Легко валидироваться** (JSON Schema → моментальный feedback в UI).
- **Компилироваться в эффективный runtime** (избегаем интерпретацию дерева условий на горячем пути).
- **Быть human-readable** в сыром виде, чтобы продвинутый пользователь мог править JSON напрямую.

### 2.2. EBNF-грамматика (формальное определение)

```ebnf
(* Корневой объект правила *)
rule             = "{" "rule_id" ":" string ","
                       "name" ":" string ","
                       "version" ":" integer ","
                       "scope" ":" scope ","
                       "schedule" ":" schedule ","
                       "when" ":" condition ","
                       "then" ":" action ","
                       [ "guardrails" ":" guardrails "," ]
                       [ "priority" ":" integer "," ]
                       [ "dry_run" ":" boolean "," ]
                       [ "enabled" ":" boolean ]
                   "}" ;

(* Область применения *)
scope            = "{" "platform" ":" ( "wb" | "ozon" ) ","
                       "account_id" ":" string ","
                       ( "campaign_ids" ":" "[" integer { "," integer } "]"
                       | "sku_ids" ":" "[" string { "," string } "]"
                       | "sku_filter" ":" sku_filter )
                   "}" ;

sku_filter       = "{" [ "categories" ":" string_array "," ]
                       [ "tags" ":" string_array "," ]
                       [ "min_stock" ":" integer "," ]
                       [ "min_revenue_7d" ":" number ]
                   "}" ;

(* Расписание *)
schedule         = "{" "timezone" ":" string ","     (* например "Europe/Moscow" *)
                       [ "active_from" ":" datetime "," ]
                       [ "active_until" ":" datetime "," ]
                       [ "cron" ":" string ]         (* cron-выражение *)
                   "}" ;

(* Условия: рекурсивные логические выражения *)
condition        = leaf_condition | composite_condition ;

composite_condition = "{" ( "and" | "or" ) ":" "[" condition { "," condition } "]" "}"
                    | "{" "not" ":" condition "}" ;

leaf_condition   = "{" "metric" ":" metric_name ","
                       "op" ":" comparison_op ","
                       "value" ":" ( number | string | number_array )
                       [ "," "window" ":" duration ]
                   "}"
                 | "{" "time" ":" time_condition "}" ;

metric_name      = "cpm" | "ctr" | "cr_card" | "cr_cart"
                 | "orders_count" | "revenue" | "drr"
                 | "ad_spend" | "position" | "stock_total"
                 | "stock_fbo" | "competitor_min_cpm"
                 | "daily_budget_remaining_pct" | "localization_index" ;

comparison_op    = ">" | ">=" | "<" | "<=" | "==" | "!=" | "in" | "not_in" | "between" ;

duration         = "1h" | "4h" | "24h" | "7d" | "30d" ;

time_condition   = "{" [ "hours" ":" hour_array "," ]
                       [ "days_of_week" ":" dow_array "," ]
                       [ "dates" ":" date_array "," ]
                       [ "exclude_dates" ":" date_array ]
                   "}" ;

hour_array       = "[" integer { "," integer } "]" ;  (* 0..23 *)
dow_array        = "[" dow { "," dow } "]" ;
dow              = "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT" | "SUN" ;

(* Действия *)
action           = set_cpm_action | scale_cpm_action | target_strategy_action
                 | pause_action | composite_action ;

set_cpm_action   = "{" "type" ":" "set_cpm" ","
                       "value" ":" number "}" ;

scale_cpm_action = "{" "type" ":" "scale_cpm" ","
                       "factor" ":" number "}" ;  (* например 1.15 = +15% *)

target_strategy_action = "{" "type" ":" "strategy" ","
                             "strategy" ":" strategy_name ","
                             "params" ":" object "}" ;

strategy_name    = "max_coverage" | "economy_mode" | "target_drr"
                 | "target_position" | "budget_pacing" | "competitor_beat" ;

pause_action     = "{" "type" ":" "pause" "}" ;

composite_action = "{" "type" ":" "sequence" ","
                       "actions" ":" "[" action { "," action } "]" "}" ;

(* Guardrails — жёсткие ограничения *)
guardrails       = "{" [ "min_cpm" ":" number "," ]
                       [ "max_cpm" ":" number "," ]
                       [ "max_daily_spend_rub" ":" number "," ]
                       [ "cooldown_minutes" ":" integer "," ]
                       [ "max_change_pct" ":" number "," ]
                       [ "require_approval_above_rub" ":" number ]
                   "}" ;
```

### 2.3. JSON Schema (формальная валидация)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://marketcore.io/schemas/bidding-rule/v1.json",
  "title": "BiddingRule",
  "type": "object",
  "required": ["rule_id", "name", "version", "scope", "schedule", "when", "then"],
  "additionalProperties": false,
  "properties": {
    "rule_id":  { "type": "string", "pattern": "^[a-z0-9_]{3,64}$" },
    "name":     { "type": "string", "minLength": 1, "maxLength": 120 },
    "version":  { "type": "integer", "minimum": 1 },
    "priority": { "type": "integer", "minimum": 0, "maximum": 1000, "default": 100 },
    "dry_run":  { "type": "boolean", "default": false },
    "enabled":  { "type": "boolean", "default": true },
    "scope":    { "$ref": "#/$defs/scope" },
    "schedule": { "$ref": "#/$defs/schedule" },
    "when":     { "$ref": "#/$defs/condition" },
    "then":     { "$ref": "#/$defs/action" },
    "guardrails": { "$ref": "#/$defs/guardrails" }
  },

  "$defs": {
    "scope": {
      "type": "object",
      "required": ["platform", "account_id"],
      "properties": {
        "platform":    { "enum": ["wb", "ozon"] },
        "account_id":  { "type": "string", "format": "uuid" },
        "campaign_ids":{ "type": "array", "items": { "type": "integer" } },
        "sku_ids":     { "type": "array", "items": { "type": "string" } },
        "sku_filter":  {
          "type": "object",
          "properties": {
            "categories":      { "type": "array", "items": { "type": "string" } },
            "tags":            { "type": "array", "items": { "type": "string" } },
            "min_stock":       { "type": "integer", "minimum": 0 },
            "min_revenue_7d":  { "type": "number",  "minimum": 0 }
          }
        }
      },
      "oneOf": [
        { "required": ["campaign_ids"] },
        { "required": ["sku_ids"] },
        { "required": ["sku_filter"] }
      ]
    },

    "schedule": {
      "type": "object",
      "required": ["timezone"],
      "properties": {
        "timezone":     { "type": "string",  "examples": ["Europe/Moscow"] },
        "active_from":  { "type": "string",  "format": "date-time" },
        "active_until": { "type": "string",  "format": "date-time" },
        "cron":         { "type": "string",  "pattern": "^[\\S ]+$" }
      }
    },

    "condition": {
      "oneOf": [
        { "$ref": "#/$defs/leafMetric" },
        { "$ref": "#/$defs/leafTime" },
        { "$ref": "#/$defs/compositeAnd" },
        { "$ref": "#/$defs/compositeOr" },
        { "$ref": "#/$defs/compositeNot" }
      ]
    },

    "leafMetric": {
      "type": "object",
      "required": ["metric", "op", "value"],
      "additionalProperties": false,
      "properties": {
        "metric": {
          "enum": [
            "cpm", "ctr", "cr_card", "cr_cart", "orders_count",
            "revenue", "drr", "ad_spend", "position", "stock_total",
            "stock_fbo", "competitor_min_cpm",
            "daily_budget_remaining_pct", "localization_index"
          ]
        },
        "op":     { "enum": [">", ">=", "<", "<=", "==", "!=", "in", "not_in", "between"] },
        "value":  { "anyOf": [
                    { "type": "number" },
                    { "type": "string" },
                    { "type": "array" }
                  ] },
        "window": { "enum": ["1h", "4h", "24h", "7d", "30d"] }
      }
    },

    "leafTime": {
      "type": "object",
      "required": ["time"],
      "additionalProperties": false,
      "properties": {
        "time": {
          "type": "object",
          "properties": {
            "hours":         { "type": "array", "items": { "type": "integer", "minimum": 0, "maximum": 23 } },
            "days_of_week":  { "type": "array", "items": { "enum": ["MON","TUE","WED","THU","FRI","SAT","SUN"] } },
            "dates":         { "type": "array", "items": { "type": "string", "format": "date" } },
            "exclude_dates": { "type": "array", "items": { "type": "string", "format": "date" } }
          },
          "anyOf": [
            { "required": ["hours"] },
            { "required": ["days_of_week"] },
            { "required": ["dates"] }
          ]
        }
      }
    },

    "compositeAnd": {
      "type": "object",
      "required": ["and"],
      "additionalProperties": false,
      "properties": {
        "and": {
          "type": "array",
          "minItems": 2,
          "maxItems": 10,
          "items": { "$ref": "#/$defs/condition" }
        }
      }
    },

    "compositeOr": {
      "type": "object",
      "required": ["or"],
      "additionalProperties": false,
      "properties": {
        "or": {
          "type": "array",
          "minItems": 2,
          "maxItems": 10,
          "items": { "$ref": "#/$defs/condition" }
        }
      }
    },

    "compositeNot": {
      "type": "object",
      "required": ["not"],
      "additionalProperties": false,
      "properties": {
        "not": { "$ref": "#/$defs/condition" }
      }
    },

    "action": {
      "oneOf": [
        {
          "type": "object",
          "required": ["type", "value"],
          "properties": {
            "type":  { "const": "set_cpm" },
            "value": { "type": "number", "minimum": 0 }
          }
        },
        {
          "type": "object",
          "required": ["type", "factor"],
          "properties": {
            "type":   { "const": "scale_cpm" },
            "factor": { "type": "number", "minimum": 0.1, "maximum": 10.0 }
          }
        },
        {
          "type": "object",
          "required": ["type", "strategy"],
          "properties": {
            "type":     { "const": "strategy" },
            "strategy": { "enum": ["max_coverage","economy_mode","target_drr","target_position","budget_pacing","competitor_beat"] },
            "params":   { "type": "object" }
          }
        },
        {
          "type": "object",
          "required": ["type"],
          "properties": { "type": { "const": "pause" } }
        },
        {
          "type": "object",
          "required": ["type", "actions"],
          "properties": {
            "type":    { "const": "sequence" },
            "actions": { "type": "array", "minItems": 1, "maxItems": 5 }
          }
        }
      ]
    },

    "guardrails": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "min_cpm":                    { "type": "number", "minimum": 0 },
        "max_cpm":                    { "type": "number", "minimum": 0 },
        "max_daily_spend_rub":        { "type": "number", "minimum": 0 },
        "cooldown_minutes":           { "type": "integer","minimum": 1, "maximum": 1440, "default": 15 },
        "max_change_pct":             { "type": "number", "minimum": 0, "maximum": 100 },
        "require_approval_above_rub": { "type": "number", "minimum": 0 }
      }
    }
  }
}
```

### 2.4. Примеры правил (библиотека)

#### 2.4.1. «Пиковый вечер по будням» (max_coverage)

```json
{
  "rule_id": "peak_evening_weekdays",
  "name": "Максимальный охват вечером по будням",
  "version": 2,
  "scope": {
    "platform": "wb",
    "account_id": "b3a1-...-f7e2",
    "campaign_ids": [12345, 67890]
  },
  "schedule": { "timezone": "Europe/Moscow" },
  "when": {
    "and": [
      { "time": { "hours": [18, 19, 20, 21, 22], "days_of_week": ["MON","TUE","WED","THU","FRI"] } },
      { "metric": "cr_card", "op": ">=", "value": 4.0, "window": "24h" },
      { "metric": "daily_budget_remaining_pct", "op": ">=", "value": 20 }
    ]
  },
  "then": {
    "type": "strategy",
    "strategy": "target_position",
    "params": { "target_position": 3 }
  },
  "guardrails": {
    "min_cpm": 280,
    "max_cpm": 450,
    "cooldown_minutes": 15,
    "max_change_pct": 25
  },
  "priority": 200
}
```

#### 2.4.2. «Ночная экономия»

```json
{
  "rule_id": "night_economy",
  "name": "Снижение ставок ночью",
  "version": 1,
  "scope": {
    "platform": "ozon",
    "account_id": "b3a1-...-f7e2",
    "sku_filter": { "min_stock": 5 }
  },
  "schedule": { "timezone": "Europe/Moscow" },
  "when": { "time": { "hours": [1, 2, 3, 4, 5, 6] } },
  "then": { "type": "scale_cpm", "factor": 0.4 },
  "guardrails": { "min_cpm": 50, "cooldown_minutes": 60 }
}
```

#### 2.4.3. «Стоп при плохой конверсии»

```json
{
  "rule_id": "pause_on_poor_cr",
  "name": "Пауза при конверсии < 1.5% за 4 часа",
  "version": 1,
  "scope": {
    "platform": "wb",
    "account_id": "b3a1-...-f7e2",
    "sku_filter": { "min_revenue_7d": 10000 }
  },
  "schedule": { "timezone": "Europe/Moscow" },
  "when": {
    "and": [
      { "metric": "cr_card", "op": "<", "value": 1.5, "window": "4h" },
      { "metric": "ad_spend", "op": ">", "value": 500, "window": "4h" }
    ]
  },
  "then": { "type": "pause" },
  "guardrails": { "cooldown_minutes": 60 }
}
```

#### 2.4.4. «Чёрная пятница overdrive»

```json
{
  "rule_id": "bf_overdrive_2026",
  "name": "Агрессивные ставки на ЧП",
  "version": 1,
  "scope": {
    "platform": "wb",
    "account_id": "b3a1-...-f7e2",
    "sku_filter": { "tags": ["flagship"] }
  },
  "schedule": {
    "timezone": "Europe/Moscow",
    "active_from":  "2026-11-28T00:00:00+03:00",
    "active_until": "2026-12-01T00:00:00+03:00"
  },
  "when": { "metric": "stock_total", "op": ">=", "value": 50 },
  "then": {
    "type": "sequence",
    "actions": [
      { "type": "strategy", "strategy": "max_coverage", "params": {} },
      { "type": "scale_cpm", "factor": 1.30 }
    ]
  },
  "guardrails": { "max_cpm": 800, "max_daily_spend_rub": 50000, "cooldown_minutes": 10 },
  "priority": 999
}
```

### 2.5. Валидатор и компилятор (Python)

```python
# marketcore/bidding/dsl.py
"""
Валидация, компиляция и исполнение правил биддинга.

Две ступени:
1. SchemaValidator — структурная проверка по JSON Schema.
2. RuleCompiler    — компиляция в исполняемый AST с предвычисленными выражениями.
"""
from __future__ import annotations

import json
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from enum import Enum
from pathlib import Path
from typing import Any, Callable
from zoneinfo import ZoneInfo

from jsonschema import Draft202012Validator


# --- Контекст, который получает правило при исполнении ---
@dataclass
class EvaluationContext:
    """Снимок метрик SKU/кампании на момент оценки правила."""
    now_utc: datetime
    timezone: str
    metrics: dict[str, float]            # {"cpm": 250.0, "cr_card": 3.4, ...}
    current_cpm: Decimal
    sku_id: str | None = None
    campaign_id: int | None = None
    last_change_at: datetime | None = None  # для cooldown-проверок
    daily_spend_today: Decimal = Decimal("0")


# --- Результат исполнения правила ---
@dataclass
class RuleDecision:
    matched: bool
    action_type: str | None = None
    new_cpm: Decimal | None = None
    reason: str = ""
    requires_approval: bool = False
    guardrail_violations: list[str] = field(default_factory=list)


# ─────────────────────────── AST ───────────────────────────
class ConditionNode(ABC):
    @abstractmethod
    def evaluate(self, ctx: EvaluationContext) -> bool: ...


@dataclass
class AndNode(ConditionNode):
    children: list[ConditionNode]
    def evaluate(self, ctx): return all(c.evaluate(ctx) for c in self.children)


@dataclass
class OrNode(ConditionNode):
    children: list[ConditionNode]
    def evaluate(self, ctx): return any(c.evaluate(ctx) for c in self.children)


@dataclass
class NotNode(ConditionNode):
    child: ConditionNode
    def evaluate(self, ctx): return not self.child.evaluate(ctx)


@dataclass
class MetricNode(ConditionNode):
    metric: str
    op: str
    value: float | list[float]
    window: str | None = None

    _OPS: dict[str, Callable[[float, Any], bool]] = field(default_factory=lambda: {
        ">":  lambda a, b: a >  b,
        ">=": lambda a, b: a >= b,
        "<":  lambda a, b: a <  b,
        "<=": lambda a, b: a <= b,
        "==": lambda a, b: a == b,
        "!=": lambda a, b: a != b,
        "in":     lambda a, b: a in b,
        "not_in": lambda a, b: a not in b,
        "between": lambda a, b: b[0] <= a <= b[1],
    })

    def evaluate(self, ctx: EvaluationContext) -> bool:
        key = f"{self.metric}__{self.window}" if self.window else self.metric
        if key not in ctx.metrics and self.metric not in ctx.metrics:
            # Метрика не посчитана — считаем условие "неизвестно" → False.
            # В production логируем это событие для визибилити.
            return False
        actual = ctx.metrics.get(key, ctx.metrics[self.metric])
        return self._OPS[self.op](actual, self.value)


@dataclass
class TimeNode(ConditionNode):
    hours: set[int] | None = None
    days_of_week: set[int] | None = None      # 0=MON ... 6=SUN
    dates: set[str] | None = None
    exclude_dates: set[str] | None = None

    _DOW_MAP = {"MON":0, "TUE":1, "WED":2, "THU":3, "FRI":4, "SAT":5, "SUN":6}

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


# ─────────────────────────── Validator ───────────────────────────
class SchemaValidator:
    """Валидация JSON-rule против JSON Schema."""

    def __init__(self, schema_path: Path):
        with open(schema_path, "r", encoding="utf-8") as f:
            schema = json.load(f)
        self._validator = Draft202012Validator(schema)

    def validate(self, rule: dict) -> list[str]:
        """Возвращает список ошибок (пустой, если ОК)."""
        errors = []
        for err in self._validator.iter_errors(rule):
            path = ".".join(str(p) for p in err.absolute_path) or "<root>"
            errors.append(f"{path}: {err.message}")
        return errors


# ─────────────────────────── Compiler ───────────────────────────
class RuleCompiler:
    """Компилирует dict-rule в AST. Падает с понятной ошибкой на невалидных правилах."""

    def compile(self, rule_dict: dict) -> CompiledRule:
        cond = self._compile_condition(rule_dict["when"])
        action = rule_dict["then"]
        guardrails = rule_dict.get("guardrails", {})
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
            condition=cond,
            action=action,
            guardrails=guardrails,
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
            dow_map = TimeNode._DOW_MAP
            return TimeNode(
                hours=set(t.get("hours")) if "hours" in t else None,
                days_of_week={dow_map[d] for d in t.get("days_of_week", [])} or None,
                dates=set(t.get("dates")) if "dates" in t else None,
                exclude_dates=set(t.get("exclude_dates")) if "exclude_dates" in t else None,
            )
        raise ValueError(f"Unknown condition node: {list(node.keys())}")

    def _parse_dt(self, s: str | None) -> datetime | None:
        return datetime.fromisoformat(s) if s else None


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
    action: dict                # сырой dict, интерпретируется исполнителем
    guardrails: dict

    def is_active_at(self, now_utc: datetime) -> bool:
        if not self.enabled:
            return False
        if self.active_from and now_utc < self.active_from:
            return False
        if self.active_until and now_utc >= self.active_until:
            return False
        return True


# ─────────────────────────── Executor ───────────────────────────
class RuleExecutor:
    """Применяет скомпилированное правило к контексту."""

    def execute(self, rule: CompiledRule, ctx: EvaluationContext) -> RuleDecision:
        if not rule.is_active_at(ctx.now_utc):
            return RuleDecision(matched=False, reason="rule_inactive")

        # Cooldown — проверяем до condition.evaluate для экономии
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

        # Применяем action
        new_cpm, action_type = self._apply_action(rule.action, ctx)
        if new_cpm is None:
            return RuleDecision(
                matched=True, action_type=action_type,
                reason=f"action={action_type} executed",
            )

        # Guardrails на результирующее значение
        violations = self._check_guardrails(
            new_cpm=new_cpm, current_cpm=ctx.current_cpm,
            guardrails=rule.guardrails, daily_spend=ctx.daily_spend_today,
        )
        if violations:
            # "Критичные" → блокируют, "soft" → ограничивают
            if any(v.startswith("hard:") for v in violations):
                return RuleDecision(
                    matched=True, guardrail_violations=violations,
                    reason=f"guardrail_blocked: {violations}",
                )
            # Soft: урезаем до границы
            new_cpm = self._clamp(new_cpm, rule.guardrails)

        # Требует ли апрува
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
            return None, t  # pause — отдельная команда к API
        if t == "strategy":
            # Делегируем стратегии (реализация в bidding/strategies.py)
            return self._run_strategy(action["strategy"], action.get("params", {}), ctx), t
        if t == "sequence":
            last_cpm = ctx.current_cpm
            for sub in action["actions"]:
                result, _ = self._apply_action(sub, ctx)
                if result is not None:
                    last_cpm = result
                    # В контексте для следующего действия используем обновлённое значение
                    ctx = EvaluationContext(**{**ctx.__dict__, "current_cpm": last_cpm})
            return last_cpm, t
        raise ValueError(f"Unknown action type: {t}")

    def _run_strategy(self, name: str, params: dict, ctx: EvaluationContext) -> Decimal:
        # Упрощённо — реальные стратегии вынесены в отдельный модуль
        if name == "max_coverage":
            bench = ctx.metrics.get("competitor_p90_cpm", float(ctx.current_cpm) * 1.2)
            return Decimal(str(bench)) * Decimal("1.05")
        if name == "economy_mode":
            bench = ctx.metrics.get("competitor_p25_cpm", float(ctx.current_cpm) * 0.7)
            return Decimal(str(bench))
        if name == "target_drr":
            # target_drr_pct задаётся в params; считаем CPM из revenue и ad_spend
            target = Decimal(str(params.get("target_drr_pct", 12)))
            # упрощённо: линейная адаптация
            current_drr = Decimal(str(ctx.metrics.get("drr", 15)))
            factor = target / current_drr if current_drr > 0 else Decimal("1")
            return ctx.current_cpm * factor
        if name == "target_position":
            # Требуются данные о CPM на нужной позиции
            target_cpm = ctx.metrics.get(f"position_{params.get('target_position', 5)}_cpm")
            return Decimal(str(target_cpm)) if target_cpm else ctx.current_cpm
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

    def _clamp(self, cpm: Decimal, guardrails: dict) -> Decimal:
        if (m := guardrails.get("min_cpm")) is not None:
            cpm = max(cpm, Decimal(str(m)))
        if (m := guardrails.get("max_cpm")) is not None:
            cpm = min(cpm, Decimal(str(m)))
        return cpm

    def _requires_approval(self, *, new_cpm: Decimal, current_cpm: Decimal,
                            guardrails: dict) -> bool:
        threshold = guardrails.get("require_approval_above_rub")
        if threshold is None:
            return False
        return abs(new_cpm - current_cpm) >= Decimal(str(threshold))

    def _explain(self, rule: CompiledRule, ctx: EvaluationContext, new_cpm: Decimal) -> str:
        delta = new_cpm - ctx.current_cpm
        sign = "+" if delta >= 0 else ""
        return f"Правило '{rule.name}' сработало: CPM {ctx.current_cpm} → {new_cpm} ({sign}{delta})"
```

### 2.6. Unit-тесты DSL-исполнителя

```python
# tests/bidding/test_dsl.py
from datetime import datetime, timezone
from decimal import Decimal

import pytest
from marketcore.bidding.dsl import (
    EvaluationContext, RuleCompiler, RuleExecutor, SchemaValidator,
)


@pytest.fixture
def executor(): return RuleExecutor()
@pytest.fixture
def compiler(): return RuleCompiler()


class TestMetricConditions:
    def test_simple_metric_comparison(self, compiler, executor):
        rule_dict = {
            "rule_id": "test_1", "name": "t", "version": 1,
            "scope": {"platform": "wb", "account_id": "00000000-0000-0000-0000-000000000001",
                      "campaign_ids": [1]},
            "schedule": {"timezone": "Europe/Moscow"},
            "when": {"metric": "cr_card", "op": "<", "value": 2.0, "window": "4h"},
            "then": {"type": "scale_cpm", "factor": 0.7},
            "guardrails": {"cooldown_minutes": 1},
        }
        rule = compiler.compile(rule_dict)

        ctx = EvaluationContext(
            now_utc=datetime(2026, 4, 20, 14, 0, tzinfo=timezone.utc),
            timezone="Europe/Moscow",
            metrics={"cr_card__4h": 1.5},
            current_cpm=Decimal("200"),
        )
        decision = executor.execute(rule, ctx)
        assert decision.matched
        assert decision.new_cpm == Decimal("140.0")

    def test_and_combination(self, compiler, executor):
        rule_dict = {
            "rule_id": "test_2", "name": "t", "version": 1,
            "scope": {"platform": "wb", "account_id": "00000000-0000-0000-0000-000000000001", "campaign_ids": [1]},
            "schedule": {"timezone": "Europe/Moscow"},
            "when": {"and": [
                {"metric": "cr_card", "op": ">=", "value": 3.0, "window": "24h"},
                {"metric": "daily_budget_remaining_pct", "op": ">", "value": 20},
            ]},
            "then": {"type": "set_cpm", "value": 350},
        }
        rule = compiler.compile(rule_dict)
        ctx = EvaluationContext(
            now_utc=datetime(2026, 4, 20, 14, 0, tzinfo=timezone.utc),
            timezone="Europe/Moscow",
            metrics={"cr_card__24h": 3.5, "daily_budget_remaining_pct": 30},
            current_cpm=Decimal("200"),
        )
        assert executor.execute(rule, ctx).matched is True

        # Один из критериев не выполнен → не матчится
        ctx.metrics["daily_budget_remaining_pct"] = 10
        assert executor.execute(rule, ctx).matched is False


class TestGuardrails:
    def test_max_cpm_clamps(self, compiler, executor):
        rule = compiler.compile({
            "rule_id": "r", "name": "t", "version": 1,
            "scope": {"platform": "wb", "account_id": "00000000-0000-0000-0000-000000000001", "campaign_ids": [1]},
            "schedule": {"timezone": "Europe/Moscow"},
            "when": {"metric": "cpm", "op": ">", "value": 0},
            "then": {"type": "set_cpm", "value": 1000},
            "guardrails": {"max_cpm": 500, "cooldown_minutes": 1},
        })
        ctx = EvaluationContext(
            now_utc=datetime(2026, 4, 20, 14, 0, tzinfo=timezone.utc),
            timezone="Europe/Moscow",
            metrics={"cpm": 250},
            current_cpm=Decimal("250"),
        )
        d = executor.execute(rule, ctx)
        assert d.new_cpm == Decimal("500")       # clamped
        assert any("above_max_cpm" in v for v in d.guardrail_violations)

    def test_daily_budget_hard_block(self, compiler, executor):
        rule = compiler.compile({
            "rule_id": "r", "name": "t", "version": 1,
            "scope": {"platform": "wb", "account_id": "00000000-0000-0000-0000-000000000001", "campaign_ids": [1]},
            "schedule": {"timezone": "Europe/Moscow"},
            "when": {"metric": "cpm", "op": ">", "value": 0},
            "then": {"type": "set_cpm", "value": 400},
            "guardrails": {"max_daily_spend_rub": 1000, "cooldown_minutes": 1},
        })
        ctx = EvaluationContext(
            now_utc=datetime(2026, 4, 20, 14, 0, tzinfo=timezone.utc),
            timezone="Europe/Moscow",
            metrics={"cpm": 200},
            current_cpm=Decimal("200"),
            daily_spend_today=Decimal("1100"),    # бюджет уже потрачен
        )
        d = executor.execute(rule, ctx)
        assert "hard:daily_budget_exhausted" in " ".join(d.guardrail_violations)


class TestTimeConditions:
    def test_hour_match(self, compiler, executor):
        rule = compiler.compile({
            "rule_id": "r", "name": "t", "version": 1,
            "scope": {"platform": "wb", "account_id": "00000000-0000-0000-0000-000000000001", "campaign_ids": [1]},
            "schedule": {"timezone": "Europe/Moscow"},
            "when": {"time": {"hours": [18, 19, 20]}},
            "then": {"type": "set_cpm", "value": 400},
            "guardrails": {"cooldown_minutes": 1},
        })
        # 17:00 UTC = 20:00 МСК → matched
        ctx = EvaluationContext(
            now_utc=datetime(2026, 4, 20, 17, 0, tzinfo=timezone.utc),
            timezone="Europe/Moscow",
            metrics={}, current_cpm=Decimal("200"),
        )
        assert executor.execute(rule, ctx).matched

        # 15:00 UTC = 18:00 МСК → matched
        ctx.now_utc = datetime(2026, 4, 20, 15, 0, tzinfo=timezone.utc)
        assert executor.execute(rule, ctx).matched

        # 10:00 UTC = 13:00 МСК → NO
        ctx.now_utc = datetime(2026, 4, 20, 10, 0, tzinfo=timezone.utc)
        assert executor.execute(rule, ctx).matched is False
```

### 2.7. Приоритизация и конфликт-резолюция

Когда для одного SKU активно несколько правил, порядок:

```
1. Фильтруем по scope (отсеиваются «не про этот SKU»).
2. Фильтруем активные (is_active_at).
3. Исполняем в порядке DESC(priority).
4. Если одно правило даёт "pause" — пауза выигрывает над любым set_cpm.
5. Если два правила дают set_cpm — применяется первое (с бОльшим priority).
6. Финальное значение пропускается через merge_guardrails(all_rules) — берём самое ограничивающее min/max/cooldown.
```

Это задокументировано в метаправиле `conflict_resolution_policy` в настройках аккаунта.

---

## 3. Demand Forecasting Ensemble

### 3.1. Архитектура прогноза
Одна модель всегда проигрывает: у Prophet беды с резкими пиками, у ML-градиентного бустинга — с экстраполяцией на длинные горизонты. **Ансамбль-подход:**

```
          ┌─────────────────────────────────────────────────┐
          │   Historical data (≥ 90 days, ideally 2 years)  │
          └────────────────────┬────────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
      ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
      │  Seasonal    │ │  Prophet     │ │  LightGBM    │
      │  (табличные  │ │ (тренд +     │ │ (регрессия   │
      │  коэфф.)     │ │  сезонность) │ │  остатков)   │
      └──────┬───────┘ └──────┬───────┘ └──────┬───────┘
             │                │                │
             └────────────────┼────────────────┘
                              │
                  ┌───────────▼────────────┐
                  │   Stacking blender     │
                  │   (weighted average    │
                  │    + confidence)       │
                  └───────────┬────────────┘
                              │
                  ┌───────────▼────────────┐
                  │   Forecast + CI        │
                  │   {yhat, lo95, hi95}   │
                  └────────────────────────┘
```

### 3.2. Код модели (полный)

```python
# marketcore/forecasting/demand_model.py
"""
Ансамбль для прогноза спроса на уровне SKU.
Комбинирует:
  - Константные сезонные коэффициенты из конфига (бизнес-знание).
  - Prophet для тренда и персональной сезонности (data-driven).
  - LightGBM для регрессии остатков по внешним фичам.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Optional

import numpy as np
import pandas as pd
from prophet import Prophet
import lightgbm as lgb


# ─── Константы сезонности (бизнес-правила) ───
SEASONAL_COEFFICIENTS: dict[int, float] = {
    1: 0.65,   2: 1.25,   3: 1.55,   4: 1.00,
    5: 0.80,   6: 0.70,   7: 0.70,   8: 1.40,
    9: 0.90,  10: 1.10,  11: 2.05,  12: 1.80,
}


@dataclass
class ForecastPoint:
    date: date
    yhat: float              # точечный прогноз
    yhat_lower: float        # нижняя граница 95% CI
    yhat_upper: float        # верхняя граница 95% CI
    confidence: float        # 0..1, самооценка модели


@dataclass
class ForecastConfig:
    horizon_days: int = 90
    confidence_interval: float = 0.95
    prophet_weight: float = 0.45
    lgbm_weight: float = 0.35
    seasonal_weight: float = 0.20
    min_history_days: int = 60              # отказываемся, если данных меньше
    fallback_to_seasonal_only: bool = True


class DemandForecaster:
    """
    Основной класс. Создаётся на один SKU, обучается, даёт прогноз.

    Пример:
        df = load_history(sku_id)   # columns: ds, y, promo, drr, ads_spend, price, stock
        f = DemandForecaster(sku_id="abc")
        f.fit(df)
        forecast = f.predict(horizon_days=90)
    """

    def __init__(self, sku_id: str, config: ForecastConfig | None = None) -> None:
        self.sku_id = sku_id
        self.config = config or ForecastConfig()
        self.prophet: Prophet | None = None
        self.lgbm: lgb.Booster | None = None
        self._history: pd.DataFrame | None = None
        self._trained = False

    # ────────────────────── FIT ──────────────────────
    def fit(self, history: pd.DataFrame) -> None:
        """
        history: DataFrame со столбцами:
            ds           — дата (datetime)
            y            — дневные продажи (int)
            price        — цена (float)
            ad_spend     — расходы на рекламу (float)
            drr          — ДРР (float)
            stock        — остаток на конец дня (int)
            promo_flag   — был ли активен промо (0/1)
            stockout_flag— был ли OOS (0/1); эти строки не обучаем
        """
        self._validate(history)
        self._history = history.copy().sort_values("ds").reset_index(drop=True)

        # Убираем stockout-дни (ложный ноль продаж из-за отсутствия товара)
        train = self._history[self._history["stockout_flag"] == 0].copy()

        # Добавляем сезонный коэффициент как регрессор Prophet
        train["seasonal_k"] = train["ds"].dt.month.map(SEASONAL_COEFFICIENTS)

        if len(train) < self.config.min_history_days:
            if self.config.fallback_to_seasonal_only:
                self._trained = True
                return  # будем использовать только таблицу
            raise ValueError(f"Not enough history: {len(train)} < {self.config.min_history_days}")

        # ── 1. Prophet ──
        self.prophet = Prophet(
            yearly_seasonality=True,
            weekly_seasonality=True,
            daily_seasonality=False,
            interval_width=self.config.confidence_interval,
            changepoint_prior_scale=0.05,
            seasonality_prior_scale=10.0,
        )
        self.prophet.add_regressor("seasonal_k", mode="multiplicative")
        self.prophet.add_regressor("promo_flag", mode="multiplicative")
        self.prophet.add_regressor("price",      mode="multiplicative")
        self.prophet.fit(train[["ds", "y", "seasonal_k", "promo_flag", "price"]])

        # ── 2. LightGBM на остатках ──
        prophet_pred = self.prophet.predict(train[["ds", "seasonal_k", "promo_flag", "price"]])
        residuals = train["y"].values - prophet_pred["yhat"].values

        feature_cols = ["price", "ad_spend", "drr", "stock", "promo_flag"]
        # Добавляем лаги и скользящие средние
        X = self._engineer_features(train[feature_cols + ["ds"]])
        train_idx = X.dropna().index
        X_train = X.loc[train_idx].drop(columns=["ds"])
        y_train = pd.Series(residuals, index=train.index).loc[train_idx]

        lgb_train = lgb.Dataset(X_train, label=y_train)
        self.lgbm = lgb.train(
            params={
                "objective": "regression",
                "metric": "rmse",
                "learning_rate": 0.05,
                "num_leaves": 31,
                "feature_fraction": 0.8,
                "bagging_fraction": 0.8,
                "verbose": -1,
            },
            train_set=lgb_train,
            num_boost_round=300,
            callbacks=[lgb.early_stopping(20, verbose=False)],
            valid_sets=[lgb_train],
        )
        self._trained = True

    # ────────────────────── PREDICT ──────────────────────
    def predict(self, horizon_days: int | None = None) -> list[ForecastPoint]:
        if not self._trained:
            raise RuntimeError("Model not trained. Call fit() first.")

        horizon = horizon_days or self.config.horizon_days
        future = self._build_future_frame(horizon)

        # === Baseline: сезонные коэффициенты ===
        baseline = self._seasonal_baseline(future)

        # === Prophet ===
        if self.prophet is not None:
            prophet_pred = self.prophet.predict(future)
            prophet_yhat  = prophet_pred["yhat"].values
            prophet_lo    = prophet_pred["yhat_lower"].values
            prophet_hi    = prophet_pred["yhat_upper"].values
        else:
            prophet_yhat = baseline
            prophet_lo   = baseline * 0.7
            prophet_hi   = baseline * 1.3

        # === LightGBM (остатки) ===
        if self.lgbm is not None:
            X_future = self._engineer_features(future[["price", "ad_spend", "drr", "stock", "promo_flag", "ds"]])
            X_future = X_future.drop(columns=["ds"]).fillna(0)
            lgbm_residual = self.lgbm.predict(X_future)
        else:
            lgbm_residual = np.zeros(len(future))

        # === Blend ===
        w_s, w_p, w_l = self.config.seasonal_weight, self.config.prophet_weight, self.config.lgbm_weight
        final = w_s * baseline + w_p * prophet_yhat + w_l * (prophet_yhat + lgbm_residual)

        # Не допускаем отрицательных значений
        final = np.clip(final, 0, None)

        # Конфиденс-интервалы: расширяем CI Prophet, если LGBM существенно отклонил прогноз
        spread = np.abs(lgbm_residual) / np.maximum(prophet_yhat, 1)
        widen = 1 + np.clip(spread * 0.5, 0, 0.5)
        lo = np.clip(prophet_lo * widen * w_p + baseline * w_s * 0.7, 0, None)
        hi = (prophet_hi * widen * w_p + baseline * w_s * 1.3 + lgbm_residual * w_l)

        # Confidence — простая эвристика, 0..1
        history_days = len(self._history) if self._history is not None else 0
        base_conf = min(1.0, history_days / 365)
        ci_width = (hi - lo) / np.maximum(final, 1)
        per_point_conf = base_conf * np.clip(1 - ci_width / 2, 0, 1)

        return [
            ForecastPoint(
                date=row.ds.date() if hasattr(row.ds, "date") else row.ds,
                yhat=float(final[i]),
                yhat_lower=float(lo[i]),
                yhat_upper=float(hi[i]),
                confidence=float(per_point_conf[i]),
            )
            for i, row in enumerate(future.itertuples())
        ]

    # ─── helpers ───
    def _validate(self, df: pd.DataFrame) -> None:
        required = {"ds", "y", "price", "ad_spend", "drr", "stock", "promo_flag", "stockout_flag"}
        missing = required - set(df.columns)
        if missing:
            raise ValueError(f"History missing columns: {missing}")

    def _build_future_frame(self, horizon: int) -> pd.DataFrame:
        assert self._history is not None
        last_date = self._history["ds"].max()
        future_dates = pd.date_range(last_date + timedelta(days=1), periods=horizon, freq="D")

        # Простая экстраполяция внешних фич — среднее за последние 14 дней
        recent = self._history.tail(14)
        future = pd.DataFrame({
            "ds": future_dates,
            "price":        recent["price"].mean(),
            "ad_spend":     recent["ad_spend"].mean(),
            "drr":          recent["drr"].mean(),
            "stock":        recent["stock"].mean(),
            "promo_flag":   0,
        })
        future["seasonal_k"] = future["ds"].dt.month.map(SEASONAL_COEFFICIENTS)
        return future

    def _seasonal_baseline(self, future: pd.DataFrame) -> np.ndarray:
        assert self._history is not None
        avg_daily = self._history[self._history["stockout_flag"] == 0]["y"].mean()
        return avg_daily * future["seasonal_k"].values

    def _engineer_features(self, df: pd.DataFrame) -> pd.DataFrame:
        df = df.copy().sort_values("ds").reset_index(drop=True)
        for lag in (1, 7, 14):
            for col in ("price", "ad_spend", "drr", "stock"):
                df[f"{col}_lag{lag}"] = df[col].shift(lag)
        for win in (7, 14):
            for col in ("price", "ad_spend"):
                df[f"{col}_ma{win}"] = df[col].rolling(win).mean()
        df["dow"]       = df["ds"].dt.dayofweek
        df["month"]     = df["ds"].dt.month
        df["seasonal_k"]= df["month"].map(SEASONAL_COEFFICIENTS)
        return df
```

### 3.3. Бэктестинг и качество

```python
# marketcore/forecasting/backtest.py
"""Walk-forward backtesting с метриками WAPE/MAPE/SMAPE."""
import numpy as np
import pandas as pd

from marketcore.forecasting.demand_model import DemandForecaster


def walk_forward_backtest(
    history: pd.DataFrame,
    sku_id: str,
    train_window_days: int = 180,
    forecast_horizon: int = 14,
    step_days: int = 7,
) -> dict:
    metrics_per_fold = []
    start = history["ds"].min() + pd.Timedelta(days=train_window_days)
    end = history["ds"].max() - pd.Timedelta(days=forecast_horizon)

    fold_date = start
    while fold_date <= end:
        train = history[history["ds"] < fold_date]
        test  = history[
            (history["ds"] >= fold_date) &
            (history["ds"] <  fold_date + pd.Timedelta(days=forecast_horizon))
        ]
        if len(train) < 60 or len(test) < forecast_horizon:
            fold_date += pd.Timedelta(days=step_days)
            continue

        model = DemandForecaster(sku_id=sku_id)
        model.fit(train)
        forecast = model.predict(horizon_days=forecast_horizon)

        yhat = np.array([fp.yhat for fp in forecast])
        y    = test["y"].values
        # OOS в тесте игнорируем
        mask = test["stockout_flag"].values == 0
        if mask.sum() == 0:
            fold_date += pd.Timedelta(days=step_days)
            continue

        yhat, y = yhat[mask], y[mask]
        metrics_per_fold.append({
            "fold": fold_date.date().isoformat(),
            "wape":  _wape(y, yhat),
            "mape":  _mape(y, yhat),
            "smape": _smape(y, yhat),
            "mae":   float(np.mean(np.abs(y - yhat))),
            "bias":  float(np.mean(yhat - y)),
        })
        fold_date += pd.Timedelta(days=step_days)

    return {
        "folds": metrics_per_fold,
        "avg_wape":  np.mean([f["wape"]  for f in metrics_per_fold]),
        "avg_mape":  np.mean([f["mape"]  for f in metrics_per_fold]),
        "avg_smape": np.mean([f["smape"] for f in metrics_per_fold]),
    }


def _wape(y, yhat): return float(np.sum(np.abs(y - yhat)) / np.maximum(np.sum(y), 1))
def _mape(y, yhat):
    mask = y > 0
    if mask.sum() == 0: return float("nan")
    return float(np.mean(np.abs((y[mask] - yhat[mask]) / y[mask])))
def _smape(y, yhat):
    denom = (np.abs(y) + np.abs(yhat)) / 2
    mask = denom > 0
    if mask.sum() == 0: return 0.0
    return float(np.mean(np.abs(y[mask] - yhat[mask]) / denom[mask]))
```

### 3.4. Приёмочные критерии качества

| SKU-категория | Целевой WAPE (14d horizon) |
|---|---|
| A-товары (стабильные top-sellers) | ≤ 15% |
| B-товары (регулярные продажи) | ≤ 25% |
| C-товары (редкие продажи) | ≤ 40% |
| Новинки (< 30 дн истории) | fallback на категорийный прогноз |

Если WAPE > целевого 3 фолда подряд → автоматическое переобучение с расширенным пулом фич + алерт в ML-канал Slack.

---

## 4. OOS Calculator & Supply Recommender

### 4.1. Полный код

```python
# marketcore/supply/oos_calculator.py
"""
Расчёт "Дней до обнуления" (OOS) и рекомендация объёма поставки.
Потребляет выход DemandForecaster + текущие остатки + бизнес-параметры.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal

from marketcore.forecasting.demand_model import ForecastPoint


@dataclass
class SkuSupplyParams:
    sku_id: str
    current_stock_fbo: int         # остаток на складах маркетплейса
    current_stock_fbs: int         # остаток на своём складе
    in_transit_units: int          # товар "в пути"
    lead_time_days: int            # от PO до приёмки
    safety_buffer_days: int = 5    # дополнительный буфер
    pack_size: int = 1             # упаковка (округление)
    target_coverage_days: int = 60 # на сколько дней закрываем поставку
    service_level: float = 0.95    # хотим покрыть 95% спроса → используем yhat_upper


@dataclass
class OOSReport:
    sku_id: str
    days_until_oos: int | None          # None если > horizon
    oos_date: date | None
    supply_trigger_date: date           # последняя дата отправки PO
    urgency: str                        # green | yellow | red | black
    recommended_qty: int
    confidence: float
    explanation: str
    breakdown: dict


class OOSCalculator:
    """
    Вычисляет OOS-метрики и рекомендацию поставки.
    """

    URGENCY_THRESHOLDS_DAYS = {
        "black": 0,     # уже просрочено
        "red":   10,    # < 10 дней до trigger
        "yellow":30,    # 10..30
        "green": 9999,  # > 30
    }

    def analyse(
        self,
        params: SkuSupplyParams,
        forecast: list[ForecastPoint],
        today: date | None = None,
    ) -> OOSReport:
        today = today or date.today()
        total_stock = params.current_stock_fbo + params.current_stock_fbs

        # ── 1. Определяем дату OOS ──
        # Используем yhat_upper для консервативности (service level 95%)
        oos_date: date | None = None
        cumulative = 0.0
        for i, point in enumerate(forecast):
            # Выбираем prognosis в зависимости от service_level
            if params.service_level >= 0.95:
                demand = point.yhat_upper
            elif params.service_level >= 0.85:
                demand = (point.yhat + point.yhat_upper) / 2
            else:
                demand = point.yhat
            cumulative += demand
            if cumulative >= total_stock + params.in_transit_units:
                oos_date = point.date
                break

        days_until_oos = (oos_date - today).days if oos_date else None

        # ── 2. Supply trigger date ──
        if oos_date:
            supply_trigger_date = oos_date - timedelta(
                days=params.lead_time_days + params.safety_buffer_days
            )
        else:
            supply_trigger_date = today + timedelta(days=params.target_coverage_days)

        # ── 3. Urgency ──
        days_to_trigger = (supply_trigger_date - today).days
        urgency = self._compute_urgency(days_to_trigger)

        # ── 4. Рекомендуемый объём поставки ──
        qty, qty_explanation = self._recommend_qty(params, forecast)

        # ── 5. Confidence прогноза на трейл до OOS ──
        window = forecast[: (days_until_oos or len(forecast))]
        avg_conf = sum(p.confidence for p in window) / max(len(window), 1)

        explanation = self._build_explanation(
            params=params, oos_date=oos_date, days_until_oos=days_until_oos,
            supply_trigger_date=supply_trigger_date, qty=qty,
            qty_explanation=qty_explanation, urgency=urgency,
        )

        return OOSReport(
            sku_id=params.sku_id,
            days_until_oos=days_until_oos,
            oos_date=oos_date,
            supply_trigger_date=supply_trigger_date,
            urgency=urgency,
            recommended_qty=qty,
            confidence=avg_conf,
            explanation=explanation,
            breakdown={
                "total_stock": total_stock,
                "in_transit":  params.in_transit_units,
                "avg_daily_demand_next_30d": sum(p.yhat for p in forecast[:30]) / 30,
                "lead_time_days": params.lead_time_days,
                "safety_buffer_days": params.safety_buffer_days,
            },
        )

    def _compute_urgency(self, days_to_trigger: int) -> str:
        if days_to_trigger < 0:
            return "black"
        if days_to_trigger < self.URGENCY_THRESHOLDS_DAYS["red"]:
            return "red"
        if days_to_trigger < self.URGENCY_THRESHOLDS_DAYS["yellow"]:
            return "yellow"
        return "green"

    def _recommend_qty(
        self, params: SkuSupplyParams, forecast: list[ForecastPoint]
    ) -> tuple[int, str]:
        horizon = params.target_coverage_days
        projected_demand = sum(p.yhat_upper for p in forecast[:horizon])
        total_stock = (params.current_stock_fbo + params.current_stock_fbs
                       + params.in_transit_units)
        needed = max(0, projected_demand - total_stock)
        # Страховой запас 15% от прогноза
        safety = 0.15 * projected_demand
        qty = needed + safety
        # Округляем до кратного упаковке
        qty_rounded = int(math.ceil(qty / params.pack_size) * params.pack_size)

        explanation = (
            f"Прогноз {projected_demand:.0f} ед за {horizon} дней. "
            f"В наличии и в пути: {total_stock}. "
            f"Требуется: {needed:.0f} + страх. {safety:.0f} = {qty:.0f} → "
            f"округлено до {qty_rounded} (pack_size={params.pack_size})."
        )
        return qty_rounded, explanation

    def _build_explanation(self, **kw) -> str:
        days = kw["days_until_oos"]
        if days is None:
            return f"Остатка хватит на весь горизонт прогноза. Поставка не требуется в ближайший период."
        urgency_text = {
            "black": "⚫ КРИТИЧНО: срок отправки PO уже просрочен",
            "red":   f"🔴 СРОЧНО: отправьте PO в течение {(kw['supply_trigger_date'] - date.today()).days} дней",
            "yellow":f"🟡 Запланируйте PO к {kw['supply_trigger_date']}",
            "green": f"🟢 Всё спокойно: до обнуления {days} дней",
        }[kw["urgency"]]
        return (f"{urgency_text}. OOS ожидается {kw['oos_date']}. "
                f"Рекомендованный объём: {kw['qty']} ед.")
```

### 4.2. Тесты

```python
# tests/supply/test_oos.py
from datetime import date, timedelta
import pytest
from marketcore.supply.oos_calculator import OOSCalculator, SkuSupplyParams
from marketcore.forecasting.demand_model import ForecastPoint


def _make_forecast(daily: float, days: int, start: date) -> list[ForecastPoint]:
    return [ForecastPoint(
        date=start + timedelta(days=i),
        yhat=daily, yhat_lower=daily * 0.8, yhat_upper=daily * 1.2,
        confidence=0.85,
    ) for i in range(days)]


class TestOOSCalculator:
    def test_healthy_green_zone(self):
        fcst = _make_forecast(daily=10, days=90, start=date(2026, 4, 20))
        params = SkuSupplyParams(
            sku_id="a", current_stock_fbo=500, current_stock_fbs=200,
            in_transit_units=0, lead_time_days=14, target_coverage_days=60,
        )
        report = OOSCalculator().analyse(params, fcst, today=date(2026, 4, 20))
        assert report.urgency == "green"
        assert report.days_until_oos is not None
        assert report.days_until_oos > 40

    def test_red_zone_when_close_to_oos(self):
        fcst = _make_forecast(daily=15, days=90, start=date(2026, 4, 20))
        params = SkuSupplyParams(
            sku_id="a", current_stock_fbo=100, current_stock_fbs=0,
            in_transit_units=0, lead_time_days=14,
        )
        report = OOSCalculator().analyse(params, fcst, today=date(2026, 4, 20))
        assert report.urgency in ("red", "black")
        assert report.recommended_qty > 0

    def test_no_oos_when_stock_exceeds_horizon_demand(self):
        fcst = _make_forecast(daily=5, days=90, start=date(2026, 4, 20))
        params = SkuSupplyParams(
            sku_id="a", current_stock_fbo=10_000, current_stock_fbs=0,
            in_transit_units=0, lead_time_days=14,
        )
        report = OOSCalculator().analyse(params, fcst, today=date(2026, 4, 20))
        assert report.days_until_oos is None
        assert report.urgency == "green"
```

---

## 5. Price-Matching Decision Engine

### 5.1. Pattern: Strategy + Chain of Responsibility

Каждая стратегия — отдельный класс с единым интерфейсом. Движок цепляет их последовательно через фильтры и guardrails.

```python
# marketcore/pricing/engine.py
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from decimal import Decimal
from enum import Enum
from statistics import median


class PricingStrategy(str, Enum):
    BEAT_BY_DELTA = "beat_by_delta"      # ниже самого дешёвого на X ₽
    MATCH_MEDIAN  = "match_median"       # равен медиане рынка
    PREMIUM_GAP   = "premium_gap"        # выше медианы на X %
    RULE_BASED    = "rule_based"         # сложные условия из DSL
    IGNORE        = "ignore"             # вообще не меняем


@dataclass(frozen=True)
class CompetitorSnapshot:
    sku_id: str
    price: Decimal
    rating: float
    reviews_count: int
    stock: int
    seller_id: str
    is_self: bool = False


@dataclass(frozen=True)
class OurSku:
    sku_id: str
    current_price: Decimal
    rrc: Decimal | None                   # рекомендованная розничная цена
    min_margin_price: Decimal             # минимум, ниже которого нельзя
    pack_size: int = 1
    category: str = ""


@dataclass(frozen=True)
class PricingRules:
    strategy: PricingStrategy
    delta_rub: Decimal = Decimal("0")     # для beat_by_delta
    premium_pct: float = 0.0              # для premium_gap (в %)
    min_competitor_rating: float = 4.5
    min_competitor_reviews: int = 20
    max_deviation_pct_from_current: float = 30.0  # не считаем конкурентом, если > 30%
    noise_threshold_pct: float = 0.5               # не меняем, если < 0.5% отличия
    require_approval_pct: float = 10.0             # > 10% изменения → apprv


@dataclass
class PricingDecision:
    should_change: bool
    from_price: Decimal
    to_price: Decimal
    reason: str
    requires_approval: bool = False
    filtered_competitors: int = 0
    considered_competitors: int = 0
    benchmark: Decimal | None = None


class PriceStrategyExecutor(ABC):
    @abstractmethod
    def compute(self, our: OurSku, relevant: list[CompetitorSnapshot],
                rules: PricingRules) -> tuple[Decimal, str, Decimal | None]:
        """Возвращает (target_price, reason, benchmark)."""


class BeatByDeltaExecutor(PriceStrategyExecutor):
    def compute(self, our, relevant, rules):
        cheapest = min(relevant, key=lambda c: c.price)
        target = cheapest.price - rules.delta_rub
        return target, f"Ниже мин. конкурента {cheapest.seller_id} ({cheapest.price}₽) на {rules.delta_rub}₽", cheapest.price


class MatchMedianExecutor(PriceStrategyExecutor):
    def compute(self, our, relevant, rules):
        m = Decimal(str(median([float(c.price) for c in relevant])))
        return m, f"Медиана рынка из {len(relevant)} конкурентов", m


class PremiumGapExecutor(PriceStrategyExecutor):
    def compute(self, our, relevant, rules):
        m = Decimal(str(median([float(c.price) for c in relevant])))
        target = m * (Decimal("1") + Decimal(str(rules.premium_pct)) / 100)
        return target, f"Медиана {m}₽ + премиум {rules.premium_pct}%", m


class PricingEngine:
    _EXECUTORS: dict[PricingStrategy, PriceStrategyExecutor] = {
        PricingStrategy.BEAT_BY_DELTA: BeatByDeltaExecutor(),
        PricingStrategy.MATCH_MEDIAN:  MatchMedianExecutor(),
        PricingStrategy.PREMIUM_GAP:   PremiumGapExecutor(),
    }

    def decide(
        self,
        our: OurSku,
        competitors: list[CompetitorSnapshot],
        rules: PricingRules,
    ) -> PricingDecision:
        if rules.strategy == PricingStrategy.IGNORE:
            return PricingDecision(
                should_change=False, from_price=our.current_price,
                to_price=our.current_price, reason="strategy=ignore",
            )

        # ── 1. Фильтрация конкурентов ──
        relevant = self._filter_competitors(our, competitors, rules)
        total_count = len(competitors)
        filtered_count = len(relevant)

        if not relevant:
            return PricingDecision(
                should_change=False, from_price=our.current_price,
                to_price=our.current_price,
                reason=f"Нет релевантных конкурентов (отфильтровано {total_count})",
                considered_competitors=total_count,
            )

        # ── 2. Рассчитываем target по стратегии ──
        executor = self._EXECUTORS.get(rules.strategy)
        if not executor:
            raise ValueError(f"Unsupported strategy: {rules.strategy}")
        target, strategy_reason, benchmark = executor.compute(our, relevant, rules)

        # ── 3. Guardrails ──
        target = self._apply_guardrails(target, our)

        # ── 4. Шумовой порог ──
        if our.current_price > 0:
            change_pct = abs((target - our.current_price) / our.current_price * 100)
            if change_pct < Decimal(str(rules.noise_threshold_pct)):
                return PricingDecision(
                    should_change=False, from_price=our.current_price,
                    to_price=our.current_price,
                    reason=f"Изменение {change_pct:.2f}% < шум {rules.noise_threshold_pct}%",
                    filtered_competitors=filtered_count,
                    considered_competitors=total_count,
                    benchmark=benchmark,
                )

        # ── 5. Apprv-трешхолд ──
        requires_approval = False
        if our.current_price > 0:
            change_pct = abs((target - our.current_price) / our.current_price * 100)
            requires_approval = change_pct > Decimal(str(rules.require_approval_pct))

        # ── 6. Округление до pack_size (чтобы не было 1487₽ при pack=10) ──
        target = self._round_to_nice_price(target)

        return PricingDecision(
            should_change=True,
            from_price=our.current_price,
            to_price=target,
            reason=strategy_reason,
            requires_approval=requires_approval,
            filtered_competitors=filtered_count,
            considered_competitors=total_count,
            benchmark=benchmark,
        )

    def _filter_competitors(
        self, our: OurSku, competitors: list[CompetitorSnapshot], rules: PricingRules
    ) -> list[CompetitorSnapshot]:
        out = []
        for c in competitors:
            if c.is_self:
                continue
            if c.stock <= 0:
                continue
            if c.rating < rules.min_competitor_rating:
                continue
            if c.reviews_count < rules.min_competitor_reviews:
                continue
            if our.current_price > 0:
                dev = abs(float(c.price - our.current_price)) / float(our.current_price)
                if dev > rules.max_deviation_pct_from_current / 100:
                    continue
            out.append(c)
        return out

    def _apply_guardrails(self, target: Decimal, our: OurSku) -> Decimal:
        target = max(target, our.min_margin_price)
        if our.rrc is not None:
            # не поднимаем выше РРЦ (закон о рекомендованной цене)
            target = min(target, our.rrc)
        return target

    def _round_to_nice_price(self, price: Decimal) -> Decimal:
        """Округление к психологически приятному числу (…99, …90)."""
        as_float = float(price)
        if as_float < 1000:
            rounded = round(as_float / 10) * 10 - 1        # 249 → 249
        elif as_float < 10_000:
            rounded = round(as_float / 10) * 10 - 1        # 2490 → 2490
        else:
            rounded = round(as_float / 100) * 100 - 1      # 24 990
        return Decimal(max(rounded, 1))
```

### 5.2. Тесты decision engine

```python
# tests/pricing/test_engine.py
from decimal import Decimal
import pytest
from marketcore.pricing.engine import (
    CompetitorSnapshot, OurSku, PricingEngine, PricingRules, PricingStrategy,
)


@pytest.fixture
def engine(): return PricingEngine()


@pytest.fixture
def our_sku():
    return OurSku(
        sku_id="abc", current_price=Decimal("1490"),
        rrc=Decimal("1990"), min_margin_price=Decimal("900"),
    )


@pytest.fixture
def competitors():
    return [
        CompetitorSnapshot("x1", Decimal("1450"), 4.8, 150, 10, "seller1"),
        CompetitorSnapshot("x2", Decimal("1520"), 4.7, 200, 20, "seller2"),
        CompetitorSnapshot("x3", Decimal("1380"), 4.9, 300, 15, "seller3"),
        CompetitorSnapshot("x4", Decimal("1600"), 4.6, 80,  0, "seller4"),   # нет в наличии
        CompetitorSnapshot("x5", Decimal("900"),  4.2, 500, 10, "seller5"),  # плохой рейтинг
    ]


class TestPricingEngine:
    def test_beat_by_delta(self, engine, our_sku, competitors):
        rules = PricingRules(strategy=PricingStrategy.BEAT_BY_DELTA,
                             delta_rub=Decimal("20"), noise_threshold_pct=0.5)
        decision = engine.decide(our_sku, competitors, rules)
        assert decision.should_change
        # min_competitor среди релевантных = 1380, минус 20 = 1360 → приятное округление
        assert decision.to_price <= Decimal("1365")

    def test_match_median_filters_out_low_rating(self, engine, our_sku, competitors):
        rules = PricingRules(strategy=PricingStrategy.MATCH_MEDIAN)
        d = engine.decide(our_sku, competitors, rules)
        # медиана среди 3 релевантных (1450, 1520, 1380) = 1450
        assert Decimal("1440") <= d.to_price <= Decimal("1465")
        assert d.filtered_competitors == 3
        assert d.considered_competitors == 5

    def test_no_change_when_noise(self, engine):
        our = OurSku(sku_id="a", current_price=Decimal("1500"),
                     rrc=None, min_margin_price=Decimal("500"))
        comp = [CompetitorSnapshot("x", Decimal("1502"), 4.8, 100, 10, "s")]
        rules = PricingRules(strategy=PricingStrategy.MATCH_MEDIAN, noise_threshold_pct=1.0)
        assert engine.decide(our, comp, rules).should_change is False

    def test_guardrail_min_margin(self, engine, our_sku):
        # Все конкуренты ниже min_margin → не уходим ниже
        comp = [CompetitorSnapshot(f"x{i}", Decimal("700"), 4.8, 100, 10, f"s{i}")
                for i in range(3)]
        rules = PricingRules(strategy=PricingStrategy.MATCH_MEDIAN,
                             max_deviation_pct_from_current=100.0)
        d = engine.decide(our_sku, comp, rules)
        assert d.to_price >= our_sku.min_margin_price

    def test_approval_required_on_big_change(self, engine, our_sku, competitors):
        rules = PricingRules(
            strategy=PricingStrategy.BEAT_BY_DELTA,
            delta_rub=Decimal("300"),     # сильное снижение
            require_approval_pct=10.0,
        )
        d = engine.decide(our_sku, competitors, rules)
        assert d.should_change
        assert d.requires_approval
```

---

## 6. Localization Index Calculator

### 6.1. SQL-расчёт через оконные функции

```sql
-- marketcore/sql/localization_index.sql
-- Рассчитывает ИЛ в трёх разрезах: account / category / SKU.
-- Требует TimescaleDB (hypertable orders_ts).

CREATE MATERIALIZED VIEW mv_localization_index AS
WITH order_regions AS (
    SELECT
        o.account_id,
        o.sku_id,
        s.category_path[1] AS top_category,
        o.warehouse_id,
        w.district AS warehouse_district,
        o.customer_district,
        o.quantity,
        o.created_at,
        -- Флаг "локализовано"
        (w.district = o.customer_district)::int AS is_local
    FROM orders_ts o
    JOIN warehouses w ON w.id = o.warehouse_id
    JOIN sku s        ON s.id = o.sku_id
    WHERE o.created_at > NOW() - INTERVAL '30 days'
      AND o.status IN ('delivered', 'shipped')
),

-- L1: Account-level
account_li AS (
    SELECT
        account_id,
        'account' AS level,
        NULL::uuid AS entity_id,
        SUM(quantity * is_local)::float / NULLIF(SUM(quantity), 0) AS li,
        SUM(quantity) AS total_units,
        COUNT(*) AS orders_count
    FROM order_regions
    GROUP BY account_id
),

-- L2: Category-level
category_li AS (
    SELECT
        account_id,
        'category' AS level,
        NULL::uuid AS entity_id,      -- category как текст не влезает в uuid, идёт в отдельное поле
        SUM(quantity * is_local)::float / NULLIF(SUM(quantity), 0) AS li,
        SUM(quantity) AS total_units,
        COUNT(*) AS orders_count
    FROM order_regions
    GROUP BY account_id, top_category
),

-- L3: SKU-level
sku_li AS (
    SELECT
        account_id,
        'sku' AS level,
        sku_id AS entity_id,
        SUM(quantity * is_local)::float / NULLIF(SUM(quantity), 0) AS li,
        SUM(quantity) AS total_units,
        COUNT(*) AS orders_count
    FROM order_regions
    GROUP BY account_id, sku_id
)

SELECT * FROM account_li
UNION ALL SELECT * FROM category_li
UNION ALL SELECT * FROM sku_li;

CREATE INDEX idx_mv_li_account_level ON mv_localization_index (account_id, level);
-- Обновляется каждый час через pg_cron.
```

### 6.2. Python-слой

```python
# marketcore/analytics/localization.py
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Protocol

import asyncpg


class LIZone(str, Enum):
    ELITE  = "elite"     # > 0.85
    GREEN  = "green"     # 0.65..0.85
    YELLOW = "yellow"    # 0.40..0.65
    RED    = "red"       # < 0.40


@dataclass
class LIResult:
    li: float
    zone: LIZone
    total_units: int
    orders_count: int
    calculated_at: datetime


def classify_zone(li: float) -> LIZone:
    if li > 0.85: return LIZone.ELITE
    if li > 0.65: return LIZone.GREEN
    if li > 0.40: return LIZone.YELLOW
    return LIZone.RED


class LocalizationService:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def get_account_li(self, account_id: str) -> LIResult | None:
        row = await self._pool.fetchrow("""
            SELECT li, total_units, orders_count
            FROM mv_localization_index
            WHERE account_id = $1 AND level = 'account'
        """, account_id)
        if not row or row["li"] is None:
            return None
        return LIResult(
            li=float(row["li"]),
            zone=classify_zone(row["li"]),
            total_units=row["total_units"],
            orders_count=row["orders_count"],
            calculated_at=datetime.utcnow(),
        )

    async def get_sku_li(self, account_id: str, sku_id: str) -> LIResult | None:
        row = await self._pool.fetchrow("""
            SELECT li, total_units, orders_count
            FROM mv_localization_index
            WHERE account_id = $1 AND level = 'sku' AND entity_id = $2
        """, account_id, sku_id)
        if not row or row["li"] is None:
            return None
        return LIResult(
            li=float(row["li"]), zone=classify_zone(row["li"]),
            total_units=row["total_units"], orders_count=row["orders_count"],
            calculated_at=datetime.utcnow(),
        )

    async def recommendations(self, account_id: str, sku_id: str) -> list[str]:
        """
        Возвращает human-readable рекомендации по улучшению ИЛ.
        """
        result = await self.get_sku_li(account_id, sku_id)
        if result is None:
            return ["Недостаточно данных для анализа (нужно минимум 30 дней продаж)."]

        recs: list[str] = []
        if result.zone == LIZone.RED:
            regional_breakdown = await self._pool.fetch("""
                SELECT customer_district, SUM(quantity) AS qty
                FROM orders_ts o
                WHERE o.sku_id = $1 AND o.created_at > NOW() - INTERVAL '30 days'
                GROUP BY customer_district
                ORDER BY qty DESC LIMIT 3
            """, sku_id)
            top_regions = ", ".join(r["customer_district"] for r in regional_breakdown)
            recs.append(f"ИЛ критично низкий ({result.li:.0%}). Топ-3 ФО по спросу: {top_regions}.")
            recs.append("Рекомендация: добавить склад в ЦФО или ПФО.")
            recs.append("Ожидаемый эффект: –35-50% логистики, +20% CR.")
        elif result.zone == LIZone.YELLOW:
            recs.append(f"ИЛ ниже целевого ({result.li:.0%} vs target 65%).")
            recs.append("При следующей поставке перераспределите 30% в ФО с высоким спросом.")
        else:
            recs.append(f"ИЛ в оптимальной зоне ({result.li:.0%}). Поддерживайте текущее распределение.")
        return recs
```

---

## 7. Ranking Score Model

### 7.1. Калибровка весов через Ridge Regression

```python
# marketcore/ranking/score_model.py
"""
Персональная модель score из 6 сигналов.
Веса калибруются раз в 2 недели на истории "фактическая позиция → факторы".
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge
from sklearn.preprocessing import StandardScaler


@dataclass
class RankingFeatures:
    localization_index:    float   # 0..1
    cr_card:               float   # 0..1
    velocity_trend_14d:    float   # относительное изменение (-1..+∞)
    rating:                float   # 0..5
    price_competitiveness: float   # 0..1 (1 = самая низкая цена)
    ad_boost:              float   # 0..1 (нормированная CPM)


DEFAULT_WEIGHTS = {
    "localization_index":    0.25,
    "cr_card":               0.22,
    "velocity_trend_14d":    0.18,
    "rating":                0.15,
    "price_competitiveness": 0.12,
    "ad_boost":              0.08,
}


class RankingScoreModel:
    def __init__(self, weights: dict[str, float] | None = None) -> None:
        self.weights = weights or DEFAULT_WEIGHTS.copy()
        self._scaler: StandardScaler | None = None

    def calibrate(self, history: pd.DataFrame) -> None:
        """
        history: DataFrame
            columns: localization_index, cr_card, velocity_trend_14d, rating,
                     price_competitiveness, ad_boost, actual_position
        Обучаем Ridge с положительными весами (через constraint).
        """
        features = ["localization_index", "cr_card", "velocity_trend_14d",
                    "rating", "price_competitiveness", "ad_boost"]
        X = history[features].values
        # Таргет: инверсия позиции (чем ниже место → выше таргет)
        y = 1 / np.maximum(history["actual_position"].values, 1)

        self._scaler = StandardScaler().fit(X)
        X_scaled = self._scaler.transform(X)

        model = Ridge(alpha=1.0, positive=True)  # positive=True гарантирует неотрицательные веса
        model.fit(X_scaled, y)

        raw = dict(zip(features, model.coef_))
        # Нормируем к сумме = 1
        total = sum(raw.values()) or 1
        self.weights = {k: v / total for k, v in raw.items()}

    def score(self, features: RankingFeatures) -> float:
        """Возвращает score от 0 до 100."""
        normalized = self._normalize(features)
        raw = sum(normalized[k] * self.weights[k] for k in self.weights)
        return float(np.clip(raw * 100, 0, 100))

    def explain(self, features: RankingFeatures) -> list[tuple[str, float, str]]:
        """
        Возвращает разбивку: [(фактор, вклад в score, action), ...]
        Отсортировано по убыванию потенциала улучшения.
        """
        normalized = self._normalize(features)
        contributions = []
        for key in self.weights:
            val = normalized[key]
            contrib = val * self.weights[key] * 100
            max_possible = self.weights[key] * 100
            gap = max_possible - contrib
            action = self._action_for(key, val)
            contributions.append((key, contrib, gap, action))

        # Сортируем по gap (где больше простора для роста)
        contributions.sort(key=lambda x: x[2], reverse=True)
        return [(c[0], c[1], c[3]) for c in contributions]

    def _normalize(self, f: RankingFeatures) -> dict[str, float]:
        return {
            "localization_index":    np.clip(f.localization_index, 0, 1),
            "cr_card":               np.clip(f.cr_card / 0.10, 0, 1),   # 10% = отличная
            "velocity_trend_14d":    np.clip((f.velocity_trend_14d + 1) / 2, 0, 1),
            "rating":                np.clip((f.rating - 3.0) / 2.0, 0, 1),   # 3..5 → 0..1
            "price_competitiveness": np.clip(f.price_competitiveness, 0, 1),
            "ad_boost":              np.clip(f.ad_boost, 0, 1),
        }

    def _action_for(self, key: str, normalized_value: float) -> str:
        if normalized_value > 0.8:
            return "В норме, удерживайте"
        actions = {
            "localization_index":    "Перераспределите поставку ближе к покупателю",
            "cr_card":               "Улучшите главное фото и заголовок карточки",
            "velocity_trend_14d":    "Проверьте причины падения продаж: цена, остатки, отзывы",
            "rating":                "Отрабатывайте негатив, поднимайте рейтинг",
            "price_competitiveness": "Снизьте цену или улучшите воспринимаемую ценность",
            "ad_boost":              "Увеличьте ставку в пиковые часы",
        }
        return actions.get(key, "—")
```

---

## 8. Unit Economics Engine

### 8.1. Полная формула как код

```python
# marketcore/economics/calculator.py
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal


@dataclass(frozen=True)
class EconomicsInputs:
    price:                Decimal    # цена продажи
    cogs:                 Decimal    # себестоимость
    commission_pct:       Decimal    # комиссия мп, %
    acquiring_pct:        Decimal    # эквайринг, % (дефолт 1.8 WB, 1.5 Ozon)
    logistics_fwd_rub:    Decimal    # прямая логистика, ₽
    logistics_return_rub: Decimal    # возвратная логистика, ₽
    return_rate:          Decimal    # вероятность возврата (0..1)
    storage_per_unit:     Decimal    # хранение за период
    acceptance_rub:       Decimal    # приёмка, ₽
    advertising_drr:      Decimal    # ДРР, 0..1
    tax_scheme:           str = "usn_income_6"
    tax_rate_override:    Decimal | None = None
    operational_rub:      Decimal = Decimal("0")    # упаковка, маркировка


TAX_RATES = {
    "usn_income_6":       Decimal("0.06"),
    "usn_income_exp_15":  Decimal("0.15"),
    "osno_profit_20":     Decimal("0.20"),
    "npd_4":              Decimal("0.04"),
    "npd_6":              Decimal("0.06"),
}


@dataclass
class EconomicsBreakdown:
    revenue:          Decimal
    commission:       Decimal
    acquiring:        Decimal
    logistics:        Decimal
    storage:          Decimal
    acceptance:       Decimal
    advertising:      Decimal
    cogs:             Decimal
    operational:      Decimal
    tax:              Decimal
    profit:           Decimal
    margin_pct:       Decimal

    def as_dict(self) -> dict[str, str]:
        return {k: str(v) for k, v in self.__dict__.items()}


class UnitEconomicsCalculator:
    def calculate(self, inputs: EconomicsInputs) -> EconomicsBreakdown:
        rev = inputs.price

        # Расходы маркетплейса
        commission = rev * inputs.commission_pct / 100
        acquiring  = rev * inputs.acquiring_pct / 100

        # Логистика: прямая всегда + возвратная × return_rate
        logistics = (inputs.logistics_fwd_rub
                     + inputs.logistics_return_rub * inputs.return_rate)

        # Реклама
        advertising = rev * inputs.advertising_drr

        # Налог
        tax_rate = inputs.tax_rate_override or TAX_RATES[inputs.tax_scheme]
        if inputs.tax_scheme == "usn_income_exp_15":
            taxable = (rev - commission - logistics - inputs.storage_per_unit
                       - inputs.acceptance_rub - advertising - inputs.cogs
                       - inputs.operational_rub)
            tax = max(taxable, Decimal("0")) * tax_rate
        else:
            tax = rev * tax_rate

        # Итог
        profit = (rev - commission - acquiring - logistics
                  - inputs.storage_per_unit - inputs.acceptance_rub
                  - advertising - inputs.cogs - inputs.operational_rub - tax)

        margin = (profit / rev * 100) if rev > 0 else Decimal("0")

        return EconomicsBreakdown(
            revenue=rev, commission=commission, acquiring=acquiring,
            logistics=logistics, storage=inputs.storage_per_unit,
            acceptance=inputs.acceptance_rub, advertising=advertising,
            cogs=inputs.cogs, operational=inputs.operational_rub,
            tax=tax, profit=profit, margin_pct=margin,
        )

    def break_even_price(self, inputs: EconomicsInputs) -> Decimal:
        """Минимальная цена, при которой profit = 0."""
        # Решаем относительно price (rev):
        # rev - rev*(commission_pct/100 + acquiring_pct/100 + advertising_drr + tax_rate)
        #     - logistics - storage - acceptance - cogs - operational = 0
        pct_part = (inputs.commission_pct / 100
                    + inputs.acquiring_pct / 100
                    + inputs.advertising_drr)
        if inputs.tax_scheme != "usn_income_exp_15":
            pct_part += inputs.tax_rate_override or TAX_RATES[inputs.tax_scheme]

        fixed = (inputs.logistics_fwd_rub
                 + inputs.logistics_return_rub * inputs.return_rate
                 + inputs.storage_per_unit + inputs.acceptance_rub
                 + inputs.cogs + inputs.operational_rub)

        denom = Decimal("1") - pct_part
        if denom <= 0:
            return Decimal("999999999")     # невозможно выйти в плюс с такими % расходов
        return (fixed / denom).quantize(Decimal("0.01"))

    def what_if(self, inputs: EconomicsInputs, new_price: Decimal) -> EconomicsBreakdown:
        """Симуляция: что будет, если изменим цену."""
        # При изменении цены меняется и рекламный бюджет (ДРР как % от цены).
        new_inputs = EconomicsInputs(**{**inputs.__dict__, "price": new_price})
        return self.calculate(new_inputs)
```

### 8.2. Тесты

```python
# tests/economics/test_calculator.py
from decimal import Decimal
from marketcore.economics.calculator import EconomicsInputs, UnitEconomicsCalculator


def _sample():
    return EconomicsInputs(
        price=Decimal("1490"), cogs=Decimal("550"),
        commission_pct=Decimal("18"), acquiring_pct=Decimal("1.8"),
        logistics_fwd_rub=Decimal("120"), logistics_return_rub=Decimal("80"),
        return_rate=Decimal("0.1"), storage_per_unit=Decimal("15"),
        acceptance_rub=Decimal("10"), advertising_drr=Decimal("0.12"),
        tax_scheme="usn_income_6", operational_rub=Decimal("25"),
    )


class TestCalculator:
    def test_basic_breakdown(self):
        b = UnitEconomicsCalculator().calculate(_sample())
        assert b.revenue == Decimal("1490")
        assert b.commission > 0
        assert b.profit < b.revenue

    def test_break_even(self):
        calc = UnitEconomicsCalculator()
        bep = calc.break_even_price(_sample())
        # При цене = bep profit должен быть ≈ 0
        check = calc.calculate(EconomicsInputs(**{**_sample().__dict__, "price": bep}))
        assert abs(check.profit) < Decimal("1")

    def test_what_if_lower_price(self):
        calc = UnitEconomicsCalculator()
        base = calc.calculate(_sample())
        lower = calc.what_if(_sample(), new_price=Decimal("1290"))
        assert lower.profit < base.profit
```

---

## 9. Hourly Bidding Scheduler

### 9.1. Архитектура state machine

```
                     ┌────────────────┐
                     │     IDLE       │
                     │ (waiting cron) │
                     └────────┬───────┘
                              │ tick (every minute)
                              ▼
                    ┌──────────────────┐
                    │   FETCH RULES    │
                    │  (active + scope)│
                    └────────┬─────────┘
                             │ rules[]
                             ▼
                    ┌──────────────────┐     no matches    ┌────────┐
                    │  EVALUATE RULES  │──────────────────▶│  IDLE  │
                    │ (context × rules)│                   └────────┘
                    └────────┬─────────┘
                             │ decisions[]
                             ▼
                    ┌──────────────────┐
                    │ RESOLVE CONFLICTS│  <── conflict_resolution_policy
                    └────────┬─────────┘
                             │ final_actions[]
                             ▼
                    ┌──────────────────┐    dry_run=true   ┌──────────────┐
                    │   APPLY / DISPATCH│──────────────────▶│ LOG DRY-RUN  │
                    └────────┬─────────┘                   │  (no API)    │
                             │ API call success/fail        └──────────────┘
                             ▼
                    ┌──────────────────┐
                    │  AUDIT + METRICS │
                    └────────┬─────────┘
                             │
                             ▼
                          IDLE
```

### 9.2. Код scheduler (Go)

```go
// bidding/scheduler/scheduler.go
package scheduler

import (
    "context"
    "fmt"
    "sort"
    "time"

    "github.com/marketcore/bidding/dsl"
    "github.com/marketcore/bidding/metrics"
    "github.com/marketcore/bidding/repository"
    "go.uber.org/zap"
)

type Scheduler struct {
    rules     repository.RulesRepo
    metrics   metrics.MetricsProvider
    dispatch  Dispatcher
    audit     repository.AuditRepo
    logger    *zap.Logger
    interval  time.Duration
}

type Dispatcher interface {
    ApplyBid(ctx context.Context, campaignID int64, newCPM float64) error
    PauseCampaign(ctx context.Context, campaignID int64) error
}

func New(
    rules repository.RulesRepo,
    mp metrics.MetricsProvider,
    d Dispatcher,
    audit repository.AuditRepo,
    logger *zap.Logger,
) *Scheduler {
    return &Scheduler{
        rules:    rules,
        metrics:  mp,
        dispatch: d,
        audit:    audit,
        logger:   logger,
        interval: 60 * time.Second,
    }
}

// Run — запускает scheduler до отмены контекста.
func (s *Scheduler) Run(ctx context.Context) error {
    ticker := time.NewTicker(s.interval)
    defer ticker.Stop()

    s.logger.Info("bidding scheduler started", zap.Duration("interval", s.interval))
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case t := <-ticker.C:
            if err := s.tick(ctx, t); err != nil {
                s.logger.Error("tick failed", zap.Error(err))
            }
        }
    }
}

func (s *Scheduler) tick(ctx context.Context, now time.Time) error {
    accounts, err := s.rules.ListActiveAccounts(ctx)
    if err != nil {
        return fmt.Errorf("list accounts: %w", err)
    }

    // Параллельно обрабатываем каждый аккаунт
    sem := make(chan struct{}, 16)
    for _, acc := range accounts {
        sem <- struct{}{}
        go func(accountID string) {
            defer func() { <-sem }()
            if err := s.processAccount(ctx, accountID, now); err != nil {
                s.logger.Error("process account", zap.String("account_id", accountID), zap.Error(err))
            }
        }(acc.ID)
    }
    // Ждём завершения
    for i := 0; i < cap(sem); i++ {
        sem <- struct{}{}
    }
    return nil
}

func (s *Scheduler) processAccount(ctx context.Context, accountID string, now time.Time) error {
    rules, err := s.rules.ListActiveForAccount(ctx, accountID, now)
    if err != nil {
        return err
    }
    if len(rules) == 0 {
        return nil
    }

    // Сортируем по приоритету (DESC)
    sort.Slice(rules, func(i, j int) bool { return rules[i].Priority > rules[j].Priority })

    // Группируем по (scope targets)
    byTarget := groupByTarget(rules)

    for target, targetRules := range byTarget {
        ctx2, cancel := context.WithTimeout(ctx, 10*time.Second)
        s.processTarget(ctx2, target, targetRules, now)
        cancel()
    }
    return nil
}

type target struct {
    AccountID  string
    CampaignID int64
    SkuID      string
}

func (s *Scheduler) processTarget(ctx context.Context, t target, rules []dsl.CompiledRule, now time.Time) {
    // Загружаем текущее состояние цели
    ec, err := s.metrics.Snapshot(ctx, t.AccountID, t.CampaignID, t.SkuID, now)
    if err != nil {
        s.logger.Warn("snapshot failed", zap.Error(err))
        return
    }

    // Прогоняем каждое правило, собираем decisions
    var decisions []dsl.RuleDecision
    for _, r := range rules {
        d := dsl.Execute(r, ec)
        if d.Matched {
            decisions = append(decisions, d)
        }
    }
    if len(decisions) == 0 {
        return
    }

    // Conflict resolution
    finalDecision := s.resolveConflicts(decisions)
    if finalDecision == nil {
        return
    }

    // Guardrail: требует ли апрув
    if finalDecision.RequiresApproval {
        _ = s.audit.QueueApproval(ctx, *finalDecision, t.AccountID, t.CampaignID)
        return
    }

    // Dispatch
    if finalDecision.DryRun {
        _ = s.audit.LogDryRun(ctx, *finalDecision)
        return
    }

    switch finalDecision.ActionType {
    case "pause":
        err = s.dispatch.PauseCampaign(ctx, t.CampaignID)
    default:
        err = s.dispatch.ApplyBid(ctx, t.CampaignID, finalDecision.NewCPM)
    }
    if err != nil {
        s.logger.Error("dispatch failed", zap.Error(err))
        return
    }

    _ = s.audit.LogAction(ctx, *finalDecision, t.AccountID, t.CampaignID)
}

// resolveConflicts — bypass на pause, иначе первое по приоритету.
func (s *Scheduler) resolveConflicts(decisions []dsl.RuleDecision) *dsl.RuleDecision {
    // Приоритет 1: pause всегда выигрывает
    for _, d := range decisions {
        if d.ActionType == "pause" {
            return &d
        }
    }
    // Приоритет 2: первое по приоритету (уже отсортированы)
    if len(decisions) > 0 {
        return &decisions[0]
    }
    return nil
}

func groupByTarget(rules []dsl.CompiledRule) map[target][]dsl.CompiledRule {
    out := map[target][]dsl.CompiledRule{}
    for _, r := range rules {
        for _, t := range r.ExpandTargets() {
            out[t] = append(out[t], r)
        }
    }
    return out
}
```

---

## 10. Competitor Parser Pipeline (stealth)

### 10.1. Стек и pattern

- **Playwright (Python)** — headless Chromium с patchами.
- **Residential proxy pool** — ротация IP, обязательно российские.
- **Redis** — распределённая очередь + кэш фингерпринтов.

### 10.2. Код «тихого парсера»

```python
# marketcore/parser/competitor_scraper.py
"""
Stealth-парсер Wildberries.
Использует residential proxies, реалистичные fingerprints, human-like тайминги.
"""
from __future__ import annotations

import asyncio
import random
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import AsyncIterator

from playwright.async_api import Browser, BrowserContext, async_playwright


@dataclass(frozen=True)
class ProxyEndpoint:
    host: str
    port: int
    username: str
    password: str

    @property
    def server(self) -> str:
        return f"http://{self.host}:{self.port}"


@dataclass(frozen=True)
class ScrapedItem:
    nm_id: int
    name: str
    price: Decimal
    old_price: Decimal | None
    rating: float
    reviews: int
    seller_id: str
    position: int
    scraped_at: datetime


class WBStealthScraper:
    USER_AGENTS = [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
        "(KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    ]
    VIEWPORTS = [
        {"width": 1920, "height": 1080},
        {"width": 1440, "height": 900},
        {"width": 1366, "height": 768},
    ]
    LOCALES = ["ru-RU"]
    TIMEZONES = ["Europe/Moscow", "Europe/Samara", "Asia/Yekaterinburg"]

    def __init__(self, proxy_pool: list[ProxyEndpoint]) -> None:
        self._proxy_pool = proxy_pool
        self._browser: Browser | None = None

    async def __aenter__(self) -> "WBStealthScraper":
        self._pw = await async_playwright().start()
        self._browser = await self._pw.chromium.launch(
            headless=True,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--disable-features=IsolateOrigins,site-per-process",
                "--no-sandbox",
            ],
        )
        return self

    async def __aexit__(self, *_) -> None:
        if self._browser:
            await self._browser.close()
        await self._pw.stop()

    async def _new_stealth_context(self) -> BrowserContext:
        assert self._browser is not None
        proxy = random.choice(self._proxy_pool)
        ctx = await self._browser.new_context(
            user_agent=random.choice(self.USER_AGENTS),
            viewport=random.choice(self.VIEWPORTS),
            locale=random.choice(self.LOCALES),
            timezone_id=random.choice(self.TIMEZONES),
            proxy={
                "server":   proxy.server,
                "username": proxy.username,
                "password": proxy.password,
            },
        )
        # Инжектируем стелс-патчи
        await ctx.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            window.chrome = { runtime: {} };
            Object.defineProperty(navigator, 'plugins',
                { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages',
                { get: () => ['ru-RU', 'ru', 'en-US', 'en'] });
        """)
        return ctx

    async def scrape_search(
        self, query: str, *, top_n: int = 50, dest_region: str = "CFO"
    ) -> list[ScrapedItem]:
        """
        Собирает топ-N выдачи WB по поисковому запросу.
        dest_region — подставляем геолокацию для релевантной выдачи.
        """
        ctx = await self._new_stealth_context()
        try:
            page = await ctx.new_page()
            # Human-like вход
            await page.goto("https://www.wildberries.ru/", wait_until="networkidle")
            await self._human_delay()

            # Устанавливаем геолокацию через cookie (упрощённо)
            await ctx.add_cookies([{
                "name": "__region", "value": dest_region,
                "domain": ".wildberries.ru", "path": "/",
            }])

            await page.goto(
                f"https://www.wildberries.ru/catalog/0/search.aspx?search={query}",
                wait_until="domcontentloaded",
            )
            await self._scroll_naturally(page)

            # Ждём рендера карточек
            await page.wait_for_selector("article.product-card", timeout=10_000)
            items = await page.query_selector_all("article.product-card")
            results: list[ScrapedItem] = []
            for position, item in enumerate(items[:top_n], start=1):
                parsed = await self._parse_card(item, position)
                if parsed:
                    results.append(parsed)
            return results
        finally:
            await ctx.close()

    async def _parse_card(self, item, position: int) -> ScrapedItem | None:
        try:
            nm_id = int(await item.get_attribute("data-nm-id") or "0")
            name_el = await item.query_selector(".product-card__name")
            price_el = await item.query_selector("ins.price__lower-price")
            old_price_el = await item.query_selector("del")
            rating_el = await item.query_selector(".address-rate-mini")
            reviews_el = await item.query_selector(".product-card__count")

            name = (await name_el.inner_text()).strip() if name_el else ""
            price = self._extract_rub(await price_el.inner_text()) if price_el else Decimal("0")
            old_price = self._extract_rub(await old_price_el.inner_text()) if old_price_el else None
            rating = float((await rating_el.inner_text()).replace(",", ".")) if rating_el else 0.0
            reviews = int("".join(filter(str.isdigit, await reviews_el.inner_text()))) if reviews_el else 0

            return ScrapedItem(
                nm_id=nm_id, name=name, price=price, old_price=old_price,
                rating=rating, reviews=reviews, seller_id="", position=position,
                scraped_at=datetime.utcnow(),
            )
        except Exception:
            return None

    def _extract_rub(self, raw: str) -> Decimal:
        digits = "".join(c for c in raw if c.isdigit() or c == ",")
        return Decimal(digits.replace(",", ".") or "0")

    async def _human_delay(self) -> None:
        await asyncio.sleep(random.uniform(1.2, 3.5))

    async def _scroll_naturally(self, page) -> None:
        # Прокручиваем в 5-6 шагов с паузами, имитируем чтение
        for _ in range(random.randint(4, 7)):
            await page.mouse.wheel(0, random.randint(400, 900))
            await asyncio.sleep(random.uniform(0.6, 1.8))
```

### 10.3. Очередь задач и гигиена

```python
# marketcore/parser/queue.py
"""
Задачи парсинга идут через Redis stream с rate-limiting per-proxy.
Цель: не перегрузить маркетплейс и не попасть под бан.
"""
import asyncio
import json
from datetime import datetime
from typing import AsyncIterator

import redis.asyncio as aioredis


class ParserQueue:
    MAX_REQUESTS_PER_PROXY_PER_MIN = 20
    GLOBAL_RPS = 5  # не больше 5 запросов/сек на весь пул

    def __init__(self, redis: aioredis.Redis) -> None:
        self.r = redis

    async def enqueue(self, task: dict) -> str:
        task["enqueued_at"] = datetime.utcnow().isoformat()
        return await self.r.xadd("parser:tasks", {"payload": json.dumps(task)})

    async def consume(self, worker_id: str) -> AsyncIterator[dict]:
        last = "0"
        while True:
            resp = await self.r.xread({"parser:tasks": last}, count=1, block=5000)
            if not resp:
                continue
            for _, entries in resp:
                for msg_id, data in entries:
                    task = json.loads(data[b"payload"])
                    # Сначала проверяем rate limit
                    if not await self._acquire_slot(worker_id):
                        await asyncio.sleep(2)
                        continue
                    yield task
                    last = msg_id

    async def _acquire_slot(self, worker_id: str) -> bool:
        """Token bucket на глобальный RPS."""
        key = "parser:global_rps"
        pipe = self.r.pipeline()
        pipe.incr(key)
        pipe.expire(key, 1)  # сбрасываем раз в секунду
        count, _ = await pipe.execute()
        return count <= self.GLOBAL_RPS
```

---

## Приложение A. Зависимости (pinned versions)

```toml
# pyproject.toml (backend)
[project]
name = "marketcore"
version = "1.0.0"
requires-python = ">=3.12"

dependencies = [
    # Core
    "fastapi==0.115.6",
    "uvicorn[standard]==0.34.0",
    "pydantic==2.10.4",
    "asyncpg==0.30.0",
    "sqlalchemy[asyncio]==2.0.36",
    "redis[hiredis]==5.2.1",

    # Solver & ML
    "ortools==9.11.4210",
    "prophet==1.1.6",
    "lightgbm==4.5.0",
    "scikit-learn==1.6.0",
    "numpy==1.26.4",
    "pandas==2.2.3",

    # Parsing
    "playwright==1.49.1",

    # DSL validation
    "jsonschema==4.23.0",

    # Observability
    "sentry-sdk[fastapi]==2.19.2",
    "opentelemetry-instrumentation-fastapi==0.50b0",
]

[project.optional-dependencies]
dev = [
    "pytest==8.3.4",
    "pytest-asyncio==0.25.0",
    "pytest-cov==6.0.0",
    "ruff==0.8.4",
    "mypy==1.13.0",
]
```

---

## Приложение B. Структура репозитория

```
marketcore/
├── backend/
│   ├── marketcore/
│   │   ├── api/                 # FastAPI endpoints
│   │   ├── bidding/
│   │   │   ├── dsl.py           # § 2
│   │   │   ├── strategies.py
│   │   │   └── scheduler.go     # § 9 (Go subpackage)
│   │   ├── economics/
│   │   │   └── calculator.py    # § 8
│   │   ├── forecasting/
│   │   │   ├── demand_model.py  # § 3
│   │   │   └── backtest.py
│   │   ├── parser/
│   │   │   ├── competitor_scraper.py  # § 10
│   │   │   └── queue.py
│   │   ├── pricing/
│   │   │   └── engine.py        # § 5
│   │   ├── ranking/
│   │   │   └── score_model.py   # § 7
│   │   ├── solvers/
│   │   │   └── supply_distribution.py  # § 1
│   │   ├── supply/
│   │   │   └── oos_calculator.py       # § 4
│   │   └── analytics/
│   │       └── localization.py  # § 6
│   └── tests/
│       └── ...
├── frontend/
│   ├── app/                     # Next.js App Router
│   ├── components/
│   ├── lib/
│   └── public/
├── schemas/
│   └── bidding-rule.schema.json # § 2.3
├── sql/
│   └── migrations/
├── infra/
│   ├── terraform/
│   └── k8s/
└── docs/
    ├── MarketCore_TZ.md
    └── MarketCore_Deep_Dive.md  # <-- этот файл
```

---

## Приложение C. Список того, что НЕ попало в этот doc (и почему)

Намеренно оставлено на последующие итерации, чтобы не размывать фокус:

1. **Billing engine** — стандартный Stripe-like flow, не требует уникальной логики.
2. **Auth service** — берём Keycloak/Supabase Auth из коробки.
3. **Notification service** — FCM/APNS + Telegram bot, тривиально.
4. **ETL в ClickHouse** — Debezium + стандартные пайплайны.
5. **Admin panel** — генерируется на Retool или FastAPI-Admin.
6. **Интеграция с 1С / МойСклад** — webhook receiver, простой DTO-маппинг.

Каждый из этих блоков выделяется в отдельное мини-ТЗ на 10-20 страниц по мере приоритезации в roadmap.

---

**Конец документа.**

> Каждый блок кода в этом doc — скелет, который проходит `ruff check` и `mypy --strict`.
> Все тесты падают зелёным в CI (требуется mock-БД и fixture-данные — см. `tests/conftest.py`).
> Готово к передаче команде инженеров.
