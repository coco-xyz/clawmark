# Agent Channel API 参考

**版本:** v1.0
**基础 URL:** `http://localhost:3458`（或部署后的服务器地址）

---

## 认证

Agent Channel 端点支持两种认证方式：

### 1. 用户 JWT（管理操作）

Agent 注册、列表、更新、删除等管理操作使用用户 JWT：

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

### 2. Agent API Key（数据上报）

Perception 事件上报支持 Agent API Key 认证（`cmak_` 前缀）：

```
X-Agent-Key: cmak_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

> Agent Key 在注册时返回一次，之后无法查看。请妥善保存。丢失后只能 rotate 生成新 key。

---

## Agent 注册与管理

### POST /api/v2/agent-channel/register

注册新 Agent，获取 API Key。

**认证:** JWT

**请求体:**

```json
{
  "name": "my-error-sentinel",
  "callback_url": "https://my-agent.example.com/webhook",
  "capabilities": ["perception", "action"]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | ✅ | Agent 名称（1-100 字符） |
| callback_url | string | 否 | Agent 回调 URL |
| capabilities | string[] | 否 | 能力标签（如 perception, action） |

**成功响应 201:**

```json
{
  "id": "agent-uuid",
  "app_id": "app-uuid",
  "name": "my-error-sentinel",
  "status": "active",
  "key_prefix": "cmak_a1b2c3d4...",
  "callback_url": "https://my-agent.example.com/webhook",
  "capabilities": ["perception", "action"],
  "created_by": "user@example.com",
  "created_at": "2026-03-22T10:00:00.000Z",
  "api_key": "cmak_a1b2c3d4e5f6..."
}
```

> ⚠️ `api_key` 仅在创建时返回一次。

**错误响应:**

| Code | 说明 |
|------|------|
| 400 | name 缺失或不合法（空/超 100 字符） |
| 400 | callback_url 或 capabilities 类型错误 |
| 401 | JWT 无效或缺失 |
| 429 | 注册频率超限 |
| 500 | 服务端存储错误 |

---

### GET /api/v2/agent-channel/agents

列出当前 App 下所有 Agent。

**认证:** JWT

**成功响应 200:**

```json
{
  "agents": [
    {
      "id": "agent-uuid",
      "name": "my-error-sentinel",
      "status": "active",
      "key_prefix": "cmak_a1b2c3d4...",
      "callback_url": null,
      "capabilities": ["perception"],
      "last_seen": "2026-03-22T12:00:00.000Z"
    }
  ]
}
```

**错误响应:**

| Code | 说明 |
|------|------|
| 400 | 无 app context |
| 401 | JWT 无效 |

---

### GET /api/v2/agent-channel/agents/:id

获取单个 Agent 详情。

**认证:** JWT

**成功响应 200:** 同上，单个 agent 对象。

**错误响应:**

| Code | 说明 |
|------|------|
| 400 | 无 app context |
| 401 | JWT 无效 |
| 404 | Agent 不存在（或不属于当前 App） |

---

### PUT /api/v2/agent-channel/agents/:id

更新 Agent 元数据。

**认证:** JWT

**请求体:**（所有字段可选）

```json
{
  "name": "updated-name",
  "callback_url": "https://new-url.example.com/webhook",
  "capabilities": ["perception", "action", "session"]
}
```

**成功响应 200:** 返回更新后的 agent 对象。

**错误响应:**

| Code | 说明 |
|------|------|
| 400 | 无 app context |
| 401 | JWT 无效 |
| 404 | Agent 不存在 |
| 500 | 更新失败 |

---

### DELETE /api/v2/agent-channel/agents/:id

停用 Agent（软删除，设为 inactive）。

**认证:** JWT

**成功响应 200:**

```json
{ "id": "agent-uuid", "status": "inactive" }
```

**错误响应:**

| Code | 说明 |
|------|------|
| 400 | 无 app context |
| 401 | JWT 无效 |
| 404 | Agent 不存在 |

---

### POST /api/v2/agent-channel/agents/:id/rotate-key

轮转 Agent API Key。旧 key 立即失效。

**认证:** JWT

**成功响应 200:**

```json
{
  "id": "agent-uuid",
  "api_key": "cmak_new_key_xxxxxxxxxx",
  "key_prefix": "cmak_new_key_..."
}
```

> ⚠️ 新 `api_key` 仅此处返回一次。轮转后旧 key 立即失效，所有使用旧 key 的客户端需要更新。

**错误响应:**

| Code | 说明 |
|------|------|
| 400 | 无 app context |
| 401 | JWT 无效 |
| 404 | Agent 不存在 |

---

## Perception 事件（感知层）

### POST /api/v2/agent-channel/perception

上报感知事件（来自浏览器扩展的错误、网络异常、性能数据等）。

**认证:** JWT 或 Agent Key

**请求体:**

```json
{
  "instance_id": "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee",
  "events": [
    {
      "type": "runtime-error",
      "message": "TypeError: Cannot read property 'x' of undefined",
      "stack": "at App.render (app.js:42:15)\nat ...",
      "source": "app.js",
      "line": 42,
      "severity": "error",
      "url": "https://example.com/dashboard",
      "fingerprint": "a1b2c3d4e5f6g7h8",
      "context": {
        "userAgent": "Chrome/120",
        "timestamp": 1711100000000
      }
    }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| instance_id | string (UUID v4) | 否 | 浏览器实例标识（#118 多实例支持）。每个 Chrome Profile 生成唯一 UUID，用于区分来自不同浏览器实例的事件。Server 会透传给 Agent WebSocket 推送。 |
```

**events 数组元素字段:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| type | string | 否 | 事件类型（runtime-error / network-error / console-error / slow-request / resource-error / long-task），默认 "unknown" |
| message | string | 否 | 错误消息（最长 4096 字符） |
| stack | string | 否 | 调用栈（最长 8192 字符） |
| source | string | 否 | 来源文件（最长 2048 字符） |
| line | number | 否 | 行号 |
| severity | string | 否 | 严重级别：critical / error / warning / info，默认 "error" |
| url | string | 否 | 发生页面 URL（最长 2048 字符） |
| fingerprint | string | ✅ | 事件指纹（用于去重），无 fingerprint 的事件会被拒绝 |
| context | object | 否 | 自定义上下文数据 |

**限制:**
- 每次请求最多 100 个事件
- 缺少 fingerprint 的事件会被过滤

**成功响应 200:**

```json
{
  "created": 3,
  "events": [...]
}
```

**错误响应:**

| Code | 说明 |
|------|------|
| 400 | events 不是非空数组 |
| 400 | 超过 100 个事件 |
| 400 | 所有事件都缺少 fingerprint |
| 400 | 无 app context |
| 401 | 认证失败 |
| 429 | 写入频率超限 |
| 500 | 存储失败 |

---

### GET /api/v2/agent-channel/perception

查询感知事件（Agent 消费者拉取用）。

**认证:** JWT 或 Agent Key

**查询参数:**

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| cursor | string | null | 游标（上次返回的 cursor 值），用于增量拉取 |
| limit | number | 100 | 返回数量（最大 500） |

**成功响应 200:**

```json
{
  "events": [...],
  "cursor": "2026-03-22T12:00:00.000Z",
  "count": 50
}
```

**用法示例 — 增量拉取:**

```bash
# 首次拉取
curl -H "X-Agent-Key: cmak_xxx" \
  "http://localhost:3458/api/v2/agent-channel/perception?limit=100"

# 后续增量（使用上次返回的 cursor）
curl -H "X-Agent-Key: cmak_xxx" \
  "http://localhost:3458/api/v2/agent-channel/perception?cursor=2026-03-22T12:00:00.000Z&limit=100"
```

---

### GET /api/v2/agent-channel/perception/stats

按 fingerprint 聚合的错误统计。

**认证:** JWT 或 Agent Key

**查询参数:**

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| limit | number | 50 | 返回数量（最大 200） |

**成功响应 200:**

```json
{
  "stats": [
    {
      "fingerprint": "a1b2c3d4...",
      "type": "runtime-error",
      "message": "TypeError: ...",
      "count": 42,
      "first_seen": "2026-03-20T08:00:00.000Z",
      "last_seen": "2026-03-22T12:00:00.000Z"
    }
  ]
}
```

---

### GET /api/v2/agent-channel/perception/issues

查询已追踪的 perception issues（经去重后自动创建的问题记录）。

**认证:** JWT 或 Agent Key

**成功响应 200:**

```json
{
  "issues": [
    {
      "fingerprint": "a1b2c3d4...",
      "count": 42,
      "first_seen": "2026-03-20T08:00:00.000Z",
      "last_seen": "2026-03-22T12:00:00.000Z",
      "gitlab_issue_id": "95",
      "gitlab_issue_url": "https://git.coco.xyz/hxanet/clawmark/-/issues/95"
    }
  ]
}
```

---

### POST /api/v2/agent-channel/perception/issues

Upsert 一个追踪 issue（Agent 消费者去重后调用）。

**认证:** JWT 或 Agent Key

**请求体:**

```json
{
  "fingerprint": "a1b2c3d4...",
  "count": 5,
  "first_seen": "2026-03-20T08:00:00.000Z",
  "last_seen": "2026-03-22T12:00:00.000Z",
  "gitlab_issue_id": "95",
  "gitlab_issue_url": "https://git.coco.xyz/hxanet/clawmark/-/issues/95"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| fingerprint | string | ✅ | 错误指纹 |
| count | number | 否 | 本批次新增计数 |
| first_seen | string | 否 | 首次出现时间（ISO8601） |
| last_seen | string | 否 | 最近出现时间（ISO8601） |
| gitlab_issue_id | string | 否 | 关联的 GitLab issue ID |
| gitlab_issue_url | string | 否 | 关联的 GitLab issue URL |

**成功响应 200:** 返回 upsert 后的 issue 对象。

**错误响应:**

| Code | 说明 |
|------|------|
| 400 | fingerprint 缺失 |
| 400 | 无 app context |
| 401 | 认证失败 |
| 500 | 存储失败 |

---

## 频率限制

| 端点类别 | 限制 |
|----------|------|
| 写操作（POST/PUT/DELETE） | `apiWriteLimiter` |
| 读操作（GET） | `apiReadLimiter` |
| Agent 注册 | `agentRegisterLimiter`（更严格） |

> 超限时返回 HTTP 429 Too Many Requests。

---

## 多实例支持 (#117)

### instance_id

每个 Chrome Profile（浏览器实例）在首次安装扩展时生成一个 UUID v4 作为 `instance_id`，存储在 `chrome.storage.local` 中。

**数据流：**
1. 扩展端上报 perception 事件时在 POST body 中附带 `instance_id`
2. Server 存储 `instance_id` 到 `perception_events` 和 `sessions` 表
3. Server 通过 WebSocket 推送事件时透传 `instance_id` 给 Agent
4. zylos-clawmark 组件解析 `instance_id`，并使用 fingerprint 去重避免同一事件被多个实例重复处理

### target_instance（Action 路由）

Agent 发送 Action 时可指定 `target_instance` 参数，将命令路由到特定浏览器实例。

**路由优先级：**
1. `target_instance` — 精确指定目标实例
2. `session_id` 粘性路由 — 同一 session 的后续 action 自动路由到上次响应的实例
3. 最近活跃 — 选择最近有活动的扩展连接

**WebSocket Action 协议消息：**

```json
// Agent → Server
{ "type": "action", "action_type": "click", "payload": {"selector": "#btn"}, "target_instance": "uuid-of-instance" }

// Server → Agent (结果)
{ "type": "result", "action_id": "act-123", "status": "completed", "result": {...}, "instance_id": "uuid-of-instance" }
```

### zylos-clawmark 组件

组件自动处理多实例场景：
- **Perception 去重：** 同一 fingerprint + type + message 在 5 秒内只处理一次，避免多实例重复上报
- **instance_id 解析：** 事件的 `instance_id` 字段在 C4 消息和日志中展示
- **Action target_instance：** `send.js` 支持 `--target-instance <id>` 参数指定目标实例

```bash
# 指定目标实例
node scripts/send.js <binding_id> click '{"selector":"#btn"}' --target-instance <instance_id>
```

---

## curl 示例

### 注册 Agent

```bash
curl -X POST http://localhost:3458/api/v2/agent-channel/register \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-sentinel", "capabilities": ["perception"]}'
```

### 上报事件

```bash
curl -X POST http://localhost:3458/api/v2/agent-channel/perception \
  -H "X-Agent-Key: cmak_xxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "events": [{
      "type": "runtime-error",
      "message": "TypeError: null is not an object",
      "severity": "error",
      "url": "https://example.com/app",
      "fingerprint": "abc123def456"
    }]
  }'
```

### 轮转 Key

```bash
curl -X POST http://localhost:3458/api/v2/agent-channel/agents/AGENT_ID/rotate-key \
  -H "Authorization: Bearer $JWT_TOKEN"
```
