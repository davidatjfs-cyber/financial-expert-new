'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, FileText, TrendingUp, AlertTriangle, Lightbulb, Brain, Download, ChevronDown, ChevronRight, ArrowUpRight, ArrowDownRight, Minus, ShieldCheck, Zap, Target, Gauge, BarChart3, Activity, Wallet, Castle } from 'lucide-react';
import { getReportDetail, getReportMetrics, getReportAlerts, getReportCompanyHistory, getReports, reanalyzeReport, type ReportDetail, type Metric, type Alert } from '@/services/api';
import { computeEnterpriseRating } from '@/services/ratingEngine';

type TabType = 'overview' | 'metrics' | 'risks' | 'opportunities' | 'insights';

export default function ReportDetailPage() {
  const params = useParams();
  const router = useRouter();
  const reportId = params.id as string;

  const [report, setReport] = useState<ReportDetail | null>(null);
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const [reanalyzing, setReanalyzing] = useState(false);
  const [pollTick, setPollTick] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [downloadTip, setDownloadTip] = useState<string | null>(null);
  const [industryAvg, setIndustryAvg] = useState({ grossMargin: 32, netMargin: 10, roe: 13, roa: 6, currentRatio: 1.5, debtRatio: 55, assetTurnover: 0.7 });
  const [industryLabel, setIndustryLabel] = useState<string>('');
  const [prevMetricMap, setPrevMetricMap] = useState<Record<string, number | null>>({});
  const [prevPeriod, setPrevPeriod] = useState<string>('');
  const [companyHistory, setCompanyHistory] = useState<string>('');
  const [companyHistorySource, setCompanyHistorySource] = useState<string>('');
  const [companyWebsite, setCompanyWebsite] = useState<string>('');
  const [metricsPeriod, setMetricsPeriod] = useState<string>('');
  const [showAllMetrics, setShowAllMetrics] = useState(false);

  async function fetchData() {
      try {
        const [reportData, metricsData, alertsData] = await Promise.all([
          getReportDetail(reportId),
          getReportMetrics(reportId),
          getReportAlerts(reportId),
        ]);
        setReport(reportData);
        setMetrics(metricsData);
        setAlerts(alertsData);

        // Fetch company history from official website extraction endpoint
        try {
          const historyData = await getReportCompanyHistory(reportId);
          setCompanyHistory(historyData.history_text || '');
          setCompanyHistorySource(historyData.source_url || '');
          setCompanyWebsite(historyData.website || '');
        } catch {
          setCompanyHistory('');
          setCompanyHistorySource('');
          setCompanyWebsite('');
        }

        // Fetch previous-year/same-company metrics for YoY comparison
        try {
          const normName = (s?: string) => {
            let x = (s || '').trim();
            x = x.replace(/[（(].*?[）)]/g, '');
            x = x.replace(/\s*\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?\s*$/, '');
            x = x.replace(/\s*(年报|季报|中报|财报)\s*$/, '');
            x = x.replace(/\s+/g, '');
            return x.toLowerCase();
          };
          const currentNormName = normName(reportData.report_name);
          const list = await getReports(1000, 'done');

          const prevCandidates = (list || [])
            .filter((x) => {
              if (!x || x.id === reportId) return false;
              if ((x.period_end || '') >= (reportData.period_end || '')) return false;
              const sameByCompanyId = !!(reportData.company_id && x.company_id && x.company_id === reportData.company_id);
              const sameByName = normName(x.report_name) === currentNormName;
              return sameByCompanyId || sameByName;
            })
            .sort((a, b) => (b.period_end || '').localeCompare(a.period_end || ''));

          const buildMetricMap = (arr: Metric[]) => {
            const m: Record<string, number | null> = {};
            arr.forEach((it) => {
              m[it.metric_code] = it.value == null ? null : Number(it.value);
            });
            return m;
          };

          const periodsInCurrent = Array.from(new Set((metricsData || []).map((m) => m.period_end).filter(Boolean))).sort();
          const prevPeriodInCurrent = periodsInCurrent.filter((p) => p < (reportData.period_end || '')).slice(-1)[0] || '';

          const pickPeriod = (periods: string[], target: string) => {
            if (!periods.length) return '';
            try {
              const targetDt = new Date(target);
              if (!Number.isNaN(targetDt.getTime())) {
                const yoyCutoff = new Date(targetDt);
                yoyCutoff.setMonth(yoyCutoff.getMonth() - 11);
                const yoyCandidates = periods.filter((p) => {
                  const d = new Date(p);
                  return !Number.isNaN(d.getTime()) && d < targetDt && d <= yoyCutoff;
                });
                if (yoyCandidates.length > 0) return yoyCandidates[yoyCandidates.length - 1] || '';
              }
            } catch {
              // ignore and fallback below
            }
            const prev = periods.filter((p) => p < target).slice(-1)[0];
            if (prev) return prev;
            return periods[periods.length - 1] || '';
          };

          let targetPrevPeriod = '';
          let pm: Record<string, number | null> = {};

          for (const prev of prevCandidates) {
            if (!prev?.id) continue;
            const prevMetrics = await getReportMetrics(prev.id);
            if (!prevMetrics || prevMetrics.length === 0) continue;
            const periods = Array.from(new Set(prevMetrics.map((m) => m.period_end).filter(Boolean))).sort();
            const preferredPeriod = pickPeriod(periods, reportData.period_end || '');
            const scoped = preferredPeriod
              ? prevMetrics.filter((m) => m.period_end === preferredPeriod)
              : prevMetrics;
            const candidateMap = buildMetricMap(scoped.length > 0 ? scoped : prevMetrics);
            if (Object.keys(candidateMap).length > 0) {
              pm = candidateMap;
              targetPrevPeriod = preferredPeriod || prev.period_end || '';
              break;
            }
          }

          // Fallback to previous period within the same report when historical report is unavailable or empty.
          if (Object.keys(pm).length === 0 && prevPeriodInCurrent) {
            targetPrevPeriod = prevPeriodInCurrent;
            const sameReportPrev = metricsData.filter((m) => m.period_end === targetPrevPeriod);
            pm = buildMetricMap(sameReportPrev);
          }

          setPrevMetricMap(pm);
          setPrevPeriod(targetPrevPeriod);
        } catch {
          setPrevMetricMap({});
          setPrevPeriod('');
        }

        // Fetch industry benchmarks
        try {
          const benchResp = await fetch(`/api/reports/${encodeURIComponent(reportId)}/industry-benchmarks`);
          if (benchResp.ok) {
            const benchData = await benchResp.json();
            if (benchData.benchmarks) {
              setIndustryAvg(prev => ({
                grossMargin: benchData.benchmarks.grossMargin ?? prev.grossMargin,
                netMargin: benchData.benchmarks.netMargin ?? prev.netMargin,
                roe: benchData.benchmarks.roe ?? prev.roe,
                roa: benchData.benchmarks.roa ?? prev.roa,
                currentRatio: benchData.benchmarks.currentRatio ?? prev.currentRatio,
                debtRatio: benchData.benchmarks.debtRatio ?? prev.debtRatio,
                assetTurnover: benchData.benchmarks.assetTurnover ?? prev.assetTurnover,
              }));
            }
            if (benchData.industry) setIndustryLabel(benchData.industry);
          }
        } catch { /* ignore */ }
      } catch (error) {
        console.error('Failed to fetch report:', error);
      } finally {
        setLoading(false);
      }
  }

  useEffect(() => {
    if (reportId) {
      fetchData();
    }
  }, [reportId]);

  useEffect(() => {
    if (!reportId) return;
    if (!report) return;
    if (report.status !== 'running' && report.status !== 'pending') return;
    const t = setInterval(() => {
      setPollTick((x) => x + 1);
    }, 2500);
    return () => clearInterval(t);
  }, [reportId, report?.status]);

  useEffect(() => {
    if (!reportId) return;
    if (!report) return;
    if (report.status !== 'running' && report.status !== 'pending') return;
    fetchData();
  }, [pollTick]);

  const handleReanalyze = async () => {
    if (!reportId) return;
    setReanalyzing(true);
    try {
      await reanalyzeReport(reportId);
      setLoading(true);
      await fetchData();
    } catch (e) {
      console.error('Reanalyze failed:', e);
    } finally {
      setReanalyzing(false);
    }
  };

  const handleExportPdf = async () => {
    if (!reportId) return;
    setExporting(true);
    try {
      const resp = await fetch(`/api/reports/${encodeURIComponent(reportId)}/export/pdf`);
      if (!resp.ok) {
        throw new Error(`export_failed_${resp.status}`);
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safeName = (report?.report_name || 'report').replace(/[/\\]/g, '-');
      const period = report?.period_end || 'period';
      a.download = `${safeName}-${period}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();

      const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
      let tip = '已开始下载：请在浏览器的“下载”中查看文件';
      if (/MicroMessenger/i.test(ua)) {
        tip = '已开始下载：微信内置浏览器可能不显示下载记录，建议右上角菜单选择“在浏览器打开”后再下载';
      } else if (/iPhone|iPad|iPod/i.test(ua)) {
        tip = '已开始下载：请到“文件 App → 下载项”或 Safari 下载列表中查找';
      } else if (/Android/i.test(ua)) {
        tip = '已开始下载：请到“下载(Download)”文件夹或浏览器下载列表中查找';
      }
      setDownloadTip(tip);
      setTimeout(() => setDownloadTip(null), 8000);

      if (/MicroMessenger/i.test(ua) || /iPhone|iPad|iPod/i.test(ua)) {
        try {
          window.open(url, '_blank', 'noopener,noreferrer');
        } catch {
          // ignore
        }
      }

      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Export PDF failed:', e);
    } finally {
      setExporting(false);
    }
  };

  const statusConfig = {
    done: { bg: 'bg-emerald-500/15', text: 'text-emerald-400', label: '已完成' },
    running: { bg: 'bg-amber-500/15', text: 'text-amber-400', label: '分析中' },
    failed: { bg: 'bg-red-500/15', text: 'text-red-400', label: '失败' },
    pending: { bg: 'bg-zinc-500/15', text: 'text-zinc-400', label: '待识别' },
  };

  const tabs: { key: TabType; label: string }[] = [
    { key: 'overview', label: '概览' },
    { key: 'metrics', label: '财务指标' },
    { key: 'risks', label: '风险分析' },
    { key: 'opportunities', label: '机会识别' },
    { key: 'insights', label: 'AI 洞察' },
  ];

  const formatDateTime = (tsSeconds: number) => {
    const d = new Date(tsSeconds * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  if (loading) {
    return (
      <div className="p-5 md:p-8 flex flex-col gap-6 max-w-2xl mx-auto">
        <div className="card-surface p-10 text-center">
          <p className="text-[var(--text-secondary)] text-base">加载中...</p>
        </div>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="p-5 md:p-8 flex flex-col gap-6 max-w-2xl mx-auto">
        <div className="card-surface p-10 text-center">
          <p className="text-[var(--text-secondary)] text-base">报告不存在</p>
          <button
            onClick={() => router.back()}
            className="mt-4 text-[var(--accent-primary)]"
          >
            返回
          </button>
        </div>
      </div>
    );
  }

  const status = statusConfig[report.status as keyof typeof statusConfig] || statusConfig.pending;

  // 计算关键指标
  const latestMetrics = metrics.filter(m => m.period_end === report.period_end);
  const metricByCodes = (codes: string[]) => latestMetrics.find(m => codes.includes(m.metric_code));
  const grossMargin = metricByCodes(['GROSS_MARGIN']);
  const netMargin = metricByCodes(['NET_MARGIN']);
  const roe = metricByCodes(['ROE']);
  const roa = metricByCodes(['ROA']);
  const currentRatio = metricByCodes(['CURRENT_RATIO']);
  const debtRatio = metricByCodes(['DEBT_ASSET']);
  const quickRatio = metricByCodes(['QUICK_RATIO']);
  const assetTurnover = metricByCodes(['ASSET_TURNOVER']);
  const inventoryTurnover = metricByCodes(['INVENTORY_TURNOVER']);
  const receivableTurnover = metricByCodes(['RECEIVABLE_TURNOVER']);
  const totalRevenue = metricByCodes(['TOTAL_REVENUE', 'IS.REVENUE']);
  const operatingCashFlow = metricByCodes(['OPERATING_CASH_FLOW', 'CF.CFO']);

  // industryAvg is now fetched from API (see state + fetchData above)

  const prevValueByCodes = (codes: string[]): number | null => {
    for (const code of codes) {
      const v = prevMetricMap[code];
      if (v != null && !Number.isNaN(v)) return Number(v);
    }
    return null;
  };

  const compareYoY = (current: number | null | undefined, prev: number | null | undefined) => {
    if (current == null || prev == null || Number(prev) === 0) return { diff: 0, status: 'neutral' as const, hasValue: false };
    const diff = ((Number(current) - Number(prev)) / Math.abs(Number(prev))) * 100;
    return {
      diff,
      status: diff > 8 ? 'good' as const : diff < -8 ? 'bad' as const : 'neutral' as const,
      hasValue: true,
    };
  };

  const metricValue = (m?: Metric | undefined) => (m?.value == null ? null : m.value);
  const fmtMetric = (v: number | null | undefined, digits = 2) => (v == null ? '-' : v.toFixed(digits));

  const enterpriseRating = computeEnterpriseRating({
    net_margin: metricValue(netMargin),
    gross_margin: metricValue(grossMargin),
    roe: metricValue(roe),
    roa: metricValue(roa),
    debt_ratio: metricValue(debtRatio),
    current_ratio: metricValue(currentRatio),
    asset_turnover: metricValue(assetTurnover),
    inventory_turnover: metricValue(inventoryTurnover),
    receivable_turnover: metricValue(receivableTurnover),
    operating_cash_flow: metricValue(operatingCashFlow),
  });
  const diffBadge = (cmp: { diff: number; status: 'good' | 'bad' | 'neutral' }, betterWhen: 'higher' | 'lower' = 'higher') => {
    let status = cmp.status;
    if (betterWhen === 'lower') {
      status = cmp.status === 'good' ? 'bad' : (cmp.status === 'bad' ? 'good' : 'neutral');
    }
    const cls = status === 'good'
      ? 'bg-emerald-500/15 text-emerald-400'
      : status === 'bad'
        ? 'bg-red-500/15 text-red-400'
        : 'bg-zinc-500/15 text-zinc-400';
    const sign = cmp.diff > 0 ? '+' : '';
    return <span className={`text-xs px-2 py-1 rounded ${cls}`}>{sign}{cmp.diff.toFixed(1)}%</span>;
  };

  const fmtAmount = (v: number | null | undefined) => {
    if (v == null || Number.isNaN(v)) return '-';
    const absV = Math.abs(v);
    if (absV >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
    if (absV >= 1e4) return `${(v / 1e4).toFixed(2)}万`;
    return v.toFixed(2);
  };

  const prevRevenue = prevValueByCodes(['TOTAL_REVENUE', 'IS.REVENUE']);
  const prevOperatingCashFlow = prevValueByCodes(['OPERATING_CASH_FLOW', 'CF.CFO']);
  const prevGrossMargin = prevValueByCodes(['GROSS_MARGIN']);
  const prevNetMargin = prevValueByCodes(['NET_MARGIN']);
  const prevRoe = prevValueByCodes(['ROE']);
  const prevRoa = prevValueByCodes(['ROA']);
  const prevCurrentRatio = prevValueByCodes(['CURRENT_RATIO']);
  const prevQuickRatio = prevValueByCodes(['QUICK_RATIO']);
  const prevDebtRatio = prevValueByCodes(['DEBT_ASSET']);
  const prevAssetTurnover = prevValueByCodes(['ASSET_TURNOVER']);
  const prevInventoryTurnover = prevValueByCodes(['INVENTORY_TURNOVER']);
  const prevReceivableTurnover = prevValueByCodes(['RECEIVABLE_TURNOVER']);

  return (
    <div className="p-4 md:p-6 flex flex-col gap-4 max-w-2xl mx-auto pb-4 animate-fade-in">
      {/* Header with Back Button */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => router.back()}
          className="w-10 h-10 rounded-[var(--radius-md)] bg-[var(--bg-surface)] border border-[var(--border-color)] flex items-center justify-center flex-shrink-0"
        >
          <ArrowLeft size={20} className="text-[var(--text-primary)]" />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-[var(--text-primary)] text-lg font-bold tracking-tight truncate">{report.report_name}</h1>
          <p className="text-[var(--text-secondary)] text-sm">
            {report.source_type === 'market_fetch' ? '市场数据' : '文件上传'} · {formatDateTime(report.created_at)}
          </p>
        </div>
        <button
          onClick={handleExportPdf}
          disabled={exporting}
          className="btn-secondary h-10 px-3.5 text-sm !min-h-0 !py-0 flex items-center gap-2 disabled:opacity-50"
        >
          <Download size={16} />
          {exporting ? '导出中...' : '导出 PDF'}
        </button>
      </div>

      {downloadTip && (
        <div className="bg-indigo-500/10 rounded-[var(--radius-md)] p-3 border border-indigo-500/25 text-[var(--text-primary)] text-sm">
          {downloadTip}
        </div>
      )}

      {/* Status Card */}
      <div className="card-surface p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-[var(--radius-md)] ${status.bg} flex items-center justify-center`}>
              <FileText size={20} className={status.text} />
            </div>
            <div>
              <div className="text-[var(--text-primary)] text-sm font-semibold">报告状态</div>
              <div className={`text-xs ${status.text}`}>{status.label}</div>
            </div>
          </div>
          <div className="text-right min-w-[80px]">
            <div className="text-[var(--text-secondary)] text-xs">报告类型</div>
            <div className="text-[var(--text-primary)] text-sm font-medium">{report.period_type === 'annual' ? '年度报告' : '季度报告'}</div>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="bg-[var(--bg-page)] rounded-[var(--radius-sm)] p-3">
            <div className="text-[var(--text-secondary)] text-xs">市场</div>
            <div className="text-[#FAFAF9] text-sm font-semibold mt-1">{report.market || '-'}</div>
          </div>
          <div className="bg-[var(--bg-page)] rounded-[var(--radius-sm)] p-3">
            <div className="text-[var(--text-secondary)] text-xs">所属行业</div>
            <div className="text-[#FAFAF9] text-sm font-semibold mt-1">{industryLabel || report.industry_code || '-'}</div>
            {industryLabel && report.industry_code && industryLabel !== report.industry_code && (
              <div className="text-[var(--text-muted)] text-[10px] mt-0.5">{report.industry_code}</div>
            )}
          </div>
        </div>

        {(report.status === 'running' || report.status === 'pending') && (
          <div className="mt-4 bg-[#FFB547]/10 border border-[#FFB547]/30 rounded-xl p-3">
            <div className="text-[#FAFAF9] text-sm font-semibold">分析进度</div>
            <div className="text-[var(--text-secondary)] text-xs mt-1">
              {report.source_type === 'file_upload'
                ? '上传完成 → 文本提取 → 指标计算 → 风险/机会生成 → 入库'
                : '拉取财报 → 指标计算 → 风险/机会生成 → 入库'}
            </div>
            <div className="mt-2 h-2 w-full bg-[#0B0B0E] rounded-full overflow-hidden">
              <div className="h-full w-1/2 bg-[#FFB547] rounded-full animate-pulse" />
            </div>
            <div className="text-[var(--text-secondary)] text-xs mt-2">页面将自动刷新状态与结果…</div>
          </div>
        )}

        {report.status === 'failed' && report.error_message && (
          <div className="mt-4 bg-[#E85A4F]/10 border border-[#E85A4F]/30 rounded-xl p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle size={16} className="text-[#E85A4F] mt-0.5 flex-shrink-0" />
              <div className="min-w-0">
                <div className="text-[#E85A4F] text-sm font-semibold">失败原因</div>
                <div className="text-[#E85A4F] text-xs mt-1 break-words">{report.error_message}</div>
              </div>
            </div>
          </div>
        )}
      </div>

      {report.source_type === 'market_fetch' && report.status !== 'done' && metrics.length === 0 && (
        <div className="card-surface p-4">
          <div className="text-[#FAFAF9] text-sm font-semibold">数据状态</div>
          <div className="text-[#6B6B70] text-sm mt-2">
            {report.status === 'running' || report.status === 'pending'
              ? '报告正在生成中，请稍等片刻后返回刷新。'
              : '当前报告没有生成可展示的指标数据。'}
          </div>
          <div className="text-[var(--text-secondary)] text-xs mt-2">财报期末：{report.period_end}</div>
        </div>
      )}

      {report.source_type === 'file_upload' && metrics.length === 0 && report.status !== 'running' && (
        <button
          onClick={handleReanalyze}
          disabled={reanalyzing}
          className="w-full bg-[var(--accent-secondary)] text-white rounded-[var(--radius-lg)] py-4 px-6 font-semibold text-base disabled:opacity-50 active:scale-[0.99] transition-transform"
        >
          {reanalyzing ? '重新分析中...' : '重新分析上传文件'}
        </button>
      )}

      {/* Enterprise Rating - 8-dimension */}
      {metrics.length > 0 && (() => {
        const r = enterpriseRating;
        const totalPct = r.total_score;
        const gradeColor = totalPct >= 70 ? 'text-emerald-400' : totalPct >= 50 ? 'text-amber-400' : totalPct >= 35 ? 'text-orange-400' : 'text-red-400';
        const gradeBg = totalPct >= 70 ? 'bg-emerald-500/8 border-emerald-500/30' : totalPct >= 50 ? 'bg-amber-500/8 border-amber-500/30' : totalPct >= 35 ? 'bg-orange-500/8 border-orange-500/30' : 'bg-red-500/8 border-red-500/30';
        const gradeIcon = totalPct >= 80 ? '👑' : totalPct >= 60 ? '🏆' : totalPct >= 40 ? '📊' : totalPct >= 25 ? '⚠️' : '🚨';
        const gradeLabel = totalPct >= 90 ? '信用等级极高' : totalPct >= 80 ? '信用等级很高' : totalPct >= 70 ? '信用等级较高' : totalPct >= 60 ? '信用等级中等' : totalPct >= 50 ? '信用等级偏低' : totalPct >= 35 ? '信用等级较低' : '信用等级很低';
        const dimEntries = Object.entries(r.dim_summary);

        return (
          <div className={`${gradeBg} border-2 rounded-[var(--radius-xl)] p-5`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-2xl">{gradeIcon}</span>
                <div>
                  <div className="text-[var(--text-muted)] text-[10px] font-medium tracking-wider uppercase">企业综合评级</div>
                  <div className="text-[var(--text-secondary)] text-xs mt-0.5">{gradeLabel} · {r.recommendation}</div>
                </div>
              </div>
              <div className="text-right">
                <div className={`${gradeColor} text-4xl font-black tracking-tighter leading-none`} style={{ textShadow: '0 0 20px rgba(250,204,21,0.3)' }}>
                  {r.grade}
                </div>
                <div className="text-[var(--text-muted)] text-[10px] mt-1">{r.total_score}/100</div>
              </div>
            </div>

            {/* 8-dimension bar breakdown */}
            <div className="mt-4 pt-3 border-t border-[var(--border-color)] space-y-2">
              {dimEntries.map(([label, d]) => (
                <div key={label} className="flex items-center gap-2 text-xs">
                  <span className="text-[var(--text-secondary)] w-16 shrink-0">{label}</span>
                  <div className="flex-1 h-2 bg-black/30 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${d.pct >= 80 ? 'bg-emerald-500' : d.pct >= 60 ? 'bg-emerald-400' : d.pct >= 40 ? 'bg-amber-400' : 'bg-red-400'}`}
                      style={{ width: `${Math.min(100, d.pct)}%`, transition: 'width 0.6s ease' }}
                    />
                  </div>
                  <span className={`w-8 text-right ${d.pct >= 60 ? 'text-emerald-400' : d.pct >= 40 ? 'text-amber-400' : 'text-red-400'}`}>{d.flag}</span>
                  <span className="text-[var(--text-muted)] w-10 text-right">{d.pct}%</span>
                </div>
              ))}
            </div>

            {/* Strengths & Risks */}
            {(r.strengths.length > 0 || r.risks.length > 0) && (
              <div className="flex flex-wrap gap-1.5 mt-3 text-[10px]">
                {r.strengths.map((s, i) => <span key={`s${i}`} className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400">{s}</span>)}
                {r.risks.map((s, i) => <span key={`r${i}`} className="px-2 py-0.5 rounded-full bg-red-500/15 text-red-400">{s}</span>)}
              </div>
            )}
          </div>
        );
      })()}

      {/* Tabs - 横向滚动 */}
      <div className="overflow-x-auto -mx-4 px-4">
        <div className="flex gap-2 min-w-max">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2.5 rounded-[var(--radius-sm)] text-sm font-semibold whitespace-nowrap transition-all ${
                activeTab === tab.key
                  ? 'bg-[var(--text-primary)] text-[var(--bg-page)]'
                  : 'bg-[var(--bg-surface)] text-[var(--text-secondary)] border border-[var(--border-color)]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content based on active tab */}
      {activeTab === 'overview' && (
        <div className="flex flex-col gap-4">
          {/* 公司介绍 */}
          <div className="card-surface p-4">
            <h3 className="text-[#FAFAF9] text-sm font-semibold mb-3">公司概况</h3>
            <div className="space-y-2">
              <div className="bg-[var(--bg-page)] rounded-[var(--radius-sm)] p-3">
                <div className="text-[var(--text-primary)] text-xs font-semibold mb-2">公司发展历史（官网抓取）</div>
                <div className="text-[var(--text-secondary)] text-xs leading-relaxed whitespace-pre-wrap">
                  {companyHistory || '正在抓取公司官网发展历史...'}
                </div>
                {(companyHistorySource || companyWebsite) && (
                  <div className="mt-2 text-[11px] text-[var(--text-muted)] break-all">
                    来源：
                    <a
                      href={companyHistorySource || companyWebsite}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-indigo-300 hover:text-indigo-200"
                    >
                      {companyHistorySource || companyWebsite}
                    </a>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 盈利能力 - 同比对比 */}
          <div className="card-surface p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[#FAFAF9] text-sm font-semibold">盈利能力</h3>
              <span className="text-[var(--text-secondary)] text-xs">同比上一年 {prevPeriod ? `(${prevPeriod})` : ''}</span>
            </div>
            <div className="space-y-3">
              {/* 毛利率 */}
              <div className="bg-[var(--bg-page)] rounded-[var(--radius-sm)] p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[var(--text-secondary)] text-xs">毛利率</span>
                  <span className="text-[var(--text-secondary)] text-xs">上年: {fmtMetric(prevGrossMargin)}%</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[#32D583] text-xl font-bold">{grossMargin?.value?.toFixed(2) || '-'}%</span>
                  {(() => {
                    const cmp = compareYoY(metricValue(grossMargin), prevGrossMargin);
                    return cmp.hasValue ? diffBadge(cmp, 'higher') : <span className="text-[var(--text-muted)] text-xs">-</span>;
                  })()}
                </div>
              </div>
              {/* 净利率 */}
              <div className="bg-[var(--bg-page)] rounded-[var(--radius-sm)] p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[var(--text-secondary)] text-xs">净利率</span>
                  <span className="text-[var(--text-secondary)] text-xs">上年: {fmtMetric(prevNetMargin)}%</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[#32D583] text-xl font-bold">{netMargin?.value?.toFixed(2) || '-'}%</span>
                  {(() => {
                    const cmp = compareYoY(metricValue(netMargin), prevNetMargin);
                    return cmp.hasValue ? diffBadge(cmp, 'higher') : <span className="text-[var(--text-muted)] text-xs">-</span>;
                  })()}
                </div>
              </div>
              {/* ROE */}
              <div className="bg-[var(--bg-page)] rounded-[var(--radius-sm)] p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[var(--text-secondary)] text-xs">ROE (净资产收益率)</span>
                  <span className="text-[var(--text-secondary)] text-xs">上年: {fmtMetric(prevRoe)}%</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[#6366F1] text-xl font-bold">{roe?.value?.toFixed(2) || '-'}%</span>
                  {(() => {
                    const cmp = compareYoY(metricValue(roe), prevRoe);
                    return cmp.hasValue ? diffBadge(cmp, 'higher') : <span className="text-[var(--text-muted)] text-xs">-</span>;
                  })()}
                </div>
              </div>
              {/* ROA */}
              <div className="bg-[var(--bg-page)] rounded-[var(--radius-sm)] p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[var(--text-secondary)] text-xs">ROA (总资产收益率)</span>
                  <span className="text-[var(--text-secondary)] text-xs">上年: {fmtMetric(prevRoa)}%</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[#6366F1] text-xl font-bold">{roa?.value?.toFixed(2) || '-'}%</span>
                  {(() => {
                    const cmp = compareYoY(metricValue(roa), prevRoa);
                    return cmp.hasValue ? diffBadge(cmp, 'higher') : <span className="text-[var(--text-muted)] text-xs">-</span>;
                  })()}
                </div>
              </div>
            </div>
          </div>

          {/* 偿债能力 - 同比对比 */}
          <div className="card-surface p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[#FAFAF9] text-sm font-semibold">偿债能力</h3>
              <span className="text-[var(--text-secondary)] text-xs">同比上一年 {prevPeriod ? `(${prevPeriod})` : ''}</span>
            </div>
            <div className="space-y-3">
              <div className="bg-[var(--bg-page)] rounded-[var(--radius-sm)] p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[var(--text-secondary)] text-xs">流动比率</span>
                  <span className="text-[var(--text-secondary)] text-xs">上年: {fmtMetric(prevCurrentRatio)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[#32D583] text-xl font-bold">{currentRatio?.value?.toFixed(2) || '-'}</span>
                  {(() => {
                    const cmp = compareYoY(metricValue(currentRatio), prevCurrentRatio);
                    return cmp.hasValue ? diffBadge(cmp, 'higher') : <span className="text-[var(--text-muted)] text-xs">-</span>;
                  })()}
                </div>
              </div>
              <div className="bg-[var(--bg-page)] rounded-[var(--radius-sm)] p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[var(--text-secondary)] text-xs">速动比率</span>
                  <span className="text-[var(--text-secondary)] text-xs">上年: {fmtMetric(prevQuickRatio)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[#32D583] text-xl font-bold">{latestMetrics.find(m => m.metric_code === 'QUICK_RATIO')?.value?.toFixed(2) || '-'}</span>
                  {(() => {
                    const cmp = compareYoY(metricValue(quickRatio), prevQuickRatio);
                    return cmp.hasValue ? diffBadge(cmp, 'higher') : <span className="text-[var(--text-muted)] text-xs">-</span>;
                  })()}
                </div>
              </div>
              <div className="bg-[var(--bg-page)] rounded-[var(--radius-sm)] p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[var(--text-secondary)] text-xs">资产负债率</span>
                  <span className="text-[var(--text-secondary)] text-xs">上年: {fmtMetric(prevDebtRatio)}%</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className={`text-xl font-bold ${(debtRatio?.value || 0) > 70 ? 'text-[#E85A4F]' : 'text-[#32D583]'}`}>{debtRatio?.value?.toFixed(2) || '-'}%</span>
                  {(() => {
                    const cmp = compareYoY(metricValue(debtRatio), prevDebtRatio);
                    return cmp.hasValue ? diffBadge(cmp, 'lower') : <span className="text-[var(--text-muted)] text-xs">-</span>;
                  })()}
                </div>
              </div>
            </div>
          </div>

          {/* 运营效率 */}
          <div className="card-surface p-4">
            <h3 className="text-[#FAFAF9] text-sm font-semibold mb-3">运营效率</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between bg-[var(--bg-page)] rounded-[var(--radius-sm)] p-3">
                <span className="text-[#6B6B70] text-sm">总资产周转率</span>
                <span className="text-[#FFB547] text-lg font-bold">{latestMetrics.find(m => m.metric_code === 'ASSET_TURNOVER')?.value?.toFixed(2) || '-'}</span>
              </div>
              <div className="flex items-center justify-between bg-[var(--bg-page)] rounded-[var(--radius-sm)] p-3">
                <span className="text-[#6B6B70] text-sm">存货周转率</span>
                <span className="text-[#FFB547] text-lg font-bold">{latestMetrics.find(m => m.metric_code === 'INVENTORY_TURNOVER')?.value?.toFixed(2) || '-'}</span>
              </div>
              <div className="flex items-center justify-between bg-[var(--bg-page)] rounded-[var(--radius-sm)] p-3">
                <span className="text-[#6B6B70] text-sm">应收账款周转率</span>
                <span className="text-[#FFB547] text-lg font-bold">{latestMetrics.find(m => m.metric_code === 'RECEIVABLE_TURNOVER')?.value?.toFixed(2) || '-'}</span>
              </div>
            </div>
          </div>

        </div>
      )}

      {activeTab === 'metrics' && (
        <div className="flex flex-col gap-4">
          {/* Period selector for multi-period data */}
          {(() => {
            const allPeriods = Array.from(new Set(metrics.map(m => m.period_end).filter(Boolean))).sort().reverse();
            if (allPeriods.length <= 1) return null;
            return (
              <div className="card-surface p-3">
                <div className="flex items-center gap-2 overflow-x-auto -mx-1 px-1">
                  <span className="text-[var(--text-muted)] text-xs shrink-0">报告期</span>
                  {allPeriods.map(p => (
                    <button
                      key={p}
                      onClick={() => { setMetricsPeriod(p); }}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all ${
                        metricsPeriod === p
                          ? 'bg-[var(--text-primary)] text-[var(--bg-page)]'
                          : 'bg-[var(--bg-page)] text-[var(--text-secondary)] border border-[var(--border-color)]'
                      }`}
                    >
                      {p.slice(0, 7)}
                    </button>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* Core Metrics - card-style mobile layout */}
          {(() => {
            const periodMetrics = metricsPeriod
              ? metrics.filter(m => m.period_end === metricsPeriod)
              : latestMetrics;
            const mv = (codes: string[]) => { const hit = periodMetrics.find(m => codes.includes(m.metric_code)); return hit?.value == null ? null : Number(hit.value); };
            const allPeriods = Array.from(new Set(metrics.map(m => m.period_end).filter(Boolean))).sort().reverse();
            const currentPeriod = metricsPeriod || report.period_end;

            type MetricDef = { codes: string[]; label: string; unit: string; betterWhen: 'higher'|'lower'; category: string; industryKey?: string; thresholds?: [number, number, number] };
            const defs: MetricDef[] = [
              { codes: ['GROSS_MARGIN'], label: '毛利率', unit: '%', betterWhen: 'higher', category: '盈利', industryKey: 'grossMargin', thresholds: [40, 20, 0] },
              { codes: ['NET_MARGIN'], label: '净利率', unit: '%', betterWhen: 'higher', category: '盈利', industryKey: 'netMargin', thresholds: [20, 10, 0] },
              { codes: ['ROE'], label: 'ROE', unit: '%', betterWhen: 'higher', category: '盈利', industryKey: 'roe', thresholds: [20, 10, 0] },
              { codes: ['ROA'], label: 'ROA', unit: '%', betterWhen: 'higher', category: '盈利', industryKey: 'roa', thresholds: [10, 5, 0] },
              { codes: ['CURRENT_RATIO'], label: '流动比率', unit: '倍', betterWhen: 'higher', category: '偿债', industryKey: 'currentRatio', thresholds: [2, 1, 0] },
              { codes: ['QUICK_RATIO'], label: '速动比率', unit: '倍', betterWhen: 'higher', category: '偿债', thresholds: [1.5, 1, 0] },
              { codes: ['DEBT_ASSET'], label: '资产负债率', unit: '%', betterWhen: 'lower', category: '偿债', industryKey: 'debtRatio', thresholds: [30, 60, 80] },
              { codes: ['ASSET_TURNOVER'], label: '总资产周转率', unit: '次', betterWhen: 'higher', category: '营运', industryKey: 'assetTurnover', thresholds: [1, 0.5, 0] },
              { codes: ['INVENTORY_TURNOVER'], label: '存货周转率', unit: '次', betterWhen: 'higher', category: '营运', thresholds: [8, 4, 0] },
              { codes: ['RECEIVABLE_TURNOVER'], label: '应收周转率', unit: '次', betterWhen: 'higher', category: '营运', thresholds: [10, 6, 0] },
              { codes: ['TOTAL_REVENUE', 'IS.REVENUE'], label: '营业总收入', unit: '', betterWhen: 'higher', category: '规模', thresholds: undefined },
              { codes: ['OPERATING_CASH_FLOW', 'CF.CFO'], label: '经营现金流净额', unit: '', betterWhen: 'higher', category: '规模', thresholds: undefined },
            ];

            const catOrder = ['盈利', '偿债', '营运', '规模'];
            const catIcon: Record<string, React.ReactNode> = { '盈利': <Zap size={14} />, '偿债': <ShieldCheck size={14} />, '营运': <Gauge size={14} />, '规模': <BarChart3 size={14} /> };
            const catColor: Record<string, string> = { '盈利': 'text-emerald-400', '偿债': 'text-amber-400', '营运': 'text-indigo-400', '规模': 'text-sky-400' };

            const yoyVal = (codes: string[]) => {
              for (const c of codes) { const v = prevMetricMap[c]; if (v != null && !Number.isNaN(v)) return Number(v); }
              return null;
            };

            const scoreBar = (val: number, thresholds: [number, number, number], betterWhen: 'higher'|'lower') => {
              if (betterWhen === 'lower') {
                const pct = val <= thresholds[0] ? 90 : val <= thresholds[1] ? 60 : val <= thresholds[2] ? 35 : 10;
                const color = pct >= 70 ? 'bg-emerald-500' : pct >= 40 ? 'bg-amber-500' : 'bg-red-500';
                return { pct, color };
              }
              const pct = val >= thresholds[0] ? 90 : val >= thresholds[1] ? 60 : val >= thresholds[2] ? 35 : 10;
              const color = pct >= 70 ? 'bg-emerald-500' : pct >= 40 ? 'bg-amber-500' : 'bg-red-500';
              return { pct, color };
            };

            const industryDiff = (val: number, key?: string) => {
              if (!key) return null;
              const avg = (industryAvg as Record<string, number>)[key];
              if (avg == null) return null;
              return val - avg;
            };

            const prevPeriodForMetrics = prevPeriod || allPeriods.find(p => p < currentPeriod);

            return catOrder.map(cat => {
              const items = defs.filter(d => d.category === cat);
              if (items.length === 0) return null;
              return (
                <div key={cat} className="card-surface p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <span className={catColor[cat]}>{catIcon[cat]}</span>
                    <span className="text-[#FAFAF9] text-sm font-semibold">{cat}指标</span>
                    {prevPeriodForMetrics && <span className="text-[var(--text-muted)] text-[10px] ml-auto">同比 {prevPeriodForMetrics?.slice(0,7)}</span>}
                  </div>
                  <div className="space-y-2">
                    {items.map(def => {
                      const val = mv(def.codes);
                      const prev = yoyVal(def.codes);
                      const hasVal = val != null;
                      const hasPrev = prev != null;
                      const cmp = hasVal && hasPrev && Number(prev) !== 0 ? ((val! - prev) / Math.abs(prev)) * 100 : null;
                      const indDiff = hasVal ? industryDiff(val!, def.industryKey) : null;
                      const bar = hasVal && def.thresholds ? scoreBar(val!, def.thresholds, def.betterWhen) : null;
                      const fmtVal = def.codes[0] === 'TOTAL_REVENUE' || def.codes[0] === 'OPERATING_CASH_FLOW'
                        ? fmtAmount(val) : fmtMetric(val);
                      const fmtPrev = def.codes[0] === 'TOTAL_REVENUE' || def.codes[0] === 'OPERATING_CASH_FLOW'
                        ? fmtAmount(prev) : fmtMetric(prev);
                      return (
                        <div key={def.codes[0]} className="bg-[var(--bg-page)] rounded-xl p-3">
                          <div className="flex items-center justify-between">
                            <span className="text-[var(--text-secondary)] text-xs">{def.label}</span>
                            <span className="text-[#FAFAF9] text-lg font-bold tracking-tight">{hasVal ? fmtVal : '-'}</span>
                          </div>
                          {hasVal && (
                            <div className="mt-2">
                              {bar && (
                                <div className="h-1.5 bg-black/30 rounded-full overflow-hidden mb-1.5">
                                  <div className={`h-full rounded-full ${bar.color}`} style={{ width: `${bar.pct}%`, transition: 'width 0.5s ease' }} />
                                </div>
                              )}
                              <div className="flex items-center justify-between text-[10px]">
                                <div className="flex items-center gap-2">
                                  {hasPrev && (
                                    <span className="text-[var(--text-muted)]">上年 {fmtPrev}{def.unit ? ` ${def.unit}` : ''}</span>
                                  )}
                                  {cmp != null && (
                                    <span className={`flex items-center gap-0.5 font-medium ${
                                      (def.betterWhen === 'higher' ? cmp > 0 : cmp < 0) ? 'text-emerald-400' :
                                      (def.betterWhen === 'higher' ? cmp < 0 : cmp > 0) ? 'text-red-400' : 'text-zinc-500'
                                    }`}>
                                      {cmp > 0 ? <ArrowUpRight size={10} /> : cmp < 0 ? <ArrowDownRight size={10} /> : <Minus size={10} />}
                                      {cmp > 0 ? '+' : ''}{cmp.toFixed(1)}%
                                    </span>
                                  )}
                                </div>
                                {indDiff != null && (
                                  <span className={`font-medium ${
                                    (def.betterWhen === 'higher' ? indDiff > 0 : indDiff < 0) ? 'text-emerald-400' :
                                    (def.betterWhen === 'higher' ? indDiff < 0 : indDiff > 0) ? 'text-red-400' : 'text-zinc-500'
                                  }`}>
                                    {def.betterWhen === 'lower' ? '低于' : indDiff > 0 ? '高于' : indDiff < 0 ? '低于' : '持平'}行业 {Math.abs(indDiff).toFixed(1)}{def.unit}
                                  </span>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            });
          })()}

          {/* All metrics by period - grouped list */}
          <div className="card-surface p-4">
            <button onClick={() => setShowAllMetrics(!showAllMetrics)} className="flex items-center justify-between w-full">
              <div className="text-[#FAFAF9] text-sm font-semibold">全部指标明细</div>
              {showAllMetrics ? <ChevronDown size={16} className="text-[var(--text-muted)]" /> : <ChevronRight size={16} className="text-[var(--text-muted)]" />}
            </button>
            {showAllMetrics && (
              <div className="mt-3 space-y-4">
                {(() => {
                  const periods = Array.from(new Set(metrics.map(m => m.period_end).filter(Boolean))).sort().reverse();
                  if (periods.length === 0) return <div className="text-[#6B6B70] text-sm">暂无财务指标数据</div>;
                  return periods.map(pe => {
                    const pMetrics = metrics.filter(m => m.period_end === pe);
                    return (
                      <div key={pe}>
                        <div className="text-[var(--text-primary)] text-xs font-semibold mb-2 pb-1 border-b border-[var(--border-color)]">{pe}</div>
                        <div className="space-y-1">
                          {pMetrics.map((m, i) => (
                            <div key={i} className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-[var(--bg-page)]">
                              <span className="text-[var(--text-secondary)] text-xs">{m.metric_name}</span>
                              <div className="flex items-center gap-2">
                                <span className="text-[#FAFAF9] text-xs font-medium">{m.value == null ? '-' : (m.metric_code === 'TOTAL_REVENUE' || m.metric_code === 'OPERATING_CASH_FLOW' || m.metric_code === 'NET_PROFIT' ? fmtAmount(m.value) : m.value.toFixed(4))}</span>
                                {m.unit && <span className="text-[var(--text-muted)] text-[10px]">{m.unit}</span>}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'risks' && (
        <div className="flex flex-col gap-3">
          {(() => {
            type SignalDef = {
              id: string; label: string; icon: React.ReactNode; color: string;
              metrics: { codes: string[]; label: string; unit: string; betterWhen: 'higher'|'lower'; warn: [number, number]; info: string }[];
            };
            const signals: SignalDef[] = [
              {
                id: 'dupont', label: '杜邦风险分解', icon: <Activity size={14} />, color: 'text-indigo-400',
                metrics: [
                  { codes: ['NET_MARGIN'], label: '净利率', unit: '%', betterWhen: 'higher', warn: [5, 2], info: '净利率<{w2}%→盈利不可持续；<{w1}%→依赖非经常性损益风险高' },
                  { codes: ['ASSET_TURNOVER'], label: '资产周转率', unit: '次', betterWhen: 'higher', warn: [0.5, 0.3], info: '周转率<{w2}→产能过剩或资产虚增' },
                  { codes: ['DEBT_ASSET'], label: '权益乘数驱动', unit: '倍', betterWhen: 'lower', warn: [3, 5], info: '权益乘数>{w2}x→高杠杆放大下行风险' },
                ],
              },
              {
                id: 'liquidity', label: '流动性风险', icon: <ShieldCheck size={14} />, color: 'text-amber-400',
                metrics: [
                  { codes: ['CURRENT_RATIO'], label: '流动比率', unit: '倍', betterWhen: 'higher', warn: [1.5, 1], info: '低于1→短期偿债缺口；1-1.5→安全边际不足' },
                  { codes: ['QUICK_RATIO'], label: '速动比率', unit: '倍', betterWhen: 'higher', warn: [1, 0.5], info: '低于0.5→依赖存货偿债，流动性紧张' },
                  { codes: ['DEBT_ASSET'], label: '资产负债率', unit: '%', betterWhen: 'lower', warn: [60, 75], info: '>{w2}%→再融资风险/评级承压' },
                ],
              },
              {
                id: 'operating', label: '营运风险', icon: <Gauge size={14} />, color: 'text-emerald-400',
                metrics: [
                  { codes: ['INVENTORY_TURNOVER'], label: '存货周转率', unit: '次', betterWhen: 'higher', warn: [4, 2], info: '低于{w2}次→存货跌价/滞销风险' },
                  { codes: ['RECEIVABLE_TURNOVER'], label: '应收周转率', unit: '次', betterWhen: 'higher', warn: [6, 3], info: '低于{w2}次→回款超120天，坏账风险升' },
                ],
              },
              {
                id: 'growth', label: '增长可持续性', icon: <Target size={14} />, color: 'text-red-400',
                metrics: [
                  { codes: ['ROE'], label: 'ROE', unit: '%', betterWhen: 'higher', warn: [10, 5], info: 'ROE<{w2}%→资本回报不足以支撑内生增长' },
                  { codes: ['GROSS_MARGIN','NET_MARGIN'], label: '利润率趋势', unit: '%', betterWhen: 'higher', warn: [15, 5], info: '净利率<{w2}%→内生增长受限，依赖外部融资' },
                ],
              },
            ];

            const mv = (codes: string[]) => { const hit = latestMetrics.find(m => codes.includes(m.metric_code)); return hit?.value == null ? null : Number(hit.value); };
            const prevV = (codes: string[]) => { for (const c of codes) { const v = prevMetricMap[c]; if (v != null && !Number.isNaN(v)) return Number(v); } return null; };

            const riskLevel = (val: number, warn: [number, number], betterWhen: 'higher'|'lower') => {
              if (betterWhen === 'lower') {
                return val >= warn[1] ? 'high' : val >= warn[0] ? 'medium' : 'low';
              }
              return val <= warn[1] ? 'high' : val <= warn[0] ? 'medium' : 'low';
            };
            const riskStyle = (level: string) => ({
              high: { bg: 'bg-red-500/10 border-red-500/30', dot: 'bg-red-500', text: 'text-red-400', label: '高风险' },
              medium: { bg: 'bg-amber-500/8 border-amber-500/25', dot: 'bg-amber-500', text: 'text-amber-400', label: '关注' },
              low: { bg: 'bg-emerald-500/5 border-emerald-500/15', dot: 'bg-emerald-500', text: 'text-emerald-400', label: '安全' },
            }[level] || { bg: 'bg-zinc-500/5', dot: 'bg-zinc-500', text: 'text-zinc-400', label: '-' });

            return signals.map(sig => {
              const riskItems = sig.metrics.map(m => {
                const val = mv(m.codes);
                const prev = prevV(m.codes);
                const hasVal = val != null;
                const level = hasVal ? riskLevel(val!, m.warn, m.betterWhen) : 'low';
                const style = riskStyle(level);
                const cmp = hasVal && prev != null && prev !== 0 ? ((val! - prev) / Math.abs(prev)) * 100 : null;
                const isWorsening = cmp != null && ((m.betterWhen === 'higher' && cmp < 0) || (m.betterWhen === 'lower' && cmp > 0));
                const eqMult = m.codes[0] === 'DEBT_ASSET' && sig.id === 'dupont' ? (100 / Math.max(1, 100 - (val || 0))) : null;
                return { ...m, val, level, style, cmp, isWorsening, eqMult };
              }).filter(m => m.val != null);

              if (riskItems.length === 0) {
                return (
                  <div key={sig.id} className="card-surface p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <span className={sig.color}>{sig.icon}</span>
                      <span className="text-[#FAFAF9] text-sm font-semibold">{sig.label}</span>
                    </div>
                    <div className="text-[var(--text-muted)] text-xs">数据不足，无法评估</div>
                  </div>
                );
              }

              const highCount = riskItems.filter(m => m.level === 'high').length;
              const medCount = riskItems.filter(m => m.level === 'medium').length;

              return (
                <div key={sig.id} className="card-surface p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className={sig.color}>{sig.icon}</span>
                      <span className="text-[#FAFAF9] text-sm font-semibold">{sig.label}</span>
                    </div>
                    {highCount > 0 ? (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 font-medium">{highCount}项高风险</span>
                    ) : medCount > 0 ? (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 font-medium">{medCount}项需关注</span>
                    ) : (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-medium">风险可控</span>
                    )}
                  </div>
                  <div className="space-y-2">
                    {riskItems.map(ri => (
                      <div key={ri.codes[0]} className={`${ri.style.bg} border rounded-xl p-3`}>
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-2">
                            <div className={`w-1.5 h-1.5 rounded-full ${ri.style.dot}`} />
                            <span className="text-[var(--text-secondary)] text-xs font-medium">{ri.label}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-[#FAFAF9] text-sm font-bold">{ri.val!.toFixed(2)}{ri.unit}</span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded ${ri.style.bg} ${ri.style.text}`}>{ri.style.label}</span>
                          </div>
                        </div>
                        {ri.cmp != null && (
                          <div className={`text-[10px] ${ri.isWorsening ? 'text-red-400' : 'text-emerald-400'}`}>
                            同比 {ri.cmp > 0 ? '+' : ''}{ri.cmp.toFixed(1)}% {ri.isWorsening ? '⚠ 趋势恶化' : '趋稳'}
                          </div>
                        )}
                        {ri.eqMult != null && (
                          <div className="text-[10px] text-[var(--text-muted)] mt-0.5">权益乘数 {ri.eqMult.toFixed(2)}x</div>
                        )}
                        <div className="text-[10px] text-[var(--text-muted)] mt-1 leading-relaxed">
                          {ri.info.replace('{w2}', String(ri.warn[1])).replace('{w1}', String(ri.warn[0]))}
                          {ri.val! <= ri.warn[1] && ri.betterWhen === 'higher' ? ` → 当前${ri.val!.toFixed(1)}${ri.unit}已触及警戒线` : ''}
                          {ri.val! >= ri.warn[1] && ri.betterWhen === 'lower' ? ` → 当前${ri.val!.toFixed(1)}${ri.unit}已触及警戒线` : ''}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            });
          })()}

          {/* System Alerts */}
          {alerts.length > 0 && (
            <div className="card-surface p-4">
              <div className="text-[#FAFAF9] text-sm font-semibold mb-3">系统风险预警</div>
              <div className="space-y-2">
                {alerts.map(alert => {
                  const alertColors: Record<string, { bg: string; text: string; label: string }> = {
                    high: { bg: 'bg-[#E85A4F]/20', text: 'text-[#E85A4F]', label: '高风险' },
                    medium: { bg: 'bg-[#FFB547]/20', text: 'text-[#FFB547]', label: '中风险' },
                    low: { bg: 'bg-[#32D583]/20', text: 'text-[#32D583]', label: '低风险' },
                  };
                  const color = alertColors[alert.level] || alertColors.medium;
                  return (
                    <div key={alert.id} className="bg-[var(--bg-page)] rounded-[var(--radius-sm)] p-3">
                      <div className="flex items-center gap-2 mb-1">
                        <AlertTriangle size={14} className={color.text} />
                        <span className="text-[#FAFAF9] text-sm font-medium">{alert.title}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${color.bg} ${color.text}`}>{color.label}</span>
                      </div>
                      <div className="text-[var(--text-secondary)] text-xs">{alert.message}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'opportunities' && (
        <div className="flex flex-col gap-3">
          {(() => {
            const mv = (codes: string[]) => { const hit = latestMetrics.find(m => codes.includes(m.metric_code)); return hit?.value == null ? null : Number(hit.value); };
            const prevV = (codes: string[]) => { for (const c of codes) { const v = prevMetricMap[c]; if (v != null && !Number.isNaN(v)) return Number(v); } return null; };

            type OppSignal = {
              id: string; label: string; icon: React.ReactNode; color: string; gradientFrom: string;
              checks: { codes: string[]; label: string; unit: string; thresholds: number[]; betterWhen: 'higher'|'lower'; verdict: string[]; industryKey?: string }[];
            };
            const opps: OppSignal[] = [
              {
                id: 'moat', label: '护城河识别', icon: <Castle size={14} />, color: 'text-indigo-400', gradientFrom: 'from-indigo-950/40',
                checks: [
                  { codes: ['GROSS_MARGIN'], label: '定价权', unit: '%', thresholds: [40, 25, 10], betterWhen: 'higher', verdict: ['强护城河：品牌溢价/技术壁垒', '中等定价权，有差异化空间', '定价权弱，价格竞争敏感'], industryKey: 'grossMargin' },
                  { codes: ['GROSS_MARGIN','NET_MARGIN'], label: '费用效率', unit: '%', thresholds: [20, 35, 50], betterWhen: 'lower', verdict: ['精益运营，成本管控强', '费用效率中等', '费用率偏高，运营效率待提升'] },
                ],
              },
              {
                id: 'value', label: '价值创造', icon: <Wallet size={14} />, color: 'text-emerald-400', gradientFrom: 'from-emerald-950/40',
                checks: [
                  { codes: ['ROE'], label: '股东回报', unit: '%', thresholds: [20, 12, 5], betterWhen: 'higher', verdict: ['卓越：持续创造超额价值', '达标：资本回报合理', '不足：低于资本成本'], industryKey: 'roe' },
                  { codes: ['ROA'], label: '资产效率', unit: '%', thresholds: [8, 4, 1], betterWhen: 'higher', verdict: ['轻资产高效率', '资产利用正常', '资产产出效率低'], industryKey: 'roa' },
                ],
              },
              {
                id: 'capital', label: '资本优化', icon: <Target size={14} />, color: 'text-amber-400', gradientFrom: 'from-amber-950/40',
                checks: [
                  { codes: ['DEBT_ASSET'], label: '杠杆空间', unit: '%', thresholds: [40, 60, 75], betterWhen: 'lower', verdict: ['杠杆空间充足，可低成本扩张', '杠杆适中', '杠杆偏高，融资弹性受限'], industryKey: 'debtRatio' },
                  { codes: ['CURRENT_RATIO'], label: '流动性储备', unit: '倍', thresholds: [3, 2, 1.2], betterWhen: 'higher', verdict: ['流动性充裕，抗风险能力强', '流动性适中', '流动性紧张'] },
                ],
              },
            ];

            return opps.map(opp => {
              const results = opp.checks.map(ck => {
                const val = mv(ck.codes);
                const prev = prevV(ck.codes);
                if (val == null) return { ...ck, val, tier: -1, tierLabel: '数据不足' };
                const diff = ck.codes.length > 1 ? mv(['GROSS_MARGIN'])! - mv(['NET_MARGIN'])! : val;
                const comparedVal = ck.codes.length > 1 ? diff : val;
                let tier = 0;
                if (ck.betterWhen === 'higher') {
                  tier = comparedVal >= ck.thresholds[0] ? 0 : comparedVal >= ck.thresholds[1] ? 1 : comparedVal >= ck.thresholds[2] ? 2 : 2;
                } else {
                  tier = comparedVal <= ck.thresholds[0] ? 0 : comparedVal <= ck.thresholds[1] ? 1 : 2;
                }
                const indAvg = ck.industryKey ? (industryAvg as Record<string, number>)[ck.industryKey] : null;
                const indDiff = indAvg != null ? (ck.codes.length > 1 ? diff : val!) - indAvg : null;
                const cmp = prev != null && prev !== 0 && ck.codes.length <= 1 ? ((val! - prev) / Math.abs(prev)) * 100 : null;
                const isImproving = cmp != null && ((ck.betterWhen === 'higher' && cmp > 0) || (ck.betterWhen === 'lower' && cmp < 0));
                return { ...ck, val, tier, tierLabel: ck.verdict[tier] || '数据不足', indDiff, cmp, isImproving };
              });

              const strongCount = results.filter(r => r.tier === 0).length;

              return (
                <div key={opp.id} className={`bg-gradient-to-r ${opp.gradientFrom} to-[var(--bg-surface)] rounded-xl p-4 border border-[var(--border-color)]`}>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className={opp.color}>{opp.icon}</span>
                      <span className="text-[#FAFAF9] text-sm font-semibold">{opp.label}</span>
                    </div>
                    {strongCount > 0 && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-medium">{strongCount}项突出</span>
                    )}
                  </div>
                  <div className="space-y-2">
                    {results.map(r => (
                      <div key={r.codes.join('-')} className="bg-black/20 rounded-xl p-3">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[var(--text-secondary)] text-xs font-medium">{r.label}</span>
                          {r.val != null && (
                            <span className="text-[#FAFAF9] text-sm font-bold">
                              {r.codes.length > 1 ? `${fmtMetric(mv(['GROSS_MARGIN']))} - ${fmtMetric(mv(['NET_MARGIN']))} = ${fmtMetric(mv(['GROSS_MARGIN'])! - mv(['NET_MARGIN'])!)}%` : `${fmtMetric(r.val)}${r.unit}`}
                            </span>
                          )}
                        </div>
                        {r.val != null && (
                          <>
                            <div className={`text-xs font-medium ${r.tier === 0 ? 'text-emerald-400' : r.tier === 1 ? 'text-amber-400' : 'text-red-400'}`}>
                              {r.tierLabel}
                            </div>
                            <div className="flex items-center gap-3 mt-1 text-[10px]">
                              {r.indDiff != null && (
                                <span className={r.indDiff > 0 ? 'text-emerald-400' : r.indDiff < 0 ? 'text-red-400' : 'text-zinc-500'}>
                                  {r.indDiff > 0 ? '高于' : r.indDiff < 0 ? '低于' : '持平'}行业 {Math.abs(r.indDiff).toFixed(1)}
                                </span>
                              )}
                              {r.cmp != null && (
                                <span className={r.isImproving ? 'text-emerald-400' : 'text-red-400'}>
                                  同比{r.cmp > 0 ? '+' : ''}{r.cmp.toFixed(1)}% {r.isImproving ? '↗改善' : '↘恶化'}
                                </span>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            });
          })()}
        </div>
      )}

      {activeTab === 'insights' && (
        <div className="flex flex-col gap-3">
          {(() => {
            const mv = (codes: string[]) => { const hit = latestMetrics.find(m => codes.includes(m.metric_code)); return hit?.value == null ? null : Number(hit.value); };
            const prevV = (codes: string[]) => { for (const c of codes) { const v = prevMetricMap[c]; if (v != null && !Number.isNaN(v)) return Number(v); } return null; };
            const r = enterpriseRating;

            const gm = mv(['GROSS_MARGIN']);
            const nm = mv(['NET_MARGIN']);
            const roeV = mv(['ROE']);
            const roaV = mv(['ROA']);
            const dr = mv(['DEBT_ASSET']);
            const cr = mv(['CURRENT_RATIO']);
            const at = mv(['ASSET_TURNOVER']);
            const it = mv(['INVENTORY_TURNOVER']);
            const rt = mv(['RECEIVABLE_TURNOVER']);

            type InsightCard = { title: string; tier: 'strong'|'normal'|'weak'; data: string; verdict: string; detail: string };
            const cards: InsightCard[] = [];

            if (gm != null && nm != null) {
              const exp = gm - nm;
              const tier: InsightCard['tier'] = nm > 20 ? 'strong' : nm > 8 ? 'normal' : 'weak';
              const verdict = tier === 'strong' ? '优质盈利' : tier === 'normal' ? '盈利中等' : '盈利薄弱';
              const detail = tier === 'strong'
                ? `费用消耗${exp.toFixed(1)}%，利润留存率${(nm/gm*100).toFixed(0)}%，核心业务产出能力强`
                : tier === 'normal'
                  ? `费用率${exp.toFixed(1)}%，${exp > 40 ? '费用端有优化空间' : '费用结构可控'}，关注利润率趋势`
                  : `费用消耗${exp.toFixed(1)}%，净利率仅${nm.toFixed(1)}%，${nm < 3 ? '接近亏损边缘' : '盈利韧性不足'}`;
              cards.push({ title: '盈利质量', tier, data: `毛利率 ${gm.toFixed(1)}% | 净利率 ${nm.toFixed(1)}%`, verdict, detail });
            }

            if (roeV != null && roaV != null) {
              const leverage = roeV / Math.max(0.1, roaV);
              const isLeverageDriven = leverage > 3;
              const tier: InsightCard['tier'] = roeV > 15 && !isLeverageDriven ? 'strong' : roeV > 8 ? 'normal' : 'weak';
              const verdict = tier === 'strong' ? '健康回报' : tier === 'normal' ? '回报一般' : '回报不足';
              const detail = isLeverageDriven
                ? `ROE/ROA=${leverage.toFixed(1)}x，高ROE依赖杠杆放大(${leverage.toFixed(1)}x权益乘数)，经营回报率${roaV.toFixed(1)}%偏低`
                : `ROE由经营能力驱动(权益乘数${leverage.toFixed(1)}x)，盈利模式更可持续`;
              cards.push({ title: '资本效率', tier, data: `ROE ${roeV.toFixed(1)}% | ROA ${roaV.toFixed(1)}%`, verdict, detail });
            }

            if (dr != null && cr != null) {
              const tier: InsightCard['tier'] = dr < 40 && cr > 1.5 ? 'strong' : dr > 70 || cr < 1 ? 'weak' : 'normal';
              const verdict = tier === 'strong' ? '财务稳健' : tier === 'normal' ? '中等安全' : '财务承压';
              const detail = tier === 'strong'
                ? `负债率${dr.toFixed(1)}%+流动比率${cr.toFixed(2)}，抗风险+扩张能力兼备`
                : tier === 'normal'
                  ? `负债率${dr.toFixed(1)}%，流动比率${cr.toFixed(2)}，${dr > 55 ? '关注利息覆盖' : '结构尚可'}`
                  : `${dr > 70 ? `负债率${dr.toFixed(1)}%偏高，再融资风险` : ''}${cr < 1 ? `流动比率${cr.toFixed(2)}<1，短期偿债缺口` : ''}`;
              cards.push({ title: '财务安全', tier, data: `负债率 ${dr.toFixed(1)}% | 流动比率 ${cr.toFixed(2)}`, verdict, detail });
            }

            if (at != null || it != null || rt != null) {
              const cccDays = (it != null ? 365 / it : 0) + (rt != null ? 365 / rt : 0) - 0;
              const tier: InsightCard['tier'] = at != null && at >= 0.8 && (it != null ? it >= 6 : true) ? 'strong' : at != null && at >= 0.4 ? 'normal' : 'weak';
              const verdict = tier === 'strong' ? '运营高效' : tier === 'normal' ? '运营一般' : '运营低效';
              const parts: string[] = [];
              if (at != null) parts.push(`资产周转${at.toFixed(2)}次`);
              if (it != null) parts.push(`存货${(365/it).toFixed(0)}天`);
              if (rt != null) parts.push(`应收${(365/rt).toFixed(0)}天`);
              const detail = parts.join('、') + (tier === 'strong' ? '，周转快，资金效率高' : tier === 'normal' ? '，有改善空间' : '，周转慢影响现金流');
              cards.push({ title: '运营效率', tier, data: parts.join(' | '), verdict, detail });
            }

            const strongCount = cards.filter(c => c.tier === 'strong').length;
            const weakCount = cards.filter(c => c.tier === 'weak').length;
            const tierStyle = (t: InsightCard['tier']) => ({
              strong: { border: 'border-emerald-500/30', bg: 'bg-emerald-500/5', badge: 'bg-emerald-500/15 text-emerald-400', bar: 'bg-emerald-500' },
              normal: { border: 'border-amber-500/25', bg: 'bg-amber-500/5', badge: 'bg-amber-500/15 text-amber-400', bar: 'bg-amber-500' },
              weak: { border: 'border-red-500/25', bg: 'bg-red-500/5', badge: 'bg-red-500/15 text-red-400', bar: 'bg-red-500' },
            }[t]);

            return (
              <>
                {/* AI Rating Header */}
                <div className="bg-gradient-to-br from-[#6366F1]/20 to-[#16161A] rounded-2xl p-5 border border-[#6366F1]/30">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-xl bg-[#6366F1]/20 flex items-center justify-center">
                      <Brain size={20} className="text-[#6366F1]" />
                    </div>
                    <div className="flex-1">
                      <div className="text-[#FAFAF9] text-base font-semibold">AI 综合研判</div>
                      <div className="text-[var(--text-secondary)] text-xs">评级 {r.grade}（{r.total_score}/100）· {r.recommendation}</div>
                    </div>
                    <div className="text-right">
                      <div className={`text-3xl font-black ${r.total_score >= 60 ? 'text-emerald-400' : r.total_score >= 40 ? 'text-amber-400' : 'text-red-400'}`} style={{ textShadow: '0 0 20px rgba(99,102,241,0.3)' }}>
                        {r.grade}
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-4 gap-1.5">
                    {Object.entries(r.dim_summary).map(([label, d]) => (
                      <div key={label} className="bg-black/30 rounded-lg p-2 text-center">
                        <div className="text-[var(--text-muted)] text-[9px]">{label}</div>
                        <div className={`text-sm font-bold mt-0.5 ${d.pct >= 60 ? 'text-emerald-400' : d.pct >= 40 ? 'text-amber-400' : 'text-red-400'}`}>{d.pct}%</div>
                        <div className="mt-1 h-1 bg-black/30 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${d.pct >= 60 ? 'bg-emerald-500' : d.pct >= 40 ? 'bg-amber-500' : 'bg-red-500'}`} style={{ width: `${d.pct}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 4-dimension insight cards */}
                <div className="space-y-2">
                  {cards.map(card => {
                    const s = tierStyle(card.tier);
                    return (
                      <div key={card.title} className={`${s.bg} border ${s.border} rounded-xl p-4`}>
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-[#FAFAF9] text-sm font-semibold">{card.title}</span>
                          <span className={`text-[10px] px-2 py-0.5 rounded-full ${s.badge} font-medium`}>{card.verdict}</span>
                        </div>
                        <div className="text-[var(--text-secondary)] text-xs font-mono mb-1">{card.data}</div>
                        <div className="text-[var(--text-muted)] text-[11px] leading-relaxed">{card.detail}</div>
                      </div>
                    );
                  })}
                </div>

                {/* Investment Thesis - data-driven */}
                <div className="card-surface p-4">
                  <div className="text-[#FAFAF9] text-sm font-semibold mb-3">投资信号</div>
                  <div className="space-y-2">
                    {(() => {
                      const signals: { label: string; type: 'bull'|'bear'; text: string }[] = [];
                      if (roeV != null && roeV > 15) signals.push({ label: 'ROE优异', type: 'bull', text: `ROE ${roeV.toFixed(1)}% > 15%，资本回报能力强${roeV/roaV! > 3 ? '（注意杠杆驱动）' : ''}` });
                      if (gm != null && gm > 40) signals.push({ label: '定价权强', type: 'bull', text: `毛利率 ${gm.toFixed(1)}% > 40%，品牌/技术壁垒明显` });
                      if (nm != null && nm > 15) signals.push({ label: '利润率高', type: 'bull', text: `净利率 ${nm.toFixed(1)}% > 15%，盈利质量优` });
                      if (dr != null && dr < 30) signals.push({ label: '财务弹性', type: 'bull', text: `负债率 ${dr.toFixed(1)}% < 30%，融资空间充足` });
                      if (dr != null && dr > 65) signals.push({ label: '杠杆风险', type: 'bear', text: `负债率 ${dr.toFixed(1)}% > 65%，再融资/利率敏感` });
                      if (cr != null && cr < 1) signals.push({ label: '流动性风险', type: 'bear', text: `流动比率 ${cr.toFixed(2)} < 1，短期偿债缺口` });
                      if (nm != null && nm < 3) signals.push({ label: '盈利脆弱', type: 'bear', text: `净利率 ${nm.toFixed(1)}% < 3%，接近亏损` });
                      if (roeV != null && roeV < 5) signals.push({ label: '资本回报不足', type: 'bear', text: `ROE ${roeV.toFixed(1)}% < 5%，低于资本成本` });

                      if (signals.length === 0) {
                        return <div className="text-[var(--text-muted)] text-xs">指标数据不足以生成投资信号</div>;
                      }
                      return signals.map((sig, i) => (
                        <div key={i} className={`${sig.type === 'bull' ? 'bg-emerald-500/8' : 'bg-red-500/8'} rounded-xl p-3`}>
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className={`text-xs font-semibold ${sig.type === 'bull' ? 'text-emerald-400' : 'text-red-400'}`}>{sig.type === 'bull' ? '看多' : '风险'}</span>
                            <span className="text-[#FAFAF9] text-xs font-medium">{sig.label}</span>
                          </div>
                          <div className="text-[var(--text-secondary)] text-[11px]">{sig.text}</div>
                        </div>
                      ));
                    })()}

                    {/* Final recommendation */}
                    <div className="bg-[var(--bg-page)] rounded-xl p-3 mt-2">
                      <div className="text-[var(--text-muted)] text-xs font-semibold mb-1">综合建议</div>
                      <div className="text-[#FAFAF9] text-sm font-medium">{r.grade}（{r.total_score}/100）— {r.recommendation}</div>
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {r.strengths.map((s, i) => <span key={`s${i}`} className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400">{s}</span>)}
                        {r.risks.map((s, i) => <span key={`r${i}`} className="text-[10px] px-2 py-0.5 rounded-full bg-red-500/15 text-red-400">{s}</span>)}
                      </div>
                    </div>
                  </div>
                </div>
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}
