'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import type { Subject } from '@/app/page'
import QuestionInput from './QuestionInput'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  imageUrl?: string
  timestamp: Date
}

interface ChatScreenProps {
  subject: Subject
  grade: string
  onBack: () => void
}

export default function ChatScreen({ subject, grade, onBack }: ChatScreenProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [inputText, setInputText] = useState('')
  const [loading, setLoading] = useState(false)
  const [questionText, setQuestionText] = useState<string | null>(null)
  const [questionImage, setQuestionImage] = useState<string | null>(null)
  const [showQuestionInput, setShowQuestionInput] = useState(false)
  const [autoRead, setAutoRead] = useState(true)
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  const [ttsLoading, setTtsLoading] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [recordingText, setRecordingText] = useState('')
  const [helpLevel, setHelpLevel] = useState<'hint' | 'guide' | 'walkthrough'>('guide')
  const chatEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const autoReadRef = useRef(autoRead)
  const welcomeSpokenRef = useRef(false)
  const ttsAbortRef = useRef<AbortController | null>(null)
  // recognitionRef removed - now using MediaRecorder + backend STT

  // Keep ref in sync with state
  useEffect(() => {
    autoReadRef.current = autoRead
  }, [autoRead])

  // High-quality TTS using server-side Alibaba CosyVoice API
  const speak = useCallback(async (text: string, msgId: string) => {
    if (!text.trim()) return

    // Stop any current audio first
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.src = ''
      audioRef.current = null
    }
    if (ttsAbortRef.current) {
      ttsAbortRef.current.abort()
      ttsAbortRef.current = null
    }

    setSpeakingId(msgId)
    setTtsLoading(true)

    const abortController = new AbortController()
    ttsAbortRef.current = abortController

    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: 'xiaoxiao' }),
        signal: abortController.signal,
      })

      if (!res.ok) {
        const errText = await res.text()
        console.error('TTS API error:', res.status, errText)
        throw new Error('TTS failed')
      }

      const blob = await res.blob()
      if (blob.size < 100) {
        throw new Error('TTS returned empty audio')
      }

      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      audioRef.current = audio

      audio.onended = () => {
        setSpeakingId(null)
        setTtsLoading(false)
        URL.revokeObjectURL(url)
        audioRef.current = null
      }

      audio.onerror = () => {
        setSpeakingId(null)
        setTtsLoading(false)
        URL.revokeObjectURL(url)
        audioRef.current = null
      }

      await audio.play()
      setTtsLoading(false)
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return
      console.warn('Server TTS failed, falling back to browser TTS:', err)
      // Fallback to browser SpeechSynthesis
      try {
        const synth = window.speechSynthesis
        if (synth) {
          synth.cancel()
          const cleanText = text.replace(/\*\*(.*?)\*\*/g, '$1').replace(/[#>*\-`]/g, '').trim()
          const utter = new SpeechSynthesisUtterance(cleanText)
          utter.lang = 'zh-CN'
          utter.rate = 0.9
          utter.pitch = 1.1
          utter.onend = () => { setSpeakingId(null); setTtsLoading(false) }
          utter.onerror = () => { setSpeakingId(null); setTtsLoading(false) }
          synth.speak(utter)
          setTtsLoading(false)
          return
        }
      } catch (fallbackErr) {
        console.error('Browser TTS also failed:', fallbackErr)
      }
      setSpeakingId(null)
      setTtsLoading(false)
    }
  }, [])

  const stopSpeaking = useCallback(() => {
    if (ttsAbortRef.current) {
      ttsAbortRef.current.abort()
      ttsAbortRef.current = null
    }
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.src = ''
      audioRef.current = null
    }
    // Also stop browser TTS
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel()
    }
    setSpeakingId(null)
    setTtsLoading(false)
  }, [])

  // Send welcome message on mount (guard against StrictMode double-mount)
  useEffect(() => {
    const welcome: ChatMessage = {
      id: 'welcome',
      role: 'assistant',
      content: getWelcomeMessage(),
      timestamp: new Date(),
    }
    setMessages([welcome])

    if (!welcomeSpokenRef.current && autoReadRef.current) {
      welcomeSpokenRef.current = true
      const timer = setTimeout(() => speak(getWelcomeMessage(), 'welcome'), 1000)
      return () => clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Cleanup audio on unmount
  useEffect(() => {
    return () => {
      if (ttsAbortRef.current) {
        ttsAbortRef.current.abort()
      }
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current = null
      }
    }
  }, [])

  function getWelcomeMessage() {
    const greetings: Record<string, string> = {
      math: `你好呀！我是小智老师 👋\n\n今天我们一起来学**数学**！\n\n你可以：\n📸 **拍照** — 把不会的题拍给我\n📎 **上传图片** — 发题目图片给我\n✏️ **打字** — 直接告诉我题目\n\n不管什么题，我都会一步步引导你自己想出答案 💪\n\n准备好了吗？把题目发给我吧！`,
      english: `Hello! 我是小智老师 👋\n\n今天我们一起学**英语**！\n\n你可以把不会的题目拍照、上传或者打字告诉我。\n\n单词不会读？语法搞不懂？阅读理解看不明白？\n没关系，我会用最简单的方式帮你理解 😊\n\nAre you ready? 把题目发给我吧！`,
      chinese: `你好呀！我是小智老师 👋\n\n今天我们一起学**语文**！\n\n阅读理解、古诗词、写作文……\n不管遇到什么难题，我都会耐心引导你 📖\n\n把题目拍照、上传或者打字告诉我，\n我们一起来攻克它！✨`,
      science: `你好呀！我是小智老师 👋\n\n今天我们一起探索**科学**的奥秘！🔬\n\n生活中到处都是科学：\n为什么天是蓝的？水为什么会结冰？\n\n把你好奇的问题或者不会的题目告诉我，\n我们一起来寻找答案！🌟`,
    }
    return greetings[subject.id] || greetings.math
  }

  const sendMessage = useCallback(async (text: string, imageBase64?: string) => {
    if (!text.trim() && !imageBase64) return
    if (loading) return

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: text,
      imageUrl: imageBase64 ? `data:image/jpeg;base64,${imageBase64}` : undefined,
      timestamp: new Date(),
    }

    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setInputText('')
    setLoading(true)

    try {
      const apiMessages = newMessages
        .filter((m) => m.id !== 'welcome' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: m.content }))

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject: subject.id,
          grade,
          messages: apiMessages,
          question_text: questionText,
          question_image_base64: imageBase64 || questionImage,
          help_level: helpLevel,
        }),
      })

      const data = await res.json()

      const assistantMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: data.message?.content || '抱歉，我没有收到回复，请再试一次 😊',
        timestamp: new Date(),
      }

      setMessages([...newMessages, assistantMsg])

      // Auto-read AI response with high-quality voice
      if (autoReadRef.current) {
        speak(assistantMsg.content, assistantMsg.id)
      }
    } catch (err) {
      const errorMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: '网络好像出了点问题 😅 请检查一下网络连接，然后再试试？',
        timestamp: new Date(),
      }
      setMessages([...newMessages, errorMsg])
    } finally {
      setLoading(false)
    }
  }, [messages, loading, subject.id, grade, questionText, questionImage])

  const handleQuestionSubmit = (text: string, imageBase64?: string) => {
    setQuestionText(text)
    if (imageBase64) setQuestionImage(imageBase64)
    setShowQuestionInput(false)
    sendMessage(text || '请帮我看看这道题', imageBase64)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(inputText)
    }
  }

  // Voice input - MediaRecorder + backend STT (works on HTTP)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])

  const startRecording = useCallback(async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('你的浏览器不支持录音功能')
      return
    }

    stopSpeaking()

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm',
      })

      audioChunksRef.current = []

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data)
      }

      mediaRecorder.onstop = async () => {
        // Stop all tracks
        stream.getTracks().forEach(t => t.stop())

        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' })
        if (audioBlob.size < 1000) {
          setIsRecording(false)
          setRecordingText('')
          return
        }

        setRecordingText('正在识别语音...')

        try {
          const formData = new FormData()
          formData.append('file', audioBlob, 'recording.webm')

          const resp = await fetch('/api/stt', { method: 'POST', body: formData })
          if (resp.ok) {
            const data = await resp.json()
            const text = data.text || ''
            if (text.trim()) {
              setInputText(text.trim())
              setRecordingText(text.trim())
            } else {
              setRecordingText('没有识别到语音内容')
            }
          } else {
            setRecordingText('语音识别失败，请重试')
          }
        } catch (err) {
          console.error('STT error:', err)
          setRecordingText('语音识别出错')
        }

        setTimeout(() => {
          setIsRecording(false)
          setRecordingText('')
        }, 1500)
      }

      mediaRecorder.onerror = () => {
        stream.getTracks().forEach(t => t.stop())
        setIsRecording(false)
        setRecordingText('')
      }

      mediaRecorderRef.current = mediaRecorder
      mediaRecorder.start(250)
      setIsRecording(true)
      setRecordingText('正在录音，说完请点击停止...')
    } catch (err: any) {
      console.error('Mic error:', err)
      if (err.name === 'NotAllowedError') {
        alert('请允许使用麦克风权限')
      } else {
        alert('无法访问麦克风')
      }
    }
  }, [stopSpeaking])

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop()
      mediaRecorderRef.current = null
    }
  }, [])

  // Simple markdown-like rendering
  function renderContent(content: string) {
    const lines = content.split('\n')
    return lines.map((line, i) => {
      // Bold
      let processed = line.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      // Inline code
      processed = processed.replace(/`([^`]+)`/g, '<code>$1</code>')

      if (line.trim() === '') return <br key={i} />
      return (
        <p
          key={i}
          className="mb-1 leading-relaxed"
          dangerouslySetInnerHTML={{ __html: processed }}
        />
      )
    })
  }

  const helpLevels = [
    { id: 'hint' as const, label: '小提示', icon: '💡', desc: '一句话点拨' },
    { id: 'guide' as const, label: '一起做', icon: '🤝', desc: '四步引导' },
    { id: 'walkthrough' as const, label: '讲思路', icon: '📝', desc: '完整解析' },
  ]

  return (
    <div className="h-screen flex flex-col bg-[#0F172A]">
      {/* Premium Header */}
      <div className="relative px-4 py-3 border-b border-white/5"
        style={{ background: 'linear-gradient(135deg, rgba(15,23,42,0.95), rgba(30,41,59,0.95))' }}
      >
        <div className="flex items-center justify-between">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 transition text-slate-400 hover:text-white"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 18l-6-6 6-6" />
            </svg>
            <span className="text-sm">返回</span>
          </button>

          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-xl"
              style={{ background: `${subject.color}20` }}>
              {subject.icon}
            </div>
            <div>
              <h1 className="text-sm font-bold text-white">{subject.name} · {grade}</h1>
              <p className="text-[11px] text-slate-500">小智老师在线辅导中</p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={() => { setAutoRead(!autoRead); if (speakingId) stopSpeaking() }}
              className={`p-2 rounded-lg transition ${
                autoRead ? 'bg-emerald-500/15 text-emerald-400' : 'bg-white/5 text-slate-500'
              }`}
              title={autoRead ? '自动朗读已开启' : '自动朗读已关闭'}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                {autoRead ? (
                  <><path d="M15.54 8.46a5 5 0 010 7.07" /><path d="M19.07 4.93a10 10 0 010 14.14" /></>
                ) : (
                  <line x1="23" y1="9" x2="17" y2="15" />
                )}
              </svg>
            </button>
            <button
              onClick={() => setShowQuestionInput(true)}
              className="flex items-center gap-1 px-3 py-2 rounded-lg text-white text-xs font-medium transition hover:brightness-110 active:scale-95"
              style={{ background: subject.color }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              新题目
            </button>
          </div>
        </div>

        {/* Help Level Selector */}
        <div className="flex items-center gap-1 mt-2.5 bg-white/5 rounded-xl p-1">
          {helpLevels.map((level) => (
            <button
              key={level.id}
              onClick={() => setHelpLevel(level.id)}
              className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg text-xs font-medium transition-all ${
                helpLevel === level.id
                  ? 'bg-white/10 text-white shadow-sm'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              <span>{level.icon}</span>
              <span>{level.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Question Context Bar */}
      {questionText && (
        <div className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/10 flex items-center gap-2">
          <span className="text-amber-400 text-xs">📋</span>
          <span className="text-xs text-amber-300/80 truncate flex-1">{questionText.slice(0, 60)}...</span>
          <button
            onClick={() => { setQuestionText(null); setQuestionImage(null) }}
            className="text-[10px] text-amber-400 hover:text-amber-300 px-2 py-0.5 rounded bg-amber-500/10"
          >
            清除
          </button>
        </div>
      )}

      {/* Chat Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4" style={{ background: 'linear-gradient(180deg, #0F172A 0%, #1E293B 100%)' }}>
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            {msg.role === 'assistant' && (
              <div className="w-8 h-8 rounded-xl flex items-center justify-center mr-2 flex-shrink-0 mt-1 text-base"
                style={{ background: `${subject.color}20` }}>
                �
              </div>
            )}

            <div className={`max-w-[78%] ${msg.role === 'user' ? 'order-1' : ''}`}>
              {msg.imageUrl && (
                <div className="mb-2 rounded-xl overflow-hidden max-w-[280px]">
                  <img src={msg.imageUrl} alt="题目图片" className="w-full" />
                </div>
              )}
              <div
                className={`px-4 py-3 rounded-2xl text-[15px] leading-relaxed ${
                  msg.role === 'user'
                    ? 'rounded-br-md text-white'
                    : 'bg-white/[0.06] text-slate-200 rounded-bl-md border border-white/[0.06] backdrop-blur-sm'
                }`}
                style={msg.role === 'user' ? { background: subject.color } : {}}
              >
                <div className="chat-content">{renderContent(msg.content)}</div>
              </div>
              {/* TTS Button */}
              <button
                onClick={() => speakingId === msg.id ? stopSpeaking() : speak(msg.content, msg.id)}
                disabled={ttsLoading && speakingId !== msg.id}
                className={`mt-1 flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium transition ${
                  speakingId === msg.id
                    ? 'bg-white/10 text-white'
                    : ttsLoading
                    ? 'text-slate-600 cursor-not-allowed'
                    : 'text-slate-500 hover:text-white hover:bg-white/5 active:scale-95'
                }`}
              >
                {speakingId === msg.id && ttsLoading ? (
                  <><div className="w-3 h-3 border-2 border-white/40 border-t-transparent rounded-full animate-spin" /><span>加载...</span></>
                ) : speakingId === msg.id ? (
                  <><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg><span>停止</span></>
                ) : (
                  <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M15.54 8.46a5 5 0 010 7.07" /></svg><span>朗读</span></>
                )}
              </button>
            </div>

            {msg.role === 'user' && (
              <div className="w-8 h-8 rounded-xl bg-white/10 flex items-center justify-center ml-2 flex-shrink-0 mt-1 text-base">
                👦
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="w-8 h-8 rounded-xl flex items-center justify-center mr-2 flex-shrink-0 text-base"
              style={{ background: `${subject.color}20` }}>
              �
            </div>
            <div className="bg-white/[0.06] px-4 py-3 rounded-2xl rounded-bl-md border border-white/[0.06]">
              <div className="flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                <span className="text-xs text-slate-500 ml-1.5">思考中...</span>
              </div>
            </div>
          </div>
        )}

        <div ref={chatEndRef} />
      </div>

      {/* Recording Overlay */}
      {isRecording && (
        <div className="mx-4 mb-2 bg-white/[0.06] rounded-2xl border border-red-500/20 px-5 py-3 backdrop-blur-sm">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse" />
            <span className="text-sm font-medium text-red-400">正在听你说话...</span>
          </div>
          {recordingText ? (
            <p className="text-slate-200 text-[15px] leading-relaxed mb-2">{recordingText}</p>
          ) : (
            <p className="text-slate-500 text-sm mb-2">请对着麦克风说出你的问题</p>
          )}
          <button
            onClick={stopRecording}
            className="w-full py-2 rounded-xl bg-red-500/80 text-white text-sm font-medium hover:bg-red-500 active:scale-95 transition"
          >
            停止录音
          </button>
        </div>
      )}

      {/* Input Area */}
      <div className="border-t border-white/5 bg-[#0F172A] px-4 py-3 safe-bottom">
        <div className="flex items-end gap-2 max-w-4xl mx-auto">
          {/* Camera */}
          <button
            onClick={() => setShowQuestionInput(true)}
            className="flex-shrink-0 w-10 h-10 rounded-xl bg-white/5 hover:bg-white/10 flex items-center justify-center transition"
            title="拍照/上传题目"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2">
              <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
          </button>

          {/* Text input */}
          <div className="flex-1 relative">
            <textarea
              ref={inputRef}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="输入问题，或语音提问..."
              rows={1}
              className="w-full px-4 py-2.5 pr-12 bg-white/[0.06] border border-white/[0.08] rounded-2xl resize-none focus:outline-none focus:ring-1 focus:ring-white/20 focus:bg-white/[0.08] transition text-[15px] text-slate-200 placeholder-slate-600 max-h-32"
              style={{ minHeight: '42px' }}
            />
          </div>

          {/* Microphone */}
          <button
            onClick={isRecording ? stopRecording : startRecording}
            className={`flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition active:scale-95 ${
              isRecording
                ? 'bg-red-500 animate-pulse'
                : 'bg-white/5 hover:bg-white/10'
            }`}
            title={isRecording ? '停止录音' : '语音输入'}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={isRecording ? 'white' : '#94a3b8'} strokeWidth="2">
              <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
              <path d="M19 10v2a7 7 0 01-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          </button>

          {/* Send */}
          <button
            onClick={() => sendMessage(inputText)}
            disabled={(!inputText.trim() || loading) && !isRecording}
            className="flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition active:scale-95 disabled:opacity-30"
            style={{ background: inputText.trim() ? subject.color : 'rgba(255,255,255,0.05)' }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={inputText.trim() ? 'white' : '#475569'} strokeWidth="2">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
      </div>

      {/* Question Input Modal */}
      {showQuestionInput && (
        <QuestionInput
          subjectColor={subject.color}
          onSubmit={handleQuestionSubmit}
          onClose={() => setShowQuestionInput(false)}
        />
      )}
    </div>
  )
}
