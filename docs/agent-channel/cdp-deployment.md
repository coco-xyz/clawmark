# CDP 通道部署指南

本文档说明如何在生产环境中启用和配置 CDP（Chrome DevTools Protocol）通道。

## 架构概览

```
Agent (AI)  <──WebSocket──>  ClawMark Server  <──WebSocket──>  Browser Extension
                              /ws/agent-channel/cdp              chrome.debugger API
```

CDP 通道由三个组件协作：

1. **服务端**（`server/ws-cdp.js`）：WebSocket 网关，负责认证、会话管理、命令路由和审计
2. **扩展端**（`extension/background/cdp-*.js`）：通过 Chrome Debugger API 执行 CDP 命令，负责白名单检查和安全过滤
3. **Agent 端**：通过 WebSocket 连接服务端，发送 CDP 命令和接收结果

## 前置条件

- ClawMark 服务端已部署并运行
- Chrome 扩展已安装（支持 Manifest V3）
- Agent 已注册并获取 API Key（`cmak_` 前缀）
- 扩展已配置应用 API Key（`cmk_` 前缀）

## 服务端配置

### WebSocket 端点

CDP 通道监听以下 WebSocket 路径：

```
ws[s]://<server>/ws/agent-channel/cdp
```

### 连接参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| 心跳间隔 | 30 秒 | 服务端定期发送 ping |
| 空闲超时 | 5 分钟 | 无活动的 Agent 连接自动断开 |
| 命令超时 | 30 秒 | 单条 CDP 命令的执行超时时间 |
| 最大载荷 | 1 MB | 单条 WebSocket 消息最大体积 |
| 速率限制 | 30 次/秒 | 每个 Agent 的命令频率上限 |

### 反向代理配置（Caddy）

```caddyfile
your-domain.com {
    # CDP WebSocket 需要 upgrade 支持
    handle /ws/agent-channel/cdp {
        reverse_proxy localhost:3000 {
            header_up Connection {>Connection}
            header_up Upgrade {>Upgrade}
        }
    }

    # 其他 API 和静态文件
    handle {
        reverse_proxy localhost:3000
    }
}
```

### 反向代理配置（Nginx）

```nginx
location /ws/agent-channel/cdp {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 300s;  # 大于空闲超时（5分钟）
}
```

### 认证

连接时通过 `x-agent-key` HTTP Header 传递 API Key：

| Key 前缀 | 角色 | 认证方式 |
|-----------|------|----------|
| `cmak_` | Agent | 查询 `agents` 表（key hash 匹配） |
| `cmk_` | 扩展/应用 | 查询 `api_keys` 表 |

连接建立后，服务端从 key 中提取 `app_id`，用于跨应用隔离。

### 跨应用隔离

- Agent 和扩展按 `app_id` 分组
- Agent 只能访问同一 `app_id` 下的扩展
- 标签页锁定是按 app 隔离的（锁 key 格式：`${app_id}:${tabId}`）

## 扩展端配置

### 权限要求

扩展 `manifest.json` 需要以下权限：

```json
{
  "permissions": ["debugger", "tabs", "storage"]
}
```

- `debugger`：必须，用于调用 Chrome Debugger API
- `tabs`：标签页查询和管理
- `storage`（sync/local）：配置和状态存储

### CDP 模块加载顺序

Service Worker 按以下顺序导入 CDP 模块：

1. `cdp-session-manager.js` — 会话生命周期
2. `cdp-tab-targeter.js` — 标签页定位
3. `cdp-event-forwarder.js` — 事件缓冲与转发
4. `cdp-whitelist.js` — 命令白名单
5. `cdp-safety.js` — 安全过滤
6. `cdp-relay.js` — 命令执行管道

### 自定义白名单

通过扩展设置页面或直接写入 `chrome.storage.sync` 配置：

```javascript
// 扩展 options 页面中
await chrome.storage.sync.set({
  cdpCustomAllowed: ['Performance.enable', 'Performance.getMetrics'],
  cdpCustomBlocked: ['Network.getCookies']  // 限制 Cookie 访问
});
```

详细说明参考 [cdp-whitelist.md](cdp-whitelist.md)。

## 生产环境安全考虑

### 1. Debugger API 的风险

Chrome Debugger API（`chrome.debugger`）提供了对浏览器的深度访问能力。在生产环境启用前，请评估以下风险：

| 风险 | 说明 | 缓解措施 |
|------|------|----------|
| 数据泄露 | Agent 可以读取页面内容、Cookie、网络请求 | 白名单限制 + 审计日志 + 事件脱敏 |
| 代码执行 | Runtime.evaluate 允许执行 JS | 安全过滤 + throwOnSideEffect + 正则模式匹配 |
| 会话劫持 | 读取 Cookie/Token 可能泄露登录态 | Cookie 在审计日志中脱敏；Network 事件自动过滤 auth 头 |
| 横向移动 | Agent 可能尝试访问其他标签页 | 独占锁 + app_id 隔离 + 标签页定位验证 |
| 资源消耗 | 高频命令可能影响浏览器性能 | 30 次/秒速率限制 + 5 分钟空闲超时 |

