from __future__ import annotations

import argparse
import json
import os
import re
import signal
import time
import csv
from collections import defaultdict
from io import StringIO

import numpy as np
import pandas as pd
import requests


US_SYMBOLS = [
    "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AVGO", "COST", "NFLX",
    "AMD", "ADBE", "CRM", "ORCL", "INTC", "QCOM", "TXN", "AMAT", "MU", "NOW",
    "JPM", "BAC", "WFC", "GS", "MS", "V", "MA", "AXP", "PYPL", "COIN",
    "UNH", "LLY", "JNJ", "ABBV", "MRK", "PFE", "TMO", "ABT", "ISRG", "DHR",
    "HD", "MCD", "NKE", "SBUX", "DIS", "BKNG", "UBER", "ABNB", "CMG", "LOW",
    "XOM", "CVX", "COP", "SLB", "LIN", "CAT", "DE", "GE", "BA", "RTX",
]

HK_SYMBOLS = [
    "00700.HK", "09988.HK", "03690.HK", "01810.HK", "09618.HK", "09888.HK", "01024.HK", "09868.HK", "06618.HK", "09626.HK",
    "00941.HK", "00762.HK", "00728.HK", "00005.HK", "00011.HK", "00016.HK", "00066.HK", "00027.HK", "01299.HK", "02318.HK",
    "03988.HK", "01398.HK", "00939.HK", "03968.HK", "02388.HK", "02628.HK", "02313.HK", "02020.HK", "02331.HK", "01347.HK",
    "00883.HK", "00857.HK", "00386.HK", "01088.HK", "01093.HK", "01177.HK", "02269.HK", "06160.HK", "02282.HK", "01801.HK",
    "02382.HK", "00992.HK", "02018.HK", "02359.HK", "00388.HK", "00669.HK", "01928.HK", "00688.HK", "01044.HK", "00291.HK",
]

HK_COMPOSITE_SUBINDEXES = ["HSHKLI", "HSHKMI", "HSHKSI"]


def _disable_proxies():
    for k in list(os.environ):
        if "proxy" in k.lower():
            del os.environ[k]


class _FetchTimeout(Exception):
    pass


def _alarm_handler(_signum, _frame):
    raise _FetchTimeout()


def _fetch_history_tencent(symbol: str, days: int = 900) -> pd.DataFrame | None:
    try:
        base = symbol.split(".", 1)[0].upper()
        if symbol.upper().endswith(".HK"):
            q = f"hk{base.zfill(5)}"
        else:
            return None
        url = f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={q},day,2022-01-01,,{days},"
        resp = requests.get(url, timeout=10, headers={"User-Agent": "Mozilla/5.0"})
        body = resp.json().get("data", {}).get(q, {})
        raw = body.get("day", []) or []
        rows = []
        for item in raw:
            if len(item) < 6:
                continue
            try:
                rows.append({
                    "date": pd.to_datetime(item[0], errors="coerce"),
                    "open": pd.to_numeric(item[1], errors="coerce"),
                    "high": pd.to_numeric(item[3], errors="coerce"),
                    "low": pd.to_numeric(item[4], errors="coerce"),
                    "close": pd.to_numeric(item[2], errors="coerce"),
                    "volume": pd.to_numeric(item[5], errors="coerce"),
                })
            except Exception:
                continue
        if not rows:
            return None
        out = pd.DataFrame(rows).dropna(subset=["date", "close", "high", "low"]).sort_values("date")
        return out.tail(days) if len(out) >= 180 else None
    except Exception:
        return None


def _fetch_history_stooq(symbol: str, days: int = 900) -> pd.DataFrame | None:
    try:
        base = symbol.split(".", 1)[0].lower()
        url = f"https://stooq.com/q/d/l/?s={base}.us&i=d"
        resp = requests.get(url, timeout=12, headers={"User-Agent": "Mozilla/5.0"})
        resp.raise_for_status()
        reader = csv.DictReader(resp.text.splitlines())
        rows = [r for r in reader if r.get("Close") and r.get("Close") != "-"]
        if not rows:
            return None
        out = pd.DataFrame({
            "date": pd.to_datetime([r.get("Date") for r in rows], errors="coerce"),
            "open": pd.to_numeric([r.get("Open") for r in rows], errors="coerce"),
            "high": pd.to_numeric([r.get("High") for r in rows], errors="coerce"),
            "low": pd.to_numeric([r.get("Low") for r in rows], errors="coerce"),
            "close": pd.to_numeric([r.get("Close") for r in rows], errors="coerce"),
            "volume": pd.to_numeric([r.get("Volume") for r in rows], errors="coerce"),
        }).dropna(subset=["date", "close", "high", "low"]).sort_values("date")
        return out.tail(days) if len(out) >= 180 else None
    except Exception:
        return None


