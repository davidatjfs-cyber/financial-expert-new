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
HEALTH_CHECK_URL="http://127.0.0.1:3000/api/health"
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
# 步骤0: 前后端版本一致性预检
# =============================================================================
version_precheck() {
    log_info "步骤0: 前后端版本一致性预检..."
    cd "${LOCAL_PROJECT}"

    # 检查关键文件都存在
    local missing=0
    for f in server/index.js working-fixed.html sw.js; do
        if [ ! -f "$f" ]; then
            log_error "❌ 本地缺少文件: $f"
            missing=1
        fi
    done
    if [ $missing -eq 1 ]; then
        log_error "本地文件不完整，部署终止"
        exit 1
    fi

    # 提取 sw.js CACHE_NAME 版本
    local sw_version
    sw_version=$(grep -oE "hrms-pwa-v[0-9]+" sw.js | head -1)
    if [ -z "$sw_version" ]; then
        log_error "❌ 无法从 sw.js 提取 CACHE_NAME 版本"
        exit 1
    fi
    log_info "本地 SW 版本: ${sw_version}"

    # 计算本地文件 sha256
    local be_hash fe_hash sw_hash
    be_hash=$(shasum -a 256 server/index.js | awk '{print $1}')
    fe_hash=$(shasum -a 256 working-fixed.html | awk '{print $1}')
    sw_hash=$(shasum -a 256 sw.js | awk '{print $1}')
    log_info "本地 index.js  sha256: ${be_hash:0:16}..."
    log_info "本地 working-fixed sha256: ${fe_hash:0:16}..."
    log_info "本地 sw.js      sha256: ${sw_hash:0:16}..."

    # 保存供部署后对比
    export LOCAL_BE_HASH="$be_hash"
    export LOCAL_FE_HASH="$fe_hash"
    export LOCAL_SW_HASH="$sw_hash"
    export LOCAL_SW_VERSION="$sw_version"

    log_info "✅ 版本预检通过"
}

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
    
    # 同步后端文件（不用 --delete，避免删除 node_modules/.env/uploads）
    rsync -avz \
        --exclude='.env' \
        --exclude='node_modules' \
        --exclude='.git' \
        --exclude='*.log' \
        --exclude='uploads/' \
        "${LOCAL_PROJECT}/server/" \
        "${SERVER_USER}@${SERVER_IP}:${SERVER_PATH}/server/" || {
        log_error "后端文件部署失败"
        exit 1
    }

    # 同步前端文件
    rsync -avz \
        "${LOCAL_PROJECT}/working-fixed.html" \
        "${LOCAL_PROJECT}/sw.js" \
        "${SERVER_USER}@${SERVER_IP}:${SERVER_PATH}/" || {
        log_error "前端文件部署失败"
        exit 1
    }

    # 同步根 package.json（workspace 配置）
    rsync -avz \
        "${LOCAL_PROJECT}/package.json" \
        "${SERVER_USER}@${SERVER_IP}:${SERVER_PATH}/package.json" || true
    
    log_info "✅ 文件部署完成"
}

