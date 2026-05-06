"""
沪深300智能选股 - 多因子评分引擎 (P0-P3)
因子体系:
  价值: PE_TTM, PB, PS
  成长: 营收增长, 净利润增长, 季报环比加速
  质量: ROE(杜邦分解), 毛利率, 现金流/净利润, 应收/存货周转
  技术: RSI, MA排列, MACD, KDJ, 布林带, 动量, 波动率, 换手率
  情绪: 北向资金, 融资融券
  行业中性化: 同行业内排名百分位
"""
from __future__ import annotations

import os
import time
import json
import threading
from dataclasses import dataclass, field, asdict
from datetime import date, datetime
from typing import Optional

import numpy as np

_UNIVERSE_CACHE: dict[str, tuple[float, list[dict]]] = {}
_UNIVERSE_LOCK = threading.Lock()
_UNIVERSE_TTL = 86400

_SCAN_LOCK = threading.Lock()
_LATEST_SCAN_RESULT: Optional[list[dict]] = None
_LATEST_SCAN_TIME: float = 0.0

_SECTOR_CACHE: dict[str, tuple[float, list[dict]]] = {}
_SECTOR_LIST_CACHE: tuple[float, list[dict]] = (0.0, [])
_STOCK_SECTOR_MAP: dict[str, str] = {}
_STOCK_SECTOR_MAP_TIME: float = 0.0
_STATIC_SECTOR_MAP: Optional[dict[str, str]] = None
_CN_MARKET_STATE_CACHE: tuple[float, str] = (0.0, "unknown")


def _disable_proxies():
    try:
        from core.net import disable_proxies_for_process
        disable_proxies_for_process()
    except Exception:
        pass


def _cn_index_market_state() -> str:
    """Classify HS300 market regime for the A-share reversal strategy.

    The backtest showed this strategy works best when the index is weak; in
    strong/neutral regimes high timing scores are downgraded to observation.
    """
    global _CN_MARKET_STATE_CACHE
    now = time.time()
    if _CN_MARKET_STATE_CACHE[0] and (now - _CN_MARKET_STATE_CACHE[0]) < 1800:
        return _CN_MARKET_STATE_CACHE[1]
    try:
        _disable_proxies()
        import httpx

        q = "sh000300"
        url = f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={q},day,,,120,qfq"
        resp = httpx.get(url, timeout=8.0, follow_redirects=True)
        data = resp.json()
        raw = (((data or {}).get("data") or {}).get(q) or {}).get("day") or []
        closes = []
        for item in raw:
            if len(item) >= 3:
                try:
                    closes.append(float(item[2]))
                except Exception:
                    pass
        if len(closes) < 65:
            raise ValueError("not enough index data")
        arr = np.array(closes, dtype=float)
        ma60 = float(np.mean(arr[-60:]))
        ret20 = (float(arr[-1]) / float(arr[-21]) - 1.0) * 100.0
        state = "weak" if float(arr[-1]) < ma60 and ret20 <= 0 else "not_weak"
    except Exception:
        state = "unknown"
    _CN_MARKET_STATE_CACHE = (now, state)
    return state


@dataclass
class StockScore:
    symbol: str = ""
    name: str = ""
    market: str = "CN"

    value_score: float = 0.0
    growth_score: float = 0.0
    quality_score: float = 0.0
    tech_score: float = 0.0
    momentum_score: float = 0.0
    sentiment_score: float = 0.0
    total_score: float = 0.0

    pe_ratio: Optional[float] = None
    pb_ratio: Optional[float] = None
    ps_ratio: Optional[float] = None
    revenue_growth: Optional[float] = None
    net_profit_growth: Optional[float] = None
    roe: Optional[float] = None
    gross_margin: Optional[float] = None
    operating_cashflow_ratio: Optional[float] = None
    rsi14: Optional[float] = None
    slope_pct: Optional[float] = None
    buy_price_aggressive: Optional[float] = None
    sell_price: Optional[float] = None
    strategy_buy_zone_low: Optional[float] = None
    strategy_buy_zone_high: Optional[float] = None
    strategy_stop_loss: Optional[float] = None
    strategy_take_profit_1: Optional[float] = None
    strategy_take_profit_2: Optional[float] = None
    buy_score: Optional[int] = None
    sell_score: Optional[int] = None
    buy_grade: Optional[str] = None
    sell_grade: Optional[str] = None
    action: Optional[str] = None
    quality_score_total: Optional[float] = None
    timing_score_total: Optional[float] = None
    sector_name: Optional[str] = None
    sector_strength_score: Optional[float] = None
    recommendation_bucket: Optional[str] = None
    timing_signal_reason: Optional[str] = None
    trend: Optional[str] = None

    momentum_20d: Optional[float] = None
    momentum_60d: Optional[float] = None
    volatility_20d: Optional[float] = None
    turnover_rate: Optional[float] = None
    north_holding_pct: Optional[float] = None

    reason: str = ""
    rank: int = 0


def _load_static_sector_map() -> dict[str, str]:
    global _STATIC_SECTOR_MAP
    if _STATIC_SECTOR_MAP is not None:
        return _STATIC_SECTOR_MAP
    try:
        map_path = os.path.join(os.path.dirname(__file__), "hs300_sector_map.json")
        with open(map_path, "r", encoding="utf-8") as f:
            _STATIC_SECTOR_MAP = json.load(f)
        print(f"[recommend] loaded static sector map: {len(_STATIC_SECTOR_MAP)} stocks")
    except Exception as e:
        print(f"[recommend] failed to load static sector map: {e}")
        _STATIC_SECTOR_MAP = {}
    return _STATIC_SECTOR_MAP


