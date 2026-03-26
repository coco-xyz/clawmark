# Agent 双向绑定设计文档

**关联 Issue:** hxa-link#722, ClawMark#61 (Agent Embed)
**作者:** Jessie
**日期:** 2026-03-27
**状态:** Draft — 待 Kevin 审阅

---

## 1. 背景与动机

### 现状问题

当前 ClawMark Agent Channel 的接入方式是**单向的**：

1. 用户在 Dashboard 注册 Agent → 获得 `cmak_` API Key
2. 用户把 key 手动配置到 Agent 侧
3. Agent 通过 HTTP 轮询消费 Perception 数据

这种模式存在几个根本问题：

- **单向信任**：ClawMark 发了 key 但不知道对面是谁，Agent 拿了 key 但没有验证 ClawMark 身份
- **无法追踪连接状态**：Server 不知道 Agent 是否在线、是什么类型、运行在哪里
- **不支持多对多**：一个 Agent 实例很难同时接入多个 ClawMark App，反过来一个 App 也难以管理多个异构 Agent
- **无组件化**：接入 ClawMark 需要每个 Agent 自己写 HTTP 轮询逻辑，没有标准 SDK/组件

### 目标

设计一套**双向绑定**机制，让 ClawMark ↔ Agent 的连接像 OAuth App Install 一样标准化：

- 用户发起邀请（生成 binding token）
- Agent 侧安装标准组件（zylos-clawmark）完成握手
- 双方互持凭证，建立持久双向连接
- 支持多对多关系

---

## 2. 核心概念

### 2.1 角色定义

| 角色 | 说明 | 类比 |
|------|------|------|
| **ClawMark App** | 一个 ClawMark 应用实例（有自己的 app_id） | OAuth Provider |
| **Agent 实例** | 一个运行中的 Zylos Agent（有自己的 agent identity） | OAuth Client App |
| **Binding** | 一条 App ↔ Agent 的绑定关系 | OAuth App Installation |
| **Binding Token** | 一次性邀请码，用于建立绑定 | OAuth Authorization Code |

### 2.2 多对多关系

```
ClawMark App A ──┬── Binding 1 ──── Agent X (Zylos Jessie)
                 └── Binding 2 ──── Agent Y (Zylos Boot)

ClawMark App B ──┬── Binding 3 ──── Agent X (Zylos Jessie)  ← 同一 Agent 接入多个 App
                 └── Binding 4 ──── Agent Z (外部 Agent)
```

每条 Binding 独立管理权限范围、连接状态、凭证。

---

## 3. 绑定流程

### 3.1 完整流程图

```
用户 (Dashboard)                ClawMark Server              Agent 实例
     │                              │                           │
     │  1. 点击 "Bind Agent"        │                           │
     │─────────────────────────────▶│                           │
     │                              │                           │
     │  2. 选择权限范围 (scopes)     │                           │
     │─────────────────────────────▶│                           │
     │                              │                           │
     │  3. 返回 Binding Token       │                           │
     │◀─────────────────────────────│                           │
     │     (一次性, 含 app_id +      │                           │
     │      scopes, 有效期 24h)      │                           │
     │                              │                           │
     │  4. 复制 token + 安装指令     │                           │
     │     发给 Agent owner          │                           │
     │─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─▶│
     │                              │                           │
     │                              │  5. Agent 安装 zylos-clawmark
     │                              │     组件，配置 binding token │
     │                              │                           │
     │                              │  6. 组件启动 → 握手请求    │
     │                              │◀──────────────────────────│
     │                              │   POST /api/v2/bind/handshake
     │                              │   { binding_token, agent_info }
     │                              │                           │
     │                              │  7. 验证 token → 创建 Binding
     │                              │     生成双向凭证           │
     │                              │                           │
     │                              │  8. 返回绑定凭证          │
     │                              │──────────────────────────▶│
     │                              │   { binding_id,           │
     │                              │     agent_key (cmak_),    │
     │                              │     ws_endpoint }         │
     │                              │                           │
     │  9. Dashboard 显示            │  10. 建立 WebSocket      │
     │     "Agent X 已绑定 ✅"       │◀──────────────────────────│
     │◀─────────────────────────────│      持久连接              │
```

