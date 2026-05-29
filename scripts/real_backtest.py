"""
真实算法回测 — 用我们当前的 timing_score + breakout_score 选股。

不同于 core/backtest.py 中的 simplified scan_fn（只返回 HS300 前 N 只），
这里在每个历史日期都重新计算技术指标，模拟我们的选股算法在过去
12 个月每月的实际行为。

输出:
- 胜率（vs HS300）
- 单股盈亏胜率
- 年化收益
- 年化超额
- 最大回撤
- 夏普比率
- 信息比率

使用:
  docker exec financial-expert-api-1 python3 /app/scripts/real_backtest.py
"""
from __future__ import annotations

import sys
sys.path.insert(0, "/app")

import os
import time
import json
import math
import pickle
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional

import numpy as np
import pandas as pd

from core.recommend import (
    get_hs300_stocks,
    _score_value,
    _score_growth,
    _score_quality,
    _score_tech,
    _score_momentum,
    _score_sentiment,
    _score_timing,
    _score_breakout_timing,
    _sector_strength_scores,
    _compute_final_total_score,
    _compute_momentum_from_kline,
    _load_dynamic_weights,
    decide_action,
    classify_cn_regime,
    StockScore,
    QUALITY_THRESHOLD,
    _STOCK_SECTOR_MAP,
    _fetch_batch_financials,
    _fetch_batch_pe_pb_ps,
    _fetch_north_flow,
)

# 我们要导入 api 里的 tencent fetch 函数
import api as api_mod

# 自动执行的两档（线上真正会建仓的桶），回测只交易这两类
BUY_ACTIONS = {"强买信号", "积极建仓"}


# =============== 参数 ===============
LOOKBACK_MONTHS = 12
TOP_N = 5
HOLD_DAYS = 20
KLINE_DAYS = 500
PARALLEL = 10
MIN_HISTORY = 70  # 至少需要 70 天 K 线才能算出 MA60

# 磁盘缓存目录（挂载到容器的 host 目录），避免每次重跑都拉 ~20 分钟数据。
CACHE_DIR = os.environ.get("BT_CACHE_DIR", "/cache")
USE_CACHE = os.environ.get("BT_USE_CACHE", "1") == "1"


def fetch_ohlcv(symbol: str) -> Optional[pd.DataFrame]:
    try:
        df = api_mod._tencent_fetch_history_df(symbol, "CN", count=KLINE_DAYS)
        if df is None or df.empty or len(df) < MIN_HISTORY:
            return None
        df = df.sort_values("date").reset_index(drop=True)
        df["date_str"] = df["date"].dt.strftime("%Y-%m-%d")
        return df
    except Exception:
        return None


def fetch_hs300_index() -> Optional[pd.DataFrame]:
    """000300.SH 指数 K 线"""
    try:
        df = api_mod._tencent_fetch_history_df("000300.SH", "CN", count=KLINE_DAYS)
        if df is None or df.empty:
            return None
        df = df.sort_values("date").reset_index(drop=True)
        df["date_str"] = df["date"].dt.strftime("%Y-%m-%d")
        return df
    except Exception:
        return None


