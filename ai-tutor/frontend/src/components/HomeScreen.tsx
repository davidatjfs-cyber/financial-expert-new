'use client'

import { useState } from 'react'
import type { Subject, SessionConfig } from '@/app/page'

const SUBJECTS: Subject[] = [
  { id: 'math', name: '数学', icon: '🔢', color: '#6366F1', description: '袋鼠数学 · 思维训练 · 计算能力' },
  { id: 'english', name: '英语', icon: '🔤', color: '#EC4899', description: '阅读理解 · 语法词汇 · 口语表达' },
  { id: 'chinese', name: '语文', icon: '📖', color: '#F59E0B', description: '阅读理解 · 古诗文 · 写作训练' },
  { id: 'science', name: '科学', icon: '🔬', color: '#10B981', description: '自然科学 · 实验探究 · 科学思维' },
]

const GRADES = ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级']

interface HomeScreenProps {
  onStart: (config: SessionConfig) => void
}

export default function HomeScreen({ onStart }: HomeScreenProps) {
  const [selectedSubject, setSelectedSubject] = useState<Subject | null>(null)
  const [selectedGrade, setSelectedGrade] = useState('三年级')

  return (
    <div className="min-h-screen flex flex-col bg-[#0F172A] relative overflow-hidden">
      {/* Animated background */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-96 h-96 rounded-full bg-indigo-500/10 blur-3xl" />
        <div className="absolute -bottom-40 -left-40 w-96 h-96 rounded-full bg-purple-500/10 blur-3xl" />
        <div className="absolute top-1/3 left-1/2 w-64 h-64 rounded-full bg-cyan-500/5 blur-3xl" />
      </div>

      <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-6 py-10 max-w-3xl mx-auto w-full">
        {/* Logo & Title */}
        <div className="text-center mb-12">
          <div className="relative inline-block mb-5">
            <div className="w-20 h-20 rounded-3xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-xl shadow-indigo-500/25">
              <span className="text-4xl">�</span>
            </div>
            <div className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-green-400 border-3 border-[#0F172A] flex items-center justify-center">
              <div className="w-2 h-2 rounded-full bg-white" />
            </div>
          </div>
          <h1 className="text-4xl font-extrabold text-white mb-3 tracking-tight">
            小智老师
          </h1>
          <p className="text-slate-400 text-lg font-light">
            AI 金牌辅导教练 · 一对一互动教学
          </p>
        </div>

        {/* Grade Selector */}
        <div className="mb-10 w-full">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-widest mb-3 text-center">
            选择年级
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {GRADES.map((g) => (
              <button
                key={g}
                onClick={() => setSelectedGrade(g)}
                className={`px-5 py-2.5 rounded-full text-sm font-medium transition-all duration-200 ${
                  selectedGrade === g
                    ? 'bg-white text-slate-900 shadow-lg shadow-white/10'
                    : 'bg-white/5 text-slate-400 border border-white/10 hover:bg-white/10 hover:text-white'
                }`}
              >
                {g}
              </button>
            ))}
          </div>
        </div>

        {/* Subject Cards */}
        <div className="grid grid-cols-2 gap-4 w-full mb-10">
          {SUBJECTS.map((subject) => {
            const isSelected = selectedSubject?.id === subject.id
            return (
              <button
                key={subject.id}
                onClick={() => setSelectedSubject(subject)}
                className={`relative p-5 rounded-2xl text-left transition-all duration-300 group ${
                  isSelected
                    ? 'scale-[1.02] shadow-2xl'
                    : 'hover:scale-[1.01] hover:shadow-lg'
                }`}
                style={{
                  background: isSelected
                    ? `linear-gradient(135deg, ${subject.color}25, ${subject.color}10)`
                    : 'rgba(255,255,255,0.04)',
                  border: isSelected
                    ? `2px solid ${subject.color}60`
                    : '2px solid rgba(255,255,255,0.06)',
                  boxShadow: isSelected ? `0 8px 32px ${subject.color}20` : undefined,
                }}
              >
                <div
                  className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl mb-3 transition-transform group-hover:scale-110"
                  style={{ background: `${subject.color}15` }}
                >
                  {subject.icon}
                </div>
                <h3 className="text-lg font-bold text-white mb-1">{subject.name}</h3>
                <p className="text-xs text-slate-500 leading-relaxed">{subject.description}</p>
                {isSelected && (
                  <div
                    className="absolute top-3 right-3 w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold shadow-lg"
                    style={{ background: subject.color }}
                  >
                    ✓
                  </div>
                )}
              </button>
            )
          })}
        </div>

        {/* Start Button */}
        <button
          disabled={!selectedSubject}
          onClick={() => selectedSubject && onStart({ subject: selectedSubject, grade: selectedGrade })}
          className={`w-full py-4 rounded-2xl text-lg font-bold transition-all duration-300 ${
            selectedSubject
              ? 'text-white shadow-xl hover:shadow-2xl active:scale-[0.98] hover:brightness-110'
              : 'bg-white/5 text-slate-600 cursor-not-allowed border border-white/5'
          }`}
          style={selectedSubject ? {
            background: `linear-gradient(135deg, ${selectedSubject.color}, ${selectedSubject.color}BB)`,
            boxShadow: `0 8px 32px ${selectedSubject.color}30`,
          } : {}}
        >
          {selectedSubject ? `开始学习 ${selectedSubject.name}` : '请先选择科目'}
        </button>

        {/* Feature badges */}
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          {['📸 拍照识题', '🎤 语音输入', '🔊 语音朗读', '💡 四步引导'].map((f) => (
            <span key={f} className="text-xs text-slate-500 bg-white/5 px-3 py-1.5 rounded-full border border-white/5">
              {f}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