def fetch_history(symbol: str, days: int = 900) -> pd.DataFrame | None:
    _disable_proxies()
    try:
        if symbol.upper().endswith(".HK"):
            return _fetch_history_tencent(symbol, days)

        import yfinance as yf
        old_handler = signal.getsignal(signal.SIGALRM)
        signal.signal(signal.SIGALRM, _alarm_handler)
        signal.alarm(12)
        try:
            df = yf.download(symbol, period="3y", interval="1d", progress=False, threads=False, auto_adjust=False)
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, old_handler)
        if df is None or df.empty:
            return _fetch_history_stooq(symbol, days)
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = [c[0] for c in df.columns]
        out = pd.DataFrame({
            "date": pd.to_datetime(df.index, errors="coerce"),
            "open": pd.to_numeric(df.get("Open"), errors="coerce"),
            "high": pd.to_numeric(df.get("High"), errors="coerce"),
            "low": pd.to_numeric(df.get("Low"), errors="coerce"),
            "close": pd.to_numeric(df.get("Close"), errors="coerce"),
            "volume": pd.to_numeric(df.get("Volume"), errors="coerce"),
        }).dropna(subset=["date", "close", "high", "low"]).sort_values("date")
        return out.tail(days) if len(out) >= 180 else None
    except _FetchTimeout:
        return _fetch_history_stooq(symbol, days)
    except Exception:
        return _fetch_history_stooq(symbol, days) if not symbol.upper().endswith(".HK") else None


def get_sp500_symbols() -> list[str]:
    try:
        resp = requests.get(
            "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies",
            timeout=20,
            headers={"User-Agent": "Mozilla/5.0"},
        )
        resp.raise_for_status()
        tables = pd.read_html(StringIO(resp.text))
        if not tables:
            raise ValueError("no tables")
        symbol_col = next((c for c in tables[0].columns if str(c).lower() == "symbol"), None)
        if symbol_col is None:
            raise ValueError("symbol column missing")
        out = []
        for value in tables[0][symbol_col].astype(str).tolist():
            sym = value.strip().upper().replace(".", "-")
            if sym:
                out.append(sym)
        return list(dict.fromkeys(out))
    except Exception:
        return US_SYMBOLS


def get_hk_composite_symbols() -> list[str]:
    symbols: list[str] = []
    headers = {"User-Agent": "Mozilla/5.0"}
    for index_code in HK_COMPOSITE_SUBINDEXES:
        url = f"https://www.aastocks.com/en/stocks/market/index/hk-index-con.aspx?index={index_code}&t=6&o=1"
        try:
            html = requests.get(url, timeout=20, headers=headers).text
            codes = re.findall(r"symbol=(\d{5})", html)
            for code in codes:
                if code == "02800":
                    continue
                symbols.append(f"{code}.HK")
            time.sleep(0.2)
        except Exception:
            continue
    deduped = list(dict.fromkeys(symbols))
    return deduped or HK_SYMBOLS


def ma(values: np.ndarray, n: int) -> np.ndarray:
    out = np.full(len(values), np.nan)
    if len(values) < n:
        return out
    for i in range(n - 1, len(values)):
        out[i] = float(np.mean(values[i - n + 1:i + 1]))
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


def score_candidates(rows: pd.DataFrame) -> list[dict]:
    close = rows["close"].to_numpy(dtype=float)
    volume = rows["volume"].to_numpy(dtype=float)
    rsi14 = rsi(close, 14)
    ma20 = ma(close, 20)
    ma60 = ma(close, 60)
    vol20 = ma(volume, 20)
    out = []
    for i in range(65, len(rows) - 30):
        if np.isnan(rsi14[i]) or np.isnan(ma20[i]) or np.isnan(ma60[i]) or np.isnan(ma60[i - 10]):
            continue
        ret_5d = (close[i] / close[i - 5] - 1.0) * 100.0
        ret_20d = (close[i] / close[i - 20] - 1.0) * 100.0
        slope_10 = (ma60[i] / ma60[i - 10] - 1.0) * 100.0
        dist20 = (close[i] / ma20[i] - 1.0) * 100.0
        dist60 = (close[i] / ma60[i] - 1.0) * 100.0
        vol_ratio = volume[i] / vol20[i] if not np.isnan(vol20[i]) and vol20[i] else None

        trend_score = 0
        if close[i] > ma20[i] > ma60[i] and slope_10 > 0:
            trend_score += 45
        if ret_20d > 5:
            trend_score += 25
        if ret_5d > 0:
            trend_score += 10
        if rsi14[i] < 70:
            trend_score += 10
        if vol_ratio is not None and vol_ratio > 1.1:
            trend_score += 10

        pullback_score = 0
        if close[i] > ma60[i] and -6 <= dist20 <= 1:
            pullback_score += 35
        if 35 <= rsi14[i] <= 55:
            pullback_score += 25
        if slope_10 > 0:
            pullback_score += 20
        if -8 <= ret_5d <= 1:
            pullback_score += 20

        reversal_score = 0
        if rsi14[i] < 35:
            reversal_score += 35
        if ret_5d < -5:
            reversal_score += 25
        if dist60 < -8:
            reversal_score += 20
        if vol_ratio is not None and vol_ratio > 1.2:
            reversal_score += 20

        out.append({
            "i": i,
            "trend": trend_score,
            "pullback": pullback_score,
            "reversal": reversal_score,
        })
    return out


