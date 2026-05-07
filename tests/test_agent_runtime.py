from __future__ import annotations

import importlib
import json
import os
import sys
import tempfile
import time
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch


class AgentRuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._old_app_data_dir = os.environ.get("APP_DATA_DIR")
        cls._tmpdir = tempfile.TemporaryDirectory()
        os.environ["APP_DATA_DIR"] = cls._tmpdir.name
        repo_root = Path(__file__).resolve().parents[1]
        if str(repo_root) not in sys.path:
            sys.path.insert(0, str(repo_root))
        import api as api_module
        import core.db as db_module
        import core.models as models_module
        import core.schema as schema_module

        cls.api = importlib.reload(api_module)
        cls.db = importlib.reload(db_module)
        cls.models = importlib.reload(models_module)
        cls.schema = importlib.reload(schema_module)
        cls.api = importlib.reload(cls.api)
        cls.schema.init_db()

    @classmethod
    def tearDownClass(cls):
        cls._tmpdir.cleanup()
        if cls._old_app_data_dir is None:
            os.environ.pop("APP_DATA_DIR", None)
        else:
            os.environ["APP_DATA_DIR"] = cls._old_app_data_dir

    def setUp(self):
        self.api._AGENT_NEW_PICK_CHECKED.clear()
        with self.db._engine.begin() as conn:
            for table in [
                "portfolio_agent_pick_logs",
                "portfolio_trades",
                "portfolio_positions",
                "portfolio_auto_trades",
                "portfolio_agent_configs",
            ]:
                conn.exec_driver_sql(f"DELETE FROM {table}")
        self.schema.init_db()

    def test_claim_agent_new_pick_slot_hits_lunch_window_within_10_minutes(self):
        real_datetime = self.api._dt.datetime
        fixed_now = real_datetime(2026, 5, 7, 12, 7, 0)

        class FixedDateTime(real_datetime):
            @classmethod
            def now(cls, tz=None):
                if tz is not None:
                    return fixed_now.replace(tzinfo=tz)
                return fixed_now

        with patch.object(self.api._dt, "datetime", FixedDateTime):
            slot = self.api._claim_agent_new_pick_slot("a")

        self.assertEqual(slot, "2026-05-07:12:00")

    def test_claim_agent_new_pick_slot_hits_new_after_close_windows(self):
        real_datetime = self.api._dt.datetime

        class FixedDateTimeA(real_datetime):
            @classmethod
            def now(cls, tz=None):
                value = real_datetime(2026, 5, 7, 16, 5, 0)
                return value.replace(tzinfo=tz) if tz is not None else value

        class FixedDateTimeB(real_datetime):
            @classmethod
            def now(cls, tz=None):
                value = real_datetime(2026, 5, 7, 16, 25, 0)
                return value.replace(tzinfo=tz) if tz is not None else value

        with patch.object(self.api._dt, "datetime", FixedDateTimeA):
            slot_a = self.api._claim_agent_new_pick_slot("a")
        with patch.object(self.api._dt, "datetime", FixedDateTimeB):
            slot_b = self.api._claim_agent_new_pick_slot("b")

        self.assertEqual(slot_a, "2026-05-07:16:00")
        self.assertEqual(slot_b, "2026-05-07:16:20")

    def test_claim_agent_new_pick_slot_hits_latest_after_close_windows(self):
        real_datetime = self.api._dt.datetime

        class FixedDateTimeA(real_datetime):
            @classmethod
            def now(cls, tz=None):
                value = real_datetime(2026, 5, 7, 16, 3, 0)
                return value.replace(tzinfo=tz) if tz is not None else value

        class FixedDateTimeB(real_datetime):
            @classmethod
            def now(cls, tz=None):
                value = real_datetime(2026, 5, 7, 16, 23, 0)
                return value.replace(tzinfo=tz) if tz is not None else value

        with patch.object(self.api._dt, "datetime", FixedDateTimeA):
            slot_a = self.api._claim_agent_new_pick_slot("a")
        with patch.object(self.api._dt, "datetime", FixedDateTimeB):
            slot_b = self.api._claim_agent_new_pick_slot("b")

        self.assertEqual(slot_a, "2026-05-07:16:00")
        self.assertEqual(slot_b, "2026-05-07:16:20")

    def test_llm_agent_accepts_base_symbol_for_existing_holding(self):
        now = int(time.time())
        with self.db.session_scope() as s:
            cfg = s.get(self.models.PortfolioAgentConfig, "b")
            if cfg is None:
                cfg = self.models.PortfolioAgentConfig(id="b")
                s.add(cfg)
                s.flush()
            cfg.enabled = "1"
            cfg.agent_type = "llm"
            cfg.capital = 10_000_000.0
            cfg.min_buy_quantity = 10000.0
            pos = self.models.PortfolioPosition(
                market="CN",
                symbol="600690.SH",
                name="海尔智家",
                quantity=10000.0,
                avg_cost=23.0,
                created_at=now,
                updated_at=now,
            )
            s.add(pos)
            s.flush()
            s.add(self.models.PortfolioTrade(
                position_id=pos.id,
                side="BUY",
                price=23.0,
                quantity=10000.0,
                amount=230000.0,
                fee=0.0,
                source="auto_strategy_b",
                created_at=now,
            ))

        fake_qwen = types.ModuleType("core.llm_qwen")
        fake_qwen.call_llm = lambda *args, **kwargs: json.dumps({
            "action": "buy",
            "symbol": "600690",
            "reason": "加仓测试",
        }, ensure_ascii=False)
        sys.modules["core.llm_qwen"] = fake_qwen

        fake_recommend = types.ModuleType("core.recommend")
        fake_recommend.get_latest_scan = lambda: []
        fake_recommend.run_scan = lambda *args, **kwargs: []
        fake_recommend.save_scan_result = lambda results: None
        sys.modules["core.recommend"] = fake_recommend

        price_obj = types.SimpleNamespace(price=21.44)
        indicator_obj = types.SimpleNamespace(
            ma5=None, ma20=None, ma60=None, rsi14=40.0, trend="下跌",
            strategy_action=None, strategy_stop_loss=None,
            strategy_take_profit_1=None, strategy_take_profit_2=None,
        )
        summary_obj = types.SimpleNamespace(
            agent_a=types.SimpleNamespace(total_market_value=0.0),
            agent_b=types.SimpleNamespace(total_market_value=214400.0),
        )

        with patch.object(self.api, "get_stock_price", return_value=price_obj), \
             patch.object(self.api, "get_stock_indicators", return_value=indicator_obj), \
             patch.object(self.api, "get_portfolio_alerts", return_value=[]), \
             patch.object(self.api, "get_portfolio_summary", return_value=summary_obj), \
             patch.object(self.api, "_cn_market_trading_now", return_value=True):
            with self.db.session_scope() as s:
                cfg = s.get(self.models.PortfolioAgentConfig, "b")
            result = self.api._run_llm_agent_once("b", cfg, allow_new_pick=True, pick_slot_key="2026-05-07:09:50", precomputed_alerts=[])

        self.assertEqual(result.get("message"), "llm_trade_executed")
        trade = ((result.get("trades") or [None])[0] or {})
        self.assertEqual(trade.get("symbol"), "600690.SH")
        self.assertEqual(trade.get("side"), "BUY")

    def test_rule_agent_repeats_buy_when_rule_signal_persists(self):
        now = int(time.time())
        with self.db.session_scope() as s:
            pos = self.models.PortfolioPosition(
                market="CN",
                symbol="600690.SH",
                name="海尔智家",
                quantity=10000.0,
                avg_cost=23.0,
                created_at=now,
                updated_at=now,
            )
            s.add(pos)
            s.flush()
            s.add(self.models.PortfolioTrade(
                position_id=pos.id,
                side="BUY",
                price=23.0,
                quantity=10000.0,
                amount=230000.0,
                fee=0.0,
                source="auto_strategy_a",
                created_at=now,
            ))
            position_id = pos.id

        alert = self.api.PortfolioAlertResponse(
            key=f"{position_id}:strategy_buy_zone:233845",
            position_id=position_id,
            market="CN",
            symbol="600690.SH",
            name="海尔智家",
            alert_type="strategy_buy_zone",
            message="已进入策略买入区间",
            current_price=21.44,
            trigger_price=23.3845,
        )

        first = self.api._execute_strategy_alert_trade(alert, "a")
        second = self.api._execute_strategy_alert_trade(alert, "a")

        self.assertIsNotNone(first)
        self.assertIsNotNone(second)
        self.assertEqual(first.side, "BUY")
        self.assertEqual(second.side, "BUY")

    def test_claim_agent_new_pick_slot_at_16_00(self):
        real_datetime = self.api._dt.datetime

        class FixedDateTime(real_datetime):
            @classmethod
            def now(cls, tz=None):
                value = real_datetime(2026, 5, 7, 16, 4, 0)
                return value.replace(tzinfo=tz) if tz is not None else value

        with patch.object(self.api._dt, "datetime", FixedDateTime):
            slot = self.api._claim_agent_new_pick_slot("a")

        self.assertEqual(slot, "2026-05-07:16:00")

    def test_create_trade_at_price_supports_existing_session(self):
        now = int(time.time())
        with patch.object(self.api, "_send_feishu_trade_notify"):
            with self.db.session_scope() as s:
                pos = self.models.PortfolioPosition(
                    market="CN",
                    symbol="600001.SH",
                    name="测试股票",
                    quantity=0.0,
                    avg_cost=0.0,
                    created_at=now,
                    updated_at=now,
                )
                s.add(pos)
                s.flush()
                trade = self.api._create_trade_at_price(pos.id, "BUY", 10000.0, 10.0, "auto_strategy_a", session=s)
                self.assertIsNotNone(trade)
                self.assertEqual(trade.symbol, "600001.SH")
                self.assertEqual(trade.side, "BUY")

        with self.db.session_scope() as s:
            pos = s.execute(self.api.select(self.models.PortfolioPosition).where(
                self.models.PortfolioPosition.symbol == "600001.SH"
            )).scalars().one()
            trades = s.execute(self.api.select(self.models.PortfolioTrade).where(
                self.models.PortfolioTrade.position_id == pos.id
            )).scalars().all()

        self.assertEqual(float(pos.quantity or 0.0), 10000.0)
        self.assertEqual(len(trades), 1)

    def test_rule_agent_new_pick_executes_buy(self):
        now = int(time.time())
        with self.db.session_scope() as s:
            cfg = s.get(self.models.PortfolioAgentConfig, "a")
            if cfg is None:
                cfg = self.models.PortfolioAgentConfig(id="a")
                s.add(cfg)
                s.flush()
            cfg.enabled = "1"
            cfg.agent_type = "rules"
            cfg.capital = 10_000_000.0
            cfg.min_buy_quantity = 10000.0

        summary_obj = types.SimpleNamespace(
            agent_a=types.SimpleNamespace(total_market_value=0.0),
            agent_b=types.SimpleNamespace(total_market_value=0.0),
        )

        with patch.object(self.api, "get_portfolio_alerts", return_value=[]), \
             patch.object(self.api, "get_portfolio_summary", return_value=summary_obj), \
             patch.object(self.api, "_portfolio_agent_pick_candidates", return_value=[("CN", "600010.SH", "测试一号", 10.0, "积极建仓")]), \
             patch.object(self.api, "_cn_market_trading_now", return_value=True), \
             patch.object(self.api, "_send_feishu_trade_notify"):
            result = self.api._run_portfolio_agent_once("a", allow_new_pick=True, pick_slot_key="2026-05-07:16:55", precomputed_alerts=[])

        self.assertEqual(result.get("message"), "picked_new_stock")
        trade = ((result.get("trades") or [None])[0] or {})
        self.assertEqual(trade.get("symbol"), "600010.SH")
        self.assertEqual(trade.get("side"), "BUY")

    def test_llm_agent_new_pick_executes_buy(self):
        now = int(time.time())
        with self.db.session_scope() as s:
            cfg = s.get(self.models.PortfolioAgentConfig, "b")
            if cfg is None:
                cfg = self.models.PortfolioAgentConfig(id="b")
                s.add(cfg)
                s.flush()
            cfg.enabled = "1"
            cfg.agent_type = "llm"
            cfg.capital = 10_000_000.0
            cfg.min_buy_quantity = 10000.0

        fake_qwen = types.ModuleType("core.llm_qwen")
        fake_qwen.call_llm = lambda *args, **kwargs: json.dumps({
            "action": "buy",
            "symbol": "600011",
            "reason": "新开仓",
        }, ensure_ascii=False)
        sys.modules["core.llm_qwen"] = fake_qwen

        fake_recommend = types.ModuleType("core.recommend")
        fake_recommend.get_latest_scan = lambda: [{
            "market": "CN",
            "symbol": "600011.SH",
            "name": "测试二号",
            "action": "积极建仓",
            "current_price": 12.3,
        }]
        fake_recommend.run_scan = lambda *args, **kwargs: []
        fake_recommend.save_scan_result = lambda results: None
        sys.modules["core.recommend"] = fake_recommend

        price_obj = types.SimpleNamespace(price=12.3)
        summary_obj = types.SimpleNamespace(
            agent_a=types.SimpleNamespace(total_market_value=0.0),
            agent_b=types.SimpleNamespace(total_market_value=0.0),
        )

        with patch.object(self.api, "get_stock_price", return_value=price_obj), \
             patch.object(self.api, "get_stock_indicators", return_value=None), \
             patch.object(self.api, "get_portfolio_alerts", return_value=[]), \
             patch.object(self.api, "get_portfolio_summary", return_value=summary_obj), \
             patch.object(self.api, "_cn_market_trading_now", return_value=True), \
             patch.object(self.api, "_send_feishu_trade_notify"):
            with self.db.session_scope() as s:
                cfg = s.get(self.models.PortfolioAgentConfig, "b")
            result = self.api._run_llm_agent_once("b", cfg, allow_new_pick=True, pick_slot_key="2026-05-07:17:05", precomputed_alerts=[])

        self.assertEqual(result.get("message"), "llm_trade_executed")
        trade = ((result.get("trades") or [None])[0] or {})
        self.assertEqual(trade.get("symbol"), "600011.SH")
        self.assertEqual(trade.get("side"), "BUY")

    def test_llm_agent_does_not_buy_outside_pick_slot(self):
        now = int(time.time())
        with self.db.session_scope() as s:
            cfg = s.get(self.models.PortfolioAgentConfig, "b")
            if cfg is None:
                cfg = self.models.PortfolioAgentConfig(id="b")
                s.add(cfg)
                s.flush()
            cfg.enabled = "1"
            cfg.agent_type = "llm"
            cfg.capital = 10_000_000.0
            cfg.min_buy_quantity = 10000.0

        fake_qwen = types.ModuleType("core.llm_qwen")
        fake_qwen.call_llm = lambda *args, **kwargs: json.dumps({
            "action": "buy",
            "symbol": "600011",
            "reason": "非窗口买入",
        }, ensure_ascii=False)
        sys.modules["core.llm_qwen"] = fake_qwen

        fake_recommend = types.ModuleType("core.recommend")
        fake_recommend.get_latest_scan = lambda: [{
            "market": "CN",
            "symbol": "600011.SH",
            "name": "测试二号",
            "action": "积极建仓",
            "current_price": 12.3,
        }]
        fake_recommend.run_scan = lambda *args, **kwargs: []
        fake_recommend.save_scan_result = lambda results: None
        sys.modules["core.recommend"] = fake_recommend

        price_obj = types.SimpleNamespace(price=12.3)
        summary_obj = types.SimpleNamespace(
            agent_a=types.SimpleNamespace(total_market_value=0.0),
            agent_b=types.SimpleNamespace(total_market_value=0.0),
        )

        with patch.object(self.api, "get_stock_price", return_value=price_obj), \
             patch.object(self.api, "get_stock_indicators", return_value=None), \
             patch.object(self.api, "get_portfolio_alerts", return_value=[]), \
             patch.object(self.api, "get_portfolio_summary", return_value=summary_obj), \
             patch.object(self.api, "_cn_market_trading_now", return_value=True), \
             patch.object(self.api, "_send_feishu_trade_notify"):
            with self.db.session_scope() as s:
                cfg = s.get(self.models.PortfolioAgentConfig, "b")
            result = self.api._run_llm_agent_once("b", cfg, allow_new_pick=False, precomputed_alerts=[])

        self.assertEqual(result.get("message"), "llm_buy_outside_pick_slot")
        with self.db.session_scope() as s:
            trades = s.execute(self.api.select(self.models.PortfolioTrade)).scalars().all()
        self.assertEqual(len(trades), 0)

    def test_log_agent_pick_event_is_non_fatal(self):
        class BrokenContext:
            def __enter__(self):
                raise RuntimeError("db busy")

            def __exit__(self, exc_type, exc, tb):
                return False

        with patch.object(self.api, "session_scope", return_value=BrokenContext()):
            self.api._log_agent_pick_event("a", "2026-05-07:17:30", "slot_entered")

    def test_agent_b_returns_use_agent_owned_lots_only(self):
        now = int(time.time())
        with self.db.session_scope() as s:
            pos = self.models.PortfolioPosition(
                market="CN",
                symbol="600690.SH",
                name="海尔智家",
                quantity=50000.0,
                avg_cost=20.0,
                created_at=now,
                updated_at=now,
            )
            s.add(pos)
            s.flush()
            s.add(self.models.PortfolioTrade(
                position_id=pos.id,
                side="BUY",
                price=18.0,
                quantity=30000.0,
                amount=540000.0,
                fee=0.0,
                source="manual",
                created_at=now - 3600,
            ))
            s.add(self.models.PortfolioTrade(
                position_id=pos.id,
                side="BUY",
                price=21.44,
                quantity=20000.0,
                amount=428800.0,
                fee=0.0,
                source="auto_strategy_b",
                created_at=now - 1800,
            ))

        with self.db.session_scope() as s:
            positions = s.execute(self.api.select(self.models.PortfolioPosition)).scalars().all()
            trades = s.execute(self.api.select(self.models.PortfolioTrade)).scalars().all()
        tz_cn = timezone(timedelta(hours=8))
        now_cn = datetime.now(tz_cn)
        today_ts = int(now_cn.replace(hour=0, minute=0, second=0, microsecond=0).timestamp())
        week_ts = int((now_cn.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=now_cn.weekday())).timestamp())
        month_ts = int(now_cn.replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp())
        periods = self.api._compute_agent_period_returns(trades, positions, {positions[0].id: 21.44}, "b", today_ts, week_ts, month_ts)

        self.assertLess(abs(float(periods.get("unrealized") or 0.0)), 1000.0)

    def test_compute_period_returns_uses_summary_total_for_agent_total_pnl(self):
        summary = self.api.PortfolioSummaryResponse(
            total_cost=0.0,
            total_market_value=0.0,
            unrealized_pnl=0.0,
            unrealized_pnl_pct=0.0,
            realized_pnl=0.0,
            total_trades=0,
            total_buy_amount=0.0,
            total_hold_amount=0.0,
            manual={
                "total_cost": 0.0,
                "total_market_value": 0.0,
                "unrealized_pnl": 0.0,
                "unrealized_pnl_pct": 0.0,
                "realized_pnl": 0.0,
                "total_trades": 0,
                "total_buy_amount": 0.0,
                "total_hold_amount": 0.0,
            },
            agent_a={
                "total_cost": 100000.0,
                "total_market_value": 141000.0,
                "unrealized_pnl": 41000.0,
                "unrealized_pnl_pct": 41.0,
                "realized_pnl": 37000.0,
                "total_trades": 3,
                "total_buy_amount": 100000.0,
                "total_hold_amount": 141000.0,
            },
            agent_b={
                "total_cost": 0.0,
                "total_market_value": 0.0,
                "unrealized_pnl": 0.0,
                "unrealized_pnl_pct": 0.0,
                "realized_pnl": 0.0,
                "total_trades": 0,
                "total_buy_amount": 0.0,
                "total_hold_amount": 0.0,
            },
        )

        def fake_agent_periods(trades, positions, pos_prices, agent_id, today_ts, week_ts, month_ts):
            if agent_id == "a":
                return {"today": 18384.0, "week": 80654.0, "month": 80654.0, "unrealized": 9197.0}
            return {"today": 0.0, "week": 0.0, "month": 0.0, "unrealized": 0.0}

        def fake_source_returns(**kwargs):
            return types.SimpleNamespace(**kwargs)

        def fake_returns(**kwargs):
            return types.SimpleNamespace(**kwargs)

        with patch.object(self.api, "_compute_agent_period_returns", side_effect=fake_agent_periods), \
             patch.object(self.api, "_orphan_agent_sell_realized_adjustment", return_value=0.0), \
             patch.object(self.api, "PortfolioSourceReturnsResponse", side_effect=fake_source_returns), \
             patch.object(self.api, "PortfolioReturnsResponse", side_effect=fake_returns):
            result = self.api._compute_period_returns([], summary, {"manual": {}, "a": {}, "b": {}}, [], {})

        self.assertEqual(result.agent_a.today_pnl, 18384.0)
        self.assertEqual(result.agent_a.total_pnl, 78000.0)

    def test_market_closed_queues_new_pick_execution(self):
        now = int(time.time())
        with self.db.session_scope() as s:
            cfg = s.get(self.models.PortfolioAgentConfig, "a")
            if cfg is None:
                cfg = self.models.PortfolioAgentConfig(id="a")
                s.add(cfg)
                s.flush()
            cfg.enabled = "1"
            cfg.agent_type = "rules"
            cfg.capital = 10_000_000.0
            cfg.min_buy_quantity = 10000.0

        with patch.object(self.api, "_cn_market_trading_now", return_value=False), \
             patch.object(self.api, "get_portfolio_summary", return_value=types.SimpleNamespace(agent_a=types.SimpleNamespace(total_market_value=0.0), agent_b=types.SimpleNamespace(total_market_value=0.0))), \
             patch.object(self.api, "_portfolio_agent_pick_candidates", return_value=[("CN", "600010.SH", "测试一号", 10.0, "积极建仓")]), \
             patch.object(self.api, "get_portfolio_alerts", return_value=[]), \
             patch.object(self.api, "_send_feishu_trade_notify"):
            result = self.api._run_portfolio_agent_once("a", allow_new_pick=True, pick_slot_key="2026-05-07:16:45", precomputed_alerts=[])

        self.assertEqual(result.get("message"), "queued_new_stock")
        with self.db.session_scope() as s:
            trades = s.execute(self.api.select(self.models.PortfolioTrade)).scalars().all()
            auto_trades = s.execute(self.api.select(self.models.PortfolioAutoTrade)).scalars().all()
        self.assertEqual(len(trades), 0)
        self.assertEqual(len(auto_trades), 1)
        self.assertEqual(auto_trades[0].status, "PENDING")
        self.assertEqual(auto_trades[0].source, "auto_strategy_a")

    def test_live_auto_trade_executes_queued_agent_buy(self):
        now = int(time.time())
        with self.db.session_scope() as s:
            pos = self.models.PortfolioPosition(
                market="CN",
                symbol="600010.SH",
                name="测试一号",
                quantity=0.0,
                avg_cost=0.0,
                created_at=now,
                updated_at=now,
            )
            s.add(pos)
            s.flush()
            s.add(self.models.PortfolioAutoTrade(
                position_id=pos.id,
                side="BUY",
                trigger_price=10.0,
                quantity=10000.0,
                status="PENDING",
                source="auto_strategy_a",
                created_at=now,
            ))

        with patch.object(self.api, "_cn_market_trading_now", return_value=True), \
             patch.object(self.api, "get_stock_price", return_value=types.SimpleNamespace(price=9.8)), \
             patch.object(self.api, "_send_feishu_trade_notify"):
            self.api._process_live_auto_trades("CN")

        with self.db.session_scope() as s:
            auto_trades = s.execute(self.api.select(self.models.PortfolioAutoTrade)).scalars().all()
            trades = s.execute(self.api.select(self.models.PortfolioTrade)).scalars().all()

        self.assertEqual(len(auto_trades), 1)
        self.assertEqual(auto_trades[0].status, "EXECUTED")
        self.assertEqual(len(trades), 1)
        self.assertEqual(trades[0].source, "auto_strategy_a")

    def test_normalize_llm_actions_supports_up_to_five_actions(self):
        decision = {
            "actions": [
                {"action": "buy", "symbol": f"60069{i}", "reason": "x"}
                for i in range(7)
            ]
        }
        actions = self.api._normalize_llm_actions(decision)
        self.assertEqual(len(actions), 5)
        self.assertEqual(actions[0]["action"], "buy")


if __name__ == "__main__":
    unittest.main()
