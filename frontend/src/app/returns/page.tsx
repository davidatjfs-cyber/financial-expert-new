'use client';

import { useEffect, useState } from 'react';
import { Brain, PiggyBank, Wallet, RefreshCw, CircleHelp } from 'lucide-react';
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
  const [activeAgent, setActiveAgent] = useState<'a' | 'b'>('a');
  const [agentConfigs, setAgentConfigs] = useState<Record<string, PortfolioAgentConfig>>({});
  const [agentStatuses, setAgentStatuses] = useState<Record<string, PortfolioAgentStatus>>({});
  const [agentCapital, setAgentCapital] = useState('10000000');
  const [agentTargetProfit, setAgentTargetProfit] = useState('');
  const [agentDeadline, setAgentDeadline] = useState('');
  const [openMetricTip, setOpenMetricTip] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  const agentConfig = agentConfigs[activeAgent] ?? null;
  const agentStatus = agentStatuses[activeAgent] ?? null;

  const fmt = (v: number | null | undefined, digits = 2) => (v == null ? '-' : v.toFixed(digits));
  const fmtSigned = (v: number | null | undefined, digits = 2) => {
    if (v == null) return '-';
    const s = v.toFixed(digits);
    return v > 0 ? `+${s}` : s;
  };
  const pnlColor = (v: number | null | undefined) => (v == null ? 'text-[var(--text-secondary)]' : v >= 0 ? 'text-emerald-400' : 'text-red-400');
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
  const sourceLabel = (source: PortfolioTrade['source']) => source === 'manual' ? '手动' : source === 'auto_strategy' || source === 'auto_strategy_a' ? 'Agent A' : source === 'auto_strategy_b' ? 'Agent B' : '委托自动';
  const sourceGroup = (source: PortfolioTrade['source']) => {
    if (source === 'manual') return 'manual';
    if (source === 'auto_strategy_b') return 'agent_b';
    return 'agent_a';
  };
  const renderMetricLabel = (label: string, tip: string) => (
    <div className="relative flex items-center gap-1 text-[var(--text-muted)]">
      <span>{label}</span>
      <button
        type="button"
        aria-label={`${label}说明`}
        title={tip}
        onClick={() => setOpenMetricTip((prev) => prev === label ? null : label)}
        className="inline-flex h-3.5 w-3.5 items-center justify-center text-[var(--text-muted)]/80"
      >
        <CircleHelp size={12} />
      </button>
      {openMetricTip === label && (
        <div className="absolute left-0 top-5 z-20 w-44 rounded-md border border-[var(--border-color)] bg-[var(--bg-surface)] p-2 text-[11px] leading-4 text-[var(--text-secondary)] shadow-lg">
          {tip}
        </div>
      )}
    </div>
  );

  const loadData = async () => {
    try {
      const [ts, sm, rt, acA, asA, acB, asB] = await Promise.all([
        getPortfolioTrades(undefined, 200),
        getPortfolioSummary(),
        getPortfolioReturns(),
        getPortfolioAgentConfig('a'),
        getPortfolioAgentStatus('a'),
        getPortfolioAgentConfig('b'),
        getPortfolioAgentStatus('b'),
      ]);
      setTrades(ts);
      setSummary(sm);
      setReturnsData(rt);
      setAgentConfigs({ a: acA, b: acB });
      setAgentStatuses({ a: asA, b: asB });
    } finally {
      setLoading(false);
    }
  };

  const syncFormFromConfig = (id: 'a' | 'b') => {
    const cfg = agentConfigs[id];
    if (cfg) {
      setAgentCapital(cfg.capital != null ? String(cfg.capital) : '10000000');
      setAgentTargetProfit(cfg.target_profit != null ? String(cfg.target_profit) : '');
      setAgentDeadline(fmtShanghaiInput(cfg.deadline_ts));
    }
  };

  useEffect(() => {
    loadData();
    const timer = setInterval(loadData, 30000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    syncFormFromConfig(activeAgent);
  }, [activeAgent, agentConfigs]);

  const handleSaveAgent = async () => {
    try {
      setSaving(true);
      const deadlineTs = parseShanghaiInput(agentDeadline);
      const targetProfit = agentTargetProfit.trim() ? Number(agentTargetProfit) : null;
      await updatePortfolioAgentConfig({
        agent_id: activeAgent,
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
      const resp = await runPortfolioAgentNow(activeAgent);
      await loadData();
      setMessage(`Agent ${activeAgent.toUpperCase()} 运行完成：${resp.message}`);
    } catch {
      setMessage('Agent 运行失败');
    } finally {
      setRunning(false);
      setTimeout(() => setMessage(null), 3000);
    }
  };

  const manualTrades = trades.filter((trade) => sourceGroup(trade.source) === 'manual');
  const periodCards = [
    {
      label: '今日收益',
      total: returnsData?.today_pnl,
      manual: returnsData?.manual?.today_pnl,
      agent_a: returnsData?.agent_a?.today_pnl,
      agent_b: returnsData?.agent_b?.today_pnl,
    },
    {
      label: '本周收益',
      total: returnsData?.week_pnl,
      manual: returnsData?.manual?.week_pnl,
      agent_a: returnsData?.agent_a?.week_pnl,
      agent_b: returnsData?.agent_b?.week_pnl,
    },
    {
      label: '本月收益',
      total: returnsData?.month_pnl,
      manual: returnsData?.manual?.month_pnl,
      agent_a: returnsData?.agent_a?.month_pnl,
      agent_b: returnsData?.agent_b?.month_pnl,
    },
    {
      label: '总收益',
      total: returnsData?.total_pnl,
      manual: returnsData?.manual?.total_pnl,
      agent_a: returnsData?.agent_a?.total_pnl,
      agent_b: returnsData?.agent_b?.total_pnl,
    },
  ];

  const splitSummaryCards = [
    { label: '手动收益', data: summary?.manual, returns: returnsData?.manual, trades: manualTrades },
    { label: 'Agent A', data: summary?.agent_a, returns: returnsData?.agent_a, trades: trades.filter((t) => sourceGroup(t.source) === 'agent_a') },
    { label: 'Agent B', data: summary?.agent_b, returns: returnsData?.agent_b, trades: trades.filter((t) => sourceGroup(t.source) === 'agent_b') },
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
              <div className="flex items-center justify-between"><span>Agent A</span><span className={(card.agent_a ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}>{fmtSigned(card.agent_a, 0)}</span></div>
              <div className="flex items-center justify-between"><span>Agent B</span><span className={(card.agent_b ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}>{fmtSigned(card.agent_b, 0)}</span></div>
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

          <div className="flex gap-1 mb-3">
            {(['a', 'b'] as const).map((id) => (
              <button
                key={id}
                onClick={() => setActiveAgent(id)}
                className={`px-3 py-1.5 rounded-full text-xs font-bold transition-colors ${activeAgent === id ? 'bg-blue-500/20 text-blue-400' : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)]'}`}
              >
                Agent {id.toUpperCase()} ({agentConfigs[id] ? (agentConfigs[id].enabled ? (agentStatuses[id]?.agent_type === 'llm' ? 'LLM·开' : '规则·开') : '关') : '?'})
              </button>
            ))}
          </div>

          <div className="text-xs text-[var(--text-muted)] mb-2">
            类型：{agentStatus?.agent_type === 'llm' ? 'LLM智能决策' : '规则策略'} · {activeAgent === 'a' ? '基于技术指标规则自动交易' : '基于LLM分析持仓和告警做买卖决策'}
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
              <input type="checkbox" checked={!!agentConfig?.enabled} onChange={(e) => setAgentConfigs(prev => ({ ...prev, [activeAgent]: { ...(prev[activeAgent] || { agent_id: activeAgent, enabled: false, capital: 10000000, min_buy_quantity: 10000 }), enabled: e.target.checked } }))} />
              开启自动操作（仅A股）
            </label>
            <button onClick={handleSaveAgent} disabled={saving} className="px-3 py-1.5 rounded-full bg-emerald-500/15 text-emerald-400 text-xs font-bold disabled:opacity-50">{saving ? '保存中...' : '保存配置'}</button>
            <button onClick={handleRunAgent} disabled={running} className="px-3 py-1.5 rounded-full bg-blue-500/15 text-blue-400 text-xs font-bold disabled:opacity-50">{running ? '运行中...' : `运行 Agent ${activeAgent.toUpperCase()}`}</button>
          </div>

          {agentStatus && (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-4 text-xs">
              <div className="rounded-lg bg-[var(--bg-elevated)] px-3 py-2"><div>{renderMetricLabel('目标达成', '当前净收益相对目标收益率的完成进度。达到100%表示命中目标。')}</div><div className="text-[var(--text-primary)] font-bold">{fmt(agentStatus.target_progress_pct, 1)}%</div></div>
              <div className="rounded-lg bg-[var(--bg-elevated)] px-3 py-2"><div>{renderMetricLabel('选股成功率', '已完成闭环的选股中，盈利次数占闭环总次数的比例。')}</div><div className="text-[var(--text-primary)] font-bold">{fmt(agentStatus.auto_pick_success_rate, 1)}%</div></div>
              <div className="rounded-lg bg-[var(--bg-elevated)] px-3 py-2"><div>{renderMetricLabel('自动交易次数', '该 Agent 已执行的自动买入和卖出总笔数。')}</div><div className="text-[var(--text-primary)] font-bold">{agentStatus.auto_trade_count}</div></div>
              <div className="rounded-lg bg-[var(--bg-elevated)] px-3 py-2"><div>{renderMetricLabel('本金', '分配给该 Agent 的虚拟管理本金。当前默认按1000万计算。')}</div><div className="text-[var(--text-primary)] font-bold">{agentStatus.managed_capital.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div></div>
              <div className="rounded-lg bg-[var(--bg-elevated)] px-3 py-2"><div>{renderMetricLabel('资金使用效率', '最近一个月累计买入金额 / 1000万。用于衡量资金周转和使用强度。')}</div><div className="text-[var(--text-primary)] font-bold">{fmt(agentStatus.capital_utilization_pct, 1)}%</div></div>
              <div className="rounded-lg bg-[var(--bg-elevated)] px-3 py-2"><div>{renderMetricLabel('持仓市值', '当前仍由该 Agent 管理的持仓市值。')}</div><div className="text-[var(--text-primary)] font-bold">{agentStatus.managed_unrealized_pnl !== 0 ? (agentStatus.managed_capital + agentStatus.managed_unrealized_pnl).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '-'}</div></div>
              <div className="rounded-lg bg-[var(--bg-elevated)] px-3 py-2"><div>{renderMetricLabel('净收益', '该 Agent 的已实现收益 + 未实现收益，已扣手续费。')}</div><div className={`font-bold ${agentStatus.managed_net_pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmtSigned(agentStatus.managed_net_pnl, 0)}</div></div>
              <div className="rounded-lg bg-[var(--bg-elevated)] px-3 py-2"><div>{renderMetricLabel('净收益率', '该 Agent 的净收益 / 本金。用于看资金回报率。')}</div><div className={`font-bold ${agentStatus.managed_net_return_rate >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmtSigned(agentStatus.managed_net_return_rate, 2)}%</div></div>
              <div className="rounded-lg bg-[var(--bg-elevated)] px-3 py-2"><div>{renderMetricLabel('平均闭环收益', '已完整闭环的选股，从买入到全部卖出后，平均每笔净盈亏金额。')}</div><div className={`font-bold ${agentStatus.avg_closed_pick_pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmtSigned(agentStatus.avg_closed_pick_pnl, 0)}</div></div>
              <div className="rounded-lg bg-[var(--bg-elevated)] px-3 py-2"><div>{renderMetricLabel('平均闭环天数', '已完整闭环的选股，从首次买入到全部卖出的平均持有天数。')}</div><div className="text-[var(--text-primary)] font-bold">{fmt(agentStatus.avg_closed_pick_days, 1)}天</div></div>
              <div className="rounded-lg bg-[var(--bg-elevated)] px-3 py-2"><div>{renderMetricLabel('最大回撤', '该 Agent 收益曲线从历史最高点回落到后续最低点的最大跌幅。越低越稳。')}</div><div className="text-red-400 font-bold">{fmt(agentStatus.max_drawdown_pct, 1)}%</div></div>
              <div className="rounded-lg bg-[var(--bg-elevated)] px-3 py-2"><div>{renderMetricLabel('闭环成功', '盈利的闭环次数 / 总闭环次数。闭环指一只票从买入到全部卖出归零。')}</div><div className="text-[var(--text-primary)] font-bold">{agentStatus.auto_pick_success_count}/{agentStatus.auto_pick_closed_count}</div></div>
              <div className="rounded-lg bg-[var(--bg-elevated)] px-3 py-2"><div>{renderMetricLabel('市场范围', '该 Agent 当前允许交易的市场范围。')}</div><div className="text-[var(--text-primary)] font-bold">{agentStatus.market_scope}</div></div>
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
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
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
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {[
            { label: '手动交易', items: manualTrades },
            { label: 'Agent A 交易', items: trades.filter((t) => sourceGroup(t.source) === 'agent_a') },
            { label: 'Agent B 交易', items: trades.filter((t) => sourceGroup(t.source) === 'agent_b') },
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
                    <div className={`${pnlColor(t.realized_pnl)} text-[11px]`}>单笔盈亏 {t.realized_pnl == null ? '-' : fmtSigned(t.realized_pnl, 0)}</div>
                    <div className={`${pnlColor(t.cumulative_realized_pnl)} text-[11px]`}>累计已实现 {t.cumulative_realized_pnl == null ? '-' : fmtSigned(t.cumulative_realized_pnl, 0)}</div>
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
