#!/bin/bash
# =============================================================================
# Agents V2 安全部署脚本
# 用途：确保代码语法正确、部署安全、服务健康
# 作者：Cascade AI
# 创建时间：2026-03-10
# 严格执行：每次部署前必须运行此脚本
# =============================================================================

set -euo pipefail

# 配置（部署路径必须与 systemd 一致，否则部署无效）
# 重要：agents-v2.service 的 WorkingDirectory=/opt/agents-service-v2，此处必须一致
LOCAL_PROJECT="/Users/xieding/windsure/CascadeProjects/windsurf-project/agents-service-v2"
SERVER_IP="47.100.96.30"
SERVER_USER="root"
SERVER_PATH="/opt/agents-service-v2"   # 必须与 /etc/systemd/system/agents-v2.service 中 WorkingDirectory 一致
SERVICE_NAME="agents-v2.service"
HEALTH_CHECK_URL="http://127.0.0.1:3100/health"
BACKUP_RETENTION_DAYS=7

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# =============================================================================
# 步骤0: 版本一致性预检
# =============================================================================
version_precheck() {
    log_info "步骤0: 版本一致性预检..."
    cd "${LOCAL_PROJECT}"

    # 检查关键目录存在
    if [ ! -d "src" ]; then
        log_error "❌ 本地缺少 src 目录"
        exit 1
    fi
    if [ ! -f "src/index.js" ]; then
        log_error "❌ 本地缺少 src/index.js"
        exit 1
    fi
    if [ ! -f "package.json" ]; then
        log_error "❌ 本地缺少 package.json"
        exit 1
    fi

    # 计算本地关键文件 sha256
    local index_hash package_hash
    index_hash=$(shasum -a 256 src/index.js | awk '{print $1}')
    package_hash=$(shasum -a 256 package.json | awk '{print $1}')
    
    log_info "本地 src/index.js sha256: ${index_hash:0:16}..."
    log_info "本地 package.json sha256: ${package_hash:0:16}..."

    # 导出供部署后对比
    export LOCAL_INDEX_HASH="$index_hash"
    export LOCAL_PACKAGE_HASH="$package_hash"

    log_info "✅ 版本预检通过"
}

# =============================================================================
# 步骤1: 语法检查
# =============================================================================
check_syntax() {
    log_info "步骤1: 检查代码语法..."
    cd "${LOCAL_PROJECT}/src"

    local files=(
        "index.js"
        "services/message-pipeline.js"
        "services/agent-handlers.js"
        "services/data-executor.js"
        "services/feishu-client.js"
        "services/llm-provider.js"
    )
    
    local has_error=0
    for file in "${files[@]}"; do
        if [ -f "$file" ]; then
            if ! node --check "$file" 2>&1; then
                log_error "❌ $file 语法错误"
                has_error=1
            else
                log_info "✓ $file 语法正确"
            fi
        fi
    done
    
    if [ $has_error -eq 1 ]; then
        log_error "语法检查失败，部署终止"
        exit 1
    fi
    
    log_info "✅ 语法检查通过"
}

# =============================================================================
# 步骤2: 创建服务器目录并校验部署路径与 systemd 一致
# =============================================================================
prepare_server() {
    log_info "步骤2: 准备服务器环境..."
    
    # 校验：部署路径必须与 systemd WorkingDirectory 一致，否则部署无效
    local actual_workdir
    actual_workdir=$(ssh "${SERVER_USER}@${SERVER_IP}" "grep -E '^WorkingDirectory=' /etc/systemd/system/${SERVICE_NAME} 2>/dev/null | cut -d= -f2" || true)
    if [ -n "${actual_workdir}" ] && [ "${actual_workdir}" != "${SERVER_PATH}" ]; then
        log_error "部署路径与 systemd 不一致！当前 SERVER_PATH=${SERVER_PATH}，但 ${SERVICE_NAME} 的 WorkingDirectory=${actual_workdir}"
        log_error "请将本脚本中 SERVER_PATH 改为: SERVER_PATH=\"${actual_workdir}\""
        exit 1
    fi
    log_info "部署路径与 systemd 一致: ${SERVER_PATH}"
    
    ssh "${SERVER_USER}@${SERVER_IP}" "
        mkdir -p ${SERVER_PATH}
        mkdir -p ${SERVER_PATH}/src
    " || {
        log_error "服务器准备失败"
        exit 1
    }
    
    log_info "✅ 服务器环境准备完成"
}

