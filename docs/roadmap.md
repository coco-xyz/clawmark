# ClawMark 产品路线图

最后更新：2026-03-01

## 当前版本：v0.3.0 ✅

**发布日期：2026-02-28** — 去中心化路由系统

- **路由 Phase 1**：4 级优先级解析
  1. 用户自定义规则（URL glob pattern）
  2. GitHub URL 自动识别（从 github.com URL 提取 repo）
  3. 用户默认 adapter
  4. 系统默认 adapter
- **用户规则 CRUD API**：`/api/v2/routing/rules` — 创建、查询、更新、删除自定义路由规则
- **Dry run**：`/api/v2/routing/resolve` — 测试路由解析，不实际创建标注
- **动态 adapter 派发**：标注根据来源 URL 自动路由到正确的 adapter
- **测试覆盖**：62 个测试（24 路由 + 38 数据库/API）
- **Chrome Web Store**：扩展已提交，等待 Google 审核
- **环境**：
  - 测试环境：https://jessie.coco.site/clawmark（v0.3.0）
  - 生产环境：https://api.coco.xyz/clawmark（待更新）

## 下一步：v0.3.5 — 用户体验基础

**目标**：让用户能登录、管理自己的投递端点，标注端体验升级。

- **用户认证**：Google OAuth 登录/注册（替代邀请码的纯人工模式）
- **投递端点管理**：用户登录后可管理自己的投递 endpoint，设置默认 endpoint
- **扩展登录态**：Chrome 扩展和标注页面共享登录状态
- **截图标注**：支持选区截图并在图上标注
- **贴图支持**：标注时直接粘贴图片

## v0.4.0 — 目标声明协议

**目标**：让项目主动声明路由偏好，标注自动路由，用户无需手动配置规则。

- **`.clawmark.yml`**（repo 根目录）— GitHub 项目声明 ClawMark 配置：
  ```yaml
  # .clawmark.yml
  adapter: github-issues
  target: coco-xyz/clawmark
  labels: ["feedback", "clawmark"]
  ```
- **`/.well-known/clawmark.json`**（网站）— 任意网站声明 ClawMark 端点：
  ```json
  {
    "adapter": "webhook",
    "endpoint": "https://api.example.com/feedback",
    "types": ["issue", "comment"]
  }
  ```
- **优先级升级为 5 级**：目标声明 > 用户规则 > GitHub URL 自动 > 用户默认 > 系统默认
- **自动发现**：扩展在用户访问页面时自动检查 `.clawmark.yml` / `/.well-known/clawmark.json`

## v0.5.0 — AI 智能路由与分析

**目标**：用 AI 智能分类、路由和分析标注。

- **智能路由**：无明确规则或声明时，AI 分析页面内容和标注上下文，推荐最佳路由目标
- **标注分类**：自动识别类型（bug、功能需求、问题、表扬等）
- **智能标签**：基于内容分析自动生成标签
- **聚合分析**：跨页面/repo 聚类相关标注，发现趋势
- **路由置信度**：显示路由决策的置信度，允许用户覆盖

## v0.6.0 — 多渠道分发增强

**目标**：从 GitHub Issues 扩展到丰富的分发目标生态。

- **新增 Adapter**：
  - Telegram（bot 消息到群组/频道）
  - Slack（发送到 channel）
  - Email（摘要或逐条）
  - 通用 Webhook（POST 到任意 URL）
  - Linear / Jira（issue tracker 集成）
- **多目标分发**：一条标注 → 同时发送到多个 adapter
- **分发状态追踪**：查看哪些 adapter 收到了标注，失败时重试
- **Adapter 市场**：社区贡献的 adapter（与 hxa-teams 模板系统打通）

## v1.0.0 — 正式发布

**目标**：生产就绪，完整认证、实时同步、多浏览器支持。

- **完整 OAuth**：在 v0.3.5 Google OAuth 基础上扩展 GitHub OAuth，完善权限体系
- **实时推送**：WebSocket 连接，实时标注更新（替代轮询）
- **多浏览器**：Firefox、Edge、Safari 扩展
- **完整 API 文档 + SDK**：TypeScript/JavaScript SDK
- **限流与防滥用**：生产级安全
- **分析仪表板**：标注量、路由统计、adapter 使用情况
- **团队管理**：组织级设置、共享路由规则、基于角色的访问控制

## v1.0 之后

探索中的想法（未承诺）：

- **标注对话**：在标注上回复
- **高亮持久化**：保存高亮文本位置，再次访问时恢复
- **浏览器间同步**：实时协作标注
- **可嵌入组件 v2**：增强的网站嵌入体验
- **移动端支持**：移动浏览器查看标注
- **私有部署**：自托管 ClawMark 服务器

## 版本历史

| 版本 | 日期 | 重点 |
|------|------|------|
| v0.3.0 | 2026-02-28 | 路由 Phase 1、62 个测试、Chrome Web Store 提交 |
| v0.2.0 | 2026-02-27 | V2 架构、Chrome 扩展 MVP、adapter 框架 |
| v0.1.0 | 2026-02-26 | 初始发布、基础标注 CRUD |
