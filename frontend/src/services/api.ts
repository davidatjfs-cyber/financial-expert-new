/**
 * API service for connecting to the FastAPI backend
 */

// Dynamically determine API URL based on current host
function getApiBaseUrl(): string {
  const envUrl = process.env.NEXT_PUBLIC_API_BASE_URL || process.env.NEXT_PUBLIC_API_URL;
  const normalize = (u: string) => u.replace(/\/+$/, '');

  if (typeof window === 'undefined') {
    return normalize(envUrl || 'http://api:8000');
  }

  if (envUrl) {
    return normalize(envUrl);
  }

  // Default (browser): use same origin, so nginx can reverse-proxy /api to backend.
  return '';
}

// ============ Types ============

export interface RecommendStock {
  symbol: string;
  name: string;
  market: string;
  value_score: number;
  growth_score: number;
  quality_score: number;
  tech_score: number;
  total_score: number;
  pe_ratio: number | null;
  revenue_growth: number | null;
  net_profit_growth: number | null;
  roe: number | null;
  gross_margin: number | null;
  rsi14: number | null;
  slope_pct: number | null;
  buy_price_aggressive: number | null;
  sell_price: number | null;
  strategy_buy_zone_low?: number | null;
  strategy_buy_zone_high?: number | null;
  strategy_stop_loss?: number | null;
  strategy_take_profit_1?: number | null;
  strategy_take_profit_2?: number | null;
  buy_score: number | null;
  sell_score: number | null;
  buy_grade: string | null;
  sell_grade: string | null;
  action: string | null;
  quality_score_total: number | null;
  timing_score_total: number | null;
  sector_name: string | null;
  sector_strength_score: number | null;
  recommendation_bucket: string | null;
  timing_signal_reason: string | null;
  trend: string | null;
  reason: string;
  rank: number;
  recommend_date?: string;
}

export interface RecommendScanStatus {
  status: 'idle' | 'running' | 'done' | 'error';
  progress: number;
  message: string;
}

export interface SectorInfo {
  label: string;
  name: string;
  count: number;
}

export interface SectorsResponse {
  sectors: SectorInfo[];
  count: number;
}

export interface RecommendLatestResponse {
  results: RecommendStock[];
  count: number;
  message?: string;
}

export interface Stats {
  total: number;
  done: number;
  risks: number;
  rate: number;
}

export interface Report {
  id: string;
  report_name: string;
  source_type: string;
  period_type: string;
  period_end: string;
  status: 'done' | 'running' | 'failed' | 'pending';
  created_at: number;
  updated_at: number;
  company_id?: string;
}

export interface ReportDetail extends Report {
  error_message?: string;
  created_at: number;
  company_id?: string;
  market?: string;
  industry_code?: string;
}

export interface CompanyHistory {
  company_name: string;
  website?: string | null;
  source_url?: string | null;
  history_text: string;
}

export interface PortfolioPosition {
  id: string;
  market: string;
  symbol: string;
  name?: string | null;
  quantity: number;
  avg_cost: number;
  target_buy_price?: number | null;
  target_sell_price?: number | null;
  current_price?: number | null;
  market_value?: number | null;
  unrealized_pnl?: number | null;
  unrealized_pnl_pct?: number | null;
  strategy_buy_price?: number | null;
  strategy_buy_ok?: boolean | null;
  strategy_buy_reason?: string | null;
  strategy_buy_desc?: string | null;
  strategy_sell_price?: number | null;
  strategy_sell_ok?: boolean | null;
  strategy_sell_reason?: string | null;
  strategy_sell_desc?: string | null;
  updated_at: number;
  holdings_breakdown?: {
    manual?: { quantity: number; avg_cost: number; market_value: number; unrealized_pnl: number; unrealized_pnl_pct: number } | null;
    agent_a?: { quantity: number; avg_cost: number; market_value: number; unrealized_pnl: number; unrealized_pnl_pct: number } | null;
    agent_b?: { quantity: number; avg_cost: number; market_value: number; unrealized_pnl: number; unrealized_pnl_pct: number } | null;
  } | null;
}

