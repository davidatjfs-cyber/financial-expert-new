---
description: HRMS 部署（rsync + systemd + 健康检查 + 常见排错）
---

> 适用场景：将本地仓库的 HRMS（前端 `working-fixed.html` / `sw.js` + 后端 `server/index.js`）一次性部署到生产服务器，并在 systemd 上重启服务与做健康检查。

> **⚠️ 关键警告：永远不要用 scp/rsync 覆盖 `server/uploads/` 目录！** 该目录存放用户上传的知识库文件（视频/PDF等），覆盖会导致文件永久丢失。部署时只同步 `server/index.js`，不要同步整个 `server/` 目录。

> **⚠️ 每次部署前必须执行「前后端版本一致性检查」**：脚本已内置步骤0（预检）和步骤8b（部署后校验），自动比对本地与服务器的 sha256 哈希 + sw.js CACHE_NAME 版本号。如果任何文件不一致，脚本会报错并提示。**绝不允许出现后端已更新、前端还是旧版的情况。**

# 固定信息（本项目默认值）
- **服务器 IP**：`47.100.96.30`
- **项目根目录**：`/opt/hrms/hr-management-system`
- **后端目录**：`/opt/hrms/hr-management-system/server`
- **systemd 服务名**：`hrms.service`
- **监听**：`127.0.0.1:3000`
- **健康检查**：`curl -s http://127.0.0.1:3000/api/health`
- **必须保留目录**：`/opt/hrms/hr-management-system/server/uploads`

# 0. 本地一键部署命令（推荐）
> 目标：在本地终端输入一个名字就完成部署。

- **一键部署名字**：`hrms-deploy`
- **脚本路径**：`.windsurf/workflows/hrms-deploy.sh`

首次配置（只需一次）：

```bash
# 在本地终端执行（建议加入 ~/.zshrc）
alias hrms-deploy='bash /Users/xieding/windsure/CascadeProjects/windsurf-project/.windsurf/workflows/hrms-deploy.sh'
```

立即使用：

```bash
hrms-deploy
```

不配 alias 也可直接运行：

```bash
bash /Users/xieding/windsure/CascadeProjects/windsurf-project/.windsurf/workflows/hrms-deploy.sh
```

# 1.（可选）服务器侧备份
建议每次发布前先做一次备份（保留 uploads）。

```bash
# 在服务器执行
sudo -u hrms bash -lc 'mkdir -p /opt/hrms/backup && cd /opt/hrms && tar -czf backup/hrms-$(date +%F-%H%M%S).tgz hr-management-system'
```

# 2. 本地同步到服务器（rsync）
## 2.1 后端同步（注意目标路径！）
后端入口是：`/opt/hrms/hr-management-system/server/index.js`，不要同步到项目根目录。

```bash
# 在本地执行（从仓库根目录）
rsync -avz \
  hr-management-system/server/index.js \
  root@47.100.96.30:/opt/hrms/hr-management-system/server/index.js
```

## 2.2 前端同步（项目根目录）
```bash
# 在本地执行（从仓库根目录）
rsync -avz \
  hr-management-system/working-fixed.html \
  hr-management-system/sw.js \
  root@47.100.96.30:/opt/hrms/hr-management-system/
```

## 2.3（可选）全量同步目录（排除项）
如果你要同步整个目录（不推荐频繁用，除非明确需要），必须排除：
- `server/uploads/`
- `server/node_modules/`
- `server/.env`

```bash
rsync -avz \
  --exclude 'server/uploads/' \
  --exclude 'server/node_modules/' \
  --exclude 'server/.env' \
  hr-management-system/ \
  root@47.100.96.30:/opt/hrms/hr-management-system/
```

# 3. 服务器重启服务
```bash
sudo systemctl restart hrms.service
```

# 4. 服务器验证（必须做）
```bash
sudo systemctl status hrms.service --no-pager
sudo journalctl -u hrms.service -n 80 --no-pager
curl -s http://127.0.0.1:3000/api/health
curl -s http://127.0.0.1:3000/api/version
```

## 4.2 发布后冒烟验证（要求：由助手主导核对，避免回归与返工）
目的：不要等上线后用户发现“又回到旧逻辑/功能不可用”。每次发布后必须完成以下最小验证，并把结果（输出/截图要点）记录。

### A. 版本一致性
- **必须**确认 `/api/version`：
  - `server.indexMtime`、`frontend.workingFixedMtime`、`frontend.swMtime` 为本次发布时间
  - `frontend.swCacheName` 已 bump（前端有变更时）

### B. 知识库（高频回归点）
- **上传**：上传一个小 PDF（<5MB）应能成功退出弹窗并在列表出现
- **预览**：点击 PDF 能预览/或至少能打开下载
- **视频**：点击视频能播放（如果无法播放通常是 Range/鉴权/反代问题）

### C. 考试资料提取
- 从知识库选择 1 个 PDF/DOCX/TXT，点击“提取/加载资料文本”应能填充文本框

### D. 员工身份证自动回填
- 在员工管理里上传身份证正面/反面后，应能自动回填：身份证号/性别/出生日期（姓名尽力识别）

## 4.1 版本一致性强校验（强烈建议）
目的：防止“同步错路径 / 缓存未更新 / 服务未重启”导致线上仍是旧逻辑。

在服务器执行：

