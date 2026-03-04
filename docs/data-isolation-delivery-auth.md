# 技术方案：数据隔离 + 投递鉴权

**关联 Issue**: GitLab #188（数据隔离）+ 投递权限问题
**作者**: jessie-coco
**状态**: 草案 — 待 review
**日期**: 2026-03-04

---

## 1. 问题描述

### 1.1 数据隔离 (#188)

所有用户共用 `app_id = 'default'`，任何登录用户都能读写系统中的所有数据。

**根因**：`items` 表用 `app_id` 做多租户隔离，但：
- JWT 认证（`type: 'jwt'`）不携带 `app_id` — 查询直接 fallback 到 `'default'`
- GET `/api/v2/items` 接受 query 参数 `app_id`，无归属验证
- POST `/api/v2/items` 允许 body 中覆盖 `app_id`

**测试服务器现状**（jessie.coco.site/clawmark）：
| 用户 | 条目数 | app_id |
|------|--------|--------|
| freefacefly@gmail.com (Kevin) | 113 | default |
| jessie@coco.xyz | 5 | default |
| voyax3@gmail.com | 1 | default |
| 其他 (Boot/Lucy/Demo) | ~4 | default |

共 123 条数据，所有人互相可见。

### 1.2 投递鉴权

用户配置投递规则到外部 repo（如 `voyax/bcat`）时，dispatch 系统在用户没提供自己 token 的情况下，fallback 使用服务器默认的 GitHub token。该 token 没有目标 repo 的权限 → 403 → dispatch 标记为 `exhausted`。

此外，label 创建失败（403）会导致整个 dispatch 失败，即使 issue 本身创建成功了。

**根因**（adapters/index.js 第 254-262 行）：Token 继承机制 — `_dispatchSingleTarget()` 搜索已注册的 adapter channel，复用管理员的 token。

---

## 2. 方案设计

### 2.1 数据隔离 — 用户级查询隔离

**原则**：所有数据查询限定在当前认证用户范围内。除非通过组织成员关系明确共享，否则不允许跨用户访问。

#### 2.1.1 认证 → user_id 绑定

当前认证中间件（`v2Auth`）已提取用户身份：
- JWT: `req.v2Auth.user = payload.email`
- API Key: `req.v2Auth.app_id = apiKey.app_id`, `req.v2Auth.user = apiKey.created_by`

**改动**：JWT 认证时，自动从用户的 apps 中解析 `app_id`：

```javascript
// v2Auth 中间件增加逻辑
if (payload) {
    const userApps = itemsDb.getAppsByUser(payload.userId);
    const defaultApp = userApps.find(a => a.is_default) || userApps[0];
    req.v2Auth = {
        type: 'jwt',
        user: payload.email,
        userId: payload.userId,
        role: payload.role,
        app_id: defaultApp?.id || null  // null = 需要创建 app
    };
}
```

#### 2.1.2 自动创建工作区

用户首次登录（Google OAuth）时，如果没有 app：
1. 创建 app：`id = uuid`, `name = "<email> 的工作区"`, `user_id = userId`
2. 创建绑定该 `app_id` 的 API key
3. 设置 `is_default = 1`

在 `/api/v2/auth/google` 处理函数中，user upsert 之后执行。

#### 2.1.3 API 端点改动

| 端点 | 当前行为 | 改动后 |
|------|---------|--------|
| `GET /api/v2/items` | `app_id` 来自 query 参数 | `app_id` 来自 `req.v2Auth.app_id`（忽略 query 参数）|
| `POST /api/v2/items` | `app_id` 来自 body 或 auth | 只使用 `req.v2Auth.app_id` |
| `GET /api/v2/items/:id` | 无归属检查 | 验证 `item.app_id === req.v2Auth.app_id` |
| `PUT /api/v2/items/:id` | 无归属检查 | 验证 `item.app_id === req.v2Auth.app_id` |
| `DELETE /api/v2/items/:id` | 无归属检查 | 验证 `item.app_id === req.v2Auth.app_id` |
| `GET /api/v2/items/stats` | `app_id` 来自 query | `app_id` 来自 `req.v2Auth.app_id` |
| `GET /api/v2/routing/rules` | 按 `userName` 参数查 | 按 `req.v2Auth.user` 查 |
| `POST /api/v2/routing/rules` | `userName` 来自 body | 只使用 `req.v2Auth.user` |
| `GET /api/v2/endpoints` | 按 `req.v2Auth.user` | 不变（已正确 ✓）|
| `GET /api/v2/dispatch/log` | 无用户过滤 | 按 `item.app_id` 过滤 |