def get_sectors() -> list[dict]:
    global _SECTOR_LIST_CACHE
    now = time.time()
    if _SECTOR_LIST_CACHE[0] and (now - _SECTOR_LIST_CACHE[0]) < _UNIVERSE_TTL:
        return _SECTOR_LIST_CACHE[1]

    mapping = _load_static_sector_map()
    if mapping:
        _STOCK_SECTOR_MAP.update(mapping)
        counts: dict[str, int] = {}
        for sector_name in mapping.values():
            if sector_name:
                counts[sector_name] = counts.get(sector_name, 0) + 1
        sectors = [
            {"label": name, "name": name, "count": count}
            for name, count in sorted(counts.items(), key=lambda x: (-x[1], x[0]))
        ]
        _SECTOR_LIST_CACHE = (now, sectors)
        return sectors

    _disable_proxies()
    try:
        import akshare as ak
        df = ak.stock_board_industry_name_ths()
        sectors = []
        for _, row in df.iterrows():
            code = str(row.get("code", row.iloc[1] if len(row) > 1 else "")).strip()
            name = str(row.get("name", row.iloc[0] if len(row) > 0 else "")).strip()
            if not code or not name:
                continue
            sectors.append({"label": code, "name": name, "count": 0})

        _update_sector_counts(sectors)
        _SECTOR_LIST_CACHE = (now, sectors)

        if not _STOCK_SECTOR_MAP or (now - _STOCK_SECTOR_MAP_TIME) > _UNIVERSE_TTL:
            threading.Thread(target=_async_build_sector_map, daemon=True).start()

        return sectors
    except Exception as e:
        print(f"[recommend] get_sectors error: {e}")
        return _SECTOR_LIST_CACHE[1]


def _update_sector_counts(sectors: list[dict]):
    if not _STOCK_SECTOR_MAP:
        return
    sector_count = {}
    for _, sname in _STOCK_SECTOR_MAP.items():
        if sname:
            sector_count[sname] = sector_count.get(sname, 0) + 1
    for s in sectors:
        s["count"] = sector_count.get(s.get("name", ""), 0)


def _async_build_sector_map():
    global _STOCK_SECTOR_MAP_TIME, _SECTOR_LIST_CACHE
    try:
        mapping = _load_static_sector_map()
        if not mapping:
            return
        _STOCK_SECTOR_MAP.update(mapping)
        _STOCK_SECTOR_MAP_TIME = time.time()

        if _SECTOR_LIST_CACHE[1]:
            _update_sector_counts(_SECTOR_LIST_CACHE[1])
            _SECTOR_LIST_CACHE = (time.time(), _SECTOR_LIST_CACHE[1])

        print(f"[recommend] sector map built: {len(mapping)} stocks mapped")
    except Exception as e:
        print(f"[recommend] async sector map error: {e}")


def get_sector_stocks(sector_label: str) -> list[dict]:
    global _STOCK_SECTOR_MAP_TIME
    now = time.time()
    with _UNIVERSE_LOCK:
        cached = _SECTOR_CACHE.get(sector_label)
        if cached and (now - cached[0]) < _UNIVERSE_TTL:
            return cached[1]

    if not _STOCK_SECTOR_MAP or (now - _STOCK_SECTOR_MAP_TIME) > _UNIVERSE_TTL:
        mapping = _load_static_sector_map()
        _STOCK_SECTOR_MAP.update(mapping)
        _STOCK_SECTOR_MAP_TIME = now

    if not _SECTOR_LIST_CACHE[1]:
        get_sectors()

    sector_name = sector_label
    for s in _SECTOR_LIST_CACHE[1]:
        if s["label"] == sector_label or s["name"] == sector_label:
            sector_name = s["name"]
            break

    result = []
    for stock in get_hs300_stocks():
        code = stock.get("code", stock["symbol"].split(".")[0])
        stock_sector = _STOCK_SECTOR_MAP.get(code, "")
        if stock_sector and (sector_name in stock_sector or stock_sector in sector_name):
            result.append(stock)

    with _UNIVERSE_LOCK:
        _SECTOR_CACHE[sector_label] = (now, result)
    return result


def get_hs300_stocks() -> list[dict]:
    now = time.time()
    with _UNIVERSE_LOCK:
        cached = _UNIVERSE_CACHE.get("hs300")
        if cached and (now - cached[0]) < _UNIVERSE_TTL:
            return cached[1]

    _disable_proxies()
    try:
        import akshare as ak
        df = ak.index_stock_cons_csindex(symbol="000300")
        stocks = []
        for _, row in df.iterrows():
            code = str(row.get("成分券代码", row.get("品种代码", row.get("code", "")))).strip()
            name = str(row.get("成分券名称", row.get("品种名称", row.get("name", "")))).strip()
            if not code or not name:
                continue
            if code.startswith("6"):
                symbol = f"{code}.SH"
            elif code.startswith("0") or code.startswith("3"):
                symbol = f"{code}.SZ"
            else:
                symbol = f"{code}.SZ"
            stocks.append({"symbol": symbol, "name": name, "market": "CN", "code": code})

        with _UNIVERSE_LOCK:
            _UNIVERSE_CACHE["hs300"] = (now, stocks)
        return stocks
    except Exception as e:
        print(f"[recommend] get_hs300_stocks error: {e}")
        return []


# ==================== Factor Scoring ====================

def _score_value(pe: Optional[float], pb: Optional[float] = None,
                 ps: Optional[float] = None) -> float:
    score = 0.0
    count = 0

    if pe is not None and pe > 0:
        count += 1
        if pe <= 8:
            score += 25.0
        elif pe <= 12:
            score += 22.0
        elif pe <= 18:
            score += 18.0
        elif pe <= 25:
            score += 14.0
        elif pe <= 40:
            score += 9.0
        elif pe <= 60:
            score += 5.0
        else:
            score += 2.0
    else:
        count += 1
        score += 10.0

    if pb is not None and pb > 0:
        count += 1
        if pb <= 0.8:
            score += 25.0
        elif pb <= 1.2:
            score += 22.0
        elif pb <= 2.0:
            score += 18.0
        elif pb <= 3.5:
            score += 12.0
        elif pb <= 6.0:
            score += 7.0
        else:
            score += 3.0
    else:
        count += 1
        score += 10.0

    if ps is not None and ps > 0:
        count += 1
        if ps <= 1.0:
            score += 25.0
        elif ps <= 2.5:
            score += 20.0
        elif ps <= 5.0:
            score += 15.0
        elif ps <= 10.0:
            score += 10.0
        else:
            score += 4.0
    else:
        count += 1
        score += 10.0

    return score / count if count > 0 else 12.5


def _score_growth(rev_growth: Optional[float], profit_growth: Optional[float]) -> float:
    r = rev_growth if rev_growth is not None else 0.0
    p = profit_growth if profit_growth is not None else 0.0
    avg = (r + p) / 2.0

    if avg >= 30:
        return 25.0
    if avg >= 20:
        return 22.0
    if avg >= 10:
        return 18.0
    if avg >= 5:
        return 14.0
    if avg >= 0:
        return 10.0
    if avg >= -10:
        return 6.0
    return 3.0


