from __future__ import annotations

import re
import json
import time
import concurrent.futures
import logging
import csv
import streamlit as st

from core.repository import upsert_company, upsert_report_market_fetch
from core.schema import init_db
from core.stock_search import infer_market, is_explicit_symbol, normalize_symbol
from core.styles import inject_css, render_sidebar_nav, render_mobile_nav
from core.financial_data import fetch_financials, compute_metrics_from_financial_data
from core.net import disable_proxies_for_process


logger = logging.getLogger(__name__)


def _run_with_timeout(fn, timeout_seconds: float):
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
        future = ex.submit(fn)
        return future.result(timeout=timeout_seconds)


@st.cache_data(ttl=60)
def _akshare_spot_df(market: str):
    disable_proxies_for_process()
    import akshare as ak

    # Zeabur 部署环境增加超时时间
    if market == "CN":
        return _run_with_timeout(lambda: ak.stock_zh_a_spot_em(), 15)
    if market == "HK":
        return _run_with_timeout(lambda: ak.stock_hk_spot_em(), 15)
    if market == "US":
        return _run_with_timeout(lambda: ak.stock_us_spot_em(), 15)
    return None


@st.cache_data(ttl=24 * 3600)
def _hk_issued_shares(code5: str) -> float | None:
    try:
        disable_proxies_for_process()
        import akshare as ak

        c = (code5 or "").strip().upper().replace(".HK", "")
        c = c.zfill(5)
        # Zeabur 部署环境增加超时时间
        df = _run_with_timeout(lambda: ak.stock_hk_financial_indicator_em(symbol=c), 18)
        if df is None or df.empty:
            return None
        row = df.iloc[0]
        # 文档示例字段：已发行股本(股)
        for k in ["已发行股本(股)", "已发行股本(股)"]:
            if k in row:
                v = row.get(k)
                try:
                    fv = float(str(v).replace(",", "").strip())
                    return fv if fv > 0 else None
                except Exception:
                    continue
        # 兜底：扫描列名
        for col in df.columns:
            if "已发行" in str(col) and "股本" in str(col):
                try:
                    fv = float(str(row.get(col)).replace(",", "").strip())
                    return fv if fv > 0 else None
                except Exception:
                    continue
        return None
    except Exception:
        return None


def _akshare_price(symbol: str, market: str) -> dict | None:
    try:
        df = _akshare_spot_df(market)
        if df is None or df.empty:
            return None

        if market == "CN":
            code = symbol.split(".")[0]
        elif market == "HK":
            code = symbol.replace(".HK", "")
            code = code.zfill(5)
        else:
            code = symbol

        code_col = "代码" if "代码" in df.columns else df.columns[0]
        row_df = df[df[code_col].astype(str).str.upper() == str(code).upper()]
        if row_df.empty:
            return None

        row = row_df.iloc[0]
        name_col = "名称" if "名称" in df.columns else None
        price_col = "最新价" if "最新价" in df.columns else ("最新价格" if "最新价格" in df.columns else None)
        chg_col = "涨跌额" if "涨跌额" in df.columns else ("涨跌" if "涨跌" in df.columns else None)
        chg_pct_col = "涨跌幅" if "涨跌幅" in df.columns else ("涨跌幅(%)" if "涨跌幅(%)" in df.columns else None)
        vol_col = "成交量" if "成交量" in df.columns else None
        amt_col = None
        for c in df.columns:
            sc = str(c)
            if sc in ("成交额", "成交额(元)", "成交额(人民币)") or ("成交额" in sc and amt_col is None):
                amt_col = c
                break
        # 不同市场列名可能不同（尤其美股/港股）
        mcap_col = "总市值" if "总市值" in df.columns else None
        if not mcap_col:
            for c in df.columns:
                if "市值" in str(c):
                    mcap_col = c
                    break

        price = float(row[price_col]) if price_col and row.get(price_col) not in (None, "-") else None
        chg = float(row[chg_col]) if chg_col and row.get(chg_col) not in (None, "-") else None
        chg_pct = float(row[chg_pct_col]) if chg_pct_col and row.get(chg_pct_col) not in (None, "-") else None
        vol = float(row[vol_col]) if vol_col and row.get(vol_col) not in (None, "-") else None
        turnover = float(row[amt_col]) if amt_col and row.get(amt_col) not in (None, "-") else None
        mcap = float(row[mcap_col]) if mcap_col and row.get(mcap_col) not in (None, "-") else None
        # AkShare 港股/美股 spot 的“市值”常见单位为“亿”(或其他非金额单位)，直接展示会出现 0.00亿 的错觉
        # 这里做保守启发式修正：市值为 0 视为缺失；值很小更像“亿”为单位时乘 1e8 转成金额
        if market in ("HK", "US") and mcap is not None:
            if mcap == 0:
                mcap = None
            else:
                # 如果值非常小（例如 < 1e6），更像是“亿”为单位的数值
                if mcap < 1e6:
                    mcap = mcap * 1e8
        name = str(row[name_col]).strip() if name_col and row.get(name_col) else None

        currency = "CNY" if market == "CN" else ("HKD" if market == "HK" else "USD")

        return {
            "price": price,
            "currency": currency,
            "change": chg,
            "change_percent": chg_pct,
            "volume": vol,
            "turnover": turnover,
            "market_cap": mcap,
            "name": name,
            "source": "akshare",
        }
    except concurrent.futures.TimeoutError:
        logger.warning("akshare price fetch timeout market=%s symbol=%s", market, symbol)
        return None
    except Exception:
        logger.exception("akshare price fetch failed market=%s symbol=%s", market, symbol)
        return None


def _tencent_quote_code(symbol: str, market: str) -> str | None:
    s = (symbol or "").strip().upper()
    m = (market or "").strip().upper()
    if m == "CN":
        if "." in s:
            code, suffix = s.split(".", 1)
            suffix = suffix.upper()
            if suffix == "SH":
                return f"sh{code}"
            if suffix == "SZ":
                return f"sz{code}"
            if suffix == "BJ":
                return f"bj{code}"
        if s.isdigit() and len(s) == 6:
            return f"sh{s}" if s.startswith("6") else f"sz{s}"
        return None
    if m == "HK":
        code = s.replace(".HK", "")
        if code.isdigit():
            return f"hk{code.zfill(5)}"
        return None
    if m == "US":
        if re.fullmatch(r"[A-Z.\-]{1,10}", s):
            return f"us{s}"
        return None
    return None


@st.cache_data(ttl=300)
def _tencent_kline_52w(q: str) -> tuple[float | None, float | None]:
    try:
        import httpx

        # count=260 trading days roughly equals 1 year
        url = f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={q},day,,,260,qfq"
        # Zeabur 部署环境增加超时时间
        with httpx.Client(timeout=12, follow_redirects=True) as client:
            resp = client.get(url)
            resp.raise_for_status()
            data = resp.json()

        qdata = ((data or {}).get("data") or {}).get(q) or {}
        kdata = qdata.get("day") or qdata.get("qfqday")
        if not kdata:
            return None, None

        highs = []
        lows = []
        for row in kdata:
            # [date, open, close, high, low, volume, ...]
            try:
                highs.append(float(row[3]))
                lows.append(float(row[4]))
            except Exception:
                continue
        if not highs or not lows:
            return None, None
        return max(highs), min(lows)
    except Exception:
        return None, None


@st.cache_data(ttl=300)
def _tencent_kline_stats(q: str, _v: int = 2) -> dict:
    try:
        import httpx

        url = f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={q},day,,,260,qfq"
        # Zeabur 部署环境增加超时时间
        with httpx.Client(timeout=12, follow_redirects=True) as client:
            resp = client.get(url)
            resp.raise_for_status()
            data = resp.json()

        qdata = ((data or {}).get("data") or {}).get(q) or {}
        kdata = qdata.get("day") or qdata.get("qfqday")
        if not kdata:
            return {}

        highs = []
        lows = []
        vols = []
        closes = []
        opens = []
        for row in kdata:
            try:
                highs.append(float(row[3]))
                lows.append(float(row[4]))
                vols.append(float(row[5]))
                closes.append(float(row[2]))
                opens.append(float(row[1]))
            except Exception:
                continue

        out = {}
        if highs:
            out["high_52w"] = max(highs)
        if lows:
            out["low_52w"] = min(lows)
        if vols:
            out["volume"] = vols[-1]
        try:
            out["day_high"] = float(kdata[-1][3])
            out["day_low"] = float(kdata[-1][4])
        except Exception:
            pass

        # MA5, MA10, MA20, MA60
        if len(closes) >= 5:
            out["ma5"] = sum(closes[-5:]) / 5
        if len(closes) >= 10:
            out["ma10"] = sum(closes[-10:]) / 10
        if len(closes) >= 20:
            out["ma20"] = sum(closes[-20:]) / 20
        if len(closes) >= 60:
            out["ma60"] = sum(closes[-60:]) / 60

        try:
            if len(closes) >= 21:
                out["ma20_prev"] = sum(closes[-21:-1]) / 20
            if len(closes) >= 6:
                out["ma5_prev"] = sum(closes[-6:-1]) / 5
        except Exception:
            pass

        try:
            if vols and len(vols) >= 5:
                out["vol_ma5"] = sum(vols[-5:]) / 5
            if vols and len(vols) >= 10:
                out["vol_ma10"] = sum(vols[-10:]) / 10
        except Exception:
            pass

        try:
            if closes and len(closes) >= 35:
                def _ema(seq: list[float], span: int) -> list[float]:
                    k = 2 / (span + 1)
                    ema = []
                    for i, v in enumerate(seq):
                        if i == 0:
                            ema.append(v)
                        else:
                            ema.append(v * k + ema[-1] * (1 - k))
                    return ema

                ema12 = _ema(closes, 12)
                ema26 = _ema(closes, 26)
                dif = [a - b for a, b in zip(ema12, ema26)]
                dea = _ema(dif, 9)
                hist = [(d - s) * 2 for d, s in zip(dif, dea)]
                out["macd_dif"] = dif[-1]
                out["macd_dea"] = dea[-1]
                out["macd_hist"] = hist[-1]
                out["macd_hist_prev"] = hist[-2] if len(hist) >= 2 else None
        except Exception:
            pass

        try:
            if closes and opens and lows:
                last_close = closes[-1]
                last_open = opens[-1] if len(opens) == len(closes) else None
                last_low = lows[-1] if len(lows) == len(closes) else None
                out["last_close"] = last_close
                out["last_open"] = last_open
                out["last_low"] = last_low
        except Exception:
            pass

        # RSI (14-day)
        if len(closes) >= 15:
            gains = []
            losses = []
            for i in range(-14, 0):
                diff = closes[i] - closes[i - 1]
                if diff > 0:
                    gains.append(diff)
                    losses.append(0)
                else:
                    gains.append(0)
                    losses.append(abs(diff))
            avg_gain = sum(gains) / 14
            avg_loss = sum(losses) / 14
            if avg_loss == 0:
                out["rsi"] = 100.0
            else:
                rs = avg_gain / avg_loss
                out["rsi"] = 100 - (100 / (1 + rs))

        return out
    except Exception:
        return {}


