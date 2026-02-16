"""
财务数据获取模块
支持从 yfinance (美股/港股) 和 akshare (A股) 获取财务报表数据
"""
from __future__ import annotations

import time
import streamlit as st
from dataclasses import dataclass
from typing import Optional

from core.net import disable_proxies_for_process


@dataclass
class FinancialData:
    """财务数据结构"""
    # 基本信息
    company_name: str = ""
    symbol: str = ""
    market: str = ""
    period: str = ""
    industry: Optional[str] = None
    
    # 利润表
    revenue: Optional[float] = None  # 营业收入
    cost: Optional[float] = None  # 营业成本
    gross_profit: Optional[float] = None  # 毛利润
    operating_income: Optional[float] = None  # 营业利润
    net_profit: Optional[float] = None  # 净利润
    
    # 资产负债表
    total_assets: Optional[float] = None  # 总资产
    total_liabilities: Optional[float] = None  # 总负债
    total_equity: Optional[float] = None  # 股东权益
    current_assets: Optional[float] = None  # 流动资产
    current_liabilities: Optional[float] = None  # 流动负债
    inventory: Optional[float] = None  # 存货
    receivables: Optional[float] = None  # 应收账款
    
    # 现金流量表
    operating_cash_flow: Optional[float] = None  # 经营活动现金流
    
    # 直接提取的比率
    gross_margin: Optional[float] = None  # 毛利率
    net_margin: Optional[float] = None  # 净利率
    roe: Optional[float] = None  # ROE
    roa: Optional[float] = None  # ROA
    current_ratio: Optional[float] = None  # 流动比率
    quick_ratio: Optional[float] = None  # 速动比率
    debt_ratio: Optional[float] = None  # 资产负债率
    
    # 数据来源
    source: str = ""  # "yfinance", "akshare", "manual"

    # 错误信息（用于可恢复失败的用户提示）
    error: Optional[str] = None


def _set_error_detail(data: FinancialData, detail: str) -> None:
    try:
        setattr(data, "error_detail", detail)
    except Exception:
        pass


def _has_meaningful_financials(data: FinancialData) -> bool:
    return any(
        v is not None
        for v in (
            data.revenue,
            data.net_profit,
            data.total_assets,
            data.total_equity,
            data.gross_margin,
            data.net_margin,
            data.roe,
            data.roa,
            data.current_ratio,
            data.quick_ratio,
            data.debt_ratio,
        )
    )


