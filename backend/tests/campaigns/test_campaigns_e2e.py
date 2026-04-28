"""
E2E-тесты для рекламных кампаний WB:
  - Массовое создание по принципу 1SKU-1РК (POST /campaigns/create-category-pack)
  - Массовое расписание показов, стратегия «2 пика» (POST /campaigns/bulk-schedule)
  - Авто-расписание будни/выходные (CRUD /campaigns/auto-schedules)
  - Установка CPM (POST /campaigns/{id}/set-cpm)

Тесты работают через FastAPI AsyncClient, WB API подменяется моками.
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient

# ─── Константы ────────────────────────────────────────────────────────────────

# Стратегия «2 пика» из WbCampaignManager.tsx
SCHEDULE_2PEAKS = [0, 0, 0, 0, 0, 0, 80, 80, 80, 80, 100, 100, 100, 100,
                   80, 80, 80, 80, 80, 100, 100, 100, 100, 0]

SCHEDULE_DAY = [0, 0, 0, 0, 0, 0, 0, 80, 100, 100, 100, 100,
                100, 100, 100, 100, 100, 80, 60, 30, 0, 0, 0, 0]

SCHEDULE_24H = [100] * 24
SCHEDULE_OFF = [0] * 24


# ─── Helpers ──────────────────────────────────────────────────────────────────

async def _register_and_login(client: AsyncClient, email: str = "test@example.com") -> str:
    await client.post("/auth/register", json={"email": email, "password": "pass12345"})
    resp = await client.post("/auth/login", json={"email": email, "password": "pass12345"})
    return resp.json()["access_token"]


async def _create_wb_account(client: AsyncClient, token: str, name: str = "WB кабинет") -> str:
    resp = await client.post(
        "/accounts",
        json={"marketplace": "wb", "name": name, "seller_id": "12345", "api_key": "fake-wb-key"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _create_ozon_account(client: AsyncClient, token: str) -> str:
    resp = await client.post(
        "/accounts",
        json={"marketplace": "ozon", "name": "Ozon кабинет", "seller_id": "99", "api_key": "ozon-key"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def _mock_wb_client(
    create_return: int = 100001,
    list_return: list | None = None,
    cpm_raises: Exception | None = None,
    hours_raises: Exception | None = None,
    create_raises: Exception | None = None,
):
    """Фабрика мок-объекта WBClient для быстрой настройки."""
    mock = MagicMock()

    # create_auto_campaign
    if create_raises:
        mock.create_auto_campaign = AsyncMock(side_effect=create_raises)
    else:
        mock.create_auto_campaign = AsyncMock(return_value=create_return)

    # set_campaign_cpm
    mock.set_campaign_cpm = AsyncMock(
        side_effect=cpm_raises if cpm_raises else None,
        return_value=None,
    )

    # set_campaign_hours
    mock.set_campaign_hours = AsyncMock(
        side_effect=hours_raises if hours_raises else None,
        return_value=None,
    )

    # list_campaigns
    mock.list_campaigns = AsyncMock(return_value=list_return or [])

    # get_campaign_names
    mock.get_campaign_names = AsyncMock(return_value={})

    # get_nm_titles
    mock.get_nm_titles = AsyncMock(return_value={})

    return mock


# ══════════════════════════════════════════════════════════════════════════════
# БЛОК 1: Массовое создание РК по принципу 1SKU-1РК
# ══════════════════════════════════════════════════════════════════════════════

class TestCreateCategoryPack:
    """POST /campaigns/create-category-pack — создание 1РК на каждый SKU."""

    async def _setup(self, client: AsyncClient):
        token = await _register_and_login(client, "ccp@example.com")
        account_id = await _create_wb_account(client, token)
        auth = {"Authorization": f"Bearer {token}"}
        return token, account_id, auth

    # ── 1. Базовый happy path: 1 SKU → 1 кампания ────────────────────────────

    @pytest.mark.asyncio
    async def test_single_sku_creates_one_campaign(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client)
        mock = _mock_wb_client(create_return=200001)

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            resp = await client.post(
                "/campaigns/create-category-pack",
                json={
                    "account_id": account_id,
                    "nm_ids": [111111],
                    "name_prefix": "Удобрение",
                    "budget": 500,
                    "cpm": 150,
                    "schedule_hours": SCHEDULE_2PEAKS,
                },
                headers=auth,
            )
        assert resp.status_code == 201
        data = resp.json()
        assert data["created_count"] == 1
        assert data["error_count"] == 0
        assert len(data["campaigns"]) == 1

    # ── 2. Название формируется как «{prefix} — {nm_id}» ─────────────────────

    @pytest.mark.asyncio
    async def test_campaign_name_format(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client)
        mock = _mock_wb_client(create_return=200002)

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            resp = await client.post(
                "/campaigns/create-category-pack",
                json={
                    "account_id": account_id,
                    "nm_ids": [999888],
                    "name_prefix": "Тест",
                    "budget": 500,
                    "cpm": 100,
                    "schedule_hours": SCHEDULE_2PEAKS,
                },
                headers=auth,
            )
        campaign = resp.json()["campaigns"][0]
        assert campaign["name"] == "Тест — 999888"
        assert campaign["nm_id"] == 999888
        assert campaign["advert_id"] == 200002

    # ── 3. 5 SKU → 5 кампаний ────────────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_five_skus_create_five_campaigns(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client)
        counter = [0]

        async def _create_side_effect(nm_ids, budget, name):
            counter[0] += 1
            return 300000 + counter[0]

        mock = _mock_wb_client()
        mock.create_auto_campaign = AsyncMock(side_effect=_create_side_effect)

        nm_ids = [100, 200, 300, 400, 500]
        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            resp = await client.post(
                "/campaigns/create-category-pack",
                json={
                    "account_id": account_id,
                    "nm_ids": nm_ids,
                    "name_prefix": "SKU",
                    "budget": 500,
                    "cpm": 200,
                    "schedule_hours": SCHEDULE_2PEAKS,
                },
                headers=auth,
            )
        data = resp.json()
        assert data["created_count"] == 5
        assert data["error_count"] == 0
        assert len(data["campaigns"]) == 5

    # ── 4. 10 SKU → 10 кампаний ──────────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_ten_skus_create_ten_campaigns(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client)
        idx = [0]

        async def _create(nm_ids, budget, name):
            idx[0] += 1
            return 400000 + idx[0]

        mock = _mock_wb_client()
        mock.create_auto_campaign = AsyncMock(side_effect=_create)

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            resp = await client.post(
                "/campaigns/create-category-pack",
                json={
                    "account_id": account_id,
                    "nm_ids": list(range(1001, 1011)),
                    "name_prefix": "Товар",
                    "budget": 1000,
                    "cpm": 250,
                    "schedule_hours": SCHEDULE_2PEAKS,
                },
                headers=auth,
            )
        assert resp.json()["created_count"] == 10

    # ── 5. 20 SKU → 20 кампаний ──────────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_twenty_skus_create_twenty_campaigns(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client)
        idx = [0]

        async def _create(nm_ids, budget, name):
            idx[0] += 1
            return 500000 + idx[0]

        mock = _mock_wb_client()
        mock.create_auto_campaign = AsyncMock(side_effect=_create)

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            resp = await client.post(
                "/campaigns/create-category-pack",
                json={
                    "account_id": account_id,
                    "nm_ids": list(range(2001, 2021)),
                    "name_prefix": "Мега",
                    "budget": 500,
                    "cpm": 100,
                    "schedule_hours": SCHEDULE_2PEAKS,
                },
                headers=auth,
            )
        assert resp.json()["created_count"] == 20

    # ── 6. CPM передаётся в WB ────────────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_cpm_is_passed_to_wb(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client)
        mock = _mock_wb_client(create_return=600001)
        cpm_calls = []
        mock.set_campaign_cpm = AsyncMock(side_effect=lambda **kw: cpm_calls.append(kw))

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            await client.post(
                "/campaigns/create-category-pack",
                json={
                    "account_id": account_id,
                    "nm_ids": [777777],
                    "name_prefix": "Тест CPM",
                    "budget": 500,
                    "cpm": 300,
                    "schedule_hours": SCHEDULE_2PEAKS,
                },
                headers=auth,
            )
        assert len(cpm_calls) == 1
        assert cpm_calls[0]["cpm"] == 300
        assert cpm_calls[0]["advert_type"] == 8  # авто-кампания

    # ── 7. Расписание «2 пика» передаётся в WB ───────────────────────────────

    @pytest.mark.asyncio
    async def test_2peaks_schedule_applied_per_sku(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client)
        mock = _mock_wb_client(create_return=600002)
        hours_calls = []
        mock.set_campaign_hours = AsyncMock(
            side_effect=lambda advert_id, hours: hours_calls.append(hours[:])
        )

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            await client.post(
                "/campaigns/create-category-pack",
                json={
                    "account_id": account_id,
                    "nm_ids": [10, 20, 30],
                    "name_prefix": "Peak",
                    "budget": 500,
                    "cpm": 150,
                    "schedule_hours": SCHEDULE_2PEAKS,
                },
                headers=auth,
            )
        assert len(hours_calls) == 3
        for call_hours in hours_calls:
            assert call_hours == SCHEDULE_2PEAKS

    # ── 8. Расписание «рабочий день» передаётся в WB ─────────────────────────

    @pytest.mark.asyncio
    async def test_day_schedule_applied(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client)
        mock = _mock_wb_client(create_return=600003)
        hours_calls = []
        mock.set_campaign_hours = AsyncMock(
            side_effect=lambda advert_id, hours: hours_calls.append(hours[:])
        )

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            await client.post(
                "/campaigns/create-category-pack",
                json={
                    "account_id": account_id,
                    "nm_ids": [11],
                    "name_prefix": "Day",
                    "budget": 500,
                    "cpm": 150,
                    "schedule_hours": SCHEDULE_DAY,
                },
                headers=auth,
            )
        assert hours_calls[0] == SCHEDULE_DAY

    # ── 9. Бюджет по умолчанию = 500 ─────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_default_budget_500(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client)
        mock = _mock_wb_client(create_return=600004)
        budget_calls = []

        async def _create(nm_ids, budget, name):
            budget_calls.append(budget)
            return 600004

        mock.create_auto_campaign = AsyncMock(side_effect=_create)

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            await client.post(
                "/campaigns/create-category-pack",
                json={
                    "account_id": account_id,
                    "nm_ids": [555],
                    "name_prefix": "Budget",
                    "cpm": 100,
                    "schedule_hours": SCHEDULE_2PEAKS,
                },
                headers=auth,
            )
        assert budget_calls[0] == 500

    # ── 10. Кастомный бюджет ──────────────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_custom_budget_passed(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client)
        budget_calls = []

        async def _create(nm_ids, budget, name):
            budget_calls.append(budget)
            return 600010

        mock = _mock_wb_client()
        mock.create_auto_campaign = AsyncMock(side_effect=_create)

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            await client.post(
                "/campaigns/create-category-pack",
                json={
                    "account_id": account_id,
                    "nm_ids": [888],
                    "name_prefix": "X",
                    "budget": 2000,
                    "cpm": 100,
                    "schedule_hours": SCHEDULE_2PEAKS,
                },
                headers=auth,
            )
        assert budget_calls[0] == 2000

    # ── 11. Пустой список nm_ids → ничего не создаётся ───────────────────────

    @pytest.mark.asyncio
    async def test_empty_nm_ids_no_campaigns_created(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client)
        mock = _mock_wb_client()

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            resp = await client.post(
                "/campaigns/create-category-pack",
                json={
                    "account_id": account_id,
                    "nm_ids": [],
                    "name_prefix": "Empty",
                    "budget": 500,
                    "cpm": 100,
                    "schedule_hours": SCHEDULE_2PEAKS,
                },
                headers=auth,
            )
        assert resp.status_code == 201
        data = resp.json()
        assert data["created_count"] == 0
        assert data["error_count"] == 0

    # ── 12. schedule_hours != 24 элементов → 400 ─────────────────────────────

    @pytest.mark.asyncio
    async def test_wrong_schedule_length_returns_400(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client)
        mock = _mock_wb_client()

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            resp = await client.post(
                "/campaigns/create-category-pack",
                json={
                    "account_id": account_id,
                    "nm_ids": [1],
                    "name_prefix": "Bad",
                    "budget": 500,
                    "cpm": 100,
                    "schedule_hours": [100] * 12,
                },
                headers=auth,
            )
        assert resp.status_code == 400

    # ── 13. schedule_hours из 25 элементов → 400 ─────────────────────────────

    @pytest.mark.asyncio
    async def test_too_long_schedule_returns_400(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client)
        mock = _mock_wb_client()

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            resp = await client.post(
                "/campaigns/create-category-pack",
                json={
                    "account_id": account_id,
                    "nm_ids": [1],
                    "name_prefix": "Bad",
                    "budget": 500,
                    "cpm": 100,
                    "schedule_hours": [100] * 25,
                },
                headers=auth,
            )
        assert resp.status_code == 400

    # ── 14. Без токена → 401/403 ──────────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_no_auth_returns_401(self, client: AsyncClient) -> None:
        resp = await client.post(
            "/campaigns/create-category-pack",
            json={
                "account_id": str(uuid.uuid4()),
                "nm_ids": [1],
                "name_prefix": "X",
                "budget": 500,
                "cpm": 100,
                "schedule_hours": SCHEDULE_2PEAKS,
            },
        )
        assert resp.status_code in (401, 403)

    # ── 15. Несуществующий account_id → 404 ──────────────────────────────────

    @pytest.mark.asyncio
    async def test_unknown_account_returns_404(self, client: AsyncClient) -> None:
        token = await _register_and_login(client, "noact@example.com")
        mock = _mock_wb_client()

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            resp = await client.post(
                "/campaigns/create-category-pack",
                json={
                    "account_id": str(uuid.uuid4()),
                    "nm_ids": [1],
                    "name_prefix": "X",
                    "budget": 500,
                    "cpm": 100,
                    "schedule_hours": SCHEDULE_2PEAKS,
                },
                headers={"Authorization": f"Bearer {token}"},
            )
        assert resp.status_code == 404

    # ── 16. Ozon-аккаунт → 400 ───────────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_ozon_account_returns_400(self, client: AsyncClient) -> None:
        token, _, auth = await self._setup(client)
        ozon_id = await _create_ozon_account(
            client, await _register_and_login(client, "ozon_ccp@example.com")
        )
        token2 = await _register_and_login(client, "ozon_ccp@example.com")
        auth2 = {"Authorization": f"Bearer {token2}"}
        ozon_id = await _create_ozon_account(client, token2)
        mock = _mock_wb_client()

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            resp = await client.post(
                "/campaigns/create-category-pack",
                json={
                    "account_id": ozon_id,
                    "nm_ids": [1],
                    "name_prefix": "X",
                    "budget": 500,
                    "cpm": 100,
                    "schedule_hours": SCHEDULE_2PEAKS,
                },
                headers=auth2,
            )
        assert resp.status_code == 400

    # ── 17. Ошибка создания → кампания в errors, остальные продолжают ─────────

    @pytest.mark.asyncio
    async def test_partial_create_failure_logged(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client)
        call_count = [0]

        async def _create(nm_ids, budget, name):
            call_count[0] += 1
            if call_count[0] == 2:
                raise Exception("WB timeout")
            return 700000 + call_count[0]

        mock = _mock_wb_client()
        mock.create_auto_campaign = AsyncMock(side_effect=_create)

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            resp = await client.post(
                "/campaigns/create-category-pack",
                json={
                    "account_id": account_id,
                    "nm_ids": [1, 2, 3],
                    "name_prefix": "Fail",
                    "budget": 500,
                    "cpm": 100,
                    "schedule_hours": SCHEDULE_2PEAKS,
                },
                headers=auth,
            )
        data = resp.json()
        assert data["created_count"] == 2
        assert data["error_count"] == 1
        assert any(e["nm_id"] == 2 and e["step"] == "create" for e in data["errors"])

    # ── 18. Ошибка set_cpm не прерывает создание ─────────────────────────────

    @pytest.mark.asyncio
    async def test_cpm_failure_does_not_abort_campaign(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client)
        mock = _mock_wb_client(create_return=800001, cpm_raises=Exception("CPM error"))

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            resp = await client.post(
                "/campaigns/create-category-pack",
                json={
                    "account_id": account_id,
                    "nm_ids": [55],
                    "name_prefix": "CpmFail",
                    "budget": 500,
                    "cpm": 100,
                    "schedule_hours": SCHEDULE_2PEAKS,
                },
                headers=auth,
            )
        data = resp.json()
        # Кампания всё равно засчитана как созданная
        assert data["created_count"] == 1
        # Ошибка CPM попала в errors
        assert any(e["step"] == "set_cpm" for e in data["errors"])

    # ── 19. Ошибка set_campaign_hours не прерывает создание ──────────────────

    @pytest.mark.asyncio
    async def test_schedule_failure_does_not_abort_campaign(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client)
        mock = _mock_wb_client(create_return=800002, hours_raises=Exception("Schedule error"))

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            resp = await client.post(
                "/campaigns/create-category-pack",
                json={
                    "account_id": account_id,
                    "nm_ids": [66],
                    "name_prefix": "SchedFail",
                    "budget": 500,
                    "cpm": 100,
                    "schedule_hours": SCHEDULE_2PEAKS,
                },
                headers=auth,
            )
        data = resp.json()
        assert data["created_count"] == 1
        assert any(e["step"] == "schedule" for e in data["errors"])

    # ── 20. Ответ содержит правильные поля для каждой кампании ───────────────

    @pytest.mark.asyncio
    async def test_response_fields_per_campaign(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client)
        mock = _mock_wb_client(create_return=900001)

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            resp = await client.post(
                "/campaigns/create-category-pack",
                json={
                    "account_id": account_id,
                    "nm_ids": [77777],
                    "name_prefix": "Fields",
                    "budget": 500,
                    "cpm": 100,
                    "schedule_hours": SCHEDULE_2PEAKS,
                },
                headers=auth,
            )
        c = resp.json()["campaigns"][0]
        assert "nm_id" in c
        assert "advert_id" in c
        assert "name" in c

    # ── 21. Порядок кампаний совпадает с nm_ids ───────────────────────────────

    @pytest.mark.asyncio
    async def test_campaign_order_matches_nm_ids(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client)
        nm_ids = [11, 22, 33, 44, 55]
        counter = [0]

        async def _create(ids, budget, name):
            counter[0] += 1
            return 900000 + counter[0]

        mock = _mock_wb_client()
        mock.create_auto_campaign = AsyncMock(side_effect=_create)

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            resp = await client.post(
                "/campaigns/create-category-pack",
                json={
                    "account_id": account_id,
                    "nm_ids": nm_ids,
                    "name_prefix": "Order",
                    "budget": 500,
                    "cpm": 100,
                    "schedule_hours": SCHEDULE_2PEAKS,
                },
                headers=auth,
            )
        created = resp.json()["campaigns"]
        result_nm_ids = [c["nm_id"] for c in created]
        assert result_nm_ids == nm_ids

    # ── 22. WB возвращает разные advert_id для каждого SKU ───────────────────

    @pytest.mark.asyncio
    async def test_each_sku_gets_unique_advert_id(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client)
        counter = [0]

        async def _create(ids, budget, name):
            counter[0] += 1
            return 1000000 + counter[0]

        mock = _mock_wb_client()
        mock.create_auto_campaign = AsyncMock(side_effect=_create)

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            resp = await client.post(
                "/campaigns/create-category-pack",
                json={
                    "account_id": account_id,
                    "nm_ids": [1, 2, 3, 4, 5],
                    "name_prefix": "Uniq",
                    "budget": 500,
                    "cpm": 100,
                    "schedule_hours": SCHEDULE_2PEAKS,
                },
                headers=auth,
            )
        advert_ids = [c["advert_id"] for c in resp.json()["campaigns"]]
        assert len(set(advert_ids)) == 5  # все уникальные

    # ── 23. Каждый nm_id создаётся отдельной кампанией (не батчем) ───────────

    @pytest.mark.asyncio
    async def test_each_sku_is_separate_campaign_call(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client)
        create_calls = []

        async def _create(nm_ids, budget, name):
            create_calls.append(nm_ids[:])
            return 1100000 + len(create_calls)

        mock = _mock_wb_client()
        mock.create_auto_campaign = AsyncMock(side_effect=_create)

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            await client.post(
                "/campaigns/create-category-pack",
                json={
                    "account_id": account_id,
                    "nm_ids": [10, 20, 30],
                    "name_prefix": "Sep",
                    "budget": 500,
                    "cpm": 100,
                    "schedule_hours": SCHEDULE_2PEAKS,
                },
                headers=auth,
            )
        # Каждый вызов — ровно 1 nm_id
        for call_ids in create_calls:
            assert len(call_ids) == 1

    # ── 24. Ответ содержит created_count и error_count ────────────────────────

    @pytest.mark.asyncio
    async def test_response_top_level_fields(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client)
        mock = _mock_wb_client(create_return=1200001)

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            resp = await client.post(
                "/campaigns/create-category-pack",
                json={
                    "account_id": account_id,
                    "nm_ids": [1, 2],
                    "name_prefix": "Fields",
                    "budget": 500,
                    "cpm": 100,
                    "schedule_hours": SCHEDULE_2PEAKS,
                },
                headers=auth,
            )
        data = resp.json()
        assert "created_count" in data
        assert "error_count" in data
        assert "campaigns" in data
        assert "errors" in data

    # ── 25. Все SKU падают → created_count=0, error_count=N ──────────────────

    @pytest.mark.asyncio
    async def test_all_skus_fail_returns_zero_created(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client)
        mock = _mock_wb_client(create_raises=Exception("WB down"))

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            resp = await client.post(
                "/campaigns/create-category-pack",
                json={
                    "account_id": account_id,
                    "nm_ids": [1, 2, 3],
                    "name_prefix": "AllFail",
                    "budget": 500,
                    "cpm": 100,
                    "schedule_hours": SCHEDULE_2PEAKS,
                },
                headers=auth,
            )
        data = resp.json()
        assert data["created_count"] == 0
        assert data["error_count"] == 3


# ══════════════════════════════════════════════════════════════════════════════
# БЛОК 2: Массовое расписание показов (bulk-schedule)
# ══════════════════════════════════════════════════════════════════════════════

class TestBulkSchedule:
    """POST /campaigns/bulk-schedule — массовая установка расписания."""

    async def _setup(self, client: AsyncClient, email: str = "bulk@example.com"):
        token = await _register_and_login(client, email)
        account_id = await _create_wb_account(client, token)
        auth = {"Authorization": f"Bearer {token}"}
        return token, account_id, auth

    # ── 26. Happy path: 1 кампания ────────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_single_campaign_schedule_ok(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client)
        mock = _mock_wb_client()

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            resp = await client.post(
                "/campaigns/bulk-schedule",
                json={"account_id": account_id, "advert_ids": [111], "hours": SCHEDULE_2PEAKS},
                headers=auth,
            )
        assert resp.status_code == 200
        data = resp.json()
        assert data["applied"] == 1
        assert data["total"] == 1

    # ── 27. 5 кампаний — все успешно ──────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_five_campaigns_all_applied(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client, "bulk5@example.com")
        mock = _mock_wb_client()

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            resp = await client.post(
                "/campaigns/bulk-schedule",
                json={
                    "account_id": account_id,
                    "advert_ids": [1, 2, 3, 4, 5],
                    "hours": SCHEDULE_2PEAKS,
                },
                headers=auth,
            )
        data = resp.json()
        assert data["applied"] == 5
        assert data["total"] == 5

    # ── 28. 10 кампаний ───────────────────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_ten_campaigns_all_applied(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client, "bulk10@example.com")
        mock = _mock_wb_client()

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            resp = await client.post(
                "/campaigns/bulk-schedule",
                json={
                    "account_id": account_id,
                    "advert_ids": list(range(101, 111)),
                    "hours": SCHEDULE_2PEAKS,
                },
                headers=auth,
            )
        assert resp.json()["applied"] == 10

    # ── 29. 20 кампаний ───────────────────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_twenty_campaigns_all_applied(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client, "bulk20@example.com")
        mock = _mock_wb_client()

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            resp = await client.post(
                "/campaigns/bulk-schedule",
                json={
                    "account_id": account_id,
                    "advert_ids": list(range(201, 221)),
                    "hours": SCHEDULE_2PEAKS,
                },
                headers=auth,
            )
        assert resp.json()["applied"] == 20

    # ── 30. Паттерн «2 пика» точно передаётся в WB ───────────────────────────

    @pytest.mark.asyncio
    async def test_2peaks_pattern_exact_values(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client, "2p@example.com")
        received_hours = []
        mock = _mock_wb_client()
        mock.set_campaign_hours = AsyncMock(
            side_effect=lambda advert_id, hours: received_hours.append(hours[:])
        )

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            await client.post(
                "/campaigns/bulk-schedule",
                json={"account_id": account_id, "advert_ids": [10], "hours": SCHEDULE_2PEAKS},
                headers=auth,
            )
        assert received_hours[0] == SCHEDULE_2PEAKS

    # ── 31. Паттерн «2 пика»: ночь 0-5 = 0% ─────────────────────────────────

    @pytest.mark.asyncio
    async def test_2peaks_night_hours_are_zero(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client, "2pn@example.com")
        received = []
        mock = _mock_wb_client()
        mock.set_campaign_hours = AsyncMock(
            side_effect=lambda advert_id, hours: received.append(hours[:])
        )

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            await client.post(
                "/campaigns/bulk-schedule",
                json={"account_id": account_id, "advert_ids": [20], "hours": SCHEDULE_2PEAKS},
                headers=auth,
            )
        hours = received[0]
        for h in range(6):
            assert hours[h] == 0, f"Час {h} должен быть 0%"

    # ── 32. Паттерн «2 пика»: пик 10-13 = 100% ───────────────────────────────

    @pytest.mark.asyncio
    async def test_2peaks_first_peak_hours_are_100(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client, "2pp1@example.com")
        received = []
        mock = _mock_wb_client()
        mock.set_campaign_hours = AsyncMock(
            side_effect=lambda advert_id, hours: received.append(hours[:])
        )

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            await client.post(
                "/campaigns/bulk-schedule",
                json={"account_id": account_id, "advert_ids": [30], "hours": SCHEDULE_2PEAKS},
                headers=auth,
            )
        hours = received[0]
        for h in range(10, 14):
            assert hours[h] == 100, f"Час {h} должен быть 100%"

    # ── 33. Паттерн «2 пика»: второй пик 19-22 = 100% ────────────────────────

    @pytest.mark.asyncio
    async def test_2peaks_second_peak_hours_are_100(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client, "2pp2@example.com")
        received = []
        mock = _mock_wb_client()
        mock.set_campaign_hours = AsyncMock(
            side_effect=lambda advert_id, hours: received.append(hours[:])
        )

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            await client.post(
                "/campaigns/bulk-schedule",
                json={"account_id": account_id, "advert_ids": [40], "hours": SCHEDULE_2PEAKS},
                headers=auth,
            )
        hours = received[0]
        for h in range(19, 23):
            assert hours[h] == 100, f"Час {h} должен быть 100%"

    # ── 34. Паттерн «2 пика»: час 23 = 0% ────────────────────────────────────

    @pytest.mark.asyncio
    async def test_2peaks_last_hour_is_zero(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client, "2pl@example.com")
        received = []
        mock = _mock_wb_client()
        mock.set_campaign_hours = AsyncMock(
            side_effect=lambda advert_id, hours: received.append(hours[:])
        )

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            await client.post(
                "/campaigns/bulk-schedule",
                json={"account_id": account_id, "advert_ids": [50], "hours": SCHEDULE_2PEAKS},
                headers=auth,
            )
        assert received[0][23] == 0

    # ── 35. Паттерн «2 пика»: ровно 24 часа ─────────────────────────────────

    @pytest.mark.asyncio
    async def test_2peaks_schedule_has_24_hours(self, client: AsyncClient) -> None:
        assert len(SCHEDULE_2PEAKS) == 24

    # ── 36. Частичная ошибка: 1 из 3 падает ──────────────────────────────────

    @pytest.mark.asyncio
    async def test_partial_failure_reported(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client, "partial@example.com")
        call_count = [0]

        async def _hours(advert_id, hours):
            call_count[0] += 1
            if call_count[0] == 2:
                raise Exception("WB rate limit")

        mock = _mock_wb_client()
        mock.set_campaign_hours = AsyncMock(side_effect=_hours)

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            resp = await client.post(
                "/campaigns/bulk-schedule",
                json={
                    "account_id": account_id,
                    "advert_ids": [1, 2, 3],
                    "hours": SCHEDULE_2PEAKS,
                },
                headers=auth,
            )
        data = resp.json()
        assert data["applied"] == 2
        assert data["total"] == 3
        assert "details" in data

    # ── 37. Все падают → applied=0 ───────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_all_fail_applied_zero(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client, "allfail@example.com")
        mock = _mock_wb_client(hours_raises=Exception("WB down"))

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            resp = await client.post(
                "/campaigns/bulk-schedule",
                json={
                    "account_id": account_id,
                    "advert_ids": [1, 2, 3],
                    "hours": SCHEDULE_2PEAKS,
                },
                headers=auth,
            )
        assert resp.json()["applied"] == 0

    # ── 38. hours != 24 элементов → 400 ──────────────────────────────────────

    @pytest.mark.asyncio
    async def test_wrong_hours_length_returns_400(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client, "badhours@example.com")
        mock = _mock_wb_client()

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            resp = await client.post(
                "/campaigns/bulk-schedule",
                json={"account_id": account_id, "advert_ids": [1], "hours": [100] * 10},
                headers=auth,
            )
        assert resp.status_code == 400

    # ── 39. Пустой advert_ids → applied=0, ok ────────────────────────────────

    @pytest.mark.asyncio
    async def test_empty_advert_ids_ok(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client, "empty@example.com")
        mock = _mock_wb_client()

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            resp = await client.post(
                "/campaigns/bulk-schedule",
                json={"account_id": account_id, "advert_ids": [], "hours": SCHEDULE_2PEAKS},
                headers=auth,
            )
        assert resp.status_code == 200
        assert resp.json()["applied"] == 0

    # ── 40. Без токена → 401/403 ──────────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_no_auth_bulk_schedule_401(self, client: AsyncClient) -> None:
        resp = await client.post(
            "/campaigns/bulk-schedule",
            json={
                "account_id": str(uuid.uuid4()),
                "advert_ids": [1],
                "hours": SCHEDULE_2PEAKS,
            },
        )
        assert resp.status_code in (401, 403)

    # ── 41. details содержит результат для каждой кампании ───────────────────

    @pytest.mark.asyncio
    async def test_details_contains_all_campaigns(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client, "det@example.com")
        mock = _mock_wb_client()

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            resp = await client.post(
                "/campaigns/bulk-schedule",
                json={
                    "account_id": account_id,
                    "advert_ids": [10, 20, 30],
                    "hours": SCHEDULE_2PEAKS,
                },
                headers=auth,
            )
        details = resp.json()["details"]
        for aid in ["10", "20", "30"]:
            assert aid in details
            assert details[aid] == "ok"

    # ── 42. Паттерн «24/7» — все 100 ─────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_24h_schedule_applied(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client, "24h@example.com")
        received = []
        mock = _mock_wb_client()
        mock.set_campaign_hours = AsyncMock(
            side_effect=lambda advert_id, hours: received.append(hours[:])
        )

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            await client.post(
                "/campaigns/bulk-schedule",
                json={"account_id": account_id, "advert_ids": [1], "hours": SCHEDULE_24H},
                headers=auth,
            )
        assert all(h == 100 for h in received[0])


# ══════════════════════════════════════════════════════════════════════════════
# БЛОК 3: Авто-расписание будни/выходные
# ══════════════════════════════════════════════════════════════════════════════

class TestAutoSchedules:
    """CRUD /campaigns/auto-schedules."""

    async def _setup(self, client: AsyncClient, email: str = "auto@example.com"):
        token = await _register_and_login(client, email)
        account_id = await _create_wb_account(client, token)
        auth = {"Authorization": f"Bearer {token}"}
        return token, account_id, auth

    def _body(self, account_id: str, name: str = "Расписание"):
        return {
            "account_id": account_id,
            "name": name,
            "advert_ids": [10, 20],
            "weekday_hours": SCHEDULE_2PEAKS,
            "weekend_hours": SCHEDULE_DAY,
        }

    # ── 43. Создание авто-расписания ─────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_create_auto_schedule(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client)
        resp = await client.post(
            "/campaigns/auto-schedules",
            json=self._body(account_id),
            headers=auth,
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["name"] == "Расписание"
        assert data["is_active"] is True
        assert data["weekday_hours"] == SCHEDULE_2PEAKS
        assert data["weekend_hours"] == SCHEDULE_DAY

    # ── 44. Список авто-расписаний ────────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_list_auto_schedules(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client, "list_as@example.com")
        await client.post("/campaigns/auto-schedules", json=self._body(account_id, "A"), headers=auth)
        await client.post("/campaigns/auto-schedules", json=self._body(account_id, "B"), headers=auth)

        resp = await client.get(
            f"/campaigns/auto-schedules?account_id={account_id}", headers=auth
        )
        assert resp.status_code == 200
        names = [s["name"] for s in resp.json()]
        assert "A" in names
        assert "B" in names

    # ── 45. Toggle: активное → неактивное ────────────────────────────────────

    @pytest.mark.asyncio
    async def test_toggle_deactivates_schedule(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client, "toggle@example.com")
        created = (await client.post(
            "/campaigns/auto-schedules", json=self._body(account_id), headers=auth
        )).json()
        schedule_id = created["id"]
        assert created["is_active"] is True

        toggled = (await client.patch(
            f"/campaigns/auto-schedules/{schedule_id}/toggle", headers=auth
        )).json()
        assert toggled["is_active"] is False

    # ── 46. Toggle дважды → снова активное ───────────────────────────────────

    @pytest.mark.asyncio
    async def test_toggle_twice_returns_to_active(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client, "toggle2@example.com")
        schedule_id = (await client.post(
            "/campaigns/auto-schedules", json=self._body(account_id), headers=auth
        )).json()["id"]

        await client.patch(f"/campaigns/auto-schedules/{schedule_id}/toggle", headers=auth)
        result = (await client.patch(
            f"/campaigns/auto-schedules/{schedule_id}/toggle", headers=auth
        )).json()
        assert result["is_active"] is True

    # ── 47. Удаление авто-расписания ─────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_delete_auto_schedule(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client, "delete_as@example.com")
        schedule_id = (await client.post(
            "/campaigns/auto-schedules", json=self._body(account_id), headers=auth
        )).json()["id"]

        del_resp = await client.delete(
            f"/campaigns/auto-schedules/{schedule_id}", headers=auth
        )
        assert del_resp.status_code == 204

        # После удаления список пуст
        lst = (await client.get(
            f"/campaigns/auto-schedules?account_id={account_id}", headers=auth
        )).json()
        assert all(s["id"] != schedule_id for s in lst)

    # ── 48. weekday_hours != 24 → 400 ────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_invalid_weekday_hours_returns_400(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client, "wdh@example.com")
        body = self._body(account_id)
        body["weekday_hours"] = [100] * 12

        resp = await client.post("/campaigns/auto-schedules", json=body, headers=auth)
        assert resp.status_code == 400

    # ── 49. weekend_hours != 24 → 400 ────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_invalid_weekend_hours_returns_400(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client, "weh@example.com")
        body = self._body(account_id)
        body["weekend_hours"] = [80] * 5

        resp = await client.post("/campaigns/auto-schedules", json=body, headers=auth)
        assert resp.status_code == 400

    # ── 50. Расписание другого пользователя не видно ─────────────────────────

    @pytest.mark.asyncio
    async def test_user_isolation_auto_schedules(self, client: AsyncClient) -> None:
        token1, account1, auth1 = await self._setup(client, "iso1@example.com")
        token2, account2, auth2 = await self._setup(client, "iso2@example.com")

        # Пользователь 1 создаёт расписание
        await client.post("/campaigns/auto-schedules", json=self._body(account1), headers=auth1)

        # Пользователь 2 видит только своё (пустой список)
        lst = (await client.get(
            f"/campaigns/auto-schedules?account_id={account2}", headers=auth2
        )).json()
        assert lst == []

    # ── 51. Ответ содержит все ожидаемые поля ────────────────────────────────

    @pytest.mark.asyncio
    async def test_auto_schedule_response_fields(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client, "fields_as@example.com")
        resp = await client.post(
            "/campaigns/auto-schedules", json=self._body(account_id), headers=auth
        )
        data = resp.json()
        for field in ("id", "name", "advert_ids", "weekday_hours", "weekend_hours",
                       "is_active", "created_at"):
            assert field in data, f"Поле '{field}' отсутствует в ответе"

    # ── 52. advert_ids сохраняются корректно ─────────────────────────────────

    @pytest.mark.asyncio
    async def test_advert_ids_saved_correctly(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client, "aids@example.com")
        body = self._body(account_id)
        body["advert_ids"] = [111, 222, 333]

        resp = await client.post("/campaigns/auto-schedules", json=body, headers=auth)
        assert resp.json()["advert_ids"] == [111, 222, 333]


# ══════════════════════════════════════════════════════════════════════════════
# БЛОК 4: Установка CPM (set-cpm)
# ══════════════════════════════════════════════════════════════════════════════

class TestSetCpm:
    """POST /campaigns/{advert_id}/set-cpm."""

    async def _setup(self, client: AsyncClient, email: str = "cpm@example.com"):
        token = await _register_and_login(client, email)
        account_id = await _create_wb_account(client, token)
        auth = {"Authorization": f"Bearer {token}"}
        return token, account_id, auth

    # ── 53. Успешная установка CPM для авто-кампании ─────────────────────────

    @pytest.mark.asyncio
    async def test_set_cpm_auto_campaign_ok(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client)
        mock = _mock_wb_client()

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            resp = await client.post(
                "/campaigns/123456/set-cpm",
                json={"account_id": account_id, "cpm": 200, "advert_type": 8, "param": 0},
                headers=auth,
            )
        assert resp.status_code == 204
        mock.set_campaign_cpm.assert_called_once_with(
            advert_id=123456, advert_type=8, cpm=200, param=0
        )

    # ── 54. CPM для поисковой кампании (тип 5) с subject_id ──────────────────

    @pytest.mark.asyncio
    async def test_set_cpm_search_campaign_with_param(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client, "cpm5@example.com")
        mock = _mock_wb_client()

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            resp = await client.post(
                "/campaigns/999/set-cpm",
                json={"account_id": account_id, "cpm": 350, "advert_type": 5, "param": 7777},
                headers=auth,
            )
        assert resp.status_code == 204
        mock.set_campaign_cpm.assert_called_once_with(
            advert_id=999, advert_type=5, cpm=350, param=7777
        )

    # ── 55. WB API ошибка → 502 ───────────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_wb_error_returns_502(self, client: AsyncClient) -> None:
        token, account_id, auth = await self._setup(client, "cpm502@example.com")
        mock = _mock_wb_client(cpm_raises=Exception("WB API error"))

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            resp = await client.post(
                "/campaigns/777/set-cpm",
                json={"account_id": account_id, "cpm": 100, "advert_type": 8, "param": 0},
                headers=auth,
            )
        assert resp.status_code == 502

    # ── 56. Неверный account_id → 404 ────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_invalid_account_returns_404_cpm(self, client: AsyncClient) -> None:
        token = await _register_and_login(client, "cpm404@example.com")
        mock = _mock_wb_client()

        with patch("marketcore.ingestor.wb_client.WBClient", return_value=mock):
            resp = await client.post(
                "/campaigns/111/set-cpm",
                json={
                    "account_id": str(uuid.uuid4()),
                    "cpm": 100,
                    "advert_type": 8,
                    "param": 0,
                },
                headers={"Authorization": f"Bearer {token}"},
            )
        assert resp.status_code == 404

    # ── 57. Без токена → 401/403 ──────────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_no_auth_set_cpm_401(self, client: AsyncClient) -> None:
        resp = await client.post(
            "/campaigns/1/set-cpm",
            json={"account_id": str(uuid.uuid4()), "cpm": 100, "advert_type": 8, "param": 0},
        )
        assert resp.status_code in (401, 403)
