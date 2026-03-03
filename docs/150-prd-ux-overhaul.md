# PRD: ClawMark UX 专项优化

**Issue:** #150
**Author:** Jessie
**Date:** 2026-03-04
**Status:** Draft v2 — 已整合 Kevin review 反馈（#152-#157）

---

## 背景

ClawMark 作为 Chrome 标注插件，核心功能（标注、截图、分发）已经跑通。但当前 UX 存在三个结构性问题：

1. **不够傻瓜化** — 首次使用需要手动填 Server URL、Username，高级配置（routing rules）暴露在 popup 里，新用户面对一堆输入框会懵
2. **没有独立配置面板** — 所有配置塞在 300px 的 popup 里，delivery rules 的增删改查挤在小窗口中操作痛苦
3. **popup 内容跟当前页面无关** — 点击插件图标弹出的是全局配置，而不是当前页面的标注或常用操作

Kevin 的原话：「点击插件之后出现的东西，只应该是跟当前页面有关 or 用户最常用的东西。」

## 目标

把 ClawMark 从「开发者工具」变成「任何人都能用的标注工具」。

## 当前状态

### Popup（点击插件图标）

当前 popup 内容（从上到下）：
- ClawMark 标题 + 版本号
- 连接状态指示灯
- 登录/登出区域
- Server URL 输入框
- Username 输入框
- Save 按钮 + Open Side Panel 按钮
- 当前网站的注入开关（Enable/Disable）
- Delivery Settings（可折叠）— 完整的 routing rules CRUD

**问题**：popup 试图同时承担「快捷操作」和「完整配置」两个角色，结果两个都做不好。

### Side Panel（侧边栏）

当前侧边栏内容：
- 当前页面的标注列表（All / Comments / Issues 标签页）
- 点击标注可查看 thread + 回复

**问题**：侧边栏功能正常，但只能从 popup 按钮或工具栏打开，没有快捷入口。

### 配置

所有配置都在 popup 里：Server URL、auth、delivery rules。没有独立的 options page。

## 方案

### 原则

- **Popup = 当前页面的快捷面板**，不放全局配置
- **Options Page（Dashboard）= 完整配置中心**，独立的全屏页面
- **首次使用零配置**，默认连接 api.coco.xyz/clawmark，Google 一键登录即可开始

### 一、Popup 改版 — 「当前页面」视角

Popup 只展示跟当前页面相关的内容 + 最常用操作。

#### 布局（从上到下）

```
┌─────────────────────────────┐
│  ClawMark          ⚙️ 齿轮  │  ← 齿轮点击打开 Dashboard
├─────────────────────────────┤
│  📄 当前页面: github.com/... │  ← 当前 tab 的 hostname+path
│  ───────────────────────────│
│  💬 3 Comments  🐛 1 Issue   │  ← 当前页面标注统计（可点击）
│  ───────────────────────────│
│  最近标注:                    │
│  · "这段代码有 bug" — 2m ago │  ← 最近 3 条本页标注
│  · "需要加单测" — 15m ago    │
│  · [查看全部 →]              │  ← 点击打开 Side Panel
│  ───────────────────────────│
│  ⏸ 本站已禁用 [启用]         │  ← 当前站点开关（仅一行）
│  ───────────────────────────│
│  快捷操作:                    │
│  [📷 截图标注]  [📋 打开面板] │  ← 两个主要操作按钮
└─────────────────────────────┘
```

#### 关键变化

| 项目 | 当前 | 改版后 |
|------|------|--------|
| Server URL / Username | popup 里手动输入 | 移到 Dashboard |
| Delivery Rules CRUD | popup 里折叠面板 | 移到 Dashboard |
| 登录状态 | popup 大块区域 | 齿轮 → Dashboard 里管理 |
| 当前页面标注数 | 无 | popup 顶部显示 |
| 最近标注 | 无 | popup 中间区域 |
| 站点开关 | popup 里 | 保留，精简为一行 |

#### 空状态

当前页面没有标注时：
```
┌─────────────────────────────┐
│  ClawMark          ⚙️ 齿轮  │
├─────────────────────────────┤
│  📄 当前页面: example.com    │
│  ───────────────────────────│
│  还没有标注                   │
│  选中文字即可开始标注 ✨       │
│  ───────────────────────────│
│  [📷 截图标注]  [📋 打开面板] │
└─────────────────────────────┘
```

