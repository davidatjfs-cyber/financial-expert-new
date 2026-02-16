interface PageHeaderProps {
  icon?: string;
  title: string;
  subtitle?: string;
}

export default function PageHeader({ icon, title, subtitle }: PageHeaderProps) {
  return (
    <div className="mb-5">
      <div className="flex items-center gap-2.5 mb-1.5">
        {icon && <span className="text-base">{icon}</span>}
        <h1 className="text-[var(--text-primary)] text-xl font-bold tracking-tight">{title}</h1>
      </div>
      {subtitle && (
        <p className="text-[var(--text-secondary)] text-sm">{subtitle}</p>
      )}
    </div>
  );
}
