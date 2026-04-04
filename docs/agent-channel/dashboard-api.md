# Dashboard API 参考

ClawMark Dashboard 提供一组分析 API，用于查询错误趋势、Agent 行为历史、质量指标等数据。所有端点都需要 JWT 认证。

**基础 URL:** `http://localhost:3458`（或部署后的服务器地址）

**认证:** 所有端点需要 JWT Bearer Token：

```
Authorization: Bearer <jwt_token>
```

---

## 一、总览摘要

### GET /api/v2/analytics/summary

获取当前应用的整体统计摘要。

**响应 200:**

```json
{
  "total_items": 1250,
  "open_items": 45,
  "resolved_items": 1180,
  "closed_items": 25,
  "by_type": {
    "issue": 890,
    "discuss": 310,
    "comment": 50
  },
  "by_priority": {
    "critical": 12,
    "high": 89,
    "normal": 1100,
    "low": 49
  }
}
```

---

## 二、趋势分析

### GET /api/v2/analytics/trends

查询标注量的时间序列数据，支持按周期和维度分组。

**查询参数：**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `period` | string | `day` | 聚合周期：`day` / `week` / `month` |
| `days` | number | `30` | 回溯天数（1–365） |
| `group_by` | string | `total` | 分组维度：`total` / `classification` / `type` / `status` |

**示例请求：**

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3458/api/v2/analytics/trends?period=day&days=7&group_by=type"
```

**响应 200:**

```json
{
  "trends": [
    { "date": "2026-03-26", "group": "issue", "count": 15 },
    { "date": "2026-03-26", "group": "discuss", "count": 8 },
    { "date": "2026-03-27", "group": "issue", "count": 22 },
    { "date": "2026-03-27", "group": "discuss", "count": 5 }
  ],
  "period": "day",
  "days": 7,
  "group_by": "type"
}
```

---

## 三、热点话题

### GET /api/v2/analytics/hot-topics

查询当前时段内频繁出现的话题/错误。

**查询参数：**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `hours` | number | `24` | 回溯小时数（1–720） |
| `threshold` | number | `2` | 最少出现次数（1–100） |

**示例请求：**

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3458/api/v2/analytics/hot-topics?hours=24&threshold=3"
```

**响应 200:**

```json
[
  {
    "topic": "TypeError: Cannot read property 'map' of undefined",
    "count": 15,
    "first_seen": "2026-04-01T08:00:00.000Z",
    "last_seen": "2026-04-01T20:30:00.000Z",
    "urls": ["https://app.example.com/dashboard", "https://app.example.com/settings"]
  }
]
```

---

## 四、质量报告

### GET /api/v2/analytics/quality-report

获取标注质量指标，包括解决率、平均响应时间等。

**查询参数：**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `days` | number | `30` | 回溯天数（1–90） |

**示例请求：**

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3458/api/v2/analytics/quality-report?days=30"
```

**响应 200:**

```json
{
  "report": {
    "total_items": 500,
    "resolution_rate": 0.92,
    "avg_resolution_hours": 4.5,
    "avg_first_response_hours": 0.8,
    "by_priority": {
      "critical": { "total": 10, "resolved": 10, "avg_hours": 1.2 },
      "high": { "total": 45, "resolved": 42, "avg_hours": 3.1 },
      "normal": { "total": 400, "resolved": 370, "avg_hours": 5.0 },
      "low": { "total": 45, "resolved": 38, "avg_hours": 12.3 }
    }
  },
  "days": 30
}
```

**错误响应：**

| Code | 说明 |
|------|------|
| 400 | 无 App 上下文 |
| 401 | JWT 无效或过期 |
| 500 | 服务端计算错误 |

---

## 五、Agent 行为历史

### GET /api/v2/analytics/agent-actions

查询 Agent 执行的操作记录，包含感知捕获、Issue 创建/更新、CDP 操作等。

**查询参数：**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `days` | number | `30` | 回溯天数（1–90） |
| `limit` | number | `100` | 返回数量（1–500） |
| `agent_id` | string | — | 按 Agent ID 过滤 |
| `action_type` | string | — | 按操作类型过滤 |

**操作类型说明：**

| action_type | 说明 |
|-------------|------|
| `perception_capture` | 感知事件捕获 |
| `issue_created` | 自动创建追踪 Issue |
| `issue_updated` | 更新已有 Issue |
| `cdp_action` | CDP 浏览器操作 |
| `auto_fix` | 自动修复尝试 |

**示例请求：**

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3458/api/v2/analytics/agent-actions?days=7&agent_id=abc123&limit=50"
```

**响应 200:**

