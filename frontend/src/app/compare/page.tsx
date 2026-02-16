'use client';

import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import { ArrowLeft } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { getReportMetrics, getReports, type Metric, type Report } from '@/services/api';

type CompareRow = {
  metric: string;
  company1: string;
  company2: string;
  highlight: 0 | 1 | 2;
};

const METRICS: Array<{ code: string; name: string; isPct?: boolean; higherIsBetter?: boolean }> = [
  { code: 'TOTAL_REVENUE', name: '营业总收入', isPct: false, higherIsBetter: true },
  { code: 'OPERATING_CASH_FLOW', name: '经营现金流量净额', isPct: false, higherIsBetter: true },
  { code: 'GROSS_MARGIN', name: '毛利率', isPct: true, higherIsBetter: true },
  { code: 'NET_MARGIN', name: '净利率', isPct: true, higherIsBetter: true },
  { code: 'ROE', name: 'ROE', isPct: true, higherIsBetter: true },
  { code: 'ROA', name: 'ROA', isPct: true, higherIsBetter: true },
  { code: 'CURRENT_RATIO', name: '流动比率', isPct: false, higherIsBetter: true },
  { code: 'QUICK_RATIO', name: '速动比率', isPct: false, higherIsBetter: true },
  { code: 'DEBT_ASSET', name: '资产负债率', isPct: true, higherIsBetter: false },
  { code: 'ASSET_TURNOVER', name: '总资产周转率', isPct: false, higherIsBetter: true },
  { code: 'INVENTORY_TURNOVER', name: '存货周转率', isPct: false, higherIsBetter: true },
  { code: 'RECEIVABLE_TURNOVER', name: '应收账款周转率', isPct: false, higherIsBetter: true },
];