@st.cache_data(ttl=3600)  # 缓存1小时
def fetch_us_financials(symbol: str) -> Optional[FinancialData]:
    """获取美股财务数据 (使用 yfinance)"""
    import yfinance as yf

    # yfinance/requests respects proxy env vars; in some environments this breaks Yahoo calls.
    disable_proxies_for_process()

    last_err: Exception | None = None
    for attempt in range(3):
        try:
            ticker = yf.Ticker(symbol)
            info = None
            try:
                info = ticker.get_info()
            except Exception:
                info = ticker.info

            if not info:
                info = {}

            company_name = None
            if info:
                company_name = info.get("shortName") or info.get("longName")

            data = FinancialData(
                company_name=company_name or symbol,
                symbol=symbol,
                market="US",
                source="yfinance",
            )

            try:
                data.industry = info.get("industry") or info.get("sector")
            except Exception:
                pass

            # If info endpoint is blocked/empty, still try financial statements.
            if not company_name:
                data.error = "partial_info"

            # 优先使用 info 的比率，减少网络请求
            data.gross_margin = info.get("grossMargins") * 100 if info.get("grossMargins") else None
            data.net_margin = info.get("profitMargins") * 100 if info.get("profitMargins") else None
            data.roe = info.get("returnOnEquity") * 100 if info.get("returnOnEquity") else None
            data.roa = info.get("returnOnAssets") * 100 if info.get("returnOnAssets") else None
            data.current_ratio = info.get("currentRatio")
            data.quick_ratio = info.get("quickRatio")
            data.debt_ratio = info.get("debtToEquity") / 100 if info.get("debtToEquity") else None

            # 尝试补充报表数据（失败不影响结果）
            try:
                income_stmt = ticker.income_stmt
                if income_stmt is not None and not income_stmt.empty:
                    latest = income_stmt.iloc[:, 0]
                    data.period = (
                        str(income_stmt.columns[0].date())
                        if hasattr(income_stmt.columns[0], "date")
                        else str(income_stmt.columns[0])
                    )
                    data.revenue = float(latest.get("Total Revenue", 0)) / 1e8 if latest.get("Total Revenue") else None
                    data.cost = float(latest.get("Cost Of Revenue", 0)) / 1e8 if latest.get("Cost Of Revenue") else None
                    data.gross_profit = float(latest.get("Gross Profit", 0)) / 1e8 if latest.get("Gross Profit") else None
                    data.operating_income = float(latest.get("Operating Income", 0)) / 1e8 if latest.get("Operating Income") else None
                    data.net_profit = float(latest.get("Net Income", 0)) / 1e8 if latest.get("Net Income") else None
            except Exception:
                pass

            try:
                balance = ticker.balance_sheet
                if balance is not None and not balance.empty:
                    latest = balance.iloc[:, 0]
                    data.total_assets = float(latest.get("Total Assets", 0)) / 1e8 if latest.get("Total Assets") else None
                    data.total_liabilities = (
                        float(latest.get("Total Liabilities Net Minority Interest", 0)) / 1e8
                        if latest.get("Total Liabilities Net Minority Interest")
                        else None
                    )
                    data.total_equity = float(latest.get("Stockholders Equity", 0)) / 1e8 if latest.get("Stockholders Equity") else None
                    data.current_assets = float(latest.get("Current Assets", 0)) / 1e8 if latest.get("Current Assets") else None
                    data.current_liabilities = float(latest.get("Current Liabilities", 0)) / 1e8 if latest.get("Current Liabilities") else None
                    data.inventory = float(latest.get("Inventory", 0)) / 1e8 if latest.get("Inventory") else None
                    data.receivables = float(latest.get("Receivables", 0)) / 1e8 if latest.get("Receivables") else None
            except Exception:
                pass

            try:
                cashflow = ticker.cashflow
                if cashflow is not None and not cashflow.empty:
                    latest = cashflow.iloc[:, 0]
                    data.operating_cash_flow = (
                        float(latest.get("Operating Cash Flow", 0)) / 1e8 if latest.get("Operating Cash Flow") else None
                    )
            except Exception:
                pass

            return data

        except Exception as e:
            last_err = e
            msg = str(e)
            is_rate_limited = ("Too Many Requests" in msg) or ("429" in msg)
            if is_rate_limited:
                # 指数退避（短等待），避免瞬间重试再次触发限流
                if attempt < 2:
                    time.sleep(1.0 * (2**attempt))
                    continue
                print(f"Error fetching US financials for {symbol}: {e}")
                raise RuntimeError("rate_limited")
            print(f"Error fetching US financials for {symbol}: {e}")
            fd = FinancialData(company_name=symbol, symbol=symbol, market="US", source="yfinance", error="fetch_failed")
            _set_error_detail(fd, f"yfinance_exception:{e}")
            return fd

    if last_err:
        print(f"Error fetching US financials for {symbol}: {last_err}")
    return None


