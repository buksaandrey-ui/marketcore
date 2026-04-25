from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from marketcore.api.routes import (
    accounts,
    analytics,
    auth,
    benchmarks,
    bidding,
    bidding_executions,
    campaigns,
    schedules,
)
from marketcore.config import settings
from marketcore.scheduler import start_scheduler, stop_scheduler


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Запускаем APScheduler внутри процесса FastAPI (без Redis, без Celery).
    # Он сам каждые 15 минут пройдёт по расписаниям и запишет в rule_executions.
    start_scheduler()
    try:
        yield
    finally:
        stop_scheduler()


app = FastAPI(
    title="MarketCore API",
    description="Автоматизация продаж на Wildberries и Ozon",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(accounts.router)
app.include_router(analytics.router)
app.include_router(bidding.router)
app.include_router(bidding_executions.router)
app.include_router(schedules.router)
app.include_router(benchmarks.router)
app.include_router(campaigns.router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
