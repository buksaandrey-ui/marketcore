"""
TwoPeaksStrategy — главный оркестратор стратегии «2 пика».

Шаги выполнения:
1. Загрузить конфиг кампании из БД.
2. Получить актуальный cpm_min рынка от WB API.
3. Определить тип текущего дня (RuHolidayCalendar).
4. Загрузить/построить профиль (история или дефолтный).
5. Построить WeeklySchedule.
6. Для текущего часа → resolve_bid + apply_safeguards.
7. Применить ставку через WB Advert API (если не dry_run).
8. Записать в bid_change_log.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from marketcore.models import CampaignStrategy, BidChangeLog as BidChangeLogModel
from marketcore.strategy.calendar.ru_holidays import calendar as ru_calendar
from marketcore.strategy.models import (
    BidChangeLog, CampaignStrategyConfig, DemandLevel, DayType,
    RuntimeContext, WeeklySchedule,
)
from marketcore.strategy.two_peaks.bid_calculator import apply_safeguards, resolve_bid
from marketcore.strategy.two_peaks.default_profiles import get_default_profile
from marketcore.strategy.two_peaks.profile_builder import build_profile_from_history
from marketcore.strategy.two_peaks.schedule_builder import build_weekly_schedule

logger = logging.getLogger(__name__)


class TwoPeaksStrategy:
    """Применяет стратегию «2 пика» к одной кампании."""

    def __init__(
        self,
        config: CampaignStrategyConfig,
        wb_client,          # WBClient instance
        db: AsyncSession,
    ) -> None:
        self.config = config
        self.wb_client = wb_client
        self.db = db

    async def execute(self) -> BidChangeLog:
        """
        Главный метод. Вызывается планировщиком каждый час.
        Возвращает BidChangeLog с результатом (applied=True/False).
        """
        config = self.config
        now = datetime.now(timezone.utc)
        hour = now.hour
        day_type: DayType = ru_calendar.classify(now.date())

        logger.info(
            "[TwoPeaks] campaign=%s day_type=%s hour=%d",
            config.campaign_id, day_type.value, hour
        )

        # 1. Актуальный cpm_min рынка
        try:
            cpm_min = await self.wb_client.get_market_cpm(advert_type=8, param=0)
        except Exception as e:
            logger.warning("[TwoPeaks] cpm_min fetch failed: %s — используем config", e)
            cpm_min = config.cpm_min

        # 2. Текущий контекст кампании (ставка, бюджет, остаток, ДРР)
        ctx = await self._build_context(cpm_min)

        # 3. Профиль спроса
        category_profile = None
        if config.use_history:
            try:
                category_profile = await build_profile_from_history(
                    db=self.db,
                    account_id=config.account_id,
                    campaign_ids=[str(config.campaign_id)],
                    category=config.category,
                    days=28,
                    min_days=config.history_min_days,
                )
            except Exception as e:
                logger.warning("[TwoPeaks] profile_builder error: %s", e)

        if category_profile is None:
            category_profile = get_default_profile(config.category)
            logger.debug("[TwoPeaks] используем дефолтный профиль: %s", config.category)

        # 4. Расписание на неделю
        weekly: WeeklySchedule = build_weekly_schedule(category_profile)

        # 5. Уровень спроса для текущего часа
        demand: DemandLevel = weekly.get(day_type, hour)

        # 6. Расчёт целевой ставки + защитные ограничения
        target_cpm = resolve_bid(demand, cpm_min, config.cpm_cap)
        final_cpm, skip_reason = apply_safeguards(ctx, config, target_cpm, demand)

        # 7. Применить ставку (если не dry_run и нет причины пропустить)
        applied = False
        if not config.dry_run and skip_reason is None:
            try:
                await self.wb_client.set_campaign_cpm(config.campaign_id, final_cpm)
                applied = True
                logger.info(
                    "[TwoPeaks] applied cpm=%d for campaign=%s",
                    final_cpm, config.campaign_id
                )
            except Exception as e:
                skip_reason = f"api_error: {e}"
                logger.error("[TwoPeaks] set_cpm failed: %s", e)
        elif config.dry_run:
            skip_reason = skip_reason or "dry_run"
            logger.info(
                "[TwoPeaks] dry_run: would set cpm=%d for campaign=%s (%s demand)",
                final_cpm, config.campaign_id, demand.value
            )

        # 8. Записать в БД
        log_entry = BidChangeLog(
            campaign_id=config.campaign_id,
            account_id=config.account_id,
            computed_at=now,
            day_type=day_type,
            hour=hour,
            demand_level=demand,
            bid_type=None,  # заполнится при записи
            cpm_min=cpm_min,
            cpm_target=final_cpm,
            cpm_prev=ctx.cpm_current,
            applied=applied,
            dry_run=config.dry_run,
            skip_reason=skip_reason,
        )
        await self._save_log(log_entry)

        return log_entry

    async def _build_context(self, cpm_min: int) -> RuntimeContext:
        """Собирает RuntimeContext из WB API + БД."""
        try:
            campaigns = await self.wb_client.list_campaigns()
            camp_data = next(
                (c for c in campaigns if c.get("advert_id") == self.config.campaign_id),
                {}
            )
            cpm_current = camp_data.get("cpm", cpm_min)
            status = camp_data.get("status", 9)
        except Exception:
            cpm_current = cpm_min
            status = 9

        # Бюджет и ДРР — упрощённо (будут расширены позже)
        # TODO: подтягивать budget_spent из WB API /adv/v1/budget
        return RuntimeContext(
            now_utc=datetime.now(timezone.utc),
            cpm_min=cpm_min,
            cpm_current=cpm_current,
            budget_total=self.config.cpm_cap * 100.0,  # заглушка
            budget_spent=0.0,
            campaign_status=status,
            stock_qty=9999,  # TODO: брать из sku_stocks
            drr_last7=0.0,   # TODO: брать из ad_stats
        )

    async def _save_log(self, log: BidChangeLog) -> None:
        """Сохраняет запись в bid_change_log."""
        from marketcore.strategy.models import DEMAND_TO_BID
        try:
            record = BidChangeLogModel(
                id=uuid.uuid4(),
                account_id=uuid.UUID(log.account_id),
                campaign_id=log.campaign_id,
                computed_at=log.computed_at,
                day_type=log.day_type.value,
                hour=log.hour,
                demand_level=log.demand_level.value,
                bid_type=DEMAND_TO_BID[log.demand_level].value,
                cpm_min=log.cpm_min,
                cpm_target=log.cpm_target,
                cpm_prev=log.cpm_prev,
                applied=log.applied,
                dry_run=log.dry_run,
                skip_reason=log.skip_reason or "",
            )
            self.db.add(record)
            await self.db.commit()
        except Exception as e:
            logger.error("[TwoPeaks] failed to save log: %s", e)
