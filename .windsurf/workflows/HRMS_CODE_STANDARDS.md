# =============================================================================
# HRMS 代码修改规范
# 严格执行此规范，确保系统稳定性
# 版本：v1.0
# 创建时间：2026-02-27
# =============================================================================

## 一、修改前检查清单（必须执行）

### 1.1 语法验证
```bash
# 修改任何 .js 文件前，必须先执行语法检查
node --check <文件名>

# 示例
node --check agents.js
node --check hq-brain-config.js
```

**⚠️ 严禁跳过此步骤！** 本次502错误就是因为 `getAvailableTools` 函数重复声明导致的。

### 1.2 重复函数检查
```bash
# 检查是否有重复定义的函数
grep -n "^function\|^export function" hq-brain-config.js | awk '{print $3}' | sort | uniq -d

# 如果有输出，说明有重复定义，必须修复后再部署
```

### 1.3 依赖检查
```bash
# 确保没有引入未定义的变量或函数
node -e "require('./hq-brain-config.js')" 2>&1 | head -20
```

## 二、修改规范

### 2.1 函数命名规范
- **禁止重复声明同名函数**，即使一个在文件开头，一个在文件结尾
- 如果必须修改现有函数，先删除旧定义再添加新定义
- 使用 IDE 的搜索功能确认函数名唯一性

### 2.2 导出规范
- 所有 `export function` 必须在文件末尾统一导出
- 或使用 `export { func1, func2 }` 方式导出
- **禁止混合使用两种方式导出同名函数**

**错误示例（导致502错误）：**
```javascript
// 第102行
function getAvailableTools(role) { ... }

// 第209行 - 重复声明！
export function getAvailableTools(role) { ... }
```

**正确示例：**
```javascript
// 只保留一个定义
function getAvailableTools(role) {
  // 完整实现
  if (normalizedRole === 'hr_manager') {
    return [...HR_ONLY_TOOLS];
  }
  // ...
}

// 文件末尾统一导出
export { getAvailableTools, ... };
```

### 2.3 修改范围控制
- **小步修改**：一次只修改1-2个文件
- **避免大重构**：不要在修复bug时进行代码重构
- **增量验证**：每修改一个文件就执行语法检查

### 2.4 关键文件保护
以下文件修改时需要特别谨慎：
- `agents.js` - 核心Agent逻辑
- `hq-brain-config.js` - 权限和模型配置
- `master-agent.js` - 主Agent协调器
- `index.js` - 服务入口

**修改前必须：**
1. 完整备份原文件
2. 在本地测试通过
3. 使用部署脚本自动部署

## 三、部署流程（强制执行）

### 3.1 必须使用部署脚本
```bash
# 正确方式
bash .windsurf/workflows/hrms-deploy.sh

# 错误方式（严禁）
rsync -avz ...  # 直接rsync，无检查
systemctl restart hrms.service  # 直接重启，无验证
```

### 3.2 部署前必须确认
- [ ] 所有修改的文件已执行 `node --check`
- [ ] 无重复函数定义
- [ ] 本地 `git diff` 已审查
- [ ] 已备份当前生产版本
- [ ] 部署脚本可执行

### 3.3 部署后必须验证
- [ ] 健康检查 HTTP 200
- [ ] Node进程正常运行
- [ ] 端口3000在监听
- [ ] 可正常登录系统

## 四、紧急回滚流程

如果部署后出现问题：

```bash
# 1. 立即停止服务
ssh root@47.100.96.30 "systemctl stop hrms.service"

# 2. 找到最新备份
ssh root@47.100.96.30 "ls -t /opt/hrms/hr-management-system/server.backup.* | head -1"

# 3. 回滚到备份
ssh root@47.100.96.30 "
    cd /opt/hrms/hr-management-system
    rm -rf server
    cp -r server.backup.YYYYMMDD_HHMMSS server
    systemctl start hrms.service
"

# 4. 验证恢复
curl -s http://47.100.96.30:3000/ | head -5
```

## 五、常见错误预防

### 5.1 SyntaxError: Identifier 'xxx' has already been declared
**原因**：函数重复声明  
**预防**：
```bash
grep -n "function getAvailableTools" hq-brain-config.js
# 确保只有一行输出
```

### 5.2 Error: Cannot find module
**原因**：缺少依赖或路径错误  
**预防**：部署前在服务器执行 `npm install`

### 5.3 FATAL: Peer authentication failed
**原因**：PostgreSQL认证配置错误  
**预防**：保持 `pg_hba.conf` 中 `md5` 认证方式

### 5.4 502 Bad Gateway
**原因**：Node服务未启动  
**预防**：部署后执行健康检查

## 六、监控告警检查项

### 6.1 每日检查
- [ ] 服务状态: `systemctl status hrms.service`
- [ ] 端口监听: `ss -tlnp | grep :3000`
- [ ] 磁盘空间: `df -h /opt`
- [ ] 日志错误: `journalctl -u hrms --since '24 hours ago' | grep -i error | wc -l`

### 6.2 每周检查
- [ ] 备份完整性: 确认备份文件存在且可恢复
- [ ] 数据库连接: 测试PostgreSQL连接
- [ ] 安全更新: 检查系统包更新

### 6.3 每月检查
- [ ] 性能分析: 检查慢查询日志
- [ ] 安全审计: 检查异常登录和访问

## 七、责任分工

| 角色 | 职责 |
|------|------|
| 开发者 | 执行修改前检查清单，确保代码质量 |
| 部署人员 | 严格执行部署脚本，验证部署结果 |
| 运维人员 | 监控服务状态，处理告警 |

## 八、违规处罚

**严禁以下行为：**
1. ❌ 不执行语法检查直接部署
2. ❌ 不使用部署脚本手动rsync
3. ❌ 部署后不验证服务状态
4. ❌ 修改关键文件不备份

**违反规范导致系统故障的，必须：**
1. 编写事故报告
2. 修复流程缺陷
3. 重新学习本规范

---

**最后更新：2026-02-27**  
**适用范围：HRMS生产环境所有代码修改和部署**