@st.cache_data(ttl=3600)
def _stooq_us_stats(symbol: str) -> dict:
    try:
        import httpx

        sym = (symbol or "").strip().lower()
        if not sym:
            return {}
        if not sym.endswith(".us"):
            sym = f"{sym}.us"

        url = f"https://stooq.com/q/d/l/?s={sym}&i=d"
        # Zeabur 部署环境可能网络较慢，增加超时时间
        with httpx.Client(timeout=15, follow_redirects=True) as client:
            resp = client.get(url)
            resp.raise_for_status()
            text = resp.text

        reader = csv.DictReader(text.splitlines())
        rows = [r for r in reader if r.get("Close") and r.get("Close") != "-"]
        if not rows:
            return {}

        tail = rows[-260:] if len(rows) >= 260 else rows
        highs = []
        lows = []
        closes = []
        vols = []
        try:
            for r in tail:
                if r.get("High"):
                    highs.append(float(r["High"]))
                if r.get("Low"):
                    lows.append(float(r["Low"]))
                if r.get("Close"):
                    closes.append(float(r["Close"]))
                if r.get("Volume") and r.get("Volume") != "-":
                    vols.append(float(r["Volume"]))
        except Exception:
            highs = []
            lows = []
            closes = []
            vols = []

        out = {}
        if highs:
            out["high_52w"] = max(highs)
        if lows:
            out["low_52w"] = min(lows)

        last = rows[-1]
        try:
            out["volume"] = float(last.get("Volume")) if last.get("Volume") not in (None, "", "-") else None
        except Exception:
            out["volume"] = None
        try:
            out["day_high"] = float(last.get("High")) if last.get("High") not in (None, "", "-") else None
            out["day_low"] = float(last.get("Low")) if last.get("Low") not in (None, "", "-") else None
        except Exception:
            pass

        try:
            if closes and len(closes) >= 5:
                out["ma5"] = sum(closes[-5:]) / 5
            if closes and len(closes) >= 20:
                out["ma20"] = sum(closes[-20:]) / 20
            if closes and len(closes) >= 60:
                out["ma60"] = sum(closes[-60:]) / 60
            if closes and len(closes) >= 21:
                out["ma20_prev"] = sum(closes[-21:-1]) / 20
            if closes and len(closes) >= 6:
                out["ma5_prev"] = sum(closes[-6:-1]) / 5
        except Exception:
            pass

        try:
            if vols and len(vols) >= 5:
                out["vol_ma5"] = sum(vols[-5:]) / 5
            if vols and len(vols) >= 10:
                out["vol_ma10"] = sum(vols[-10:]) / 10
        except Exception:
            pass

        try:
            if closes and len(closes) >= 35:
                def _ema(seq: list[float], span: int) -> list[float]:
                    k = 2 / (span + 1)
                    ema = []
                    for i, v in enumerate(seq):
                        if i == 0:
                            ema.append(v)
                        else:
                            ema.append(v * k + ema[-1] * (1 - k))
                    return ema

                ema12 = _ema(closes, 12)
                ema26 = _ema(closes, 26)
                dif = [a - b for a, b in zip(ema12, ema26)]
                dea = _ema(dif, 9)
                hist = [(d - s) * 2 for d, s in zip(dif, dea)]
                out["macd_dif"] = dif[-1]
                out["macd_dea"] = dea[-1]
                out["macd_hist"] = hist[-1]
                out["macd_hist_prev"] = hist[-2] if len(hist) >= 2 else None
        except Exception:
            pass

        try:
            if rows and rows[-1].get("Close"):
                out["last_close"] = float(rows[-1].get("Close"))
        except Exception:
            pass

        # RSI (14-day)
        if len(closes) >= 15:
            try:
                gains = []
                losses = []
                for i in range(-14, 0):
                    diff = closes[i] - closes[i - 1]
                    if diff > 0:
                        gains.append(diff)
                        losses.append(0)
                    else:
                        gains.append(0)
                        losses.append(abs(diff))
                avg_gain = sum(gains) / 14
                avg_loss = sum(losses) / 14
                if avg_loss == 0:
                    out["rsi"] = 100.0
                else:
                    rs = avg_gain / avg_loss
                    out["rsi"] = 100 - (100 / (1 + rs))
            except Exception:
                pass

        return out
    except Exception:
        return {}


def _tencent_price(symbol: str, market: str) -> dict | None:
    try:
        import httpx

        q = _tencent_quote_code(symbol, market)
        if not q:
            return None

        url = f"https://qt.gtimg.cn/q={q}"
        # Zeabur 部署环境增加超时时间
        with httpx.Client(timeout=10, follow_redirects=True) as client:
            resp = client.get(url)
            resp.raise_for_status()
            text = resp.text

        if "~" not in text:
            return None
        payload = text.split("\"", 2)[1]
        parts = payload.split("~")
        if len(parts) < 6:
            return None

        def _first_float(parts: list[str], idxs: list[int]) -> float | None:
            for i in idxs:
                if 0 <= i < len(parts):
                    try:
                        v = parts[i]
                        if v in (None, "", "-"):
                            continue
                        return float(v)
                    except Exception:
                        continue
            return None

        name = parts[1] or None
        price = None
        prev_close = None
        try:
            price = float(parts[3])
        except Exception:
            price = None
        try:
            prev_close = float(parts[4])
        except Exception:
            prev_close = None

        chg = None
        chg_pct = None
        if price is not None and prev_close not in (None, 0):
            chg = price - prev_close
            chg_pct = (chg / prev_close) * 100

        volume = _first_float(parts, [6, 7, 8, 36, 37])
        day_high = _first_float(parts, [33, 41, 44, 46])
        day_low = _first_float(parts, [34, 42, 45, 47])
        market_cap = _first_float(parts, [45, 46, 47, 48, 49, 53, 54, 55])

        # 市值字段在腾讯不同市场/不同接口返回的“单位”与“索引”都不稳定。
        # 优先用“股本(股数) * 当前价”来推导市值（更稳），其次再对疑似“亿”为单位的值做换算。
        shares = None
        if market == "US":
            shares = _first_float(parts, [62, 63, 64, 65])
        elif market == "CN":
            shares = _first_float(parts, [72, 73, 74, 75, 76])
        elif market == "HK":
            shares = _first_float(parts, [62, 63, 64, 65])

        # 兜底：部分环境腾讯字段索引会变动，尝试在末尾字段中启发式识别“股本/总股本”
        if shares is None:
            try:
                candidates: list[float] = []
                for i in range(max(0, len(parts) - 30), len(parts)):
                    try:
                        sv = parts[i]
                        if sv in (None, "", "-"):
                            continue
                        fv = float(sv)
                        # 过滤明显不是股本的字段：时间戳、成交额等
                        if fv < 1e7 or fv > 1e12:
                            continue
                        # 若为时间戳（例如 20260129...），直接跳过
                        if fv > 2e12:
                            continue
                        candidates.append(fv)
                    except Exception:
                        continue
                if candidates:
                    shares = max(candidates)
            except Exception:
                pass

        try:
            if (market_cap is None or market_cap < 1e8) and price is not None and shares is not None and shares > 1e6:
                market_cap = float(price) * float(shares)
        except Exception:
            pass

        # 兜底：如果市值很小但又不是空值，且在 CN/HK 市场更像是“亿”为单位，统一转成金额
        try:
            if market in ("CN", "HK") and market_cap is not None and 1 < market_cap < 1e7:
                market_cap = float(market_cap) * 1e8
        except Exception:
            pass

        kstats = _tencent_kline_stats(q)
        high_52w = kstats.get("high_52w")
        low_52w = kstats.get("low_52w")
        volume = volume if volume is not None else kstats.get("volume")
        day_high = day_high if day_high is not None else kstats.get("day_high")
        day_low = day_low if day_low is not None else kstats.get("day_low")

        # 美股：腾讯 K 线数据经常不稳定（只有几行），强制使用 Stooq 作为主要数据源
        if market == "US":
            sstats = _stooq_us_stats(symbol)
            high_52w = sstats.get("high_52w") or high_52w
            low_52w = sstats.get("low_52w") or low_52w
            volume = volume if volume is not None else sstats.get("volume")
            day_high = day_high if day_high is not None else sstats.get("day_high")
            day_low = day_low if day_low is not None else sstats.get("day_low")
            # 美股技术指标优先使用 Stooq（数据更完整）
            for k in ("ma5", "ma10", "ma20", "ma60", "rsi", "macd_dif", "macd_dea", "macd_hist", "macd_hist_prev", "vol_ma5", "vol_ma10", "ma5_prev", "ma20_prev", "last_close"):
                if sstats.get(k) is not None:
                    kstats[k] = sstats[k]

        currency = "CNY" if market == "CN" else ("HKD" if market == "HK" else "USD")
        out = {
            "price": price,
            "currency": currency,
            "change": chg,
            "change_percent": chg_pct,
            "high_52w": high_52w or day_high,
            "low_52w": low_52w or day_low,
            "volume": volume,
            "market_cap": market_cap,
            "name": name,
            "source": "tencent",
            "ma5": kstats.get("ma5"),
            "ma10": kstats.get("ma10"),
            "ma20": kstats.get("ma20"),
            "ma60": kstats.get("ma60"),
            "rsi": kstats.get("rsi"),
            "macd_dif": kstats.get("macd_dif"),
            "macd_dea": kstats.get("macd_dea"),
            "macd_hist": kstats.get("macd_hist"),
            "macd_hist_prev": kstats.get("macd_hist_prev"),
            "vol_ma5": kstats.get("vol_ma5"),
            "vol_ma10": kstats.get("vol_ma10"),
            "ma5_prev": kstats.get("ma5_prev"),
            "ma20_prev": kstats.get("ma20_prev"),
            "last_close": kstats.get("last_close"),
            "last_open": kstats.get("last_open"),
            "last_low": kstats.get("last_low"),
        }

        # 港股市值：腾讯经常不给，改用“已发行股本(股)”*当前价 计算
        if market == "HK":
            try:
                mc = out.get("market_cap")
                if mc is None or mc <= 0 or mc < 5e8:
                    code5 = symbol.replace(".HK", "").zfill(5)
                    shares = _hk_issued_shares(code5)
                    if shares and out.get("price"):
                        out["market_cap"] = float(out["price"]) * float(shares)
                        out["source"] = f"{out.get('source')}+issued_shares"
            except Exception:
                pass

        return out
    except Exception:
        logger.exception("tencent price fetch failed market=%s symbol=%s", market, symbol)
        return None


