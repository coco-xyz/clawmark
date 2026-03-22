# Agent Registration 合约

**Issue:** #92（本合约）— 连接 #68（服务端注册 API）→ #69（Agent 消费者）

## 概述

定义 AI Agent 在 ClawMark 服务端的注册流程、API Key 管理和 CRUD 操作接口。Agent 注册后获得 `cmak_` 前缀的 API key，用于访问 Perception API、Session API 和 Action Queue 等 Agent Channel 端点。

| 角色 | 组件 | 位置 |
|------|------|------|
| **注册方** | 应用管理员（通过 App API Key） | Dashboard / API 调用 |
| **服务端** | Agent Channel 注册端点 | `server/index.js` + `server/agent-auth.js`（已实现，#68） |
| **消费者** | AI Agent 实例 | 使用 `cmak_` key 调用 Agent Channel API |

## 认证模型

### 双层认证架构

```
应用级 (cmk_)          Agent 级 (cmak_)
┌──────────────┐      ┌───────────────────┐
│ App API Key  │      │  Agent API Key    │
│ cmk_xxxxxxxx │      │  cmak_xxxxxxxxxx  │
│              │      │                   │
│ 用途：       │      │ 用途：            │
│ - 注册 agent │      │ - Perception API  │
│ - 管理 agent │      │ - Session API     │
│ - CRUD 操作  │      │ - Action Queue    │
│              │      │ - WebSocket 连接  │
└──────────────┘      └───────────────────┘
    v2Auth                agentAuth
```

### App API Key（`cmk_` 前缀）

- 通过 `Authorization: Bearer cmk_...` header 传递
- 由 `v2Auth` 中间件验证
- 用于 agent 注册和管理操作（CRUD）
- 解析出 `app_id`，确保 agent 归属于正确的应用

### Agent API Key（`cmak_` 前缀）

- 通过 `X-Agent-Key: cmak_...` header 传递
- 由 `agentAuth` 中间件验证（`server/agent-auth.js`）
- 格式：`cmak_` + 48 个十六进制字符（24 随机字节）
- 仅在注册时返回一次，服务端只存储 SHA-256 哈希值
- 每次请求异步更新 `last_seen` 时间戳

### 认证流程

```
Agent 请求
    │
    ├── Header: X-Agent-Key → agentAuth 中间件
    │   ├── 验证 cmak_ 前缀
    │   ├── SHA-256 哈希 → 查询 agents 表
    │   ├── 检查 status = 'active'
    │   └── 设置 req.agent + req.v2Auth.app_id
    │
    └── Header: Authorization: Bearer → v2Auth 中间件
        └── JWT 或 App API Key 验证
```

## HTTP API

所有端点前缀：`/api/v2/agent-channel`

### 端点列表

| 方法 | 路径 | 认证 | 限流 | 说明 |
|------|------|------|------|------|
| `POST` | `/register` | v2Auth（App Key） | 注册限流 | 注册新 agent |
| `GET` | `/agents` | v2Auth（App Key） | 读限流 | 列出当前 app 的所有 agent |
| `GET` | `/agents/:id` | v2Auth（App Key） | 读限流 | 获取单个 agent 详情 |
| `PUT` | `/agents/:id` | v2Auth（App Key） | 写限流 | 更新 agent 元数据 |
| `DELETE` | `/agents/:id` | v2Auth（App Key） | 写限流 | 停用 agent（软删除） |
| `POST` | `/agents/:id/rotate-key` | v2Auth（App Key） | 写限流 | 轮换 agent API key |

---

### POST /api/v2/agent-channel/register

注册新 agent，返回 API key。**API key 仅在此响应中返回一次。**

**请求体：**

```jsonc
{
  "name": "error-sentinel",         // 必填，1-100 字符
  "callback_url": "https://...",     // 可选，webhook 回调地址
  "capabilities": ["perception"]    // 可选，能力标签数组
}
```

**校验规则：**
- `name`：必填，字符串，1-100 字符，会 trim
- `callback_url`：可选，必须为字符串
- `capabilities`：可选，必须为数组

**成功响应（201）：**

```jsonc
{
  "id": "agent_xxxxxx",
  "app_id": "app_xxxxxx",
  "name": "error-sentinel",
  "api_key": "cmak_a1b2c3d4e5f6...",   // ⚠️ 仅此处返回！
  "key_prefix": "cmak_a1b2c3d4...",     // 前 12 字符 + "..."
  "callback_url": "https://...",
  "capabilities": ["perception"],
  "status": "active",
  "created_by": "admin",
  "created_at": "2026-03-21T12:00:00.000Z",
  "updated_at": "2026-03-21T12:00:00.000Z"
}
```

**错误响应：**

| 状态码 | 条件 |
|--------|------|
| 400 | `name` 缺失或不合法 |
| 400 | `callback_url` 不是字符串 |
| 400 | `capabilities` 不是数组 |
| 400 | 无 app 上下文 |
| 401 | 认证失败 |
| 429 | 注册频率限制（每小时 10 次） |
| 500 | 服务端错误 |

---

### GET /api/v2/agent-channel/agents

列出当前 app 下所有 agent（按 `created_at` 降序）。

**响应（200）：**

```jsonc
{
  "agents": [
    {
      "id": "agent_xxxxxx",
      "app_id": "app_xxxxxx",
      "name": "error-sentinel",
      "key_prefix": "cmak_a1b2c3d4...",
      "callback_url": "https://...",
      "capabilities": "[\"perception\"]",  // JSON 字符串
      "status": "active",
      "created_by": "admin",
      "created_at": "2026-03-21T...",
      "updated_at": "2026-03-21T...",
      "last_seen": "2026-03-21T..."
    }
  ]
}
```

