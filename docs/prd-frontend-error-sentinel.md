# PRD: Agent Embed — 让 AI Agent 寄生在浏览器中

> ClawMark 从「反馈工具」进化为「Agent 的眼睛和手」
>
> **参考方案**：[OpenClaw Browser Relay](https://docs.openclaw.ai/tools/browser)（CDP 远程控制） · [Claude Code /chrome](https://code.claude.com/docs/en/chrome.md)（Native Messaging + per-site permission） · [Sentry](https://sentry.io)（错误采集基准线）

## 愿景

**Agent Embed 是一种新范式：AI Agent 不再是被动等待指令的后端服务，而是通过浏览器插件直接寄生在用户环境中，拥有与用户相同的视角和操作能力。**

ClawMark 已经运行在用户浏览器里，拥有 `<all_urls>` 权限、content script 注入、截图能力。现在，我们让它成为 Agent 的宿主 —— Agent 通过 ClawMark 看到页面、感知错误、操作 DOM、执行测试，像一个永远在线的 AI 队友坐在你旁边看着你的屏幕。

## 这不是 Sentry

Sentry 是被动采集 → 人工分诊 → 人工修复。

Agent Embed 是：
- **Agent 主动巡检**：不等错误上报，Agent 自己打开页面测试
- **Agent 实时感知**：用户在用产品时，Agent 同步看到 console、network、DOM 变化
- **Agent 直接行动**：发现问题 → 分析根因 → 生成修复 PR → 通知团队，全自动闭环
- **Agent 理解上下文**：不是孤立的 error log，而是理解用户在做什么、为什么出错、影响多大

## 核心架构

Agent Embed 是 ClawMark 的**原生能力**，不依赖任何外部系统（HxA Link、HxA Connect 等）。Agent 可以是任何 AI —— Jessie、第三方 LLM、甚至用户自建的 Agent。ClawMark 提供标准的 Agent Channel API，任何 Agent 只要接入这个 API 就能获得浏览器感知和操作能力。

```
┌─────────────────────────────────────────────────────┐
│                    用户浏览器                          │
│                                                       │
│  ┌──────────────┐    ┌──────────────────────────┐    │
│  │   任意网页     │    │   ClawMark Extension      │    │
│  │  (webapp)     │◄──►│                           │    │
│  │               │    │  Content Script:           │    │
│  │  DOM / JS     │    │  · ErrorMonitor (感知)     │    │
│  │  Console      │    │  · DOMInspector (观察)     │    │
│  │  Network      │    │  · ActionExecutor (操作)   │    │
│  └──────────────┘    │  · SessionRecorder (记录)  │    │
│                       │                           │    │
│                       │  Background SW:            │    │
│                       │  · Agent Bridge (通信)     │    │
│                       │  · Task Scheduler (调度)   │    │
│                       └─────────┬─────────────────┘    │
│                                 │ WebSocket             │
└─────────────────────────────────┼───────────────────────┘
                                  │
                    ┌─────────────▼─────────────┐
                    │      ClawMark Server       │
                    │                            │
                    │  · Agent Channel API       │
                    │  · Perception Store        │
                    │  · Action Queue            │
                    │  · Agent Auth (API Key)    │
                    └─────────────┬──────────────┘
                                  │ Standard REST/WS API
                    ┌─────────────▼─────────────┐
                    │     Any AI Agent           │
                    │  (Jessie / 3rd party /     │
                    │   user-built agent)        │
                    │                            │
                    │  · 消费感知数据              │
                    │  · 下发操作指令              │
                    │  · 自主决策 + 行动           │
                    └───────────────────────────┘
```

**设计原则：**
- ClawMark 是独立产品，Agent Channel 是它的原生 API
- Agent 通过 ClawMark API Key 接入，不需要其他系统的身份
- 一个用户可以绑定多个 Agent（QA Agent、安全 Agent、性能 Agent…）
- Agent 的智能在 Agent 侧实现，ClawMark 只提供感知和操作通道

## 四大能力

### 能力 1：感知（Perception）

Agent 通过 ClawMark 获得浏览器的「五感」：

| 感知通道 | 数据 | 实现方式 |
|---------|------|---------|
| **Console 感知** | error / warn / log 输出 | Proxy `console.*` |
| **Network 感知** | 请求/响应/失败/延迟 | Patch `fetch` + `XMLHttpRequest` |
| **DOM 感知** | 页面结构、元素状态、可见性 | `MutationObserver` + DOM snapshot |
| **视觉感知** | 页面截图、渲染状态 | `html2canvas` / `chrome.tabs.captureVisibleTab` |
| **用户行为感知** | 点击、输入、导航、滚动 | 事件监听 + 行为序列记录 |
| **性能感知** | Long task / CLS / LCP / 内存 | `PerformanceObserver` API |

**关键设计：感知数据不是 raw dump，而是结构化事件流。**

```typescript
interface PerceptionEvent {
  channel: 'console' | 'network' | 'dom' | 'visual' | 'user' | 'perf';
  severity: 'critical' | 'warning' | 'info';
  timestamp: number;
  url: string;           // 当前页面
  summary: string;       // 人/AI 可读的一句话描述
  detail: object;        // 完整数据
  context: {
    userAction?: string; // 触发此事件的用户操作（如 "clicked Submit button"）
    sessionPhase?: string; // 用户处于什么流程（如 "agent creation flow"）
  };
}
```

### 能力 2：记忆（Session Recording）

不只是记录错误，而是记录完整的用户会话上下文：

**Session Replay 数据结构：**
```typescript
interface SessionSegment {
  sessionId: string;
  startTime: number;
  events: Array<{
    type: 'navigation' | 'click' | 'input' | 'scroll' | 'api_call' | 'error' | 'screenshot';
    timestamp: number;
    data: object;
  }>;
  snapshots: Array<{   // 关键时刻的 DOM 快照
    timestamp: number;
    trigger: string;    // 什么触发了快照（error / navigation / manual）
    html: string;       // 压缩后的 DOM 快照
    screenshot?: string; // base64 截图
  }>;
}
```

**智能触发快照（不是持续录屏）：**
- Error 发生时：自动截图 + DOM 快照
- 页面导航时：记录 from/to
- API 返回异常时：记录请求/响应
- 用户连续操作后停顿 > 3 秒：可能遇到困惑
- Agent 主动请求快照

这让 Agent 能「回放」用户遇到 bug 的完整过程，而不只是看到一条 error log。

### 能力 3：行动（Action）

Agent 不只是看，还能操作：

| 行动类型 | 描述 | 场景 |
|---------|------|------|
| **DOM 操作** | 点击、输入、滚动、选择 | Agent 自主测试：自动走完注册/发消息流程 |
| **导航** | 打开 URL、前进后退 | Agent 巡检：依次打开关键页面检查 |
| **截图** | 捕获当前页面 | Agent 取证：发现问题时保存现场 |
| **注入脚本** | 执行自定义 JS | Agent 诊断：检查特定变量状态、调用内部 API |
| **表单填写** | 自动填充测试数据 | Agent 回归测试：用预设数据走完核心流程 |

**Action 通过 Agent Channel 下发：**
```typescript
// Agent → ClawMark Server → Extension
interface AgentAction {
  actionId: string;
  type: 'click' | 'type' | 'navigate' | 'screenshot' | 'inject' | 'scroll';
  target?: string;      // CSS selector 或 XPath
  value?: string;       // 输入值或 URL
  timeout?: number;     // 最大等待时间
}

// Extension → ClawMark Server → Agent
interface ActionResult {
  actionId: string;
  success: boolean;
  result?: object;      // 截图 base64、注入脚本返回值等
  error?: string;
}
```

### 能力 4：决策（Agent Intelligence）

Agent 侧的智能处理（不在插件内，在 Jessie 的 runtime 中）：

**自动分诊流：**
```
感知事件流 → 聚合分析 → 决策 → 行动

例：
1. Console 感知：TypeError at chat.js:142（3 次/分钟）
2. Network 感知：GET /api/messages 返回 500
3. Session 记忆：用户刚点了「发送消息」按钮
4. Agent 分析：消息发送 API 返回 500 → 前端 .map() 处理空响应报错
5. Agent 行动：
   a. 创建 GitLab issue（含完整堆栈 + session replay + 影响范围）
   b. git blame 定位代码 → 自动生成修复 PR
   c. 通知 Boot（assignee）review
   d. 在 Connect 群通知：「发现消息发送 API 500 bug，已提 PR !xxx」
```

**自主巡检流：**
```
定时触发 → Agent 操作浏览器 → 验证核心功能 → 报告

例（每小时执行）：
1. navigate → hxa-link login page
2. type username/password → click login
3. verify → dashboard loaded, no console errors
4. navigate → chat page → send test message
5. verify → message appears, no errors
6. screenshot → 保存为 baseline
7. 结果：PASS（或 FAIL + issue）
```

## Agent Channel 协议

ClawMark Extension 和 Agent 之间通过 ClawMark Server 中转通信。这是 ClawMark 的原生 API，与其他产品无依赖。

### Agent 认证

Agent 通过 ClawMark 自己的 API Key 认证：

```
POST /api/v2/agent-channel/register
Authorization: Bearer <user-jwt>
{
  "agentName": "QA Bot",
  "permissions": ["perception", "action", "session"]
}

Response 201:
{
  "agentId": "cm_agent_xxx",
  "apiKey": "cmak_xxxxxxxx",   // ClawMark Agent Key，一次显示
  "permissions": [...]
}
```

### 通信端点

```
Extension ←→ ClawMark Server ←→ Agent

Extension → Server:
  POST /api/v2/agent-channel/perception   (上报感知数据)
  POST /api/v2/agent-channel/session      (上报 session 片段)
  WS   /api/v2/agent-channel/ws           (双向实时通道)

Agent → Server:
  GET  /api/v2/agent-channel/perception   (查询感知数据)
  GET  /api/v2/agent-channel/sessions     (查询 session 历史)
  POST /api/v2/agent-channel/actions      (下发操作指令)
  WS   /api/v2/agent-channel/ws           (双向实时通道)

All Agent endpoints require: Authorization: Bearer cmak_xxxxxxxx
```

### Agent 绑定

- 每个 ClawMark 用户可以绑定多个 Agent（QA Agent、安全 Agent、性能 Agent…）
- 绑定通过 ClawMark Dashboard 或 Extension Settings 管理
- 每个 Agent 有独立的权限控制（只感知 / 可操作 / 可读 session）
- 用户可以随时解绑 / 暂停任意 Agent

## 权限模型（参考 Claude Code /chrome + OpenClaw Browser Relay）

借鉴 Claude Code `/chrome` 的 per-site permission 模型和 OpenClaw Browser Relay 的 CDP 架构，设计三层权限：

### 站点级权限（Per-Site Permission）

**权限粒度：每个 Agent 独立一份设置。** 不同 Agent 可以对同一站点有不同的权限级别。例如 QA Agent 有操作权限，而监控 Agent 只有感知权限。

参考 Claude in Chrome 插件的权限管理：

```
Extension Settings → Agent Permissions → [选择 Agent]
┌─────────────────────────────────────────┐
│ QA Bot — Site Permissions                │
│                                          │
│ ✅ jessie.coco.site   [感知][操作][录制] │
│ ✅ *.coco.xyz         [感知][  ][  ]    │
│ ❌ github.com         (blocked)          │
│                                          │
│ [+ Add site]                             │
│                                          │
│ Default: Ask on first visit              │
└─────────────────────────────────────────┘
```

- **每个站点独立授权**：用户控制 Agent 能在哪些站点感知/操作
- **三种权限粒度**：感知（只读 console/network/DOM）、操作（能 click/type/navigate）、录制（记录 session）
- **首次访问询问**：Agent 首次请求访问新站点时，弹窗询问用户
- **权限持久化**：存储在 `chrome.storage.sync`，跨设备同步

### 操作风险分级

| 风险级别 | 操作类型 | 授权方式 |
|---------|---------|---------|
| **低** | 读取 console/network/DOM | 站点权限授权后自动允许 |
| **中** | 点击、输入、导航、截图 | 站点操作权限授权后允许 |
| **高** | 表单提交、文件上传、删除操作 | 每次弹窗确认 |
| **禁止** | 密码输入、支付操作、账户设置 | 始终阻止 |

### CDP 升级路径（Phase 3+）

Phase 1-2 使用 Content Script 实现感知和基本操作。Phase 3 引入 CDP（Chrome DevTools Protocol）作为高级通道：

**为什么需要 CDP：**
- Content Script 无法获取 Performance Profile、Memory Snapshot
- Content Script 无法拦截 Service Worker 内部请求
- Content Script 的 DOM 操作能力有限（无法模拟真实鼠标事件）
- CDP 能提供完整的 debugger 能力（断点、变量检查、网络节流）

**CDP 实现方式（参考 OpenClaw）：**
```
Extension 使用 chrome.debugger API
    │ attach 到目标 tab
    │
    ▼
CDP Session → 暴露给 Agent Bridge
    │
    ▼
Agent 可发送任意 CDP 命令：
  · Page.navigate
  · Runtime.evaluate
  · DOM.querySelector + click
  · Network.enable + 拦截
  · Performance.getMetrics
  · HeapProfiler.takeHeapSnapshot
```

**安全约束：**
- CDP 模式仅在用户显式启用后激活（默认关闭）
- 使用 CDP 时插件图标变为橙色（视觉提示）
- CDP 命令白名单：只允许安全的只读/操作命令，禁止 `Target.disposeBrowserContext` 等危险操作

## 安全模型

| 层级 | 约束 |
|------|------|
| **站点级权限** | Per-site permission：每个站点独立授权感知/操作/录制权限 |
| **操作风险分级** | 低/中/高/禁止四级，高风险每次确认，支付等始终阻止 |
| **数据脱敏** | 密码字段、token、敏感 cookie 自动脱敏后上报 |
| **会话隔离** | Agent 只能访问绑定用户的数据，不能跨用户 |
| **开关控制** | 用户可一键暂停所有 Agent 感知（插件图标 → 暂停） |
| **操作审计** | 所有 Agent 行动记录在案，用户可在 Side Panel 查看历史 |
| **CDP 可选** | CDP 模式默认关闭，仅在用户显式启用后激活，命令白名单过滤 |

## 任务跟踪

**GitLab Issue**: [#61 Agent Embed — 浏览器内 AI Agent 感知与操作能力](https://git.coco.xyz/hxanet/clawmark/-/issues/61)

子任务将在 #61 下拆分为独立 issue，按 Phase 分配。

## 实现分期

### Phase 1：感知层（Agent 能「看到」浏览器）

**开发任务：**
- Content Script: ErrorMonitor + NetworkMonitor + ConsoleProxy
- Background: Agent Bridge（感知事件上报）
- Server: `POST /api/v2/agent-channel/perception` + 存储 + `GET` 查询 API
- Server: Agent 注册 + API Key 签发（`POST /api/v2/agent-channel/register`）
- Agent 侧: 定时拉取感知数据 → 自动创建 issue
- Extension Settings: Agent 绑定 UI + per-agent per-site 权限设置
- **参考实现**：Sentry SDK 错误采集模式 + OpenClaw Relay 的 tab 自动 attach

**文档交付：**
- 开发者文档：Agent Channel API Reference（认证、端点、数据结构、错误码）
- 用户文档：如何绑定 Agent、权限管理、开关控制、FAQ

**交付物：Agent 能实时感知用户浏览器的 console/network 错误，自动建 issue**
**估时：L（3-4 session）**

### Phase 2：记忆层（Agent 能「回放」用户操作）

**开发任务：**
- Content Script: SessionRecorder（事件序列 + 智能快照）
- Server: Session 存储 + 查询 API（`POST/GET /api/v2/agent-channel/sessions`）
- Agent 侧: 结合 session 上下文分析 bug 根因
- Side Panel: Session 回放查看器
- **参考实现**：LogRocket session replay 数据模型

**文档交付：**
- 开发者文档：Session 数据格式规范 + 回放 API
- 用户文档：Session 录制说明、隐私控制、数据保留策略

**交付物：Issue 自动附带用户操作回放，Agent 能理解 bug 的完整上下文**
**估时：XL（4-5 session）**

### Phase 3：行动层（Agent 能「操作」浏览器）

**开发任务：**
- Content Script: ActionExecutor（DOM 操作、导航、截图、表单填写）
- Server: Action Queue + WebSocket 双向通道（实时指令下发 + 结果回传）
- Agent 侧: 自主巡检脚本（核心流程自动化测试）
- **参考实现**：Claude Code /chrome 的操作能力（click/type/navigate/screenshot）+ per-site permission 模型

**文档交付：**
- 开发者文档：Action API 规范 + 巡检脚本编写指南
- 用户文档：操作授权管理、风险分级说明

**交付物：Agent 能通过 Content Script 操作页面 —— 基础 E2E 巡检**
**估时：L（3-4 session）**

### Phase 4：CDP 通道（深度浏览器控制）

**开发任务：**
- Extension: 通过 `chrome.debugger` API attach 目标 tab，建立 CDP session
- Background: CDP Relay —— Agent 命令 ↔ CDP 协议转换层
- CDP 命令白名单过滤（安全）：
  - 允许：`Page.navigate`, `Runtime.evaluate`, `DOM.querySelector`, `Network.enable`, `Performance.getMetrics`, `Page.captureScreenshot`
  - 禁止：`Target.disposeBrowserContext`, `Browser.close`, `SystemInfo.*` 等危险操作
- Server: CDP 通道端点（`WS /api/v2/agent-channel/cdp`）
- Extension Settings: CDP 模式开关（默认关闭，启用时图标变橙色）
- **参考实现**：OpenClaw Browser Relay 的三层架构（Extension → Gateway → Agent）+ loopback + token 认证

**文档交付：**
- 开发者文档：CDP 命令白名单清单 + CDP 通道 API + 本地 Gateway 部署指南
- 用户文档：CDP 模式启用说明、安全须知、视觉提示含义

**交付物：Agent 获得完整 DevTools 级能力 —— Performance Profile、Memory Snapshot、网络拦截、精确 DOM 操作**
**估时：XL（5-6 session）**

### Phase 5：闭环（Agent 从发现到修复全自动）

**开发任务：**
- Agent 侧: Error → git blame → 生成修复 PR → 通知 reviewer
- Dashboard: 错误趋势 + Agent 行动历史 + 质量报告
- Webhook: 实时推送 P1 错误到外部系统

**文档交付：**
- 开发者文档：Webhook 配置 + Dashboard API
- 用户文档：自动修复工作流说明、审计日志查看

**交付物：发现 bug → 修复 PR，全自动，人只需 review merge**
**估时：XL（5-6 session）**

## 与现有系统的关系

| 系统 | 关系 |
|------|------|
| **ClawMark 标注** | 人工标注 = 用户主动反馈；Agent Embed = AI 自动发现。互补，共享 delivery 管道 |
| **ClawMark Server** | Agent Channel 是 Server 的原生模块，复用现有 auth + DB + API 框架 |
| **ClawMark Dashboard** | 新增 Agent 管理面板：绑定/解绑 Agent、查看感知历史、操作审计 |
| **外部 AI Agent** | 任何 Agent 通过 ClawMark API Key 接入，ClawMark 不关心 Agent 的实现 |
| **GitLab / GitHub** | Agent 自行调用 Git API 创建 issue/PR（Agent 侧逻辑，不是 ClawMark 的责任） |

## 差异化定位

| 对比 | Sentry / LogRocket | Agent Embed |
|------|-------------------|-------------|
| 定位 | 错误监控工具 | Agent 的浏览器载体 |
| 感知 | 被动采集错误 | 主动巡检 + 被动感知 |
| 分析 | 人工看 dashboard | AI 自动分析根因 |
| 行动 | 人工创建 issue → 人工修复 | 自动建 issue → 自动生成 PR |
| 上下文 | 孤立的 error stack | 完整 session replay + 用户意图 |
| 闭环 | 发现 → 人工 → 修复 | 发现 → AI → 修复 → 人工 review |

## 验收标准

### Phase 1 验收
1. Kevin 使用 hxa-link 时触发 console.error → Jessie 30 秒内感知并自动创建 GitLab issue
2. Issue 包含：错误堆栈 + 页面 URL + 触发时的 network 上下文
3. 相同错误不重复创建 issue

### Phase 2 验收
1. Issue 自动附带用户操作序列（点击了什么 → 触发了什么请求 → 出了什么错）
2. Agent 能基于 session 上下文分析根因，issue 描述中包含推测的原因

### Phase 3 验收
1. Agent 每小时自主执行一轮核心功能巡检（登录 → 聊天 → 发消息 → 验证）
2. 巡检失败自动创建 issue + 截图

### Phase 4 验收（CDP）
1. Agent 通过 CDP 获取页面 Performance Metrics + Memory Snapshot
2. CDP 命令白名单生效 —— 危险命令被拦截
3. CDP 模式启用时插件图标变橙色，关闭后恢复
4. Agent 通过 CDP 执行精确 DOM 操作（比 Content Script 更可靠）

### Phase 5 验收
1. 从错误发生到修复 PR 创建，全自动，0 人工干预
2. 修复 PR 的 merge rate > 60%（说明 AI 修复质量可用）
