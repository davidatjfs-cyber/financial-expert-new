interface StatCardProps {
  icon: string;
  label: string;
  value: string | number;
  subtitle?: string;
}

export default function StatCard({ icon, label, value, subtitle }: StatCardProps) {
  return (
    <div className="card-surface p-4 hover:border-[var(--accent-primary)]/40 transition-all duration-200">
      <div className="flex items-center gap-2 text-[var(--text-secondary)] text-xs mb-3">
        <span>{icon}</span>
        <span className="font-medium">{label}</span>
      </div>
      <div className="text-[var(--text-primary)] text-2xl font-bold tracking-tight">{value}</div>
      {subtitle && (
        <div className="text-[var(--text-secondary)] text-xs mt-1.5">{subtitle}</div>
      )}
    </div>
  );
}