def _score_quality(roe: Optional[float], gross_margin: Optional[float],
                   debt_ratio: Optional[float],
                   cashflow_ratio: Optional[float] = None) -> float:
    score = 12.5

    if roe is not None:
        if roe >= 20:
            score += 5.0
        elif roe >= 15:
            score += 3.5
        elif roe >= 10:
            score += 2.0
        elif roe >= 5:
            score += 0.5
        else:
            score -= 2.0

    if gross_margin is not None:
        if gross_margin >= 50:
            score += 4.0
        elif gross_margin >= 30:
            score += 2.5
        elif gross_margin >= 15:
            score += 1.0
        else:
            score -= 1.0

    if debt_ratio is not None:
        if debt_ratio <= 30:
            score += 2.5
        elif debt_ratio <= 50:
            score += 1.5
        elif debt_ratio <= 70:
            score += 0.0
        else:
            score -= 2.0

    if cashflow_ratio is not None:
        if cashflow_ratio >= 1.2:
            score += 2.0
        elif cashflow_ratio >= 0.8:
            score += 1.0
        elif cashflow_ratio < 0.5:
            score -= 1.5

    return max(0.0, min(25.0, score))


def _score_tech(rsi14: Optional[float], slope_pct: Optional[float],
                buy_price_aggressive_ok: Optional[bool],
                signal_golden_cross: Optional[bool],
                signal_macd_bullish: Optional[bool],
                rsi_rebound: Optional[bool],
                kdj_golden: Optional[bool] = None,
                boll_position: Optional[float] = None,
                ma_bullish_align: Optional[bool] = None) -> float:
    score = 10.0

    if rsi14 is not None:
        if rsi14 < 25:
            score += 5.0
        elif 25 <= rsi14 < 35:
            score += 4.0
        elif 35 <= rsi14 < 45:
            score += 2.5
        elif 45 <= rsi14 <= 55:
            score += 1.0
        elif 55 < rsi14 <= 65:
            score -= 1.0
        elif 65 < rsi14 <= 75:
            score -= 2.0
        elif rsi14 > 75:
            score -= 4.0

    if slope_pct is not None:
        if slope_pct < -0.15:
            score += 5.0
        elif -0.15 <= slope_pct < -0.05:
            score += 2.0
        elif -0.05 <= slope_pct < 0:
            score += 1.0
        elif 0 <= slope_pct < 0.05:
            score -= 1.0
        elif 0.05 <= slope_pct <= 0.15:
            score -= 2.0
        elif slope_pct > 0.15:
            score -= 4.0

    if buy_price_aggressive_ok is True:
        score += 3.0

    if signal_golden_cross is True:
        score += 2.0

    if signal_macd_bullish is True:
        score += 1.5

    if rsi_rebound is True:
        score += 2.0

    if kdj_golden is True:
        score += 1.5

    if boll_position is not None:
        if boll_position < 0.2:
            score += 3.0
        elif boll_position < 0.4:
            score += 1.5
        elif boll_position > 0.8:
            score -= 2.0

    if ma_bullish_align is True:
        score -= 1.0
    elif ma_bullish_align is False:
        score += 1.5
        score += 2.0

    return max(0.0, min(25.0, score))


def _score_timing(rsi14: Optional[float], boll_position: Optional[float],
                  kdj_golden: Optional[bool], macd_golden: Optional[bool],
                  ma_bullish_align: Optional[bool], slope_pct: Optional[float],
                  near_buy_price: Optional[bool],
                  buy_score: Optional[int], trend: Optional[str],
                  vol_ratio: Optional[float] = None,
                  ret_5d: Optional[float] = None,
                  ret_10d: Optional[float] = None,
                  dist_ma60_pct: Optional[float] = None) -> float:
    steep_drop = slope_pct is not None and slope_pct < -0.15
    oversold = rsi14 is not None and rsi14 < 30
    mild_drop = slope_pct is not None and -0.15 <= slope_pct < -0.05
    vol_spike = vol_ratio is not None and vol_ratio > 1.5
    big_drop_5d = ret_5d is not None and ret_5d < -5
    big_drop_10d = ret_10d is not None and ret_10d < -8
    below_ma60_10pct = dist_ma60_pct is not None and dist_ma60_pct < -10

    if big_drop_5d and vol_spike:
        return 100.0
    if steep_drop and oversold and vol_spike:
        return 98.0
    if big_drop_10d and below_ma60_10pct:
        return 96.0
    if steep_drop and oversold and big_drop_5d:
        return 94.0
    if steep_drop and oversold:
        # Strict backtest shows this plain double-signal bucket is too weak to
        # qualify as a buy on its own; keep it as observation only.
        score = 72.0
        if kdj_golden:
            score += 4.0
        return min(79.0, score)
    if steep_drop or oversold:
        score = 60.0
        if vol_spike:
            score = 80.0
        if big_drop_5d:
            score += 8.0
        if big_drop_10d:
            score += 5.0
        if below_ma60_10pct:
            score += 5.0
        if boll_position is not None and boll_position < 0.3:
            score += 3.0
        if kdj_golden:
            score += 2.0
        if near_buy_price:
            score += 3.0
        return min(89.0, score)
    if mild_drop:
        score = 30.0
        if big_drop_5d:
            score += 15.0
        if vol_spike:
            score += 10.0
        if below_ma60_10pct:
            score += 8.0
        if kdj_golden:
            score += 3.0
        return min(55.0, score)
    score = 0.0
    if rsi14 is not None:
        if rsi14 > 75:
            score -= 10.0
        elif rsi14 > 65:
            score -= 5.0
    if slope_pct is not None and slope_pct > 0.15:
        score -= 8.0
    if boll_position is not None and boll_position > 0.8:
        score -= 3.0
    if below_ma60_10pct:
        score += 10.0
    if vol_spike:
        score += 5.0
    return max(-20.0, score)


