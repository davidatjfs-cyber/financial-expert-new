import { ChevronRight } from 'lucide-react';

interface ReportItemProps {
  title: string;
  source: string;
  date: string;
  status: 'done' | 'running' | 'failed' | 'pending';
  onClick?: () => void;
}

const statusConfig = {
  done: { bg: 'bg-emerald-500/15', text: 'text-emerald-400', icon: '✓' },
  running: { bg: 'bg-amber-500/15', text: 'text-amber-400', icon: '◐' },
  failed: { bg: 'bg-red-400/15', text: 'text-red-400', icon: '✕' },
  pending: { bg: 'bg-zinc-500/15', text: 'text-zinc-400', icon: '○' },
};

export default function ReportItem({ title, source, date, status, onClick }: ReportItemProps) {
  const { bg, text, icon } = statusConfig[status];

  return (
    <div
      onClick={onClick}
      className="card-surface p-4 flex items-center gap-4 cursor-pointer active:scale-[0.99] transition-all duration-150"
    >
      {/* Status Icon */}
      <div className={`w-11 h-11 rounded-[12px] ${bg} flex items-center justify-center flex-shrink-0`}>
        <span className={`text-lg ${text}`}>{icon}</span>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="text-[var(--text-primary)] text-[15px] font-semibold truncate mb-0.5">{title}</div>
        <div className="text-[var(--text-secondary)] text-sm">
          {source} · {date}
        </div>
      </div>

      {/* Arrow */}
      <ChevronRight size={20} className="text-[var(--text-muted)] flex-shrink-0" />
    </div>
  );
}