@st.cache_data(ttl=300)  # 缓存5分钟
def get_stock_price(symbol: str, market: str) -> dict | None:
    """获取股票实时价格"""
    # Prefer Tencent quotes in deployment to avoid yfinance rate limits.
    tx_data = _tencent_price(symbol, market)
    # 美股：部署环境 yfinance 极易触发限流 (YFRateLimitError)。
    # 只要腾讯能拿到实时价，就直接返回腾讯（市值已在 _tencent_price 内尽力推导）。
    # 如需补齐市值，仅尝试 AkShare；失败也不影响行情展示。
    if tx_data and tx_data.get("price") is not None:
        if market == "US":
            try:
                mc = tx_data.get("market_cap")
                if mc is None or mc < 1e9:
                    ak_data = _akshare_price(symbol, market)
                    if ak_data and ak_data.get("market_cap"):
                        merged = dict(tx_data)
                        merged["market_cap"] = ak_data.get("market_cap")
                        merged["source"] = f"{merged.get('source')}+akshare"
                        return merged
            except Exception:
                pass
            return tx_data
        return tx_data

    try:
        import yfinance as yf

        if market == "CN":
            yf_symbol = symbol.replace(".SH", ".SS")
        elif market == "HK":
            if symbol.isdigit():
                code = symbol.replace(".HK", "")
                yf_symbol = f"{code.zfill(4)}.HK"
            else:
                yf_symbol = symbol
        else:
            yf_symbol = symbol

        ticker = yf.Ticker(yf_symbol)
        # Zeabur 部署环境 yfinance 容易超时，增加超时时间
        info = _run_with_timeout(lambda: ticker.info, 10)

        if info and (info.get("regularMarketPrice") is not None or info.get("currentPrice") is not None):
            # Try to get MA/RSI from Tencent K-line as supplement
            q = _tencent_quote_code(symbol, market)
            kstats = _tencent_kline_stats(q) if q else {}
            y_data = {
                "price": info.get("regularMarketPrice") or info.get("currentPrice"),
                "currency": info.get("currency", "USD"),
                "change": info.get("regularMarketChange"),
                "change_percent": info.get("regularMarketChangePercent"),
                "high_52w": info.get("fiftyTwoWeekHigh"),
                "low_52w": info.get("fiftyTwoWeekLow"),
                "volume": info.get("regularMarketVolume"),
                "market_cap": info.get("marketCap"),
                "name": info.get("shortName") or info.get("longName"),
                "source": "yfinance",
                "ma5": kstats.get("ma5"),
                "ma20": kstats.get("ma20"),
                "rsi": kstats.get("rsi"),
            }
            if tx_data and tx_data.get("price") is not None and market == "US":
                merged = dict(tx_data)
                if (merged.get("market_cap") is None or merged.get("market_cap", 0) < 1e9) and y_data.get("market_cap"):
                    merged["market_cap"] = y_data.get("market_cap")
                    merged["source"] = f"{merged.get('source')}+yfinance"
                if merged.get("high_52w") is None and y_data.get("high_52w") is not None:
                    merged["high_52w"] = y_data.get("high_52w")
                if merged.get("low_52w") is None and y_data.get("low_52w") is not None:
                    merged["low_52w"] = y_data.get("low_52w")
                if merged.get("volume") is None and y_data.get("volume") is not None:
                    merged["volume"] = y_data.get("volume")
                return merged
            return y_data
    except concurrent.futures.TimeoutError:
        logger.warning("yfinance price fetch timeout market=%s symbol=%s", market, symbol)
    except Exception:
        logger.exception("yfinance price fetch failed market=%s symbol=%s", market, symbol)

    ak_data = _akshare_price(symbol, market)
    if ak_data:
        if tx_data and tx_data.get("price") is not None and market == "US":
            merged = dict(tx_data)
            if (merged.get("market_cap") is None or merged.get("market_cap", 0) < 1e9) and ak_data.get("market_cap"):
                merged["market_cap"] = ak_data.get("market_cap")
                merged["source"] = f"{merged.get('source')}+akshare"
            return merged
        return ak_data

    # 兜底：如果 yfinance/akshare 都失败，但腾讯有价格数据，仍然返回腾讯数据
    if tx_data and tx_data.get("price") is not None:
        return tx_data

    return None

