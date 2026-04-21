from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file="../.env", extra="ignore")

    database_url: str = "postgresql+asyncpg://marketcore:devpassword@localhost:5432/marketcore_dev"
    redis_url: str = "redis://localhost:6379/0"

    jwt_secret_key: str = "change-me-to-random-secret-key-in-production"
    jwt_access_token_expire_minutes: int = 15
    jwt_refresh_token_expire_days: int = 30

    encryption_key: str = "change-me-to-32-bytes-key-______"

    environment: str = "development"
    debug: bool = True
    log_level: str = "INFO"

    # Фронтенды которым разрешён доступ (через запятую)
    # Пример: "https://marketcore.vercel.app,http://localhost:5174"
    allowed_origins: str = "http://localhost:5173,http://localhost:5174"

    @field_validator("database_url", mode="before")
    @classmethod
    def fix_db_url(cls, v: str) -> str:
        # Railway отдаёт postgresql:// — SQLAlchemy asyncpg требует postgresql+asyncpg://
        if v.startswith("postgresql://"):
            return v.replace("postgresql://", "postgresql+asyncpg://", 1)
        if v.startswith("postgres://"):
            return v.replace("postgres://", "postgresql+asyncpg://", 1)
        return v

    @property
    def origins_list(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(",") if o.strip()]


settings = Settings()