### 3.2 Binding Token 设计

```
格式: cmbt_{base64url(payload)}.{signature}

Payload:
{
  "app_id": "uuid",           // ClawMark App ID
  "scopes": ["perception", "action", "session"],  // 授权范围
  "created_by": "user@email", // 创建者
  "created_at": "ISO8601",
  "expires_at": "ISO8601",    // 默认 24 小时
  "nonce": "random-hex"       // 一次性，防重放
}

签名: HMAC-SHA256(payload, server_secret)
```

**特性：**
- 一次性使用：握手成功后 token 作废
- 有效期 24 小时（可配置）
- 包含权限范围，Agent 接受时即同意该范围
- 不含敏感信息，可通过即时通讯传递

### 3.3 权限范围 (Scopes)

| Scope | 说明 | 数据方向 |
|-------|------|----------|
| `perception` | 接收浏览器感知事件（错误、网络、性能） | ClawMark → Agent |
| `action` | 执行页面操作（CDP 指令） | Agent → ClawMark |
| `session` | 查看/管理浏览器 Session | 双向 |
| `annotation` | 接收用户标注/评论 | ClawMark → Agent |
| `issue` | 创建/管理追踪 Issue | Agent → ClawMark |
| `admin` | 管理 App 设置（受限） | Agent → ClawMark |

用户创建 token 时选择授权哪些 scope，Agent 握手时不能请求超出 token 范围的权限。

---

## 4. 数据模型

### 4.1 新增表：bindings

```sql
CREATE TABLE IF NOT EXISTS bindings (
    id              TEXT PRIMARY KEY,           -- binding UUID
    app_id          TEXT NOT NULL,              -- ClawMark App ID
    agent_id        TEXT,                       -- agents 表 FK（握手后填充）

    -- Agent 身份信息（握手时由 Agent 提供）
    agent_name      TEXT,                       -- Agent 显示名
    agent_type      TEXT DEFAULT 'zylos',       -- zylos / external / custom
    agent_node_url  TEXT,                       -- Agent 节点 URL 标识符

    -- 权限与状态
    scopes          TEXT NOT NULL DEFAULT '[]', -- JSON array of granted scopes
    status          TEXT NOT NULL DEFAULT 'pending',
                    -- pending: token 已生成，等待握手
                    -- active: 已绑定，正常工作
                    -- suspended: 暂停（用户手动或违规）
                    -- revoked: 已解绑

    -- 连接状态
    connected       INTEGER NOT NULL DEFAULT 0, -- 当前是否在线 (WebSocket)
    last_heartbeat  TEXT,                       -- 最近心跳时间

    -- Token 信息
    token_hash      TEXT,                       -- binding token 的 hash（用于握手验证）
    token_used      INTEGER NOT NULL DEFAULT 0, -- token 是否已使用
    token_expires   TEXT,                       -- token 过期时间

    -- 审计
    created_by      TEXT NOT NULL,              -- 创建 token 的用户
    created_at      TEXT NOT NULL,
    activated_at    TEXT,                       -- 握手成功时间
    updated_at      TEXT NOT NULL,

    FOREIGN KEY (app_id) REFERENCES apps(id),
    FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE INDEX IF NOT EXISTS idx_bindings_app ON bindings(app_id);
CREATE INDEX IF NOT EXISTS idx_bindings_agent ON bindings(agent_id);
CREATE INDEX IF NOT EXISTS idx_bindings_status ON bindings(status);
CREATE INDEX IF NOT EXISTS idx_bindings_token ON bindings(token_hash);
```

### 4.2 与现有表的关系

```
apps (1) ──── (N) bindings (N) ──── (1) agents
                     │
                     │ 1:1 映射到 agent_key
                     │ binding.scopes 限制 agent 可访问的 API
                     ▼
              agent_actions (审计日志)
```

