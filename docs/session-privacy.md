# 会话隐私保护 (Session Privacy)

**Issue:** #76 | **Parent:** #61

本文档描述 ClawMark 会话录制中的隐私保护机制，包括 PII 过滤规则、数据保留策略、数据收集范围和合规说明。

## 概述

所有会话数据在**离开 content script 之前**即经过 `PrivacyFilter`（`extension/content/privacy-filter.js`）处理。这意味着敏感信息永远不会以明文形式进入 background service worker 或服务端。

**核心原则：**
- 本地过滤：所有脱敏在浏览器端完成，服务端不接触原始数据
- 最小采集：只记录重现问题所需的最少信息
- 默认安全：敏感字段自动掩码，无需用户配置

---

## PII 过滤规则

### 1. 输入值掩码 (Input Masking)

**密码字段**

所有 `type="password"` 的输入字段，其值被替换为 `"••••"`。

**敏感字段名检测**

字段的 `name`、`id`、`autocomplete` 或 `aria-label` 属性匹配以下模式时，值被替换为 `"••••"`：

```
password, passwd, pass, pwd, ssn, social security,
credit card, card number, cvv, cvc, ccv, expir,
secret, token, api key
```

匹配规则（不区分大小写）：

```regex
/^(password|passwd|pass|pwd|ssn|social.?security|credit.?card|card.?number|cvv|cvc|ccv|expir|secret|token|api.?key)$/i
```

**示例：**

```
输入: <input name="credit-card" value="4111111111111111">
输出: { "name": "credit-card", "value": "••••", "masked": true }
```

### 2. 文本模式掩码 (Text Pattern Masking)

**信用卡号**

13-19 位数字序列（可含空格或短横线）被替换为 `"••••"`：

```regex
/\b(?:\d[ -]*){13,19}\b/g
```

**电子邮箱**

邮箱地址的本地部分（@ 前）被掩码，域名保留：

```
输入: john.doe@example.com
输出: ••••@example.com
```

### 3. URL 脱敏 (URL Sanitization)

查询参数名匹配以下关键词时，参数值被替换为 `[REDACTED]`：

```
token, key, secret, password, passwd, auth, code,
session, access_token, refresh_token, api_key, apikey,
credential, sig, signature
```

**示例：**

```
输入: https://example.com/callback?code=abc123&state=xyz
输出: https://example.com/callback?code=[REDACTED]&state=xyz
```

### 4. 选择器脱敏 (Selector Sanitization)

CSS 选择器路径自底向上构建，限制如下：
- 最多 5 级祖先
- 每级仅包含标签名 + 前两个 class 名
- 遇到 `id` 属性时提前停止
- 不包含任何敏感属性值

**示例：**

```
div#form > form.auth-form.login-form > input
```

### 5. 快照 HTML 脱敏 (Snapshot Sanitization)

| 规则 | 处理方式 |
|------|---------|
| 敏感输入字段值 | 替换为 `"••••"`（最多处理 100 个字符的 value） |
| 隐藏输入值 | 替换为 `"••••"` |
| 敏感 `data-*` 属性 | 匹配 `email\|phone\|user\|token\|password\|secret` 的属性值设为 `[REDACTED]` |
| HTML 总长度 | 截断到 50,000 字符 |

---

## 数据收集范围

### 收集的数据

| 数据类型 | 内容 | 用途 |
|---------|------|------|
| 页面导航 | URL（脱敏后）、标题、viewport 尺寸 | 重现用户操作路径 |
| 点击事件 | 脱敏选择器、标签名、坐标 | 定位交互目标 |
| 输入事件 | 字段名、脱敏后的值 | 理解表单交互流程 |
| 滚动位置 | scrollX/Y、视口高度 | 理解可见区域 |
| DOM 快照 | 脱敏后的 HTML 片段 | 视觉重现页面状态 |
| 错误信息 | 脱敏后的错误消息、来源文件、行列号 | 定位和重现错误 |

### 不收集的数据

- 密码和认证凭证（自动掩码）
- 完整的 DOM 树（仅采集脱敏快照，最大 50KB）
- Cookie 和 localStorage 内容
- 网络请求体和响应体
- 文件上传内容
- 浏览器扩展的内部状态

---

## 数据保留策略 (TTL)

| 数据类型 | 保留期 | 清理触发 |
|---------|--------|---------|
| 已完成会话（`status = "completed"`） | **30 天** | 基于 `updated_at` |
| 孤立活跃会话（`status = "active"` 但长期无更新） | **7 天** | 基于 `updated_at` |
| 操作日志（action log） | **90 天** | 基于 `created_at` |
| 本地存储（扩展端） | 标签页关闭时删除 | 标签页关闭事件 |

**清理机制：**
- 服务启动时执行一次清理
- 之后每 24 小时自动执行
- 删除通过 SQL CASCADE 级联清除关联的 events 和 snapshots 记录

---

## 用户控制

### 全局开关

用户可在扩展设置中完全禁用会话录制。禁用后不产生任何会话数据。

### 上传条件

`SessionForwarder` 仅在以下条件全部满足时上传数据：
1. 用户已认证（登录状态）
2. 至少有一个代理已绑定
3. 服务端 URL 匹配可信来源

### 本地存储限制

| 限制项 | 值 |
|--------|------|
| 每会话最大事件数 | 2,000 |
| 每会话最大快照数 | 50 |
| 每标签页最大会话数 | 10 |
| 空闲超时 | 30 分钟 |

超出限制时自动裁剪最旧的记录。

---

## 合规说明

### 数据处理原则

- **数据最小化：** 仅采集重现问题所需的最少数据
- **端侧处理：** PII 过滤在用户浏览器中完成，敏感数据不离开客户端
- **有限保留：** 所有数据有明确的 TTL，自动清理过期数据
- **透明性：** 用户可查看录制状态，随时禁用

### 建议部署方

- 在隐私政策中披露会话录制功能
- 告知用户数据采集范围和保留期
- 提供 opt-out 机制的说明
- 确保服务端存储符合所在地区的数据保护法规
