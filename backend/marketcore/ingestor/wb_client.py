from datetime import datetime, timezone

import httpx

WB_STAT_BASE = "https://statistics-api.wildberries.ru"
WB_PRICES_BASE = "https://discounts-prices-api.wb.ru"
WB_ADV_BASE = "https://advert-api.wildberries.ru"

# Соответствие названий категорий → ID предметов WB (subject_id)
# Нужно для запроса минимальной ставки CPM в аукционе WB
WB_SUBJECT_IDS: dict[str, int] = {
    "Одежда": 50,
    "Обувь": 18,
    "Электроника": 515,
    "Красота": 73,
    "Дом и сад": 306,
    "Детские товары": 172,
    "Спорт": 228,
    "Продукты": 3869,
}

# Тип рекламного места WB → числовой код
# 5 = Поиск, 6 = Каталог, 9 = Карточка товара, 32 = Главная
WB_PLACEMENT_TYPES: dict[str, int] = {
    "Поиск": 5,
    "Каталог": 6,
    "Карточка товара": 9,
    "Главная": 32,
    "Рекомендации": 9,
}


class WBClient:
    def __init__(self, api_key: str) -> None:
        self._headers = {"Authorization": api_key}

    async def get_orders(self, date_from: datetime) -> list[dict]:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                f"{WB_STAT_BASE}/api/v1/supplier/orders",
                headers=self._headers,
                params={"dateFrom": date_from.strftime("%Y-%m-%dT%H:%M:%S"), "flag": 0},
            )
            resp.raise_for_status()
            return resp.json() or []

    async def get_stocks(self, date_from: datetime) -> list[dict]:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                f"{WB_STAT_BASE}/api/v1/supplier/stocks",
                headers=self._headers,
                params={"dateFrom": date_from.strftime("%Y-%m-%dT%H:%M:%S")},
            )
            resp.raise_for_status()
            return resp.json() or []

    async def get_prices(self) -> list[dict]:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                f"{WB_PRICES_BASE}/api/v2/list/goods/filter",
                headers=self._headers,
                params={"limit": 1000, "offset": 0, "filterNmIds": 0},
            )
            resp.raise_for_status()
            data = resp.json()
            return data.get("data", {}).get("listGoods", []) if data else []

    async def get_cpm_benchmark(
        self,
        category: str = "Электроника",
        placement: str = "Поиск",
    ) -> dict[str, int]:
        """
        Получаем минимальную ставку CPM с WB для заданной категории и места показа.
        WB возвращает {'cpm': N} — минимум для входа в аукцион.
        Остальные ориентиры рассчитываем как рыночные мультипликаторы от минимума.
        """
        subject_id = WB_SUBJECT_IDS.get(category, 515)
        placement_type = WB_PLACEMENT_TYPES.get(placement, 5)
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"{WB_ADV_BASE}/adv/v0/cpm",
                headers=self._headers,
                params={"type": placement_type, "param": subject_id},
            )
            resp.raise_for_status()
            data = resp.json()
        min_cpm = int(data.get("cpm", 50))
        # Мультипликаторы основаны на рыночной аналитике WB:
        # конкурент ≈ 3.5×min, ТОП-10 ≈ 5.5×min, агрессивная ≈ 9×min
        return {
            "min": min_cpm,
            "competitor": round(min_cpm * 3.5),
            "top": round(min_cpm * 5.5),
            "aggressive": round(min_cpm * 9.0),
        }

    async def get_cpc_benchmark(
        self,
        category: str = "Электроника",
        placement: str = "Каталог",
    ) -> dict[str, int]:
        """
        CPC-ставки WB: получаем минимум через тот же endpoint с placement_type=6 (Каталог).
        CPC на WB обычно в 8–12 раз меньше CPM-значений.
        """
        subject_id = WB_SUBJECT_IDS.get(category, 515)
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"{WB_ADV_BASE}/adv/v0/cpm",
                headers=self._headers,
                params={"type": 6, "param": subject_id},
            )
            resp.raise_for_status()
            data = resp.json()
        # WB отдаёт CPM; для CPC делим на среднее число кликов на 1000 показов (~8)
        raw_cpm = int(data.get("cpm", 400))
        min_cpc = max(5, round(raw_cpm / 8))
        return {
            "min": min_cpc,
            "competitor": round(min_cpc * 3.5),
            "top": round(min_cpc * 5.5),
            "aggressive": round(min_cpc * 9.0),
        }

    # ─── Advert / Campaign management ─────────────────────────────────────────

    async def list_campaigns(self, statuses: list[int] | None = None) -> list[dict]:
        """Список рекламных кампаний (активные + приостановленные).

        Использует актуальный WB API v2 (старый /adv/v1/promotion/adverts удалён WB):
          Шаг 1: GET /adv/v1/promotion/count   → все ID кампаний продавца
          Шаг 2: GET /api/advert/v2/adverts    → детали по нужным ID
        """
        import logging as _log
        _logger = _log.getLogger(__name__)

        if statuses is None:
            statuses = [9, 11]  # 9=активна, 11=на паузе

        # ── Шаг 1: получаем все ID кампаний ─────────────────────────────────
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp1 = await client.get(
                f"{WB_ADV_BASE}/adv/v1/promotion/count",
                headers=self._headers,
            )
            _logger.info("[wb_campaigns] count http=%d body=%.300s", resp1.status_code, resp1.text)
            resp1.raise_for_status()
            count_data = resp1.json()

        all_adverts = count_data.get("adverts") or []
        advert_ids = [
            a["advertId"] for a in all_adverts
            if isinstance(a, dict) and a.get("status") in statuses and a.get("advertId")
        ]

        if not advert_ids:
            return []

        advert_ids = advert_ids[:50]  # API принимает максимум 50

        # ── Шаг 2: получаем детали кампаний ──────────────────────────────────
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp2 = await client.get(
                f"{WB_ADV_BASE}/api/advert/v2/adverts",
                headers=self._headers,
                params={
                    "ids": ",".join(str(i) for i in advert_ids),
                    "statuses": ",".join(str(s) for s in statuses),
                },
            )
            _logger.info("[wb_campaigns] details http=%d body=%.300s", resp2.status_code, resp2.text)
            resp2.raise_for_status()
            detail_data = resp2.json()

        result = []
        for item in (detail_data.get("adverts") or []):
            if not isinstance(item, dict):
                continue
            # Пробуем достать subject_id из разных мест в зависимости от типа кампании
            params_list = item.get("params") or item.get("unitedParams") or []
            subject_id = None
            if isinstance(params_list, list) and params_list:
                first = params_list[0] if isinstance(params_list[0], dict) else {}
                subj = first.get("subject") or {}
                subject_id = subj.get("id") if isinstance(subj, dict) else None

            result.append({
                "advert_id": item.get("advertId"),
                "name": item.get("name", f"Кампания {item.get('advertId')}"),
                "type": item.get("type"),       # 8=авто/единая, 9=поиск+каталог
                "status": item.get("status"),   # 9=активна, 11=на паузе
                "cpm": item.get("cpm", 0),
                "subject_id": subject_id,
                "menu_id": None,
            })
        return result

    async def set_campaign_cpm(
        self,
        advert_id: int,
        nm_ids: list[int],
        cpm: int,
        placement: str = "combined",
    ) -> None:
        """Установить ставку CPM для артикулов в кампании (новый WB API v1).

        advert_id:  ID кампании
        nm_ids:     список артикулов WB в этой кампании (nm)
        cpm:        ставка в рублях (WB принимает в рублях, не в копейках)
        placement:  "combined" для Единой кампании (поиск+рекомендации),
                    "search" или "recommendations" для ручной ставки
        WB API: PATCH /api/advert/v1/bids
        """
        bids = [
            {"advert_id": advert_id, "nm_id": nm, "bid": cpm, "placement": placement}
            for nm in nm_ids
        ]
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.patch(
                f"{WB_ADV_BASE}/api/advert/v1/bids",
                headers=self._headers,
                json={"bids": bids},
            )
            resp.raise_for_status()

    async def get_ad_stats(self, date_from: str, date_to: str) -> list[dict]:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.get(
                f"{WB_ADV_BASE}/adv/v2/fullstats",
                headers=self._headers,
                params={"dateFrom": date_from, "dateTo": date_to},
            )
            resp.raise_for_status()
            return resp.json() or []
