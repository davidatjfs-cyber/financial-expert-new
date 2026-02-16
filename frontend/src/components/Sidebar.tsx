'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import {
  Activity,
  LayoutDashboard,
  Search,
  Upload,
  FileText,
  Briefcase,
  AlertTriangle,
  TrendingUp,
} from 'lucide-react';

interface NavItem {
  href: string;
  icon: React.ReactNode;
  label: string;
}

const navItems: NavItem[] = [
  { href: '/', icon: <LayoutDashboard size={20} />, label: '仪表盘' },
  { href: '/stock', icon: <Search size={20} />, label: '股票' },
  { href: '/upload', icon: <Upload size={20} />, label: '上传' },
  { href: '/reports', icon: <FileText size={20} />, label: '报告' },
  { href: '/indicators', icon: <Briefcase size={20} />, label: '持仓' },
  { href: '/risk', icon: <AlertTriangle size={20} />, label: '预警' },
  { href: '/trends', icon: <TrendingUp size={20} />, label: '趋势' },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-[72px] h-full bg-[var(--bg-surface)] flex flex-col items-center py-5 px-2 gap-2 border-r border-[var(--border-color)] flex-shrink-0">
      {/* Logo */}
      <div className="w-10 h-10 rounded-[12px] bg-gradient-to-br from-[var(--accent-primary)] to-emerald-600 flex items-center justify-center shadow-lg shadow-emerald-500/20">
        <Activity size={20} className="text-white" />
      </div>
      
      {/* Divider */}
      <div className="w-9 h-px bg-[var(--border-color)] my-1" />
      
      {/* Navigation */}
      <nav className="flex flex-col gap-1.5">
        {navItems.map((item) => {
          const isActive = pathname === item.href || 
            (item.href !== '/' && pathname.startsWith(item.href));
          
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`w-[52px] h-[52px] rounded-[12px] flex flex-col items-center justify-center gap-0.5 transition-all duration-200 ${
                isActive
                  ? 'bg-[var(--accent-primary)] text-white shadow-lg shadow-emerald-500/25'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
              }`}
            >
              {item.icon}
              <span className="text-[9px] font-semibold leading-none">{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
