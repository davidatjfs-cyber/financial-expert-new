from __future__ import annotations

import os
import json
import re
import httpx
from typing import Optional
from dataclasses import asdict


QWEN_API_URL = "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation"

LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "qwen").strip().lower()
LLM_LOCAL_URL = os.environ.get("LLM_LOCAL_URL", "http://localhost:11434/v1").strip().rstrip("/")
LLM_LOCAL_MODEL = os.environ.get("LLM_LOCAL_MODEL", "gemma3:27b").strip()


def get_api_key() -> str:
    return os.environ.get("DASHSCOPE_API_KEY", "")


def call_llm(system_prompt: str, user_prompt: str,
             temperature: float = 0.3, max_tokens: int = 2000,
             api_key: Optional[str] = None,
             model: Optional[str] = None) -> str:
    """统一 LLM 调用入口，支持 Qwen 和本地模型(Ollama/vLLM)"""
    if LLM_PROVIDER == "local":
        return _call_local_llm(system_prompt, user_prompt, temperature, max_tokens)
    return _call_qwen_llm(system_prompt, user_prompt, temperature, max_tokens, api_key, model)


def _call_local_llm(system_prompt: str, user_prompt: str,
                    temperature: float = 0.3, max_tokens: int = 2000) -> str:
    try:
        resp = httpx.post(
            f"{LLM_LOCAL_URL}/chat/completions",
            headers={"Content-Type": "application/json"},
            json={
                "model": LLM_LOCAL_MODEL,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                "temperature": temperature,
                "max_tokens": max_tokens,
            },
            timeout=120.0,
        )
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"]
    except Exception as e:
        print(f"[llm] local LLM error: {e}")
        raise


def _call_qwen_llm(system_prompt: str, user_prompt: str,
                   temperature: float = 0.3, max_tokens: int = 2000,
                   api_key: Optional[str] = None,
                   model: Optional[str] = None) -> str:
    key = api_key or get_api_key()
    if not key:
        raise RuntimeError("missing_api_key")
    qwen_model = (model or "qwen-turbo").strip()
    try:
        resp = httpx.post(
            QWEN_API_URL,
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
            },
            json={
                "model": qwen_model,
                "input": {
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ]
                },
                "parameters": {
                    "temperature": temperature,
                    "max_tokens": max_tokens,
                },
            },
            timeout=30.0,
        )
        resp.raise_for_status()
        data = resp.json()
        if "output" in data and "text" in data["output"]:
            return data["output"]["text"]
        elif "output" in data and "choices" in data["output"]:
            return data["output"]["choices"][0]["message"]["content"]
        return ""
    except Exception as e:
        print(f"[llm] qwen error: {e}")
        raise


def test_qwen_connection(api_key: Optional[str] = None) -> tuple[bool, str]:
    key = api_key or get_api_key()
    if not key:
        return False, "missing_api_key"

    try:
        resp = httpx.post(
            QWEN_API_URL,
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
            },
            json={
                "model": "qwen-turbo",
                "input": {
                    "messages": [
                        {"role": "system", "content": "You are a helpful assistant."},
                        {"role": "user", "content": "ping"},
                    ]
                },
                "parameters": {"temperature": 0.0, "max_tokens": 16},
            },
            timeout=15.0,
        )
        if resp.status_code >= 400:
            return False, f"http_{resp.status_code}:{resp.text[:500]}"
        data = resp.json()
        if (data or {}).get("output"):
            return True, "ok"
        return False, f"unexpected_response:{str(data)[:500]}"
    except Exception as e:
        return False, f"exception:{e}"