def compute_indicators_at(df: pd.DataFrame, as_of_idx: int) -> Optional[dict]:
    """在 as_of_idx 那一行（含）截止，计算所有指标"""
    if as_of_idx < MIN_HISTORY - 1:
        return None
    window = df.iloc[: as_of_idx + 1]
    close = window["close"].values
    high = window["high"].values
    low = window["low"].values
    vol = window["volume"].values

    if len(close) < MIN_HISTORY:
        return None

    last_close = float(close[-1])

    # MA
    ma5 = float(np.mean(close[-5:]))
    ma20 = float(np.mean(close[-20:]))
    ma60 = float(np.mean(close[-60:]))

    # RSI14
    delta = np.diff(close[-15:])
    gains = delta[delta > 0].sum() / 14 if (delta > 0).any() else 0
    losses = -delta[delta < 0].sum() / 14 if (delta < 0).any() else 0
    if losses == 0:
        rsi14 = 100.0
    else:
        rs = gains / losses
        rsi14 = 100.0 - 100.0 / (1.0 + rs)

    # slope (last 5 days)
    if len(close) >= 6:
        slope_pct = (close[-1] / close[-6] - 1.0) / 5.0
    else:
        slope_pct = 0.0

    # ret_5d, ret_10d
    ret_5d = (last_close / close[-6] - 1.0) * 100.0 if len(close) >= 6 else 0.0
    ret_10d = (last_close / close[-11] - 1.0) * 100.0 if len(close) >= 11 else 0.0

    # vol_ratio (last vol / avg10)
    if len(vol) >= 11:
        vol_avg = float(np.mean(vol[-11:-1]))
        vol_ratio = float(vol[-1]) / vol_avg if vol_avg > 0 else 1.0
    else:
        vol_ratio = 1.0

    # dist_ma60_pct
    dist_ma60_pct = (last_close / ma60 - 1.0) * 100.0 if ma60 > 0 else 0.0

    # Boll position (B%)
    if len(close) >= 20:
        std20 = float(np.std(close[-20:]))
        upper = ma20 + 2 * std20
        lower = ma20 - 2 * std20
        boll_position = (last_close - lower) / (upper - lower) if (upper - lower) > 0 else 0.5
    else:
        boll_position = 0.5

    # KDJ(9,3,3) golden cross — computed point-in-time to mirror production,
    # which passes kdj_golden_cross into _score_timing / _score_breakout_timing.
    if len(close) >= 11:
        cser = pd.Series(close)
        low_n = pd.Series(low).rolling(window=9).min()
        high_n = pd.Series(high).rolling(window=9).max()
        rng = (high_n - low_n).replace(0, np.nan)
        rsv = (cser - low_n) / rng * 100.0
        k = rsv.ewm(com=2, adjust=False).mean()
        d = k.ewm(com=2, adjust=False).mean()
        try:
            kdj_golden = bool(k.iloc[-1] > d.iloc[-1] and k.iloc[-2] <= d.iloc[-2])
        except Exception:
            kdj_golden = False
    else:
        kdj_golden = False

    # MACD golden cross
    if len(close) >= 35:
        ema12 = pd.Series(close).ewm(span=12, adjust=False).mean().values
        ema26 = pd.Series(close).ewm(span=26, adjust=False).mean().values
        dif = ema12 - ema26
        dea = pd.Series(dif).ewm(span=9, adjust=False).mean().values
        macd_golden = bool(dif[-1] > dea[-1] and dif[-2] <= dea[-2])
    else:
        macd_golden = False

    # MA bullish align
    ma_align = ma5 > ma20 > ma60

    # 动量因子（点位）— 复用生产的计算口径
    mom_20, mom_60, vol_20 = _compute_momentum_from_kline([float(c) for c in close])

    return {
        "close": last_close,
        "ma5": ma5, "ma20": ma20, "ma60": ma60,
        "rsi14": rsi14, "slope_pct": slope_pct,
        "ret_5d": ret_5d, "ret_10d": ret_10d,
        "vol_ratio": vol_ratio,
        "dist_ma60_pct": dist_ma60_pct,
        "boll_position": boll_position,
        "kdj_golden": kdj_golden,
        "macd_golden": macd_golden,
        "ma_align": ma_align,
        "momentum_20d": mom_20,
        "momentum_60d": mom_60,
        "volatility_20d": vol_20,
    }


