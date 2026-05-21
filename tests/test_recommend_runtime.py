from __future__ import annotations

import sys
import types
import unittest
from unittest.mock import patch

import pandas as pd

import core.recommend as recommend


class RecommendRuntimeTests(unittest.TestCase):
    def test_fetch_north_flow_falls_back_to_hold_stock_api(self):
        fake_ak = types.SimpleNamespace(
            stock_hsgt_individual_em=lambda symbol: (_ for _ in ()).throw(TypeError("legacy api broke")),
            stock_hsgt_hold_stock_em=lambda **kwargs: pd.DataFrame([
                {"股票代码": "600690", "持股占流通股比": "4.25%"},
                {"股票代码": "000001", "持股占流通股比": 1.5},
            ]),
        )

        with patch.dict(sys.modules, {"akshare": fake_ak}):
            result = recommend._fetch_north_flow()

        self.assertEqual(result["600690"], 4.25)
        self.assertEqual(result["000001"], 1.5)


class BreakoutTimingTests(unittest.TestCase):
    def test_breakout_score_high_for_textbook_uptrend(self):
        """Textbook trending stock: MA aligned, RSI 60, +3% in 5 days, volume up."""
        score = recommend._score_breakout_timing(
            rsi14=58.0,
            ma5=11.0, ma20=10.5, ma60=10.0,
            close=11.2,
            ret_5d=3.5, ret_10d=6.0,
            vol_ratio=1.6,
            kdj_golden=True, macd_golden=True,
            dist_ma60_pct=12.0,
        )
        # Should clear the 75 strong-breakout threshold comfortably.
        self.assertGreaterEqual(score, 75.0)

    def test_breakout_score_low_when_below_ma60(self):
        """Stock below MA60 is not a breakout setup, regardless of other signals."""
        score = recommend._score_breakout_timing(
            rsi14=55.0,
            ma5=9.0, ma20=9.5, ma60=10.0,
            close=8.5,
            ret_5d=2.0, ret_10d=1.0,
            vol_ratio=1.5,
            kdj_golden=False, macd_golden=False,
            dist_ma60_pct=-15.0,
        )
        # Heavy penalty for distance below MA60 and no MA alignment → low score.
        self.assertLess(score, 40.0)

    def test_breakout_score_low_when_overextended_rsi(self):
        """RSI > 75 means likely reversal, not continuation — score should drop."""
        score = recommend._score_breakout_timing(
            rsi14=82.0,
            ma5=11.0, ma20=10.5, ma60=10.0,
            close=11.5,
            ret_5d=8.0, ret_10d=15.0,
            vol_ratio=1.4,
            kdj_golden=False, macd_golden=False,
            dist_ma60_pct=15.0,
        )
        # Overextended setup — should not clear the 75 threshold.
        self.assertLess(score, 75.0)

    def test_breakout_score_low_when_falling(self):
        """Negative 5-day return invalidates a breakout claim."""
        score = recommend._score_breakout_timing(
            rsi14=55.0,
            ma5=10.5, ma20=10.3, ma60=10.0,
            close=10.4,
            ret_5d=-5.0,
            ret_10d=-3.0,
            vol_ratio=1.3,
            kdj_golden=False, macd_golden=False,
            dist_ma60_pct=4.0,
        )
        # Falling -5% in 5 days → not a breakout.
        self.assertLess(score, 60.0)

    def test_breakout_score_handles_none_inputs(self):
        """Missing data must not crash — return some valid number in [0, 100]."""
        score = recommend._score_breakout_timing(
            rsi14=None, ma5=None, ma20=None, ma60=None, close=None,
            ret_5d=None, ret_10d=None, vol_ratio=None,
            kdj_golden=None, macd_golden=None, dist_ma60_pct=None,
        )
        self.assertGreaterEqual(score, 0.0)
        self.assertLessEqual(score, 100.0)
