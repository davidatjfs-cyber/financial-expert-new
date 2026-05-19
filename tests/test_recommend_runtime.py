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
