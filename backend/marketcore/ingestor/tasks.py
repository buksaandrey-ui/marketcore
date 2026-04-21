import asyncio
from datetime import datetime, timedelta, timezone

from celery.utils.log import get_task_logger

from marketcore.celery_app import celery_app
from marketcore.ingestor import circuit_breaker, rate_limiter

logger = get_task_logger(__name__)


# ── Dispatcher tasks (scheduled by Beat, fan-out to per-account tasks) ────────

@celery_app.task(name="marketcore.ingestor.tasks.dispatch_pull_orders")
def dispatch_pull_orders() -> None:
    asyncio.run(_dispatch(pull_orders_wb.name, pull_orders_ozon.name))


@celery_app.task(name="marketcore.ingestor.tasks.dispatch_pull_stocks")
def dispatch_pull_stocks() -> None:
    asyncio.run(_dispatch(pull_stocks_wb.name, pull_stocks_ozon.name))


@celery_app.task(name="marketcore.ingestor.tasks.dispatch_pull_prices")
def dispatch_pull_prices() -> None:
    asyncio.run(_dispatch(pull_prices_wb.name, pull_prices_ozon.name))


@celery_app.task(name="marketcore.ingestor.tasks.dispatch_pull_ad_stats")
def dispatch_pull_ad_stats() -> None:
    asyncio.run(_dispatch(pull_ad_stats_wb.name, pull_ad_stats_ozon.name))


async def _dispatch(wb_task: str, ozon_task: str) -> None:
    from marketcore.ingestor.db import get_active_accounts
    accounts = await get_active_accounts()
    for account in accounts:
        task_name = wb_task if account.marketplace == "wb" else ozon_task
        celery_app.send_task(task_name, args=[str(account.id)])


# ── WB tasks ──────────────────────────────────────────────────────────────────

@celery_app.task(name="marketcore.ingestor.tasks.pull_orders_wb", bind=True, max_retries=3)
def pull_orders_wb(self, account_id: str) -> dict:  # type: ignore[override]
    return asyncio.run(_pull_orders_wb(self, account_id))


@celery_app.task(name="marketcore.ingestor.tasks.pull_stocks_wb", bind=True, max_retries=3)
def pull_stocks_wb(self, account_id: str) -> dict:  # type: ignore[override]
    return asyncio.run(_pull_stocks_wb(self, account_id))


@celery_app.task(name="marketcore.ingestor.tasks.pull_prices_wb", bind=True, max_retries=3)
def pull_prices_wb(self, account_id: str) -> dict:  # type: ignore[override]
    return asyncio.run(_pull_prices_wb(self, account_id))


@celery_app.task(name="marketcore.ingestor.tasks.pull_ad_stats_wb", bind=True, max_retries=3)
def pull_ad_stats_wb(self, account_id: str) -> dict:  # type: ignore[override]
    return asyncio.run(_pull_ad_stats_wb(self, account_id))


# ── Ozon tasks ────────────────────────────────────────────────────────────────

@celery_app.task(name="marketcore.ingestor.tasks.pull_orders_ozon", bind=True, max_retries=3)
def pull_orders_ozon(self, account_id: str) -> dict:  # type: ignore[override]
    return asyncio.run(_pull_orders_ozon(self, account_id))


@celery_app.task(name="marketcore.ingestor.tasks.pull_stocks_ozon", bind=True, max_retries=3)
def pull_stocks_ozon(self, account_id: str) -> dict:  # type: ignore[override]
    return asyncio.run(_pull_stocks_ozon(self, account_id))


@celery_app.task(name="marketcore.ingestor.tasks.pull_prices_ozon", bind=True, max_retries=3)
def pull_prices_ozon(self, account_id: str) -> dict:  # type: ignore[override]
    return asyncio.run(_pull_prices_ozon(self, account_id))


@celery_app.task(name="marketcore.ingestor.tasks.pull_ad_stats_ozon", bind=True, max_retries=3)
def pull_ad_stats_ozon(self, account_id: str) -> dict:  # type: ignore[override]
    return asyncio.run(_pull_ad_stats_ozon(self, account_id))


# ── Async implementations ─────────────────────────────────────────────────────