def _score_momentum(momentum_20d: Optional[float], momentum_60d: Optional[float],
                    volatility_20d: Optional[float]) -> float:
    score = 8.0

    if momentum_20d is not None:
        if momentum_20d > 10:
            score += 4.0
        elif momentum_20d > 5:
            score += 3.0
        elif momentum_20d > 0:
            score += 1.5
        elif momentum_20d > -5:
            score -= 0.5
        else:
            score -= 2.0

    if momentum_60d is not None:
        if 0 < momentum_60d < 20:
            score += 4.0
        elif momentum_60d >= 20:
            score += 2.0
        elif momentum_60d > -5:
            score += 0.0
        else:
            score -= 2.0

    if volatility_20d is not None:
        if volatility_20d < 15:
            score += 3.0
        elif volatility_20d < 25:
            score += 1.5
        elif volatility_20d < 40:
            score += 0.0
        else:
            score -= 2.0

    return max(0.0, min(20.0, score))


def _score_sentiment(north_holding_pct: Optional[float],
                     turnover_rate: Optional[float]) -> float:
    score = 5.0

    if north_holding_pct is not None:
        if north_holding_pct > 5.0:
            score += 4.0
        elif north_holding_pct > 2.0:
            score += 2.5
        elif north_holding_pct > 0.5:
            score += 1.0
        elif north_holding_pct < -0.5:
            score -= 2.0

    if turnover_rate is not None:
        if 1.0 < turnover_rate < 5.0:
            score += 3.0
        elif turnover_rate < 1.0:
            score += 1.0
        elif turnover_rate < 8.0:
            score += 1.5
        else:
            score -= 1.0

    return max(0.0, min(15.0, score))


def _sector_strength_scores(scores: list[StockScore]) -> dict[str, float]:
    groups: dict[str, list[StockScore]] = {}
    for s in scores:
        code = s.symbol.split(".")[0]
        sec = _STOCK_SECTOR_MAP.get(code, "其他")
        groups.setdefault(sec, []).append(s)

    result: dict[str, float] = {}
    for sec, group in groups.items():
        mom20 = [s.momentum_20d for s in group if s.momentum_20d is not None]
        mom60 = [s.momentum_60d for s in group if s.momentum_60d is not None]
        if not mom20:
            result[sec] = 50.0
            continue
        avg20 = sum(mom20) / len(mom20)
        avg60 = sum(mom60) / len(mom60) if mom60 else 0.0
        breadth = sum(1 for v in mom20 if v > 0) / len(mom20)
        score = 50.0 + avg20 * 1.8 + avg60 * 0.35 + (breadth - 0.5) * 35.0
        result[sec] = max(0.0, min(100.0, score))
    return result


def _downgrade_action(action: str, levels: int = 1) -> str:
    ladder = ["强买信号", "积极建仓", "轻仓试探", "关注等买点", "优质远离买点", "暂不关注"]
    if action == "有买点基本面弱":
        return "关注等买点" if levels == 1 else "暂不关注"
    if action not in ladder:
        return action
    idx = min(len(ladder) - 1, ladder.index(action) + levels)
    return ladder[idx]


def _bucket_for_action(action: str) -> str:
    if action in ("强买信号", "积极建仓"):
        return "buy_now"
    if action == "轻仓试探":
        return "try_position"
    if action in ("关注等买点", "优质远离买点"):
        return "watchlist"
    return "other"


def _timing_signal_reason(timing_score: Optional[float], rsi14: Optional[float],
                          slope_pct: Optional[float], vol_ratio: Optional[float],
                          ret_5d: Optional[float], ret_10d: Optional[float],
                          dist_ma60_pct: Optional[float]) -> str:
    parts = []
    if slope_pct is not None and slope_pct < -0.15:
        parts.append("60日斜率急跌")
    elif slope_pct is not None and -0.15 <= slope_pct < -0.05:
        parts.append("60日斜率缓跌")
    if rsi14 is not None and rsi14 < 30:
        parts.append("RSI超卖")
    if ret_5d is not None and ret_5d < -5:
        parts.append("5日急跌")
    if ret_10d is not None and ret_10d < -8:
        parts.append("10日急跌")
    if vol_ratio is not None and vol_ratio > 1.5:
        parts.append("放量确认")
    if dist_ma60_pct is not None and dist_ma60_pct < -10:
        parts.append("低于MA60超10%")
    if not parts:
        return "暂无高胜率买点"
    prefix = "强买" if (timing_score or 0) >= 96 else "买点"
    return f"{prefix}: " + " + ".join(parts[:4])


def _rank_neutralize(scores: list[StockScore]) -> list[StockScore]:
    sector_groups: dict[str, list[StockScore]] = {}
    for s in scores:
        code = s.symbol.split(".")[0]
        sec = _STOCK_SECTOR_MAP.get(code, "其他")
        if sec not in sector_groups:
            sector_groups[sec] = []
        sector_groups[sec].append(s)

    for sec_name, group in sector_groups.items():
        if len(group) < 3:
            continue
        for factor in ['value_score', 'growth_score', 'quality_score',
                        'tech_score', 'momentum_score']:
            vals = []
            for s in group:
                v = getattr(s, factor)
                if v is not None:
                    vals.append(v)
            if not vals:
                continue
            arr = np.array(vals)
            mn, mx = arr.min(), arr.max()
            if mx == mn:
                continue
            rng = mx - mn
            for s in group:
                v = getattr(s, factor)
                if v is not None:
                    pct = (v - mn) / rng
                    setattr(s, factor, pct * 25.0)

    return scores


# ==================== Data Fetching ====================

