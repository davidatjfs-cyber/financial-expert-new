"""
Enterprise Credit Rating Engine
8-dimension scoring system (0-100) with letter grades (AAA-CCC)
Reference: Moody's/S&P credit rating methodology + Morningstar equity research
"""

import json
import datetime as dt
from collections import defaultdict


def _score_scale(val, low, mid, high, reverse=False):
    """Map a value to 0-25 score scale with interpolation.
    low=7.5pts, mid=15pts, high=25pts. reverse=True for lower-is-better metrics."""
    if val is None:
        return 0
    if reverse:
        val = -val
        low, mid, high = -low, -mid, -high
    if val >= high:
        return 25
    elif val >= mid:
        t = (val - mid) / max(high - mid, 1e-9)
        return 15 + t * 10
    elif val >= low:
        t = (val - low) / max(mid - low, 1e-9)
        return 7.5 + t * 7.5
    else:
        t = val / max(low, 1e-9) if low > 0 else 0
        return max(0, t * 7.5)


def compute_enterprise_rating(
    net_margin=None,
    gross_margin=None,
    roe=None,
    roa=None,
    debt_ratio=None,
    current_ratio=None,
    interest_coverage=None,
    asset_turnover=None,
    inv_turnover=None,
    recv_turnover=None,
    revenue_growth=None,
    profit_growth=None,
    pe_ratio=None,
    pb_ratio=None,
    ps_ratio=None,
    industry_pe=None,
    industry_pb=None,
    industry_ps=None,
    operating_cash_flow=None,
    net_profit=None,
    free_cash_flow=None,
    gross_margin_3y=None,
    market_cap_rank=None,
    industry_avg_debt=None,
    industry_avg_roe=None,
    industry_avg_margin=None,
):
    """8-dimension enterprise rating. Returns dict with total score, grade, and details."""

    dims = {}

    # === DIMENSION 1: Profitability (20%) ===
    p_scores = {}
    p_scores["net_margin"] = _score_scale(net_margin, 3, 10, 25)
    p_scores["gross_margin"] = _score_scale(gross_margin, 20, 40, 70)
    if net_margin is not None and gross_margin is not None:
        expense = gross_margin - net_margin
        p_scores["expense_control"] = _score_scale(expense, 50, 25, 10, reverse=True)
    else:
        p_scores["expense_control"] = 0
    p_avg = sum(p_scores.values()) / len(p_scores) if p_scores else 0
    dims["profitability"] = {
        "score": round(p_avg, 1),
        "max": 25,
        "weight": 0.20,
        "weighted": round(p_avg * 0.20, 2),
        "details": {k: round(v, 1) for k, v in p_scores.items()},
        "label": "盈利能力",
    }

    # === DIMENSION 2: Capital Efficiency (15%) ===
    c_scores = {}
    c_scores["roe"] = _score_scale(roe, 5, 15, 30)
    c_scores["roa"] = _score_scale(roa, 2, 8, 18)
    if roe is not None and roa is not None and roe > 0:
        leverage_quality = roa / max(roe, 1e-9)
        c_scores["leverage_quality"] = _score_scale(leverage_quality, 0.15, 0.4, 0.7)
    else:
        c_scores["leverage_quality"] = 0
    c_avg = sum(c_scores.values()) / len(c_scores) if c_scores else 0
    dims["capital_efficiency"] = {
        "score": round(c_avg, 1),
        "max": 25,
        "weight": 0.15,
        "weighted": round(c_avg * 0.15, 2),
        "label": "资本效率",
    }

    # === DIMENSION 3: Financial Safety (15%) ===
    f_scores = {}
    f_scores["debt_ratio"] = _score_scale(debt_ratio, 70, 50, 30, reverse=True)
    f_scores["current_ratio"] = _score_scale(current_ratio, 0.8, 1.5, 3.0)
    if interest_coverage is not None:
        f_scores["interest_coverage"] = _score_scale(interest_coverage, 1.5, 4, 10)
    else:
        f_scores["interest_coverage"] = 0
    f_avg = sum(f_scores.values()) / len(f_scores) if f_scores else 0
    dims["financial_safety"] = {
        "score": round(f_avg, 1),
        "max": 25,
        "weight": 0.15,
        "weighted": round(f_avg * 0.15, 2),
        "label": "财务安全",
    }

    # === DIMENSION 4: Operating Efficiency (10%) ===
    o_scores = {}
    o_scores["asset_turnover"] = _score_scale(asset_turnover, 0.3, 0.8, 2.0)
    o_scores["inv_turnover"] = _score_scale(inv_turnover, 2, 6, 15)
    o_scores["recv_turnover"] = _score_scale(recv_turnover, 3, 8, 20)
    o_avg = sum(o_scores.values()) / len(o_scores) if o_scores else 0
    dims["operating_efficiency"] = {
        "score": round(o_avg, 1),
        "max": 25,
        "weight": 0.10,
        "weighted": round(o_avg * 0.10, 2),
        "label": "营运效率",
    }

    # === DIMENSION 5: Growth (15%) ===
    g_scores = {}
    g_scores["revenue_growth"] = _score_scale(revenue_growth, -5, 10, 30)
    g_scores["profit_growth"] = _score_scale(profit_growth, -10, 15, 40)
    g_avg = sum(g_scores.values()) / len(g_scores) if g_scores else 0
    dims["growth"] = {
        "score": round(g_avg, 1),
        "max": 25,
        "weight": 0.15,
        "weighted": round(g_avg * 0.15, 2),
        "label": "成长性",
    }

    # === DIMENSION 6: Valuation (10%) ===
    v_scores = {}
    if pe_ratio is not None and industry_pe is not None and industry_pe > 0:
        pe_relative = pe_ratio / industry_pe
        v_scores["pe_relative"] = _score_scale(pe_relative, 2.0, 1.2, 0.6, reverse=True)
    elif pe_ratio is not None:
        v_scores["pe_absolute"] = _score_scale(pe_ratio, 50, 20, 8, reverse=True)
    else:
        v_scores["pe"] = 0

    if pb_ratio is not None and industry_pb is not None and industry_pb > 0:
        pb_relative = pb_ratio / industry_pb
        v_scores["pb_relative"] = _score_scale(pb_relative, 2.5, 1.3, 0.5, reverse=True)
    elif pb_ratio is not None:
        v_scores["pb_absolute"] = _score_scale(pb_ratio, 5, 2, 0.8, reverse=True)

    if ps_ratio is not None and industry_ps is not None and industry_ps > 0:
        ps_relative = ps_ratio / industry_ps
        v_scores["ps_relative"] = _score_scale(ps_relative, 2.5, 1.2, 0.5, reverse=True)
    elif ps_ratio is not None:
        v_scores["ps_absolute"] = _score_scale(ps_ratio, 8, 3, 0.5, reverse=True)

    v_avg = sum(v_scores.values()) / len(v_scores) if v_scores else 0
    dims["valuation"] = {
        "score": round(v_avg, 1),
        "max": 25,
        "weight": 0.10,
        "weighted": round(v_avg * 0.10, 2),
        "label": "估值水平",
    }

    # === DIMENSION 7: Cash Flow Quality (10%) ===
    cf_scores = {}
    if operating_cash_flow is not None and net_profit is not None and abs(net_profit) > 1e-9:
        cfo_np_ratio = operating_cash_flow / abs(net_profit)
        cf_scores["cfo_quality"] = _score_scale(cfo_np_ratio, 0.5, 1.0, 1.5)
    else:
        cf_scores["cfo_quality"] = 0

    if free_cash_flow is not None:
        cf_scores["fcf"] = _score_scale(free_cash_flow, -0.05, 0.02, 0.08)
    else:
        cf_scores["fcf"] = 0

    cf_avg = sum(cf_scores.values()) / len(cf_scores) if cf_scores else 0
    dims["cash_flow"] = {
        "score": round(cf_avg, 1),
        "max": 25,
        "weight": 0.10,
        "weighted": round(cf_avg * 0.10, 2),
        "label": "现金流质量",
    }

    # === DIMENSION 8: Moat (5%) ===
    m_scores = {}
    if gross_margin_3y is not None and len(gross_margin_3y) >= 3:
        gm_std = _std(gross_margin_3y)
        m_scores["margin_stability"] = _score_scale(gm_std, 8, 3, 1, reverse=True)
    elif gross_margin is not None:
        m_scores["margin_stability"] = 12.5
    else:
        m_scores["margin_stability"] = 0

    if market_cap_rank is not None:
        m_scores["market_position"] = _score_scale(market_cap_rank, 50, 20, 5, reverse=True)
    elif gross_margin is not None and gross_margin > 50:
        m_scores["market_position"] = 18.0
    else:
        m_scores["market_position"] = 5.0

    m_avg = sum(m_scores.values()) / len(m_scores) if m_scores else 0
    dims["moat"] = {
        "score": round(m_avg, 1),
        "max": 25,
        "weight": 0.05,
        "weighted": round(m_avg * 0.05, 2),
        "label": "护城河",
    }

    # === AGGREGATE ===
    total = sum(d["weighted"] for d in dims.values())
    total_pct = total / 25.0 * 100  # normalize to 0-100

    # Letter grade (Moody's-style)
    if total_pct >= 90:
        grade = "AAA"
    elif total_pct >= 80:
        grade = "AA"
    elif total_pct >= 70:
        grade = "A"
    elif total_pct >= 60:
        grade = "BBB"
    elif total_pct >= 50:
        grade = "BB"
    elif total_pct >= 35:
        grade = "B"
    else:
        grade = "CCC"

    # Investment recommendation
    if total_pct >= 75:
        recommendation = "优质标的，估值合理时可积极配置"
    elif total_pct >= 60:
        recommendation = "基本面稳健，关注估值安全边际后可配置"
    elif total_pct >= 45:
        recommendation = "基本面中等，需等待更多积极信号"
    elif total_pct >= 30:
        recommendation = "基本面偏弱，谨慎观望"
    else:
        recommendation = "财务风险较高，建议回避"

    # Risk flags
    risks = []
    if debt_ratio is not None and debt_ratio > 70:
        risks.append("高负债率(>70%)")
    if current_ratio is not None and current_ratio < 1.0:
        risks.append("流动比率不足(<1.0)")
    if net_margin is not None and net_margin < 3:
        risks.append("净利率极低(<3%)")
    if roe is not None and roe < 5:
        risks.append("ROE过低(<5%)")
    if revenue_growth is not None and revenue_growth < -10:
        risks.append("营收大幅下滑(>-10%)")

    # Strength flags
    strengths = []
    if roe is not None and roe > 20:
        strengths.append("ROE优秀(>20%)")
    if gross_margin is not None and gross_margin > 50:
        strengths.append("强定价权(毛利率>50%)")
    if net_margin is not None and net_margin > 20:
        strengths.append("高利润率(>20%)")
    if debt_ratio is not None and debt_ratio < 30:
        strengths.append("极低负债(<30%)")
    if revenue_growth is not None and revenue_growth > 20:
        strengths.append("高增长(>20%)")

    # Dimension summary for quick display
    dim_summary = {}
    for k, d in dims.items():
        pct = d["score"] / d["max"] * 100 if d["max"] else 0
        if pct >= 80:
            flag = "强"
        elif pct >= 60:
            flag = "良"
        elif pct >= 40:
            flag = "中"
        else:
            flag = "弱"
        dim_summary[d["label"]] = {"score": round(d["score"], 1), "pct": round(pct, 0), "flag": flag, "weight": d["weight"]}

    return {
        "total_score": round(total_pct, 1),
        "grade": grade,
        "recommendation": recommendation,
        "dimensions": dims,
        "dim_summary": dim_summary,
        "risks": risks,
        "strengths": strengths,
    }


def _std(values):
    if not values or len(values) < 2:
        return 0
    n = len(values)
    mean = sum(values) / n
    variance = sum((x - mean) ** 2 for x in values) / (n - 1)
    return variance ** 0.5