async def _pull_orders_wb(task: object, account_id: str) -> dict:
    task_name = "pull_orders_wb"
    if circuit_breaker.is_open(account_id, task_name):
        logger.warning("Circuit open for %s %s", task_name, account_id)
        return {"status": "circuit_open"}
    if not rate_limiter.acquire(account_id):
        raise _retry(task, countdown=60)
    try:
        from marketcore.ingestor.db import get_account_with_key, save_orders_wb
        from marketcore.ingestor.wb_client import WBClient
        account, api_key = await get_account_with_key(account_id)
        date_from = datetime.now(timezone.utc) - timedelta(hours=24)
        orders = await WBClient(api_key).get_orders(date_from)
        count = await save_orders_wb(account_id, orders)
        circuit_breaker.record_success(account_id, task_name)
        return {"status": "ok", "count": count}
    except Exception as exc:
        circuit_breaker.record_failure(account_id, task_name)
        logger.exception("pull_orders_wb failed for %s", account_id)
        raise _retry(task, exc=exc)


async def _pull_stocks_wb(task: object, account_id: str) -> dict:
    task_name = "pull_stocks_wb"
    if circuit_breaker.is_open(account_id, task_name):
        return {"status": "circuit_open"}
    if not rate_limiter.acquire(account_id):
        raise _retry(task, countdown=60)
    try:
        from marketcore.ingestor.db import get_account_with_key, save_stocks_wb
        from marketcore.ingestor.wb_client import WBClient
        account, api_key = await get_account_with_key(account_id)
        date_from = datetime.now(timezone.utc) - timedelta(days=1)
        stocks = await WBClient(api_key).get_stocks(date_from)
        count = await save_stocks_wb(account_id, stocks)
        circuit_breaker.record_success(account_id, task_name)
        return {"status": "ok", "count": count}
    except Exception as exc:
        circuit_breaker.record_failure(account_id, task_name)
        logger.exception("pull_stocks_wb failed for %s", account_id)
        raise _retry(task, exc=exc)


async def _pull_prices_wb(task: object, account_id: str) -> dict:
    task_name = "pull_prices_wb"
    if circuit_breaker.is_open(account_id, task_name):
        return {"status": "circuit_open"}
    if not rate_limiter.acquire(account_id):
        raise _retry(task, countdown=60)
    try:
        from marketcore.ingestor.db import get_account_with_key, save_prices_wb
        from marketcore.ingestor.wb_client import WBClient
        account, api_key = await get_account_with_key(account_id)
        goods = await WBClient(api_key).get_prices()
        count = await save_prices_wb(account_id, goods)
        circuit_breaker.record_success(account_id, task_name)
        return {"status": "ok", "count": count}
    except Exception as exc:
        circuit_breaker.record_failure(account_id, task_name)
        logger.exception("pull_prices_wb failed for %s", account_id)
        raise _retry(task, exc=exc)


async def _pull_ad_stats_wb(task: object, account_id: str) -> dict:
    task_name = "pull_ad_stats_wb"
    if circuit_breaker.is_open(account_id, task_name):
        return {"status": "circuit_open"}
    if not rate_limiter.acquire(account_id):
        raise _retry(task, countdown=60)
    try:
        from marketcore.ingestor.db import get_account_with_key, save_ad_stats_wb
        from marketcore.ingestor.wb_client import WBClient
        account, api_key = await get_account_with_key(account_id)
        now = datetime.now(timezone.utc)
        date_from = (now - timedelta(days=1)).strftime("%Y-%m-%d")
        date_to = now.strftime("%Y-%m-%d")
        stats = await WBClient(api_key).get_ad_stats(date_from, date_to)
        count = await save_ad_stats_wb(account_id, stats)
        circuit_breaker.record_success(account_id, task_name)
        return {"status": "ok", "count": count}
    except Exception as exc:
        circuit_breaker.record_failure(account_id, task_name)
        logger.exception("pull_ad_stats_wb failed for %s", account_id)
        raise _retry(task, exc=exc)


