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
            "last_close": 30.0,
            "ma20": 30.0,
            "ma60": 28.0,
            "slope_pct": 0.12,
            "rsi14": 36.1,
            "rsi_rebound": True,
            "rsi_b2": 35.2,
            "rsi_y": 33.8,
            "rsi_t": 36.1,
            "aggressive_ok": True,
        },
        {
            "name": "buy_ok_false",
            "last_close": 27.0,
            "ma20": 30.0,
            "ma60": 28.0,
            "slope_pct": -0.10,
            "rsi14": 45.0,
            "rsi_rebound": False,
            "rsi_b2": 41.0,
            "rsi_y": 42.0,
            "rsi_t": 40.0,
            "aggressive_ok": False,
        },
    ]

    sell_cases = [
        {
            "name": "sell_desc_has_stopline",
            "last_close": 100.0,
            "ma20": 98.0,
            "atr14": 2.5,
            "rsi14": 72.0,
            "prev_max_close": 101.0,
            "prev_max_rsi": 78.0,
        }
    ]

    out = []

    for c in cases:
        err = []
        try:
            desc = api._build_buy_condition_desc(
                last_close=c["last_close"],
                ma20_now=c["ma20"],
                ma60_now=c["ma60"],
                slope_pct=c["slope_pct"],
                rsi14=c["rsi14"],
                rsi_rebound=c["rsi_rebound"],
                rsi_before_yesterday_v=c["rsi_b2"],
                rsi_yesterday_v=c["rsi_y"],
                rsi_today_v=c["rsi_t"],
                aggressive_ok=c["aggressive_ok"],
                tol=0.02,
            )
            if not (isinstance(desc, str) and desc.strip()):
                err.append("buy_condition_desc missing")
            else:
                low_p = float(c["ma20"]) * (1.0 - 0.02)
                high_p = float(c["ma20"]) * (1.0 + 0.02)
                if f"{low_p:.2f}~{high_p:.2f}" not in desc:
                    err.append("ma20 tolerance range not embedded")
                if c["aggressive_ok"] is True and "可以买入" not in desc:
                    err.append("should contain 买可以入")
                if c["aggressive_ok"] is False and "暂不满足" not in desc:
                    err.append("should contain 暂不满足")
        except Exception as e:
            err.append(str(e))
        out.append({"case": c["name"], "ok": len(err) == 0, "errors": err})

    for c in sell_cases:
        err = []
        try:
            desc = api._build_sell_condition_desc(
                last_close=c["last_close"],
                ma20_now=c["ma20"],
                atr14=c["atr14"],
                rsi14=c["rsi14"],
                prev_max_close=c["prev_max_close"],
                prev_max_rsi=c["prev_max_rsi"],
            )
            if not (isinstance(desc, str) and desc.strip()):
                err.append("sell_condition_desc missing")
            else:
                stop_line = float(c["last_close"]) - 2.0 * float(c["atr14"])
                if f"{stop_line:.2f}" not in desc:
                    err.append("stop_line not embedded")
        except Exception as e:
            err.append(str(e))
        out.append({"case": c["name"], "ok": len(err) == 0, "errors": err})

    print(json.dumps(out, ensure_ascii=False, indent=2))
    bad = [x for x in out if not x.get("ok")]
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(_main())
