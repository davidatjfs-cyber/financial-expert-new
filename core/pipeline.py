from __future__ import annotations

import json
import re
import time
import uuid

import pandas as pd
from sqlalchemy import delete, select

from core.a_share import fetch_a_share_financials, row_payload
from core.analysis import STANDARD_ITEM_NAMES, dumps, risk_p0, compute_p0_metrics
from core.db import session_scope
from core.models import Alert, ComputedMetric, Report, Statement, StatementItem
from core.net import disable_proxies_for_process
from core.stock_search import normalize_symbol
from core.repository import upsert_company


PROFIT_MAP = {
    "IS.REVENUE": ("OPERATE_INCOME", "营业收入"),
    "IS.COGS": ("OPERATE_COST", "营业成本"),
    "IS.NET_PROFIT": ("PARENT_NETPROFIT", "净利润"),
    "IS.SELLING_EXP": ("SALE_EXPENSE", "销售费用"),
    "IS.GA_EXP": ("MANAGE_EXPENSE", "管理费用"),
    "IS.FIN_EXP": ("FINANCE_EXPENSE", "财务费用"),
    "BS.DEBT_INTEREST": (None, "有息负债"),
}

BALANCE_MAP = {
    "BS.CASH": ("MONETARYFUNDS", "货币资金"),
    "BS.AR": ("ACCOUNTS_RECE", "应收账款"),
    "BS.INVENTORY": ("INVENTORY", "存货"),
    "BS.CA_TOTAL": ("TOTAL_CURRENT_ASSETS", "流动资产合计"),
    "BS.CL_TOTAL": ("TOTAL_CURRENT_LIAB", "流动负债合计"),
    "BS.ASSET_TOTAL": ("TOTAL_ASSETS", "资产总计"),
    "BS.LIAB_TOTAL": ("TOTAL_LIABILITIES", "负债合计"),
    "BS.EQUITY_TOTAL": ("TOTAL_PARENT_EQUITY", "所有者权益合计"),
}

CASH_MAP = {
    "CF.CFO": ("NETCASH_OPERATE", "经营活动现金流净额"),
}


def _period_end_from_row(row: pd.Series) -> str:
    dt = row.get("REPORT_DATE")
    if isinstance(dt, pd.Timestamp):
        return dt.date().isoformat()
    return str(dt)[:10]


def _safe_float(v) -> float | None:
    try:
        if v is None:
            return None
        if pd.isna(v):
            return None
        return float(v)
    except Exception:
        return None


def _to_iso_period_end(v) -> str | None:
    try:
        dt = pd.to_datetime(v, errors="coerce")
        if dt is None or pd.isna(dt):
            return None
        return dt.date().isoformat()
    except Exception:
        return None


def _collect_periods_from_df(df: pd.DataFrame | None) -> list[str]:
    out: list[str] = []
    try:
        if df is None or df.empty:
            return out
        date_col = None
        for c in ("STD_REPORT_DATE", "REPORT_DATE", "报告期"):
            if c in df.columns:
                date_col = c
                break
        if not date_col:
            return out
        for v in df[date_col].tolist():
            pe = _to_iso_period_end(v)
            if pe:
                out.append(pe)
    except Exception:
        return out
    return out


def _pick_effective_period(target_period: str | None, periods: list[str]) -> str | None:
    if not periods:
        return target_period
    parsed: list[pd.Timestamp] = []
    for p in periods:
        dt = pd.to_datetime(p, errors="coerce")
        if dt is not None and not pd.isna(dt):
            parsed.append(dt)
    if not parsed:
        return target_period
    parsed = sorted(set(parsed))
    target_dt = pd.to_datetime(target_period, errors="coerce") if target_period else None
    if target_dt is not None and not pd.isna(target_dt):
        le = [d for d in parsed if d <= target_dt]
        if le:
            return le[-1].date().isoformat()
        parsed.sort(key=lambda d: abs((d - target_dt).days))
        return parsed[0].date().isoformat()
    return parsed[-1].date().isoformat()


def delete_report_children_full(report_id: str) -> None:
    with session_scope() as s:
        s.execute(delete(Alert).where(Alert.report_id == report_id))
        s.execute(delete(ComputedMetric).where(ComputedMetric.report_id == report_id))
        s.execute(delete(StatementItem).where(StatementItem.report_id == report_id))
        s.execute(delete(Statement).where(Statement.report_id == report_id))


def ingest_and_analyze_market_fetch(report_id: str) -> None:
    disable_proxies_for_process()
    with session_scope() as s:
        r = s.get(Report, report_id)
        if not r:
            raise ValueError("report not found")
        if r.source_type != "market_fetch":
            raise ValueError("unsupported source_type")
        if not r.company_id:
            raise ValueError("market_fetch report missing company_id")

        market = (r.market or "CN").strip().upper()
        r.status = "running"
        r.error_message = None
        r.updated_at = int(time.time())

    if market == "CN":
        ingest_and_analyze_a_share(report_id)
        return

    _ingest_and_analyze_non_cn_akshare(report_id)


