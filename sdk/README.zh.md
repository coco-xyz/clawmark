# openclaw

[ClawMark](https://github.com/coco-xyz/clawmark) Agent Channel 的 Node.js SDK — 感知事件上报、浏览器操作执行和实时 WebSocket 通信。

## 安装

```bash
npm install openclaw ws
```

> `ws` 是 WebSocket 操作所需的 peer dependency。如果只使用 HTTP 感知 API，`ws` 可选。

## 快速开始

```typescript
import { OpenClaw } from 'openclaw';

const claw = new OpenClaw({
  serverUrl: 'https://clawmark.example.com',
  agentKey: 'cmak_xxxxxxxxxxxx', // 注册 Agent 时获得
});

// 1. 上报错误事件
await claw.perception.report([
  {
    type: 'runtime-error',
    message: 'TypeError: Cannot read property "x" of undefined',
    fingerprint: 'abc123def456',
    severity: 'error',
    url: 'https://example.com/dashboard',
  },
]);

// 2. 连接 WebSocket 执行浏览器操作
await claw.actions.connect();

const result = await claw.actions.execute({
  type: 'click',
  target: '#submit-btn',
  timeout: 5000,
});
console.log('操作结果:', result);

// 3. 监听事件
claw.on('action:result', (msg) => {
  console.log(`Action ${msg.action_id}: ${msg.status}`);
});

// 4. 断开连接
claw.actions.disconnect();
```

## API 概览

### 感知 API（HTTP）

| 方法 | 说明 |
|------|------|
| `perception.report(events)` | 上报感知事件 |
| `perception.query(opts?)` | 查询事件（cursor 分页） |
| `perception.stats(limit?)` | 按 fingerprint 聚合统计 |
| `perception.issues()` | 获取已追踪的 issues |
| `perception.upsertIssue(input)` | 创建/更新追踪 issue |

### 操作 API（WebSocket）

| 方法 | 说明 |
|------|------|
| `actions.connect()` | 连接 WebSocket（自动重连） |
| `actions.disconnect()` | 断开 WebSocket |
| `actions.execute(request)` | 执行浏览器操作并等待结果 |

**操作类型：** `click` | `type` | `navigate` | `screenshot` | `scroll` | `form-fill`

### 错误处理

```typescript
import { AuthError, RateLimitError, ActionTimeoutError } from 'openclaw';
```

| 错误类型 | 说明 |
|----------|------|
| `AuthError` | Agent Key 无效或过期 (401) |
| `HttpError` | HTTP 请求失败 |
| `RateLimitError` | 请求频率超限 (429) |
| `ActionTimeoutError` | 操作超时 |
| `NotConnectedError` | WebSocket 未连接 |

## 认证

SDK 使用 Agent API Key（`cmak_` 前缀）认证。通过 ClawMark 管理 API 注册 Agent 获取：

```bash
curl -X POST https://clawmark.example.com/api/v2/agent-channel/register \
  -H "Authorization: Bearer $APP_JWT" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent", "capabilities": ["perception", "action"]}'
```

响应中的 `api_key` 即为 `agentKey`，仅返回一次，请妥善保存。

## 环境要求

- Node.js >= 18.0.0
- `ws` >= 8.0.0（peer dependency）

## License

MIT
