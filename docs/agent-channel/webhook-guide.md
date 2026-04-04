# Webhook 配置指南

本指南介绍如何在 ClawMark 中配置 Webhook，让感知错误事件自动推送到 Slack、Lark（飞书）、钉钉或任意 HTTP 端点。

---

## 概述

ClawMark 支持两类 Webhook：

| 类型 | 用途 | 配置方式 |
|------|------|----------|
| **Agent Webhook** | Agent 注册的错误通知推送（P0/P1 自动触发） | API 注册 |
| **分发 Webhook** | Item 创建/解决/分配等事件推送 | 配置文件 或 Endpoint API |

Agent Webhook 在高优先级错误（P0/P1）发生时自动触发，适合实时告警场景。分发 Webhook 用于 Item 生命周期事件的通知分发。

---

## 一、Agent Webhook（错误告警）

### 1.1 前置条件

- 已注册 Agent，持有 API Key（`cmak_` 前缀）
- 有一个可接收 HTTPS POST 的端点

### 1.2 注册 Webhook

```bash
curl -X POST http://localhost:3458/api/v2/agent-channel/webhooks \
  -H "X-Agent-Key: cmak_your_agent_key" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://hooks.slack.com/services/T00000/B00000/XXXX",
    "template": "slack",
    "event_filters": {
      "severity": ["P0", "P1"],
      "types": ["runtime-error", "network-error"],
      "sites": ["app.example.com"]
    }
  }'
```

**请求参数：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `url` | string | ✅ | 接收端点 URL（默认需 HTTPS） |
| `secret` | string | 否 | HMAC 签名密钥（不提供则自动生成） |
| `template` | string | 否 | 载荷格式：`generic`（默认）/ `slack` / `lark` / `dingtalk` |
| `event_filters` | object | 否 | 事件过滤器（见下文） |
| `allow_http` | boolean | 否 | 是否允许 HTTP（默认仅 HTTPS） |

**event_filters 字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `severity` | string[] | 仅推送指定严重级别：`P0` / `P1` / `error` / `warning` / `info` |
| `types` | string[] | 仅推送指定事件类型：`runtime-error` / `network-error` / `console-error` 等 |
| `sites` | string[] | 仅推送指定站点的事件（URL 包含匹配） |

**成功响应 201：**

```json
{
  "id": "wh-1711234567-abc123",
  "url": "https://hooks.slack.com/services/...",
  "template": "slack",
  "active": true,
  "event_filters": { "severity": ["P0", "P1"] },
  "secret": "a1b2c3d4e5f6..."
}
```

> ⚠️ `secret` 仅在创建时返回，请立即保存。

**限制：** 每个 Agent 最多注册 10 个 Webhook。

### 1.3 管理 Webhook

```bash
# 列出所有 Webhook
curl -H "X-Agent-Key: cmak_xxx" \
  http://localhost:3458/api/v2/agent-channel/webhooks

# 查看详情 + 最近投递记录
curl -H "X-Agent-Key: cmak_xxx" \
  http://localhost:3458/api/v2/agent-channel/webhooks/{webhook_id}

# 更新 Webhook（如修改过滤器或暂停）
curl -X PUT -H "X-Agent-Key: cmak_xxx" \
  -H "Content-Type: application/json" \
  -d '{"active": false}' \
  http://localhost:3458/api/v2/agent-channel/webhooks/{webhook_id}

# 删除 Webhook
curl -X DELETE -H "X-Agent-Key: cmak_xxx" \
  http://localhost:3458/api/v2/agent-channel/webhooks/{webhook_id}
```

### 1.4 测试 Webhook

发送一个示例 P1 载荷到你的端点，验证连通性：

```bash
curl -X POST -H "X-Agent-Key: cmak_xxx" \
  http://localhost:3458/api/v2/agent-channel/webhooks/{webhook_id}/test
```

返回投递结果和实际发送的 payload，方便调试。

### 1.5 查看投递历史

```bash
curl -H "X-Agent-Key: cmak_xxx" \
  "http://localhost:3458/api/v2/agent-channel/webhooks/{webhook_id}/deliveries?limit=50"
```