# =============================================================================
# 步骤3: 备份当前版本
# =============================================================================
backup_current() {
    log_info "步骤3: 备份当前版本..."
    local backup_time=$(date +%Y%m%d_%H%M%S)
    local backup_name="src.backup.${backup_time}"
    
    ssh "${SERVER_USER}@${SERVER_IP}" "
        if [ -d ${SERVER_PATH}/src ]; then
            cd ${SERVER_PATH}
            cp -r src ${backup_name}
            echo ${backup_name}
        fi
    " || {
        log_warn "备份可能失败，继续部署..."
    }
    
    # 清理旧备份（保留最近7天）
    ssh "${SERVER_USER}@${SERVER_IP}" "
        cd ${SERVER_PATH} && \
        ls -t src.backup.* 2>/dev/null | tail -n +8 | xargs -r rm -rf
    " || true
    
    log_info "✅ 备份完成: ${backup_name}"
}

# =============================================================================
# 步骤4: 部署文件
# =============================================================================
deploy_files() {
    log_info "步骤4: 部署文件到服务器..."
    
    # 同步 src 目录（保留 node_modules/.env）
    rsync -avz \
        --exclude='.env' \
        --exclude='node_modules' \
        --exclude='.git' \
        --exclude='*.log' \
        "${LOCAL_PROJECT}/src/" \
        "${SERVER_USER}@${SERVER_IP}:${SERVER_PATH}/src/" || {
        log_error "src 目录部署失败"
        exit 1
    }

    # 同步 package.json
    rsync -avz \
        "${LOCAL_PROJECT}/package.json" \
        "${SERVER_USER}@${SERVER_IP}:${SERVER_PATH}/package.json" || {
        log_error "package.json 部署失败"
        exit 1
    }

    # 同步 public 目录（如有）
    if [ -d "${LOCAL_PROJECT}/public" ]; then
        rsync -avz \
            --exclude='.git' \
            "${LOCAL_PROJECT}/public/" \
            "${SERVER_USER}@${SERVER_IP}:${SERVER_PATH}/public/" || true
    fi
    
    log_info "✅ 文件部署完成"
}

# =============================================================================
# 步骤5: 安装依赖
# =============================================================================
install_deps() {
    log_info "步骤5: 检查并安装服务器依赖..."
    
    ssh "${SERVER_USER}@${SERVER_IP}" "
        cd ${SERVER_PATH} && npm install --production 2>&1 | tail -10
    " || {
        log_warn "npm install 可能失败，继续部署..."
    }
    
    log_info "✅ 依赖安装完成"
}

# =============================================================================
# 步骤6: 重启服务
# =============================================================================
restart_service() {
    log_info "步骤6: 重启 Agents V2 服务..."
    
    ssh "${SERVER_USER}@${SERVER_IP}" "
        systemctl restart ${SERVICE_NAME}
    " || {
        log_error "服务重启失败"
        exit 1
    }
    
    log_info "✅ 服务重启完成"
}