# 内置常用股票列表（避免网络请求失败）
BUILTIN_STOCKS = {
    # 美股
    "AAPL": {"market": "US", "name": "Apple Inc. (苹果)", "symbol": "AAPL"},
    "TSLA": {"market": "US", "name": "Tesla Inc. (特斯拉)", "symbol": "TSLA"},
    "MSFT": {"market": "US", "name": "Microsoft Corp. (微软)", "symbol": "MSFT"},
    "GOOGL": {"market": "US", "name": "Alphabet Inc. (谷歌)", "symbol": "GOOGL"},
    "AMZN": {"market": "US", "name": "Amazon.com Inc. (亚马逊)", "symbol": "AMZN"},
    "META": {"market": "US", "name": "Meta Platforms (脸书)", "symbol": "META"},
    "NVDA": {"market": "US", "name": "NVIDIA Corp. (英伟达)", "symbol": "NVDA"},
    "BABA": {"market": "US", "name": "Alibaba Group (阿里巴巴)", "symbol": "BABA"},
    "JD": {"market": "US", "name": "JD.com Inc. (京东)", "symbol": "JD"},
    "PDD": {"market": "US", "name": "PDD Holdings (拼多多)", "symbol": "PDD"},
    "NIO": {"market": "US", "name": "NIO Inc. (蔚来)", "symbol": "NIO"},
    "XPEV": {"market": "US", "name": "XPeng Inc. (小鹏)", "symbol": "XPEV"},
    "LI": {"market": "US", "name": "Li Auto Inc. (理想汽车)", "symbol": "LI"},
    "SBUX": {"market": "US", "name": "Starbucks Corp. (星巴克)", "symbol": "SBUX"},
    "KO": {"market": "US", "name": "Coca-Cola Co. (可口可乐)", "symbol": "KO"},
    "PEP": {"market": "US", "name": "PepsiCo Inc. (百事可乐)", "symbol": "PEP"},
    "MCD": {"market": "US", "name": "McDonald's Corp. (麦当劳)", "symbol": "MCD"},
    "DIS": {"market": "US", "name": "Walt Disney Co. (迪士尼)", "symbol": "DIS"},
    "NFLX": {"market": "US", "name": "Netflix Inc. (奈飞)", "symbol": "NFLX"},
    "INTC": {"market": "US", "name": "Intel Corp. (英特尔)", "symbol": "INTC"},
    "AMD": {"market": "US", "name": "AMD Inc. (超威半导体)", "symbol": "AMD"},
    "BA": {"market": "US", "name": "Boeing Co. (波音)", "symbol": "BA"},
    "JPM": {"market": "US", "name": "JPMorgan Chase (摩根大通)", "symbol": "JPM"},
    "V": {"market": "US", "name": "Visa Inc. (维萨)", "symbol": "V"},
    "MA": {"market": "US", "name": "Mastercard Inc. (万事达)", "symbol": "MA"},
    "WMT": {"market": "US", "name": "Walmart Inc. (沃尔玛)", "symbol": "WMT"},
    "COST": {"market": "US", "name": "Costco Wholesale (好市多)", "symbol": "COST"},
    # A股
    "600519": {"market": "CN", "name": "贵州茅台", "symbol": "600519.SH"},
    "000001": {"market": "CN", "name": "平安银行", "symbol": "000001.SZ"},
    "600036": {"market": "CN", "name": "招商银行", "symbol": "600036.SH"},
    "000858": {"market": "CN", "name": "五粮液", "symbol": "000858.SZ"},
    "601318": {"market": "CN", "name": "中国平安", "symbol": "601318.SH"},
    "600276": {"market": "CN", "name": "恒瑞医药", "symbol": "600276.SH"},
    "000333": {"market": "CN", "name": "美的集团", "symbol": "000333.SZ"},
    "600900": {"market": "CN", "name": "长江电力", "symbol": "600900.SH"},
    "601888": {"market": "CN", "name": "中国中免", "symbol": "601888.SH"},
    "300750": {"market": "CN", "name": "宁德时代", "symbol": "300750.SZ"},
    # 中文名称映射
    "苹果": {"market": "US", "name": "Apple Inc. (苹果)", "symbol": "AAPL"},
    "特斯拉": {"market": "US", "name": "Tesla Inc. (特斯拉)", "symbol": "TSLA"},
    "微软": {"market": "US", "name": "Microsoft Corp. (微软)", "symbol": "MSFT"},
    "谷歌": {"market": "US", "name": "Alphabet Inc. (谷歌)", "symbol": "GOOGL"},
    "亚马逊": {"market": "US", "name": "Amazon.com Inc. (亚马逊)", "symbol": "AMZN"},
    "脸书": {"market": "US", "name": "Meta Platforms (脸书)", "symbol": "META"},
    "英伟达": {"market": "US", "name": "NVIDIA Corp. (英伟达)", "symbol": "NVDA"},
    "阿里巴巴": {"market": "US", "name": "Alibaba Group (阿里巴巴)", "symbol": "BABA"},
    "京东": {"market": "US", "name": "JD.com Inc. (京东)", "symbol": "JD"},
    "拼多多": {"market": "US", "name": "PDD Holdings (拼多多)", "symbol": "PDD"},
    "蔚来": {"market": "US", "name": "NIO Inc. (蔚来)", "symbol": "NIO"},
    "小鹏": {"market": "US", "name": "XPeng Inc. (小鹏)", "symbol": "XPEV"},
    "理想汽车": {"market": "US", "name": "Li Auto Inc. (理想汽车)", "symbol": "LI"},
    "茅台": {"market": "CN", "name": "贵州茅台", "symbol": "600519.SH"},
    "贵州茅台": {"market": "CN", "name": "贵州茅台", "symbol": "600519.SH"},
    "平安银行": {"market": "CN", "name": "平安银行", "symbol": "000001.SZ"},
    "招商银行": {"market": "CN", "name": "招商银行", "symbol": "600036.SH"},
    "五粮液": {"market": "CN", "name": "五粮液", "symbol": "000858.SZ"},
    "中国平安": {"market": "CN", "name": "中国平安", "symbol": "601318.SH"},
    "恒瑞医药": {"market": "CN", "name": "恒瑞医药", "symbol": "600276.SH"},
    "美的": {"market": "CN", "name": "美的集团", "symbol": "000333.SZ"},
    # 更多中文名称映射
    "星巴克": {"market": "US", "name": "Starbucks Corp. (星巴克)", "symbol": "SBUX"},
    "starbucks": {"market": "US", "name": "Starbucks Corp. (星巴克)", "symbol": "SBUX"},
    "可口可乐": {"market": "US", "name": "Coca-Cola Co. (可口可乐)", "symbol": "KO"},
    "百事可乐": {"market": "US", "name": "PepsiCo Inc. (百事可乐)", "symbol": "PEP"},
    "麦当劳": {"market": "US", "name": "McDonald's Corp. (麦当劳)", "symbol": "MCD"},
    "迪士尼": {"market": "US", "name": "Walt Disney Co. (迪士尼)", "symbol": "DIS"},
    "奈飞": {"market": "US", "name": "Netflix Inc. (奈飞)", "symbol": "NFLX"},
    "英特尔": {"market": "US", "name": "Intel Corp. (英特尔)", "symbol": "INTC"},
    "波音": {"market": "US", "name": "Boeing Co. (波音)", "symbol": "BA"},
    "摩根大通": {"market": "US", "name": "JPMorgan Chase (摩根大通)", "symbol": "JPM"},
    "沃尔玛": {"market": "US", "name": "Walmart Inc. (沃尔玛)", "symbol": "WMT"},
    # 港股
    "00700": {"market": "HK", "name": "腾讯控股", "symbol": "0700.HK"},
    "09988": {"market": "HK", "name": "阿里巴巴-SW", "symbol": "9988.HK"},
    "09618": {"market": "HK", "name": "京东集团-SW", "symbol": "9618.HK"},
    "03690": {"market": "HK", "name": "美团-W", "symbol": "3690.HK"},
    "01810": {"market": "HK", "name": "小米集团-W", "symbol": "1810.HK"},
    "09999": {"market": "HK", "name": "网易-S", "symbol": "9999.HK"},
    "00941": {"market": "HK", "name": "中国移动", "symbol": "0941.HK"},
    "00005": {"market": "HK", "name": "汇丰控股", "symbol": "0005.HK"},
    "02318": {"market": "HK", "name": "中国平安", "symbol": "2318.HK"},
    "00388": {"market": "HK", "name": "香港交易所", "symbol": "0388.HK"},
    "06862": {"market": "HK", "name": "海底捞", "symbol": "6862.HK"},
    "09633": {"market": "HK", "name": "农夫山泉", "symbol": "9633.HK"},
    "02020": {"market": "HK", "name": "安踏体育", "symbol": "2020.HK"},
    "01024": {"market": "HK", "name": "快手-W", "symbol": "1024.HK"},
    "09888": {"market": "HK", "name": "百度集团-SW", "symbol": "9888.HK"},
    "00992": {"market": "HK", "name": "联想集团", "symbol": "0992.HK"},
    "01211": {"market": "HK", "name": "比亚迪股份", "symbol": "1211.HK"},
    "00883": {"market": "HK", "name": "中国海洋石油", "symbol": "0883.HK"},
    "00857": {"market": "HK", "name": "中国石油股份", "symbol": "0857.HK"},
    "00386": {"market": "HK", "name": "中国石油化工股份", "symbol": "0386.HK"},
    "01398": {"market": "HK", "name": "工商银行", "symbol": "1398.HK"},
    "03988": {"market": "HK", "name": "中国银行", "symbol": "3988.HK"},
    "00939": {"market": "HK", "name": "建设银行", "symbol": "0939.HK"},
    "01288": {"market": "HK", "name": "农业银行", "symbol": "1288.HK"},
    # 港股中文名称映射
    "腾讯": {"market": "HK", "name": "腾讯控股", "symbol": "0700.HK"},
    "腾讯控股": {"market": "HK", "name": "腾讯控股", "symbol": "0700.HK"},
    "美团": {"market": "HK", "name": "美团-W", "symbol": "3690.HK"},
    "小米": {"market": "HK", "name": "小米集团-W", "symbol": "1810.HK"},
    "网易": {"market": "HK", "name": "网易-S", "symbol": "9999.HK"},
    "中国移动": {"market": "HK", "name": "中国移动", "symbol": "0941.HK"},
    "汇丰": {"market": "HK", "name": "汇丰控股", "symbol": "0005.HK"},
    "港交所": {"market": "HK", "name": "香港交易所", "symbol": "0388.HK"},
    "海底捞": {"market": "HK", "name": "海底捞", "symbol": "6862.HK"},
    "农夫山泉": {"market": "HK", "name": "农夫山泉", "symbol": "9633.HK"},
    "安踏": {"market": "HK", "name": "安踏体育", "symbol": "2020.HK"},
    "安踏体育": {"market": "HK", "name": "安踏体育", "symbol": "2020.HK"},
    "快手": {"market": "HK", "name": "快手-W", "symbol": "1024.HK"},
    "百度": {"market": "HK", "name": "百度集团-SW", "symbol": "9888.HK"},
    "联想": {"market": "HK", "name": "联想集团", "symbol": "0992.HK"},
    "比亚迪": {"market": "HK", "name": "比亚迪股份", "symbol": "1211.HK"},
    "中海油": {"market": "HK", "name": "中国海洋石油", "symbol": "0883.HK"},
    "中石油": {"market": "HK", "name": "中国石油股份", "symbol": "0857.HK"},
    "中石化": {"market": "HK", "name": "中国石油化工股份", "symbol": "0386.HK"},
    "工商银行": {"market": "HK", "name": "工商银行", "symbol": "1398.HK"},
    "中国银行": {"market": "HK", "name": "中国银行", "symbol": "3988.HK"},
    "建设银行": {"market": "HK", "name": "建设银行", "symbol": "0939.HK"},
    "农业银行": {"market": "HK", "name": "农业银行", "symbol": "1288.HK"},
    "美的集团": {"market": "CN", "name": "美的集团", "symbol": "000333.SZ"},
    "长江电力": {"market": "CN", "name": "长江电力", "symbol": "600900.SH"},
    "中国中免": {"market": "CN", "name": "中国中免", "symbol": "601888.SH"},
    "宁德时代": {"market": "CN", "name": "宁德时代", "symbol": "300750.SZ"},
}


def local_search(query: str) -> list[dict]:
    """本地股票搜索"""
    q = query.strip().upper()
    q_lower = query.strip().lower()
    results = []
    seen = set()
    
    for key, stock in BUILTIN_STOCKS.items():
        if stock["symbol"] in seen:
            continue
        # 匹配代码或名称
        if q in key.upper() or q_lower in key.lower() or q in stock["symbol"].upper() or q_lower in stock["name"].lower():
            results.append(stock)
            seen.add(stock["symbol"])
    
    return results


