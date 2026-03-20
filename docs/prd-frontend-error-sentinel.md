# PRD: 前端错误哨兵（Frontend Error Sentinel）

> ClawMark 插件扩展 —— 从「用户主动标注」到「自动采集前端异常」

## 背景与动机

当前 bug 发现流程依赖人工：用户遇到问题 → 手动截图/描述 → 提 issue → 开发定位。这个链路有三个缺陷：

1. **信息不全**：用户描述往往缺少 console error、network trace、页面状态
2. **延迟高**：问题发生到 issue 创建之间可能是小时甚至天
3. **覆盖率低**：大量前端错误用户根本不会注意到（静默失败）

ClawMark 浏览器插件已经运行在用户浏览器中，天然具备采集前端运行时数据的能力。本 PRD 将 ClawMark 从「反馈工具」升级为「质量哨兵」。

## 目标

| 目标 | 衡量标准 |
|------|---------|
| 自动采集所有 coco 产品的前端错误 | 90%+ console.error / network failure 被捕获 |
| 错误自动上报到后端 | 无需用户手动操作 |
| Jessie（AI agent）可实时消费错误流 | 从错误发生到 Jessie 感知 < 1 分钟 |
| 关键错误自动创建 GitLab issue | P1 错误 → issue，带完整堆栈和上下文 |

## 用户角色

| 角色 | 场景 |
|------|------|
| **终端用户（Kevin 等）** | 正常使用产品，插件后台自动采集错误 |
| **AI Agent（Jessie）** | 定时/实时读取错误数据，自动分诊 + 创建 issue |
| **开发者（Boot/Lucy 等）** | 在 ClawMark Dashboard 或 GitLab 查看错误报告 |

## 功能模块

### 模块 1：错误采集（Content Script）

基于已有设计 [design-43-qa-passive-monitoring.md](design-43-qa-passive-monitoring.md)，在 content script 中增加 `ErrorMonitor`：

| 采集类型 | 方式 | 优先级 |
|---------|------|--------|
| JS 运行时错误 | `window.onerror` + `unhandledrejection` | P1 |
| console.error | Proxy `console.error` | P1 |
| 网络请求失败 | Patch `fetch` / `XMLHttpRequest`，捕获 4xx/5xx/timeout | P1 |
| 资源加载失败 | `error` 事件（img/script/css） | P2 |
| 性能异常 | `PerformanceObserver`（long task > 200ms, CLS > 0.1） | P3 |

**数据结构：**
```json
{
  "type": "js_error | promise_rejection | network_error | resource_error | long_task",
  "message": "TypeError: Cannot read property 'map' of null",
  "url": "https://jessie.coco.site/hxa-link/chat",
  "source": "app.js:142:15",
  "stack": "TypeError: Cannot read...\n    at renderMessages (app.js:142)...",
  "timestamp": 1711000000000,
  "fingerprint": "sha256-first8",
  "userAgent": "Chrome/132...",
  "viewport": "1920x1080",
  "extras": {
    "statusCode": 500,
    "requestUrl": "/api/messages",
    "method": "GET"
  }
}
```

**去重策略：**
- 相同 fingerprint 在 5 秒内不重复采集
- fingerprint = hash(type + message + source file + line number)

### 模块 2：本地聚合（Background Service Worker）

Service Worker 负责：

1. **接收** content script 的 `error:captured` 消息
2. **存储** 到 `chrome.storage.local`，每个 tab 最多 100 条（ring buffer）
3. **Badge** 在扩展图标显示错误计数（红色）
4. **批量上报**（新增）：
   - 每 30 秒或累积 10 条错误触发上报
   - 通过 `POST /api/v2/errors` 上报到 ClawMark Server
   - 上报成功后清除本地已上报数据
   - 离线时暂存，恢复后补报

### 模块 3：服务端接收与存储（ClawMark Server）

新增 API 端点：

```
POST /api/v2/errors
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "errors": [
    { ...error1 },
    { ...error2 }
  ],
  "meta": {
    "extensionVersion": "0.8.2",
    "sessionId": "uuid",
    "userId": "google-oauth-id"
  }
}

Response 201:
{
  "accepted": 2,
  "deduplicated": 0
}
```

**服务端存储：**
- SQLite 新表 `client_errors`
- 字段：id, user_id, session_id, type, message, url, source, stack, fingerprint, extras(JSON), created_at
- 索引：fingerprint + created_at（去重查询）、url（按域名查询）、created_at（时间范围）
- 保留策略：30 天自动清理

**服务端去重：**
- 相同 fingerprint + 相同 user 在 1 分钟内只存一条
- 跨用户不去重（不同用户遇到相同错误 = 值得关注）

### 模块 4：错误查询 API（供 Jessie 消费）

