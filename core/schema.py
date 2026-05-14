from __future__ import annotations

from sqlalchemy import inspect, text

from core.db import _engine
from core.models import Base


def init_db() -> None:
    Base.metadata.create_all(bind=_engine)
    _ensure_portfolio_schema()
    # Force WAL checkpoint to prevent data loss during container restarts
    try:
        with _engine.begin() as conn:
            conn.execute(text("PRAGMA wal_checkpoint(TRUNCATE)"))
    except Exception:
        pass


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
        if "symbol" not in trade_columns:
            with _engine.begin() as conn:
                conn.execute(text("ALTER TABLE portfolio_trades ADD COLUMN symbol VARCHAR"))
        if "name" not in trade_columns:
            with _engine.begin() as conn:
                conn.execute(text("ALTER TABLE portfolio_trades ADD COLUMN name VARCHAR"))
        if "market" not in trade_columns:
            with _engine.begin() as conn:
                conn.execute(text("ALTER TABLE portfolio_trades ADD COLUMN market VARCHAR"))
    except Exception:
        pass

    try:
        auto_trade_columns = {c["name"] for c in inspector.get_columns("portfolio_auto_trades")}
        if "source" not in auto_trade_columns:
            with _engine.begin() as conn:
                conn.execute(text("ALTER TABLE portfolio_auto_trades ADD COLUMN source VARCHAR DEFAULT 'auto_order'"))
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
                existing = conn.execute(
                    text("SELECT COUNT(*) FROM portfolio_agent_configs WHERE id = :aid"),
                    {"aid": aid},
                ).scalar()
                if not existing:
                    conn.execute(
                        text("INSERT INTO portfolio_agent_configs(id, enabled, capital, agent_type) VALUES(:aid, '0', 10000000.0, :atype)"),
                        {"aid": aid, "atype": atype},
                    )
        except Exception:
            pass

    _migrate_position_source_split()


def _source_bucket_from_trade_source(trade_source: str) -> str:
    s = (trade_source or "manual").strip()
    if s == "manual":
        return "manual"
    if s.startswith("auto_strategy_"):
        return s[len("auto_strategy_"):]
    if s == "auto_strategy":
        return "a"
    if s == "auto_order":
        return "manual"
    return "manual"


