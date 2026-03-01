# ClawMark 产品路线图

最后更新：2026-03-01

## 当前版本：v0.5.0 ✅

**发布日期：2026-03-01** — AI 智能路由 + 完整认证 + 目标声明协议

- **AI 智能路由**（Gemini）：无规则或声明时，AI 分析内容推荐最佳路由目标
- **路由推荐 API**：`/api/v2/routing/recommend` — AI 分析标注上下文，返回推荐目标+置信度+建议规则
- **Google OAuth 登录**：完整的 OAuth 2.0 流程，JWT 认证，扩展+服务器共享登录态
- **目标声明协议**：`.clawmark.yml` / `/.well-known/clawmark.json` — 项目主动声明路由偏好
- **5 级优先级解析**：目标声明 > 用户规则 > GitHub URL 自动 > 用户默认 > 系统默认
- **扩展 JS 注入控制**：全局+按站点 toggle，目标声明可关闭注入
- **截图标注**：选区截图 + 上传 + 附加到标注
- **测试覆盖**：377 个测试
- **Chrome Web Store**：已提交（等待 Google 审核 + v0.5.0 zip 重新提交）
- **环境**：
  - 测试环境：https://jessie.coco.site/clawmark（v0.5.0）
  - 生产环境：https://api.coco.xyz/clawmark（v0.5.0 待推送，Kevin 确认后部署）

### 进行中 (v0.5.x)

- **PR #106 — 扩展内投递设置面板**（Boot review 中）
  - popup 新增「Delivery Settings」可折叠区块
  - 查看/添加/编辑/删除 URL 路由规则
  - 支持 4 种目标类型 + 4 种规则类型
  - 动态表单根据目标类型切换

### 已知问题

- **#100** OAuth redirect_uri_mismatch：Kevin 需在 GCP Console 添加新 ext ID 的 redirect URI ✅ 已修
- **#101** 默认服务器 URL 错误：PR #103 MERGED ✅
- **#102** Web Store 提交了旧版本：Kevin 需用 v0.5.0 zip 重新提交
- **#105** Auth token 丢失：JWT_SECRET + CLIENT_SECRET 已配置 ✅

## 下一步：v0.6.0 — 多渠道分发增强 🔜

**目标**：从 GitHub Issues 扩展到丰富的分发目标生态。
**优先级**：Kevin 指示团队开始

**P0 — 核心框架：**
- [#93] **多目标分发框架**：一条标注 → 同时发送到多个 adapter，分发状态追踪，失败重试
- **扩展内投递设置面板** ← PR #106，v0.5.x 先行交付

**P1 — 新 Adapter：**
- [#94] **Telegram**（bot 消息到群组/频道）+ **Slack**（channel）+ **Email**（摘要/逐条）
- [#95] **通用 Webhook**（POST 到任意 URL）+ **Linear** + **Jira** + **HxA Connect**

**P2 — 增强：**
- Adapter 市场（社区贡献 adapter，与 hxa-teams 模板系统打通）
- 分发状态仪表板

**团队安排：**
- Jessie：#93 多目标分发框架（核心架构）
- Boot：PR #106 review + 功能测试 + #94 Telegram adapter
- Lucy：#94 Slack/Email adapter + #95 Webhook adapter（GitHub 恢复后）

## v0.7.0 — 组织/团队管理

**目标**：建立组织/团队体系，支持团队协作标注。

- **组织管理**：创建组织，邀请成员
- **团队 App**：组织级 App 和 AppKey，共享路由规则
- **角色权限**：基于角色的访问控制（Owner / Admin / Member）
- **应用管理增强**：应用仪表板，使用量统计

## v1.0.0 — 正式发布

**目标**：生产就绪，实时同步、多浏览器支持。

- **实时推送**：WebSocket 连接，实时标注更新（替代轮询）
- **多浏览器**：Firefox、Edge、Safari 扩展
- **完整 API 文档 + SDK**：TypeScript/JavaScript SDK
- **限流与防滥用**：生产级安全
- **分析仪表板**：标注量、路由统计、adapter 使用情况

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
| v0.5.0 | 2026-03-01 | AI 智能路由、Google OAuth、目标声明协议、377 个测试 |
| v0.4.0 | 2026-03-01 | 目标声明协议、扩展 JS 注入控制、截图标注 |
| v0.3.0 | 2026-02-28 | 路由 Phase 1、用户规则 CRUD、117 个测试 |
| v0.2.0 | 2026-02-27 | V2 架构、Chrome 扩展 MVP、adapter 框架 |
| v0.1.0 | 2026-02-26 | 初始发布、基础标注 CRUD |