```
GET /api/v2/errors?since=<timestamp>&domain=<hostname>&type=<type>&limit=50
Authorization: Bearer <jwt>

Response 200:
{
  "errors": [...],
  "total": 128,
  "hasMore": true
}
```

**查询参数：**
- `since`: 时间戳，只返回此时间之后的错误
- `domain`: 按域名过滤（如 `jessie.coco.site`）
- `type`: 按错误类型过滤
- `severity`: P1/P2/P3
- `limit` / `offset`: 分页

**Webhook 推送（可选，Phase 2）：**
- 配置 webhook URL，新 P1 错误实时 POST 到指定端点
- Jessie 可以注册 webhook 接收实时错误通知

### 模块 5：Side Panel 错误列表

在 ClawMark Side Panel 增加「Errors」标签：

```
┌─────────────────────────────┐
│ [标注] [错误 (3)] [设置]     │
├─────────────────────────────┤
│ 🔴 TypeError: Cannot read   │
│    property 'map' of null   │
│    app.js:142 · 10:34:05    │
│    [提 Issue] [忽略]         │
│                              │
│ 🟡 GET /api/health 503      │
│    10:34:05 · 已上报         │
│    [提 Issue] [忽略]         │
│                              │
│ 🟢 Long task 312ms          │
│    10:33:58                  │
│    [忽略]                    │
└─────────────────────────────┘
```

- 点击「提 Issue」→ 预填标注表单（标题 = 错误消息，描述 = 完整堆栈 + URL + 时间）
- 通过现有 delivery rules 分发到 GitLab/GitHub/Lark

### 模块 6：自动分诊（Jessie 侧）

Jessie 定时轮询 `GET /api/v2/errors`：

1. **聚合**：按 fingerprint 统计出现次数和影响用户数
2. **分类**：根据 URL 域名归属到对应项目（hxa-link / clawmark / coco-dashboard）
3. **自动建 issue**：
   - 条件：同一 fingerprint 出现 ≥ 3 次，或影响 ≥ 2 个用户
   - Issue 内容：错误描述 + 堆栈 + 影响范围 + 首次/末次出现时间
   - 自动 assign 给对应项目的 on-duty 开发者
4. **去重**：检查 GitLab 是否已有相同 fingerprint 的 open issue，避免重复创建

## 配置项

| 配置 | 位置 | 默认值 | 说明 |
|------|------|--------|------|
| `errorReportingEnabled` | chrome.storage.sync | `true` | 全局开关 |
| `errorReportingDomains` | chrome.storage.sync | `["*.coco.site", "*.coco.xyz"]` | 仅在指定域名采集（白名单） |
| `errorReportingSeverity` | chrome.storage.sync | `["P1", "P2"]` | 上报哪些级别 |
| `errorReportingInterval` | chrome.storage.sync | `30000` | 批量上报间隔（ms） |

**安全约束：**
- 默认仅在 coco 域名下采集（避免泄露用户在其他网站的数据）
- 错误消息中的敏感信息（token、密码）在上报前脱敏
- stack trace 中的本地文件路径不上报

## 实现分期

### Phase 1：采集 + 本地展示（基于已有设计 #43）
- ErrorMonitor content script 模块
- Service Worker 存储 + badge
- Side Panel 错误列表 + "提 Issue" 按钮
- **估时：L（2-3 session）**

### Phase 2：服务端上报 + Jessie 消费
- `POST /api/v2/errors` 端点
- Background 批量上报逻辑
- `GET /api/v2/errors` 查询 API
- Jessie 定时轮询 + 自动建 issue
- **估时：L（2-3 session）**

### Phase 3：高级功能（按需）
- Webhook 实时推送
- 错误趋势分析 Dashboard
- AI 错误归因（分析堆栈自动定位根因）
- Source map 支持（还原压缩后的堆栈）

## 与现有系统的关系

| 系统 | 关系 |
|------|------|
| ClawMark 标注 | 错误采集是标注的自动化补充，共享 delivery 管道 |
| ClawMark Server | 复用现有 auth + API 框架，新增 errors 模块 |
| GitLab Issues | 自动创建 issue 的目标系统 |
| Jessie Agent | 错误数据的消费者，自动分诊和建 issue |
| hxa-link | 首要监控目标（当前 bug 最多的产品） |

## 验收标准

1. Kevin 在浏览器中使用 hxa-link，触发一个 console.error → 30 秒内 Jessie 可以查询到
2. 同一错误重复出现 3 次 → 自动在 GitLab hxa-link 项目创建 issue
3. Issue 包含完整堆栈、URL、时间、影响用户数
4. 用户可以在 Settings 中关闭错误上报
5. 仅 coco 域名下采集，不泄露其他网站数据