@st.cache_data(ttl=3600)
def fetch_us_financials_akshare(symbol: str) -> Optional[FinancialData]:
    """获取美股财务数据 (使用 AkShare / 东方财富 USF10)

    兜底用于部署环境 yfinance 被限流/阻断时。
    """
    try:
        import akshare as ak

        disable_proxies_for_process()

        base = (symbol or "").strip().upper()
        if not base:
            return None
        # TSLA / TSLA.OQ / TSLA.O
        base = base.split(".")[0]

        data = FinancialData(company_name=base, symbol=base, market="US", source="akshare")

        try:
            ind_df = ak.stock_financial_us_analysis_indicator_em(symbol=base, indicator="年报")
        except Exception as e:
            ind_df = None
            _set_error_detail(data, f"akshare_us_indicator_exception:{e}")

        if ind_df is not None and not ind_df.empty:
            row = ind_df.iloc[0]
            try:
                data.company_name = str(row.get("SECURITY_NAME_ABBR") or base)
            except Exception:
                pass

            try:
                p = row.get("STD_REPORT_DATE") or row.get("REPORT_DATE")
                if p is not None:
                    data.period = str(p.date()) if hasattr(p, "date") else str(p)
            except Exception:
                pass

            def _num(v):
                try:
                    if v is None:
                        return None
                    sv = str(v).strip()
                    if sv in ("", "--", "nan", "None"):
                        return None
                    return float(v)
                except Exception:
                    return None

            data.gross_margin = _num(row.get("GROSS_PROFIT_RATIO"))
            data.net_margin = _num(row.get("NET_PROFIT_RATIO"))
            data.roe = _num(row.get("ROE_AVG"))
            data.roa = _num(row.get("ROA"))
            data.current_ratio = _num(row.get("CURRENT_RATIO"))
            data.quick_ratio = _num(row.get("SPEED_RATIO"))
            data.debt_ratio = _num(row.get("DEBT_ASSET_RATIO"))

        def _pick_amount(df, keywords: list[str]) -> float | None:
            try:
                if df is None or df.empty:
                    return None
                date_col = "REPORT_DATE" if "REPORT_DATE" in df.columns else None
                item_col = "ITEM_NAME" if "ITEM_NAME" in df.columns else None
                amt_col = "AMOUNT" if "AMOUNT" in df.columns else None
                if not item_col or not amt_col:
                    return None
                df2 = df
                if date_col:
                    try:
                        latest = df2[date_col].max()
                        df2 = df2[df2[date_col] == latest]
                        if not data.period and latest is not None:
                            data.period = str(latest.date()) if hasattr(latest, "date") else str(latest)
                    except Exception:
                        pass
                for kw in keywords:
                    hit = df2[df2[item_col].astype(str).str.contains(kw, na=False)]
                    if not hit.empty:
                        v = hit.iloc[0].get(amt_col)
                        if v is None:
                            continue
                        try:
                            return float(v) / 1e8
                        except Exception:
                            continue
                return None
            except Exception:
                return None

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

        data.revenue = _pick_amount(income_df, ["营业收入", "主营收入"]) 
        data.cost = _pick_amount(income_df, ["营业成本", "主营成本"]) 
        data.gross_profit = _pick_amount(income_df, ["毛利"]) 
        data.operating_income = _pick_amount(income_df, ["营业利润"]) 
        data.net_profit = _pick_amount(income_df, ["净利润", "归属于母公司股东净利润", "归属于普通股股东净利润"]) 

        data.total_assets = _pick_amount(balance_df, ["总资产", "资产总计"]) 
        data.total_liabilities = _pick_amount(balance_df, ["负债合计", "总负债"]) 
        data.total_equity = _pick_amount(balance_df, ["股东权益", "权益合计", "净资产"]) 
        data.current_assets = _pick_amount(balance_df, ["流动资产合计"]) 
        data.current_liabilities = _pick_amount(balance_df, ["流动负债合计"]) 
        data.inventory = _pick_amount(balance_df, ["存货"]) 
        data.receivables = _pick_amount(balance_df, ["应收账款"]) 

        data.operating_cash_flow = _pick_amount(cash_df, ["经营活动产生的现金流量净额"]) 

        if not _has_meaningful_financials(data):
            data.error = "fetch_failed"
            if not getattr(data, "error_detail", None):
                _set_error_detail(data, "akshare_us_empty")
        else:
            data.error = None

        return data
    except Exception as e:
        fd = FinancialData(company_name=symbol, symbol=symbol, market="US", source="akshare", error="fetch_failed")
        _set_error_detail(fd, f"akshare_us_exception:{e}")
        return fd