def _fetch_batch_pe_pb_ps(stocks: list[dict]) -> dict[str, dict]:
    _disable_proxies()
    result = {}
    try:
        import httpx
        batch_size = 30
        for i in range(0, len(stocks), batch_size):
            batch = stocks[i:i + batch_size]
            symbols = []
            code_map = {}
            for stock in batch:
                code = stock.get("code", stock["symbol"].split(".")[0])
                if stock["symbol"].endswith(".SH"):
                    prefix = "sh"
                else:
                    prefix = "sz"
                sym = f"{prefix}{code}"
                symbols.append(sym)
                code_map[sym] = code

            try:
                qs = ",".join(symbols)
                resp = httpx.get(f"https://qt.gtimg.cn/q={qs}", timeout=10.0)
                text = resp.text
                for line in text.split(";"):
                    line = line.strip()
                    if "~" not in line:
                        continue
                    parts = line.split("~")
                    if len(parts) < 50:
                        continue
                    var_part = parts[0]
                    sym_key = ""
                    for s in symbols:
                        if s in var_part:
                            sym_key = s
                            break
                    if not sym_key:
                        continue
                    code = code_map.get(sym_key, "")

                    pe_val = None
                    pb_val = None
                    ps_val = None
                    turnover = None
                    try:
                        raw_pe = parts[39] if len(parts) > 39 else ""
                        pe_val = float(raw_pe) if float(raw_pe) > 0 else None
                    except (ValueError, TypeError):
                        pass
                    try:
                        raw_pb = parts[43] if len(parts) > 43 else ""
                        pb_val = float(raw_pb) if float(raw_pb) > 0 else None
                    except (ValueError, TypeError):
                        pass
                    try:
                        raw_ps = parts[45] if len(parts) > 45 else ""
                        ps_val = float(raw_ps) if float(raw_ps) > 0 else None
                    except (ValueError, TypeError):
                        pass
                    try:
                        raw_turnover = parts[38] if len(parts) > 38 else ""
                        turnover = float(raw_turnover) if float(raw_turnover) > 0 else None
                    except (ValueError, TypeError):
                        pass

                    result[code] = {
                        "pe_ratio": pe_val,
                        "pb_ratio": pb_val,
                        "ps_ratio": ps_val,
                        "turnover_rate": turnover,
                    }
            except Exception:
                for stock in batch:
                    code = stock.get("code", stock["symbol"].split(".")[0])
                    if code not in result:
                        result[code] = {"pe_ratio": None, "pb_ratio": None, "ps_ratio": None, "turnover_rate": None}

            time.sleep(0.1)

        for stock in stocks:
            code = stock.get("code", stock["symbol"].split(".")[0])
            if code not in result:
                result[code] = {"pe_ratio": None, "pb_ratio": None, "ps_ratio": None, "turnover_rate": None}
    except Exception as e:
        print(f"[recommend] batch PE/PB/PS error: {e}")
    return result


def _fetch_batch_financials(stocks: list[dict]) -> dict[str, dict]:
    _disable_proxies()
    result = {}
    import akshare as ak

    for stock in stocks:
        code = stock.get("code", stock["symbol"].split(".")[0])
        info = {
            "name": stock.get("name", ""),
            "roe": None, "gross_margin": None, "debt_ratio": None,
            "revenue": None, "net_profit": None, "total_assets": None,
            "pe_ratio": None, "revenue_growth": None, "net_profit_growth": None,
            "operating_cashflow": None, "cashflow_ratio": None,
            "inventory_turnover": None, "receivable_turnover": None,
        }

        try:
            fin_df = ak.stock_financial_abstract_ths(symbol=code, indicator="按报告期")
            if fin_df is not None and not fin_df.empty and len(fin_df) >= 1:
                latest = fin_df.iloc[0]

                for col_name in ['营业总收入', '营业收入']:
                    v = latest.get(col_name)
                    if v and str(v) not in ('', '--', 'nan', 'None'):
                        try:
                            s = str(v).replace(',', '')
                            if '亿' in s:
                                info['revenue'] = float(s.replace('亿', ''))
                            elif '万' in s:
                                info['revenue'] = float(s.replace('万', '')) / 10000
                        except (ValueError, TypeError):
                            pass
                        break

                for col_name in ['净利润', '归属于母公司股东的净利润']:
                    v = latest.get(col_name)
                    if v and str(v) not in ('', '--', 'nan', 'None'):
                        try:
                            s = str(v).replace(',', '')
                            if '亿' in s:
                                info['net_profit'] = float(s.replace('亿', ''))
                            elif '万' in s:
                                info['net_profit'] = float(s.replace('万', '')) / 10000
                        except (ValueError, TypeError):
                            pass
                        break

                for col_name in ['毛利率', '销售毛利率']:
                    v = latest.get(col_name)
                    if v and str(v) not in ('', '--', 'nan', 'None'):
                        try:
                            info['gross_margin'] = float(str(v).replace('%', '').replace(',', ''))
                        except (ValueError, TypeError):
                            pass
                        break

                for col_name in ['净资产收益率', '净资产收益率(%)']:
                    v = latest.get(col_name)
                    if v and str(v) not in ('', '--', 'nan', 'None'):
                        try:
                            info['roe'] = float(str(v).replace('%', '').replace(',', ''))
                        except (ValueError, TypeError):
                            pass
                        break

                for col_name in ['经营现金流量净额', '经营活动产生的现金流量净额']:
                    v = latest.get(col_name)
                    if v and str(v) not in ('', '--', 'nan', 'None'):
                        try:
                            s = str(v).replace(',', '')
                            if '亿' in s:
                                info['operating_cashflow'] = float(s.replace('亿', ''))
                            elif '万' in s:
                                info['operating_cashflow'] = float(s.replace('万', '')) / 10000
                        except (ValueError, TypeError):
                            pass
                        break

                if info['operating_cashflow'] is not None and info['net_profit'] is not None and info['net_profit'] != 0:
                    info['cashflow_ratio'] = info['operating_cashflow'] / abs(info['net_profit'])

                if len(fin_df) >= 2:
                    prev = fin_df.iloc[1]
                    for col_name in ['营业总收入', '营业收入']:
                        vn, vo = latest.get(col_name), prev.get(col_name)
                        if vn and vo and str(vn) not in ('', '--') and str(vo) not in ('', '--'):
                            try:
                                def _n(s):
                                    s = str(s).replace(',', '')
                                    if '亿' in s: return float(s.replace('亿', ''))
                                    if '万' in s: return float(s.replace('万', '')) / 10000
                                    return float(s) / 1e8
                                rn, ro = _n(vn), _n(vo)
                                if ro != 0:
                                    info['revenue_growth'] = ((rn - ro) / abs(ro)) * 100
                            except Exception:
                                pass
                        break
                    for col_name in ['净利润', '归属于母公司股东的净利润']:
                        vn, vo = latest.get(col_name), prev.get(col_name)
                        if vn and vo and str(vn) not in ('', '--') and str(vo) not in ('', '--'):
                            try:
                                def _n2(s):
                                    s = str(s).replace(',', '')
                                    if '亿' in s: return float(s.replace('亿', ''))
                                    if '万' in s: return float(s.replace('万', '')) / 10000
                                    return float(s) / 1e8
                                nn, no = _n2(vn), _n2(vo)
                                if no != 0:
                                    info['net_profit_growth'] = ((nn - no) / abs(no)) * 100
                            except Exception:
                                pass
                        break
        except Exception:
            pass

        result[code] = info
        time.sleep(0.15)

    return result


