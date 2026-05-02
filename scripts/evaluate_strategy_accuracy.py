from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import defaultdict

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.recommend import get_hs300_stocks, _score_timing  # noqa: E402


def _disable_proxies():
    for k in list(os.environ.keys()):
        if "proxy" in k.lower():
            del os.environ[k]


def fetch_kline(symbol: str, days: int = 700) -> list[dict]:
    _disable_proxies()
    import httpx

    code = symbol.split(".")[0]
    prefix = "sh" if symbol.endswith(".SH") else "sz"
    qt_sym = f"{prefix}{code}"
    url = f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={qt_sym},day,2023-01-01,,{days},"
    resp = httpx.get(url, timeout=12.0)
    body = resp.json().get("data", {}).get(qt_sym, {})
    raw = body.get("day", [])
    out = []
    for item in raw:
        if len(item) >= 6:
            try:
                out.append({
                    "date": item[0],
                    "open": float(item[1]),
                    "close": float(item[2]),
                    "high": float(item[3]),
                    "low": float(item[4]),
                    "volume": float(item[5]),
                })
            except (ValueError, TypeError):
                pass
    out.sort(key=lambda x: x["date"])
    return out


def rsi(values: np.ndarray, period: int = 14) -> np.ndarray:
    out = np.full(len(values), np.nan)
    if len(values) <= period:
        return out
    diff = np.diff(values)
    gains = np.where(diff > 0, diff, 0.0)
    losses = np.where(diff < 0, -diff, 0.0)
    for i in range(period, len(values)):
        g = np.mean(gains[i - period:i])
        l = np.mean(losses[i - period:i])
        out[i] = 100.0 if l == 0 else 100.0 - (100.0 / (1.0 + g / l))
    return out


def ma(values: np.ndarray, n: int) -> np.ndarray:
    out = np.full(len(values), np.nan)
    if len(values) < n:
        return out
    for i in range(n - 1, len(values)):
        out[i] = float(np.mean(values[i - n + 1:i + 1]))
    return out


def market_risk_by_date(index_rows: list[dict]) -> dict[str, int]:
    closes = np.array([x["close"] for x in index_rows], dtype=float)
    dates = [x["date"] for x in index_rows]
    ma20 = ma(closes, 20)
    ma60 = ma(closes, 60)
    risk = {}
    for i, d in enumerate(dates):
        if i < 65 or np.isnan(ma60[i]) or np.isnan(ma60[i - 5]):
            risk[d] = 0
            continue
        slope = (ma60[i] / ma60[i - 5] - 1.0) * 100.0
        if closes[i] < ma60[i] and slope < -0.5:
            risk[d] = 2
        elif closes[i] < ma60[i] or (not np.isnan(ma20[i]) and ma20[i] < ma60[i]):
            risk[d] = 1
        else:
            risk[d] = 0
    return risk