```json
{
  "actions": [
    {
      "id": "aa-1711234567-xyz",
      "agent_id": "abc123",
      "action_type": "perception_capture",
      "target_type": null,
      "target_id": null,
      "summary": "Captured 5 error event(s)",
      "status": "success",
      "metadata": { "count": 5 },
      "created_at": "2026-04-01T15:30:00.000Z"
    },
    {
      "id": "aa-1711234568-abc",
      "agent_id": "abc123",
      "action_type": "issue_created",
      "target_type": "perception_issue",
      "target_id": "a1b2c3d4...",
      "summary": "Created issue for a1b2c3d4...",
      "status": "success",
      "metadata": { "gitlab_issue_url": "https://git.coco.xyz/.../issues/42" },
      "created_at": "2026-04-01T15:31:00.000Z"
    }
  ],
  "summary": {
    "total_actions": 150,
    "by_type": {
      "perception_capture": 100,
      "issue_created": 30,
      "issue_updated": 20
    },
    "by_agent": {
      "abc123": 150
    }
  },
  "days": 7
}
```

---

## 六、错误趋势

### GET /api/v2/analytics/error-trends

查询感知错误的时间序列趋势，可按严重级别或类型分组。

**查询参数：**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `days` | number | `7` | 回溯天数（1–90） |
| `group_by` | string | `severity` | 分组：`severity` / `type` / `total` |

**示例请求：**

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3458/api/v2/analytics/error-trends?days=7&group_by=severity"
```

**响应 200:**

```json
{
  "trends": [
    { "date": "2026-03-26", "group": "P0", "count": 2 },
    { "date": "2026-03-26", "group": "P1", "count": 8 },
    { "date": "2026-03-26", "group": "error", "count": 45 },
    { "date": "2026-03-27", "group": "P0", "count": 0 },
    { "date": "2026-03-27", "group": "P1", "count": 5 },
    { "date": "2026-03-27", "group": "error", "count": 38 }
  ],
  "summary": {
    "total_events": 320,
    "unique_fingerprints": 42,
    "by_severity": {
      "P0": 5,
      "P1": 35,
      "error": 250,
      "warning": 30
    }
  },
  "days": 7,
  "group_by": "severity"
}
```

---

## 七、AI 聚类分析

### GET /api/v2/analytics/clusters

使用 AI 对近期标注进行语义聚类（需配置 Gemini API Key）。

**查询参数：**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `days` | number | `7` | 回溯天数（1–90） |
| `limit` | number | `50` | 参与聚类的最大标注数（1–100） |

**示例请求：**

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3458/api/v2/analytics/clusters?days=7"
```

**响应 200:**

```json
{
  "clusters": [
    {
      "name": "Dashboard 渲染异常",
      "description": "多个与 Dashboard 组件渲染相关的错误",
      "items": ["item-id-1", "item-id-2", "item-id-3"],
      "count": 3
    }
  ],
  "summary": "发现 3 个错误集群，其中 Dashboard 渲染相关最集中"
}
```

**错误响应：**

| Code | 说明 |
|------|------|
| 503 | AI 未配置（缺少 `GEMINI_API_KEY` 或 `config.ai.apiKey`） |

---

## 八、分发记录

### GET /api/v2/distributions/:item_id

查询指定 Item 的分发历史（Webhook/GitHub/GitLab/Slack 等）。

**示例请求：**

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3458/api/v2/distributions/item-1234
```

**响应 200:**

```json
{
  "dispatches": [
    {
      "id": "dl-xxx",
      "target_type": "github-issue",
      "status": "delivered",
      "external_url": "https://github.com/org/repo/issues/42",
      "method": "user_rule",
      "retries": 0,
      "created_at": "2026-04-01T10:00:00.000Z"
    },
    {
      "id": "dl-yyy",
      "target_type": "webhook",
      "status": "failed",
      "last_error": "HTTP 500: Internal Server Error",
      "retries": 3,
      "created_at": "2026-04-01T10:00:01.000Z"
    }
  ]
}
```

### POST /api/v2/distributions/:item_id/retry

重试指定 Item 失败的分发。

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://localhost:3458/api/v2/distributions/item-1234/retry
```

---

## 九、通用错误响应

| Code | 说明 |
|------|------|
| 400 | 参数错误或无 App 上下文 |
| 401 | JWT 无效、过期或缺失 |
| 429 | 请求频率超限 |
| 500 | 服务端内部错误 |

### 速率限制

分析类端点使用 `apiReadLimiter`，AI 类端点（clusters、classify）使用更严格的 `aiLimiter`。超限时返回 429 状态码。

---

## 十、分页说明

分析 API 的列表类端点通过 `limit` 参数控制返回数量，各端点限制不同：

| 端点 | 默认 limit | 最大 limit |
|------|-----------|-----------|
| agent-actions | 100 | 500 |
| error-trends | 7（天） | 90 |
| hot-topics | 24（小时） | 720 |
| quality-report | 30（天） | 90 |
| clusters | 50 | 100 |

时间序列类数据通过 `days` / `hours` 参数控制范围，而非传统游标分页。