def _fetch_north_flow() -> dict[str, float]:
    _disable_proxies()
    result = {}
    try:
        import akshare as ak
        df = ak.stock_hsgt_individual_em(symbol="北向资金")
        if df is not None and not df.empty:
            for _, row in df.iterrows():
                code = str(row.get("股票代码", "")).strip()
                hold_pct = row.get("持股占比", None)
                if code and hold_pct is not None:
                    try:
                        result[code] = float(hold_pct)
                    except (ValueError, TypeError):
                        pass
    except Exception as e:
        print(f"[recommend] north flow error: {e}")
    return result


def _fetch_kline_close_batch(stocks: list[dict]) -> dict[str, list[float]]:
    _disable_proxies()
    result = {}
    try:
        import httpx
        for stock in stocks:
            sym = stock.get("symbol", "")
            code = sym.split(".")[0]
            if sym.endswith(".SH"):
                prefix = "sh"
            else:
                prefix = "sz"
            qt_sym = f"{prefix}{code}"
            try:
                resp = httpx.get(
                    f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={qt_sym},day,2024-01-01,,120,",
                    timeout=10.0,
                )
                data = resp.json()
                body = data.get("data", {}).get(qt_sym, {})
                closes = []
                for key in ["day", "week", "month"]:
                    if key in body:
                        for item in body[key]:
                            if len(item) >= 6:
                                try:
                                    closes.append(float(item[2]))
                                except (ValueError, TypeError):
                                    continue
                        break
                result[code] = closes
            except Exception:
                result[code] = []
            time.sleep(0.05)
    except Exception as e:
        print(f"[recommend] kline batch error: {e}")
    return result


def _compute_momentum_from_kline(closes: list[float]) -> tuple[Optional[float], Optional[float], Optional[float]]:
    try:
        if not closes or len(closes) < 20:
            return None, None, None

        arr = np.array(closes, dtype=float)
        arr = arr[~np.isnan(arr)]

        mom_20 = None
        if len(arr) >= 21:
            mom_20 = (arr[-1] / arr[-21] - 1.0) * 100.0

        mom_60 = None
        if len(arr) >= 61:
            mom_60 = (arr[-1] / arr[-61] - 1.0) * 100.0

        vol_20 = None
        if len(arr) >= 21:
            rets = np.diff(arr[-21:]) / arr[-21:-1]
            rets = rets[~np.isnan(rets)]
            if len(rets) > 0:
                vol_20 = float(np.std(rets) * np.sqrt(252) * 100)

        return mom_20, mom_60, vol_20
    except Exception:
        return None, None, None

        close_arr = np.array(close_series, dtype=float)
        close_arr = close_arr[~np.isnan(close_arr)]

        mom_20 = None
        if len(close_arr) >= 21:
            mom_20 = (close_arr[-1] / close_arr[-21] - 1.0) * 100.0

        mom_60 = None
        if len(close_arr) >= 61:
            mom_60 = (close_arr[-1] / close_arr[-61] - 1.0) * 100.0

        vol_20 = None
        if len(close_arr) >= 21:
            rets = np.diff(close_arr[-21:]) / close_arr[-21:-1]
            rets = rets[~np.isnan(rets)]
            if len(rets) > 0:
                vol_20 = float(np.std(rets) * np.sqrt(252) * 100)

        return mom_20, mom_60, vol_20
    except Exception:
        return None, None, None


def _fetch_batch_technicals(stocks: list[dict], get_indicators_fn,
                            batch_size: int = 5) -> dict[str, dict]:
    result = {}
    total = len(stocks)
    for i in range(0, total, batch_size):
        batch = stocks[i:i + batch_size]
        for stock in batch:
            code = stock.get("code", stock["symbol"].split(".")[0])
            try:
                ind = get_indicators_fn(stock["symbol"], "CN")
                result[code] = ind if ind else {}
            except Exception:
                result[code] = {}
        if i + batch_size < total:
            time.sleep(0.3)
    return result


# ==================== Risk Control ====================

def _apply_risk_controls(scores: list[StockScore]) -> list[StockScore]:
    sector_counts: dict[str, int] = {}
    filtered = []
    for s in scores:
        code = s.symbol.split(".")[0]
        sec = _STOCK_SECTOR_MAP.get(code, "其他")
        if sector_counts.get(sec, 0) >= 5:
            continue
        sector_counts[sec] = sector_counts.get(sec, 0) + 1
        filtered.append(s)
    return filtered


# ==================== Dynamic Factor Weights ====================

_FACTOR_WEIGHTS: dict[str, float] = {
    "value": 0.20,
    "growth": 0.20,
    "quality": 0.20,
    "tech": 0.20,
    "momentum": 0.12,
    "sentiment": 0.08,
}


def _load_dynamic_weights() -> dict[str, float]:
    try:
        wpath = os.path.join(os.path.dirname(__file__), "factor_weights.json")
        if os.path.exists(wpath):
            with open(wpath, "r") as f:
                w = json.load(f)
            return w
    except Exception:
        pass
    return _FACTOR_WEIGHTS.copy()


def _compute_total_score(s: StockScore, weights: dict[str, float]) -> float:
    return (
        s.value_score * weights.get("value", 0.20)
        + s.growth_score * weights.get("growth", 0.20)
        + s.quality_score * weights.get("quality", 0.20)
        + s.tech_score * weights.get("tech", 0.20)
        + s.momentum_score * weights.get("momentum", 0.12)
        + s.sentiment_score * weights.get("sentiment", 0.08)
    )


# ==================== Main Scan ====================

