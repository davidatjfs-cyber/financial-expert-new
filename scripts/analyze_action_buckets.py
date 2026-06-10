"""桶级期望值分析：复用 real_backtest 的缓存，测量每个 action 桶(强买信号/
积极建仓/轻仓试探/关注等买点)的前向收益与出场收益，用于评估"是否值得放开
Agent B 买入更弱的桶(关注等买点/轻仓试探)"。

只读缓存，不拉网络。用法：BT_CACHE_DIR=.data/btcache python3 scripts/analyze_action_buckets.py
"""
from __future__ import annotations

import os
import sys
import pickle
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np

from core.recommend import (
    decide_action, classify_cn_regime, QUALITY_THRESHOLD,
    _STOCK_SECTOR_MAP, _load_static_sector_map,
)
import scripts.real_backtest as bt

CACHE_DIR = os.environ.get("BT_CACHE_DIR", ".data/btcache")
HOLD_DAYS = bt.HOLD_DAYS


def main():
    if not _STOCK_SECTOR_MAP:
        _STOCK_SECTOR_MAP.update(_load_static_sector_map())

    with open(os.path.join(CACHE_DIR, "bt_data.pkl"), "rb") as f:
        b = pickle.load(f)
    idx_df = b["idx_df"]; symbol_dfs = b["symbol_dfs"]
    financials = b["financials"]; valuations = b["valuations"]
    north_data = b["north_data"]; weights = b["weights"]

    month_ends = bt.get_month_end_dates(idx_df, bt.LOOKBACK_MONTHS + 1)
    test_periods = month_ends[:-1]

    # bucket -> list of (fwd_ret, exit_ret, regime)
    rows = defaultdict(list)
    for period_date in test_periods:
        idx_mask = idx_df["date_str"] >= period_date
        if not idx_mask.any():
            continue
        start_idx = idx_mask.values.nonzero()[0][0]
        end_idx = min(start_idx + HOLD_DAYS, len(idx_df) - 1)
        end_date = idx_df["date_str"].iloc[end_idx]
        regime = classify_cn_regime(idx_df.loc[:start_idx, "close"].tolist())
        allows = regime == "weak"

        scores = bt.build_scores_at_date(symbol_dfs, period_date, financials,
                                         valuations, north_data, weights)
        for s in scores:
            action = decide_action(s.quality_score_total, s.timing_score_total,
                                   s.breakout_score, s.sector_strength_score,
                                   allows, QUALITY_THRESHOLD)
            if action not in ("强买信号", "积极建仓", "轻仓试探", "关注等买点"):
                continue
            fwd, exit_ret = bt._fwd_and_exit(s.symbol, period_date, end_date) \
                if hasattr(bt, "_fwd_and_exit") else (None, None)
            if fwd is None:
                df = symbol_dfs[s.symbol]
                p0 = bt.get_price_at(df, period_date); p1 = bt.get_price_at(df, end_date)
                fwd = (p1 / p0 - 1) * 100 if (p0 and p1 and p0 > 0) else None
                ei = bt.get_idx_at(df, period_date)
                exit_ret = bt.simulate_exit(df, ei, HOLD_DAYS) if ei is not None else None
            if fwd is None:
                continue
            rows[action].append((fwd, exit_ret if exit_ret is not None else fwd, regime))

    print(f"=== 桶级期望值（{len(test_periods)}期 HS300，持有{HOLD_DAYS}天，出场=V2纯移动止损）===\n")
    print(f"{'桶':<10}{'笔数':>5}{'固定胜率':>9}{'固定均值':>9}{'出场胜率':>9}{'出场均值':>9}")
    for action in ("强买信号", "积极建仓", "轻仓试探", "关注等买点"):
        r = rows.get(action, [])
        if not r:
            print(f"{action:<10}{'0':>5}")
            continue
        fwd = [x[0] for x in r]; ex = [x[1] for x in r]
        fw = sum(1 for v in fwd if v > 0) / len(fwd) * 100
        ew = sum(1 for v in ex if v > 0) / len(ex) * 100
        print(f"{action:<10}{len(r):>5}{fw:>8.1f}%{np.mean(fwd):>+8.2f}%{ew:>8.1f}%{np.mean(ex):>+8.2f}%")

    # 关注等买点 / 轻仓试探 按 regime 细分（B 是抄底派，弱市才是它的主场）
    print("\n=== 弱桶按 regime 细分（评估放开 B 买入弱桶的价值）===")
    for action in ("轻仓试探", "关注等买点"):
        for reg in ("weak", "not_weak"):
            r = [x for x in rows.get(action, []) if x[2] == reg]
            if not r:
                continue
            ex = [x[1] for x in r]
            ew = sum(1 for v in ex if v > 0) / len(ex) * 100
            print(f"  {action} [{reg}]: n={len(r)} 出场胜率{ew:.1f}% 出场均值{np.mean(ex):+.2f}%")


if __name__ == "__main__":
    main()
