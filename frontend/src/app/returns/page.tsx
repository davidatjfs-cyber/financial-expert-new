'use client';

import { useEffect, useState } from 'react';
import { Brain, PiggyBank, Wallet, TrendingUp, RefreshCw } from 'lucide-react';
import {
  getPortfolioTrades,
  getPortfolioSummary,
  getPortfolioReturns,
  getPortfolioAgentConfig,
  getPortfolioAgentStatus,
  updatePortfolioAgentConfig,
  runPortfolioAgentNow,
  type PortfolioTrade,
  type PortfolioSummary,
  type PortfolioReturns,
  type PortfolioAgentConfig,
  type PortfolioAgentStatus,
} from '@/services/api';

export default function ReturnsPage() {
  const SH_TIMEZONE = 'Asia/Shanghai';
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [trades, setTrades] = useState<PortfolioTrade[]>([]);
  const [summary, setSummary] = useState<PortfolioSummary | null>(null);
  const [returnsData, setReturnsData] = useState<PortfolioReturns | null>(null);
  const [agentConfig, setAgentConfig] = useState<PortfolioAgentConfig | null>(null);
  const [agentStatus, setAgentStatus] = useState<PortfolioAgentStatus | null>(null);
  const [agentCapital, setAgentCapital] = useState('10000000');
  const [agentTargetProfit, setAgentTargetProfit] = useState('');
  const [agentDeadline, setAgentDeadline] = useState('');
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  const fmt = (v: number | null | undefined, digits = 2) => (v == null ? '-' : v.toFixed(digits));
  const fmtSigned = (v: number | null | undefined, digits = 2) => {
    if (v == null) return '-';
    const s = v.toFixed(digits);
    return v > 0 ? `+${s}` : s;
  };
  const fmtTs = (ts?: number | null) => {
    if (!ts) return '-';
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: SH_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(ts * 1000));
  };
  const fmtShanghaiInput = (ts?: number | null) => {
    if (!ts) return '';
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: SH_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(ts * 1000));
    const map = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}`;
  };
  const parseShanghaiInput = (value: string) => {
    if (!value) return null;
    const iso = `${value}:00+08:00`;
    const parsed = new Date(iso).getTime();
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
  };
  const sourceLabel = (source: PortfolioTrade['source']) => source === 'manual' ? '手动' : source === 'auto_strategy' ? 'Agent策略' : '委托自动';
  const sourceGroup = (source: PortfolioTrade['source']) => source === 'manual' ? 'manual' : 'agent';

  const loadData = async () => {
    try {
      const [ts, sm, rt, ac, as] = await Promise.all([
        getPortfolioTrades(undefined, 200),
        getPortfolioSummary(),
        getPortfolioReturns(),
        getPortfolioAgentConfig(),
        getPortfolioAgentStatus(),
      ]);
      setTrades(ts);
      setSummary(sm);
      setReturnsData(rt);
      setAgentConfig(ac);
      setAgentStatus(as);
      setAgentCapital(ac.capital != null ? String(ac.capital) : '10000000');
      setAgentTargetProfit(ac.target_profit != null ? String(ac.target_profit) : '');
      setAgentDeadline(fmtShanghaiInput(ac.deadline_ts));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    const timer = setInterval(loadData, 30000);
    return () => clearInterval(timer);
  }, []);

  const handleSaveAgent = async () => {
    try {
      setSaving(true);
      const deadlineTs = parseShanghaiInput(agentDeadline);
      const targetProfit = agentTargetProfit.trim() ? Number(agentTargetProfit) : null;
      await updatePortfolioAgentConfig({
        enabled: !!agentConfig?.enabled,
        capital: Number(agentCapital) || 10000000,
        target_profit: Number.isFinite(targetProfit as number) ? targetProfit : null,
        deadline_ts: deadlineTs,
        min_buy_quantity: Math.max(10000, Number(agentConfig?.min_buy_quantity || 10000)),
        last_run_at: agentConfig?.last_run_at ?? null,
        last_action: agentConfig?.last_action ?? null,
        last_status: agentConfig?.last_status ?? null,
      });
      await loadData();
      setMessage('Agent 配置已保存');
    } catch {
      setMessage('Agent 配置保存失败');
    } finally {
      setSaving(false);
      setTimeout(() => setMessage(null), 3000);
    }
  };

  const handleRunAgent = async () => {
    try {
      setRunning(true);
      const resp = await runPortfolioAgentNow();
      await loadData();
      setMessage(`Agent 运行完成：${resp.message}`);
    } catch {
      setMessage('Agent 运行失败');
    } finally {
      setRunning(false);
      setTimeout(() => setMessage(null), 3000);
    }
  };

  const manualTrades = trades.filter((trade) => sourceGroup(trade.source) === 'manual');
  const agentTrades = trades.filter((trade) => sourceGroup(trade.source) === 'agent');
  const periodCards = [
    {
      label: '今日收益',
      total: returnsData?.today_pnl,
      manual: returnsData?.manual?.today_pnl,
      agent: returnsData?.agent?.today_pnl,
    },
    {
      label: '本周收益',
      total: returnsData?.week_pnl,
      manual: returnsData?.manual?.week_pnl,
      agent: returnsData?.agent?.week_pnl,
    },
    {
      label: '本月收益',
      total: returnsData?.month_pnl,
      manual: returnsData?.manual?.month_pnl,
      agent: returnsData?.agent?.month_pnl,
    },
    {
      label: '总收益',
      total: returnsData?.total_pnl,
      manual: returnsData?.manual?.total_pnl,
      agent: returnsData?.agent?.total_pnl,
    },
  ];

  const splitSummaryCards = [
    { label: '手动收益', data: summary?.manual, returns: returnsData?.manual, trades: manualTrades },
    { label: 'Agent收益', data: summary?.agent, returns: returnsData?.agent, trades: agentTrades },
  ];

  return (
    <div className="p-4 md:p-8 flex flex-col gap-5 max-w-5xl mx-auto animate-fade-in pb-24 md:pb-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[var(--text-primary)] text-xl md:text-2xl font-bold tracking-tight">收益中心</h1>
          <p className="text-[var(--text-secondary)] text-sm mt-1">收益、Agent KPI、交易记录（本页时间按北京时间）</p>
        </div>
        <button onClick={loadData} className="px-3 py-2 rounded-lg bg-[var(--bg-surface)] text-[var(--text-secondary)] text-sm flex items-center gap-2">
          <RefreshCw size={14} /> 刷新
        </button>
      </div>

      {message && (
        <div className={`rounded-[var(--radius-md)] p-3 text-center text-sm font-medium ${message.includes('失败') ? 'bg-red-500/15 text-red-400' : 'bg-emerald-500/15 text-emerald-400'}`}>
          {message}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {periodCards.map((card) => (
          <div key={card.label} className="card-surface p-4">
            <div className="text-[var(--text-muted)] text-xs">{card.label}</div>
            <div className={`mt-2 text-lg font-bold ${(card.total ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{loading ? '-' : fmtSigned(card.total, 0)}</div>
            <div className="mt-2 flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
              <div className="flex items-center justify-between"><span>手动</span><span className={(card.manual ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}>{fmtSigned(card.manual, 0)}</span></div>
              <div className="flex items-center justify-between"><span>Agent</span><span className={(card.agent ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}>{fmtSigned(card.agent, 0)}</span></div>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1.1fr_0.9fr] gap-5">
        <div className="card-surface p-4">
          <div className="flex items-center gap-2 mb-3">
            <Brain size={16} className="text-[var(--text-muted)]" />
            <span className="text-[var(--text-primary)] text-sm font-bold">A股 Agent 顾问</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-[var(--text-secondary)]">
              本金(万)
              <input value={agentCapital} onChange={(e) => setAgentCapital(e.target.value)} className="mt-1 w-full bg-[var(--bg-elevated)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)]" />
            </label>
            <label className="text-xs text-[var(--text-secondary)]">
              目标收益率(%)
              <input value={agentTargetProfit} onChange={(e) => setAgentTargetProfit(e.target.value)} className="mt-1 w-full bg-[var(--bg-elevated)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)]" />
            </label>
            <label className="text-xs text-[var(--text-secondary)]">
              截止时间
              <input type="datetime-local" value={agentDeadline} onChange={(e) => setAgentDeadline(e.target.value)} className="mt-1 w-full bg-[var(--bg-elevated)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)]" />
            </label>
          </div>
          <div className="flex items-center gap-3 mt-3">
            <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
              <input type="checkbox" checked={!!agentConfig?.enabled} onChange={(e) => setAgentConfig(prev => ({ ...(prev || { enabled: false, capital: 10000000, min_buy_quantity: 10000 }), enabled: e.target.checked }))} />
              开启自动操作（仅A股）
            </label>
            <button onClick={handleSaveAgent} disabled={saving} className="px-3 py-1.5 rounded-full bg-emerald-500/15 text-emerald-400 text-xs font-bold disabled:opacity-50">{saving ? '保存中...' : '保存配置'}</button>
            <button onClick={handleRunAgent} disabled={running} className="px-3 py-1.5 rounded-full bg-blue-500/15 text-blue-400 text-xs font-bold disabled:opacity-50">{running ? '运行中...' : '立即运行'}</button>
          </div>

          {agentStatus && (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-4 text-xs">
              <div className="rounded-lg bg-[var(--bg-elevated)] px-3 py-2"><div className="text-[var(--text-muted)]">目标达成</div><div className="text-[var(--text-primary)] font-bold">{fmt(agentStatus.target_progress_pct, 1)}%</div></div>
              <div className="rounded-lg bg-[var(--bg-elevated)] px-3 py-2"><div className="text-[var(--text-muted)]">选股成功率</div><div className="text-[var(--text-primary)] font-bold">{fmt(agentStatus.auto_pick_success_rate, 1)}%</div></div>
              <div className="rounded-lg bg-[var(--bg-elevated)] px-3 py-2"><div className="text-[var(--text-muted)]">自动交易次数</div><div className="text-[var(--text-primary)] font-bold">{agentStatus.auto_trade_count}</div></div>
              <div className="rounded-lg bg-[var(--bg-elevated)] px-3 py-2"><div className="text-[var(--text-muted)]">本金</div><div className="text-[var(--text-primary)] font-bold">{agentStatus.managed_capital.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div></div>
              <div className="rounded-lg bg-[var(--bg-elevated)] px-3 py-2"><div className="text-[var(--text-muted)]">Agent持仓市值</div><div className="text-[var(--text-primary)] font-bold">{summary?.agent ? summary.agent.total_market_value.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '-'}</div></div>
              <div className="rounded-lg bg-[var(--bg-elevated)] px-3 py-2"><div className="text-[var(--text-muted)]">Agent净收益</div><div className={`font-bold ${agentStatus.managed_net_pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmtSigned(agentStatus.managed_net_pnl, 0)}</div></div>
              <div className="rounded-lg bg-[var(--bg-elevated)] px-3 py-2"><div className="text-[var(--text-muted)]">Agent净收益率</div><div className={`font-bold ${agentStatus.managed_net_return_rate >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmtSigned(agentStatus.managed_net_return_rate, 2)}%</div></div>
              <div className="rounded-lg bg-[var(--bg-elevated)] px-3 py-2"><div className="text-[var(--text-muted)]">平均闭环收益</div><div className={`font-bold ${agentStatus.avg_closed_pick_pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmtSigned(agentStatus.avg_closed_pick_pnl, 0)}</div></div>
              <div className="rounded-lg bg-[var(--bg-elevated)] px-3 py-2"><div className="text-[var(--text-muted)]">平均闭环天数</div><div className="text-[var(--text-primary)] font-bold">{fmt(agentStatus.avg_closed_pick_days, 1)}天</div></div>
              <div className="rounded-lg bg-[var(--bg-elevated)] px-3 py-2"><div className="text-[var(--text-muted)]">最大回撤</div><div className="text-red-400 font-bold">{fmt(agentStatus.max_drawdown_pct, 1)}%</div></div>
              <div className="rounded-lg bg-[var(--bg-elevated)] px-3 py-2"><div className="text-[var(--text-muted)]">闭环成功</div><div className="text-[var(--text-primary)] font-bold">{agentStatus.auto_pick_success_count}/{agentStatus.auto_pick_closed_count}</div></div>
              <div className="rounded-lg bg-[var(--bg-elevated)] px-3 py-2"><div className="text-[var(--text-muted)]">市场范围</div><div className="text-[var(--text-primary)] font-bold">{agentStatus.market_scope}</div></div>
              <div className="rounded-lg bg-[var(--bg-elevated)] px-3 py-2"><div className="text-[var(--text-muted)]">最小买入</div><div className="text-[var(--text-primary)] font-bold">{agentStatus.min_buy_quantity.toLocaleString()}股</div></div>
            </div>
          )}
          {agentStatus && (
            <div className="mt-4 text-xs text-[var(--text-secondary)] flex flex-col gap-1">
              <div>最近状态：{agentStatus.last_status || '-'}</div>
              <div>最近动作：{agentStatus.last_action || '-'}</div>
              <div>最近运行：{fmtTs(agentStatus.last_run_at)}</div>
            </div>
          )}
        </div>

        <div className="card-surface p-4">
          <div className="flex items-center gap-2 mb-3">
            <Wallet size={16} className="text-[var(--text-muted)]" />
            <span className="text-[var(--text-primary)] text-sm font-bold">收益拆分</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            {splitSummaryCards.map((card) => (
              <div key={card.label} className="rounded-lg bg-[var(--bg-elevated)] p-3 flex flex-col gap-2">
                <div className="text-[var(--text-primary)] font-bold">{card.label}</div>
                <div className="flex items-center justify-between"><span className="text-[var(--text-secondary)]">今日 / 本周 / 本月</span><span className="text-[var(--text-primary)] font-bold">{fmtSigned(card.returns?.today_pnl, 0)} / {fmtSigned(card.returns?.week_pnl, 0)} / {fmtSigned(card.returns?.month_pnl, 0)}</span></div>
                <div className="flex items-center justify-between"><span className="text-[var(--text-secondary)]">已实现收益</span><span className={`${(card.data?.realized_pnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'} font-bold`}>{fmtSigned(card.data?.realized_pnl, 0)}</span></div>
                <div className="flex items-center justify-between"><span className="text-[var(--text-secondary)]">未实现收益</span><span className={`${(card.data?.unrealized_pnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'} font-bold`}>{fmtSigned(card.data?.unrealized_pnl, 0)}</span></div>
                <div className="flex items-center justify-between"><span className="text-[var(--text-secondary)]">持仓成本 / 市值</span><span className="text-[var(--text-primary)] font-bold">{card.data ? card.data.total_cost.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '-'} / {card.data ? card.data.total_market_value.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '-'}</span></div>
                <div className="flex items-center justify-between"><span className="text-[var(--text-secondary)]">买入 / 持有金额</span><span className="text-[var(--text-primary)] font-bold">{card.data ? card.data.total_buy_amount.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '-'} / {card.data ? card.data.total_hold_amount.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '-'}</span></div>
                <div className="flex items-center justify-between"><span className="text-[var(--text-secondary)]">交易笔数 / 总收益</span><span className="text-[var(--text-primary)] font-bold">{card.data?.total_trades ?? '-'} / {fmtSigned(card.returns?.total_pnl, 0)}</span></div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card-surface p-4">
        <div className="flex items-center gap-2 mb-3">
            <PiggyBank size={16} className="text-[var(--text-muted)]" />
            <span className="text-[var(--text-primary)] text-sm font-bold">交易记录</span>
          </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {[
            { label: '手动交易', items: manualTrades },
            { label: 'Agent交易', items: agentTrades },
          ].map((group) => (
            <div key={group.label} className="flex flex-col gap-2">
              <div className="text-[var(--text-primary)] text-sm font-bold">{group.label}</div>
              {group.items.length === 0 && <div className="text-[var(--text-secondary)] text-sm">暂无{group.label}</div>}
              {group.items.slice(0, 50).map((t) => (
                <div key={t.id} className="flex items-center justify-between rounded-lg bg-[var(--bg-elevated)] px-3 py-2 text-xs">
                  <div className="min-w-0">
                    <div className="text-[var(--text-primary)] font-bold truncate">{t.name || t.symbol || t.position_id}</div>
                    <div className="text-[var(--text-muted)]">{t.market || '-'} · {sourceLabel(t.source)} · {fmtTs(t.created_at)}</div>
                  </div>
                  <div className="text-right shrink-0 ml-3">
                    <div className={`font-bold ${t.side === 'BUY' ? 'text-emerald-400' : 'text-red-400'}`}>{t.side === 'BUY' ? '买入' : '卖出'} {fmt(t.price)}</div>
                    <div className="text-[var(--text-secondary)]">{t.quantity.toLocaleString()}股 · {t.amount.toLocaleString(undefined, { maximumFractionDigits: 0 })} · 手续费 {t.fee.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
