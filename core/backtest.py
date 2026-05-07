"""
沪深300智能选股 - 回测引擎
用历史数据验证选股策略的有效性
输出: 胜率、年化收益、最大回撤、夏普比率、信息比率
"""
from __future__ import annotations


from core.net import disable_proxies_for_process
import os
import json
import time
from datetime import datetime, timedelta
from dataclasses import dataclass, asdict
from typing import Optional

import numpy as np


@dataclass
class BacktestResult:
    start_date: str = ""
    end_date: str = ""
    total_months: int = 0
    num_periods: int = 0
    win_rate: float = 0.0
    avg_period_return: float = 0.0
    avg_benchmark_return: float = 0.0
    avg_excess_return: float = 0.0
    annualized_return: float = 0.0
    annualized_benchmark: float = 0.0
    annualized_excess: float = 0.0
    max_drawdown: float = 0.0
    sharpe_ratio: float = 0.0
    information_ratio: float = 0.0
    period_details: list[dict] = None

    def __post_init__(self):
        if self.period_details is None:
            self.period_details = []


def fetch_history_close(symbol: str, days: int = 500) -> list[tuple[str, float]]:
    disable_proxies_for_process()
    try:
        import httpx
        code = symbol.split(".")[0]
        if symbol.endswith(".SH"):
            prefix = "sh"
        else:
            prefix = "sz"
        sym = f"{prefix}{code}"

        resp = httpx.get(
            f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={sym},day,2023-01-01,,{days},",
            timeout=15.0,
        )
        data = resp.json()
        body = data.get("data", {}).get(sym, {})
        klines = []
        for key in ["day", "week", "month"]:
            if key in body:
                raw = body[key]
                for item in raw:
                    if len(item) >= 3:
                        ds = item[0]
                        try:
                            close_price = float(item[2])
                            klines.append((ds, close_price))
                        except (ValueError, TypeError):
                            continue
                break
        klines.sort(key=lambda x: x[0])
        return klines
    except Exception as e:
        print(f"[backtest] fetch history error for {symbol}: {e}")
        return []


def fetch_index_close(index_code: str = "000300", days: int = 500) -> list[tuple[str, float]]:
    disable_proxies_for_process()
    try:
        import httpx
        prefix = "sh"
        sym = f"{prefix}{index_code}"

        resp = httpx.get(
            f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={sym},day,2023-01-01,,{days},",
            timeout=15.0,
        )
        data = resp.json()
        body = data.get("data", {}).get(sym, {})
        klines = []
        for key in ["day", "week", "month"]:
            if key in body:
                raw = body[key]
                for item in raw:
                    if len(item) >= 3:
                        ds = item[0]
                        try:
                            close_price = float(item[2])
                            klines.append((ds, close_price))
                        except (ValueError, TypeError):
                            continue
                break
        klines.sort(key=lambda x: x[0])
        return klines
    except Exception as e:
        print(f"[backtest] fetch index history error: {e}")
        return []


def _get_month_end_dates(all_dates: list[str]) -> list[str]:
    month_ends = []
    for i in range(len(all_dates) - 1):
        d1 = all_dates[i][:7]
        d2 = all_dates[i + 1][:7]
        if d1 != d2:
            month_ends.append(all_dates[i])
    if all_dates:
        month_ends.append(all_dates[-1])
    return month_ends


def _calc_return(prices: list[float]) -> float:
    if len(prices) < 2 or prices[0] == 0:
        return 0.0
    return (prices[-1] / prices[0] - 1.0) * 100.0


def _calc_max_drawdown(returns: list[float]) -> float:
    if not returns:
        return 0.0
    cumulative = 1.0
    peak = 1.0
    max_dd = 0.0
    for r in returns:
        cumulative *= (1.0 + r / 100.0)
        if cumulative > peak:
            peak = cumulative
        dd = (peak - cumulative) / peak * 100.0
        if dd > max_dd:
            max_dd = dd
    return max_dd