未登录时：
```
┌─────────────────────────────┐
│  ClawMark          ⚙️ 齿轮  │
├─────────────────────────────┤
│  登录后开始标注               │
│  [🔑 Google 登录]            │
│  ───────────────────────────│
│  [⚙️ 打开设置]               │  ← 打开 Dashboard（Server URL 等）
└─────────────────────────────┘
```

### 二、Dashboard（Options Page）— 完整配置中心

新增 `chrome.runtime.openOptionsPage()` 打开的全屏配置页面。

#### 页面结构

```
┌──────────┬──────────────────────────────────┐
│ 侧边导航  │  主内容区                          │
│          │                                    │
│ 📊 概览   │  ┌────────────────────────────┐  │
│ 👤 账户   │  │  概览 Dashboard              │  │
│ 🔗 连接   │  │                              │  │
│ 📮 分发规则│  │  统计卡片:                    │  │
│ 🌐 站点管理│  │  [总标注数] [本周] [分发成功率] │  │
│ ℹ️ 关于   │  │                              │  │
│          │  │  最近活动列表...               │  │
│          │  └────────────────────────────┘  │
└──────────┴──────────────────────────────────┘
```

#### 各 Tab 内容

**📊 概览**
- 统计卡片：总标注数、本周标注数、分发成功率
- 最近活动时间线（跨页面）

**👤 账户**
- 当前登录状态 + 头像
- Google 登录 / 登出
- Username 设置
- ~~手动认证（API Key / Invite Code）~~ → **移除**（Kevin #153/#157：傻瓜化目标下不需要 API Key 手动配置，Google 登录已覆盖认证需求）

**🔗 连接**
- Server URL 配置（默认 `api.coco.xyz/clawmark`，允许修改 — Kevin #154/#156）
- 连接状态 + 延迟测试
- 版本信息

**📮 分发规则**（从 popup 迁移过来，扩展空间大幅提升）
- 规则列表表格（可排序、可搜索）
- 新增/编辑规则的完整表单（不再挤在小弹窗里）
- 规则测试：输入一个 URL 看会匹配到哪些规则
- 导入/导出规则（JSON）
- **智能推荐**（Kevin #155）：根据当前页面 URL 自动推荐分发规则 — 例如在 GitHub PR 页面提示「发送到 GitHub Issue」，在 Notion 页面提示「发送到 Slack」。基于 URL pattern 匹配 + 预置规则模板

**📮 Delivery URL 处理**（Kevin #152 + PR review comment）
- 分发目标（delivery URL）从 popup 完整迁移到 Dashboard
- Dashboard 里提供完整的 delivery URL 管理：增删改查 + 测试连通性
- Popup 中不再显示 delivery URL 配置，仅在标注时自动按规则匹配分发
- **Delivery 智能化三层**（Kevin PR comment）：
  1. **综合推荐**：根据当前页面 URL + 用户历史分发记录 + 标注类型，自动推荐最佳 delivery 目标（如 GitHub PR 页面 → 推荐发到对应 repo 的 Issue）
  2. **可选择特定目标**：推荐之外允许手动选择其他已配置的 delivery 目标
  3. **候选列表**：展示所有可用的 delivery 目标，按匹配度排序

**🌐 站点管理**
- 已启用/已禁用站点列表
- 批量管理（全部启用/全部禁用）
- 黑名单/白名单模式切换

**ℹ️ 关于**
- 版本号 + 更新日志链接
- 反馈入口（GitHub Issues）
- 隐私政策链接

### 三、傻瓜化 — 首次使用流程优化

#### 当前流程（6 步）

1. 安装插件
2. 点击图标
3. 手动输入 Server URL
4. 手动输入 Username
5. 点击 Save
6. 可选：配置 Google 登录

#### 优化后流程（2 步）

1. 安装插件 → 自动弹出 Welcome 页面
2. 点击「Google 登录」→ 完成

**实现：**
- `chrome.runtime.onInstalled` 监听安装事件，打开 welcome 页面（Dashboard 的特殊 tab）
- Server URL 默认 `api.coco.xyz/clawmark`，在 Dashboard 连接 tab 可修改
- Username 从 Google 账户自动获取
- 登录完成后自动跳转到当前 tab，tooltip 提示「选中文字开始标注」

#### Welcome 页面

