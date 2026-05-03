from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import defaultdict
from typing import Any

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.recommend import _score_timing, get_hs300_stocks  # noqa: E402


THRESHOLDS = [60, 80, 90, 94, 96, 98, 100]
HOLDS = [10, 20, 30]


def _disable_proxies() -> None:
    for k in list(os.environ.keys()):
        if "proxy" in k.lower():
            del os.environ[k]


def fetch_kline(symbol: str, days: int = 900) -> list[dict[str, Any]]:
    _disable_proxies()
    import httpx

    code = symbol.split(".")[0]
    prefix = "sh" if symbol.endswith(".SH") else "sz"
    qt_sym = f"{prefix}{code}"
    url = f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={qt_sym},day,2022-01-01,,{days},"
    resp = httpx.get(url, timeout=12.0)
    body = resp.json().get("data", {}).get(qt_sym, {})
    raw = body.get("day", []) or []
    out: list[dict[str, Any]] = []
    for item in raw:
        if len(item) < 6:
            continue
        try:
            close = float(item[2])
            volume = float(item[5])
            out.append(
                {
                    "date": item[0],
                    "open": float(item[1]),
                    "close": close,
                    "high": float(item[3]),
                    "low": float(item[4]),
                    "volume": volume,
                    "amount_proxy": close * volume,
                }
            )
        except (ValueError, TypeError):
            pass
    out.sort(key=lambda x: x["date"])
    return out


def ma(values: np.ndarray, n: int) -> np.ndarray:
    out = np.full(len(values), np.nan)
    if len(values) < n:
        return out
    for i in range(n - 1, len(values)):
        out[i] = float(np.mean(values[i - n + 1 : i + 1]))
    return out


def rsi(values: np.ndarray, period: int = 14) -> np.ndarray:
    out = np.full(len(values), np.nan)
    if len(values) <= period:
        return out
    diff = np.diff(values)
    gains = np.where(diff > 0, diff, 0.0)
    losses = np.where(diff < 0, -diff, 0.0)
    for i in range(period, len(values)):
        g = np.mean(gains[i - period : i])
        l = np.mean(losses[i - period : i])
        out[i] = 100.0 if l == 0 else 100.0 - (100.0 / (1.0 + g / l))
    return out


def _add(bucket: dict[str, float], ret: float) -> None:
    bucket["n"] += 1
    bucket["win"] += int(ret > 0)
    bucket["ret"] += ret


def _finish(bucket: dict[str, float]) -> dict[str, float]:
    n = int(bucket["n"])
    return {
        "samples": n,
        "win_rate": round(bucket["win"] / n * 100.0, 2) if n else 0.0,
        "avg_return": round(bucket["ret"] / n, 2) if n else 0.0,
    }


def _subrule_name(
    timing: float,
    steep_drop: bool,
    oversold: bool,
    vol_spike: bool,
    big_drop_5d: bool,
    big_drop_10d: bool,
    below_ma60_10pct: bool,
) -> str:
    if big_drop_5d and vol_spike:
        return "100_5日急跌+放量"
    if steep_drop and oversold and vol_spike:
        return "98_急跌斜率+RSI超卖+放量"
    if big_drop_10d and below_ma60_10pct:
        return "96_10日急跌+低于MA60超10%"
    if steep_drop and oversold and big_drop_5d:
        return "94_急跌斜率+RSI超卖+5日急跌"
    if steep_drop and oversold:
        return "90_急跌斜率+RSI超卖"
    if steep_drop or oversold:
        return "60_急跌斜率或RSI超卖"
    if timing > 0:
        return "other_positive"
    return "none"


def _index_state_by_date(rows: list[dict[str, Any]]) -> dict[str, str]:
    if len(rows) < 80:
        return {}
    closes = np.array([x["close"] for x in rows], dtype=float)
    ma20 = ma(closes, 20)
    ma60 = ma(closes, 60)
    out: dict[str, str] = {}
    for i, row in enumerate(rows):
        if i < 65 or np.isnan(ma20[i]) or np.isnan(ma60[i]) or np.isnan(ma60[i - 5]):
            out[row["date"]] = "market_unknown"
            continue
        ret20 = (closes[i] / closes[i - 20] - 1.0) * 100.0
        slope60 = (ma60[i] / ma60[i - 5] - 1.0) * 100.0
        if closes[i] > ma60[i] and ma20[i] > ma60[i] and slope60 >= 0:
            state = "market_strong"
        elif closes[i] > ma60[i] or ret20 > 0:
            state = "market_neutral"
        else:
            state = "market_weak"
        out[row["date"]] = state
    return out


