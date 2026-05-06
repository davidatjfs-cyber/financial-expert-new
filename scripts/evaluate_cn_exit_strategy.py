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
            out.append(
                {
                    "date": item[0],
                    "open": float(item[1]),
                    "close": close,
                    "high": float(item[3]),
                    "low": float(item[4]),
                    "volume": float(item[5]),
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


def ema(values: np.ndarray, period: int) -> np.ndarray:
    out = np.full(len(values), np.nan)
    if len(values) < period:
        return out
    alpha = 2.0 / (period + 1.0)
    seed = float(np.mean(values[:period]))
    out[period - 1] = seed
    for i in range(period, len(values)):
        out[i] = alpha * float(values[i]) + (1.0 - alpha) * float(out[i - 1])
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


def macd_hist(values: np.ndarray) -> np.ndarray:
    ema12 = ema(values, 12)
    ema26 = ema(values, 26)
    dif = ema12 - ema26
    dea = ema(dif[~np.isnan(dif)], 9)
    out = np.full(len(values), np.nan)
    start = np.where(~np.isnan(dif))[0]
    if len(start) == 0 or len(dea) == 0:
        return out
    start_idx = start[0] + 8
    if start_idx >= len(values):
        return out
    valid_dif = dif[~np.isnan(dif)]
    for idx, v in enumerate(dea):
        pos = start[0] + 8 + idx
        if pos < len(values) and (start[0] + idx) < len(valid_dif):
            out[pos] = valid_dif[8 + idx] - v if (8 + idx) < len(valid_dif) else np.nan
    return out


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


def evaluate(limit: int, cooldown_days: int, cost_pct: float) -> dict[str, Any]:
    stocks = get_hs300_stocks()[:limit]
    index_state = _index_state_by_date(fetch_kline("000300.SH"))
    results = defaultdict(lambda: {"n": 0, "win": 0, "ret": 0.0})
    loaded = 0

    for idx, stock in enumerate(stocks):
        rows = fetch_kline(stock["symbol"])
        if len(rows) < 120:
            continue
        loaded += 1
        closes = np.array([x["close"] for x in rows], dtype=float)
        highs = np.array([x["high"] for x in rows], dtype=float)
        lows = np.array([x["low"] for x in rows], dtype=float)
        vols = np.array([x["volume"] for x in rows], dtype=float)
        ma20 = ma(closes, 20)
        ma60 = ma(closes, 60)
        vol_ma10 = ma(vols, 10)
        rsi14 = rsi(closes, 14)
        hist = macd_hist(closes)
        next_allowed = 0

        for i in range(65, len(rows) - 21):
            if i < next_allowed or index_state.get(rows[i]["date"]) != "market_weak":
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
            if timing < 96:
                continue

            entry = closes[i]
            fixed20 = (closes[i + 20] / entry - 1.0) * 100.0 - cost_pct
            _add(results["fixed20"], fixed20)

            stop = entry * 0.92
            tp1 = max(float(ma20[i]) if not np.isnan(ma20[i]) else entry, entry * 1.05)
            tp2 = max(float(ma60[i]) if not np.isnan(ma60[i]) else entry, entry * 1.10)

            cash_tp = None
            half_tp = False
            cash_tp_rev = None
            half_tp_rev = False
            reversed_half = False
            for j in range(i + 1, i + 21):
                reversal = False
                if j >= 1 and not np.isnan(ma20[j]) and not np.isnan(ma20[j - 1]) and not np.isnan(hist[j]) and not np.isnan(hist[j - 1]) and not np.isnan(rsi14[j]):
                    reversal = closes[j] < ma20[j] and ma20[j] < ma20[j - 1] and hist[j - 1] > 0 > hist[j] and rsi14[j] < 55

                if cash_tp is None:
                    if lows[j] <= stop:
                        cash_tp = (stop / entry - 1.0) * 100.0 - cost_pct
                    elif highs[j] >= tp2:
                        leg = (tp2 / entry - 1.0) * 100.0
                        cash_tp = ((tp1 / entry - 1.0) * 100.0 + leg) / 2.0 - cost_pct if half_tp else leg - cost_pct
                    elif highs[j] >= tp1 and not half_tp:
                        half_tp = True

                if cash_tp_rev is None:
                    if lows[j] <= stop:
                        cash_tp_rev = (stop / entry - 1.0) * 100.0 - cost_pct
                    elif highs[j] >= tp2:
                        leg = (tp2 / entry - 1.0) * 100.0
                        if half_tp_rev or reversed_half:
                            cash_tp_rev = ((tp1 / entry - 1.0) * 100.0 + leg) / 2.0 - cost_pct
                        else:
                            cash_tp_rev = leg - cost_pct
                    elif reversal and not reversed_half:
                        reversed_half = True
                        half_tp_rev = True
                    elif highs[j] >= tp1 and not half_tp_rev:
                        half_tp_rev = True

                if cash_tp is not None and cash_tp_rev is not None:
                    break

            if cash_tp is None:
                end_ret = (closes[i + 20] / entry - 1.0) * 100.0
                cash_tp = (((tp1 / entry - 1.0) * 100.0 + end_ret) / 2.0 - cost_pct) if half_tp else (end_ret - cost_pct)
            if cash_tp_rev is None:
                end_ret = (closes[i + 20] / entry - 1.0) * 100.0
                cash_tp_rev = (((tp1 / entry - 1.0) * 100.0 + end_ret) / 2.0 - cost_pct) if (half_tp_rev or reversed_half) else (end_ret - cost_pct)

            _add(results["tp_sl20"], cash_tp)
            _add(results["tp_sl_trend_reversal20"], cash_tp_rev)
            next_allowed = i + cooldown_days

        print(f"{idx + 1}/{len(stocks)} {stock['symbol']}")
        time.sleep(0.03)

    return {
        "loaded_symbols": loaded,
        "cooldown_days": cooldown_days,
        "results": {k: _finish(v) for k, v in sorted(results.items())},
    }


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=300)
    p.add_argument("--cooldown-days", type=int, default=20)
    p.add_argument("--cost-pct", type=float, default=0.3)
    args = p.parse_args()
    print(json.dumps(evaluate(args.limit, args.cooldown_days, args.cost_pct), ensure_ascii=False, indent=2))
