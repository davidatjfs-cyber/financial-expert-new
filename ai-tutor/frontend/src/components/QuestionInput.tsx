'use client'

import { useState, useRef, useCallback } from 'react'

interface QuestionInputProps {
  subjectColor: string
  onSubmit: (text: string, imageBase64?: string) => void
  onClose: () => void
}

type InputMode = 'menu' | 'camera' | 'text'

export default function QuestionInput({ subjectColor, onSubmit, onClose }: QuestionInputProps) {
  const [mode, setMode] = useState<InputMode>('menu')
  const [text, setText] = useState('')
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [imageBase64, setImageBase64] = useState<string | null>(null)
  const [recognizing, setRecognizing] = useState(false)
  const [recognizedText, setRecognizedText] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [streaming, setStreaming] = useState(false)
  const streamRef = useRef<MediaStream | null>(null)

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = async (ev) => {
      const dataUrl = ev.target?.result as string
      setImagePreview(dataUrl)
      const base64 = dataUrl.split(',')[1]
      setImageBase64(base64)
      setMode('text')
      await recognizeImage(base64)
    }
    reader.readAsDataURL(file)
  }, [])

  const startCamera = useCallback(async () => {
    setMode('camera')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        videoRef.current.play()
      }
      setStreaming(true)
    } catch (err) {
      alert('无法访问摄像头，请检查权限设置')
      setMode('menu')
    }
  }, [])

  const capturePhoto = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return

    const video = videoRef.current
    const canvas = canvasRef.current
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.drawImage(video, 0, 0)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
    setImagePreview(dataUrl)
    const base64 = dataUrl.split(',')[1]
    setImageBase64(base64)

    // Stop camera
    stopCamera()
    setMode('text')
    recognizeImage(base64)
  }, [])

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
    setStreaming(false)
  }, [])

  const recognizeImage = async (base64: string) => {
    setRecognizing(true)
    try {
      const res = await fetch('/api/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64: base64 }),
      })
      const data = await res.json()
      if (data.text && !data.text.startsWith('[')) {
        setRecognizedText(data.text)
        setText(data.text)
      }
    } catch (err) {
      console.error('OCR failed:', err)
    } finally {
      setRecognizing(false)
    }
  }

  const handleSubmit = () => {
    if (!text.trim() && !imageBase64) return
    onSubmit(text, imageBase64 || undefined)
  }

  const handleClose = () => {
    stopCamera()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center">
      <div className="bg-white w-full sm:w-[560px] sm:rounded-2xl rounded-t-2xl max-h-[90vh] overflow-hidden flex flex-col animate-[fadeInUp_0.25s_ease-out]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h2 className="text-lg font-bold text-gray-800">
            {mode === 'menu' ? '添加题目' : mode === 'camera' ? '拍照识别' : '确认题目'}
          </h2>
          <button onClick={handleClose} className="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center hover:bg-gray-200 transition">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {/* Menu Mode */}
          {mode === 'menu' && (
            <div className="grid grid-cols-1 gap-4">
              {/* Camera */}
              <button
                onClick={startCamera}
                className="flex items-center gap-4 p-5 rounded-2xl bg-gradient-to-r from-blue-50 to-cyan-50 border border-blue-100 hover:shadow-md transition text-left"
              >
                <div className="w-14 h-14 rounded-xl bg-blue-500 flex items-center justify-center flex-shrink-0">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                    <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
                    <circle cx="12" cy="13" r="4" />
                  </svg>
                </div>
                <div>
                  <h3 className="font-bold text-gray-800 text-base">📸 拍照识别</h3>
                  <p className="text-sm text-gray-500 mt-0.5">用摄像头拍下题目，AI自动识别</p>
                </div>
              </button>

              {/* Upload */}
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-4 p-5 rounded-2xl bg-gradient-to-r from-purple-50 to-pink-50 border border-purple-100 hover:shadow-md transition text-left"
              >
                <div className="w-14 h-14 rounded-xl bg-purple-500 flex items-center justify-center flex-shrink-0">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                </div>
                <div>
                  <h3 className="font-bold text-gray-800 text-base">📎 上传图片</h3>
                  <p className="text-sm text-gray-500 mt-0.5">从相册选择题目图片上传</p>
                </div>
              </button>

              {/* Text Input */}
              <button
                onClick={() => setMode('text')}
                className="flex items-center gap-4 p-5 rounded-2xl bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-100 hover:shadow-md transition text-left"
              >
                <div className="w-14 h-14 rounded-xl bg-amber-500 flex items-center justify-center flex-shrink-0">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </div>
                <div>
                  <h3 className="font-bold text-gray-800 text-base">✏️ 手动输入</h3>
                  <p className="text-sm text-gray-500 mt-0.5">直接打字输入题目内容</p>
                </div>
              </button>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleFileUpload}
              />
            </div>
          )}

          {/* Camera Mode */}
          {mode === 'camera' && (
            <div className="flex flex-col items-center">
              <div className="relative w-full rounded-2xl overflow-hidden bg-black aspect-[4/3]">
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover"
                />
                {!streaming && (
                  <div className="absolute inset-0 flex items-center justify-center text-white">
                    <span className="animate-pulse">正在启动摄像头...</span>
                  </div>
                )}
              </div>
              <canvas ref={canvasRef} className="hidden" />

              <div className="flex items-center gap-6 mt-6">
                <button
                  onClick={() => { stopCamera(); setMode('menu') }}
                  className="w-12 h-12 rounded-full bg-gray-200 flex items-center justify-center"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
                <button
                  onClick={capturePhoto}
                  disabled={!streaming}
                  className="w-16 h-16 rounded-full border-4 border-white shadow-lg flex items-center justify-center disabled:opacity-50"
                  style={{ background: subjectColor }}
                >
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                    <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
                    <circle cx="12" cy="13" r="4" />
                  </svg>
                </button>
                <div className="w-12 h-12" /> {/* Spacer */}
              </div>
            </div>
          )}

          {/* Text / Confirm Mode */}
          {mode === 'text' && (
            <div className="space-y-4">
              {/* Image Preview */}
              {imagePreview && (
                <div className="relative">
                  <img src={imagePreview} alt="题目图片" className="w-full rounded-xl border" />
                  {recognizing && (
                    <div className="absolute inset-0 bg-white/80 rounded-xl flex items-center justify-center">
                      <div className="flex items-center gap-2 text-blue-600">
                        <svg className="animate-spin w-5 h-5" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        <span className="text-sm font-medium">正在识别题目...</span>
                      </div>
                    </div>
                  )}
                  <button
                    onClick={() => { setImagePreview(null); setImageBase64(null); setRecognizedText('') }}
                    className="absolute top-2 right-2 w-8 h-8 rounded-full bg-black/50 flex items-center justify-center"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              )}

              {/* Text Area */}
              <div>
                <label className="text-sm font-medium text-gray-600 mb-2 block">
                  {imagePreview ? '识别结果（可编辑修改）' : '输入题目内容'}
                </label>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="在这里输入或粘贴题目内容...\n\n例如：小明有3个苹果，小红有5个苹果，他们一共有多少个苹果？"
                  rows={6}
                  className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-300 resize-none text-[15px] leading-relaxed"
                  autoFocus={!imagePreview}
                />
              </div>

              {/* No image? Show quick add buttons */}
              {!imagePreview && (
                <div className="flex gap-2">
                  <button
                    onClick={startCamera}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-50 text-blue-600 text-sm hover:bg-blue-100 transition"
                  >
                    📸 拍照
                  </button>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-purple-50 text-purple-600 text-sm hover:bg-purple-100 transition"
                  >
                    📎 上传图片
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleFileUpload}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        {mode === 'text' && (
          <div className="px-5 py-4 border-t bg-gray-50">
            <div className="flex gap-3">
              <button
                onClick={() => { setMode('menu'); setImagePreview(null); setImageBase64(null); setText(''); setRecognizedText('') }}
                className="flex-1 py-3 rounded-xl border border-gray-300 text-gray-600 font-medium hover:bg-gray-100 transition"
              >
                重新选择
              </button>
              <button
                onClick={handleSubmit}
                disabled={!text.trim() && !imageBase64}
                className="flex-[2] py-3 rounded-xl text-white font-bold transition active:scale-[0.98] disabled:opacity-40"
                style={{ background: subjectColor }}
              >
                开始辅导 🚀
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
