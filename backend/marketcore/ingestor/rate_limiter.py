import time

import redis

from marketcore.config import settings

_r = redis.from_url(settings.redis_url, decode_responses=True)

MAX_REQUESTS_PER_MINUTE = 60


def acquire(account_id: str) -> bool:
    key = f"ratelimit:{account_id}:{int(time.time()) // 60}"
    count = _r.incr(key)
    if count == 1:
        _r.expire(key, 120)
    return count <= MAX_REQUESTS_PER_MINUTE
