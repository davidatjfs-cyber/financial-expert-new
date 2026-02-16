# AI Tutor 智能辅导系统

## 项目结构

```
ai-tutor/
├── backend/          # FastAPI 后端
│   ├── main.py       # API入口
│   ├── database.py   # 数据库模型
│   ├── ai_service.py # AI服务
│   └── requirements.txt
├── frontend/         # Next.js 前端
│   ├── src/
│   ├── package.json
│   └── next.config.js
└── docker-compose.yml
```

## 快速启动

### 1. 启动后端

```bash
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
python main.py
```

### 2. 配置AI（可选）

创建 `backend/.env`：
```
OPENAI_API_KEY=your_api_key_here
OPENAI_API_BASE=https://api.openai.com/v1
AI_MODEL=gpt-4o-mini
```

### 3. 启动前端

```bash
cd frontend
npm install
npm run dev
```

## 功能特性

- 📚 多学科支持：数学、英语、语文
- 🤖 AI辅导老师：引导式教学，不直接给答案
- 💬 对话式学习：随时提问，即时解答
- 📊 学习进度追踪：记录练习情况
- 🎯 难度自适应：根据年级和水平调整

## 教学理念

AI辅导老师遵循以下原则：
1. **苏格拉底式提问** - 通过问题引导学生自己找到答案
2. **分步讲解** - 复杂问题拆成小步骤
3. **积极鼓励** - 建立孩子学习信心
4. **生活化** - 用孩子熟悉的场景举例