def is_explicit_code(query: str) -> tuple[bool, str]:
    """判断是否为明确的股票代码"""
    q = query.strip().upper()
    if not q:
        return False, ""

    # A股代码（6位数字）
    if re.fullmatch(r"\d{6}", q):
        return True, "CN"
    if re.fullmatch(r"\d{6}\.(SH|SZ|SS|BJ)", q, re.IGNORECASE):
        return True, "CN"
    # 港股代码（1-5位数字，可带.HK后缀）
    if re.fullmatch(r"\d{1,5}\.HK", q, re.IGNORECASE):
        return True, "HK"
    if re.fullmatch(r"\d{1,5}", q) and len(q) <= 5:
        # 纯数字且不超过5位，可能是港股
        return True, "HK"
    # 美股代码（1-5位字母）
    if re.fullmatch(r"[A-Z]{1,5}", q):
        return True, "US"

    return False, ""


def _normalize_candidate(candidate: dict) -> dict:
    c = dict(candidate or {})
    market = str(c.get("market") or "").strip().upper()
    symbol = str(c.get("symbol") or "").strip()
    if market in {"CN", "HK", "US"} and symbol:
        try:
            c["symbol"] = normalize_symbol(market, symbol)
        except Exception:
            pass
    return c


def get_market_name(market: str) -> str:
    """获取市场名称"""
    return {"CN": "中国沪深市", "US": "美国市场", "HK": "香港市场"}.get(market, market)


def _add_to_search_history(stock: dict) -> None:
    """添加到搜索历史"""
    if "search_history" not in st.session_state:
        st.session_state["search_history"] = []
    
    history = st.session_state["search_history"]
    
    # 检查是否已存在
    for h in history:
        if h["symbol"] == stock["symbol"]:
            # 移到最前面
            history.remove(h)
            history.insert(0, stock)
            return
    
    # 添加到最前面，最多保留10条
    history.insert(0, stock)
    st.session_state["search_history"] = history[:10]


def fuzzy_search(query: str) -> list[dict]:
    """增强的模糊搜索"""
    q = query.strip().lower()
    if not q:
        return []
    
    results = []
    seen = set()
    
    for key, stock in BUILTIN_STOCKS.items():
        if stock["symbol"] in seen:
            continue
        
        key_lower = key.lower()
        name_lower = stock["name"].lower()
        symbol_lower = stock["symbol"].lower()
        
        # 精确匹配优先级最高
        if q == key_lower or q == symbol_lower:
            results.insert(0, (stock, 100))
            seen.add(stock["symbol"])
            continue
        
        # 计算匹配分数
        score = 0
        
        # 代码前缀匹配
        if symbol_lower.startswith(q):
            score += 80
        elif q in symbol_lower:
            score += 50
        
        # 名称包含匹配
        if q in name_lower:
            score += 60
        elif q in key_lower:
            score += 40
        
        if score > 0:
            results.append((stock, score))
            seen.add(stock["symbol"])
    
    # 按分数排序
    results.sort(key=lambda x: x[1], reverse=True)
    return [_normalize_candidate(r[0]) for r in results]


@st.cache_data(ttl=60)
def online_stock_search(query: str) -> list[dict]:
    """使用 yfinance 在线搜索股票 - 支持美股、港股、A股"""
    try:
        import yfinance as yf
        
        results = []
        q = query.strip().upper()
        q_original = query.strip()
        
        # 构建可能的股票代码列表
        possible_symbols = []
        
        # 如果是纯数字（可能是港股或A股代码）
        if q.isdigit():
            # 港股代码（4-5位数字）
            if len(q) <= 5:
                hk_code = q.zfill(4)  # 补齐4位
                possible_symbols.append(f"{hk_code}.HK")
            # A股代码（6位数字）
            if len(q) == 6:
                if q.startswith("6"):
                    possible_symbols.append(f"{q}.SS")  # 上海
                else:
                    possible_symbols.append(f"{q}.SZ")  # 深圳
        # 如果是英文（美股代码）
        elif q.isalpha():
            possible_symbols.append(q)  # 美股
            possible_symbols.append(f"{q}.HK")  # 港股英文代码
        # 如果已经包含后缀
        elif "." in q:
            possible_symbols.append(q)
        else:
            # 默认尝试美股
            possible_symbols.append(q)
        
        for sym in possible_symbols[:3]:  # 限制查询数量
            try:
                ticker = yf.Ticker(sym)
                info = _run_with_timeout(lambda: ticker.info, 6)
                if info and info.get("shortName"):
                    market = "US"
                    if ".HK" in sym:
                        market = "HK"
                    elif ".SS" in sym or ".SZ" in sym:
                        market = "CN"
                    
                    results.append(
                        _normalize_candidate(
                            {
                                "symbol": sym,
                                "market": market,
                                "name": info.get("shortName") or info.get("longName") or sym,
                            }
                        )
                    )
            except concurrent.futures.TimeoutError:
                continue
            except Exception:
                continue
        
        return results
    except concurrent.futures.TimeoutError:
        return []
    except Exception:
        return []


def main() -> None:
    st.set_page_config(page_title="股票查询", page_icon="🔍", layout="wide")
    inject_css()
    init_db()

    # 初始化搜索历史
    if "search_history" not in st.session_state:
        st.session_state["search_history"] = []

    with st.sidebar:
        render_sidebar_nav()

    # 移动端导航栏
    render_mobile_nav(title="股票查询", show_back=True, back_url="app.py")

    st.markdown('<div class="page-title">股票查询</div>', unsafe_allow_html=True)
    st.markdown('<div class="page-desc">搜索上市公司股票代码或名称，查看基本信息</div>', unsafe_allow_html=True)

    st.markdown('''
    <div class="category-card">
        <div class="category-header">Search Stocks</div>
        <div style="font-size:0.8125rem;color:var(--text-3);">US (AAPL, TSLA), A-share (600000.SS), Shenzhen (000001.SZ)</div>
    </div>
    ''', unsafe_allow_html=True)

    with st.form("stock_search_form", clear_on_submit=False):
        col1, col2 = st.columns([5, 1])
        with col1:
            query = st.text_input(
                "搜索",
                placeholder="输入股票代码或公司名称...",
                label_visibility="collapsed",
                key="stock_search_input",
            )
        with col2:
            search_btn = st.form_submit_button("🔍 搜索", use_container_width=True)

    # 显示搜索历史
    history = st.session_state.get("search_history", [])
    clean_history: list[dict] = []
    try:
        for h in (history or []):
            if not isinstance(h, dict):
                continue
            name = (h.get("name") or "").strip()
            symbol0 = (h.get("symbol") or "").strip()
            if not name and not symbol0:
                continue
            h2 = dict(h)
            h2["_label"] = (name or symbol0).strip()
            clean_history.append(h2)
    except Exception:
        clean_history = []

    if clean_history:
        st.markdown('<div style="font-size:0.75rem;color:var(--text-3);margin-top:var(--space-2);">Recent:</div>', unsafe_allow_html=True)
        cols = st.columns(min(len(clean_history), 5))
        for i, h in enumerate(clean_history[:5]):
            label = str(h.get("_label") or "")
            symbol0 = str(h.get("symbol") or "")
            name0 = str(h.get("name") or "")
            if cols[i].button(label[:10], key=f"hist_{i}", help=f"{symbol0} - {name0}"):
                st.session_state["selected_stock"] = {"symbol": symbol0, "name": name0}
                st.rerun()

    st.markdown('<div style="font-size:0.75rem;color:var(--text-3);margin-top:var(--space-2);">Examples:</div>', unsafe_allow_html=True)
    examples = ["AAPL", "TSLA", "600519.SS", "000001.SZ", "BABA"]
    cols = st.columns(len(examples))
    for i, ex in enumerate(examples):
        if cols[i].button(ex, key=f"ex_{ex}"):
            st.session_state["stock_query"] = ex
            st.rerun()

    # 处理搜索：如果点击了搜索按钮，清除已选中的股票
    if search_btn and query:
        st.session_state["selected_stock"] = None
        st.session_state["stock_query"] = query
        st.rerun()

    # 优先显示已选中的股票详情
    if st.session_state.get("selected_stock"):
        stock = st.session_state["selected_stock"]

        # 侧边栏固定显示返回按钮，避免主区域样式导致不可见
        with st.sidebar:
            if st.button("← 返回搜索", key="back_to_search_sidebar", type="secondary", use_container_width=True):
                st.session_state["selected_stock"] = None
                st.rerun()
        
        # 添加到搜索历史
        _add_to_search_history(stock)
        
        # 主区域也显示一次返回按钮（双保险）
        if st.button("← 返回搜索", key="back_to_search_main", type="secondary"):
            st.session_state["selected_stock"] = None
            st.rerun()
        
        _render_stock_detail(stock["symbol"], stock["market"], stock.get("name") or stock["symbol"])
        return  # 显示详情后不再显示搜索结果

    q = st.session_state.get("stock_query")
    if q:
        st.session_state["stock_query"] = None
        st.markdown("<br>", unsafe_allow_html=True)

        market = infer_market(q)
        is_explicit = bool(market and is_explicit_symbol(market, q))

        if is_explicit:
            symbol = normalize_symbol(market, q)
            # 查找内置股票信息
            lookup_key = q.replace(".SH", "").replace(".SZ", "").replace(".SS", "").replace(".HK", "")
            stock_info = BUILTIN_STOCKS.get(lookup_key) or BUILTIN_STOCKS.get(lookup_key.lstrip("0"))
            
            # 如果本地没有，尝试在线获取
            if not stock_info and market == "HK":
                with st.spinner("正在从港股市场获取数据..."):
                    online_results = online_stock_search(q)
                    if online_results:
                        stock_info = online_results[0]
            
            stock_info = _normalize_candidate(stock_info) if stock_info else None
            name = stock_info["name"] if stock_info else symbol
            # 直接设置选中状态并显示详情
            st.session_state["selected_stock"] = {"symbol": symbol, "market": market, "name": name}
            st.rerun()
        else:
            # 使用增强的模糊搜索
            candidates = fuzzy_search(q)
            
            # 如果本地搜索无结果，尝试在线搜索
            if not candidates:
                with st.spinner("正在在线搜索..."):
                    candidates = online_stock_search(q)
            
            if not candidates:
                st.warning(f"未找到匹配「{q}」的股票")
                st.markdown('''
                <div style="padding:1rem;background:#f8fafc;border-radius:12px;border:1px solid #e2e8f0;margin-top:1rem;">
                    <div style="font-weight:600;color:#0f172a;margin-bottom:0.5rem;">💡 搜索提示</div>
                    <div style="font-size:0.875rem;color:#64748b;line-height:1.6;">
                        • <b>美股</b>：输入股票代码，如 AAPL、TSLA、SBUX<br>
                        • <b>港股</b>：输入数字代码，如 700（腾讯）、6862（海底捞）、9633（农夫山泉）<br>
                        • <b>A股</b>：输入6位代码，如 600519（茅台）、000858（五粮液）<br>
                        • 或直接上传公司财务报表 PDF 进行分析
                    </div>
                </div>
                ''', unsafe_allow_html=True)
            elif len(candidates) == 1:
                # 只有一个结果，直接显示详情
                c = _normalize_candidate(candidates[0])
                st.session_state["selected_stock"] = c
                st.rerun()
            else:
                st.markdown(f"#### 搜索结果（{len(candidates)} 条）")
                for c in candidates:
                    c = _normalize_candidate(c)
                    col1, col2 = st.columns([4, 1])
                    with col1:
                        st.markdown(f'''
                        <div class="report-item">
                            <div class="report-icon">📈</div>
                            <div class="report-info">
                                <div class="report-title">{c["name"]}</div>
                                <div class="report-meta">{c["symbol"]} · {get_market_name(c["market"])}</div>
                            </div>
                        </div>
                        ''', unsafe_allow_html=True)
                    with col2:
                        if st.button("查看", key=f"sel_{c['symbol']}"):
                            st.session_state["selected_stock"] = c
                            st.rerun()