def _smart_truncate_for_ai(text: str, max_len: int = 30000) -> str:
    """智能截断：优先保留财务报表关键段落（利润表、资产负债表、现金流量表）"""
    if len(text) <= max_len:
        return text

    # 定义关键段落的标记词（中英文）
    section_markers = [
        # 英文
        "CONSOLIDATED STATEMENTS OF EARNINGS",
        "CONSOLIDATED STATEMENTS OF OPERATIONS",
        "CONSOLIDATED BALANCE SHEETS",
        "CONSOLIDATED STATEMENTS OF CASH FLOWS",
        "STATEMENTS OF EARNINGS",
        "STATEMENTS OF OPERATIONS",
        "BALANCE SHEETS",
        "INCOME STATEMENT",
        "TOTAL ASSETS",
        "TOTAL LIABILITIES",
        "NET REVENUES",
        "NET SALES",
        "NET INCOME",
        "FISCAL YEAR ENDED",
        # 中文
        "合并利润表",
        "合并资产负债表",
        "合并现金流量表",
        "利润表",
        "资产负债表",
        "现金流量表",
        "营业收入",
        "营业总收入",
        "净利润",
        "资产总计",
        "负债合计",
        "所有者权益",
        "基本每股收益",
        "毛利率",
        "净资产收益率",
    ]

    upper_text = text.upper()
    # 找到所有关键段落的位置
    key_positions: list[int] = []
    for marker in section_markers:
        pos = upper_text.find(marker.upper()) if marker.isascii() else text.find(marker)
        if pos >= 0:
            key_positions.append(pos)

    if not key_positions:
        # 没找到关键段落，取前面和后面
        half = max_len // 2
        return text[:half] + "\n...（中间部分已省略）...\n" + text[-half:]

    # 围绕每个关键位置取上下文窗口
    window = 3000  # 每个关键位置前后各取3000字符
    intervals: list[tuple[int, int]] = []
    # 始终保留开头（报告标题/期间信息）
    intervals.append((0, min(2000, len(text))))
    for pos in sorted(set(key_positions)):
        start = max(0, pos - window)
        end = min(len(text), pos + window)
        intervals.append((start, end))

    # 合并重叠区间
    intervals.sort()
    merged: list[tuple[int, int]] = [intervals[0]]
    for s, e in intervals[1:]:
        if s <= merged[-1][1] + 200:  # 允许200字符间隙也合并
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))

    # 拼接
    parts: list[str] = []
    total = 0
    for i, (s, e) in enumerate(merged):
        chunk = text[s:e]
        if total + len(chunk) > max_len:
            remaining = max_len - total
            if remaining > 500:
                parts.append(chunk[:remaining])
            break
        parts.append(chunk)
        total += len(chunk)
        if i < len(merged) - 1:
            parts.append("\n...\n")
            total += 5

    result = "".join(parts)
    if len(result) < len(text):
        result += "\n...(部分内容已省略)"
    return result


