# PRD: ClawMark 多浏览器实例支持

> 状态：草案
> 作者：Jessie
> 日期：2026-03-28

## 1. 背景

一个用户（如 Kevin）在日常使用中会有以下场景：

- 拥有多个 Agent（zylos-jessie、cocoai-zylos-kevin-1b 等）
- 使用多个 Chrome Profile（工作号、个人号、测试号等）
- 每个 Profile 的 ClawMark 扩展登录同一或不同 Google 账号
- 每个 ClawMark 账号可以绑定多个 Agent

目前对于同一个 ClawMark 账号在不同浏览器实例下的行为不够清晰，需要梳理并明确设计。

## 2. 实体关系模型

```
人 (Human User)
├── Agent A (zylos-jessie)
├── Agent B (cocoai-zylos-kevin-1b)
├── Agent C (...)
│
├── Chrome Profile 1 (Google: kevin@coco.xyz)
│   └── ClawMark 扩展实例 1
│       ├── authToken (local storage, 独立)
│       ├── binding_id_1 → Agent A
│       └── binding_id_2 → Agent B
│       └── WS 连接 1
│
├── Chrome Profile 2 (Google: kevin@coco.xyz)  ← 同 Google 账号
│   └── ClawMark 扩展实例 2
│       ├── authToken (local storage, 独立)
│       ├── binding_id_3 → Agent A  ← 同 Agent，不同 binding
│       └── WS 连接 2
│
└── Chrome Profile 3 (Google: elonhe668@gmail.com)  ← 不同账号
    └── ClawMark 扩展实例 3
        ├── authToken (local storage, 独立)
        ├── binding_id_4 → Agent C
        └── WS 连接 3
```

### 关键关系

| 关系 | 类型 | 说明 |
|------|------|------|
| 人 → Agent | 1:N | 一个人管理多个 agent |
| 人 → Chrome Profile | 1:N | 多个浏览器实例 |
| Chrome Profile → Google Account | 1:1 | 每个 profile 一个 Google 账号 |
| Google Account → ClawMark User | 1:1 | Google 登录即身份 |
| ClawMark User → Bound Agent | 1:N | 一个账号绑定多个 agent |
| Chrome Profile → 扩展实例 | 1:1 | 每个 profile 独立扩展 |
| 扩展实例 → Binding | 1:N | 每个扩展实例独立注册 binding |
| 扩展实例 → WS 连接 | 1:1 | 每个实例一条 WebSocket |

## 3. 当前行为（代码确认）

### 3.1 连接管理

**每个 Chrome Profile 是独立的 agent 连接。**

- Server 维护 `bindingConnections` Map（`binding_id → Set<ws>`），而非用户级分组
- WS 连接认证需要 `key={agentKey}` + `binding={binding_id}`，均为 binding 级别
- 同一 Google 账号在多个 Profile 中会各自独立认证、独立建立 binding

```
代码位置：server/ws-perception.js:126-131
bindingConnections.set(ctx.binding_id, new Set())
appBindings.set(ctx.app_id, new Set())  // app 级索引
```

### 3.2 Perception 事件路由

**所有 binding 都收到同一 app 的 perception 事件。**

- `pushPerceptionEvents(app_id, events)` 遍历 `appBindings.get(app_id)` 的所有 binding
- 同一 Google 账号的多个 Profile 共享同一个 `app_id`（默认 "default"）
- 结果：Agent A 绑定在两个 Profile 上 → 收到两份 perception 数据

```
代码位置：server/ws-perception.js:230-252
for (const bindingId of bindingIds) {
    for (const ws of sockets) {
        wsSend(ws, { type: 'perception', binding_id: bindingId, payload: event });
    }
}
```

### 3.3 Action 路由

**Action 是 binding 级别隔离的。**

- Agent 发送 action 时关联到特定 binding_id
- action result 只路由回发起 action 的 agent_id 对应的 WS 连接
- 扩展端通过 `chrome.tabs.sendMessage(tabId, ...)` 在具体 tab 上执行 action
- 不同 Profile 的 tab 完全隔离

```
代码位置：server/ws-actions.js:174-190
代码位置：extension/background/action-queue.js:54-111
```

### 3.4 Storage 同步

| 数据 | 存储位置 | 是否跨 Profile 同步 |
|------|----------|---------------------|
| serverUrl, apiKey, appId | chrome.storage.sync | 是（同 Google 账号） |
| boundAgents | chrome.storage.sync | 是 |
| authToken | chrome.storage.local | **否** |
| authUser | chrome.storage.local | **否** |