def scan_at_date(symbol_dfs: dict, as_of_date: str, top_n: int,
                 financials: dict, valuations: dict, north_data: dict,
                 weights: dict, regime: str) -> list:
    """在 as_of_date 选 top_n 只股票 —— 完整复刻线上 run_scan 的决策链：
    因子打分 → total_score 排序 → 板块强度 → decide_action 桶判定 →
    只交易自动执行的 强买信号/积极建仓 两档。

    基本面（value/growth/quality/sentiment）用当前快照做静态代理：本系统线上
    也只用最新基本面，无 point-in-time 基本面源；HS300 大盘股基本面变化缓慢，
    12 个月回测内偏差有限。技术/动量/regime 均为严格 point-in-time。
    """
    cn_market_allows_new_buy = regime == "weak"

    # 1) 对全池逐只算点位指标 + 因子打分，构建 StockScore
    scores: list[StockScore] = []
    for symbol, df in symbol_dfs.items():
        date_mask = df["date_str"] <= as_of_date
        if not date_mask.any():
            continue
        as_of_idx = date_mask.values.nonzero()[0][-1]
        ind = compute_indicators_at(df, as_of_idx)
        if ind is None:
            continue

        code = symbol.split(".")[0]
        fin = financials.get(code, {})
        val = valuations.get(code, {})
        pe = val.get("pe_ratio") or fin.get("pe_ratio")
        pb = val.get("pb_ratio")
        ps = val.get("ps_ratio")
        turnover = val.get("turnover_rate")
        north_pct = north_data.get(code)

        s = StockScore(symbol=symbol, name=code, market="CN",
                       sector_name=_STOCK_SECTOR_MAP.get(code, "其他"))
        s._ind = ind

        s.value_score = _score_value(pe, pb, ps)
        s.growth_score = _score_growth(
            fin.get("revenue_growth"), fin.get("net_profit_growth"))
        s.quality_score = _score_quality(
            fin.get("roe"), fin.get("gross_margin"),
            fin.get("debt_ratio"), fin.get("cashflow_ratio"))
        s.tech_score = _score_tech(
            ind["rsi14"], ind["slope_pct"],
            None, ind["macd_golden"], ind["macd_golden"], None,
            ind["kdj_golden"], ind["boll_position"], ind["ma_align"])
        s.momentum_score = _score_momentum(
            ind["momentum_20d"], ind["momentum_60d"], ind["volatility_20d"])
        s.sentiment_score = _score_sentiment(north_pct, turnover)

        s.momentum_20d = ind["momentum_20d"]
        s.momentum_60d = ind["momentum_60d"]
        s.quality_score_total = s.value_score + s.growth_score + s.quality_score
        s.timing_score_total = _score_timing(
            rsi14=ind["rsi14"], boll_position=ind["boll_position"],
            kdj_golden=ind["kdj_golden"], macd_golden=ind["macd_golden"],
            ma_bullish_align=ind["ma_align"], slope_pct=ind["slope_pct"],
            near_buy_price=False, buy_score=10,
            trend="up" if ind["ma_align"] else "down",
            vol_ratio=ind["vol_ratio"], ret_5d=ind["ret_5d"],
            ret_10d=ind["ret_10d"], dist_ma60_pct=ind["dist_ma60_pct"])
        s.breakout_score = _score_breakout_timing(
            rsi14=ind["rsi14"], ma5=ind["ma5"], ma20=ind["ma20"], ma60=ind["ma60"],
            close=ind["close"], ret_5d=ind["ret_5d"], ret_10d=ind["ret_10d"],
            vol_ratio=ind["vol_ratio"], kdj_golden=ind["kdj_golden"],
            macd_golden=ind["macd_golden"], dist_ma60_pct=ind["dist_ma60_pct"])
        scores.append(s)

    if not scores:
        return []

    # 2) 板块强度（基于当期候选池动量，与线上一致）
    sector_strength = _sector_strength_scores(scores)
    for s in scores:
        s.sector_strength_score = sector_strength.get(s.sector_name, 50.0)

    # 3) total_score 排序（线上口径：factor 85% + sector 15%，质量门槛扣分）
    for s in scores:
        s.total_score = _compute_final_total_score(s, weights, QUALITY_THRESHOLD)
    scores.sort(key=lambda x: x.total_score, reverse=True)

    # 4) decide_action 桶判定（与 run_scan 共享同一函数），只取自动执行两档
    selected = []
    sector_count = {}
    for s in scores:
        action = decide_action(
            s.quality_score_total, s.timing_score_total, s.breakout_score,
            s.sector_strength_score, cn_market_allows_new_buy, QUALITY_THRESHOLD)
        if action not in BUY_ACTIONS:
            continue
        sec = s.sector_name
        if sector_count.get(sec, 0) >= 3:
            continue
        sector_count[sec] = sector_count.get(sec, 0) + 1
        selected.append((s.symbol, round(s.total_score, 1),
                         round(s.timing_score_total or 0, 1),
                         round(s.breakout_score or 0, 1), action,
                         s._ind))
        if len(selected) >= top_n:
            break
    return selected


# =============== 出场规则（镜像 api.py 生产语义）===============
# TP1=成本×1.05 减半，TP2=成本×1.10 清仓，止损=成本×0.92 清仓；
# 移动止损：峰值超 +5% 后，止损抬升到 max(成本×0.92, 峰值×0.95)。
EXIT_TP1 = float(os.environ.get("BT_TP1", "0.05"))
EXIT_TP2 = float(os.environ.get("BT_TP2", "0.10"))
EXIT_STOP = float(os.environ.get("BT_STOP", "0.08"))
EXIT_TRAIL_ACT = float(os.environ.get("BT_TRAIL_ACT", "0.05"))
EXIT_TRAIL_DD = float(os.environ.get("BT_TRAIL_DD", "0.05"))
# 设 BT_TP2=0（或负）表示「不设固定止盈、纯移动止损让利润奔跑」
EXIT_NO_TP = EXIT_TP2 <= 0


def get_idx_at(df: pd.DataFrame, date: str) -> Optional[int]:
    """返回 date（或其后首个交易日）在 df 中的行号。"""
    mask = df["date_str"] >= date
    if not mask.any():
        return None
    return int(mask.values.nonzero()[0][0])


