'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { LayoutDashboard, Search, FileText, Briefcase, PiggyBank } from 'lucide-react';

const mobileNavItems = [
  { href: '/', icon: <LayoutDashboard size={22} />, label: '首页' },
  { href: '/stock', icon: <Search size={22} />, label: '查询' },
  { href: '/reports', icon: <FileText size={22} />, label: '报告' },
  { href: '/indicators', icon: <Briefcase size={22} />, label: '持仓' },
  { href: '/returns', icon: <PiggyBank size={22} />, label: '收益' },
];

export default function MobileNav() {
  const pathname = usePathname();

  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 glass border-t border-[var(--border-color)] z-50 safe-area-pb">
      <div className="flex justify-around items-center h-[60px]">
        {mobileNavItems.map((item) => {
          const isActive = pathname === item.href ||
            (item.href !== '/' && pathname.startsWith(item.href));

          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex flex-col items-center justify-center gap-0.5 flex-1 h-full transition-colors duration-150 ${
                isActive
                  ? 'text-[var(--accent-primary)]'
                  : 'text-[var(--text-secondary)]'
              }`}
            >
              {item.icon}
              <span className="text-[10px] font-semibold">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
