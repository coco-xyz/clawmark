# Action API 参考 (Action API Reference)

**Issue:** #80 | **Parent:** #61

本文档是 ClawMark Action（行动层）的完整 API 参考，覆盖命令模式 (Command Schema)、WebSocket 协议、REST 端点和认证方式。

## 概述

Action API 允许 AI 代理远程控制浏览器执行 DOM 操作。支持两种通信方式：

| 方式 | 路径 | 特点 |
|------|------|------|
| **WebSocket**（推荐） | `/ws/agent-channel/actions` | 实时双向，低延迟 |
| **REST** | `/api/v2/agent-channel/actions` | 轮询模式，适合无状态场景 |

**架构：**

```
Agent → (WS/REST) → Server Action Queue → (WS) → Extension → Content Script → DOM
```

---

## 认证

### Agent Key（代理密钥）

通过 `X-Agent-Key` 头传递：

```
X-Agent-Key: cmak_<48-hex-chars>
```

- 前缀：`cmak_`（agent key）或 `cmk_`（API key）
- 服务端使用 SHA-256 哈希存储和验证
- 每次认证自动更新 `last_seen` 时间

### JWT / API Key

通过 `Authorization` 头传递（REST 端点备选）：

```
Authorization: Bearer <jwt-or-cmk-key>
```

---

## 命令类型 (Command Schema)

### 支持的操作类型

| 类型 | 风险等级 | 说明 |
|------|---------|------|
| `click` | medium | 点击 DOM 元素（单击、双击、右键） |
| `type` | medium | 在输入框中键入文本 |
| `navigate` | medium | 导航到 URL 或使用前进/后退/刷新 |
| `screenshot` | low | 截取可见区域或指定元素 |
| `scroll` | low | 滚动页面或将元素滚动到视野内 |
| `form-fill` | high | 批量填充多个表单字段 |

风险等级：`low`（始终允许）、`medium`（默认允许）、`high`（需显式启用）、`forbidden`（始终阻止）。

### click

点击指定 DOM 元素。

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `target` | `string` | 必填 | CSS 选择器或 `xpath:...` 表达式 |
| `options.clickType` | `string` | `"single"` | `"single"` \| `"double"` \| `"context"` |
| `options.offsetX` | `number` | 元素中心 | 相对元素左上角的 X 偏移（px） |
| `options.offsetY` | `number` | 元素中心 | 相对元素左上角的 Y 偏移（px） |

**请求示例：**

```json
{
  "action_type": "click",
  "payload": {
    "target": "#submit-btn",
    "options": { "clickType": "single" }
  }
}
```

**成功结果：**

```json
{ "clicked": true, "selector": "#submit-btn", "durationMs": 42 }
```

### type

在输入框、文本域或 contenteditable 元素中键入文本。

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `target` | `string` | 必填 | 元素选择器 |
| `value` | `string` | `""` | 要键入的文本 |
| `options.clearFirst` | `boolean` | `true` | 键入前清空已有值 |
| `options.append` | `boolean` | `false` | 追加到已有值（覆盖 clearFirst） |

**成功结果：**

```json
{ "typed": true, "length": 11, "durationMs": 35 }
```

### navigate

导航到指定 URL 或执行浏览器历史操作。

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `value` | `string` | 必填 | URL（`https://...`）或特殊值：`"back"`, `"forward"`, `"reload"` |

仅接受 `http://` 和 `https://` 协议的 URL。

**成功结果：**

```json
{ "navigated": "https://example.com", "durationMs": 120 }
```

### screenshot

截取当前可见区域的截图。

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `target` | `string?` | 无 | 可选，截图前先将此元素滚动到视野内 |

截图通过 `chrome.tabs.captureVisibleTab` 在 background service worker 中执行。

**成功结果：**

```json
{ "dataUrl": "data:image/png;base64,...", "timestamp": 1711100000000, "durationMs": 85 }
```

### scroll

滚动页面或将指定元素滚动到视野内。

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `target` | `string?` | 无 | 将此元素滚动到视野内 |
| `options.behavior` | `string` | `"instant"` | `"smooth"` \| `"instant"` |
| `options.position` | `string?` | 无 | `"top"` \| `"bottom"` |
| `options.x` | `number` | `0` | 水平滚动偏移（px） |
| `options.y` | `number` | `0` | 垂直滚动偏移（px） |

优先级：`target` > `position` > `x/y` 偏移。

**成功结果（target）：**

```json
{ "scrolledTo": "#section-3", "durationMs": 15 }
```

**成功结果（offset）：**

```json
{ "scrolledBy": { "x": 0, "y": 500 }, "durationMs": 10 }
```

### form-fill

批量填充多个表单字段。密码字段自动跳过。

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `value.fields` | `array` | 必填 | 字段描述符数组 |
| `value.fields[].selector` | `string` | 必填 | 元素选择器 |
| `value.fields[].value` | `string \| boolean` | 必填 | 要设置的值 |

支持的字段类型：文本输入框、文本域、select 下拉框、checkbox、radio。

**请求示例：**

```json
{
  "action_type": "form-fill",
  "payload": {
    "value": {
      "fields": [
        { "selector": "#name", "value": "张三" },
        { "selector": "#email", "value": "test@example.com" },
        { "selector": "#agree", "value": true }
      ]
    }
  }
}
```

**成功结果：**

```json
{
  "fields": [
    { "selector": "#name", "filled": true },
    { "selector": "#email", "filled": true },
    { "selector": "#agree", "checked": true },
    { "selector": "#password", "skipped": true, "reason": "password field" }
  ],
  "count": 3,
  "durationMs": 120
}
```

