# ClawMark V2 架构设计

> 浏览器插件 + 开源收集器 + 多渠道分发

## 概述

ClawMark V2 从嵌入式组件进化为**消息管道**，分三层：

```
┌─────────────┐     ┌─────────────────┐     ┌──────────────────┐
│    产生      │────▶│      收集        │────▶│      分发         │
│  (浏览器插件) │     │  (ClawMark       │     │  (渠道 Adapter)   │
│             │     │   Server)        │     │                  │
└─────────────┘     └─────────────────┘     └──────────────────┘
  Chrome Web Store    clawmark.coco.xyz       Lark / TG / GitHub
                      或自建部署               / Slack / 邮件 ...
```

**核心原则：** 插件只负责生产结构化消息。服务端负责收集和存储。分发由可插拔的 adapter 完成。

## 第一层：产生（浏览器插件）

### 功能

- 在任意网页上注入轻量 UI 覆盖层
- 用户选中文本 → 弹出浮动工具栏 → 评论 / 提 issue / 打标签
- 自动采集上下文：页面 URL、选中文本、DOM 位置、截图
- 将结构化消息发送到配置的 ClawMark 服务端

### Chrome 插件结构（Manifest V3）

```
extension/
├── manifest.json          # Manifest V3，权限：activeTab, storage, contextMenus
├── background/
│   └── service-worker.js  # 管理登录态，向服务端发 API 请求
├── content/
│   ├── inject.js          # Content script — 检测文本选择，渲染浮层
│   └── inject.css         # 浮动工具栏 + 侧边栏样式
├── sidepanel/
│   ├── panel.html         # 侧边栏 UI — issue 列表、评论线程、设置
│   └── panel.js
├── popup/
│   ├── popup.html         # 快捷操作 + 登录
│   └── popup.js
└── icons/                 # 插件图标 (16/32/48/128)
```

### 用户流程

**流程 1：快速评论**
1. 用户在任意网页选中文本
2. 弹出浮动工具栏：💬 评论 | 🐛 Issue | 🏷️ 标签
3. 点"评论" → 展开输入框
4. 提交 → 消息发到服务端 `{ type: "comment", url, quote, position, content, user }`

**流程 2：创建 Issue**
1. 选中文本或点击插件图标 → 侧边栏打开
2. 填写：标题、优先级、描述、可选截图
3. 提交 → `{ type: "issue", url, title, priority, content, screenshots[], user }`

**流程 3：浏览与回复**
1. 点击插件图标 → 侧边栏展示当前 URL 的所有条目
2. 查看线程、回复评论、变更 issue 状态
3. 如果开启高亮持久化，之前评论过的文本会被高亮

### 消息 Schema（插件 → 服务端）

```typescript
interface ClawMarkMessage {
  // 标识
  type: "comment" | "issue" | "tag";
  app_id: string;              // 项目/工作区 ID

  // 上下文
  source_url: string;          // 完整页面 URL
  source_title: string;        // 页面标题
  quote?: string;              // 选中文本
  quote_position?: {           // 用于重新高亮
    xpath: string;
    startOffset: number;
    endOffset: number;
  };
  screenshots?: string[];      // base64 或已上传的 URL

  // 内容
  title?: string;              // issue 必填
  content: string;             // 用户的消息
  priority?: "low" | "normal" | "high" | "critical";
  tags?: string[];

  // 用户
  user: string;                // 已认证的用户 ID
  created_at: string;          // ISO 8601
}
```

## 第二层：收集（ClawMark Server）

### 功能

- 接收来自插件（及任何其他客户端）的消息
- 存储到 SQLite（现有 schema 扩展）
- 提供 REST API 进行增删改查
- 管理认证（邀请码 → 后续扩展 OAuth）
- 继续托管 widget JS（嵌入模式仍可用，向后兼容）

### 从 V1 的演进

现有服务端已覆盖大部分能力。主要变更：

| 方面 | V1（现状） | V2 |
|------|-----------|-----|
| 客户端 | 嵌入式 widget | 浏览器插件 + widget |
| 数据模型 | `doc` = 文档路径 | `doc` = 任意 URL 或文档 ID |
| 认证 | 仅邀请码 | 邀请码 + API Key + OAuth（后续） |
| 多租户 | 路径中的 `app_id` | 同上，增加团队/工作区概念 |
| 分发 | 单个 webhook URL | 多 adapter + 路由规则 |

### 数据库变更

`items` 表新增字段：

```sql
ALTER TABLE items ADD COLUMN source_url   TEXT;    -- 创建条目的页面 URL
ALTER TABLE items ADD COLUMN source_title TEXT;    -- 页面标题
ALTER TABLE items ADD COLUMN tags         TEXT DEFAULT '[]';  -- JSON 标签数组
ALTER TABLE items ADD COLUMN screenshots  TEXT DEFAULT '[]';  -- JSON 截图 URL 数组
```

### 新增 API 端点

