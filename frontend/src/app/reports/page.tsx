'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import ReportItem from '@/components/ReportItem';
import { Search } from 'lucide-react';
import { getReports, type Report } from '@/services/api';

export default function ReportsPage() {
  const router = useRouter();
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState('all');

  const formatDateTime = (tsSeconds: number) => {
    const d = new Date(tsSeconds * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  useEffect(() => {
    async function fetchReports() {
      try {
        const data = await getReports(50);
        setReports(data);
      } catch (error) {
        console.error('Failed to fetch reports:', error);
      } finally {
        setLoading(false);
      }
    }
    fetchReports();
  }, []);

  const filteredReports = reports.filter((report) => {
    const matchesSearch = report.report_name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesFilter = filter === 'all' || report.status === filter;
    return matchesSearch && matchesFilter;
  });

  return (
    <div className="p-5 md:p-8 flex flex-col gap-6 max-w-2xl mx-auto pb-24 animate-fade-in">
      {/* Header */}
      <div>
        <h1 className="text-[var(--text-primary)] text-xl md:text-2xl font-bold tracking-tight">分析报告</h1>
        <p className="text-[var(--text-secondary)] text-sm mt-1">查看所有已上传和分析的财务报表</p>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" size={20} />
        <input
          type="text"
          placeholder="搜索报告..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="input-base pl-14"
        />
      </div>

      {/* Filter Tabs */}
      <div className="flex gap-2.5 overflow-x-auto pb-1">
        {[
          { key: 'all', label: '全部' },
          { key: 'done', label: '已完成' },
          { key: 'running', label: '分析中' },
          { key: 'pending', label: '待识别' },
          { key: 'failed', label: '失败' },
        ].map((tab) => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key)}
            className={`px-4 py-2.5 rounded-[var(--radius-sm)] text-sm font-semibold whitespace-nowrap transition-all ${
              filter === tab.key
                ? 'bg-[var(--accent-primary)] text-[var(--bg-page)]'
                : 'bg-[var(--bg-surface)] text-[var(--text-secondary)] border border-[var(--border-color)]'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tip */}
      <div className="bg-indigo-500/10 rounded-[var(--radius-md)] p-4 border border-indigo-500/25">
        <p className="text-indigo-400 text-sm">
          💡 提示：通过"股票查询"获取的A股报告（如贵州茅台、五粮液）有完整的财务分析数据
        </p>
      </div>

      {/* Reports List */}
      <div className="flex flex-col gap-3">
        {loading ? (
          <div className="card-surface p-10 text-center">
            <p className="text-[var(--text-secondary)] text-base">加载中...</p>
          </div>
        ) : filteredReports.length > 0 ? (
          filteredReports.map((report) => (
            <ReportItem
              key={report.id}
              title={report.report_name}
              source={report.source_type === 'market_fetch' ? '市场数据' : '文件上传'}
              date={formatDateTime(report.created_at)}
              status={report.status}
              onClick={() => router.push(`/reports/${report.id}`)}
            />
          ))
        ) : (
          <div className="card-surface p-10 text-center">
            <p className="text-[var(--text-secondary)] text-base">没有找到匹配的报告</p>
          </div>
        )}
      </div>
    </div>
  );
}