def _render_stock_detail(symbol: str, market: str, name: str | None = None) -> None:
    """渲染股票详情"""
    st.markdown("---")

    with st.expander("调试 / 强制刷新", expanded=False):
        if st.button("清除缓存并刷新", key=f"clear_cache_{market}_{symbol}", use_container_width=True):
            try:
                st.cache_data.clear()
            except Exception:
                pass
            st.rerun()

    # 获取实时价格
    price_data = get_stock_price(symbol, market)
    
    # 股票基本信息
    col1, col2 = st.columns([3, 1])
    with col1:
        display_name = price_data.get("name", name) if price_data else name
        st.markdown(f'''
        <div style="margin-bottom:1rem;">
            <h2 style="margin:0;font-size:1.5rem;font-weight:600;color:#1a1a2e;">{display_name}</h2>
            <div style="color:#888;font-size:0.875rem;">{symbol} · {get_market_name(market)}</div>
        </div>
        ''', unsafe_allow_html=True)
    with col2:
        if price_data and price_data.get("price"):
            price = price_data["price"]
            currency = price_data.get("currency", "USD")
            change_pct = price_data.get("change_percent")
            change_color = "#e53935" if change_pct and change_pct >= 0 else "#43a047"
            change_str = f"+{change_pct:.2f}%" if change_pct and change_pct >= 0 else f"{change_pct:.2f}%" if change_pct else ""
            st.markdown(f'''
            <div style="text-align:right;">
                <div style="font-size:1.75rem;font-weight:600;color:#1976d2;">{currency} {price:.2f}</div>
                <div style="font-size:0.875rem;color:{change_color};">{change_str} 当前价格</div>
            </div>
            ''', unsafe_allow_html=True)
        else:
            st.markdown('''
            <div style="text-align:right;">
                <div style="font-size:0.75rem;color:#888;">当前价格</div>
                <div style="font-size:1.5rem;font-weight:600;color:#1976d2;">--</div>
            </div>
            ''', unsafe_allow_html=True)

    if not price_data:
        st.info("当前环境暂时无法获取实时行情（可能是部署环境网络限制或数据源超时）。你仍可继续生成财务分析报告。")

    # 显示市场数据卡片
    if price_data:
        def _fmt_yi(v: float | None) -> str:
            try:
                if v is None:
                    return "N/A"
                fv = float(v)
                if fv <= 0:
                    return "N/A"
                yi = fv / 1e8
                if yi < 0.01:
                    return "<0.01亿"
                return f"{yi:.2f}亿"
            except Exception:
                return "N/A"

        st.markdown("<br>", unsafe_allow_html=True)
        col1, col2, col3, col4 = st.columns(4)
        
        with col1:
            market_cap = price_data.get("market_cap")
            cap_str = _fmt_yi(market_cap)
            st.markdown(f'''
            <div style="text-align:center;padding:1rem;background:white;border-radius:8px;border:1px solid #eee;">
                <div style="font-size:0.75rem;color:#888;">💰 市值</div>
                <div style="font-size:1.25rem;font-weight:600;color:#1a1a2e;">{cap_str}</div>
            </div>
            ''', unsafe_allow_html=True)
        
        with col2:
            high_52w = price_data.get("high_52w")
            high_str = f"{high_52w:.2f}" if high_52w else "N/A"
            st.markdown(f'''
            <div style="text-align:center;padding:1rem;background:white;border-radius:8px;border:1px solid #eee;">
                <div style="font-size:0.75rem;color:#888;">📈 52周最高</div>
                <div style="font-size:1.25rem;font-weight:600;color:#e53935;">{high_str}</div>
            </div>
            ''', unsafe_allow_html=True)
        
        with col3:
            low_52w = price_data.get("low_52w")
            low_str = f"{low_52w:.2f}" if low_52w else "N/A"
            st.markdown(f'''
            <div style="text-align:center;padding:1rem;background:white;border-radius:8px;border:1px solid #eee;">
                <div style="font-size:0.75rem;color:#888;">📉 52周最低</div>
                <div style="font-size:1.25rem;font-weight:600;color:#43a047;">{low_str}</div>
            </div>
            ''', unsafe_allow_html=True)
        
        with col4:
            turnover = price_data.get("turnover")
            if turnover is None:
                try:
                    p = float(price_data.get("price") or 0)
                    v = float(price_data.get("volume") or 0)
                    if p > 0 and v > 0:
                        turnover = p * v
                except Exception:
                    turnover = None

            vol_str = _fmt_yi(turnover)
            st.markdown(f'''
            <div style="text-align:center;padding:1rem;background:white;border-radius:8px;border:1px solid #eee;">
                <div style="font-size:0.75rem;color:#888;">📊 成交额</div>
                <div style="font-size:1.25rem;font-weight:600;color:#1a1a2e;">{vol_str}</div>
            </div>
            ''', unsafe_allow_html=True)

        # 技术指标行：MA5, MA20, MA60, RSI
        st.markdown("<div style='height:0.5rem;'></div>", unsafe_allow_html=True)
        tcol1, tcol2, tcol3, tcol4 = st.columns(4)
        with tcol1:
            ma5 = price_data.get("ma5")
            ma5_str = f"{ma5:.2f}" if ma5 else "N/A"
            st.markdown(f'''
            <div style="text-align:center;padding:0.75rem;background:#f8f9fa;border-radius:8px;border:1px solid #eee;">
                <div style="font-size:0.7rem;color:#888;">MA5</div>
                <div style="font-size:1rem;font-weight:600;color:#1a1a2e;">{ma5_str}</div>
            </div>
            ''', unsafe_allow_html=True)
        with tcol2:
            ma20 = price_data.get("ma20")
            ma20_str = f"{ma20:.2f}" if ma20 else "N/A"
            st.markdown(f'''
            <div style="text-align:center;padding:0.75rem;background:#f8f9fa;border-radius:8px;border:1px solid #eee;">
                <div style="font-size:0.7rem;color:#888;">MA20</div>
                <div style="font-size:1rem;font-weight:600;color:#1a1a2e;">{ma20_str}</div>
            </div>
            ''', unsafe_allow_html=True)
        with tcol3:
            ma60 = price_data.get("ma60")
            ma60_str = f"{ma60:.2f}" if ma60 else "N/A"
            st.markdown(f'''
            <div style="text-align:center;padding:0.75rem;background:#f8f9fa;border-radius:8px;border:1px solid #eee;">
                <div style="font-size:0.7rem;color:#888;">MA60</div>
                <div style="font-size:1rem;font-weight:600;color:#1a1a2e;">{ma60_str}</div>
            </div>
            ''', unsafe_allow_html=True)
        with tcol4:
            rsi = price_data.get("rsi")
            if rsi:
                rsi_str = f"{rsi:.1f}"
                if rsi >= 70:
                    rsi_color = "#e53935"
                    rsi_hint = "超买"
                elif rsi <= 30:
                    rsi_color = "#43a047"
                    rsi_hint = "超卖"
                else:
                    rsi_color = "#1a1a2e"
                    rsi_hint = "中性"
            else:
                rsi_str = "N/A"
                rsi_color = "#1a1a2e"
                rsi_hint = ""
            st.markdown(f'''
            <div style="text-align:center;padding:0.75rem;background:#f8f9fa;border-radius:8px;border:1px solid #eee;">
                <div style="font-size:0.7rem;color:#888;">RSI(14) {rsi_hint}</div>
                <div style="font-size:1rem;font-weight:600;color:{rsi_color};">{rsi_str}</div>
            </div>
            ''', unsafe_allow_html=True)

        st.markdown("<div style='height:0.5rem;'></div>", unsafe_allow_html=True)
        bcol1, bcol2, bcol3, bcol4 = st.columns(4)

        def _pstr(v: float | None) -> str:
            try:
                if v is None:
                    return "N/A"
                return f"{float(v):.2f}"
            except Exception:
                return "N/A"

        last_close = price_data.get("last_close") or price_data.get("price")
        last_open = price_data.get("last_open")
        last_low = price_data.get("last_low")
        ma5_prev = price_data.get("ma5_prev")
        ma20_prev = price_data.get("ma20_prev")
        ma5_now = price_data.get("ma5")
        ma20_now = price_data.get("ma20")
        macd_dif = price_data.get("macd_dif")
        macd_dea = price_data.get("macd_dea")
        macd_hist = price_data.get("macd_hist")
        macd_hist_prev = price_data.get("macd_hist_prev")
        vol = price_data.get("volume")
        vol_ma5 = price_data.get("vol_ma5")

        macd_ok = False
        try:
            if macd_dif is not None and macd_dea is not None and float(macd_dif) > float(macd_dea):
                macd_ok = True
            if (macd_hist_prev is not None) and (macd_hist is not None):
                if float(macd_hist_prev) < 0 <= float(macd_hist):
                    macd_ok = True
        except Exception:
            macd_ok = False

        vol_ok = False
        try:
            if vol is not None and vol_ma5 is not None and float(vol) > float(vol_ma5):
                vol_ok = True
        except Exception:
            vol_ok = False

        ma20_up = False
        try:
            if ma20_now is not None and ma20_prev is not None and float(ma20_now) > float(ma20_prev):
                ma20_up = True
        except Exception:
            ma20_up = False

        aggressive_ok = False
        aggressive_price = None
        try:
            if ma20_now is not None and last_close is not None and last_low is not None:
                touched = float(last_low) <= float(ma20_now) <= float(last_close)
                bullish = (last_open is None) or (float(last_close) > float(last_open))
                aggressive_ok = bool(touched and bullish and ma20_up)
                # 仅在价格仍在 MA20 上方/附近时展示“回踩 MA20”的参考买入位，避免价格已跌破 MA20 时产生误导
                aggressive_price = float(ma20_now) if float(last_close) >= float(ma20_now) else None
        except Exception:
            aggressive_ok = False
            aggressive_price = None

        conservative_ok = False
        conservative_price = None
        try:
            if ma5_prev is not None and ma20_prev is not None and ma5_now is not None and ma20_now is not None and last_close is not None:
                golden = float(ma5_prev) <= float(ma20_prev) and float(ma5_now) > float(ma20_now)
                conservative_ok = bool(golden)
                conservative_price = float(last_close) if conservative_ok else None
        except Exception:
            conservative_ok = False
            conservative_price = None

        sell_trend_ok = False
        sell_trend_price = None
        try:
            if ma20_now is not None and ma20_prev is not None and last_close is not None:
                weaken = float(last_close) < float(ma20_now) and float(ma20_now) <= float(ma20_prev)
                sell_trend_ok = bool(weaken)
                sell_trend_price = float(last_close) if sell_trend_ok else None
        except Exception:
            sell_trend_ok = False
            sell_trend_price = None

        sell_cross_ok = False
        sell_cross_price = None
        try:
            if ma5_prev is not None and ma20_prev is not None and ma5_now is not None and ma20_now is not None and last_close is not None:
                death = float(ma5_prev) >= float(ma20_prev) and float(ma5_now) < float(ma20_now)
                sell_cross_ok = bool(death)
                sell_cross_price = float(last_close) if sell_cross_ok else None
        except Exception:
            sell_cross_ok = False
            sell_cross_price = None

        def _hint(ok: bool, title: str) -> str:
            return f"{title}{'确认' if ok else '等待'}"

        with bcol1:
            st.markdown(f'''
            <div style="text-align:center;padding:0.85rem;background:white;border-radius:8px;border:1px solid #eee;">
                <div style="font-size:0.75rem;color:#888;">买入价位(激进)</div>
                <div style="font-size:1.1rem;font-weight:600;color:#1a1a2e;">{_pstr(aggressive_price)}</div>
                <div style="font-size:0.75rem;color:#64748b;">{_hint(aggressive_ok and macd_ok and vol_ok, 'MA20回踩·')}</div>
            </div>
            ''', unsafe_allow_html=True)
        with bcol2:
            st.markdown(f'''
            <div style="text-align:center;padding:0.85rem;background:white;border-radius:8px;border:1px solid #eee;">
                <div style="font-size:0.75rem;color:#888;">买入价位(稳健)</div>
                <div style="font-size:1.1rem;font-weight:600;color:#1a1a2e;">{_pstr(conservative_price)}</div>
                <div style="font-size:0.75rem;color:#64748b;">{_hint(conservative_ok and macd_ok and vol_ok, '金叉·')}</div>
            </div>
            ''', unsafe_allow_html=True)
        with bcol3:
            st.markdown(f'''
            <div style="text-align:center;padding:0.85rem;background:white;border-radius:8px;border:1px solid #eee;">
                <div style="font-size:0.75rem;color:#888;">卖出价位(趋势)</div>
                <div style="font-size:1.1rem;font-weight:600;color:#1a1a2e;">{_pstr(sell_trend_price)}</div>
                <div style="font-size:0.75rem;color:#64748b;">{_hint(sell_trend_ok, '跌破MA20·')}</div>
            </div>
            ''', unsafe_allow_html=True)
        with bcol4:
            st.markdown(f'''
            <div style="text-align:center;padding:0.85rem;background:white;border-radius:8px;border:1px solid #eee;">
                <div style="font-size:0.75rem;color:#888;">卖出价位(死叉)</div>
                <div style="font-size:1.1rem;font-weight:600;color:#1a1a2e;">{_pstr(sell_cross_price)}</div>
                <div style="font-size:0.75rem;color:#64748b;">{_hint(sell_cross_ok, '死叉·')}</div>
            </div>
            ''', unsafe_allow_html=True)
    
    st.markdown("<br>", unsafe_allow_html=True)

    # ========== 自动获取财务数据 ==========
    st.markdown('''
    <div class="category-card">
        <div class="category-header">📊 自动获取财务数据</div>
        <div style="font-size:0.875rem;color:#64748b;">从网络自动获取财务报表数据，一键生成分析报告</div>
    </div>
    ''', unsafe_allow_html=True)
    
    col1, col2 = st.columns(2)
    with col1:
        if st.button("🚀 一键获取财报并分析", type="primary", use_container_width=True):
            _fetch_and_analyze(symbol, market, name)
    with col2:
        if st.button("📤 手动上传 PDF 分析", use_container_width=True):
            st.session_state["upload_company"] = {"symbol": symbol, "market": market, "name": name}
            st.switch_page("pages/2_上传报表.py")

    st.markdown("<br>", unsafe_allow_html=True)

    # 获取详细财务报表
    st.markdown('''
    <div class="category-card">
        <div class="category-header">📄 手动下载财务报表</div>
        <div style="font-size:0.875rem;color:#64748b;">如果自动获取数据不完整，可从官方渠道下载 PDF 上传分析</div>
    </div>
    ''', unsafe_allow_html=True)

    if market == "US":
        _render_us_report_sources(symbol)
    elif market == "CN":
        _render_cn_report_sources(symbol)
    elif market == "HK":
        _render_hk_report_sources(symbol)


