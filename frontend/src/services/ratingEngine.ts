/**
 * Enterprise Credit Rating Engine - 8-dimension scoring system
 * Translated from Python rating_engine.py
 * Reference: Moody's/S&P credit rating methodology + Morningstar equity research
 */

interface DimResult {
  score: number;
  max: number;
  weight: number;
  weighted: number;
  label: string;
  details: Record<string, number>;
}

interface RatingResult {
  total_score: number;
  grade: string;
  recommendation: string;
  dimensions: Record<string, DimResult>;
  dim_summary: Record<string, { score: number; pct: number; flag: string; weight: number }>;
  risks: string[];
  strengths: string[];
}

function _scoreScale(
  val: number | null | undefined,
  low: number,
  mid: number,
  high: number,
  reverse = false
): number {
  if (val == null) return 0;
  let v = val;
  let lo = low,
    mi = mid,
    hi = high;
  if (reverse) {
    v = -v;
    lo = -lo;
    mi = -mi;
    hi = -hi;
  }
  if (v >= hi) return 25;
  if (v >= mi) {
    const t = (v - mi) / Math.max(hi - mi, 1e-9);
    return 15 + t * 10;
  }
  if (v >= lo) {
    const t = (v - lo) / Math.max(mi - lo, 1e-9);
    return 7.5 + t * 7.5;
  }
  const t = lo > 0 ? v / lo : 0;
  return Math.max(0, t * 7.5);
}

