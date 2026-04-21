import pytest
from httpx import AsyncClient


async def _register_and_login(client: AsyncClient) -> str:
    await client.post("/auth/register", json={"email": "seller@example.com", "password": "securepass123"})
    resp = await client.post("/auth/login", json={"email": "seller@example.com", "password": "securepass123"})
    return resp.json()["access_token"]


@pytest.mark.asyncio
async def test_create_account(client: AsyncClient) -> None:
    token = await _register_and_login(client)
    response = await client.post(
        "/accounts",
        json={"marketplace": "wb", "name": "Мой кабинет WB", "seller_id": "123456", "api_key": "test-api-key"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 201
    data = response.json()
    assert data["marketplace"] == "wb"
    assert data["status"] == "pending"
    assert data["name"] == "Мой кабинет WB"


@pytest.mark.asyncio
async def test_create_account_invalid_marketplace(client: AsyncClient) -> None:
    token = await _register_and_login(client)
    response = await client.post(
        "/accounts",
        json={"marketplace": "amazon", "name": "Тест", "seller_id": "123", "api_key": "key"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_list_accounts(client: AsyncClient) -> None:
    token = await _register_and_login(client)
    await client.post(
        "/accounts",
        json={"marketplace": "wb", "name": "WB", "seller_id": "111", "api_key": "key1"},
        headers={"Authorization": f"Bearer {token}"},
    )
    await client.post(
        "/accounts",
        json={"marketplace": "ozon", "name": "Ozon", "seller_id": "222", "api_key": "key2"},
        headers={"Authorization": f"Bearer {token}"},
    )
    response = await client.get("/accounts", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200
    assert len(response.json()) == 2


@pytest.mark.asyncio
async def test_delete_account(client: AsyncClient) -> None:
    token = await _register_and_login(client)
    create = await client.post(
        "/accounts",
        json={"marketplace": "wb", "name": "Удалить", "seller_id": "999", "api_key": "key"},
        headers={"Authorization": f"Bearer {token}"},
    )
    account_id = create.json()["id"]
    response = await client.delete(f"/accounts/{account_id}", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 204

    accounts = await client.get("/accounts", headers={"Authorization": f"Bearer {token}"})
    assert len(accounts.json()) == 0


@pytest.mark.asyncio
async def test_unauthorized_access(client: AsyncClient) -> None:
    response = await client.get("/accounts")
    assert response.status_code == 403 or response.status_code == 401
