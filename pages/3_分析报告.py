from __future__ import annotations

import json
import time

import pandas as pd
import streamlit as st
from sqlalchemy import select

from core.db import session_scope
from core.models import Alert, ComputedMetric, Report, StatementItem
from core.net import disable_proxies_for_process
from core.pipeline import ingest_and_analyze_a_share
from core.repository import get_report, list_reports, normalize_market, update_report_status
from core.schema import init_db
from core.styles import inject_css, render_sidebar_nav, render_mobile_nav, badge
from core.pdf_text import extract_pdf_text
from core.pdf_analyzer import extract_financials_from_pdf, compute_metrics_from_extracted
from core.ui import pretty_json
from core.llm_qwen import analyze_financials_with_qwen, _calculate_health_score, _calculate_rating_details, get_api_key, test_qwen_connection
import plotly.graph_objects as go

from io import BytesIO
from pathlib import Path


# 行业基准数据 - 按行业分类
INDUSTRY_BENCHMARKS_BY_SECTOR = {
    "银行": {
        "GROSS_MARGIN": {"name": "毛利率", "avg": None, "unit": "%"},  # 银行无毛利率概念
        "NET_MARGIN": {"name": "净利率", "avg": 35.0, "unit": "%"},
        "ROE": {"name": "ROE (净资产收益率)", "avg": 10.0, "unit": "%"},
        "ROA": {"name": "ROA (总资产收益率)", "avg": 0.8, "unit": "%"},
        "CURRENT_RATIO": {"name": "流动比率", "avg": None, "unit": ""},  # 银行不适用
        "QUICK_RATIO": {"name": "速动比率", "avg": None, "unit": ""},
        "DEBT_ASSET": {"name": "资产负债率", "avg": 92.0, "unit": "%", "reverse": True},
        "EQUITY_RATIO": {"name": "产权比率", "avg": 11.5, "unit": "", "reverse": True},
        "INVENTORY_TURNOVER": {"name": "存货周转率", "avg": None, "unit": ""},
        "RECEIVABLE_TURNOVER": {"name": "应收账款周转率", "avg": None, "unit": ""},
        "ASSET_TURNOVER": {"name": "总资产周转率", "avg": 0.02, "unit": ""},
        "REVENUE_GROWTH": {"name": "营收增长率", "avg": 5.0, "unit": "%"},
        "PROFIT_GROWTH": {"name": "净利润增长率", "avg": 5.0, "unit": "%"},
        "ASSET_GROWTH": {"name": "资产增长率", "avg": 8.0, "unit": "%"},
    },
    "保险": {
        "GROSS_MARGIN": {"name": "毛利率", "avg": None, "unit": "%"},
        "NET_MARGIN": {"name": "净利率", "avg": 8.0, "unit": "%"},
        "ROE": {"name": "ROE (净资产收益率)", "avg": 12.0, "unit": "%"},
        "ROA": {"name": "ROA (总资产收益率)", "avg": 1.0, "unit": "%"},
        "CURRENT_RATIO": {"name": "流动比率", "avg": None, "unit": ""},
        "QUICK_RATIO": {"name": "速动比率", "avg": None, "unit": ""},
        "DEBT_ASSET": {"name": "资产负债率", "avg": 88.0, "unit": "%", "reverse": True},
        "EQUITY_RATIO": {"name": "产权比率", "avg": 7.3, "unit": "", "reverse": True},
        "INVENTORY_TURNOVER": {"name": "存货周转率", "avg": None, "unit": ""},
        "RECEIVABLE_TURNOVER": {"name": "应收账款周转率", "avg": None, "unit": ""},
        "ASSET_TURNOVER": {"name": "总资产周转率", "avg": 0.15, "unit": ""},
        "REVENUE_GROWTH": {"name": "营收增长率", "avg": 8.0, "unit": "%"},
        "PROFIT_GROWTH": {"name": "净利润增长率", "avg": 10.0, "unit": "%"},
        "ASSET_GROWTH": {"name": "资产增长率", "avg": 10.0, "unit": "%"},
    },
    "白酒": {
        "GROSS_MARGIN": {"name": "毛利率", "avg": 75.0, "unit": "%"},
        "NET_MARGIN": {"name": "净利率", "avg": 35.0, "unit": "%"},
        "ROE": {"name": "ROE (净资产收益率)", "avg": 25.0, "unit": "%"},
        "ROA": {"name": "ROA (总资产收益率)", "avg": 18.0, "unit": "%"},
        "CURRENT_RATIO": {"name": "流动比率", "avg": 3.0, "unit": ""},
        "QUICK_RATIO": {"name": "速动比率", "avg": 2.5, "unit": ""},
        "DEBT_ASSET": {"name": "资产负债率", "avg": 30.0, "unit": "%", "reverse": True},
        "EQUITY_RATIO": {"name": "产权比率", "avg": 0.43, "unit": "", "reverse": True},
        "INVENTORY_TURNOVER": {"name": "存货周转率", "avg": 0.5, "unit": ""},
        "RECEIVABLE_TURNOVER": {"name": "应收账款周转率", "avg": 50.0, "unit": ""},
        "ASSET_TURNOVER": {"name": "总资产周转率", "avg": 0.5, "unit": ""},
        "REVENUE_GROWTH": {"name": "营收增长率", "avg": 15.0, "unit": "%"},
        "PROFIT_GROWTH": {"name": "净利润增长率", "avg": 18.0, "unit": "%"},
        "ASSET_GROWTH": {"name": "资产增长率", "avg": 12.0, "unit": "%"},
    },
    "制造业": {
        "GROSS_MARGIN": {"name": "毛利率", "avg": 25.0, "unit": "%"},
        "NET_MARGIN": {"name": "净利率", "avg": 8.0, "unit": "%"},
        "ROE": {"name": "ROE (净资产收益率)", "avg": 12.0, "unit": "%"},
        "ROA": {"name": "ROA (总资产收益率)", "avg": 6.0, "unit": "%"},
        "CURRENT_RATIO": {"name": "流动比率", "avg": 1.5, "unit": ""},
        "QUICK_RATIO": {"name": "速动比率", "avg": 1.0, "unit": ""},
        "DEBT_ASSET": {"name": "资产负债率", "avg": 55.0, "unit": "%", "reverse": True},
        "EQUITY_RATIO": {"name": "产权比率", "avg": 1.22, "unit": "", "reverse": True},
        "INVENTORY_TURNOVER": {"name": "存货周转率", "avg": 5.0, "unit": ""},
        "RECEIVABLE_TURNOVER": {"name": "应收账款周转率", "avg": 7.0, "unit": ""},
        "ASSET_TURNOVER": {"name": "总资产周转率", "avg": 0.7, "unit": ""},
        "REVENUE_GROWTH": {"name": "营收增长率", "avg": 10.0, "unit": "%"},
        "PROFIT_GROWTH": {"name": "净利润增长率", "avg": 12.0, "unit": "%"},
        "ASSET_GROWTH": {"name": "资产增长率", "avg": 9.0, "unit": "%"},
    },
    "默认": {
        "GROSS_MARGIN": {"name": "毛利率", "avg": 32.0, "unit": "%"},
        "NET_MARGIN": {"name": "净利率", "avg": 10.0, "unit": "%"},
        "ROE": {"name": "ROE (净资产收益率)", "avg": 13.0, "unit": "%"},
        "ROA": {"name": "ROA (总资产收益率)", "avg": 6.0, "unit": "%"},
        "CURRENT_RATIO": {"name": "流动比率", "avg": 1.5, "unit": ""},
        "QUICK_RATIO": {"name": "速动比率", "avg": 1.0, "unit": ""},
        "DEBT_ASSET": {"name": "资产负债率", "avg": 55.0, "unit": "%", "reverse": True},
        "EQUITY_RATIO": {"name": "产权比率", "avg": 1.22, "unit": "", "reverse": True},
        "INVENTORY_TURNOVER": {"name": "存货周转率", "avg": 5.0, "unit": ""},
        "RECEIVABLE_TURNOVER": {"name": "应收账款周转率", "avg": 7.0, "unit": ""},
        "ASSET_TURNOVER": {"name": "总资产周转率", "avg": 0.7, "unit": ""},
        "REVENUE_GROWTH": {"name": "营收增长率", "avg": 10.0, "unit": "%"},
        "PROFIT_GROWTH": {"name": "净利润增长率", "avg": 12.0, "unit": "%"},
        "ASSET_GROWTH": {"name": "资产增长率", "avg": 9.0, "unit": "%"},
    },
}

def detect_industry(company_name: str) -> str:
    """根据公司名称检测行业"""
    combined = (company_name or "").strip().lower()
    if any(kw in combined for kw in ["银行", "bank"]):
        return "银行"
    if any(kw in combined for kw in ["保险", "人寿", "财险", "insurance"]):
        return "保险"
    if any(kw in combined for kw in ["白酒", "五粮液", "茅台", "泸州老窖", "洋河", "汾酒", "酒"]):
        return "白酒"
    if any(kw in combined for kw in [
        "餐饮", "火锅", "海底捞", "小菜园", "小南国", "呷哺", "九毛九", "太二", "奈雪", "喜茶",
        "restaurant", "food service", "catering", "dining", "mcdonald", "starbucks", "yum",
        "chipotle", "darden", "domino", "pizza", "cafe", "coffee",
    ]):
        return "餐饮"
    if any(kw in combined for kw in [
        "零售", "retail", "超市", "百货", "walmart", "costco", "电商",
        "specialty retail", "grocery", "department store",
    ]):
        return "零售"
    if any(kw in combined for kw in ["医药", "制药", "生物", "pharma", "biotech", "drug", "health", "medical"]):
        return "医药"
    if any(kw in combined for kw in [
        "互联网", "internet", "腾讯", "阿里", "美团", "字节", "百度", "京东", "拼多多",
        "meta", "google", "alphabet", "amazon", "netflix",
    ]):
        return "互联网"
    if any(kw in combined for kw in [
        "科技", "tech", "软件", "software", "芯片", "半导体", "semiconductor",
        "apple", "microsoft", "nvidia", "苹果", "英伟达",
    ]):
        return "科技"
    if any(kw in combined for kw in ["房地产", "地产", "real estate", "property", "万科", "碧桂园", "恒大"]):
        return "房地产"
    if any(kw in combined for kw in ["能源", "石油", "石化", "energy", "oil", "gas", "煤炭", "电力"]):
        return "能源"
    if any(kw in combined for kw in ["消费", "consumer", "食品", "饮料", "日用", "家电", "packaged food", "beverage"]):
        return "消费品"
    if any(kw in combined for kw in ["制造", "机械", "汽车", "电子", "工业", "manufacturing", "industrial", "auto"]):
        return "制造业"
    return "默认"

def _normalize_industry_bucket(industry: str | None, company_name: str) -> str:
    s = (industry or "").strip().lower()
    name = (company_name or "").strip().lower()
    combined = s + " " + name
    if any(kw in combined for kw in ["银行", "bank"]):
        return "银行"
    if any(kw in combined for kw in ["保险", "人寿", "财险", "insurance"]):
        return "保险"
    if any(kw in combined for kw in ["白酒", "酒", "食品饮料"]):
        return "白酒"
    if any(kw in combined for kw in [
        "餐饮", "火锅", "海底捞", "小菜园", "小南国", "呷哺", "九毛九", "太二", "奈雪", "喜茶",
        "restaurant", "food service", "catering", "dining", "mcdonald", "starbucks", "yum",
        "chipotle", "darden", "domino", "pizza", "cafe", "coffee",
    ]):
        return "餐饮"
    if any(kw in combined for kw in [
        "零售", "retail", "超市", "百货", "walmart", "costco", "电商",
        "specialty retail", "grocery", "department store",
    ]):
        return "零售"
    if any(kw in combined for kw in ["医药", "制药", "生物", "pharma", "biotech", "drug", "health", "medical"]):
        return "医药"
    if any(kw in combined for kw in [
        "互联网", "internet", "腾讯", "阿里", "美团", "字节", "百度", "京东", "拼多多",
        "meta", "google", "alphabet", "amazon", "netflix",
        "interactive media", "internet content",
    ]):
        return "互联网"
    if any(kw in combined for kw in [
        "科技", "tech", "软件", "software", "芯片", "半导体", "semiconductor",
        "apple", "microsoft", "nvidia", "苹果", "英伟达",
        "information technology", "electronic", "computing", "cloud",
    ]):
        return "科技"
    if any(kw in combined for kw in ["房地产", "地产", "real estate", "property", "万科", "碧桂园", "恒大", "reit"]):
        return "房地产"
    if any(kw in combined for kw in ["能源", "石油", "石化", "energy", "oil", "gas", "煤炭", "电力", "petroleum", "utilities"]):
        return "能源"
    if any(kw in combined for kw in ["消费", "consumer", "食品", "饮料", "日用", "家电", "packaged food", "beverage", "household"]):
        return "消费品"
    if any(kw in combined for kw in ["制造", "机械", "汽车", "电子", "工业", "manufacturing", "industrial", "auto", "aerospace"]):
        return "制造业"
    return detect_industry(company_name)