def run_scan(top_n: int = 20,
             get_indicators_fn=None,
             progress_cb=None,
             sector: Optional[str] = None,
             use_neutralize: bool = True) -> list[dict]:
    if not _STOCK_SECTOR_MAP:
        _STOCK_SECTOR_MAP.update(_load_static_sector_map())

    if sector:
        stocks = get_sector_stocks(sector)
        pool_name = sector
    else:
        stocks = get_hs300_stocks()
        pool_name = "沪深300"

    if not stocks:
        return []

    if progress_cb:
        progress_cb(0.05, f"获取{pool_name}股票池完成({len(stocks)}只)，开始获取基本面...")

    financials = _fetch_batch_financials(stocks)

    if progress_cb:
        progress_cb(0.30, "获取PE/PB/PS...")

    valuation = _fetch_batch_pe_pb_ps(stocks)

    if progress_cb:
        progress_cb(0.45, "获取技术指标...")

    if get_indicators_fn is None:
        get_indicators_fn = _dummy_indicators_fn

    tech_data = _fetch_batch_technicals(stocks, get_indicators_fn)

    if progress_cb:
        progress_cb(0.65, "获取北向资金...")

    north_data = _fetch_north_flow()

    if progress_cb:
        progress_cb(0.70, "获取K线计算动量...")

    kline_closes = _fetch_kline_close_batch(stocks)

    if progress_cb:
        progress_cb(0.80, "计算因子评分...")

    weights = _load_dynamic_weights()
    scores: list[StockScore] = []

    for stock in stocks:
        code = stock.get("code", stock["symbol"].split(".")[0])
        fin = financials.get(code, {})
        val = valuation.get(code, {})
        tech = tech_data.get(code, {})

        buy_score = tech.get("buy_score")
        trend = tech.get("trend")
        if buy_score is not None and buy_score < 15:
            continue

        pe = val.get("pe_ratio") or fin.get("pe_ratio")
        pb = val.get("pb_ratio")
        ps = val.get("ps_ratio")
        turnover = val.get("turnover_rate")

        closes = kline_closes.get(code, [])
        mom_20, mom_60, vol_20 = _compute_momentum_from_kline(closes)
        north_pct = north_data.get(code)

        kdj_golden = tech.get("kdj_golden_cross")
        boll_pos = tech.get("boll_pct_b")
        ma_align = None
        ma5 = tech.get("ma5")
        ma20 = tech.get("ma20")
        ma60 = tech.get("ma60")
        close = tech.get("close")
        if ma5 and ma20 and ma60 and close:
            try:
                ma_align = float(ma5) > float(ma20) > float(ma60)
            except (ValueError, TypeError):
                pass

        ret_5d = None
        if len(closes) >= 6:
            ret_5d = (closes[-1] / closes[-6] - 1) * 100
        ret_10d = None
        if len(closes) >= 11:
            ret_10d = (closes[-1] / closes[-11] - 1) * 100
        dist_ma60_pct = None
        if ma60 and close:
            try:
                dist_ma60_pct = (float(close) / float(ma60) - 1) * 100
            except (ValueError, TypeError):
                pass

        # vol_ratio approximation from turnover_rate
        vol_ratio = None
        if turnover is not None:
            vol_ratio = float(turnover) / 2.0 if float(turnover) > 0 else None

        cashflow_ratio = fin.get("cashflow_ratio")
        sector_name = _STOCK_SECTOR_MAP.get(code, "其他")

        s = StockScore(
            symbol=stock["symbol"],
            name=fin.get("name") or stock.get("name", ""),
            market="CN",
            pe_ratio=pe,
            pb_ratio=pb,
            ps_ratio=ps,
            revenue_growth=fin.get("revenue_growth"),
            net_profit_growth=fin.get("net_profit_growth"),
            roe=fin.get("roe"),
            gross_margin=fin.get("gross_margin"),
            operating_cashflow_ratio=cashflow_ratio,
            rsi14=tech.get("rsi14"),
            slope_pct=tech.get("slope_pct"),
            buy_price_aggressive=tech.get("buy_price_aggressive"),
            sell_price=tech.get("sell_price"),
            strategy_buy_zone_low=tech.get("strategy_buy_zone_low"),
            strategy_buy_zone_high=tech.get("strategy_buy_zone_high"),
            strategy_stop_loss=tech.get("strategy_stop_loss"),
            strategy_take_profit_1=tech.get("strategy_take_profit_1"),
            strategy_take_profit_2=tech.get("strategy_take_profit_2"),
            buy_score=buy_score,
            sell_score=tech.get("sell_score"),
            buy_grade=tech.get("buy_grade"),
            sell_grade=tech.get("sell_grade"),
            trend=trend,
            sector_name=sector_name,
            momentum_20d=mom_20,
            momentum_60d=mom_60,
            volatility_20d=vol_20,
            turnover_rate=turnover,
            north_holding_pct=north_pct,
        )

        s.value_score = _score_value(pe, pb, ps)
        s.growth_score = _score_growth(
            fin.get("revenue_growth"), fin.get("net_profit_growth"))
        s.quality_score = _score_quality(
            fin.get("roe"), fin.get("gross_margin"), fin.get("debt_ratio"),
            cashflow_ratio)
        s.tech_score = _score_tech(
            tech.get("rsi14"), tech.get("slope_pct"),
            tech.get("buy_price_aggressive_ok"),
            tech.get("signal_golden_cross"),
            tech.get("signal_macd_bullish"),
            tech.get("rsi_rebound"),
            kdj_golden, boll_pos, ma_align)
        s.momentum_score = _score_momentum(mom_20, mom_60, vol_20)
        s.sentiment_score = _score_sentiment(north_pct, turnover)

        s.quality_score_total = s.value_score + s.growth_score + s.quality_score
        s.timing_score_total = _score_timing(
            tech.get("rsi14"), boll_pos,
            kdj_golden, tech.get("signal_golden_cross"),
            ma_align, tech.get("slope_pct"),
            tech.get("buy_price_aggressive_ok"),
            buy_score, trend,
            vol_ratio=vol_ratio,
            ret_5d=ret_5d,
            ret_10d=ret_10d,
            dist_ma60_pct=dist_ma60_pct)
        s.timing_signal_reason = _timing_signal_reason(
            s.timing_score_total, tech.get("rsi14"), tech.get("slope_pct"),
            vol_ratio, ret_5d, ret_10d, dist_ma60_pct)

        scores.append(s)

    if use_neutralize:
        scores = _rank_neutralize(scores)

    for s in scores:
        s.quality_score_total = s.value_score + s.growth_score + s.quality_score

    sector_strength = _sector_strength_scores(scores)
    for s in scores:
        sec = s.sector_name or _STOCK_SECTOR_MAP.get(s.symbol.split(".")[0], "其他")
        s.sector_name = sec
        s.sector_strength_score = sector_strength.get(sec, 50.0)

    QUALITY_THRESHOLD = 30.0
    cn_market_state = _cn_index_market_state()
    cn_market_allows_strong_buy = cn_market_state in ("weak", "unknown")

    qualified = [s for s in scores if (s.quality_score_total or 0) >= QUALITY_THRESHOLD]
    unqualified = [s for s in scores if (s.quality_score_total or 0) < QUALITY_THRESHOLD]

    for s in qualified:
        qt = (s.quality_score_total or 0) / 75.0 * 100
        tt = max(0, (s.timing_score_total or 0) + 40) / 140.0 * 100
        st = s.sector_strength_score if s.sector_strength_score is not None else 50.0
        s.total_score = qt * 0.30 + tt * 0.55 + st * 0.15

    for s in unqualified:
        qt = (s.quality_score_total or 0) / 75.0 * 100
        tt = max(0, (s.timing_score_total or 0) + 40) / 140.0 * 100
        st = s.sector_strength_score if s.sector_strength_score is not None else 50.0
        s.total_score = qt * 0.10 + tt * 0.30 + st * 0.10 - 10

    qualified.sort(key=lambda x: x.total_score, reverse=True)
    unqualified.sort(key=lambda x: x.total_score, reverse=True)

    scores = _apply_risk_controls(qualified + unqualified)

    results = []
    for i, s in enumerate(scores[:top_n]):
        s.rank = i + 1
        s.reason = _generate_factor_reason(s)
        qt = s.quality_score_total or 0
        tt = s.timing_score_total or 0
        if qt >= QUALITY_THRESHOLD and tt >= 96 and cn_market_allows_strong_buy:
            s.action = "强买信号"
        elif qt >= QUALITY_THRESHOLD and tt >= 80 and cn_market_allows_strong_buy:
            s.action = "积极建仓"
        elif qt >= QUALITY_THRESHOLD and tt >= 80:
            s.action = "关注等买点"
        elif qt >= QUALITY_THRESHOLD and tt >= 60:
            s.action = "轻仓试探"
        elif qt >= QUALITY_THRESHOLD and tt >= 0:
            s.action = "关注等买点"
        elif tt >= 80:
            s.action = "有买点基本面弱"
        elif qt >= QUALITY_THRESHOLD:
            s.action = "优质远离买点"
        else:
            s.action = "暂不关注"
        sector_strength_score = s.sector_strength_score if s.sector_strength_score is not None else 50.0
        if sector_strength_score < 25:
            s.action = _downgrade_action(s.action, 2)
        elif sector_strength_score < 35:
            s.action = _downgrade_action(s.action, 1)
        s.recommendation_bucket = _bucket_for_action(s.action)
        results.append(asdict(s))

    if progress_cb:
        progress_cb(1.0, "扫描完成")

    return results