def evaluate(limit: int, hold_days: int, cost_pct: float) -> dict:
    stocks = get_hs300_stocks()[:limit]
    index_rows = fetch_kline("000300.SH", 700)
    risk_map = market_risk_by_date(index_rows)
    buckets = defaultdict(lambda: {"n": 0, "win": 0, "ret": 0.0})
    sell_plan = {"n": 0, "win": 0, "ret": 0.0, "tp1": 0, "tp2": 0, "sl": 0}

    for idx, stock in enumerate(stocks):
        rows = fetch_kline(stock["symbol"], 700)
        if len(rows) < 100:
            continue
        closes = np.array([x["close"] for x in rows], dtype=float)
        vols = np.array([x["volume"] for x in rows], dtype=float)
        dates = [x["date"] for x in rows]
        rsi14 = rsi(closes, 14)
        ma20 = ma(closes, 20)
        ma60 = ma(closes, 60)
        vol_ma10 = ma(vols, 10)

        for i in range(65, len(rows) - hold_days):
            if np.isnan(ma60[i]) or np.isnan(ma60[i - 5]) or np.isnan(rsi14[i]):
                continue
            slope_pct = (ma60[i] / ma60[i - 5] - 1.0) * 100.0
            ret_5d = (closes[i] / closes[i - 5] - 1.0) * 100.0
            ret_10d = (closes[i] / closes[i - 10] - 1.0) * 100.0
            dist_ma60_pct = (closes[i] / ma60[i] - 1.0) * 100.0
            vol_ratio = vols[i] / vol_ma10[i] if not np.isnan(vol_ma10[i]) and vol_ma10[i] else None
            timing = _score_timing(
                float(rsi14[i]), None, None, None, None, float(slope_pct), None, None, None,
                vol_ratio=vol_ratio,
                ret_5d=float(ret_5d),
                ret_10d=float(ret_10d),
                dist_ma60_pct=float(dist_ma60_pct),
            )
            if timing < 60:
                continue

            risk = risk_map.get(dates[i], 0)
            filtered = timing
            if risk == 2 and filtered > 60:
                filtered = 60
            elif risk == 1 and filtered > 80:
                filtered = 80

            future_ret = (closes[i + hold_days] / closes[i] - 1.0) * 100.0 - cost_pct
            for name, score in (("baseline_all", timing), ("filtered_all", filtered)):
                if score >= 60:
                    buckets[name]["n"] += 1
                    buckets[name]["win"] += int(future_ret > 0)
                    buckets[name]["ret"] += future_ret
                if score >= 90:
                    key = name.replace("all", "strong")
                    buckets[key]["n"] += 1
                    buckets[key]["win"] += int(future_ret > 0)
                    buckets[key]["ret"] += future_ret

            if filtered >= 90:
                entry = closes[i]
                tp1 = max(ma20[i] if not np.isnan(ma20[i]) and ma20[i] > entry else entry * 1.05, entry * 1.05)
                tp2 = max(ma60[i] if not np.isnan(ma60[i]) and ma60[i] > tp1 else entry * 1.10, entry * 1.10)
                stop = entry * 0.92
                cash_ret = None
                half_sold = False
                for j in range(i + 1, i + hold_days + 1):
                    high = rows[j]["high"]
                    low = rows[j]["low"]
                    if low <= stop:
                        cash_ret = -8.0 - cost_pct
                        sell_plan["sl"] += 1
                        break
                    if high >= tp2:
                        cash_ret = 10.0 - cost_pct if not half_sold else 7.5 - cost_pct
                        sell_plan["tp2"] += 1
                        break
                    if high >= tp1 and not half_sold:
                        half_sold = True
                        sell_plan["tp1"] += 1
                if cash_ret is None:
                    end_ret = (closes[i + hold_days] / entry - 1.0) * 100.0
                    cash_ret = ((5.0 + end_ret) / 2.0 - cost_pct) if half_sold else (end_ret - cost_pct)
                sell_plan["n"] += 1
                sell_plan["win"] += int(cash_ret > 0)
                sell_plan["ret"] += cash_ret

        print(f"{idx + 1}/{len(stocks)} {stock['symbol']}")
        time.sleep(0.03)

    def finish(v: dict) -> dict:
        n = v["n"]
        return {
            "samples": n,
            "win_rate": round(v["win"] / n * 100.0, 2) if n else 0.0,
            "avg_return": round(v["ret"] / n, 2) if n else 0.0,
        }

    result = {k: finish(v) for k, v in sorted(buckets.items())}
    result["sell_plan_filtered_strong"] = {
        **finish(sell_plan),
        "tp1_hits": sell_plan["tp1"],
        "tp2_hits": sell_plan["tp2"],
        "stop_hits": sell_plan["sl"],
    }
    return result


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=120)
    p.add_argument("--hold-days", type=int, default=20)
    p.add_argument("--cost-pct", type=float, default=0.3)
    args = p.parse_args()
    print(json.dumps(evaluate(args.limit, args.hold_days, args.cost_pct), ensure_ascii=False, indent=2))
