# ClawMark 反馈投递教程

> 本教程介绍 ClawMark 的所有反馈投递方式，帮助你快速上手提交问题和建议。

---

## 目录

- [方式一：浏览器扩展（推荐）](#方式一浏览器扩展推荐)
- [方式二：GitHub Issue（网页）](#方式二github-issue网页)
- [方式三：投递渠道配置（管理员）](#方式三投递渠道配置管理员)

---

## 方式一：浏览器扩展（推荐）

ClawMark 浏览器扩展是最便捷的反馈方式——在任何网页上选中文字或截图，一键提交。

### 1.1 安装扩展

1. 打开 Chrome 浏览器，在地址栏输入 `chrome://extensions/`
2. 打开右上角的 **开发者模式** 开关
3. 点击 **加载已解压的扩展程序**
4. 选择 ClawMark 仓库中的 `extension/` 文件夹

![安装扩展](tutorial-images/ext-install.png)

> **提示：** 安装后，工具栏会出现 ClawMark 图标。建议点击拼图图标 📌 固定到工具栏。

### 1.2 配置连接

1. 点击工具栏的 ClawMark 图标，打开弹窗
2. 填写 **Server URL**（服务器地址），例如 `https://labs.coco.xyz/clawmark`
3. 使用 Google 账号登录，或输入 API Key

![配置扩展](tutorial-images/ext-config.png)

### 1.3 提交反馈

#### 方法 A：选中文字提交

1. 在任意网页上选中一段文字
2. 弹出的浮动工具栏上选择操作：
   - 💬 **评论** — 一般性评论
   - 🐛 **Issue** — 报告问题
   - 📸 **截图** — 截图标注
3. 在弹出的输入框中填写：
   - **标题**：简述问题（如"登录按钮点击无反应"）
   - **内容**：详细描述
   - **优先级**：低 / 普通 / 高 / 紧急
   - **标签**：可选，分类用
4. 点击 **提交**

![选中文字提交](tutorial-images/ext-select-submit.png)

#### 方法 B：截图提交

1. 右键点击页面 → 选择 **ClawMark** → **截图并反馈**
2. 框选需要截图的区域
3. 可在截图上添加标注
4. 填写描述后提交

#### 方法 C：侧边栏查看

1. 点击 ClawMark 图标打开侧边栏
2. 查看当前页面的所有标注和反馈
3. 可以回复、修改状态（解决/关闭）

![侧边栏](tutorial-images/ext-sidepanel.png)

### 1.4 扩展功能开关

- **全局开关**：在扩展弹窗中可一键启用/禁用
- **按站点禁用**：在特定网站上可单独关闭扩展

---

## 方式二：GitHub Issue（网页）

如果你不方便安装扩展，也可以直接在 GitHub 上提交 Issue。

### 2.1 注册 GitHub 账号

如果已有账号可跳过。

1. 访问 [github.com](https://github.com)，点击 **Sign up**
2. 按提示输入邮箱、密码、用户名

![GitHub 注册](tutorial-images/step1-github-homepage.png)

> **提示：** 使用常用邮箱注册，方便接收通知。

### 2.2 打开 Issues 页面

登录后，访问：
```
https://github.com/coco-xyz/clawmark/issues
```

![Issues 页面](tutorial-images/step3-clawmark-issues.png)

### 2.3 创建 Issue

1. 点击绿色的 **New issue** 按钮

![New Issue](tutorial-images/step4-new-issue-button.png)

2. 填写内容：

**标题** — 一句话描述，例如：
- "登录页面加载缓慢"
- "消息发送失败"
- "[建议] 增加深色模式"

**描述** — 建议使用模板：

```markdown
## 问题描述
简要说明遇到的问题。

## 复现步骤
1. 第一步
2. 第二步
3. 出现问题

## 期望行为
描述期望的正确结果。

## 环境信息
- 设备：手机/电脑
- 浏览器：Chrome/Safari
- 系统：iOS/Android/Windows/Mac
```

![填写示例](tutorial-images/step6-issue-form-filled.png)

### 2.4 添加截图

截图能帮助开发者快速定位问题：

- **拖拽上传**：将截图文件拖入描述框
- **粘贴上传**：截图后在描述框按 Ctrl+V（Mac 按 Cmd+V）
- **点击上传**：点击输入框下方的上传链接

> 上传后会显示 `![image](...)` 代码，这是正常的，提交后会显示为图片。

### 2.5 提交

- 可选：在右侧选择标签（`bug` / `enhancement` / `question`）
- 确认内容无误后点击 **Submit new issue**

> ⚠️ 提交后内容公开可见，请勿包含密码等敏感信息。

### 2.6 跟踪状态

- **邮件通知**：有回复或状态变更时会收到邮件
- **查看进度**：随时访问 Issues 页面查看
- **补充信息**：在 Issue 评论区可追加说明

| 状态 | 含义 |
|------|------|
| **Open** (绿色) | 等待处理 |
| **Closed** (紫色) | 已解决/关闭 |

---

## 方式三：投递渠道配置（管理员）

ClawMark 支持将反馈自动分发到多个平台。此部分面向项目管理员。

### 3.1 支持的投递渠道

| 渠道 | 用途 | 配置要点 |
|------|------|----------|
| **GitHub Issue** | 自动创建 GitHub Issue | GitHub Token + 仓库名 |
| **GitLab Issue** | 自动创建 GitLab Issue | GitLab Token + 项目 ID |
| **Telegram** | 发送通知到 TG 群 | Bot Token + Chat ID |
| **Lark（飞书）** | 发送卡片消息到群 | Webhook URL |
| **Slack** | 发送通知到 Slack | Webhook URL |
| **Email** | 邮件通知 | SMTP 配置 |
| **Jira** | 创建 Jira Issue | Token + Project Key |
| **Linear** | 创建 Linear Issue | API Key + Team ID |
| **Webhook** | 通用 HTTP 回调 | URL + 密钥 |
| **HxA Connect** | 消息总线 | Endpoint + Topic |

### 3.2 配置投递规则

在 Dashboard 的 **Delivery Rules** 页面，或编辑服务器 `config.json`：

```json
{
  "distribution": {
    "rules": [
      {
        "match": {
          "event": "item.created",
          "priority": ["high", "critical"]
        },
        "channels": ["telegram-alerts", "github-bugs"]
      }
    ],
    "channels": {
      "telegram-alerts": {
        "adapter": "telegram",
        "bot_token": "你的Bot Token",
        "chat_id": "群聊ID"
      },
      "github-bugs": {
        "adapter": "github-issue",
        "token": "GitHub PAT",
        "repo": "coco-xyz/clawmark",
        "labels": ["bug"]
      }
    }
  }
}
```

### 3.3 配置 Telegram 通知

1. 在 Telegram 找 [@BotFather](https://t.me/BotFather)，创建 Bot，获取 Token
2. 将 Bot 添加到目标群组
3. 获取群聊 Chat ID（可通过 [@userinfobot](https://t.me/userinfobot)）
4. 在 config.json 或 Dashboard 中添加 Telegram 渠道配置

> **注意：** Telegram 渠道是**通知推送**（反馈提交后自动转发到群），不是通过 TG bot 提交反馈。

### 3.4 配置飞书通知

1. 在飞书群设置中添加自定义机器人，获取 Webhook URL
2. 在配置中添加 Lark 渠道：

```json
{
  "lark-team": {
    "adapter": "lark",
    "webhook_url": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx"
  }
}
```

### 3.5 规则匹配说明

| 匹配字段 | 可选值 | 说明 |
|----------|--------|------|
| `event` | `item.created`, `item.resolved`, `item.assigned`, `item.closed` | 触发事件 |
| `type` | `issue`, `discuss`, `comment` | 反馈类型 |
| `priority` | `critical`, `high`, `medium`, `low` | 优先级 |
| `tags` | 自定义标签数组 | 标签匹配 |

所有字段均可选，省略表示匹配所有。

---

## 常见问题

**Q: 不会英文，可以用中文写吗？**
A: 可以！团队支持中文反馈。

**Q: 提交后发现写错了怎么办？**
A: GitHub Issue 可以点击编辑图标修改；扩展提交的内容可在侧边栏编辑。

**Q: 推荐哪种方式？**
A: 日常使用推荐**浏览器扩展**，最方便；不便安装扩展时用 **GitHub Issue**。

**Q: Telegram 群里收到了通知，怎么回复？**
A: TG 通知是单向推送。要回复请点击通知中的链接跳转到原始 Issue。

---

*如有疑问，可在 Issue 中 @jessie-coco 或联系团队成员。*