def _ingest_and_analyze_non_cn_akshare(report_id: str) -> None:
    """HK/US market_fetch (AkShare).

    Persist computed metrics only (no statements).
    Avoid yfinance (unreliable in deployment) and avoid CN-only AkShare statements.
    """
    disable_proxies_for_process()
    with session_scope() as s:
        r = s.get(Report, report_id)
        if not r:
            raise ValueError("report not found")
        if not r.company_id:
            raise ValueError("report missing company_id")

        market = (r.market or "").strip().upper()
        company_id = r.company_id
        period_type = r.period_type
        period_end = r.period_end

        symbol = company_id.split(":", 1)[1]
        symbol = normalize_symbol(market, symbol)

    delete_report_children_full(report_id)

    import akshare as ak

    def _num(v):
        try:
            if v is None:
                return None
            sv = str(v).strip()
            if sv in ("", "--", "nan", "None"):
                return None
            if pd.isna(v):
                return None
            return float(v)
        except Exception:
            return None

    def _to_num(v):
        try:
            if v is None:
                return None
            if pd.isna(v):
                return None
            if isinstance(v, (int, float)):
                return float(v)

            sv = str(v).strip()
            if sv in ("", "--", "nan", "None"):
                return None

            neg = False
            if sv.startswith("(") and sv.endswith(")"):
                neg = True
                sv = sv[1:-1].strip()

            # Handle common percent formatting
            if sv.endswith("%"):
                sv = sv[:-1].strip()

            # Handle Chinese unit suffixes
            mult = 1.0
            if "亿" in sv:
                mult = 1e8
                sv = sv.replace("亿", "")
            elif "万" in sv:
                mult = 1e4
                sv = sv.replace("万", "")

            # Remove thousands separators and any stray non-numeric characters
            sv = sv.replace(",", "").replace("，", "").strip()
            sv = re.sub(r"[^0-9eE.\-+]", "", sv)
            if sv in ("", "+", "-", "."):
                return None

            out = float(sv) * mult
            if neg:
                out = -out
            return out
        except Exception:
            return None

    def _pick_from_df(
        df: pd.DataFrame | None,
        keywords: list[str],
        *,
        value_col_candidates: list[str] | None = None,
        target_period: str | None = None,
        prefer_nearest: bool = False,
    ) -> float | None:
        try:
            if df is None or df.empty:
                return None
            item_col = None
            for c in ("STD_ITEM_NAME", "ITEM_NAME", "项目名称", "项目", "ITEM"):
                if c in df.columns:
                    item_col = c
                    break
            if not item_col:
                return None
            value_col = None
            for c in (value_col_candidates or ["AMOUNT", "金额", "VALUE", "value"]):
                if c in df.columns:
                    value_col = c
                    break
            date_col = None
            for c in ("STD_REPORT_DATE", "REPORT_DATE", "报告期"):
                if c in df.columns:
                    date_col = c
                    break
            df2 = df
            if date_col:
                try:
                    dt_series = pd.to_datetime(df2[date_col], errors="coerce")
                    chosen_date = None
                    target_dt = pd.to_datetime(target_period, errors="coerce") if target_period else None
                    if target_dt is not None and not pd.isna(target_dt):
                        if prefer_nearest:
                            valid = dt_series.dropna()
                            if not valid.empty:
                                deltas = (valid - target_dt).abs()
                                chosen_date = valid.loc[deltas.idxmin()]
                        else:
                            same_year = dt_series[dt_series.dt.year == target_dt.year]
                            if not same_year.empty:
                                chosen_date = same_year.max()
                            else:
                                le = dt_series[dt_series <= target_dt]
                                if not le.empty:
                                    chosen_date = le.max()
                    if chosen_date is None or pd.isna(chosen_date):
                        chosen_date = dt_series.max()
                    if chosen_date is not None and not pd.isna(chosen_date):
                        df2 = df2[dt_series == chosen_date]
                except Exception:
                    pass

            if not value_col:
                date_like_cols: list[tuple[pd.Timestamp, str]] = []
                for c in df2.columns:
                    if c == item_col:
                        continue
                    if isinstance(c, pd.Timestamp):
                        date_like_cols.append((c, c))
                        continue
                    sc = str(c)
                    if not re.search(r"\d{4}", sc):
                        continue
                    if "-" not in sc and "/" not in sc:
                        continue
                    dt = pd.to_datetime(sc, errors="coerce")
                    if dt is None or pd.isna(dt):
                        continue
                    date_like_cols.append((dt, c))
                if date_like_cols:
                    date_like_cols.sort(key=lambda x: x[0])
                    value_col = date_like_cols[-1][1]
            if not value_col:
                return None

            for kw in keywords:
                hit = df2[df2[item_col].astype(str).str.contains(kw, na=False)]
                if not hit.empty:
                    return _to_num(hit.iloc[0].get(value_col))
            return None
        except Exception:
            return None

    def _ingest_items(*, statement_type: str, period_end: str, items: dict[str, float | None], currency: str | None = None):
        with session_scope() as s:
            st_obj = Statement(
                id=str(uuid.uuid4()),
                report_id=report_id,
                company_id=company_id,
                statement_type=statement_type,
                period_end=period_end,
                period_type=period_type,
                source="akshare",
                raw_payload=dumps({"items": items, "currency": currency}),
                created_at=int(time.time()),
            )
            s.add(st_obj)
            for code, v in items.items():
                s.add(
                    StatementItem(
                        id=str(uuid.uuid4()),
                        statement_id=st_obj.id,
                        report_id=report_id,
                        company_id=company_id,
                        statement_type=statement_type,
                        period_end=period_end,
                        period_type=period_type,
                        standard_item_code=code,
                        standard_item_name=STANDARD_ITEM_NAMES.get(code, code),
                        value=v,
                        currency=currency,
                        original_item_name=None,
                        mapping_confidence=None,
                    )
                )

    def _row_values_by_period(df: pd.DataFrame | None, row_labels: list[str]) -> dict[str, float]:
        out: dict[str, float] = {}
        try:
            if df is None or df.empty:
                return out
            idx_map = {str(i).strip().lower(): i for i in df.index}
            row_key = None
            for n in row_labels:
                key = n.lower()
                if key in idx_map:
                    row_key = idx_map[key]
                    break
            if row_key is None:
                # fuzzy contains fallback (Yahoo labels can vary)
                for raw in df.index:
                    low = str(raw).strip().lower()
                    for n in row_labels:
                        if n.lower() in low:
                            row_key = raw
                            break
                    if row_key is not None:
                        break
            if row_key is None:
                return out

            ser = df.loc[row_key]
            for col, v in ser.items():
                fv = _to_num(v)
                if fv is None:
                    continue
                try:
                    pe = pd.to_datetime(col).date().isoformat()
                except Exception:
                    pe = str(col)[:10]
                out[pe] = float(fv)
            return out
        except Exception:
            return out

    def _pick_period_value_for_report_period(
        period_values: dict[str, float],
        target_period: str | None,
        *,
        prefer_nearest: bool = False,
    ) -> tuple[str | None, float | None]:
        try:
            if not period_values:
                return (None, None)
            if target_period and target_period in period_values:
                return (target_period, period_values[target_period])

            parsed: list[tuple[pd.Timestamp, str, float]] = []
            for k, v in period_values.items():
                try:
                    dt = pd.to_datetime(k, errors="coerce")
                    if dt is None or pd.isna(dt):
                        continue
                    parsed.append((dt, k, float(v)))
                except Exception:
                    continue

            if not parsed:
                k0 = next(iter(period_values.keys()))
                return (k0, period_values[k0])

            parsed.sort(key=lambda x: x[0])
            target_dt = pd.to_datetime(target_period, errors="coerce") if target_period else None
            if target_dt is not None and not pd.isna(target_dt):
                if prefer_nearest:
                    parsed.sort(key=lambda x: abs((x[0] - target_dt).days))
                    return (parsed[0][1], parsed[0][2])
                same_year = [(d, v) for d, _, v in parsed if d.year == target_dt.year]
                if same_year:
                    same_year.sort(key=lambda x: x[0])
                    best = same_year[-1]
                    for d, raw, v in parsed:
                        if d == best[0] and v == best[1]:
                            return (raw, v)
                le = [(d, raw, v) for d, raw, v in parsed if d <= target_dt]
                if le:
                    le.sort(key=lambda x: x[0])
                    return (le[-1][1], le[-1][2])

            return (parsed[-1][1], parsed[-1][2])
        except Exception:
            return (None, None)

    def _pick_for_report_period(
        period_values: dict[str, float],
        target_period: str | None,
        *,
        prefer_nearest: bool = False,
    ) -> float | None:
        _, value = _pick_period_value_for_report_period(
            period_values,
            target_period,
            prefer_nearest=prefer_nearest,
        )
        return value

    yf_revenue = None
    yf_cfo = None
    yf_revenue_map: dict[str, float] = {}
    yf_cfo_map: dict[str, float] = {}
    resolved_period_end = period_end
    if market in ("HK", "US"):
        try:
            import yfinance as yf

            symbol_up = symbol.upper()
            if market == "HK":
                base = symbol_up.split(".", 1)[0].zfill(5)
                yf_symbol = f"{base}.HK"
            else:
                yf_symbol = symbol_up.split(".", 1)[0]

            tk = yf.Ticker(yf_symbol)
            income_df = None
            cashflow_df = None
            try:
                income_df = tk.financials
            except Exception:
                income_df = None
            try:
                cashflow_df = tk.cashflow
            except Exception:
                cashflow_df = None

            yf_revenue_map = _row_values_by_period(income_df, ["Total Revenue", "Revenue", "Operating Revenue"])
            yf_cfo_map = _row_values_by_period(cashflow_df, ["Operating Cash Flow", "Cash Flow From Continuing Operating Activities"])
            yf_revenue = _pick_for_report_period(
                yf_revenue_map,
                period_end,
                prefer_nearest=True,
            )
            yf_cfo = _pick_for_report_period(
                yf_cfo_map,
                period_end,
                prefer_nearest=True,
            )
        except Exception:
            yf_revenue = None
            yf_cfo = None

    if market == "HK":
        code = symbol.replace(".HK", "")
        code = code.zfill(5)
        ind_df = None
        try:
            ind_df = ak.stock_hk_financial_indicator_em(symbol=code)
        except Exception:
            ind_df = None

        revenue = None
        net_profit = None
        net_profit_margin = None
        gross_margin_pct = None
        roe_pct = None
        roa_pct = None
        debt_asset_pct = None
        current_ratio = None
        quick_ratio = None
        try:
            if ind_df is not None and not ind_df.empty:
                row = ind_df.iloc[0]
                net_profit_margin = _to_num(row.get("销售净利率(%)"))
                gross_margin_pct = _to_num(
                    row.get("销售毛利率(%)")
                    or row.get("销售毛利率（%）")
                    or row.get("毛利率(%)")
                    or row.get("毛利率（%）")
                    or row.get("销售毛利率")
                    or row.get("毛利率")
                )
                if gross_margin_pct is None:
                    try:
                        for c in row.index:
                            sc = str(c)
                            sl = sc.lower()
                            if ("毛利率" in sc or ("gross" in sl and "margin" in sl)) and not (
                                "净" in sc or "net" in sl
                            ):
                                v = _to_num(row.get(c))
                                if v is not None:
                                    gross_margin_pct = v
                                    break
                    except Exception:
                        pass
                roe_pct = _to_num(row.get("股东权益回报率(%)"))
                roa_pct = _to_num(row.get("总资产回报率(%)"))
                debt_asset_pct = _to_num(row.get("资产负债率(%)"))
                current_ratio = _to_num(row.get("流动比率"))
                quick_ratio = _to_num(row.get("速动比率"))
                rev = row.get("营业总收入")
                revenue = _to_num(rev)
                npv = row.get("净利润")
                net_profit = _to_num(npv)
        except Exception:
            pass

        profit_df = None
        balance_df = None
        cash_df = None
        primary_indicator = "半年度" if "-06-30" in str(period_end) else "年度"
        secondary_indicator = "年度" if primary_indicator == "半年度" else "半年度"
        try:
            profit_df = ak.stock_financial_hk_report_em(stock=code, symbol="利润表", indicator=primary_indicator)
        except Exception:
            profit_df = None
        try:
            balance_df = ak.stock_financial_hk_report_em(stock=code, symbol="资产负债表", indicator=primary_indicator)
        except Exception:
            balance_df = None
        try:
            cash_df = ak.stock_financial_hk_report_em(stock=code, symbol="现金流量表", indicator=primary_indicator)
        except Exception:
            cash_df = None
        try:
            profit_df2 = ak.stock_financial_hk_report_em(stock=code, symbol="利润表", indicator=secondary_indicator)
            if profit_df is None:
                profit_df = profit_df2
            elif profit_df2 is not None:
                import pandas as _pd
                profit_df = _pd.concat([profit_df, profit_df2], ignore_index=True)
        except Exception:
            pass
        try:
            balance_df2 = ak.stock_financial_hk_report_em(stock=code, symbol="资产负债表", indicator=secondary_indicator)
            if balance_df is None:
                balance_df = balance_df2
            elif balance_df2 is not None:
                import pandas as _pd
                balance_df = _pd.concat([balance_df, balance_df2], ignore_index=True)
        except Exception:
            pass
        try:
            cash_df2 = ak.stock_financial_hk_report_em(stock=code, symbol="现金流量表", indicator=secondary_indicator)
            if cash_df is None:
                cash_df = cash_df2
            elif cash_df2 is not None:
                import pandas as _pd
                cash_df = _pd.concat([cash_df, cash_df2], ignore_index=True)
        except Exception:
            pass

        pe = _pick_effective_period(
            period_end,
            _collect_periods_from_df(profit_df)
            + _collect_periods_from_df(balance_df)
            + _collect_periods_from_df(cash_df)
            + list(yf_revenue_map.keys())
            + list(yf_cfo_map.keys()),
        ) or period_end
        resolved_period_end = pe

        revenue_stmt = _pick_from_df(
            profit_df,
            [
                "营业额",
                "营业收入",
                "营运收入",
                "总收入",
                "收入",
                "收益",
                # English variants
                "Turnover",
                "Revenue",
                "Total revenue",
                "Total revenues",
                "Total income",
                "Net revenue",
            ],
            target_period=pe,
            prefer_nearest=True,
        )
        if revenue_stmt is not None:
            # Prefer statement revenue for HK: indicator table can lag or use mixed-caliber values.
            revenue = revenue_stmt
        yf_revenue = _pick_for_report_period(yf_revenue_map, pe, prefer_nearest=True)
        if yf_revenue is not None:
            revenue = float(yf_revenue)
        net_profit_stmt = _pick_from_df(
            profit_df,
            [
                "股东应占溢利",
                "本公司拥有人应占",
                "净利润",
                "净利",
                "本年溢利",
                # English variants
                "Net profit",
                "Profit for the year",
                "Profit attributable",
            ],
            target_period=pe,
            prefer_nearest=True,
        )
        if net_profit_stmt is not None:
            net_profit = net_profit_stmt

        gross_profit = _pick_from_df(profit_df, ["毛利", "毛利润", "Gross profit"], target_period=pe, prefer_nearest=True)

        # COGS selection for HK is tricky: generic keyword "成本" often matches non-COGS items
        # (e.g., finance cost), resulting in unrealistically high gross margin (97%+).
        cogs = None
        try:
            if revenue is not None and gross_profit is not None:
                rp = float(revenue)
                gp = float(gross_profit)
                if rp > 0 and 0 <= gp <= rp:
                    cogs = rp - gp
        except Exception:
            cogs = None

        if cogs is None:
            # Prefer explicit cost-of-sales / cost-of-revenue keywords.
            cogs = _pick_from_df(
                profit_df,
                [
                    "销售成本",
                    "营业成本",
                    "营运成本",
                    "已售货品成本",
                    "已售货物成本",
                    "已售成本",
                    # English variants
                    "Cost of sales",
                    "Cost of revenue",
                    "Cost of revenues",
                    "Cost of goods sold",
                    "Cost of sales and services",
                ],
            )

        if cogs is None and profit_df is not None and not profit_df.empty and revenue is not None:
            # As a last resort, scan cost-like rows but exclude common non-COGS costs.
            try:
                df_cost = profit_df
                item_col = None
                for c in ("STD_ITEM_NAME", "ITEM_NAME", "项目名称"):
                    if c in df_cost.columns:
                        item_col = c
                        break
                value_col = None
                for c in ("AMOUNT", "金额", "VALUE", "value"):
                    if c in df_cost.columns:
                        value_col = c
                        break
                date_col = None
                for c in ("STD_REPORT_DATE", "REPORT_DATE", "报告期"):
                    if c in df_cost.columns:
                        date_col = c
                        break
                if item_col and value_col:
                    if date_col:
                        try:
                            dt_series = pd.to_datetime(df_cost[date_col], errors="coerce")
                            latest_date = dt_series.max()
                            if latest_date is not None and not pd.isna(latest_date):
                                df_cost = df_cost[dt_series == latest_date]
                        except Exception:
                            pass

                    rp = float(revenue)
                    excludes = [
                        "财务成本",
                        "融资成本",
                        "利息",
                        "税",
                        "所得税",
                        "行政",
                        "分销",
                        "销售及分销",
                        "管理费用",
                        "销售费用",
                        "研发",
                        "折旧",
                        "摊销",
                        "其他费用",
                        # English non-COGS
                        "finance cost",
                        "interest",
                        "tax",
                        "administrative",
                        "selling",
                        "distribution",
                        "marketing",
                        "research",
                        "depreciation",
                        "amortization",
                    ]

                    candidates: list[float] = []
                    for _, rr in df_cost.iterrows():
                        name = str(rr.get(item_col) or "").strip()
                        low = name.lower()
                        is_cost_like = ("成本" in name) or ("cost" in low) or ("cogs" in low)
                        if not is_cost_like:
                            continue
                        if any(x in name for x in excludes):
                            continue
                        if any(x in low for x in excludes):
                            continue
                        try:
                            v = rr.get(value_col)
                            fv = _to_num(v)
                        except Exception:
                            continue
                        if fv is None:
                            continue
                        if fv <= 0:
                            continue
                        # choose values that yield a reasonable gross margin.
                        gm = None
                        try:
                            gm = (rp - fv) / rp * 100.0
                        except Exception:
                            gm = None
                        if gm is not None and 0.0 <= gm <= 80.0:
                            candidates.append(fv)

                    if candidates:
                        # pick the largest plausible COGS among candidates
                        cogs = max(candidates)

            except Exception:
                cogs = None

        # If indicator gross margin is missing or clearly unreasonable, derive from statements.
        try:
            gm_ok = gross_margin_pct is not None and 0.0 <= float(gross_margin_pct) <= 80.0
        except Exception:
            gm_ok = False
        if not gm_ok:
            try:
                rp = float(revenue) if revenue is not None else None
                gp = float(gross_profit) if gross_profit is not None else None
                cg = float(cogs) if cogs is not None else None
                derived = None
                if rp is not None and rp > 0:
                    if gp is not None and 0 <= gp <= rp:
                        derived = gp / rp * 100.0
                    elif cg is not None and 0 <= cg <= rp:
                        derived = (rp - cg) / rp * 100.0
                if derived is not None and 0.0 <= derived <= 80.0:
                    gross_margin_pct = derived
            except Exception:
                pass

        def _hk_amount_map(
            df: pd.DataFrame | None,
            keywords: list[str],
            *,
            excludes: list[str] | None = None,
        ) -> dict[str, float]:
            out: dict[str, float] = {}
            if df is None or df.empty:
                return out
            date_col = "REPORT_DATE" if "REPORT_DATE" in df.columns else ("STD_REPORT_DATE" if "STD_REPORT_DATE" in df.columns else None)
            item_col = "STD_ITEM_NAME" if "STD_ITEM_NAME" in df.columns else ("ITEM_NAME" if "ITEM_NAME" in df.columns else None)
            val_col = "AMOUNT" if "AMOUNT" in df.columns else ("金额" if "金额" in df.columns else None)
            if not item_col or not val_col:
                return out
            excludes = excludes or []
            for _, rr in df.iterrows():
                nm = str(rr.get(item_col) or "")
                low = nm.lower()
                if not any((k in nm) or (k.lower() in low) for k in keywords):
                    continue
                if any((x in nm) or (x.lower() in low) for x in excludes):
                    continue
                v = rr.get(val_col)
                if v is None or str(v) in ("", "--", "nan", "None"):
                    continue
                try:
                    p = pe
                    if date_col:
                        p = pd.to_datetime(rr.get(date_col)).date().isoformat()
                    fv = float(v)
                    old = out.get(p)
                    if old is None or abs(fv) > abs(float(old)):
                        out[p] = fv
                except Exception:
                    continue
            return out

        ta_map = _hk_amount_map(balance_df, ["总资产", "资产总计", "资产总值", "资产合计", "Total Assets"], excludes=["总资产减流动负债"])
        tl_map = _hk_amount_map(balance_df, ["总负债", "负债总额", "负债合计", "Total Liabilities"], excludes=["流动负债", "非流动负债", "总权益及总负债"])
        te_map = _hk_amount_map(
            balance_df,
            ["总权益", "净资产", "股东权益", "权益总额", "权益总计", "股东权益合计", "股东应占权益", "Total Equity"],
            excludes=["少数", "总权益及", "总权益及总负债", "总权益及非流动负债"],
        )

        total_assets = ta_map.get(pe)
        total_liab = tl_map.get(pe)
        total_equity = te_map.get(pe)

        try:
            if total_assets is not None and total_liab is not None:
                derived_equity = float(total_assets) - float(total_liab)
                if derived_equity > 0:
                    if total_equity is None or total_equity <= 0:
                        total_equity = derived_equity
                    else:
                        denom = derived_equity if derived_equity != 0 else None
                        if denom is not None:
                            rel_diff = abs(float(total_equity) - derived_equity) / abs(denom)
                            if rel_diff >= 0.5 or float(total_equity) < derived_equity * 0.05:
                                total_equity = derived_equity
        except Exception:
            pass

        try:
            if revenue not in (None, 0) and net_profit is not None:
                net_profit_margin = float(net_profit) / float(revenue) * 100.0

            prev_asset_candidates = sorted([k for k in ta_map.keys() if k < pe])
            prev_equity_candidates = sorted([k for k in te_map.keys() if k < pe])
            avg_assets = float(total_assets) if total_assets is not None else None
            avg_equity = float(total_equity) if total_equity is not None else None

            if avg_assets is not None and prev_asset_candidates:
                prev_assets = ta_map.get(prev_asset_candidates[-1])
                if prev_assets not in (None, 0):
                    avg_assets = (avg_assets + float(prev_assets)) / 2.0
            if avg_equity is not None and prev_equity_candidates:
                prev_equity = te_map.get(prev_equity_candidates[-1])
                if prev_equity not in (None, 0):
                    avg_equity = (avg_equity + float(prev_equity)) / 2.0

            if net_profit is not None and avg_equity not in (None, 0):
                roe_pct = float(net_profit) / float(avg_equity) * 100.0
            if net_profit is not None and avg_assets not in (None, 0):
                roa_pct = float(net_profit) / float(avg_assets) * 100.0
        except Exception:
            pass
        ca_total = _pick_from_df(balance_df, ["流动资产总值", "流动资产合计", "流动资产"], target_period=pe)
        cl_total = _pick_from_df(balance_df, ["流动负债总额", "流动负债合计", "流动负债"], target_period=pe)
        inventory = _pick_from_df(balance_df, ["存货"], target_period=pe)
        ar = _pick_from_df(balance_df, ["应收账款", "应收账项"], target_period=pe)
        cash = _pick_from_df(balance_df, ["现金", "货币资金", "现金及现金等价物", "银行结余"], target_period=pe)

        cfo = _pick_from_df(
            cash_df,
            ["经营活动现金流量净额", "经营活动现金流净额", "经营活动现金净额", "经营业务现金净额"],
            target_period=pe,
            prefer_nearest=True,
        )
        yf_cfo = _pick_for_report_period(yf_cfo_map, pe, prefer_nearest=True)
        if yf_cfo is not None:
            cfo = float(yf_cfo)

        _ingest_items(statement_type="is", period_end=pe, items={
            "IS.REVENUE": revenue,
            "IS.COGS": cogs,
            "IS.NET_PROFIT": net_profit,
        })
        _ingest_items(statement_type="bs", period_end=pe, items={
            "BS.CASH": cash,
            "BS.AR": ar,
            "BS.INVENTORY": inventory,
            "BS.CA_TOTAL": ca_total,
            "BS.CL_TOTAL": cl_total,
            "BS.ASSET_TOTAL": total_assets,
            "BS.LIAB_TOTAL": total_liab,
            "BS.EQUITY_TOTAL": total_equity,
        })
        _ingest_items(statement_type="cf", period_end=pe, items={
            "CF.CFO": cfo,
        })

        _compute_metrics_and_alerts(report_id, company_id, focus_period_end=pe, period_type=period_type)

        # Override key ratios using indicator table (more reliable than inferred revenue/cogs)
        def _reasonable_pct(v: float | None) -> float | None:
            try:
                if v is None:
                    return None
                fv = float(v)
                if -50.0 <= fv <= 100.0:
                    return fv
                return None
            except Exception:
                return None

        def _reasonable_gross_margin_hk(v: float | None) -> float | None:
            try:
                if v is None:
                    return None
                fv = float(v)
                # HK gross margin above ~80% is almost always a data quality issue (seen in some sources).
                if 0.0 <= fv <= 80.0:
                    return fv
                return None
            except Exception:
                return None

        def _reasonable_times(v: float | None) -> float | None:
            try:
                if v is None:
                    return None
                fv = float(v)
                if 0.0 <= fv <= 50.0:
                    return fv
                return None
            except Exception:
                return None

        overrides: list[tuple[str, str, float | None, str | None]] = [
            ("GROSS_MARGIN", "毛利率", _reasonable_gross_margin_hk(gross_margin_pct), "%"),
            ("NET_MARGIN", "净利率", _reasonable_pct(net_profit_margin), "%"),
            ("ROE", "ROE", _reasonable_pct(roe_pct), "%"),
            ("ROA", "ROA", _reasonable_pct(roa_pct), "%"),
            ("DEBT_ASSET", "资产负债率", _reasonable_pct(debt_asset_pct), "%"),
            ("CURRENT_RATIO", "流动比率", _reasonable_times(current_ratio), "times"),
            ("QUICK_RATIO", "速动比率", _reasonable_times(quick_ratio), "times"),
        ]

        with session_scope() as s:
            for code2, name2, val2, unit2 in overrides:
                if val2 is None:
                    continue
                s.execute(
                    delete(ComputedMetric).where(
                        ComputedMetric.report_id == report_id,
                        ComputedMetric.period_end == pe,
                        ComputedMetric.metric_code == code2,
                    )
                )
                s.add(
                    ComputedMetric(
                        id=str(uuid.uuid4()),
                        report_id=report_id,
                        company_id=company_id,
                        period_end=pe,
                        period_type=period_type,
                        metric_code=code2,
                        metric_name=name2,
                        value=float(val2),
                        unit=unit2,
                        created_at=int(time.time()),
                    )
                )

    elif market == "US":
        base = symbol.split(".", 1)[0]
        ind_df = None
        try:
            ind_df = ak.stock_financial_us_analysis_indicator_em(symbol=base, indicator="年报")
        except Exception:
            ind_df = None

        revenue = None
        cogs = None
        net_profit = None
        total_assets = None
        total_liab = None
        total_equity = None
        ca_total = None
        cl_total = None
        cash = None
        cfo = None

        gross_margin_pct = None
        net_margin_pct = None
        roe_pct = None
        roa_pct = None
        debt_asset_pct = None
        current_ratio = None
        quick_ratio = None

        try:
            if ind_df is not None and not ind_df.empty:
                row = ind_df.iloc[0]
                revenue = _to_num(row.get("OPERATE_INCOME") or row.get("REVENUE"))
                net_profit = _to_num(row.get("NET_PROFIT") or row.get("NET_PROFIT") or row.get("NET_PROFIT"))
                total_assets = _to_num(row.get("TOTAL_ASSETS"))
                total_liab = _to_num(row.get("TOTAL_LIABILITIES"))

                gross_margin_pct = _to_num(row.get("GROSS_PROFIT_RATIO"))
                net_margin_pct = _to_num(row.get("NET_PROFIT_RATIO"))
                roe_pct = _to_num(row.get("ROE_AVG"))
                roa_pct = _to_num(row.get("ROA"))
                debt_asset_pct = _to_num(row.get("DEBT_ASSET_RATIO"))
                current_ratio = _to_num(row.get("CURRENT_RATIO"))
                quick_ratio = _to_num(row.get("SPEED_RATIO"))
        except Exception:
            pass

        income_df = None
        balance_df = None
        cash_df = None
        try:
            income_df = ak.stock_financial_us_report_em(stock=base, symbol="综合损益表", indicator="年报")
        except Exception:
            income_df = None
        try:
            balance_df = ak.stock_financial_us_report_em(stock=base, symbol="资产负债表", indicator="年报")
        except Exception:
            balance_df = None
        try:
            cash_df = ak.stock_financial_us_report_em(stock=base, symbol="现金流量表", indicator="年报")
        except Exception:
            cash_df = None

        pe = _pick_effective_period(
            period_end,
            _collect_periods_from_df(ind_df)
            + _collect_periods_from_df(income_df)
            + _collect_periods_from_df(balance_df)
            + _collect_periods_from_df(cash_df)
            + list(yf_revenue_map.keys())
            + list(yf_cfo_map.keys()),
        ) or period_end
        resolved_period_end = pe

        try:
            if ind_df is not None and not ind_df.empty:
                date_col = "REPORT_DATE" if "REPORT_DATE" in ind_df.columns else ("STD_REPORT_DATE" if "STD_REPORT_DATE" in ind_df.columns else None)
                row = ind_df.iloc[0]
                if date_col:
                    try:
                        ts = pd.to_datetime(ind_df[date_col], errors="coerce")
                        if pe:
                            pe_ts = pd.to_datetime(pe, errors="coerce")
                            le = ts[ts <= pe_ts]
                            if not le.empty:
                                row = ind_df.loc[le.idxmax()]
                        elif not ts.dropna().empty:
                            row = ind_df.loc[ts.idxmax()]
                    except Exception:
                        row = ind_df.iloc[0]
                revenue = _to_num(row.get("OPERATE_INCOME") or row.get("REVENUE"))
                net_profit = _to_num(row.get("NET_PROFIT") or row.get("NET_PROFIT") or row.get("NET_PROFIT"))
                total_assets = _to_num(row.get("TOTAL_ASSETS"))
                total_liab = _to_num(row.get("TOTAL_LIABILITIES"))

                gross_margin_pct = _to_num(row.get("GROSS_PROFIT_RATIO"))
                net_margin_pct = _to_num(row.get("NET_PROFIT_RATIO"))
                roe_pct = _to_num(row.get("ROE_AVG"))
                roa_pct = _to_num(row.get("ROA"))
                debt_asset_pct = _to_num(row.get("DEBT_ASSET_RATIO"))
                current_ratio = _to_num(row.get("CURRENT_RATIO"))
                quick_ratio = _to_num(row.get("SPEED_RATIO"))
        except Exception:
            pass

        revenue_stmt = _pick_from_df(income_df, ["营业收入", "营业总收入", "主营收入", "收入", "总收入", "Revenue", "Total revenue"], target_period=pe, prefer_nearest=True)
        cfo_stmt = _pick_from_df(cash_df, ["经营活动产生的现金流量净额", "经营活动现金流量净额", "经营现金流量净额", "Operating Cash Flow", "Cash Flow From Continuing Operating Activities"], target_period=pe, prefer_nearest=True)
        assets_stmt = _pick_from_df(balance_df, ["总资产", "资产总计", "Total Assets"], target_period=pe, prefer_nearest=True)
        liab_stmt = _pick_from_df(balance_df, ["负债合计", "总负债", "Total Liabilities"], target_period=pe, prefer_nearest=True)
        equity_stmt = _pick_from_df(balance_df, ["股东权益", "权益合计", "净资产", "Total Equity", "Stockholders Equity"], target_period=pe, prefer_nearest=True)
        ca_stmt = _pick_from_df(balance_df, ["流动资产合计", "Current Assets"], target_period=pe, prefer_nearest=True)
        cl_stmt = _pick_from_df(balance_df, ["流动负债合计", "Current Liabilities"], target_period=pe, prefer_nearest=True)
        cash_stmt = _pick_from_df(balance_df, ["货币资金", "现金及现金等价物", "Cash And Cash Equivalents", "Cash"], target_period=pe, prefer_nearest=True)

        if revenue_stmt is not None:
            revenue = revenue_stmt
        if cfo_stmt is not None:
            cfo = cfo_stmt
        if total_assets is None and assets_stmt is not None:
            total_assets = assets_stmt
        if total_liab is None and liab_stmt is not None:
            total_liab = liab_stmt
        if total_equity is None and equity_stmt is not None:
            total_equity = equity_stmt
        if ca_total is None and ca_stmt is not None:
            ca_total = ca_stmt
        if cl_total is None and cl_stmt is not None:
            cl_total = cl_stmt
        if cash is None and cash_stmt is not None:
            cash = cash_stmt

        yf_revenue = _pick_for_report_period(yf_revenue_map, pe, prefer_nearest=True)
        if yf_revenue is not None:
            revenue = float(yf_revenue)
        yf_cfo = _pick_for_report_period(yf_cfo_map, pe, prefer_nearest=True)
        if yf_cfo is not None:
            cfo = float(yf_cfo)

        _ingest_items(statement_type="is", period_end=pe, items={
            "IS.REVENUE": revenue,
            "IS.COGS": cogs,
            "IS.NET_PROFIT": net_profit,
        })
        _ingest_items(statement_type="bs", period_end=pe, items={
            "BS.CASH": cash,
            "BS.CA_TOTAL": ca_total,
            "BS.CL_TOTAL": cl_total,
            "BS.ASSET_TOTAL": total_assets,
            "BS.LIAB_TOTAL": total_liab,
            "BS.EQUITY_TOTAL": total_equity,
        })
        _ingest_items(statement_type="cf", period_end=pe, items={
            "CF.CFO": cfo,
        })

        _compute_metrics_and_alerts(report_id, company_id, focus_period_end=pe, period_type=period_type)

        def _reasonable_pct(v: float | None) -> float | None:
            try:
                if v is None:
                    return None
                fv = float(v)
                if -50.0 <= fv <= 100.0:
                    return fv
                return None
            except Exception:
                return None

        def _reasonable_times(v: float | None) -> float | None:
            try:
                if v is None:
                    return None
                fv = float(v)
                if 0.0 <= fv <= 50.0:
                    return fv
                return None
            except Exception:
                return None

        overrides: list[tuple[str, str, float | None, str | None]] = [
            ("GROSS_MARGIN", "毛利率", _reasonable_pct(gross_margin_pct), "%"),
            ("NET_MARGIN", "净利率", _reasonable_pct(net_margin_pct), "%"),
            ("ROE", "ROE", _reasonable_pct(roe_pct), "%"),
            ("ROA", "ROA", _reasonable_pct(roa_pct), "%"),
            ("DEBT_ASSET", "资产负债率", _reasonable_pct(debt_asset_pct), "%"),
            ("CURRENT_RATIO", "流动比率", _reasonable_times(current_ratio), "times"),
            ("QUICK_RATIO", "速动比率", _reasonable_times(quick_ratio), "times"),
        ]

        with session_scope() as s:
            for code2, name2, val2, unit2 in overrides:
                if val2 is None:
                    continue
                s.execute(
                    delete(ComputedMetric).where(
                        ComputedMetric.report_id == report_id,
                        ComputedMetric.period_end == pe,
                        ComputedMetric.metric_code == code2,
                    )
                )
                s.add(
                    ComputedMetric(
                        id=str(uuid.uuid4()),
                        report_id=report_id,
                        company_id=company_id,
                        period_end=pe,
                        period_type=period_type,
                        metric_code=code2,
                        metric_name=name2,
                        value=float(val2),
                        unit=unit2,
                        created_at=int(time.time()),
                    )
                )

    with session_scope() as s:
        rr = s.get(Report, report_id)
        if not rr:
            return
        # computed metrics for this report determine status
        has_metrics = (s.execute(select(ComputedMetric.id).where(ComputedMetric.report_id == report_id)).first() is not None)
        if has_metrics:
            rr.status = "done"
            rr.error_message = None
            if resolved_period_end:
                old_pe = rr.period_end
                rr.period_end = resolved_period_end
                if rr.report_name and old_pe and rr.report_name.endswith(old_pe):
                    rr.report_name = f"{rr.report_name[:-len(old_pe)]}{resolved_period_end}"
        else:
            rr.status = "failed"
            rr.error_message = "未能从市场数据获取到可用的财务指标（HK/US）"
        rr.updated_at = int(time.time())


