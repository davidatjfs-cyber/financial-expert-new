#!/usr/bin/env bash
set -euo pipefail

# ────────────────────────────────────────────────────────────────────
# 部署脚本
# 警告: .env 文件包含飞书/DASHSCOPE/DEEPSEEK 等敏感凭证
# 部署时 .env 会被保留（git clean -fd 不删除 .env）
# 如需修改 .env 请使用:  echo "KEY=VALUE" >> /opt/financial-expert/.env
# 切勿用 echo "..." > .env 覆盖（会丢失全部凭证）
# ────────────────────────────────────────────────────────────────────

# Run from repo root (e.g. /opt/financial-expert)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

DEPLOY_SKIP_GIT="${DEPLOY_SKIP_GIT:-0}"

if [ -f ./.env ]; then
  set -a
  . ./.env
  set +a
fi

REV="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
export APP_REV="${APP_REV:-$REV}"

echo "[deploy] git revision: ${REV}"
echo "[deploy] APP_REV: ${APP_REV}"

if [ "${DEPLOY_SKIP_GIT}" != "1" ]; then
  echo "[deploy] sync source"
  git fetch --all
  git reset --hard origin/main
  # 保留 .env 配置文件（包含飞书/API 凭证）
  if [ -f .env ]; then
    cp .env /tmp/_deploy_env_backup
  fi
  git clean -fd
  if [ -f /tmp/_deploy_env_backup ]; then
    mv /tmp/_deploy_env_backup .env
    echo "[deploy] restored .env from backup"
  fi
else
  echo "[deploy] skip git sync (DEPLOY_SKIP_GIT=1)"
fi

echo "[deploy] build images"
docker compose down

docker compose build --no-cache api frontend

echo "[deploy] start services"
docker compose up -d

echo "[deploy] wait for /api/version"
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1/api/version >/dev/null 2>&1; then
    break
  fi
  sleep 1
  if [ "$i" = "30" ]; then
    echo "[deploy] ERROR: /api/version not healthy after 30s" >&2
    docker compose ps
    exit 1
  fi
done

curl -fsS http://127.0.0.1/api/version || true

echo "[deploy] done"
