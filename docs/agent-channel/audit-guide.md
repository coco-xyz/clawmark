# 审计指南

本文档介绍 ClawMark 的完整审计体系——记录了什么、存储在哪、如何查询、保留多久，以及如何进行合规性审查。

---

## 概述

ClawMark 提供三层审计记录，覆盖 Agent 的所有操作行为：

| 审计层 | 数据表 | 记录内容 |
|--------|--------|----------|
| **Agent 行为日志** | `agent_actions` | 感知捕获、Issue 创建/更新、分类等高层操作 |
| **CDP 操作审计** | `cdp_audit_log` | 浏览器 CDP 命令执行（页面操作） |
| **Webhook 投递记录** | `webhook_deliveries` | Webhook 投递状态、重试、错误 |
| **分发日志** | `dispatch_log` | Item 分发到各渠道的完整记录 |

所有日志按 `app_id` 隔离，确保多租户数据安全。

---

## 一、Agent 行为日志

### 记录内容

每当 Agent 执行操作，系统自动记录一条 `agent_actions` 记录：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 唯一 ID |
| `app_id` | string | 所属应用 |
| `agent_id` | string | 执行操作的 Agent |
| `action_type` | string | 操作类型（见下表） |
| `target_type` | string | 操作目标类型（如 `perception_issue`） |
| `target_id` | string | 操作目标 ID |
| `summary` | string | 操作摘要（人可读） |
| `status` | string | 结果：`success` / `error` |
| `metadata` | JSON | 额外元数据 |
| `created_at` | ISO 8601 | 操作时间 |

**操作类型一览：**

| action_type | 触发时机 |
|-------------|----------|
| `perception_capture` | Agent 上报感知事件 |
| `issue_created` | Agent 自动创建追踪 Issue |
| `issue_updated` | Agent 更新已有 Issue（计数/时间） |
| `cdp_action` | Agent 通过 CDP 执行浏览器操作 |
| `auto_fix` | Agent 尝试自动修复 |
| `classification` | AI 自动分类标注 |
| `tag_generation` | AI 自动生成标签 |

### 查询方式

```bash
# 查询最近 7 天所有操作
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3458/api/v2/analytics/agent-actions?days=7&limit=200"

# 按 Agent 过滤
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3458/api/v2/analytics/agent-actions?agent_id=abc123&days=30"

# 按操作类型过滤
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3458/api/v2/analytics/agent-actions?action_type=issue_created&days=30"
```

---

## 二、CDP 操作审计

### 记录内容

当 Agent 通过 CDP（Chrome DevTools Protocol）执行浏览器操作时，每条命令都会记录：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 唯一 ID |
| `app_id` | string | 所属应用 |
| `agent_id` | string | 执行操作的 Agent |
| `session_key` | string | CDP 会话标识 |
| `tab_id` | number | 目标浏览器 Tab ID |
| `method` | string | CDP 方法名（如 `Page.navigate`、`DOM.querySelector`） |
| `params_hash` | string | 参数哈希（防止记录敏感参数明文） |
| `status` | string | `sent` / `success` / `error` |
| `result_summary` | string | 执行结果摘要 |
| `error` | string | 错误信息（如有） |
| `duration_ms` | number | 执行耗时（毫秒） |
| `created_at` | ISO 8601 | 操作时间 |

### 安全设计

- **参数哈希**：CDP 参数可能包含敏感内容（如输入的文本），仅记录哈希值而非明文
- **白名单机制**：仅允许安全的 CDP 方法执行（参考 `docs/agent-channel/cdp-whitelist.md`）
- **会话绑定**：每条操作都关联到具体的 Agent 和 Session

### 查询方式

CDP 审计日志目前通过数据库直接查询：

```sql
-- 查询某 Agent 最近的 CDP 操作
SELECT * FROM cdp_audit_log
WHERE agent_id = 'abc123'
ORDER BY created_at DESC
LIMIT 50;

-- 查询某会话的所有操作
SELECT * FROM cdp_audit_log
WHERE session_key = 'session-xyz'
ORDER BY created_at ASC;

-- 统计各方法的使用频率
SELECT method, COUNT(*) AS cnt, AVG(duration_ms) AS avg_ms
FROM cdp_audit_log
WHERE app_id = 'your-app-id' AND created_at > datetime('now', '-7 days')
GROUP BY method
ORDER BY cnt DESC;
```