def ingest_and_analyze_a_share(report_id: str) -> None:
    disable_proxies_for_process()
    with session_scope() as s:
        r = s.get(Report, report_id)
        if not r:
            raise ValueError("report not found")
        if not r.company_id:
            raise ValueError("A股报告缺少 company_id")

        company_id = r.company_id
        period_type = r.period_type
        period_end = r.period_end

        symbol = company_id.split(":", 1)[1]
        symbol = normalize_symbol("CN", symbol)

        r.status = "running"
        r.error_message = None
        r.updated_at = int(time.time())

    delete_report_children_full(report_id)

    fin = fetch_a_share_financials(symbol)

    # 补齐行业信息（用于行业基准对比）
    try:
        import akshare as ak

        code = symbol.split(".")[0]
        stock_info = ak.stock_individual_info_em(symbol=code)
        if stock_info is not None and not stock_info.empty:
            info_dict = dict(zip(stock_info["item"], stock_info["value"]))
            industry = (
                info_dict.get("所属行业")
                or info_dict.get("行业")
                or info_dict.get("所属板块")
                or info_dict.get("行业分类")
            )
            industry = (str(industry).strip() if industry is not None else None) or None

            if industry:
                # 同步到公司表
                try:
                    upsert_company(market="CN", symbol=symbol, industry_code=industry)
                except Exception:
                    pass

                # 写入报告 source_meta
                with session_scope() as s2:
                    rr = s2.get(Report, report_id)
                    if rr:
                        try:
                            meta = json.loads(rr.source_meta or "{}")
                        except Exception:
                            meta = {}
                        meta["industry"] = industry
                        if "industry_bucket" not in meta:
                            meta["industry_bucket"] = None
                        rr.source_meta = json.dumps(meta, ensure_ascii=False)
                        rr.updated_at = int(time.time())
    except Exception:
        pass

    _ingest_statement(report_id, company_id, "is", period_type, fin.profit, PROFIT_MAP, source="akshare_em")
    _ingest_statement(report_id, company_id, "bs", period_type, fin.balance, BALANCE_MAP, source="akshare_em")
    _ingest_statement(report_id, company_id, "cf", period_type, fin.cash, CASH_MAP, source="akshare_em")

    available_periods = _sorted_periods(report_id)
    focus_period_end = _pick_effective_period(period_end, available_periods) or period_end
    _compute_metrics_and_alerts(report_id, company_id, focus_period_end=focus_period_end, period_type=period_type)

    with session_scope() as s:
        r2 = s.get(Report, report_id)
        if r2:
            r2.status = "done"
            if focus_period_end:
                old_pe = r2.period_end
                r2.period_end = focus_period_end
                if r2.report_name and old_pe and r2.report_name.endswith(old_pe):
                    r2.report_name = f"{r2.report_name[:-len(old_pe)]}{focus_period_end}"
            r2.updated_at = int(time.time())