function avg(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export interface RatingInput {
  net_margin?: number | null;
  gross_margin?: number | null;
  roe?: number | null;
  roa?: number | null;
  debt_ratio?: number | null;
  current_ratio?: number | null;
  asset_turnover?: number | null;
  inventory_turnover?: number | null;
  receivable_turnover?: number | null;
  revenue_growth?: number | null;
  profit_growth?: number | null;
  pe_ratio?: number | null;
  operating_cash_flow?: number | null;
  net_profit?: number | null;
  total_assets?: number | null;
}

export function computeEnterpriseRating(inp: RatingInput): RatingResult {
  const dims: Record<string, DimResult> = {};

  // === DIM 1: Profitability (20%) ===
  const pScores: Record<string, number> = {};
  pScores["net_margin"] = _scoreScale(inp.net_margin, 3, 10, 25);
  pScores["gross_margin"] = _scoreScale(inp.gross_margin, 20, 40, 70);
  if (inp.net_margin != null && inp.gross_margin != null) {
    pScores["expense_control"] = _scoreScale(
      inp.gross_margin - inp.net_margin,
      50,
      25,
      10,
      true
    );
  } else {
    pScores["expense_control"] = 0;
  }
  const pAvg = avg(Object.values(pScores));
  dims["profitability"] = {
    score: Math.round(pAvg * 10) / 10,
    max: 25,
    weight: 0.2,
    weighted: Math.round(pAvg * 0.2 * 100) / 100,
    label: "盈利能力",
    details: Object.fromEntries(
      Object.entries(pScores).map(([k, v]) => [k, Math.round(v * 10) / 10])
    ),
  };

  // === DIM 2: Capital Efficiency (15%) ===
  const cScores: Record<string, number> = {};
  cScores["roe"] = _scoreScale(inp.roe, 5, 15, 30);
  cScores["roa"] = _scoreScale(inp.roa, 2, 8, 18);
  if (inp.roe != null && inp.roa != null && inp.roe > 0) {
    cScores["leverage_quality"] = _scoreScale(inp.roa / inp.roe, 0.15, 0.4, 0.7);
  } else {
    cScores["leverage_quality"] = 0;
  }
  const cAvg = avg(Object.values(cScores));
  dims["capital_efficiency"] = {
    score: Math.round(cAvg * 10) / 10,
    max: 25,
    weight: 0.15,
    weighted: Math.round(cAvg * 0.15 * 100) / 100,
    label: "资本效率",
    details: Object.fromEntries(
      Object.entries(cScores).map(([k, v]) => [k, Math.round(v * 10) / 10])
    ),
  };

  // === DIM 3: Financial Safety (15%) ===
  const fScores: Record<string, number> = {};
  fScores["debt_ratio"] = _scoreScale(inp.debt_ratio, 70, 50, 30, true);
  fScores["current_ratio"] = _scoreScale(inp.current_ratio, 0.8, 1.5, 3.0);
  fScores["interest_coverage"] = 0;
  const fAvg = avg(Object.values(fScores));
  dims["financial_safety"] = {
    score: Math.round(fAvg * 10) / 10,
    max: 25,
    weight: 0.15,
    weighted: Math.round(fAvg * 0.15 * 100) / 100,
    label: "财务安全",
    details: Object.fromEntries(
      Object.entries(fScores).map(([k, v]) => [k, Math.round(v * 10) / 10])
    ),
  };

  // === DIM 4: Operating Efficiency (10%) ===
  const oScores: Record<string, number> = {};
  oScores["asset_turnover"] = _scoreScale(inp.asset_turnover, 0.3, 0.8, 2.0);
  oScores["inv_turnover"] = _scoreScale(inp.inventory_turnover, 2, 6, 15);
  oScores["recv_turnover"] = _scoreScale(inp.receivable_turnover, 3, 8, 20);
  const oAvg = avg(Object.values(oScores));
  dims["operating_efficiency"] = {
    score: Math.round(oAvg * 10) / 10,
    max: 25,
    weight: 0.1,
    weighted: Math.round(oAvg * 0.1 * 100) / 100,
    label: "营运效率",
    details: Object.fromEntries(
      Object.entries(oScores).map(([k, v]) => [k, Math.round(v * 10) / 10])
    ),
  };

  // === DIM 5: Growth (15%) ===
  const gScores: Record<string, number> = {};
  gScores["revenue_growth"] = _scoreScale(inp.revenue_growth, -5, 10, 30);
  gScores["profit_growth"] = _scoreScale(inp.profit_growth, -10, 15, 40);
  const gAvg = avg(Object.values(gScores));
  dims["growth"] = {
    score: Math.round(gAvg * 10) / 10,
    max: 25,
    weight: 0.15,
    weighted: Math.round(gAvg * 0.15 * 100) / 100,
    label: "成长性",
    details: Object.fromEntries(
      Object.entries(gScores).map(([k, v]) => [k, Math.round(v * 10) / 10])
    ),
  };

  // === DIM 6: Valuation (10%) ===
  const vScores: Record<string, number> = {};
  vScores["pe"] = _scoreScale(inp.pe_ratio, 50, 20, 8, true);
  const vAvg = avg(Object.values(vScores));
  dims["valuation"] = {
    score: Math.round(vAvg * 10) / 10,
    max: 25,
    weight: 0.1,
    weighted: Math.round(vAvg * 0.1 * 100) / 100,
    label: "估值水平",
    details: Object.fromEntries(
      Object.entries(vScores).map(([k, v]) => [k, Math.round(v * 10) / 10])
    ),
  };

  // === DIM 7: Cash Flow Quality (10%) ===
  const cfScores: Record<string, number> = {};
  if (
    inp.operating_cash_flow != null &&
    inp.net_profit != null &&
    Math.abs(inp.net_profit) > 1e-9
  ) {
    cfScores["cfo_quality"] = _scoreScale(
      inp.operating_cash_flow / Math.abs(inp.net_profit),
      0.5,
      1.0,
      1.5
    );
  } else {
    cfScores["cfo_quality"] = 0;
  }
  cfScores["fcf"] = 0;
  const cfAvg = avg(Object.values(cfScores));
  dims["cash_flow"] = {
    score: Math.round(cfAvg * 10) / 10,
    max: 25,
    weight: 0.1,
    weighted: Math.round(cfAvg * 0.1 * 100) / 100,
    label: "现金流质量",
    details: Object.fromEntries(
      Object.entries(cfScores).map(([k, v]) => [k, Math.round(v * 10) / 10])
    ),
  };

  // === DIM 8: Moat (5%) ===
  const mScores: Record<string, number> = {};
  if (inp.gross_margin != null) {
    mScores["margin_stability"] = inp.gross_margin >= 60 ? 22 : inp.gross_margin >= 40 ? 18 : inp.gross_margin >= 20 ? 12 : 5;
  } else {
    mScores["margin_stability"] = 0;
  }
  if (inp.gross_margin != null && inp.total_assets != null) {
    mScores["market_position"] =
      inp.gross_margin > 40 && inp.total_assets > 1e9
        ? 22
        : inp.gross_margin > 30 && inp.total_assets > 5e8
          ? 18
          : inp.gross_margin > 20
            ? 12
            : 5;
  } else if (inp.gross_margin != null && inp.gross_margin > 50) {
    mScores["market_position"] = 18;
  } else {
    mScores["market_position"] = 5;
  }
  const mAvg = avg(Object.values(mScores));
  dims["moat"] = {
    score: Math.round(mAvg * 10) / 10,
    max: 25,
    weight: 0.05,
    weighted: Math.round(mAvg * 0.05 * 100) / 100,
    label: "护城河",
    details: Object.fromEntries(
      Object.entries(mScores).map(([k, v]) => [k, Math.round(v * 10) / 10])
    ),
  };

  // === AGGREGATE ===
  const total = Object.values(dims).reduce((s, d) => s + d.weighted, 0);
  const totalPct = (total / 25) * 100;

  let grade: string;
  if (totalPct >= 90) grade = "AAA";
  else if (totalPct >= 80) grade = "AA";
  else if (totalPct >= 70) grade = "A";
  else if (totalPct >= 60) grade = "BBB";
  else if (totalPct >= 50) grade = "BB";
  else if (totalPct >= 35) grade = "B";
  else grade = "CCC";

  let recommendation: string;
  if (totalPct >= 75) recommendation = "优质标的，估值合理时可积极配置";
  else if (totalPct >= 60)
    recommendation = "基本面稳健，关注估值安全边际后可配置";
  else if (totalPct >= 45)
    recommendation = "基本面中等，需等待更多积极信号";
  else if (totalPct >= 30) recommendation = "基本面偏弱，谨慎观望";
  else recommendation = "财务风险较高，建议回避";

  const risks: string[] = [];
  if (inp.debt_ratio != null && inp.debt_ratio > 70) risks.push("高负债率(>70%)");
  if (inp.current_ratio != null && inp.current_ratio < 1.0)
    risks.push("流动比率不足(<1.0)");
  if (inp.net_margin != null && inp.net_margin < 3) risks.push("净利率极低(<3%)");
  if (inp.roe != null && inp.roe < 5) risks.push("ROE过低(<5%)");
  if (inp.revenue_growth != null && inp.revenue_growth < -10)
    risks.push("营收大幅下滑(>-10%)");

  const strengths: string[] = [];
  if (inp.roe != null && inp.roe > 20) strengths.push("ROE优秀(>20%)");
  if (inp.gross_margin != null && inp.gross_margin > 50)
    strengths.push("强定价权(毛利率>50%)");
  if (inp.net_margin != null && inp.net_margin > 20)
    strengths.push("高利润率(>20%)");
  if (inp.debt_ratio != null && inp.debt_ratio < 30)
    strengths.push("极低负债(<30%)");
  if (inp.revenue_growth != null && inp.revenue_growth > 20)
    strengths.push("高增长(>20%)");

  const dimSummary: Record<
    string,
    { score: number; pct: number; flag: string; weight: number }
  > = {};
  for (const [k, d] of Object.entries(dims)) {
    const pct = d.max ? (d.score / d.max) * 100 : 0;
    dimSummary[d.label] = {
      score: Math.round(d.score * 10) / 10,
      pct: Math.round(pct),
      flag: pct >= 80 ? "强" : pct >= 60 ? "良" : pct >= 40 ? "中" : "弱",
      weight: d.weight,
    };
  }

  return {
    total_score: Math.round(totalPct * 10) / 10,
    grade,
    recommendation,
    dimensions: dims,
    dim_summary: dimSummary,
    risks,
    strengths,
  };
}