def _migrate_position_source_split() -> None:
    inspector = inspect(_engine)
    try:
        pos_columns = {c["name"] for c in inspector.get_columns("portfolio_positions")}
    except Exception:
        return
    if "source" in pos_columns:
        return

    with _engine.begin() as conn:
        # PRAGMA foreign_keys must be OFF for table rebuild in SQLite
        conn.execute(text("PRAGMA foreign_keys = OFF"))

        # Step 1: Create new table (drop any leftover from failed migration)
        try:
            conn.execute(text("DROP TABLE IF EXISTS portfolio_positions_new"))
        except Exception:
            pass
        conn.execute(text("""
            CREATE TABLE portfolio_positions_new (
                id VARCHAR NOT NULL,
                market VARCHAR NOT NULL,
                symbol VARCHAR NOT NULL,
                name VARCHAR,
                source VARCHAR NOT NULL DEFAULT 'manual',
                quantity FLOAT DEFAULT 0.0,
                avg_cost FLOAT DEFAULT 0.0,
                target_buy_price FLOAT,
                target_sell_price FLOAT,
                created_at INTEGER,
                updated_at INTEGER,
                PRIMARY KEY (id),
                UNIQUE (market, symbol, source)
            )
        """))

        # Step 2: Fetch all existing positions and trades (use index-based access to avoid AttributeError on text columns)
        old_positions = conn.execute(text("SELECT id, market, symbol, name, quantity, avg_cost, target_buy_price, target_sell_price, created_at, updated_at FROM portfolio_positions")).fetchall()
        all_trades = conn.execute(text("SELECT id, position_id, side, quantity, price, fee, source, market, name, symbol FROM portfolio_trades ORDER BY position_id, created_at, id")).fetchall()

        # Step 3: Compute per-source holdings via FIFO for each position
        import uuid
        _by_pos = {}
        for t in all_trades:
            pid = t[1]  # position_id
            _by_pos.setdefault(pid, []).append(t)

        # Map: original_position_id -> {source: new_position_id}
        pos_source_map = {}

        for pid, items in _by_pos.items():
            items.sort(key=lambda x: (x[8] or 0, x[0] or ""))  # created_at(8), id(0)
            lots = []
            source_tracker = {}
            for t in items:
                # id(0), position_id(1), side(2), quantity(3), price(4), fee(5), source(6), market(7), name(8), symbol(9)
                side = (t[2] or "").strip().upper()
                qty = float(t[3] or 0.0)
                if qty <= 0:
                    continue
                if side == "BUY":
                    bucket = _source_bucket_from_trade_source(t[6] or "manual")
                    lots.append({"bucket": bucket, "qty": qty, "price": float(t[4] or 0.0), "fee": float(t[5] or 0.0) / qty if qty > 0 else 0.0})
                elif side == "SELL":
                    remaining = qty
                    sell_bucket = _source_bucket_from_trade_source(t[6] or "manual")
                    while remaining > 1e-9 and lots:
                        idx = next((i for i, lot in enumerate(lots) if lot.get("bucket") == sell_bucket), None)
                        if idx is None:
                            idx = 0
                        lot = lots[idx]
                        used = min(remaining, float(lot["qty"]))
                        lot["qty"] = float(lot["qty"]) - used
                        remaining -= used
                        if float(lot["qty"]) <= 1e-9:
                            lots.pop(idx)

            for lot in lots:
                bucket = lot["bucket"]
                lot_qty = float(lot["qty"])
                if lot_qty <= 0:
                    continue
                st = source_tracker.get(bucket)
                if st is None:
                    st = {"qty": 0.0, "total_cost": 0.0}
                    source_tracker[bucket] = st
                st["qty"] += lot_qty
                st["total_cost"] += lot_qty * (float(lot["price"]) + float(lot.get("fee", 0.0)))

            # pos_row: id(0), market(1), symbol(2), name(3), quantity(4), avg_cost(5),
            # target_buy_price(6), target_sell_price(7), created_at(8), updated_at(9)
            pos_row = next((p for p in old_positions if p[0] == pid), None)
            pos_name = pos_row[3] if pos_row else None
            pos_market = pos_row[1] if pos_row else "CN"
            pos_symbol = pos_row[2] if pos_row else ""

            pid_sources = {}
            for src, st in source_tracker.items():
                new_id = str(uuid.uuid4())
                pos_source_map.setdefault(pid, {})[src] = new_id
                pid_sources[new_id] = {"source": src, "qty": st["qty"], "cost": st["total_cost"]}
                conn.execute(text("""
                    INSERT INTO portfolio_positions_new (id, market, symbol, name, source, quantity, avg_cost, created_at, updated_at)
                    VALUES (:id, :market, :symbol, :name, :source, :qty, :avg_cost, :created_at, :updated_at)
                """), {
                    "id": new_id,
                    "market": pos_market,
                    "symbol": pos_symbol,
                    "name": pos_name,
                    "source": src,
                    "qty": st["qty"],
                    "avg_cost": st["total_cost"] / st["qty"] if st["qty"] > 0 else 0.0,
                    "created_at": int(pos_row[8] or 0) if pos_row else 0,
                    "updated_at": int(pos_row[9] or 0) if pos_row else 0,
                })

        # Copy positions that have no trades (keep as manual)
        traded_pids = set(pos_source_map.keys())
        for p in old_positions:
            if p[0] not in traded_pids:
                new_id = str(uuid.uuid4())
                pos_source_map.setdefault(p[0], {})["manual"] = new_id
                conn.execute(text("""
                    INSERT INTO portfolio_positions_new (id, market, symbol, name, source, quantity, avg_cost, created_at, updated_at)
                    VALUES (:id, :market, :symbol, :name, 'manual', :qty, :avg_cost, :created_at, :updated_at)
                """), {
                    "id": new_id,
                    "market": p[1],
                    "symbol": p[2],
                    "name": p[3],
                    "qty": float(p[4] or 0.0),
                    "avg_cost": float(p[5] or 0.0),
                    "created_at": int(p[8] or 0),
                    "updated_at": int(p[9] or 0),
                })

        # Step 4: Update portfolio_trades position_id to new source-specific positions
        for t in all_trades:
            # id(0), position_id(1), side(2), quantity(3), price(4), fee(5), source(6), market(7), name(8), symbol(9)
            old_pid = t[1]
            src = _source_bucket_from_trade_source(t[6] or "manual")
            pids = pos_source_map.get(old_pid, {})
            new_pid = pids.get(src)
            if new_pid:
                conn.execute(text("UPDATE portfolio_trades SET position_id=:new_pid WHERE id=:tid"), {"new_pid": new_pid, "tid": t[0]})

        # Step 5: Update portfolio_auto_trades position_id
        all_auto = conn.execute(text("SELECT id, position_id, source FROM portfolio_auto_trades")).fetchall()
        for at in all_auto:
            # id(0), position_id(1), source(2)
            old_pid = at[1]
            src = _source_bucket_from_trade_source(at[2] or "auto_order")
            pids = pos_source_map.get(old_pid, {})
            new_pid = pids.get(src)
            if new_pid:
                conn.execute(text("UPDATE portfolio_auto_trades SET position_id=:new_pid WHERE id=:aid"), {"new_pid": new_pid, "aid": at[0]})

        # Step 6: Drop old table and rename new
        conn.execute(text("DROP TABLE portfolio_positions"))
        conn.execute(text("ALTER TABLE portfolio_positions_new RENAME TO portfolio_positions"))

        # Step 7: Recreate indexes
        conn.execute(text("CREATE INDEX ix_portfolio_positions_market ON portfolio_positions (market)"))
        conn.execute(text("CREATE INDEX ix_portfolio_positions_symbol ON portfolio_positions (symbol)"))
        conn.execute(text("CREATE INDEX ix_portfolio_positions_source ON portfolio_positions (source)"))

        # Step 8: Re-enable foreign keys
        conn.execute(text("PRAGMA foreign_keys = ON"))
