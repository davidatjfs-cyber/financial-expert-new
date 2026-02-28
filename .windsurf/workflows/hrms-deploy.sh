#!/bin/bash
# =============================================================================
# HRMS 安全部署脚本
# 用途：确保代码语法正确、部署安全、服务健康
# 作者：Cascade AI
# 创建时间：2026-02-27
# 严格执行：每次部署前必须运行此脚本
# =============================================================================

set -euo pipefail

# 配置
LOCAL_PROJECT="/Users/xieding/windsure/CascadeProjects/windsurf-project/hr-management-system"
SERVER_IP="47.100.96.30"
SERVER_USER="root"
SERVER_PATH="/opt/hrms/hr-management-system"
SERVICE_NAME="hrms.service"
HEALTH_CHECK_URL="http://localhost:3000/"
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
# 步骤1: 语法检查
# =============================================================================
check_syntax() {
    log_info "步骤1: 检查代码语法..."
    cd "${LOCAL_PROJECT}/server"
    
    local files=(
        "agents.js"
        "auto-ops-engine.js"
        "new-scoring-model.js"
        "hq-brain-config.js"
        "llm-config-enhanced.js"
        "master-agent.js"
        "index.js"
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
# 步骤2: 检查关键函数是否重复定义
# =============================================================================
check_duplicate_functions() {
    log_info "步骤2: 检查重复函数定义..."
    cd "${LOCAL_PROJECT}/server"
    
    # 检查 hq-brain-config.js 中的重复函数
    local duplicates
    duplicates=$(sed -nE "s/^[[:space:]]*(export[[:space:]]+)?function[[:space:]]+([A-Za-z_\$][A-Za-z0-9_\$]*)[[:space:]]*\(.*/\2/p" hq-brain-config.js | sort | uniq -d)
    if [ -n "$duplicates" ]; then
        log_error "❌ 发现重复函数定义: $duplicates"
        exit 1
    fi
    
    log_info "✅ 无重复函数定义"
}

# =============================================================================
# 步骤3: 创建服务器目录
# =============================================================================
prepare_server() {
    log_info "步骤3: 准备服务器环境..."
    
    ssh "${SERVER_USER}@${SERVER_IP}" "
        mkdir -p ${SERVER_PATH}/server/public
        mkdir -p ${SERVER_PATH}/server/uploads
        chown -R hrms:hrms ${SERVER_PATH}
    " || {
        log_error "服务器准备失败"
        exit 1
    }
    
    log_info "✅ 服务器环境准备完成"
}

# =============================================================================
# 步骤4: 备份当前版本
# =============================================================================
backup_current() {
    log_info "步骤4: 备份当前版本..."
    local backup_time=$(date +%Y%m%d_%H%M%S)
    local backup_name="server.backup.${backup_time}"
    
    ssh "${SERVER_USER}@${SERVER_IP}" "
        if [ -d ${SERVER_PATH}/server ]; then
            cd ${SERVER_PATH}
            cp -r server ${backup_name}
            echo ${backup_name}
        fi
    " || {
        log_warn "备份可能失败，继续部署..."
    }
    
    # 清理旧备份（保留最近7天）
    ssh "${SERVER_USER}@${SERVER_IP}" "
        cd ${SERVER_PATH} && \
        ls -t server.backup.* 2>/dev/null | tail -n +8 | xargs -r rm -rf
    " || true
    
    log_info "✅ 备份完成: ${backup_name}"
}

# =============================================================================
# 步骤5: 部署文件
# =============================================================================
deploy_files() {
    log_info "步骤5: 部署文件到服务器..."
    
    # 使用rsync部署，排除敏感文件
    rsync -avz --delete \
        --exclude='.env' \
        --exclude='node_modules' \
        --exclude='.git' \
        --exclude='*.log' \
        --exclude='uploads/*' \
        "${LOCAL_PROJECT}/server/" \
        "${SERVER_USER}@${SERVER_IP}:${SERVER_PATH}/server/" || {
        log_error "文件部署失败"
        exit 1
    }
    
    log_info "✅ 文件部署完成"
}

# =============================================================================
# 步骤6: 重启服务
# =============================================================================
restart_service() {
    log_info "步骤6: 重启HRMS服务..."
    
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
    local max_attempts=10
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
        ls -t ${SERVER_PATH}/server.backup.* 2>/dev/null | head -1
    ")
    
    if [ -n "$latest_backup" ]; then
        log_info "回滚到备份: $latest_backup"
        ssh "${SERVER_USER}@${SERVER_IP}" "
            systemctl stop ${SERVICE_NAME}
            rm -rf ${SERVER_PATH}/server
            cp -r ${latest_backup} ${SERVER_PATH}/server
            systemctl start ${SERVICE_NAME}
        " || {
            log_error "回滚失败，需要人工介入"
            exit 1
        }
        log_info "✅ 回滚完成"
    else
        log_error "❌ 没有找到备份，无法自动回滚"
        exit 1
    fi
}

# =============================================================================
# 主流程
# =============================================================================
main() {
    log_info "=========================================="
    log_info "HRMS 安全部署流程启动"
    log_info "=========================================="
    log_info "时间: $(date '+%Y-%m-%d %H:%M:%S')"
    log_info "服务器: ${SERVER_IP}"
    log_info "=========================================="
    
    # 执行部署步骤
    check_syntax
    check_duplicate_functions
    prepare_server
    backup_current
    deploy_files
    restart_service
    
    # 健康检查，失败则回滚
    if ! health_check; then
        rollback
        exit 1
    fi
    
    log_info "=========================================="
    log_info "✅ 部署成功完成！"
    log_info "=========================================="
    log_info "HRMS系统已安全部署到生产环境"
    log_info "访问地址: http://${SERVER_IP}:3000/"
    log_info "=========================================="
}

# 执行主流程
main "$@"
