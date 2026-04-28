import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from marketcore.api.main import app
from marketcore.database import Base, get_db

TEST_DATABASE_URL = "postgresql+asyncpg://marketcore:devpassword@localhost:5432/marketcore_dev"

test_engine = create_async_engine(TEST_DATABASE_URL)
TestSessionLocal = async_sessionmaker(test_engine, expire_on_commit=False)


async def _reset_schema(conn) -> None:
    """Пересоздаём схему с CASCADE — корректно убивает materialized views и FK."""
    await conn.execute(text("DROP SCHEMA public CASCADE"))
    await conn.execute(text("CREATE SCHEMA public"))
    await conn.execute(text("GRANT ALL ON SCHEMA public TO PUBLIC"))


@pytest_asyncio.fixture(scope="session", loop_scope="session", autouse=True)
async def setup_db() -> None:
    async with test_engine.begin() as conn:
        await _reset_schema(conn)
        await conn.run_sync(Base.metadata.create_all)
    yield
    async with test_engine.begin() as conn:
        await _reset_schema(conn)


@pytest_asyncio.fixture(loop_scope="session")
async def db() -> AsyncSession:
    async with TestSessionLocal() as session:
        yield session
        for table in reversed(Base.metadata.sorted_tables):
            await session.execute(table.delete())
        await session.commit()


@pytest_asyncio.fixture(loop_scope="session")
async def client(db: AsyncSession) -> AsyncClient:
    app.dependency_overrides[get_db] = lambda: db
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()
