from __future__ import annotations

import os
import re
from dataclasses import dataclass

from core.pdf_text import extract_pdf_text


@dataclass
class ExtractedFinancials:
    """从 PDF 提取的财务数据"""
    # 报告期信息
    report_period: str | None = None  # 如 "2024-12-31"
    report_year: str | None = None    # 如 "2024"
    # 财务数据
    revenue: float | None = None
    cost: float | None = None
    gross_profit: float | None = None
    net_profit: float | None = None
    total_assets: float | None = None
    total_liabilities: float | None = None
    total_equity: float | None = None
    current_assets: float | None = None
    current_liabilities: float | None = None
    cash: float | None = None
    inventory: float | None = None
    receivables: float | None = None
    fixed_assets: float | None = None
    # 直接提取的指标
    gross_margin_direct: float | None = None
    net_margin_direct: float | None = None
    roe_direct: float | None = None
    roa_direct: float | None = None
    current_ratio_direct: float | None = None
    debt_ratio_direct: float | None = None


def _normalize_chinese_text(text: str) -> str:
    """标准化中文文本 - 处理全角字符等"""
    # 全角转半角映射
    replacements = {
        '⼊': '入', '⼀': '一', '⼆': '二', '⼆': '二', '⼗': '十',
        '⽉': '月', '⽇': '日', '⾏': '行', '⾸': '首', '⾦': '金',
        '⾼': '高', '⽤': '用', '⽬': '目', '⽣': '生', '⽩': '白',
        '⽴': '立', '⽹': '网', '⾃': '自', '⾄': '至', '⾊': '色',
        '⾏': '行', '⾐': '衣', '⾒': '见', '⾓': '角', '⾔': '言',
        '⾕': '谷', '⾖': '豆', '⾛': '走', '⾜': '足', '⾝': '身',
        '⻋': '车', '⻓': '长', '⻔': '门', '⻛': '风', '⻜': '飞',
        '⻝': '食', '⻢': '马', '⻥': '鱼', '⻦': '鸟', '⿊': '黑',
        '％': '%', '：': ':', '（': '(', '）': ')',
    }
    for old, new in replacements.items():
        text = text.replace(old, new)
    return text