def _render_us_report_sources(symbol: str) -> None:
    """渲染美股财务报表来源"""
    # 最简单的方式：直接搜索 PDF
    st.markdown(f'''
    <div style="padding:1.25rem;background:#e3f2fd;border-radius:12px;margin-bottom:1rem;border:1px solid #1976d2;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem;">
            <div style="font-weight:600;font-size:1rem;color:#1976d2;">🚀 最快方式：Google 搜索年报 PDF</div>
            <a href="https://www.google.com/search?q={symbol}+annual+report+10-K+PDF+2024" target="_blank" style="background:#1976d2;color:white;padding:0.5rem 1rem;border-radius:6px;text-decoration:none;font-size:0.875rem;">立即搜索 ↗</a>
        </div>
        <div style="font-size:0.875rem;color:#1565c0;">直接搜索「{symbol} annual report 10-K PDF 2024」，通常第一个结果就是官方年报</div>
    </div>
    ''', unsafe_allow_html=True)

    # 公司官网 IR
    st.markdown(f'''
    <div style="padding:1.25rem;background:white;border-radius:12px;margin-bottom:1rem;border:1px solid #eee;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;">
            <div style="font-weight:600;font-size:1rem;color:#1a1a2e;">📁 公司投资者关系页面</div>
            <a href="https://www.google.com/search?q={symbol}+investor+relations+annual+report" target="_blank" style="color:#1976d2;text-decoration:none;font-size:0.875rem;">搜索 ↗</a>
        </div>
        <div style="font-size:0.875rem;color:#666;">大多数上市公司在官网的 Investor Relations 页面提供年报下载</div>
    </div>
    ''', unsafe_allow_html=True)

    # SEC EDGAR
    st.markdown(f'''
    <div style="padding:1.25rem;background:white;border-radius:12px;margin-bottom:1rem;border:1px solid #eee;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;">
            <div style="font-weight:600;font-size:1rem;color:#1a1a2e;">📋 SEC EDGAR（官方备案）</div>
            <a href="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={symbol}&type=10-K&dateb=&owner=include&count=40" target="_blank" style="color:#1976d2;text-decoration:none;font-size:0.875rem;">访问 ↗</a>
        </div>
        <div style="font-size:0.875rem;color:#666;">美国证券交易委员会官方网站，查找 10-K（年报）或 10-Q（季报）</div>
    </div>
    ''', unsafe_allow_html=True)


