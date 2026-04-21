from celery import Celery

from marketcore.config import settings

celery_app = Celery(
    "marketcore",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=["marketcore.ingestor.tasks"],
)

celery_app.conf.beat_schedule = {
    "dispatch-pull-orders": {
        "task": "marketcore.ingestor.tasks.dispatch_pull_orders",
        "schedule": 300.0,
    },
    "dispatch-pull-stocks": {
        "task": "marketcore.ingestor.tasks.dispatch_pull_stocks",
        "schedule": 600.0,
    },
    "dispatch-pull-prices": {
        "task": "marketcore.ingestor.tasks.dispatch_pull_prices",
        "schedule": 900.0,
    },
    "dispatch-pull-ad-stats": {
        "task": "marketcore.ingestor.tasks.dispatch_pull_ad_stats",
        "schedule": 1800.0,
    },
}

celery_app.conf.timezone = "UTC"
celery_app.conf.task_serializer = "json"
celery_app.conf.result_serializer = "json"
celery_app.conf.accept_content = ["json"]
