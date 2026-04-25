from datetime import datetime, timezone

import httpx

WB_STAT_BASE = "https://statistics-api.wildberries.ru"
WB_PRICES_BASE = "https://discounts-prices-api.wb.ru"
WB_ADV_BASE = "https://advert-api.wildberries.ru"
WB_CONTENT_BASE = "https://content-suppliers.wildberries.ru"

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

        GET /adv/v1/promotion/count → возвращает ID кампаний сгруппированные по типу/статусу.
        WB убрал endpoint для получения деталей, поэтому показываем ID как имя кампании.
        """
        if statuses is None:
            statuses = [9, 11]  # 9=активна, 11=на паузе

        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.get(
                f"{WB_ADV_BASE}/adv/v1/promotion/count",
                headers=self._headers,
            )
            resp.raise_for_status()
            count_data = resp.json()

        all_adverts = count_data.get("adverts") or []

        # Ответ: {"adverts": [{"type":8,"status":9,"count":3,"advert_list":[{"advertId":123,"changeTime":"..."},...]},...]}
        TYPE_LABELS = {4: "Каталог", 5: "Карточка", 6: "Поиск", 7: "Рекомендации", 8: "Авто", 9: "Поиск+Каталог"}
        STATUS_LABELS = {9: "▶ Активна", 11: "⏸ Пауза"}

        result = []
        for group in all_adverts:
            if not isinstance(group, dict):
                continue
            grp_status = group.get("status")
            if grp_status not in statuses:
                continue
            grp_type = group.get("type")
            type_label = TYPE_LABELS.get(grp_type, f"Тип {grp_type}")
            status_label = STATUS_LABELS.get(grp_status, "")

            for item in (group.get("advert_list") or []):
                if isinstance(item, dict):
                    aid = item.get("advertId")
                else:
                    aid = item
                if not aid:
                    continue
                result.append({
                    "advert_id": int(aid),
                    "name": f"{type_label} #{aid} {status_label}",
                    "type": grp_type,
                    "status": grp_status,
                    "cpm": 0,
                    "subject_id": None,
                    "menu_id": None,
                })

        return result[:50]

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

    async def set_campaign_hours(self, advert_id: int, hours: list[int]) -> None:
        """Установить расписание показов кампании.

        hours: список из 24 чисел (0-100) — коэффициент показа для каждого часа.
        0 = реклама выключена в этот час, 100 = полная ставка.
        WB API: POST /adv/v1/schedule/hours
        """
        assert len(hours) == 24, "hours должен содержать ровно 24 элемента"
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"{WB_ADV_BASE}/adv/v1/schedule/hours",
                headers=self._headers,
                json={"advertId": advert_id, "hours": hours},
            )
            resp.raise_for_status()

    async def get_nm_titles(self, nm_ids: list[int]) -> dict[int, str]:
        """Названия товаров nmId → title через WB Content API v2.
        Если ключ не имеет прав на Контент — возвращает пустой словарь.
        """
        if not nm_ids:
            return {}
        nm_id_set = set(nm_ids)
        result: dict[int, str] = {}
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                resp = await client.post(
                    f"{WB_CONTENT_BASE}/content/v2/get/cards/list",
                    headers=self._headers,
                    json={"settings": {"cursor": {"limit": 100}, "filter": {"withPhoto": -1}}},
                )
                if resp.status_code != 200:
                    return {}
                data = resp.json()
            for card in (data.get("data", {}).get("cards") or []):
                nid = card.get("nmID")
                if nid and int(nid) in nm_id_set:
                    title = card.get("title") or card.get("subjectName") or ""
                    if title:
                        result[int(nid)] = title
        except Exception:
            pass
        return result

    async def pause_campaign(self, advert_id: int) -> None:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"{WB_ADV_BASE}/adv/v0/pause",
                headers=self._headers,
                params={"id": advert_id},
            )
            resp.raise_for_status()

    async def resume_campaign(self, advert_id: int) -> None:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"{WB_ADV_BASE}/adv/v0/start",
                headers=self._headers,
                params={"id": advert_id},
            )
            resp.raise_for_status()

    async def rename_campaign(self, advert_id: int, name: str) -> None:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"{WB_ADV_BASE}/adv/v0/rename",
                headers=self._headers,
                json={"advertId": advert_id, "name": name},
            )
            resp.raise_for_status()

    async def set_campaign_budget(self, advert_id: int, amount: int) -> None:
        """Пополнить бюджет кампании на amount рублей."""
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"{WB_ADV_BASE}/adv/v0/budget",
                headers=self._headers,
                json={"id": advert_id, "sum": amount, "type": "add"},
            )
            resp.raise_for_status()

    async def create_auto_campaign(self, nm_ids: list[int], budget: int, name: str) -> int:
        """Создать автоматическую кампанию (тип 8). Возвращает advertId."""
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(
                f"{WB_ADV_BASE}/adv/v1/promotion/auto/save",
                headers=self._headers,
                json={"nms": nm_ids, "budget": {"sum": budget}, "name": name},
            )
            resp.raise_for_status()
            data = resp.json()
            # WB возвращает {"advertId": 123} или просто число
            if isinstance(data, dict):
                return int(data.get("advertId") or data.get("id") or 0)
            return int(data)

    async def get_ad_stats(self, date_from: str, date_to: str) -> list[dict]:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.get(
                f"{WB_ADV_BASE}/adv/v2/fullstats",
                headers=self._headers,
                params={"dateFrom": date_from, "dateTo": date_to},
            )
            resp.raise_for_status()
            return resp.json() or []