def _ingest_statement(
    report_id: str,
    company_id: str,
    statement_type: str,
    period_type: str,
    df: pd.DataFrame,
    mapping: dict[str, tuple[str | None, str]],
    source: str,
) -> None:
    keep_cols = ["REPORT_DATE", "CURRENCY"] + [c for c, _ in mapping.values() if c]

    with session_scope() as s:
        for _, row in df.iterrows():
            period_end = _period_end_from_row(row)
            currency = str(row.get("CURRENCY")) if row.get("CURRENCY") is not None else None

            st_obj = Statement(
                id=str(uuid.uuid4()),
                report_id=report_id,
                company_id=company_id,
                statement_type=statement_type,
                period_end=period_end,
                period_type=period_type,
                source=source,
                raw_payload=row_payload(row, keep_cols),
                created_at=int(time.time()),
            )
            s.add(st_obj)

            for code, (col, name) in mapping.items():
                if col is None:
                    # placeholder for fields not mapped in P0
                    continue
                v = _safe_float(row.get(col))
                item = StatementItem(
                    id=str(uuid.uuid4()),
                    statement_id=st_obj.id,
                    report_id=report_id,
                    company_id=company_id,
                    statement_type=statement_type,
                    period_end=period_end,
                    period_type=period_type,
                    standard_item_code=code,
                    standard_item_name=STANDARD_ITEM_NAMES.get(code, name),
                    value=v,
                    currency=currency,
                    original_item_name=col,
                    mapping_confidence=1.0,
                )
                s.add(item)


