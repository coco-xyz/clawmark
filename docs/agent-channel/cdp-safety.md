# CDP 通道安全文档

本文档对 CDP（Chrome DevTools Protocol）通道进行安全风险评估，详细说明审计日志机制、事件响应流程和用户知情同意流程。

## 风险评估

### 威胁模型

CDP 通道允许 AI Agent 通过 Chrome Debugger API 读取浏览器页面信息。主要威胁场景：

| 威胁 | 攻击方式 | 影响 | 可能性 | 风险等级 |
|------|----------|------|--------|----------|
| 凭证窃取 | 通过 Runtime.evaluate 读取 Cookie/Token | 会话劫持、身份冒用 | 中 | **高** |
| 数据泄露 | 读取页面中的敏感信息（PII、财务数据） | 隐私侵犯、合规违规 | 中 | **高** |
| 安全过滤绕过 | 混淆 JS 代码绕过正则模式匹配 | 执行任意有副作用的代码 | 低 | **中** |
| 跨应用访问 | 利用认证漏洞访问其他应用的标签页 | 数据泄露、权限提升 | 低 | **中** |
| 拒绝服务 | 高频发送 CDP 命令消耗浏览器资源 | 浏览器卡顿、页面无响应 | 中 | **中** |
| 白名单提权 | 管理员误配置，添加危险命令到自定义白名单 | 页面修改、导航劫持 | 低 | **中** |

### 纵深防御体系

CDP 通道采用多层安全机制：

```
第一层：命令白名单（cdp-whitelist.js）
  ↓ 仅 44 条只读命令通过
第二层：安全过滤（cdp-safety.js）
  ↓ 正则匹配阻止 JS 副作用模式
第三层：V8 引擎防护（throwOnSideEffect）
  ↓ 运行时阻止实际副作用
第四层：速率限制（ws-cdp.js）
  ↓ 30 次/秒上限
第五层：审计日志
  ↓ 全量记录，事后追溯
第六层：应用隔离（app_id）
  ↓ 跨应用不可访问
```

### 各防护层详细说明

#### 第一层：命令白名单

- 默认 44 条只读命令，永久黑名单 44 条危险命令
- 默认拒绝策略：未在白名单中的命令一律阻止
- 永久黑名单不可被管理员覆盖
- 详细命令列表参考 [cdp-whitelist.md](cdp-whitelist.md)

#### 第二层：安全过滤

针对 `Runtime.evaluate` 和 `Runtime.callFunctionOn`，扫描以下 7 类危险模式（共 25 条正则规则）：

1. **DOM 修改**：innerHTML=, setAttribute(), appendChild() 等
2. **页面导航**：location=, window.open(), history.pushState() 等
3. **网络请求**：fetch(), XMLHttpRequest, WebSocket, sendBeacon() 等
4. **脚本注入**：eval(), new Function(), setTimeout() 等
5. **存储修改**：localStorage.setItem(), document.cookie= 等
6. **表单/交互**：submit(), click(), dispatchEvent() 等
7. **样式修改**：classList.add/remove(), style.property= 等

#### 第三层：V8 引擎防护

即使 JS 代码通过了正则检查，V8 引擎的 `throwOnSideEffect: true` 参数会在执行层面捕获所有实际产生副作用的操作。这是对正则模式匹配的有效补充，可以防御：

- 变量重命名绕过：`const a = document; a.body['inner' + 'HTML'] = '...'`
- Proxy/Reflect 绕过：通过元编程间接调用副作用方法
- 编码绕过：使用 Unicode 转义序列等

#### 第四层：速率限制

| 参数 | 值 | 说明 |
|------|------|------|
| 窗口 | 1 秒 | 滑动窗口 |
| 上限 | 30 次/秒 | 每个 Agent |
| 超限处理 | 返回 RATE_LIMITED 错误 | 不断开连接 |

#### 第五层：审计日志

分两层记录（详见下方「审计日志」章节）：

- **扩展端**：内存环形缓冲，最近 200 条
- **服务端**：SQLite 持久化，支持按条件查询

#### 第六层：应用隔离

- 每个应用（app_id）有独立的连接池和会话锁
- Agent 只能与同一应用的扩展通信
- 标签页锁 key 包含 app_id，防止跨应用会话冲突

## 审计日志

### 扩展端审计日志

**位置**：内存中（`cdp-safety.js`）

