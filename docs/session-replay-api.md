# 会话回放 API (Session Replay API)

**Issue:** #76 | **Parent:** #61

本文档是会话 (Session) REST API 的完整参考，覆盖创建、追加、终结、查询和分析端点。

## 认证

所有端点需要 Bearer token（JWT 或 `cmk_` API key）通过 `Authorization` 头传递：

```
Authorization: Bearer <token>
```

或使用 `X-Agent-Key` 头（Agent 认证）：

```
X-Agent-Key: cmak_<agent-key>
```

---

## 端点总览

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/v2/agent-channel/sessions` | 创建会话或追加事件 |
| `POST` | `/api/v2/agent-channel/sessions/:id/finalize` | 终结会话 |
| `GET` | `/api/v2/agent-channel/sessions` | 列出会话 |
| `GET` | `/api/v2/agent-channel/sessions/:id` | 获取单个会话详情（含事件） |
| `GET` | `/api/v2/agent-channel/sessions/:id/snapshots/:snapshotId` | 获取快照 HTML |
| `GET` | `/api/v2/agent-channel/sessions/:id/analysis` | 会话-错误关联分析 |

---

## POST /api/v2/agent-channel/sessions

创建新会话或向已有会话追加事件。

**速率限制:** 每应用每分钟 60 次

### 创建新会话

**请求体:**

```jsonc
{
  "url": "https://example.com/page",            // 必填
  "events": [                                     // 最多 1000 个
    {
      "type": "navigation",
      "timestamp": 1711100000000,
      "data": { "action": "session-start", "url": "https://example.com/page" }
    }
  ],
  "snapshots": [                                  // 最多 100 个
    {
      "trigger": "page-load",
      "timestamp": 1711100000000,
      "html": "<html>...</html>",
      "url": "https://example.com/page",
      "title": "Example Page"
    }
  ],
  "metadata": {                                   // 可选
    "userAgent": "Mozilla/5.0 ...",
    "viewport": { "width": 1920, "height": 1080 }
  }
}
```

**响应 (201 Created):**

```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "event_count": 5,
  "snapshot_count": 1
}
```

### 追加事件到已有会话

在请求体中包含 `session_id`：

```jsonc
{
  "session_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",   // 已有会话 ID
  "events": [ ... ],                                         // 新事件（最多 1000）
  "snapshots": [ ... ]                                       // 新快照（最多 100）
}
```

**响应 (201 Created):**

```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "event_count": 42,
  "snapshot_count": 5
}
```

### 错误响应

| 状态码 | 说明 |
|--------|------|
| 400 | 请求体验证失败（缺少 url、events 超过 1000、snapshots 超过 100） |
| 401 | 未认证 |
| 429 | 速率限制（每分钟 60 次） |
| 500 | 服务器内部错误 |

---

## POST /api/v2/agent-channel/sessions/:id/finalize

将会话标记为已完成。设置 `status = "completed"` 并记录 `end_time`。

**参数:**

| 参数 | 位置 | 说明 |
|------|------|------|
| `id` | path | 会话 ID |

**响应 (200 OK):**

```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "completed"
}
```

---

## GET /api/v2/agent-channel/sessions

列出会话，支持按代理、站点和时间筛选。

**查询参数:**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `agent_id` | `string` | - | 按代理 ID 筛选 |
| `site` | `string` | - | 按站点 URL 模糊匹配（LIKE） |
| `after` | `string` | - | ISO 8601 时间戳，只返回此时间之后的会话 |
| `limit` | `number` | 50 | 返回数量上限（最大 200） |

**响应 (200 OK):**

```jsonc
[
  {
    "id": "a1b2c3d4-...",
    "app_id": "app-uuid",
    "agent_id": "agent-uuid",
    "url": "https://example.com/page",
    "title": "Example Page",
    "start_time": "2026-03-29T10:00:00.000Z",
    "end_time": "2026-03-29T10:15:00.000Z",
    "event_count": 142,
    "snapshot_count": 8,
    "total_size": 245760,
    "status": "completed",
    "metadata": { ... }
  }
]
```

---

## GET /api/v2/agent-channel/sessions/:id

获取单个会话详情，包含所有事件。

**查询参数:**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `include_snapshots` | `boolean` | `false` | 是否包含快照数据 |
| `start_time` | `string` | - | ISO 8601，筛选此时间之后的事件 |
| `end_time` | `string` | - | ISO 8601，筛选此时间之前的事件 |

**响应 (200 OK):**

```jsonc
{
  "id": "a1b2c3d4-...",
  "app_id": "app-uuid",
  "agent_id": "agent-uuid",
  "url": "https://example.com/page",
  "title": "Example Page",
  "start_time": "2026-03-29T10:00:00.000Z",
  "end_time": "2026-03-29T10:15:00.000Z",
  "event_count": 142,
  "snapshot_count": 8,
  "status": "completed",
  "events": [
    { "type": "navigation", "timestamp": "2026-03-29T10:00:00.000Z", "data": { ... } },
    { "type": "click", "timestamp": "2026-03-29T10:00:05.000Z", "data": { ... } }
  ],
  "snapshots": []   // 仅当 include_snapshots=true 时包含
}
```

---

## GET /api/v2/agent-channel/sessions/:id/snapshots/:snapshotId

获取指定快照的完整 HTML 内容。

**参数:**

| 参数 | 位置 | 说明 |
|------|------|------|
| `id` | path | 会话 ID |
| `snapshotId` | path | 快照 ID |

**响应 (200 OK):**

```jsonc
{
  "id": 1,
  "session_id": "a1b2c3d4-...",
  "trigger": "page-load",
  "timestamp": "2026-03-29T10:00:00.000Z",
  "html": "<!DOCTYPE html><html>...</html>",
  "size": 32768
}
```

---

## GET /api/v2/agent-channel/sessions/:id/analysis

将会话事件与错误关联分析，生成复现步骤。

**查询参数:**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `before_ms` | `number` | 30000 | 错误发生前的时间窗口（ms） |
| `after_ms` | `number` | 10000 | 错误发生后的时间窗口（ms） |

**响应 (200 OK):**

```jsonc
{
  "session_id": "a1b2c3d4-...",
  "errors": [
    {
      "error": { "message": "TypeError: ...", "timestamp": "..." },
      "reproduction_steps": [
        { "type": "navigation", "timestamp": "...", "data": { ... } },
        { "type": "click", "timestamp": "...", "data": { ... } }
      ],
      "triggering_action": { "type": "click", "timestamp": "...", "data": { ... } },
      "timeline": [ ... ],
      "closest_snapshot": { "id": 3, "trigger": "error", "timestamp": "..." }
    }
  ]
}
```

分析算法：
1. 找出会话中所有 `error` 类型事件
2. 对每个错误，提取 `[error.timestamp - before_ms, error.timestamp + after_ms]` 时间窗口内的事件
3. 识别错误前最近的用户操作（click/input/navigation）作为触发动作
4. 关联最近的快照

---

## WebSocket 推送

当会话有新事件上传时，服务端通过 WebSocket 向绑定的代理推送通知：

```jsonc
{
  "type": "session",
  "data": {
    "session_id": "a1b2c3d4-...",
    "event_count": 42,
    "snapshot_count": 5
  }
}
```

仅推送给具有 `session` scope 的已绑定代理。
