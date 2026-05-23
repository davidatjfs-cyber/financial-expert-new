import json
import os
import sys


def _main() -> int:
    sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
    try:
        import api  # type: ignore
    except Exception as e:
        print(f"IMPORT_FAIL: {e}")
        return 2

    cases = [
        {
            "name": "buy_ok_true",
            "buy_score": 68,
            "buy_grade": "建议买入",
            "buy_score_details": {
                "trend": {"score": 8, "max": 8, "reason": "上涨趋势"},
                "ma_align": {"score": 8, "max": 8, "reason": "多头排列"},
                "price_pos": {"score": 5, "max": 5, "reason": "高于MA60"},
                "rsi": {"score": 22, "max": 25, "reason": "RSI超卖反弹(36.1)"},
                "kdj": {"score": 10, "max": 15, "reason": "KDJ金叉超卖(J=18.5)"},
                "volume": {"score": 10, "max": 10, "reason": "放量>MA10"},
                "macd": {"score": 5, "max": 5, "reason": "MACD多头"},
                "boll": {"score": 6, "max": 12, "reason": "布林下方"},
            },
        },
        {
            "name": "buy_ok_false",
            "buy_score": 12,
            "buy_grade": "不建议",
            "buy_score_details": {
                "trend": {"score": 0, "max": 8, "reason": "下跌趋势"},
                "ma_align": {"score": 0, "max": 8, "reason": "非多头"},
                "price_pos": {"score": 0, "max": 5, "reason": "低于MA60"},
                "rsi": {"score": 3, "max": 25, "reason": "RSI中性(45.0)"},
                "kdj": {"score": 0, "max": 15, "reason": "KDJ(J=55.0)"},
                "volume": {"score": 0, "max": 10, "reason": "缩量"},
                "macd": {"score": 0, "max": 5, "reason": "MACD偏空"},
                "boll": {"score": 0, "max": 12, "reason": "布林%B=0.50"},
            },
        },
    ]

    sell_cases = [
        {
            "name": "sell_desc_has_stopline",
            "sell_score": 45,
            "sell_grade": "建议减仓",
            "sell_score_details": {
                "rsi_ob": {"score": 5, "max": 15, "reason": "RSI超买(72.0)"},
                "macd_death": {"score": 8, "max": 18, "reason": "MACD空头"},
                "break_ma20": {"score": 5, "max": 12, "reason": "略低于MA20"},
                "kdj_sell": {"score": 6, "max": 12, "reason": "KDJ死叉(J=82.0)"},
                "boll_sell": {"score": 0, "max": 8, "reason": "布林%B=0.70"},
                "divergence": {"score": 0, "max": 10, "reason": "无背离"},
                "stop_loss": {"score": 10, "max": 10, "reason": "止损线=95.00"},
            },
        },
    ]

    out = []

    for c in cases:
        err = []
        try:
            desc = api._build_buy_condition_desc(
                buy_score=c["buy_score"],
                buy_grade=c["buy_grade"],
                buy_score_details=c["buy_score_details"],
            )
            if not (isinstance(desc, str) and desc.strip()):
                err.append("buy_condition_desc missing")
            else:
                grade = c["buy_grade"]
                if grade not in desc:
                    err.append(f"grade '{grade}' not in desc")
                score_str = f"综合评分{c['buy_score']}分"
                if score_str not in desc:
                    err.append(f"score string '{score_str}' not in desc")
        except Exception as e:
            err.append(str(e))
        out.append({"case": c["name"], "ok": len(err) == 0, "errors": err})

    for c in sell_cases:
        err = []
        try:
            desc = api._build_sell_condition_desc(
                sell_score=c["sell_score"],
                sell_grade=c["sell_grade"],
                sell_score_details=c["sell_score_details"],
            )
            if not (isinstance(desc, str) and desc.strip()):
                err.append("sell_condition_desc missing")
            else:
                grade = c["sell_grade"]
                if grade not in desc:
                    err.append(f"grade '{grade}' not in desc")
                score_str = f"综合评分{c['sell_score']}分"
                if score_str not in desc:
                    err.append(f"score string '{score_str}' not in desc")
                if "止损线=95.00" not in desc:
                    err.append("stop_line info not embedded in desc")
        except Exception as e:
            err.append(str(e))
        out.append({"case": c["name"], "ok": len(err) == 0, "errors": err})

    print(json.dumps(out, ensure_ascii=False, indent=2))
    bad = [x for x in out if not x.get("ok")]
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(_main())