def _generate_factor_reason(s: StockScore) -> str:
    quality_parts = []
    timing_parts = []

    if s.value_score >= 18:
        if s.pe_ratio is not None and s.pe_ratio > 0:
            quality_parts.append(f"PE {s.pe_ratio:.0f}")
        else:
            quality_parts.append("低估值")
    elif s.value_score >= 14:
        quality_parts.append("估值适中")

    if s.growth_score >= 20:
        quality_parts.append("高成长")
    elif s.growth_score >= 16:
        quality_parts.append("稳增长")

    if s.quality_score >= 18:
        quality_parts.append("基本面优")
    elif s.quality_score >= 14:
        if s.roe is not None and s.roe >= 15:
            quality_parts.append(f"ROE {s.roe:.0f}%")

    if s.trend and s.trend in ("上涨", "震荡偏强"):
        timing_parts.append(f"趋势{s.trend}")
    if s.rsi14 is not None:
        if 25 <= s.rsi14 <= 45:
            timing_parts.append(f"RSI {s.rsi14:.0f} 回调到位")
        elif 45 < s.rsi14 <= 55:
            timing_parts.append("RSI中性")
        elif s.rsi14 > 70:
            timing_parts.append("RSI偏高")
    if s.buy_score is not None and s.buy_score >= 35:
        timing_parts.append(f"买入信号{s.buy_score}分")
    if s.timing_signal_reason and s.timing_signal_reason != "暂无高胜率买点":
        timing_parts.insert(0, s.timing_signal_reason)

    q_str = "、".join(quality_parts[:2]) if quality_parts else "基本面一般"
    t_str = "、".join(timing_parts[:2]) if timing_parts else "暂无明确买点"
    return f"{q_str} | {t_str}"


def _dummy_indicators_fn(symbol: str, market: str) -> dict:
    return {}


def get_latest_scan() -> Optional[list[dict]]:
    global _LATEST_SCAN_RESULT, _LATEST_SCAN_TIME
    with _SCAN_LOCK:
        if _LATEST_SCAN_RESULT is None:
            return None
        if time.time() - _LATEST_SCAN_TIME > 86400:
            return None
        return _LATEST_SCAN_RESULT


def save_scan_result(results: list[dict]):
    global _LATEST_SCAN_RESULT, _LATEST_SCAN_TIME
    with _SCAN_LOCK:
        _LATEST_SCAN_RESULT = results
        _LATEST_SCAN_TIME = time.time()


def generate_ai_reasons(results: list[dict], llm_call_fn=None) -> list[dict]:
    if llm_call_fn is None:
        return results

    for item in results:
        try:
            prompt = f"""请用一句简洁的中文(不超过30字)概括以下股票的推荐理由，不要加序号、不要加引号：
股票: {item['name']}({item['symbol']})
PE: {item.get('pe_ratio', '未知')}
PB: {item.get('pb_ratio', '未知')}
ROE: {item.get('roe', '未知')}%
毛利率: {item.get('gross_margin', '未知')}%
营收增长: {item.get('revenue_growth', '未知')}%
净利润增长: {item.get('net_profit_growth', '未知')}%
RSI: {item.get('rsi14', '未知')}
动量20日: {item.get('momentum_20d', '未知')}%
波动率: {item.get('volatility_20d', '未知')}%
因子评分: 价值{item['value_score']:.0f}/成长{item['growth_score']:.0f}/质量{item['quality_score']:.0f}/技术{item['tech_score']:.0f}/动量{item.get('momentum_score',0):.0f}/情绪{item.get('sentiment_score',0):.0f}
只输出一句话推荐理由:"""
            reason = llm_call_fn(
                "你是股票分析师，擅长用简洁语言概括投资亮点。",
                prompt,
                temperature=0.3,
                max_tokens=100,
            )
            if reason and len(reason.strip()) > 3:
                item["reason"] = reason.strip()
        except Exception as e:
            print(f"[recommend] AI reason error for {item['symbol']}: {e}")

    return results
