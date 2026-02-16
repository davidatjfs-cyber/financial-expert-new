#!/usr/bin/env python3
"""Quick test: verify _g() helper reads data from dict-typed indicators/price."""
from api import get_stock_indicators, get_stock_price

si = get_stock_indicators(symbol="600031.SH", market="CN")
sp = get_stock_price(symbol="600031.SH", market="CN")

def _g(obj, key, default=None):
    if obj is None: return default
    if isinstance(obj, dict): return obj.get(key, default)
    return getattr(obj, key, default)

def _safe(v, fmt=".2f"):
    if v is None: return "N/A"
    try: return f"{float(v):{fmt}}"
    except: return str(v)

print("=== Price data ===")
print("type:", type(sp))
print("price:", _g(sp, "price"))
print("open:", _g(sp, "open"))
print("high:", _g(sp, "high"))
print("change_pct:", _g(sp, "change_pct"))
print("volume:", _g(sp, "volume"))

print()
print("=== Indicator data ===")
print("type:", type(si))
print("ma5:", _safe(_g(si, "ma5")))
print("ma20:", _safe(_g(si, "ma20")))
print("ma60:", _safe(_g(si, "ma60")))
print("rsi14:", _safe(_g(si, "rsi14")))
print("atr14:", _safe(_g(si, "atr14")))
print("trend:", _g(si, "trend", "N/A"))
print("high_52w:", _safe(_g(si, "high_52w")))
print("low_52w:", _safe(_g(si, "low_52w")))
print("buy_price:", _safe(_g(si, "buy_price_aggressive")))
print("sell_price:", _safe(_g(si, "sell_price")))
print("buy_desc:", _g(si, "buy_condition_desc", "N/A"))
print("sell_desc:", _g(si, "sell_condition_desc", "N/A"))

# Count N/A vs real values
fields = ["ma5","ma20","ma60","rsi14","atr14","high_52w","low_52w","macd_dif","macd_dea","pe_ratio","buy_price_aggressive","sell_price"]
real = sum(1 for f in fields if _g(si, f) is not None)
print(f"\nReal indicator values: {real}/{len(fields)}")
