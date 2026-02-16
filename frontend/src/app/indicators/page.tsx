'use client';

import { useEffect, useRef, useState } from 'react';
import { Search, Plus, Trash2, TrendingUp, TrendingDown, X, Brain, Timer, XCircle } from 'lucide-react';
import {
  searchStocks,
  getPortfolioPositions,
  createPortfolioPosition,
  deletePortfolioPosition,
  createPortfolioTrade,
  updatePortfolioPosition,
  getPortfolioAlerts,
  getPortfolioAutoTrades,
  createPortfolioAutoTrade,
  cancelPortfolioAutoTrade,
  type PortfolioPosition,
  type PortfolioAlert,
  type PortfolioAutoTrade,
  type StockSearchResult,
} from '@/services/api';

const HOT_STOCKS = [
  { name: '腾讯控股', symbol: '00700.HK', market: 'HK' },
  { name: '阿里巴巴', symbol: 'BABA', market: 'US' },
  { name: '贵州茅台', symbol: '600519.SH', market: 'CN' },
  { name: '苹果公司', symbol: 'AAPL', market: 'US' },
  { name: '比亚迪', symbol: '002594.SZ', market: 'CN' },
  { name: '宁德时代', symbol: '300750.SZ', market: 'CN' },
  { name: '美团', symbol: '03690.HK', market: 'HK' },
  { name: '英伟达', symbol: 'NVDA', market: 'US' },
];