**关键变化：**
- `agents` 表保持不变，仍然是 Agent 在系统中的实体记录
- `bindings` 表是新增的关系表，管理 App ↔ Agent 的绑定
- 一个 Agent 可以有多条 binding（接入多个 App）
- 一个 App 可以有多条 binding（接入多个 Agent）
- 权限校验从 agent 级别细化到 binding 级别（按 scopes 过滤）

### 4.3 现有 agents 表迁移

现有 `agents` 表中的记录代表通过旧方式注册的 Agent。迁移策略：

1. **向后兼容**：旧的 `cmak_` key 继续工作，不强制迁移
2. **增量迁移**：为每个现有 agent 自动创建一条 `binding` 记录（status=active, scopes=全量）
3. **新注册统一走绑定流程**：Dashboard UI 只提供 "Bind Agent" 入口

---

## 5. API 设计

### 5.1 Binding Token 生成

```
POST /api/v2/bindings/create-token
Authorization: Bearer <JWT or App API Key>

Request:
{
  "scopes": ["perception", "action", "session"],
  "expires_in": 86400,           // 秒，默认 24h，最大 7d
  "label": "给 Jessie Agent 用"  // 可选备注
}

Response 201:
{
  "binding_id": "uuid",
  "token": "cmbt_eyJhcHA...",   // 完整 token，仅返回一次
  "scopes": ["perception", "action", "session"],
  "expires_at": "2026-03-28T03:00:00.000Z",
  "install_command": "zylos component install zylos-clawmark --token cmbt_eyJhcHA..."
}
```

### 5.2 握手

```
POST /api/v2/bindings/handshake
Content-Type: application/json

Request:
{
  "binding_token": "cmbt_eyJhcHA...",
  "agent_info": {
    "name": "Jessie",
    "type": "zylos",                    // zylos / external
    "node_url": "jessie.coco.site",     // Agent 节点 URL
    "version": "0.1.0",                 // zylos-clawmark 组件版本
    "capabilities": ["perception", "action"]
  }
}

Response 200:
{
  "binding_id": "uuid",
  "agent_id": "uuid",                  // 新创建或复用的 agent 记录
  "agent_key": "cmak_xxxxxxxxxx",      // Agent API Key，仅返回一次
  "scopes": ["perception", "action", "session"],
  "ws_endpoint": "wss://clawmark.coco.xyz/ws/agent",
  "app_info": {
    "name": "COCO Dashboard",
    "app_id": "uuid"
  }
}

Error 400: { "error": "token_expired" | "token_used" | "token_invalid" }
```

### 5.3 Binding 管理

```
GET    /api/v2/bindings              -- 列出当前 App 的所有绑定
GET    /api/v2/bindings/:id          -- 绑定详情（含连接状态）
PUT    /api/v2/bindings/:id          -- 更新绑定（修改 scopes、label）
POST   /api/v2/bindings/:id/suspend  -- 暂停绑定
POST   /api/v2/bindings/:id/resume   -- 恢复绑定
DELETE /api/v2/bindings/:id          -- 解绑（revoke，Agent 侧连接断开）
```

### 5.4 Agent 侧 API（zylos-clawmark 组件调用）

```
GET    /api/v2/bindings/me           -- 查看自己的绑定信息
                                     -- Auth: X-Agent-Key
                                     -- 返回 scopes, app_info, 连接状态

POST   /api/v2/bindings/heartbeat    -- 心跳上报
                                     -- Auth: X-Agent-Key
                                     -- Body: { "status": "healthy", "version": "0.1.0" }
```

---

## 6. zylos-clawmark 组件设计

### 6.1 定位

`zylos-clawmark` 是一个标准 Zylos 组件，类似 `zylos-lark`、`zylos-hxa-connect`。它的职责是：

- 管理 Agent 与 ClawMark Server 的持久连接
- 将 ClawMark Perception 事件转发到 C4 Communication Bridge
- 将 Agent 的 Action 指令转发到 ClawMark Server
- 处理认证、重连、心跳

### 6.2 组件结构

