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
        self.api._strategy_exec_today.clear()
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

    def test_strategy_alert_trade_retries_after_failed_first_attempt(self):
        now = int(time.time())
        with self.db.session_scope() as s:
            pos = self.models.PortfolioPosition(
                market="CN",
                symbol="600690.SH",
                name="海尔智家",
                source="a",
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
            key=f"{position_id}:strategy_stop_loss:211600",
            position_id=position_id,
            market="CN",
            symbol="600690.SH",
            name="海尔智家",
            alert_type="strategy_stop_loss",
            message="已跌破严格止损价",
            current_price=21.0,
            trigger_price=21.16,
        )

        with patch.object(self.api, "_create_trade_at_price", return_value=None):
            first = self.api._execute_strategy_alert_trade(alert, "a")
        second = self.api._execute_strategy_alert_trade(alert, "a")

        self.assertIsNone(first)
        self.assertIsNotNone(second)
        self.assertEqual(second.side, "SELL")

    def test_portfolio_alerts_use_intraday_low_and_effective_stop_loss(self):
        now = int(time.time())
        with self.db.session_scope() as s:
            pos = self.models.PortfolioPosition(
                market="CN",
                symbol="600690.SH",
                name="海尔智家",
                source="a",
                quantity=1000.0,
                avg_cost=100.0,
                created_at=now,
                updated_at=now,
            )
            s.add(pos)

        price = types.SimpleNamespace(price=93.0, high=95.0, low=91.0)
        indicators = types.SimpleNamespace(
            strategy_buy_zone_low=None,
            strategy_buy_zone_high=None,
            strategy_stop_loss=90.0,
            strategy_take_profit_1=None,
            strategy_take_profit_2=None,
            buy_price_aggressive_ok=False,
            buy_price_aggressive=None,
            sell_price_ok=False,
            sell_price=None,
        )

        with patch("concurrent.futures.ThreadPoolExecutor", side_effect=RuntimeError("no threadpool")), \
             patch.object(self.api, "get_stock_price", return_value=price), \
             patch.object(self.api, "get_stock_indicators", return_value=indicators):
            alerts = self.api.get_portfolio_alerts()

        stop_alerts = [a for a in alerts if a.alert_type == "strategy_stop_loss"]
        self.assertEqual(len(stop_alerts), 1)
        self.assertAlmostEqual(stop_alerts[0].trigger_price, 92.0)

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
            "action": "强买信号",
            "current_price": 12.3,
            "auto_trade_eligible": True,
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
            "action": "强买信号",
            "current_price": 12.3,
            "auto_trade_eligible": True,
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

    def test_llm_hold_is_logged_for_agent_b(self):
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
            "action": "hold",
            "symbol": None,
            "reason": "继续观察",
        }, ensure_ascii=False)
        sys.modules["core.llm_qwen"] = fake_qwen

        fake_recommend = types.ModuleType("core.recommend")
        fake_recommend.get_latest_scan = lambda: []
        fake_recommend.run_scan = lambda *args, **kwargs: []
        fake_recommend.save_scan_result = lambda results: None
        sys.modules["core.recommend"] = fake_recommend

        summary_obj = types.SimpleNamespace(
            agent_a=types.SimpleNamespace(total_market_value=0.0),
            agent_b=types.SimpleNamespace(total_market_value=0.0),
        )

        with patch.object(self.api, "get_portfolio_alerts", return_value=[]), \
             patch.object(self.api, "get_portfolio_summary", return_value=summary_obj), \
             patch.object(self.api, "_cn_market_trading_now", return_value=True):
            with self.db.session_scope() as s:
                cfg = s.get(self.models.PortfolioAgentConfig, "b")
            result = self.api._run_llm_agent_once("b", cfg, allow_new_pick=True, pick_slot_key="2026-05-07:09:30", precomputed_alerts=[])

        self.assertEqual(result.get("message"), "llm_hold")
        with self.db.session_scope() as s:
            rows = s.execute(self.api.select(self.models.PortfolioAgentPickLog).where(
                self.models.PortfolioAgentPickLog.agent_id == "b",
                self.models.PortfolioAgentPickLog.event == "llm_hold",
            )).scalars().all()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].detail, "继续观察")

    def test_llm_agent_rejects_watch_only_breakout_buy(self):
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
            "symbol": "600012",
            "reason": "想买 breakout",
        }, ensure_ascii=False)
        sys.modules["core.llm_qwen"] = fake_qwen

        fake_recommend = types.ModuleType("core.recommend")
        fake_recommend.get_latest_scan = lambda: [{
            "market": "CN",
            "symbol": "600012.SH",
            "name": "观察候选",
            "action": "积极建仓",
            "current_price": 12.8,
            "auto_trade_eligible": False,
        }]
        fake_recommend.run_scan = lambda *args, **kwargs: []
        fake_recommend.save_scan_result = lambda results: None
        sys.modules["core.recommend"] = fake_recommend

        price_obj = types.SimpleNamespace(price=12.8)
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

        self.assertEqual(result.get("message"), "llm_hold")
        with self.db.session_scope() as s:
            trades = s.execute(self.api.select(self.models.PortfolioTrade)).scalars().all()
        self.assertEqual(len(trades), 0)

    def test_run_endpoint_is_health_check_only(self):
        now = int(time.time())
        with self.db.session_scope() as s:
            cfg = s.get(self.models.PortfolioAgentConfig, "a")
            if cfg is None:
                cfg = self.models.PortfolioAgentConfig(id="a")
                s.add(cfg)
                s.flush()
            cfg.enabled = "1"
            cfg.agent_type = "rules"
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
            position_id = pos.id

        with patch.object(self.api, "_cn_market_trading_now", return_value=True), \
             patch.object(self.api, "_cn_market_closed", return_value=False), \
             patch.object(self.api, "_cn_index_market_state", return_value="weak"):
            result = self.api.run_portfolio_agent_now("a")

        self.assertTrue(result.ok)
        self.assertEqual(result.message, "health_checked")
        with self.db.session_scope() as s:
            trades = s.execute(self.api.select(self.models.PortfolioTrade)).scalars().all()
        self.assertEqual(len(trades), 0)

    def test_execute_endpoint_still_allows_explicit_trading(self):
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
            cfg.min_buy_quantity = 1000.0

        summary_obj = types.SimpleNamespace(
            agent_a=types.SimpleNamespace(total_market_value=0.0),
            agent_b=types.SimpleNamespace(total_market_value=0.0),
        )

        with patch.object(self.api, "get_portfolio_alerts", return_value=[]), \
             patch.object(self.api, "get_portfolio_summary", return_value=summary_obj), \
             patch.object(self.api, "_portfolio_agent_pick_candidates", return_value=[("CN", "600010.SH", "测试一号", 10.0, "积极建仓")]), \
             patch.object(self.api, "_cn_market_trading_now", return_value=True), \
             patch.object(self.api, "_send_feishu_trade_notify"):
            result = self.api.execute_portfolio_agent_now("a")

        self.assertEqual(result.get("message"), "picked_new_stock")
        trade = ((result.get("trades") or [None])[0] or {})
        self.assertEqual(trade.get("symbol"), "600010.SH")
        self.assertEqual(trade.get("side"), "BUY")

    def test_feishu_notifier_does_not_send_non_trade_alerts(self):
        alert = self.api.PortfolioAlertResponse(
            key="k",
            position_id="p",
            market="CN",
            symbol="600690.SH",
            name="海尔智家",
            alert_type="strategy_buy_zone",
            message="已进入策略买入区间",
            current_price=21.0,
            trigger_price=22.0,
        )

        sleep_calls = iter([None, RuntimeError("stop")])

        def fake_sleep(_seconds):
            result = next(sleep_calls)
            if isinstance(result, Exception):
                raise result

        with patch.object(self.api, "get_portfolio_alerts", return_value=[alert]), \
             patch.object(self.api, "_process_live_auto_trades"), \
             patch.object(self.api, "_claim_agent_new_pick_slot", return_value=None), \
             patch.object(self.api, "_send_feishu_portfolio_alert") as mock_send, \
             patch.object(self.api.time, "sleep", side_effect=fake_sleep):
            with self.assertRaisesRegex(RuntimeError, "stop"):
                self.api._portfolio_feishu_notifier()

        mock_send.assert_not_called()

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

    def test_end_to_end_position_lifecycle_with_trailing_stop(self):
        """Full lifecycle: buy → rally past TP1 → trailing stop lifts → fall → trailing-stop sell."""
        now = int(time.time())
        with self.db.session_scope() as s:
            # Position purchased at avg_cost=100.0 long enough ago that the
            # signal_sell cooldown won't be a factor.
            pos = self.models.PortfolioPosition(
                market="CN", symbol="600036.SH", name="招商银行",
                source="a", quantity=10000.0, avg_cost=100.0,
                created_at=now - 30 * 86400, updated_at=now - 30 * 86400,
            )
            s.add(pos)
            s.flush()
            s.add(self.models.PortfolioTrade(
                position_id=pos.id, side="BUY", price=100.0,
                quantity=10000.0, amount=1_000_000.0, fee=0.0,
                source="auto_strategy_a", created_at=now - 30 * 86400,
            ))
            position_id = pos.id

        # ---- Phase 1: stock rallies to 120 (+20% from cost) ----
        price_p1 = types.SimpleNamespace(price=120.0, high=122.0, low=118.0)
        indicator_p1 = types.SimpleNamespace(
            strategy_buy_zone_low=None, strategy_buy_zone_high=None,
            strategy_stop_loss=92.0, strategy_take_profit_1=105.0,
            strategy_take_profit_2=110.0,
            buy_price_aggressive_ok=False, buy_price_aggressive=None,
            sell_price_ok=False, sell_price=None,
        )
        with patch("concurrent.futures.ThreadPoolExecutor", side_effect=RuntimeError("no pool")), \
             patch.object(self.api, "get_stock_price", return_value=price_p1), \
             patch.object(self.api, "get_stock_indicators", return_value=indicator_p1):
            alerts_p1 = self.api.get_portfolio_alerts()

        # Peak should now be 122 (intraday high).
        with self.db.session_scope() as s:
            p_after_p1 = s.get(self.models.PortfolioPosition, position_id)
            self.assertAlmostEqual(float(p_after_p1.peak_price or 0), 122.0)

        # ---- Phase 2: stock pulls back to 113. trailing_stop = 122*0.95 = 115.9 ----
        # Price 113 is below trailing stop → strategy_stop_loss alert should fire.
        price_p2 = types.SimpleNamespace(price=113.0, high=115.0, low=112.0)
        with patch("concurrent.futures.ThreadPoolExecutor", side_effect=RuntimeError("no pool")), \
             patch.object(self.api, "get_stock_price", return_value=price_p2), \
             patch.object(self.api, "get_stock_indicators", return_value=indicator_p1):
            alerts_p2 = self.api.get_portfolio_alerts()

        stop_alerts = [a for a in alerts_p2 if a.alert_type == "strategy_stop_loss"]
        self.assertEqual(len(stop_alerts), 1,
                         "trailing stop must trigger when price falls below peak*0.95")
        self.assertAlmostEqual(stop_alerts[0].trigger_price, 122.0 * 0.95)

        # ---- Phase 3: execute the trailing stop → position should be fully closed ----
        with patch.object(self.api, "get_stock_price", return_value=price_p2):
            trade = self.api._execute_strategy_alert_trade(stop_alerts[0], "a")
        self.assertIsNotNone(trade)
        self.assertEqual(trade.side, "SELL")
        self.assertAlmostEqual(trade.quantity, 10000.0,
                               msg="stop_loss must close the full position")

        # End-state check: the captured profit is ~13% (sold at 113, cost 100),
        # which is much better than the fixed TP2 at +10%. Net P&L on the trade
        # should be positive.
        self.assertGreater(float(trade.price or 0) * float(trade.quantity or 0)
                           - 100.0 * 10000.0, 100_000.0,
                           "trailing stop should lock in ≥10% gain")

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

    def test_trailing_stop_inactive_below_tp1_zone(self):
        """Peak <5% above cost: trailing stop should not lift the stop."""
        position = types.SimpleNamespace(
            quantity=1000.0, avg_cost=100.0, peak_price=103.0, source="manual",
        )
        indicators = types.SimpleNamespace(
            strategy_stop_loss=90.0,
            strategy_take_profit_1=105.0,
            strategy_take_profit_2=110.0,
        )
        stop, tp1, tp2 = self.api._effective_strategy_levels(position, indicators)
        # peak=103 < activation 105 → fallback to cost-based floor (max(90, 92)=92)
        self.assertAlmostEqual(stop, 92.0)
        self.assertAlmostEqual(tp1, 105.0)
        self.assertAlmostEqual(tp2, 110.0)

    def test_trailing_stop_lifts_stop_when_peak_above_tp1(self):
        """Peak well above TP1: stop should rise to peak*(1-trailing_pct)."""
        position = types.SimpleNamespace(
            quantity=1000.0, avg_cost=100.0, peak_price=120.0, source="manual",
        )
        indicators = types.SimpleNamespace(
            strategy_stop_loss=90.0,
            strategy_take_profit_1=105.0,
            strategy_take_profit_2=110.0,
        )
        stop, tp1, tp2 = self.api._effective_strategy_levels(position, indicators)
        # peak=120 ≥ activation 105; trailing stop = 120 * 0.95 = 114
        # 114 > original floor 92, so effective stop becomes 114
        self.assertAlmostEqual(stop, 114.0)

    def test_trailing_stop_does_not_lower_existing_stop(self):
        """When original stop is already higher than trailing, keep original."""
        position = types.SimpleNamespace(
            quantity=1000.0, avg_cost=100.0, peak_price=106.0, source="manual",
        )
        # peak=106 → trailing stop = 100.7
        # but if original stop is 102, we should keep 102 (higher).
        indicators = types.SimpleNamespace(
            strategy_stop_loss=102.0,
            strategy_take_profit_1=105.0,
            strategy_take_profit_2=110.0,
        )
        stop, _, _ = self.api._effective_strategy_levels(position, indicators)
        self.assertAlmostEqual(stop, 102.0)

    def test_trailing_stop_inactive_for_flat_or_no_position(self):
        """No quantity → return raw stops, no trailing."""
        position = types.SimpleNamespace(
            quantity=0.0, avg_cost=100.0, peak_price=200.0, source="manual",
        )
        indicators = types.SimpleNamespace(
            strategy_stop_loss=90.0,
            strategy_take_profit_1=105.0,
            strategy_take_profit_2=110.0,
        )
        stop, tp1, tp2 = self.api._effective_strategy_levels(position, indicators)
        self.assertAlmostEqual(stop, 90.0)
        self.assertAlmostEqual(tp1, 105.0)
        self.assertAlmostEqual(tp2, 110.0)

    def test_agent_reversal_levels_use_wider_profit_targets(self):
        position = types.SimpleNamespace(
            quantity=1000.0, avg_cost=100.0, peak_price=112.0, source="a",
        )
        indicators = types.SimpleNamespace(
            strategy_stop_loss=90.0,
            strategy_take_profit_1=105.0,
            strategy_take_profit_2=110.0,
        )

        stop, tp1, tp2 = self.api._effective_strategy_levels(position, indicators)

        self.assertAlmostEqual(tp1, 110.0)
        self.assertAlmostEqual(tp2, 118.0)
        self.assertAlmostEqual(stop, 104.16)

    def test_stock_indicators_cn_uses_breakout_score_in_shared_action_resolver(self):
        import pandas as pd

        self.api._INDICATOR_CACHE.clear()

        history = pd.DataFrame({
            "date": pd.date_range("2026-01-01", periods=80, freq="D"),
            "open": [10.0 + i * 0.15 for i in range(80)],
            "high": [10.2 + i * 0.15 for i in range(80)],
            "low": [9.8 + i * 0.15 for i in range(80)],
            "close": [10.1 + i * 0.15 for i in range(80)],
            "volume": [1_000_000 + i * 10_000 for i in range(80)],
            "amount": [10_000_000 + i * 100_000 for i in range(80)],
        })

        captured = {}

        def _fake_resolver(**kwargs):
            captured.update(kwargs)
            return {
                "action": "积极建仓",
                "execution_mode": "breakout_watch",
                "auto_trade_eligible": False,
                "market_state": kwargs.get("market_state") or "not_weak",
            }

        fake_recommend = types.ModuleType("core.recommend")
        fake_recommend._score_timing = lambda *args, **kwargs: 12.0
        fake_recommend._score_breakout_timing = lambda *args, **kwargs: 88.0
        fake_recommend._resolve_cn_scan_action = _fake_resolver

        with patch.object(self.api, "_fetch_history_df", return_value=history), \
             patch.object(self.api, "_tencent_fetch_pe_ratio", return_value=12.0), \
             patch.object(self.api, "_cn_index_market_state", return_value="not_weak"), \
             patch.dict(sys.modules, {"core.recommend": fake_recommend}):
            payload = self.api.get_stock_indicators("600690.SH", market="CN")

        self.assertIsNotNone(payload)
        strategy_action = payload.get("strategy_action") if isinstance(payload, dict) else payload.strategy_action
        self.assertEqual(strategy_action, "积极建仓")
        self.assertEqual(captured["market_state"], "not_weak")
        self.assertEqual(captured["timing_score_total"], 12.0)
        self.assertEqual(captured["breakout_score"], 88.0)

    def test_update_position_peak_price_picks_intraday_high(self):
        position = types.SimpleNamespace(quantity=1000.0, peak_price=100.0)
        # current=98, day_high=105 → peak should jump to 105 (uses intraday high).
        new_peak = self.api._update_position_peak_price(position, 98.0, 105.0)
        self.assertAlmostEqual(new_peak, 105.0)

    def test_update_position_peak_price_keeps_higher_existing(self):
        position = types.SimpleNamespace(quantity=1000.0, peak_price=120.0)
        new_peak = self.api._update_position_peak_price(position, 110.0, 115.0)
        self.assertAlmostEqual(new_peak, 120.0)

    def test_update_position_peak_price_initializes_from_none(self):
        position = types.SimpleNamespace(quantity=1000.0, peak_price=None)
        new_peak = self.api._update_position_peak_price(position, 50.0, 52.5)
        self.assertAlmostEqual(new_peak, 52.5)

    def test_update_position_peak_price_ignored_for_no_position(self):
        position = types.SimpleNamespace(quantity=0.0, peak_price=99.0)
        new_peak = self.api._update_position_peak_price(position, 200.0, 210.0)
        # quantity=0 → don't update.
        self.assertEqual(new_peak, 99.0)

    def test_get_portfolio_alerts_updates_peak_price_on_position(self):
        """Verify peak_price is actually persisted to DB after alert evaluation."""
        now = int(time.time())
        with self.db.session_scope() as s:
            pos = self.models.PortfolioPosition(
                market="CN", symbol="600519.SH", name="贵州茅台",
                source="a", quantity=100.0, avg_cost=1500.0,
                created_at=now, updated_at=now,
            )
            s.add(pos)

        # Day 1: spot=1620, high=1650 → peak should become 1650.
        price = types.SimpleNamespace(price=1620.0, high=1650.0, low=1600.0)
        indicators = types.SimpleNamespace(
            strategy_buy_zone_low=None, strategy_buy_zone_high=None,
            strategy_stop_loss=1400.0, strategy_take_profit_1=1575.0,
            strategy_take_profit_2=1650.0,
            buy_price_aggressive_ok=False, buy_price_aggressive=None,
            sell_price_ok=False, sell_price=None,
        )
        with patch("concurrent.futures.ThreadPoolExecutor", side_effect=RuntimeError("no threadpool")), \
             patch.object(self.api, "get_stock_price", return_value=price), \
             patch.object(self.api, "get_stock_indicators", return_value=indicators):
            self.api.get_portfolio_alerts()

        with self.db.session_scope() as s:
            p_db = s.execute(self.api.select(self.models.PortfolioPosition).where(
                self.models.PortfolioPosition.symbol == "600519.SH"
            )).scalars().first()
            self.assertAlmostEqual(float(p_db.peak_price or 0), 1650.0)

        # Day 2: spot=1600, high=1610 → peak should NOT decrease.
        price2 = types.SimpleNamespace(price=1600.0, high=1610.0, low=1590.0)
        with patch("concurrent.futures.ThreadPoolExecutor", side_effect=RuntimeError("no threadpool")), \
             patch.object(self.api, "get_stock_price", return_value=price2), \
             patch.object(self.api, "get_stock_indicators", return_value=indicators):
            self.api.get_portfolio_alerts()

        with self.db.session_scope() as s:
            p_db = s.execute(self.api.select(self.models.PortfolioPosition).where(
                self.models.PortfolioPosition.symbol == "600519.SH"
            )).scalars().first()
            self.assertAlmostEqual(float(p_db.peak_price or 0), 1650.0)

    def test_agent_a_candidates_primary_uses_strong_buy_only(self):
        """当存在强买信号时，Agent A 只用强买信号，不混入次级候选。"""
        fake_scan = [
            {
                "market": "CN", "symbol": "600001.SH", "name": "A1",
                "action": "强买信号", "current_price": 10.0,
                "quality_score_total": 40.0, "sector_strength_score": 60.0,
                "auto_trade_eligible": True,
            },
            {
                "market": "CN", "symbol": "600002.SH", "name": "A2",
                "action": "积极建仓", "current_price": 10.0,
                "quality_score_total": 50.0, "sector_strength_score": 90.0,
                "auto_trade_eligible": False,
            },
        ]
        fake_recommend = types.ModuleType("core.recommend")
        fake_recommend.get_latest_scan = lambda *a, **kw: fake_scan
        fake_recommend.run_scan = lambda *a, **kw: fake_scan
        fake_recommend.save_scan_result = lambda *a, **kw: None
        sys.modules["core.recommend"] = fake_recommend

        result = self.api._portfolio_agent_pick_candidates(1000.0, limit=5)
        # 应该只有 600001.SH (强买信号)，不含 600002.SH (即使次级符合 sector/quality 阈值)
        symbols = [c[1] for c in result]
        self.assertIn("600001.SH", symbols)
        self.assertNotIn("600002.SH", symbols)

    def test_agent_a_candidates_require_auto_trade_eligibility(self):
        """自动候选必须显式标记 auto_trade_eligible，watch-only breakout 不能混入。"""
        fake_scan = [
            {
                "market": "CN", "symbol": "600003.SH", "name": "B1",
                "action": "强买信号", "current_price": 10.0,
                "quality_score_total": 40.0, "sector_strength_score": 75.0,
                "auto_trade_eligible": False,
            },
            {
                "market": "CN", "symbol": "600004.SH", "name": "B2",
                "action": "强买信号", "current_price": 10.0,
                "quality_score_total": 44.0, "sector_strength_score": 80.0,
                "auto_trade_eligible": True,
            },
        ]
        fake_recommend = types.ModuleType("core.recommend")
        fake_recommend.get_latest_scan = lambda *a, **kw: fake_scan
        fake_recommend.run_scan = lambda *a, **kw: fake_scan
        fake_recommend.save_scan_result = lambda *a, **kw: None
        sys.modules["core.recommend"] = fake_recommend

        result = self.api._portfolio_agent_pick_candidates(1000.0, limit=5)
        symbols = [c[1] for c in result]
        self.assertNotIn("600003.SH", symbols)
        self.assertIn("600004.SH", symbols)

    def test_agent_a_no_candidates_when_only_watch_candidates_exist(self):
        """只有 watch-only breakout 时返回空，不自动兜底到积极建仓。"""
        fake_scan = [
            {
                "market": "CN", "symbol": "600006.SH", "name": "C1",
                "action": "积极建仓", "current_price": 10.0,
                "quality_score_total": 30.0, "sector_strength_score": 60.0,
                "auto_trade_eligible": False,
            },
            {
                "market": "CN", "symbol": "600007.SH", "name": "C2",
                "action": "积极建仓", "current_price": 10.0,
                "quality_score_total": 50.0, "sector_strength_score": 85.0,
                "auto_trade_eligible": False,
            },
        ]
        fake_recommend = types.ModuleType("core.recommend")
        fake_recommend.get_latest_scan = lambda *a, **kw: fake_scan
        fake_recommend.run_scan = lambda *a, **kw: fake_scan
        fake_recommend.save_scan_result = lambda *a, **kw: None
        sys.modules["core.recommend"] = fake_recommend

        result = self.api._portfolio_agent_pick_candidates(1000.0, limit=5)
        self.assertEqual(result, [])

    def test_agent_b_candidates_cap_widened_to_15(self):
        """LLM 收到的候选股池上限是 15，而不是旧的 5。"""
        # 构造 20 支 active 候选
        fake_scan = [
            {
                "market": "CN", "symbol": f"60{i:04d}.SH", "name": f"S{i}",
                "action": "积极建仓",
                "current_price": 10.0,
                "strategy_buy_zone_low": 9.5,
                "strategy_buy_zone_high": 10.5,
                "strategy_stop_loss": 9.0,
                "strategy_take_profit_2": 11.0,
                "quality_score_total": 40.0,
                "timing_score_total": 60.0,
                "sector_strength_score": 60.0,
                "momentum_20d_pct": -3.0,
            }
            for i in range(20)
        ]
        fake_recommend = types.ModuleType("core.recommend")
        fake_recommend.get_latest_scan = lambda *a, **kw: fake_scan
        fake_recommend.run_scan = lambda *a, **kw: fake_scan
        fake_recommend.save_scan_result = lambda *a, **kw: None
        sys.modules["core.recommend"] = fake_recommend

        captured = {}
        def _cap(sp, up, **kw):
            captured["user"] = up
            return json.dumps({"action": "hold", "symbol": None, "reason": "test"}, ensure_ascii=False)
        fake_qwen = types.ModuleType("core.llm_qwen")
        fake_qwen.call_llm = _cap
        sys.modules["core.llm_qwen"] = fake_qwen

        with self.db.session_scope() as s:
            cfg = s.get(self.models.PortfolioAgentConfig, "b")
            if cfg is None:
                cfg = self.models.PortfolioAgentConfig(id="b")
                s.add(cfg)
                s.flush()
            cfg.enabled = "1"
            cfg.agent_type = "llm"
            cfg.capital = 10_000_000.0

        summary_obj = types.SimpleNamespace(
            agent_a=types.SimpleNamespace(total_market_value=0.0),
            agent_b=types.SimpleNamespace(total_market_value=0.0),
        )
        with patch.object(self.api, "get_stock_price", return_value=types.SimpleNamespace(price=10.0)), \
             patch.object(self.api, "get_stock_indicators", return_value=None), \
             patch.object(self.api, "get_portfolio_alerts", return_value=[]), \
             patch.object(self.api, "get_portfolio_summary", return_value=summary_obj), \
             patch.object(self.api, "_cn_market_trading_now", return_value=True), \
             patch.object(self.api, "_send_feishu_trade_notify"):
            with self.db.session_scope() as s:
                cfg = s.get(self.models.PortfolioAgentConfig, "b")
            self.api._run_llm_agent_once("b", cfg, allow_new_pick=True,
                                         pick_slot_key="2026-05-22:10:00",
                                         precomputed_alerts=[])

        user_prompt = captured.get("user", "")
        # 候选列表的 symbol 应该有 15 个（候选池上限），而不是 5 个
        import re
        symbols_in_prompt = re.findall(r'"60\d{4}\.SH"', user_prompt)
        # 去重（因为持仓字段里可能也有同样的symbol）
        unique = set(symbols_in_prompt)
        self.assertGreaterEqual(len(unique), 15, f"prompt 应该包含至少15个候选 symbol，实际 {len(unique)}")

    def test_dynamic_buy_quantity_legacy_mode_unchanged(self):
        """Without buy_price/capital, behavior must match the original share-count contract."""
        # action=强买信号 → +1, target progress<20% → +1 → units=3 (capped) → 1000*3=3000
        qty = self.api._agent_dynamic_buy_quantity(
            1000.0, 10.0, None, 0.0, "强买信号", 10_000_000.0,
        )
        self.assertAlmostEqual(qty, 3000.0)

    def test_dynamic_buy_quantity_percentage_mode_strong_signal(self):
        """With buy_price+capital, strong-buy targets ~8% of capital after pressure."""
        # capital=10M, buy_price=10 → 10M*0.08 ≈ 800k → 80000 shares.
        # KPI pressure with progress<20% lifts target_pct upward.
        qty = self.api._agent_dynamic_buy_quantity(
            min_buy_quantity=1000.0,
            target_profit=10.0,
            deadline_ts=None,
            net_pnl=0.0,
            action="强买信号",
            managed_capital=10_000_000.0,
            buy_price=10.0,
            capital=10_000_000.0,
        )
        # Expect substantially more than the legacy 3000 shares — at least ~40k.
        # Hard cap is 15% (=150k shares at price 10).
        self.assertGreaterEqual(qty, 30000.0)
        self.assertLessEqual(qty, 150000.0)

    def test_dynamic_buy_quantity_respects_15pct_single_stock_cap(self):
        """Even with max pressure, target must not exceed 15% of capital."""
        # Max pressure path: strong-buy + progress<20% + deadline<=3 days → mult=3
        qty = self.api._agent_dynamic_buy_quantity(
            min_buy_quantity=1000.0,
            target_profit=10.0,
            deadline_ts=int(time.time()) + 2 * 86400,
            net_pnl=0.0,
            action="强买信号",
            managed_capital=10_000_000.0,
            buy_price=10.0,
            capital=10_000_000.0,
        )
        # 15% of 10M / 10 = 150,000 shares is the absolute ceiling.
        self.assertLessEqual(qty, 150000.0)

    def test_dynamic_buy_quantity_existing_holdings_reduce_headroom(self):
        """If we already hold near the cap, the top-up shrinks accordingly."""
        # Already holding 1.4M of this symbol (14% of 10M capital). Headroom is
        # only 1% (100k). At price 10, that's 10000 shares max.
        qty = self.api._agent_dynamic_buy_quantity(
            min_buy_quantity=1000.0,
            target_profit=10.0,
            deadline_ts=None,
            net_pnl=0.0,
            action="强买信号",
            managed_capital=10_000_000.0,
            buy_price=10.0,
            capital=10_000_000.0,
            existing_symbol_value=1_400_000.0,
        )
        # qty * buy_price should not push total beyond 15% * capital = 1.5M.
        # So new qty * 10 ≤ 100k → qty ≤ 10000.
        self.assertLessEqual(qty * 10.0, 100_000.0 + 1e-6)

    def test_dynamic_buy_quantity_zero_when_already_at_cap(self):
        """If existing_symbol_value already exceeds the cap, return 0."""
        qty = self.api._agent_dynamic_buy_quantity(
            min_buy_quantity=1000.0,
            target_profit=None,
            deadline_ts=None,
            net_pnl=0.0,
            action="强买信号",
            managed_capital=10_000_000.0,
            buy_price=10.0,
            capital=10_000_000.0,
            existing_symbol_value=1_600_000.0,  # already 16% > 15% cap
        )
        self.assertEqual(qty, 0.0)

    def test_dynamic_buy_quantity_weak_action_smaller_position(self):
        """关注等买点 should size much smaller than 强买信号."""
        strong = self.api._agent_dynamic_buy_quantity(
            min_buy_quantity=1000.0, target_profit=None, deadline_ts=None,
            net_pnl=0.0, action="强买信号", managed_capital=10_000_000.0,
            buy_price=10.0, capital=10_000_000.0,
        )
        weak = self.api._agent_dynamic_buy_quantity(
            min_buy_quantity=1000.0, target_profit=None, deadline_ts=None,
            net_pnl=0.0, action="关注等买点", managed_capital=10_000_000.0,
            buy_price=10.0, capital=10_000_000.0,
        )
        self.assertGreater(strong, weak, "strong signal must size larger than weak signal")

    def test_llm_user_prompt_includes_decision_context_fields(self):
        """Verify the LLM prompt actually carries the new context fields we added."""
        now = int(time.time())
        days_ago = now - 7 * 86400  # 7 days of holding
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
                market="CN", symbol="600000.SH", name="浦发银行",
                source="b", quantity=10000.0, avg_cost=10.0,
                peak_price=11.5,  # has rallied — peak_pct_from_entry should reflect this
                created_at=days_ago, updated_at=days_ago,
            )
            s.add(pos)
            s.flush()
            s.add(self.models.PortfolioTrade(
                position_id=pos.id, side="BUY", price=10.0,
                quantity=10000.0, amount=100000.0, fee=0.0,
                source="auto_strategy_b", created_at=days_ago,
            ))

        captured_prompt = {}

        def _capture_call_llm(system_prompt, user_prompt, **kwargs):
            captured_prompt["system"] = system_prompt
            captured_prompt["user"] = user_prompt
            return json.dumps({"action": "hold", "symbol": None, "reason": "test"}, ensure_ascii=False)

        fake_qwen = types.ModuleType("core.llm_qwen")
        fake_qwen.call_llm = _capture_call_llm
        sys.modules["core.llm_qwen"] = fake_qwen

        fake_recommend = types.ModuleType("core.recommend")
        # Candidate with full set of fields we want to see surfaced.
        fake_recommend.get_latest_scan = lambda *a, **kw: [{
            "market": "CN", "symbol": "600519.SH", "name": "贵州茅台",
            "action": "强买信号",
            "current_price": 1480.0,
            "strategy_buy_zone_low": 1450.0,
            "strategy_buy_zone_high": 1500.0,
            "strategy_stop_loss": 1380.0,
            "strategy_take_profit_2": 1600.0,
            "momentum_20d_pct": -12.5,
        }]
        fake_recommend.run_scan = lambda *args, **kwargs: []
        fake_recommend.save_scan_result = lambda results: None
        sys.modules["core.recommend"] = fake_recommend

        price_obj = types.SimpleNamespace(price=11.2, high=11.6, low=11.0)
        indicator_obj = types.SimpleNamespace(
            ma5=11.0, ma20=10.8, ma60=10.5, rsi14=58.0, trend="up",
            strategy_action=None, strategy_stop_loss=10.0, strategy_take_profit_1=10.5,
            strategy_take_profit_2=11.0,
            strategy_buy_zone_low=None, strategy_buy_zone_high=None,
            buy_price_aggressive_ok=False, buy_price_aggressive=None,
            sell_price_ok=False, sell_price=None,
        )
        summary_obj = types.SimpleNamespace(
            agent_a=types.SimpleNamespace(total_market_value=0.0),
            agent_b=types.SimpleNamespace(total_market_value=112000.0),
        )

        with patch.object(self.api, "get_stock_price", return_value=price_obj), \
             patch.object(self.api, "get_stock_indicators", return_value=indicator_obj), \
             patch.object(self.api, "get_portfolio_alerts", return_value=[]), \
             patch.object(self.api, "get_portfolio_summary", return_value=summary_obj), \
             patch.object(self.api, "_cn_market_trading_now", return_value=True), \
             patch.object(self.api, "_send_feishu_trade_notify"):
            with self.db.session_scope() as s:
                cfg = s.get(self.models.PortfolioAgentConfig, "b")
            self.api._run_llm_agent_once("b", cfg, allow_new_pick=True,
                                         pick_slot_key="2026-05-07:17:05",
                                         precomputed_alerts=[])

        user_prompt = captured_prompt.get("user", "")
        # New holding context fields should appear in JSON dump.
        self.assertIn("days_held", user_prompt, "holding context should expose days_held")
        self.assertIn("peak_pct_from_entry", user_prompt)
        self.assertIn("dist_to_stop_pct", user_prompt)
        self.assertIn("dist_to_tp2_pct", user_prompt)
        # New candidate context fields.
        self.assertIn("price_in_zone", user_prompt)
        self.assertIn("reward_risk_ratio", user_prompt)
        self.assertIn("upside_to_tp2_pct", user_prompt)

    def test_signal_sell_trims_half_not_full_position(self):
        """signal_sell should sell half (like TP1), not the entire position."""
        long_ago = int(time.time()) - 30 * 86400  # 30 days ago — past the 5-day cooldown
        with self.db.session_scope() as s:
            pos = self.models.PortfolioPosition(
                market="CN", symbol="600036.SH", name="招商银行",
                source="a", quantity=10000.0, avg_cost=30.0,
                created_at=long_ago, updated_at=long_ago,
            )
            s.add(pos)
            s.flush()
            s.add(self.models.PortfolioTrade(
                position_id=pos.id, side="BUY", price=30.0,
                quantity=10000.0, amount=300000.0, fee=0.0,
                source="auto_strategy_a", created_at=long_ago,
            ))
            position_id = pos.id

        alert = self.api.PortfolioAlertResponse(
            key=f"{position_id}:signal_sell",
            position_id=position_id, market="CN", symbol="600036.SH",
            name="招商银行", alert_type="signal_sell",
            message="出现卖出信号", current_price=33.0, trigger_price=32.0,
        )
        with patch.object(self.api, "get_stock_price",
                          return_value=types.SimpleNamespace(price=33.0, high=33.5, low=32.5)):
            trade = self.api._execute_strategy_alert_trade(alert, "a")
        self.assertIsNotNone(trade, "signal_sell after cooldown should execute")
        self.assertEqual(trade.side, "SELL")
        # Half of 10000 = 5000 shares (not the full 10000).
        self.assertAlmostEqual(trade.quantity, 5000.0)

    def test_signal_sell_blocked_within_5_day_cooldown(self):
        """A signal_sell within 5 days of entry should be blocked."""
        recent = int(time.time()) - 2 * 86400  # 2 days ago
        with self.db.session_scope() as s:
            pos = self.models.PortfolioPosition(
                market="CN", symbol="600519.SH", name="贵州茅台",
                source="a", quantity=100.0, avg_cost=1500.0,
                created_at=recent, updated_at=recent,
            )
            s.add(pos)
            s.flush()
            s.add(self.models.PortfolioTrade(
                position_id=pos.id, side="BUY", price=1500.0,
                quantity=100.0, amount=150000.0, fee=0.0,
                source="auto_strategy_a", created_at=recent,
            ))
            position_id = pos.id

        alert = self.api.PortfolioAlertResponse(
            key=f"{position_id}:signal_sell",
            position_id=position_id, market="CN", symbol="600519.SH",
            name="贵州茅台", alert_type="signal_sell",
            message="出现卖出信号", current_price=1480.0, trigger_price=1490.0,
        )
        with patch.object(self.api, "get_stock_price",
                          return_value=types.SimpleNamespace(price=1480.0, high=1490.0, low=1475.0)):
            trade = self.api._execute_strategy_alert_trade(alert, "a")
        self.assertIsNone(trade, "signal_sell within cooldown should be blocked")

    def test_signal_sell_blocked_within_extended_agent_cooldown(self):
        """Agent reversal positions keep a longer cooldown before signal_sell can trim them."""
        recent = int(time.time()) - 6 * 86400
        with self.db.session_scope() as s:
            pos = self.models.PortfolioPosition(
                market="CN", symbol="600030.SH", name="中信证券",
                source="a", quantity=1000.0, avg_cost=20.0,
                created_at=recent, updated_at=recent,
            )
            s.add(pos)
            s.flush()
            s.add(self.models.PortfolioTrade(
                position_id=pos.id, side="BUY", price=20.0,
                quantity=1000.0, amount=20000.0, fee=0.0,
                source="auto_strategy_a", created_at=recent,
            ))
            position_id = pos.id

        alert = self.api.PortfolioAlertResponse(
            key=f"{position_id}:signal_sell",
            position_id=position_id, market="CN", symbol="600030.SH",
            name="中信证券", alert_type="signal_sell",
            message="出现卖出信号", current_price=20.5, trigger_price=20.2,
        )
        with patch.object(self.api, "get_stock_price",
                          return_value=types.SimpleNamespace(price=20.5, high=20.8, low=20.1)):
            trade = self.api._execute_strategy_alert_trade(alert, "a")
        self.assertIsNone(trade, "signal_sell should still be blocked before the 8-day cooldown ends")

    def test_strategy_stop_loss_not_blocked_by_cooldown(self):
        """5-day cooldown only gates signal_sell — hard stops must still execute immediately."""
        recent = int(time.time()) - 1 * 86400  # 1 day ago
        with self.db.session_scope() as s:
            pos = self.models.PortfolioPosition(
                market="CN", symbol="002594.SZ", name="比亚迪",
                source="a", quantity=1000.0, avg_cost=200.0,
                created_at=recent, updated_at=recent,
            )
            s.add(pos)
            s.flush()
            s.add(self.models.PortfolioTrade(
                position_id=pos.id, side="BUY", price=200.0,
                quantity=1000.0, amount=200000.0, fee=0.0,
                source="auto_strategy_a", created_at=recent,
            ))
            position_id = pos.id

        alert = self.api.PortfolioAlertResponse(
            key=f"{position_id}:strategy_stop_loss:1800000",
            position_id=position_id, market="CN", symbol="002594.SZ",
            name="比亚迪", alert_type="strategy_stop_loss",
            message="已跌破严格止损价", current_price=180.0, trigger_price=184.0,
        )
        with patch.object(self.api, "get_stock_price",
                          return_value=types.SimpleNamespace(price=180.0, high=185.0, low=178.0)):
            trade = self.api._execute_strategy_alert_trade(alert, "a")
        self.assertIsNotNone(trade, "strategy_stop_loss must execute regardless of holding period")
        self.assertEqual(trade.side, "SELL")
        self.assertAlmostEqual(trade.quantity, 1000.0)  # full position

    def test_trailing_stop_triggers_alert_in_portfolio_alerts(self):
        """End-to-end: peak rises to lift stop, price falls below it → stop alert fires."""
        now = int(time.time())
        with self.db.session_scope() as s:
            pos = self.models.PortfolioPosition(
                market="CN", symbol="000001.SZ", name="平安银行",
                source="a", quantity=1000.0, avg_cost=100.0,
                peak_price=120.0,  # already rallied to 120
                created_at=now, updated_at=now,
            )
            s.add(pos)

        # Current price = 113, below trailing stop 114 (=120*0.95).
        price = types.SimpleNamespace(price=113.0, high=115.0, low=112.0)
        indicators = types.SimpleNamespace(
            strategy_buy_zone_low=None, strategy_buy_zone_high=None,
            strategy_stop_loss=90.0,  # raw stop way below — trailing overrides
            strategy_take_profit_1=105.0,
            strategy_take_profit_2=110.0,
            buy_price_aggressive_ok=False, buy_price_aggressive=None,
            sell_price_ok=False, sell_price=None,
        )
        with patch("concurrent.futures.ThreadPoolExecutor", side_effect=RuntimeError("no threadpool")), \
             patch.object(self.api, "get_stock_price", return_value=price), \
             patch.object(self.api, "get_stock_indicators", return_value=indicators):
            alerts = self.api.get_portfolio_alerts()

        stop_alerts = [a for a in alerts if a.alert_type == "strategy_stop_loss"]
        self.assertEqual(len(stop_alerts), 1, "trailing stop should trigger when price<peak*0.95")
        # Trigger price is the effective stop = max(120*0.95, 90) = 114.
        self.assertAlmostEqual(stop_alerts[0].trigger_price, 114.0)


if __name__ == "__main__":
    unittest.main()