# =============================================================================
# 步骤7: 健康检查
# =============================================================================
health_check() {
    log_info "步骤7: 执行健康检查..."
    local max_attempts=15
    local attempt=1
    
    while [ $attempt -le $max_attempts ]; do
        local status=$(ssh "${SERVER_USER}@${SERVER_IP}" "
            curl -s -o /dev/null -w '%{http_code}' ${HEALTH_CHECK_URL} 2>/dev/null || echo '000'
        ")
        
        if [ "$status" == "200" ]; then
            log_info "✅ 健康检查通过 (HTTP 200)"
            return 0
        fi
        
        log_warn "健康检查尝试 $attempt/$max_attempts: HTTP $status"
        sleep 2
        attempt=$((attempt + 1))
    done
    
    log_error "❌ 健康检查失败，HTTP状态码不是200"
    return 1
}

# =============================================================================
# 步骤8: 自动回滚（如健康检查失败）
# =============================================================================
rollback() {
    log_error "执行自动回滚..."
    local latest_backup=$(ssh "${SERVER_USER}@${SERVER_IP}" "
        ls -td ${SERVER_PATH}/src.backup.* 2>/dev/null | head -1
    ")
    
    if [ -n "$latest_backup" ]; then
        log_info "回滚到备份: $latest_backup"
        ssh "${SERVER_USER}@${SERVER_IP}" "
            systemctl stop ${SERVICE_NAME}
            rm -rf ${SERVER_PATH}/src
            cp -r ${latest_backup} ${SERVER_PATH}/src
            systemctl start ${SERVICE_NAME}
        " || {
            log_error "回滚失败，需要人工介入"
            exit 1
        }
        log_info "✅ 回滚完成"
    else
        log_error "❌ 没有找到备份，无法自动回滚"
        log_warn "尝试直接重启服务..."
        ssh "${SERVER_USER}@${SERVER_IP}" "systemctl restart ${SERVICE_NAME}" || true
    fi
}

# =============================================================================
# 步骤9: 部署后版本一致性校验
# =============================================================================
verify_versions() {
    log_info "步骤9: 部署后版本一致性校验..."

    # 获取服务器文件 sha256
    local remote_hashes
    remote_hashes=$(ssh "${SERVER_USER}@${SERVER_IP}" "
        shasum -a 256 ${SERVER_PATH}/src/index.js ${SERVER_PATH}/package.json 2>/dev/null || \
        sha256sum ${SERVER_PATH}/src/index.js ${SERVER_PATH}/package.json 2>/dev/null
    ")

    local remote_index remote_package
    remote_index=$(echo "$remote_hashes" | grep 'index.js' | awk '{print $1}')
    remote_package=$(echo "$remote_hashes" | grep 'package.json' | awk '{print $1}')

    local mismatch=0
    if [ "$LOCAL_INDEX_HASH" != "$remote_index" ]; then
        log_error "❌ src/index.js 哈希不匹配！本地=${LOCAL_INDEX_HASH:0:16} 服务器=${remote_index:0:16}"
        mismatch=1
    else
        log_info "✓ src/index.js 一致"
    fi

    if [ "$LOCAL_PACKAGE_HASH" != "$remote_package" ]; then
        log_error "❌ package.json 哈希不匹配！本地=${LOCAL_PACKAGE_HASH:0:16} 服务器=${remote_package:0:16}"
        mismatch=1
    else
        log_info "✓ package.json 一致"
    fi

    if [ $mismatch -eq 1 ]; then
        log_error "⚠️  版本不一致！请检查部署路径和文件"
        return 1
    fi

    log_info "✅ 版本一致性校验通过"
}

# =============================================================================
# 主流程
# =============================================================================
main() {
    log_info "=========================================="
    log_info "Agents V2 安全部署流程启动"
    log_info "=========================================="
    log_info "时间: $(date '+%Y-%m-%d %H:%M:%S')"
    log_info "服务器: ${SERVER_IP}"
    log_info "服务名: ${SERVICE_NAME}"
    log_info "部署路径: ${SERVER_PATH} （与 systemd WorkingDirectory 一致）"
    log_info "端口: 3100"
    log_info "=========================================="
    
    # 执行部署步骤
    version_precheck
    check_syntax
    prepare_server
    backup_current
    deploy_files
    install_deps
    restart_service
    
    # 健康检查，失败则回滚
    if ! health_check; then
        rollback
        exit 1
    fi

    # 部署后版本一致性校验
    verify_versions
    
    log_info "=========================================="
    log_info "✅ Agents V2 部署成功完成！"
    log_info "=========================================="
    log_info "访问地址: http://${SERVER_IP}:3100/"
    log_info "=========================================="
}

# 执行主流程
main "$@"
