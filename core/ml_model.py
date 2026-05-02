"""
沪深300智能选股 - XGBoost 排序模型
训练: 用历史因子数据预测未来20日超额收益
预测: 对当前股票池打分排序
"""
from __future__ import annotations

import os
import json
import time
import threading
from typing import Optional

import numpy as np

_MODEL_LOCK = threading.Lock()
_TRAINED_MODEL = None
_MODEL_TRAIN_TIME: float = 0.0
_FEATURE_COLS = [
    "pe_ratio", "pb_ratio", "ps_ratio",
    "revenue_growth", "net_profit_growth",
    "roe", "gross_margin", "cashflow_ratio",
    "rsi14", "slope_pct",
    "momentum_20d", "momentum_60d", "volatility_20d",
    "turnover_rate",
]


def _disable_proxies():
    try:
        from core.net import disable_proxies_for_process
        disable_proxies_for_process()
    except Exception:
        pass


def _get_feature_vector(stock_data: dict) -> list[float]:
    vec = []
    for col in _FEATURE_COLS:
        v = stock_data.get(col)
        if v is None:
            vec.append(0.0)
        else:
            try:
                vec.append(float(v))
            except (ValueError, TypeError):
                vec.append(0.0)
    return vec


def build_training_dataset(
    progress_cb=None,
    max_stocks: int = 100,
) -> tuple[np.ndarray, np.ndarray]:
    """
    构建训练数据集
    返回: (X, y) - 特征矩阵和标签(是否跑赢指数)
    """
    _disable_proxies()
    from core.recommend import get_hs300_stocks, _STOCK_SECTOR_MAP
    from core.backtest import fetch_history_close, fetch_index_close

    stocks = get_hs300_stocks()
    if not stocks:
        return np.array([]), np.array([])

    if max_stocks and max_stocks < len(stocks):
        import random
        random.seed(42)
        stocks = random.sample(stocks, max_stocks)

    if progress_cb:
        progress_cb(0.05, f"获取指数数据用于训练集...")

    index_klines = fetch_index_close("000300", days=600)
    if not index_klines:
        return np.array([]), np.array([])

    index_prices = {k[0]: k[1] for k in index_klines}
    index_dates = [k[0] for k in index_klines]

    train_months = []
    for i in range(len(index_dates) - 1):
        d1 = index_dates[i][:7]
        d2 = index_dates[i + 1][:7]
        if d1 != d2:
            train_months.append(index_dates[i])

    train_months = train_months[-12:]

    if len(train_months) < 3:
        return np.array([]), np.array([])

    if progress_cb:
        progress_cb(0.1, f"获取{len(stocks)}只股票历史...")

    stock_hist_cache: dict[str, dict[str, float]] = {}
    for si, stock in enumerate(stocks):
        klines = fetch_history_close(stock["symbol"], days=600)
        stock_hist_cache[stock["symbol"]] = {k[0]: k[1] for k in klines}
        if progress_cb:
            pct = 0.1 + 0.3 * (si / len(stocks))
            progress_cb(pct, f"历史数据 {si}/{len(stocks)}...")
        time.sleep(0.05)

    if progress_cb:
        progress_cb(0.45, "获取基本面数据用于训练集...")

    from core.recommend import _fetch_batch_financials, _fetch_batch_pe_pb_ps
    financials = _fetch_batch_financials(stocks)
    valuations = _fetch_batch_pe_pb_ps(stocks)

    X_all = []
    y_all = []

    for mi, month_date in enumerate(train_months):
        if progress_cb:
            pct = 0.5 + 0.4 * (mi / len(train_months))
            progress_cb(pct, f"训练数据构建 {mi}/{len(train_months)}...")

        month_idx = None
        for di, d in enumerate(index_dates):
            if d >= month_date:
                month_idx = di
                break
        if month_idx is None:
            continue

        fwd_idx = min(month_idx + 20, len(index_dates) - 1)
        fwd_date = index_dates[fwd_idx]

        bm_start = index_prices.get(month_date)
        bm_end = index_prices.get(fwd_date)
        if not bm_start or not bm_end or bm_start == 0:
            continue
        bm_ret = bm_end / bm_start - 1.0

        for stock in stocks:
            sym = stock["symbol"]
            code = stock.get("code", sym.split(".")[0])
            pm = stock_hist_cache.get(sym, {})
            p_start = pm.get(month_date)
            p_end = pm.get(fwd_date)

            if not p_start or not p_end or p_start == 0:
                continue

            stock_ret = p_end / p_start - 1.0
            excess = stock_ret - bm_ret

            fin = financials.get(code, {})
            val = valuations.get(code, {})

            features = {
                "pe_ratio": val.get("pe_ratio"),
                "pb_ratio": val.get("pb_ratio"),
                "ps_ratio": val.get("ps_ratio"),
                "revenue_growth": fin.get("revenue_growth"),
                "net_profit_growth": fin.get("net_profit_growth"),
                "roe": fin.get("roe"),
                "gross_margin": fin.get("gross_margin"),
                "cashflow_ratio": fin.get("cashflow_ratio"),
                "rsi14": None,
                "slope_pct": None,
                "momentum_20d": None,
                "momentum_60d": None,
                "volatility_20d": None,
                "turnover_rate": val.get("turnover_rate"),
            }

            prices_before = []
            dates_before = [d for d in index_dates if d <= month_date][-60:]
            for d in dates_before:
                if d in pm:
                    prices_before.append(pm[d])

            if len(prices_before) >= 20:
                arr = np.array(prices_before)
                features["momentum_20d"] = (arr[-1] / arr[-20] - 1.0) * 100.0
                if len(arr) >= 60:
                    features["momentum_60d"] = (arr[-1] / arr[0] - 1.0) * 100.0
                tail = arr[-20:]
                rets = np.diff(tail) / tail[:-1]
                features["volatility_20d"] = float(np.std(rets) * np.sqrt(252) * 100) if len(rets) > 0 else None

            vec = _get_feature_vector(features)
            label = 1.0 if excess > 0 else 0.0
            X_all.append(vec)
            y_all.append(label)

    if not X_all:
        return np.array([]), np.array([])

    return np.array(X_all), np.array(y_all)


