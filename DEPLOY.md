# Financial Expert 部署指南

**服务器**: 8.153.95.62  
**SSH Key**: `~/.ssh/aliyun_ecs`  
**项目路径**: `/opt/financial-expert`  
**架构**: Docker Compose（API + Frontend + Nginx）

---

## 第一原则：所有代码跑在 Docker 里

> **宿主机上绝对没有我们的任何服务进程。**  
> 不要 kill 宿主机进程、不要手动起 uvicorn、不要手动 `docker run`。  
> 所有操作必须通过 `docker compose`。

---

## 架构概览

```
用户 -> Nginx(:80) -> Frontend(:3000)  [Next.js SSR Turbopack]
                    -> API(:8000)       [FastAPI/uvicorn]
                       └── /data/financial_reports.db  [SQLite, 宿主机 volume 挂载]
```

### 数据库路径

- 容器内: `/data/financial_reports.db`（通过 `APP_DATA_DIR=/data` 环境变量指定）
- 宿主机: `/opt/financial-expert/data/financial_reports.db`
- **不要创建 `/app/.data/ → /data` 的软链接**，代码已通过环境变量正确处理
- 表名是 **`portfolio_positions`**（复数！），不是 `portfolio_position`

---

## 死规则（必须严格遵守）

### 规则 1：必须用 `docker compose`

```bash
# ✅ 正确
docker compose ps
docker compose logs api
docker compose build --no-cache frontend
docker compose up -d

# ❌ 绝对禁止
docker run -d --name financial-expert-api-1 financial-expert-api:latest
kill <pid>
nohup uvicorn api:app &
```

**原因**: 手动创建的容器没有 Docker Compose 的 DNS service name，Nginx 的 `proxy_pass http://api:8000` 会解析失败。

### 规则 2：更新代码必须重建镜像

```bash
# ✅ 正确
rsync -az ... ./ root@8.153.95.62:/opt/financial-expert/
ssh root@8.153.95.62 "cd /opt/financial-expert && docker compose build --no-cache frontend && docker compose up -d frontend"

# ❌ 错误：只同步文件不重建
rsync ...  # 文件同步了但 docker 还是旧代码
```

**原因**: Docker 将代码 `COPY` 到镜像中，不是挂载宿主目录（除了 `data/`）。只 rsync 不 build 等于没更新。

### 规则 3：build 必须加 `--no-cache`

```bash
# ✅ 正确
docker compose build --no-cache frontend

# ❌ 错误：可能用缓存
docker compose build frontend
```

### 规则 4：nginx 必须用 resolver + 变量

修改 `deploy/nginx.conf` 时，proxy_pass 必须用变量：

```nginx
# ✅ 正确
resolver 127.0.0.11 valid=10s;
location /api/ {
    set $api_backend api:8000;
    proxy_pass http://$api_backend;
}

# ❌ 错误：nginx 会缓存 DNS 到永远
location /api/ {
    proxy_pass http://api:8000;
}
```

**原因**: `docker compose up -d` 重建容器时 IP 会变。没有 resolver + 变量，nginx 不会重新解析 DNS，请求会发送到旧容器。

### 规则 5：只改前端就不要重建 API — 这是最常犯的错误

```bash
# ✅ 正确：只重建前端
docker compose build --no-cache frontend
docker compose up -d frontend          # 只重建 frontend 容器，API 不停机

# ✅ 正确：只改 api.py
docker compose build --no-cache api
docker compose up -d api               # 只重建 API，frontend 不动

# ❌ 错误：无差别重启所有
docker compose up -d                   # 会连带重建 frontend、API 甚至 nginx！
```

**原因**: `docker compose up -d` 会检查所有服务，如果 Docker Compose 认为任何服务需要重建（哪怕不应该），它会全部重建。API 每次重建 → 数据库重新连接 → 约 **3-5 秒无响应**。如果用户在这几秒刷新页面 → 请求失败 → 看到"暂无持仓"。

**前端的自动重试机制**：即使遇到 API 短暂不可用，前端会在 2 秒后重试，最多重试 3 次，30 秒内自动恢复。但这也不能替代正确的部署操作。

### 规则 6：修改前端代码后必须强制刷新本地浏览器

Next.js Turbopack 的 JS chunk hash 可能在代码修改后不变（基于模块图而非内容）。部署后须告知用户按 **Cmd+Shift+R（Mac）或 Ctrl+Shift+R（Windows）** 强制刷新。或者修改一个运行时字符串（如 cache-buster 常量）确保 hash 变化。

---

## 完整部署流程

### 第一步：判断改了什么

| 改动内容 | 需要重建 | 需要重启 |
|---------|---------|---------|
| `frontend/src/app/indicators/page.tsx` 等前端文件 | `frontend` | `frontend` |
| `api.py` | `api` | `api` |
| `deploy/nginx.conf` | 无（卷挂载） | `nginx` |
| `DEPLOY.md` | 无 | 无 |
| `core/` 目录 | `api` | `api` |

