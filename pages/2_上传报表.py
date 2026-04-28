from __future__ import annotations

from datetime import date

import streamlit as st

from core.repository import upsert_report_file_upload
from core.uploads import save_uploaded_file
from core.schema import init_db
from core.styles import inject_css, render_sidebar_nav, render_mobile_nav


def main() -> None:
    st.set_page_config(page_title="上传报表", page_icon="📤", layout="wide")
    inject_css()
    init_db()

    with st.sidebar:
        render_sidebar_nav()

    # 移动端导航栏
    render_mobile_nav(title="上传报表", show_back=True, back_url="app.py")

    st.markdown('<div class="page-title">上传财务报表</div>', unsafe_allow_html=True)
    st.markdown('<div class="page-desc">上传 PDF 格式的财务报表，AI 将自动提取数据并进行分析</div>', unsafe_allow_html=True)

    # 上传区域
    st.markdown('''
    <div class="category-card">
        <div class="category-header">📁 选择文件</div>
        <div style="font-size:0.8125rem;color:var(--text-3);">PDF, Excel, CSV — max 16MB</div>
    </div>
    ''', unsafe_allow_html=True)

    f = st.file_uploader(
        "选择文件", 
        type=["pdf", "xlsx", "csv"], 
        help="支持 PDF、Excel、CSV 格式，文件大小不超过 200MB"
    )
    
    if f:
        st.success(f"✅ 已选择文件: {f.name} ({f.size / 1024:.1f} KB)")

    st.markdown("<br>", unsafe_allow_html=True)

    # 公司信息
    st.markdown('''
    <div class="category-card">
        <div class="category-header">🏢 公司信息（可选）</div>
        <div style="font-size:0.8125rem;color:var(--text-3);">If AI can't identify the company name from the report</div>
    </div>
    ''', unsafe_allow_html=True)

    company_name = st.text_input("公司名称", placeholder="例如：某某科技有限公司", label_visibility="collapsed")

    st.markdown("<br>", unsafe_allow_html=True)

    # 操作按钮
    col1, col2 = st.columns(2)
    with col1:
        if st.button("取消", use_container_width=True):
            st.switch_page("app.py")
    with col2:
        can_start = f is not None
        if st.button("📤 开始上传", type="primary", use_container_width=True, disabled=not can_start):
            with st.spinner("正在上传..."):
                saved_path = save_uploaded_file(filename=getattr(f, "name", "upload"), data=f.getvalue())
                filetype = (getattr(f, "name", "").rsplit(".", 1)[-1] or "").lower()

                final_company = company_name.strip() if company_name.strip() else "待识别"
                report_name = f"{final_company} - {getattr(f, 'name', 'upload')}"

                meta = {
                    "upload_company_name": final_company,
                    "upload_filename": getattr(f, "name", None),
                    "upload_filetype": filetype,
                    "upload_saved_path": str(saved_path),
                }
                report_id = upsert_report_file_upload(
                    upload_company_name=final_company,
                    report_name=report_name,
                    period_type="annual",
                    period_end=date.today().isoformat(),
                    source_meta=meta,
                )
                st.success("上传成功！正在跳转...")
                st.session_state["active_report_id"] = report_id
                st.switch_page("pages/3_分析报告.py")


if __name__ == "__main__":
    main()
