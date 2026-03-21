# Agent Channel 使用指南

本指南帮你从零开始配置 ClawMark Agent Channel，让 AI Agent 接收浏览器端的实时错误数据并自动创建 Issue。

---

## 前置条件

- ClawMark 服务端已部署运行（`http://localhost:3458` 或你的部署地址）
- ClawMark Chrome 扩展已安装
- 拥有 ClawMark 用户账号（Google OAuth 登录）
- （可选）GitLab 项目用于自动创建 Issue

---

## 第一步：注册 Agent

通过 API 注册一个 Agent，获取专用 API Key。

```bash
# 用你的 JWT token（从 Dashboard 或扩展获取）
curl -X POST http://localhost:3458/api/v2/agent-channel/register \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-error-sentinel",
    "capabilities": ["perception"]
  }'
```

返回示例：

```json
{
  "id": "abc123-def456",
  "name": "my-error-sentinel",
  "status": "active",
  "api_key": "cmak_a1b2c3d4e5f6g7h8i9j0..."
}
```

> ⚠️ **立即保存 `api_key`！** 这是唯一一次显示完整 key 的机会。丢失后只能通过 rotate 生成新 key。

---

## 第二步：配置扩展

在 Chrome 扩展中启用 Agent Channel 感知功能。

### 2.1 打开扩展设置

1. 点击 Chrome 工具栏的 ClawMark 图标
2. 点击 ⚙️ 设置（或右键扩展图标 → 选项）

### 2.2 配置 Agent Channel

在设置页面中：

1. **Server URL** — 填入 ClawMark 服务器地址（如 `http://localhost:3458`）
2. **Agent Key** — 填入上一步获取的 `cmak_xxx` key
3. **启用 Perception** — 开启以下感知通道：
   - ✅ Error Monitor — 捕获 JS 运行时错误
   - ✅ Console Proxy — 捕获 console.error/warn
   - ✅ Network Monitor — 捕获网络异常
4. **域名白名单** — 只在指定域名上采集数据（如 `example.com, app.mysite.com`）

### 2.3 保存并验证

保存配置后：
1. 访问白名单中的网站
2. 打开 DevTools → Console
3. 输入 `throw new Error("test perception")` 制造一个测试错误
4. 在 ClawMark 侧边栏中应能看到事件出现

---

## 第三步：验证数据流

确认事件正常从扩展流入服务端：

```bash
# 查询最近的感知事件
curl -H "X-Agent-Key: cmak_xxx" \
  "http://localhost:3458/api/v2/agent-channel/perception?limit=10"
```

返回示例：

```json
{
  "events": [
    {
      "type": "runtime-error",
      "message": "Error: test perception",
      "severity": "error",
      "url": "https://example.com/",
      "fingerprint": "a1b2c3d4..."
    }
  ],
  "cursor": "2026-03-22T12:00:00.000Z",
  "count": 1
}
```

如果看到事件数据，说明配置成功 ✅

---

## 第四步：配置 Agent 消费者（可选）

ClawMark 提供两种方式消费感知事件：

### 方式 A：内置消费者（进程内，推荐）

PerceptionConsumer 作为 ClawMark Server 的进程内模块运行，**直接读取 SQLite 数据库**，不经过 HTTP API。适合在 ClawMark Server 进程中集成。

```javascript
const PerceptionConsumer = require('./server/agent/perception-consumer');

const consumer = new PerceptionConsumer({
  db: clawmarkDb,         // ClawMark 数据库实例（直接访问）
  app_id: 'your-app-id',  // 你的 App ID
  pollInterval: 30000,     // 轮询间隔（ms），默认 30s
  minSeverity: 'error',   // 最低处理级别：critical/error/warning/info
  batchSize: 100,          // 每次拉取数量

  // GitLab 自动建 Issue（可选）
  gitlab: {
    token: 'glpat-xxx',
    project_id: 2,
    base_url: 'https://git.coco.xyz',
    labels: ['bug', 'auto-created'],
    assignees: ['developer1'],
    parent_issue_iid: 61    // 父 Issue（Agent Embed epic）
  }
});

consumer.start();
// consumer.stop();  // 停止轮询
```

### 方式 B：外部 Agent（HTTP 轮询）

如果你的 Agent 运行在 ClawMark Server 外部，使用 HTTP API 拉取事件：

```bash
# 增量拉取（使用游标）
curl -H "X-Agent-Key: cmak_xxx" \
  "http://localhost:3458/api/v2/agent-channel/perception?cursor=2026-03-22T12:00:00.000Z&limit=100"
```

外部 Agent 需自行实现去重和 Issue 创建逻辑，参考 `ErrorDeduplicator` 的算法。

### 消费者工作流程

1. 每 30 秒增量拉取新事件（内置：`db.getPerceptionEvents()`；外部：`GET /perception`）
2. 按严重级别过滤（默认只处理 error 及以上）
3. 按 fingerprint 去重分组
4. 对每个新唯一错误：
   - 在 ClawMark 中创建追踪记录
   - （如配置）在 GitLab 自动创建 Issue
5. 对已知错误：更新计数和最后出现时间

---

## 第五步：查看统计和追踪

### 聚合统计

```bash
curl -H "X-Agent-Key: cmak_xxx" \
  "http://localhost:3458/api/v2/agent-channel/perception/stats?limit=20"
```

返回按 fingerprint 聚合的错误排行，包含首次/最近出现时间和出现次数。

### 追踪 Issue

```bash
curl -H "X-Agent-Key: cmak_xxx" \
  "http://localhost:3458/api/v2/agent-channel/perception/issues"
```

返回已创建的追踪 Issue 列表，包含关联的 GitLab Issue 链接。

---

## 常见问题排查

### 扩展没有上报事件

| 检查项 | 解决方案 |
|--------|----------|
| Perception 未启用 | 扩展设置 → 确认 Error Monitor / Console Proxy / Network Monitor 已开启 |
| 域名不在白名单 | 扩展设置 → 添加目标网站域名 |
| Server URL 错误 | 确认地址可访问：`curl http://localhost:3458/health` |
| Agent Key 无效 | 检查 key 是否以 `cmak_` 开头、是否已被 rotate |

### API 返回 401

| 原因 | 解决方案 |
|------|----------|
| Agent Key 已失效 | 通过 `/agents/:id/rotate-key` 生成新 key |
| JWT 过期 | 重新登录获取新 token |
| Key 格式错误 | 确认使用 `X-Agent-Key` header（不是 `Authorization`） |

### 事件重复

ClawMark 在三个层面去重：
1. **客户端** — 10 秒内相同 fingerprint 不重发
2. **服务端** — fingerprint 字段用于事件聚合
3. **消费者** — ErrorDeduplicator 按 `SHA256(type+message+stack)` 归一化去重

如果仍有重复，检查 fingerprint 生成逻辑是否包含动态变量（如时间戳、请求 ID）。

### GitLab Issue 没有自动创建

| 检查项 | 解决方案 |
|--------|----------|
| gitlab 配置未设置 | PerceptionConsumer 构造参数中添加 `gitlab` 对象 |
| GitLab token 无权限 | 确认 token 有 `api` scope |
| project_id 错误 | 确认 GitLab 项目 ID |
| 事件低于 minSeverity | 降低阈值（如改为 `warning`） |

---

## API Key 管理最佳实践

1. **一个 Agent 一个 Key** — 不要多个服务共享同一个 key
2. **定期轮转** — 建议每 90 天 rotate 一次
3. **环境隔离** — dev/staging/prod 使用不同的 Agent 和 Key
4. **泄露处理** — 立即调用 `/rotate-key`，旧 key 立即失效