@st.cache_data(ttl=3600)
def fetch_hk_financials(symbol: str, _v: int = 2) -> Optional[FinancialData]:
    """获取港股财务数据 (使用 yfinance)"""
    try:
        import yfinance as yf

        disable_proxies_for_process()
        
        # 转换为 yfinance 格式
        yf_symbol = symbol
        if not yf_symbol.endswith(".HK"):
            yf_symbol = f"{symbol}.HK"

        ticker = yf.Ticker(yf_symbol)

        data = FinancialData(company_name=symbol, symbol=yf_symbol, market="HK", source="yfinance")

        yfinance_rate_limited = False
        rate_limit_detail = None
        try:
            info = ticker.info
        except Exception as e:
            msg = str(e)
            if "Too Many Requests" in msg or "Rate limited" in msg or "429" in msg:
                yfinance_rate_limited = True
                rate_limit_detail = f"yfinance_rate_limited:{e}"
            info = {}

        if not info:
            info = {}

        company_name = info.get("shortName") or info.get("longName")
        if company_name:
            data.company_name = company_name

        try:
            data.industry = info.get("industry") or info.get("sector")
        except Exception:
            pass

        if yfinance_rate_limited:
            data.error = "rate_limited"
            if rate_limit_detail:
                try:
                    setattr(data, "error_detail", rate_limit_detail)
                except Exception:
                    pass

        if (not company_name) and data.error != "rate_limited":
            data.error = "partial_info"
        
        # 获取财务报表（与美股相同逻辑）
        try:
            income_stmt = ticker.income_stmt
            if income_stmt is not None and not income_stmt.empty:
                latest = income_stmt.iloc[:, 0]
                data.period = str(income_stmt.columns[0].date()) if hasattr(income_stmt.columns[0], 'date') else str(income_stmt.columns[0])
                data.revenue = float(latest.get("Total Revenue", 0)) / 1e8 if latest.get("Total Revenue") else None
                data.net_profit = float(latest.get("Net Income", 0)) / 1e8 if latest.get("Net Income") else None
        except Exception:
            pass
        
        try:
            balance = ticker.balance_sheet
            if balance is not None and not balance.empty:
                latest = balance.iloc[:, 0]
                data.total_assets = float(latest.get("Total Assets", 0)) / 1e8 if latest.get("Total Assets") else None
                data.total_equity = float(latest.get("Stockholders Equity", 0)) / 1e8 if latest.get("Stockholders Equity") else None
        except Exception:
            pass
        
        # 港股：yfinance info 中的比率（ROE/ROA/margins）经常不准确，
        # 仅暂存作为 AkShare 失败时的兜底值
        _yf_gross_margin = info.get("grossMargins") * 100 if info.get("grossMargins") else None
        _yf_net_margin = info.get("profitMargins") * 100 if info.get("profitMargins") else None
        _yf_roe = info.get("returnOnEquity") * 100 if info.get("returnOnEquity") else None
        _yf_roa = info.get("returnOnAssets") * 100 if info.get("returnOnAssets") else None
        _yf_current_ratio = info.get("currentRatio")

        # 港股始终优先使用 AkShare 获取财务指标（东方财富数据更准确）
        if True:
            try:
                import akshare as ak

                disable_proxies_for_process()

                stock = yf_symbol.replace(".HK", "")
                stock = stock.zfill(5)

                # 1) 最新指标（包含净利率/ROE/ROA 等，也直接含营业总收入/净利润原始值）
                ind_df = ak.stock_hk_financial_indicator_em(symbol=stock)
                if ind_df is not None and not ind_df.empty:
                    row = ind_df.iloc[0]

                    def _pct(v):
                        try:
                            if v is None:
                                return None
                            sv = str(v).strip()
                            if sv in ("", "--", "nan", "None"):
                                return None
                            return float(sv)
                        except Exception:
                            return None

                    data.net_margin = _pct(row.get("销售净利率(%)"))
                    data.gross_margin = _pct(row.get("销售毛利率(%)"))
                    data.roe = _pct(row.get("股东权益回报率(%)"))
                    data.roa = _pct(row.get("总资产回报率(%)"))

                    # 直接从指标表取原始财务数据（更可靠）
                    try:
                        rev = row.get("营业总收入")
                        if rev is not None and str(rev) not in ("", "--", "nan", "None"):
                            data.revenue = float(rev) / 1e8
                    except Exception:
                        pass
                    try:
                        np = row.get("净利润")
                        if np is not None and str(np) not in ("", "--", "nan", "None"):
                            data.net_profit = float(np) / 1e8
                    except Exception:
                        pass

                # 2) 三大报表（用于 total_assets / total_equity 等，revenue/net_profit 已从指标表取）
                def _pick_amount(df, keywords: list[str]) -> float | None:
                    try:
                        if df is None or df.empty:
                            return None
                        # 东方财富港股报表实际列名为 STD_ITEM_NAME / AMOUNT
                        item_col = None
                        for c in ("STD_ITEM_NAME", "ITEM_NAME", "项目名称"):
                            if c in df.columns:
                                item_col = c
                                break
                        amt_col = "AMOUNT" if "AMOUNT" in df.columns else ("金额" if "金额" in df.columns else None)
                        date_col = None
                        for c in ("STD_REPORT_DATE", "REPORT_DATE", "报告期"):
                            if c in df.columns:
                                date_col = c
                                break
                        if not item_col or not amt_col:
                            return None

                        df2 = df
                        if date_col and date_col in df2.columns:
                            try:
                                latest_date = df2[date_col].max()
                                df2 = df2[df2[date_col] == latest_date]
                                if latest_date is not None:
                                    data.period = (
                                        str(latest_date.date())
                                        if hasattr(latest_date, "date")
                                        else str(latest_date)
                                    )
                            except Exception:
                                pass

                        for kw in keywords:
                            hit = df2[df2[item_col].astype(str).str.contains(kw, na=False)]
                            if not hit.empty:
                                v = hit.iloc[0].get(amt_col)
                                if v is None:
                                    continue
                                try:
                                    return float(v) / 1e8
                                except Exception:
                                    continue
                        return None
                    except Exception:
                        return None

                try:
                    profit_df = ak.stock_financial_hk_report_em(stock=stock, symbol="利润表", indicator="年度")
                except Exception:
                    profit_df = None
                try:
                    balance_df = ak.stock_financial_hk_report_em(stock=stock, symbol="资产负债表", indicator="年度")
                except Exception:
                    balance_df = None

                # 如果指标表没拿到 revenue/net_profit，再从利润表补
                if data.revenue is None:
                    data.revenue = _pick_amount(profit_df, ["营业额", "营运收入", "营业收入", "收入", "收益", "总收入"])
                if data.net_profit is None:
                    data.net_profit = _pick_amount(profit_df, ["本公司拥有人应占", "股东应占溢利", "净利润", "净利", "本年溢利"])
                
                # 资产负债表
                data.total_assets = _pick_amount(balance_df, ["资产总值", "资产总计", "总资产", "资产合计"])
                data.total_liabilities = _pick_amount(balance_df, ["负债总额", "负债合计", "总负债"])
                data.total_equity = _pick_amount(balance_df, ["权益总额", "权益总计", "股东权益合计", "股东应占权益", "权益"])
                data.current_assets = _pick_amount(balance_df, ["流动资产总值", "流动资产合计"])
                data.current_liabilities = _pick_amount(balance_df, ["流动负债总额", "流动负债合计"])

                data.source = "akshare"
                if not (data.revenue or data.net_profit or data.total_assets or data.total_equity or data.net_margin or data.roe or data.roa):
                    # yfinance 可能被限流，akshare 也失败时，保留更准确的错误码
                    if data.error != "rate_limited":
                        data.error = "fetch_failed"
                else:
                    data.error = None
            except Exception as e:
                if not data.error:
                    data.error = "fetch_failed"
                try:
                    setattr(data, "error_detail", f"akshare_fallback_exception:{e}")
                except Exception:
                    pass

        # AkShare 未能提供的比率，用 yfinance 兜底
        if data.gross_margin is None and _yf_gross_margin is not None:
            data.gross_margin = _yf_gross_margin
        if data.net_margin is None and _yf_net_margin is not None:
            data.net_margin = _yf_net_margin
        if data.roe is None and _yf_roe is not None:
            data.roe = _yf_roe
        if data.roa is None and _yf_roa is not None:
            data.roa = _yf_roa
        if data.current_ratio is None and _yf_current_ratio is not None:
            data.current_ratio = _yf_current_ratio

        return data
        
    except Exception as e:
        print(f"Error fetching HK financials for {symbol}: {e}")
        msg = str(e)
        err = "rate_limited" if ("Too Many Requests" in msg or "Rate limited" in msg or "429" in msg) else "fetch_failed"
        fd = FinancialData(company_name=symbol, symbol=symbol, market="HK", source="yfinance", error=err)
        try:
            setattr(fd, "error_detail", f"yfinance_exception:{e}")
        except Exception:
            pass
        return fd


