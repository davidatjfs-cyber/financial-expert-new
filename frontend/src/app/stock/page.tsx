'use client';

import { Suspense, useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search, Download, X } from 'lucide-react';
import { searchStocks, getStockPrice, getStockIndicators, getStockAnnouncements, fetchMarketReport, type StockSearchResult, type StockPrice, type StockIndicators, type StockAnnouncement } from '@/services/api';

function StockPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<StockSearchResult[]>([]);
  const [selectedStock, setSelectedStock] = useState<StockSearchResult | null>(null);
  const [stockPrice, setStockPrice] = useState<StockPrice | null>(null);
  const [stockIndicators, setStockIndicators] = useState<StockIndicators | null>(null);
  const [searching, setSearching] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [loadingPrice, setLoadingPrice] = useState(false);
  const [message, setMessage] = useState('');
  const [showDetail, setShowDetail] = useState(false);
  const [announcements, setAnnouncements] = useState<StockAnnouncement[]>([]);

  const fmt = (v: number | null | undefined, digits = 2) => (v == null ? '-' : v.toFixed(digits));

  const fmtBig = (v: number | null | undefined) => (v == null ? '-' : v.toLocaleString());

  const fmtMoney = (v: number | null | undefined) => {
    if (v == null) return '-';
    const abs = Math.abs(v);
    if (abs >= 1e8) return (v / 1e8).toFixed(2) + '亿';
    if (abs >= 1e4) return (v / 1e4).toFixed(2) + '万';
    return v.toFixed(0);
  };

  const fmtYi = (v: number | null | undefined) => (v == null ? '-' : (v / 1e8).toFixed(2) + '亿');

  const fmtCompact = (v: number | null | undefined, digits = 2) => {
    if (v == null) return '-';
    const abs = Math.abs(v);
    if (abs >= 1e12) return (v / 1e12).toFixed(digits) + 'T';
    if (abs >= 1e9) return (v / 1e9).toFixed(digits) + 'B';
    if (abs >= 1e6) return (v / 1e6).toFixed(digits) + 'M';
    if (abs >= 1e3) return (v / 1e3).toFixed(digits) + 'K';
    return v.toFixed(0);
  };

  const fmtBigByMarket = (v: number | null | undefined, market?: string) => {
    return currencyPrefix(market) + fmtYi(v);
  };

  const fmtVolumeByMarket = (v: number | null | undefined, market?: string) => {
    if (v == null) return '-';
    if (market === 'US') return fmtCompact(v, 2) + '股';
    return fmtBig(v) + '股';
  };

  const fmtNA = (v: number | null | undefined, digits = 2) => (v == null ? 'N/A' : v.toFixed(digits));

  const currencyPrefix = (market?: string) => {
    if (market === 'US') return '$';
    if (market === 'HK') return 'HK$';
    return '¥';
  };

  const fmtSigned = (v: number | null | undefined, digits = 2) => {
    if (v == null) return '-';
    const s = v.toFixed(digits);
    return v > 0 ? `+${s}` : s;
  };

  const trendLabel = (trend?: string | null) => {
    const t = (trend || '').trim();
    if (!t) return '-';
    return t;
  };

  const trendColorClass = (trend?: string | null) => {
    const t = (trend || '').trim();
    if (t === '上涨') return 'text-[#E85A4F]';
    if (t === '下跌') return 'text-[#32D583]';
    return 'text-[#FAFAF9]';
  };

  // Fetch price when stock is selected
  useEffect(() => {
    if (selectedStock) {
      setLoadingPrice(true);
      getStockPrice(selectedStock.symbol, selectedStock.market)
        .then(price => setStockPrice(price))
        .catch(() => setStockPrice(null))
        .finally(() => setLoadingPrice(false));

      getStockIndicators(selectedStock.symbol, selectedStock.market)
        .then((v) => setStockIndicators(v))
        .catch(() => setStockIndicators(null));

      getStockAnnouncements(selectedStock.symbol, selectedStock.market, 5)
        .then((v) => setAnnouncements(v))
        .catch(() => setAnnouncements([]));
    } else {
      setStockPrice(null);
      setStockIndicators(null);
      setAnnouncements([]);
    }
  }, [selectedStock]);

  useEffect(() => {
    const symbol = searchParams.get('symbol');
    const market = searchParams.get('market');
    const name = searchParams.get('name');
    if (symbol && market) {
      setSelectedStock({ symbol, market, name: name || symbol });
    }
  }, [searchParams]);

  useEffect(() => {
    if (!selectedStock) return;
    try {
      const item = { symbol: selectedStock.symbol, market: selectedStock.market, name: selectedStock.name };
      const raw = localStorage.getItem('recent_stocks');
      const prev = raw ? (JSON.parse(raw) as any[]) : [];
      const next = [item, ...(Array.isArray(prev) ? prev : [])]
        .filter((v, idx, arr) => v && arr.findIndex((x) => x.symbol === v.symbol && x.market === v.market) === idx)
        .slice(0, 10);
      localStorage.setItem('recent_stocks', JSON.stringify(next));
    } catch {
      // ignore
    }
  }, [selectedStock]);

  const refreshQuote = async () => {
    if (!selectedStock) return;
    setLoadingPrice(true);
    try {
      const price = await getStockPrice(selectedStock.symbol, selectedStock.market);
      setStockPrice(price);
      const ind = await getStockIndicators(selectedStock.symbol, selectedStock.market);
      setStockIndicators(ind);
    } catch {
      setStockPrice(null);
      setStockIndicators(null);
    } finally {
      setLoadingPrice(false);
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setMessage('');
    setSearchResults([]);
    try {
      console.log('Searching for:', searchQuery);
      const results = await searchStocks(searchQuery.trim());
      console.log('Search results:', results);
      setSearchResults(results);
      if (results.length === 0) {
        setMessage('未找到匹配的股票');
      } else {
        setMessage('请选择股票（可区分 A股 / 港股 / 美股）');
      }
    } catch (error) {
      console.error('Search error:', error);
      setMessage('搜索失败，请检查网络连接');
    } finally {
      setSearching(false);
    }
  };

  const handleFetchReport = async () => {
    if (!selectedStock) return;
    setFetching(true);
    setMessage('');
    try {
      const resp = await fetchMarketReport(
        selectedStock.symbol,
        selectedStock.market,
        'annual',
        undefined,
        selectedStock.name
      );
      setMessage(resp.message || '已开始获取财报数据');
      if (resp?.report_id) {
        router.push(`/reports/${resp.report_id}`);
      }
    } catch (error) {
      setMessage('获取失败，请重试');
    } finally {
      setFetching(false);
    }
  };

  return (
    <div className="p-4 md:p-10 flex flex-col gap-6 md:gap-7 max-w-3xl mx-auto pb-24 md:pb-10 animate-fade-in">
      {/* Header */}
      <div>
        <h1 className="text-[var(--text-primary)] text-2xl md:text-3xl font-bold tracking-tight">股票查询</h1>
        <p className="text-[var(--text-secondary)] text-base mt-2">搜索股票代码或公司名称，获取财务数据</p>
      </div>

      {/* Search Results */}
      {searchResults.length > 0 && (
        <div>
          <h2 className="section-title mb-3">搜索结果</h2>
          <div className="flex flex-col gap-2.5">
            {searchResults.map((stock) => {
              const isSelected = selectedStock?.symbol === stock.symbol && selectedStock?.market === stock.market;
              return (
                <button
                  key={`${stock.market}:${stock.symbol}`}
                  type="button"
                  onClick={() => setSelectedStock(stock)}
                  className={`card-surface p-5 text-left flex items-center justify-between transition-all duration-150 active:scale-[0.99] ${
                    isSelected ? 'border-2 border-emerald-500/60 bg-emerald-500/10' : ''
                  }`}
                >
                  <div>
                    <div className="text-[var(--text-primary)] text-base font-semibold">{stock.name}</div>
                    <div className="text-[var(--text-secondary)] text-sm mt-0.5">{stock.symbol}</div>
                  </div>
                  <span className="text-[var(--text-muted)] text-sm">{stock.market}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Search Card - unified for mobile and desktop */}
      <div className="card-surface p-4 md:p-7">
        <div className="relative mb-3 md:mb-6">
          <Search className="absolute left-4 md:left-6 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" size={22} />
          <input
            type="text"
            placeholder="输入股票代码或公司名称，如 600519、苹果、AAPL"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            className="w-full bg-[var(--bg-elevated)] text-[var(--text-primary)] rounded-[var(--radius-lg)] md:rounded-[var(--radius-xl)] py-4 md:py-5 pl-12 md:pl-16 pr-4 md:pr-6 text-base md:text-lg border-2 border-[var(--border-color)] focus:border-[var(--accent-primary)] focus:outline-none placeholder:text-[var(--text-muted)] transition-colors"
          />
        </div>
        <button
          onClick={handleSearch}
          disabled={searching || !searchQuery.trim()}
          className="w-full btn-primary rounded-[var(--radius-lg)] py-4 md:py-5 px-5 md:px-6 text-base md:text-lg flex items-center justify-center gap-2 md:gap-3 disabled:opacity-50"
        >
          <Search size={22} />
          {searching ? '搜索中...' : '搜索股票'}
        </button>
      </div>

      {/* Selected Stock Detail */}
      {selectedStock && (
        <div className="bg-gradient-to-br from-emerald-950/40 to-[var(--bg-surface)] rounded-[var(--radius-xl)] p-6 border-2 border-emerald-500/40 shadow-lg shadow-emerald-500/10">
          {/* 股票名称和代码 */}
          <div className="text-center mb-4">
            <div className="text-emerald-400 text-2xl font-bold mb-1">{selectedStock.name}</div>
            <div className="text-[var(--text-primary)] text-lg md:text-xl">{selectedStock.symbol}</div>
            <div className="text-[var(--text-secondary)] text-base mt-2">{selectedStock.market} 市场</div>
          </div>

          {/* Real-time price */}
          <div className="bg-[var(--bg-page)]/70 rounded-[var(--radius-lg)] p-4 border border-[var(--border-color)] mb-4">
            <div className="flex items-center justify-between">
              <div className="text-[var(--text-secondary)] text-sm">实时价格</div>
              <div className="text-[var(--text-muted)] text-sm">{loadingPrice ? '更新中...' : '已更新'}</div>
            </div>
            <div className="mt-2 flex items-end justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[var(--text-primary)] text-3xl md:text-4xl font-bold truncate tracking-tight">
                  {currencyPrefix(selectedStock.market)}{fmt(stockPrice?.price)}
                </div>
                <div className={`mt-2 text-base md:text-lg font-semibold ${
                  (stockPrice?.change ?? 0) > 0
                    ? 'text-emerald-400'
                    : (stockPrice?.change ?? 0) < 0
                      ? 'text-red-400'
                      : 'text-[var(--text-primary)]'
                }`}>
                  {fmtSigned(stockPrice?.change)} ({fmtSigned(stockPrice?.change_pct)}%)
                </div>
              </div>
              <button
                onClick={refreshQuote}
                className="btn-secondary h-10 px-3.5 text-sm !min-h-0 !py-0"
              >
                刷新
              </button>
            </div>
          </div>

          <button
            onClick={() => setShowDetail(true)}
            className="w-full btn-secondary rounded-[var(--radius-lg)] py-4 px-6 font-bold text-base mb-3"
          >
            查看关键指标
          </button>

          {/* Action Button */}
          <button 
            onClick={handleFetchReport}
            disabled={fetching}
            className="w-full bg-[var(--accent-secondary)] text-white rounded-[var(--radius-lg)] py-4 px-6 font-bold text-lg flex items-center justify-center gap-2 disabled:opacity-50 active:scale-[0.99] transition-transform"
          >
            <Download size={22} />
            {fetching ? '获取中...' : '获取财报数据'}
          </button>
        </div>
      )}

      {selectedStock && showDetail && (
        <div className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-3 animate-fade-in" onClick={() => setShowDetail(false)}>
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full md:max-w-xl bg-[var(--bg-page)] rounded-[var(--radius-xl)] border border-[var(--border-color)] max-h-[calc(100dvh-24px)] overflow-y-auto overscroll-contain pb-[calc(env(safe-area-inset-bottom,0px)+80px)] animate-slide-up"
          >
            {/* Header with gradient */}
            <div className="sticky top-0 z-10 bg-gradient-to-b from-[var(--bg-page)] via-[var(--bg-page)] to-transparent px-5 pt-5 pb-3">
              <div className="flex items-center justify-between">
                <div className="min-w-0 flex-1">
                  <div className="text-[var(--text-primary)] text-lg font-bold tracking-tight truncate">{selectedStock.name}</div>
                  <div className="text-[var(--text-muted)] text-xs">{selectedStock.symbol} · {selectedStock.market}</div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button onClick={refreshQuote} className="text-[var(--accent-primary)] text-xs font-semibold px-3 py-1.5 rounded-full bg-[var(--accent-primary)]/10">
                    {loadingPrice ? '刷新中' : '刷新'}
                  </button>
                  <button onClick={() => setShowDetail(false)} className="w-8 h-8 rounded-full bg-[var(--bg-elevated)] flex items-center justify-center">
                    <X size={16} className="text-[var(--text-muted)]" />
                  </button>
                </div>
              </div>
            </div>

            <div className="px-5 flex flex-col gap-3">
              {/* Section 1: Price */}
              <div className="flex items-end justify-between">
                <div>
                  <div className="text-[var(--text-primary)] text-3xl font-extrabold tracking-tight">
                    {currencyPrefix(selectedStock.market)}{fmt(stockPrice?.price)}
                  </div>
                  <div className={`text-sm font-bold mt-0.5 ${(stockPrice?.change ?? 0) > 0 ? 'text-emerald-400' : (stockPrice?.change ?? 0) < 0 ? 'text-red-400' : 'text-[var(--text-secondary)]'}`}>
                    {fmtSigned(stockPrice?.change)} ({fmtSigned(stockPrice?.change_pct)}%)
                  </div>
                </div>
                <div className="text-right">
                  <div className={`text-2xl font-extrabold ${trendColorClass(stockIndicators?.trend)}`}>{trendLabel(stockIndicators?.trend)}</div>
                  <div className="text-[var(--text-muted)] text-[10px] mt-0.5">MA60趋势</div>
                </div>
              </div>

              {/* Section 2: Core Metrics - compact row */}
              <div className="grid grid-cols-4 gap-1.5">
                {[
                  { label: '市值', value: fmtBigByMarket(stockIndicators?.market_cap ?? stockPrice?.market_cap, selectedStock.market) },
                  { label: 'PE', value: fmt(stockIndicators?.pe_ratio, 1) },
                  { label: '52W高', value: fmt(stockIndicators?.high_52w), color: 'text-red-400' },
                  { label: '52W低', value: fmt(stockIndicators?.low_52w), color: 'text-emerald-400' },
                ].map((item) => (
                  <div key={item.label} className="bg-[var(--bg-surface)] rounded-lg p-2 text-center">
                    <div className="text-[var(--text-muted)] text-[9px] font-medium">{item.label}</div>
                    <div className={`${item.color || 'text-[var(--text-primary)]'} text-xs font-bold mt-0.5 truncate`}>{item.value}</div>
                  </div>
                ))}
              </div>

              {/* Section 3: Technical Indicators */}
              <div className="bg-[var(--bg-surface)] rounded-xl p-4">
                <div className="text-[var(--text-primary)] text-xs font-bold mb-3 flex items-center gap-1.5">
                  <span className="w-1 h-3.5 bg-[var(--accent-primary)] rounded-full"></span>
                  技术指标
                </div>
                <div className="grid grid-cols-3 gap-x-4 gap-y-2.5">
                  {/* MA */}
                  <div>
                    <div className="text-[var(--text-muted)] text-[9px]">MA5</div>
                    <div className="text-[var(--text-primary)] text-sm font-bold">{fmt(stockIndicators?.ma5)}</div>
                  </div>
                  <div>
                    <div className="text-[var(--text-muted)] text-[9px]">MA20</div>
                    <div className="text-[var(--text-primary)] text-sm font-bold">{fmt(stockIndicators?.ma20)}</div>
                  </div>
                  <div>
                    <div className="text-[var(--text-muted)] text-[9px]">MA60</div>
                    <div className="text-[var(--text-primary)] text-sm font-bold">{fmt(stockIndicators?.ma60)}</div>
                  </div>
                  {/* Slope */}
                  <div>
                    <div className="text-[var(--text-muted)] text-[9px]">Slope率</div>
                    <div className="text-[var(--text-primary)] text-sm font-bold">{stockIndicators?.slope_pct == null ? '-' : `${fmt(stockIndicators?.slope_pct, 3)}%`}</div>
                  </div>
                  <div>
                    <div className="text-[var(--text-muted)] text-[9px]">Slope建议</div>
                    <div className={`text-sm font-bold ${stockIndicators?.slope_advice === '放心买' ? 'text-emerald-400' : stockIndicators?.slope_advice === '有危险' ? 'text-red-400' : stockIndicators?.slope_advice === '不要买' ? 'text-red-400' : 'text-amber-400'}`}>
                      {stockIndicators?.slope_advice || '-'}
                    </div>
                  </div>
                  <div>
                    <div className="text-[var(--text-muted)] text-[9px]">ATR(14)</div>
                    <div className="text-[var(--text-primary)] text-sm font-bold">{fmt(stockIndicators?.atr14, 3)}</div>
                  </div>
                  {/* RSI & MACD */}
                  <div>
                    <div className="text-[var(--text-muted)] text-[9px]">RSI(14)</div>
                    <div className={`text-sm font-bold ${(stockIndicators?.rsi14 ?? 50) > 70 ? 'text-red-400' : (stockIndicators?.rsi14 ?? 50) < 30 ? 'text-emerald-400' : 'text-[var(--text-primary)]'}`}>
                      {fmt(stockIndicators?.rsi14, 1)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[var(--text-muted)] text-[9px]">RSI拐头</div>
                    <div className={`text-sm font-bold ${stockIndicators?.rsi_rebound ? 'text-emerald-400' : 'text-[var(--text-muted)]'}`}>
                      {stockIndicators?.rsi_rebound ? '✓ 是' : '✗ 否'}
                    </div>
                  </div>
                  <div>
                    <div className="text-[var(--text-muted)] text-[9px]">MACD</div>
                    <div className={`text-sm font-bold ${stockIndicators?.signal_macd_bullish ? 'text-emerald-400' : 'text-red-400'}`}>
                      {stockIndicators?.signal_macd_bullish ? '多头' : '空头'}
                    </div>
                  </div>
                </div>
              </div>

              {/* Section 4: Buy Signal */}
              <div className={`rounded-xl p-4 border-2 ${stockIndicators?.buy_price_aggressive_ok ? 'bg-emerald-500/8 border-emerald-500/30' : 'bg-[var(--bg-surface)] border-[var(--border-color)]'}`}>
                <div className="flex items-center justify-between mb-2">
                  <div className="text-xs font-bold flex items-center gap-1.5">
                    <span className="w-1 h-3.5 bg-emerald-500 rounded-full"></span>
                    <span className="text-emerald-400">买入信号</span>
                  </div>
                  <div className={`text-xs font-extrabold px-3 py-1 rounded-full ${stockIndicators?.buy_price_aggressive_ok ? 'bg-emerald-500 text-white' : 'bg-[var(--bg-elevated)] text-[var(--text-muted)]'}`}>
                    {stockIndicators?.buy_price_aggressive_ok ? '✓ 满足' : '等待中'}
                  </div>
                </div>
                <div className="flex items-center gap-3 mb-2">
                  <div className="text-[var(--text-primary)] text-xs">参考买入价</div>
                  <div className="text-emerald-400 text-lg font-extrabold">{currencyPrefix(selectedStock.market)}{fmt(stockIndicators?.buy_price_aggressive)}</div>
                  <div className="text-[var(--text-muted)] text-[10px]">≈MA20</div>
                </div>
                <div className="text-[var(--text-secondary)] text-[11px] leading-relaxed">
                  {stockIndicators?.buy_condition_desc || '数据加载中...'}
                </div>
              </div>

              {/* Section 5: Sell Signal */}
              <div className={`rounded-xl p-4 border-2 ${stockIndicators?.sell_price_ok ? 'bg-red-500/8 border-red-500/30' : 'bg-[var(--bg-surface)] border-[var(--border-color)]'}`}>
                <div className="flex items-center justify-between mb-2">
                  <div className="text-xs font-bold flex items-center gap-1.5">
                    <span className="w-1 h-3.5 bg-red-500 rounded-full"></span>
                    <span className="text-red-400">卖出信号</span>
                  </div>
                  <div className={`text-xs font-extrabold px-3 py-1 rounded-full ${stockIndicators?.sell_price_ok ? 'bg-red-500 text-white' : 'bg-[var(--bg-elevated)] text-[var(--text-muted)]'}`}>
                    {stockIndicators?.sell_price_ok ? '⚠ 触发' : '安全'}
                  </div>
                </div>
                <div className="flex items-center gap-3 mb-2">
                  <div className="text-[var(--text-primary)] text-xs">止损参考价</div>
                  <div className="text-red-400 text-lg font-extrabold">{currencyPrefix(selectedStock.market)}{fmt(stockIndicators?.sell_price)}</div>
                  <div className="text-[var(--text-muted)] text-[10px]">价-2×ATR</div>
                </div>
                <div className="text-[var(--text-secondary)] text-[11px] leading-relaxed">
                  {stockIndicators?.sell_condition_desc || '数据加载中...'}
                </div>
                {stockIndicators?.sell_reason && (
                  <div className="mt-1.5 text-red-400 text-[11px] font-semibold">{stockIndicators.sell_reason}</div>
                )}
              </div>

              {/* Section 6: Signal Summary */}
              <div className="flex gap-1.5 flex-wrap">
                {[
                  { label: '金叉', active: stockIndicators?.signal_golden_cross, color: 'emerald' },
                  { label: '死叉', active: stockIndicators?.signal_death_cross, color: 'red' },
                  { label: 'MACD多', active: stockIndicators?.signal_macd_bullish, color: 'emerald' },
                  { label: 'RSI超买', active: stockIndicators?.signal_rsi_overbought, color: 'red' },
                  { label: '放量', active: stockIndicators?.signal_vol_gt_ma5, color: 'amber' },
                ].map((s) => (
                  <span key={s.label} className={`text-[10px] font-semibold px-2 py-1 rounded-full ${s.active ? `bg-${s.color}-500/15 text-${s.color}-400` : 'bg-[var(--bg-elevated)] text-[var(--text-muted)]'}`}>
                    {s.active ? '●' : '○'} {s.label}
                  </span>
                ))}
              </div>

              {/* Section 7: Announcements */}
              {announcements.length > 0 && (
                <div className="bg-[var(--bg-surface)] rounded-xl p-4">
                  <div className="text-[var(--text-primary)] text-xs font-bold mb-3 flex items-center gap-1.5">
                    <span className="w-1 h-3.5 bg-amber-500 rounded-full"></span>
                    最新公告
                  </div>
                  <div className="flex flex-col gap-2">
                    {announcements.map((a, i) => (
                      <div key={i} className="flex items-start gap-2">
                        <span className="text-[var(--text-muted)] text-[10px] mt-0.5 flex-shrink-0 w-[68px]">{a.date || ''}</span>
                        {a.url ? (
                          <a href={a.url} target="_blank" rel="noopener noreferrer" className="text-[var(--accent-primary)] text-xs leading-relaxed hover:underline line-clamp-2">
                            {a.title}
                          </a>
                        ) : (
                          <span className="text-[var(--text-secondary)] text-xs leading-relaxed line-clamp-2">{a.title}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Action */}
              <button
                onClick={() => { setShowDetail(false); handleFetchReport(); }}
                disabled={fetching}
                className="w-full bg-[var(--accent-secondary)] text-white rounded-xl py-3.5 font-bold text-sm disabled:opacity-50 active:scale-[0.99] transition-transform mb-4"
              >
                {fetching ? '获取中...' : '获取财报数据'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Message */}
      {message && (
        <div className={`rounded-[var(--radius-md)] p-4 text-center text-sm font-medium ${
          message.includes('失败') ? 'bg-red-500/15 text-red-400' : 'bg-emerald-500/15 text-emerald-400'
        }`}>
          {message}
        </div>
      )}

      {/* Quick Search Suggestions */}
      <div>
        <h2 className="section-title mb-3">热门股票</h2>
        <div className="flex flex-col gap-2.5">
          {[
            { name: '腾讯控股', symbol: '00700.HK', market: 'HK' },
            { name: '阿里巴巴', symbol: 'BABA', market: 'US' },
            { name: '贵州茅台', symbol: '600519.SH', market: 'CN' },
            { name: '苹果公司', symbol: 'AAPL', market: 'US' },
          ].map((stock) => (
            <div
              key={stock.symbol}
              onClick={() => {
                setSelectedStock(stock);
              }}
              className="card-surface p-5 flex items-center justify-between cursor-pointer active:scale-[0.99] transition-all duration-150"
            >
              <div>
                <span className="text-[var(--text-primary)] text-base font-semibold">{stock.name}</span>
                <span className="text-[var(--text-secondary)] text-sm ml-2">{stock.symbol}</span>
              </div>
              <span className="text-[var(--text-muted)] text-sm">{stock.market}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function StockPage() {
  return (
    <Suspense
      fallback={
        <div className="p-5 md:p-8 flex flex-col gap-6 max-w-2xl mx-auto">
          <div className="card-surface p-10 text-center">
            <p className="text-[var(--text-secondary)] text-base">加载中...</p>
          </div>
        </div>
      }
    >
      <StockPageInner />
    </Suspense>
  );
}