每条记录包含：状态（`delivered` / `failed` / `pending`）、HTTP 状态码、错误信息、重试次数。

---

## 二、HMAC 签名验证

所有 Webhook 投递都带有 HMAC-SHA256 签名，通过 `X-ClawMark-Signature` 请求头传递。

### 签名格式

```
X-ClawMark-Signature: sha256=<hex_digest>
```

签名算法：以 `secret` 为密钥，对请求体 JSON 字符串计算 HMAC-SHA256，输出十六进制。

### Node.js 验证示例

```javascript
const crypto = require('crypto');

function verifySignature(body, signature, secret) {
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(typeof body === 'string' ? body : JSON.stringify(body))
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}

// Express 中间件
app.post('/webhook', express.text({ type: '*/*' }), (req, res) => {
  const sig = req.headers['x-clawmark-signature'];
  if (!verifySignature(req.body, sig, WEBHOOK_SECRET)) {
    return res.status(401).send('Invalid signature');
  }
  const payload = JSON.parse(req.body);
  console.log('收到 ClawMark 事件:', payload.event_type);
  // 处理事件...
  res.sendStatus(200);
});
```

### Python 验证示例

```python
import hmac
import hashlib

def verify_signature(body: bytes, signature: str, secret: str) -> bool:
    expected = 'sha256=' + hmac.new(
        secret.encode(),
        body,
        hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(signature, expected)

# Flask 示例
from flask import Flask, request, abort

app = Flask(__name__)

@app.route('/webhook', methods=['POST'])
def handle_webhook():
    sig = request.headers.get('X-ClawMark-Signature', '')
    if not verify_signature(request.data, sig, WEBHOOK_SECRET):
        abort(401)
    payload = request.get_json()
    print(f"收到事件: {payload['event_type']}")
    # 处理事件...
    return '', 200
```

---

## 三、载荷格式

### 3.1 通用格式（generic）

默认格式，适合自定义处理：

```json
{
  "event_type": "perception.error",
  "error": {
    "type": "runtime-error",
    "message": "TypeError: Cannot read property 'map' of undefined",
    "severity": "P1",
    "url": "https://app.example.com/dashboard",
    "fingerprint": "a1b2c3d4e5f6...",
    "stack": "TypeError: Cannot read property...\n    at Dashboard.render (app.js:142:8)"
  },
  "issue": {
    "id": "pi-1711234567-xyz",
    "count": 42,
    "first_seen": "2026-03-20T10:00:00.000Z",
    "last_seen": "2026-04-01T15:30:00.000Z",
    "gitlab_url": "https://git.coco.xyz/hxanet/myproject/-/issues/123"
  },
  "timestamp": "2026-04-01T15:30:00.000Z",
  "app_id": "app-uuid"
}
```

### 3.2 Slack 格式

自动转换为 Slack attachment 格式，含颜色编码（P0 红色、P1 橙色、其他黄色）：

```json
{
  "attachments": [{
    "color": "#fd7e14",
    "title": "[P1] runtime-error: TypeError: Cannot read property 'map'...",
    "title_link": "https://git.coco.xyz/.../issues/123",
    "fields": [
      { "title": "URL", "value": "https://app.example.com/dashboard", "short": true },
      { "title": "Count", "value": "42", "short": true },
      { "title": "First Seen", "value": "2026-03-20T10:00:00.000Z", "short": true },
      { "title": "Fingerprint", "value": "a1b2c3d4e5f6...", "short": true }
    ]
  }]
}
```

### 3.3 Lark（飞书）格式

转换为 Lark 卡片消息，含颜色标题和"查看 Issue"按钮：

```json
{
  "msg_type": "interactive",
  "card": {
    "header": {
      "title": { "tag": "plain_text", "content": "[P1] runtime-error" },
      "template": "orange"
    },
    "elements": [
      {
        "tag": "div",
        "text": { "tag": "lark_md", "content": "**Message:** TypeError: Cannot read property..." }
      },
      {
        "tag": "div",
        "fields": [
          { "is_short": true, "text": { "tag": "lark_md", "content": "**URL:** https://app.example.com/..." } },
          { "is_short": true, "text": { "tag": "lark_md", "content": "**Count:** 42" } }
        ]
      },
      {
        "tag": "action",
        "actions": [{
          "tag": "button",
          "text": { "tag": "plain_text", "content": "View Issue" },
          "url": "https://git.coco.xyz/.../issues/123",
          "type": "primary"
        }]
      }
    ]
  }
}
```