# =============================================================================
# 步骤5b: 安装依赖（防止新增包导致启动失败）
# =============================================================================
install_deps() {
    log_info "步骤5b: 检查并安装服务器依赖..."
    
    ssh "${SERVER_USER}@${SERVER_IP}" "
        cd ${SERVER_PATH} && npm install --workspace server --omit=dev 2>&1 | tail -5
    " || {
        log_warn "npm install 可能失败，继续部署..."
    }
    
    log_info "✅ 依赖安装完成"
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
        ls -td ${SERVER_PATH}/server.backup.* 2>/dev/null | head -1
    ")
    
    if [ -n "$latest_backup" ]; then
        log_info "回滚到备份: $latest_backup"
        # 安全回滚：只覆盖 JS 文件，绝不删除 node_modules / uploads / .env
        ssh "${SERVER_USER}@${SERVER_IP}" "
            systemctl stop ${SERVICE_NAME}
            # 只回滚 JS/JSON 源码，保留 node_modules, uploads, .env
            find ${SERVER_PATH}/server -maxdepth 1 -name '*.js' -delete 2>/dev/null
            cp ${latest_backup}/*.js ${SERVER_PATH}/server/ 2>/dev/null
            cp ${latest_backup}/package.json ${SERVER_PATH}/server/package.json 2>/dev/null
            # 回滚子目录（migrations, utils, scripts）
            for d in migrations utils scripts; do
                if [ -d ${latest_backup}/\$d ]; then
                    rm -rf ${SERVER_PATH}/server/\$d
                    cp -r ${latest_backup}/\$d ${SERVER_PATH}/server/\$d
                fi
            done
            systemctl start ${SERVICE_NAME}
        " || {
            log_error "回滚失败，需要人工介入"
            exit 1
        }
        log_info "✅ 回滚完成（node_modules/uploads/.env 已保留）"
    else
        log_error "❌ 没有找到备份，无法自动回滚"
        log_warn "尝试直接重启服务..."
        ssh "${SERVER_USER}@${SERVER_IP}" "systemctl restart ${SERVICE_NAME}" || true
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
    version_precheck
    check_syntax
    check_duplicate_functions
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
    log_info "✅ 部署成功完成！"
    log_info "=========================================="
    log_info "HRMS系统已安全部署到生产环境"
    log_info "访问地址: http://${SERVER_IP}:3000/"
    log_info "=========================================="
}

# =============================================================================
# 步骤8b: 部署后版本一致性校验
# =============================================================================
verify_versions() {
    log_info "步骤8b: 部署后版本一致性校验..."

    # 获取服务器文件 sha256
    local remote_hashes
    remote_hashes=$(ssh "${SERVER_USER}@${SERVER_IP}" "
        shasum -a 256 ${SERVER_PATH}/server/index.js ${SERVER_PATH}/working-fixed.html ${SERVER_PATH}/sw.js 2>/dev/null || \
        sha256sum ${SERVER_PATH}/server/index.js ${SERVER_PATH}/working-fixed.html ${SERVER_PATH}/sw.js 2>/dev/null
    ")

    local remote_be remote_fe remote_sw
    remote_be=$(echo "$remote_hashes" | grep 'index.js' | awk '{print $1}')
    remote_fe=$(echo "$remote_hashes" | grep 'working-fixed' | awk '{print $1}')
    remote_sw=$(echo "$remote_hashes" | grep 'sw.js' | awk '{print $1}')

    local mismatch=0
    if [ "$LOCAL_BE_HASH" != "$remote_be" ]; then
        log_error "❌ 后端 index.js 哈希不匹配！本地=${LOCAL_BE_HASH:0:16} 服务器=${remote_be:0:16}"
        mismatch=1
    else
        log_info "✓ 后端 index.js 一致"
    fi

    if [ "$LOCAL_FE_HASH" != "$remote_fe" ]; then
        log_error "❌ 前端 working-fixed.html 哈希不匹配！本地=${LOCAL_FE_HASH:0:16} 服务器=${remote_fe:0:16}"
        mismatch=1
    else
        log_info "✓ 前端 working-fixed.html 一致"
    fi

    if [ "$LOCAL_SW_HASH" != "$remote_sw" ]; then
        log_error "❌ sw.js 哈希不匹配！本地=${LOCAL_SW_HASH:0:16} 服务器=${remote_sw:0:16}"
        mismatch=1
    else
        log_info "✓ sw.js 一致"
    fi

    # 验证 /api/version
    local api_version
    api_version=$(ssh "${SERVER_USER}@${SERVER_IP}" "curl -s http://127.0.0.1:3000/api/version 2>/dev/null" || echo '{}')
    local api_sw_cache
    api_sw_cache=$(echo "$api_version" | grep -oE 'hrms-pwa-v[0-9]+' | head -1)
    if [ -n "$api_sw_cache" ] && [ "$api_sw_cache" != "$LOCAL_SW_VERSION" ]; then
        log_error "❌ API返回的swCacheName($api_sw_cache) != 本地($LOCAL_SW_VERSION)"
        mismatch=1
    elif [ -n "$api_sw_cache" ]; then
        log_info "✓ API swCacheName: $api_sw_cache"
    fi

    if [ $mismatch -eq 1 ]; then
        log_error "⚠️  版本不一致！请检查部署路径和文件"
        log_warn "部署可能部分成功，前后端版本不同步"
        return 1
    fi

    log_info "✅ 前后端版本一致性校验通过"
}

# 执行主流程
main "$@"