export default function PortfolioPage() {
  const [positions, setPositions] = useState<PortfolioPosition[]>([]);
  const [alerts, setAlerts] = useState<PortfolioAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  // Inline search (replaces modal)
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<StockSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const searchTimer = useRef<any>(null);
  const searchBoxRef = useRef<HTMLDivElement>(null);

  // Trade modal
  const [tradeTarget, setTradeTarget] = useState<PortfolioPosition | null>(null);
  const [tradeSide, setTradeSide] = useState<'BUY' | 'SELL'>('BUY');
  const [tradeQty, setTradeQty] = useState('');

  // AI Advice
  const [adviceTarget, setAdviceTarget] = useState<PortfolioPosition | null>(null);
  const [adviceText, setAdviceText] = useState('');
  const [adviceLoading, setAdviceLoading] = useState(false);
  const [adviceDataTime, setAdviceDataTime] = useState('');

  // Auto-trade
  const [autoTrades, setAutoTrades] = useState<PortfolioAutoTrade[]>([]);
  const [autoTradeTarget, setAutoTradeTarget] = useState<PortfolioPosition | null>(null);
  const [autoTradeSide, setAutoTradeSide] = useState<'BUY' | 'SELL'>('BUY');
  const [autoTradePrice, setAutoTradePrice] = useState('');
  const [autoTradeQty, setAutoTradeQty] = useState('');

  // Summary
  const totalCost = positions.reduce((s, p) => s + p.avg_cost * p.quantity, 0);
  const totalMarketValue = positions.reduce((s, p) => s + (p.market_value ?? 0), 0);
  const totalPnl = positions.reduce((s, p) => s + (p.unrealized_pnl ?? 0), 0);
  const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;

  const loadData = async () => {
    try {
      const [ps, al, ats] = await Promise.all([getPortfolioPositions(), getPortfolioAlerts(), getPortfolioAutoTrades()]);
      setPositions(ps);
      setAlerts(al);
      setAutoTrades(ats);
    } catch (e) {
      console.error('Failed to load portfolio:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    const timer = setInterval(loadData, 15_000);
    return () => clearInterval(timer);
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target as Node)) {
        setSearchFocused(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Fuzzy search with debounce
  const handleSearchInput = (val: string) => {
    setSearchQuery(val);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!val.trim()) {
      setSearchResults([]);
      return;
    }
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const results = await searchStocks(val.trim());
        setSearchResults(results);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 400);
  };

  const handleAddStock = async (stock: StockSearchResult | { name: string; symbol: string; market: string }) => {
    const key = `${stock.market}:${stock.symbol}`;
    setAdding(key);
    try {
      await createPortfolioPosition({ market: stock.market, symbol: stock.symbol, name: stock.name });
      setMessage(`已添加 ${stock.name || stock.symbol}`);
      setSearchQuery('');
      setSearchResults([]);
      setSearchFocused(false);
      await loadData();
    } catch {
      setMessage('添加失败，可能已存在');
    }
    setAdding(null);
    setTimeout(() => setMessage(null), 3000);
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`确认删除 ${name}？`)) return;
    try {
      await deletePortfolioPosition(id);
      await loadData();
    } catch {
      setMessage('删除失败');
      setTimeout(() => setMessage(null), 3000);
    }
  };

  const handleTrade = async () => {
    if (!tradeTarget) return;
    const qty = Number(tradeQty);
    if (!Number.isFinite(qty) || qty <= 0) {
      setMessage('请输入有效数量');
      setTimeout(() => setMessage(null), 3000);
      return;
    }
    try {
      await createPortfolioTrade({ position_id: tradeTarget.id, side: tradeSide, quantity: qty });
      setTradeTarget(null);
      setTradeQty('');
      await loadData();
      setMessage(`${tradeSide === 'BUY' ? '买入' : '卖出'}成功`);
    } catch {
      setMessage('交易失败，请重试');
    }
    setTimeout(() => setMessage(null), 3000);
  };

  const fetchAdvice = async (p: PortfolioPosition) => {
    setAdviceTarget(p);
    setAdviceText('');
    setAdviceDataTime('');
    setAdviceLoading(true);
    try {
      const resp = await fetch(`/api/portfolio/${encodeURIComponent(p.id)}/ai-advice`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      setAdviceText(data.advice || 'AI未返回有效建议');
      setAdviceDataTime(data.data_time || '');
    } catch (e: any) {
      setAdviceText(`获取建议失败：${e.message || '未知错误'}`);
    } finally {
      setAdviceLoading(false);
    }
  };

  const handleCreateAutoTrade = async () => {
    if (!autoTradeTarget) return;
    const price = Number(autoTradePrice);
    const qty = Number(autoTradeQty);
    if (!Number.isFinite(price) || price <= 0) {
      setMessage('请输入有效触发价格');
      setTimeout(() => setMessage(null), 3000);
      return;
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      setMessage('请输入有效数量');
      setTimeout(() => setMessage(null), 3000);
      return;
    }
    try {
      await createPortfolioAutoTrade({
        position_id: autoTradeTarget.id,
        side: autoTradeSide,
        trigger_price: price,
        quantity: qty,
      });
      setAutoTradeTarget(null);
      setAutoTradePrice('');
      setAutoTradeQty('');
      await loadData();
      setMessage(`自动${autoTradeSide === 'BUY' ? '买入' : '卖出'}订单已创建`);
    } catch {
      setMessage('创建自动交易失败');
    }
    setTimeout(() => setMessage(null), 3000);
  };

  const handleCancelAutoTrade = async (id: string) => {
    try {
      await cancelPortfolioAutoTrade(id);
      await loadData();
    } catch {
      setMessage('取消失败');
      setTimeout(() => setMessage(null), 3000);
    }
  };

  const pendingAutoTrades = autoTrades.filter(at => at.status === 'PENDING');

  const fmt = (v: number | null | undefined, digits = 2) => (v == null ? '-' : v.toFixed(digits));
  const fmtSigned = (v: number | null | undefined, digits = 2) => {
    if (v == null) return '-';
    const s = v.toFixed(digits);
    return v > 0 ? `+${s}` : s;
  };

  const showDropdown = searchFocused;

  return (
    <div className="p-4 md:p-8 flex flex-col gap-5 max-w-3xl mx-auto animate-fade-in">
      {/* Header */}
      <div>
        <h1 className="text-[var(--text-primary)] text-xl md:text-2xl font-bold tracking-tight">我的股票</h1>
        <p className="text-[var(--text-secondary)] text-sm mt-1">模拟买卖，实时追踪盈亏</p>
      </div>

      {/* Inline Search Bar - always visible */}
      <div ref={searchBoxRef} className="relative z-50">
        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" size={18} />
          <input
            type="text"
            placeholder="搜索并添加股票，如 AAPL、腾讯、600519"
            value={searchQuery}
            onChange={(e) => handleSearchInput(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            className="w-full bg-[var(--bg-elevated)] text-[var(--text-primary)] rounded-[var(--radius-lg)] py-3.5 pl-10 pr-10 text-base border-2 border-[var(--border-color)] focus:border-[var(--accent-primary)] focus:outline-none placeholder:text-[var(--text-muted)] transition-colors"
          />
          {(searchQuery || searchFocused) && (
            <button
              onClick={() => { setSearchQuery(''); setSearchResults([]); setSearchFocused(false); }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1"
            >
              <X size={16} />
            </button>
          )}
        </div>

        {/* Dropdown results */}
        {showDropdown && (
          <div className="absolute left-0 right-0 top-full mt-1 bg-[var(--bg-surface)] border border-[var(--border-color)] rounded-[var(--radius-lg)] shadow-2xl shadow-black/40 max-h-[60dvh] overflow-y-auto overscroll-contain z-50">
            {searching && (
              <div className="text-center py-4 text-[var(--text-secondary)] text-sm">搜索中...</div>
            )}
            {!searching && searchResults.length === 0 && searchQuery.trim() && (
              <div className="text-center py-4 text-[var(--text-secondary)] text-sm">未找到匹配股票</div>
            )}
            {searchResults.map((stock) => {
              const key = `${stock.market}:${stock.symbol}`;
              const isAdding = adding === key;
              const alreadyHeld = positions.some(p => p.symbol === stock.symbol && p.market === stock.market);
              return (
                <div
                  key={key}
                  onClick={() => !isAdding && !alreadyHeld && handleAddStock(stock)}
                  className={`flex items-center justify-between px-4 py-3 border-b border-[var(--border-color)] last:border-b-0 transition-colors ${alreadyHeld ? 'opacity-50 cursor-default' : 'cursor-pointer hover:bg-[var(--bg-elevated)] active:bg-[var(--bg-elevated)]'}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[var(--text-primary)] text-sm font-semibold truncate">{stock.name}</span>
                      <span className="text-[var(--text-muted)] text-xs bg-[var(--bg-page)] px-1.5 py-0.5 rounded">{stock.market}</span>
                    </div>
                    <div className="text-[var(--text-secondary)] text-xs mt-0.5">{stock.symbol}</div>
                  </div>
                  {alreadyHeld ? (
                    <span className="text-[var(--text-muted)] text-xs">已持有</span>
                  ) : isAdding ? (
                    <span className="text-[var(--accent-primary)] text-xs">添加中...</span>
                  ) : (
                    <button className="flex items-center gap-1 text-[var(--accent-primary)] text-xs font-semibold bg-[var(--accent-primary)]/10 px-2.5 py-1.5 rounded-[var(--radius-md)] hover:bg-[var(--accent-primary)]/20 transition-colors">
                      <Plus size={14} />
                      添加
                    </button>
                  )}
                </div>
              );
            })}

            {/* Hot stocks when no query */}
            {!searchQuery.trim() && (
              <div>
                <div className="text-[var(--text-muted)] text-xs font-medium px-4 pt-3 pb-1">快速添加热门股票</div>
                <div className="grid grid-cols-2 gap-0">
                  {HOT_STOCKS.map((stock) => {
                    const key = `${stock.market}:${stock.symbol}`;
                    const isAdding2 = adding === key;
                    const alreadyHeld = positions.some(p => p.symbol === stock.symbol && p.market === stock.market);
                    return (
                      <div
                        key={key}
                        onClick={() => !isAdding2 && !alreadyHeld && handleAddStock(stock)}
                        className={`flex items-center justify-between px-4 py-3 border-b border-r border-[var(--border-color)] transition-colors ${alreadyHeld ? 'opacity-40 cursor-default' : 'cursor-pointer hover:bg-[var(--bg-elevated)] active:bg-[var(--bg-elevated)]'}`}
                      >
                        <div className="min-w-0">
                          <div className="text-[var(--text-primary)] text-sm font-medium truncate">{stock.name}</div>
                          <div className="text-[var(--text-muted)] text-[10px]">{stock.symbol}</div>
                        </div>
                        {alreadyHeld ? (
                          <span className="text-[var(--text-muted)] text-[10px]">已有</span>
                        ) : isAdding2 ? (
                          <span className="text-[var(--accent-primary)] text-[10px]">...</span>
                        ) : (
                          <Plus size={14} className="text-[var(--accent-primary)] flex-shrink-0" />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Message */}
      {message && (
        <div className={`rounded-[var(--radius-md)] p-3 text-center text-sm font-medium ${
          message.includes('失败') || message.includes('已存在') ? 'bg-red-500/15 text-red-400' : 'bg-emerald-500/15 text-emerald-400'
        }`}>
          {message}
        </div>
      )}

      {/* Portfolio Summary */}
      <div className="card-surface p-5">
        <div className="text-[var(--text-secondary)] text-sm font-medium mb-3">账户总览</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-[var(--bg-page)] rounded-[var(--radius-md)] p-3.5">
            <div className="text-[var(--text-secondary)] text-xs">持仓数</div>
            <div className="text-[var(--text-primary)] text-xl font-bold mt-1">{positions.length}</div>
          </div>
          <div className="bg-[var(--bg-page)] rounded-[var(--radius-md)] p-3.5">
            <div className="text-[var(--text-secondary)] text-xs">总成本</div>
            <div className="text-[var(--text-primary)] text-xl font-bold mt-1">{totalCost > 0 ? totalCost.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '-'}</div>
          </div>
          <div className="bg-[var(--bg-page)] rounded-[var(--radius-md)] p-3.5">
            <div className="text-[var(--text-secondary)] text-xs">总市值</div>
            <div className="text-[var(--text-primary)] text-xl font-bold mt-1">{totalMarketValue > 0 ? totalMarketValue.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '-'}</div>
          </div>
          <div className="bg-[var(--bg-page)] rounded-[var(--radius-md)] p-3.5">
            <div className="text-[var(--text-secondary)] text-xs">总盈亏</div>
            <div className={`text-xl font-bold mt-1 ${totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {totalCost > 0 ? `${fmtSigned(totalPnl, 0)} (${fmtSigned(totalPnlPct, 1)}%)` : '-'}
            </div>
          </div>
        </div>
      </div>

      {/* Alerts */}
      {alerts.length > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/25 rounded-[var(--radius-md)] p-4">
          <div className="text-amber-400 text-sm font-semibold mb-2">交易提醒 ({alerts.length})</div>
          {alerts.slice(0, 3).map((a) => (
            <div key={a.key} className="text-[var(--text-primary)] text-sm mt-1">
              {a.name || a.symbol}：{a.message}
            </div>
          ))}
        </div>
      )}

      {/* Position List */}
      {loading ? (
        <div className="card-surface p-8 text-center">
          <p className="text-[var(--text-secondary)]">加载中...</p>
        </div>
      ) : positions.length === 0 ? (
        <div className="card-surface p-8 text-center">
          <p className="text-[var(--text-secondary)] text-base mb-1">暂无持仓</p>
          <p className="text-[var(--text-muted)] text-sm">在上方搜索框中搜索并添加股票</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {positions.map((p) => (
            <div key={p.id} className="card-surface p-4 md:p-5">
              {/* Stock header */}
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[var(--text-primary)] text-lg font-bold tracking-tight truncate">{p.name || p.symbol}</span>
                    <span className="text-[var(--text-muted)] text-xs bg-[var(--bg-elevated)] px-2 py-0.5 rounded">{p.market}</span>
                  </div>
                  <div className="text-[var(--text-secondary)] text-sm mt-0.5">{p.symbol}</div>
                </div>
                <div className="text-right">
                  <div className="text-[var(--text-primary)] text-xl font-bold">{fmt(p.current_price)}</div>
                  <div className={`text-sm font-semibold ${(p.unrealized_pnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {fmtSigned(p.unrealized_pnl_pct)}%
                  </div>
                </div>
              </div>

              {/* Key metrics grid */}
              <div className="mt-3 grid grid-cols-4 gap-2">
                <div className="bg-[var(--bg-page)] rounded-[var(--radius-sm)] p-2.5 text-center">
                  <div className="text-[var(--text-muted)] text-[10px]">持仓</div>
                  <div className="text-[var(--text-primary)] text-sm font-bold mt-0.5">{p.quantity || 0}</div>
                </div>
                <div className="bg-[var(--bg-page)] rounded-[var(--radius-sm)] p-2.5 text-center">
                  <div className="text-[var(--text-muted)] text-[10px]">成本价</div>
                  <div className="text-[var(--text-primary)] text-sm font-bold mt-0.5">{fmt(p.avg_cost)}</div>
                </div>
                <div className="bg-[var(--bg-page)] rounded-[var(--radius-sm)] p-2.5 text-center">
                  <div className="text-[var(--text-muted)] text-[10px]">市值</div>
                  <div className="text-[var(--text-primary)] text-sm font-bold mt-0.5">{p.market_value != null ? p.market_value.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '-'}</div>
                </div>
                <div className="bg-[var(--bg-page)] rounded-[var(--radius-sm)] p-2.5 text-center">
                  <div className="text-[var(--text-muted)] text-[10px]">盈亏</div>
                  <div className={`text-sm font-bold mt-0.5 ${(p.unrealized_pnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {fmtSigned(p.unrealized_pnl, 0)}
                  </div>
                </div>
              </div>

              {/* Action buttons */}
              <div className="mt-3 grid grid-cols-5 gap-1.5">
                <button
                  onClick={() => { setTradeTarget(p); setTradeSide('BUY'); setTradeQty(''); }}
                  className="bg-emerald-500/15 text-emerald-400 rounded-[var(--radius-md)] py-2 font-bold text-xs active:scale-[0.98] transition-transform flex items-center justify-center gap-0.5"
                >
                  <TrendingUp size={13} />
                  买入
                </button>
                <button
                  onClick={() => { setTradeTarget(p); setTradeSide('SELL'); setTradeQty(''); }}
                  className="bg-red-500/15 text-red-400 rounded-[var(--radius-md)] py-2 font-bold text-xs active:scale-[0.98] transition-transform flex items-center justify-center gap-0.5"
                >
                  <TrendingDown size={13} />
                  卖出
                </button>
                <button
                  onClick={() => { setAutoTradeTarget(p); setAutoTradeSide('BUY'); setAutoTradePrice(''); setAutoTradeQty(''); }}
                  className="bg-blue-500/15 text-blue-400 rounded-[var(--radius-md)] py-2 font-bold text-xs active:scale-[0.98] transition-transform flex items-center justify-center gap-0.5 relative"
                >
                  <Timer size={13} />
                  委托
                  {pendingAutoTrades.filter(at => at.position_id === p.id).length > 0 && (
                    <span className="absolute -top-1 -right-1 bg-blue-500 text-white text-[9px] w-4 h-4 rounded-full flex items-center justify-center font-bold">
                      {pendingAutoTrades.filter(at => at.position_id === p.id).length}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => fetchAdvice(p)}
                  className="bg-[#FFB547]/15 text-[#FFB547] rounded-[var(--radius-md)] py-2 font-bold text-xs active:scale-[0.98] transition-transform flex items-center justify-center gap-0.5"
                >
                  <Brain size={13} />
                  AI
                </button>
                <button
                  onClick={() => handleDelete(p.id, p.name || p.symbol)}
                  className="bg-[var(--bg-elevated)] text-[var(--text-secondary)] rounded-[var(--radius-md)] py-2 font-medium text-xs active:scale-[0.98] transition-transform flex items-center justify-center gap-0.5"
                >
                  <Trash2 size={13} />
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pending Auto-Trades */}
      {pendingAutoTrades.length > 0 && (
        <div className="card-surface p-4">
          <div className="flex items-center gap-2 mb-3">
            <Timer size={16} className="text-blue-400" />
            <span className="text-blue-400 text-sm font-semibold">委托订单 ({pendingAutoTrades.length})</span>
          </div>
          <div className="flex flex-col gap-2">
            {pendingAutoTrades.map((at) => (
              <div key={at.id} className="flex items-center justify-between bg-[var(--bg-page)] rounded-[var(--radius-md)] px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${at.side === 'BUY' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}`}>
                      {at.side === 'BUY' ? '买' : '卖'}
                    </span>
                    <span className="text-[var(--text-primary)] text-sm font-semibold truncate">{at.name || at.symbol}</span>
                  </div>
                  <div className="text-[var(--text-muted)] text-xs mt-1">
                    触发价 {at.trigger_price.toFixed(2)} · {at.quantity}股
                    {at.side === 'BUY' ? ' · 价格≤触发价时买入' : ' · 价格≥触发价时卖出'}
                  </div>
                </div>
                <button
                  onClick={() => handleCancelAutoTrade(at.id)}
                  className="text-[var(--text-muted)] hover:text-red-400 p-1.5 rounded-lg hover:bg-red-500/10 transition-colors flex-shrink-0"
                  title="取消委托"
                >
                  <XCircle size={18} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Bottom spacer — ensures last card clears the fixed mobile nav */}
      <div className="h-40 md:hidden flex-shrink-0" aria-hidden="true" />

      {/* Auto-Trade Modal */}
      {autoTradeTarget && (
        <div className="fixed inset-0 z-[120] bg-black/70 flex items-end md:items-center justify-center animate-fade-in">
          <div className="w-full md:max-w-sm bg-[var(--bg-page)] rounded-t-[var(--radius-xl)] md:rounded-[var(--radius-xl)] border border-[var(--border-color)] p-5 animate-slide-up">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-blue-400 text-lg font-bold">
                  委托交易 {autoTradeTarget.name || autoTradeTarget.symbol}
                </h3>
                <div className="text-[var(--text-secondary)] text-sm mt-0.5">
                  现价 {fmt(autoTradeTarget.current_price)} · 持仓 {autoTradeTarget.quantity}
                </div>
              </div>
              <button
                onClick={() => setAutoTradeTarget(null)}
                className="btn-secondary h-9 px-3 text-sm !min-h-0 !py-0"
              >
                取消
              </button>
            </div>

            <div className="flex gap-2 mb-4">
              <button
                onClick={() => setAutoTradeSide('BUY')}
                className={`flex-1 py-2.5 rounded-[var(--radius-md)] font-bold text-sm transition-colors ${autoTradeSide === 'BUY' ? 'bg-emerald-500 text-white' : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)]'}`}
              >
                低于目标价买入
              </button>
              <button
                onClick={() => setAutoTradeSide('SELL')}
                className={`flex-1 py-2.5 rounded-[var(--radius-md)] font-bold text-sm transition-colors ${autoTradeSide === 'SELL' ? 'bg-red-500 text-white' : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)]'}`}
              >
                高于目标价卖出
              </button>
            </div>

            <div className="mb-3">
              <label className="text-[var(--text-secondary)] text-sm font-medium">
                触发价格 <span className="text-[var(--text-muted)] text-xs">({autoTradeSide === 'BUY' ? '当价格≤此值时自动买入' : '当价格≥此值时自动卖出'})</span>
              </label>
              <input
                type="number"
                value={autoTradePrice}
                onChange={(e) => setAutoTradePrice(e.target.value)}
                placeholder={`输入触发价格`}
                autoFocus
                step="0.01"
                className="input-base mt-2 text-lg"
              />
            </div>

            <div className="mb-4">
              <label className="text-[var(--text-secondary)] text-sm font-medium">数量</label>
              <input
                type="number"
                value={autoTradeQty}
                onChange={(e) => setAutoTradeQty(e.target.value)}
                placeholder="输入数量"
                className="input-base mt-2 text-lg"
              />
              {autoTradePrice && autoTradeQty && Number(autoTradePrice) > 0 && Number(autoTradeQty) > 0 && (
                <div className="text-[var(--text-secondary)] text-sm mt-2">
                  预估金额：{(Number(autoTradePrice) * Number(autoTradeQty)).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </div>
              )}
            </div>

            <button
              onClick={handleCreateAutoTrade}
              className="w-full bg-blue-500 text-white rounded-[var(--radius-lg)] py-4 font-bold text-base active:scale-[0.98] transition-transform"
            >
              创建委托订单
            </button>
          </div>
        </div>
      )}

      {/* Trade Modal */}
      {tradeTarget && (
        <div className="fixed inset-0 z-[120] bg-black/70 flex items-end md:items-center justify-center animate-fade-in">
          <div className="w-full md:max-w-sm bg-[var(--bg-page)] rounded-t-[var(--radius-xl)] md:rounded-[var(--radius-xl)] border border-[var(--border-color)] p-5 animate-slide-up">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className={`text-lg font-bold ${tradeSide === 'BUY' ? 'text-emerald-400' : 'text-red-400'}`}>
                  {tradeSide === 'BUY' ? '买入' : '卖出'} {tradeTarget.name || tradeTarget.symbol}
                </h3>
                <div className="text-[var(--text-secondary)] text-sm mt-0.5">
                  现价 {fmt(tradeTarget.current_price)} · 持仓 {tradeTarget.quantity}
                </div>
              </div>
              <button
                onClick={() => setTradeTarget(null)}
                className="btn-secondary h-9 px-3 text-sm !min-h-0 !py-0"
              >
                取消
              </button>
            </div>

            <div className="mb-4">
              <label className="text-[var(--text-secondary)] text-sm font-medium">数量</label>
              <input
                type="number"
                value={tradeQty}
                onChange={(e) => setTradeQty(e.target.value)}
                placeholder="输入数量"
                autoFocus
                className="input-base mt-2 text-lg"
              />
              {tradeTarget.current_price != null && tradeQty && Number(tradeQty) > 0 && (
                <div className="text-[var(--text-secondary)] text-sm mt-2">
                  预估金额：{(tradeTarget.current_price * Number(tradeQty)).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </div>
              )}
            </div>

            <button
              onClick={handleTrade}
              className={`w-full rounded-[var(--radius-lg)] py-4 font-bold text-base active:scale-[0.98] transition-transform ${
                tradeSide === 'BUY'
                  ? 'bg-emerald-500 text-[var(--bg-page)]'
                  : 'bg-red-500 text-white'
              }`}
            >
              确认{tradeSide === 'BUY' ? '买入' : '卖出'}
            </button>
          </div>
        </div>
      )}

      {/* AI Advice Modal */}
      {adviceTarget && (
        <div className="fixed inset-0 z-[120] bg-black/70 flex items-end md:items-center justify-center animate-fade-in" onClick={() => !adviceLoading && setAdviceTarget(null)}>
          <div
            className="w-full md:max-w-lg bg-[var(--bg-page)] rounded-t-[var(--radius-xl)] md:rounded-[var(--radius-xl)] border border-[var(--border-color)] animate-slide-up max-h-[85dvh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between p-5 pb-3 border-b border-[var(--border-color)] flex-shrink-0">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-9 h-9 rounded-full bg-[#FFB547]/15 flex items-center justify-center flex-shrink-0">
                  <Brain size={18} className="text-[#FFB547]" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-[var(--text-primary)] text-base font-bold truncate">AI 专家建议</h3>
                  <div className="text-[var(--text-secondary)] text-xs mt-0.5 truncate">
                    {adviceTarget.name || adviceTarget.symbol} · {adviceTarget.symbol}
                    {adviceDataTime && <span className="text-[var(--text-muted)]"> · 数据 {adviceDataTime}</span>}
                  </div>
                </div>
              </div>
              <button
                onClick={() => setAdviceTarget(null)}
                className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] transition-colors flex-shrink-0"
              >
                <X size={18} />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto overscroll-contain p-5">
              {adviceLoading ? (
                <div className="flex flex-col items-center justify-center py-12 gap-3">
                  <div className="w-10 h-10 rounded-full border-2 border-[#FFB547]/30 border-t-[#FFB547] animate-spin" />
                  <div className="text-[var(--text-secondary)] text-sm">AI 正在分析持仓数据...</div>
                  <div className="text-[var(--text-muted)] text-xs">结合技术指标生成专业建议，约需10-20秒</div>
                </div>
              ) : (
                <div className="text-[var(--text-primary)] text-sm leading-relaxed whitespace-pre-wrap break-words">
                  {adviceText.split('\n').map((line, i) => {
                    const trimmed = line.trim();
                    // Bold headers: lines starting with ** or numbered headers
                    if (/^\*\*.*\*\*$/.test(trimmed)) {
                      return <div key={i} className="text-[#FFB547] font-bold text-[15px] mt-4 mb-1.5">{trimmed.replace(/\*\*/g, '')}</div>;
                    }
                    if (/^\d+\.\s*\*\*/.test(trimmed)) {
                      const clean = trimmed.replace(/\*\*/g, '');
                      return <div key={i} className="text-[#FFB547] font-bold text-[15px] mt-4 mb-1.5">{clean}</div>;
                    }
                    // Sub-headers with **text**
                    if (trimmed.includes('**')) {
                      const parts = trimmed.split(/\*\*/);
                      return (
                        <div key={i} className="mt-1">
                          {parts.map((part, j) => j % 2 === 1 ? <strong key={j} className="text-[var(--text-primary)] font-semibold">{part}</strong> : <span key={j}>{part}</span>)}
                        </div>
                      );
                    }
                    // Bullet points
                    if (/^[-•]/.test(trimmed)) {
                      return <div key={i} className="pl-3 mt-0.5 text-[var(--text-secondary)]">• {trimmed.replace(/^[-•]\s*/, '')}</div>;
                    }
                    // Disclaimer
                    if (trimmed.includes('免责') || trimmed.includes('风险自担') || trimmed.includes('不构成')) {
                      return <div key={i} className="text-[var(--text-muted)] text-xs mt-3 pt-3 border-t border-[var(--border-color)]">{trimmed}</div>;
                    }
                    // Empty lines
                    if (!trimmed) return <div key={i} className="h-2" />;
                    // Normal text
                    return <div key={i} className="mt-0.5">{line}</div>;
                  })}
                </div>
              )}
            </div>

            {/* Footer */}
            {!adviceLoading && (
              <div className="p-4 pt-3 border-t border-[var(--border-color)] flex gap-2 flex-shrink-0">
                <button
                  onClick={() => fetchAdvice(adviceTarget)}
                  className="flex-1 bg-[#FFB547]/15 text-[#FFB547] rounded-[var(--radius-lg)] py-3 font-bold text-sm active:scale-[0.98] transition-transform flex items-center justify-center gap-1.5"
                >
                  <Brain size={15} />
                  重新生成
                </button>
                <button
                  onClick={() => setAdviceTarget(null)}
                  className="flex-1 bg-[var(--bg-elevated)] text-[var(--text-secondary)] rounded-[var(--radius-lg)] py-3 font-medium text-sm active:scale-[0.98] transition-transform"
                >
                  关闭
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
