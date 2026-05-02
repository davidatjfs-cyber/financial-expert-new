'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Search, X, Loader2, TrendingUp, TrendingDown, Minus, Sparkles, RefreshCw } from 'lucide-react';
import {
  searchStocks,
  getStockIndicators,
  startRecommendScan,
  getRecommendScanStatus,
  getRecommendLatest,
  getRecommendSectors,
  type StockSearchResult,
  type StockIndicators,
  type RecommendStock,
  type SectorInfo,
} from '@/services/api';

type PickedStock = { symbol: string; market: string; name: string };
type ScreenResult = PickedStock & {
  loading: boolean;
  indicators?: StockIndicators | null;
  error?: boolean;
};
type Tab = 'manual' | 'ai';

export default function Dashboard() {
  const router = useRouter();

  const [activeTab, setActiveTab] = useState<Tab>('ai');

  // Manual stock picker state
  const [pickedStocks, setPickedStocks] = useState<PickedStock[]>([]);
  const [screenResults, setScreenResults] = useState<ScreenResult[]>([]);
  const [screening, setScreening] = useState(false);
  const [screened, setScreened] = useState(false);

  // AI recommend state
  const [aiResults, setAiResults] = useState<RecommendStock[]>([]);
  const [aiScanning, setAiScanning] = useState(false);
  const [aiStatus, setAiStatus] = useState('');
  const [aiProgress, setAiProgress] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [sectors, setSectors] = useState<SectorInfo[]>([]);
  const [selectedSector, setSelectedSector] = useState<string>('');
  const [sectorsLoaded, setSectorsLoaded] = useState(false);

  // Search overlay
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<StockSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  useEffect(() => {
    if (showSearch) {
      setTimeout(() => searchInputRef.current?.focus(), 100);
    }
  }, [showSearch]);

  // Load latest AI results on mount
  useEffect(() => {
    getRecommendLatest()
      .then((res) => {
        if (res.results && res.results.length > 0) {
          setAiResults(res.results);
        }
      })
      .catch(() => {});
    getRecommendSectors()
      .then((res) => {
        if (res.sectors && res.sectors.length > 0) {
          setSectors(res.sectors);
          setSectorsLoaded(true);
        }
      })
      .catch(() => {});
  }, []);

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

  const isBuyable = (ind?: StockIndicators | null) => {
    if (!ind) return false;
    return ind.buy_price_aggressive_ok === true;
  };

  const trendIcon = (trend?: string | null) => {
    if (trend === '上涨') return <TrendingUp size={14} className="text-emerald-400" />;
    if (trend === '下跌' || trend === '震荡偏弱') return <TrendingDown size={14} className="text-red-400" />;
    if (trend === '震荡偏强') return <TrendingUp size={14} className="text-yellow-400" />;
    if (trend === '震荡') return <Minus size={14} className="text-yellow-400" />;
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

  const sortedResults = [...screenResults].sort((a, b) => {
    const aBuy = isBuyable(a.indicators) ? 0 : 1;
    const bBuy = isBuyable(b.indicators) ? 0 : 1;
    return aBuy - bBuy;
  });

  const buyableCount = screenResults.filter(r => isBuyable(r.indicators)).length;

  // AI recommend scan
  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startAiScan = async () => {
    try {
      const sector = selectedSector || undefined;
      await startRecommendScan(20, true, sector);
      setAiScanning(true);
      setAiProgress(0);
      const sectorName = selectedSector ? sectors.find(s => s.label === selectedSector)?.name : '沪深300';
      setAiStatus(`正在扫描${sectorName}...`);
      stopPolling();
      pollRef.current = setInterval(async () => {
        try {
          const st = await getRecommendScanStatus();
          setAiProgress(st.progress);
          setAiStatus(st.message);
          if (st.status === 'done') {
            stopPolling();
            setAiScanning(false);
            const res = await getRecommendLatest();
            setAiResults(res.results || []);
          } else if (st.status === 'error') {
            stopPolling();
            setAiScanning(false);
            setAiStatus(st.message);
          }
        } catch {
          stopPolling();
          setAiScanning(false);
        }
      }, 2000);
    } catch (e: any) {
      setAiStatus(e?.message || '启动失败');
      setAiScanning(false);
    }
  };

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  const recommendationGroups = [
    { key: 'buy_now', title: '今日可买', desc: '质量达标 + 买点强 + 行业不过弱' },
    { key: 'try_position', title: '轻仓试探', desc: '有买点，但确认度低于强信号' },
    { key: 'watchlist', title: '优质观察', desc: '基本面较好，等待更明确买点' },
  ].map(group => ({
    ...group,
    items: aiResults.filter(r => (r.recommendation_bucket || 'other') === group.key),
  })).filter(group => group.items.length > 0);

  const otherRecommendItems = aiResults.filter(r => !['buy_now', 'try_position', 'watchlist'].includes(r.recommendation_bucket || 'other'));
  const groupedAiResults = recommendationGroups.flatMap(group => group.items).concat(otherRecommendItems);
  const bucketMeta: Record<string, { title: string; desc: string }> = {
    buy_now: { title: '今日可买', desc: '质量达标 + 买点强 + 行业不过弱' },
    try_position: { title: '轻仓试探', desc: '有买点，但确认度低于强信号' },
    watchlist: { title: '优质观察', desc: '基本面较好，等待更明确买点' },
    other: { title: '其他', desc: '不进入主推荐，仅供参考' },
  };

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

      {/* ===== Smart Stock Picker with Tabs ===== */}
      <div className="card-surface p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-[var(--text-primary)] text-lg font-bold tracking-tight flex items-center gap-2">
              🤖 智能选股
            </h3>
          </div>
        </div>

        {/* Tab switcher */}
        <div className="flex gap-1 mb-4 bg-[var(--bg-elevated)] rounded-lg p-1">
          <button
            onClick={() => setActiveTab('ai')}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md text-sm font-semibold transition-all ${
              activeTab === 'ai'
                ? 'bg-[var(--accent-primary)] text-white shadow-sm'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
            }`}
          >
            <Sparkles size={14} /> AI推荐
          </button>
          <button
            onClick={() => setActiveTab('manual')}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md text-sm font-semibold transition-all ${
              activeTab === 'manual'
                ? 'bg-[var(--accent-primary)] text-white shadow-sm'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
            }`}
          >
            <Search size={14} /> 手动选股
          </button>
        </div>

        {/* ===== AI Recommend Tab ===== */}
        {activeTab === 'ai' && (
          <div>
            {/* Sector selector */}
            <div className="mb-3">
              <div className="text-[var(--text-secondary)] text-xs mb-1.5 font-semibold">选择板块（默认沪深300）</div>
              <select
                value={selectedSector}
                onChange={(e) => setSelectedSector(e.target.value)}
                disabled={aiScanning}
                className="w-full bg-[var(--bg-elevated)] border border-[var(--border-color)] rounded-lg px-3 py-2.5 text-sm text-[var(--text-primary)] appearance-none cursor-pointer disabled:opacity-40 focus:outline-none focus:border-purple-500/50"
                style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center' }}
              >
                <option value="">沪深300（全部）</option>
                {sectors.map((s) => (
                  <option key={s.label} value={s.label}>{s.name}（{s.count}只）</option>
                ))}
              </select>
            </div>

            {/* Scan button */}
            <button
              onClick={startAiScan}
              disabled={aiScanning}
              className="w-full bg-gradient-to-r from-purple-600 to-blue-600 text-white rounded-xl py-3.5 font-bold text-sm disabled:opacity-40 active:scale-[0.99] transition-transform flex items-center justify-center gap-2"
            >
              {aiScanning ? (
                <><Loader2 size={16} className="animate-spin" /> 扫描中...</>
              ) : (
                <><Sparkles size={16} /> {selectedSector ? `扫描${sectors.find(s => s.label === selectedSector)?.name || '选中板块'}` : '智能扫描沪深300'}</>
              )}
            </button>

            {/* Progress bar */}
            {aiScanning && (
              <div className="mt-3">
                <div className="flex items-center justify-between text-xs text-[var(--text-muted)] mb-1">
                  <span>{aiStatus}</span>
                  <span>{Math.round(aiProgress * 100)}%</span>
                </div>
                <div className="w-full bg-[var(--bg-elevated)] rounded-full h-1.5">
                  <div
                    className="bg-gradient-to-r from-purple-500 to-blue-500 h-1.5 rounded-full transition-all duration-500"
                    style={{ width: `${aiProgress * 100}%` }}
                  />
                </div>
              </div>
            )}

            {/* AI Results */}
            {aiResults.length > 0 && !aiScanning && (
              <div className="mt-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[var(--text-primary)] text-sm font-bold flex items-center gap-1.5">
                    <Sparkles size={14} className="text-purple-400" />
                    推荐结果
                    <span className="text-[var(--text-muted)] text-xs font-normal ml-1">{aiResults[0]?.recommend_date}</span>
                  </div>
                  <button onClick={startAiScan} className="text-[var(--accent-primary)] text-xs flex items-center gap-1">
                    <RefreshCw size={10} /> 重新扫描
                  </button>
                </div>

                <div className="flex flex-col gap-2">
                  {groupedAiResults.map((r, index) => {
                    const bucket = r.recommendation_bucket || 'other';
                    const prevBucket = index > 0 ? (groupedAiResults[index - 1].recommendation_bucket || 'other') : null;
                    const meta = bucketMeta[bucket] || bucketMeta.other;
                    return (
                    <div key={`${bucket}-${r.symbol}`}>
                      {bucket !== prevBucket && (
                        <div className={`mt-2 rounded-lg px-3 py-2 border ${
                          bucket === 'buy_now' ? 'bg-emerald-500/10 border-emerald-500/25' :
                          bucket === 'try_position' ? 'bg-blue-500/10 border-blue-500/25' :
                          bucket === 'watchlist' ? 'bg-amber-500/10 border-amber-500/25' :
                          'bg-[var(--bg-surface)] border-[var(--border-color)]'
                        }`}>
                          <div className="text-[var(--text-primary)] text-sm font-extrabold">{meta.title}</div>
                          <div className="text-[var(--text-secondary)] text-[10px] mt-0.5">{meta.desc}</div>
                        </div>
                      )}
                      <div
                      onClick={() => router.push(`/stock?symbol=${encodeURIComponent(r.symbol)}&market=CN&name=${encodeURIComponent(r.name)}`)}
                      className="rounded-xl p-3.5 border-2 border-[var(--border-color)] cursor-pointer active:scale-[0.99] transition-all bg-[var(--bg-elevated)] hover:border-purple-500/30"
                    >
                      {/* Row 1: rank + name + code + action */}
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`text-xs font-extrabold w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 ${
                            r.rank <= 3 ? 'bg-gradient-to-br from-purple-500 to-blue-500 text-white' : 'bg-[var(--bg-surface)] text-[var(--text-secondary)]'
                          }`}>
                            {r.rank}
                          </span>
                          {marketTag(r.market)}
                          <span className="text-[var(--text-primary)] text-sm font-bold truncate">{r.name}</span>
                          <span className="text-[var(--text-muted)] text-[10px]">{r.symbol.split('.')[0]}</span>
                        </div>
                        <span className={`text-xs font-bold px-2 py-0.5 rounded-full whitespace-nowrap ${
                          bucket === 'buy_now' ? 'bg-emerald-500/25 text-emerald-300' :
                          bucket === 'try_position' ? 'bg-blue-500/20 text-blue-400' :
                          bucket === 'watchlist' ? 'bg-amber-500/20 text-amber-400' :
                          'bg-[var(--bg-surface)] text-[var(--text-muted)]'
                        }`}>
                          {(bucketMeta[bucket] || bucketMeta.other).title}
                        </span>
                      </div>

                      {/* Row 2: quality + timing scores + trend */}
                      <div className="flex items-center gap-2 mb-1.5 text-[10px]">
                        {r.quality_score_total != null && (
                          <span className="bg-[var(--bg-surface)] px-1.5 py-0.5 rounded">
                            <span className="text-[var(--text-muted)]">质量</span>
                            <span className={`font-bold ml-0.5 ${
                              r.quality_score_total >= 50 ? 'text-emerald-400' :
                              r.quality_score_total >= 30 ? 'text-blue-400' :
                              'text-amber-400'
                            }`}>{r.quality_score_total.toFixed(0)}</span>
                          </span>
                        )}
                        {r.timing_score_total != null && (
                          <span className="bg-[var(--bg-surface)] px-1.5 py-0.5 rounded">
                            <span className="text-[var(--text-muted)]">时机</span>
                            <span className={`font-bold ml-0.5 ${
                              r.timing_score_total >= 90 ? 'text-emerald-400' :
                              r.timing_score_total >= 55 ? 'text-blue-400' :
                              'text-amber-400'
                            }`}>{r.timing_score_total.toFixed(0)}</span>
                          </span>
                        )}
                        {r.trend && (
                          <span className={`font-medium ${
                            r.trend === '上涨' ? 'text-emerald-400' :
                            r.trend === '下跌' ? 'text-red-400' :
                            'text-amber-400'
                          }`}>趋势{r.trend}</span>
                        )}
                      </div>

                      {(r.strategy_buy_zone_high != null || r.strategy_stop_loss != null || r.strategy_take_profit_1 != null || r.strategy_take_profit_2 != null) && (
                        <div className="grid grid-cols-2 gap-1.5 mb-1.5 text-[10px]">
                          <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-2 py-1">
                            <span className="text-[var(--text-muted)]">买入区间 </span>
                            <span className="text-emerald-400 font-bold">
                              {r.strategy_buy_zone_low != null ? r.strategy_buy_zone_low.toFixed(2) : '-'}-{r.strategy_buy_zone_high != null ? r.strategy_buy_zone_high.toFixed(2) : '-'}
                            </span>
                          </div>
                          <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-2 py-1">
                            <span className="text-[var(--text-muted)]">止损 </span>
                            <span className="text-red-400 font-bold">{r.strategy_stop_loss != null ? r.strategy_stop_loss.toFixed(2) : '-'}</span>
                          </div>
                          <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-2 py-1">
                            <span className="text-[var(--text-muted)]">止盈1 </span>
                            <span className="text-amber-300 font-bold">{r.strategy_take_profit_1 != null ? r.strategy_take_profit_1.toFixed(2) : '-'}</span>
                          </div>
                          <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-2 py-1">
                            <span className="text-[var(--text-muted)]">止盈2 </span>
                            <span className="text-amber-300 font-bold">{r.strategy_take_profit_2 != null ? r.strategy_take_profit_2.toFixed(2) : '-'}</span>
                          </div>
                        </div>
                      )}

                      <div className="text-[10px] text-[var(--text-secondary)] mb-1.5 flex flex-wrap gap-1.5">
                        <span className="bg-[var(--bg-surface)] px-1.5 py-0.5 rounded">动作: {r.action || '-'}</span>
                        {r.sector_name && <span className="bg-[var(--bg-surface)] px-1.5 py-0.5 rounded">行业: {r.sector_name}</span>}
                        {r.sector_strength_score != null && <span className="bg-[var(--bg-surface)] px-1.5 py-0.5 rounded">行业强度 {r.sector_strength_score.toFixed(0)}</span>}
                      </div>

                      {/* Row 3: factor scores bar */}
                      <div className="flex items-center gap-1.5 mb-1.5">
                        {[
                          { label: '价值', score: r.value_score },
                          { label: '成长', score: r.growth_score },
                          { label: '质量', score: r.quality_score },
                          { label: '技术', score: r.tech_score },
                        ].map((f) => (
                          <div key={f.label} className="flex-1">
                            <div className="text-[8px] text-[var(--text-muted)] mb-0.5">{f.label}</div>
                            <div className="w-full bg-[var(--bg-surface)] rounded-full h-1">
                              <div
                                className={`h-1 rounded-full ${
                                  f.score >= 20 ? 'bg-emerald-400' : f.score >= 15 ? 'bg-amber-400' : 'bg-red-400'
                                }`}
                                style={{ width: `${(f.score / 25) * 100}%` }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Row 4: reason */}
                      {r.reason && (
                        <div className="text-[11px] text-[var(--text-secondary)] leading-relaxed bg-[var(--bg-surface)] rounded-lg px-2.5 py-1.5">
                          {r.timing_signal_reason || r.reason}
                        </div>
                      )}
                      </div>
                    </div>
                  );})}
                </div>
              </div>
            )}

            {!aiScanning && aiResults.length === 0 && !aiStatus.includes('失败') && (
              <div className="mt-4 text-center py-6">
                <p className="text-[var(--text-muted)] text-sm">选择板块后点击上方按钮，开始智能扫描</p>
              </div>
            )}
          </div>
        )}

        {/* ===== Manual Tab ===== */}
        {activeTab === 'manual' && (
          <div>
            <p className="text-[var(--text-muted)] text-xs mb-3">添加股票后一键筛选，系统根据趋势/斜率/RSI自动判断买入信号</p>

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
                  <div className="text-[var(--text-primary)] text-sm font-bold">筛选结果</div>
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
