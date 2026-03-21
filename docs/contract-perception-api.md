# Perception API 合约

**Issue:** #91（本合约）— 连接 #63/#66（扩展端内容脚本）→ #67/#69（服务端感知消费者）

## 概述

定义 ClawMark 浏览器扩展采集的页面错误/运行时事件通过 HTTP API 上报至 Agent Channel 服务端的数据格式与接口协议。

| 角色 | 组件 | 位置 |
|------|------|------|
| **生产者** | `ErrorMonitor` 内容脚本 | `extension/content/error-monitor.js` |
| **传输层** | Background service worker | `extension/background/` |
| **消费者** | Agent Channel 服务端 | `server/index.js`（已实现，#67/#69） |
| **下游** | Perception Consumer（AI Agent） | 通过 `cmak_` key 拉取事件 |

## 认证

Perception API 支持两种认证方式，由 `v2AuthOrAgent` 中间件处理：

| 方式 | Header | 说明 |
|------|--------|------|
| **App API Key** | `Authorization: Bearer cmk_...` | 扩展端上报事件（绑定到具体 app） |
| **Agent Key** | `X-Agent-Key: cmak_...` | AI Agent 查询事件（绑定到 agent 所属 app） |

两种方式都会解析出 `app_id`，用于数据隔离。Agent key 认证时，`req.v2Auth.user_name` 设为 `agent:<agent_id>`。

## 事件类型

| type | 说明 |
|------|------|
| `error` | JavaScript 运行时错误 |
| `unhandled-rejection` | 未捕获的 Promise 拒绝 |
| `network` | 网络请求错误（XHR/fetch 失败） |
| `console` | Console.error 调用 |
| `unknown` | 未分类（兜底） |

## 事件模型

### 单条事件（数据库 `perception_events` 表）

```jsonc
{
  "id": "pe-xxxxxx",               // 服务端生成（genId('pe')）
  "app_id": "app_xxxxxx",         // 所属应用
  "type": "error",                // 事件类型（见上表）
  "message": "Cannot read ...",   // 错误消息（最长 4096 字符）
  "stack": "Error: ...\n  at ...",// 调用栈（最长 8192 字符，可为 null）
  "source": "app.js",             // 来源文件名（最长 2048 字符，可为 null）
  "line": 42,                     // 行号（可为 null）
  "severity": "error",            // 严重级别：error | warning | info
  "url": "https://example.com",   // 发生页面 URL（最长 2048 字符，可为 null）
  "fingerprint": "sha256:...",    // 去重指纹（必填）
  "context": {},                  // 额外上下文（JSON 对象）
  "created_at": "2026-03-21T..."  // ISO 8601 创建时间
}
```

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | `string` | 是 | 事件类型，缺失时服务端默认为 `"unknown"` |
| `message` | `string` | 是 | 错误消息，服务端截断至 4096 字符 |
| `stack` | `string?` | 否 | 调用栈，服务端截断至 8192 字符 |
| `source` | `string?` | 否 | 源文件名，服务端截断至 2048 字符 |
| `line` | `number?` | 否 | 行号 |
| `severity` | `string` | 否 | 默认 `"error"` |
| `url` | `string?` | 否 | 页面 URL，服务端截断至 2048 字符 |
| `fingerprint` | `string` | 是 | 去重指纹，无指纹的事件会被服务端拒绝 |
| `context` | `object` | 否 | 附加上下文，默认 `{}` |

## HTTP API

所有端点前缀：`/api/v2/agent-channel/perception`

### 端点列表

| 方法 | 路径 | 认证 | 限流 | 说明 |
|------|------|------|------|------|
| `POST` | `/perception` | v2Auth 或 Agent | 写限流 | 批量上报事件 |
| `GET` | `/perception` | v2Auth 或 Agent | 读限流 | 游标分页查询事件 |
| `GET` | `/perception/stats` | v2Auth 或 Agent | 读限流 | 按指纹聚合统计 |
| `GET` | `/perception/issues` | v2Auth 或 Agent | 读限流 | 查询已跟踪的 issue |
| `POST` | `/perception/issues` | v2Auth 或 Agent | 写限流 | 创建/更新跟踪 issue |

