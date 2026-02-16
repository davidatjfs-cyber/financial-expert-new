'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Search, X, Loader2, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import {
  searchStocks,
  getStockIndicators,
  type StockSearchResult,
  type StockIndicators,
} from '@/services/api';

type PickedStock = { symbol: string; market: string; name: string };
type ScreenResult = PickedStock & {
  loading: boolean;
  indicators?: StockIndicators | null;
  error?: boolean;
};

export default function Dashboard() {
  const router = useRouter();

  // Auto stock picker state
  const [pickedStocks, setPickedStocks] = useState<PickedStock[]>([]);
  const [screenResults, setScreenResults] = useState<ScreenResult[]>([]);
  const [screening, setScreening] = useState(false);
  const [screened, setScreened] = useState(false);

  // Search overlay for adding stocks
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<StockSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef<any>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Recent stocks
  const [recentStocks, setRecentStocks] = useState<PickedStock[]>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem('recent_stocks');
      const parsed = raw ? (JSON.parse(raw) as PickedStock[]) : [];
      if (Array.isArray(parsed)) setRecentStocks(parsed);
    } catch {
      setRecentStocks([]);
    }
  }, []);

  // Focus search input when overlay opens
  useEffect(() => {
    if (showSearch) {
      setTimeout(() => searchInputRef.current?.focus(), 100);
    }
  }, [showSearch]);

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
        const results = await searchStocks(val.trim(), 'ALL');
        setSearchResults(results);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 350);
  };

  const addStock = (stock: StockSearchResult | PickedStock) => {
    if (pickedStocks.length >= 10) return;
    const exists = pickedStocks.some(s => s.symbol === stock.symbol && s.market === stock.market);
    if (exists) return;
    setPickedStocks(prev => [...prev, { symbol: stock.symbol, market: stock.market, name: stock.name }]);
    setShowSearch(false);
    setSearchQuery('');
    setSearchResults([]);
    setScreened(false);
  };

  const removeStock = (idx: number) => {
    setPickedStocks(prev => prev.filter((_, i) => i !== idx));
    setScreened(false);
  };

  const isAlreadyPicked = (stock: StockSearchResult) =>
    pickedStocks.some(s => s.symbol === stock.symbol && s.market === stock.market);

  // Screen all picked stocks
  const handleScreen = async () => {
    if (pickedStocks.length === 0) return;
    setScreening(true);
    setScreened(false);
    const initial: ScreenResult[] = pickedStocks.map(s => ({ ...s, loading: true }));
    setScreenResults(initial);

    const promises = pickedStocks.map(async (stock, idx) => {
      try {
        const ind = await getStockIndicators(stock.symbol, stock.market);
        setScreenResults(prev => {
          const next = [...prev];
          next[idx] = { ...next[idx], loading: false, indicators: ind };
          return next;
        });
      } catch {
        setScreenResults(prev => {
          const next = [...prev];
          next[idx] = { ...next[idx], loading: false, error: true };
          return next;
        });
      }
    });

    await Promise.allSettled(promises);
    setScreening(false);
    setScreened(true);
  };

  // Determine if a stock is buyable based on indicators
  const isBuyable = (ind?: StockIndicators | null) => {
    if (!ind) return false;
    return ind.buy_price_aggressive_ok === true;
  };

  const trendIcon = (trend?: string | null) => {
    if (trend === '上涨') return <TrendingUp size={14} className="text-emerald-400" />;
    if (trend === '下跌') return <TrendingDown size={14} className="text-red-400" />;
    return <Minus size={14} className="text-[var(--text-muted)]" />;
  };

  const marketTag = (m: string) => {
    const colors: Record<string, string> = {
      CN: 'bg-red-500/15 text-red-400',
      US: 'bg-blue-500/15 text-blue-400',
      HK: 'bg-amber-500/15 text-amber-400',
    };
    return <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${colors[m] || 'bg-zinc-500/15 text-zinc-400'}`}>{m}</span>;
  };

  // Buyable stocks sorted first
  const sortedResults = [...screenResults].sort((a, b) => {
    const aBuy = isBuyable(a.indicators) ? 0 : 1;
    const bBuy = isBuyable(b.indicators) ? 0 : 1;
    return aBuy - bBuy;
  });

  const buyableCount = screenResults.filter(r => isBuyable(r.indicators)).length;

  return (
    <div className="px-4 py-5 md:px-10 md:py-8 flex flex-col gap-5 max-w-3xl mx-auto pb-24 md:pb-10 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[var(--text-primary)] text-xl md:text-2xl font-bold tracking-tight">财务分析专家</h1>
          <p className="text-[var(--text-secondary)] text-sm mt-1">智能财务决策助手</p>
        </div>
        <div className="flex items-center gap-2.5">
          <div className="w-10 h-10 rounded-full bg-[var(--bg-surface)] border border-[var(--border-color)] flex items-center justify-center">
            <span className="text-base">🔔</span>
          </div>
          <div className="w-10 h-10 rounded-full bg-[var(--bg-surface)] border border-[var(--border-color)] flex items-center justify-center">
            <span className="text-base">👤</span>
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-3 gap-2.5">
        <Link href="/indicators" className="card-surface p-4 active:scale-[0.99] transition-transform text-center">
          <div className="text-lg mb-1">📊</div>
          <h3 className="text-[var(--text-primary)] text-sm font-bold">持仓</h3>
        </Link>
        <Link href="/stock" className="card-surface p-4 active:scale-[0.99] transition-transform text-center">
          <div className="text-lg mb-1">🔍</div>
          <h3 className="text-[var(--text-primary)] text-sm font-bold">查询</h3>
        </Link>
        <Link href="/compare" className="card-surface p-4 active:scale-[0.99] transition-transform text-center">
          <div className="text-lg mb-1">⚖️</div>
          <h3 className="text-[var(--text-primary)] text-sm font-bold">对比</h3>
        </Link>
      </div>

      {/* ===== Auto Stock Picker ===== */}
      <div className="card-surface p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-[var(--text-primary)] text-lg font-bold tracking-tight flex items-center gap-2">
              🤖 智能选股
            </h3>
            <p className="text-[var(--text-muted)] text-xs mt-1">添加股票后一键筛选，系统根据趋势/斜率/RSI自动判断买入信号</p>
          </div>
          <span className="text-[var(--text-muted)] text-xs">{pickedStocks.length}/10</span>
        </div>

        {/* Picked stocks chips */}
        <div className="flex flex-wrap gap-2 mb-3">
          {pickedStocks.map((s, idx) => (
            <div key={`${s.market}:${s.symbol}`} className="flex items-center gap-1.5 bg-[var(--bg-elevated)] rounded-full pl-3 pr-1.5 py-1.5 border border-[var(--border-color)]">
              {marketTag(s.market)}
              <span className="text-[var(--text-primary)] text-xs font-semibold max-w-[80px] truncate">{s.name}</span>
              <button onClick={() => removeStock(idx)} className="w-5 h-5 rounded-full bg-[var(--bg-surface)] flex items-center justify-center flex-shrink-0">
                <X size={10} className="text-[var(--text-muted)]" />
              </button>
            </div>
          ))}
          {pickedStocks.length < 10 && (
            <button
              onClick={() => setShowSearch(true)}
              className="flex items-center gap-1 bg-[var(--accent-primary)]/10 text-[var(--accent-primary)] rounded-full px-3 py-1.5 text-xs font-semibold border border-[var(--accent-primary)]/20 active:scale-[0.97] transition-transform"
            >
              <Search size={12} /> 添加股票
            </button>
          )}
        </div>

        {/* Screen button */}
        <button
          onClick={handleScreen}
          disabled={pickedStocks.length === 0 || screening}
          className="w-full bg-gradient-to-r from-[var(--accent-primary)] to-[var(--accent-secondary)] text-white rounded-xl py-3.5 font-bold text-sm disabled:opacity-40 active:scale-[0.99] transition-transform flex items-center justify-center gap-2"
        >
          {screening ? (
            <><Loader2 size={16} className="animate-spin" /> 分析中...</>
          ) : (
            <><TrendingUp size={16} /> 一键筛选可买股票</>
          )}
        </button>

        {/* Screen results */}
        {screened && screenResults.length > 0 && (
          <div className="mt-4">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[var(--text-primary)] text-sm font-bold">
                筛选结果
              </div>
              <div className="text-xs">
                {buyableCount > 0 ? (
                  <span className="text-emerald-400 font-bold">{buyableCount} 只可买入</span>
                ) : (
                  <span className="text-[var(--text-muted)]">暂无满足买入条件的股票</span>
                )}
              </div>
            </div>
            <div className="flex flex-col gap-2">
              {sortedResults.map((r) => {
                const buy = isBuyable(r.indicators);
                const ind = r.indicators;
                return (
                  <div
                    key={`${r.market}:${r.symbol}`}
                    onClick={() => router.push(`/stock?symbol=${encodeURIComponent(r.symbol)}&market=${encodeURIComponent(r.market)}&name=${encodeURIComponent(r.name)}`)}
                    className={`rounded-xl p-3 border-2 cursor-pointer active:scale-[0.99] transition-all ${
                      buy ? 'bg-emerald-500/8 border-emerald-500/30' : 'bg-[var(--bg-elevated)] border-[var(--border-color)]'
                    }`}
                  >
                    {r.loading ? (
                      <div className="flex items-center gap-2 text-[var(--text-muted)] text-sm">
                        <Loader2 size={14} className="animate-spin" /> 分析中...
                      </div>
                    ) : r.error ? (
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          {marketTag(r.market)}
                          <span className="text-[var(--text-primary)] text-sm font-semibold">{r.name}</span>
                        </div>
                        <span className="text-red-400 text-xs">获取失败</span>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="flex items-center gap-2 min-w-0">
                            {marketTag(r.market)}
                            <span className="text-[var(--text-primary)] text-sm font-bold truncate">{r.name}</span>
                            <span className="text-[var(--text-muted)] text-[10px]">{r.symbol}</span>
                          </div>
                          <div className={`text-xs font-extrabold px-2.5 py-1 rounded-full ${
                            buy ? 'bg-emerald-500 text-white' : 'bg-[var(--bg-surface)] text-[var(--text-muted)]'
                          }`}>
                            {buy ? '✓ 可买入' : '等待'}
                          </div>
                        </div>
                        <div className="flex items-center gap-3 text-[10px] flex-wrap">
                          <span className="flex items-center gap-1">
                            {trendIcon(ind?.trend)}
                            <span className="text-[var(--text-secondary)]">{ind?.trend || '-'}</span>
                          </span>
                          <span className="text-[var(--text-muted)]">
                            Slope {ind?.slope_pct != null ? `${ind.slope_pct.toFixed(3)}%` : '-'}
                          </span>
                          <span className={`font-semibold ${ind?.slope_advice === '放心买' ? 'text-emerald-400' : ind?.slope_advice === '不要买' || ind?.slope_advice === '有危险' ? 'text-red-400' : 'text-amber-400'}`}>
                            {ind?.slope_advice || '-'}
                          </span>
                          <span className="text-[var(--text-muted)]">
                            RSI {ind?.rsi14 != null ? ind.rsi14.toFixed(1) : '-'}
                          </span>
                          {ind?.rsi_rebound && <span className="text-emerald-400 font-semibold">RSI拐头✓</span>}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Recent Stock Searches */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="section-title">最近查询</h3>
          <Link href="/stock" className="text-[var(--accent-primary)] text-sm font-semibold">查看全部 →</Link>
        </div>
        <div className="flex flex-col gap-2">
          {recentStocks.length > 0 ? (
            recentStocks.slice(0, 5).map((s) => (
              <div
                key={`${s.market}:${s.symbol}`}
                onClick={() => router.push(`/stock?symbol=${encodeURIComponent(s.symbol)}&market=${encodeURIComponent(s.market)}&name=${encodeURIComponent(s.name)}`)}
                className="card-surface p-3.5 flex items-center justify-between cursor-pointer active:scale-[0.99] transition-all duration-150"
              >
                <div className="flex items-center gap-2 min-w-0">
                  {marketTag(s.market)}
                  <span className="text-[var(--text-primary)] text-sm font-semibold truncate">{s.name}</span>
                  <span className="text-[var(--text-muted)] text-xs">{s.symbol}</span>
                </div>
                <span className="text-[var(--text-muted)] text-xs">→</span>
              </div>
            ))
          ) : (
            <div className="card-surface p-5 text-center">
              <p className="text-[var(--text-secondary)] text-sm">暂无记录</p>
            </div>
          )}
        </div>
      </div>

      {/* ===== Search Overlay ===== */}
      {showSearch && (
        <div className="fixed inset-0 z-[100] bg-black/80 animate-fade-in" onClick={() => setShowSearch(false)}>
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute inset-x-0 top-0 bg-[var(--bg-page)] rounded-b-2xl max-h-[85dvh] flex flex-col animate-slide-down safe-area-top"
          >
            {/* Search header */}
            <div className="px-4 pt-4 pb-3 flex items-center gap-3">
              <div className="flex-1 relative">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
                <input
                  ref={searchInputRef}
                  type="text"
                  placeholder="搜索股票名称或代码（支持美/中/港）"
                  value={searchQuery}
                  onChange={(e) => handleSearchInput(e.target.value)}
                  className="w-full bg-[var(--bg-elevated)] text-[var(--text-primary)] rounded-xl py-3 pl-10 pr-4 text-sm border border-[var(--border-color)] focus:border-[var(--accent-primary)] focus:outline-none placeholder:text-[var(--text-muted)]"
                />
              </div>
              <button onClick={() => { setShowSearch(false); setSearchQuery(''); setSearchResults([]); }} className="text-[var(--accent-primary)] text-sm font-semibold px-2">
                取消
              </button>
            </div>

            {/* Search results */}
            <div className="flex-1 overflow-y-auto px-4 pb-6">
              {searching && (
                <div className="flex items-center justify-center py-6 text-[var(--text-muted)] text-sm gap-2">
                  <Loader2 size={16} className="animate-spin" /> 搜索中...
                </div>
              )}

              {!searching && searchQuery.trim() && searchResults.length === 0 && (
                <div className="text-center py-6 text-[var(--text-muted)] text-sm">未找到匹配的股票</div>
              )}

              {searchResults.length > 0 && (
                <div className="flex flex-col gap-1">
                  {searchResults.map((s) => {
                    const picked = isAlreadyPicked(s);
                    return (
                      <button
                        key={`${s.market}:${s.symbol}`}
                        onClick={() => !picked && addStock(s)}
                        disabled={picked || pickedStocks.length >= 10}
                        className={`w-full text-left flex items-center justify-between p-3 rounded-xl transition-colors ${
                          picked ? 'opacity-40' : 'active:bg-[var(--bg-elevated)]'
                        }`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          {marketTag(s.market)}
                          <span className="text-[var(--text-primary)] text-sm font-semibold truncate">{s.name}</span>
                          <span className="text-[var(--text-muted)] text-xs">{s.symbol}</span>
                        </div>
                        <span className={`text-xs font-semibold ${picked ? 'text-[var(--text-muted)]' : 'text-[var(--accent-primary)]'}`}>
                          {picked ? '已添加' : '+ 添加'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Quick add from recent or hot stocks when no query */}
              {!searchQuery.trim() && (
                <>
                  <div className="text-[var(--text-muted)] text-xs font-medium mb-2 mt-1">热门股票</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {[
                      { name: '贵州茅台', symbol: '600519.SH', market: 'CN' },
                      { name: '腾讯控股', symbol: '00700.HK', market: 'HK' },
                      { name: '苹果公司', symbol: 'AAPL', market: 'US' },
                      { name: '英伟达', symbol: 'NVDA', market: 'US' },
                      { name: '比亚迪', symbol: '002594.SZ', market: 'CN' },
                      { name: '美团', symbol: '03690.HK', market: 'HK' },
                      { name: '宁德时代', symbol: '300750.SZ', market: 'CN' },
                      { name: '麦当劳', symbol: 'MCD', market: 'US' },
                    ].map((s) => {
                      const picked = isAlreadyPicked(s as StockSearchResult);
                      return (
                        <button
                          key={s.symbol}
                          onClick={() => !picked && addStock(s as StockSearchResult)}
                          disabled={picked || pickedStocks.length >= 10}
                          className={`flex items-center gap-1.5 p-2.5 rounded-lg border border-[var(--border-color)] text-left ${
                            picked ? 'opacity-40' : 'active:bg-[var(--bg-elevated)]'
                          }`}
                        >
                          {marketTag(s.market)}
                          <span className="text-[var(--text-primary)] text-xs font-semibold truncate">{s.name}</span>
                        </button>
                      );
                    })}
                  </div>

                  {recentStocks.length > 0 && (
                    <>
                      <div className="text-[var(--text-muted)] text-xs font-medium mb-2 mt-4">最近查询</div>
                      <div className="flex flex-col gap-1">
                        {recentStocks.slice(0, 6).map((s) => {
                          const picked = isAlreadyPicked(s as StockSearchResult);
                          return (
                            <button
                              key={`${s.market}:${s.symbol}`}
                              onClick={() => !picked && addStock(s as StockSearchResult)}
                              disabled={picked || pickedStocks.length >= 10}
                              className={`w-full text-left flex items-center justify-between p-2.5 rounded-lg ${
                                picked ? 'opacity-40' : 'active:bg-[var(--bg-elevated)]'
                              }`}
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                {marketTag(s.market)}
                                <span className="text-[var(--text-primary)] text-xs font-semibold truncate">{s.name}</span>
                                <span className="text-[var(--text-muted)] text-[10px]">{s.symbol}</span>
                              </div>
                              <span className={`text-[10px] font-semibold ${picked ? 'text-[var(--text-muted)]' : 'text-[var(--accent-primary)]'}`}>
                                {picked ? '已添加' : '+ 添加'}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
