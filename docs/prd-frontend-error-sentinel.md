# PRD: Agent Embed — 让 AI Agent 寄生在浏览器中

> ClawMark 从「反馈工具」进化为「Agent 的眼睛和手」

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

## 安全模型

| 层级 | 约束 |
|------|------|
| **域名白名单** | Agent 只能感知白名单域名的数据（默认 `*.coco.site`, `*.coco.xyz`） |
| **行动授权** | 高风险操作（删除、支付、设置变更）需用户确认弹窗 |
| **数据脱敏** | 密码字段、token、敏感 cookie 自动脱敏后上报 |
| **会话隔离** | Agent 只能访问绑定用户的数据，不能跨用户 |
| **开关控制** | 用户可一键暂停所有 Agent 感知（插件图标 → 暂停） |
| **操作审计** | 所有 Agent 行动记录在案，用户可在 Side Panel 查看历史 |

## 实现分期

### Phase 1：感知层（Agent 能「看到」浏览器）
- Content Script: ErrorMonitor + NetworkMonitor + ConsoleProxy
- Background: Agent Bridge（感知事件上报）
- Server: `POST /api/v2/agent-channel/perception` + 存储
- Agent 侧: 定时拉取感知数据 → 自动创建 issue
- **交付物：Agent 能实时感知用户浏览器的 console/network 错误，自动建 issue**
- **估时：L（3-4 session）**

### Phase 2：记忆层（Agent 能「回放」用户操作）
- Content Script: SessionRecorder（事件序列 + 智能快照）
- Server: Session 存储 + 查询 API
- Agent 侧: 结合 session 上下文分析 bug 根因
- **交付物：Issue 自动附带用户操作回放，Agent 能理解 bug 的完整上下文**
- **估时：XL（4-5 session）**

### Phase 3：行动层（Agent 能「操作」浏览器）
- Content Script: ActionExecutor（DOM 操作、导航、截图）
- Server: Action Queue + WebSocket 双向通道
- Agent 侧: 自主巡检脚本（核心流程自动化测试）
- **交付物：Agent 能自主打开页面、执行操作、验证结果 —— 自动化 E2E 测试**
- **估时：XL（5-6 session）**

### Phase 4：闭环（Agent 从发现到修复全自动）
- Agent 侧: Error → git blame → 生成修复 PR → 通知 reviewer
- Dashboard: 错误趋势 + Agent 行动历史 + 质量报告
- **交付物：发现 bug → 修复 PR，全自动，人只需 review merge**
- **估时：XL（5-6 session）**

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

### Phase 4 验收
1. 从错误发生到修复 PR 创建，全自动，0 人工干预
2. 修复 PR 的 merge rate > 60%（说明 AI 修复质量可用）
