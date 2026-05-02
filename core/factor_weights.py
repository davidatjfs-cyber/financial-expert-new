"""
沪深300智能选股 - 动态因子权重优化
基于滚动回归计算各因子的预测贡献度，动态调整权重
"""
from __future__ import annotations

import os
import json
import time
import numpy as np
from typing import Optional

_FACTOR_NAMES = ["value", "growth", "quality", "tech", "momentum", "sentiment"]
_DEFAULT_WEIGHTS = {
    "value": 0.20,
    "growth": 0.20,
    "quality": 0.20,
    "tech": 0.20,
    "momentum": 0.12,
    "sentiment": 0.08,
}


def _disable_proxies():
    try:
        from core.net import disable_proxies_for_process
        disable_proxies_for_process()
    except Exception:
        pass


def optimize_weights(progress_cb=None) -> dict:
    """
    基于历史数据滚动回归优化因子权重
    """
    _disable_proxies()
    from core.recommend import get_hs300_stocks
    from core.backtest import fetch_history_close, fetch_index_close

    stocks = get_hs300_stocks()
    if not stocks:
        return _DEFAULT_WEIGHTS

    if progress_cb:
        progress_cb(0.05, "获取指数历史...")

    index_klines = fetch_index_close("000300", days=600)
    if not index_klines:
        return _DEFAULT_WEIGHTS

    index_prices = {k[0]: k[1] for k in index_klines}
    index_dates = [k[0] for k in index_klines]

    from core.recommend import _fetch_batch_financials, _fetch_batch_pe_pb_ps

    import random
    random.seed(42)
    sample_stocks = random.sample(stocks, min(80, len(stocks)))

    if progress_cb:
        progress_cb(0.1, "获取基本面数据...")

    financials = _fetch_batch_financials(sample_stocks)
    valuations = _fetch_batch_pe_pb_ps(sample_stocks)

    if progress_cb:
        progress_cb(0.3, "获取历史价格...")

    stock_cache: dict[str, dict[str, float]] = {}
    for si, stock in enumerate(sample_stocks):
        klines = fetch_history_close(stock["symbol"], days=600)
        stock_cache[stock["symbol"]] = {k[0]: k[1] for k in klines}
        if progress_cb:
            pct = 0.3 + 0.3 * (si / len(sample_stocks))
            progress_cb(pct, f"历史数据 {si}/{len(sample_stocks)}...")
        time.sleep(0.05)

    if progress_cb:
        progress_cb(0.65, "计算因子收益率...")

    factor_returns: dict[str, list[float]] = {f: [] for f in _FACTOR_NAMES}

    for month_offset in range(6):
        offset_days = (6 - month_offset) * 20
        as_of_idx = len(index_dates) - 1 - offset_days - 20
        if as_of_idx < 60:
            continue
        as_of_date = index_dates[as_of_idx]
        fwd_idx = as_of_idx + 20
        fwd_date = index_dates[fwd_idx]

        bm_ret = 0.0
        bm_s = index_prices.get(as_of_date)
        bm_e = index_prices.get(fwd_date)
        if bm_s and bm_e and bm_s > 0:
            bm_ret = bm_e / bm_s - 1.0

        stock_factor_rets = []
        for stock in sample_stocks:
            sym = stock["symbol"]
            code = stock.get("code", sym.split(".")[0])
            pm = stock_cache.get(sym, {})
            p_s = pm.get(as_of_date)
            p_e = pm.get(fwd_date)
            if not p_s or not p_e or p_s == 0:
                continue

            ret = p_e / p_s - 1.0 - bm_ret

            fin = financials.get(code, {})
            val = valuations.get(code, {})

            pe = val.get("pe_ratio")
            pb = val.get("pb_ratio")
            ps = val.get("ps_ratio")

            value_score = 0.0
            vc = 0
            if pe is not None and pe > 0:
                vc += 1
                value_score += max(0, min(25, 25 - pe * 0.3))
            if pb is not None and pb > 0:
                vc += 1
                value_score += max(0, min(25, 25 - pb * 2.0))
            if vc > 0:
                value_score /= vc
            else:
                value_score = 12.5

            rev_g = fin.get("revenue_growth") or 0.0
            np_g = fin.get("net_profit_growth") or 0.0
            growth_score = max(0, min(25, 10 + (rev_g + np_g) / 4.0))

            roe = fin.get("roe") or 0.0
            gm = fin.get("gross_margin") or 0.0
            quality_score = max(0, min(25, 12.5 + roe * 0.3 + gm * 0.1))

            stock_factor_rets.append({
                "value": value_score,
                "growth": growth_score,
                "quality": quality_score,
                "tech": 12.5,
                "momentum": 10.0,
                "sentiment": 5.0,
                "return": ret,
            })

        if not stock_factor_rets:
            continue

        try:
            from sklearn.linear_model import LinearRegression
            X = []
            y = []
            for sfr in stock_factor_rets:
                row = [sfr[f] for f in _FACTOR_NAMES]
                X.append(row)
                y.append(sfr["return"])
            X = np.array(X)
            y = np.array(y)

            reg = LinearRegression().fit(X, y)
            coefs = np.abs(reg.coef_)
            total_c = coefs.sum()
            if total_c > 0:
                norm_coefs = coefs / total_c
                for fi, fn in enumerate(_FACTOR_NAMES):
                    factor_returns[fn].append(float(norm_coefs[fi]))
        except Exception as e:
            print(f"[weights] regression error: {e}")

    weights = {}
    for fn in _FACTOR_NAMES:
        vals = factor_returns.get(fn, [])
        if vals:
            weights[fn] = round(float(np.mean(vals)), 4)
        else:
            weights[fn] = _DEFAULT_WEIGHTS.get(fn, 0.1)

    total_w = sum(weights.values())
    if total_w > 0:
        weights = {k: round(v / total_w, 4) for k, v in weights.items()}

    if progress_cb:
        progress_cb(0.9, "保存权重...")

    weights_path = os.path.join(os.path.dirname(__file__), "factor_weights.json")
    try:
        with open(weights_path, "w") as f:
            json.dump(weights, f, indent=2)
    except Exception as e:
        print(f"[weights] save error: {e}")

    if progress_cb:
        progress_cb(1.0, "权重优化完成")

    print(f"[weights] optimized: {weights}")
    return weights
