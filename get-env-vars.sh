#!/bin/bash
# 从生产服务器提取环境变量

echo "=== HRMS 环境变量 ==="
ssh root@47.100.96.30 "cat /etc/hrms.env 2>/dev/null || echo '文件不存在，尝试从systemd服务读取...'"

echo ""
echo "=== 从systemd服务配置读取 ==="
ssh root@47.100.96.30 "systemctl cat hrms.service | grep -E 'JWT_SECRET|DEEPSEEK|QWEN|DOUBAO|FEISHU' || echo '未在systemd配置中找到'"

echo ""
echo "=== Agents V2 环境变量 ==="
ssh root@47.100.96.30 "cat /opt/agents-service-v2/.env 2>/dev/null || echo 'Agents V2 .env文件不存在'"
