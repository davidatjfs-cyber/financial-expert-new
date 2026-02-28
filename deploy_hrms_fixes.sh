#!/usr/bin/env bash
set -euo pipefail

# HRMS Fixes Deploy Script - Feb 27, 2026
# Fixes: table visit query, task reply recording, batch import, tool permission

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER="root@47.100.96.30"
REMOTE_DIR="/opt/hrms/hr-management-system"

echo "=== HRMS Fixes Deployment ==="
echo "[1/4] Syncing backend server files..."
scp "${REPO_ROOT}/hr-management-system/server/agents.js" \
    "${REPO_ROOT}/hr-management-system/server/hq-brain-config.js" \
    "${SERVER}:${REMOTE_DIR}/server/"

echo "[2/4] Syncing frontend files..."
scp "${REPO_ROOT}/hr-management-system/working-fixed.html" \
    "${REPO_ROOT}/hr-management-system/sw.js" \
    "${SERVER}:${REMOTE_DIR}/"

echo "[3/4] Restarting hrms.service..."
ssh "${SERVER}" "sudo systemctl restart hrms.service && sleep 2 && sudo systemctl status hrms.service --no-pager"

echo "[4/4] Health check..."
ssh "${SERVER}" "curl -s http://127.0.0.1:3000/api/health && echo '' && curl -s http://127.0.0.1:3000/api/version"

echo ""
echo "=== Deploy complete! ==="
echo "Files deployed:"
echo "  - server/agents.js (table visit tool + task reply fix)"
echo "  - server/hq-brain-config.js (tool permission name fix)"
echo "  - working-fixed.html (batch import fix)"
echo "  - sw.js (cache bump v174)"
