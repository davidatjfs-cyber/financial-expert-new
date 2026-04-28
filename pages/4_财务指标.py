from __future__ import annotations

import pandas as pd
import streamlit as st
from sqlalchemy import select

from core.db import session_scope
from core.models import ComputedMetric, Report
from core.schema import init_db
from core.styles import inject_css, render_sidebar_nav, render_mobile_nav


INDUSTRY_BENCHMARKS_BY_SECTOR = {
    "银行": {
        "GROSS_MARGIN": {"name": "毛利率", "avg": None, "unit": "%"},
        "NET_MARGIN": {"name": "净利率", "avg": 35.0, "unit": "%"},
        "ROE": {"name": "ROE (净资产收益率)", "avg": 10.0, "unit": "%"},
        "ROA": {"name": "ROA (总资产收益率)", "avg": 0.8, "unit": "%"},
        "CURRENT_RATIO": {"name": "流动比率", "avg": None, "unit": ""},
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
    if any(kw in company_name for kw in ["银行", "Bank"]):
        return "银行"
    if any(kw in company_name for kw in ["保险", "人寿", "财险", "Insurance"]):
        return "保险"
    if any(kw in company_name for kw in ["五粮液", "茅台", "泸州老窖", "洋河", "汾酒", "酒"]):
        return "白酒"
    if any(kw in company_name for kw in ["制造", "机械", "汽车", "电子"]):
        return "制造业"
    return "默认"


def get_industry_benchmarks(company_name: str) -> tuple[dict, str]:
    industry = detect_industry(company_name)
    return INDUSTRY_BENCHMARKS_BY_SECTOR.get(industry, INDUSTRY_BENCHMARKS_BY_SECTOR["默认"]), industry


def main() -> None:
    st.set_page_config(page_title="财务指标", page_icon="📈", layout="wide")
    inject_css()
    init_db()

    with st.sidebar:
        render_sidebar_nav()

    # 移动端导航栏
    render_mobile_nav(title="财务指标", show_back=True, back_url="app.py")

    st.markdown('<div class="page-title">财务指标</div>', unsafe_allow_html=True)
    st.markdown('<div class="page-desc">了解各项财务指标的含义和计算方式，查看已分析报告的指标数值</div>', unsafe_allow_html=True)

    col1, col2 = st.columns(2)

    with col1:
        st.markdown('''
        <div class="category-card">
            <div class="category-header">📈 盈利能力指标</div>
            <div class="metric-row">
                <div>
                    <div class="metric-name">毛利率</div>
                    <div class="metric-benchmark">毛利润与营业收入的比率，反映产品附加值</div>
                </div>
            </div>
            <div class="metric-row">
                <div>
                    <div class="metric-name">净利率</div>
                    <div class="metric-benchmark">净利润与营业收入的比率，反映最终盈利能力</div>
                </div>
            </div>
            <div class="metric-row">
                <div>
                    <div class="metric-name">ROE</div>
                    <div class="metric-benchmark">净资产收益率，反映股东权益的回报率</div>
                </div>
            </div>
            <div class="metric-row">
                <div>
                    <div class="metric-name">ROA</div>
                    <div class="metric-benchmark">总资产收益率，反映资产利用效率</div>
                </div>
            </div>
        </div>
        ''', unsafe_allow_html=True)

        st.markdown("<br>", unsafe_allow_html=True)

        st.markdown('''
        <div class="category-card">
            <div class="category-header">⚡ 营运能力指标</div>
            <div class="metric-row">
                <div>
                    <div class="metric-name">存货周转率</div>
                    <div class="metric-benchmark">营业成本与平均存货的比率，反映存货管理效率</div>
                </div>
            </div>
            <div class="metric-row">
                <div>
                    <div class="metric-name">应收账款周转率</div>
                    <div class="metric-benchmark">营业收入与平均应收账款的比率，反映回款速度</div>
                </div>
            </div>
            <div class="metric-row">
                <div>
                    <div class="metric-name">总资产周转率</div>
                    <div class="metric-benchmark">营业收入与平均总资产的比率，反映资产运营效率</div>
                </div>
            </div>
        </div>
        ''', unsafe_allow_html=True)

    with col2:
        st.markdown('''
        <div class="category-card">
            <div class="category-header">📊 偿债能力指标</div>
            <div class="metric-row">
                <div>
                    <div class="metric-name">流动比率</div>
                    <div class="metric-benchmark">流动资产与流动负债的比率，反映短期偿债能力</div>
                </div>
            </div>
            <div class="metric-row">
                <div>
                    <div class="metric-name">速动比率</div>
                    <div class="metric-benchmark">速动资产与流动负债的比率，更严格的流动性指标</div>
                </div>
            </div>
            <div class="metric-row">
                <div>
                    <div class="metric-name">资产负债率</div>
                    <div class="metric-benchmark">总负债与总资产的比率，反映财务杠杆水平</div>
                </div>
            </div>
            <div class="metric-row">
                <div>
                    <div class="metric-name">产权比率</div>
                    <div class="metric-benchmark">总负债与所有者权益的比率，反映债权人权益保障</div>
                </div>
            </div>
        </div>
        ''', unsafe_allow_html=True)

        st.markdown("<br>", unsafe_allow_html=True)

        st.markdown('''
        <div class="category-card">
            <div class="category-header">🚀 成长能力指标</div>
            <div class="metric-row">
                <div>
                    <div class="metric-name">营收增长率</div>
                    <div class="metric-benchmark">本期营收相比上期的增长比例</div>
                </div>
            </div>
            <div class="metric-row">
                <div>
                    <div class="metric-name">净利润增长率</div>
                    <div class="metric-benchmark">本期净利润相比上期的增长比例</div>
                </div>
            </div>
            <div class="metric-row">
                <div>
                    <div class="metric-name">总资产增长率</div>
                    <div class="metric-benchmark">本期总资产相比上期的增长比例</div>
                </div>
            </div>
        </div>
        ''', unsafe_allow_html=True)

    # 查看报表指标
    st.markdown("<br>", unsafe_allow_html=True)
    st.markdown('''
    <div class="category-card">
        <div class="category-header">📋 查看报表指标</div>
        <div style="font-size:0.8125rem;color:var(--text-3);">Select an analyzed report to view specific metrics</div>
    </div>
    ''', unsafe_allow_html=True)

    # 获取所有已分析的报告
    reports = _get_analyzed_reports()
    if reports:
        report_options = {f"{r['name']} ({r['period_end']})": r['id'] for r in reports}
        selected = st.selectbox("选择报告", options=list(report_options.keys()))
        if selected:
            report_id = report_options[selected]
            _render_report_metrics(report_id)
    else:
        st.info("暂无已分析的报告，请先上传并分析财务报表")

    # 行业基准参考
    st.markdown("<br>", unsafe_allow_html=True)
    st.markdown('''
    <div class="category-card">
        <div class="category-header">📊 行业基准参考</div>
        <div style="font-size:0.8125rem;color:var(--text-3);margin-bottom:var(--space-4);">Industry benchmarks for reference</div>
    </div>
    ''', unsafe_allow_html=True)

    col1, col2, col3, col4 = st.columns(4)
    with col1:
        st.markdown('''
        <div style="text-align:center;padding:var(--space-4);background:var(--bg-surface);border-radius:var(--radius-sm);border:1px solid var(--border);">
            <div style="font-size:0.6875rem;color:var(--text-3);text-transform:uppercase;letter-spacing:0.04em;">Current Ratio</div>
            <div style="font-size:1.5rem;font-weight:700;color:var(--accent);">≥ 2.0</div>
            <div style="font-size:0.6875rem;color:var(--green);">Healthy</div>
        </div>
        ''', unsafe_allow_html=True)
    with col2:
        st.markdown('''
        <div style="text-align:center;padding:var(--space-4);background:var(--bg-surface);border-radius:var(--radius-sm);border:1px solid var(--border);">
            <div style="font-size:0.6875rem;color:var(--text-3);text-transform:uppercase;letter-spacing:0.04em;">Quick Ratio</div>
            <div style="font-size:1.5rem;font-weight:700;color:var(--accent);">≥ 1.0</div>
            <div style="font-size:0.6875rem;color:var(--green);">Healthy</div>
        </div>
        ''', unsafe_allow_html=True)
    with col3:
        st.markdown('''
        <div style="text-align:center;padding:var(--space-4);background:var(--bg-surface);border-radius:var(--radius-sm);border:1px solid var(--border);">
            <div style="font-size:0.6875rem;color:var(--text-3);text-transform:uppercase;letter-spacing:0.04em;">Debt/Asset</div>
            <div style="font-size:1.5rem;font-weight:700;color:var(--yellow);">≤ 60%</div>
            <div style="font-size:0.6875rem;color:var(--yellow);">Moderate</div>
        </div>
        ''', unsafe_allow_html=True)
    with col4:
        st.markdown('''
        <div style="text-align:center;padding:var(--space-4);background:var(--bg-surface);border-radius:var(--radius-sm);border:1px solid var(--border);">
            <div style="font-size:0.6875rem;color:var(--text-3);text-transform:uppercase;letter-spacing:0.04em;">ROE</div>
            <div style="font-size:1.5rem;font-weight:700;color:var(--green);">≥ 15%</div>
            <div style="font-size:0.6875rem;color:var(--green);">Good</div>
        </div>
        ''', unsafe_allow_html=True)


def _get_analyzed_reports() -> list[dict]:
    """获取所有已分析的报告"""
    with session_scope() as s:
        stmt = select(Report).where(Report.status == "done").order_by(Report.updated_at.desc())
        reports = s.execute(stmt).scalars().all()
        return [{"id": r.id, "name": r.report_name, "period_end": r.period_end} for r in reports]


def _render_report_metrics(report_id: str) -> None:
    """渲染报告的指标 - 美化版"""
    with session_scope() as s:
        report = s.get(Report, report_id)
        company_name = report.report_name.split(" - ")[0] if report and report.report_name else ""
        benchmarks, industry = get_industry_benchmarks(company_name)

        stmt = select(ComputedMetric).where(ComputedMetric.report_id == report_id)
        metrics = s.execute(stmt).scalars().all()
        
        if not metrics:
            st.warning("该报告暂无指标数据")
            return
        
        # 按类别分组显示
        profitability = []  # 盈利能力
        solvency = []       # 偿债能力
        efficiency = []     # 营运能力
        
        for m in metrics:
            item = {"name": m.metric_name, "value": m.value, "unit": m.unit or "", "code": m.metric_code}
            if m.metric_code in ["GROSS_MARGIN", "NET_MARGIN", "ROE", "ROA"]:
                profitability.append(item)
            elif m.metric_code in ["CURRENT_RATIO", "QUICK_RATIO", "DEBT_ASSET", "EQUITY_RATIO"]:
                solvency.append(item)
            elif m.metric_code in ["INVENTORY_TURNOVER", "RECEIVABLE_TURNOVER", "ASSET_TURNOVER"]:
                efficiency.append(item)
        
        # 使用卡片式布局
        st.markdown("""
        <style>
        .metric-card {
            background: var(--bg-surface);
            border-radius: var(--radius-sm);
            padding: var(--space-4);
            margin-bottom: var(--space-2);
            color: var(--text-1);
            border: 1px solid var(--border);
        }
        .metric-card.green {
            border-left: 3px solid var(--green);
        }
        .metric-card.orange {
            border-left: 3px solid var(--yellow);
        }
        .metric-card.blue {
            border-left: 3px solid var(--blue);
        }
        .metric-label {
            font-size: 0.75rem;
            color: var(--text-2);
            margin-bottom: var(--space-1);
            text-transform: uppercase;
            letter-spacing: 0.04em;
            font-weight: 500;
        }
        .metric-value {
            font-size: 1.5rem;
            font-weight: 700;
            color: var(--text-1);
            letter-spacing: -0.02em;
        }
        .metric-avg {
            font-size: 0.6875rem;
            color: var(--text-3);
            margin-top: var(--space-2);
            line-height: 1.4;
        }
        .category-title {
            font-size: 0.9375rem;
            font-weight: 600;
            color: var(--text-1);
            margin-bottom: var(--space-3);
            padding-bottom: var(--space-2);
            border-bottom: 1px solid var(--border);
        }
        </style>
        """, unsafe_allow_html=True)
        
        col1, col2, col3 = st.columns(3)
        
        with col1:
            st.markdown('<div class="category-title">📈 盈利能力</div>', unsafe_allow_html=True)
            for item in profitability:
                val = f"{item['value']:.2f}{item['unit']}" if item['value'] else "--"
                bench = benchmarks.get(item["code"]) if benchmarks else None
                avg = None if not bench else bench.get("avg")
                avg_unit = "" if not bench else (bench.get("unit") or "")
                if avg is None:
                    avg_str = "行业不适用" if bench and bench.get("avg") is None else "行业平均: --"
                else:
                    avg_str = f"行业平均: {avg}{avg_unit}"
                st.markdown(f'''
                <div class="metric-card green">
                    <div class="metric-label">{item['name']}</div>
                    <div class="metric-value">{val}</div>
                    <div class="metric-avg">{avg_str}</div>
                </div>
                ''', unsafe_allow_html=True)
            if not profitability:
                st.markdown('<div style="color:var(--text-3);font-size:0.8125rem;">No data</div>', unsafe_allow_html=True)
        
        with col2:
            st.markdown('<div class="category-title">🏦 偿债能力</div>', unsafe_allow_html=True)
            for item in solvency:
                val = f"{item['value']:.2f}{item['unit']}" if item['value'] else "--"
                bench = benchmarks.get(item["code"]) if benchmarks else None
                avg = None if not bench else bench.get("avg")
                avg_unit = "" if not bench else (bench.get("unit") or "")
                if avg is None:
                    avg_str = "行业不适用" if bench and bench.get("avg") is None else "行业平均: --"
                else:
                    avg_str = f"行业平均: {avg}{avg_unit}"
                st.markdown(f'''
                <div class="metric-card blue">
                    <div class="metric-label">{item['name']}</div>
                    <div class="metric-value">{val}</div>
                    <div class="metric-avg">{avg_str}</div>
                </div>
                ''', unsafe_allow_html=True)
            if not solvency:
                st.markdown('<div style="color:var(--text-3);font-size:0.8125rem;">No data</div>', unsafe_allow_html=True)
        
        with col3:
            st.markdown('<div class="category-title">⚡ 营运能力</div>', unsafe_allow_html=True)
            for item in efficiency:
                val = f"{item['value']:.2f}" if item['value'] else "--"
                bench = benchmarks.get(item["code"]) if benchmarks else None
                avg = None if not bench else bench.get("avg")
                avg_unit = "" if not bench else (bench.get("unit") or "")
                if avg is None:
                    avg_str = "行业不适用" if bench and bench.get("avg") is None else "行业平均: --"
                else:
                    avg_str = f"行业平均: {avg}{avg_unit}"
                st.markdown(f'''
                <div class="metric-card orange">
                    <div class="metric-label">{item['name']}</div>
                    <div class="metric-value">{val}</div>
                    <div class="metric-avg">{avg_str}</div>
                </div>
                ''', unsafe_allow_html=True)
            if not efficiency:
                st.markdown('<div style="color:var(--text-3);font-size:0.8125rem;">No data</div>', unsafe_allow_html=True)


if __name__ == "__main__":
    main()
