import redis

from marketcore.config import settings

_r = redis.from_url(settings.redis_url, decode_responses=True)

FAILURE_THRESHOLD = 5
COOLDOWN_SECONDS = 300


def _failure_key(account_id: str, task: str) -> str:
    return f"cb:failures:{task}:{account_id}"


def _cooldown_key(account_id: str, task: str) -> str:
    return f"cb:cooldown:{task}:{account_id}"


def is_open(account_id: str, task: str) -> bool:
    return bool(_r.exists(_cooldown_key(account_id, task)))


def record_success(account_id: str, task: str) -> None:
    _r.delete(_failure_key(account_id, task))


def record_failure(account_id: str, task: str) -> None:
    key = _failure_key(account_id, task)
    failures = _r.incr(key)
    if failures == 1:
        _r.expire(key, 3600)
    if failures >= FAILURE_THRESHOLD:
        _r.setex(_cooldown_key(account_id, task), COOLDOWN_SECONDS, "1")
        _r.delete(key)