def extract_financials_with_ai(pdf_text: str, api_key: Optional[str] = None, raise_on_error: bool = False) -> dict:
    """使用 AI 从 PDF 文本中提取财务数据"""
    key = api_key or get_api_key()
    if not key:
        if raise_on_error:
            raise RuntimeError("missing_api_key")
        return {}
    
    # 智能截断，保留财务报表关键段落
    pdf_text = _smart_truncate_for_ai(pdf_text, max_len=30000)
    
    prompt = """请从以下财务报表文本中提取关键财务数据。严格按照 JSON 格式返回，不要添加任何其他文字。

需要提取的字段（如果找不到则填 null）：
{
    "report_period": "报告期，格式：YYYY-MM-DD",
    "report_year": "报告年份，如 2024",
    "revenue": "营业收入/营业总收入/Total revenues/Net sales（数字）",
    "cost": "营业成本/Cost of sales/Cost of revenues（数字）",
    "gross_profit": "毛利润/Gross profit（数字）",
    "net_profit": "净利润/归属于股东的净利润/Net income（数字）",
    "total_assets": "资产总额/总资产/Total assets（数字）",
    "total_liabilities": "负债总额/总负债/Total liabilities（数字）",
    "total_equity": "股东权益/所有者权益/Total equity（数字）",
    "current_assets": "流动资产合计/Total current assets（数字）",
    "current_liabilities": "流动负债合计/Total current liabilities（数字）",
    "cash": "货币资金/现金及现金等价物/Cash and cash equivalents（数字）",
    "inventory": "存货/Inventories（数字）",
    "receivables": "应收账款/Accounts receivable（数字）",
    "fixed_assets": "固定资产/Property, plant and equipment（数字）",
    "gross_margin": "毛利率（百分比数字，如 32.5）",
    "net_margin": "净利率（百分比数字）",
    "roe": "净资产收益率/ROE（百分比数字）",
    "roa": "总资产收益率/ROA（百分比数字）",
    "current_ratio": "流动比率（数字）",
    "quick_ratio": "速动比率（数字）",
    "debt_ratio": "资产负债率（百分比数字）"
}

重要注意事项：
1. 金额数字不要包含逗号，直接返回数值
2. 请保持原始报表中的单位（如百万美元、百万元、元等），不需要做单位转换
3. 如果报表中标注了单位（如"in millions"、"百万元"、"万元"、"元"），请在返回的JSON中额外增加一个 "unit" 字段说明单位，如 "unit": "millions_usd" 或 "unit": "万元" 或 "unit": "元"
4. 百分比只返回数字部分，不要包含%符号
5. 如果有多个报告期的数据，请提取最新一期的数据
6. 负数用负号表示，不要用括号

财务报表文本：
""" + pdf_text + """

请直接返回 JSON，不要有任何前缀或后缀文字："""

    try:
        response = httpx.post(
            QWEN_API_URL,
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
            },
            json={
                "model": "qwen-plus",
                "input": {
                    "messages": [
                        {"role": "system", "content": "你是一个财务数据提取专家。你的任务是从财务报表文本中精确提取所有可用的财务数据。你只返回 JSON 格式的数据，不添加任何解释文字。请尽可能提取所有字段，不要遗漏。"},
                        {"role": "user", "content": prompt},
                    ]
                },
                "parameters": {
                    "temperature": 0.1,
                    "max_tokens": 2000,
                },
            },
            timeout=90.0,
        )
        response.raise_for_status()
        data = response.json()

        # 提取返回的文本
        text = ""
        if "output" in data and "text" in data["output"]:
            text = data["output"]["text"]
        elif "output" in data and "choices" in data["output"]:
            text = data["output"]["choices"][0]["message"]["content"]
        
        if not text:
            return {}
        
        text = text.strip()
        if text.startswith("```"):
            text = re.sub(r'^```(?:json)?\s*', '', text)
            text = re.sub(r'\s*```$', '', text)

        # 容错：截取最外层 JSON
        if "{" in text and "}" in text:
            start = text.find("{")
            end = text.rfind("}")
            if start >= 0 and end > start:
                text = text[start : end + 1]

        result = json.loads(text)
        return result

    except httpx.HTTPStatusError as e:
        resp = e.response
        try:
            body = resp.text
        except Exception:
            body = ""
        print(f"AI extraction HTTP error: {resp.status_code}, body: {body[:500]}")
        if raise_on_error:
            raise RuntimeError(f"qwen_http_{resp.status_code}:{body[:300]}")
        return {}
    except json.JSONDecodeError as e:
        print(f"JSON parse error: {e}, text: {text[:200] if text else 'empty'}")
        if raise_on_error:
            raise RuntimeError(f"qwen_json_parse_error:{e}")
        return {}
    except Exception as e:
        print(f"AI extraction error: {e}")
        if raise_on_error:
            raise RuntimeError(f"qwen_exception:{e}")
        return {}


def merge_ai_extracted_data(extracted: dict, ai_data: dict):
    """将 AI 提取的数据合并到已提取的数据中"""
    from core.pdf_analyzer import ExtractedFinancials
    
    # 映射关系
    field_map = {
        "report_period": "report_period",
        "report_year": "report_year",
        "revenue": "revenue",
        "cost": "cost",
        "net_profit": "net_profit",
        "total_assets": "total_assets",
        "total_liabilities": "total_liabilities",
        "total_equity": "total_equity",
        "gross_profit": "gross_profit",
        "current_assets": "current_assets",
        "current_liabilities": "current_liabilities",
        "cash": "cash",
        "inventory": "inventory",
        "receivables": "receivables",
        "fixed_assets": "fixed_assets",
        "gross_margin": "gross_margin_direct",
        "net_margin": "net_margin_direct",
        "roe": "roe_direct",
        "roa": "roa_direct",
        "current_ratio": "current_ratio_direct",
        "debt_ratio": "debt_ratio_direct",
    }
    
    def _to_float(v):
        try:
            if v is None:
                return None
            if isinstance(v, (int, float)):
                return float(v)
            sv = str(v).strip()
            if sv in ("", "null", "None", "nan", "NaN", "--"):
                return None
            return float(sv)
        except Exception:
            return None

    def _should_override(cur: float | None, ai: float | None, is_pct: bool) -> bool:
        if ai is None:
            return False
        if cur is None:
            return True
        if cur == 0.0:
            return True

        # 百分比字段：通常 0~100；明显越界就用 AI
        if is_pct:
            if not (0.0 <= cur <= 100.0) and (0.0 <= ai <= 100.0):
                return True
            return False

        # 金额字段：允许 AI 纠错数量级错误（>=10x）
        if cur != 0 and ai != 0:
            ratio = abs(ai / cur)
            if ratio >= 10 or ratio <= 0.1:
                return True
        return False

    overridden = []
    for ai_field, extracted_field in field_map.items():
        ai_value = _to_float(ai_data.get(ai_field))
        cur_value = _to_float(getattr(extracted, extracted_field, None))
        is_pct = ai_field in {
            "gross_margin",
            "net_margin",
            "roe",
            "roa",
            "debt_ratio",
        }
        if _should_override(cur_value, ai_value, is_pct=is_pct):
            try:
                setattr(extracted, extracted_field, ai_value)
                overridden.append(ai_field)
            except Exception:
                pass

    if overridden:
        try:
            setattr(extracted, "_ai_overrode", overridden)
        except Exception:
            pass