export interface PortfolioCreatePositionRequest {
  market: string;
  symbol: string;
  name?: string | null;
  target_buy_price?: number | null;
  target_sell_price?: number | null;
}

export interface PortfolioUpdatePositionRequest {
  name?: string | null;
  target_buy_price?: number | null;
  target_sell_price?: number | null;
}

export interface PortfolioTradeRequest {
  position_id: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  source?: 'manual' | 'auto_strategy' | 'auto_strategy_a' | 'auto_strategy_b' | 'auto_order';
}

export interface PortfolioTrade {
  id: string;
  position_id: string;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  amount: number;
  fee: number;
  source: 'manual' | 'auto_strategy' | 'auto_strategy_a' | 'auto_strategy_b' | 'auto_order';
  symbol?: string | null;
  name?: string | null;
  market?: string | null;
  created_at: number;
   realized_pnl?: number | null;
}

export interface PortfolioSummary {
  total_cost: number;
  total_market_value: number;
  unrealized_pnl: number;
  unrealized_pnl_pct: number;
  realized_pnl: number;
  total_trades: number;
  total_buy_amount: number;
  total_hold_amount: number;
  manual: PortfolioSourceSummary;
  agent_a: PortfolioSourceSummary;
  agent_b: PortfolioSourceSummary;
}

export interface PortfolioSourceSummary {
  total_cost: number;
  total_market_value: number;
  unrealized_pnl: number;
  unrealized_pnl_pct: number;
  realized_pnl: number;
  total_trades: number;
  total_buy_amount: number;
  total_hold_amount: number;
}

export interface PortfolioAgentConfig {
  agent_id: string;
  enabled: boolean;
  target_profit?: number | null;
  deadline_ts?: number | null;
  capital: number;
  min_buy_quantity: number;
  last_run_at?: number | null;
  last_action?: string | null;
  last_status?: string | null;
}

export interface PortfolioAgentStatus {
  agent_id: string;
  agent_type: string;
  enabled: boolean;
  market_scope: 'CN' | string;
  target_profit?: number | null;
  deadline_ts?: number | null;
  capital: number;
  min_buy_quantity: number;
  managed_capital: number;
  managed_realized_pnl: number;
  managed_unrealized_pnl: number;
  managed_net_pnl: number;
  managed_net_return_rate: number;
  realized_pnl: number;
  unrealized_pnl: number;
  net_pnl: number;
  target_progress_pct: number;
  auto_trade_count: number;
  auto_pick_count: number;
  auto_pick_success_count: number;
  auto_pick_closed_count: number;
  auto_pick_success_rate: number;
  capital_utilization_pct: number;
  avg_closed_pick_pnl: number;
  avg_closed_pick_days: number;
  max_drawdown_pct: number;
  managed_remaining_capital: number;
  last_run_at?: number | null;
  last_action?: string | null;
  last_status?: string | null;
}

export interface PortfolioReturns {
  today_pnl: number;
  week_pnl: number;
  month_pnl: number;
  total_pnl: number;
  realized_pnl: number;
  unrealized_pnl: number;
  manual: PortfolioSourceReturns;
  agent_a: PortfolioSourceReturns;
  agent_b: PortfolioSourceReturns;
}

export interface PortfolioSourceReturns {
  today_pnl: number;
  week_pnl: number;
  month_pnl: number;
  total_pnl: number;
  realized_pnl: number;
  unrealized_pnl: number;
  net_return_rate?: number;
}

export interface PortfolioAlert {
  key: string;
  position_id: string;
  market: string;
  symbol: string;
  name?: string | null;
  alert_type: string;
  message: string;
  current_price?: number | null;
  trigger_price?: number | null;
}

export interface Metric {
  metric_code: string;
  metric_name: string;
  value: number | null;
  unit?: string;
  period_end: string;
}