**容量**：环形缓冲，最大 200 条。超过 250 条时批量裁剪至 200 条。

**记录字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `tabId` | number | 目标标签页 ID |
| `method` | string | CDP 命令名称 |
| `params` | object | 命令参数（已脱敏） |
| `allowed` | boolean | 是否允许执行 |
| `reason` | string | 阻止原因（如果被阻止） |
| `success` | boolean | 执行是否成功（如果允许） |
| `durationMs` | number | 执行耗时（毫秒） |
| `timestamp` | number | 时间戳 |

**查询接口**：

```javascript
// 按标签页查询
cdpGetAuditLog({ tabId: 123, limit: 50 });

// 按时间范围查询
cdpGetAuditLog({ since: Date.now() - 3600000, limit: 100 });
```

**脱敏规则**（在 `cdp-relay.js` 中执行）：

- 截图数据：仅记录 format 和 quality，不记录图片内容
- 长表达式：截断至 200 字符
- 函数声明：截断至 200 字符

### 服务端审计日志

**位置**：SQLite 数据库

**记录时机**：
1. Agent 发送命令时创建记录（`db.createCdpAuditLog()`）
2. 收到扩展返回结果时更新记录（`db.updateCdpAuditLog()`）

**记录字段**：

| 字段 | 说明 |
|------|------|
| `agent_id` | 发起命令的 Agent ID |
| `app_id` | 所属应用 ID |
| `session_key` | CDP 会话标识 |
| `tab_id` | 目标标签页 |
| `method` | CDP 命令 |
| `params_hash` | 参数的 hash 值（不存储明文） |
| `status` | 状态：pending / success / error / blocked |
| `error` | 错误信息（如果失败） |
| `duration_ms` | 执行耗时 |
| `created_at` | 创建时间 |

**保留策略**：

```javascript
// 清理 N 天前的日志
db.cleanupOldCdpAuditLogs(days);
```

建议保留期限：
- 一般环境：30 天
- 合规要求高的环境：90 天或更长
- 开发环境：7 天

### 事件数据脱敏

CDP 事件在存储和转发前会进行脱敏处理（`cdp-event-forwarder.js`）：

| 数据类型 | 处理方式 |
|----------|----------|
| Cookie 头 | 完全移除 |
| Authorization 头 | 完全移除 |
| X-API-Key 头 | 完全移除 |
| Set-Cookie 头 | 完全移除 |
| Proxy-Authorization 头 | 完全移除 |
| 请求体 | 超过 1000 字符截断 |
| 脚本源码 | 超过 2000 字符截断 |
| 控制台消息 | 超过 500 字符截断 |

匹配的敏感头正则：`^(cookie|set-cookie|authorization|x-api-key|x-auth-token|proxy-authorization)$`

## 事件响应流程

### 异常检测指标

| 指标 | 阈值建议 | 说明 |
|------|----------|------|
| 被阻止命令比例 | > 20% | Agent 可能在尝试执行非授权操作 |
| 安全过滤触发率 | > 10% | Agent 可能在尝试绕过安全限制 |
| 速率限制触发频率 | > 5 次/分钟 | Agent 行为异常或代码有 bug |
| 单个 Agent 命令量 | > 1000 次/小时 | 异常高频访问 |
| 不同标签页切换频率 | > 50 次/分钟 | 可能在扫描多个页面 |

### 响应级别

#### P3 — 观察（低风险）

**触发条件**：偶发的被阻止命令，可能是 Agent 功能探测

**响应**：
1. 记录到审计日志
2. 无需人工介入
3. 定期回顾审计报告

#### P2 — 调查（中风险）

**触发条件**：
- 连续的安全过滤触发
- 同一 Agent 重复尝试被阻止的操作
- 速率限制频繁触发

**响应**：
1. 查看审计日志，确认 Agent 行为模式
2. 联系 Agent 开发者确认意图
3. 如有需要，临时收窄该 Agent 的白名单

#### P1 — 处置（高风险）

**触发条件**：
- 确认 Agent 在尝试窃取凭证或敏感数据
- 安全过滤被绕过（V8 throwOnSideEffect 触发但正则未拦截）
- 跨应用访问尝试

**响应**：
1. **立即撤销** Agent 的 API Key
2. **断开** 该 Agent 的所有 WebSocket 连接
3. **审查** 该 Agent 最近 24 小时的审计日志
4. **通知** 应用管理员
5. **评估** 是否有数据泄露，如有则按数据泄露流程处理
6. **修复** 如果是安全过滤绕过，更新过滤规则并发布补丁

