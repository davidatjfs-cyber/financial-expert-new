# 财务分析专家 — 部署指南

## 架构概览

```
用户浏览器
    │
    ▼
┌─────────────────────────────────────────────┐
│  nginx (Docker, 端口 80)                     │
│  ┌─────────┐  ┌──────────┐  ┌───────────┐   │
│  │ /       │  │ /api/    │  │ /brain/   │   │
│  │→frontend│  │→api:8000 │  │→宿主:9000 │   │
│  └─────────┘  └──────────┘  └───────────┘   │
└──────┬──────────────┬────────────────────────┘
       │              │
┌──────▼──────┐ ┌─────▼──────┐
│  frontend   │ │    api     │
│  Next.js    │ │  FastAPI   │
│  端口 3000   │ │  端口 8000  │
│             │ │  Python 3.11│
└─────────────┘ │  + OCR引擎  │
                └─────┬──────┘
                      │
                ┌─────▼──────┐
                │ /data 卷    │
                │ SQLite数据库│
                │ 上传的PDF   │
                └────────────┘
```

**三个 Docker 容器：**

| 容器 | 镜像 | 端口 | 作用 |
|------|------|------|------|
| `financial-expert-nginx-1` | nginx:1.27-alpine | 80→80 | 反向代理、路由分发 |
| `financial-expert-frontend-1` | financial-expert-frontend:latest | 3000 (内部) | Next.js 前端，SSR 渲染 |
| `financial-expert-api-1` | financial-expert-api:latest | 8000 (内部) | FastAPI 后端，AI分析/OCR |

**路由规则：**
- `/` → Next.js 前端（仪表盘、股票查询、上传、报告等页面）
- `/api/` → FastAPI 后端（数据分析、PDF处理、AI接口）
- `/brain/` → 宿主机 9000 端口（其他应用，非本项目）

## 服务器信息

- **IP:** 8.153.95.62
- **系统:** Ubuntu 22.04
- **项目路径:** `/opt/financial-expert`
- **数据卷:** `/opt/financial-expert/data`（SQLite数据库 + 上传文件）
- **SSH:** root 无密码登录已配置

## 关键文件清单

```
/opt/financial-expert/
├── docker-compose.yml          # Docker 编排（核心部署文件）
├── Dockerfile.api              # API 后端镜像构建
├── .env                        # 环境变量（DASHSCOPE_API_KEY）
├── deploy/
│   ├── deploy.sh               # 一键部署脚本
│   ├── sync_to_server.sh       # 本地→服务器同步脚本
│   └── nginx.conf              # Nginx 配置（挂载到容器）
├── api.py                      # FastAPI 入口
├── core/                       # 后端核心逻辑
│   ├── db.py                   # 数据库连接
│   ├── models.py               # ORM 模型
│   ├── llm_qwen.py             # 通义千问 AI 接口
│   ├── pdf_analyzer.py         # PDF 解析
│   └── styles.py               # Streamlit 样式（仅旧版使用）
├── pages/                      # Streamlit 页面（仅旧版，生产不用）
├── frontend/                   # Next.js 前端（生产使用）
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── app/                # Next.js App Router 页面
│       │   ├── page.tsx        # 仪表盘首页
│       │   ├── stock/          # 股票查询
│       │   ├── upload/         # 上传报表
│       │   ├── reports/        # 分析报告
│       │   ├── indicators/     # 财务指标
│       │   ├── risk/           # 风险预警
│       │   ├── trends/         # 趋势分析
│       │   └── compare/        # 公司对比
│       ├── components/         # React 组件
│       └── services/           # API 调用层
├── requirements.txt             # Python 依赖（全部）
├── requirements-api.txt        # Python 依赖（仅 API 后端）
└── data/                       # 持久化数据（不随部署覆盖）
    ├── financial.db
    ├── financial_reports.db
    └── uploads/
```

## 部署方式

### 方式一：服务器直接部署（推荐）

适合：服务器上有 git 仓库，代码已推送到 main 分支。

```bash
ssh root@8.153.95.62
cd /opt/financial-expert
./deploy/deploy.sh
```

`deploy.sh` 会自动执行：
1. 读取 `.env` 环境变量
2. `git pull` 拉取最新代码
3. `docker compose down` 停止旧容器
4. `docker compose build --no-cache api frontend` 重新构建镜像
5. `docker compose up -d` 启动新容器
6. 健康检查：等待 `/api/version` 可用（最多30秒）

### 方式二：本地同步后部署

适合：本地有修改但未推送到 git，或无法使用 git 同步。

```bash
# 在本地项目根目录执行
./deploy/sync_to_server.sh
```

然后 SSH 到服务器手动部署：

```bash
ssh root@8.153.95.62
cd /opt/financial-expert
DEPLOY_SKIP_GIT=1 ./deploy/deploy.sh
```