---

### POST /api/v2/agent-channel/perception

批量上报感知事件。

**请求体：**

```jsonc
{
  "events": [
    {
      "type": "error",
      "message": "Cannot read properties of null",
      "stack": "Error: Cannot read...\n  at foo (app.js:42)",
      "source": "app.js",
      "line": 42,
      "severity": "error",
      "url": "https://example.com/page",
      "fingerprint": "sha256:abc123",
      "context": { "browser": "Chrome 120" }
    }
  ]
}
```

**校验规则：**
- `events` 必须为非空数组
- 单次最多 100 条事件
- 所有事件必须有 `fingerprint`，无指纹的会被过滤

**成功响应（200）：**

```jsonc
{
  "created": 1,
  "events": [
    {
      "id": "pe-xxxxxx",           // 服务端生成的 ID
      "created_at": "2026-03-21T12:00:00.000Z"
    }
  ]
}
```

> **注意：** 返回值仅包含 `id` 和 `created_at`，不返回完整事件对象。需要完整数据请通过 GET 端点查询。

**错误响应：**

| 状态码 | 条件 |
|--------|------|
| 400 | `events` 不是非空数组 |
| 400 | 超过 100 条限制 |
| 400 | 所有事件均缺少 `fingerprint` |
| 400 | 无 app 上下文 |
| 401 | 认证失败 |
| 500 | 存储失败 |

---

### GET /api/v2/agent-channel/perception

游标分页查询事件（按 `created_at` 升序）。

**查询参数：**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `cursor` | `string?` | `null` | 起始游标（上次返回的 `cursor` 值，ISO 8601 时间戳） |
| `limit` | `number` | `100` | 每页条数，最大 500 |

**响应（200）：**

```jsonc
{
  "events": [ /* perception_event 对象数组 */ ],
  "cursor": "2026-03-21T12:00:00.000Z",  // 下次请求的游标
  "count": 42
}
```

---

### GET /api/v2/agent-channel/perception/stats

按指纹聚合统计（降序排列）。

**查询参数：**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `limit` | `number` | `50` | 返回条数，最大 200 |

**响应（200）：**

```jsonc
{
  "stats": [
    {
      "fingerprint": "sha256:abc123",
      "count": 42,
      "first_seen": "2026-03-20T...",
      "last_seen": "2026-03-21T..."
    }
  ]
}
```

---

### GET /api/v2/agent-channel/perception/issues

查询当前 app 下所有 open 状态的跟踪 issue。

**响应（200）：**

```jsonc
{
  "issues": [
    {
      "id": "pi-xxxxxx",
      "app_id": "app_xxxxxx",
      "fingerprint": "sha256:abc123",
      "gitlab_issue_id": "123",
      "gitlab_issue_url": "https://git.coco.xyz/...",
      "first_seen": "2026-03-20T...",
      "last_seen": "2026-03-21T...",
      "count": 42,
      "status": "open"
    }
  ]
}
```

---

### POST /api/v2/agent-channel/perception/issues

创建或更新（upsert）跟踪 issue。按 `(app_id, fingerprint)` 唯一约束去重。

**请求体：**

```jsonc
{
  "fingerprint": "sha256:abc123",   // 必填
  "count": 5,                       // 事件计数
  "first_seen": "2026-03-20T...",   // 首次出现时间
  "last_seen": "2026-03-21T...",    // 最近出现时间
  "gitlab_issue_id": "123",         // 可选，关联的 GitLab issue
  "gitlab_issue_url": "https://..." // 可选，GitLab issue URL
}
```

**响应（200）：**

新建时：
```jsonc
{ "id": "pi-xxxxxx", "created": true }
```

更新时（返回更新前的 issue 快照 + 标记）：
```jsonc
{
  "id": "pi-xxxxxx",
  "app_id": "app_xxxxxx",
  "fingerprint": "sha256:abc123",
  "first_seen": "2026-03-20T...",
  "last_seen": "2026-03-21T...",
  "count": 37,
  "status": "open",
  "updated": true
}
```

