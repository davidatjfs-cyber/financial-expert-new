"""
数值模拟：对比新旧策略在典型A股场景下的表现差异

这不是历史回测（我们没有历史K线全量），而是基于以下方法：
1. 构造几个有代表性的价格场景（牛市趋势、震荡、反弹后回落等）
2. 对每个场景用旧策略和新策略分别模拟交易
3. 报告P&L、胜率、单笔贡献等指标

目的：验证我们的5项改进在合理假设下确实能改善结果。
"""
from __future__ import annotations
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


# ===== 旧策略：固定TP1卖半仓+TP2卖全仓 =====
def simulate_old_strategy(entry_price, daily_prices, tp1_pct=0.05, tp2_pct=0.10, stop_pct=-0.08):
    """旧策略：达到TP1卖50%，达到TP2卖剩余50%，达到stop_loss卖全部。"""
    tp1 = entry_price * (1 + tp1_pct)
    tp2 = entry_price * (1 + tp2_pct)
    stop = entry_price * (1 + stop_pct)
    held_qty = 1.0  # 标准化
    realized_pnl = 0.0
    tp1_hit = False
    exit_reason = "未触发"
    for day, price in enumerate(daily_prices):
        if held_qty <= 0:
            break
        if not tp1_hit and price >= tp1:
            sell_qty = held_qty / 2.0
            realized_pnl += (price - entry_price) * sell_qty
            held_qty -= sell_qty
            tp1_hit = True
        elif price >= tp2:
            realized_pnl += (price - entry_price) * held_qty
            held_qty = 0.0
            exit_reason = f"day_{day}_tp2"
        elif price <= stop:
            realized_pnl += (price - entry_price) * held_qty
            held_qty = 0.0
            exit_reason = f"day_{day}_stop"
    # 收盘强制清算（不是真实情况但便于对比）
    if held_qty > 0:
        last_price = daily_prices[-1]
        realized_pnl += (last_price - entry_price) * held_qty
        exit_reason += f"_open_at_{last_price:.2f}"
    return realized_pnl / entry_price * 100.0, exit_reason


# ===== 新策略：trailing stop + 短期保护 =====
def simulate_new_strategy(entry_price, daily_prices,
                          tp1_pct=0.05, tp2_pct=0.10, stop_pct=-0.08,
                          trailing_activate=0.05, trailing_drawdown=0.05):
    """新策略：TP1后启用移动止损 (peak * (1-trailing_drawdown))，全程跟踪。"""
    tp1 = entry_price * (1 + tp1_pct)
    tp2 = entry_price * (1 + tp2_pct)
    raw_stop = entry_price * (1 + stop_pct)
    held_qty = 1.0
    realized_pnl = 0.0
    peak = entry_price
    tp1_hit = False
    exit_reason = "未触发"
    for day, price in enumerate(daily_prices):
        if held_qty <= 0:
            break
        if price > peak:
            peak = price
        # 计算effective stop：trailing激活后取较高者
        if peak >= entry_price * (1 + trailing_activate):
            effective_stop = max(raw_stop, peak * (1 - trailing_drawdown))
        else:
            effective_stop = raw_stop
        # TP1: 卖半仓
        if not tp1_hit and price >= tp1:
            sell_qty = held_qty / 2.0
            realized_pnl += (price - entry_price) * sell_qty
            held_qty -= sell_qty
            tp1_hit = True
            continue
        # TP2: 卖全部
        if price >= tp2:
            realized_pnl += (price - entry_price) * held_qty
            held_qty = 0.0
            exit_reason = f"day_{day}_tp2"
            break
        # Stop loss (raw or trailing): 卖全部
        if price <= effective_stop:
            realized_pnl += (price - entry_price) * held_qty
            held_qty = 0.0
            exit_reason = f"day_{day}_stop_at_{effective_stop:.2f}"
            break
    if held_qty > 0:
        last_price = daily_prices[-1]
        realized_pnl += (last_price - entry_price) * held_qty
        exit_reason += f"_open_at_{last_price:.2f}"
    return realized_pnl / entry_price * 100.0, exit_reason


def run_scenarios():
    """构造典型场景并对比新旧策略表现。"""
    entry = 100.0
    scenarios = [
        # 场景1: 趋势上涨（最常见）- 慢慢涨到+25%
        {
            "name": "趋势上涨 +25%",
            "prices": [100, 102, 105, 107, 108, 110, 112, 115, 118, 120, 122, 125],
        },
        # 场景2: 急涨后回落（移动止损价值最高的场景）
        {
            "name": "急涨后回落 +15%→+3%",
            "prices": [100, 103, 106, 108, 112, 115, 113, 110, 108, 105, 103],
        },
        # 场景3: 触达TP1后回吐
        {
            "name": "触达TP1后回到平本",
            "prices": [100, 102, 104, 105, 106, 104, 102, 100, 98, 95],
        },
        # 场景4: 触达TP1后继续上涨到TP2
        {
            "name": "触达TP1后继续涨到TP2",
            "prices": [100, 102, 104, 105, 107, 108, 109, 110, 111],
        },
        # 场景5: 趋势失败止损
        {
            "name": "趋势失败止损",
            "prices": [100, 98, 95, 93, 91, 90, 88, 85],
        },
        # 场景6: 慢牛 - 涨10%以上但慢
        {
            "name": "慢牛 +18%",
            "prices": [100, 101, 102, 103, 104, 105, 106, 107, 108, 110, 112, 115, 118],
        },
        # 场景7: 假突破 - 涨到+6%然后回落
        {
            "name": "假突破 +6%→-3%",
            "prices": [100, 102, 104, 106, 104, 102, 100, 98, 97],
        },
        # 场景8: 大幅上涨50% (验证trailing捕获大趋势)
        {
            "name": "大幅上涨+50%",
            "prices": [100, 105, 108, 112, 116, 120, 125, 130, 135, 140, 145, 150],
        },
    ]

    print(f"{'场景':<26} {'旧策略':>10} {'新策略':>10} {'差异':>10}")
    print("-" * 60)
    old_total = 0.0
    new_total = 0.0
    new_wins = 0
    for s in scenarios:
        old_ret, _ = simulate_old_strategy(entry, s["prices"])
        new_ret, _ = simulate_new_strategy(entry, s["prices"])
        diff = new_ret - old_ret
        old_total += old_ret
        new_total += new_ret
        if diff >= 0:
            new_wins += 1
        sign = "+" if diff >= 0 else ""
        print(f"{s['name']:<26} {old_ret:>8.2f}% {new_ret:>8.2f}% {sign}{diff:>7.2f}%")
    print("-" * 60)
    print(f"{'累计':<26} {old_total:>8.2f}% {new_total:>8.2f}% {'+' if new_total>old_total else ''}{new_total - old_total:>7.2f}%")
    print(f"\n新策略在 {new_wins}/{len(scenarios)} 个场景中表现 ≥ 旧策略")
    print(f"新策略平均单笔贡献提升: {(new_total - old_total) / len(scenarios):+.2f}%")


if __name__ == "__main__":
    run_scenarios()