export interface Alert {
  id: string;
  alert_code: string;
  level: 'high' | 'medium' | 'low';
  title: string;
  message: string;
  period_end: string;
}

export interface AlertsSummary {
  high: number;
  medium: number;
  low: number;
}

export interface StockSearchResult {
  symbol: string;
  name: string;
  market: string;
}

export interface StockPrice {
  symbol: string;
  name: string;
  market: string;
  price: number | null;
  change: number | null;
  change_pct: number | null;
  volume: number | null;
  market_cap: number | null;
  high: number | null;
  low: number | null;
  amount?: number | null;
  open?: number | null;
  prev_close?: number | null;
  turnover_rate?: number | null;
  volume_ratio?: number | null;
  amplitude?: number | null;
  bid?: number | null;
  ask?: number | null;
}

export interface StockIndicators {
  symbol: string;
  name?: string | null;
  market: string;
  currency?: string | null;
  as_of?: string | null;

  market_cap?: number | null;
  amount?: number | null;
  high_52w?: number | null;
  low_52w?: number | null;
  ma5?: number | null;
  ma20?: number | null;
  ma60?: number | null;
  slope_raw?: number | null;
  slope_pct?: number | null;
  trend?: string | null;
  slope_advice?: string | null;
  pe_ratio?: number | null;
  atr14?: number | null;
  rsi14?: number | null;
  rsi_rebound?: boolean | null;
  macd_dif?: number | null;
  macd_dea?: number | null;
  macd_hist?: number | null;

  buy_price_aggressive?: number | null;
  buy_price_stable?: number | null;
  sell_price?: number | null;

  strategy_action?: string | null;
  strategy_buy_zone_low?: number | null;
  strategy_buy_zone_high?: number | null;
  strategy_stop_loss?: number | null;
  strategy_take_profit_1?: number | null;
  strategy_take_profit_2?: number | null;
  strategy_sell_trigger?: string | null;
  strategy_buy_trigger?: string | null;
  indicator_reference_note?: string | null;
  ma60_reference?: string | null;
  slope_reference?: string | null;
  buy_score_reference?: string | null;
  sell_score_reference?: string | null;

  buy_condition_desc?: string | null;
  sell_condition_desc?: string | null;

  buy_reason?: string | null;
  sell_reason?: string | null;

  buy_price_aggressive_ok?: boolean | null;
  buy_price_stable_ok?: boolean | null;
  sell_price_ok?: boolean | null;

  signal_golden_cross?: boolean | null;
  signal_death_cross?: boolean | null;
  signal_macd_bullish?: boolean | null;
  signal_rsi_overbought?: boolean | null;
  signal_vol_gt_ma5?: boolean | null;
  signal_vol_gt_ma10?: boolean | null;
}

// ============ API Functions ============

async function fetchAPI<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${getApiBaseUrl()}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body?.detail) detail = body.detail;
    } catch {}
    throw new Error(detail);
  }

  return response.json();
}

/**
 * Get dashboard statistics
 */
export async function getStats(): Promise<Stats> {
  return fetchAPI<Stats>('/api/stats');
}

/**
 * Get list of reports
 */
export async function getReports(limit = 50, status?: string): Promise<Report[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (status) params.append('status', status);
  return fetchAPI<Report[]>(`/api/reports?${params}`);
}

/**
 * Get report details
 */
export async function getReportDetail(reportId: string): Promise<ReportDetail> {
  return fetchAPI<ReportDetail>(`/api/reports/${reportId}`);
}

export async function getReportCompanyHistory(reportId: string): Promise<CompanyHistory> {
  return fetchAPI<CompanyHistory>(`/api/reports/${reportId}/company-history`);
}

/**
 * Get computed metrics for a report
 */
export async function getReportMetrics(reportId: string): Promise<Metric[]> {
  return fetchAPI<Metric[]>(`/api/reports/${reportId}/metrics`);
}