```
zylos-clawmark/
├── SKILL.md                    # 组件使用说明（Claude Code skill）
├── package.json
├── ecosystem.config.cjs        # PM2 常驻进程配置
├── config.json                 # 运行时配置（binding token、server URL 等）
├── src/
│   ├── bot.js                  # 主进程：WebSocket 连接 + 事件路由
│   ├── handshake.js            # 握手流程（binding token → agent_key）
│   ├── ws-client.js            # WebSocket 客户端（重连、心跳）
│   └── perception-handler.js   # Perception 事件 → C4 消息
├── scripts/
│   ├── send.js                 # C4 → ClawMark（Agent 下发 action）
│   └── install.js              # 首次安装时执行握手
└── hooks/
    └── post-install.js         # 安装后自动触发握手
```

### 6.3 安装流程

```bash
# 方式 1: 一步安装（token 作为参数）
zylos component install zylos-clawmark --token cmbt_eyJhcHA...

# 方式 2: 先安装后配置
zylos component install zylos-clawmark
# 编辑 config.json 填入 token
# 重启组件触发握手
```

安装后自动执行：
1. 解析 binding token → 提取 server URL
2. 发送 handshake 请求 → 获取 agent_key + ws_endpoint
3. 保存凭证到 config.json
4. 启动 PM2 常驻进程
5. 建立 WebSocket 连接

### 6.4 config.json 示例

```json
{
  "server_url": "https://clawmark.coco.xyz",
  "bindings": [
    {
      "binding_id": "uuid-1",
      "app_id": "uuid",
      "app_name": "COCO Dashboard",
      "agent_key": "cmak_xxxxxxxxxx",
      "scopes": ["perception", "action", "session"],
      "ws_endpoint": "wss://clawmark.coco.xyz/ws/agent",
      "status": "active"
    },
    {
      "binding_id": "uuid-2",
      "app_id": "uuid-other",
      "app_name": "Another App",
      "agent_key": "cmak_yyyyyyyyyy",
      "scopes": ["perception"],
      "ws_endpoint": "wss://other.example.com/ws/agent",
      "status": "active"
    }
  ],
  "heartbeat_interval": 30000,
  "reconnect_max_delay": 60000
}
```

支持同时绑定多个 ClawMark App（多对多的 Agent 侧体现）。

### 6.5 WebSocket 协议

```
连接: wss://{server}/ws/agent?key={cmak_key}&binding={binding_id}

Server → Agent (下行):
{
  "type": "perception",          // 事件类型
  "binding_id": "uuid",
  "payload": { ...PerceptionEvent }
}

{
  "type": "annotation",          // 用户标注
  "binding_id": "uuid",
  "payload": { text, url, user, ... }
}

Agent → Server (上行):
{
  "type": "action",              // Agent 执行操作
  "binding_id": "uuid",
  "payload": { action_type, target, params }
}

{
  "type": "heartbeat",           // 心跳
  "binding_id": "uuid",
  "payload": { status: "healthy", version: "0.1.0" }
}

Server → Agent:
{
  "type": "heartbeat_ack"
}
```

---

## 7. Dashboard UI 变更

### 7.1 Bound Agents 页面

替换现有 Dashboard 中的 Agent 列表页面：

```
┌─────────────────────────────────────────────────────┐
│  Bound Agents                        [+ Bind Agent] │
├─────────────────────────────────────────────────────┤
│                                                     │
│  🟢 Jessie (zylos)           perception, action     │
│     jessie.coco.site          Connected 2m ago      │
│     Binding: 2026-03-27       [Manage] [Unbind]     │
│                                                     │
│  🟢 Boot (zylos)             perception             │
│     boot.hxa.net              Connected 5m ago      │
│     Binding: 2026-03-27       [Manage] [Unbind]     │
│                                                     │
│  🔴 External Agent           perception, session    │
│     —                         Last seen 2h ago      │
│     Binding: 2026-03-26       [Manage] [Unbind]     │
│                                                     │
│  ⏳ Pending Invitation                               │
│     Token expires in 23h       [Copy Token] [Revoke]│
│                                                     │
└─────────────────────────────────────────────────────┘
```

### 7.2 Bind Agent 流程