def extract_financials_from_pdf(pdf_path: str, use_ai: bool = True, force_ai: bool = False) -> ExtractedFinancials:
    """从 PDF 中提取财务数据 - 支持中英文，可选 AI 增强"""
    max_pages = int((os.environ.get("PDF_TEXT_MAX_PAGES") or "20").strip() or "20")
    max_chars = int((os.environ.get("PDF_TEXT_MAX_CHARS") or "80000").strip() or "80000")
    # AI-only path should avoid heavy extractors (pdfplumber/pdfminer/OCR) to prevent server OOM/hangs.
    text = extract_pdf_text(pdf_path, max_pages=max_pages, max_chars=max_chars, fast_only=bool(force_ai))
    if not text:
        return ExtractedFinancials()
    
    # 标准化中文文本
    text = _normalize_chinese_text(text)

    result = ExtractedFinancials()

    # Some PDFs place numbers in tables with frequent newlines; keep a no-newline version for regex.
    text_no_newline = text.replace("\n", " ")

    # ========== 提取报告期 ==========
    month_map = {
        "january": 1,
        "february": 2,
        "march": 3,
        "april": 4,
        "may": 5,
        "june": 6,
        "july": 7,
        "august": 8,
        "september": 9,
        "october": 10,
        "november": 11,
        "december": 12,
    }

    date_candidates: list[tuple[int, int, int, int, int]] = []

    def _add_date(y: str, m: str | int, d: str, prio: int, pos: int) -> None:
        try:
            yi = int(y)
            di = int(d)
            if isinstance(m, int):
                mi = int(m)
            else:
                mi = month_map.get(str(m).lower().strip(), 0)
            if yi <= 1900 or mi <= 0 or mi > 12 or di <= 0 or di > 31:
                return
            date_candidates.append((int(prio), yi, mi, di, -int(pos)))
        except Exception:
            return

    for m in re.finditer(
        r"fiscal\s+year\s+ended\s+(\w+)\s+(\d{1,2}),?\s+(\d{4})",
        text,
        re.IGNORECASE,
    ):
        mm, dd, yy = m.group(1), m.group(2), m.group(3)
        _add_date(yy, mm, dd, 90, m.start())

    for m in re.finditer(
        r"(?:Years?)\s+ended\s+(\w+)\s+(\d{1,2}),?\s+(\d{4})",
        text,
        re.IGNORECASE,
    ):
        mm, dd, yy = m.group(1), m.group(2), m.group(3)
        _add_date(yy, mm, dd, 90, m.start())

    for m in re.finditer(r"as\s+of\s+(\w+)\s+(\d{1,2}),?\s+(\d{4})", text, re.IGNORECASE):
        mm, dd, yy = m.group(1), m.group(2), m.group(3)
        _add_date(yy, mm, dd, 80, m.start())

    cn_quarterly = re.search(r"(\d{4})年第?[三3]季度报告", text)
    if cn_quarterly:
        _add_date(cn_quarterly.group(1), 9, "30", 50, cn_quarterly.start())

    for m in re.finditer(r"(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日", text):
        yy, mm, dd = m.group(1), m.group(2), m.group(3)
        _add_date(yy, int(mm), dd, 40, m.start())

    cn_annual = re.search(r"(\d{4})\s*(?:度|年度)", text)
    if cn_annual:
        _add_date(cn_annual.group(1), 12, "31", 35, cn_annual.start())

    quarterly_match = re.search(r"(?:Third|3rd|Q3)\s*(?:Quarterly\s*Report)?\s*(\d{4})", text, re.IGNORECASE)
    if quarterly_match:
        _add_date(quarterly_match.group(1), 9, "30", 60, quarterly_match.start())

    annual_match = re.search(r"(\d{4})\s*(?:Annual\s+Report|年度报告|年报)", text, re.IGNORECASE)
    if annual_match:
        _add_date(annual_match.group(1), 12, "31", 70, annual_match.start())

    if date_candidates:
        _, yy, mm, dd, _ = max(date_candidates)
        result.report_year = str(yy)
        result.report_period = f"{yy:04d}-{mm:02d}-{dd:02d}"

    def find_first_number(patterns: list[str], txt: str, min_value: float = 0, pick: str = "first") -> float | None:
        """提取匹配的数字"""
        picked: float | None = None
        picked_abs: float = -1.0
        token_re = re.compile(r"-?\d+(?:,\d{3})*(?:\.\d+)?")
        for pattern in patterns:
            matches = re.findall(pattern, txt, re.IGNORECASE)
            for match in matches:
                try:
                    raw = (match or "").strip()
                    is_paren = raw.startswith("(") and raw.endswith(")")
                    if is_paren:
                        raw = raw[1:-1]
                    raw = raw.replace("$", " ")
                    tokens = token_re.findall(raw)
                    if not tokens:
                        continue
                    vals: list[float] = []
                    for t in tokens:
                        try:
                            v = float(t.replace(",", ""))
                            if is_paren:
                                v = -abs(v)
                            vals.append(v)
                        except Exception:
                            continue
                    if not vals:
                        continue
                    val0 = vals[0]
                    if abs(val0) < min_value:
                        continue
                    if pick == "first":
                        return val0

                    av0 = abs(val0)
                    if av0 > picked_abs:
                        picked_abs = av0
                        picked = val0
                except (ValueError, TypeError):
                    continue
        return picked

    def find_percentage(patterns: list[str], txt: str) -> float | None:
        """提取百分比"""
        for pattern in patterns:
            matches = re.findall(pattern, txt, re.IGNORECASE)
            for match in matches:
                try:
                    num_str = match.replace(",", "").replace("%", "").strip()
                    val = float(num_str)
                    if 0 < val < 500:  # 合理的百分比范围（ROE/ROA 可能 >100）
                        return val
                except (ValueError, TypeError):
                    continue
        return None

    # ========== 直接提取百分比指标（优先级最高）==========

    # Gross margin (Tesla format: "Gross margin total automotive 18.4 %")
    result.gross_margin_direct = find_percentage([
        r"Gross\s+margin\s+(?:total\s+)?(?:automotive)?\s*([0-9.]+)\s*%",
        r"Gross\s+margin\s*[：:\s]*([0-9.]+)\s*%",
        r"毛利率[：:\s]*([0-9.]+)\s*%?",
    ], text)

    # Net margin
    result.net_margin_direct = find_percentage([
        r"Net\s+(?:profit\s+)?margin\s*[：:\s]*([0-9.]+)\s*%",
        r"净利率[：:\s]*([0-9.]+)\s*%?",
        r"销售净利率[：:\s]*([0-9.]+)\s*%?",
    ], text)

    # ROE - 银行财报格式
    result.roe_direct = find_percentage([
        r"加权平均净资产收益率[（(]年化[)）]\s*([0-9.]+)%",
        r"净资产收益率[：:\s]*([0-9.]+)\s*%?",
        r"ROE[：:\s]*([0-9.]+)\s*%?",
    ], text)

    # ROA - 银行财报格式
    result.roa_direct = find_percentage([
        r"平均总资产收益率[（(]年化[)）]\s*([0-9.]+)%",
        r"总资产收益率[：:\s]*([0-9.]+)\s*%?",
        r"ROA[：:\s]*([0-9.]+)\s*%?",
    ], text)

    # ========== 利润表 ==========

    # Total revenues - 支持多种格式
    result.revenue = find_first_number([
        r"Total\s+net\s+sales\s*\$?\s*([0-9,\.\s]+)",  # Apple 格式优先
        r"Total\s+net\s+revenues\s*\$?\s*([0-9,\.\s]+)",
        r"Total\s+revenues?\s*\$?\s*([0-9,\.\s]+)",
        r"Net\s*sales\s*\$?\s*([0-9,\.\s]+)",
        r"Net\s*revenues\s*\$?\s*([0-9,\.\s]+)",
        r"Netrevenues\s*\$?\s*([0-9,\.\s]+)",
        r"Operatingrevenue\s*\(RMB\)\s*([0-9,\s]+(?:\.[0-9]+)?)",  # 五粮液格式
        r"Operating\s+revenue\s*\(RMB\)\s*([0-9,\s]+(?:\.[0-9]+)?)",
        r"营业收入[：:\s]*([0-9,\s]+)",
        r"实现营业收入([0-9,\s]+(?:\.[0-9]+)?)",  # 银行财报格式
    ], text_no_newline, min_value=1000, pick="max")

    # Cost of revenues / Cost of sales
    result.cost = find_first_number([
        r"Total\s+cost\s+of\s+(?:revenues?|sales)\s*\$?\s*([0-9,\.\s]+)",
        r"Cost\s+of\s+(?:revenues?|sales)\s*\$?\s*([0-9,\.\s]+)",
        r"Cost\s+of\s+sales:\s*\n?\s*Products?\s*\$?\s*([0-9,\.\s]+)",  # Apple 格式
        r"营业成本[：:\s]*([0-9,\s]+)",
    ], text_no_newline, min_value=1000, pick="max")

    # Gross profit / Gross margin
    result.gross_profit = find_first_number([
        r"Gross\s+(?:profit|margin)\s*\$?\s*([0-9,\.\s]+)",
        r"毛利[润]?[：:\s]*([0-9,\s]+)",
    ], text_no_newline, min_value=100, pick="max")

    # Net income - 支持多种格式
    result.net_profit = find_first_number([
        r"Net\s+earnings\s+attributable\s+to\s+[^$]{0,60}\$\s*([0-9,\.\s\(\)\-]+)",
        r"Net\s+earnings\s+including\s+noncontrolling\s+interests\s*\$\s*([0-9,\.\s\(\)\-]+)",
        r"Net\s+income\s+attributable\s+to\s+common\s+stockholders?\s*\$?\s*([0-9,\.\s]+)",
        r"Net\s+income\s*\$?\s*([0-9,\.\s\(\)\-]+)",
        r"Net\s+earnings\s*\$?\s*([0-9,\.\s\(\)\-]+)",
        r"thelistedcompany.s\s+([0-9,\s]+(?:\.[0-9]+)?)",  # 五粮液格式 - 用.匹配任意引号
        r"Net\s+profit\s+attributable\s+to.*shareholders\s*\(RMB\)\s*([0-9,\s]+(?:\.[0-9]+)?)",
        r"归属于上市公司股东的净利润[（(]元[)）]\s*([0-9,\s]+(?:\.[0-9]+)?)",  # A股季报格式
        r"净利润[：:\s]*([0-9,\s]+)",
        r"归属于.*股东的净利润\s*([0-9,\s]+)",  # 银行财报格式
    ], text_no_newline, min_value=100, pick="max")

    # ========== 资产负债表 ==========

    result.total_assets = find_first_number([
        r"Total\s+assets\s*\$?\s*([0-9,\.\s]+)",
        r"Totalassets\s*\(RMB\)\s*([0-9,\s]+(?:\.[0-9]+)?)",  # 五粮液格式
        r"资产总计\s+([0-9,\s]+(?:\.[0-9]+)?)",  # A股季报格式
        r"资产总[计额][：:\s]*([0-9,\s]+)",
        r"资产总额\s*([0-9,\s]+)",  # 银行财报格式
    ], text, min_value=1000, pick="max")

    result.total_equity = find_first_number([
        r"Total\s+stockholders['']?\s*equity\s*\$?\s*\(?([0-9,\.\s]+)\)?",
        r"Total\s+equity\s*\$?\s*\(?([0-9,\.\s]+)\)?",
        r"所有者权益合计[：:\s]*([0-9,\s]+)",
        r"股东权益\s*([0-9,\s]+)",  # 银行财报格式
        r"归属于.*股东的股东权益\s*([0-9,\s]+)",
    ], text, min_value=100, pick="max")

    result.total_liabilities = find_first_number([
        r"Total\s+liabilities\s*\$?\s*([0-9,\.\s]+)",
        r"负债总[计额][：:\s]*([0-9,\s]+)",
        r"负债合计[：:\s]*([0-9,\s]+)",
    ], text, min_value=1000, pick="max")
    
    # 银行特殊：如果没有直接的负债数据，用资产-权益计算
    if not result.total_liabilities and result.total_assets and result.total_equity:
        result.total_liabilities = result.total_assets - result.total_equity

    result.current_assets = find_first_number([
        r"Total\s+current\s+assets\s*\$?\s*([0-9,\.\s]+)",
        r"流动资产合计[：:\s]*([0-9,\s]+)",
    ], text, min_value=100, pick="max")

    result.current_liabilities = find_first_number([
        r"Total\s+current\s+liabilities\s*\$?\s*([0-9,\.\s]+)",
        r"流动负债合计[：:\s]*([0-9,\s]+)",
    ], text, min_value=100, pick="max")

    result.cash = find_first_number([
        r"Cash\s+and\s+cash\s+equivalents\s*\$?\s*([0-9,\.\s]+)",
        r"货币资金[：:\s]*([0-9,\s]+)",
    ], text, min_value=10, pick="max")

    result.inventory = find_first_number([
        r"Inventor(?:y|ies)\s*\$?\s*([0-9,\.\s]+)",
        r"存货[：:\s]*([0-9,\s]+)",
    ], text, min_value=10, pick="max")

    result.receivables = find_first_number([
        r"Accounts\s+receivable[^\d]{0,60}\$?\s*([0-9,\.\s]+)",
        r"应收账款[：:\s]*([0-9,\s]+)",
    ], text, min_value=10, pick="max")

    result.fixed_assets = find_first_number([
        r"Property,?\s+plant\s+and\s+equipment,?\s*(?:net)?\s*\$?\s*([0-9,\.\s]+)",
        r"固定资产[：:\s]*([0-9,\s]+)",
    ], text, min_value=10, pick="max")

    # 如果没有权益但有资产和负债，计算权益
    if not result.total_equity and result.total_assets and result.total_liabilities:
        result.total_equity = result.total_assets - result.total_liabilities

    # ========== AI 增强提取 ==========
    # force_ai=True: 每次都调用 AI；否则按命中率阈值触发
    if use_ai:
        if force_ai:
            try:
                from core.llm_qwen import extract_financials_with_ai, merge_ai_extracted_data, get_api_key
                if not get_api_key():
                    raise RuntimeError("ai_required_no_api_key")
                ai_data = extract_financials_with_ai(text, raise_on_error=True)
                if ai_data:
                    merge_ai_extracted_data(result, ai_data)
                    setattr(result, "_ai_enhanced", True)
                    setattr(result, "_ai_keys", list(ai_data.keys()))
                else:
                    raise RuntimeError("ai_extraction_empty")
            except Exception as e:
                raise
            return result

        # 计算已提取的关键指标数量
        extracted_count = sum(1 for v in [
            result.revenue, result.net_profit, result.total_assets,
            result.total_equity, result.gross_margin_direct, result.roe_direct,
            result.total_liabilities, result.current_assets, result.current_liabilities
        ] if v is not None)

        key_fields = [
            result.revenue,
            result.net_profit,
            result.total_assets,
            result.total_liabilities,
            result.total_equity,
            result.current_assets,
            result.current_liabilities,
        ]
        key_missing = sum(1 for v in key_fields if v is None)

        # 触发 AI：关键字段缺失较多，或整体提取数量偏少
        if extracted_count < 8 or key_missing >= 3:
            try:
                from core.llm_qwen import extract_financials_with_ai, merge_ai_extracted_data, get_api_key
                if get_api_key():
                    print(f"Regex extracted {extracted_count} metrics, using AI to enhance...")
                    ai_data = extract_financials_with_ai(text)
                    if ai_data:
                        merge_ai_extracted_data(result, ai_data)
                        setattr(result, "_ai_enhanced", True)
                        setattr(result, "_ai_keys", list(ai_data.keys()))
                        print(f"AI extracted: {list(ai_data.keys())}")
            except Exception as e:
                print(f"AI enhancement failed: {e}")

    return result