async def _pull_orders_ozon(task: object, account_id: str) -> dict:
    task_name = "pull_orders_ozon"
    if circuit_breaker.is_open(account_id, task_name):
        return {"status": "circuit_open"}
    if not rate_limiter.acquire(account_id):
        raise _retry(task, countdown=60)
    try:
        from marketcore.ingestor.db import get_account_with_key, save_orders_ozon
        from marketcore.ingestor.ozon_client import OzonClient
        account, api_key = await get_account_with_key(account_id)
        date_from = datetime.now(timezone.utc) - timedelta(hours=24)
        postings = await OzonClient(account.seller_id, api_key).get_orders(date_from)
        count = await save_orders_ozon(account_id, postings)
        circuit_breaker.record_success(account_id, task_name)
        return {"status": "ok", "count": count}
    except Exception as exc:
        circuit_breaker.record_failure(account_id, task_name)
        logger.exception("pull_orders_ozon failed for %s", account_id)
        raise _retry(task, exc=exc)


async def _pull_stocks_ozon(task: object, account_id: str) -> dict:
    task_name = "pull_stocks_ozon"
    if circuit_breaker.is_open(account_id, task_name):
        return {"status": "circuit_open"}
    if not rate_limiter.acquire(account_id):
        raise _retry(task, countdown=60)
    try:
        from marketcore.ingestor.db import get_account_with_key, save_stocks_ozon
        from marketcore.ingestor.ozon_client import OzonClient
        account, api_key = await get_account_with_key(account_id)
        stocks = await OzonClient(account.seller_id, api_key).get_stocks()
        count = await save_stocks_ozon(account_id, stocks)
        circuit_breaker.record_success(account_id, task_name)
        return {"status": "ok", "count": count}
    except Exception as exc:
        circuit_breaker.record_failure(account_id, task_name)
        logger.exception("pull_stocks_ozon failed for %s", account_id)
        raise _retry(task, exc=exc)


async def _pull_prices_ozon(task: object, account_id: str) -> dict:
    task_name = "pull_prices_ozon"
    if circuit_breaker.is_open(account_id, task_name):
        return {"status": "circuit_open"}
    if not rate_limiter.acquire(account_id):
        raise _retry(task, countdown=60)
    try:
        from marketcore.ingestor.db import get_account_with_key, save_prices_ozon
        from marketcore.ingestor.ozon_client import OzonClient
        account, api_key = await get_account_with_key(account_id)
        items = await OzonClient(account.seller_id, api_key).get_prices()
        count = await save_prices_ozon(account_id, items)
        circuit_breaker.record_success(account_id, task_name)
        return {"status": "ok", "count": count}
    except Exception as exc:
        circuit_breaker.record_failure(account_id, task_name)
        logger.exception("pull_prices_ozon failed for %s", account_id)
        raise _retry(task, exc=exc)


async def _pull_ad_stats_ozon(task: object, account_id: str) -> dict:
    task_name = "pull_ad_stats_ozon"
    if circuit_breaker.is_open(account_id, task_name):
        return {"status": "circuit_open"}
    if not rate_limiter.acquire(account_id):
        raise _retry(task, countdown=60)
    try:
        from marketcore.ingestor.db import get_account_with_key, save_ad_stats_ozon
        from marketcore.ingestor.ozon_client import OzonClient
        account, api_key = await get_account_with_key(account_id)
        now = datetime.now(timezone.utc)
        date_from = (now - timedelta(days=1)).strftime("%Y-%m-%d")
        date_to = now.strftime("%Y-%m-%d")
        stats = await OzonClient(account.seller_id, api_key).get_ad_stats(date_from, date_to)
        count = await save_ad_stats_ozon(account_id, stats)
        circuit_breaker.record_success(account_id, task_name)
        return {"status": "ok", "count": count}
    except Exception as exc:
        circuit_breaker.record_failure(account_id, task_name)
        logger.exception("pull_ad_stats_ozon failed for %s", account_id)
        raise _retry(task, exc=exc)


def _retry(task: object, exc: Exception | None = None, countdown: int = 30) -> Exception:
    retries = getattr(getattr(task, "request", None), "retries", 0)
    return task.retry(exc=exc, countdown=countdown * (retries + 1))  # type: ignore[union-attr]