1. 用户点击 "+ Bind Agent"
2. 选择权限范围（checkbox: perception, action, session, annotation, issue）
3. 生成 Binding Token + 安装指令
4. 显示 token + 一键复制按钮
5. 页面显示 "等待 Agent 握手..." 状态（轮询 binding status）
6. 握手成功 → 自动刷新列表，显示已绑定 Agent

---

## 8. 安全考虑

### 8.1 Token 安全

- Binding Token 有效期默认 24h，最长 7 天
- 一次性使用：握手成功即作废
- Server 只存储 token hash，不存明文
- Token 不含 agent_key 等敏感凭证，仅用于一次握手

### 8.2 凭证保护

- Agent Key (`cmak_`) 仅在握手响应中返回一次
- Server 端 SHA-256 哈希存储，不保存明文
- Agent 侧存储在 config.json（文件权限 0600）
- Key 泄露 → 通过 Dashboard 一键 Revoke Binding

### 8.3 权限隔离

- 每条 Binding 的 scopes 是独立的，不能越权
- Agent Key 的权限由 binding scopes 决定，不是 agent 全局权限
- 暂停/解绑操作立即生效，Agent 的 WebSocket 连接会被强制断开

### 8.4 与现有认证的兼容

- 旧的 `cmak_` key（通过 `/register` 注册的）继续工作
- 新的 binding 流程生成的 key 也是 `cmak_` 前缀，复用现有 `agentAuth` 中间件
- 区别：新 key 关联到 binding 记录，权限由 scopes 控制

---

## 9. 实现计划

### Phase 1: Server 端绑定 API（M 级）

- 新增 `bindings` 表
- 实现 token 生成 + 握手端点
- 实现 binding CRUD API
- 数据迁移：为现有 agents 创建 binding 记录
- 单元测试

### Phase 2: zylos-clawmark 组件（L 级）

- 组件脚手架（package.json, ecosystem.config.cjs, SKILL.md）
- 握手流程实现
- WebSocket 客户端（连接、重连、心跳）
- Perception 事件 → C4 路由
- Action 指令 C4 → ClawMark 转发
- 安装脚本（含 binding token 解析）

### Phase 3: Dashboard UI（M 级）

- Bound Agents 列表页
- Bind Agent 流程（token 生成 + 复制 + 等待）
- Binding 管理（查看详情、暂停、解绑）
- 连接状态实时显示（WebSocket 或轮询）

### Phase 4: WebSocket 推送（S 级）

- Server 端 WebSocket 服务（Agent 连接管理）
- Perception 事件实时推送（替代 HTTP 轮询）
- 心跳 + 连接状态追踪

### 依赖关系

```
Phase 1 (Server API) → Phase 2 (Component) + Phase 3 (Dashboard UI)
                     → Phase 4 (WebSocket) 可与 Phase 2/3 并行
```

---

## 10. 与 COCO 产品架构的对齐

根据四层餐厅模型：

| 层 | 产品 | 本设计涉及 |
|----|------|-----------|
| 煤气灶 (AgentOS/Zylos) | zylos-clawmark 组件 | ✅ Phase 2 |
| 餐厅 (Workspace) | ClawMark Dashboard | ✅ Phase 3 |
| 预制菜 (AgentStore) | — | 未来：预制 Agent 模板可内置 zylos-clawmark |

绑定机制本身是 AgentOS 层的基础设施（Agent ↔ App 的标准连接协议），ClawMark 是第一个实现者。未来其他 Workspace 工具（如 HxA Link）也可以复用相同的绑定模式。

---

## 11. 开放问题

1. **Binding Token 传递方式**：当前设计依赖用户手动复制 token 给 Agent owner。是否需要支持 Agent 主动扫描/发现 ClawMark 实例？
2. **多实例 Agent 共享 Binding**：如果一个 Agent 有多个 replica，是否共享同一个 binding + agent_key？还是每个 replica 独立绑定？
3. **权限动态调整**：绑定后能否修改 scopes？当前设计支持 PUT 更新，但 Agent 侧需要重新建立连接才能生效。
4. **外部 Agent（非 Zylos）接入**：是否提供 SDK（npm 包）给非 Zylos 平台的 Agent 用？还是只依赖 HTTP API 文档？
