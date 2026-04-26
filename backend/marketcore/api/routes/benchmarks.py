"""
Маршрут /benchmarks — возвращает рыночные ориентиры ставок (мин/конкурент/ТОП/агрессивная).

Источники данных (в порядке приоритета):
1. Реальный средний CPM из таблицы ad_stats аккаунта (если есть данные за 30 дней)
2. Hardcoded fallback-значения с пометкой is_real=False
"""
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from marketcore.accounts.encryption import decrypt_api_key
from marketcore.auth.dependencies import get_current_user
from marketcore.database import get_db
from marketcore.ingestor.ozon_client import OzonClient
from marketcore.ingestor.wb_client import WBClient
from marketcore.models import Account, AdStat, User

router = APIRouter(prefix="/benchmarks", tags=["benchmarks"])


class BenchmarkResponse(BaseModel):
    min: int
    competitor: int
    top: int
    aggressive: int
    is_real: bool          # True = реальные данные с площадки, False = заглушка
    source: str            # описание источника для фронта


class BenchmarkPreviewRequest(BaseModel):
    """
    Получить ставки без сохранённого аккаунта — передаём ключ напрямую.
    Удобно для быстрого теста и первой настройки.
    """
    platform: str  # "wb" | "ozon"
    pay_model: str = "cpm"  # "cpm" | "cpc"
    api_key: str
    seller_id: str = ""  # только для Ozon (Client-Id)
    category: str = "Электроника"
    placement: str = "Поиск"


@router.post("/preview", response_model=BenchmarkResponse)
async def get_benchmarks_preview(
    body: BenchmarkPreviewRequest,
    current_user: User = Depends(get_current_user),
) -> BenchmarkResponse:
    """
    Быстрая проверка ставок без предварительного сохранения аккаунта.
    API-ключ передаётся в теле запроса напрямую.
    Используется для тестирования ключей перед полным подключением.
    """
    fallback = FALLBACK.get(body.platform, FALLBACK["wb"]).get(body.pay_model, FALLBACK["wb"]["cpm"])
    try:
        if body.platform == "wb":
            client = WBClient(body.api_key)
            if body.pay_model == "cpm":
                data = await client.get_cpm_benchmark(body.category, body.placement)
            else:
                data = await client.get_cpc_benchmark(body.category, body.placement)
        else:
            client = OzonClient(client_id=body.seller_id, api_key=body.api_key)
            if body.pay_model == "cpm":
                data = await client.get_cpm_benchmark(body.category, body.placement)
            else:
                data = await client.get_cpc_benchmark(body.category, body.placement)
        return BenchmarkResponse(
            **data,
            is_real=True,
            source=f"Реальные данные {body.platform.upper()} · {body.category} · {body.placement}",
        )
    except Exception as exc:
        return BenchmarkResponse(
            **fallback,
            is_real=False,
            source=f"Ошибка ({exc.__class__.__name__}: {exc}) — показаны ориентировочные значения",
        )

# Резервные значения — используются если площадка недоступна
FALLBACK: dict[str, dict[str, dict[str, int]]] = {
    "wb": {
        "cpm": {"min": 50, "competitor": 180, "top": 250, "aggressive": 400},
        "cpc": {"min": 5, "competitor": 25, "top": 40, "aggressive": 80},
    },
    "ozon": {
        "cpm": {"min": 60, "competitor": 200, "top": 280, "aggressive": 450},
        "cpc": {"min": 6, "competitor": 28, "top": 45, "aggressive": 90},
    },
}


@router.get("", response_model=BenchmarkResponse)
async def get_benchmarks(
    account_id: uuid.UUID = Query(..., description="ID кабинета из списка аккаунтов"),
    platform: Literal["wb", "ozon"] = Query("wb"),
    pay_model: Literal["cpm", "cpc"] = Query("cpm"),
    category: str = Query("Электроника"),
    placement: str = Query("Поиск"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> BenchmarkResponse:
    # Проверяем, что кабинет принадлежит текущему пользователю
    acc = (
        await db.execute(
            select(Account).where(
                Account.id == account_id,
                Account.user_id == current_user.id,
            )
        )
    ).scalar_one_or_none()

    fallback = FALLBACK[platform][pay_model]

    if acc is None:
        return BenchmarkResponse(
            **fallback,
            is_real=False,
            source="Кабинет не найден — показаны ориентировочные значения",
        )

    # Для WB ставки — используем рекламный ключ (если задан), иначе основной
    if platform == "wb" and acc.advert_api_key_cipher:
        api_key = decrypt_api_key(acc.advert_api_key_cipher)
    else:
        api_key = decrypt_api_key(acc.api_key_cipher)

    # Сначала пробуем посчитать из реальной рекламной статистики аккаунта
    since = datetime.now(timezone.utc) - timedelta(days=30)
    avg_q = await db.execute(
        select(func.avg(AdStat.cpm))
        .where(AdStat.account_id == account_id)
        .where(AdStat.cpm > 0)
        .where(AdStat.stat_date >= since)
    )
    avg_cpm = float(avg_q.scalar() or 0)

    if avg_cpm >= 10:
        data = {
            "min": max(5, round(avg_cpm * 0.28)),
            "competitor": round(avg_cpm),
            "top": round(avg_cpm * 1.5),
            "aggressive": round(avg_cpm * 2.4),
        }
        return BenchmarkResponse(
            **data,
            is_real=True,
            source=f"На основе вашей статистики за 30 дней (средний CPM {avg_cpm:.0f}₽)",
        )

    # Fallback — hardcoded ориентиры
    return BenchmarkResponse(
        **fallback,
        is_real=False,
        source="Нет рекламной статистики — нажмите «Синхронизировать» в Аккаунтах",
    )