```bash
# 确认后端入口文件更新时间（必须是本次发布的时间）
ls -l /opt/hrms/hr-management-system/server/index.js

# 确认前端文件更新时间（必须是本次发布的时间）
ls -l /opt/hrms/hr-management-system/working-fixed.html /opt/hrms/hr-management-system/sw.js

# 可选：计算校验和（把输出记录到发布单/群里，便于回溯）
sha256sum /opt/hrms/hr-management-system/server/index.js \
  /opt/hrms/hr-management-system/working-fixed.html \
  /opt/hrms/hr-management-system/sw.js
```

`/api/version` 返回值检查点：
- `server.indexMtime` 是否为本次发布后的时间
- `frontend.workingFixedMtime` / `frontend.swMtime` 是否为本次发布后的时间
- `frontend.swCacheName` 是否为最新（每次前端变更都要 bump）

# 5. 前端强制更新（Service Worker）
如果你改了前端页面，建议每次发布时 bump `sw.js` 里的：
- `CACHE_NAME = 'hrms-pwa-vX'`（X + 1）

客户端更新方式：
- 浏览器强刷：`Cmd+Shift+R` / `Ctrl+F5`
- 仍不更新：DevTools → Application → Service Workers → 勾选 *Update on reload* → Reload
- PWA：关闭后重开，必要时清站点数据

# 6. 服务器自动备份（推荐首次部署后设置一次）

在服务器上设置 cron 每天自动备份 uploads 目录和数据库：

```bash
# 在服务器执行（设置每天凌晨3点自动备份）
sudo mkdir -p /opt/hrms/backup/uploads
sudo bash -c 'cat > /etc/cron.d/hrms-backup << "EOF"
# HRMS 每日备份：uploads + 数据库
0 3 * * * root /bin/bash -c "cp -a /opt/hrms/hr-management-system/server/uploads/ /opt/hrms/backup/uploads/$(date +\%F) 2>/dev/null; sudo -u postgres pg_dump hrms | gzip > /opt/hrms/backup/hrms-db-$(date +\%F).sql.gz 2>/dev/null; find /opt/hrms/backup -mtime +30 -delete 2>/dev/null"
EOF'
sudo chmod 644 /etc/cron.d/hrms-backup
```

备份内容：
- `uploads/` 目录完整拷贝（按日期归档）
- PostgreSQL 数据库 dump（gzip 压缩）
- 自动清理 30 天前的旧备份

# 7. 常见排错
## 6.1 服务启动报错：`ReferenceError: Cannot access 'upload' before initialization`
含义：Express 路由里引用了 `upload`（multer 实例），但 `const upload = multer(...)` 定义在后面。

排查：
- 服务器确认运行的文件是否是 `server/index.js`：

```bash
ls -l /opt/hrms/hr-management-system/server/index.js
```

修复原则：
- 把所有使用 `upload.*` 的路由注册移动到 `const upload = multer(...)` **之后**。

## 6.2 同步后不生效（典型：rsync 同步到错误路径）
现象：你同步了 `index.js`，但服务逻辑没变。

排查：
```bash
ls -l /opt/hrms/hr-management-system/index.js /opt/hrms/hr-management-system/server/index.js
```

结论：
- `systemd` 启动的是 `server/index.js`，所以必须同步到：
  `/opt/hrms/hr-management-system/server/index.js`

## 6.2.1 一键脚本报错：`发现重复函数定义: {`
现象：`hrms-deploy` 在“步骤2: 检查重复函数定义”直接失败，报：

```text
[ERROR] ❌ 发现重复函数定义: {
```

原因：旧版脚本使用 `awk` 按空格取字段，误把 `{` 当成函数名，产生误报。

处理：已修复为正则提取真实函数名（`hrms-deploy.sh`）。直接重跑：

```bash
hrms-deploy
```

## 6.3 npm install 权限问题（EACCES）
一般是目录属主不对。

```bash
sudo chown -R hrms:staff /opt/hrms/hr-management-system
sudo -u hrms bash -lc 'cd /opt/hrms/hr-management-system/server && npm install --omit=dev'
```

## 6.4 上传大文件失败（知识库视频/PDF）
现象：前端显示“上传完成/写入中”很久不退出，或直接失败。

排查：
- 反代/Nginx 的 `client_max_body_size` 是否足够（建议 ≥ 350m，支持 300MB 单文件）

提示：本仓库 `deploy/nginx.conf` 已将 `client_max_body_size` 调整为 `350m`，若线上 Nginx 配置不同需要同步修改并 reload。

# 8. 部署后必须 git commit（防止修改丢失）

> **⚠️ 极其重要：每次部署后必须立即执行此步骤。** 历史教训：Feb 21 的所有修改（毛利率目标、企微会员等功能）因未 git commit，在下次会话中被旧版本覆盖，导致 4700+ 行代码丢失。

```bash
# 在本地仓库根目录执行
cd /Users/xieding/windsure/CascadeProjects/windsurf-project

# 查看有哪些文件被修改
git status --short

# 暂存所有 HRMS 相关修改（根据实际情况调整）
git add hr-management-system/working-fixed.html \
        hr-management-system/sw.js \
        hr-management-system/server/agents.js \
        hr-management-system/server/index.js \
        hr-management-system/server/new-scoring-model.js

# 提交，描述本次修改内容（必须写清楚改了什么）
git commit -m "deploy: 描述本次修改内容 + sw vXXX"
```

**提交信息规范：**
- 前缀用 `deploy:` 或 `feat:` 或 `fix:`
- 必须说明改了哪些功能/文件
- 必须注明 SW 版本号（如 `sw v152`）

**验证提交成功：**
```bash
git log --oneline -3
```

确认最新 commit 时间戳与本次部署时间一致。
