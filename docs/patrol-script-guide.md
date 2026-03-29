# 巡逻脚本指南 (Patrol Script Guide)

**Issue:** #80 | **Parent:** #61

本文档是 ClawMark Patrol（巡逻脚本）的 DSL 参考，覆盖脚本结构、断言类型、参数化和定时调度。

## 概述

Patrol 是一种声明式脚本，定义一系列浏览器操作步骤和验证断言。代理可以定期执行 Patrol 来监控网站健康状况、验证关键用户流程、检测回归问题。

**核心文件：**

| 文件 | 说明 |
|------|------|
| `server/agent/patrol/runner.js` | 脚本执行引擎 |
| `server/agent/patrol/assertions.js` | 断言引擎 |
| `server/agent/patrol/scheduler.js` | Cron 定时调度器 |
| `server/agent/patrol/scripts.js` | 内置示例脚本 |

---

## 脚本结构

```jsonc
{
  "id": "login-flow",                       // 唯一标识
  "name": "Login Flow Check",               // 可读名称
  "schedule": "0 */4 * * *",                // Cron 表达式（每 4 小时）
  "params": {                                // 参数默认值
    "baseUrl": "https://example.com",
    "username": "test@example.com",
    "password": "test123"
  },
  "steps": [                                 // 步骤数组
    {
      "action": "navigate",                  // 操作类型
      "payload": { "url": "{{baseUrl}}/login" },  // 支持参数插值
      "label": "打开登录页",                  // 步骤描述
      "assertions": [                        // 断言数组（可选）
        { "type": "url-match", "expected": { "url": "/login" } }
      ]
    }
  ]
}
```

---

## 操作类型

### 队列操作（通过 Action Queue 执行）

| 类型 | 说明 | payload 字段 |
|------|------|-------------|
| `navigate` | 导航到 URL | `{ url: string }` |
| `click` | 点击元素 | `{ target: string, options?: object }` |
| `screenshot` | 截图 | `{ target?: string }` |

### 本地操作（在 runner 中直接执行）

| 类型 | 说明 | payload 字段 |
|------|------|-------------|
| `wait` | 等待指定时间 | `{ pauseMs: number }` |
| `type` | 键入文本 | `{ target: string, value: string }` |
| `assert-only` | 仅执行断言，无操作 | 无 |

---

## 参数插值

脚本支持 `{{paramName}}` 语法进行参数化。参数在运行时从 `params` 对象解析。

```jsonc
{
  "params": { "baseUrl": "https://staging.example.com" },
  "steps": [
    {
      "action": "navigate",
      "payload": { "url": "{{baseUrl}}/dashboard" }
    }
  ]
}
```

运行时覆盖参数：

```javascript
runPatrol(script, deps, {
  params: { baseUrl: "https://production.example.com" }
})
```

---

## 断言类型

每个步骤可以包含一个或多个断言。断言在操作执行后验证。

### element-exists

检查指定元素是否存在于 DOM 中。

```json
{
  "type": "element-exists",
  "expected": { "selector": "#welcome-message" }
}
```

上下文来源：操作结果中的 `elements`、`dom` 或 `result` 字段。

### text-match

检查页面文本是否包含/等于指定内容。

```jsonc
{
  "type": "text-match",
  "expected": {
    "text": "登录成功",
    "exact": false          // false: 包含匹配（默认）; true: 精确匹配
  }
}
```

### url-match

检查当前 URL 是否包含/等于指定字符串。

```jsonc
{
  "type": "url-match",
  "expected": {
    "url": "/dashboard",
    "exact": false          // false: 包含匹配（默认）; true: 精确匹配
  }
}
```

### no-console-errors

检查浏览器控制台是否无错误。

```json
{
  "type": "no-console-errors",
  "expected": {}
}
```

上下文来源：`consoleErrors` 字符串数组。空数组 = 通过。

### result-match

检查操作结果中指定路径的值。

```json
{
  "type": "result-match",
  "expected": {
    "path": "data.title",
    "value": "Dashboard"
  }
}
```

路径使用点号分隔（如 `data.title`），值精确匹配。

### 断言结果格式

单个断言：

```json
{ "type": "url-match", "pass": true, "actual": "/dashboard", "message": "" }
```

批量断言：

```json
{
  "results": [ ... ],
  "allPassed": false,
  "failCount": 1
}
```

---

## 内置示例脚本

### loginFlow

验证登录流程完整性。

```jsonc
{
  "id": "loginFlow",
  "params": { "baseUrl": "", "username": "", "password": "" },
  "steps": [
    { "action": "navigate", "payload": { "url": "{{baseUrl}}/login" }, "label": "打开登录页" },
    { "action": "click", "payload": { "target": "#email" }, "label": "点击邮箱字段" },
    { "action": "type", "payload": { "target": "#email", "value": "{{username}}" }, "label": "输入邮箱" },
    { "action": "click", "payload": { "target": "#password" }, "label": "点击密码字段" },
    { "action": "type", "payload": { "target": "#password", "value": "{{password}}" }, "label": "输入密码" },
    {
      "action": "click",
      "payload": { "target": "button[type='submit']" },
      "label": "点击登录",
      "assertions": [
        { "type": "url-match", "expected": { "url": "/dashboard" } },
        { "type": "no-console-errors", "expected": {} }
      ]
    }
  ]
}
```

### basicNavigation

验证多页面导航正常。

