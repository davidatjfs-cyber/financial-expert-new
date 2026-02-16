"""TTS Service - Microsoft Edge TTS (high quality, HTTP-based, no WebSocket needed)"""
import re
import asyncio
import edge_tts

VOICE_MAP = {
    'xiaoxiao': 'zh-CN-XiaoxiaoNeural',
    'xiaoyi': 'zh-CN-XiaoyiNeural',
    'yunjian': 'zh-CN-YunjianNeural',
    'yunxi': 'zh-CN-YunxiNeural',
    'yunxia': 'zh-CN-YunxiaNeural',
    'yunyang': 'zh-CN-YunyangNeural',
    'xiaobei': 'zh-CN-liaoning-XiaobeiNeural',
    'xiaoni': 'zh-CN-shaanxi-XiaoniNeural',
}

DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural'


def clean_text(t: str) -> str:
    t = re.sub(r'\*\*(.*?)\*\*', r'\1', t)
    t = re.sub(r'`([^`]+)`', r'\1', t)
    t = re.sub(r'[#>*\-]', '', t)
    t = re.sub(r'\n{2,}', '\n', t)
    t = re.sub(r'[\U0001F300-\U0001F9FF\U00002702-\U000027B0\U0000FE00-\U0000FE0F\U0000200D]+', '', t)
    return t.strip()


async def synthesize(text: str, voice: str = "xiaoxiao") -> bytes:
    ct = clean_text(text)
    if not ct:
        raise Exception("文本为空")

    voice_id = VOICE_MAP.get(voice, DEFAULT_VOICE)

    comm = edge_tts.Communicate(ct, voice_id, rate="+0%", pitch="+5Hz")
    chunks = []
    async for chunk in comm.stream():
        if chunk["type"] == "audio":
            chunks.append(chunk["data"])

    result = b"".join(chunks)
    if len(result) < 100:
        raise Exception("语音合成返回空数据")
    return result