def _render_cn_report_sources(symbol: str) -> None:
    """渲染A股财务报表来源"""
    # 提取纯数字代码
    code = symbol.replace(".SH", "").replace(".SZ", "").replace(".SS", "")
    
    # 最简单的方式：直接搜索 PDF
    st.markdown(f'''
    <div style="padding:1.25rem;background:#e3f2fd;border-radius:12px;margin-bottom:1rem;border:1px solid #1976d2;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem;">
            <div style="font-weight:600;font-size:1rem;color:#1976d2;">🚀 最快方式：百度搜索年报 PDF</div>
            <a href="https://www.baidu.com/s?wd={code}+年报+PDF+2024" target="_blank" style="background:#1976d2;color:white;padding:0.5rem 1rem;border-radius:6px;text-decoration:none;font-size:0.875rem;">立即搜索 ↗</a>
        </div>
        <div style="font-size:0.875rem;color:#1565c0;">直接搜索「{code} 年报 PDF 2024」，通常前几个结果就有官方年报下载</div>
    </div>
    ''', unsafe_allow_html=True)

    # 巨潮资讯 - 直接搜索链接
    st.markdown(f'''
    <div style="padding:1.25rem;background:white;border-radius:12px;margin-bottom:1rem;border:1px solid #eee;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;">
            <div style="font-weight:600;font-size:1rem;color:#1a1a2e;">📋 巨潮资讯（官方披露）</div>
            <a href="http://www.cninfo.com.cn/new/disclosure/stock?stockCode={code}" target="_blank" style="color:#1976d2;text-decoration:none;font-size:0.875rem;">直接查看 ↗</a>
        </div>
        <div style="font-size:0.875rem;color:#666;">中国证监会指定信息披露网站，在「定期报告」中找年报</div>
    </div>
    ''', unsafe_allow_html=True)

    # 东方财富
    st.markdown(f'''
    <div style="padding:1.25rem;background:white;border-radius:12px;margin-bottom:1rem;border:1px solid #eee;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;">
            <div style="font-weight:600;font-size:1rem;color:#1a1a2e;">📊 东方财富</div>
            <a href="https://data.eastmoney.com/report/{code}.html" target="_blank" style="color:#1976d2;text-decoration:none;font-size:0.875rem;">查看报告 ↗</a>
        </div>
        <div style="font-size:0.875rem;color:#666;">提供 A 股上市公司完整的财务报表数据</div>
    </div>
    ''', unsafe_allow_html=True)


def _render_hk_report_sources(symbol: str) -> None:
    """渲染港股财务报表来源"""
    st.markdown(f'''
    <div style="padding:1.25rem;background:white;border-radius:12px;margin-bottom:1rem;border:1px solid #eee;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem;">
            <div style="font-weight:600;font-size:1rem;color:#1a1a2e;">港交所披露易</div>
            <a href="https://www.hkexnews.hk/" target="_blank" style="color:#1976d2;text-decoration:none;font-size:0.875rem;">访问 ↗</a>
        </div>
        <div style="font-size:0.875rem;color:#666;margin-bottom:1rem;">香港交易所官方信息披露平台</div>
        <div style="background:#f8f9fa;padding:1rem;border-radius:8px;font-size:0.875rem;color:#444;">
            <div style="font-weight:500;margin-bottom:0.5rem;">操作步骤：</div>
            <div style="line-height:1.8;">
                1. 访问港交所披露易网站<br>
                2. 搜索股票代码 {symbol}<br>
                3. 下载年报或中期报告<br>
                4. 返回本系统上传分析
            </div>
        </div>
    </div>
    ''', unsafe_allow_html=True)


def _fetch_and_analyze(symbol: str, market: str, name: str) -> None:
    """获取财务数据并创建分析报告"""
    from core.db import session_scope
    from core.models import Report, ComputedMetric
    from sqlalchemy import select

    if st.session_state.get("_fetch_and_analyze_running"):
        st.warning("正在获取财务数据，请稍候...")
        return

    st.session_state["_fetch_and_analyze_running"] = True

    try:
        fin_data = None
        last_error = None
        max_retries = 2

        for attempt in range(max_retries + 1):
            with st.spinner(f"正在从网络获取财务数据...{f' (重试 {attempt}/{max_retries})' if attempt > 0 else ''}"):
                try:
                    fin_data = fetch_financials(symbol, market)
                    if fin_data and getattr(fin_data, "error", None) not in ("rate_limited", "fetch_failed"):
                        break
                    last_error = getattr(fin_data, "error", None) if fin_data else "no_data"
                except Exception as e:
                    last_error = str(e)
                    logger.warning(f"Fetch attempt {attempt + 1} failed: {e}")

                if attempt < max_retries:
                    time.sleep(1.5)

        if not fin_data:
            st.error(f"❌ 无法获取财务数据（{last_error or '未知错误'}），请尝试手动上传 PDF")
            return

        if getattr(fin_data, "error", None) == "rate_limited":
            st.error("❌ 当前数据源请求过于频繁（被限流），请稍后再试，或改用手动上传 PDF 分析")
            return

        if getattr(fin_data, "error", None) == "fetch_failed":
            detail = getattr(fin_data, "error_detail", None)
            st.error(
                f"❌ 自动获取失败（网络/数据源异常）。source={getattr(fin_data, 'source', None)} symbol={symbol} market={market}"
                + (f"\n\n详情：{detail}" if detail else "")
            )
            st.info("建议：稍后重试；或改用手动上传 PDF；如部署环境访问不了外网数据源，需要检查网络/代理设置。")
            return

        metrics = compute_metrics_from_financial_data(fin_data)

        if not metrics or len(metrics) < 3:
            st.warning("⚠️ 获取的数据不完整，建议手动上传 PDF 获取更准确的分析")
            st.info(f"已获取指标: {list(metrics.keys())}")
            st.info(
                "数据源信息："
                + f"source={getattr(fin_data, 'source', None)} "
                + f"error={getattr(fin_data, 'error', None)} "
                + (f"detail={getattr(fin_data, 'error_detail', None)}" if getattr(fin_data, 'error_detail', None) else "")
            )

        if getattr(fin_data, "error", None) == "partial_info":
            st.warning("⚠️ 数据源返回的公司信息不完整，已尽力获取财务数据；如需更完整分析建议上传 PDF")

        company_id = upsert_company(
            market=market,
            symbol=symbol,
            name=fin_data.company_name or name,
            industry_code=getattr(fin_data, "industry", None),
        )

        period_end = fin_data.period or "2024-12-31"

        report_id = upsert_report_market_fetch(
            company_id=company_id,
            report_name=f"{fin_data.company_name or name}",
            market=market,
            period_type="annual",
            period_end=period_end,
            source_meta={
                "source": "api_fetch",
                "api": fin_data.source,
                "symbol": symbol,
                "market": market,
                "industry": getattr(fin_data, "industry", None),
                "industry_bucket": None,
                "financial_overview": {
                    "period_end": period_end,
                    "currency": ("USD" if market == "US" else "HKD" if market == "HK" else "CNY"),
                    "unit": "1e8",
                    "revenue": getattr(fin_data, "revenue", None),
                    "net_profit": getattr(fin_data, "net_profit", None),
                    "total_assets": getattr(fin_data, "total_assets", None),
                    "total_liabilities": getattr(fin_data, "total_liabilities", None),
                    "total_equity": getattr(fin_data, "total_equity", None),
                    "operating_cash_flow": getattr(fin_data, "operating_cash_flow", None),
                    "current_assets": getattr(fin_data, "current_assets", None),
                    "current_liabilities": getattr(fin_data, "current_liabilities", None),
                },
            },
        )

        METRIC_NAMES = {
            "GROSS_MARGIN": "毛利率",
            "NET_MARGIN": "净利率",
            "ROE": "ROE (净资产收益率)",
            "ROA": "ROA (总资产收益率)",
            "CURRENT_RATIO": "流动比率",
            "QUICK_RATIO": "速动比率",
            "DEBT_ASSET": "资产负债率",
            "EQUITY_RATIO": "产权比率",
            "ASSET_TURNOVER": "总资产周转率",
            "INVENTORY_TURNOVER": "存货周转率",
            "RECEIVABLE_TURNOVER": "应收账款周转率",
        }

        with session_scope() as s:
            r = s.get(Report, report_id)
            if r:
                r.status = "done"
                r.updated_at = int(time.time())

            for old in s.execute(select(ComputedMetric).where(ComputedMetric.report_id == report_id)).scalars().all():
                s.delete(old)

            for code, value in metrics.items():
                if value is not None:
                    m = ComputedMetric(
                        id=f"{report_id}:{code}:{period_end}",
                        report_id=report_id,
                        company_id=company_id,
                        period_end=period_end,
                        period_type="annual",
                        metric_code=code,
                        metric_name=METRIC_NAMES.get(code, code),
                        value=value,
                        unit="%" if code in ["GROSS_MARGIN", "NET_MARGIN", "ROE", "ROA", "DEBT_ASSET"] else "",
                        calc_trace=f"from {fin_data.source} API",
                    )
                    s.add(m)

        st.success(f"✅ 成功获取 {len(metrics)} 项财务指标！")

        st.markdown("**获取到的财务数据：**")
        preview_cols = st.columns(3)
        metric_items = list(metrics.items())
        for i, (code, value) in enumerate(metric_items[:9]):
            with preview_cols[i % 3]:
                unit = "%" if code in ["GROSS_MARGIN", "NET_MARGIN", "ROE", "ROA", "DEBT_ASSET"] else ""
                st.metric(METRIC_NAMES.get(code, code), f"{value:.2f}{unit}")

        st.markdown("<br>", unsafe_allow_html=True)

        # 直接跳转到完整报告页（避免按钮放在回调函数内，下一次 rerun 无法再次渲染导致点击失效）
        st.session_state["active_report_id"] = report_id
        st.session_state["selected_stock"] = None
        st.switch_page("pages/3_分析报告.py")
    finally:
        st.session_state["_fetch_and_analyze_running"] = False


if __name__ == "__main__":
    main()
