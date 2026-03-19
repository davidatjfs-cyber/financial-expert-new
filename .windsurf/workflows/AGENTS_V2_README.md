# Agents V2 部署与替换说明

## 1. 部署路径（必读）

- **正确部署路径**：`/opt/agents-service-v2`
- **systemd 服务**：`agents-v2.service`，其中 `WorkingDirectory=/opt/agents-service-v2`
- **部署脚本**：`.windsurf/workflows/agents-v2-deploy.sh` 中 `SERVER_PATH` 必须与上述路径一致，否则部署到错误目录会导致线上无任何变化。
- 脚本在「步骤2」会校验 `SERVER_PATH` 与 systemd 的 `WorkingDirectory` 是否一致，不一致将直接报错退出。

## 2. Agent V2 已替换 V1 的判定

- **飞书事件（消息/卡片）**：若飞书应用「事件订阅」请求地址指向 **Agents V2**（例如 `http(s)://服务器:3100/api/webhook/feishu`），则由 V2 处理，表示 **V2 已替换 V1**。
- 若请求地址仍指向 **HRMS**（例如 `https://nnyx.cc/api/webhook/feishu`），则仍由 V1（hr-management-system/server/agents.js）处理，V2 未替换 V1。
- 确认方式：在飞书开放平台 → 应用 → 事件订阅 → 请求地址，查看配置的 URL 属于 HRMS 还是 agents-v2（端口 3100）。

## 3. 数据源与门店映射

- 桌访/差评等飞书多维表使用字段 **所属门店**（如「马己仙大宁店」「洪潮久光店」）。
- HRMS / daily_reports 使用全称（如「马己仙上海音乐广场店」）。门店映射见 `agents-service-v2/src/config/store-mapping.js`，查询时需同时匹配全称与映射后的飞书门店名，否则会出现「桌访为 0」等无数据问题。