### 方式一：本地推送到生产（推荐）

```bash
# 1. 同步源码到服务器
rsync -az \
  --exclude ".git/" --exclude ".env" --exclude "data/" --exclude ".data/" \
  --exclude "hr-management-system/" --exclude "*.tar.gz" \
  --exclude ".agent-reach-venv/" --exclude "node_modules/" --exclude "__pycache__" \
  -e "ssh -i ~/.ssh/aliyun_ecs" \
  /Users/xieding/financial-expert-new/ root@8.153.95.62:/opt/financial-expert/

# 2. SSH 到服务器
ssh -i ~/.ssh/aliyun_ecs root@8.153.95.62
cd /opt/financial-expert
```

**如果只改了前端（最常见）：**
```bash
docker compose build --no-cache frontend
docker compose up -d frontend
```
> API 全程不停机，页面不会有任何中断。

**如果只改了 api.py / core/**
```bash
docker compose build --no-cache api
docker compose up -d api
```
> API 重启约 3-5 秒，期间旧页面请求可能失败，但前端会自动重试恢复。

**如果改了 nginx.conf**
```bash
docker compose restart nginx
```
> 无需 build，config 是卷挂载的。

**如果需要同时改多个**
```bash
docker compose build --no-cache api frontend
docker compose up -d api frontend    # 只重启改了的那两个
```

### 方式二：服务器端 Git 部署

```bash
ssh -i ~/.ssh/aliyun_ecs root@8.153.95.62
cd /opt/financial-expert
git fetch --all && git reset --hard origin/main
docker compose build --no-cache api frontend
docker compose up -d
```

---

## 部署后验证清单

逐项检查，缺一不可：

```bash
# 1. 所有容器运行
docker compose ps
# 输出必须是所有服务 "Up"

# 2. API 返回持仓数据
curl -s http://127.0.0.1/api/portfolio/positions | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d),'positions')"
# 必须 > 0

# 3. API 返回新格式的 holdings_breakdown
curl -s http://127.0.0.1/api/portfolio/positions | python3 -c "
import sys,json; d=json.load(sys.stdin)
for p in d[:2]:
    bd = p.get('holdings_breakdown',{})
    for k in ['manual','agent_a','agent_b']:
        v = bd.get(k)
        if v and v.get('quantity',0) > 0:
            print(f'{p[\"name\"]} {k}: qty={v[\"quantity\"]} cost={v[\"avg_cost\"]} pnl={v[\"unrealized_pnl\"]}')
"
# 必须显示每个来源的独立 qty/cost/pnl

# 4. 前端页面 200
curl -s -o /dev/null -w 'indicators: %{http_code}\n' http://127.0.0.1/indicators

# 5. JS chunk 可访问
curl -s -o /dev/null -w 'chunk: %{http_code}\n' http://127.0.0.1/_next/static/chunks/$(curl -s http://127.0.0.1/indicators | grep -oE 'chunks/[a-f0-9]{16}\.js' | tail -1 | cut -d/ -f2)

# 6. Nginx DNS 解析正常
docker exec financial-expert-nginx-1 nslookup api
docker exec financial-expert-nginx-1 nslookup frontend
```

---

## 常见坑

| 症状 | 原因 | 修复 |
|------|------|------|
| 前端显示"加载中..."不动 | 浏览器缓存了旧 JS chunk | Cmd+Shift+R 强制刷新 |
| API 返回 `[]` 空数组 | 数据库路径错误 | `docker compose exec api python3 -c 'from core.db import get_db_path; print(get_db_path())'` 确认是 `/data/financial_reports.db` |
| 前端请求 API 返回旧数据格式 | nginx DNS 缓存在旧容器 | 检查 nginx resolver 配置，重启 nginx: `docker compose restart nginx` |
| `docker compose build` 后 hash 没变 | Turbopack 的 chunk hash 基于模块图 | 改一个运行时字符串（如 cache-buster 常量）让 JS 内容不同 |
| API 报 "no such table: portfolio_position" | 查的是单数 `portfolio_position`，真实表名是复数 `portfolio_positions` | 检查 SQL 查询中的表名 |
| `docker compose up -d` 重建 API 后页面短暂"无数据" | API 容器重启需 3-5 秒，期间请求失败 | 前端已内置自动重试（失败后等2秒再试，最多3次）；部署后30秒内自动恢复 |
| 页面一直"加载中"不消失 | API 请求挂起（无响应也无超时） | 前端已内置自动重试，不会卡死 |

---

## 文件说明

| 文件 | 用途 |
|------|------|
| `deploy/nginx.conf` | Nginx 反向代理 + resolver 动态 DNS |
| `Dockerfile.api` | API Python 3.11 镜像，COPY api.py + core/ |
| `frontend/Dockerfile` | 前端 Node 20 镜像，npm run build |
| `docker-compose.yml` | 服务编排，设 `APP_DATA_DIR=/data` |
| `frontend/.env.local` | 本地开发环境变量（不同步到服务器） |
