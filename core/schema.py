from __future__ import annotations

from sqlalchemy import inspect, text

from core.db import _engine
from core.models import Base


def init_db() -> None:
    Base.metadata.create_all(bind=_engine)
    _ensure_portfolio_schema()


def _ensure_portfolio_schema() -> None:
    inspector = inspect(_engine)

    try:
        trade_columns = {c["name"] for c in inspector.get_columns("portfolio_trades")}
        if "source" not in trade_columns:
            with _engine.begin() as conn:
                conn.execute(text("ALTER TABLE portfolio_trades ADD COLUMN source VARCHAR DEFAULT 'manual'"))
    except Exception:
        pass