def evaluate_market(symbols: list[str], limit: int, cost_pct: float) -> dict:
    holds = [10, 20, 30]
    thresholds = [70, 80, 90]
    buy = defaultdict(lambda: {"n": 0, "win": 0, "ret": 0.0})
    sell = defaultdict(lambda: {"n": 0, "win": 0, "ret": 0.0, "tp1": 0, "tp2": 0, "sl": 0})
    loaded = 0

    for symbol in symbols[:limit]:
        rows = fetch_history(symbol)
        if rows is None or len(rows) < 180:
            continue
        loaded += 1
        arr = rows.to_dict("records")
        close = rows["close"].to_numpy(dtype=float)
        candidates = score_candidates(rows)
        for c in candidates:
            i = c["i"]
            for model in ("trend", "pullback", "reversal"):
                score = c[model]
                for h in holds:
                    ret = (close[i + h] / close[i] - 1.0) * 100.0 - cost_pct
                    for t in thresholds:
                        if score >= t:
                            k = (model, t, h)
                            buy[k]["n"] += 1
                            buy[k]["win"] += int(ret > 0)
                            buy[k]["ret"] += ret

                if model == "pullback" and score >= 80:
                    entry = close[i]
                    fixed = (close[i + 20] / entry - 1.0) * 100.0 - cost_pct
                    sell[("fixed20", 0, 0, 0)]["n"] += 1
                    sell[("fixed20", 0, 0, 0)]["win"] += int(fixed > 0)
                    sell[("fixed20", 0, 0, 0)]["ret"] += fixed
                    for stop in (0.92, 0.95):
                        for tp1 in (1.06, 1.08):
                            for tp2 in (1.12, 1.16):
                                cash = None
                                half = False
                                tp1_hit = tp2_hit = sl_hit = 0
                                for j in range(i + 1, i + 21):
                                    high = float(arr[j]["high"])
                                    low = float(arr[j]["low"])
                                    if low <= entry * stop:
                                        cash = (stop - 1.0) * 100.0 - cost_pct
                                        sl_hit = 1
                                        break
                                    if high >= entry * tp2:
                                        cash = ((tp2 - 1.0) * 100.0 - cost_pct) if not half else (((tp1 - 1.0) * 100.0 + (tp2 - 1.0) * 100.0) / 2.0 - cost_pct)
                                        tp2_hit = 1
                                        break
                                    if high >= entry * tp1 and not half:
                                        half = True
                                        tp1_hit = 1
                                if cash is None:
                                    end_ret = (close[i + 20] / entry - 1.0) * 100.0
                                    cash = (((tp1 - 1.0) * 100.0 + end_ret) / 2.0 - cost_pct) if half else (end_ret - cost_pct)
                                k = ("sell20", stop, tp1, tp2)
                                sell[k]["n"] += 1
                                sell[k]["win"] += int(cash > 0)
                                sell[k]["ret"] += cash
                                sell[k]["tp1"] += tp1_hit
                                sell[k]["tp2"] += tp2_hit
                                sell[k]["sl"] += sl_hit
        print(symbol)
        time.sleep(0.05)

    def finish(v: dict) -> dict:
        n = v["n"]
        return {"samples": n, "win_rate": round(v["win"] / n * 100.0, 2) if n else 0.0, "avg_return": round(v["ret"] / n, 2) if n else 0.0}

    buy_out = []
    for k, v in buy.items():
        r = finish(v)
        r.update({"model": k[0], "threshold": k[1], "hold_days": k[2]})
        if r["samples"] >= 50:
            buy_out.append(r)
    sell_out = []
    for k, v in sell.items():
        r = finish(v)
        r.update({"kind": k[0], "stop": k[1], "tp1": k[2], "tp2": k[3], "tp1_hits": v.get("tp1", 0), "tp2_hits": v.get("tp2", 0), "stop_hits": v.get("sl", 0)})
        if r["samples"] >= 50:
            sell_out.append(r)
    return {
        "loaded_symbols": loaded,
        "best_buy": sorted(buy_out, key=lambda x: (x["avg_return"], x["win_rate"], x["samples"]), reverse=True)[:15],
        "best_sell_or_fixed": sorted(sell_out, key=lambda x: (x["avg_return"], x["win_rate"]), reverse=True)[:15],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--market", choices=["US", "HK"], required=True)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--cost-pct", type=float, default=0.3)
    parser.add_argument("--universe", choices=["default", "expanded"], default="default")
    args = parser.parse_args()
    if args.market == "US":
        symbols = get_sp500_symbols() if args.universe == "expanded" else US_SYMBOLS
    else:
        symbols = get_hk_composite_symbols() if args.universe == "expanded" else HK_SYMBOLS
    limit = args.limit or len(symbols)
    result = evaluate_market(symbols, limit, args.cost_pct)
    result.update({
        "market": args.market,
        "universe": args.universe,
        "requested_symbols": len(symbols),
        "effective_limit": limit,
    })
    print(json.dumps(result, ensure_ascii=False, indent=2))