**核心规则**：永远不信任客户端传入的 `app_id` 或 `userName`，一律从 auth token 推导。

#### 2.1.4 数据迁移

现有数据需要分配到正确的 `app_id`：

```sql
-- 第 1 步：为已有用户创建 app
INSERT INTO apps (id, user_id, name, is_default, created_at, updated_at)
SELECT
    lower(hex(randomblob(16))),
    u.id,
    u.email || ' 的工作区',
    1,
    datetime('now'),
    datetime('now')
FROM users u
WHERE u.id NOT IN (SELECT user_id FROM apps);

-- 第 2 步：按 created_by email 将 items 归属到用户的 app_id
UPDATE items SET app_id = (
    SELECT a.id FROM apps a
    JOIN users u ON a.user_id = u.id
    WHERE u.email = items.created_by
    AND a.is_default = 1
)
WHERE created_by IN (SELECT email FROM users);

-- 第 3 步：孤儿数据（created_by 不在 users 表中的）保留为 'default'
-- 只有 admin 可见
```

#### 2.1.5 截图 / 上传文件隔离

当前截图存储在 `/data/images/<timestamp>-<random>.png`，无用户隔离。

**改动**：存储为 `/data/images/<app_id>/<filename>`。获取时检查归属：
- `GET /images/:filename` → 检查文件是否属于当前用户的 app_id

已有文件：保留原位，通过查找表或 metadata 中嵌入 app_id 关联。

### 2.2 投递鉴权 — 用户自有 Token

**原则**：服务器永远不用自己的凭证向用户指定的目标投递。用户必须提供自己的 token。

#### 2.2.1 移除 Token 继承

删除 `adapters/index.js` 第 254-262 行的 fallback 逻辑：

```javascript
// 删除这段代码：
if (target_type === 'github-issue' && !config.token) {
    for (const [, adapter] of this.channels) {
        if (adapter.type === 'github-issue' && adapter.token) {
            config.token = adapter.token;
            break;
        }
    }
}
```

替换为验证逻辑：

```javascript
if (!config.token && !config.webhook_url && !config.api_key) {
    throw new Error(`${target_type} 缺少凭证，用户必须配置自己的 token。`);
}
```

#### 2.2.2 保存规则时验证凭证

用户创建/更新投递规则时，验证提供的凭证是否有效：