---

## 三、Webhook 投递记录

### 记录内容

每次 Webhook 投递（成功或失败）都记录在 `webhook_deliveries` 表：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 唯一 ID |
| `webhook_id` | string | 关联的 Webhook |
| `event_type` | string | 事件类型 |
| `payload` | JSON | 实际发送的载荷 |
| `status` | string | `pending` / `delivered` / `failed` |
| `status_code` | number | HTTP 响应码 |
| `error` | string | 错误信息 |
| `attempt` | number | 当前尝试次数（1–4） |
| `next_retry_at` | ISO 8601 | 下次重试时间 |
| `created_at` | ISO 8601 | 创建时间 |
| `delivered_at` | ISO 8601 | 成功投递时间 |

### 查询方式

```bash
# 通过 API 查询指定 Webhook 的投递历史
curl -H "X-Agent-Key: cmak_xxx" \
  "http://localhost:3458/api/v2/agent-channel/webhooks/{webhook_id}/deliveries?limit=50"
```

---

## 四、分发日志

### 记录内容

Item 分发到外部渠道（GitHub、GitLab、Slack、Lark、Email 等）的完整记录：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 唯一 ID |
| `item_id` | string | 关联的 Item |
| `target_type` | string | 渠道类型：`github-issue` / `gitlab-issue` / `lark` / `slack` / `webhook` / `email` |
| `target_config` | JSON | 渠道配置（脱敏） |
| `event` | string | 触发事件：`item.created` / `item.resolved` / `item.assigned` |
| `status` | string | `pending` / `delivered` / `failed` |
| `retries` | number | 重试次数 |
| `last_error` | string | 最近错误信息 |
| `external_id` | string | 外部系统 ID（如 GitHub Issue 号） |
| `external_url` | string | 外部系统链接 |
| `method` | string | 路由方式：`target_declaration` / `user_rule` / `github_auto` / `system_default` |
| `app_id` | string | 所属应用 |
| `auth_id` | string | 使用的认证凭据 |
| `created_at` | ISO 8601 | 创建时间 |
| `updated_at` | ISO 8601 | 最后更新时间 |

### 查询方式

```bash
# 查询指定 Item 的分发记录
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3458/api/v2/distributions/{item_id}

# 重试失败的分发
curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://localhost:3458/api/v2/distributions/{item_id}/retry
```

---

## 五、日志存储

### 存储位置

所有审计日志存储在 ClawMark 的 SQLite 数据库中：

```
{dataDir}/clawmark.db
```

默认 `dataDir` 为 `./data`，可通过配置或 `CLAWMARK_DATA_DIR` 环境变量修改。

### 数据库表清单

| 表 | 用途 |
|----|------|
| `agent_actions` | Agent 高层操作日志 |
| `cdp_audit_log` | CDP 浏览器操作审计 |
| `webhook_deliveries` | Webhook 投递记录 |
| `dispatch_log` | Item 分发记录 |
| `perception_events` | 原始感知事件（数据源） |
| `perception_issues` | 去重后的追踪 Issue |

### 备份建议

SQLite WAL 模式支持并发读写。建议定期备份：

```bash
# 使用 SQLite 的 .backup 命令（在线备份，不锁库）
sqlite3 data/clawmark.db ".backup data/clawmark-backup-$(date +%Y%m%d).db"

# 或直接复制（需确保无写入进行中）
cp data/clawmark.db data/clawmark-backup.db
```

---

## 六、保留策略

ClawMark 内置了过期数据清理机制：

| 数据类型 | 默认保留期 | 清理方式 |
|----------|-----------|----------|
| `cdp_audit_log` | 可配置 | `deleteOld(cutoff_date)` 定期清理 |
| `webhook_deliveries` | 可配置 | `deleteOldDeliveries(cutoff_date)` 定期清理 |
| `perception_events` | 无自动清理 | 需手动或定时任务清理 |
| `agent_actions` | 无自动清理 | 需手动或定时任务清理 |
| `dispatch_log` | 无自动清理 | 需手动或定时任务清理 |

### 手动清理示例

