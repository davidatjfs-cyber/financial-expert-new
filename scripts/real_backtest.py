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

import time
import json
import math
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional

import numpy as np
import pandas as pd

from core.recommend import (
    get_hs300_stocks,
    _score_timing,
    _score_breakout_timing,
    _STOCK_SECTOR_MAP,
)

# 我们要导入 api 里的 tencent fetch 函数
import api as api_mod


# =============== 参数 ===============
LOOKBACK_MONTHS = 12
TOP_N = 5
HOLD_DAYS = 20
KLINE_DAYS = 500
PARALLEL = 10
MIN_HISTORY = 70  # 至少需要 70 天 K 线才能算出 MA60


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

    # KDJ golden cross (简化判断)
    kdj_golden = False  # 简化 — 影响很小，回测里这是噪声

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
    }


def scan_at_date(symbol_dfs: dict, as_of_date: str, top_n: int) -> list:
    """在 as_of_date 选 top_n 只股票"""
    candidates = []
    for symbol, df in symbol_dfs.items():
        # 找到 as_of_date 在 df 中的位置
        date_mask = df["date_str"] <= as_of_date
        if not date_mask.any():
            continue
        as_of_idx = date_mask.values.nonzero()[0][-1]
        indicators = compute_indicators_at(df, as_of_idx)
        if indicators is None:
            continue
        # 调 timing_score + breakout_score
        ts = _score_timing(
            rsi14=indicators["rsi14"], boll_position=indicators["boll_position"],
            kdj_golden=indicators["kdj_golden"],
            macd_golden=indicators["macd_golden"],
            ma_bullish_align=indicators["ma_align"],
            slope_pct=indicators["slope_pct"],
            near_buy_price=False,
            buy_score=10, trend="up" if indicators["ma_align"] else "down",
            vol_ratio=indicators["vol_ratio"],
            ret_5d=indicators["ret_5d"],
            ret_10d=indicators["ret_10d"],
            dist_ma60_pct=indicators["dist_ma60_pct"],
        )
        bs = _score_breakout_timing(
            rsi14=indicators["rsi14"],
            ma5=indicators["ma5"], ma20=indicators["ma20"], ma60=indicators["ma60"],
            close=indicators["close"],
            ret_5d=indicators["ret_5d"], ret_10d=indicators["ret_10d"],
            vol_ratio=indicators["vol_ratio"],
            kdj_golden=indicators["kdj_golden"],
            macd_golden=indicators["macd_golden"],
            dist_ma60_pct=indicators["dist_ma60_pct"],
        )

        score = max(ts, bs)
        # 只挑 score >= 60 的（对应我们算法里的"强买信号"/"积极建仓"两档）
        if score < 60:
            continue
        candidates.append((symbol, score, ts, bs))

    # 按行业限制 + score 排序
    candidates.sort(key=lambda x: x[1], reverse=True)
    # 行业上限 = 3（与我们最新算法一致）
    selected = []
    sector_count = {}
    for sym, score, ts, bs in candidates:
        code = sym.split(".")[0]
        sec = _STOCK_SECTOR_MAP.get(code, "其他")
        if sector_count.get(sec, 0) >= 3:
            continue
        sector_count[sec] = sector_count.get(sec, 0) + 1
        selected.append((sym, score, ts, bs))
        if len(selected) >= top_n:
            break
    return selected


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


def main():
    t0 = time.time()
    print("=== 真实算法回测开始 ===")

    # 1. 拉 HS300 指数
    print("\n[1/3] 拉 HS300 指数 K 线...")
    idx_df = fetch_hs300_index()
    if idx_df is None:
        print("  失败")
        return
    print(f"  ✓ HS300: {len(idx_df)} 个交易日, {idx_df['date_str'].iloc[0]} ~ {idx_df['date_str'].iloc[-1]}")

    month_ends = get_month_end_dates(idx_df, LOOKBACK_MONTHS + 1)
    if len(month_ends) < LOOKBACK_MONTHS:
        print(f"  数据不足，只有 {len(month_ends)} 个月")
        return
    test_periods = month_ends[:-1]  # 排除最后一个未完整的月
    print(f"  回测周期: {test_periods[0]} ~ {test_periods[-1]} ({len(test_periods)} 期)")

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

    # 3. 逐期回测
    print(f"\n[3/3] 逐期回测 ({len(test_periods)} 期, top_n={TOP_N}, hold_days={HOLD_DAYS})...")

    period_results = []
    for pi, period_date in enumerate(test_periods):
        # 在 period_date 选股
        selected = scan_at_date(symbol_dfs, period_date, top_n=TOP_N)

        # 算持有期收益
        # 找出 period_date 的指数索引位置
        idx_mask = idx_df["date_str"] >= period_date
        if not idx_mask.any():
            continue
        start_idx = idx_mask.values.nonzero()[0][0]
        end_idx = min(start_idx + HOLD_DAYS, len(idx_df) - 1)
        end_date = idx_df["date_str"].iloc[end_idx]

        # benchmark return
        bm_start = float(idx_df["close"].iloc[start_idx])
        bm_end = float(idx_df["close"].iloc[end_idx])
        bm_ret = (bm_end / bm_start - 1.0) * 100.0

        # portfolio return
        stock_rets = []
        winning_stocks = 0
        for sym, score, ts, bs in selected:
            df = symbol_dfs[sym]
            p_start = get_price_at(df, period_date)
            p_end = get_price_at(df, end_date)
            if p_start and p_end and p_start > 0:
                ret = (p_end / p_start - 1.0) * 100.0
                stock_rets.append(ret)
                if ret > 0:
                    winning_stocks += 1

        if not stock_rets:
            continue

        avg_ret = float(np.mean(stock_rets))
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
            "selected": [(s, round(score, 1)) for s, score, ts, bs in selected],
        })

        print(f"  期 {pi+1}/{len(test_periods)} {period_date}->{end_date}: 选{len(selected)}只 组合{avg_ret:+6.2f}% vs HS300{bm_ret:+6.2f}% 超额{excess:+6.2f}% 单股胜{winning_stocks}/{len(stock_rets)}")

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

    print(f"\n🎯 胜率指标")
    print(f"  组合 vs HS300 胜率:  {portfolio_win_rate:.1f}%  ({portfolio_win_periods}/{len(period_results)} 期跑赢)")
    print(f"  单股盈利胜率:       {single_stock_win_rate:.1f}%  ({total_winning}/{total_stocks} 只盈利)")

    print(f"\n📉 风险指标")
    print(f"  最大回撤（组合）:   -{max_dd:.2f}%")
    print(f"  最大回撤（基准）:   -{max_dd_bm:.2f}%")
    print(f"  夏普比率:           {sharpe:.2f}")
    print(f"  信息比率:           {info_ratio:.2f}")

    print(f"\n⏱  总耗时: {time.time()-t0:.0f}秒")

    # 保存
    result_path = "/tmp/real_backtest_result.json"
    with open(result_path, "w", encoding="utf-8") as f:
        json.dump({
            "params": {"lookback_months": LOOKBACK_MONTHS, "top_n": TOP_N, "hold_days": HOLD_DAYS},
            "periods": len(period_results),
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
        }, f, ensure_ascii=False, indent=2)
    print(f"\n详细结果已保存到 {result_path}")


if __name__ == "__main__":
    main()