def compute_metrics_from_extracted(data: ExtractedFinancials) -> dict[str, float | None]:
    """从提取的数据计算财务指标"""
    metrics = {}

    # ========== 盈利能力指标 ==========

    # 毛利率 - 优先使用直接提取的值
    if data.gross_margin_direct:
        metrics["GROSS_MARGIN"] = data.gross_margin_direct
    elif data.revenue and data.gross_profit and data.revenue > 0:
        metrics["GROSS_MARGIN"] = (data.gross_profit / data.revenue) * 100
    elif data.revenue and data.cost and data.revenue > 0:
        metrics["GROSS_MARGIN"] = ((data.revenue - data.cost) / data.revenue) * 100

    # 净利率
    if data.net_margin_direct:
        metrics["NET_MARGIN"] = data.net_margin_direct
    elif data.revenue and data.net_profit and data.revenue > 0:
        metrics["NET_MARGIN"] = (data.net_profit / data.revenue) * 100

    # ROE
    if data.roe_direct:
        metrics["ROE"] = data.roe_direct
    elif data.total_equity and data.net_profit and data.total_equity > 0:
        metrics["ROE"] = (data.net_profit / data.total_equity) * 100

    # ROA
    if data.roa_direct:
        metrics["ROA"] = data.roa_direct
    elif data.total_assets and data.net_profit and data.total_assets > 0:
        metrics["ROA"] = (data.net_profit / data.total_assets) * 100

    # ========== 偿债能力指标 ==========

    # 资产负债率
    if data.debt_ratio_direct:
        metrics["DEBT_ASSET"] = data.debt_ratio_direct
    elif data.total_assets and data.total_liabilities and data.total_assets > 0:
        metrics["DEBT_ASSET"] = (data.total_liabilities / data.total_assets) * 100

    # 流动比率
    if data.current_ratio_direct:
        metrics["CURRENT_RATIO"] = data.current_ratio_direct
    elif data.current_assets and data.current_liabilities and data.current_liabilities > 0:
        metrics["CURRENT_RATIO"] = data.current_assets / data.current_liabilities

    # 速动比率
    if data.current_assets and data.current_liabilities and data.current_liabilities > 0:
        inventory = data.inventory or 0
        metrics["QUICK_RATIO"] = (data.current_assets - inventory) / data.current_liabilities

    # 产权比率
    if data.total_liabilities and data.total_equity and data.total_equity > 0:
        metrics["EQUITY_RATIO"] = data.total_liabilities / data.total_equity

    # ========== 营运能力指标 ==========

    # 存货周转率
    if data.cost and data.inventory and data.inventory > 0:
        metrics["INVENTORY_TURNOVER"] = data.cost / data.inventory

    # 应收账款周转率
    if data.revenue and data.receivables and data.receivables > 0:
        metrics["RECEIVABLE_TURNOVER"] = data.revenue / data.receivables

    # 总资产周转率
    if data.revenue and data.total_assets and data.total_assets > 0:
        metrics["ASSET_TURNOVER"] = data.revenue / data.total_assets

    return metrics
