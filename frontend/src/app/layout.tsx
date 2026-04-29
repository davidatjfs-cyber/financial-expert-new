import type { Metadata, Viewport } from "next";
import "./globals.css";
import Sidebar from "@/components/Sidebar";
import MobileNav from "@/components/MobileNav";

export const metadata: Metadata = {
  title: "财务分析专家",
  description: "智能分析财务报表，洞察经营状况",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      </head>
      <body className="antialiased bg-[var(--bg-page)] text-[var(--text-primary)]">
        <div className="md:flex md:min-h-[100dvh]">
          {/* Sidebar - Desktop only */}
          <div className="hidden md:block">
            <Sidebar />
          </div>
          
          {/* Main Content */}
          <main className="md:flex-1" style={{ paddingBottom: '5rem' }}>
            {children}
          </main>
        </div>
        
        {/* Mobile Bottom Nav */}
        <MobileNav />
      </body>
    </html>
  );
}
