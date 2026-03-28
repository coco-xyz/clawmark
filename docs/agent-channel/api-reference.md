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

---

## Sessions（会话录制）

Session 端点用于录制和回放浏览器会话（DOM 变更、用户操作、网络错误等）。

### POST /api/v2/agent-channel/sessions

创建新 session 或追加事件到已有 session（分块上传）。

**认证:** JWT / Agent Key

**请求体:**

```json
{
  "session_id": "string (可选，提供则追加到已有 session)",
  "tab_id": "string (可选)",
  "url": "https://example.com/page",
  "title": "Page Title",
  "start_time": "2026-03-28T10:00:00.000Z",
  "events": [
    {
      "type": "dom-mutation|console-log|console-error|network-error|click|scroll",
      "timestamp": "2026-03-28T10:00:01.000Z"
    }
  ],
  "snapshots": [
    { "id": "snap-1", "html": "<html>...</html>" }
  ],
  "metadata": {}
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| session_id | string | 否 | 提供则追加到已有 session |
| start_time | ISO 8601 | ✅ | 会话开始时间 |
| events | array | 否 | 事件列表（单次最多 1000） |
| snapshots | array | 否 | DOM 快照列表（单次最多 100） |

**成功响应 201:**

```json
{
  "id": "session-uuid",
  "app_id": "app-uuid",
  "agent_id": "agent-uuid",
  "event_count": 42,
  "snapshot_count": 2
}
```

**错误响应:**

| Code | 说明 |
|------|------|
| 400 | start_time 格式无效或 event type 不合法 |
| 409 | 尝试追加到已 finalize 的 session |
| 413 | Session 超过 50MB 大小限制 |

### POST /api/v2/agent-channel/sessions/:id/finalize

标记 session 完成，不可再追加事件。

**认证:** JWT / Agent Key

**请求体:** `{}`

**成功响应 200:**

```json
{
  "id": "session-uuid",
  "status": "finalized",
  "event_count": 156,
  "snapshot_count": 5
}
```

### GET /api/v2/agent-channel/sessions

列出 sessions。

**认证:** JWT / Agent Key

**查询参数:**

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| agent_id | string | — | 按 agent 过滤 |
| site | string | — | 按站点 URL 过滤 |
| after | ISO 8601 | — | 只返回此时间之后创建的 session |
| limit | number | 50 | 最大 500 |

**成功响应 200:**

```json
{
  "sessions": [
    {
      "id": "session-uuid",
      "app_id": "string",
      "agent_id": "string",
      "url": "https://example.com",
      "title": "Page Title",
      "start_time": "2026-03-28T10:00:00.000Z",
      "end_time": "2026-03-28T10:05:00.000Z",
      "status": "open|finalized",
      "event_count": 156,
      "snapshot_count": 5
    }
  ],
  "count": 1
}
```

### GET /api/v2/agent-channel/sessions/:id

获取 session 详情及事件。

**认证:** JWT / Agent Key

**查询参数:**

| 参数 | 类型 | 说明 |
|------|------|------|
| start_time | ISO 8601 | 过滤事件的起始时间 |
| end_time | ISO 8601 | 过滤事件的结束时间 |
| include_snapshots | boolean | 是否包含快照数据（`true` 或 `1`） |

### GET /api/v2/agent-channel/sessions/:id/snapshots/:snapshotId

获取指定快照的完整 HTML 内容。

---

## Webhooks（事件通知）

Webhook 端点用于接收 Perception 错误通知的 HTTP 回调。

### POST /api/v2/agent-channel/webhooks

注册 webhook。

**认证:** Agent Key（必须）

**请求体:**

```json
{
  "url": "https://my-service.com/webhook",
  "secret": "string (可选，自动生成)",
  "event_filters": {
    "severity": ["P0", "P1"],
    "types": ["js-error", "network-error"],
    "sites": ["example.com"]
  },
  "template": "default|slack|lark|dingtalk",
  "allow_http": false
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | string | ✅ | 回调 URL（默认要求 HTTPS） |
| secret | string | 否 | HMAC 签名密钥，未提供则自动生成 |
| event_filters | object | 否 | 过滤条件（severity/types/sites） |
| template | string | 否 | 通知模板格式 |
| allow_http | boolean | 否 | 允许 HTTP（非 HTTPS）URL |

**限制:** 每个 agent 最多 10 个 webhook。

**成功响应 201:**

```json
{
  "id": "webhook-uuid",
  "url": "https://my-service.com/webhook",
  "secret": "auto-generated-secret",
  "active": true,
  "event_filters": { "severity": ["P0", "P1"] },
  "template": "default",
  "created_at": "2026-03-28T10:00:00.000Z"
}
```

> `secret` 仅在创建时返回一次。

### GET /api/v2/agent-channel/webhooks

列出所有 webhook（secret 字段不返回）。

### GET /api/v2/agent-channel/webhooks/:id

获取 webhook 详情 + 最近 20 条投递记录。

### PUT /api/v2/agent-channel/webhooks/:id

更新 webhook 配置（url, event_filters, template, active）。

### DELETE /api/v2/agent-channel/webhooks/:id

删除 webhook。

### POST /api/v2/agent-channel/webhooks/:id/test

发送测试 payload 验证 webhook 连通性。

### GET /api/v2/agent-channel/webhooks/:id/deliveries

查询 webhook 投递历史。

**查询参数:** `limit`（默认 50，最大 200）

**Webhook 签名验证:**

Server 使用 HMAC-SHA256 签名 payload：

```
X-Signature: sha256=<hex digest>
```

验证示例：
```javascript
const crypto = require('crypto');
const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
if (signature !== `sha256=${expected}`) reject();
```

**重试策略:** 立即 → 30s → 2min → 10min。连续 10 次失败后自动禁用。

---

## Actions（远程操作）

Action 端点允许 Agent 向浏览器扩展发送操作指令。支持 REST 轮询和 WebSocket 实时两种模式。

### REST API

#### POST /api/v2/agent-channel/actions

提交操作请求。

**认证:** Agent Key（必须）

**请求体:**

```json
{
  "action_type": "click|navigate|scroll|evaluate|screenshot",
  "payload": { "selector": "#submit-btn" },
  "session_id": "string (可选)",
  "timeout_ms": 30000
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| action_type | string | ✅ | 操作类型 |
| payload | object | 否 | 操作参数 |
| session_id | string | 否 | 关联的会话 ID |
| timeout_ms | number | 否 | 超时时间（默认 30000ms） |

**限制:** 每个 agent 最多 100 个待处理 action。

**成功响应 201:**

```json
{
  "id": "action-uuid",
  "agent_id": "string",
  "type": "click",
  "status": "queued",
  "created_at": "2026-03-28T10:00:00.000Z"
}
```

#### GET /api/v2/agent-channel/actions/:id

轮询 action 状态和结果。

**响应:**

```json
{
  "id": "action-uuid",
  "type": "click",
  "status": "completed",
  "result": { "success": true },
  "created_at": "2026-03-28T10:00:00.000Z"
}
```

Status 值：`queued` → `dispatched` → `completed` | `failed`

#### GET /api/v2/agent-channel/actions

列出 agent 的 action 历史。

**查询参数:** `status`（默认 `queued`），`limit`（默认 50，最大 500）

#### POST /api/v2/agent-channel/actions/:id/result

扩展端提交 action 结果（WebSocket 不可用时的 HTTP 回退）。

### WebSocket 实时通道

**连接:** `wss://{server}/ws/agent-channel/actions`

**认证（Header）:**

```
X-Agent-Key: cmak_xxxxxxxxxxxx   (Agent 角色)
X-Agent-Key: cmk_xxxxxxxxxxxx    (Extension 角色)
```

**连接成功:**

```json
{ "type": "connected", "role": "agent|extension", "app_id": "string" }
```

**Agent → Extension（发送操作）:**

```json
// Agent 发送
{ "type": "action", "action_type": "click", "payload": { "selector": "#btn" } }

// Server 转发给 Extension
{ "type": "action", "action_id": "uuid", "action_type": "click", "payload": { "selector": "#btn" } }
```

**Extension → Agent（返回结果）:**

```json
// Extension 发送
{ "type": "result", "action_id": "uuid", "result": { "success": true } }

// Server 转发给 Agent
{ "type": "result", "action_id": "uuid", "action_type": "click", "status": "completed", "result": { "success": true } }
```

**心跳:** Server 每 30 秒发送 ping，客户端需响应 `{ "type": "pong" }` 或原生 pong 帧。

**限制:**

| 参数 | 值 |
|------|------|
| 最大消息体 | 1 MB |
| 每 agent 最大待处理 | 100 actions |
| 默认超时 | 30 秒 |

超时的 action 会通知 agent：`{ "type": "result", "status": "failed", "error": "Action timed out" }`

---

## CDP 审计

### GET /api/v2/agent-channel/cdp/audit

查询 CDP（Chrome DevTools Protocol）审计日志。

**认证:** Agent Key

CDP WebSocket 通道 (`/ws/agent-channel/cdp`) 提供浏览器 DevTools Protocol 中继能力，支持 Agent 直接操控浏览器。审计日志记录所有 CDP 命令和结果。

---

## 端点汇总

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| POST | /agent-channel/register | JWT | 注册 Agent |
| GET | /agent-channel/agents | JWT | 列出 Agent |
| GET | /agent-channel/agents/:id | JWT | Agent 详情 |
| PUT | /agent-channel/agents/:id | JWT | 更新 Agent |
| DELETE | /agent-channel/agents/:id | JWT | 删除 Agent |
| POST | /agent-channel/agents/:id/rotate-key | JWT | 轮转 Key |
| POST | /agent-channel/perception | JWT/Agent | 上报事件 |
| GET | /agent-channel/perception | JWT/Agent | 查询事件 |
| GET | /agent-channel/perception/stats | JWT/Agent | 聚合统计 |
| GET/POST | /agent-channel/perception/issues | JWT/Agent | Issue 追踪 |
| POST | /agent-channel/sessions | JWT/Agent | 创建/追加 Session |
| POST | /agent-channel/sessions/:id/finalize | JWT/Agent | 完成 Session |
| GET | /agent-channel/sessions | JWT/Agent | 列出 Sessions |
| GET | /agent-channel/sessions/:id | JWT/Agent | Session 详情 |
| GET | /agent-channel/sessions/:id/snapshots/:sid | JWT/Agent | 快照内容 |
| POST | /agent-channel/webhooks | Agent | 注册 Webhook |
| GET | /agent-channel/webhooks | JWT/Agent | 列出 Webhooks |
| GET | /agent-channel/webhooks/:id | JWT/Agent | Webhook 详情 |
| PUT | /agent-channel/webhooks/:id | JWT/Agent | 更新 Webhook |
| DELETE | /agent-channel/webhooks/:id | JWT/Agent | 删除 Webhook |
| POST | /agent-channel/webhooks/:id/test | JWT/Agent | 测试 Webhook |
| GET | /agent-channel/webhooks/:id/deliveries | JWT/Agent | 投递历史 |
| POST | /agent-channel/actions | Agent | 提交 Action |
| GET | /agent-channel/actions | JWT/Agent | 列出 Actions |
| GET | /agent-channel/actions/:id | JWT/Agent | Action 状态 |
| POST | /agent-channel/actions/:id/result | JWT/Agent | 提交结果 |
| GET | /agent-channel/cdp/audit | Agent | CDP 审计日志 |
| **WS** | /ws/agent-channel/actions | Agent/Ext | Action 实时通道 |
| **WS** | /ws/agent-channel/cdp | Agent/Ext | CDP 中继通道 |

---

## 快速上手

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

### 提交 Action

```bash
curl -X POST http://localhost:3458/api/v2/agent-channel/actions \
  -H "X-Agent-Key: cmak_xxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"action_type": "click", "payload": {"selector": "#submit-btn"}}'
```

### 注册 Webhook

```bash
curl -X POST http://localhost:3458/api/v2/agent-channel/webhooks \
  -H "X-Agent-Key: cmak_xxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://my-service.com/webhook", "event_filters": {"severity": ["P0","P1"]}}'
```
