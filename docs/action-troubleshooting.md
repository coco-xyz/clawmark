# Action 故障排除 (Action Troubleshooting)

**Issue:** #80 | **Parent:** #61

本文档覆盖 ClawMark Action 系统的常见错误、调试方法和解决方案。

---

## 常见错误

### 扩展端错误 (Content Script / Action Executor)

| 错误消息 | 原因 | 解决方法 |
|---------|------|---------|
| `Action not permitted: site not in allowed domains` | 当前页面域名不在允许列表中 | 在扩展设置中将域名添加到 `agentEmbedAllowedDomains` |
| `Unknown action type: {type}` | 使用了不支持的操作类型 | 使用支持的类型：click, type, navigate, screenshot, scroll, form-fill |
| `Action forbidden: {type}` | 操作风险等级为 forbidden | 无法覆盖，这是设计限制 |
| `ActionExecutor not enabled on this page` | Action 功能被全局禁用或在此站点禁用 | 设置 `agentActionEnabled=true`，从 `agentActionDisabledSites` 中移除该站点 |
| `ElementFinder not loaded` | Content script 加载顺序错误 | 确保 `element-finder.js` 在 `action-executor.js` 之前加载 |
| `Element not found after {timeout}ms: {selector}` | 元素不存在或不可见 | 验证选择器正确性；增大超时时间；检查页面状态 |
| `Target is not an input, textarea, or contenteditable: {selector}` | type 操作指向了非输入元素 | 使用有效的 input/textarea/contenteditable 选择器 |
| `Only http/https URLs are allowed` | navigate 使用了非 http(s) URL | 使用 `http://` 或 `https://` 协议 |
| `form-fill requires value.fields array` | 缺少或为空的 fields 数组 | 提供 `value.fields` 且至少包含一个条目 |
| `Failed to reach content script: {message}` | 标签页已关闭、content script 未注入或扩展错误 | 验证标签页处于活跃状态且 content scripts 已加载 |

### 服务端错误 (Action Queue / WebSocket)

| 错误消息 | HTTP 状态码 | 原因 | 解决方法 |
|---------|-----------|------|---------|
| `Invalid action_type. Allowed: ...` | 400 | 不支持的操作类型 | 服务端仅接受：navigate, click, screenshot |
| `Action queue full (max 100 pending)` | 429 | 代理的待处理操作数超过 100 | 等待操作完成后再提交新操作 |
| `Failed to queue action` | 500 | 数据库错误 | 检查服务端日志，重试请求 |
| `Action timed out` | — (状态变为 failed) | 超过 timeout_ms 未收到结果 | 增大 `timeout_ms`（默认 30000ms） |
| `Invalid state transition` | 409 | 尝试了无效的状态转换 | 操作已完成或已失败 |
| `Action already resolved` | 409 | 重复提交结果 | 结果具有幂等性（首次生效） |

---

## WebSocket 连接问题

### 401 Unauthorized

**症状：** 连接 `/ws/agent-channel/actions` 返回 401。

**排查步骤：**
1. 检查 `X-Agent-Key` 头是否存在
2. 验证 key 格式——必须以 `cmak_`（agent）或 `cmk_`（API key）开头
3. 确认 key 在数据库中存在且对应的 agent/API key 处于活跃状态

### 连接断开

**症状：** 操作执行过程中 WebSocket 连接断开。

**排查步骤：**
1. 检查心跳：服务端每 30 秒发送 ping，客户端必须回复 pong
2. 确认客户端正确处理 ping/pong 帧
3. 检查网络层是否有空闲超时设置（代理、负载均衡器等）

### 操作入队但未派发到扩展

**症状：** 操作状态为 `queued`，但扩展没有收到。

**排查步骤：**
1. 确认扩展已通过 WebSocket 连接到 `/ws/agent-channel/actions`
2. 检查 `instance_id` 路由——如果指定了 `target_instance`，确认目标实例在线
3. 检查会话粘性路由——如果 `session_id` 已绑定到某个实例，操作只会派发到该实例
4. 查看服务端日志中 `findExtensionSocket()` 的返回值

---

## 元素查找问题

### 元素存在但找不到

**可能原因：**
- 元素在 iframe 内（当前不支持跨 iframe 查找）
- 元素被 Shadow DOM 封装
- CSS 选择器语法错误

**调试方法：**
1. 在浏览器 DevTools 控制台中测试选择器：`document.querySelector('your-selector')`
2. 如果使用 XPath，测试：`document.evaluate('xpath-expr', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`

### 元素存在但判定为不可见

**可见性检查条件（全部必须满足）：**
- `display !== "none"`
- `visibility !== "hidden"`
- `opacity !== 0`
- bounding rect 宽高均大于 0

**常见场景：**
- 元素被其他元素遮挡（不影响可见性判定）
- 元素 `opacity: 0` 用于动画——等待动画完成后再操作
- 元素 `display: none` 需要某个交互才会显示——先触发显示操作

### 选择器最佳实践

| 推荐 | 不推荐 | 原因 |
|------|--------|------|
| `#unique-id` | `.class1.class2.class3` | ID 更稳定 |
| `[data-testid="submit"]` | `div > div > div > button` | data-testid 不受 DOM 结构变化影响 |
| `button[type="submit"]` | `body > main > form > button:nth-child(3)` | 结构路径脆弱 |
| `xpath://button[contains(text(), '提交')]` | 复杂 CSS 选择器 | 按文本查找更语义化 |

---

## Patrol 脚本调试

### 断言失败

**排查步骤：**
1. 查看 patrol 结果中 `steps[n].assertionResults.results`
2. 检查 `actual` 值与 `expected` 值的差异
3. 对于 `result-match`：确认路径语法（使用点号分隔，如 `data.title`）
4. 对于 `no-console-errors`：查看 `consoleErrors` 数组内容

### Cron 表达式不生效

**排查步骤：**
1. 确认为 5 字段格式（分钟 小时 日 月 星期）
2. 验证字段范围：分钟 [0-59]、小时 [0-23]、日 [1-31]、月 [1-12]、星期 [0-6]
3. 检查调度器是否已启动（`scheduler.start()`）
4. 注意防重复机制：同一分钟内不会重复执行

### 步骤超时

**每步轮询机制：**
- 操作结果轮询间隔：500ms
- 超时由操作自身的 `timeout_ms` 控制（默认 30 秒）
- 可通过 `opts.stepTimeout` 全局覆盖

---

## 风险等级参考

| 等级 | 操作 | 行为 |
|------|------|------|
| low | screenshot, scroll | 始终允许 |
| medium | click, type, navigate | 默认允许 |
| high | form-fill | 需显式启用（未来实现） |
| forbidden | （当前无） | 始终阻止，无法覆盖 |

---

## 安全注意事项

### 域名白名单

操作仅在白名单域名的页面上执行。默认允许的域名：

- `coco.xyz`, `coco.site`
- `hxa.net`, `hxa.one`
- `clawmark.dev`
- `localhost`

子域名自动匹配（如 `app.coco.xyz` 匹配 `coco.xyz`）。通过 `agentEmbedAllowedDomains` 在 `chrome.storage.sync` 中配置。

### 密码保护

`form-fill` 操作自动跳过 `type="password"` 的输入字段，返回 `{ skipped: true, reason: "password field" }`。

### 全局开关

| 设置 | 说明 |
|------|------|
| `agentActionEnabled` | 全局开关，`false` 时阻止所有操作 |
| `agentActionDisabledSites` | 按站点禁用列表 |
| `agentEmbedAllowedDomains` | 域名白名单 |
