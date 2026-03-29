# 会话数据格式 (Session Data Format)

**Issue:** #76 | **Parent:** #61

本文档定义 ClawMark 扩展录制的用户会话数据格式，包括事件模式 (Event Schema)、快照格式 (Snapshot Format) 和增量追加格式 (Incremental Append Format)。

## 概述

会话 (Session) 是一段连续的用户浏览活动记录。扩展端的 `SessionRecorder` 捕获用户交互事件，经 `PrivacyFilter` 脱敏后，通过 `SessionForwarder` 上传至服务端。

**数据流:**

```
SessionRecorder → PrivacyFilter → SessionStorage (本地) → SessionForwarder → Server API
```

---

## 事件类型 (Event Types)

| 类型 | 说明 |
|------|------|
| `navigation` | 页面生命周期：会话开始/结束、popstate、hashchange、visibility 变化 |
| `click` | 用户点击 DOM 元素 |
| `input` | 用户在表单字段中输入文本 |
| `scroll` | 滚动位置变化（500ms 节流） |
| `snapshot` | DOM 上下文快照（页面加载、用户暂停、错误、导航时触发） |
| `error` | JavaScript 运行时错误或未处理的 Promise 拒绝 |

---

## 事件模式 (Event Schema)

每个事件共享统一信封格式：

```jsonc
{
  "type": "<event-type>",       // 上述类型之一
  "timestamp": 1711100000000,   // Date.now() 捕获时间
  "data": { /* 按类型定义 */ }
}
```

### `navigation` 数据

| 字段 | 类型 | 出现条件 | 说明 |
|------|------|---------|------|
| `action` | `string` | 始终 | `"session-start"` \| `"session-end"` \| `"visibility-change"` \| `"popstate"` \| `"hashchange"` |
| `url` | `string` | start, popstate, hashchange | 脱敏后的页面 URL |
| `title` | `string` | start, popstate | `document.title` |
| `referrer` | `string` | start | 脱敏后的 referrer（无则空字符串） |
| `viewport` | `{ width, height }` | start | 窗口内部尺寸 |
| `reason` | `string` | end | `"idle-timeout"` \| `"navigation"` \| `"disabled"` |
| `duration` | `number` | end | 会话持续时间（ms） |
| `eventCount` | `number` | end | 会话中录制的事件总数 |
| `hidden` | `boolean` | visibility-change | `document.hidden` 值 |

示例：

```json
{
  "type": "navigation",
  "timestamp": 1711100000000,
  "data": {
    "action": "session-start",
    "url": "https://example.com/page",
    "title": "Example Page",
    "referrer": "https://example.com/",
    "viewport": { "width": 1920, "height": 1080 }
  }
}
```

### `click` 数据

| 字段 | 类型 | 说明 |
|------|------|------|
| `selector` | `string` | 脱敏后的 CSS 选择器路径（最多 5 级祖先） |
| `tag` | `string` | 目标元素小写标签名 |
| `text` | `string` | 脱敏后的可见文本（前 50 字符） |
| `href` | `string?` | 脱敏后的链接 URL（仅锚点元素） |
| `x` | `number` | `clientX` 坐标 |
| `y` | `number` | `clientY` 坐标 |

### `input` 数据

| 字段 | 类型 | 说明 |
|------|------|------|
| `selector` | `string` | 脱敏后的 CSS 选择器路径 |
| `tag` | `string` | `"input"` 或 `"textarea"` |
| `inputType` | `string` | HTML input type（如 `"text"`, `"email"`） |
| `name` | `string` | 字段 name 属性 |
| `value` | `string` | 脱敏后的值（最多 200 字符）；敏感字段为 `"••••"` |
| `masked` | `boolean` | `true` 表示值已被完全掩码 |

### `scroll` 数据

| 字段 | 类型 | 说明 |
|------|------|------|
| `x` | `number` | `window.scrollX` |
| `y` | `number` | `window.scrollY` |
| `maxY` | `number` | `document.documentElement.scrollHeight` |
| `viewportHeight` | `number` | `window.innerHeight` |

### `snapshot` 数据

| 字段 | 类型 | 说明 |
|------|------|------|
| `trigger` | `string` | `"page-load"` \| `"user-pause"` \| `"error"` \| `"navigation"` |
| `html` | `string` | 脱敏后的 HTML 片段（最大 50,000 字符） |
| `url` | `string` | 快照时的脱敏页面 URL |
| `title` | `string` | `document.title` |
| `selector` | `string` | 触发元素的 CSS 选择器（页面级为空） |

### `error` 数据

| 字段 | 类型 | 说明 |
|------|------|------|
| `message` | `string` | 脱敏后的错误消息（最多 300 字符） |
| `source` | `string?` | 来源文件名（仅运行时错误） |
| `line` | `number?` | 行号（仅运行时错误） |
| `col` | `number?` | 列号（仅运行时错误） |
| `type` | `string?` | Promise 拒绝时为 `"unhandled-rejection"` |

