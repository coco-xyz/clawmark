# Action Protocol Contract

**Issue:** #94 (this contract) — bridges #77 (extension executor) → #78 (server action queue)

## Overview

Defines the protocol for dispatching DOM actions from an AI agent to the ClawMark browser extension and receiving results.

| Role | Component | Location |
|------|-----------|----------|
| **Executor** | `ActionExecutor` content script | `extension/content/action-executor.js` |
| **Element resolver** | `ElementFinder` content script | `extension/content/element-finder.js` |
| **Local queue** | `ActionQueue` background script | `extension/background/action-queue.js` |
| **Dispatcher** | Agent Channel server | `server/` (planned, #78) |

## Action Types

| Type | Risk Level | Description |
|------|-----------|-------------|
| `click` | medium | Click a DOM element (single, double, or context) |
| `type` | medium | Type text into an input, textarea, or contenteditable |
| `navigate` | medium | Navigate to a URL or use back/forward/reload |
| `screenshot` | low | Capture a screenshot of the visible tab or a specific element |
| `scroll` | low | Scroll the page or scroll an element into view |
| `form-fill` | high | Fill multiple form fields in a single action |

Risk levels: `low` (always allowed), `medium` (allowed by default), `high` (requires explicit opt-in — future), `forbidden` (always blocked).

## Action Request Schema

An action request is dispatched from the background service worker to the content script via `chrome.tabs.sendMessage`.

### Message envelope (background → content)

```jsonc
{
  "type": "action:execute",
  "payload": { /* ActionRequest */ }
}
```

### ActionRequest

```jsonc
{
  "actionId": "unique-id-string",  // required, unique identifier
  "type": "click",                 // required, one of the action types above
  "target": "#submit-btn",         // CSS selector or "xpath:..." expression
  "value": "hello world",          // action-specific value (see below)
  "timeout": 5000,                 // optional, element wait timeout in ms (default 5000)
  "options": {}                    // optional, action-specific options (see below)
}
```

### Per-type fields

#### `click`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `target` | `string` | required | Element selector |
| `options.clickType` | `string` | `"single"` | `"single"` \| `"double"` \| `"context"` |
| `options.offsetX` | `number` | center | X offset from element top-left |
| `options.offsetY` | `number` | center | Y offset from element top-left |

#### `type`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `target` | `string` | required | Element selector (input, textarea, or contenteditable) |
| `value` | `string` | `""` | Text to type |
| `options.clearFirst` | `boolean` | `true` | Clear existing value before typing |
| `options.append` | `boolean` | `false` | Append to existing value (overrides clearFirst) |

#### `navigate`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `value` | `string` | required | URL (`https://...`) or special: `"back"`, `"forward"`, `"reload"` |

No `target` needed. Only `http://` and `https://` URLs are accepted.

#### `screenshot`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `target` | `string?` | none | Optional element selector — scrolls element into view before capture |

Screenshot is captured via `chrome.tabs.captureVisibleTab` in the background service worker.

#### `scroll`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `target` | `string?` | none | Scroll element into view (if provided) |
| `options.behavior` | `string` | `"instant"` | `"smooth"` \| `"instant"` |
| `options.position` | `string?` | none | `"top"` \| `"bottom"` (scroll to named position) |
| `options.x` | `number` | `0` | Horizontal scroll offset in pixels |
| `options.y` | `number` | `0` | Vertical scroll offset in pixels |

Priority: `target` > `position` > `x/y` offsets.

#### `form-fill`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `value.fields` | `array` | required | Array of field descriptors |
| `value.fields[].selector` | `string` | required | Element selector |
| `value.fields[].value` | `string \| boolean` | required | Value to set |

Supported field types: text input, textarea, select, checkbox, radio. Password fields are always skipped (returns `skipped: true, reason: "password field"`).

## Action Result Schema

Every action returns a result through `sendResponse`:

```jsonc
{
  "actionId": "unique-id-string",
  "success": true,
  "timestamp": 1711100000000,
  "result": {            // present when success === true
    "durationMs": 42,    // execution time
    // ... action-specific fields below
  },
  "error": "..."         // present when success === false (string)
}
```

### Per-type result fields

| Type | Result fields |
|------|---------------|
| `click` | `{ clicked: true, selector: "..." }` |
| `type` | `{ typed: true, length: 11 }` |
| `navigate` | `{ navigated: "back" }` or `{ navigated: "https://..." }` |
| `screenshot` | `{ dataUrl: "data:image/png;base64,...", timestamp: ... }` |
| `scroll` | `{ scrolledTo: "..." }` or `{ scrolledBy: { x, y } }` |
| `form-fill` | `{ fields: [{ selector, filled, skipped?, reason?, checked? }], count: N }` |

## Element Selector Strategy

`ElementFinder` (`element-finder.js`) resolves selectors with the following strategy:

### Selector formats

| Format | Example | Description |
|--------|---------|-------------|
| CSS selector | `#submit-btn`, `.form > input` | Standard `document.querySelector` |
| XPath | `xpath://div[@id='main']//button` | Prefix with `xpath:`, uses `document.evaluate` |

### Visibility wait

All actions that target an element use `waitForElement()`:

- Polls every **200 ms** for the element to exist and be visible
- Default timeout: **5 000 ms** (overridable per-action via `timeout`)
- Visibility check: `display !== "none"`, `visibility !== "hidden"`, `opacity !== 0`, and non-zero bounding rect
- Rejects with `"Element not found after {timeout}ms: {selector}"` on timeout

## Action Queue (background)

The `ActionQueue` (`action-queue.js`) manages dispatch and history in the background service worker.

### Queue entry (stored in `chrome.storage.local` at key `actions_{tabId}`)

```jsonc
{
  "actionId": "...",
  "type": "click",
  "target": "...",
  "tabId": 123,
  "dispatchedAt": 1711100000000,
  "status": "dispatching",       // → "completed" | "failed"
  "result": { /* ActionResult */ },
  "completedAt": 1711100000042
}
```

### Global history (key `action_history`)

```jsonc
{
  "actionId": "...",
  "type": "click",
  "tabId": 123,
  "success": true,
  "error": null,
  "dispatchedAt": 1711100000000,
  "completedAt": 1711100000042
}
```

### Limits

| Limit | Value |
|-------|-------|
| Max queued actions per tab | 50 |
| Max global history entries | 100 |

Queues are automatically cleared when their tab is closed.

## Server Action Queue (proposed for #78)

The Agent Channel server will accept and dispatch actions via WebSocket, enabling real-time agent-to-browser communication.

### WebSocket message format

#### Server → Extension (action request)

```jsonc
{
  "type": "action:request",
  "payload": {
    "actionId": "server-generated-uuid",
    "type": "click",
    "target": "#submit-btn",
    "value": null,
    "timeout": 5000,
    "options": {}
  }
}
```

#### Extension → Server (action result)

```jsonc
{
  "type": "action:result",
  "payload": {
    "actionId": "server-generated-uuid",
    "success": true,
    "timestamp": 1711100000000,
    "result": { "clicked": true, "selector": "#submit-btn", "durationMs": 42 }
  }
}
```

### REST fallback endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/agent/actions` | Submit an action for execution |
| `GET` | `/api/agent/actions/:id` | Poll action result by ID |
| `GET` | `/api/agent/actions?tabId=&status=` | List actions (filter by tab and status) |

## Error Codes and Handling

| Error | Cause | Recovery |
|-------|-------|----------|
| `"Action not permitted: site not in allowed domains"` | Domain not in allowlist | Add domain to `agentEmbedAllowedDomains` in extension settings |
| `"Unknown action type: {type}"` | Unrecognized action type | Use a supported action type |
| `"Action forbidden: {type}"` | Action risk level is `forbidden` | Cannot be overridden |
| `"ActionExecutor not enabled on this page"` | Feature disabled globally or for this site | Enable `agentActionEnabled` and remove site from `agentActionDisabledSites` |
| `"ElementFinder not loaded"` | Content script load order issue | Ensure `element-finder.js` loads before `action-executor.js` |
| `"Element not found after {timeout}ms: {selector}"` | Element does not exist or is not visible | Verify selector; increase timeout; check page state |
| `"Target is not an input, textarea, or contenteditable: {selector}"` | `type` action on non-editable element | Target a valid input element |
| `"Only http/https URLs are allowed"` | `navigate` with non-http URL | Use http or https scheme |
| `"form-fill requires value.fields array"` | Missing or empty `fields` array | Provide `value.fields` with at least one entry |
| `"Failed to reach content script: {message}"` | Tab closed, script not injected, or extension error | Verify tab is active and content scripts are loaded |

## Security Model

### Domain allowlist

Actions are only executed on pages whose hostname matches the allowlist. Default allowed domains:

- `coco.xyz`, `coco.site`
- `hxa.net`, `hxa.one`
- `clawmark.dev`
- `localhost`

Subdomains are allowed (e.g. `app.coco.xyz` matches `coco.xyz`). The allowlist is configurable via `agentEmbedAllowedDomains` in `chrome.storage.sync`.

### Risk levels

| Level | Behavior |
|-------|----------|
| `low` | Always permitted (screenshot, scroll) |
| `medium` | Permitted by default (click, type, navigate) |
| `high` | Requires explicit per-action opt-in — future implementation (form-fill) |
| `forbidden` | Always blocked, cannot be overridden |

### Additional safeguards

- **Password field protection:** `form-fill` silently skips `type="password"` fields
- **Per-site disable:** Individual sites can be blocked via `agentActionDisabledSites`
- **Global kill switch:** `agentActionEnabled` must be `true` for any action to execute
- **Element visibility gate:** Actions wait for the target element to be visible before interacting, preventing blind interactions with hidden elements

## Versioning

This contract is **v1**. When the action schema changes:

1. Increment the version number.
2. Add a `"contractVersion": 1` field to the action request so the executor can detect format changes.
3. Maintain backward compatibility for at least one minor release cycle.
