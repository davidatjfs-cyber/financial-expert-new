'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, FileText, TrendingUp, AlertTriangle, Lightbulb, Brain, Download } from 'lucide-react';
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
    <div className="p-4 md:p-6 flex flex-col gap-4 max-w-2xl mx-auto pb-[calc(env(safe-area-inset-bottom,0px)+140px)] animate-fade-in">
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
          <div className="card-surface p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[#FAFAF9] text-sm font-semibold">核心指标（同比上一年）</div>
                <div className="text-[var(--text-secondary)] text-xs mt-1">左右滑动查看更多列</div>
              </div>
              <div className="text-[var(--text-secondary)] text-xs">期末：{report.period_end}</div>
            </div>

            <div className="overflow-x-auto -mx-4 px-4 mt-3">
              <table className="min-w-[720px] w-full border-separate border-spacing-y-2">
                <thead>
                  <tr className="text-left text-[var(--text-secondary)] text-xs">
                    <th className="px-3">指标</th>
                    <th className="px-3">本期</th>
                    <th className="px-3">单位</th>
                    <th className="px-3">上年同期</th>
                    <th className="px-3">同比</th>
                    <th className="px-3">解读</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="bg-[#0B0B0E]">
                    <td className="px-3 py-3 rounded-l-xl text-[#FAFAF9] text-sm">毛利率</td>
                    <td className="px-3 py-3 text-[#FAFAF9] text-sm">{fmtMetric(metricValue(grossMargin))}%</td>
                    <td className="px-3 py-3 text-[#6B6B70] text-sm">%</td>
                    <td className="px-3 py-3 text-[#6B6B70] text-sm">{fmtMetric(prevGrossMargin)}%</td>
                    <td className="px-3 py-3">{(() => { const cmp = compareYoY(metricValue(grossMargin), prevGrossMargin); return cmp.hasValue ? diffBadge(cmp, 'higher') : '-'; })()}</td>
                    <td className="px-3 py-3 rounded-r-xl text-[#6B6B70] text-sm">产品/服务定价与成本控制能力</td>
                  </tr>
                  <tr className="bg-[#0B0B0E]">
                    <td className="px-3 py-3 rounded-l-xl text-[#FAFAF9] text-sm">净利率</td>
                    <td className="px-3 py-3 text-[#FAFAF9] text-sm">{fmtMetric(metricValue(netMargin))}%</td>
                    <td className="px-3 py-3 text-[#6B6B70] text-sm">%</td>
                    <td className="px-3 py-3 text-[#6B6B70] text-sm">{fmtMetric(prevNetMargin)}%</td>
                    <td className="px-3 py-3">{(() => { const cmp = compareYoY(metricValue(netMargin), prevNetMargin); return cmp.hasValue ? diffBadge(cmp, 'higher') : '-'; })()}</td>
                    <td className="px-3 py-3 rounded-r-xl text-[#6B6B70] text-sm">费用结构与经营效率综合体现</td>
                  </tr>
                  <tr className="bg-[#0B0B0E]">
                    <td className="px-3 py-3 rounded-l-xl text-[#FAFAF9] text-sm">ROE</td>
                    <td className="px-3 py-3 text-[#FAFAF9] text-sm">{fmtMetric(metricValue(roe))}%</td>
                    <td className="px-3 py-3 text-[#6B6B70] text-sm">%</td>
                    <td className="px-3 py-3 text-[#6B6B70] text-sm">{fmtMetric(prevRoe)}%</td>
                    <td className="px-3 py-3">{(() => { const cmp = compareYoY(metricValue(roe), prevRoe); return cmp.hasValue ? diffBadge(cmp, 'higher') : '-'; })()}</td>
                    <td className="px-3 py-3 rounded-r-xl text-[#6B6B70] text-sm">股东资本回报能力（杜邦核心）</td>
                  </tr>
                  <tr className="bg-[#0B0B0E]">
                    <td className="px-3 py-3 rounded-l-xl text-[#FAFAF9] text-sm">ROA</td>
                    <td className="px-3 py-3 text-[#FAFAF9] text-sm">{fmtMetric(metricValue(roa))}%</td>
                    <td className="px-3 py-3 text-[#6B6B70] text-sm">%</td>
                    <td className="px-3 py-3 text-[#6B6B70] text-sm">{fmtMetric(prevRoa)}%</td>
                    <td className="px-3 py-3">{(() => { const cmp = compareYoY(metricValue(roa), prevRoa); return cmp.hasValue ? diffBadge(cmp, 'higher') : '-'; })()}</td>
                    <td className="px-3 py-3 rounded-r-xl text-[#6B6B70] text-sm">资产创造利润的效率</td>
                  </tr>
                  <tr className="bg-[#0B0B0E]">
                    <td className="px-3 py-3 rounded-l-xl text-[#FAFAF9] text-sm">流动比率</td>
                    <td className="px-3 py-3 text-[#FAFAF9] text-sm">{fmtMetric(metricValue(currentRatio))}</td>
                    <td className="px-3 py-3 text-[#6B6B70] text-sm">倍</td>
                    <td className="px-3 py-3 text-[#6B6B70] text-sm">{fmtMetric(prevCurrentRatio)}</td>
                    <td className="px-3 py-3">{(() => { const cmp = compareYoY(metricValue(currentRatio), prevCurrentRatio); return cmp.hasValue ? diffBadge(cmp, 'higher') : '-'; })()}</td>
                    <td className="px-3 py-3 rounded-r-xl text-[#6B6B70] text-sm">短期偿债安全边际</td>
                  </tr>
                  <tr className="bg-[#0B0B0E]">
                    <td className="px-3 py-3 rounded-l-xl text-[#FAFAF9] text-sm">速动比率</td>
                    <td className="px-3 py-3 text-[#FAFAF9] text-sm">{fmtMetric(metricValue(quickRatio))}</td>
                    <td className="px-3 py-3 text-[#6B6B70] text-sm">倍</td>
                    <td className="px-3 py-3 text-[#6B6B70] text-sm">{fmtMetric(prevQuickRatio)}</td>
                    <td className="px-3 py-3">{(() => { const cmp = compareYoY(metricValue(quickRatio), prevQuickRatio); return cmp.hasValue ? diffBadge(cmp, 'higher') : '-'; })()}</td>
                    <td className="px-3 py-3 rounded-r-xl text-[#6B6B70] text-sm">剔除存货后的短债覆盖</td>
                  </tr>
                  <tr className="bg-[#0B0B0E]">
                    <td className="px-3 py-3 rounded-l-xl text-[#FAFAF9] text-sm">资产负债率</td>
                    <td className="px-3 py-3 text-[#FAFAF9] text-sm">{fmtMetric(metricValue(debtRatio))}%</td>
                    <td className="px-3 py-3 text-[#6B6B70] text-sm">%</td>
                    <td className="px-3 py-3 text-[#6B6B70] text-sm">{fmtMetric(prevDebtRatio)}%</td>
                    <td className="px-3 py-3">{(() => { const cmp = compareYoY(metricValue(debtRatio), prevDebtRatio); return cmp.hasValue ? diffBadge(cmp, 'lower') : '-'; })()}</td>
                    <td className="px-3 py-3 rounded-r-xl text-[#6B6B70] text-sm">杠杆水平与财务弹性</td>
                  </tr>
                  <tr className="bg-[#0B0B0E]">
                    <td className="px-3 py-3 rounded-l-xl text-[#FAFAF9] text-sm">总资产周转率</td>
                    <td className="px-3 py-3 text-[#FAFAF9] text-sm">{fmtMetric(metricValue(assetTurnover))}</td>
                    <td className="px-3 py-3 text-[#6B6B70] text-sm">次</td>
                    <td className="px-3 py-3 text-[#6B6B70] text-sm">{fmtMetric(prevAssetTurnover)}</td>
                    <td className="px-3 py-3">{(() => { const cmp = compareYoY(metricValue(assetTurnover), prevAssetTurnover); return cmp.hasValue ? diffBadge(cmp, 'higher') : '-'; })()}</td>
                    <td className="px-3 py-3 rounded-r-xl text-[#6B6B70] text-sm">资产利用效率与周转速度</td>
                  </tr>
                  <tr className="bg-[#0B0B0E]">
                    <td className="px-3 py-3 rounded-l-xl text-[#FAFAF9] text-sm">存货周转率</td>
                    <td className="px-3 py-3 text-[#FAFAF9] text-sm">{fmtMetric(metricValue(inventoryTurnover))}</td>
                    <td className="px-3 py-3 text-[#6B6B70] text-sm">次</td>
                    <td className="px-3 py-3 text-[#6B6B70] text-sm">{fmtMetric(prevInventoryTurnover)}</td>
                    <td className="px-3 py-3">{(() => { const cmp = compareYoY(metricValue(inventoryTurnover), prevInventoryTurnover); return cmp.hasValue ? diffBadge(cmp, 'higher') : '-'; })()}</td>
                    <td className="px-3 py-3 rounded-r-xl text-[#6B6B70] text-sm">库存管理效率（缺行业数据）</td>
                  </tr>
                  <tr className="bg-[#0B0B0E]">
                    <td className="px-3 py-3 rounded-l-xl text-[#FAFAF9] text-sm">应收周转率</td>
                    <td className="px-3 py-3 text-[#FAFAF9] text-sm">{fmtMetric(metricValue(receivableTurnover))}</td>
                    <td className="px-3 py-3 text-[#6B6B70] text-sm">次</td>
                    <td className="px-3 py-3 text-[#6B6B70] text-sm">{fmtMetric(prevReceivableTurnover)}</td>
                    <td className="px-3 py-3">{(() => { const cmp = compareYoY(metricValue(receivableTurnover), prevReceivableTurnover); return cmp.hasValue ? diffBadge(cmp, 'higher') : '-'; })()}</td>
                    <td className="px-3 py-3 rounded-r-xl text-[#6B6B70] text-sm">回款与信用政策效果（缺行业数据）</td>
                  </tr>
                  <tr className="bg-[#0B0B0E]">
                    <td className="px-3 py-3 rounded-l-xl text-[#FAFAF9] text-sm">营业总收入</td>
                    <td className="px-3 py-3 text-[#FAFAF9] text-sm">{fmtAmount(metricValue(totalRevenue))}</td>
                    <td className="px-3 py-3 text-[#6B6B70] text-sm">元</td>
                    <td className="px-3 py-3 text-[#6B6B70] text-sm">{fmtAmount(prevRevenue)}</td>
                    <td className="px-3 py-3">{(() => { const cmp = compareYoY(metricValue(totalRevenue), prevRevenue); return cmp.hasValue ? diffBadge(cmp, 'higher') : '-'; })()}</td>
                    <td className="px-3 py-3 rounded-r-xl text-[#6B6B70] text-sm">规模增长与市场扩张能力</td>
                  </tr>
                  <tr className="bg-[#0B0B0E]">
                    <td className="px-3 py-3 rounded-l-xl text-[#FAFAF9] text-sm">经营现金流量净额</td>
                    <td className="px-3 py-3 text-[#FAFAF9] text-sm">{fmtAmount(metricValue(operatingCashFlow))}</td>
                    <td className="px-3 py-3 text-[#6B6B70] text-sm">元</td>
                    <td className="px-3 py-3 text-[#6B6B70] text-sm">{fmtAmount(prevOperatingCashFlow)}</td>
                    <td className="px-3 py-3">{(() => { const cmp = compareYoY(metricValue(operatingCashFlow), prevOperatingCashFlow); return cmp.hasValue ? diffBadge(cmp, 'higher') : '-'; })()}</td>
                    <td className="px-3 py-3 rounded-r-xl text-[#6B6B70] text-sm">盈利含金量与回款质量</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="card-surface p-4">
            <div className="text-[#FAFAF9] text-sm font-semibold">全部指标（按报告期）</div>
            <div className="text-[var(--text-secondary)] text-xs mt-1">支持横向滚动查看较长字段</div>
            <div className="overflow-x-auto -mx-4 px-4 mt-3">
              <table className="min-w-[680px] w-full border-separate border-spacing-y-2">
                <thead>
                  <tr className="text-left text-[var(--text-secondary)] text-xs">
                    <th className="px-3">指标</th>
                    <th className="px-3">值</th>
                    <th className="px-3">单位</th>
                    <th className="px-3">报告期</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.length > 0 ? metrics
                    .slice()
                    .sort((a, b) => (b.period_end || '').localeCompare(a.period_end || ''))
                    .map((m, idx) => (
                      <tr key={idx} className="bg-[#0B0B0E]">
                        <td className="px-3 py-3 rounded-l-xl text-[#FAFAF9] text-sm">{m.metric_name}</td>
                        <td className="px-3 py-3 text-[#FAFAF9] text-sm">{m.value == null ? '-' : m.value.toFixed(2)}</td>
                        <td className="px-3 py-3 text-[#6B6B70] text-sm">{m.unit || ''}</td>
                        <td className="px-3 py-3 rounded-r-xl text-[#6B6B70] text-sm">{m.period_end}</td>
                      </tr>
                    ))
                    : (
                      <tr className="bg-[#0B0B0E]">
                        <td className="px-3 py-3 rounded-xl text-[#6B6B70] text-sm" colSpan={4}>暂无财务指标数据</td>
                      </tr>
                    )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'risks' && (
        <div className="flex flex-col gap-3">
          {/* Professional Risk Framework */}
          <div className="card-surface p-4">
            <div className="text-[#FAFAF9] text-sm font-semibold">专业风险评估框架</div>
            <div className="text-[var(--text-secondary)] text-xs mt-1">参考穆迪/标普评级方法论，从六大维度系统评估企业风险</div>
          </div>

          {/* 1. DuPont Decomposition Risk */}
          <div className="card-surface p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-6 h-6 rounded bg-indigo-500/20 flex items-center justify-center text-xs font-bold text-indigo-400">1</div>
              <div className="text-[#FAFAF9] text-sm font-semibold">杜邦分解分析 (DuPont Analysis)</div>
            </div>
            <div className="text-[var(--text-muted)] text-xs mb-3">拆解ROE驱动因素：利润率 × 周转率 × 权益乘数，识别盈利质量风险</div>
            <div className="space-y-2">
              <div className="bg-[var(--bg-page)] rounded-[var(--radius-sm)] p-3">
                <div className="text-[var(--text-secondary)] text-xs font-medium">净利率驱动</div>
                <div className="text-[var(--text-secondary)] text-xs mt-1">
                  {metricValue(netMargin) != null
                    ? `净利率 ${fmtMetric(metricValue(netMargin))}%${metricValue(netMargin)! > industryAvg.netMargin ? '，高于行业均值，但需警惕是否依赖非经常性损益（资产处置、政府补贴、投资收益）支撑，这类利润不可持续。' : '，低于行业均值，表明费用控制或定价能力存在压力，需关注销售费用率、管理费用率的变动趋势。'}`
                    : '净利率数据缺失，无法进行杜邦分解。'}
                </div>
              </div>
              <div className="bg-[var(--bg-page)] rounded-[var(--radius-sm)] p-3">
                <div className="text-[var(--text-secondary)] text-xs font-medium">资产周转驱动</div>
                <div className="text-[var(--text-secondary)] text-xs mt-1">
                  {metricValue(assetTurnover) != null
                    ? `总资产周转率 ${fmtMetric(metricValue(assetTurnover))}${metricValue(assetTurnover)! < industryAvg.assetTurnover ? '，低于行业水平，可能存在产能过剩、固定资产利用率不足或应收/存货占比过高的问题，需结合资本开支计划评估。' : '，处于行业正常水平，资产利用效率尚可，但仍需关注是否存在商誉等无形资产虚增总资产的情况。'}`
                    : '周转率数据缺失。'}
                </div>
              </div>
              <div className="bg-[var(--bg-page)] rounded-[var(--radius-sm)] p-3">
                <div className="text-[var(--text-secondary)] text-xs font-medium">财务杠杆驱动</div>
                <div className="text-[var(--text-secondary)] text-xs mt-1">
                  {metricValue(debtRatio) != null
                    ? `资产负债率 ${fmtMetric(metricValue(debtRatio))}%，权益乘数约 ${(100 / Math.max(1, 100 - metricValue(debtRatio)!)).toFixed(2)}x。${metricValue(debtRatio)! > 60 ? '高杠杆虽可放大ROE，但在利率上行周期或营收下滑时，利息覆盖倍数可能快速恶化，形成"杠杆陷阱"。' : '杠杆水平适中，财务弹性较好，但需评估是否存在未充分利用低成本债务融资的机会成本。'}`
                    : '负债率数据缺失。'}
                </div>
              </div>
            </div>
          </div>

          {/* 2. Liquidity & Solvency */}
          <div className="card-surface p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-6 h-6 rounded bg-amber-500/20 flex items-center justify-center text-xs font-bold text-amber-400">2</div>
              <div className="text-[#FAFAF9] text-sm font-semibold">流动性与偿债能力 (Liquidity & Solvency)</div>
            </div>
            <div className="text-[var(--text-muted)] text-xs mb-3">参考Altman Z-Score模型思路，评估短期偿债安全边际与破产风险</div>
            <div className="space-y-2">
              <div className="bg-[var(--bg-page)] rounded-[var(--radius-sm)] p-3">
                <div className="text-[var(--text-secondary)] text-xs font-medium">短期偿债压力</div>
                <div className="text-[var(--text-secondary)] text-xs mt-1">
                  {metricValue(currentRatio) != null && metricValue(quickRatio) != null
                    ? `流动比率 ${fmtMetric(metricValue(currentRatio))}，速动比率 ${fmtMetric(metricValue(quickRatio))}。${metricValue(currentRatio)! < 1 ? '流动资产不足以覆盖流动负债，存在短期偿债缺口。若叠加应收账款回收周期延长，可能触发流动性危机。建议关注银行授信额度和短期融资渠道。' : metricValue(currentRatio)! > 3 ? '流动比率偏高，虽然偿债无忧，但大量资金闲置可能拉低资本回报率，存在资金使用效率问题。' : '短期偿债能力处于合理区间，但需持续监控应收账款账龄和存货跌价风险。'}`
                    : metricValue(currentRatio) != null
                      ? `流动比率 ${fmtMetric(metricValue(currentRatio))}。${metricValue(currentRatio)! < 1 ? '低于警戒线，短期偿债压力较大。' : '短期偿债能力尚可。'}`
                      : '流动性数据缺失，无法评估偿债能力。'}
                </div>
              </div>
              <div className="bg-[var(--bg-page)] rounded-[var(--radius-sm)] p-3">
                <div className="text-[var(--text-secondary)] text-xs font-medium">资本结构稳定性</div>
                <div className="text-[var(--text-secondary)] text-xs mt-1">
                  {metricValue(debtRatio) != null
                    ? `资产负债率 ${fmtMetric(metricValue(debtRatio))}%。${metricValue(debtRatio)! > 70 ? '高负债率意味着在经济下行期，企业可能面临银行抽贷、债券评级下调、再融资成本上升等连锁风险。参考标普评级方法论，负债率持续高于70%的企业通常面临投机级评级压力。' : metricValue(debtRatio)! < 30 ? '极低的负债率表明财务极为保守，几乎无债务违约风险，但可能未充分利用税盾效应和低成本融资优化资本结构。' : '负债率处于可控区间，建议关注有息负债占比、债务期限结构以及利息保障倍数的变化趋势。'}`
                    : '资本结构数据缺失。'}
                </div>
              </div>
            </div>
          </div>

          {/* 3. Operating Efficiency Risk */}
          <div className="card-surface p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-6 h-6 rounded bg-emerald-500/20 flex items-center justify-center text-xs font-bold text-emerald-400">3</div>
              <div className="text-[#FAFAF9] text-sm font-semibold">营运质量与周转风险 (Operating Quality)</div>
            </div>
            <div className="text-[var(--text-muted)] text-xs mb-3">参考麦肯锡价值驱动树模型，评估营运资本管理效率</div>
            <div className="space-y-2">
              <div className="bg-[var(--bg-page)] rounded-[var(--radius-sm)] p-3">
                <div className="text-[var(--text-secondary)] text-xs font-medium">存货管理风险</div>
                <div className="text-[var(--text-secondary)] text-xs mt-1">
                  {metricValue(inventoryTurnover) != null
                    ? `存货周转率 ${fmtMetric(metricValue(inventoryTurnover))} 次。${metricValue(inventoryTurnover)! < 4 ? '周转偏慢，可能面临存货跌价、产品过时或滞销风险。对于科技/消费品行业，存货周转率低于4次需重点关注库龄分布和跌价准备计提是否充分。' : '存货周转效率尚可，但仍需关注季节性波动和渠道库存压力。建议对比同行业竞争对手的周转水平。'}`
                    : '存货周转率数据缺失，无法评估库存管理效率。'}
                </div>
              </div>
              <div className="bg-[var(--bg-page)] rounded-[var(--radius-sm)] p-3">
                <div className="text-[var(--text-secondary)] text-xs font-medium">应收账款风险</div>
                <div className="text-[var(--text-secondary)] text-xs mt-1">
                  {metricValue(receivableTurnover) != null
                    ? `应收账款周转率 ${fmtMetric(metricValue(receivableTurnover))} 次（约 ${(365 / metricValue(receivableTurnover)!).toFixed(0)} 天回款周期）。${metricValue(receivableTurnover)! < 6 ? '回款周期超过60天，需警惕客户信用风险和坏账计提不足。建议关注前五大客户集中度和账龄超过1年的应收占比。' : '回款效率尚可，但仍需关注是否存在关联方交易虚增收入的情况。'}`
                    : '应收周转率数据缺失，无法评估回款风险。'}
                </div>
              </div>
            </div>
          </div>

          {/* 4. Growth Sustainability Risk */}
          <div className="card-surface p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-6 h-6 rounded bg-red-500/20 flex items-center justify-center text-xs font-bold text-red-400">4</div>
              <div className="text-[#FAFAF9] text-sm font-semibold">增长可持续性风险 (Growth Sustainability)</div>
            </div>
            <div className="text-[var(--text-muted)] text-xs mb-3">参考波士顿矩阵与可持续增长率(SGR)框架</div>
            <div className="bg-[var(--bg-page)] rounded-[var(--radius-sm)] p-3">
              <div className="text-[var(--text-secondary)] text-xs mt-1">
                {metricValue(roe) != null && metricValue(netMargin) != null && metricValue(grossMargin) != null
                  ? `ROE ${fmtMetric(metricValue(roe))}%，可持续增长率(SGR)约 ${fmtMetric(metricValue(roe)! * 0.7)}%（假设70%留存率）。${metricValue(grossMargin)! > 50 && metricValue(netMargin)! > 20 ? '作为高利润率企业，未来增长面临基数效应挑战——维持高增速需要不断开拓新市场或推出新产品线，否则增速将自然回落。参考BCG经验，毛利率超过50%的企业通常处于成熟期，需关注市场份额天花板。' : metricValue(netMargin)! < 5 ? '低利润率限制了内生增长能力，企业可能需要依赖外部融资支撑扩张，这将进一步推高杠杆水平。' : '盈利水平支撑一定的内生增长能力，但需关注行业竞争格局变化对利润率的侵蚀。'}`
                  : '关键盈利指标缺失，无法评估增长可持续性。建议补齐ROE、净利率等核心数据。'}
              </div>
            </div>
          </div>

          {/* Alert Details */}
          {alerts.length > 0 && (
            <div className="card-surface p-4">
              <div className="text-[#FAFAF9] text-sm font-semibold mb-3">系统风险预警明细</div>
              <div className="space-y-2">
                {alerts.map((alert) => {
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
          <div className="card-surface p-4">
            <div className="text-[#FAFAF9] text-sm font-semibold">投资机会识别框架</div>
            <div className="text-[var(--text-secondary)] text-xs mt-1">参考高盛/摩根士丹利研究方法论，从竞争壁垒、价值创造、资本优化三大维度识别机会</div>
          </div>

          {/* 1. Competitive Moat */}
          <div className="card-surface p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-6 h-6 rounded bg-emerald-500/20 flex items-center justify-center text-xs font-bold text-emerald-400">1</div>
              <div className="text-[#FAFAF9] text-sm font-semibold">竞争壁垒与护城河 (Competitive Moat)</div>
            </div>
            <div className="text-[var(--text-muted)] text-xs mb-3">参考晨星护城河评级体系，从定价权和成本优势评估竞争壁垒</div>
            <div className="space-y-2">
              <div className="bg-[var(--bg-page)] rounded-[var(--radius-sm)] p-3">
                <div className="text-[var(--text-secondary)] text-xs font-medium">定价权与品牌溢价</div>
                <div className="text-[var(--text-secondary)] text-xs mt-1">
                  {metricValue(grossMargin) != null
                    ? `毛利率 ${fmtMetric(metricValue(grossMargin))}%。${metricValue(grossMargin)! >= 40 ? '高毛利率（>40%）通常意味着企业拥有较强的品牌溢价、技术壁垒或网络效应。参考晨星"宽护城河"标准，持续高毛利率是竞争优势的核心体现，这类企业在经济下行期往往能更好地维持盈利。' : metricValue(grossMargin)! >= industryAvg.grossMargin ? '毛利率高于行业均值，表明具备一定的产品差异化或成本优势。若能持续维持，说明竞争壁垒有效。建议关注毛利率的年度变化趋势，稳定或上升趋势更有价值。' : '毛利率低于行业均值，但若企业正处于市场扩张期（以价换量），未来随着规模效应释放和产品结构升级，毛利率存在改善空间，这可能成为重要的利润弹性来源。'}`
                    : '毛利率数据缺失，无法评估定价权。'}
                </div>
              </div>
              <div className="bg-[var(--bg-page)] rounded-[var(--radius-sm)] p-3">
                <div className="text-[var(--text-secondary)] text-xs font-medium">成本效率优势</div>
                <div className="text-[var(--text-secondary)] text-xs mt-1">
                  {metricValue(netMargin) != null && metricValue(grossMargin) != null
                    ? `费用率（毛利率-净利率）约 ${fmtMetric(metricValue(grossMargin)! - metricValue(netMargin)!)}%。${(metricValue(grossMargin)! - metricValue(netMargin)!) < 20 ? '费用率控制良好（<20%），表明企业运营效率较高，管理层具备较强的成本管控能力。这种"精益运营"特质在行业整合期将成为重要竞争优势。' : '费用率偏高，但若企业正处于研发投入期或渠道扩张期，高费用率可能是为未来增长"播种"。建议区分资本化研发支出和费用化支出，评估投入产出效率。'}`
                    : '数据不足，无法评估费用效率。'}
                </div>
              </div>
            </div>
          </div>

          {/* 2. Value Creation */}
          <div className="card-surface p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-6 h-6 rounded bg-indigo-500/20 flex items-center justify-center text-xs font-bold text-indigo-400">2</div>
              <div className="text-[#FAFAF9] text-sm font-semibold">价值创造能力 (Value Creation)</div>
            </div>
            <div className="text-[var(--text-muted)] text-xs mb-3">参考EVA(经济增加值)和ROIC框架，评估企业是否在创造超额回报</div>
            <div className="space-y-2">
              <div className="bg-[var(--bg-page)] rounded-[var(--radius-sm)] p-3">
                <div className="text-[var(--text-secondary)] text-xs font-medium">股东价值创造</div>
                <div className="text-[var(--text-secondary)] text-xs mt-1">
                  {metricValue(roe) != null
                    ? `ROE ${fmtMetric(metricValue(roe))}%。${metricValue(roe)! > 20 ? '优秀的ROE（>20%）表明企业正在为股东创造显著超额回报。参考巴菲特选股标准，持续ROE>20%的企业通常具备"经济特许权"，是长期价值投资的理想标的。关键是判断高ROE的来源——利润率驱动优于杠杆驱动。' : metricValue(roe)! > industryAvg.roe ? `ROE高于行业均值${industryAvg.roe}%，资本回报效率较好。若ROE主要由利润率和周转率驱动（而非高杠杆），则盈利质量更高，具备长期复利潜力。` : `ROE低于行业均值${industryAvg.roe}%，但若企业正处于转型期或重资产投入期，未来随着产能释放和利润率改善，ROE存在较大提升空间——这正是"困境反转"型投资机会。`}`
                    : 'ROE数据缺失，无法评估价值创造能力。'}
                </div>
              </div>
              <div className="bg-[var(--bg-page)] rounded-[var(--radius-sm)] p-3">
                <div className="text-[var(--text-secondary)] text-xs font-medium">资产创利效率</div>
                <div className="text-[var(--text-secondary)] text-xs mt-1">
                  {metricValue(roa) != null
                    ? `ROA ${fmtMetric(metricValue(roa))}%。${metricValue(roa)! > industryAvg.roa ? '资产回报率高于行业水平，表明企业资产质量较好、运营效率较高。高ROA企业通常具备轻资产运营特征或强大的品牌变现能力。' : 'ROA低于行业水平，可能存在资产利用效率不足的问题。但若企业正在进行大规模资本开支（新建产能、并购整合），短期ROA下降可能是为长期增长蓄力。'}`
                    : 'ROA数据缺失。'}
                </div>
              </div>
            </div>
          </div>

          {/* 3. Capital Structure Optimization */}
          <div className="card-surface p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-6 h-6 rounded bg-amber-500/20 flex items-center justify-center text-xs font-bold text-amber-400">3</div>
              <div className="text-[#FAFAF9] text-sm font-semibold">资本结构优化空间 (Capital Optimization)</div>
            </div>
            <div className="text-[var(--text-muted)] text-xs mb-3">参考Modigliani-Miller理论和实务中的最优资本结构分析</div>
            <div className="space-y-2">
              <div className="bg-[var(--bg-page)] rounded-[var(--radius-sm)] p-3">
                <div className="text-[var(--text-secondary)] text-xs font-medium">杠杆优化机会</div>
                <div className="text-[var(--text-secondary)] text-xs mt-1">
                  {metricValue(debtRatio) != null
                    ? `资产负债率 ${fmtMetric(metricValue(debtRatio))}%。${metricValue(debtRatio)! < 40 ? '较低的负债率意味着企业拥有充足的"融资弹药"。在利率较低的环境下，适度增加杠杆可以利用税盾效应降低加权资本成本(WACC)，从而提升企业价值和股东回报。这是一个被市场低估的价值释放机会。' : metricValue(debtRatio)! < industryAvg.debtRatio ? '负债率低于行业均值，财务结构稳健，在行业整合或经济波动期具备更强的抗风险能力和并购扩张能力。' : '负债率高于行业均值，但若企业现金流稳定且利息覆盖充足，适度杠杆可以放大股东回报。关键是确保债务成本低于资产回报率(ROIC>WACC)。'}`
                    : '负债率数据缺失。'}
                </div>
              </div>
              <div className="bg-[var(--bg-page)] rounded-[var(--radius-sm)] p-3">
                <div className="text-[var(--text-secondary)] text-xs font-medium">营运资本释放</div>
                <div className="text-[var(--text-secondary)] text-xs mt-1">
                  {metricValue(inventoryTurnover) != null || metricValue(receivableTurnover) != null
                    ? `${metricValue(inventoryTurnover) != null ? `存货周转 ${fmtMetric(metricValue(inventoryTurnover))} 次` : ''}${metricValue(inventoryTurnover) != null && metricValue(receivableTurnover) != null ? '，' : ''}${metricValue(receivableTurnover) != null ? `应收周转 ${fmtMetric(metricValue(receivableTurnover))} 次` : ''}。通过供应链优化（JIT库存管理、供应商融资）和应收管理（缩短账期、应收保理）释放营运资本，可以在不增加外部融资的情况下改善现金流和资本效率。每提升1次周转率，相当于释放数月的营运资金。`
                    : '周转率数据缺失，无法评估营运资本优化空间。'}
                </div>
              </div>
            </div>
          </div>

          {/* Highlight Cards */}
          {metricValue(roe) != null && metricValue(roe)! > 15 && (
            <div className="bg-gradient-to-r from-emerald-950/40 to-[var(--bg-surface)] rounded-xl p-4 border border-emerald-500/30">
              <div className="flex items-start gap-3">
                <Lightbulb size={18} className="text-emerald-400 mt-0.5 flex-shrink-0" />
                <div>
                  <div className="text-emerald-400 text-sm font-semibold mb-1">核心亮点：优质资本回报</div>
                  <div className="text-[var(--text-secondary)] text-xs">ROE {metricValue(roe)!.toFixed(1)}% 显著高于行业水平，表明企业具备持续的价值创造能力。建议深入分析其竞争壁垒的可持续性。</div>
                </div>
              </div>
            </div>
          )}
          {metricValue(grossMargin) != null && metricValue(grossMargin)! > 40 && (
            <div className="bg-gradient-to-r from-indigo-950/40 to-[var(--bg-surface)] rounded-xl p-4 border border-indigo-500/30">
              <div className="flex items-start gap-3">
                <TrendingUp size={18} className="text-indigo-400 mt-0.5 flex-shrink-0" />
                <div>
                  <div className="text-indigo-400 text-sm font-semibold mb-1">核心亮点：强定价权</div>
                  <div className="text-[var(--text-secondary)] text-xs">毛利率 {metricValue(grossMargin)!.toFixed(1)}% 体现较强的品牌溢价或技术壁垒，这是长期竞争优势的重要信号。</div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'insights' && (
        <div className="flex flex-col gap-3">
          {/* AI Header */}
          <div className="bg-gradient-to-br from-[#6366F1]/20 to-[#16161A] rounded-2xl p-5 border border-[#6366F1]/30">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-[#6366F1]/20 flex items-center justify-center">
                <Brain size={20} className="text-[#6366F1]" />
              </div>
              <div>
                <div className="text-[#FAFAF9] text-base font-semibold">AI 综合研判</div>
                <div className="text-[var(--text-secondary)] text-xs">参考CFA研究框架，融合定量分析与定性判断</div>
              </div>
            </div>

            {metrics.length > 0 ? (
              <div className="space-y-4">
                {/* Financial Health Scorecard - 8-dimension */}
                <div>
                  <div className="text-[#FAFAF9] text-sm font-semibold mb-2">财务健康评分卡（8维评级）</div>
                  <div className="grid grid-cols-4 gap-2">
                    {Object.entries(enterpriseRating.dim_summary).map(([label, d]) => (
                      <div key={label} className="bg-black/30 rounded-lg p-2.5 text-center">
                        <div className="text-[var(--text-muted)] text-[10px]">{label}</div>
                        <div className={`text-base font-bold mt-1 ${d.pct >= 60 ? 'text-emerald-400' : d.pct >= 40 ? 'text-amber-400' : 'text-red-400'}`}>
                          {d.pct}%
                        </div>
                        <div className="mt-1 h-1 bg-black/30 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${d.pct >= 60 ? 'bg-emerald-500' : d.pct >= 40 ? 'bg-amber-500' : 'bg-red-500'}`}
                            style={{ width: `${d.pct}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Core Analysis */}
                <div className="space-y-3 text-sm text-[#FAFAF9]">
                  <div>
                    <div className="font-semibold mb-1">📊 盈利质量深度分析</div>
                    <div className="text-[var(--text-secondary)] text-xs leading-relaxed">
                      {grossMargin?.value != null && netMargin?.value != null
                        ? `毛利率 ${grossMargin.value.toFixed(1)}%，净利率 ${netMargin.value.toFixed(1)}%，费用消耗率 ${(grossMargin.value - netMargin.value).toFixed(1)}%。${netMargin.value > 20 ? '净利率超过20%属于优质盈利水平，参考标普500成分股数据，仅约15%的企业能持续达到此水平。需重点验证：(1)高利润是否来自核心业务而非一次性收益；(2)研发投入是否充足以维持技术壁垒；(3)毛利率趋势是否稳定或上升。' : netMargin.value > 10 ? '净利率处于中等偏上水平，盈利能力尚可。建议关注：(1)费用率是否有优化空间；(2)产品/服务结构是否向高附加值方向演进；(3)规模效应是否正在释放。' : '净利率偏低，盈利压力较大。需分析：(1)是行业特性（薄利多销）还是竞争力不足；(2)是否处于战略性亏损期（市场扩张/研发投入）；(3)成本端是否存在刚性约束。'}`
                        : '盈利数据不足，无法进行深度分析。'}
                    </div>
                  </div>

                  <div>
                    <div className="font-semibold mb-1">💰 杜邦分解与资本效率</div>
                    <div className="text-[var(--text-secondary)] text-xs leading-relaxed">
                      {roe?.value != null && roa?.value != null
                        ? `ROE ${roe.value.toFixed(1)}%（= 净利率 × 周转率 × 权益乘数），ROA ${roa.value.toFixed(1)}%。${roe.value > 15 && roa.value > 8 ? '高ROE且高ROA的组合表明企业通过经营能力而非财务杠杆创造回报，这是最健康的盈利模式。参考沃伦·巴菲特的投资哲学，这类企业通常具备"经济护城河"。' : roe.value > 15 && roa.value < 8 ? 'ROE较高但ROA偏低，说明高ROE主要依赖财务杠杆放大。这种模式在经济上行期表现亮眼，但在下行期风险会被同步放大。建议关注利息保障倍数和债务到期结构。' : 'ROE和ROA均处于一般水平，企业可能处于行业成熟期或转型期。建议从杜邦三因素中寻找最大改善空间——通常提升周转率的难度最低、见效最快。'}`
                        : '资本效率数据不足。'}
                    </div>
                  </div>

                  <div>
                    <div className="font-semibold mb-1">🏦 财务稳健性评估</div>
                    <div className="text-[var(--text-secondary)] text-xs leading-relaxed">
                      {debtRatio?.value != null && currentRatio?.value != null
                        ? `资产负债率 ${debtRatio.value.toFixed(1)}%，流动比率 ${currentRatio.value.toFixed(2)}。${debtRatio.value < 50 && currentRatio.value > 1.5 ? '财务结构稳健，短期偿债能力充足。这种"保守型"财务策略在经济不确定性增加时尤为珍贵——企业拥有充足的财务弹性应对突发风险或把握并购机会。' : debtRatio.value > 65 ? '负债率偏高，需密切关注：(1)有息负债占比和加权融资成本；(2)短期债务占比和再融资安排；(3)经营性现金流对利息支出的覆盖能力。参考穆迪评级方法论，持续高杠杆可能导致信用评级承压。' : '财务结构处于中等水平，建议关注债务期限结构和利率敏感性。在当前利率环境下，固定利率债务占比越高，利率风险越可控。'}`
                        : '财务健康数据不足。'}
                    </div>
                  </div>

                  <div>
                    <div className="font-semibold mb-1">⚙️ 运营效率与现金转化</div>
                    <div className="text-[var(--text-secondary)] text-xs leading-relaxed">
                      {metricValue(assetTurnover) != null
                        ? `总资产周转率 ${fmtMetric(metricValue(assetTurnover))}。${metricValue(inventoryTurnover) != null ? `存货周转 ${fmtMetric(metricValue(inventoryTurnover))} 次（${(365 / metricValue(inventoryTurnover)!).toFixed(0)}天）` : ''}${metricValue(receivableTurnover) != null ? `，应收周转 ${fmtMetric(metricValue(receivableTurnover))} 次（${(365 / metricValue(receivableTurnover)!).toFixed(0)}天）` : ''}。运营效率直接影响现金转化周期(CCC)——周转越快，企业对外部融资的依赖越低，自由现金流越充裕。建议对比同行业领先企业的周转水平，识别改善空间。`
                        : '运营效率数据不足，建议补齐周转率相关指标。'}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-[#6B6B70] text-sm">暂无足够数据生成AI洞察，请确保报告已完成分析。</p>
            )}
          </div>

          {/* Investment Thesis */}
          {metrics.length > 0 && (
            <div className="card-surface p-4">
              <h4 className="text-[#FAFAF9] text-sm font-semibold mb-3">💡 投资论点与建议</h4>
              <div className="space-y-2">
                {metricValue(roe) != null && metricValue(roe)! > 20 && (
                  <div className="bg-emerald-500/10 rounded-[var(--radius-sm)] p-3">
                    <div className="text-emerald-400 text-xs font-semibold">看多因素</div>
                    <div className="text-[var(--text-secondary)] text-xs mt-1">ROE {fmtMetric(metricValue(roe))}% 显著高于资本成本，企业正在为股东创造超额价值。若此水平可持续3年以上，通常意味着存在结构性竞争优势。</div>
                  </div>
                )}
                {metricValue(grossMargin) != null && metricValue(grossMargin)! > 40 && (
                  <div className="bg-emerald-500/10 rounded-[var(--radius-sm)] p-3">
                    <div className="text-emerald-400 text-xs font-semibold">看多因素</div>
                    <div className="text-[var(--text-secondary)] text-xs mt-1">高毛利率 {fmtMetric(metricValue(grossMargin))}% 体现强定价权，在通胀环境下具备成本转嫁能力，盈利韧性较强。</div>
                  </div>
                )}
                {metricValue(debtRatio) != null && metricValue(debtRatio)! > 65 && (
                  <div className="bg-red-500/10 rounded-[var(--radius-sm)] p-3">
                    <div className="text-red-400 text-xs font-semibold">风险因素</div>
                    <div className="text-[var(--text-secondary)] text-xs mt-1">高负债率 {fmtMetric(metricValue(debtRatio))}% 在利率上行周期可能侵蚀利润，需关注再融资风险和利息覆盖倍数变化。</div>
                  </div>
                )}
                {metricValue(currentRatio) != null && metricValue(currentRatio)! < 1.2 && (
                  <div className="bg-red-500/10 rounded-[var(--radius-sm)] p-3">
                    <div className="text-red-400 text-xs font-semibold">风险因素</div>
                    <div className="text-[var(--text-secondary)] text-xs mt-1">流动比率 {fmtMetric(metricValue(currentRatio))} 接近或低于警戒线，短期偿债安全边际不足，需关注现金流状况。</div>
                  </div>
                )}
                {metricValue(netMargin) != null && metricValue(netMargin)! > 15 && (
                  <div className="bg-emerald-500/10 rounded-[var(--radius-sm)] p-3">
                    <div className="text-emerald-400 text-xs font-semibold">看多因素</div>
                    <div className="text-[var(--text-secondary)] text-xs mt-1">净利率 {fmtMetric(metricValue(netMargin))}% 处于优秀水平，需验证是否来自核心业务的持续性盈利。</div>
                  </div>
                )}
                <div className="bg-[var(--bg-page)] rounded-[var(--radius-sm)] p-3">
                  <div className="text-[var(--text-muted)] text-xs font-semibold">综合建议</div>
                  <div className="text-[var(--text-secondary)] text-xs mt-1">
                    评级 {enterpriseRating.grade}（{enterpriseRating.total_score}/100）：{enterpriseRating.recommendation}
                    {enterpriseRating.strengths.length > 0 && (
                      <span className="text-emerald-400 ml-2">优势：{enterpriseRating.strengths.join('、')}</span>
                    )}
                    {enterpriseRating.risks.length > 0 && (
                      <span className="text-red-400 ml-2">风险：{enterpriseRating.risks.join('、')}</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