@st.cache_data(ttl=3600)
def fetch_cn_financials(symbol: str) -> Optional[FinancialData]:
    """获取A股财务数据 (使用 akshare)"""
    try:
        import akshare as ak

        disable_proxies_for_process()
        
        # 提取纯数字代码
        code = symbol.replace(".SH", "").replace(".SZ", "").replace(".SS", "")
        
        # 判断交易所
        if symbol.endswith(".SH") or symbol.endswith(".SS") or code.startswith("6"):
            full_code = f"sh{code}"
            suffix = ".SH"
        else:
            full_code = f"sz{code}"
            suffix = ".SZ"
        
        data = FinancialData(
            symbol=f"{code}{suffix}",
            market="CN",
            source="akshare"
        )
        
        # 获取公司基本信息
        try:
            stock_info = ak.stock_individual_info_em(symbol=code)
            if stock_info is not None and not stock_info.empty:
                info_dict = dict(zip(stock_info['item'], stock_info['value']))
                data.company_name = info_dict.get('股票简称', code)
                try:
                    data.industry = (
                        info_dict.get('所属行业')
                        or info_dict.get('行业')
                        or info_dict.get('所属板块')
                        or info_dict.get('行业分类')
                    )
                except Exception:
                    pass
        except Exception:
            data.company_name = code
        
        # 获取财务指标
        try:
            # 主要财务指标
            finance_df = ak.stock_financial_abstract_ths(symbol=code, indicator="按报告期")
            if finance_df is not None and not finance_df.empty:
                latest = finance_df.iloc[0]
                data.period = str(latest.get('报告期', ''))
                
                # 尝试获取各项指标
                if '营业总收入' in latest:
                    val = latest['营业总收入']
                    if val and str(val) != '--':
                        data.revenue = float(str(val).replace(',', '')) / 1e8
                
                if '净利润' in latest:
                    val = latest['净利润']
                    if val and str(val) != '--':
                        data.net_profit = float(str(val).replace(',', '')) / 1e8
                
                if '总资产' in latest:
                    val = latest['总资产']
                    if val and str(val) != '--':
                        data.total_assets = float(str(val).replace(',', '')) / 1e8
                
                if '净资产' in latest or '股东权益' in latest:
                    val = latest.get('净资产') or latest.get('股东权益')
                    if val and str(val) != '--':
                        data.total_equity = float(str(val).replace(',', '')) / 1e8
        except Exception as e:
            print(f"Error fetching CN finance abstract: {e}")
            _set_error_detail(data, f"cn_finance_abstract_exception:{e}")
        
        # 获取财务比率
        try:
            ratio_df = ak.stock_financial_analysis_indicator(symbol=code)
            if ratio_df is not None and not ratio_df.empty:
                latest = ratio_df.iloc[0]
                
                if '净资产收益率(%)' in latest:
                    val = latest['净资产收益率(%)']
                    if val and str(val) != '--':
                        data.roe = float(val)
                
                if '总资产报酬率(%)' in latest or '总资产净利率(%)' in latest:
                    val = latest.get('总资产报酬率(%)') or latest.get('总资产净利率(%)')
                    if val and str(val) != '--':
                        data.roa = float(val)
                
                if '销售毛利率(%)' in latest:
                    val = latest['销售毛利率(%)']
                    if val and str(val) != '--':
                        data.gross_margin = float(val)
                
                if '销售净利率(%)' in latest:
                    val = latest['销售净利率(%)']
                    if val and str(val) != '--':
                        data.net_margin = float(val)
                
                if '流动比率' in latest:
                    val = latest['流动比率']
                    if val and str(val) != '--':
                        data.current_ratio = float(val)
                
                if '速动比率' in latest:
                    val = latest['速动比率']
                    if val and str(val) != '--':
                        data.quick_ratio = float(val)
                
                if '资产负债率(%)' in latest:
                    val = latest['资产负债率(%)']
                    if val and str(val) != '--':
                        data.debt_ratio = float(val)
        except Exception as e:
            print(f"Error fetching CN financial ratios: {e}")
            if not getattr(data, "error_detail", None):
                _set_error_detail(data, f"cn_financial_ratios_exception:{e}")

        # 兜底：如果 AkShare(同花顺)返回空，使用新浪三大报表兜底
        if not _has_meaningful_financials(data):
            try:
                profit_df = ak.stock_financial_report_sina(stock=full_code, symbol="利润表")
            except Exception as e:
                profit_df = None
                _set_error_detail(data, f"sina_profit_exception:{e}")

            try:
                balance_df = ak.stock_financial_report_sina(stock=full_code, symbol="资产负债表")
            except Exception as e:
                balance_df = None
                if not getattr(data, "error_detail", None):
                    _set_error_detail(data, f"sina_balance_exception:{e}")

            def _pick_row0(df):
                try:
                    if df is None or df.empty:
                        return None
                    return df.iloc[0]
                except Exception:
                    return None

            prow = _pick_row0(profit_df)
            brow = _pick_row0(balance_df)

            try:
                if prow is not None and data.period == "":
                    data.period = str(prow.get("报告日") or "")
            except Exception:
                pass

            def _to_amount(v):
                try:
                    if v is None:
                        return None
                    sv = str(v).replace(",", "").strip()
                    if sv in ("", "--", "nan", "None"):
                        return None
                    return float(sv) / 1e8
                except Exception:
                    return None

            try:
                if prow is not None:
                    data.revenue = _to_amount(prow.get("营业收入") or prow.get("营业总收入"))
                    data.net_profit = _to_amount(prow.get("净利润") or prow.get("归属于母公司所有者的净利润"))
                    data.gross_margin = None
                    data.net_margin = _to_amount(prow.get("销售净利率(%)"))
            except Exception:
                pass

            try:
                if brow is not None:
                    data.total_assets = _to_amount(brow.get("资产总计") or brow.get("总资产"))
                    data.total_equity = _to_amount(brow.get("股东权益合计") or brow.get("归属于母公司股东权益合计") or brow.get("净资产"))
                    data.total_liabilities = _to_amount(brow.get("负债合计") or brow.get("总负债"))
            except Exception:
                pass

            data.source = "sina"

        if not _has_meaningful_financials(data):
            data.error = "fetch_failed"
            if not getattr(data, "error_detail", None):
                _set_error_detail(data, "cn_empty")
        else:
            data.error = None
        
        return data
        
    except Exception as e:
        print(f"Error fetching CN financials for {symbol}: {e}")
        return None