> **注意：** `capabilities` 在列表接口返回的是 JSON 字符串，调用方需自行解析。`key_hash` 永远不会出现在响应中。

---

### GET /api/v2/agent-channel/agents/:id

获取单个 agent 详情。

**响应（200）：** 同列表中的单个 agent 对象（不含 `key_hash`）。

**错误响应：**

| 状态码 | 条件 |
|--------|------|
| 404 | Agent 不存在或不属于当前 app |

> **安全：** 跨 app 访问统一返回 404，不暴露 agent 是否存在。

---

### PUT /api/v2/agent-channel/agents/:id

更新 agent 元数据。支持部分更新。

**请求体（均为可选）：**

```jsonc
{
  "name": "new-name",
  "callback_url": "https://new-url.com",
  "capabilities": ["perception", "actions"]
}
```

**响应（200）：** 更新后的 agent 对象。

---

### DELETE /api/v2/agent-channel/agents/:id

停用 agent（软删除）。将 `status` 设为 `"inactive"`，该 agent 的 API key 随即失效。

**响应（200）：**

```jsonc
{
  "id": "agent_xxxxxx",
  "status": "inactive"
}
```

---

### POST /api/v2/agent-channel/agents/:id/rotate-key

轮换 agent API key。旧 key 立即失效，返回新 key。

**响应（200）：**

```jsonc
{
  "id": "agent_xxxxxx",
  "api_key": "cmak_new_key_here...",   // ⚠️ 仅此处返回！
  "key_prefix": "cmak_new_key_..."
}
```

## 数据库表结构

### agents

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| `id` | TEXT | PRIMARY KEY | `agent_` 前缀，服务端生成 |
| `app_id` | TEXT | NOT NULL, INDEX | 所属应用 |
| `name` | TEXT | NOT NULL | Agent 名称 |
| `key_hash` | TEXT | NOT NULL, UNIQUE | SHA-256 哈希（永不返回给客户端） |
| `key_prefix` | TEXT | NOT NULL, INDEX | key 前 12 字符 + "..."（用于识别） |
| `callback_url` | TEXT | — | Webhook 回调地址 |
| `capabilities` | TEXT | DEFAULT '[]' | JSON 数组字符串 |
| `status` | TEXT | NOT NULL, DEFAULT 'active' | `active` 或 `inactive` |
| `created_by` | TEXT | NOT NULL | 创建者（用户名或 `"api"`） |
| `created_at` | TEXT | NOT NULL | ISO 8601 |
| `updated_at` | TEXT | NOT NULL | ISO 8601 |
| `last_seen` | TEXT | — | 最近一次 API 请求时间 |

**索引：** `(app_id)`, `(key_hash)`, `(status)`, `(key_prefix)`

## API Key 安全模型

### 生成

```
cmak_ + crypto.randomBytes(24).toString('hex')
     = cmak_ + 48 个十六进制字符
     = 共 53 字符
```

### 存储

- **客户端保存原始 key** — 服务端不保留原文
- **服务端仅存哈希** — `SHA-256(raw_key)` → `key_hash` 列
- **前缀用于识别** — `key_prefix` = 前 12 字符 + `"..."`（如 `cmak_a1b2c3d4...`）

### 验证流程

```
请求到达
    │
    ├── 提取 X-Agent-Key header
    ├── 验证 cmak_ 前缀
    ├── SHA-256 哈希
    ├── 查询 agents 表 (WHERE key_hash = ? AND status = 'active')
    ├── 匹配 → req.agent = agent 记录
    └── 异步更新 last_seen
```

### 安全要点

| 规则 | 说明 |
|------|------|
| 一次性展示 | API key 仅在注册和轮换响应中返回 |
| 不可逆存储 | 数据库只存 SHA-256 哈希 |
| 隔离查询 | 列表/详情接口永远不含 `key_hash` |
| 即时失效 | DELETE（停用）后 key 立即无法认证 |
| 无状态验证 | 每次请求独立验证，无 session |

## 限流

| 端点 | 窗口 | 最大请求数 |
|------|------|-----------|
| 注册 (`POST /register`) | 1 小时 | 10 |
| 读操作（GET） | 依 apiReadLimiter 配置 | — |
| 写操作（PUT/DELETE/rotate） | 依 apiWriteLimiter 配置 | — |

## 数据隔离

所有 agent 操作都通过 `app_id` 进行隔离：

- 注册时 `app_id` 从认证上下文自动获取，不接受客户端传入
- 列表接口只返回当前 app 的 agent
- 详情/更新/删除接口在 app_id 不匹配时返回 404（不泄露存在性）
- Agent key 认证时自动关联到注册时的 app_id

## 错误码

| 错误消息 | 原因 | 恢复方式 |
|----------|------|----------|
| `"No app context"` | 认证成功但无法解析 app_id | 检查 API key 绑定 |
| `"name required (1-100 chars)"` | name 缺失或长度不合法 | 提供合法名称 |
| `"callback_url must be a string"` | callback_url 类型错误 | 传字符串或省略 |
| `"capabilities must be an array"` | capabilities 类型错误 | 传数组或省略 |
| `"Agent not found"` | agent 不存在或不属于当前 app | 检查 ID 和 app 归属 |
| `"X-Agent-Key header required"` | 缺少 agent key header | 添加 X-Agent-Key |
| `"Invalid agent key format"` | key 不以 cmak_ 开头 | 使用正确格式 |
| `"Invalid or inactive agent key"` | key 无效或 agent 已停用 | 检查 key 或重新注册 |
| `"Agent registration rate limit exceeded"` | 超过注册限流 | 等待后重试 |

## 版本

本合约为 **v1**。变更时：

1. 递增版本号。
2. 注册响应中添加 `"contractVersion": 1` 字段。
3. 至少保持一个小版本周期的向后兼容。