def _items_for_period(report_id: str, period_end: str) -> dict[str, float | None]:
    with session_scope() as s:
        stmt = select(StatementItem).where(StatementItem.report_id == report_id, StatementItem.period_end == period_end)
        items = s.execute(stmt).scalars().all()
        return {i.standard_item_code: i.value for i in items}


def _sorted_periods(report_id: str) -> list[str]:
    with session_scope() as s:
        stmt = select(Statement.period_end).where(Statement.report_id == report_id).distinct()
        periods = sorted({p[0] for p in s.execute(stmt).all()})
        return periods


def _compute_metrics_and_alerts(report_id: str, company_id: str, focus_period_end: str, period_type: str) -> None:
    periods = _sorted_periods(report_id)
    if not periods:
        return

    # compute metrics for all periods with prev period for avg fields
    with session_scope() as s:
        for idx, pe in enumerate(periods):
            cur_items = _items_for_period(report_id, pe)
            prev_items = _items_for_period(report_id, periods[idx - 1]) if idx > 0 else None
            metrics = compute_p0_metrics(cur_items, prev_items)
            for m in metrics:
                s.add(
                    ComputedMetric(
                        id=str(uuid.uuid4()),
                        report_id=report_id,
                        company_id=company_id,
                        period_end=pe,
                        period_type=period_type,
                        metric_code=m.metric_code,
                        metric_name=m.metric_name,
                        value=m.value,
                        unit=m.unit,
                        calc_trace=dumps(m.calc_trace),
                        created_at=int(time.time()),
                    )
                )

            # Persist key raw amounts for UI display and year-over-year comparison.
            raw_metrics = [
                ("TOTAL_REVENUE", "营业总收入", cur_items.get("IS.REVENUE"), ""),
                ("OPERATING_CASH_FLOW", "经营现金流量净额", cur_items.get("CF.CFO"), ""),
            ]
            for code, name, value, unit in raw_metrics:
                if value is None:
                    continue
                try:
                    fv = float(value)
                except Exception:
                    continue
                s.add(
                    ComputedMetric(
                        id=str(uuid.uuid4()),
                        report_id=report_id,
                        company_id=company_id,
                        period_end=pe,
                        period_type=period_type,
                        metric_code=code,
                        metric_name=name,
                        value=fv,
                        unit=unit,
                        calc_trace=dumps({"from": "statement_items", "source_code": "IS.REVENUE" if code == "TOTAL_REVENUE" else "CF.CFO"}),
                        created_at=int(time.time()),
                    )
                )

    # alerts only for focus period (latest selected)
    focus_items = _items_for_period(report_id, focus_period_end)
    alerts = risk_p0(focus_items)
    with session_scope() as s:
        for a in alerts:
            s.add(
                Alert(
                    id=str(uuid.uuid4()),
                    report_id=report_id,
                    company_id=company_id,
                    period_end=focus_period_end,
                    period_type=period_type,
                    alert_code=a.alert_code,
                    level=a.level,
                    title=a.title,
                    message=a.message,
                    evidence=dumps(a.evidence),
                    created_at=int(time.time()),
                )
            )