def simulate_exit(df: pd.DataFrame, entry_idx: int, max_days: int,
                  tp1=EXIT_TP1, tp2=EXIT_TP2, stop=EXIT_STOP,
                  trail_act=EXIT_TRAIL_ACT, trail_dd=EXIT_TRAIL_DD,
                  no_tp=EXIT_NO_TP) -> Optional[float]:
    """A 股 T+1 逐日出场模拟，返回实现收益率(%)。

    买入在 entry_idx 收盘价，T+1 起（entry_idx+1）才可卖。每日：用 high 更新峰值，
    TP1 触及减半、TP2/止损/移动止损清仓；到 max_days 仍持有则按末日收盘清仓。
    同日止损与止盈同时触及时，保守按止损优先（最坏情形）。

    已知简化（HS300 大盘股影响很小）：未建模一字涨跌停日的不可成交、
    未建模 signal_sell 动量反转减半（属软信号，非本次验证的硬阈值 #5/#6）。
    """
    cost = float(df["close"].iloc[entry_idx])
    if cost <= 0:
        return None
    last_idx = min(entry_idx + max_days, len(df) - 1)
    remaining = 1.0
    realized = 0.0
    peak = cost
    tp1_done = False
    tp1_lvl = cost * (1 + tp1)
    tp2_lvl = cost * (1 + tp2)
    i = entry_idx + 1
    while i <= last_idx and remaining > 0:
        hi = float(df["high"].iloc[i])
        lo = float(df["low"].iloc[i])
        peak = max(peak, hi)
        eff_stop = cost * (1 - stop)
        if peak >= cost * (1 + trail_act):
            eff_stop = max(eff_stop, peak * (1 - trail_dd))
        if lo <= eff_stop:                       # 止损/移动止损 → 清仓
            realized += remaining * (eff_stop / cost - 1.0)
            remaining = 0.0
            break
        if not no_tp:
            if hi >= tp2_lvl:                    # TP2 → 清仓
                realized += remaining * (tp2_lvl / cost - 1.0)
                remaining = 0.0
                break
            if (not tp1_done) and hi >= tp1_lvl:  # TP1 → 减半
                half = remaining * 0.5
                realized += half * (tp1_lvl / cost - 1.0)
                remaining -= half
                tp1_done = True
        i += 1
    if remaining > 0:                            # 到期清仓
        realized += remaining * (float(df["close"].iloc[last_idx]) / cost - 1.0)
    return realized * 100.0


def get_price_at(df: pd.DataFrame, date: str, prefer="close"):
    """获取 date 那天的 close 价格，找不到则向后找 5 天"""
    mask = df["date_str"] == date
    if mask.any():
        return float(df.loc[mask, prefer].iloc[0])
    # 找不到，向后找 5 天（节假日/停牌）
    later = df[df["date_str"] >= date]
    if not later.empty:
        return float(later[prefer].iloc[0])
    return None


def get_month_end_dates(idx_df: pd.DataFrame, n_months: int) -> list:
    """从指数 K 线里提取最近 n_months 个月的月末交易日"""
    idx_df = idx_df.copy()
    idx_df["year_month"] = idx_df["date"].dt.strftime("%Y-%m")
    month_ends = idx_df.groupby("year_month")["date_str"].last().tolist()
    return month_ends[-n_months:]


def calc_max_drawdown(returns: list) -> float:
    cum = 1.0
    peak = 1.0
    max_dd = 0.0
    for r in returns:
        cum *= 1.0 + r / 100.0
        if cum > peak:
            peak = cum
        dd = (peak - cum) / peak * 100.0
        if dd > max_dd:
            max_dd = dd
    return max_dd


def _bucket_stats(trades: list, key: str, edges: list):
    """按 trades[i][key] 落入 edges 定义的区间，打印每桶笔数/胜率/平均前向收益。
    edges 例 [(-1e9, 0), (0, 3), (3, 8), (8, 1e9)] → 4 桶。"""
    for lo, hi in edges:
        bucket = [t for t in trades if lo <= t[key] < hi]
        n = len(bucket)
        if n == 0:
            print(f"    {key} [{lo:>6.1f},{hi:>6.1f}): n=0")
            continue
        wins = sum(1 for t in bucket if t["win"])
        avg_fwd = sum(t["fwd_ret"] for t in bucket) / n
        print(f"    {key} [{lo:>6.1f},{hi:>6.1f}): n={n:2d} 胜率{wins/n*100:5.1f}% 平均前向{avg_fwd:+6.2f}%")


