# ClawMark

**网页标注工具，反馈一键分发。**

ClawMark 是一个 Chrome 扩展 + 后端服务的组合。用户可以在任意网页上选中文字、截图或高亮内容，添加批注后自动分发到 GitHub Issues、Lark、Telegram、Slack 或任意 Webhook。

[![Version](https://img.shields.io/badge/version-0.8.0-blue)](https://git.coco.xyz/hxanet/clawmark/-/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## 核心功能

- **网页标注** — 选中文字或截图，秒级创建批注或 Issue
- **智能路由** — GitHub 页面自动识别仓库；其他页面按用户规则匹配
- **多渠道分发** — GitHub Issues、GitLab Issues、Lark、Telegram、Slack、邮件、Webhook 等
- **Web 仪表盘** — 浏览批注、管理分发规则、查看活动统计
- **Google 登录** — 一键登录，JWT 认证

---

## 目录结构

```
clawmark/
├── server/                  后端服务（Express + SQLite）
│   ├── index.js             入口，加载配置、启动 HTTP 服务
│   ├── db.js                数据库初始化与迁移
│   ├── auth.js              Google OAuth + JWT 认证
│   ├── crypto.js            AES-256-GCM 凭证加密
│   ├── routing.js           URL 规则匹配 + GitHub 自动检测
│   ├── target-declaration.js  分发目标声明
│   ├── ai.js                AI 辅助功能
│   ├── adapters/            分发适配器
│   │   ├── github-issue.js  GitHub Issues
│   │   ├── gitlab-issue.js  GitLab Issues
│   │   ├── lark.js          Lark / 飞书
│   │   ├── telegram.js      Telegram
│   │   ├── slack.js         Slack
│   │   ├── email.js         邮件
│   │   ├── webhook.js       通用 Webhook
│   │   ├── hxa-connect.js   HxA Connect
│   │   ├── jira.js          Jira
│   │   ├── linear.js        Linear
│   │   └── index.js         适配器注册
│   └── config.example.json  配置文件模板
├── extension/               Chrome 扩展（Manifest V3）
│   ├── manifest.json        扩展清单
│   ├── background/          Service Worker — API 通信、消息路由
│   ├── content/             Content Script — 文字选择、浮动工具栏、截图
│   ├── sidepanel/           侧边栏 — 批注列表、讨论线程、筛选
│   ├── popup/               弹出窗口
│   ├── options/             设置页
│   └── config.js            构建时生成的环境配置（.gitignore 忽略）
├── dashboard/               Web 仪表盘（Vite SPA）
│   └── src/                 前端源码
├── scripts/                 构建与运维脚本
│   ├── build.sh             构建脚本（支持 test / production 环境）
│   ├── release.sh           发版脚本
│   └── encrypt-credentials.js  凭证加密工具
├── widget/                  嵌入式 Widget（可嵌入第三方页面）
├── docs/                    项目文档
├── test/                    测试套件（Node.js 内置 test runner）
├── config.json              服务端配置（.gitignore 忽略）
├── CHANGELOG.md             变更日志
└── CONTRIBUTING.md          贡献指南
```

---

## 快速开始

### 前置条件

- Node.js >= 18
- npm
- Chrome 浏览器（用于加载扩展）

### 本地开发

```bash
# 1. 克隆仓库
git clone https://git.coco.xyz/hxanet/clawmark.git
cd clawmark

# 2. 安装依赖
npm install
cd dashboard && npm install && cd ..

# 3. 创建配置文件
cp server/config.example.json config.json
# 编辑 config.json，至少填写 jwtSecret（见「环境变量与配置」章节）

# 4. 启动后端服务
npm start
# 服务默认监听 http://localhost:3458

# 5. 加载 Chrome 扩展
# 打开 chrome://extensions → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择 extension/ 目录

# 6. 构建仪表盘（可选）
cd dashboard && npm run build && cd ..
# 构建产物在 dashboard/dist/
```

### 运行测试

```bash
npm test    # 运行全部测试（Node.js 内置 test runner）
```

---

## 环境变量与配置

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CLAWMARK_PORT` | `3458` | 服务端口 |
| `CLAWMARK_DATA_DIR` | `./data` | 数据目录（SQLite 数据库 + 上传文件） |
| `CLAWMARK_CONFIG` | `../config.json` | 配置文件路径 |

### config.json

服务端的主要配置通过 `config.json` 管理。从模板创建：

```bash
cp server/config.example.json config.json
```

关键字段：

```jsonc
{
  "port": 3458,                    // 服务端口（也可通过 CLAWMARK_PORT 覆盖）
  "dataDir": "./data",             // 数据目录（也可通过 CLAWMARK_DATA_DIR 覆盖）
  "auth": {
    "jwtSecret": "<随机字符串>",    // JWT 签名密钥（必填，建议 64 字符 hex）
    "encryptionKey": "<32字节hex>", // 凭证加密密钥（推荐，64 字符 hex = 32 字节）
  },
  "webhook": {                     // 全局 Webhook（可选）
    "url": "",
    "events": ["item.created", "item.resolved", "item.assigned"],
    "secret": ""
  },
  "distribution": {                // 分发规则与渠道（可选）
    "rules": [...],
    "channels": {...}
  }
}
```

#### 配置项说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `auth.jwtSecret` | 是 | JWT 签名密钥。用于 API 认证，所有 V1/V2 接口均需 JWT。建议使用 `openssl rand -hex 32` 生成 |
| `auth.encryptionKey` | 推荐 | AES-256-GCM 凭证加密密钥（32 字节 hex）。用于加密存储用户的第三方凭证（GitHub Token 等）。未设置时凭证明文存储。使用 `openssl rand -hex 32` 生成 |
| `port` | 否 | 服务端口，默认 3458 |
| `dataDir` | 否 | 数据存储路径，默认 `./data` |
| `webhook` | 否 | 全局 Webhook 配置 |
| `distribution` | 否 | 服务端分发规则和渠道配置 |

---

## 部署

### 环境差异

| 项目 | 测试环境 | 生产环境 |
|------|----------|----------|
| 后端地址 | `jessie.coco.site/clawmark` | `api.coco.xyz/clawmark` |
| 仪表盘 | `jessie.coco.site/clawmark-dashboard/` | `labs.coco.xyz/clawmark/dashboard` |
| 端口 | 3459 | 3458 |
| 数据目录 | `./data-staging` | `./data` |
| 配置文件 | `config.staging.json` | `config.json` |
| PM2 进程名 | `clawmark-staging` | `clawmark-server` |

### 部署步骤

```bash
# 构建扩展 + 仪表盘（test 或 production）
./scripts/build.sh production

# 启动/重启后端
pm2 start server/index.js --name clawmark-server
# 或
pm2 restart clawmark-server
```

### 扩展分发

构建脚本会生成 `clawmark-v{版本号}-{环境}.zip`，用于：
- Chrome Web Store 上传
- GitLab Release 附件下载
- 开发者模式侧加载

---

## API 简要说明

### 认证方式

v0.8.0 起，所有 API 接口均需 JWT 认证（包括原先无需认证的 V1 接口）。

认证流程：
1. 用户通过 Google OAuth 登录，获取 JWT
2. 请求时携带 `Authorization: Bearer <jwt_token>`
3. 扩展端也支持 API Key 认证：`Authorization: Bearer cmk_...`

### 主要接口

基础路径：`/api/v2`

| 接口 | 方法 | 说明 |
|------|------|------|
| `/auth/google` | POST | Google OAuth 登录，返回 JWT |
| `/items` | GET | 查询批注列表（支持 url/tag/status 筛选） |
| `/items` | POST | 创建批注 |
| `/items/:id` | GET | 获取批注详情 + 讨论线程 |
| `/items/:id/messages` | POST | 添加评论 |
| `/items/:id/resolve` | POST | 标记已解决 |
| `/items/:id/close` | POST | 关闭 |
| `/items/:id/tags` | POST | 添加/移除标签 |
| `/routing/rules` | GET/POST | 查询/创建路由规则 |
| `/routing/rules/:id` | PUT/DELETE | 更新/删除路由规则 |
| `/routing/resolve` | POST | 测试路由匹配（dry run） |
| `/urls` | GET | 查询已标注的 URL 列表 |
| `/adapters` | GET | 查询已启用的分发渠道 |
| `/credentials` | GET/POST/DELETE | 管理用户凭证 |
| `/dispatch-log` | GET | 查询分发日志 |

完整参考：[docs/api-reference.md](docs/api-reference.md)

---

## 路由规则

批注创建后，ClawMark 按以下优先级决定分发目标：

| 优先级 | 规则 | 示例 |
|--------|------|------|
| 1 | **用户 URL 规则** — 正则/通配符匹配 | `medium.com/**` → `my/reading-notes` |
| 2 | **GitHub 自动检测** — 从 URL 提取仓库 | `github.com/coco-xyz/clawmark` → `coco-xyz/clawmark` |
| 3 | **用户默认** — 个人兜底目标 | 其余 → `my/inbox` |
| 4 | **系统默认** — config.json 兜底 | → 配置中的默认仓库 |

---

## 分发适配器

支持以下分发渠道，通过 `config.json` 的 `distribution.channels` 配置，或用户在仪表盘中添加凭证后使用：

| 适配器 | 说明 |
|--------|------|
| `github-issue` | GitHub Issues（支持生命周期同步：创建/关闭/重开） |
| `gitlab-issue` | GitLab Issues |
| `lark` | Lark / 飞书 Webhook |
| `telegram` | Telegram Bot |
| `slack` | Slack Webhook |
| `email` | 邮件 |
| `webhook` | 通用 Webhook（支持 HMAC-SHA256 签名） |
| `hxa-connect` | HxA Connect 消息总线 |
| `jira` | Jira |
| `linear` | Linear |

详细配置参考：[docs/adapters.md](docs/adapters.md)

---

## 相关链接

- **发布页**: [git.coco.xyz/hxanet/clawmark/-/releases](https://git.coco.xyz/hxanet/clawmark/-/releases)
- **Issue 跟踪**: [git.coco.xyz/hxanet/clawmark/-/issues](https://git.coco.xyz/hxanet/clawmark/-/issues)
- **产品页**: [labs.coco.xyz/clawmark](https://labs.coco.xyz/clawmark/)
- **隐私政策**: [labs.coco.xyz/clawmark/privacy](https://labs.coco.xyz/clawmark/privacy/)
- **GitHub 镜像**: [github.com/coco-xyz/clawmark](https://github.com/coco-xyz/clawmark)

---

## 许可证

[MIT](LICENSE)