```
┌──────────────────────────────────────────┐
│                                            │
│         🦀 欢迎使用 ClawMark               │
│                                            │
│    标注任何网页 — 评论、提 Issue、截图标注    │
│                                            │
│         [🔑 Google 一键登录]               │
│                                            │
│    登录后即可开始使用，无需其他配置。          │
│                                            │
│    [⚙️ 高级设置 — 自定义 Server URL]        │  ← 折叠，非默认路径
│                                            │
└──────────────────────────────────────────┘
```

### 四、其他 UX 微调

| 项目 | 描述 | 优先级 |
|------|------|--------|
| **工具栏位置记忆** | 记住上次工具栏出现的偏好位置（跟随选区 vs 固定位置）| P2 |
| **标注计数 badge** | 插件图标上显示当前页面标注数（chrome.action.setBadgeText）| P1 |
| **快捷键提示** | 首次使用时提示 Cmd+Shift+X 打开面板 | P2 |
| **错误信息人话化** | "Disconnected" → "无法连接服务器，检查网络或 [打开设置]" | P1 |
| **Loading 状态** | 提交标注时显示进度条而不只是按钮变灰 | P2 |

## 实现分期

### Phase 1: Dashboard + Popup 瘦身（P0）

**范围：**
- 新增 `extension/options/` 目录 — Dashboard 全屏页面
- 将 Server URL、Username、Auth、Delivery Rules 从 popup 迁移到 Dashboard
- Popup 改版为当前页面视角（标注统计 + 最近标注 + 快捷操作）
- 齿轮图标打开 Dashboard

**文件变更：**
- 新增: `extension/options/options.html`, `options.js`, `options.css`
- 修改: `extension/popup/popup.html`, `popup.js` （大幅精简）
- 修改: `extension/manifest.json`（添加 `options_page`）

**预计工作量：** 中等

### Phase 2: 首次使用优化（P1）

**范围：**
- `onInstalled` → 自动打开 Welcome 页面
- Google 登录后自动填充 Username
- Server URL 默认值 + 隐藏高级配置
- 插件图标 badge 显示当前页面标注数

**文件变更：**
- 修改: `extension/background/service-worker.js`（onInstalled 监听）
- 新增/修改: Dashboard 的 Welcome tab
- 修改: `extension/popup/popup.js`（badge 逻辑）

**预计工作量：** 小

### Phase 3: 打磨细节（P2）

**范围：**
- 错误信息人话化
- Loading 进度条
- 快捷键提示
- 规则导入/导出
- 站点批量管理

**预计工作量：** 小

## 验收标准

1. **新用户 2 步开始使用**：安装 → Google 登录 → 选中文字标注。不需要手动填任何 URL 或配置。
2. **Popup 只展示当前页面内容**：打开 popup 看到的是本页标注和快捷操作，不是配置表单。
3. **Dashboard 独立页面**：所有配置在全屏 Dashboard 里管理，操作空间充足。
4. **向后兼容**：已有用户的 Server URL、rules、auth 配置自动迁移，无需重新配置。

## Kevin Review 反馈整合（Issues #152-#157）

| Issue | 反馈 | 处理 |
|-------|------|------|
| #152 | delivery url 怎么处理？ | Delivery URL 管理完整迁移到 Dashboard，popup 不再显示 |
| #153 | 手动认证还有必要吗？ | 移除 API Key / Invite Code 手动认证，只保留 Google 登录 |
| #154 | Server URL 应该可以修改 | 改为「允许修改」，放在 Dashboard 连接 tab |
| #155 | 分发规则怎么智能化？ | 新增智能推荐：根据当前页面 URL 自动建议分发规则 |
| #156 | 默认 URL 应为 api.coco.xyz/clawmark | 已修正所有默认 URL |
| #157 | Welcome 页手动配置/API Key 的价值？ | 移除，Welcome 页只保留 Google 登录 + 高级设置（Server URL） |

## 开放问题

1. **Dashboard 是否需要 i18n？** 当前 popup 是英文，Dashboard 是否也只做英文？
2. **规则模板**：是否预置常用规则模板（如「GitHub PR → GitHub Issue」「Notion → Slack」）？
3. **智能推荐的规则匹配深度**：只做 URL pattern 还是也分析页面内容？

## 团队分工

| 角色 | 成员 | 负责内容 |
|------|------|---------|
| PM | Jessie | PRD、验收、协调 |
| 实现 | Boot | Phase 1-3 开发 |
| Review | Kevin | 方向确认、验收 |

---

*PRD by Jessie, 2026-03-04 (v2). Based on issue #150 (Kevin) + Kevin review #152-#157 + ClawMark extension v0.6.1 代码分析。*