def analyze_financials_with_qwen(
    company_name: str,
    metrics: dict[str, float],
    api_key: Optional[str] = None,
) -> str:
    """使用千问分析财务数据"""
    key = api_key or get_api_key()
    if not key:
        return _generate_fallback_analysis(company_name, metrics)

    # 构建提示词
    metrics_text = "\n".join([f"- {k}: {v:.4f}" for k, v in metrics.items() if v is not None])

    prompt = f"""你是一位卖方研究员 + 买方投研经理，擅长把财务指标转化为可执行的投资建议。

请基于下列财务指标，为【{company_name}】生成一份“专业财务与投资建议报告”（中文）。

【输入财务指标】
{metrics_text}

【输出要求】
1) 输出必须结构化，使用清晰的小标题与条目。
2) 必须覆盖以下章节（缺失信息允许说明“数据不足/无法判断”）：
   - 一、投资结论摘要（3-6条要点）
   - 二、财务质量诊断（盈利能力/偿债能力/营运效率/资本结构）
   - 三、关键指标解读（对 ROE/ROA/毛利率/净利率/资产负债率/流动比率/速动比率/周转率 等进行解释，并给出判断区间）
   - 四、风险清单（至少5条：经营/财务/行业/政策/市场/治理等维度）
   - 五、情景分析（基准/乐观/悲观：分别给出关注点与可能触发条件）
   - 六、投资建议与策略（适合的投资者类型、建议仓位区间、关注的关键指标/事件、止损/风控框架）
   - 七、免责声明（明确非投资建议）
3) 语气专业、审慎，避免夸张承诺。
4) 控制在 800-1200 中文字左右。
5) 若某些指标含义不明确（如单位/口径），请先说明假设口径再给出结论。
"""

    try:
        response = httpx.post(
            QWEN_API_URL,
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
            },
            json={
                "model": "qwen-turbo",
                "input": {
                    "messages": [
                        {"role": "system", "content": "你是一位专业的财务分析师，擅长分析企业财务报表和财务指标。"},
                        {"role": "user", "content": prompt},
                    ]
                },
                "parameters": {
                    "temperature": 0.3,
                    "max_tokens": 1800,
                },
            },
            timeout=30.0,
        )
        response.raise_for_status()
        data = response.json()

        if "output" in data and "text" in data["output"]:
            return data["output"]["text"]
        elif "output" in data and "choices" in data["output"]:
            return data["output"]["choices"][0]["message"]["content"]
        else:
            return _generate_fallback_analysis(company_name, metrics)

    except httpx.HTTPStatusError as e:
        resp = e.response
        try:
            body = resp.text
        except Exception:
            body = ""
        print(f"Qwen API HTTP error: {resp.status_code}, body: {body[:500]}")
        return _generate_fallback_analysis(company_name, metrics)
    except Exception as e:
        print(f"Qwen API error: {e}")
        return _generate_fallback_analysis(company_name, metrics)