def get_industry_benchmarks(company_name: str, industry_override: str | None = None) -> tuple[dict, str, str | None]:
    """获取公司所属行业的基准数据

    Returns: (benchmarks, bucket, raw_industry)
    """
    bucket = _normalize_industry_bucket(industry_override, company_name)
    raw = (industry_override or "").strip() or None
    return INDUSTRY_BENCHMARKS_BY_SECTOR.get(bucket, INDUSTRY_BENCHMARKS_BY_SECTOR["默认"]), bucket, raw


def _get_report_symbol_for_market(r: Report) -> tuple[str | None, str | None]:
    try:
        meta = _parse_source_meta(getattr(r, "source_meta", "{}"))
        sym = meta.get("symbol")
        mkt = meta.get("market") or getattr(r, "market", None)
        sym = (str(sym).strip() if sym is not None else None) or None
        mkt = (str(mkt).strip() if mkt is not None else None) or None
        if sym:
            return sym, mkt
    except Exception:
        pass

    try:
        if getattr(r, "company_id", None) and ":" in str(r.company_id):
            _, sym = str(r.company_id).split(":", 1)
            sym = sym.strip()
            if sym:
                return sym, getattr(r, "market", None)
    except Exception:
        pass

    return None, getattr(r, "market", None)


@st.cache_data(ttl=24 * 3600)
def _cn_sw_industry_latest_map() -> dict[str, str]:
    """Return mapping {symbol6: industry_code} using Shenwan classification history.

    AkShare endpoint: stock_industry_clf_hist_sw
    """
    disable_proxies_for_process()
    import akshare as ak

    df = ak.stock_industry_clf_hist_sw()
    if df is None or df.empty:
        return {}

    df2 = df.copy()
    try:
        df2["start_date"] = pd.to_datetime(df2["start_date"], errors="coerce")
    except Exception:
        pass
    try:
        df2 = df2.sort_values(["symbol", "start_date"]).dropna(subset=["symbol", "industry_code"])
        df2 = df2.drop_duplicates(subset=["symbol"], keep="last")
    except Exception:
        pass

    out: dict[str, str] = {}
    for _, row in df2.iterrows():
        try:
            s = str(row.get("symbol") or "").strip()
            c = str(row.get("industry_code") or "").strip()
            if s and c:
                out[s] = c
        except Exception:
            continue
    return out


def _cn_symbol6(symbol: str) -> str | None:
    s = (symbol or "").strip().upper()
    if not s:
        return None
    if "." in s:
        s = s.split(".", 1)[0]
    s = s.replace("SH", "").replace("SZ", "").replace("BJ", "")
    s = "".join([ch for ch in s if ch.isdigit()])
    if len(s) == 6:
        return s
    return None


