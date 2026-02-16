---
description: AI Tutor 部署到阿里云ECS（docker compose + nginx）
---

# AI Tutor 部署工作流

## 服务器信息
- **IP**: 8.153.95.62
- **OS**: Ubuntu 22.04 64位
- **配置**: 2CPU / 4GB RAM / 80GB SSD
- **用户**: root
- **部署路径**: /opt/ai-tutor
- **访问地址**: http://8.153.95.62:8080

## 项目信息
- **本地路径**: /Users/xieding/windsure/CascadeProjects/windsurf-project/ai-tutor
- **技术栈**: FastAPI (Python 3.11) + Next.js (Node 20) + Nginx + Docker Compose
- **后端端口**: 8000 (内部)
- **前端端口**: 3000 (内部)
- **Nginx端口**: 8080 (外部，80被financial-expert占用)

## AI 模型配置
- **API Provider**: 阿里云 DashScope (通义千问)
- **API Base**: https://dashscope.aliyuncs.com/compatible-mode/v1
- **文本模型**: qwen-turbo
- **视觉模型**: qwen-vl-plus (用于图片识别)
- **TTS**: edge-tts (Microsoft Edge TTS, 无需API Key, HTTP协议)
- **TTS Voice**: xiaoxiao (zh-CN-XiaoxiaoNeural)
- **API Key 环境变量**: OPENAI_API_KEY (存放在服务器 /opt/ai-tutor/.env)

## 服务器 .env 文件内容模板
```
OPENAI_API_KEY=sk-58b59a56999a4e688d9fee958edbc82c
OPENAI_API_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1
AI_MODEL=qwen-turbo
AI_VISION_MODEL=qwen-vl-plus
```

## 部署步骤

### 1. 同步代码到服务器
// turbo
```bash
rsync -avz --exclude='node_modules' --exclude='.next' --exclude='__pycache__' --exclude='uploads/*' --exclude='.git' --exclude='.env' /Users/xieding/windsure/CascadeProjects/windsurf-project/ai-tutor/ root@8.153.95.62:/opt/ai-tutor/
```

### 2. SSH到服务器创建 .env（仅首次）
```bash
ssh root@8.153.95.62 "cat > /opt/ai-tutor/.env << 'EOF'
OPENAI_API_KEY=sk-58b59a56999a4e688d9fee958edbc82c
OPENAI_API_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1
AI_MODEL=qwen-turbo
AI_VISION_MODEL=qwen-vl-plus
EOF"
```

### 3. 确保服务器已安装 Docker（仅首次）
```bash
ssh root@8.153.95.62 "docker --version && docker compose version || (curl -fsSL https://get.docker.com | sh)"
```

### 4. 构建并启动服务
```bash
ssh root@8.153.95.62 "cd /opt/ai-tutor && docker compose up -d --build"
```

### 5. 检查服务状态
```bash
ssh root@8.153.95.62 "cd /opt/ai-tutor && docker compose ps && echo '---' && curl -s http://localhost/api/health"
```

### 6. 查看日志（排错用）
```bash
ssh root@8.153.95.62 "cd /opt/ai-tutor && docker compose logs --tail=50"
```

### 7. 重启服务
```bash
ssh root@8.153.95.62 "cd /opt/ai-tutor && docker compose restart"
```

### 8. 完全重建（代码变更后）
```bash
rsync -avz --exclude='node_modules' --exclude='.next' --exclude='__pycache__' --exclude='uploads/*' --exclude='.git' --exclude='.env' /Users/xieding/windsure/CascadeProjects/windsurf-project/ai-tutor/ root@8.153.95.62:/opt/ai-tutor/
ssh root@8.153.95.62 "cd /opt/ai-tutor && docker compose up -d --build"
```

## 核心功能
- **四步引导法**: 确认视线 → 拆解翻译 → 启发提问 → 复盘点赞
- **分学科教学**: 数学/英语/语文/科学各有专属引导策略
- **求助程度**: 小提示(hint) / 一起做(guide) / 讲思路(walkthrough)
- **语音朗读**: edge-tts 高质量中文语音 + 浏览器 SpeechSynthesis 兜底
- **语音输入**: 浏览器 Web Speech API 中文语音识别
- **图片识别**: qwen-vl-plus 视觉模型识别题目图片

## Docker镜像加速（已配置）
服务器 /etc/docker/daemon.json:
```json
{
  "registry-mirrors": [
    "https://docker.1ms.run",
    "https://docker.xuanyuan.me",
    "https://docker.rainbond.cc"
  ]
}
```

## 同服务器其他项目
- **financial-expert**: 占用端口80 (nginx)，路径 /opt/financial-expert

## 注意事项
- .env 文件不会被 rsync 同步（已排除），首次部署需手动创建
- uploads 目录使用 Docker named volume，不会被覆盖
- 前端 Next.js 使用 standalone 模式构建，体积小
- 后端 httpx 已设置 verify=False 以兼容特殊网络环境
- TTS 使用 edge-tts（HTTP协议），不依赖 WebSocket，网络兼容性好
