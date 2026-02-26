---
description: 飞书多维表格同步配置指南
---
## 飞书多维表格同步与BI数据源配置标准流程

当你需要新增或检查飞书多维表格的同步时，请严格按照以下步骤操作，确保所有表格都作为 BI 的数据源，并且数据能按最新日期排序拉取。

### 1. 确认飞书端权限（非常重要）
对于每一个需要同步的多维表格，**必须**在飞书端将对应的应用添加为“可阅读”的协作者。
- 营运检查表：需授权给 `cli_a91dae9f9578dcb1`
- 桌访表及其他报告（开档、收档、例会、差评、原料）：需授权给 `cli_a9fc0d13c838dcd6`
- 如果未授权，接口会直接报错 `RolePermNotAllow` (1254302)，导致数据永远无法同步。

### 2. 配置后端 `BITABLE_CONFIGS` (server/agents.js)
在 `server/agents.js` 的 `BITABLE_CONFIGS` 对象中，确保为表格添加配置。
**强制要求**：必须添加 `sortField` 属性，以保证每次轮询拉取的是最新数据（否则只会一直拉取最老的20条数据）。
- 如果表格有明确的日期字段（如“日期”或“创建日期”），使用：`sortField: '["日期 DESC"]'`
- 如果没有，使用默认记录ID排序：`sortField: '["_id DESC"]'`

示例：
```javascript
'table_visit': {
  appId: 'cli_a9fc0d13c838dcd6',
  appSecret: '...',
  appToken: '...',
  tableId: 'tblpx5Efqc6eHo3L',
  name: '桌访表',
  type: 'table_visit',
  pollingInterval: 300000, // 5分钟
  sortField: '["日期 DESC"]' // 必须配置排序
}
```

### 3. 配置解析逻辑 (server/agents.js)
在 `processBitableData` 和对应的 `processXxxData` 函数中，确保解析逻辑能正确读取表格字段。
对于像差评报告这样不是由表单直接提交的表，也必须在 `processBitableData` 的 switch case 中添加对应类型（如 `case 'bad_review': return await processBadReviewData(records);`），并编写解析插入数据库的函数。

### 4. 注册为 BI 数据源 (server/agents.js)
在 `BI_AGENT_CONFIG.dataSources` 中，必须将该表格对应的 key 设置为 `enabled: true`，确保 BI Agent 可以将其作为分析的数据源。
```javascript
let BI_AGENT_CONFIG = {
  dataSources: [
    { key: 'table_visit_bitable', enabled: true },
    { key: 'bad_reviews', enabled: true },
    // 确保新增的表格在这里注册
  ]
};
```

### 5. 重启后端服务
完成配置和代码修改后，务必重启后端服务以使轮询任务和新配置生效：
```bash
systemctl restart hrms.service
```
