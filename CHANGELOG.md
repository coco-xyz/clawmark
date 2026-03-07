# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号采用 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.8.0] — 2026-03-06

### 重大变更（Breaking Changes）

- **所有 API 端点强制 JWT 认证** — V1 和 V2 接口均需 JWT token，不再支持匿名访问
- **移除邀请码认证** — `auth.codes` 配置项废弃，Phase 1 数据隔离完成
- **新增必填配置 `auth.jwtSecret`** — 生产环境未配置将拒绝启动

### 新增

- **凭证加密（AES-256-GCM）** — 第三方凭证（GitHub Token 等）加密存储，通过 `auth.encryptionKey` 配置
- **安全审计修复** — 3 Critical + 3 High 漏洞全部修复（XSS 转义、SSRF 防护、安全头、rate limiting 等）
- **Dashboard 刷新修复** — 修复 dashboard SPA 刷新后白屏问题
- **dispatch_log 迁移修复** — 一次性迁移替代每次重启执行的 Phase 1 cleanup
- **扩展双版本 zip** — test 和 production 环境独立打包

### 安全

- helmet 安全头
- express-rate-limit 全局限流
- multer 文件上传安全
- SSRF webhook 防护
- XSS 转义加固

### 测试

- 515 个测试全部通过

## [0.7.0] — 2026-03-05

### 新增

- **Google OAuth 登录** — Chrome 扩展和 Dashboard 均支持 Google 一键登录
- **JWT 认证体系** — 替代旧邀请码认证，所有端点 JWT 保护
- **用户凭证管理** — Dashboard Auth 面板管理 9 种第三方凭证（GitHub、GitLab、Lark、Telegram、Slack 等）
- **分发日志** — `dispatch_log` 记录每次分发结果，Dashboard 可查

### 修复

- GitLab Issue adapter 修复
- 路由规则 ownership 校验

## [0.6.4] — 2026-03-05

### 新增