### 2. 部署模式建议

#### 开发/测试环境

- 可直接启用，使用默认白名单
- 建议在独立浏览器 Profile 中加载扩展

#### 生产环境（推荐配置）

```
1. 启用 HTTPS（WebSocket 走 wss://）
2. 配置反向代理的 IP 白名单，限制 Agent 来源
3. 按需收窄白名单：移除不需要的命令（如 Network.getCookies）
4. 启用审计日志清理定时任务（建议保留 30 天）
5. 监控速率限制告警
```

#### 高安全环境

```
1. 上述所有措施
2. 限制 Runtime.evaluate 为完全禁用（添加到 cdpCustomBlocked）
3. 仅保留 DOM/CSS/Page 域命令
4. 配置独立的 ClawMark 实例，与主业务隔离
5. 定期审查审计日志
```

### 3. 网络安全

| 配置项 | 建议 |
|--------|------|
| 传输加密 | **必须** 使用 wss://（TLS），禁止明文 ws:// |
| API Key 管理 | 定期轮换，按 Agent 分配独立 Key |
| 来源限制 | 反向代理层限制可连接的 IP 范围 |
| 心跳检查 | 保持默认 30 秒间隔，及时清理断线连接 |

## 会话管理

### 独占锁机制

每个标签页（在同一 app 内）同时只能有一个 Agent 建立 CDP 会话：

```
Agent A -> cdp:session-start {tabId: 1}  -> 成功，获得锁
Agent B -> cdp:session-start {tabId: 1}  -> 失败，返回 SESSION_LOCKED
Agent A -> cdp:session-stop  {tabId: 1}  -> 释放锁
Agent B -> cdp:session-start {tabId: 1}  -> 成功
```

### 会话生命周期

```
session-start -> 附加 Debugger -> 启用域 -> 执行命令... -> session-stop -> 分离 Debugger
                                                              |
                                                    标签页关闭 -> 自动清理
                                                    连接断开 -> 自动清理
                                                    空闲超时 -> 自动清理
```

### 导航时自动重连

当页面导航时，CDP 会话可能中断。扩展会：

1. 监听 `chrome.tabs.onUpdated` 事件
2. 发送验证命令（`Runtime.evaluate: '1'`）检测会话状态
3. 如果会话丢失，自动重新附加并恢复之前启用的域

## 监控与运维

### 健康检查

检查 CDP WebSocket 服务是否正常：

```bash
# 检查 WebSocket 端口是否监听
curl -s http://localhost:3000/health | jq .

# 检查 PM2 服务状态
pm2 status clawmark-server
```

### 审计日志查询

Agent 可以通过 WebSocket 查询审计日志：

```json
{
  "type": "cdp:audit-log",
  "filter": {
    "tabId": 123,
    "since": 1711900000000,
    "limit": 50
  }
}
```

服务端数据库存储完整审计记录：

```sql
-- 查看最近的 CDP 命令
SELECT * FROM cdp_audit_logs ORDER BY created_at DESC LIMIT 20;

-- 查看被阻止的命令
SELECT * FROM cdp_audit_logs WHERE status = 'blocked' ORDER BY created_at DESC;

-- 按 Agent 统计
SELECT agent_id, COUNT(*) as total, 
       SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as blocked
FROM cdp_audit_logs 
GROUP BY agent_id;
```

### 日志清理

定期清理过期审计日志，避免数据库膨胀：

```javascript
// 清理 30 天前的日志
db.cleanupOldCdpAuditLogs(30);
```

建议配置定时任务（cron）每天执行一次。

## 生产部署检查清单

- [ ] HTTPS/WSS 配置完成
- [ ] 反向代理 WebSocket upgrade 支持已验证
- [ ] Agent API Key 已创建并分发
- [ ] 扩展已安装并配置正确的服务器地址
- [ ] 白名单已按需收窄（如果需要）
- [ ] 审计日志清理定时任务已配置
- [ ] 速率限制参数已确认适合业务场景
- [ ] 监控告警已设置（连接数、错误率、被阻止命令比例）
- [ ] 安全评估文档已完成（参考 [cdp-safety.md](cdp-safety.md)）

## 相关文件

| 文件 | 说明 |
|------|------|
| `server/ws-cdp.js` | 服务端 WebSocket 处理器 |
| `extension/background/cdp-session-manager.js` | 扩展端会话管理 |
| `extension/background/cdp-relay.js` | 命令执行管道 |
| `extension/manifest.json` | 扩展权限声明 |