### 3.4 钉钉格式

转换为钉钉 Markdown 消息：

```json
{
  "msgtype": "markdown",
  "markdown": {
    "title": "[P1] runtime-error",
    "text": "### [P1] runtime-error\n> TypeError: Cannot read property...\n\n- **URL:** https://app.example.com/dashboard\n- **Count:** 42\n- **First Seen:** 2026-03-20T10:00:00.000Z\n- [View Issue](https://git.coco.xyz/.../issues/123)"
  }
}
```

---

## 四、分发 Webhook（配置文件方式）

通过 `config.json` 配置静态 Webhook，用于 Item 生命周期事件推送：

```json
{
  "distribution": {
    "rules": [
      {
        "match": { "event": "item.created" },
        "channels": ["my-webhook"]
      },
      {
        "match": { "event": "item.resolved" },
        "channels": ["my-webhook"]
      }
    ],
    "channels": {
      "my-webhook": {
        "adapter": "webhook",
        "url": "https://my-service.example.com/clawmark-hook",
        "secret": "your-hmac-secret",
        "events": ["item.created", "item.resolved"]
      }
    }
  }
}
```

也支持通过环境变量快速配置：

```bash
CLAWMARK_WEBHOOK_URL=https://my-service.example.com/hook
CLAWMARK_WEBHOOK_SECRET=my-secret
```

支持的事件类型：`item.created` / `item.resolved` / `item.assigned` / `discussion.created` / `discussion.message`

---

## 五、投递机制

### 重试策略

失败的 Webhook 投递自动重试，退避间隔递增：

| 尝试次数 | 延迟 |
|----------|------|
| 第 1 次 | 立即 |
| 第 2 次 | 30 秒 |
| 第 3 次 | 2 分钟 |
| 第 4 次 | 10 分钟 |

超过 4 次后标记为 `failed`。

### 自动禁用

连续 10 次投递失败后，Webhook 自动设为 `inactive`。修复端点后需手动重新激活：

```bash
curl -X PUT -H "X-Agent-Key: cmak_xxx" \
  -H "Content-Type: application/json" \
  -d '{"active": true}' \
  http://localhost:3458/api/v2/agent-channel/webhooks/{webhook_id}
```

### 速率限制

每个 Agent 每分钟最多 100 次投递（滑动窗口）。超限的投递会被跳过。

### 安全保护

- **SSRF 防护**：所有 Webhook URL 会做 DNS 解析检查，禁止投递到私有 IP 地址
- **HTTPS 强制**：默认仅允许 HTTPS URL（可通过 `allow_http: true` 放行 HTTP）
- **超时**：单次投递 10 秒超时

---

## 六、请求头说明

每次 Webhook 投递包含以下请求头：

| 请求头 | 说明 |
|--------|------|
| `Content-Type` | `application/json` |
| `User-Agent` | `ClawMark/2.0` |
| `X-ClawMark-Signature` | HMAC-SHA256 签名（`sha256=<hex>`） |
| `X-ClawMark-Event` | 事件类型（如 `perception.error`） |

---

## 常见问题

### Webhook 没有收到投递

1. **检查 Webhook 状态**：确认 `active` 为 `true`（连续失败 10 次会自动禁用）
2. **检查过滤器**：`event_filters` 可能过滤掉了事件
3. **检查 URL 可达性**：确保端点可以从 ClawMark 服务器访问
4. **查看投递历史**：`GET /webhooks/{id}/deliveries` 查看具体错误

### 签名验证失败

1. 确认使用的是创建时返回的 `secret`
2. 确认签名计算使用的是原始请求体字符串（不是解析后再序列化的）
3. 使用 `crypto.timingSafeEqual`（Node.js）或 `hmac.compare_digest`（Python）做比较，避免时序攻击

### 收到重复投递

Webhook 重试可能导致重复。建议在接收端用 `fingerprint` + `timestamp` 做幂等处理。