- 数据隔离 Phase 1 — 每用户独立 app_id，不再共享 default (#188)
- 数据隔离 Phase 2 — PUT/DELETE 路由规则 ownership check，POST /apikey app_id 归属校验 (#188)
- V1 路由全部标记 Deprecated + Sunset 2026-06-01 (#188)
- 版本检查 + 更新横幅 — popup 显示最新版本提示 (#2)
- Dashboard Overview 全局统计 + 可点击钻取 (#7)

### 修复

- dispatch 权限 403 优雅降级 — labels 改为 best-effort 单独调用 (#189)
- URL hash 持久化 — 刷新保持当前 tab (#9)
- version check review feedback 修正

### 文档

- 数据隔离 + 交付授权技术设计文档
- 技术设计中文翻译

### 其他

- 发版流程 — release.sh 脚本 + MR/issue 模板

## [0.6.2] — 2026-03-04

### 新增

- About 面板 — 项目卡片 + GitHub API 拉取最新版本 + 橙色徽章（#165, #166）
- 配置面板重组 + 全局统计数据展示（#167, #170, #177）

### 修复

- 阻止 Google OAuth 在页面刷新时重复触发
- Adapter 页脚添加品牌链接（#171, #172）
- Fallback 投递提示 + 管理链接跳转到正确标签页（#173, #174, #175）

### 文档

- 重构 README — 介绍、托管 vs 自部署、链接更新（#168, #169）

## [0.6.1] — 2026-03-04

### 新增

- Phase 1 — Dashboard + Popup 全新设计（#150, #158）
- Phase 1.5 — 标注窗口覆盖层优化（#150）
- Phase 2 — 欢迎页 + 徽章计数
- Phase 3 打磨 — 错误 UX、加载进度条、快捷键提示、站点模式切换
- 投递地址 fallback + 可见分发目标（#147）

### 修复

- 事件监听器清理 + 自定义标签双重提交 + 尺寸上限
- 工具栏定位及文字标注输入问题（#143, #144）
- 解决 review 反馈 — P1/P2/P3 问题修复

### 文档

- ClawMark UX 大改版 PRD（#150）+ 多次更新

## [0.6.0] — 2026-03-02

### 新增

- 多目标分发框架（#93, #108）
- Slack 和 Email adapters（#94, #107）
- Linear、Jira、HxA Connect adapters（#95, #110）
- 智能分发预览 + 状态展示（#115, #129）
- 截图模式可拖拽标注层模型（#111, #131）
- 截图 AI 视觉分析（#117, #137）
- 扩展 popup 投递设置面板

### 修复

- 转义分发目标标签中的 HTML 以防止 XSS（#115, #130）
- 优先使用认证身份而非 body userName，修复规则可见性 bug（#116, #128）
- 默认服务器 URL 设为 api.coco.xyz/clawmark

## [0.3.5] — 2026-03-01

### 新增

- Google OAuth 登录 + JWT 认证（#64）
- 扩展添加 Google OAuth 登录（#67）
- 应用管理 — 自助 App + AppKey 创建（#65）
- 端点管理 UI 和 API（#66）
- 组织/团队管理 + RBAC 权限体系（#68）
- 截图标注 + 图片粘贴（#69, #70）

### 修复

- Google OAuth 安全加固 + /auth/google 测试
- 路由规则 PUT 响应中 target_config 解析修复
- 修复 v0.3.0 路由及认证关键 bug
- org_id 索引创建顺序修正

### 其他

- 设置 Google OAuth Client ID
- 产品路线图文档

## [0.5.0] — 2026-03-01

### 新增

- AI 路由推荐（#89）
  - `POST /api/v2/routing/recommend` — 当无规则/声明匹配时，Gemini 分析标注上下文推荐路由目标
  - 返回分类（bug/feature/question/praise/general）、目标、置信度、推理过程
  - 可选自动创建路由规则建议
  - 零新 npm 依赖 — 使用 Node 原生 `https` 调用 Gemini API
- 标注自动分类（#90）
  - 创建标注时自动分类：bug, feature_request, question, praise, general
  - 异步执行，不阻塞创建响应
  - `POST /api/v2/items/:id/classify` — 手动分类/纠正
  - `GET /api/v2/items/by-classification/:classification` — 按分类筛选
  - 数据库自动迁移：`classification`, `classification_confidence`, `classified_at` 字段
- 智能标签生成（#91）
  - `POST /api/v2/items/:id/generate-tags` — AI 生成 2-5 个相关标签
  - 标签规范化：小写、去特殊字符、与已有标签去重
  - 合并模式：默认追加，`merge: false` 替换
- 聚合分析与趋势（#92）
  - `GET /api/v2/analytics/summary` — 仪表板概览（总量、状态/类型/分类分布、Top URL/标签、7 日活跃）
  - `GET /api/v2/analytics/trends` — 时间序列趋势（day/week/month 周期，可按 classification/type/status 分组）
  - `GET /api/v2/analytics/hot-topics` — 热点检测（时间窗口 + 阈值）
  - `GET /api/v2/analytics/clusters` — AI 聚类（Gemini 驱动，含集群验证）
  - 前三个端点纯 SQL 聚合（无 AI 成本），仅 clusters 调用 Gemini

### 安全

- AI 端点专用限流器 `aiLimiter`（15 次/分钟）
- 所有用户输入使用 `<USER_INPUT>` 分隔符防 prompt injection
- 输入长度限制 + 标签单条截断（50 字符）
- AI 响应校验：类型检查、置信度范围、集群结构验证
- 错误详情仅服务端日志，不泄露给客户端

### 测试

- 377 个测试（新增 81 个：AI 推荐 20 + 分类 10 + 标签 10 + 分析 33 + review fixes 8）

## [0.4.0] — 2026-03-01

### 新增

- 目标声明发现系统（#84）
  - `.clawmark.yml`（GitHub repo root）和 `/.well-known/clawmark.json`（任意网站）
  - 声明验证：adapter 类型、target 格式、webhook endpoint 安全检查
  - 24 小时缓存 + LRU 淘汰（上限 1000 条）
- 5 级路由优先链（#85）
  - 声明 > 用户规则 > GitHub 自动检测 > 用户默认 > 系统默认
- JS 注入开关（#86）
  - 全局开关：扩展 popup 中一键启用/禁用
  - 站点级控制：按 hostname 启用/禁用（上限 100 站点）
  - 目标声明覆盖：`js_injection: false` 禁止在目标站点注入
  - 优先级：目标声明 > 用户站点设置 > 用户全局设置
  - 无刷新动态切换（storage.onChanged + generation counter 防竞态）
  - inject.js 重构：条件初始化、DOM 清理、事件监听器卸载

### 安全

- SSRF 完整防护：DNS 预检 + isPrivateIP + HTTPS only + redirect 深度限制（max 3）
- webhook endpoint 验证：HTTPS only + localhost/private IP 黑名单
- YAML 解析安全：FAILSAFE_SCHEMA（只允许 string/sequence/mapping）
- Object.assign → 显式 safe fields 白名单（防 prototype pollution）
- 响应大小限制（64KB）

### 测试

- 296 个测试（新增 51 个：声明验证、SSRF 防护、缓存行为、js_injection 字段、路由集成）

## [0.3.0] — 2026-03-01

### 新增

- 去中心化路由系统 Phase 1（#38）
  - URL pattern 匹配引擎：glob 风格通配符（`*`, `**`）
  - GitHub URL 自动检测：从 source_url 提取 org/repo，自动路由到对应仓库
  - 用户路由规则：每个用户可配置 URL → 目标的映射规则
  - 路由解析优先级：用户规则 > GitHub 自动检测 > 用户默认 > 系统默认
  - 动态 adapter 分发：按路由结果即时创建 adapter 实例
  - 路由规则 CRUD API：`/api/v2/routing/rules`
  - 路由测试端点：`POST /api/v2/routing/resolve`（dry run）
  - user_rules 数据库表 + 完整索引
  - 24 个路由测试（extractGitHubRepo、matchUrlPattern、resolveTarget）

## [0.2.0] — 2026-02-28

### 新增

- 网页文字选中 → 浮动工具栏 → 创建 Comment / Issue 核心交互
- 侧边栏面板：标注列表、评论线程、标签筛选
- GitHub Issue 集成：自动创建 issue 并同步状态
- 多 adapter 分发架构：GitHub Issue、Lark、Telegram、Webhook
- 邀请码认证 + API Key 认证（多租户 app_id）
- Chrome 右键菜单快捷标注
- 键盘快捷键（⌘↵ 提交、Esc 关闭）
- Widget V2：来源归属、标签、截图支持
- API 限流 + 侧边栏防抖 / 缓存
- GitHub Issue adapter 映射持久化（SQLite）
- 浏览器插件 Manifest V3
- Docker 部署方案
- V2 API 参考文档、Chrome 扩展指南、adapter 指南、部署指南

### 修复

- 插件 popup 添加邀请码输入框 (#34)
- 侧边栏提交后自动刷新 (#39)
- adapter dispatch 传递完整 item 数据 (#32)
- 扩展图标生成（16/32/48/128px）(#24)

## [0.1.0] — 2026-01-17

### 新增

- 初始版本：基础标注收集服务
- 上传扩展白名单
- `/verify` 接口限流
- JSON body 大小限制（512KB）
- 不存在 item 的状态操作返回 404

[0.8.0]: https://git.coco.xyz/hxanet/clawmark/-/releases/v0.8.0
[0.7.0]: https://github.com/coco-xyz/clawmark/releases/tag/v0.7.0
[0.6.4]: https://github.com/coco-xyz/clawmark/releases/tag/v0.6.4
[0.6.2]: https://github.com/coco-xyz/clawmark/releases/tag/v0.6.2
[0.6.1]: https://github.com/coco-xyz/clawmark/releases/tag/v0.6.1
[0.6.0]: https://github.com/coco-xyz/clawmark/releases/tag/v0.6.0
[0.5.0]: https://github.com/coco-xyz/clawmark/releases/tag/v0.5.0
[0.4.0]: https://github.com/coco-xyz/clawmark/releases/tag/v0.4.0
[0.3.5]: https://github.com/coco-xyz/clawmark/releases/tag/v0.3.5
[0.3.0]: https://github.com/coco-xyz/clawmark/releases/tag/v0.3.0
[0.2.0]: https://github.com/coco-xyz/clawmark/releases/tag/v0.2.0
[0.1.0]: https://github.com/coco-xyz/clawmark/commits/0c02d6b
