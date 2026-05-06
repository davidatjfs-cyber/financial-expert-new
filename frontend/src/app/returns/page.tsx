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
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [trades, setTrades] = useState<PortfolioTrade[]>([]);
  const [summary, setSummary] = useState<PortfolioSummary | null>(null);
  const [returnsData, setReturnsData] = useState<PortfolioReturns | null>(null);
  const [agentConfig, setAgentConfig] = useState<PortfolioAgentConfig | null>(null);
  const [agentStatus, setAgentStatus] = useState<PortfolioAgentStatus | null>(null);
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
  const fmtTs = (ts?: number | null) => (ts ? new Date(ts * 1000).toLocaleString() : '-');

  const loadData = async () => {
    try {
      const [ts, sm, rt, ac, as] = await Promise.all([
        getPortfolioTrades(undefined, 100),
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
      setAgentTargetProfit(ac.target_profit != null ? String(ac.target_profit) : '');
      setAgentDeadline(ac.deadline_ts ? new Date(ac.deadline_ts * 1000).toISOString().slice(0, 16) : '');
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
      const deadlineTs = agentDeadline ? Math.floor(new Date(agentDeadline).getTime() / 1000) : null;
      const targetProfit = agentTargetProfit.trim() ? Number(agentTargetProfit) : null;
      await updatePortfolioAgentConfig({
        enabled: !!agentConfig?.enabled,
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

  return (
    <div className="p-4 md:p-8 flex flex-col gap-5 max-w-5xl mx-auto animate-fade-in pb-24 md:pb-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[var(--text-primary)] text-xl md:text-2xl font-bold tracking-tight">收益中心</h1>
          <p className="text-[var(--text-secondary)] text-sm mt-1">收益、Agent KPI、交易记录</p>
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
        <div className="card-surface p-4">
          <div className="text-[var(--text-muted)] text-xs">今日收益</div>
          <div className={`mt-2 text-lg font-bold ${(returnsData?.today_pnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{loading ? '-' : fmtSigned(returnsData?.today_pnl, 0)}</div>
        </div>
        <div className="card-surface p-4">
          <div className="text-[var(--text-muted)] text-xs">本周收益</div>
          <div className={`mt-2 text-lg font-bold ${(returnsData?.week_pnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{loading ? '-' : fmtSigned(returnsData?.week_pnl, 0)}</div>
        </div>
        <div className="card-surface p-4">
          <div className="text-[var(--text-muted)] text-xs">本月收益</div>
          <div className={`mt-2 text-lg font-bold ${(returnsData?.month_pnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{loading ? '-' : fmtSigned(returnsData?.month_pnl, 0)}</div>
        </div>
        <div className="card-surface p-4">
          <div className="text-[var(--text-muted)] text-xs">总收益</div>
          <div className={`mt-2 text-lg font-bold ${(returnsData?.total_pnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{loading ? '-' : fmtSigned(returnsData?.total_pnl, 0)}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1.1fr_0.9fr] gap-5">
        <div className="card-surface p-4">
          <div className="flex items-center gap-2 mb-3">
            <Brain size={16} className="text-[var(--text-muted)]" />
            <span className="text-[var(--text-primary)] text-sm font-bold">A股 Agent 顾问</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
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
              <input type="checkbox" checked={!!agentConfig?.enabled} onChange={(e) => setAgentConfig(prev => ({ ...(prev || { enabled: false, min_buy_quantity: 10000 }), enabled: e.target.checked }))} />
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
              <div className="rounded-lg bg-[var(--bg-elevated)] px-3 py-2"><div className="text-[var(--text-muted)]">管理资金</div><div className="text-[var(--text-primary)] font-bold">{agentStatus.managed_capital.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div></div>
              <div className="rounded-lg bg-[var(--bg-elevated)] px-3 py-2"><div className="text-[var(--text-muted)]">Agent净收益</div><div className={`font-bold ${agentStatus.managed_net_pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmtSigned(agentStatus.managed_net_pnl, 0)}</div></div>
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
          <div className="flex flex-col gap-3 text-sm">
            <div className="flex items-center justify-between"><span className="text-[var(--text-secondary)]">已实现收益</span><span className={`${(summary?.realized_pnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'} font-bold`}>{fmtSigned(summary?.realized_pnl, 0)}</span></div>
            <div className="flex items-center justify-between"><span className="text-[var(--text-secondary)]">未实现收益</span><span className={`${(summary?.unrealized_pnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'} font-bold`}>{fmtSigned(summary?.unrealized_pnl, 0)}</span></div>
            <div className="flex items-center justify-between"><span className="text-[var(--text-secondary)]">总买入金额</span><span className="text-[var(--text-primary)] font-bold">{summary ? summary.total_buy_amount.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '-'}</span></div>
            <div className="flex items-center justify-between"><span className="text-[var(--text-secondary)]">总卖出金额</span><span className="text-[var(--text-primary)] font-bold">{summary ? summary.total_sell_amount.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '-'}</span></div>
            <div className="flex items-center justify-between"><span className="text-[var(--text-secondary)]">交易总笔数</span><span className="text-[var(--text-primary)] font-bold">{summary?.total_trades ?? '-'}</span></div>
          </div>
        </div>
      </div>

      <div className="card-surface p-4">
        <div className="flex items-center gap-2 mb-3">
          <PiggyBank size={16} className="text-[var(--text-muted)]" />
          <span className="text-[var(--text-primary)] text-sm font-bold">交易记录</span>
        </div>
        <div className="flex flex-col gap-2">
          {trades.length === 0 && <div className="text-[var(--text-secondary)] text-sm">暂无交易记录</div>}
          {trades.slice(0, 50).map((t) => (
            <div key={t.id} className="flex items-center justify-between rounded-lg bg-[var(--bg-elevated)] px-3 py-2 text-xs">
              <div className="min-w-0">
                <div className="text-[var(--text-primary)] font-bold truncate">{t.name || t.symbol || t.position_id}</div>
                <div className="text-[var(--text-muted)]">{t.market || '-'} · {t.source === 'auto_strategy' ? 'Agent策略' : t.source === 'auto_order' ? '委托自动' : '手动'} · {fmtTs(t.created_at)}</div>
              </div>
              <div className="text-right shrink-0 ml-3">
                <div className={`font-bold ${t.side === 'BUY' ? 'text-emerald-400' : 'text-red-400'}`}>{t.side === 'BUY' ? '买入' : '卖出'} {fmt(t.price)}</div>
                <div className="text-[var(--text-secondary)]">{t.quantity.toLocaleString()}股 · {t.amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