/**
 * Get alerts for a report
 */
export async function getReportAlerts(reportId: string): Promise<Alert[]> {
  return fetchAPI<Alert[]>(`/api/reports/${reportId}/alerts`);
}

export async function reanalyzeReport(reportId: string): Promise<{ report_id: string; status: string; message: string }> {
  return fetchAPI<{ report_id: string; status: string; message: string }>(`/api/reports/${reportId}/reanalyze`, {
    method: 'POST',
  });
}

/**
 * Get all alerts
 */
export async function getAllAlerts(level?: string, limit = 50): Promise<Alert[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (level) params.append('level', level);
  return fetchAPI<Alert[]>(`/api/alerts?${params}`);
}

/**
 * Get alerts summary
 */
export async function getAlertsSummary(): Promise<AlertsSummary> {
  return fetchAPI<AlertsSummary>('/api/alerts/summary');
}

/**
 * Search for stocks
 */
export async function searchStocks(query: string, market = 'ALL'): Promise<StockSearchResult[]> {
  const params = new URLSearchParams({ q: query, market });
  return fetchAPI<StockSearchResult[]>(`/api/stock/search?${params}`);
}

/**
 * Get stock price
 */
export async function getStockPrice(symbol: string, market: string = 'CN') {
  return fetchAPI<StockPrice | null>(`/api/stock/price?symbol=${encodeURIComponent(symbol)}&market=${market}`);
}

/**
 * Get stock indicators
 */
export async function getStockIndicators(symbol: string, market: string = 'CN') {
  return fetchAPI<StockIndicators | null>(`/api/stock/indicators?symbol=${encodeURIComponent(symbol)}&market=${market}`);
}

export interface StockAnnouncement {
  title: string;
  date?: string | null;
  url?: string | null;
}

export async function getStockAnnouncements(symbol: string, market: string = 'CN', limit: number = 5) {
  return fetchAPI<StockAnnouncement[]>(`/api/stock/announcements?symbol=${encodeURIComponent(symbol)}&market=${market}&limit=${limit}`);
}

/**
 * Portfolio - list positions
 */
export async function getPortfolioPositions() {
  return fetchAPI<PortfolioPosition[]>(`/api/portfolio/positions`);
}

/**
 * Portfolio - create position
 */