---

## 批次格式 (Batch Format)

事件从 content script 以批次形式发送到 background service worker（每 5 秒或 50 个事件，先到先发）。

```jsonc
{
  "sessionId": "1711100000000-a1b2c3d4",   // 格式: {timestamp}-{random}
  "startTime": 1711100000000,
  "url": "https://example.com/page",
  "events": [
    { "type": "...", "timestamp": ..., "data": { ... } }
  ]
}
```

内部消息信封（content → background）：

```jsonc
{ "type": "session:batch", "payload": <batch> }
```

---

## 增量追加格式 (Incremental Append)

服务端支持分块上传——首次上传创建会话，后续上传追加事件到同一会话。

### 首次上传（创建会话）

```
POST /api/v2/agent-channel/sessions
```

请求体：

```jsonc
{
  "url": "https://example.com/page",
  "events": [
    { "type": "navigation", "timestamp": 1711100000000, "data": { ... } }
  ],
  "snapshots": [
    { "trigger": "page-load", "timestamp": 1711100000000, "html": "...", "url": "...", "title": "..." }
  ],
  "metadata": { "userAgent": "...", "viewport": { "width": 1920, "height": 1080 } }
}
```

响应（201 Created）：

```jsonc
{
  "id": "session-uuid",
  "event_count": 5,
  "snapshot_count": 1
}
```

### 后续追加

```
POST /api/v2/agent-channel/sessions
```

请求体中包含 `session_id` 字段：

```jsonc
{
  "session_id": "session-uuid",   // 已存在的会话 ID
  "events": [ ... ],              // 新事件（最多 1000 个/次）
  "snapshots": [ ... ]            // 新快照（最多 100 个/次）
}
```

响应（201 Created）：

```jsonc
{
  "id": "session-uuid",
  "event_count": 42,        // 累计事件总数
  "snapshot_count": 5        // 累计快照总数
}
```

### 终结会话

```
POST /api/v2/agent-channel/sessions/:id/finalize
```

将会话状态标记为 `completed`，记录结束时间。

---

## 服务端数据库模式

### sessions 表

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT (PK) | 会话 UUID |
| `app_id` | TEXT | 应用 ID |
| `agent_id` | TEXT | 代理 ID |
| `instance_id` | TEXT | 实例 ID |
| `tab_id` | TEXT | 标签页 ID |
| `url` | TEXT | 起始 URL |
| `title` | TEXT | 页面标题 |
| `start_time` | TEXT | ISO 8601 开始时间 |
| `end_time` | TEXT | ISO 8601 结束时间 |
| `event_count` | INTEGER | 事件总数 |
| `snapshot_count` | INTEGER | 快照总数 |
| `total_size` | INTEGER | 总数据大小（字节） |
| `status` | TEXT | `"active"` \| `"completed"` |
| `metadata` | TEXT | JSON 元数据 |

### session_events 表

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INTEGER (PK) | 自增 ID |
| `session_id` | TEXT (FK) | 关联会话 ID（CASCADE 删除） |
| `type` | TEXT | 事件类型 |
| `timestamp` | TEXT | ISO 8601 时间戳 |
| `data` | TEXT | JSON 事件数据 |
| `size` | INTEGER | 数据大小（字节） |

### session_snapshots 表

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INTEGER (PK) | 自增 ID |
| `session_id` | TEXT (FK) | 关联会话 ID（CASCADE 删除） |
| `trigger` | TEXT | 快照触发类型 |
| `timestamp` | TEXT | ISO 8601 时间戳 |
| `html` | TEXT | 脱敏后的 HTML |
| `size` | INTEGER | 数据大小（字节） |

---

## 本地存储格式

由 `session-storage.js` 在 background service worker 中管理。

| 存储键 | 值 |
|--------|------|
| `session_{tabId}_{sessionId}` | 完整会话对象 |
| `session_index_{tabId}` | sessionId → 元数据的索引映射 |

### 限制

| 限制项 | 值 |
|--------|------|
| 每个会话最大事件数 | 2,000（超出时裁剪最旧的） |
| 每个会话最大快照数 | 50（超出时裁剪最旧的） |
| 每个标签页最大会话数 | 10（超出时淘汰最旧的） |
| 会话空闲超时 | 30 分钟 → 自动开始新会话 |
| 快照速率限制 | 每分钟 10 个 |
| 每次上传最大事件数 | 1,000 |
| 每次上传最大快照数 | 100 |
| 单个会话最大总大小 | 50 MB |

标签页关闭时自动清除对应会话。

---

## 数据保留

| 策略 | 保留期 |
|------|--------|
| 已完成会话 | 30 天（基于 `updated_at`） |
| 孤立活跃会话 | 7 天（`updated_at` 超过 7 天未更新的 active 会话） |
| 操作日志 | 90 天 |

清理任务在服务启动时执行，之后每 24 小时运行一次。删除通过 CASCADE 级联清除关联事件和快照。