def analyze_trades(trades: list):
    if not trades:
        print("  无交易")
        return

    def summ(label, ts):
        if not ts:
            print(f"  {label}: n=0")
            return
        n = len(ts)
        wins = sum(1 for t in ts if t["win"])
        avg = sum(t["fwd_ret"] for t in ts) / n
        print(f"  {label}: n={n} 胜率{wins/n*100:.1f}% 平均前向{avg:+.2f}%")

    # 按 path（突破 vs 均值回归）
    print("\n  ▸ 按入场路径")
    summ("突破(not_weak)", [t for t in trades if t["path"] == "breakout"])
    summ("均值回归(weak)", [t for t in trades if t["path"] == "meanrev"])

    bo = [t for t in trades if t["path"] == "breakout"]
    print(f"\n  ▸ 突破路径内（n={len(bo)}）按追高程度分桶 —— 验证假设 A")
    print("  · ret_5d（近5日涨幅）:")
    _bucket_stats(bo, "ret_5d", [(-1e9, 0), (0, 3), (3, 6), (6, 12), (12, 1e9)])
    print("  · dist_ma60_pct（偏离MA60）:")
    _bucket_stats(bo, "dist_ma60_pct", [(-1e9, 3), (3, 8), (8, 12), (12, 20), (20, 1e9)])
    print("  · rsi14:")
    _bucket_stats(bo, "rsi14", [(0, 50), (50, 60), (60, 70), (70, 1e9)])
    print("  · breakout_score:")
    _bucket_stats(bo, "breakout_score", [(0, 75), (75, 85), (85, 95), (95, 1e9)])