```
POST   /api/v2/items              # 创建条目（接收完整 ClawMarkMessage）
GET    /api/v2/items?url=...      # 按来源 URL 查询
GET    /api/v2/items?tag=...      # 按标签查询
POST   /api/v2/items/:id/tags     # 添加/移除标签
GET    /api/v2/urls               # 列出某个 app 下所有标注过的 URL
POST   /api/v2/auth/apikey        # 为插件签发 API Key
```

现有 V2 端点（`/items`、`/items/:id/messages` 等）保持不变，向后兼容。

### 部署方式

- **官方托管**：`clawmark.coco.xyz` — COCO 运营
- **自建部署**：`npm install && npm start` — 任何人都能跑自己的实例
- 插件设置：服务端地址默认 `clawmark.coco.xyz`，用户可切换到自建地址

## 第三层：分发（渠道 Adapter）

### 功能

- 在条目事件触发时（创建、解决、分配等），将通知路由到外部渠道
- 每个渠道 = 一个 adapter 模块
- 路由规则决定哪些事件发到哪里

### Adapter 架构

```
server/adapters/
├── index.js           # Adapter 注册 + 路由引擎
├── webhook.js         # 通用 webhook（升级现有）
├── lark.js            # Lark 群消息 / 机器人消息
├── telegram.js        # Telegram bot 消息
├── github-issue.js    # 创建/同步 GitHub Issue
├── slack.js           # Slack webhook / bot
└── email.js           # 邮件通知
```

每个 adapter 实现：

```javascript
class Adapter {
  constructor(config) { }

  /** 格式化并发送指定事件的通知 */
  async send(event, item, context) { }

  /** 校验 adapter 配置（启动时调用） */
  validate() { return { ok: true }; }
}
```

### 路由规则（config.json）

```json
{
  "distribution": {
    "rules": [
      {
        "match": { "event": "item.created", "type": "issue", "priority": ["high", "critical"] },
        "channels": ["lark-dev", "telegram-alerts"]
      },
      {
        "match": { "event": "item.created", "type": "comment" },
        "channels": ["lark-feedback"]
      },
      {
        "match": { "event": "item.resolved" },
        "channels": ["webhook-default"]
      }
    ],
    "channels": {
      "lark-dev": {
        "adapter": "lark",
        "webhook_url": "https://open.larksuite.com/open-apis/bot/v2/hook/xxx",
        "template": "issue"
      },
      "telegram-alerts": {
        "adapter": "telegram",
        "bot_token": "...",
        "chat_id": "-100xxx"
      },
      "lark-feedback": {
        "adapter": "lark",
        "webhook_url": "https://open.larksuite.com/open-apis/bot/v2/hook/yyy",
        "template": "comment"
      },
      "webhook-default": {
        "adapter": "webhook",
        "url": "https://your-service/webhook"
      }
    }
  }
}
```

### 消息模板

每个 adapter 支持模板格式化：

```
[ClawMark] 新 issue：{{title}}
优先级：{{priority}} | 提交人：{{user}}
来源：{{source_url}}
---
{{content}}
```

## 落地计划

### Phase 1：服务端升级（第 1-2 周）
- 给 `items` 表加 `source_url`、`source_title`、`tags`、`screenshots` 字段
- 新增 `/api/v2/` 端点
- 搭建 adapter 注册框架 + 路由引擎
- 实现 webhook adapter（升级现有）+ Lark adapter
- **负责人：Lucy**

### Phase 2：浏览器插件 MVP（第 2-4 周）
- Manifest V3 脚手架
- Content script：文本选择 → 浮动工具栏
- Side panel：条目列表、评论线程
- Background service worker：认证、API 调用
- 对接 ClawMark Server API
- **负责人：Lucy（前端）+ Jessie（review）**

### Phase 3：分发 Adapter（第 3-4 周）
- Telegram adapter
- GitHub Issue adapter
- 路由规则引擎测试
- 管理端配置 UI
- **负责人：Boot**

### Phase 4：打磨与发布（第 4-5 周）
- Chrome Web Store 上架
- clawmark.coco.xyz 部署
- 文档站
- 现有 widget 向后兼容验证
- **负责人：全团队**

## 待确认问题

1. **认证演进** — 邀请码够 MVP 用。什么时候加 OAuth / SSO？
2. **高亮持久化** — 存 DOM 位置本身很脆弱（页面变了就失效）。接受这个限制，还是投入做稳健锚定（如文本指纹）？
3. **实时同步** — 插件轮询服务端，还是加 WebSocket / SSE 做实时推送？
4. **离线支持** — 离线时本地排队，上线后同步？
5. **Firefox / Safari** — 先做 Chrome，Manifest V3 本身跨浏览器兼容。其他浏览器排什么时候？

## 与 HxA 生态的关系

- **ClawMark Server** = 独立 HxA 组件（开源，可独立部署）
- **分发层**可选择使用 **HxA Connect** 做渠道路由，也可以用内置 adapter
- **COCO Dashboard** 集成：ClawMark 条目接入 dashboard 的 issue 跟踪
- 插件是 HxA 消息总线架构中的一个**生产者**
