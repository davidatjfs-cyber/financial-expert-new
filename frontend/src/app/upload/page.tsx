'use client';

import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Upload, FileText, Check, X } from 'lucide-react';
import { uploadReport } from '@/services/api';

export default function UploadPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [companyName, setCompanyName] = useState('');
  const [market, setMarket] = useState<'CN' | 'HK' | 'US'>('US');
  const [symbol, setSymbol] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      setFile(selectedFile);
      setError('');
    }
  };

  const handleUpload = async () => {
    if (!file) {
      setError('请选择文件');
      return;
    }
    // 公司名称可选，如果未填写则使用"待识别"

    setUploading(true);
    setError('');

    try {
      // 如果未填写公司名称，使用"待识别"
      const finalCompanyName = companyName.trim() || '待识别';
      // 报告期间自动设置为当前日期
      const today = new Date().toISOString().split('T')[0];
      await uploadReport(file, finalCompanyName, 'annual', today, market, symbol);
      router.push('/reports');
    } catch (err) {
      setError('上传失败，请重试');
      console.error('Upload error:', err);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="p-5 md:p-8 flex flex-col gap-6 max-w-2xl mx-auto animate-fade-in">
      {/* Header */}
      <div>
        <h1 className="text-[var(--text-primary)] text-xl md:text-2xl font-bold tracking-tight">上传财务报表</h1>
        <p className="text-[var(--text-secondary)] text-sm mt-1">支持PDF、Excel格式的财务报表文件</p>
      </div>

      {/* Upload Area */}
      <div 
        className="card-surface p-5 cursor-pointer"
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.xls,.xlsx"
          onChange={handleFileSelect}
          className="hidden"
        />
        <div className="border-2 border-dashed border-[var(--border-subtle)] rounded-[var(--radius-lg)] p-10 text-center">
          <div className="w-20 h-20 mx-auto mb-5 bg-[var(--bg-elevated)] rounded-[var(--radius-lg)] flex items-center justify-center">
            <Upload size={40} className="text-[var(--text-muted)]" />
          </div>
          <p className="text-[var(--text-primary)] text-lg font-medium mb-2">点击或拖拽文件到此处</p>
          <p className="text-[var(--text-secondary)] text-sm">支持 PDF、XLS、XLSX 格式</p>
        </div>
      </div>

      {/* Selected File */}
      <div className="card-surface p-5">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 bg-[var(--bg-elevated)] rounded-[var(--radius-md)] flex items-center justify-center">
            <FileText size={28} className={file ? 'text-emerald-400' : 'text-[var(--text-muted)]'} />
          </div>
          <div className="flex-1">
            {file ? (
              <div>
                <p className="text-[var(--text-primary)] text-base font-medium">{file.name}</p>
                <p className="text-[var(--text-secondary)] text-sm">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
              </div>
            ) : (
              <p className="text-[var(--text-secondary)] text-base">尚未选择文件</p>
            )}
          </div>
          {file && (
            <button onClick={() => setFile(null)} className="p-2">
              <X size={20} className="text-[var(--text-muted)]" />
            </button>
          )}
        </div>
      </div>

      {/* Company Info */}
      <div className="card-surface p-5">
        <h3 className="text-[var(--text-primary)] text-lg font-bold tracking-tight mb-4">公司信息（可选）</h3>
        <div>
          <label className="text-[var(--text-secondary)] text-sm font-medium mb-2 block">公司名称</label>
          <input
            type="text"
            placeholder="AI将自动从报表中识别..."
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            className="input-base"
          />
        </div>

        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="text-[var(--text-secondary)] text-sm font-medium mb-2 block">市场（可选）</label>
            <select
              value={market}
              onChange={(e) => setMarket(e.target.value as any)}
              className="input-base"
            >
              <option value="CN">CN</option>
              <option value="HK">HK</option>
              <option value="US">US</option>
            </select>
          </div>
          <div>
            <label className="text-[var(--text-secondary)] text-sm font-medium mb-2 block">股票代码（可选）</label>
            <input
              type="text"
              placeholder="例如 AAPL / 00700 / 600519"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              className="input-base"
            />
            <div className="text-[var(--text-muted)] text-xs mt-2">
              填写后可绑定公司，报告详情可显示“所属行业”。
            </div>
          </div>
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div className="bg-red-500/15 text-red-400 rounded-[var(--radius-md)] p-4 text-center text-sm font-medium">
          {error}
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex gap-3">
        <button 
          onClick={() => router.back()}
          className="flex-1 btn-secondary rounded-[var(--radius-md)] py-4 px-5 text-base"
        >
          取消
        </button>
        <button 
          onClick={handleUpload}
          disabled={uploading}
          className="flex-1 btn-primary rounded-[var(--radius-md)] py-4 px-5 text-base flex items-center justify-center gap-2 disabled:opacity-50"
        >
          {uploading ? (
            '上传中...'
          ) : (
            <>
              <Check size={22} />
              开始分析
            </>
          )}
        </button>
      </div>
    </div>
  );
}