```sql
-- 清理 30 天前的 CDP 审计日志
DELETE FROM cdp_audit_log
WHERE created_at < datetime('now', '-30 days');

-- 清理 90 天前的 Webhook 投递记录
DELETE FROM webhook_deliveries
WHERE created_at < datetime('now', '-90 days');

-- 清理 180 天前的感知事件（保留 Issue 摘要）
DELETE FROM perception_events
WHERE created_at < datetime('now', '-180 days');

-- 清理 90 天前的 Agent 行为日志
DELETE FROM agent_actions
WHERE created_at < datetime('now', '-90 days');
```

### 建议定时任务

```bash
# 添加 cron job（每周日 3:00 AM 清理）
0 3 * * 0 sqlite3 /path/to/data/clawmark.db "DELETE FROM cdp_audit_log WHERE created_at < datetime('now', '-30 days'); DELETE FROM webhook_deliveries WHERE created_at < datetime('now', '-90 days');"
```

---

## 七、数据导出

### 导出为 CSV

```bash
# 导出 Agent 行为日志
sqlite3 -header -csv data/clawmark.db \
  "SELECT * FROM agent_actions WHERE created_at > '2026-03-01'" \
  > agent-actions-export.csv

# 导出 CDP 审计日志
sqlite3 -header -csv data/clawmark.db \
  "SELECT * FROM cdp_audit_log WHERE created_at > '2026-03-01'" \
  > cdp-audit-export.csv

# 导出分发记录
sqlite3 -header -csv data/clawmark.db \
  "SELECT * FROM dispatch_log WHERE created_at > '2026-03-01'" \
  > dispatch-log-export.csv
```

### 导出为 JSON

```bash
sqlite3 -json data/clawmark.db \
  "SELECT * FROM agent_actions WHERE created_at > '2026-03-01' LIMIT 1000" \
  > agent-actions-export.json
```

---

## 八、合规性审查清单

进行定期合规性审查时，按以下清单逐项检查：

### 数据完整性

- [ ] 所有 Agent 操作是否都有对应的 `agent_actions` 记录
- [ ] CDP 操作是否全部记录（检查 `cdp_audit_log` 无遗漏）
- [ ] Webhook 投递失败是否都有错误记录
- [ ] 分发记录中 `failed` 状态的是否都已处理或重试

### 访问控制

- [ ] Agent API Key 是否定期轮转（`POST /agents/:id/rotate-key`）
- [ ] 是否有 Agent 长期未使用但状态仍为 `active`
- [ ] JWT Token 是否设置了合理的过期时间
- [ ] 数据库文件权限是否仅限服务进程访问

### 数据安全

- [ ] 敏感凭据是否加密存储（`user_auths` 表使用 AES-256 加密）
- [ ] Webhook secret 是否不在列表 API 中暴露（默认已脱敏）
- [ ] CDP 参数是否仅记录哈希（不含明文敏感数据）
- [ ] 数据库备份是否存放在安全位置

### 保留合规

- [ ] 审计日志保留期是否满足合规要求（建议 ≥ 90 天）
- [ ] 过期数据是否按策略定期清理
- [ ] 清理操作本身是否有记录

### 异常检测

```sql
-- 查找异常高频操作的 Agent（可能被滥用）
SELECT agent_id, action_type, COUNT(*) AS cnt
FROM agent_actions
WHERE created_at > datetime('now', '-24 hours')
GROUP BY agent_id, action_type
HAVING cnt > 1000;

-- 查找连续失败的 Webhook（可能配置有误）
SELECT w.id, w.url, w.consecutive_failures
FROM agent_webhooks w
WHERE w.consecutive_failures > 5;

-- 查找失败率高的分发渠道
SELECT target_type, status, COUNT(*) AS cnt
FROM dispatch_log
WHERE created_at > datetime('now', '-7 days')
GROUP BY target_type, status;
```

---

## 九、隐私说明

- **感知事件**：自动过滤敏感字段（token、password、API key），由浏览器端在上报前完成
- **CDP 参数**：仅记录参数哈希值，不存储明文（可能包含用户输入）
- **凭据存储**：`user_auths` 表中的凭据使用 AES-256-GCM 加密，密钥通过 `config.auth.encryptionKey` 配置
- **Webhook 载荷**：`webhook_deliveries` 中保存实际发送的载荷，用于调试和重试；包含脱敏后的错误信息