---

## 元素选择器

### 选择器格式

| 格式 | 示例 | 说明 |
|------|------|------|
| CSS 选择器 | `#submit-btn`, `.form > input` | 标准 `document.querySelector` |
| XPath | `xpath://div[@id='main']//button` | 前缀 `xpath:`，使用 `document.evaluate` |

### 可见性等待

所有操作在执行前等待目标元素可见：

- 轮询间隔：**200ms**
- 默认超时：**5,000ms**（可通过 `timeout` 字段覆盖）
- 可见性检查：`display !== "none"`, `visibility !== "hidden"`, `opacity !== 0`, 且 bounding rect 有非零宽高
- 超时错误：`"Element not found after {timeout}ms: {selector}"`

---

## WebSocket 协议

### 连接

```
ws://<server>/ws/agent-channel/actions
```

请求头：

```
X-Agent-Key: cmak_<key>
```

可选查询参数：

| 参数 | 说明 |
|------|------|
| `instance_id` | 扩展实例 ID（多实例路由用） |

### 心跳

服务端每 **30 秒** 发送 ping，客户端应回复 pong。

最大消息体：**1 MB**。

### Agent → Server：提交操作

```json
{
  "type": "action",
  "action_type": "click",
  "payload": { "target": "#submit-btn" },
  "session_id": "optional-session-id",
  "target_instance": "optional-instance-id",
  "timeout_ms": 30000
}
```

**服务端确认：**

```json
{
  "type": "action_queued",
  "action_id": "uuid",
  "status": "queued"
}
```

### Server → Extension：派发操作

```json
{
  "type": "action",
  "action_id": "uuid",
  "action_type": "click",
  "payload": { "target": "#submit-btn" },
  "session_id": "...",
  "timeout_ms": 30000
}
```

### Extension → Server：返回结果

```json
{
  "type": "result",
  "action_id": "uuid",
  "result": { "clicked": true, "selector": "#submit-btn", "durationMs": 42 },
  "instance_id": "ext-instance-1"
}
```

失败时：

```json
{
  "type": "result",
  "action_id": "uuid",
  "error": "Element not found after 5000ms: #submit-btn"
}
```

### Server → Agent：转发结果

```json
{
  "type": "result",
  "action_id": "uuid",
  "action_type": "click",
  "status": "completed",
  "result": { "clicked": true, "selector": "#submit-btn", "durationMs": 42 },
  "instance_id": "ext-instance-1"
}
```

### 会话粘性路由 (Session-Sticky Routing)

当存在多个扩展实例时，服务端维护 `session_id → instance_id` 映射：

1. 首次成功执行操作时，将 session 绑定到处理该操作的 instance
2. 后续同一 session 的操作自动路由到同一 instance
3. 可通过 `target_instance` 字段显式指定目标实例

---

## REST 端点

### POST /api/v2/agent-channel/actions

提交操作到队列。

**请求体：**

```json
{
  "action_type": "click",
  "payload": { "target": "#submit-btn" },
  "session_id": "optional",
  "timeout_ms": 30000
}
```

**响应 (201 Created)：**

```json
{
  "id": "action-uuid",
  "agent_id": "agent-uuid",
  "app_id": "app-uuid",
  "type": "click",
  "status": "queued",
  "created_at": "2026-03-29T10:00:00.000Z"
}
```

**错误：**

| 状态码 | 说明 |
|--------|------|
| 400 | 无效的 action_type |
| 429 | 队列已满（每代理最多 100 个待处理操作） |
| 500 | 服务器错误 |

### GET /api/v2/agent-channel/actions/:id

轮询操作状态。

**响应 (200 OK)：**

```json
{
  "id": "action-uuid",
  "agent_id": "agent-uuid",
  "type": "click",
  "payload": { "target": "#submit-btn" },
  "status": "completed",
  "result": { "clicked": true, "selector": "#submit-btn", "durationMs": 42 },
  "error": null,
  "timeout_ms": 30000,
  "created_at": "2026-03-29T10:00:00.000Z",
  "dispatched_at": "2026-03-29T10:00:00.100Z",
  "completed_at": "2026-03-29T10:00:00.142Z"
}
```

### POST /api/v2/agent-channel/actions/:id/result

扩展 Webhook 回调——提交操作结果（REST 备选，WebSocket 不可用时使用）。

**请求体：**

```json
{
  "result": { "clicked": true },
  "error": null
}
```

**响应 (200 OK)：**

```json
{ "action_id": "uuid", "status": "completed" }
```

**错误：**

| 状态码 | 说明 |
|--------|------|
| 404 | 操作不存在或不属于当前应用 |
| 409 | 操作已完成或无效状态转换 |

### GET /api/v2/agent-channel/actions

列出操作。

**查询参数：**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `status` | `string` | - | 按状态筛选 |
| `limit` | `number` | 50 | 返回数量（最大 200） |

**响应 (200 OK)：**

```json
{
  "actions": [ ... ],
  "count": 5
}
```

---

## 操作状态流转

```
queued → dispatched → completed
  │          │
  └──failed──┘
```

| 状态 | 说明 |
|------|------|
| `queued` | 已入队，等待扩展领取 |
| `dispatched` | 已派发到扩展，等待执行结果 |
| `completed` | 执行成功 |
| `failed` | 执行失败或超时 |

**超时机制：** 服务端定期检查已派发操作，超过 `timeout_ms`（默认 30 秒）未返回结果的操作标记为 `failed`。

---

## 数据保留

操作队列记录保留 **7 天**，之后自动清理。