def _generate_fallback_analysis(company_name: str, metrics: dict[str, float]) -> str:
    """生成备用分析（当 API 不可用时）"""
    analysis_parts = []

    # 盈利能力
    gross_margin = metrics.get("GROSS_MARGIN")
    net_margin = metrics.get("NET_MARGIN")
    roe = metrics.get("ROE")

    if gross_margin is not None or net_margin is not None:
        if gross_margin and gross_margin > 40:
            analysis_parts.append(f"**盈利能力**：毛利率达到 {gross_margin:.2f}%，表现出色，产品具有较强的市场竞争力和定价能力。")
        elif gross_margin and gross_margin > 25:
            analysis_parts.append(f"**盈利能力**：毛利率为 {gross_margin:.2f}%，处于行业中等水平，盈利能力稳健。")
        elif gross_margin:
            analysis_parts.append(f"**盈利能力**：毛利率为 {gross_margin:.2f}%，相对较低，建议关注成本控制和产品结构优化。")

    # 偿债能力
    debt_asset = metrics.get("DEBT_ASSET")
    current_ratio = metrics.get("CURRENT_RATIO")

    if debt_asset is not None:
        if debt_asset < 40:
            analysis_parts.append(f"**偿债能力**：资产负债率仅 {debt_asset:.2f}%，财务结构非常稳健，偿债压力小。")
        elif debt_asset < 60:
            analysis_parts.append(f"**偿债能力**：资产负债率 {debt_asset:.2f}%，处于合理区间，财务风险可控。")
        else:
            analysis_parts.append(f"**偿债能力**：资产负债率达到 {debt_asset:.2f}%，财务杠杆较高，需关注偿债风险。")

    # 综合评分
    score = _calculate_health_score(metrics)
    if score >= 80:
        rating = "优秀"
    elif score >= 60:
        rating = "良好"
    elif score >= 40:
        rating = "一般"
    else:
        rating = "较差"

    analysis_parts.append(f"**综合评分**：财务健康度评分 **{score}分**（{rating}）。")

    # 投资建议
    if score >= 70:
        analysis_parts.append("**投资建议**：公司财务状况良好，具备一定的投资价值，建议持续关注业绩增长情况。")
    elif score >= 50:
        analysis_parts.append("**投资建议**：公司财务状况一般，建议谨慎投资，重点关注风险指标的变化趋势。")
    else:
        analysis_parts.append("**投资建议**：公司财务状况存在一定风险，建议暂时观望，等待基本面改善。")

    return "\n\n".join(analysis_parts)


def _calculate_health_score(metrics: dict[str, float]) -> int:
    from rating_engine import compute_enterprise_rating
    r = compute_enterprise_rating(
        net_margin=metrics.get("NET_MARGIN"),
        gross_margin=metrics.get("GROSS_MARGIN"),
        roe=metrics.get("ROE"),
        roa=metrics.get("ROA"),
        debt_ratio=metrics.get("DEBT_ASSET"),
        current_ratio=metrics.get("CURRENT_RATIO"),
        asset_turnover=metrics.get("ASSET_TURNOVER"),
        inv_turnover=metrics.get("INVENTORY_TURNOVER"),
        recv_turnover=metrics.get("RECEIVABLE_TURNOVER"),
        revenue_growth=metrics.get("REVENUE_GROWTH"),
        profit_growth=metrics.get("PROFIT_GROWTH"),
        pe_ratio=metrics.get("PE_RATIO"),
        operating_cash_flow=metrics.get("OPERATING_CASH_FLOW"),
        net_profit=metrics.get("NET_PROFIT"),
    )
    return round(r["total_score"])


def _calculate_rating_details(metrics: dict[str, float]) -> dict:
    from rating_engine import compute_enterprise_rating
    return compute_enterprise_rating(
        net_margin=metrics.get("NET_MARGIN"),
        gross_margin=metrics.get("GROSS_MARGIN"),
        roe=metrics.get("ROE"),
        roa=metrics.get("ROA"),
        debt_ratio=metrics.get("DEBT_ASSET"),
        current_ratio=metrics.get("CURRENT_RATIO"),
        asset_turnover=metrics.get("ASSET_TURNOVER"),
        inv_turnover=metrics.get("INVENTORY_TURNOVER"),
        recv_turnover=metrics.get("RECEIVABLE_TURNOVER"),
        revenue_growth=metrics.get("REVENUE_GROWTH"),
        profit_growth=metrics.get("PROFIT_GROWTH"),
        pe_ratio=metrics.get("PE_RATIO"),
        operating_cash_flow=metrics.get("OPERATING_CASH_FLOW"),
        net_profit=metrics.get("NET_PROFIT"),
    )