> **注意：** 更新时返回的是更新前的 issue 数据（`...existing`），`count` 字段在数据库中已累加但响应中是旧值。

## 数据库表结构

### perception_events

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| `id` | TEXT | PRIMARY KEY | 服务端生成 |
| `app_id` | TEXT | NOT NULL, INDEX | 应用隔离 |
| `type` | TEXT | NOT NULL | 事件类型 |
| `message` | TEXT | NOT NULL | 错误消息 |
| `stack` | TEXT | — | 调用栈 |
| `source` | TEXT | — | 源文件 |
| `line` | INTEGER | — | 行号 |
| `severity` | TEXT | NOT NULL, DEFAULT 'error' | 严重级别 |
| `url` | TEXT | — | 页面 URL |
| `fingerprint` | TEXT | NOT NULL, INDEX | 去重指纹 |
| `context` | TEXT | DEFAULT '{}' | JSON 上下文 |
| `created_at` | TEXT | NOT NULL, INDEX | ISO 8601 |

**索引：** `(app_id)`, `(app_id, fingerprint)`, `(app_id, created_at)`, `(app_id, type)`

### perception_issues

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| `id` | TEXT | PRIMARY KEY | |
| `app_id` | TEXT | NOT NULL, INDEX | |
| `fingerprint` | TEXT | NOT NULL, UNIQUE(app_id, fingerprint) | |
| `gitlab_issue_id` | TEXT | — | 关联 GitLab issue |
| `gitlab_issue_url` | TEXT | — | GitLab issue URL |
| `first_seen` | TEXT | NOT NULL | |
| `last_seen` | TEXT | NOT NULL | |
| `count` | INTEGER | NOT NULL, DEFAULT 1 | |
| `status` | TEXT | NOT NULL, DEFAULT 'open' | |

## 数据流

```
ErrorMonitor (content script)
    │
    ├── 捕获 window.onerror / unhandledrejection
    ├── 捕获 console.error
    ├── 捕获 XHR/fetch 网络错误
    │
    ▼
Background Service Worker
    │
    ├── 本地去重（fingerprint）
    ├── 批量聚合（5s 或 50 条）
    │
    ▼
POST /api/v2/agent-channel/perception
    │
    ├── 校验 + 截断 + 存储
    │
    ▼
perception_events 表
    │
    ▼
AI Agent（Perception Consumer, #69）
    │
    ├── GET /perception（游标轮询新事件）
    ├── GET /perception/stats（聚合分析）
    ├── 去重 → 自动创建 GitLab issue
    └── POST /perception/issues（记录跟踪状态）
```

## 错误码

| 错误消息 | 原因 | 恢复方式 |
|----------|------|----------|
| `"No app context"` | 认证成功但无法解析 app_id | 检查 API key 绑定的应用配置 |
| `"events must be a non-empty array"` | 请求体 events 字段缺失或为空 | 提供至少一条事件 |
| `"Max 100 events per request"` | 单次上报超过 100 条 | 分批上报 |
| `"All events missing fingerprint"` | 所有事件都没有 fingerprint | 确保每条事件包含指纹 |
| `"fingerprint required"` | POST issues 缺少 fingerprint | 提供 fingerprint 字段 |
| `"Authentication required"` | 未提供认证凭据 | 使用 Bearer token 或 X-Agent-Key |
| `"Invalid agent key format"` | Agent key 不以 `cmak_` 开头 | 使用正确格式的 agent key |
| `"Invalid or inactive agent key"` | Agent key 不存在或已停用 | 检查 key 是否有效 |

## 限流

| 端点类别 | 窗口 | 最大请求数 |
|----------|------|-----------|
| 写端点（POST） | 依服务端配置 | apiWriteLimiter |
| 读端点（GET） | 依服务端配置 | apiReadLimiter |

## 版本

本合约为 **v1**。变更时：

1. 递增版本号。
2. 在事件上报中添加 `"contractVersion": 1` 字段，便于消费者检测格式变化。
3. 至少保持一个小版本周期的向后兼容。