def run_backtest(
    scan_fn,
    top_n: int = 20,
    hold_days: int = 20,
    lookback_months: int = 12,
    progress_cb=None,
) -> BacktestResult:
    """
    回测主函数
    scan_fn: 回调函数 (as_of_date: str) -> list[str] (返回symbol列表)
    top_n: 每期选几只
    hold_days: 持有天数
    lookback_months: 回测多少个月
    """
    result = BacktestResult()

    disable_proxies_for_process()

    from core.recommend import get_hs300_stocks
    stocks = get_hs300_stocks()
    if not stocks:
        return result

    if progress_cb:
        progress_cb(0.05, "获取指数基准数据...")

    index_klines = fetch_index_close("000300", days=600)
    if len(index_klines) < 100:
        result.period_details = [{"error": "指数数据不足"}]
        return result

    index_dates = [k[0] for k in index_klines]
    index_prices = {k[0]: k[1] for k in index_klines}
    month_ends = _get_month_end_dates(index_dates)

    start_idx = max(0, len(month_ends) - lookback_months)
    test_periods = month_ends[start_idx:]

    if len(test_periods) < 3:
        result.period_details = [{"error": f"回测期不足: {len(test_periods)}个月"}]
        return result

    result.start_date = test_periods[0]
    result.end_date = test_periods[-1]
    result.total_months = lookback_months
    result.num_periods = len(test_periods)

    if progress_cb:
        progress_cb(0.1, f"回测{len(test_periods)}期，获取股票历史...")

    stock_cache: dict[str, dict[str, float]] = {}
    batch_size = 30
    for i in range(0, len(stocks), batch_size):
        batch = stocks[i:i + batch_size]
        for stock in batch:
            klines = fetch_history_close(stock["symbol"], days=600)
            price_map = {k[0]: k[1] for k in klines}
            stock_cache[stock["symbol"]] = price_map
        if progress_cb:
            pct = 0.1 + 0.5 * (i / len(stocks))
            progress_cb(pct, f"获取历史数据 {i}/{len(stocks)}...")
        time.sleep(0.1)

    if progress_cb:
        progress_cb(0.65, "开始逐期回测...")

    period_details = []
    portfolio_returns = []
    benchmark_returns = []

    for pi, period_start_date in enumerate(test_periods):
        if progress_cb:
            pct = 0.65 + 0.3 * (pi / len(test_periods))
            progress_cb(pct, f"回测第{pi+1}/{len(test_periods)}期: {period_start_date}")

        try:
            selected_symbols = scan_fn(period_start_date)
        except Exception:
            selected_symbols = []

        if not selected_symbols:
            selected_symbols = [s["symbol"] for s in stocks[:top_n]]

        selected_symbols = selected_symbols[:top_n]

        start_idx_pos = None
        end_idx_pos = None
        for di, d in enumerate(index_dates):
            if d >= period_start_date:
                start_idx_pos = di
                break

        if start_idx_pos is None:
            continue

        end_idx_pos = min(start_idx_pos + hold_days, len(index_dates) - 1)
        end_date = index_dates[end_idx_pos]

        stock_rets = []
        for sym in selected_symbols:
            pm = stock_cache.get(sym, {})
            p_start = pm.get(period_start_date)
            p_end = pm.get(end_date)

            if p_start is None:
                for di in range(start_idx_pos, min(start_idx_pos + 5, len(index_dates))):
                    d = index_dates[di]
                    if d in pm:
                        p_start = pm[d]
                        break
            if p_end is None:
                for di in range(end_idx_pos, max(end_idx_pos - 5, start_idx_pos), -1):
                    d = index_dates[di]
                    if d in pm:
                        p_end = pm[d]
                        break

            if p_start and p_end and p_start > 0:
                ret = (p_end / p_start - 1.0) * 100.0
                stock_rets.append(ret)

        avg_ret = np.mean(stock_rets) if stock_rets else 0.0

        bm_start = index_prices.get(period_start_date)
        bm_end = index_prices.get(end_date)
        bm_ret = 0.0
        if bm_start and bm_end and bm_start > 0:
            bm_ret = (bm_end / bm_start - 1.0) * 100.0

        excess = avg_ret - bm_ret

        portfolio_returns.append(avg_ret)
        benchmark_returns.append(bm_ret)

        period_details.append({
            "period": period_start_date,
            "end": end_date,
            "num_stocks": len(selected_symbols),
            "valid_stocks": len(stock_rets),
            "portfolio_return": round(avg_ret, 2),
            "benchmark_return": round(bm_ret, 2),
            "excess_return": round(excess, 2),
        })

    if not period_details:
        result.period_details = [{"error": "无有效回测结果"}]
        return result

    wins = sum(1 for p in period_details if p["excess_return"] > 0)
    result.win_rate = wins / len(period_details) * 100.0
    result.avg_period_return = float(np.mean(portfolio_returns))
    result.avg_benchmark_return = float(np.mean(benchmark_returns))
    result.avg_excess_return = result.avg_period_return - result.avg_benchmark_return

    periods_per_year = 252 / hold_days
    result.annualized_return = result.avg_period_return * periods_per_year
    result.annualized_benchmark = result.avg_benchmark_return * periods_per_year
    result.annualized_excess = result.avg_excess_return * periods_per_year

    result.max_drawdown = _calc_max_drawdown(portfolio_returns)

    if len(portfolio_returns) > 1:
        std = float(np.std(portfolio_returns))
        if std > 0:
            result.sharpe_ratio = (result.avg_period_return / std) * np.sqrt(periods_per_year)
        excess_list = [p - b for p, b in zip(portfolio_returns, benchmark_returns)]
        ex_std = float(np.std(excess_list))
        if ex_std > 0:
            result.information_ratio = (result.avg_excess_return / ex_std) * np.sqrt(periods_per_year)

    result.period_details = period_details

    return result


def save_backtest_result(result: BacktestResult, path: str = ""):
    if not path:
        path = os.path.join(os.path.dirname(__file__), "backtest_result.json")
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(asdict(result), f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[backtest] save error: {e}")


def load_backtest_result(path: str = "") -> Optional[BacktestResult]:
    if not path:
        path = os.path.join(os.path.dirname(__file__), "backtest_result.json")
    try:
        if not os.path.exists(path):
            return None
        with open(path, "r", encoding="utf-8") as f:
            d = json.load(f)
        return BacktestResult(**{k: v for k, v in d.items() if k in BacktestResult.__dataclass_fields__})
    except Exception:
        return None