### 事件响应操作

```bash
# 1. 查看某 Agent 最近的审计日志
sqlite3 clawmark.db "SELECT * FROM cdp_audit_logs WHERE agent_id = '<id>' ORDER BY created_at DESC LIMIT 50;"

# 2. 查看被阻止的命令
sqlite3 clawmark.db "SELECT method, COUNT(*) as cnt FROM cdp_audit_logs WHERE status = 'blocked' AND agent_id = '<id>' GROUP BY method ORDER BY cnt DESC;"

# 3. 撤销 Agent Key（将 key 标记为 revoked）
sqlite3 clawmark.db "UPDATE agents SET status = 'revoked' WHERE id = '<id>';"

# 4. 重启服务使撤销生效
pm2 restart clawmark-server
```

## 用户知情同意

### 用户感知

当 Agent 通过 CDP 通道附加到标签页时，Chrome 会在页面顶部显示黄色提示条：

> "[扩展名]" started debugging this browser

这是 Chrome 的内置安全机制，确保用户知道有调试器附加到了浏览器。

### 同意流程

#### 扩展安装时

1. 用户安装 ClawMark 扩展时，Chrome 会提示需要 `debugger` 权限
2. 权限描述明确说明扩展可以使用 Chrome 调试功能
3. 用户必须主动接受才能安装

#### CDP 功能启用时

1. CDP 功能默认关闭，需要在扩展设置中手动启用
2. 启用时应向用户展示以下信息：
   - CDP 允许 AI Agent 读取当前页面的内容和结构
   - 读取范围包括：DOM 结构、CSS 样式、截图、控制台日志、网络请求信息
   - 所有操作通过白名单限制，仅允许只读访问
   - 所有命令执行均有审计日志记录
3. 用户确认后启用

#### Agent 连接时

1. Agent 首次请求 CDP 会话时，扩展应通知用户（通过扩展图标状态变化或通知）
2. 用户可以随时在扩展设置中查看当前活跃的 CDP 会话
3. 用户可以随时断开某个 Agent 的 CDP 会话

### 用户控制权

| 操作 | 方式 |
|------|------|
| 查看活跃会话 | 扩展 Popup → CDP Sessions 面板 |
| 断开单个会话 | 点击会话旁的断开按钮 |
| 禁用 CDP 功能 | 扩展设置 → 关闭 CDP 开关 |
| 查看审计日志 | 扩展 Popup → Audit Log 面板 |
| 自定义白名单 | 扩展设置 → CDP Whitelist 配置 |
| 完全移除 | 卸载扩展 |

## 合规考虑

### 数据处理

| 数据类型 | 处理方式 | 保留期限 |
|----------|----------|----------|
| CDP 命令参数 | 脱敏后存储 hash | 随审计日志保留 |
| 页面内容 | 仅在内存中处理，不持久化 | 会话结束即清除 |
| Cookie/Token | 读取后可能在 Agent 内存中 | Agent 控制 |
| 截图 | 传输给 Agent，服务端不存储 | Agent 控制 |
| 审计日志 | 服务端 SQLite | 可配置（建议 30-90 天） |
| 事件缓冲 | 扩展内存，最多 500 条/标签页 | 扩展重启即清除 |

### 建议措施

1. **隐私政策**：在产品隐私政策中披露 CDP 数据访问能力
2. **最小权限**：仅启用 Agent 实际需要的 CDP 域，移除不需要的命令
3. **日志审查**：定期审查审计日志，确保 Agent 行为符合预期
4. **数据分类**：识别哪些页面包含敏感数据，避免在这些页面启用 CDP
5. **访问控制**：限制哪些 Agent 可以使用 CDP 功能

## 相关文件

| 文件 | 说明 |
|------|------|
| `extension/background/cdp-safety.js` | 安全过滤 + 审计日志（扩展端） |
| `extension/background/cdp-whitelist.js` | 命令白名单 |
| `extension/background/cdp-event-forwarder.js` | 事件脱敏 + 缓冲 |
| `server/ws-cdp.js` | 服务端认证 + 审计 + 速率限制 |
| `test/cdp-whitelist-safety.test.js` | 安全测试 |
| `test/cdp.test.js` | 集成测试 |
