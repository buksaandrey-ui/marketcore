from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from marketcore.api.routes import accounts, analytics, auth, benchmarks, bidding, schedules
from marketcore.config import settings

app = FastAPI(
    title="MarketCore API",
    description="Автоматизация продаж на Wildberries и Ozon",
    version="0.1.0",
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
app.include_router(schedules.router)
app.include_router(benchmarks.router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
