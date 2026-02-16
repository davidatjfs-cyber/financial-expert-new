"""
AI Tutor - 多学科智能辅导系统
平板优先 · 对话式学习 · 资深老师教学
"""

from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel
from typing import List, Optional, Literal
import os
import base64
import uuid
import asyncio
import httpx
from dotenv import load_dotenv

load_dotenv()

# Fix SSL certs for macOS + set DashScope API key at startup
try:
    import certifi
    os.environ['SSL_CERT_FILE'] = certifi.where()
except ImportError:
    pass

import dashscope
dashscope.api_key = os.getenv('OPENAI_API_KEY', '')

from ai_service import AITutorService

app = FastAPI(title="AI Tutor API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

os.makedirs("uploads", exist_ok=True)

# ─── 数据模型 ───

class ChatMessage(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: str
    image_url: Optional[str] = None

class ChatRequest(BaseModel):
    subject: str
    grade: str
    messages: List[ChatMessage]
    question_text: Optional[str] = None
    question_image_base64: Optional[str] = None
    help_level: Optional[str] = "guide"

class ChatResponse(BaseModel):
    message: ChatMessage

class OCRRequest(BaseModel):
    image_base64: str

# ─── 路由 ───

SUBJECTS = [
    {"id": "math", "name": "数学", "icon": "🔢", "color": "#4F8CFF", "description": "袋鼠数学·思维训练·计算能力"},
    {"id": "english", "name": "英语", "icon": "🔤", "color": "#FF6B9D", "description": "阅读理解·语法词汇·口语表达"},
    {"id": "chinese", "name": "语文", "icon": "📖", "color": "#FFB347", "description": "阅读理解·古诗文·写作训练"},
    {"id": "science", "name": "科学", "icon": "🔬", "color": "#51D88A", "description": "自然科学·实验探究·科学思维"},
]

GRADES = [
    {"id": "grade1", "name": "一年级"},
    {"id": "grade2", "name": "二年级"},
    {"id": "grade3", "name": "三年级"},
    {"id": "grade4", "name": "四年级"},
    {"id": "grade5", "name": "五年级"},
    {"id": "grade6", "name": "六年级"},
]

@app.get("/api/subjects")
async def get_subjects():
    return SUBJECTS

@app.get("/api/grades")
async def get_grades():
    return GRADES

@app.post("/api/upload-image")
async def upload_image(file: UploadFile = File(...)):
    """上传题目图片"""
    ext = file.filename.split(".")[-1] if file.filename else "jpg"
    filename = f"{uuid.uuid4().hex}.{ext}"
    filepath = os.path.join("uploads", filename)

    content = await file.read()
    with open(filepath, "wb") as f:
        f.write(content)

    image_base64 = base64.b64encode(content).decode("utf-8")

    ai_service = AITutorService()
    recognized_text = await ai_service.recognize_image(image_base64, ext)

    return {
        "filename": filename,
        "image_base64": image_base64,
        "recognized_text": recognized_text,
    }

@app.post("/api/ocr")
async def ocr_image(request: OCRRequest):
    """OCR识别图片中的题目"""
    ai_service = AITutorService()
    text = await ai_service.recognize_image(request.image_base64)
    return {"text": text}

@app.post("/api/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """AI辅导对话 - 核心接口"""
    ai_service = AITutorService()
    messages_dicts = [m.model_dump() for m in request.messages]
    response = await ai_service.tutor_chat(
        subject=request.subject,
        grade=request.grade,
        messages=messages_dicts,
        question_text=request.question_text,
        question_image_base64=request.question_image_base64,
        help_level=request.help_level or "guide",
    )
    return response

class TTSRequest(BaseModel):
    text: str
    voice: Optional[str] = "longanyang"

@app.post("/api/tts")
async def text_to_speech(request: TTSRequest):
    """高质量语音合成 - 使用阿里云CosyVoice WebSocket API"""
    from tts_service import synthesize

    voice = request.voice or 'longanyang'
    print(f'[TTS] Synthesizing with voice={voice}')

    try:
        audio_data = await synthesize(request.text, voice)
        print(f'[TTS] Success: {len(audio_data)} bytes')
        return Response(
            content=audio_data,
            media_type="audio/mpeg",
            headers={"Content-Disposition": "inline"},
        )
    except Exception as e:
        print(f'[TTS] Error: {e}')
        raise HTTPException(status_code=500, detail=f"TTS服务错误: {str(e)}")

@app.post("/api/stt")
async def speech_to_text(file: UploadFile = File(...)):
    """语音识别 - 前端录音上传，后端用DashScope Paraformer识别"""
    import tempfile
    import time
    import json

    api_key = os.getenv('OPENAI_API_KEY', '')
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="空音频文件")

    print(f'[STT] Received audio: {len(content)} bytes, type={file.content_type}')

    # Save to temp file
    ext = 'webm'
    if file.content_type:
        if 'wav' in file.content_type: ext = 'wav'
        elif 'mp3' in file.content_type: ext = 'mp3'
        elif 'ogg' in file.content_type: ext = 'ogg'
        elif 'mp4' in file.content_type or 'm4a' in file.content_type: ext = 'mp4'

    tmp_path = os.path.join("uploads", f"stt_{uuid.uuid4().hex}.{ext}")
    with open(tmp_path, "wb") as f:
        f.write(content)

    try:
        # Use DashScope Transcription API (async: submit + poll)
        async with httpx.AsyncClient(verify=False, timeout=30) as client:
            # Step 1: Submit task
            submit_resp = await client.post(
                "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                    "X-DashScope-Async": "enable",
                },
                json={
                    "model": "paraformer-v2",
                    "input": {"file_urls": [f"file://{os.path.abspath(tmp_path)}"]},
                    "parameters": {"language_hints": ["zh", "en"]},
                },
            )

            # If file:// doesn't work, try uploading via DashScope OSS
            if submit_resp.status_code != 200:
                print(f'[STT] File URL failed ({submit_resp.status_code}), trying base64 approach via qwen-audio')
                # Fallback: use qwen-audio-turbo for short audio recognition
                audio_b64 = base64.b64encode(content).decode('utf-8')
                mime = file.content_type or 'audio/webm'

                chat_resp = await client.post(
                    f"{os.getenv('OPENAI_API_BASE', 'https://dashscope.aliyuncs.com/compatible-mode/v1')}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": "qwen-audio-turbo",
                        "messages": [
                            {
                                "role": "user",
                                "content": [
                                    {"type": "input_audio", "input_audio": {"data": f"data:{mime};base64,{audio_b64}", "format": ext}},
                                    {"type": "text", "text": "请把这段语音的内容逐字转写出来，只输出语音内容本身，不要添加任何额外说明。"},
                                ],
                            }
                        ],
                    },
                    timeout=30,
                )

                if chat_resp.status_code == 200:
                    result = chat_resp.json()
                    text = result.get("choices", [{}])[0].get("message", {}).get("content", "")
                    print(f'[STT] qwen-audio result: {text}')
                    return {"text": text.strip()}
                else:
                    print(f'[STT] qwen-audio failed: {chat_resp.status_code} {chat_resp.text}')
                    raise HTTPException(status_code=500, detail="语音识别失败")

            task_id = submit_resp.json().get("output", {}).get("task_id")
            if not task_id:
                raise HTTPException(status_code=500, detail="语音识别任务提交失败")

            print(f'[STT] Task submitted: {task_id}')

            # Step 2: Poll for result (max 15 seconds)
            for _ in range(30):
                await asyncio.sleep(0.5)
                poll_resp = await client.get(
                    f"https://dashscope.aliyuncs.com/api/v1/tasks/{task_id}",
                    headers={"Authorization": f"Bearer {api_key}"},
                )
                if poll_resp.status_code == 200:
                    status = poll_resp.json().get("output", {}).get("task_status")
                    if status == "SUCCEEDED":
                        results = poll_resp.json().get("output", {}).get("results", [])
                        if results:
                            # Get transcription from result URL
                            result_url = results[0].get("transcription_url")
                            if result_url:
                                tr_resp = await client.get(result_url)
                                if tr_resp.status_code == 200:
                                    tr_data = tr_resp.json()
                                    texts = []
                                    for t in tr_data.get("transcripts", []):
                                        for s in t.get("sentences", []):
                                            texts.append(s.get("text", ""))
                                    text = "".join(texts)
                                    print(f'[STT] Result: {text}')
                                    return {"text": text}
                        return {"text": ""}
                    elif status in ("FAILED",):
                        print(f'[STT] Task failed: {poll_resp.text}')
                        raise HTTPException(status_code=500, detail="语音识别失败")

            raise HTTPException(status_code=504, detail="语音识别超时")

    except HTTPException:
        raise
    except Exception as e:
        print(f'[STT] Error: {e}')
        raise HTTPException(status_code=500, detail=f"语音识别错误: {str(e)}")
    finally:
        try:
            os.remove(tmp_path)
        except:
            pass

@app.get("/api/health")
async def health_check():
    return {"status": "healthy", "version": "2.0.0"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