```javascript
// POST /api/v2/routing/rules — 增加验证步骤
async function validateDeliveryCredentials(target_type, target_config) {
    switch (target_type) {
        case 'github-issue': {
            // 测试：token 能否访问目标 repo
            const res = await fetch(`https://api.github.com/repos/${target_config.repo}`, {
                headers: { Authorization: `Bearer ${target_config.token}` }
            });
            if (!res.ok) throw new Error(`GitHub token 无法访问 ${target_config.repo}`);
            const repo = await res.json();
            if (!repo.permissions?.push) throw new Error(`Token 缺少 ${target_config.repo} 的写入权限`);
            return true;
        }
        case 'linear': {
            // 测试 Linear API key
            const res = await fetch('https://api.linear.app/graphql', {
                method: 'POST',
                headers: { Authorization: target_config.api_key, 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: '{ viewer { id } }' })
            });
            if (!res.ok) throw new Error('Linear API key 无效');
            return true;
        }
        // Webhook 类型（slack, lark, telegram）— 跳过验证（无可靠测试方法）
        default:
            return true;
    }
}
```

验证失败时返回清晰错误信息，用户可据此修正 token。

#### 2.2.3 服务器 Token 使用范围

服务器默认 GitHub token（`config.distribution.channels` 中配置）**仅**用于：
- 系统级通知（如向 `coco-xyz/clawmark` 发 issue）
- config 中定义的静态分发规则

**绝不**用于用户发起的投递。通过 dispatch method 强制执行：
- `method: 'user_rule'` 或 `method: 'user_default'` → 必须使用用户 token
- `method: 'system_default'` → 允许使用服务器 token（但仅限配置的系统 repo）
- `method: 'github_auto'` → 必须使用用户 token（因为目标来自用户浏览的 URL）

#### 2.2.4 Label 创建 — Best-Effort

修改 GitHub adapter，将 label 操作视为非致命错误：

```javascript
// adapters/github-issue.js
async send(event, item, context) {
    // 1. 创建 issue（必须成功 — 失败则抛错）
    const issue = await this.createIssue(item);

    // 2. 添加 label（best-effort — 记录警告，不抛错）
    try {
        await this.addLabels(issue.number, this.config.labels);
    } catch (labelErr) {
        console.warn(`[github-issue] Label 创建失败（非致命）: ${labelErr.message}`);
        // 不抛错 — issue 已创建成功
    }

    return { external_id: issue.number, external_url: issue.html_url };
}
```

---

## 3. 实施计划

### Phase 1：数据隔离（P0 — 安全修复）

1. **数据库迁移**：apps 表加 `is_default` 列。为已有用户创建 app，迁移 items 归属。
2. **认证中间件**：JWT 登录时自动从用户 apps 解析 `app_id`。
3. **API 加固**：所有端点使用 `req.v2Auth.app_id` — 忽略客户端传入值。
4. **插件更新**：移除请求中的 `app_id` 字段（由服务器推导）。
5. **测试**：验证用户 A 看不到用户 B 的数据。

### Phase 2：投递鉴权（P1 — 功能修复）

1. **移除 token 继承**（adapter registry）。
2. **保存规则时验证凭证**。
3. **Label best-effort**：GitHub adapter 捕获 label 错误，不导致投递失败。
4. **UI 更新**：投递规则表单要求外部目标必须填 token。
5. **测试**：无效 token 创建规则 → 拒绝。有效 token → 成功。

### Phase 3：凭证安全（P2 — 安全加固）

1. 对 `target_config` 和 endpoint `config` 做落盘加密（AES-256-GCM，密钥来自环境变量）。
2. 实现 token 轮换 / 过期追踪。
3. 凭证访问审计日志。

---

## 4. 涉及文件

| 文件 | 改动内容 |
|------|---------|
| `server/auth.js` | 首次登录自动创建 app |
| `server/index.js` | 所有 item/rule/stats 端点使用 `req.v2Auth.app_id` |
| `server/db.js` | 迁移脚本，`getItemsByAppId()` 强制执行 |
| `server/routing.js` | 路由解析传递用户上下文 |
| `server/adapters/index.js` | 移除 token 继承，增加验证 |
| `server/adapters/github-issue.js` | Label best-effort |
| `extension/src/api.js` | 移除请求中的 `app_id` |
| `extension/src/options/` | 投递规则表单 — token 必填 |

---

## 5. 风险与应对

| 风险 | 应对措施 |
|------|---------|
| 数据迁移破坏已有 items | 在事务中执行迁移；先备份数据库 |
| 插件缓存旧的 `app_id` 逻辑 | 服务器忽略客户端 `app_id` — 向后兼容 |
| 没有 Google OAuth 的用户（仅 invite code） | Invite code 用户分配共享 "guest" app — 权限受限 |
| Token 验证增加规则保存延迟 | 验证只在保存时执行一次，不在每次投递时执行 |
| GitHub API 速率限制影响验证 | 缓存验证结果；仅在投递 401 时重新验证 |

---

## 6. 待讨论问题

1. **组织级共享**：Phase 1 是否实现组织成员关系？当前方案仅做用户级隔离。
2. **Invite Code 废弃**：所有用户都用 Google OAuth 后，是否移除 invite code？
3. **API Key 迁移**：现有 API key 绑定 `app_id = 'default'`。迁移到用户的新 app_id，还是作废后重新生成？
