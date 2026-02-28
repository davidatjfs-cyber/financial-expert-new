#!/bin/bash
# =============================================================================
# HRMS 监控告警脚本
# 用途：每分钟检查HRMS服务状态，异常时发送告警
# 部署方法：添加到crontab: * * * * * /opt/hrms/monitor.sh
# =============================================================================

# 配置
SERVER_IP="47.100.96.30"
SERVICE_NAME="hrms.service"
HEALTH_CHECK_URL="http://localhost:3000/"
LOG_FILE="/var/log/hrms-monitor.log"
ALERT_COOLDOWN_FILE="/tmp/hrms_alert_cooldown"
ALERT_COOLDOWN_SECONDS=300  # 5分钟内不重复告警

# 告警接收人（逗号分隔）
ALERT_EMAIL="admin@example.com"
FEISHU_WEBHOOK="https://open.feishu.cn/open-apis/bot/v2/hook/xxx"  # 如需飞书告警，请替换为真实webhook

# 日志函数
log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG_FILE"
}

# 发送告警（带冷却）
send_alert() {
    local message="$1"
    local current_time=$(date +%s)
    
    # 检查冷却时间
    if [ -f "$ALERT_COOLDOWN_FILE" ]; then
        local last_alert=$(cat "$ALERT_COOLDOWN_FILE")
        local time_diff=$((current_time - last_alert))
        if [ $time_diff -lt $ALERT_COOLDOWN_SECONDS ]; then
            log "告警冷却中，跳过发送: $message"
            return
        fi
    fi
    
    # 记录本次告警时间
    echo "$current_time" > "$ALERT_COOLDOWN_FILE"
    
    # 发送邮件告警
    if command -v mail >/dev/null 2>&1; then
        echo "$message" | mail -s "[ALERT] HRMS服务异常" "$ALERT_EMAIL"
        log "邮件告警已发送: $ALERT_EMAIL"
    fi
    
    # 发送飞书告警（如配置了webhook）
    if [ -n "$FEISHU_WEBHOOK" ] && [ "$FEISHU_WEBHOOK" != "https://open.feishu.cn/open-apis/bot/v2/hook/xxx" ]; then
        curl -s -X POST "$FEISHU_WEBHOOK" \
            -H "Content-Type: application/json" \
            -d "{
                \"msg_type\": \"text\",
                \"content\": {
                    \"text\": \"🚨 HRMS服务异常告警\\n$message\\n时间: $(date '+%Y-%m-%d %H:%M:%S')\\n服务器: $SERVER_IP\"
                }
            }" >/dev/null 2>&1
        log "飞书告警已发送"
    fi
    
    log "告警已发送: $message"
}

# 检查服务状态
check_service() {
    local status=$(systemctl is-active "$SERVICE_NAME" 2>/dev/null)
    if [ "$status" != "active" ]; then
        log "ERROR: 服务状态异常: $status"
        send_alert "HRMS服务状态异常: $status\\n请立即检查: systemctl status $SERVICE_NAME"
        return 1
    fi
    return 0
}

# 检查端口监听
check_port() {
    if ! ss -tlnp | grep -q ":3000"; then
        log "ERROR: 端口3000未监听"
        send_alert "HRMS端口3000未监听\\nNode进程可能已崩溃"
        return 1
    fi
    return 0
}

# 检查HTTP响应
check_http() {
    local http_code=$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_CHECK_URL" 2>/dev/null)
    if [ "$http_code" != "200" ]; then
        log "ERROR: HTTP状态码异常: $http_code"
        send_alert "HRMS HTTP响应异常: $http_code\\n期望: 200"
        return 1
    fi
    return 0
}

# 检查磁盘空间
check_disk() {
    local usage=$(df /opt | tail -1 | awk '{print $5}' | sed 's/%//')
    if [ "$usage" -gt 90 ]; then
        log "WARNING: 磁盘空间不足: ${usage}%"
        send_alert "HRMS服务器磁盘空间不足: ${usage}%\\n请及时清理"
        return 1
    fi
    return 0
}

# 检查内存使用
check_memory() {
    local mem_usage=$(free | grep Mem | awk '{printf("%.0f", $3/$2 * 100.0)}')
    if [ "$mem_usage" -gt 90 ]; then
        log "WARNING: 内存使用率高: ${mem_usage}%"
        send_alert "HRMS服务器内存使用率过高: ${mem_usage}%"
        return 1
    fi
    return 0
}

# 检查错误日志
check_error_logs() {
    local error_count=$(journalctl -u "$SERVICE_NAME" --since "5 minutes ago" 2>/dev/null | grep -cE "error|Error|failed|Failed|exception|Exception" || echo "0")
    if [ "$error_count" -gt 10 ]; then
        log "WARNING: 最近5分钟错误日志过多: $error_count"
        send_alert "HRMS最近5分钟错误日志过多: $error_count条\\n请检查: journalctl -u $SERVICE_NAME"
        return 1
    fi
    return 0
}

# 自动修复尝试
auto_fix() {
    log "尝试自动修复..."
    
    # 重启服务
    systemctl restart "$SERVICE_NAME"
    sleep 5
    
    # 验证修复
    if check_service && check_port && check_http; then
        log "自动修复成功"
        send_alert "✅ HRMS服务已自动恢复\\n服务已重启并恢复正常"
        return 0
    else
        log "自动修复失败，需要人工介入"
        send_alert "🚨 HRMS自动修复失败\\n需要立即人工介入处理"
        return 1
    fi
}

# 主检查流程
main() {
    local has_error=0
    
    # 执行各项检查
    check_service || has_error=1
    check_port || has_error=1
    check_http || has_error=1
    check_disk || true  # 非致命检查
    check_memory || true  # 非致命检查
    check_error_logs || true  # 非致命检查
    
    if [ $has_error -eq 1 ]; then
        log "检测到异常，尝试自动修复..."
        auto_fix
    else
        log "所有检查通过，服务正常"
    fi
}

# 执行主流程
main
