import uuid
from datetime import datetime, timedelta, timezone

import bcrypt as _bcrypt
from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from marketcore.config import settings
from marketcore.models import Session, User

ALGORITHM = "HS256"


def hash_password(password: str) -> str:
    return _bcrypt.hashpw(password.encode("utf-8"), _bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    return _bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))


def create_access_token(user_id: uuid.UUID) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.jwt_access_token_expire_minutes)
    return jwt.encode(
        {"sub": str(user_id), "exp": expire, "type": "access"},
        settings.jwt_secret_key,
        algorithm=ALGORITHM,
    )


def create_refresh_token(user_id: uuid.UUID) -> str:
    expire = datetime.now(timezone.utc) + timedelta(days=settings.jwt_refresh_token_expire_days)
    return jwt.encode(
        {"sub": str(user_id), "exp": expire, "type": "refresh", "jti": str(uuid.uuid4())},
        settings.jwt_secret_key,
        algorithm=ALGORITHM,
    )


def decode_token(token: str) -> dict:  # type: ignore[type-arg]
    try:
        return jwt.decode(token, settings.jwt_secret_key, algorithms=[ALGORITHM])
    except JWTError as e:
        raise ValueError("Недействительный токен") from e


async def register_user(db: AsyncSession, email: str, password: str) -> User:
    existing = await db.scalar(select(User).where(User.email == email))
    if existing:
        raise ValueError("Пользователь с таким email уже существует")

    user = User(email=email, hashed_password=hash_password(password))
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


async def login_user(db: AsyncSession, email: str, password: str) -> tuple[str, str]:
    user = await db.scalar(select(User).where(User.email == email))
    if not user or not verify_password(password, user.hashed_password):
        raise ValueError("Неверный email или пароль")
    if not user.is_active:
        raise ValueError("Аккаунт заблокирован")

    refresh_token = create_refresh_token(user.id)
    expires_at = datetime.now(timezone.utc) + timedelta(days=settings.jwt_refresh_token_expire_days)

    session = Session(user_id=user.id, refresh_token=refresh_token, expires_at=expires_at)
    db.add(session)
    await db.commit()

    return create_access_token(user.id), refresh_token


async def logout_user(db: AsyncSession, refresh_token: str) -> None:
    """Деактивировать сессию по refresh_token. Если токен не найден — игнорируем."""
    db_session = await db.scalar(
        select(Session).where(Session.refresh_token == refresh_token, Session.is_active == True)  # noqa: E712
    )
    if db_session:
        db_session.is_active = False
        await db.commit()


async def refresh_tokens(db: AsyncSession, refresh_token: str) -> tuple[str, str]:
    payload = decode_token(refresh_token)
    if payload.get("type") != "refresh":
        raise ValueError("Неверный тип токена")

    db_session = await db.scalar(
        select(Session).where(Session.refresh_token == refresh_token, Session.is_active == True)  # noqa: E712
    )
    if not db_session:
        raise ValueError("Сессия не найдена или истекла")

    # Ротация: старый токен деактивируем, выдаём новый
    db_session.is_active = False
    user_id = uuid.UUID(payload["sub"])
    new_refresh = create_refresh_token(user_id)
    expires_at = datetime.now(timezone.utc) + timedelta(days=settings.jwt_refresh_token_expire_days)

    new_session = Session(user_id=user_id, refresh_token=new_refresh, expires_at=expires_at)
    db.add(new_session)
    await db.commit()

    return create_access_token(user_id), new_refresh