`sync_to_server.sh` 使用 rsync 同步，**安全规则：**
- ✅ 同步代码文件
- ❌ 不删除服务器上多余文件
- ❌ 不覆盖 `.env`
- ❌ 不覆盖 `data/` 持久化数据

### 方式三：手动步骤

```bash
ssh root@8.153.95.62
cd /opt/financial-expert

# 1. 拉取代码（如果用 git）
git fetch --all && git reset --hard origin/main

# 2. 重新构建并启动
docker compose down
docker compose build --no-cache api frontend
docker compose up -d

# 3. 验证
curl -fsS http://127.0.0.1/api/version
curl -s http://127.0.0.1/ | grep '<title>'
```

## 验证部署成功

```bash
# 1. 所有容器运行中
docker ps --format 'table {{.Names}}\t{{.Status}}'
# 期望输出：3个容器都是 Up

# 2. API 健康
curl -fsS http://127.0.0.1/api/version
# 期望：返回版本 JSON

# 3. 前端可访问
curl -s http://127.0.0.1/ | grep '<title>'
# 期望：<title>财务分析专家</title>

# 4. 浏览器访问
# http://8.153.95.62 → Next.js 前端
```

## 常见问题排查

### 容器启动失败

```bash
# 查看容器日志
docker compose logs --tail 50 api
docker compose logs --tail 50 frontend
docker compose logs --tail 50 nginx

# 查看容器状态
docker compose ps
```

### API 不可用

```bash
# 检查 API 容器日志
docker logs financial-expert-api-1 --tail 100

# 进入 API 容器调试
docker exec -it financial-expert-api-1 bash
```

### 前端白屏或 502

```bash
# 检查前端容器
docker logs financial-expert-frontend-1 --tail 50

# 检查 nginx 配置是否正确加载
docker exec financial-expert-nginx-1 cat /etc/nginx/conf.d/default.conf
docker exec financial-expert-nginx-1 nginx -t
```

### 需要回滚

```bash
# 回滚到上一个 git 版本
cd /opt/financial-expert
git log --oneline -5           # 找到上一个版本
git checkout <commit-hash>     # 切换版本
docker compose build --no-cache api frontend
docker compose up -d
```

## 环境变量

| 变量 | 位置 | 说明 |
|------|------|------|
| `DASHSCOPE_API_KEY` | `.env` | 通义千问 API 密钥，AI 分析必需 |
| `APP_DATA_DIR` | docker-compose.yml | 数据目录，容器内为 `/data` |
| `FORCE_PDF_AI` | docker-compose.yml | 强制使用 AI 解析 PDF（默认 0） |
| `ENABLE_OCR` | docker-compose.yml | 启用 OCR 识别（默认 0） |
| `AUTO_OCR_FALLBACK` | docker-compose.yml | PDF 解析失败自动降级 OCR（默认 1） |

## ⚠️ 重要注意事项

1. **不要在宿主机上运行 Streamlit 进程**。生产环境只用 Docker 容器中的 Next.js 前端 + FastAPI 后端。Streamlit 是旧版方案，已弃用。

2. **不要修改 `/app/` 路由**。`/app/` 不属于本项目架构，不要在 nginx 中添加 `/app/` location 块。

3. **不要直接修改容器内的文件**。容器重启后修改会丢失。所有配置变更都应该修改宿主机上的源文件（特别是 `deploy/nginx.conf`），然后通过 `docker compose restart nginx` 生效。

4. **`data/` 目录是持久化的**。`deploy.sh` 和 `sync_to_server.sh` 都不会覆盖此目录。数据库和用户上传的 PDF 都在这里。

5. **修改前端代码后必须重新构建镜像**。Next.js 是编译型框架，生产模式使用 `.next` 构建产物，修改 `src/` 后需要：
   ```bash
   docker compose build --no-cache frontend
   docker compose up -d
   ```

6. **修改后端代码后同理**：
   ```bash
   docker compose build --no-cache api
   docker compose up -d
   ```

7. **修改 nginx 配置后**，只需重启 nginx 容器：
   ```bash
   docker compose restart nginx
   ```

## 数据备份

```bash
# 备份 SQLite 数据库和上传文件
ssh root@8.153.95.62 "cd /opt/financial-expert && tar czf /tmp/financial-backup-$(date +%Y%m%d).tar.gz data/"
scp root@8.153.95.62:/tmp/financial-backup-*.tar.gz ./
```

## 端口占用参考

| 端口 | 用途 | 备注 |
|------|------|------|
| 80 | nginx (Docker) | 对外提供 Web 服务 |
| 3000 | Next.js 前端 | 仅 Docker 内部 |
| 8000 | FastAPI 后端 | 仅 Docker 内部 |
| 8080 | ai-tutor 应用 | 非本项目 |
| 9000 | brain 应用 | 非本项目 |