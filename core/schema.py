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
        if "fee" not in trade_columns:
            with _engine.begin() as conn:
                conn.execute(text("ALTER TABLE portfolio_trades ADD COLUMN fee FLOAT DEFAULT 0"))
    except Exception:
        pass

    try:
        cfg_columns = {c["name"] for c in inspector.get_columns("portfolio_agent_configs")}
        if "capital" not in cfg_columns:
            with _engine.begin() as conn:
                conn.execute(text("ALTER TABLE portfolio_agent_configs ADD COLUMN capital FLOAT DEFAULT 10000000.0"))
        if "agent_type" not in cfg_columns:
            with _engine.begin() as conn:
                conn.execute(text("ALTER TABLE portfolio_agent_configs ADD COLUMN agent_type VARCHAR DEFAULT 'rules'"))
    except Exception:
        pass

    try:
        with _engine.begin() as conn:
            conn.execute(text("UPDATE portfolio_agent_configs SET id='a' WHERE id='default'"))
    except Exception:
        pass

    try:
        with _engine.begin() as conn:
            conn.execute(text("UPDATE portfolio_trades SET source='auto_strategy_a' WHERE source='auto_strategy'"))
    except Exception:
        pass

    for aid, atype in [("a", "rules"), ("b", "llm")]:
        try:
            with _engine.begin() as conn:
                existing = conn.execute(text(f"SELECT COUNT(*) FROM portfolio_agent_configs WHERE id='{aid}'")).scalar()
                if not existing:
                    conn.execute(text(f"INSERT INTO portfolio_agent_configs(id, enabled, capital, agent_type) VALUES('{aid}', '0', 10000000.0, '{atype}')"))
        except Exception:
            pass
