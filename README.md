# Financial Expert - AI智能投资分析系统

Financial Expert是一个基于AI的智能投资分析系统，帮助投资者进行股票分析、财务报表解读和投资决策。

## 主要功能

### 1. 股票查询与分析
- 实时股票数据查询
- A股市场全面覆盖
- 技术指标分析
- 市场趋势预测

### 2. 财务报表分析
- PDF财务报表自动解析
- 关键财务指标提取
- 财务健康度评估
- 同行业对比分析

### 3. 智能投资建议
- AI驱动的投资策略
- 风险评估与预警
- 买入/卖出信号
- 投资组合优化

### 4. 数据可视化
- 交互式图表展示
- 多维度数据分析
- 趋势对比分析
- 自定义报表生成

## 技术栈

### 后端 (FastAPI)
- **框架**: FastAPI
- **数据库**: PostgreSQL
- **AI模型**: 通义千问 (Qwen)
- **数据源**: AkShare, yfinance
- **PDF处理**: PyMuPDF, pdfplumber

### 前端 (Next.js)
- **框架**: Next.js 15
- **UI库**: shadcn/ui, Tailwind CSS
- **图表**: Recharts
- **状态管理**: React Hooks

### Streamlit界面
- **框架**: Streamlit
- **可视化**: Plotly, Matplotlib
- **数据处理**: Pandas, NumPy

## 快速开始

### 环境要求
- Python 3.11+
- Node.js 18+
- PostgreSQL 14+

### 安装步骤

1. **克隆仓库**
```bash
git clone https://github.com/davidatjfs-cyber/financial-expert-new.git
cd financial-expert-new
```

2. **配置环境变量**
```bash
cp .env.example .env
# 编辑.env文件，填入必要的API密钥和数据库配置
```

3. **启动后端API**
```bash
pip install -r requirements-api.txt
python api.py
```

4. **启动Streamlit界面**
```bash
pip install -r requirements.txt
streamlit run app.py
```

5. **启动Next.js前端**
```bash
cd frontend
npm install
npm run dev
```

### Docker部署

```bash
docker-compose up -d
```

## 项目结构

```
financial-expert-new/
├── api.py                  # FastAPI后端服务
├── app.py                  # Streamlit主应用
├── core/                   # 核心业务逻辑
│   ├── financial_data.py   # 财务数据处理
│   ├── pdf_analyzer.py     # PDF分析引擎
│   ├── llm_qwen.py        # AI模型集成
│   └── pipeline.py        # 数据处理流水线
├── pages/                  # Streamlit页面
│   ├── 1_股票查询.py
│   ├── 2_上传报表.py
│   ├── 3_分析报告.py
│   └── ...
├── frontend/              # Next.js前端
│   ├── src/
│   └── public/
├── scripts/               # 工具脚本
└── docs/                  # 文档

```

## 环境变量配置

创建`.env`文件并配置以下变量：

```env
# 数据库配置
DATABASE_URL=postgresql://user:password@localhost:5432/financial_expert

# AI模型API密钥
QWEN_API_KEY=your_qwen_api_key

# 其他配置
API_PORT=8000
STREAMLIT_PORT=8501
```

## 使用说明

### 股票查询
1. 在侧边栏选择"股票查询"
2. 输入股票代码或名称
3. 查看实时数据和分析结果

### 上传财务报表
1. 选择"上传报表"页面
2. 上传PDF格式的财务报表
3. 系统自动解析并提取关键指标

### 生成分析报告
1. 选择要分析的股票或公司
2. 点击"生成报告"
3. 查看AI生成的详细分析报告

## 开发指南

### 添加新功能
1. 在`core/`目录下创建新的业务逻辑模块
2. 在`pages/`目录下创建对应的Streamlit页面
3. 更新API路由（如需要）

### 测试
```bash
# 运行测试
pytest

# 代码检查
flake8 .
```

## 部署

详细部署说明请参考：`.windsurf/workflows/financial-expert-deploy.md`

## 许可证

MIT License

## 联系方式

如有问题或建议，请提交Issue或Pull Request。