def fetch_financials(symbol: str, market: str) -> Optional[FinancialData]:
    """统一的财务数据获取接口"""
    if market == "US":
        try:
            data = fetch_us_financials(symbol)
            if data is not None and _has_meaningful_financials(data) and getattr(data, "error", None) not in ("fetch_failed", "rate_limited"):
                return data
            # yfinance 失败/空数据时，使用 AkShare 兜底
            ak_data = fetch_us_financials_akshare(symbol)
            if ak_data is not None and _has_meaningful_financials(ak_data) and getattr(ak_data, "error", None) != "fetch_failed":
                return ak_data
            return data or ak_data
        except RuntimeError as e:
            if str(e) == "rate_limited":
                ak_data = fetch_us_financials_akshare(symbol)
                if ak_data is not None and _has_meaningful_financials(ak_data) and getattr(ak_data, "error", None) != "fetch_failed":
                    return ak_data
                fd = FinancialData(company_name=symbol, symbol=symbol, market="US", source="yfinance", error="rate_limited")
                _set_error_detail(fd, "yfinance_rate_limited")
                return fd
            raise
    elif market == "HK":
        return fetch_hk_financials(symbol)
    elif market == "CN":
        return fetch_cn_financials(symbol)
    else:
        return None


def compute_metrics_from_financial_data(data: FinancialData) -> dict:
    """从财务数据计算指标"""
    metrics = {}
    
    # 盈利能力
    if data.gross_margin is not None:
        metrics["GROSS_MARGIN"] = data.gross_margin
    elif data.revenue and data.gross_profit and data.revenue > 0:
        metrics["GROSS_MARGIN"] = (data.gross_profit / data.revenue) * 100
    
    if data.net_margin is not None:
        metrics["NET_MARGIN"] = data.net_margin
    elif data.revenue and data.net_profit and data.revenue > 0:
        metrics["NET_MARGIN"] = (data.net_profit / data.revenue) * 100
    
    if data.roe is not None:
        metrics["ROE"] = data.roe
    elif data.net_profit and data.total_equity and data.total_equity > 0:
        metrics["ROE"] = (data.net_profit / data.total_equity) * 100
    
    if data.roa is not None:
        metrics["ROA"] = data.roa
    elif data.net_profit and data.total_assets and data.total_assets > 0:
        metrics["ROA"] = (data.net_profit / data.total_assets) * 100
    
    # 偿债能力
    if data.current_ratio is not None:
        metrics["CURRENT_RATIO"] = data.current_ratio
    elif data.current_assets and data.current_liabilities and data.current_liabilities > 0:
        metrics["CURRENT_RATIO"] = data.current_assets / data.current_liabilities
    
    if data.quick_ratio is not None:
        metrics["QUICK_RATIO"] = data.quick_ratio
    elif data.current_assets and data.inventory and data.current_liabilities and data.current_liabilities > 0:
        metrics["QUICK_RATIO"] = (data.current_assets - data.inventory) / data.current_liabilities
    
    if data.debt_ratio is not None:
        metrics["DEBT_ASSET"] = data.debt_ratio
    elif data.total_liabilities and data.total_assets and data.total_assets > 0:
        metrics["DEBT_ASSET"] = (data.total_liabilities / data.total_assets) * 100
    
    # 产权比率
    if data.total_liabilities and data.total_equity and data.total_equity > 0:
        metrics["EQUITY_RATIO"] = data.total_liabilities / data.total_equity
    
    # 营运能力
    if data.revenue and data.total_assets and data.total_assets > 0:
        metrics["ASSET_TURNOVER"] = data.revenue / data.total_assets
    
    if data.revenue and data.inventory and data.inventory > 0:
        metrics["INVENTORY_TURNOVER"] = data.revenue / data.inventory
    
    if data.revenue and data.receivables and data.receivables > 0:
        metrics["RECEIVABLE_TURNOVER"] = data.revenue / data.receivables
    
    return metrics