def evaluate(limit: int, cooldown_days: int, cost_pct: float) -> dict[str, Any]:
    stocks = get_hs300_stocks()[:limit]
    index_rows = fetch_kline("000300.SH")
    index_state = _index_state_by_date(index_rows)
    overall = defaultdict(lambda: {"n": 0, "win": 0, "ret": 0.0})
    yearly = defaultdict(lambda: {"n": 0, "win": 0, "ret": 0.0})
    subrules = defaultdict(lambda: {"n": 0, "win": 0, "ret": 0.0})
    liquidity = defaultdict(lambda: {"n": 0, "win": 0, "ret": 0.0})
    market_state = defaultdict(lambda: {"n": 0, "win": 0, "ret": 0.0})
    loaded = 0

    for idx, stock in enumerate(stocks):
        symbol = stock["symbol"]
        rows = fetch_kline(symbol)
        if len(rows) < 120:
            continue
        loaded += 1
        closes = np.array([x["close"] for x in rows], dtype=float)
        vols = np.array([x["volume"] for x in rows], dtype=float)
        amount_proxy = np.array([x["amount_proxy"] for x in rows], dtype=float)
        rsi14 = rsi(closes, 14)
        ma20 = ma(closes, 20)
        ma60 = ma(closes, 60)
        vol_ma10 = ma(vols, 10)
        amount_ma20 = ma(amount_proxy, 20)
        next_allowed = 0

        for i in range(65, len(rows) - max(HOLDS)):
            if i < next_allowed:
                continue
            if np.isnan(ma60[i]) or np.isnan(ma60[i - 5]) or np.isnan(rsi14[i]):
                continue
            slope_ma60_pct = (ma60[i] / ma60[i - 5] - 1.0) * 100.0 if ma60[i - 5] else np.nan
            ret_5d = (closes[i] / closes[i - 5] - 1.0) * 100.0
            ret_10d = (closes[i] / closes[i - 10] - 1.0) * 100.0
            dist_ma60_pct = (closes[i] / ma60[i] - 1.0) * 100.0 if ma60[i] else np.nan
            vol_ratio = vols[i] / vol_ma10[i] if not np.isnan(vol_ma10[i]) and vol_ma10[i] else None
            timing = _score_timing(
                float(rsi14[i]),
                None,
                None,
                None,
                None,
                float(slope_ma60_pct),
                None,
                None,
                None,
                vol_ratio=vol_ratio,
                ret_5d=float(ret_5d),
                ret_10d=float(ret_10d),
                dist_ma60_pct=float(dist_ma60_pct),
            )
            if timing < 60:
                continue

            steep_drop = slope_ma60_pct < -0.15
            oversold = rsi14[i] < 30
            vol_spike = vol_ratio is not None and vol_ratio > 1.5
            big_drop_5d = ret_5d < -5
            big_drop_10d = ret_10d < -8
            below_ma60_10pct = dist_ma60_pct < -10
            rule = _subrule_name(timing, steep_drop, oversold, vol_spike, big_drop_5d, big_drop_10d, below_ma60_10pct)
            year = rows[i]["date"][:4]
            mstate = index_state.get(rows[i]["date"], "market_unknown")
            liq = "amount_ma20高" if not np.isnan(amount_ma20[i]) and amount_ma20[i] >= np.nanmedian(amount_ma20[max(0, i - 120) : i + 1]) else "amount_ma20低"

            for hold in HOLDS:
                future_ret = (closes[i + hold] / closes[i] - 1.0) * 100.0 - cost_pct
                for threshold in THRESHOLDS:
                    if timing >= threshold:
                        key = f"t{threshold}_h{hold}"
                        _add(overall[key], future_ret)
                        _add(yearly[f"{year}_{key}"], future_ret)
                        _add(liquidity[f"{liq}_{key}"], future_ret)
                        _add(market_state[f"{mstate}_{key}"], future_ret)
                _add(subrules[f"{rule}_h{hold}"], future_ret)

            next_allowed = i + cooldown_days

        print(f"{idx + 1}/{len(stocks)} {symbol}")
        time.sleep(0.03)

    return {
        "loaded_symbols": loaded,
        "cooldown_days": cooldown_days,
        "overall": {k: _finish(v) for k, v in sorted(overall.items())},
        "yearly": {k: _finish(v) for k, v in sorted(yearly.items())},
        "subrules": {k: _finish(v) for k, v in sorted(subrules.items())},
        "liquidity": {k: _finish(v) for k, v in sorted(liquidity.items())},
        "market_state": {k: _finish(v) for k, v in sorted(market_state.items())},
    }


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=120)
    p.add_argument("--cooldown-days", type=int, default=20)
    p.add_argument("--cost-pct", type=float, default=0.3)
    args = p.parse_args()
    print(json.dumps(evaluate(args.limit, args.cooldown_days, args.cost_pct), ensure_ascii=False, indent=2))