```jsonc
{
  "id": "basicNavigation",
  "params": { "baseUrl": "" },
  "steps": [
    {
      "action": "navigate",
      "payload": { "url": "{{baseUrl}}" },
      "label": "首页",
      "assertions": [{ "type": "url-match", "expected": { "url": "{{baseUrl}}" } }]
    },
    {
      "action": "navigate",
      "payload": { "url": "{{baseUrl}}/about" },
      "label": "关于页",
      "assertions": [{ "type": "no-console-errors", "expected": {} }]
    }
  ]
}
```

### formSubmission

验证表单提交流程。

```jsonc
{
  "id": "formSubmission",
  "params": { "baseUrl": "", "formUrl": "/contact", "submitSelector": "button[type='submit']" },
  "steps": [
    { "action": "navigate", "payload": { "url": "{{baseUrl}}{{formUrl}}" }, "label": "打开表单页" },
    { "action": "type", "payload": { "target": "#name", "value": "Test User" }, "label": "填写姓名" },
    { "action": "type", "payload": { "target": "#email", "value": "test@example.com" }, "label": "填写邮箱" },
    { "action": "click", "payload": { "target": "{{submitSelector}}" }, "label": "提交表单" },
    { "action": "wait", "payload": { "pauseMs": 2000 }, "label": "等待提交" },
    {
      "action": "screenshot",
      "payload": {},
      "label": "截图结果",
      "assertions": [{ "type": "no-console-errors", "expected": {} }]
    }
  ]
}
```

---

## 定时调度 (Scheduling)

### Cron 表达式

标准 5 字段 cron 格式：

```
┌───────────── 分钟 (0-59)
│ ┌───────────── 小时 (0-23)
│ │ ┌───────────── 日 (1-31)
│ │ │ ┌───────────── 月 (1-12)
│ │ │ │ ┌───────────── 星期 (0-6, 0=周日)
│ │ │ │ │
* * * * *
```

支持的语法：

| 语法 | 示例 | 说明 |
|------|------|------|
| `*` | `* * * * *` | 每分钟 |
| `*/N` | `*/15 * * * *` | 每 15 分钟 |
| `N` | `30 2 * * *` | 固定值（2:30） |
| `N-M` | `0-30 * * * *` | 范围（0-30 分） |
| `N,M,P` | `0,15,30,45 * * * *` | 列表 |

### PatrolScheduler

调度器定期检查 cron 表达式，匹配当前时间时自动执行脚本。

```javascript
const scheduler = new PatrolScheduler({
  db,
  agentId: 'agent-uuid',
  appId: 'app-uuid',
  checkIntervalMs: 60000,     // 检查间隔，默认 60 秒
  onResult: (result) => { ... }  // 结果回调
})

// 注册脚本
scheduler.register(script)

// 启动调度
scheduler.start()

// 查看状态
scheduler.getStatus()
// → { scripts: [...], running: true, lastCheck: '2026-03-29T10:00:00Z' }

// 停止调度
scheduler.stop()

// 注销脚本
scheduler.unregister('login-flow')
```

**防重复：** 同一分钟内不会重复执行同一脚本。

---

## 执行引擎

### runPatrol()

```javascript
const result = await runPatrol(script, deps, opts)
```

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `script` | `object` | Patrol 脚本定义 |
| `deps` | `{ db, agentId, appId }` | 依赖注入 |
| `opts.params` | `object` | 运行时参数覆盖 |
| `opts.dryRun` | `boolean` | 干跑模式（不实际执行操作） |
| `opts.stepTimeout` | `number` | 每步超时（ms） |
| `opts.onStep` | `function` | 每步完成回调 |

**返回值：**

```jsonc
{
  "patrolId": "uuid",
  "name": "Login Flow Check",
  "status": "passed",              // "passed" | "failed" | "error"
  "steps": [
    {
      "stepIndex": 0,
      "label": "打开登录页",
      "action": "navigate",
      "status": "passed",          // "passed" | "failed" | "error" | "skipped"
      "actionResult": { ... },
      "assertionResults": { "results": [...], "allPassed": true, "failCount": 0 },
      "error": null,
      "durationMs": 120
    }
  ],
  "startTime": "2026-03-29T10:00:00.000Z",
  "endTime": "2026-03-29T10:00:05.000Z",
  "durationMs": 5000
}
```

### 失败报告

断言失败时，runner 自动生成 perception event 并写入数据库：

- 指纹 (fingerprint)：`SHA-256(patrol:step:type:message)` 截取前 16 字符
- 用于去重相同类型的失败
- 包含 patrol 元数据、步骤信息、断言详情

---

## 完整示例：编写自定义 Patrol

监控产品页面加载和关键 CTA 按钮：

```jsonc
{
  "id": "product-page-health",
  "name": "产品页健康检查",
  "schedule": "0 */2 * * *",
  "params": {
    "baseUrl": "https://app.example.com"
  },
  "steps": [
    {
      "action": "navigate",
      "payload": { "url": "{{baseUrl}}/products" },
      "label": "打开产品列表页",
      "assertions": [
        { "type": "url-match", "expected": { "url": "/products" } },
        { "type": "no-console-errors", "expected": {} }
      ]
    },
    {
      "action": "click",
      "payload": { "target": ".product-card:first-child" },
      "label": "点击第一个产品"
    },
    {
      "action": "wait",
      "payload": { "pauseMs": 1000 },
      "label": "等待详情页加载"
    },
    {
      "action": "assert-only",
      "label": "验证购买按钮存在",
      "assertions": [
        { "type": "element-exists", "expected": { "selector": "#buy-now" } },
        { "type": "text-match", "expected": { "text": "立即购买" } }
      ]
    },
    {
      "action": "screenshot",
      "payload": {},
      "label": "截图产品详情页"
    }
  ]
}
```