关键：**config 同步但 auth 不同步**。每个 Profile 必须独立认证。

### 3.5 Session ID

- DB schema 支持 `session_id` 字段（`action_queue` 表）
- 但**目前未用于路由**——仅存储，不影响 action dispatch

## 4. 当前问题

### P1: Perception 事件重复

同一 Agent 绑定在同一用户的多个 Profile 上时，Agent 收到的 perception 事件数量 = Profile 数 × 事件数。没有去重机制。

**影响**：Agent 会重复处理相同网页上的相同事件。

### P2: 无法区分 Perception 来源

Agent 收到 perception 事件时，不知道来自哪个浏览器实例。如果用户在 Profile 1 看邮件、Profile 2 写代码，Agent 无法区分。

**影响**：Agent 缺乏上下文理解用户在不同浏览器中的行为。

### P3: Action 无法指定目标实例

Agent 发送 action（如 "在当前页面点击按钮"）时，无法指定发到哪个 Profile。当前行为是发到建立 binding 的那个连接。

**影响**：在多实例场景下，action 可能发到错误的浏览器。

### P4: boundAgents 同步与 Auth 不同步的矛盾

`boundAgents` 通过 sync storage 同步到所有同账号 Profile，但 authToken 不同步。Profile 2 可能看到 Profile 1 注册的 boundAgents 但没有对应的 auth 凭证。

**影响**：新 Profile 看到 boundAgents 列表但可能无法正确连接。

### P5: Dashboard 显示不区分实例

Bound Agents 页面显示 "Connected" / "Offline"，但不区分是哪个 Profile 连接的。

**影响**：用户无法判断哪个浏览器实例在工作。

## 5. 设计方案

### 5.1 引入 Instance 概念

```
ClawMark User (Google Account)
└── App (default)
    ├── Instance 1 (Chrome Profile 1)  ← NEW
    │   ├── instance_id: "inst-xxxx"
    │   ├── label: "Work Chrome" (用户可命名)
    │   ├── WS 连接
    │   └── Binding → Agent A, Agent B
    │
    └── Instance 2 (Chrome Profile 2)  ← NEW
        ├── instance_id: "inst-yyyy"
        ├── label: "Personal Chrome"
        ├── WS 连接
        └── Binding → Agent A
```

- 每个 Chrome Profile 在首次认证时生成一个 `instance_id`（存 `chrome.storage.local`，不跨 Profile 同步）
- WS 连接携带 `instance_id` 参数
- Server 新增 `instanceConnections` Map（`instance_id → ws`）

### 5.2 Perception 事件增加来源标识

```json
{
  "type": "perception",
  "binding_id": "bind-xxx",
  "instance_id": "inst-xxxx",
  "instance_label": "Work Chrome",
  "payload": { ... }
}
```

Agent 端可根据 `instance_id` 去重或区分来源。

### 5.3 Action 支持目标实例

```json
{
  "type": "action",
  "action_id": "act-xxx",
  "target_instance": "inst-xxxx",
  "payload": { ... }
}
```

- `target_instance` 可选。不指定时发到最近活跃的实例（fallback）
- 指定时只发到该实例

### 5.4 Dashboard 增加实例信息

Bound Agents 页面增加：
- 显示每个 agent 从哪些实例连接
- 实例状态（connected / offline）
- 实例标签（用户可编辑）

### 5.5 Session ID 利用

将已有的 `session_id` 字段关联到 `instance_id`，用于 action 路由。每个浏览器实例维护自己的 session，action 可按 session 路由。

## 6. 实施分期

### Phase 1: 基础 — Instance 标识（S 级）
- 扩展端生成 `instance_id` 存入 `chrome.storage.local`
- WS 连接参数增加 `instance_id`
- Server 记录 instance 信息
- Perception 事件增加 `instance_id` 字段

### Phase 2: Action 路由（M 级）
- Action 支持 `target_instance` 参数
- Server 按 instance 路由 action
- 未指定时 fallback 到最近活跃实例

### Phase 3: Dashboard UI（S 级）
- Bound Agents 页面显示实例列表
- 实例标签编辑
- 实例连接状态

### Phase 4: Agent SDK 支持（S 级）
- zylos-clawmark 组件支持读取 instance_id
- Perception 去重能力
- Action 指定目标实例

## 7. 兼容性

- 旧版扩展不发送 `instance_id` → Server 将其视为 `instance_id = null`，行为与当前一致
- 新字段均为可选，不影响现有 binding 和 agent 连接
- 渐进升级：先升 server，再升 extension，最后升 agent SDK
