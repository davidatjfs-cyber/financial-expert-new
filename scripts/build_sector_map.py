"""
Build stock_code -> sector_name mapping for HS300 stocks.
Run this on a machine that can access eastmoney APIs.
Output: core/hs300_sector_map.json
"""
import json
import sys
import os
import time
import warnings

warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Disable proxies
for k in list(os.environ.keys()):
    if "proxy" in k.lower():
        del os.environ[k]


def main():
    import akshare as ak

    print("Getting HS300 stocks...")
    df = ak.index_stock_cons_csindex(symbol="000300")
    stocks = []
    for _, row in df.iterrows():
        code = str(row.get("成分券代码", row.get("品种代码", ""))).strip()
        name = str(row.get("成分券名称", row.get("品种名称", ""))).strip()
        if code and name:
            stocks.append({"code": code, "name": name})

    print(f"Got {len(stocks)} stocks, fetching sectors...")

    sector_map = {}
    for i, stock in enumerate(stocks):
        code = stock["code"]
        try:
            info = ak.stock_individual_info_em(symbol=code)
            sector = ""
            for _, row in info.iterrows():
                if str(row.iloc[0]).strip() == "行业":
                    sector = str(row.iloc[1]).strip()
                    sector = sector.replace("Ⅱ", "").replace("Ⅲ", "").replace("—", "").strip()
                    break
            sector_map[code] = sector
            print(f"  [{i+1}/{len(stocks)}] {code} {stock['name']} => {sector}")
        except Exception as e:
            sector_map[code] = ""
            print(f"  [{i+1}/{len(stocks)}] {code} {stock['name']} => FAIL ({type(e).__name__})")
        time.sleep(0.3)

    output_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "core", "hs300_sector_map.json",
    )
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(sector_map, f, ensure_ascii=False, indent=2)

    mapped = sum(1 for v in sector_map.values() if v)
    print(f"\nDone! {mapped}/{len(sector_map)} stocks mapped to sectors")
    print(f"Saved to {output_path}")


if __name__ == "__main__":
    main()