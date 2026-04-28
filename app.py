from __future__ import annotations

import os
import streamlit as st
from sqlalchemy import func, select
from dotenv import load_dotenv

# 加载环境变量
load_dotenv()

from core.db import session_scope
from core.models import Alert, Report
from core.repository import list_reports
from core.schema import init_db
from core.styles import inject_css, render_sidebar_nav, render_mobile_nav, stat_card, badge


def main() -> None:
    st.set_page_config(page_title="Financial Expert", page_icon="", layout="wide", initial_sidebar_state="auto")
    inject_css()
    init_db()

    with st.sidebar:
        render_sidebar_nav()

    # 移动端导航栏
    render_mobile_nav(title="Dashboard", show_back=False)

    # 页面标题
    st.markdown('<div class="page-title">Dashboard</div>', unsafe_allow_html=True)
    st.markdown('<div class="page-desc">Intelligent financial analysis & insights</div>', unsafe_allow_html=True)

    # 统计卡片
    stats = _get_stats()

    c1, c2, c3, c4 = st.columns(4)
    with c1:
        st.markdown(stat_card("Reports", stats["total"], "Total uploaded", ""), unsafe_allow_html=True)
    with c2:
        st.markdown(stat_card("Completed", stats["done"], "Analysis done", ""), unsafe_allow_html=True)
    with c3:
        st.markdown(stat_card("Risk Alerts", stats["risks"], "High-risk items", ""), unsafe_allow_html=True)
    with c4:
        rate = f"{stats['rate']}%" if stats["total"] > 0 else "0%"
        st.markdown(stat_card("Completion", rate, "Analysis rate", ""), unsafe_allow_html=True)

    st.markdown("<br>", unsafe_allow_html=True)

    # Quick actions
    st.markdown("#### Quick Actions")

    if st.button("Upload Report", type="primary", use_container_width=True):
        st.switch_page("pages/2_上传报表.py")

    if st.button("View Analysis", use_container_width=True):
        st.switch_page("pages/3_分析报告.py")

    if st.button("Risk Alerts", use_container_width=True):
        st.switch_page("pages/5_风险预警.py")

    st.markdown("<br>", unsafe_allow_html=True)

    # 多公司对比功能
    st.markdown('''
    <div style="margin-bottom:1rem;">
        <div style="font-size:1.0625rem;font-weight:600;color:var(--text-1);margin-bottom:var(--space-2);">Multi-Company Comparison</div>
        <div style="font-size:0.8125rem;color:var(--text-3);">Select 2-5 companies for cross-comparison analysis</div>
    </div>
    ''', unsafe_allow_html=True)
    
    # 获取已完成分析的报告
    done_reports = [r for r in list_reports(limit=20) if r.status == "done"]
    
    if len(done_reports) >= 2:
        selected_reports = st.multiselect(
            "Select companies to compare (2-5)",
            options=[(r.id, r.report_name) for r in done_reports],
            format_func=lambda x: x[1],
            max_selections=5,
            key="compare_reports"
        )
        
        if len(selected_reports) >= 2:
            if st.button("Start Comparison", type="primary"):
                st.session_state["compare_report_ids"] = [r[0] for r in selected_reports]
                st.switch_page("pages/7_公司对比.py")
        else:
            st.markdown('<div style="font-size:0.8125rem;color:var(--text-3);">Select at least 2 companies to compare</div>', unsafe_allow_html=True)
        else:
            st.markdown('''
            <div style="padding:var(--space-4);background:var(--bg-surface);border-radius:var(--radius-sm);border:1px solid var(--border);">
                <div style="font-size:0.8125rem;color:var(--text-3);">Need at least 2 analyzed reports to compare</div>
            </div>
            ''', unsafe_allow_html=True)

    st.markdown("<br>", unsafe_allow_html=True)

    # Recent analysis
    col1, col2 = st.columns([3, 1])
    with col1:
        st.markdown("#### Recent Analysis")
    with col2:
        if st.button("View All", type="secondary"):
            st.switch_page("pages/3_分析报告.py")

    reports = list_reports(limit=10)
    if not reports:
        st.info("No reports yet. Tap 'Upload Report' to get started.")
    else:
        for r in reports:
            status_map = {
                "done": ("success", "Done"),
                "running": ("warning", "Processing"),
                "failed": ("danger", "Failed"),
                "pending": ("pending", "Pending"),
            }
            s, t = status_map.get(r.status, ("pending", "Pending"))

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
                if st.button("→", key=f"go_{r.id}"):
                    st.session_state["active_report_id"] = r.id
                    st.switch_page("pages/3_分析报告.py")


def _get_stats() -> dict:
    with session_scope() as s:
        total = s.execute(select(func.count(Report.id))).scalar() or 0
        done = s.execute(select(func.count(Report.id)).where(Report.status == "done")).scalar() or 0
        risks = s.execute(select(func.count(func.distinct(Alert.report_id))).where(Alert.level == "high")).scalar() or 0
        rate = int(done / total * 100) if total > 0 else 0
    return {"total": total, "done": done, "risks": risks, "rate": rate}


if __name__ == "__main__":
    main()
