from datetime import datetime, timezone

import httpx

OZON_API_BASE = "https://api-seller.ozon.ru"
OZON_PERF_BASE = "https://performance.ozon.ru:443"

# Соответствие названий категорий → ID категорий Ozon (приблизительные)
OZON_CATEGORY_IDS: dict[str, int] = {
    "Одежда": 15621,
    "Обувь": 17027,
    "Электроника": 17061,
    "Красота": 6500,
    "Дом и сад": 14625,
    "Детские товары": 7812,
    "Спорт": 91597,
    "Продукты": 13654,
}


class OzonClient:
    def __init__(self, client_id: str, api_key: str) -> None:
        self._headers = {
            "Client-Id": client_id,
            "Api-Key": api_key,
            "Content-Type": "application/json",
        }

    async def _fetch_fbo(self, client: httpx.AsyncClient, date_from: datetime) -> list[dict]:
        try:
            resp = await client.post(
                f"{OZON_API_BASE}/v3/posting/fbo/list",
                headers=self._headers,
                json={
                    "dir": "asc",
                    "filter": {
                        "since": date_from.strftime("%Y-%m-%dT%H:%M:%SZ"),
                        "to": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                        "status": "",
                    },
                    "limit": 1000,
                    "offset": 0,
                    "with": {"analytics_data": True, "financial_data": False},
                },
            )
            if resp.status_code == 403:
                return []
            resp.raise_for_status()
            return resp.json().get("result", {}).get("postings", [])
        except httpx.HTTPStatusError:
            return []

    async def _fetch_fbs(self, client: httpx.AsyncClient, date_from: datetime) -> list[dict]:
        try:
            resp = await client.post(
                f"{OZON_API_BASE}/v3/posting/fbs/list",
                headers=self._headers,
                json={
                    "dir": "asc",
                    "filter": {
                        "since": date_from.strftime("%Y-%m-%dT%H:%M:%SZ"),
                        "to": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                        "status": "",
                        "delivery_schema": [],
                    },
                    "limit": 1000,
                    "offset": 0,
                    "with": {"analytics_data": True, "financial_data": False, "barcodes": False},
                },
            )
            if resp.status_code == 403:
                return []
            resp.raise_for_status()
            return resp.json().get("result", {}).get("postings", [])
        except httpx.HTTPStatusError:
            return []

    async def get_orders(self, date_from: datetime) -> list[dict]:
        async with httpx.AsyncClient(timeout=30.0) as client:
            fbo = await self._fetch_fbo(client, date_from)
            fbs = await self._fetch_fbs(client, date_from)
            return fbo + fbs

    async def get_stocks(self) -> list[dict]:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{OZON_API_BASE}/v2/analytics/stock_on_warehouses",
                headers=self._headers,
                json={"limit": 1000, "offset": 0, "warehouse_type": "ALL"},
            )
            resp.raise_for_status()
            return resp.json().get("result", {}).get("rows", [])

    async def get_prices(self) -> list[dict]:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{OZON_API_BASE}/v5/product/info/prices",
                headers=self._headers,
                json={"filter": {"visibility": "ALL"}, "cursor": "", "limit": 1000},
            )
            resp.raise_for_status()
            data = resp.json()
            return data.get("items", []) or data.get("result", {}).get("items", [])

    async def get_cpm_benchmark(
        self,
        category: str = "Электроника",
        placement: str = "Поиск",
    ) -> dict[str, int]:
        """
        Получаем ставки CPM с Ozon через Performance API.
        Endpoint /api/client/campaign/cpm возвращает минимум и рекомендованную ставку.
        """
        category_id = OZON_CATEGORY_IDS.get(category, 17061)
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"{OZON_PERF_BASE}/api/client/campaign/cpm",
                headers={**self._headers, "Content-Type": "application/json"},
                params={"categoryId": category_id, "placementType": placement},
            )
            resp.raise_for_status()
            data = resp.json()
        # Ozon возвращает: {"minCpm": N, "recommendedCpm": M}
        min_cpm = int(data.get("minCpm", 50))
        recommended = int(data.get("recommendedCpm", min_cpm * 4))
        return {
            "min": min_cpm,
            "competitor": recommended,
            "top": round(recommended * 1.4),
            "aggressive": round(recommended * 2.2),
        }

    async def get_cpc_benchmark(
        self,
        category: str = "Электроника",
        placement: str = "Поиск",
    ) -> dict[str, int]:
        """
        CPC-ставки Ozon через Performance API.
        """
        category_id = OZON_CATEGORY_IDS.get(category, 17061)
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"{OZON_PERF_BASE}/api/client/campaign/cpc",
                headers={**self._headers, "Content-Type": "application/json"},
                params={"categoryId": category_id, "placementType": placement},
            )
            resp.raise_for_status()
            data = resp.json()
        min_cpc = int(data.get("minCpc", 5))
        recommended = int(data.get("recommendedCpc", min_cpc * 4))
        return {
            "min": min_cpc,
            "competitor": recommended,
            "top": round(recommended * 1.4),
            "aggressive": round(recommended * 2.2),
        }

    async def get_ad_stats(self, date_from: str, date_to: str) -> list[dict]:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{OZON_API_BASE}/statistics/campaign/product/day",
                headers=self._headers,
                json={"date_from": date_from, "date_to": date_to},
            )
            resp.raise_for_status()
            return resp.json().get("result", [])