export default function ComparePage() {
  const [reports, setReports] = useState<Report[]>([]);
  const [reportId1, setReportId1] = useState<string>('');
  const [reportId2, setReportId2] = useState<string>('');
  const [m1, setM1] = useState<Metric[]>([]);
  const [m2, setM2] = useState<Metric[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const r1 = useMemo(() => reports.find((r) => r.id === reportId1) || null, [reports, reportId1]);
  const r2 = useMemo(() => reports.find((r) => r.id === reportId2) || null, [reports, reportId2]);

  useEffect(() => {
    async function init() {
      setMessage('');
      try {
        const list = await getReports(50);
        setReports(list);
        if (list.length >= 2) {
          setReportId1(list[0].id);
          setReportId2(list[1].id);
        } else if (list.length === 1) {
          setReportId1(list[0].id);
        }
      } catch (e) {
        console.error(e);
        setMessage('加载报告列表失败');
      }
    }
    init();
  }, []);

  useEffect(() => {
    async function load() {
      if (!reportId1 || !reportId2 || reportId1 === reportId2) {
        return;
      }
      setLoading(true);
      setMessage('');
      try {
        const [a, b] = await Promise.all([getReportMetrics(reportId1), getReportMetrics(reportId2)]);
        setM1(a);
        setM2(b);
      } catch (e) {
        console.error(e);
        setM1([]);
        setM2([]);
        setMessage('加载对比指标失败');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [reportId1, reportId2]);

  const findMetric = (list: Metric[], code: string) => {
    const aliases: Record<string, string[]> = {
      TOTAL_REVENUE: ['TOTAL_REVENUE', 'IS.REVENUE'],
      OPERATING_CASH_FLOW: ['OPERATING_CASH_FLOW', 'CF.CFO'],
    };
    const codes = aliases[code] || [code];
    for (const c of codes) {
      const hit = list.find((m) => m.metric_code === c)?.value;
      if (hit != null) return hit;
    }
    return null;
  };
  const fmt = (v: number | null, isPct?: boolean) => {
    if (v == null || Number.isNaN(v)) return '-';
    return isPct ? `${Number(v).toFixed(2)}%` : `${Number(v).toFixed(2)}`;
  };

  const rows: CompareRow[] = useMemo(() => {
    const out: CompareRow[] = [];
    for (const m of METRICS) {
      const v1 = findMetric(m1, m.code);
      const v2 = findMetric(m2, m.code);
      let highlight: 0 | 1 | 2 = 0;
      if (v1 != null && v2 != null) {
        const higherIsBetter = m.higherIsBetter !== false;
        if (higherIsBetter) {
          highlight = v1 > v2 ? 1 : v2 > v1 ? 2 : 0;
        } else {
          highlight = v1 < v2 ? 1 : v2 < v1 ? 2 : 0;
        }
      }
      out.push({ metric: m.name, company1: fmt(v1, m.isPct), company2: fmt(v2, m.isPct), highlight });
    }
    return out;
  }, [m1, m2]);

  const download = (data: BlobPart, filename: string, mime: string) => {
    const blob = new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const exportCsv = () => {
    const header = ['指标', '公司1', '公司2'];
    const rows2 = rows.map((r) => [r.metric, r.company1, r.company2]);
    const esc = (s: any) => {
      const v = String(s ?? '');
      if (/[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
      return v;
    };
    const csv = [header, ...rows2].map((r) => r.map(esc).join(',')).join('\n');
    const name = `${(r1?.report_name || 'report1').slice(0, 12)}_vs_${(r2?.report_name || 'report2').slice(0, 12)}`;
    download(csv, `${name}.csv`, 'text/csv;charset=utf-8');
  };

  const exportHtml = () => {
    const rowsHtml = rows
      .map(
        (r) =>
          `<tr><td>${r.metric}</td><td>${r.company1}</td><td>${r.company2}</td></tr>`
      )
      .join('');
    const html = `<!doctype html><html><head><meta charset="utf-8" /><title>对比报告</title>
<style>body{font-family:Arial,Helvetica,sans-serif;padding:20px;} table{border-collapse:collapse;width:100%;} th,td{border:1px solid #ddd;padding:8px;} th{background:#f5f5f5;}</style>
</head><body><h2>多公司财务对比</h2><p>公司1：${r1?.report_name || '-'}</p><p>公司2：${r2?.report_name || '-'}</p><table><thead><tr><th>指标</th><th>公司1</th><th>公司2</th></tr></thead><tbody>${rowsHtml}</tbody></table></body></html>`;
    const name = `${(r1?.report_name || 'report1').slice(0, 12)}_vs_${(r2?.report_name || 'report2').slice(0, 12)}`;
    download(html, `${name}.html`, 'text/html;charset=utf-8');
  };

  return (
    <div className="p-4 md:p-6 max-w-4xl animate-fade-in">
      <PageHeader
        icon="📊"
        title="多公司财务对比"
        subtitle="对比多家公司的关键财务指标"
      />

      {/* Company Cards */}
      <div className="mb-5">
        <p className="text-[var(--text-secondary)] text-xs font-medium mb-2">对比公司:</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="card-surface p-4 !border-indigo-500/40">
            <div className="text-[var(--text-secondary)] text-xs font-medium mb-2">公司 1</div>
            <select
              value={reportId1}
              onChange={(e) => setReportId1(e.target.value)}
              className="input-base text-sm"
            >
              <option value="">请选择报告</option>
              {reports.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.report_name} - {r.period_end}
                </option>
              ))}
            </select>
            <div className="text-[var(--text-primary)] text-sm font-semibold mt-2 truncate">{r1?.report_name || '-'}</div>
            <div className="text-[var(--text-muted)] text-xs truncate">{r1?.period_end || '-'}</div>
          </div>

          <div className="card-surface p-4 !border-red-500/40">
            <div className="text-[var(--text-secondary)] text-xs font-medium mb-2">公司 2</div>
            <select
              value={reportId2}
              onChange={(e) => setReportId2(e.target.value)}
              className="input-base text-sm"
            >
              <option value="">请选择报告</option>
              {reports.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.report_name} - {r.period_end}
                </option>
              ))}
            </select>
            <div className="text-[var(--text-primary)] text-sm font-semibold mt-2 truncate">{r2?.report_name || '-'}</div>
            <div className="text-[var(--text-muted)] text-xs truncate">{r2?.period_end || '-'}</div>
          </div>
        </div>

        {message && (
          <div className="mt-2 text-red-400 text-xs">{message}</div>
        )}
      </div>

      {/* Comparison Table */}
      <div className="mb-5">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-sm">📋</span>
          <h2 className="section-title text-sm">指标对比表</h2>
        </div>

        <div className="flex gap-2.5 mb-3">
          <button
            onClick={exportCsv}
            disabled={loading || rows.length === 0}
            className="flex-1 btn-secondary !py-2.5 !px-4 text-sm !min-h-0"
          >
            ⬇️ 导出 CSV
          </button>
          <button
            onClick={exportHtml}
            disabled={loading || rows.length === 0}
            className="flex-1 btn-secondary !py-2.5 !px-4 text-sm !min-h-0"
          >
            ⬇️ 导出 HTML
          </button>
        </div>
        <div className="card-surface overflow-hidden !rounded-[var(--radius-md)]">
          {/* Header */}
          <div className="flex border-b border-[var(--border-color)] px-3 py-2.5 bg-[var(--bg-elevated)]">
            <div className="w-20 text-[var(--text-secondary)] text-xs font-medium">指标</div>
            <div className="flex-1 text-center text-indigo-400 text-xs font-medium truncate">{r1?.report_name || '公司1'}</div>
            <div className="flex-1 text-center text-red-400 text-xs font-medium truncate">{r2?.report_name || '公司2'}</div>
          </div>
          {/* Rows */}
          {rows.map((row, i) => (
            <div
              key={row.metric}
              className={`flex px-3 py-2.5 ${i < rows.length - 1 ? 'border-b border-[var(--border-color)]' : ''}`}
            >
              <div className="w-20 text-[var(--text-primary)] text-xs font-medium">{row.metric}</div>
              <div className={`flex-1 text-center text-xs font-medium ${row.highlight === 1 ? 'text-emerald-400' : (row.company1 === 'N/A' || row.company1 === '-') ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}>
                {row.company1}
              </div>
              <div className={`flex-1 text-center text-xs font-medium ${row.highlight === 2 ? 'text-emerald-400' : 'text-[var(--text-primary)]'}`}>
                {row.company2}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Radar Chart - SVG based */}
      <div className="mb-5">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-sm">📈</span>
          <h2 className="section-title text-sm">综合能力雷达图</h2>
        </div>
        <div className="card-surface p-4">
          <div className="flex items-center justify-center gap-4 mb-3">
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-full bg-indigo-400" />
              <span className="text-[var(--text-secondary)] text-xs truncate max-w-[100px]">{r1?.report_name || '公司1'}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-full bg-red-400" />
              <span className="text-[var(--text-secondary)] text-xs truncate max-w-[100px]">{r2?.report_name || '公司2'}</span>
            </div>
          </div>
          {(() => {
            const radarMetrics = [
              { code: 'GROSS_MARGIN', label: '盈利能力', max: 80 },
              { code: 'ROE', label: '资本效率', max: 40 },
              { code: 'CURRENT_RATIO', label: '偿债能力', max: 5 },
              { code: 'ASSET_TURNOVER', label: '运营效率', max: 3 },
              { code: 'DEBT_ASSET', label: '财务稳健', max: 100, invert: true },
            ];
            const n = radarMetrics.length;
            const cx = 150, cy = 140, R = 110;
            const angleStep = (2 * Math.PI) / n;
            const startAngle = -Math.PI / 2;

            const getPoint = (i: number, ratio: number) => {
              const angle = startAngle + i * angleStep;
              return { x: cx + R * ratio * Math.cos(angle), y: cy + R * ratio * Math.sin(angle) };
            };

            const gridLevels = [0.25, 0.5, 0.75, 1.0];

            const v1Ratios = radarMetrics.map(rm => {
              const v = findMetric(m1, rm.code);
              if (v == null) return 0;
              const val = rm.invert ? (rm.max - Number(v)) : Number(v);
              return Math.max(0, Math.min(1, val / rm.max));
            });
            const v2Ratios = radarMetrics.map(rm => {
              const v = findMetric(m2, rm.code);
              if (v == null) return 0;
              const val = rm.invert ? (rm.max - Number(v)) : Number(v);
              return Math.max(0, Math.min(1, val / rm.max));
            });

            const poly1 = v1Ratios.map((r, i) => getPoint(i, r));
            const poly2 = v2Ratios.map((r, i) => getPoint(i, r));

            return (
              <svg viewBox="0 0 300 290" className="w-full max-w-[320px] mx-auto">
                {/* Grid */}
                {gridLevels.map((level) => (
                  <polygon
                    key={level}
                    points={Array.from({ length: n }, (_, i) => getPoint(i, level)).map(p => `${p.x},${p.y}`).join(' ')}
                    fill="none"
                    stroke="var(--border-color)"
                    strokeWidth="0.5"
                    opacity={0.6}
                  />
                ))}
                {/* Axis lines */}
                {Array.from({ length: n }, (_, i) => {
                  const p = getPoint(i, 1);
                  return <line key={i} x1={cx} y1={cy} x2={p.x} y2={p.y} stroke="var(--border-color)" strokeWidth="0.5" opacity={0.4} />;
                })}
                {/* Company 1 polygon */}
                <polygon
                  points={poly1.map(p => `${p.x},${p.y}`).join(' ')}
                  fill="rgba(99,102,241,0.2)"
                  stroke="#6366F1"
                  strokeWidth="2"
                />
                {poly1.map((p, i) => (
                  <circle key={`c1-${i}`} cx={p.x} cy={p.y} r="3.5" fill="#6366F1" />
                ))}
                {/* Company 2 polygon */}
                <polygon
                  points={poly2.map(p => `${p.x},${p.y}`).join(' ')}
                  fill="rgba(248,113,113,0.15)"
                  stroke="#F87171"
                  strokeWidth="2"
                />
                {poly2.map((p, i) => (
                  <circle key={`c2-${i}`} cx={p.x} cy={p.y} r="3.5" fill="#F87171" />
                ))}
                {/* Labels */}
                {radarMetrics.map((rm, i) => {
                  const p = getPoint(i, 1.22);
                  const anchor = p.x < cx - 10 ? 'end' : p.x > cx + 10 ? 'start' : 'middle';
                  return (
                    <text key={rm.code} x={p.x} y={p.y} textAnchor={anchor} dominantBaseline="central" fill="var(--text-secondary)" fontSize="11" fontWeight="500">
                      {rm.label}
                    </text>
                  );
                })}
              </svg>
            );
          })()}
        </div>
      </div>

      {/* Bar Charts - data driven */}
      <div className="mb-5">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-sm">📊</span>
          <h2 className="section-title text-sm">关键指标柱状图对比</h2>
        </div>
        <div className="flex flex-col gap-3">
          {[
            { title: '盈利能力', items: [{ code: 'GROSS_MARGIN', label: '毛利率' }, { code: 'NET_MARGIN', label: '净利率' }, { code: 'ROE', label: 'ROE' }] },
            { title: '偿债与效率', items: [{ code: 'CURRENT_RATIO', label: '流动比率' }, { code: 'DEBT_ASSET', label: '负债率' }, { code: 'ASSET_TURNOVER', label: '周转率' }] },
          ].map((group) => (
            <div key={group.title} className="card-surface p-4">
              <p className="text-[var(--text-primary)] text-xs font-semibold mb-3">{group.title}</p>
              <div className="space-y-3">
                {group.items.map((item) => {
                  const v1 = findMetric(m1, item.code);
                  const v2 = findMetric(m2, item.code);
                  const max = Math.max(Math.abs(Number(v1) || 0), Math.abs(Number(v2) || 0), 1);
                  const w1 = v1 != null ? Math.max(4, (Math.abs(Number(v1)) / max) * 100) : 0;
                  const w2 = v2 != null ? Math.max(4, (Math.abs(Number(v2)) / max) * 100) : 0;
                  return (
                    <div key={item.code}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[var(--text-secondary)] text-[10px]">{item.label}</span>
                        <div className="flex gap-3 text-[10px]">
                          <span className="text-indigo-400">{v1 != null ? Number(v1).toFixed(1) : '-'}</span>
                          <span className="text-red-400">{v2 != null ? Number(v2).toFixed(1) : '-'}</span>
                        </div>
                      </div>
                      <div className="flex flex-col gap-1">
                        <div className="h-2.5 bg-[var(--bg-page)] rounded-full overflow-hidden">
                          <div className="h-full bg-indigo-500 rounded-full transition-all duration-500" style={{ width: `${w1}%` }} />
                        </div>
                        <div className="h-2.5 bg-[var(--bg-page)] rounded-full overflow-hidden">
                          <div className="h-full bg-red-400 rounded-full transition-all duration-500" style={{ width: `${w2}%` }} />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Back Button */}
      <Link
        href="/"
        className="btn-secondary flex items-center justify-center gap-2 text-sm !py-3"
      >
        <ArrowLeft size={16} />
        返回仪表盘
      </Link>
    </div>
  );
}
