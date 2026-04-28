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

    async def get_market_cpm(self, advert_type: int = 8, param: int = 0) -> dict[str, int]:
        """Получить рыночные ориентиры CPM напрямую по числовому типу/параметру.

        advert_type: 5=поиск, 6=каталог, 8=авто, 9=поиск+каталог
        param: subject_id для поиска/каталога, 0 для авто

        Возвращает {"min": N, "competitor": N, "top": N}
        """
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"{WB_ADV_BASE}/adv/v0/cpm",
                headers=self._headers,
                params={"type": advert_type, "param": param},
            )
            resp.raise_for_status()
            data = resp.json()
        min_cpm = int(data.get("cpm", 50))
        return {
            "min": min_cpm,
            "competitor": round(min_cpm * 3.5),
            "top": round(min_cpm * 5.5),
        }

    # ─── Advert / Campaign management ─────────────────────────────────────────

    async def list_campaigns(self, statuses: list[int] | None = None) -> list[dict]:
        """Список рекламных кампаний (активные + приостановленные).

        GET /adv/v1/promotion/count → возвращает ID кампаний сгруппированные по типу/статусу.
        WB убрал endpoint для получения деталей, поэтому показываем ID как имя кампании.
        """
        import asyncio as _asyncio

        if statuses is None:
            statuses = [9, 11]  # 9=активна, 11=на паузе

        # Retry при 429 (WB rate limit: ~6 req/min на advert API)
        async with httpx.AsyncClient(timeout=20.0) as client:
            for attempt in range(3):
                resp = await client.get(
                    f"{WB_ADV_BASE}/adv/v1/promotion/count",
                    headers=self._headers,
                )
                if resp.status_code == 429:
                    await _asyncio.sleep(12 * (attempt + 1))  # 12s, 24s, 36s
                    continue
                resp.raise_for_status()
                break
            else:
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

        # Ограничение: не более 200 кампаний; имена загружаем отдельным запросом
        all_ids = [c["advert_id"] for c in result]
        names = await self.get_campaign_names(all_ids)
        for c in result:
            real_name = names.get(c["advert_id"])
            if real_name:
                c["name"] = real_name
        return result[:200]

    async def set_campaign_cpm(
        self,
        advert_id: int,
        advert_type: int,
        cpm: int,
        param: int = 0,
        instrument: int = 0,
    ) -> None:
        """Установить ставку CPM для кампании через WB Advert API.

        advert_id:   ID кампании
        advert_type: тип (5=поиск, 6=каталог, 8=авто, 9=поиск+каталог)
        cpm:         ставка в рублях
        param:       subject_id (категория) — нужен для поиска/каталога
        instrument:  0 = стандарт (по умолчанию)

        WB API: POST /adv/v0/cpm
        Документация: https://openapi.wildberries.ru/#tag/Reklama/paths/~1adv~1v0~1cpm/post
        """
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"{WB_ADV_BASE}/adv/v0/cpm",
                headers=self._headers,
                json={
                    "advertId": advert_id,
                    "type": advert_type,
                    "cpm": cpm,
                    "param": param,
                    "instrument": instrument,
                },
            )
            resp.raise_for_status()

    async def set_campaign_cpm_by_nms(
        self,
        advert_id: int,
        nm_ids: list[int],
        cpm: int,
        placement: str = "combined",
    ) -> None:
        """Установить ставку CPM для конкретных артикулов в кампании.

        Используется когда известны nm_ids товаров в кампании.
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

    async def get_campaign_names(self, advert_ids: list[int]) -> dict[int, str]:
        """Реальные названия кампаний через POST /adv/v1/promotion/adverts."""
        if not advert_ids:
            return {}
        result: dict[int, str] = {}
        for i in range(0, len(advert_ids), 50):
            batch = advert_ids[i : i + 50]
            try:
                async with httpx.AsyncClient(timeout=20.0) as client:
                    resp = await client.post(
                        f"{WB_ADV_BASE}/adv/v1/promotion/adverts",
                        headers=self._headers,
                        json=batch,
                    )
                if resp.status_code == 200:
                    for item in (resp.json() or []):
                        if isinstance(item, dict):
                            aid = item.get("advertId")
                            name = item.get("name", "").strip()
                            if aid and name:
                                result[int(aid)] = name
            except Exception:
                pass
        return result

    async def get_all_products_with_subjects(self) -> list[dict]:
        """Все товары аккаунта с категориями из WB Content API (пагинация по cursor).

        Возвращает список: [{nm_id, name, subject_name, subject_id, vendor_code}]
        """
        all_cards: list[dict] = []
        cursor_nm_id: int | None = None
        cursor_updated: str | None = None

        async with httpx.AsyncClient(timeout=30.0) as client:
            while True:
                cursor_block: dict = {"limit": 100}
                if cursor_nm_id:
                    cursor_block["nmID"] = cursor_nm_id
                if cursor_updated:
                    cursor_block["updatedAt"] = cursor_updated

                resp = await client.post(
                    f"{WB_CONTENT_BASE}/content/v2/get/cards/list",
                    headers=self._headers,
                    json={"settings": {"cursor": cursor_block, "filter": {"withPhoto": -1}}},
                )
                if resp.status_code != 200:
                    break
                data = resp.json()
                cards = (data.get("data", {}).get("cards")) or []
                all_cards.extend(cards)

                next_cursor = (data.get("data", {}).get("cursor")) or {}
                if not next_cursor.get("nmID") or len(cards) < 100:
                    break
                cursor_nm_id = next_cursor["nmID"]
                cursor_updated = next_cursor.get("updatedAt")

        result = []
        for card in all_cards:
            nm_id = card.get("nmID")
            if not nm_id:
                continue
            result.append({
                "nm_id": int(nm_id),
                "name": card.get("title") or card.get("vendorCode") or f"#{nm_id}",
                "subject_name": card.get("subjectName") or "Без категории",
                "subject_id": card.get("subjectID") or 0,
                "vendor_code": card.get("vendorCode") or "",
            })
        return result

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
        result: dict[int, str] = {}
        # WB Content API принимает до 100 nmID за запрос
        batch_size = 100
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                for i in range(0, len(nm_ids), batch_size):
                    batch = nm_ids[i : i + batch_size]
                    resp = await client.post(
                        f"{WB_CONTENT_BASE}/content/v2/get/cards/list",
                        headers=self._headers,
                        json={"settings": {"cursor": {"limit": batch_size}, "filter": {"withPhoto": -1, "nmID": batch}}},
                    )
                    if resp.status_code != 200:
                        continue
                    data = resp.json()
                    for card in (data.get("data", {}).get("cards") or []):
                        nid = card.get("nmID")
                        if nid:
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

    async def get_campaign_detailed_stats(
        self, advert_ids: list[int], date_from: str, date_to: str
    ) -> list[dict]:
        """Подробная статистика кампаний через GET /adv/v3/fullstats.

        Возвращает на каждую кампанию:
          advert_id, name (первый товар), spend, views, clicks,
          atbs (в корзину), orders (заказы), shks (выкуплено), revenue.
        Батчи по 50 кампаний, один запрос на батч.
        """
        import asyncio as _asyncio

        aggregated: dict[int, dict] = {}

        async with httpx.AsyncClient(timeout=60.0) as client:
            for i in range(0, len(advert_ids), 50):
                batch_ids = advert_ids[i : i + 50]
                ids_str = ",".join(str(x) for x in batch_ids)
                try:
                    resp = await client.get(
                        f"{WB_ADV_BASE}/adv/v3/fullstats",
                        headers=self._headers,
                        params={"ids": ids_str, "beginDate": date_from, "endDate": date_to},
                    )
                    if resp.status_code == 429:
                        await _asyncio.sleep(2)
                        resp = await client.get(
                            f"{WB_ADV_BASE}/adv/v3/fullstats",
                            headers=self._headers,
                            params={"ids": ids_str, "beginDate": date_from, "endDate": date_to},
                        )
                    if resp.status_code != 200:
                        continue
                    rows = resp.json() or []
                except Exception:
                    continue

                for row in rows:
                    aid = row.get("advertId")
                    if not aid:
                        continue
                    if aid not in aggregated:
                        aggregated[aid] = {
                            "advert_id": aid, "name": f"Кампания #{aid}",
                            "views": 0, "clicks": 0, "spend": 0.0,
                            "atbs": 0, "orders": 0, "shks": 0, "revenue": 0.0,
                            "nm_ids": [],
                        }
                    for day in row.get("days") or []:
                        for app in day.get("apps") or []:
                            for nm in app.get("nms") or []:
                                nm_name = nm.get("name") or ""
                                nm_id   = nm.get("nmId")
                                aggregated[aid]["views"]   += int(nm.get("views",  0))
                                aggregated[aid]["clicks"]  += int(nm.get("clicks", 0))
                                aggregated[aid]["spend"]   += float(nm.get("sum",       0))
                                aggregated[aid]["atbs"]    += int(nm.get("atbs",    0))
                                aggregated[aid]["orders"]  += int(nm.get("orders",  0))
                                aggregated[aid]["shks"]    += int(nm.get("shks",    0))
                                aggregated[aid]["revenue"] += float(nm.get("sum_price", 0))
                                if nm_id and nm_id not in aggregated[aid]["nm_ids"]:
                                    aggregated[aid]["nm_ids"].append(nm_id)
                                if nm_name and aggregated[aid]["name"].startswith("Кампания #"):
                                    aggregated[aid]["name"] = nm_name

                await _asyncio.sleep(0.5)

        return list(aggregated.values())

    async def get_ad_stats(self, date_from: str, date_to: str) -> list[dict]:
        """Получить статистику рекламных кампаний за период.

        Использует GET /adv/v3/fullstats (замена устаревшего POST /adv/v2/fullstats).
        Параметры: ids (через запятую), beginDate, endDate (YYYY-MM-DD).
        Ответ: [{advertId, days:[{date, apps:[{nms:[{nmId,views,clicks,sum,...}]}]}]}]
        """
        import asyncio as _asyncio

        # 1. Список всех кампаний (активные + пауза + завершённые)
        try:
            campaigns = await self.list_campaigns(statuses=[7, 9, 11])
        except Exception:
            return []

        if not campaigns:
            return []

        advert_ids = [c["advert_id"] for c in campaigns]

        # 2. Запрашиваем статистику батчами по 50 кампаний (лимит WB API)
        agg: dict[int, dict[str, dict[int, dict]]] = {}

        async with httpx.AsyncClient(timeout=60.0) as client:
            for i in range(0, len(advert_ids), 50):
                batch_ids = advert_ids[i:i + 50]
                ids_str = ",".join(str(x) for x in batch_ids)
                try:
                    resp = await client.get(
                        f"{WB_ADV_BASE}/adv/v3/fullstats",
                        headers=self._headers,
                        params={"ids": ids_str, "beginDate": date_from, "endDate": date_to},
                    )
                    if resp.status_code == 429:
                        await _asyncio.sleep(2)
                        resp = await client.get(
                            f"{WB_ADV_BASE}/adv/v3/fullstats",
                            headers=self._headers,
                            params={"ids": ids_str, "beginDate": date_from, "endDate": date_to},
                        )
                    if resp.status_code != 200:
                        continue
                    rows = resp.json() or []
                except Exception:
                    continue

                for row in rows:
                    aid = row.get("advertId")
                    if not aid:
                        continue
                    if aid not in agg:
                        agg[aid] = {}
                    # v3 ответ: {advertId, days:[{date, apps:[{appType, nms:[...]}]}]}
                    for day in row.get("days") or []:
                        d = (day.get("date") or "")[:10]
                        if not d:
                            continue
                        if d not in agg[aid]:
                            agg[aid][d] = {}
                        for app in day.get("apps") or []:
                            for nm in app.get("nms") or []:
                                nm_id = nm.get("nmId")
                                if not nm_id:
                                    continue
                                if nm_id not in agg[aid][d]:
                                    agg[aid][d][nm_id] = {
                                        "nmId": nm_id,
                                        "name": str(nm.get("name") or ""),
                                        "views": 0, "clicks": 0,
                                        "cpm": float(nm.get("cpm") or 0),
                                        "sum": 0.0,
                                    }
                                agg[aid][d][nm_id]["views"]  += int(nm.get("views")  or 0)
                                agg[aid][d][nm_id]["clicks"] += int(nm.get("clicks") or 0)
                                agg[aid][d][nm_id]["sum"]    += float(nm.get("sum")   or 0)
                                if nm.get("name") and not agg[aid][d][nm_id]["name"]:
                                    agg[aid][d][nm_id]["name"] = str(nm.get("name"))

                await _asyncio.sleep(0.5)  # избегаем rate limit между батчами

        # 3. Конвертируем в формат ожидаемый save_ad_stats_wb
        result = []
        for aid, dates_map in agg.items():
            days_list = []
            for d, nm_map in dates_map.items():
                if any(v["views"] > 0 or v["sum"] > 0 for v in nm_map.values()):
                    days_list.append({
                        "date": d,
                        "apps": [{"nms": list(nm_map.values())}],
                    })
            if days_list:
                result.append({"advertId": aid, "days": days_list})

        return result

    @staticmethod
    def _wb_basket_url(nm_id: int, basket: int) -> str:
        vol  = nm_id // 100000
        part = nm_id // 1000
        return f"https://basket-{basket:02d}.wbbasket.ru/vol{vol}/part{part}/{nm_id}/info/ru/card.json"

    @staticmethod
    def _basket_candidates(nm_id: int) -> list[int]:
        """Список кандидатов корзины WB CDN для данного nm_id (наиболее вероятные сначала)."""
        vol = nm_id // 100000
        # Приблизительная формула: basket ≈ vol // 200, но WB расширяет CDN
        center = max(1, vol // 200)
        seen: set[int] = set()
        result: list[int] = []
        for delta in [0, 1, -1, 2, -2, 3, 4, 5, -3, 6, 7, 8]:
            b = center + delta
            if 1 <= b <= 40 and b not in seen:
                seen.add(b)
                result.append(b)
        return result

    @staticmethod
    async def get_card_params(nm_ids: list[int]) -> dict[int, str]:
        """Получить параметры объёма/веса/граммовки товаров через публичный WB CDN API.

        Не требует авторизации. Возвращает {nm_id: "250 г"} / {nm_id: "1 л"} и т.п.
        Используется для обогащения названий SKU: "Корневин" → "Корневин, 250 г".
        """
        if not nm_ids:
            return {}

        # Приоритетный порядок ключей характеристик (объём/вес без упаковки)
        PARAM_PRIORITY = [
            "объём", "объем",
            "вес товара без упаковки",
            "масса нетто", "масса товара",
            "вес без упаковки", "масса без упаковки",
            "вес нетто",
            "граммовка",
            "вместимость", "литраж",
            "масса", "вес",
        ]

        result: dict[int, str] = {}
        # Кэш vol_bucket → basket_num чтобы не проверять повторно
        basket_cache: dict[int, int] = {}

        async with httpx.AsyncClient(timeout=10.0) as client:
            for nm_id in nm_ids:
                bucket = nm_id // 100000
                # Берём basket из кэша или ищем
                basket = basket_cache.get(bucket)
                if basket is None:
                    for candidate in WBClient._basket_candidates(nm_id):
                        try:
                            r = await client.head(
                                WBClient._wb_basket_url(nm_id, candidate)
                            )
                            if r.status_code == 200:
                                basket = candidate
                                basket_cache[bucket] = basket
                                break
                        except Exception:
                            continue
                if basket is None:
                    continue

                try:
                    r = await client.get(WBClient._wb_basket_url(nm_id, basket))
                    if r.status_code != 200:
                        continue
                    options = r.json().get("options") or []
                    for key in PARAM_PRIORITY:
                        for opt in options:
                            opt_name = (opt.get("name") or "").lower()
                            if key in opt_name:
                                val = (opt.get("value") or "").strip()
                                if val:
                                    # Если единица указана в скобках в имени поля — добавляем
                                    # Пример: "Объем (л)" → val="1" → "1 л"
                                    import re as _re
                                    unit_match = _re.search(r'\(([а-яёa-z]+)\)', opt_name)
                                    if unit_match:
                                        unit = unit_match.group(1)
                                        has_unit = _re.search(r'[а-яёa-z]+', val, _re.IGNORECASE)
                                        if not has_unit:
                                            val = f"{val} {unit}"
                                    result[nm_id] = val
                                    break
                        if nm_id in result:
                            break
                except Exception:
                    continue

        return result

    async def get_payouts_sum(self, date_from: str, date_to: str) -> float:
        """Сумма начислений продавцу от WB за период (поле ppvz_for_pay).

        Использует WB финансовый отчёт (/api/v5/supplier/reportdetailbyperiod).
        ppvz_for_pay = выручка − комиссия WB − логистика − хранение.
        Это реальная сумма которую WB перечислит продавцу.
        Отрицательные значения (возвраты) уже учтены в поле.
        """
        total = 0.0
        rrdid = 0
        async with httpx.AsyncClient(timeout=90.0) as client:
            while True:
                try:
                    resp = await client.get(
                        f"{WB_STAT_BASE}/api/v5/supplier/reportdetailbyperiod",
                        headers=self._headers,
                        params={"dateFrom": date_from, "dateTo": date_to, "rrdid": rrdid, "limit": 100000},
                    )
                    if resp.status_code != 200:
                        break
                    rows: list[dict] = resp.json() or []
                    if not rows:
                        break
                except Exception:
                    break
                for row in rows:
                    total += float(row.get("ppvz_for_pay") or 0)
                if len(rows) < 100000:
                    break
                rrdid = rows[-1].get("rrd_id", 0)
        return round(total, 2)

    async def get_wb_services_costs(self, date_from: str, date_to: str) -> dict:
        """Получить доп. расходы по WB-услугам из финансового отчёта.

        Возвращает словарь:
          total       — сумма всех удержаний по доп. услугам
          by_type     — разбивка по типу услуги
          rows_count  — сколько строк обработано

        Типы услуг, которые включаем (продвижение, реклама WB):
          'Продвижение', 'Услуги продвижения', 'Реклама', 'Маркетинг'
        Хранение и логистика намеренно исключаем — это операционные, не маркетинговые.
        """
        PROMO_KEYWORDS = ("продвижен", "реклам", "маркетинг", "продвиж")

        total = 0.0
        by_type: dict[str, float] = {}
        rows_count = 0
        rrdid = 0  # пагинация

        async with httpx.AsyncClient(timeout=60.0) as client:
            while True:
                try:
                    resp = await client.get(
                        f"{WB_STAT_BASE}/api/v5/supplier/reportdetailbyperiod",
                        headers=self._headers,
                        params={"dateFrom": date_from, "dateTo": date_to, "rrdid": rrdid, "limit": 100000},
                    )
                    if resp.status_code != 200:
                        break
                    rows: list[dict] = resp.json() or []
                    if not rows:
                        break
                except Exception:
                    break

                for row in rows:
                    rows_count += 1
                    op_name: str = (row.get("supplier_oper_name") or "").lower()
                    # Берём только строки с доп. услугами продвижения
                    if not any(kw in op_name for kw in PROMO_KEYWORDS):
                        continue
                    # Удержания хранятся в поле deduction (отрицательное = расход продавца)
                    deduction = float(row.get("deduction") or 0)
                    if deduction < 0:
                        cost = abs(deduction)
                        orig_name = row.get("supplier_oper_name") or "Услуга WB"
                        by_type[orig_name] = by_type.get(orig_name, 0.0) + cost
                        total += cost

                # Если вернулось меньше страницы — конец
                if len(rows) < 100000:
                    break
                rrdid = rows[-1].get("rrd_id", 0)

        return {"total": round(total, 2), "by_type": by_type, "rows_count": rows_count}
