---
description: PostgreSQL 数据库连接配置（避免密码认证卡死）
---

# PostgreSQL 数据库连接配置指南

## 问题现象
在执行 PostgreSQL 相关命令时，系统会卡住等待密码输入，导致操作无法继续。

## 解决方案

### 1. 使用 sudo -u postgres 执行命令
对于需要 postgres 超级用户权限的操作，使用以下格式：

```bash
sudo -u postgres psql -d hrms -c "YOUR_SQL_COMMAND"
```

### 2. 使用 hrms 用户执行命令
对于日常操作，使用 hrms 用户（无需密码）：

```bash
sudo -u hrms psql -d hrms -c "YOUR_SQL_COMMAND"
```

### 3. 通过应用程序执行 SQL
最佳实践：在应用启动时通过运行时迁移执行 SQL，避免直接操作数据库。

示例（在 server/index.js 的 app.listen 回调中）：
```javascript
await pool.query(`CREATE TABLE IF NOT EXISTS your_table (...)`).catch(e => console.warn('[migration]:', e?.message));
```

### 4. 使用临时 SQL 文件
如果必须执行复杂 SQL：

```bash
# 1. 创建临时 SQL 文件
cat > /tmp/migration.sql <<'EOF'
CREATE TABLE IF NOT EXISTS ...;
CREATE INDEX IF NOT EXISTS ...;
EOF

# 2. 执行 SQL 文件
sudo -u postgres psql -d hrms -f /tmp/migration.sql

# 3. 清理
rm /tmp/migration.sql
```

## 注意事项

1. **永远不要**直接使用 `psql -U postgres` 或 `psql -U hrms`，这会触发密码认证
2. **优先使用**应用程序运行时迁移，而不是手动执行 SQL
3. **测试连接**时使用 `sudo -u hrms psql -d hrms -c "SELECT 1"`
4. **查看表结构**使用 `sudo -u hrms psql -d hrms -c "\dt"`

## 常用命令示例

```bash
# 列出所有表
sudo -u hrms psql -d hrms -c "\dt"

# 查询表数据
sudo -u hrms psql -d hrms -c "SELECT COUNT(*) FROM files"

# 创建表
sudo -u postgres psql -d hrms -c "CREATE TABLE IF NOT EXISTS test_table (id SERIAL PRIMARY KEY)"

# 删除表
sudo -u postgres psql -d hrms -c "DROP TABLE IF EXISTS test_table"
```

## 相关配置

- 数据库名称: `hrms`
- 应用用户: `hrms`
- 超级用户: `postgres`
- 连接字符串: `postgresql://localhost:5432/hrms`
- 配置文件: `/opt/hrms/hr-management-system/server/.env`