@st.cache_data(ttl=6 * 3600)
def _compute_cn_industry_benchmarks_by_sw(industry_code: str, sample_size: int = 30) -> dict:
    """Compute industry benchmarks (median) from peer statistics.

    Peers are derived from Shenwan industry_code; metrics are pulled from AkShare financial ratio endpoint.
    """
    disable_proxies_for_process()
    import akshare as ak

    ind = (industry_code or "").strip()
    if not ind:
        return {}

    mp = _cn_sw_industry_latest_map()
    peers = sorted([s for s, c in mp.items() if c == ind])
    if not peers:
        return {}

    peers = peers[: max(5, min(sample_size, len(peers)))]

    vals: dict[str, list[float]] = {
        "GROSS_MARGIN": [],
        "NET_MARGIN": [],
        "ROE": [],
        "ROA": [],
        "CURRENT_RATIO": [],
        "QUICK_RATIO": [],
        "DEBT_ASSET": [],
    }

    def _add(code: str, v) -> None:
        try:
            if v is None:
                return
            sv = str(v).replace(",", "").strip()
            if sv in ("", "--", "nan", "None"):
                return
            fv = float(sv)
            vals[code].append(fv)
        except Exception:
            return

    for s in peers:
        try:
            df = ak.stock_financial_analysis_indicator(symbol=s)
            if df is None or df.empty:
                continue
            row = df.iloc[0]
            _add("ROE", row.get("净资产收益率(%)"))
            _add("ROA", row.get("总资产报酬率(%)") or row.get("总资产净利率(%)"))
            _add("GROSS_MARGIN", row.get("销售毛利率(%)"))
            _add("NET_MARGIN", row.get("销售净利率(%)"))
            _add("CURRENT_RATIO", row.get("流动比率"))
            _add("QUICK_RATIO", row.get("速动比率"))
            _add("DEBT_ASSET", row.get("资产负债率(%)"))
        except Exception:
            continue

    def _median(xs: list[float]) -> float | None:
        try:
            if not xs:
                return None
            s = sorted(xs)
            n = len(s)
            if n % 2 == 1:
                return float(s[n // 2])
            return float((s[n // 2 - 1] + s[n // 2]) / 2)
        except Exception:
            return None

    tmpl = INDUSTRY_BENCHMARKS_BY_SECTOR["默认"]
    out = {}
    for code, conf in tmpl.items():
        if code not in vals:
            out[code] = dict(conf)
            continue
        med = _median(vals[code])
        out[code] = dict(conf)
        out[code]["avg"] = med
    out["_meta"] = {"source": "akshare_sw_peer_stats", "industry_code": ind, "sample_n": len(peers)}
    return out


@st.cache_data(ttl=3 * 3600)
def _compute_internal_industry_benchmarks(market: str, industry_key: str, sample_size: int = 50) -> dict:
    """Compute industry benchmarks from internal reports stored in DB.

    This is used as a stable fallback when external industry constituents are not reliably accessible.
    """
    market_norm = normalize_market(market)
    key = (industry_key or "").strip()
    if not key:
        return {}

    with session_scope() as s:
        reps = (
            s.execute(select(Report).where(Report.market == market_norm).order_by(Report.updated_at.desc()))
            .scalars()
            .all()
        )

    report_ids: list[str] = []
    for r in reps:
        try:
            meta = _parse_source_meta(getattr(r, "source_meta", "{}"))
            ind = meta.get("industry") or meta.get("industry_bucket")
            ind = (str(ind).strip() if ind is not None else "")
            if not ind:
                continue
            if ind == key:
                report_ids.append(r.id)
                if len(report_ids) >= sample_size:
                    break
        except Exception:
            continue

    if not report_ids:
        return {}

    codes = [
        "GROSS_MARGIN",
        "NET_MARGIN",
        "ROE",
        "ROA",
        "CURRENT_RATIO",
        "QUICK_RATIO",
        "DEBT_ASSET",
        "EQUITY_RATIO",
        "ASSET_TURNOVER",
        "INVENTORY_TURNOVER",
        "RECEIVABLE_TURNOVER",
    ]

    with session_scope() as s:
        rows = (
            s.execute(
                select(ComputedMetric.metric_code, ComputedMetric.value)
                .where(ComputedMetric.report_id.in_(report_ids), ComputedMetric.metric_code.in_(codes))
            )
            .all()
        )

    vals: dict[str, list[float]] = {c: [] for c in codes}
    for code, v in rows:
        try:
            if v is None:
                continue
            fv = float(v)
            if pd.isna(fv):
                continue
            vals[str(code)].append(fv)
        except Exception:
            continue

    def _median(xs: list[float]) -> float | None:
        try:
            if not xs:
                return None
            s2 = sorted(xs)
            n = len(s2)
            if n % 2 == 1:
                return float(s2[n // 2])
            return float((s2[n // 2 - 1] + s2[n // 2]) / 2)
        except Exception:
            return None

    tmpl = INDUSTRY_BENCHMARKS_BY_SECTOR["默认"]
    out = {}
    for code, conf in tmpl.items():
        out[code] = dict(conf)
        if code in vals:
            out[code]["avg"] = _median(vals[code])
    out["_meta"] = {"source": "internal_peer_stats", "industry": key, "sample_n": len(report_ids)}
    return out

# 保留旧变量名以兼容
INDUSTRY_BENCHMARKS = INDUSTRY_BENCHMARKS_BY_SECTOR["默认"]

METRIC_NAMES = {
    "GROSS_MARGIN": "毛利率",
    "NET_MARGIN": "净利率",
    "ROE": "ROE",
    "ROA": "ROA",
    "CURRENT_RATIO": "流动比率",
    "QUICK_RATIO": "速动比率",
    "DEBT_ASSET": "资产负债率",
    "EQUITY_RATIO": "产权比率",
    "INVENTORY_TURNOVER": "存货周转率",
    "RECEIVABLE_TURNOVER": "应收账款周转率",
    "ASSET_TURNOVER": "总资产周转率",
    "REVENUE_GROWTH": "营收增长率",
    "PROFIT_GROWTH": "净利润增长率",
    "ASSET_GROWTH": "资产增长率",
}


def main() -> None:
    st.set_page_config(page_title="分析报告", page_icon="📋", layout="wide")
    inject_css()
    init_db()

    with st.sidebar:
        render_sidebar_nav()

    # 移动端导航栏
    render_mobile_nav(title="分析报告", show_back=True, back_url="app.py")

    # 如果有选中的报告，显示详情
    if st.session_state.get("active_report_id"):
        _show_report_detail(st.session_state["active_report_id"])
        return

    # 报告列表页
    col_title, col_btn = st.columns([4, 1])
    with col_title:
        st.markdown('<div class="page-title">分析报告</div>', unsafe_allow_html=True)
        st.markdown('<div class="page-desc">查看和管理您的财务分析报告</div>', unsafe_allow_html=True)
    with col_btn:
        if st.button("📤 上传新报表", type="primary"):
            st.switch_page("pages/2_上传报表.py")

    q = st.text_input("🔍", placeholder="搜索公司名称或文件名...", label_visibility="collapsed")

    st.markdown("<br>", unsafe_allow_html=True)

    reports = list_reports(limit=50)
    if q.strip():
        reports = [r for r in reports if q.strip().lower() in r.report_name.lower()]

    if not reports:
        st.info("暂无报告，点击右上角「上传新报表」开始")
        return

    for r in reports:
        status_map = {
            "done": ("success", "已完成"),
            "running": ("warning", "分析中"),
            "failed": ("danger", "失败"),
            "pending": ("pending", "待识别"),
        }
        s, t = status_map.get(r.status, ("pending", "待识别"))

        col1, col2 = st.columns([6, 1])
        with col1:
            st.markdown(f'''
            <div class="report-item">
                <div class="report-icon">📄</div>
                <div class="report-info">
                    <div class="report-title">{r.report_name} {badge(t, s)}</div>
                    <div class="report-meta">📁 {r.source_type} · 📅 {r.period_end}</div>
                </div>
                <div class="report-arrow">›</div>
            </div>
            ''', unsafe_allow_html=True)
        with col2:
            if st.button("→", key=f"view_{r.id}"):
                st.session_state["active_report_id"] = r.id
                st.rerun()


def _show_report_detail(report_id: str) -> None:
    r = get_report(report_id)
    if not r:
        st.warning("报告不存在")
        st.session_state["active_report_id"] = None
        return

    # 返回按钮
    if st.button("← 返回报告列表"):
        st.session_state["active_report_id"] = None
        st.rerun()

    # 标题和状态信息
    status_map = {
        "done": ("success", "已完成"),
        "running": ("warning", "分析中"),
        "failed": ("danger", "失败"),
        "pending": ("pending", "待识别"),
    }
    s, t = status_map.get(r.status, ("pending", "待识别"))

    # 解析报告期
    period_text = r.period_end or "未知"
    period_type_text = "季度" if r.period_type == "quarter" else "年度"
    # 尝试解析年份
    try:
        if period_text and len(period_text) >= 4:
            year = period_text[:4]
            period_display = f"{year}年{period_type_text}"
        else:
            period_display = period_type_text
    except:
        period_display = period_type_text

    st.markdown(f'''
    <div style="margin-bottom:1.5rem;">
        <div style="display:flex;align-items:center;gap:1rem;margin-bottom:0.75rem;">
            <h2 style="margin:0;font-size:1.5rem;font-weight:600;color:#1a1a2e;">{r.report_name}</h2>
            <span style="background:#e3f2fd;color:#1976d2;padding:0.25rem 0.75rem;border-radius:4px;font-size:0.875rem;font-weight:500;">{period_display}</span>
        </div>
        <div style="display:flex;gap:2rem;flex-wrap:wrap;background:#f8f9fa;padding:0.75rem 1rem;border-radius:8px;border:1px solid #eee;">
            <div><span style="color:#666;font-size:0.875rem;">来源</span> <span style="font-weight:500;color:#1a1a2e;margin-left:0.5rem;">{r.source_type}</span></div>
            <div><span style="color:#666;font-size:0.875rem;">状态</span> <span style="margin-left:0.5rem;">{badge(t, s)}</span></div>
            <div><span style="color:#666;font-size:0.875rem;">报告期</span> <span style="font-weight:500;color:#1a1a2e;margin-left:0.5rem;">{period_text}</span></div>
        </div>
    </div>
    ''', unsafe_allow_html=True)

    # 导出 PDF（放在详情页顶部，便于用户查找）
    metrics_for_export = _load_metrics(r.id)
    alerts_for_export = _load_alerts(r.id)
    deep_ai = st.session_state.get(f"deep_ai_analysis:{r.id}")
    try:
        pdf_bytes = _build_report_pdf_bytes(r, metrics_for_export, alerts_for_export, deep_ai)
    except Exception:
        pdf_bytes = None

    with st.expander("导出报告", expanded=False):
        if pdf_bytes:
            safe_name = (r.report_name or "report").replace("/", "-").replace("\\", "-")
            filename = f"{safe_name}-{(r.period_end or 'period')}.pdf"
            st.download_button(
                "📄 下载 PDF 报告",
                data=pdf_bytes,
                file_name=filename,
                mime="application/pdf",
                use_container_width=True,
            )
        else:
            st.info("当前环境尚未能生成 PDF（请确认已安装 reportlab 依赖后重试）。")

    if r.error_message:
        st.error(r.error_message)

    source_meta = _parse_source_meta(r.source_meta)

    # 分析按钮 - 更紧凑的布局
    can_run_ashare = bool(r.company_id) and normalize_market(r.market or "CN") == "CN"
    has_pdf = source_meta.get("upload_filetype") == "pdf"

    if has_pdf and source_meta.get("upload_company_name") == "待识别":
        pdf_path = source_meta.get("upload_saved_path")
        upload_filename = source_meta.get("upload_filename")
        if pdf_path:
            detected_name = _detect_company_name_cached(str(pdf_path))
            current_name = r.report_name.split(" - ")[0] if " - " in r.report_name else r.report_name
            if detected_name and detected_name != current_name:
                st.warning(f"检测到公司名称可能识别错误：当前为「{current_name}」，建议修正为「{detected_name}」")
                if st.button(f"✅ 修正公司名称为 {detected_name}", key=f"fix_company_{r.id}", type="primary"):
                    with session_scope() as s:
                        rr = s.get(Report, r.id)
                        if rr:
                            rr.report_name = f"{detected_name} - {upload_filename}" if upload_filename else detected_name
                            rr.company_id = detected_name
                            rr.updated_at = int(time.time())
                    st.rerun()

    if can_run_ashare or has_pdf:
        cols = st.columns(2 if can_run_ashare and has_pdf else 1)
        col_idx = 0

        if can_run_ashare:
            with cols[col_idx]:
                if st.button("🔄 拉取 A 股数据并分析", type="primary", use_container_width=True):
                    with st.spinner("正在从东方财富拉取财报数据并计算指标..."):
                        try:
                            ingest_and_analyze_a_share(r.id)
                            st.success("✅ A股数据拉取并分析完成！")
                        except Exception as e:
                            update_report_status(r.id, "failed", error_message=str(e))
                            st.error(f"失败：{e}")
                    st.rerun()
            col_idx += 1

        if has_pdf:
            with cols[col_idx] if col_idx < len(cols) else cols[0]:
                if st.button("📊 分析 PDF 报表", type="primary", use_container_width=True):
                    with st.spinner("正在提取并分析 PDF 数据..."):
                        try:
                            _analyze_pdf_report(r.id, source_meta.get("upload_saved_path", ""))
                            st.success("✅ PDF 分析完成！")
                        except Exception as e:
                            update_report_status(r.id, "failed", error_message=str(e))
                            st.error(f"分析失败：{e}")
                    st.rerun()

        # A股数据说明
        if can_run_ashare:
            st.caption("💡 A股数据来源：东方财富网，包含利润表、资产负债表、现金流量表等完整财务数据")

    # Tab 切换
    tab0, tab1, tab2, tab3, tab4, tab5 = st.tabs(["专业报告", "概览", "财务指标", "风险分析", "机会识别", "AI 洞察"])

    metrics = _load_metrics(r.id)
    alerts = _load_alerts(r.id)

    with tab0:
        _render_professional_report(r, metrics, alerts)

    with tab1:
        _render_overview(r, metrics, alerts)

    with tab2:
        company_name = r.report_name.split(" - ")[0] if " - " in r.report_name else r.report_name
        _render_financial_metrics(metrics, company_name)

    with tab3:
        _render_risk_analysis(alerts)

    with tab4:
        _render_opportunities(metrics)

    with tab5:
        _render_ai_insights(r, metrics, alerts)


def _parse_source_meta(source_meta: str) -> dict:
    try:
        return json.loads(source_meta or "{}")
    except Exception:
        return {}


def _get_report_industry(r: Report) -> tuple[str | None, str | None]:
    """Return (industry_raw, industry_bucket)"""
    meta = _parse_source_meta(getattr(r, "source_meta", "{}"))
    raw = meta.get("industry")
    bucket = meta.get("industry_bucket")
    raw = (str(raw).strip() if raw is not None else None) or None
    bucket = (str(bucket).strip() if bucket is not None else None) or None
    return raw, bucket


def _load_statement_items(report_id: str, period_end: str) -> dict[str, float | None]:
    with session_scope() as s:
        stmt = select(StatementItem).where(StatementItem.report_id == report_id, StatementItem.period_end == period_end)
        rows = s.execute(stmt).scalars().all()
        return {r.standard_item_code: r.value for r in rows}


def _get_financial_overview(r: Report) -> dict:
    meta = _parse_source_meta(getattr(r, "source_meta", "{}"))

    if isinstance(meta.get("financial_overview"), dict):
        return meta.get("financial_overview") or {}

    if isinstance(meta.get("extract_diag"), dict):
        diag = meta.get("extract_diag") or {}
        return {
            "period_end": diag.get("report_period") or getattr(r, "period_end", None),
            "currency": "CNY",
            "unit": "1e8",
            "revenue": diag.get("revenue"),
            "net_profit": diag.get("net_profit"),
            "total_assets": diag.get("total_assets"),
            "total_liabilities": diag.get("total_liabilities"),
            "total_equity": diag.get("total_equity"),
            "operating_cash_flow": None,
            "current_assets": diag.get("current_assets"),
            "current_liabilities": diag.get("current_liabilities"),
        }

    market = normalize_market(getattr(r, "market", "") or "")
    if market == "CN":
        pe = getattr(r, "period_end", None)
        if pe:
            items = _load_statement_items(r.id, pe)
            if items:
                return {
                    "period_end": pe,
                    "currency": "CNY",
                    "unit": "raw",
                    "revenue": items.get("IS.REVENUE"),
                    "net_profit": items.get("IS.NET_PROFIT"),
                    "total_assets": items.get("BS.ASSET_TOTAL"),
                    "total_liabilities": items.get("BS.LIAB_TOTAL"),
                    "total_equity": items.get("BS.EQUITY_TOTAL"),
                    "operating_cash_flow": items.get("CF.CFO"),
                    "current_assets": items.get("BS.CA_TOTAL"),
                    "current_liabilities": items.get("BS.CL_TOTAL"),
                }

    return {}


def _fmt_amount(v: float | None, *, currency: str, unit: str) -> str:
    if v is None:
        return "N/A"
    try:
        fv = float(v)
    except Exception:
        return "N/A"

    if unit == "1e8":
        if currency == "USD":
            return f"{fv:,.2f} 亿美元"
        if currency == "HKD":
            return f"{fv:,.2f} 亿港元"
        return f"{fv:,.2f} 亿元"

    if currency == "USD":
        return f"{fv:,.2f} USD"
    if currency == "HKD":
        return f"{fv:,.2f} HKD"
    return f"{fv:,.2f} CNY"


def _metric_to_value_map(metrics: pd.DataFrame) -> dict[str, float]:
    out: dict[str, float] = {}
    if metrics is None or metrics.empty:
        return out
    for _, row in metrics.iterrows():
        code = row.get("metric_code")
        if code and code not in out:
            out[str(code)] = row.get("value")
    return out


def _assumed_range_text(avg: float | None, unit: str, *, reverse: bool) -> str:
    if avg is None:
        return "不适用"
    try:
        a = float(avg)
    except Exception:
        return "N/A"

    if unit == "%":
        lo = max(0.0, a - 10.0)
        hi = min(100.0, a + 10.0)
        return f"{lo:.0f}% - {hi:.0f}%"

    if a == 0:
        return "N/A"
    width = max(0.1, abs(a) * 0.25)
    lo = a - width
    hi = a + width
    if reverse:
        return f"{hi:.2f} - {lo:.2f}"
    return f"{lo:.2f} - {hi:.2f}"


def _interpret_metric(metric_code: str, value: float | None, bench: dict) -> str:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return "数据不足，建议补充财务报表或更完整的报告期数据。"

    avg = bench.get("avg")
    unit = bench.get("unit")
    reverse = bench.get("reverse", False)
    name = bench.get("name")

    if avg is None:
        return f"{name}在该行业通常不作为核心评估指标，建议结合行业特征与其他指标综合判断。"

    try:
        v = float(value)
        a = float(avg)
    except Exception:
        return "数值口径不明确，建议核对数据来源与单位后再解读。"

    better = (v < a) if reverse else (v > a)
    if unit == "%":
        if better:
            return "指标优于行业基准，反映经营质量相对更强；建议关注该优势是否可持续（成本、价格、竞争格局）。"
        return "指标低于行业基准，可能存在结构性短板；建议拆解驱动因素（价格/成本/费用/资产效率）并制定改善路径。"

    if better:
        return "指标优于行业基准，体现运营或资本结构更健康；建议保持优势并监控边际变化。"
    return "指标弱于行业基准，提示效率或结构问题；建议结合现金流与周转情况进行针对性优化。"


def _build_exec_summary(metric_dict: dict[str, float], overview: dict) -> list[str]:
    pts: list[str] = []

    gm = metric_dict.get("GROSS_MARGIN")
    nm = metric_dict.get("NET_MARGIN")
    roe = metric_dict.get("ROE")
    da = metric_dict.get("DEBT_ASSET")
    cr = metric_dict.get("CURRENT_RATIO")
    at = metric_dict.get("ASSET_TURNOVER")

    if gm is not None:
        pts.append(f"盈利能力：毛利率 {gm:.2f}%")
    if nm is not None:
        pts.append(f"盈利质量：净利率 {nm:.2f}%")
    if roe is not None:
        pts.append(f"股东回报：ROE {roe:.2f}%")
    if da is not None:
        pts.append(f"杠杆水平：资产负债率 {da:.2f}%")
    if cr is not None:
        pts.append(f"短期偿债：流动比率 {cr:.2f}")
    if at is not None:
        pts.append(f"资产效率：总资产周转率 {at:.2f}")

    currency = str(overview.get("currency") or "CNY")
    unit = str(overview.get("unit") or "raw")
    rev = overview.get("revenue")
    np = overview.get("net_profit")
    if rev is not None:
        pts.append(f"规模：营收 {_fmt_amount(rev, currency=currency, unit=unit)}")
    if np is not None:
        pts.append(f"利润：净利润 {_fmt_amount(np, currency=currency, unit=unit)}")

    if not pts:
        pts.append("数据不足，建议补充完整财务报表或更丰富的历史报告期数据。")

    return pts[:6]


def _render_professional_report(r: Report, metrics: pd.DataFrame, alerts: pd.DataFrame) -> None:
    metric_dict = _metric_to_value_map(metrics)
    overview = _get_financial_overview(r)
    company_name = r.report_name.split(" - ")[0] if " - " in r.report_name else r.report_name
    industry_raw, industry_bucket = _get_report_industry(r)
    benchmarks, industry_bucket2, industry_raw2 = get_industry_benchmarks(company_name, industry_override=industry_raw or industry_bucket)
    industry_bucket = industry_bucket or industry_bucket2
    industry_raw = industry_raw or industry_raw2

    st.markdown(f"### {company_name} 专业财务分析报告")
    sub = []
    if getattr(r, "period_end", None):
        sub.append(f"报告期：{r.period_end}")
    if getattr(r, "market", None):
        sub.append(f"市场：{r.market}")
    if industry_raw and industry_bucket and industry_raw != industry_bucket:
        sub.append(f"行业：{industry_raw}（基准口径：{industry_bucket}）")
    elif industry_bucket:
        sub.append(f"行业：{industry_bucket}")
    if sub:
        st.caption(" · ".join(sub))

    st.markdown("#### 1. 执行摘要")
    for p in _build_exec_summary(metric_dict, overview):
        st.markdown(f"- {p}")

    st.markdown("#### 2. 公司财务概况")
    if overview:
        currency = str(overview.get("currency") or "CNY")
        unit = str(overview.get("unit") or "raw")
        rows = [
            ("营业收入", overview.get("revenue")),
            ("净利润", overview.get("net_profit")),
            ("总资产", overview.get("total_assets")),
            ("总负债", overview.get("total_liabilities")),
            ("所有者权益", overview.get("total_equity")),
            ("经营活动现金流", overview.get("operating_cash_flow")),
        ]
        st.table(pd.DataFrame([{"财务项目": k, "金额": _fmt_amount(v, currency=currency, unit=unit)} for k, v in rows]))
    else:
        st.info("当前报告缺少关键财务科目（营收/净利/资产/负债/现金流）。建议重新拉取或上传更完整的年报 PDF。")

    st.markdown("#### 3. 详细指标分析")
    detail_rows = []
    for code in [
        "GROSS_MARGIN",
        "NET_MARGIN",
        "ROE",
        "ROA",
        "CURRENT_RATIO",
        "QUICK_RATIO",
        "DEBT_ASSET",
        "EQUITY_RATIO",
        "ASSET_TURNOVER",
        "INVENTORY_TURNOVER",
        "RECEIVABLE_TURNOVER",
    ]:
        bench = (benchmarks or {}).get(code)
        if not bench:
            continue
        val = metric_dict.get(code)
        unit = bench.get("unit")
        vstr = "N/A" if val is None else (f"{float(val):.2f}{unit}" if unit == "%" else f"{float(val):.2f}")
        detail_rows.append(
            {
                "指标": bench.get("name"),
                "数值": vstr,
                "行业区间(假设)": _assumed_range_text(bench.get("avg"), unit or "", reverse=bool(bench.get("reverse", False))),
                "分析解读": _interpret_metric(code, val, bench),
            }
        )
    if detail_rows:
        st.dataframe(pd.DataFrame(detail_rows), use_container_width=True)
    else:
        st.info("暂无可用指标用于详细解读。")

    st.markdown("#### 4. 风险预警")
    if alerts is None or alerts.empty:
        st.success("暂无风险预警")
    else:
        lvl_map = {"high": "高", "medium": "中", "low": "低"}
        risk_rows = []
        for _, a in alerts.iterrows():
            risk_rows.append(
                {
                    "风险项目": str(a.get("title") or ""),
                    "风险等级": lvl_map.get(str(a.get("level") or "").lower(), str(a.get("level") or "")),
                    "详细说明": str(a.get("message") or ""),
                    "风险应对建议": "建议对风险项设定量化阈值、跟踪频率和责任人，并形成闭环复盘。",
                }
            )
        st.dataframe(pd.DataFrame(risk_rows), use_container_width=True)

    st.markdown("#### 5. 总结与行动计划")
    plan = []
    if metric_dict.get("DEBT_ASSET") is not None and float(metric_dict.get("DEBT_ASSET") or 0) > 70:
        plan.append({"优先级": "1(高)", "行动项": "降低财务杠杆", "目标": "优化负债结构并降低财务费用", "负责人/部门": "财务部"})
    if metric_dict.get("ASSET_TURNOVER") is not None and float(metric_dict.get("ASSET_TURNOVER") or 0) < 0.5:
        plan.append({"优先级": "2", "行动项": "提升资产周转效率", "目标": "处置低效资产、提升产能利用率", "负责人/部门": "运营/供应链"})
    if metric_dict.get("ROE") is not None and float(metric_dict.get("ROE") or 0) < 10:
        plan.append({"优先级": "3", "行动项": "提升股东回报", "目标": "利润率/周转/杠杆三维提升ROE", "负责人/部门": "管理层"})
    if not plan:
        plan.append({"优先级": "1(高)", "行动项": "建立指标跟踪与复盘机制", "目标": "按季度跟踪核心指标与风险项", "负责人/部门": "财务部/投研"})
    st.table(pd.DataFrame(plan[:4]))

    st.markdown("#### 6. 免责声明")
    st.caption("本报告为基于公开数据与模型推断的辅助信息，不构成任何形式的投资建议或收益承诺。投资需结合个人风险承受能力并自行决策。")


def _build_report_pdf_bytes(r: Report, metrics: pd.DataFrame, alerts: pd.DataFrame, deep_ai_analysis: str | None) -> bytes:
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import getSampleStyleSheet
        from reportlab.lib.enums import TA_LEFT
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
        from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
        from reportlab.lib import colors
    except Exception as e:
        raise RuntimeError(f"reportlab_import_failed:{e}")

    def _register_cjk_font() -> str:
        # 优先使用容器内常见 CJK 字体；注册失败则退化为 Helvetica
        candidates = [
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
            "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/noto/NotoSansCJKsc-Regular.otf",
            "/usr/share/fonts/truetype/arphic/ukai.ttc",
            "/usr/share/fonts/truetype/arphic/uming.ttc",
            "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
            "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
        ]
        for fp in candidates:
            try:
                if fp and Path(fp).exists():
                    font_name = "CJKFont"
                    pdfmetrics.registerFont(TTFont(font_name, fp))
                    return font_name
            except Exception:
                continue
        return "Helvetica"

    cjk_font = _register_cjk_font()

    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=36, rightMargin=36, topMargin=36, bottomMargin=36)
    styles = getSampleStyleSheet()

    # 使用 CJK 字体，避免中文变成方块字
    try:
        styles["Title"].fontName = cjk_font
        styles["Normal"].fontName = cjk_font
        styles["Heading2"].fontName = cjk_font
        styles["Heading3"].fontName = cjk_font
        if "Italic" in styles:
            styles["Italic"].fontName = cjk_font
        styles["Normal"].alignment = TA_LEFT
    except Exception:
        pass

    story = []
    title = r.report_name or "分析报告"
    story.append(Paragraph(title, styles["Title"]))

    meta_lines = []
    if getattr(r, "source_type", None):
        meta_lines.append(f"来源：{r.source_type}")
    if getattr(r, "status", None):
        meta_lines.append(f"状态：{r.status}")
    if getattr(r, "period_end", None):
        meta_lines.append(f"报告期：{r.period_end}")
    if getattr(r, "market", None):
        meta_lines.append(f"市场：{r.market}")
    if meta_lines:
        story.append(Spacer(1, 8))
        story.append(Paragraph("<br/>".join(meta_lines), styles["Normal"]))

    story.append(Spacer(1, 12))

    # ========== 专业报告：执行摘要/财务概况/详细指标分析 ==========
    company_name = (r.report_name or "").split(" - ")[0] if " - " in (r.report_name or "") else (r.report_name or "")
    industry_raw, industry_bucket = _get_report_industry(r)
    benchmarks, _bucket, _raw = get_industry_benchmarks(company_name, industry_override=industry_raw or industry_bucket)
    overview = _get_financial_overview(r)
    metric_map = _metric_to_value_map(metrics)

    story.append(Paragraph("执行摘要", styles["Heading2"]))
    for p in _build_exec_summary(metric_map, overview):
        story.append(Paragraph(f"• {p}", styles["Normal"]))
    story.append(Spacer(1, 10))

    story.append(Paragraph("公司财务概况", styles["Heading2"]))
    if overview:
        currency = str(overview.get("currency") or "CNY")
        unit = str(overview.get("unit") or "raw")
        rows = [
            ["财务项目", "金额"],
            ["营业收入", _fmt_amount(overview.get("revenue"), currency=currency, unit=unit)],
            ["净利润", _fmt_amount(overview.get("net_profit"), currency=currency, unit=unit)],
            ["总资产", _fmt_amount(overview.get("total_assets"), currency=currency, unit=unit)],
            ["总负债", _fmt_amount(overview.get("total_liabilities"), currency=currency, unit=unit)],
            ["所有者权益", _fmt_amount(overview.get("total_equity"), currency=currency, unit=unit)],
            ["经营活动现金流", _fmt_amount(overview.get("operating_cash_flow"), currency=currency, unit=unit)],
        ]
        tbl = Table(rows, repeatRows=1, hAlign="LEFT", colWidths=[160, 260])
        tbl.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f0f2f6")),
                    ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#d0d7de")),
                    ("FONTNAME", (0, 0), (-1, -1), cjk_font),
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ]
            )
        )
        story.append(tbl)
    else:
        story.append(Paragraph("缺少关键财务科目，建议补充更完整的数据源。", styles["Normal"]))

    story.append(Spacer(1, 12))

    story.append(Paragraph("详细指标分析", styles["Heading2"]))
    if metrics is None or metrics.empty:
        story.append(Paragraph("暂无指标数据", styles["Normal"]))
    else:
        detail = [["指标", "数值", "行业区间(假设)", "分析解读"]]
        for code in [
            "GROSS_MARGIN",
            "NET_MARGIN",
            "ROE",
            "ROA",
            "CURRENT_RATIO",
            "QUICK_RATIO",
            "DEBT_ASSET",
            "EQUITY_RATIO",
            "ASSET_TURNOVER",
            "INVENTORY_TURNOVER",
            "RECEIVABLE_TURNOVER",
        ]:
            bench = (benchmarks or {}).get(code)
            if not bench:
                continue
            val = metric_map.get(code)
            unit = bench.get("unit") or ""
            vstr = "N/A" if val is None else (f"{float(val):.2f}{unit}" if unit == "%" else f"{float(val):.2f}")
            rng = _assumed_range_text(bench.get("avg"), unit, reverse=bool(bench.get("reverse", False)))
            itp = _interpret_metric(code, val, bench)
            detail.append([str(bench.get("name") or code), vstr, rng, itp])

        tbl = Table(detail, repeatRows=1, hAlign="LEFT", colWidths=[90, 70, 90, 230])
        tbl.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f0f2f6")),
                    ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#d0d7de")),
                    ("FONTNAME", (0, 0), (-1, -1), cjk_font),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ]
            )
        )
        story.append(tbl)

    story.append(Spacer(1, 12))

    # 风险预警
    story.append(Paragraph("风险预警", styles["Heading2"]))
    if alerts is None or alerts.empty:
        story.append(Paragraph("暂无风险预警", styles["Normal"]))
    else:
        for _, a in alerts.iterrows():
            lvl = str(a.get("level") or "")
            ttl = str(a.get("title") or "")
            msg = str(a.get("message") or "")
            evd = str(a.get("evidence") or "")
            story.append(Paragraph(f"[{lvl}] {ttl}", styles["Heading3"]))
            story.append(Paragraph(msg.replace("\n", "<br/>") or "-", styles["Normal"]))
            if evd:
                story.append(Paragraph(f"证据：{evd}", styles["Italic"]))
            story.append(Spacer(1, 6))

    story.append(Spacer(1, 12))

    # AI 深度分析（如果用户已经生成过）
    if deep_ai_analysis:
        story.append(Paragraph("AI 深度分析", styles["Heading2"]))
        story.append(Paragraph(str(deep_ai_analysis).replace("\n", "<br/>")[:20000], styles["Normal"]))

    doc.build(story)
    return buf.getvalue()


def _extract_company_name_from_pdf(pdf_path: str) -> str | None:
    """从 PDF 中提取公司名称"""
    try:
        import re

        first_text = extract_pdf_text(pdf_path, max_pages=2, max_chars=12000) or ""
        full_text = extract_pdf_text(pdf_path, max_pages=8, max_chars=30000) or ""
        if not first_text and not full_text:
            return None

        bank_names = {
            "平安银行",
            "招商银行",
            "工商银行",
            "建设银行",
            "中国银行",
            "农业银行",
            "交通银行",
            "兴业银行",
            "浦发银行",
            "民生银行",
            "光大银行",
            "华夏银行",
            "中信银行",
        }
        liquor_names = {"五粮液", "茅台", "泸州老窖", "洋河", "汾酒", "古井贡", "剑南春", "郎酒", "水井坊", "舍得"}
        insurance_names = {"中国平安", "中国人寿", "中国太保", "新华保险", "中国人保", "泰康", "友邦"}

        def _clean_name(s: str) -> str:
            s = (s or "").strip()
            s = re.sub(r"[\s\u3000]+", "", s)
            s = re.sub(r"(年度报告|年报|财务报表|财务报告|报告|摘要|正文|全文)$", "", s)
            s = s.strip("-—_·•:：")
            return s

        def _score(name: str, filename_hint: str | None) -> int:
            n = _clean_name(name)
            if not n or len(n) < 2 or len(n) > 30:
                return -10
            score = 0
            if filename_hint and n in filename_hint:
                score += 10
            c1 = first_text.count(n)
            c2 = full_text.count(n)
            if c1:
                score += 6 + min(c1, 6)
            if c2:
                score += min(c2, 10)
            if n in bank_names and not (filename_hint and n in filename_hint):
                score -= 3
            return score

        filename_hint = None
        mfn = re.search(r"/([^/]+)$", str(pdf_path))
        if mfn:
            raw_fn = mfn.group(1)
            raw_fn = re.sub(r"\.(pdf|PDF)$", "", raw_fn)
            raw_fn = raw_fn.replace("_", " ").replace("-", " ")
            raw_fn = re.sub(r"\b(20\d{2})\b", " ", raw_fn)
            raw_fn = re.sub(r"(年度报告|年报|财务报表|财务报告|报告|摘要)", " ", raw_fn)
            filename_hint = _clean_name(raw_fn)

        candidates: set[str] = set()

        if filename_hint:
            for n in liquor_names | bank_names | insurance_names:
                if n in filename_hint:
                    candidates.add(n)
            if len(filename_hint) >= 2 and len(filename_hint) <= 30:
                candidates.add(filename_hint)

        for n in liquor_names | bank_names | insurance_names:
            if n in first_text or n in full_text:
                candidates.add(n)

        for m in re.finditer(r"(?:公司名称|股票简称|发行人)[:：\s]*([^\n\r]{2,40})", first_text):
            cand = _clean_name(m.group(1))
            if cand:
                candidates.add(cand)

        for m in re.finditer(r"([^\s]{2,30}(?:集团股份有限公司|股份有限公司|有限公司|集团|控股))", first_text):
            cand = _clean_name(m.group(1))
            if cand:
                candidates.add(cand)

        best_name = None
        best_score = -999
        for cand in candidates:
            s = _score(cand, filename_hint)
            if s > best_score:
                best_score = s
                best_name = _clean_name(cand)

        if best_name and best_score >= 6:
            return best_name
        return None
    except Exception:
        return None


@st.cache_data(ttl=24 * 3600)
def _detect_company_name_cached(pdf_path: str) -> str | None:
    return _extract_company_name_from_pdf(pdf_path)


def _analyze_pdf_report(report_id: str, pdf_path: str) -> None:
    """分析 PDF 报表并保存指标"""
    if not pdf_path:
        raise ValueError("PDF 文件路径为空")

    # 提取财务数据
    try:
        extracted = extract_financials_from_pdf(pdf_path, use_ai=True, force_ai=True)
    except Exception as e:
        msg = str(e)
        if "ai_required_no_api_key" in msg or "missing_api_key" in msg:
            raise ValueError(
                "当前已设置为强制 AI 抽取，但未配置 DASHSCOPE_API_KEY。\n\n"
                "请在部署环境/本地运行环境配置该环境变量后重试。"
            )
        if "qwen_http_401" in msg or "qwen_http_403" in msg:
            raise ValueError("AI 抽取失败：鉴权失败（API Key 无效或无权限）。请检查 DASHSCOPE_API_KEY 是否正确，以及 DashScope 权限是否开通。")
        if "qwen_http_429" in msg:
            raise ValueError("AI 抽取失败：请求过于频繁（429 限流）。请稍后再试，或降低并发/增加缓存。")
        if "qwen_http_" in msg:
            raise ValueError(f"AI 抽取失败：DashScope 返回错误：{msg}")
        if "qwen_json_parse_error" in msg:
            raise ValueError("AI 抽取失败：模型返回的内容不是合法 JSON（可能被安全策略/内容截断影响）。请稍后重试，或更换/缩短 PDF 文本。")
        if "ai_extraction_empty" in msg:
            raise ValueError("AI 抽取失败：模型未返回任何可解析字段。可能是 PDF 文本提取为空/乱码/扫描件。建议换原版 PDF 或先转文字版。")
        if "qwen_exception" in msg:
            raise ValueError(f"AI 抽取失败：{msg}")
        raise

    # 计算指标
    metrics = compute_metrics_from_extracted(extracted)

    if not metrics:
        raise ValueError(
            "无法从 PDF 中提取有效的财务数据。\n\n"
            "可能的原因：\n"
            "1. PDF 使用了特殊字体编码，文本无法正确提取\n"
            "2. PDF 是扫描件或图片格式\n"
            "3. PDF 不包含标准的财务报表格式\n\n"
            "建议：请尝试从公司官网下载原版年报 PDF，或使用 SEC EDGAR 的 HTML 格式报告"
        )

    # 保存指标到数据库
    with session_scope() as s:
        r = s.get(Report, report_id)
        if not r:
            raise ValueError("报告不存在")

        # 自动识别公司名称
        meta = _parse_source_meta(r.source_meta)
        if r.report_name.startswith("待识别") or meta.get("upload_company_name") == "待识别":
            detected_name = _extract_company_name_from_pdf(pdf_path)
            if detected_name:
                upload_filename = meta.get("upload_filename")
                r.report_name = f"{detected_name} - {upload_filename}" if upload_filename else detected_name
                r.company_id = detected_name

        # 使用从 PDF 提取的报告期，如果没有则使用默认值
        if extracted.report_period:
            period_end = extracted.report_period
            # 更新报告的 period_end
            r.period_end = period_end
        else:
            period_end = r.period_end or "2024-12-31"

        period_type = r.period_type or "annual"
        company_id = r.company_id or "unknown"

        # 删除旧指标
        for old in s.execute(select(ComputedMetric).where(ComputedMetric.report_id == report_id)).scalars().all():
            s.delete(old)

        # 删除旧预警
        for old in s.execute(select(Alert).where(Alert.report_id == report_id)).scalars().all():
            s.delete(old)

        # 保存新指标
        for code, value in metrics.items():
            if value is not None:
                m = ComputedMetric(
                    id=f"{report_id}:{code}:{period_end}",
                    report_id=report_id,
                    company_id=company_id,
                    period_end=period_end,
                    period_type=period_type,
                    metric_code=code,
                    metric_name=METRIC_NAMES.get(code, code),
                    value=value,
                    unit="%" if code in ["GROSS_MARGIN", "NET_MARGIN", "ROE", "ROA", "DEBT_ASSET"] else "",
                    calc_trace="extracted from PDF",
                )
                s.add(m)

        # 生成风险预警
        _generate_alerts_in_session(s, report_id, company_id, period_end, period_type, metrics)

        r.status = "done"
        r.updated_at = int(time.time())

        # 保存提取诊断信息（不影响指标分析）
        try:
            meta = _parse_source_meta(r.source_meta)
            meta["extract_diag"] = {
                "ai_enhanced": bool(getattr(extracted, "_ai_enhanced", False)),
                "ai_keys": getattr(extracted, "_ai_keys", None),
                "report_period": extracted.report_period,
                "revenue": extracted.revenue,
                "net_profit": extracted.net_profit,
                "total_assets": extracted.total_assets,
                "total_liabilities": extracted.total_liabilities,
                "total_equity": extracted.total_equity,
                "current_assets": extracted.current_assets,
                "current_liabilities": extracted.current_liabilities,
                "gross_profit": extracted.gross_profit,
                "cost": extracted.cost,
                "gross_margin_direct": extracted.gross_margin_direct,
                "net_margin_direct": extracted.net_margin_direct,
                "roe_direct": extracted.roe_direct,
                "roa_direct": extracted.roa_direct,
                "current_ratio_direct": extracted.current_ratio_direct,
                "debt_ratio_direct": extracted.debt_ratio_direct,
            }
            r.source_meta = json.dumps(meta, ensure_ascii=False)
        except Exception:
            pass


def _generate_alerts_in_session(session, report_id: str, company_id: str, period_end: str, period_type: str, metrics: dict) -> None:
    """根据指标生成风险预警（在已有 session 中）- 增强版"""
    alerts = []

    current_ratio = metrics.get("CURRENT_RATIO")
    quick_ratio = metrics.get("QUICK_RATIO")
    debt_asset = metrics.get("DEBT_ASSET")
    gross_margin = metrics.get("GROSS_MARGIN")
    net_margin = metrics.get("NET_MARGIN")
    roe = metrics.get("ROE")
    roa = metrics.get("ROA")
    inventory_turnover = metrics.get("INVENTORY_TURNOVER")
    receivable_turnover = metrics.get("RECEIVABLE_TURNOVER")
    asset_turnover = metrics.get("ASSET_TURNOVER")

    # ========== 流动性资产利用效率风险 ==========
    if current_ratio and current_ratio > 3:
        alerts.append(Alert(
            id=f"{report_id}:high_liquidity",
            report_id=report_id,
            company_id=company_id,
            period_end=period_end,
            period_type=period_type,
            alert_code="HIGH_LIQUIDITY",
            level="medium",
            title="流动性资产利用效率低下",
            message=f"流动比率高达 {current_ratio:.2f}，远超安全范围（通常2.0左右），表明公司持有大量现金和类现金资产。这虽然提供了极高的偿债保障，但也意味着大量资金未被有效投入到高回报的增长项目或资本支出中，存在资金闲置成本。",
            evidence=f"CURRENT_RATIO={current_ratio:.2f}",
        ))

    # ========== 流动比率过低风险 ==========
    if current_ratio and current_ratio < 1:
        alerts.append(Alert(
            id=f"{report_id}:low_current",
            report_id=report_id,
            company_id=company_id,
            period_end=period_end,
            period_type=period_type,
            alert_code="LOW_CURRENT",
            level="high",
            title="短期偿债能力不足",
            message=f"流动比率为 {current_ratio:.2f}，低于1.0警戒线，表明流动资产不足以覆盖流动负债，短期偿债压力较大，需关注现金流管理和短期融资安排。",
            evidence=f"CURRENT_RATIO={current_ratio:.2f}",
        ))

    # ========== 资产负债率风险 ==========
    if debt_asset and debt_asset > 70:
        alerts.append(Alert(
            id=f"{report_id}:high_debt",
            report_id=report_id,
            company_id=company_id,
            period_end=period_end,
            period_type=period_type,
            alert_code="HIGH_DEBT",
            level="high",
            title="财务杠杆过高",
            message=f"资产负债率达到 {debt_asset:.1f}%，超过70%警戒线，财务杠杆较高。高负债率虽然可以放大股东收益，但也增加了财务风险和利息负担，在经济下行期可能面临偿债压力。",
            evidence=f"DEBT_ASSET={debt_asset:.2f}%",
        ))
    elif debt_asset and debt_asset < 20:
        # 资产负债率过低也是一种"风险"——资本效率低
        alerts.append(Alert(
            id=f"{report_id}:low_leverage",
            report_id=report_id,
            company_id=company_id,
            period_end=period_end,
            period_type=period_type,
            alert_code="LOW_LEVERAGE",
            level="low",
            title="财务杠杆利用不足",
            message=f"资产负债率仅为 {debt_asset:.1f}%，财务结构过于保守。虽然财务风险极低，但可能未能充分利用财务杠杆提升股东回报，存在资本效率优化空间。",
            evidence=f"DEBT_ASSET={debt_asset:.2f}%",
        ))

    # ========== 增长放缓及基数效应风险 ==========
    if gross_margin and gross_margin > 50 and net_margin and net_margin > 30:
        alerts.append(Alert(
            id=f"{report_id}:growth_ceiling",
            report_id=report_id,
            company_id=company_id,
            period_end=period_end,
            period_type=period_type,
            alert_code="GROWTH_CEILING",
            level="medium",
            title="增长放缓及基数效应风险",
            message=f"作为高利润率企业（毛利率{gross_margin:.1f}%，净利率{net_margin:.1f}%），未来的营收增长将面临巨大的基数效应挑战。持续保持50%以上的净利率和高ROE，需要不断开拓新市场或提高产品结构附加值，存在增长瓶颈的潜在风险。",
            evidence=f"GROSS_MARGIN={gross_margin:.2f}%, NET_MARGIN={net_margin:.2f}%",
        ))

    # ========== 盈利能力风险 ==========
    if net_margin and net_margin < 5:
        alerts.append(Alert(
            id=f"{report_id}:low_margin",
            report_id=report_id,
            company_id=company_id,
            period_end=period_end,
            period_type=period_type,
            alert_code="LOW_MARGIN",
            level="medium",
            title="盈利能力偏弱",
            message=f"净利率为 {net_margin:.1f}%，低于行业平均水平，盈利能力较弱。需关注成本控制、定价策略和产品结构优化，提升整体盈利水平。",
            evidence=f"NET_MARGIN={net_margin:.2f}%",
        ))

    # ========== ROE 风险 ==========
    if roe and roe < 8:
        alerts.append(Alert(
            id=f"{report_id}:low_roe",
            report_id=report_id,
            company_id=company_id,
            period_end=period_end,
            period_type=period_type,
            alert_code="LOW_ROE",
            level="medium",
            title="股东回报效率偏低",
            message=f"净资产收益率为 {roe:.1f}%，低于8%的基准水平，资本回报效率不高。建议优化资本结构、提升资产周转率或改善利润率以提高股东回报。",
            evidence=f"ROE={roe:.2f}%",
        ))

    # ========== 存货周转风险 ==========
    if inventory_turnover and inventory_turnover < 2:
        alerts.append(Alert(
            id=f"{report_id}:slow_inventory",
            report_id=report_id,
            company_id=company_id,
            period_end=period_end,
            period_type=period_type,
            alert_code="SLOW_INVENTORY",
            level="medium",
            title="存货周转效率偏低",
            message=f"存货周转率为 {inventory_turnover:.2f}，低于行业平均水平，存货积压风险较高。建议优化库存管理，加快存货周转，减少资金占用。",
            evidence=f"INVENTORY_TURNOVER={inventory_turnover:.2f}",
        ))

    # ========== 应收账款风险 ==========
    if receivable_turnover and receivable_turnover < 4:
        alerts.append(Alert(
            id=f"{report_id}:slow_receivable",
            report_id=report_id,
            company_id=company_id,
            period_end=period_end,
            period_type=period_type,
            alert_code="SLOW_RECEIVABLE",
            level="medium",
            title="应收账款回收效率偏低",
            message=f"应收账款周转率为 {receivable_turnover:.2f}，回款速度较慢，可能存在坏账风险。建议加强信用管理，优化客户结构，加快应收账款回收。",
            evidence=f"RECEIVABLE_TURNOVER={receivable_turnover:.2f}",
        ))

    # ========== 资产周转效率风险 ==========
    if asset_turnover and asset_turnover < 0.3:
        alerts.append(Alert(
            id=f"{report_id}:low_asset_turnover",
            report_id=report_id,
            company_id=company_id,
            period_end=period_end,
            period_type=period_type,
            alert_code="LOW_ASSET_TURNOVER",
            level="low",
            title="资产运营效率偏低",
            message=f"总资产周转率为 {asset_turnover:.2f}，资产利用效率不高。建议优化资产配置，提升资产使用效率，或考虑处置低效资产。",
            evidence=f"ASSET_TURNOVER={asset_turnover:.2f}",
        ))

    for alert in alerts:
        session.add(alert)


def _render_overview(r, metrics: pd.DataFrame, alerts: pd.DataFrame) -> None:
    """概览 Tab"""
    if metrics.empty:
        st.info("暂无指标数据，请点击上方按钮开始分析")
        return

    # 转换为字典
    metric_dict = {}
    for _, row in metrics.iterrows():
        if row["metric_code"] not in metric_dict:
            metric_dict[row["metric_code"]] = row["value"]

    # 4 个核心指标卡片
    k1, k2, k3, k4 = st.columns(4)

    with k1:
        gm = metric_dict.get("GROSS_MARGIN")
        gm_str = f"{gm:.2f}%" if gm else "N/A"
        st.markdown(f'''
        <div class="stat-card">
            <div class="stat-header">毛利率</div>
            <div class="stat-value" style="color:#1976d2;">{gm_str}</div>
            <div style="height:4px;background:linear-gradient(90deg,#1976d2 {min(gm or 0, 100)}%,#eee {min(gm or 0, 100)}%);border-radius:2px;margin-top:0.5rem;"></div>
        </div>
        ''', unsafe_allow_html=True)

    with k2:
        nm = metric_dict.get("NET_MARGIN")
        nm_str = f"{nm:.2f}%" if nm else "N/A"
        st.markdown(f'''
        <div class="stat-card">
            <div class="stat-header">净利率</div>
            <div class="stat-value" style="color:#1976d2;">{nm_str}</div>
            <div style="height:4px;background:linear-gradient(90deg,#1976d2 {min((nm or 0) * 2, 100)}%,#eee {min((nm or 0) * 2, 100)}%);border-radius:2px;margin-top:0.5rem;"></div>
        </div>
        ''', unsafe_allow_html=True)

    with k3:
        cr = metric_dict.get("CURRENT_RATIO")
        cr_str = f"{cr:.2f}" if cr else "N/A"
        health = "健康" if cr and cr > 1.5 else ("一般" if cr and cr > 1 else "偏低")
        st.markdown(f'''
        <div class="stat-card">
            <div class="stat-header">流动比率</div>
            <div class="stat-value">{cr_str}</div>
            <div class="stat-sub">{health}</div>
        </div>
        ''', unsafe_allow_html=True)

    with k4:
        da = metric_dict.get("DEBT_ASSET")
        da_str = f"{da:.2f}%" if da else "N/A"
        level = "适中" if da and da < 60 else ("偏高" if da and da < 75 else "过高")
        st.markdown(f'''
        <div class="stat-card">
            <div class="stat-header">资产负债率</div>
            <div class="stat-value">{da_str}</div>
            <div class="stat-sub">{level}</div>
        </div>
        ''', unsafe_allow_html=True)

    st.markdown("<br>", unsafe_allow_html=True)

    # 雷达图和柱状图
    col1, col2 = st.columns(2)

    with col1:
        st.markdown('''
        <div class="category-card">
            <div class="category-header">📊 财务健康雷达图</div>
            <div style="font-size:0.8125rem;color:#888;">多维度评估企业财务状况</div>
        </div>
        ''', unsafe_allow_html=True)

        # 雷达图数据 - use 8-dimension rating engine
        from rating_engine import compute_enterprise_rating
        _rating_result = compute_enterprise_rating(
            net_margin=metric_dict.get("NET_MARGIN"),
            gross_margin=metric_dict.get("GROSS_MARGIN"),
            roe=metric_dict.get("ROE"),
            roa=metric_dict.get("ROA"),
            debt_ratio=metric_dict.get("DEBT_ASSET"),
            current_ratio=metric_dict.get("CURRENT_RATIO"),
            asset_turnover=metric_dict.get("ASSET_TURNOVER"),
            inv_turnover=metric_dict.get("INVENTORY_TURNOVER"),
            recv_turnover=metric_dict.get("RECEIVABLE_TURNOVER"),
            revenue_growth=metric_dict.get("REVENUE_GROWTH"),
            profit_growth=metric_dict.get("PROFIT_GROWTH"),
            pe_ratio=metric_dict.get("PE_RATIO"),
            operating_cash_flow=metric_dict.get("OPERATING_CASH_FLOW"),
            net_profit=metric_dict.get("NET_PROFIT"),
        )
        categories = [v["label"] for v in _rating_result["dim_summary"].values()]
        values = [v["pct"] for v in _rating_result["dim_summary"].values()]
        values.append(values[0])

        fig_radar = go.Figure()
        fig_radar.add_trace(go.Scatterpolar(
            r=values,
            theta=categories + [categories[0]],
            fill='toself',
            fillcolor='rgba(25, 118, 210, 0.2)',
            line=dict(color='#1976d2', width=2),
            name='当前值'
        ))
        fig_radar.update_layout(
            polar=dict(
                radialaxis=dict(visible=True, range=[0, 100], showticklabels=False),
                angularaxis=dict(tickfont=dict(size=12))
            ),
            showlegend=False,
            height=280,
            margin=dict(l=40, r=40, t=20, b=20),
            paper_bgcolor='white',
        )
        st.plotly_chart(fig_radar, use_container_width=True)

    with col2:
        st.markdown('''
        <div class="category-card">
            <div class="category-header">📈 偿债能力指标</div>
            <div style="font-size:0.8125rem;color:#888;">与行业基准对比</div>
        </div>
        ''', unsafe_allow_html=True)

        # 柱状图数据
        bar_metrics = ['流动比率', '速动比率', '资产负债率']
        actual_values = [
            metric_dict.get("CURRENT_RATIO") or 0,
            metric_dict.get("QUICK_RATIO") or 0,
            (metric_dict.get("DEBT_ASSET") or 0) / 10,  # 缩放以便显示
        ]
        benchmark_values = [1.5, 1.0, 5.5]  # 行业基准

        fig_bar = go.Figure()
        fig_bar.add_trace(go.Bar(
            name='实际值',
            x=bar_metrics,
            y=actual_values,
            marker_color='#1976d2',
        ))
        fig_bar.add_trace(go.Bar(
            name='基准值',
            x=bar_metrics,
            y=benchmark_values,
            marker_color='#e0e0e0',
        ))
        fig_bar.update_layout(
            barmode='group',
            height=280,
            margin=dict(l=20, r=20, t=20, b=40),
            legend=dict(orientation="h", yanchor="bottom", y=-0.25, xanchor="center", x=0.5),
            paper_bgcolor='white',
            plot_bgcolor='white',
            yaxis=dict(gridcolor='#f5f5f5'),
        )
        st.plotly_chart(fig_bar, use_container_width=True)

    st.markdown("<br>", unsafe_allow_html=True)

    # AI 分析摘要
    st.markdown('''
    <div class="category-card">
        <div class="category-header">🤖 AI 分析摘要</div>
    </div>
    ''', unsafe_allow_html=True)

    # 获取公司名称
    company_name = r.report_name.split(" - ")[0] if " - " in r.report_name else r.report_name

    # 生成 AI 分析
    if st.button("🔄 生成 AI 分析", key="gen_ai"):
        with st.spinner("AI 正在分析财务数据..."):
            analysis = analyze_financials_with_qwen(company_name, metric_dict)
            st.session_state["ai_analysis"] = analysis

    if st.session_state.get("ai_analysis"):
        st.markdown(f'''
        <div style="padding:1.25rem;background:#f8f9fa;border-radius:10px;border-left:4px solid #1976d2;">
            <div style="font-size:0.9375rem;color:#1a1a2e;line-height:1.8;">
                {st.session_state["ai_analysis"]}
            </div>
        </div>
        ''', unsafe_allow_html=True)
    else:
        # 显示默认分析 - use 8-dimension rating
        _rd = _calculate_rating_details(metric_dict) if '_rating_result' not in dir() else _rating_result
        if _rd is None:
            _rd = _calculate_rating_details(metric_dict)
        health_score = round(_rd["total_score"]) if _rd else 0
        _grade = _rd.get("grade", "-") if _rd else "-"
        _rec = _rd.get("recommendation", "") if _rd else ""
        _strengths = "、".join(_rd.get("strengths", [])) if _rd else ""
        _risks = "、".join(_rd.get("risks", [])) if _rd else ""
        
        st.markdown(f'''
        <div style="padding:1.25rem;background:#f8f9fa;border-radius:10px;border:1px solid #e0e0e0;">
            <div style="font-size:1.1rem;font-weight:700;color:#1a1a2e;margin-bottom:0.5rem;">
                📊 企业综合评级：<span style="color:#1976d2;font-size:1.3rem;">{_grade}</span>
                <span style="color:#666;font-size:0.9rem;"> {health_score}/100</span>
            </div>
            <div style="font-size:0.875rem;color:#333;line-height:1.8;">
                {_rec}
            </div>
            {f'<div style="font-size:0.8125rem;color:#2e7d32;margin-top:0.5rem;">✅ 优势：{_strengths}</div>' if _strengths else ''}
            {f'<div style="font-size:0.8125rem;color:#c62828;margin-top:0.25rem;">⚠️ 风险：{_risks}</div>' if _risks else ''}
            <div style="font-size:0.8125rem;color:#666;margin-top:0.75rem;">
                💡 点击上方「生成 AI 分析」按钮获取更详细的智能分析报告。
            </div>
            </div>
        </div>
        ''', unsafe_allow_html=True)

    # 风险摘要
    if not alerts.empty:
        st.markdown("<br>", unsafe_allow_html=True)
        st.markdown('''
        <div style="font-size:1rem;font-weight:600;color:#1a1a2e;margin-bottom:0.75rem;">
            ⚠️ 风险提示
        </div>
        ''', unsafe_allow_html=True)
        high_count = len(alerts[alerts["level"] == "high"])
        medium_count = len(alerts[alerts["level"] == "medium"])
        if high_count > 0:
            st.error(f"发现 **{high_count}** 个高风险项需要立即关注")
        if medium_count > 0:
            st.warning(f"发现 **{medium_count}** 个中风险项建议改进")


def _render_financial_metrics(metrics: pd.DataFrame, company_name: str = "") -> None:
    """财务指标 Tab"""
    if metrics.empty:
        st.info("暂无指标数据，请先进行分析")
        return

    # 获取行业基准数据
    report_obj = None
    try:
        report_obj = st.session_state.get("active_report_id")
    except Exception:
        report_obj = None

    r = None
    if report_obj:
        try:
            r = get_report(report_obj)
        except Exception:
            r = None

    industry_override = None
    industry_bucket = None
    market = None
    symbol = None
    if r:
        try:
            industry_override, industry_bucket = _get_report_industry(r)
        except Exception:
            pass
        try:
            symbol, market = _get_report_symbol_for_market(r)
        except Exception:
            pass

    industry_benchmarks, bucket, raw = get_industry_benchmarks(company_name, industry_override=industry_override or industry_bucket)

    # Try to replace static avg with industry statistics
    bench_source = None
    bench_sample_n = None
    market_norm = normalize_market(market or "") if market else ""
    if market_norm == "CN" and symbol:
        try:
            s6 = _cn_symbol6(symbol)
            if s6:
                mp = _cn_sw_industry_latest_map()
                ind_code = mp.get(s6)
                if ind_code:
                    b2 = _compute_cn_industry_benchmarks_by_sw(ind_code)
                    if b2 and isinstance(b2, dict) and b2.get("_meta"):
                        industry_benchmarks = b2
                        meta2 = b2.get("_meta") or {}
                        bench_source = str(meta2.get("source") or "")
                        bench_sample_n = meta2.get("sample_n")
                        raw = f"申万行业代码 {ind_code}"
                        bucket = "申万行业统计"
        except Exception:
            pass

    if not bench_source and (industry_override or industry_bucket):
        try:
            key = str(industry_override or industry_bucket)
            b3 = _compute_internal_industry_benchmarks(market_norm or "", key)
            if b3 and isinstance(b3, dict) and b3.get("_meta"):
                industry_benchmarks = b3
                meta3 = b3.get("_meta") or {}
                bench_source = str(meta3.get("source") or "")
                bench_sample_n = meta3.get("sample_n")
        except Exception:
            pass

    # 显示行业信息
    industry_display = raw or bucket
    if raw and bucket and raw != bucket:
        industry_display = f"{raw}（基准口径：{bucket}）"
    st.markdown(f'''
    <div style="background:#e3f2fd;padding:0.5rem 1rem;border-radius:8px;margin-bottom:1rem;display:inline-block;">
        <span style="color:#1976d2;font-weight:500;">🏢 行业分类：{industry_display}</span>
    </div>
    ''', unsafe_allow_html=True)

    if bench_source:
        src_text = "行业统计"
        if bench_source == "akshare_sw_peer_stats":
            src_text = "行业统计：AkShare 申万分类同业样本"
        elif bench_source == "internal_peer_stats":
            src_text = "行业统计：本系统已分析报告样本"
        st.caption(f"{src_text} · 样本量 N={bench_sample_n}")

    # 选择报告期
    available_periods = sorted(metrics["period_end"].dropna().unique().tolist(), reverse=True)
    if available_periods:
        selected_period = st.selectbox("选择报告期", available_periods, index=0, key="metrics_period")
        sel = metrics[metrics["period_end"] == selected_period]
    else:
        sel = metrics

    # 转换为字典
    metric_dict = {}
    for _, row in sel.iterrows():
        metric_dict[row["metric_code"]] = row["value"]

    col1, col2 = st.columns(2)

    with col1:
        # 盈利能力
        st.markdown('''
        <div class="category-card">
            <div class="category-header">📈 盈利能力指标</div>
        </div>
        ''', unsafe_allow_html=True)
        _render_metric_row("GROSS_MARGIN", metric_dict, industry_benchmarks)
        _render_metric_row("NET_MARGIN", metric_dict, industry_benchmarks)
        _render_metric_row("ROE", metric_dict, industry_benchmarks)
        _render_metric_row("ROA", metric_dict, industry_benchmarks)

        st.markdown("<br>", unsafe_allow_html=True)

        # 营运能力
        st.markdown('''
        <div class="category-card">
            <div class="category-header">⚡ 营运能力指标</div>
        </div>
        ''', unsafe_allow_html=True)
        _render_metric_row("INVENTORY_TURNOVER", metric_dict, industry_benchmarks)
        _render_metric_row("RECEIVABLE_TURNOVER", metric_dict, industry_benchmarks)
        _render_metric_row("ASSET_TURNOVER", metric_dict, industry_benchmarks)

    with col2:
        # 偿债能力
        st.markdown('''
        <div class="category-card">
            <div class="category-header">📊 偿债能力指标</div>
        </div>
        ''', unsafe_allow_html=True)
        _render_metric_row("CURRENT_RATIO", metric_dict, industry_benchmarks)
        _render_metric_row("QUICK_RATIO", metric_dict, industry_benchmarks)
        _render_metric_row("DEBT_ASSET", metric_dict, industry_benchmarks)
        _render_metric_row("EQUITY_RATIO", metric_dict, industry_benchmarks)

        st.markdown("<br>", unsafe_allow_html=True)

        # 成长能力
        st.markdown('''
        <div class="category-card">
            <div class="category-header">🚀 成长能力指标</div>
        </div>
        ''', unsafe_allow_html=True)
        _render_metric_row("REVENUE_GROWTH", metric_dict, industry_benchmarks)
        _render_metric_row("PROFIT_GROWTH", metric_dict, industry_benchmarks)
        _render_metric_row("ASSET_GROWTH", metric_dict, industry_benchmarks)


def _render_metric_row(metric_code: str, metric_dict: dict, industry_benchmarks: dict = None) -> None:
    """渲染单个指标行"""
    benchmarks = industry_benchmarks or INDUSTRY_BENCHMARKS
    bench = benchmarks.get(metric_code)
    if not bench:
        return

    name = bench["name"]
    avg = bench["avg"]
    unit = bench["unit"]
    reverse = bench.get("reverse", False)

    value = metric_dict.get(metric_code)

    if value is not None and not pd.isna(value):
        value_str = f"{float(value):.2f}{unit}" if unit == "%" else f"{float(value):.2f}"
        
        # 如果行业平均值为 None，表示该指标不适用于此行业
        if avg is None:
            compare_class = ""
            compare_text = "该行业不适用"
            avg_display = "N/A"
        else:
            val = float(value)
            avg_f = float(avg)
            avg_display = f"{avg_f:.2f}{unit}" if unit == "%" else f"{avg_f:.2f}"

            def _fmt_delta(d: float) -> str:
                if unit == "%":
                    return f"{d:+.2f}pct"
                return f"{d:+.2f}"

            # 对于反向指标（如资产负债率），低于行业平均是好的
            if reverse:
                # improvement is (avg - val)
                delta = avg_f - val
                is_good = delta > 0
                if is_good:
                    compare_class = "metric-compare-up"
                    compare_text = f"↗ 优于行业均值 {_fmt_delta(delta)}"
                else:
                    compare_class = "metric-compare-down"
                    compare_text = f"↘ 劣于行业均值 {_fmt_delta(delta)}"
            else:
                delta = val - avg_f
                is_good = delta > 0
                if is_good:
                    compare_class = "metric-compare-up"
                    compare_text = f"↗ 高于行业均值 {_fmt_delta(delta)}"
                else:
                    compare_class = "metric-compare-down"
                    compare_text = f"↘ 低于行业均值 {_fmt_delta(delta)}"
    else:
        value_str = "N/A"
        compare_class = ""
        compare_text = ""
        if avg is not None:
            try:
                avg_f = float(avg)
                avg_display = f"{avg_f:.2f}{unit}" if unit == "%" else f"{avg_f:.2f}"
            except Exception:
                avg_display = f"{avg}{unit}"
        else:
            avg_display = "N/A"

    st.markdown(f'''
    <div class="metric-row">
        <div>
            <div class="metric-name">{name}</div>
            <div class="metric-benchmark">行业平均: {avg_display} · <span class="{compare_class}">{compare_text}</span></div>
        </div>
        <div class="metric-value">{value_str}</div>
    </div>
    ''', unsafe_allow_html=True)


def _render_risk_analysis(alerts: pd.DataFrame) -> None:
    """风险分析 Tab - 增强版"""
    if alerts.empty:
        st.success("✅ 未发现明显风险，财务状况整体健康")
        return

    # 风险分类映射
    risk_categories = {
        "HIGH_LIQUIDITY": "资金效率",
        "LOW_CURRENT": "偿债能力",
        "HIGH_DEBT": "财务杠杆",
        "LOW_LEVERAGE": "资本结构",
        "GROWTH_CEILING": "增长瓶颈",
        "LOW_MARGIN": "盈利能力与市场竞争",
        "LOW_ROE": "股东回报与资本效率",
        "SLOW_INVENTORY": "营运效率",
        "SLOW_RECEIVABLE": "应收管理",
        "LOW_ASSET_TURNOVER": "资产效率",
    }

    # 风险建议映射
    risk_recommendations = {
        "HIGH_LIQUIDITY": "建议管理层进行一次全面的资本结构审查，将部分超额现金通过提高分红率或进行股票回购的方式回馈股东，或投资于高回报的增长项目。",
        "LOW_CURRENT": "建议加强现金流管理，优化应收账款回收，必要时考虑短期融资安排以改善流动性。",
        "HIGH_DEBT": "建议逐步降低负债水平，优化债务结构，降低财务费用，增强抗风险能力。",
        "LOW_LEVERAGE": "建议在保持信用评级的前提下，适度增加负债以享受税盾效应，并提高现金分配率以提升股东回报。",
        "GROWTH_CEILING": "建议加大研发投入，开拓新市场或新产品线，寻找第二增长曲线，同时优化成本结构以保持竞争力。",
        "LOW_MARGIN": "加强供应链管理和生产效率（如一体化压铸技术），持续推进成本优化项目。探索高利润率服务和软件业务，以平衡硬件利润下降的风险。",
        "LOW_ROE": "建议优化资本结构、提升资产周转率或改善利润率，通过杜邦分析找出提升ROE的关键驱动因素。",
        "SLOW_INVENTORY": "建议优化库存管理系统，加快存货周转，减少资金占用，必要时考虑促销清理积压库存。",
        "SLOW_RECEIVABLE": "建议加强信用管理，优化客户结构，缩短账期，加快应收账款回收，降低坏账风险。",
        "LOW_ASSET_TURNOVER": "建议优化资产配置，提升资产使用效率，或考虑处置低效资产，聚焦核心业务。",
    }

    for _, a in alerts.iterrows():
        level_color = {"high": "#c62828", "medium": "#ef6c00", "low": "#f9a825"}.get(a["level"], "#666")
        level_text = {"high": "高风险", "medium": "中风险", "low": "低风险"}.get(a["level"], "风险")
        
        # 获取风险分类
        alert_code = a.get("evidence", "").split("=")[0] if "=" in str(a.get("evidence", "")) else ""
        # 从 title 推断分类
        category = risk_categories.get(alert_code, "")
        if not category:
            if "流动" in a["title"]:
                category = "偿债能力"
            elif "负债" in a["title"] or "杠杆" in a["title"]:
                category = "财务杠杆"
            elif "利润" in a["title"] or "盈利" in a["title"]:
                category = "盈利能力与市场竞争"
            elif "ROE" in a["title"] or "回报" in a["title"]:
                category = "股东回报与资本效率"
            elif "周转" in a["title"]:
                category = "营运效率"
            elif "增长" in a["title"]:
                category = "增长瓶颈"
            else:
                category = "综合风险"

        # 获取建议
        recommendation = risk_recommendations.get(alert_code, "")
        if not recommendation:
            recommendation = "建议密切关注该指标变化趋势，及时调整经营策略以应对潜在风险。"

        st.markdown(f'''
        <div style="padding:1.25rem;background:white;border-radius:12px;margin-bottom:1rem;border-left:4px solid {level_color};">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.75rem;">
                <div style="display:flex;align-items:center;gap:0.5rem;">
                    <span style="font-size:1.25rem;">⚠️</span>
                    <div style="font-weight:600;color:#1a1a2e;font-size:1rem;">{a['title']}</div>
                </div>
                <span style="background:{level_color}15;color:{level_color};padding:0.25rem 0.75rem;border-radius:4px;font-size:0.75rem;font-weight:500;">{category}</span>
            </div>
            <div style="font-size:0.9rem;color:#444;line-height:1.7;margin-bottom:1rem;">{a['message']}</div>
            <div style="background:#fff8e1;padding:0.875rem;border-radius:8px;">
                <div style="font-size:0.8125rem;color:#f57c00;font-weight:500;margin-bottom:0.25rem;">建议措施</div>
                <div style="font-size:0.875rem;color:#1a1a2e;line-height:1.6;">{recommendation}</div>
            </div>
        </div>
        ''', unsafe_allow_html=True)


def _render_opportunities(metrics: pd.DataFrame) -> None:
    """机会识别 Tab - 增强版"""
    if metrics.empty:
        st.info("暂无数据")
        return

    metric_dict = {}
    for _, row in metrics.iterrows():
        if row["metric_code"] not in metric_dict:
            metric_dict[row["metric_code"]] = row["value"]

    opportunities = []

    gross_margin = metric_dict.get("GROSS_MARGIN")
    net_margin = metric_dict.get("NET_MARGIN")
    roe = metric_dict.get("ROE")
    roa = metric_dict.get("ROA")
    current_ratio = metric_dict.get("CURRENT_RATIO")
    quick_ratio = metric_dict.get("QUICK_RATIO")
    debt_asset = metric_dict.get("DEBT_ASSET")
    inventory_turnover = metric_dict.get("INVENTORY_TURNOVER")
    asset_turnover = metric_dict.get("ASSET_TURNOVER")

    # ========== 优秀的资本回报率（ROE）==========
    if roe and float(roe) > 15:
        opportunities.append({
            "title": "优秀的资本回报率（ROE）",
            "category": "股东回报与资本效率 · 高潜力",
            "description": f"ROE高达{float(roe):.2f}%，表明公司利用股东资本创造利润的能力极强，远超行业平均水平。对投资者具有极高吸引力。",
            "action": "保持高效的资产周转率和适度的财务杠杆，持续优化资本结构，确保高ROE的可持续性。适时考虑股票回购或股息政策，进一步提升股东价值。",
            "icon": "💡",
        })

    # ========== 强大的经营现金流支持扩张 ==========
    if current_ratio and float(current_ratio) > 1.5 and quick_ratio and float(quick_ratio) > 1:
        opportunities.append({
            "title": "强大的经营现金流支持扩张",
            "category": "成长与市场扩张 · 高潜力",
            "description": f"流动比率{float(current_ratio):.2f}，速动比率{float(quick_ratio):.2f}，均高于安全标准。这为公司在全球范围内的超级工厂建设、新产品研发和能源业务扩张提供了坚实的内部资金基础。",
            "action": "将强大的经营现金流优先投入到高增长、高利润率的业务领域（如能源存储、AI算力服务）。利用现金流优势，快速抢占新兴市场份额。",
            "icon": "💡",
        })

    # ========== 良好的短期偿债能力 ==========
    if current_ratio and float(current_ratio) > 1.5:
        opportunities.append({
            "title": "良好的短期偿债能力",
            "category": "财务结构稳健性 · 中等潜力",
            "description": f"流动比率{float(current_ratio):.2f}，速动比率{float(quick_ratio or 0):.2f}，均远高于安全标准，表明公司短期偿债能力极强，财务弹性高。",
            "action": "在保持足够流动性的前提下，可以适度优化流动资产结构，将部分闲置现金投入到短期高收益资产中，提高资金利用效率。",
            "icon": "💡",
        })

    # ========== 优化资本结构，提高股东回报 ==========
    if debt_asset and float(debt_asset) < 40:
        opportunities.append({
            "title": "优化资本结构，提高股东回报",
            "category": "资本配置 · 高潜力",
            "description": f"资产负债率仅为{float(debt_asset):.2f}%，财务结构极为保守。公司有能力在不显著增加财务风险的前提下，适度提高财务杠杆，或通过更高的分红、回购来提高股东回报。",
            "action": "管理层应重新评估最优资本结构，考虑在保持信用评级的前提下，适度增加负债以享受税盾效应，并提高现金分配率。",
            "icon": "💡",
        })

    # ========== 高毛利率优势 ==========
    if gross_margin and float(gross_margin) > 30:
        opportunities.append({
            "title": "产品竞争力与定价能力",
            "category": "盈利能力 · 高潜力",
            "description": f"毛利率达到{float(gross_margin):.2f}%，表明公司产品具有较强的市场竞争力和定价能力。可以通过产品升级、服务增值等方式进一步提升毛利率。",
            "action": "加大对高附加值产品的研发投入，优化产品结构，提高高毛利产品占比。同时探索服务和软件业务，提升整体盈利能力。",
            "icon": "🏆",
        })

    # ========== 高净利率优势 ==========
    if net_margin and float(net_margin) > 10:
        opportunities.append({
            "title": "持续强化盈利能力护城河",
            "category": "盈利优势 · 高潜力",
            "description": f"净利率高达{float(net_margin):.2f}%，远超行业平均水平，表明公司具有强大的成本控制能力和运营效率。这种盈利能力优势是公司的核心竞争力。",
            "action": "持续投入品牌建设和产品创新，巩固市场地位，同时优化供应链管理，进一步提升运营效率。",
            "icon": "🏆",
        })

    # ========== 存货周转效率高 ==========
    if inventory_turnover and float(inventory_turnover) > 5:
        opportunities.append({
            "title": "高效的存货管理能力",
            "category": "营运效率 · 中等潜力",
            "description": f"存货周转率达到{float(inventory_turnover):.2f}，表明公司存货管理效率较高，资金占用少，运营效率优秀。",
            "action": "继续优化供应链管理，保持高效的存货周转，同时关注市场需求变化，避免因过度追求周转而影响客户满意度。",
            "icon": "⚡",
        })

    if not opportunities:
        st.info("暂未识别到明显投资机会，建议持续关注财务指标变化趋势。")
    else:
        for opp in opportunities:
            st.markdown(f'''
            <div style="padding:1.25rem;background:white;border-radius:12px;margin-bottom:1rem;border-left:4px solid #2e7d32;">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.75rem;">
                    <div style="display:flex;align-items:center;gap:0.5rem;">
                        <span style="font-size:1.25rem;">{opp["icon"]}</span>
                        <div style="font-weight:600;color:#1a1a2e;font-size:1rem;">{opp["title"]}</div>
                    </div>
                    <span style="background:#e8f5e9;color:#2e7d32;padding:0.25rem 0.75rem;border-radius:4px;font-size:0.75rem;">{opp["category"]}</span>
                </div>
                <div style="font-size:0.9rem;color:#444;line-height:1.7;margin-bottom:1rem;">{opp["description"]}</div>
                <div style="background:#f8f9fa;padding:0.875rem;border-radius:8px;">
                    <div style="font-size:0.8125rem;color:#666;font-weight:500;margin-bottom:0.25rem;">行动计划</div>
                    <div style="font-size:0.875rem;color:#1a1a2e;line-height:1.6;">{opp["action"]}</div>
                </div>
            </div>
            ''', unsafe_allow_html=True)


def _render_ai_insights(r, metrics: pd.DataFrame, alerts: pd.DataFrame) -> None:
    """AI 洞察 Tab - 增强版"""
    if metrics.empty:
        st.info("暂无数据，请先进行分析")
        return

    with st.expander("LLM 运行状态", expanded=False):
        has_key = bool(get_api_key())
        st.write(f"DASHSCOPE_API_KEY: {'已配置' if has_key else '未配置'}")

        if st.button("🔌 测试 DashScope 连通性", use_container_width=True, key=f"test_qwen_{r.id}"):
            ok, msg = test_qwen_connection()
            st.session_state[f"qwen_test_result:{r.id}"] = (ok, msg)

        res = st.session_state.get(f"qwen_test_result:{r.id}")
        if res:
            ok, msg = res
            if ok:
                st.success("✅ DashScope / Qwen 可用")
            else:
                st.error(f"❌ DashScope / Qwen 不可用：{msg}")

    metric_dict = {}
    for _, row in metrics.iterrows():
        if row["metric_code"] not in metric_dict:
            metric_dict[row["metric_code"]] = row["value"]

    gross_margin = metric_dict.get("GROSS_MARGIN")
    net_margin = metric_dict.get("NET_MARGIN")
    roe = metric_dict.get("ROE")
    roa = metric_dict.get("ROA")
    debt_asset = metric_dict.get("DEBT_ASSET")
    current_ratio = metric_dict.get("CURRENT_RATIO")
    quick_ratio = metric_dict.get("QUICK_RATIO")
    asset_turnover = metric_dict.get("ASSET_TURNOVER")
    inventory_turnover = metric_dict.get("INVENTORY_TURNOVER")

    # 获取公司名称
    company_name = r.report_name.split(" - ")[0] if " - " in r.report_name else r.report_name

    st.markdown('''
    <div class="category-card">
        <div class="category-header">🤖 专业建议</div>
        <div style="font-size:0.8125rem;color:#888;">基于 AI 深度分析的改进建议</div>
    </div>
    ''', unsafe_allow_html=True)

    # 生成专业建议 - 更加具体和可操作
    recommendations = []

    # 1. 成本结构优化
    if gross_margin and float(gross_margin) < 25:
        recommendations.append(
            f"**成本结构优化：** 实施更激进的成本削减计划，目标是将毛利率稳定在20%以上。"
            f"重点关注原材料采购、生产工艺自动化和物流效率。"
        )
    elif gross_margin and float(gross_margin) < 40:
        recommendations.append(
            f"**成本结构优化：** 当前毛利率为{float(gross_margin):.2f}%，建议持续推进成本优化项目，"
            f"探索高利润率服务和软件业务，以平衡硬件利润下降的风险。"
        )

    # 2. 服务与软件变现
    if net_margin and float(net_margin) < 15:
        recommendations.append(
            f"**服务与软件变现：** 加快FSD和软件订阅服务的商业化进程，将软件收入占比提升至总营收的更高比例，"
            f"以提高整体利润率的稳定性。"
        )

    # 3. 资本支出效率
    if asset_turnover and float(asset_turnover) < 0.8:
        recommendations.append(
            f"**资本支出效率：** 对新工厂和技术研发的投资设立更清晰的里程碑和回报预期，"
            f"确保资本支出的效率和及时性。"
        )

    # 4. 多元化战略
    if gross_margin and float(gross_margin) > 15:
        recommendations.append(
            f"**多元化战略：** 积极扩大能源存储业务的规模和市场渗透率，将其打造成新的利润增长极，"
            f"以对冲汽车业务周期性波动的风险。"
        )

    # 5. 现金流管理
    if current_ratio and float(current_ratio) > 2:
        recommendations.append(
            f"**现金流管理：** 流动比率为{float(current_ratio):.2f}，现金储备充裕。"
            f"建议将部分超额现金用于战略性投资或股东回报，提高资金使用效率。"
        )

    # 6. ROE优化
    if roe and float(roe) < 15:
        recommendations.append(
            f"**ROE优化：** 当前ROE为{float(roe):.2f}%，建议通过杜邦分析找出提升空间，"
            f"可从提升利润率、加快资产周转或适度增加财务杠杆三个方向入手。"
        )

    if not recommendations:
        recommendations.append(
            f"**综合评估：** {company_name}财务状况整体平稳，建议持续关注各项指标的变化趋势，"
            f"及时调整经营策略以应对市场变化。"
        )

    # 显示建议 - 使用编号列表格式
    full_text = " ".join([f"{i+1}. {rec}" for i, rec in enumerate(recommendations)])

    st.markdown(f'''
    <div style="padding:1.5rem;background:white;border-radius:12px;border:1px solid #eee;">
        <div style="font-size:0.9375rem;color:#1a1a2e;line-height:1.8;">
            建议公司采取以下措施： {full_text}
        </div>
    </div>
    ''', unsafe_allow_html=True)

    st.markdown("<br>", unsafe_allow_html=True)

    # 使用千问 API 生成更详细的分析
    st.markdown('''
    <div class="category-card">
        <div class="category-header">🔮 AI 深度分析</div>
        <div style="font-size:0.8125rem;color:#888;">使用大语言模型生成更详细的分析报告</div>
    </div>
    ''', unsafe_allow_html=True)

    # 每个 report 维持独立的 deep_ai_analysis，避免切换报告串数据/丢数据
    state_key = f"deep_ai_analysis:{r.id}"

    if st.button("🚀 生成 AI 深度分析", type="primary", key=f"gen_deep_ai:{r.id}"):
        with st.spinner("AI 正在深度分析财务数据，请稍候..."):
            analysis = analyze_financials_with_qwen(company_name, metric_dict)
            st.session_state[state_key] = analysis

    if st.session_state.get(state_key):
        st.markdown(f'''
        <div style="padding:1.5rem;background:#f8f9fa;border-radius:12px;border-left:4px solid #1976d2;">
            <div style="font-size:0.9375rem;color:#1a1a2e;line-height:1.8;white-space:pre-wrap;">
                {st.session_state[state_key]}
            </div>
        </div>
        ''', unsafe_allow_html=True)



def _load_metrics(report_id: str) -> pd.DataFrame:
    with session_scope() as s:
        stmt = select(ComputedMetric).where(ComputedMetric.report_id == report_id)
        rows = s.execute(stmt).scalars().all()
        if not rows:
            return pd.DataFrame()
        return pd.DataFrame([
            {"period_end": r.period_end, "metric_code": r.metric_code, "metric_name": r.metric_name, "value": r.value, "unit": r.unit}
            for r in rows
        ])


def _load_alerts(report_id: str) -> pd.DataFrame:
    with session_scope() as s:
        stmt = select(Alert).where(Alert.report_id == report_id).order_by(Alert.level.desc())
        rows = s.execute(stmt).scalars().all()
        if not rows:
            return pd.DataFrame()
        return pd.DataFrame([
            {"level": r.level, "title": r.title, "message": r.message, "evidence": r.evidence}
            for r in rows
        ])


def _fmt(df: pd.DataFrame, metric_code: str, suffix: str = "") -> str:
    if df.empty:
        return "N/A"
    row = df[df["metric_code"] == metric_code]
    if row.empty:
        return "N/A"
    v = row.iloc[0]["value"]
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return "N/A"
    return f"{float(v):.2f}{suffix}"


if __name__ == "__main__":
    main()