def train_model(X: np.ndarray, y: np.ndarray) -> object:
    try:
        from xgboost import XGBClassifier
        model = XGBClassifier(
            n_estimators=100,
            max_depth=4,
            learning_rate=0.1,
            subsample=0.8,
            colsample_bytree=0.8,
            objective="binary:logistic",
            eval_metric="logloss",
            use_label_encoder=False,
            random_state=42,
        )
        model.fit(X, y)
        return model
    except ImportError:
        print("[ml_model] xgboost not available, falling back to sklearn")
        from sklearn.ensemble import GradientBoostingClassifier
        model = GradientBoostingClassifier(
            n_estimators=100,
            max_depth=4,
            learning_rate=0.1,
            subsample=0.8,
            random_state=42,
        )
        model.fit(X, y)
        return model
    except Exception as e:
        print(f"[ml_model] train error: {e}")
        return None


def predict_scores(stocks_data: list[dict]) -> list[tuple[str, float]]:
    global _TRAINED_MODEL
    if _TRAINED_MODEL is None:
        return [(s.get("symbol", ""), 0.0) for s in stocks_data]

    results = []
    for stock in stocks_data:
        vec = _get_feature_vector(stock)
        X = np.array([vec])
        try:
            prob = _TRAINED_MODEL.predict_proba(X)[0]
            score = prob[1] if len(prob) > 1 else prob[0]
        except Exception:
            score = 0.5
        sym = stock.get("symbol", "")
        results.append((sym, float(score)))

    return results


def train_and_save(progress_cb=None) -> dict:
    global _TRAINED_MODEL, _MODEL_TRAIN_TIME

    X, y = build_training_dataset(progress_cb=progress_cb)
    if len(X) == 0:
        return {"status": "error", "message": "训练数据不足"}

    print(f"[ml_model] training with {len(X)} samples, {X.shape[1]} features")
    print(f"[ml_model] positive ratio: {y.mean():.2%}")

    model = train_model(X, y)
    if model is None:
        return {"status": "error", "message": "模型训练失败"}

    with _MODEL_LOCK:
        _TRAINED_MODEL = model
        _MODEL_TRAIN_TIME = time.time()

    model_path = os.path.join(os.path.dirname(__file__), "xgb_model.json")
    try:
        model.save_model(model_path)
    except Exception:
        try:
            import joblib
            joblib.dump(model, model_path.replace(".json", ".pkl"))
        except Exception as e:
            print(f"[ml_model] save error: {e}")

    train_pred = model.predict(X)
    acc = float(np.mean(train_pred == y))
    feature_importance = {}
    try:
        fi = model.feature_importances_
        for name, imp in zip(_FEATURE_COLS, fi):
            feature_importance[name] = round(float(imp), 4)
    except Exception:
        pass

    result = {
        "status": "ok",
        "samples": len(X),
        "positive_ratio": round(float(y.mean()), 3),
        "train_accuracy": round(acc, 3),
        "feature_importance": feature_importance,
    }

    print(f"[ml_model] training done: acc={acc:.3f}, importance={feature_importance}")
    return result


def load_model() -> bool:
    global _TRAINED_MODEL, _MODEL_TRAIN_TIME
    model_path = os.path.join(os.path.dirname(__file__), "xgb_model.json")
    pkl_path = os.path.join(os.path.dirname(__file__), "xgb_model.pkl")

    try:
        if os.path.exists(model_path):
            from xgboost import XGBClassifier
            model = XGBClassifier()
            model.load_model(model_path)
            with _MODEL_LOCK:
                _TRAINED_MODEL = model
                _MODEL_TRAIN_TIME = time.time()
            print(f"[ml_model] loaded xgb model from {model_path}")
            return True
    except Exception:
        pass

    try:
        if os.path.exists(pkl_path):
            import joblib
            model = joblib.load(pkl_path)
            with _MODEL_LOCK:
                _TRAINED_MODEL = model
                _MODEL_TRAIN_TIME = time.time()
            print(f"[ml_model] loaded model from {pkl_path}")
            return True
    except Exception:
        pass

    return False


def get_model_info() -> dict:
    global _TRAINED_MODEL, _MODEL_TRAIN_TIME
    with _MODEL_LOCK:
        if _TRAINED_MODEL is None:
            return {"trained": False}
        return {
            "trained": True,
            "train_time": _MODEL_TRAIN_TIME,
            "model_type": type(_TRAINED_MODEL).__name__,
        }
