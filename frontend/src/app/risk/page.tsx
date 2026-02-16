'use client';

import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { getAlertsSummary, getAllAlerts, type Alert, type AlertsSummary } from '@/services/api';

export default function RiskPage() {
  const [summary, setSummary] = useState<AlertsSummary>({ high: 0, medium: 0, low: 0 });
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const [summaryData, alertsData] = await Promise.all([
          getAlertsSummary(),
          getAllAlerts(undefined, 20),
        ]);
        setSummary(summaryData);
        setAlerts(alertsData);
      } catch (error) {
        console.error('Failed to fetch alerts:', error);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  return (
    <div className="p-5 md:p-8 flex flex-col gap-6 max-w-2xl mx-auto animate-fade-in">
      {/* Header */}
      <div>
        <h1 className="text-[var(--text-primary)] text-xl md:text-2xl font-bold tracking-tight">风险预警</h1>
        <p className="text-[var(--text-secondary)] text-sm mt-1">监控财务风险指标，及时发现潜在问题</p>
      </div>

      {/* Risk Stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="card-surface p-4 text-center">
          <div className="text-[var(--text-secondary)] text-xs font-medium mb-2">严重风险</div>
          <div className="text-red-400 text-3xl font-bold">{loading ? '-' : summary.high}</div>
          <div className="text-[var(--text-muted)] text-xs mt-2">个预警</div>
        </div>
        <div className="card-surface p-4 text-center">
          <div className="text-[var(--text-secondary)] text-xs font-medium mb-2">中等风险</div>
          <div className="text-amber-400 text-3xl font-bold">{loading ? '-' : summary.medium}</div>
          <div className="text-[var(--text-muted)] text-xs mt-2">个预警</div>
        </div>
        <div className="card-surface p-4 text-center">
          <div className="text-[var(--text-secondary)] text-xs font-medium mb-2">低风险</div>
          <div className="text-emerald-400 text-3xl font-bold">{loading ? '-' : summary.low}</div>
          <div className="text-[var(--text-muted)] text-xs mt-2">个预警</div>
        </div>
      </div>

      {/* Alerts List */}
      <div>
        <h2 className="section-title mb-2">风险预警列表</h2>
        <p className="text-[var(--text-secondary)] text-sm mb-4">点击查看详细风险分析</p>
        
        <div className="flex flex-col gap-3">
          {loading ? (
            <div className="card-surface p-10 text-center">
              <p className="text-[var(--text-secondary)] text-base">加载中...</p>
            </div>
          ) : alerts.length > 0 ? (
            alerts.map((alert) => {
              const riskColors = {
                high: { bg: 'bg-red-500/15', text: 'text-red-400', label: '高风险' },
                medium: { bg: 'bg-amber-500/15', text: 'text-amber-400', label: '中风险' },
                low: { bg: 'bg-emerald-500/15', text: 'text-emerald-400', label: '低风险' },
              };
              const risk = riskColors[alert.level];

              return (
                <div
                  key={alert.id}
                  className="card-surface p-4 flex items-center gap-4 active:scale-[0.99] transition-all duration-150"
                >
                  <div className={`w-11 h-11 rounded-[12px] ${risk.bg} flex items-center justify-center flex-shrink-0`}>
                    <span className={`text-lg ${risk.text}`}>⚠️</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[var(--text-primary)] text-[15px] font-semibold truncate">{alert.title}</span>
                      <span className={`px-2 py-0.5 rounded-md text-xs font-semibold ${risk.bg} ${risk.text}`}>
                        {risk.label}
                      </span>
                    </div>
                    <div className="text-[var(--text-secondary)] text-sm truncate">
                      {alert.message}
                    </div>
                  </div>
                  <ChevronRight size={20} className="text-[var(--text-muted)] flex-shrink-0" />
                </div>
              );
            })
          ) : (
            <div className="card-surface p-10 text-center">
              <p className="text-[var(--text-secondary)] text-base">暂无风险预警</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