export async function createPortfolioPosition(req: PortfolioCreatePositionRequest) {
  return fetchAPI<PortfolioPosition>(`/api/portfolio/positions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
}

/**
 * Portfolio - update position
 */
export async function updatePortfolioPosition(positionId: string, req: PortfolioUpdatePositionRequest) {
  return fetchAPI<PortfolioPosition>(`/api/portfolio/positions/${encodeURIComponent(positionId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
}

/**
 * Portfolio - delete position
 */
export async function deletePortfolioPosition(positionId: string) {
  return fetchAPI<{ ok: boolean }>(`/api/portfolio/positions/${encodeURIComponent(positionId)}`, {
    method: 'DELETE',
  });
}

/**
 * Portfolio - create trade (BUY/SELL). Price uses latest.
 */
export async function createPortfolioTrade(req: PortfolioTradeRequest) {
  return fetchAPI<PortfolioTrade>(`/api/portfolio/trades`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
}

export async function getPortfolioTrades(positionId?: string, limit: number = 100) {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (positionId) params.set('position_id', positionId);
  return fetchAPI<PortfolioTrade[]>(`/api/portfolio/trades?${params.toString()}`);
}

export async function getPortfolioSummary() {
  return fetchAPI<PortfolioSummary>(`/api/portfolio/summary`);
}

export async function getPortfolioAgentConfig(agentId: string = 'a') {
  return fetchAPI<PortfolioAgentConfig>(`/api/portfolio/agent/config?agent_id=${agentId}`);
}

export async function getPortfolioAgentStatus(agentId: string = 'a') {
  return fetchAPI<PortfolioAgentStatus>(`/api/portfolio/agent/status?agent_id=${agentId}`);
}

export async function getPortfolioReturns() {
  return fetchAPI<PortfolioReturns>(`/api/portfolio/returns`);
}

export async function updatePortfolioAgentConfig(req: PortfolioAgentConfig) {
  return fetchAPI<PortfolioAgentConfig>(`/api/portfolio/agent/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
}

export async function runPortfolioAgentNow(agentId: string = 'a') {
  return fetchAPI<{ ok: boolean; message: string; trade?: PortfolioTrade }>(`/api/portfolio/agent/run?agent_id=${agentId}`, {
    method: 'POST',
  });
}

/**
 * Portfolio - alerts
 */
export async function getPortfolioAlerts() {
  return fetchAPI<PortfolioAlert[]>(`/api/portfolio/alerts`);
}

export interface PortfolioAutoTrade {
  id: string;
  position_id: string;
  side: 'BUY' | 'SELL';
  trigger_price: number;
  quantity: number;
  status: 'PENDING' | 'EXECUTED' | 'CANCELLED';
  created_at: number;
  executed_at?: number | null;
  executed_price?: number | null;
  symbol?: string | null;
  name?: string | null;
  market?: string | null;
}

export interface PortfolioAutoTradeRequest {
  position_id: string;
  side: 'BUY' | 'SELL';
  trigger_price: number;
  quantity: number;
}

export async function getPortfolioAutoTrades() {
  return fetchAPI<PortfolioAutoTrade[]>(`/api/portfolio/auto-trades`);
}

export async function createPortfolioAutoTrade(req: PortfolioAutoTradeRequest) {
  return fetchAPI<PortfolioAutoTrade>(`/api/portfolio/auto-trades`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
}

export async function cancelPortfolioAutoTrade(autoTradeId: string) {
  return fetchAPI<{ ok: boolean }>(`/api/portfolio/auto-trades/${encodeURIComponent(autoTradeId)}`, {
    method: 'DELETE',
  });
}

/**
 * Upload a financial report file
 */
export async function uploadReport(
  file: File,
  companyName: string,
  periodType: string,
  periodEnd: string,
  market?: string,
  symbol?: string
): Promise<{ report_id: string; message: string }> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('company_name', companyName);
  formData.append('period_type', periodType);
  formData.append('period_end', periodEnd);
  if (market && market.trim()) formData.append('market', market.trim());
  if (symbol && symbol.trim()) formData.append('symbol', symbol.trim());

  const response = await fetch(`${getApiBaseUrl()}/api/reports/upload`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Fetch market report for a stock
 */
export async function fetchMarketReport(
  symbol: string,
  market = 'CN',
  periodType = 'annual',
  periodEnd?: string,
  companyName?: string
): Promise<{ report_id: string; message: string }> {
  const params = new URLSearchParams({
    symbol,
    market,
    period_type: periodType,
  });

  if (periodEnd && periodEnd.trim()) {
    params.set('period_end', periodEnd.trim());
  }

  if (companyName && companyName.trim()) {
    params.set('company_name', companyName.trim());
  }

  return fetchAPI(`/api/reports/fetch?${params}`, { method: 'POST' });
}

export async function startRecommendScan(topN: number = 20, useAi: boolean = true, sector?: string) {
  const body: Record<string, unknown> = { top_n: topN, use_ai: useAi };
  if (sector) body.sector = sector;
  return fetchAPI<{ status: string; message: string }>(`/api/recommend/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function getRecommendSectors(): Promise<SectorsResponse> {
  return fetchAPI<SectorsResponse>('/api/recommend/sectors');
}

export async function getRecommendScanStatus(): Promise<RecommendScanStatus> {
  return fetchAPI<RecommendScanStatus>('/api/recommend/scan/status');
}

export async function getRecommendLatest(): Promise<RecommendLatestResponse> {
  return fetchAPI<RecommendLatestResponse>('/api/recommend/latest');
}