def main():
    t0 = time.time()
    print("=== 真实算法回测开始 ===")

    # 0. 尝试从磁盘缓存加载（网络拉数据约 20 分钟，缓存后重跑仅秒级）
    cache_path = os.path.join(CACHE_DIR, "bt_data.pkl")
    bundle = None
    if USE_CACHE and os.path.exists(cache_path):
        try:
            with open(cache_path, "rb") as f:
                bundle = pickle.load(f)
            print(f"\n[cache] ✓ 命中磁盘缓存 {cache_path}（跳过网络拉取）")
        except Exception as e:
            print(f"\n[cache] 读取失败，回退到网络拉取: {e}")
            bundle = None

    if bundle is None:
        # 1. 拉 HS300 指数
        print("\n[1/3] 拉 HS300 指数 K 线...")
        idx_df = fetch_hs300_index()
        if idx_df is None:
            print("  失败")
            return
        print(f"  ✓ HS300: {len(idx_df)} 个交易日, {idx_df['date_str'].iloc[0]} ~ {idx_df['date_str'].iloc[-1]}")

        # 2. 拉 HS300 成分股 K 线
        print(f"\n[2/3] 拉 HS300 成分股 K 线 (parallel={PARALLEL})...")
        stocks = get_hs300_stocks()
        print(f"  共 {len(stocks)} 只股票")

        symbol_dfs = {}
        success = 0
        fail = 0
        t1 = time.time()
        with ThreadPoolExecutor(max_workers=PARALLEL) as ex:
            futs = {ex.submit(fetch_ohlcv, s["symbol"]): s["symbol"] for s in stocks}
            for fut in as_completed(futs):
                sym = futs[fut]
                try:
                    df = fut.result()
                    if df is not None:
                        symbol_dfs[sym] = df
                        success += 1
                    else:
                        fail += 1
                except Exception:
                    fail += 1
                if (success + fail) % 30 == 0:
                    print(f"    进度 {success + fail}/{len(stocks)}, ok={success} fail={fail}, 耗时{time.time()-t1:.0f}s")
        print(f"  ✓ 拉数据完成: ok={success} fail={fail}, 耗时 {time.time()-t1:.0f}秒")

        # 2b. 基本面 / 估值 / 北向（当前快照，静态代理 —— 见 scan_at_date 注释）
        print("\n[2b] 拉基本面/估值/北向快照（静态代理）...")
        financials = _fetch_batch_financials(stocks)
        valuations = _fetch_batch_pe_pb_ps(stocks)
        try:
            north_data = _fetch_north_flow() or {}
        except Exception:
            north_data = {}
        weights = _load_dynamic_weights()
        print(f"  ✓ 基本面 {len(financials)} / 估值 {len(valuations)} / 北向 {len(north_data)}；权重 {weights}")

        bundle = {"idx_df": idx_df, "stocks": stocks, "symbol_dfs": symbol_dfs,
                  "financials": financials, "valuations": valuations,
                  "north_data": north_data, "weights": weights}
        if USE_CACHE:
            try:
                os.makedirs(CACHE_DIR, exist_ok=True)
                with open(cache_path, "wb") as f:
                    pickle.dump(bundle, f)
                print(f"[cache] ✓ 已写入磁盘缓存 {cache_path}")
            except Exception as e:
                print(f"[cache] 写入失败（不影响本次回测）: {e}")

    idx_df = bundle["idx_df"]
    symbol_dfs = bundle["symbol_dfs"]
    financials = bundle["financials"]
    valuations = bundle["valuations"]
    north_data = bundle["north_data"]
    weights = bundle["weights"]

    month_ends = get_month_end_dates(idx_df, LOOKBACK_MONTHS + 1)
    if len(month_ends) < LOOKBACK_MONTHS:
        print(f"  数据不足，只有 {len(month_ends)} 个月")
        return
    test_periods = month_ends[:-1]  # 排除最后一个未完整的月
    print(f"  回测周期: {test_periods[0]} ~ {test_periods[-1]} ({len(test_periods)} 期)")

    # 3. 逐期回测
    print(f"\n[3/3] 逐期回测 ({len(test_periods)} 期, top_n={TOP_N}, hold_days={HOLD_DAYS})...")

    period_results = []
    idle_periods = 0
    trades = []  # 每笔买入的入场特征 + 前向收益（用于客观验证假设 A）
    for pi, period_date in enumerate(test_periods):
        # 找出 period_date 的指数索引位置
        idx_mask = idx_df["date_str"] >= period_date
        if not idx_mask.any():
            continue
        start_idx = idx_mask.values.nonzero()[0][0]
        end_idx = min(start_idx + HOLD_DAYS, len(idx_df) - 1)
        end_date = idx_df["date_str"].iloc[end_idx]

        # 点位 regime：用截止到 period_date 的指数收盘序列（与线上同一规则）
        idx_closes = idx_df.loc[:start_idx, "close"].tolist()
        regime = classify_cn_regime(idx_closes)

        # 在 period_date 选股（复刻线上决策链）
        selected = scan_at_date(symbol_dfs, period_date, TOP_N,
                                financials, valuations, north_data, weights, regime)

        if not selected:
            idle_periods += 1
            print(f"  期 {pi+1}/{len(test_periods)} {period_date} [{regime}]: 无买入信号（空仓）")
            continue

        # benchmark return
        bm_start = float(idx_df["close"].iloc[start_idx])
        bm_end = float(idx_df["close"].iloc[end_idx])
        bm_ret = (bm_end / bm_start - 1.0) * 100.0

        # portfolio return（固定持有 vs T+1 出场模拟，并排）
        stock_rets = []
        exit_stock_rets = []
        winning_stocks = 0
        exit_winning = 0
        for sym, score, ts, bs, action, ind in selected:
            df = symbol_dfs[sym]
            p_start = get_price_at(df, period_date)
            p_end = get_price_at(df, end_date)
            if p_start and p_end and p_start > 0:
                ret = (p_end / p_start - 1.0) * 100.0
                stock_rets.append(ret)
                if ret > 0:
                    winning_stocks += 1
                # T+1 出场模拟
                entry_idx = get_idx_at(df, period_date)
                exit_ret = simulate_exit(df, entry_idx, HOLD_DAYS) if entry_idx is not None else None
                if exit_ret is not None:
                    exit_stock_rets.append(exit_ret)
                    if exit_ret > 0:
                        exit_winning += 1
                # 记录入场特征 + 前向收益（path 由 regime 决定：weak=均值回归，not_weak=突破）
                trades.append({
                    "period": period_date, "symbol": sym, "regime": regime,
                    "path": "meanrev" if regime == "weak" else "breakout",
                    "action": action, "fwd_ret": round(ret, 2),
                    "exit_ret": round(exit_ret, 2) if exit_ret is not None else None,
                    "win": ret > 0,
                    "total_score": score, "timing_score": ts, "breakout_score": bs,
                    "ret_5d": round(ind["ret_5d"], 2),
                    "ret_10d": round(ind["ret_10d"], 2),
                    "dist_ma60_pct": round(ind["dist_ma60_pct"], 2),
                    "rsi14": round(ind["rsi14"], 1),
                    "vol_ratio": round(ind["vol_ratio"], 2),
                })

        if not stock_rets:
            continue

        avg_ret = float(np.mean(stock_rets))
        exit_avg_ret = float(np.mean(exit_stock_rets)) if exit_stock_rets else avg_ret
        excess = avg_ret - bm_ret

        period_results.append({
            "period": period_date,
            "end": end_date,
            "n_selected": len(selected),
            "n_valid": len(stock_rets),
            "portfolio_return": round(avg_ret, 2),
            "benchmark_return": round(bm_ret, 2),
            "excess_return": round(excess, 2),
            "winning_stocks": winning_stocks,
            "single_stock_win_rate": round(winning_stocks / len(stock_rets) * 100, 1) if stock_rets else 0,
            "exit_return": round(exit_avg_ret, 2),
            "exit_winning_stocks": exit_winning,
            "regime": regime,
            "selected": [(s, round(score, 1), action) for s, score, ts, bs, action, ind in selected],
        })

        print(f"  期 {pi+1}/{len(test_periods)} {period_date}->{end_date} [{regime}]: 选{len(selected)}只 固定{avg_ret:+6.2f}% 出场{exit_avg_ret:+6.2f}% vs HS300{bm_ret:+6.2f}% 单股胜{winning_stocks}/{len(stock_rets)}")

    # 4. 汇总
    print(f"\n=== 回测结果（{len(period_results)} 期）===")
    if not period_results:
        print("没有有效结果")
        return

    portfolio_rets = [p["portfolio_return"] for p in period_results]
    benchmark_rets = [p["benchmark_return"] for p in period_results]
    excess_rets = [p["excess_return"] for p in period_results]
    all_single_stock_rets = []
    total_winning = 0
    total_stocks = 0
    for p in period_results:
        total_winning += p["winning_stocks"]
        total_stocks += p["n_valid"]

    # 胜率（vs benchmark）
    portfolio_win_periods = sum(1 for x in excess_rets if x > 0)
    portfolio_win_rate = portfolio_win_periods / len(period_results) * 100

    # 单股胜率
    single_stock_win_rate = total_winning / total_stocks * 100 if total_stocks else 0

    # 平均/年化
    avg_period_ret = float(np.mean(portfolio_rets))
    avg_bm_ret = float(np.mean(benchmark_rets))
    avg_excess_ret = float(np.mean(excess_rets))
    periods_per_year = 252 / HOLD_DAYS  # ~12.6
    annual_portfolio = avg_period_ret * periods_per_year
    annual_bm = avg_bm_ret * periods_per_year
    annual_excess = avg_excess_ret * periods_per_year

    # 复利年化
    compound_portfolio = 1.0
    compound_bm = 1.0
    for p in period_results:
        compound_portfolio *= (1.0 + p["portfolio_return"] / 100)
        compound_bm *= (1.0 + p["benchmark_return"] / 100)
    years = len(period_results) / periods_per_year
    cagr_portfolio = (compound_portfolio ** (1.0 / years) - 1.0) * 100 if years > 0 else 0
    cagr_bm = (compound_bm ** (1.0 / years) - 1.0) * 100 if years > 0 else 0

    # 最大回撤
    max_dd = calc_max_drawdown(portfolio_rets)
    max_dd_bm = calc_max_drawdown(benchmark_rets)

    # 夏普
    if len(portfolio_rets) > 1:
        std = float(np.std(portfolio_rets))
        sharpe = (avg_period_ret / std) * math.sqrt(periods_per_year) if std > 0 else 0
        ex_std = float(np.std(excess_rets))
        info_ratio = (avg_excess_ret / ex_std) * math.sqrt(periods_per_year) if ex_std > 0 else 0
    else:
        sharpe = 0
        info_ratio = 0

    # 输出
    print(f"\n📊 收益指标")
    print(f"  期平均组合收益:    {avg_period_ret:+6.2f}%  (每持有20天)")
    print(f"  期平均基准收益:    {avg_bm_ret:+6.2f}%")
    print(f"  期平均超额收益:    {avg_excess_ret:+6.2f}%")
    print(f"  年化组合收益（算术）: {annual_portfolio:+6.2f}%")
    print(f"  年化基准收益（算术）: {annual_bm:+6.2f}%")
    print(f"  年化超额收益（算术）: {annual_excess:+6.2f}%")
    print(f"  CAGR 组合（复利）:    {cagr_portfolio:+6.2f}%")
    print(f"  CAGR 基准（复利）:    {cagr_bm:+6.2f}%")

    total_periods = len(period_results) + idle_periods
    print(f"\n🎯 胜率指标")
    print(f"  组合 vs HS300 胜率:  {portfolio_win_rate:.1f}%  ({portfolio_win_periods}/{len(period_results)} 期跑赢)")
    print(f"  单股盈利胜率:       {single_stock_win_rate:.1f}%  ({total_winning}/{total_stocks} 只盈利)")
    print(f"  空仓期（无信号）:    {idle_periods}/{total_periods}  ({idle_periods/total_periods*100:.0f}% 期未建仓)")

    print(f"\n📉 风险指标")
    print(f"  最大回撤（组合）:   -{max_dd:.2f}%")
    print(f"  最大回撤（基准）:   -{max_dd_bm:.2f}%")
    print(f"  夏普比率:           {sharpe:.2f}")
    print(f"  信息比率:           {info_ratio:.2f}")

    # 4b. 固定持有 vs T+1 出场模拟 对比（验证 #5/#6 出场规则）
    exit_rets = [p["exit_return"] for p in period_results]
    exit_total_win = sum(p["exit_winning_stocks"] for p in period_results)
    avg_exit_ret = float(np.mean(exit_rets))
    exit_excess = [e - b for e, b in zip(exit_rets, benchmark_rets)]
    avg_exit_excess = float(np.mean(exit_excess))
    exit_win_periods = sum(1 for x in exit_excess if x > 0)
    exit_max_dd = calc_max_drawdown(exit_rets)
    if len(exit_rets) > 1:
        exit_std = float(np.std(exit_rets))
        exit_sharpe = (avg_exit_ret / exit_std) * math.sqrt(periods_per_year) if exit_std > 0 else 0
    else:
        exit_sharpe = 0

    _tp_desc = "纯移动止损(无固定止盈)" if EXIT_NO_TP else f"TP1+{EXIT_TP1*100:.0f}%减半/TP2+{EXIT_TP2*100:.0f}%"
    print(f"\n=== 出场规则对比：固定持有{HOLD_DAYS}天 vs T+1出场模拟 ===")
    print(f"  出场参数: {_tp_desc} 止损-{EXIT_STOP*100:.0f}% 移动止损(激活+{EXIT_TRAIL_ACT*100:.0f}%/回撤{EXIT_TRAIL_DD*100:.0f}%)")
    print(f"  指标                固定持有      出场模拟")
    print(f"  期平均组合收益:     {avg_period_ret:+6.2f}%      {avg_exit_ret:+6.2f}%")
    print(f"  期平均超额收益:     {avg_excess_ret:+6.2f}%      {avg_exit_excess:+6.2f}%")
    print(f"  跑赢大盘期数:       {portfolio_win_periods}/{len(period_results)}          {exit_win_periods}/{len(period_results)}")
    print(f"  单股盈利胜率:       {single_stock_win_rate:.1f}%        {exit_total_win/total_stocks*100 if total_stocks else 0:.1f}%")
    print(f"  最大回撤:           -{max_dd:.2f}%      -{exit_max_dd:.2f}%")
    print(f"  夏普比率:           {sharpe:.2f}         {exit_sharpe:.2f}")

    # 5. 假设 A 客观验证：突破/追高入场是否真的胜率更低、前向收益更差
    print(f"\n=== 假设检验：入场特征 vs 前向收益（共 {len(trades)} 笔买入）===")
    analyze_trades(trades)

    print(f"\n⏱  总耗时: {time.time()-t0:.0f}秒")

    # 保存（优先写入缓存目录，便于从 host 读取）
    result_dir = CACHE_DIR if os.path.isdir(CACHE_DIR) else "/tmp"
    result_path = os.path.join(result_dir, "real_backtest_result.json")
    with open(result_path, "w", encoding="utf-8") as f:
        json.dump({
            "params": {"lookback_months": LOOKBACK_MONTHS, "top_n": TOP_N, "hold_days": HOLD_DAYS},
            "periods": len(period_results),
            "idle_periods": idle_periods,
            "metrics": {
                "avg_period_return": round(avg_period_ret, 2),
                "avg_benchmark_return": round(avg_bm_ret, 2),
                "avg_excess_return": round(avg_excess_ret, 2),
                "annualized_return_arith": round(annual_portfolio, 2),
                "annualized_benchmark_arith": round(annual_bm, 2),
                "annualized_excess_arith": round(annual_excess, 2),
                "cagr_portfolio": round(cagr_portfolio, 2),
                "cagr_benchmark": round(cagr_bm, 2),
                "win_rate_vs_benchmark": round(portfolio_win_rate, 1),
                "single_stock_win_rate": round(single_stock_win_rate, 1),
                "max_drawdown": round(max_dd, 2),
                "sharpe_ratio": round(sharpe, 2),
                "information_ratio": round(info_ratio, 2),
            },
            "period_details": period_results,
            "trades": trades,
        }, f, ensure_ascii=False, indent=2)
    print(f"\n详细结果已保存到 {result_path}")


if __name__ == "__main__":
    main()
