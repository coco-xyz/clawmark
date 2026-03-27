# Session Data Format Contract

**Issue:** #93 (this contract) — bridges #72 (extension recording) → #73 (server storage)

## Overview

Defines the data format for user session recordings captured by the ClawMark extension and consumed by the server-side Agent Channel.

| Role | Component | Location |
|------|-----------|----------|
| **Producer** | `SessionRecorder` content script | `extension/content/session-recorder.js` |
| **Filter** | `PrivacyFilter` content script | `extension/content/privacy-filter.js` |
| **Local store** | `SessionStorage` background script | `extension/background/session-storage.js` |
| **Forwarder** | `SessionForwarder` background script | `extension/background/session-forwarder.js` |
| **Consumer** | Agent Channel server API | `server/index.js` (POST/GET `/api/v2/agent-channel/sessions`) |

## Session Event Types

```
navigation   Page lifecycle: session start/end, popstate, hashchange, visibility change
click        User click on a DOM element
input        User text entry into a form field
scroll       Scroll position change (throttled to 500 ms)
snapshot     DOM context capture (page-load, user-pause, error, navigation)
error        JavaScript runtime error or unhandled promise rejection
```

## Event Schema

Every event shares a common envelope:

```jsonc
{
  "type": "<event-type>",   // one of the types above
  "timestamp": 1711100000000, // Date.now() at capture
  "data": { /* per-type shape below */ }
}
```

### `navigation` data

| Field | Type | Present | Description |
|-------|------|---------|-------------|
| `action` | `string` | always | `"session-start"` \| `"session-end"` \| `"visibility-change"` \| `"popstate"` \| `"hashchange"` |
| `url` | `string` | start, popstate, hashchange | Sanitized page URL |
| `title` | `string` | start, popstate | `document.title` |
| `referrer` | `string` | start | Sanitized referrer (empty string if none) |
| `viewport` | `{ width, height }` | start | Window inner dimensions |
| `reason` | `string` | end | `"idle-timeout"` \| `"navigation"` \| `"disabled"` |
| `duration` | `number` | end | Session duration in ms |
| `eventCount` | `number` | end | Total events recorded in session |
| `hidden` | `boolean` | visibility-change | `document.hidden` value |

### `click` data

| Field | Type | Description |
|-------|------|-------------|
| `selector` | `string` | Privacy-safe CSS selector path (max 5 levels) |
| `tag` | `string` | Lowercase tag name of target element |
| `text` | `string` | Masked visible text (first 50 chars) |
| `href` | `string?` | Sanitized link URL (present only on anchor elements) |
| `x` | `number` | `clientX` coordinate |
| `y` | `number` | `clientY` coordinate |

### `input` data

| Field | Type | Description |
|-------|------|-------------|
| `selector` | `string` | Privacy-safe CSS selector path |
| `tag` | `string` | `"input"` or `"textarea"` |
| `inputType` | `string` | HTML input type (e.g. `"text"`, `"email"`) |
| `name` | `string` | Field name attribute |
| `value` | `string` | Masked value (max 200 chars); `"••••"` if sensitive |
| `masked` | `boolean` | `true` if the value was fully masked |

### `scroll` data

| Field | Type | Description |
|-------|------|-------------|
| `x` | `number` | `window.scrollX` |
| `y` | `number` | `window.scrollY` |
| `maxY` | `number` | `document.documentElement.scrollHeight` |
| `viewportHeight` | `number` | `window.innerHeight` |

### `snapshot` data

| Field | Type | Description |
|-------|------|-------------|
| `trigger` | `string` | `"page-load"` \| `"user-pause"` \| `"error"` \| `"navigation"` |
| `html` | `string` | Sanitized HTML fragment (max 50 000 chars) |
| `url` | `string` | Sanitized page URL at snapshot time |
| `title` | `string` | `document.title` |
| `selector` | `string` | CSS selector of trigger element (empty for page-level) |

### `error` data

| Field | Type | Description |
|-------|------|-------------|
| `message` | `string` | Masked error message (max 300 chars) |
| `source` | `string?` | Source filename (runtime errors only) |
| `line` | `number?` | Line number (runtime errors only) |
| `col` | `number?` | Column number (runtime errors only) |
| `type` | `string?` | `"unhandled-rejection"` for promise rejections |

## Batch Format

Events are dispatched from the content script to the background service worker in batches (every 5 s or 50 events, whichever comes first).

```jsonc
{
  "sessionId": "1711100000000-a1b2c3d4",
  "startTime": 1711100000000,
  "url": "https://example.com/page",
  "events": [
    { "type": "...", "timestamp": ..., "data": { ... } }
  ]
}
```

Internal message envelope (content → background):

```jsonc
{ "type": "session:batch", "payload": <batch> }
```

## Server Upload Flow (#61 Phase 2)

The `SessionForwarder` background script bridges local session data to the server:

1. **First batch** → `POST /api/v2/agent-channel/sessions` (creates server session, returns `id`)
2. **Subsequent batches** → `POST /api/v2/agent-channel/sessions` with `session_id` (appends events)
3. **Session end** → `POST /api/v2/agent-channel/sessions/:id/finalize`

The forwarder only uploads when: (a) user is authenticated, (b) at least one agent is bound, and (c) the server URL matches the trusted origin.

Server-side, session updates are pushed to bound agents via WebSocket (`type: "session"`) with the `session` scope.

## Privacy Rules

All data passes through `PrivacyFilter` before leaving the content script.

### Input masking

| Rule | Detection | Result |
|------|-----------|--------|
| Password fields | `type="password"` | Value replaced with `"••••"` |
| Sensitive field names | Name/id/autocomplete/aria-label matching `/^(password\|passwd\|pass\|pwd\|ssn\|social.?security\|credit.?card\|card.?number\|cvv\|cvc\|ccv\|expir\|secret\|token\|api.?key)$/i` | Value replaced with `"••••"` |

### Text masking

| Rule | Pattern | Result |
|------|---------|--------|
| Credit card numbers | 13-19 digit sequences (with optional spaces/dashes) | Replaced with `"••••"` |
| Email addresses | Standard email pattern | Local part replaced with `"••••"`, domain preserved (e.g. `"••••@example.com"`) |

### URL sanitization

Query parameters matching `/^(token\|key\|secret\|password\|passwd\|auth\|code\|session\|access_token\|refresh_token\|api_key\|apikey\|credential\|sig\|signature)$/i` are replaced with `[REDACTED]`.

### Selector sanitization

CSS selector paths are built bottom-up (max 5 ancestor levels), using tag name + first two class names. Stops early at an `id`. No sensitive attribute values are included.

### Snapshot sanitization

- Sensitive input values inside snapshots are masked
- Hidden input values are replaced with `"••••"`
- `data-*` attributes matching `email|phone|user|token|password|secret` are set to `[REDACTED]`
- HTML truncated to 50 000 characters

## Local Storage Format

Managed by `session-storage.js` in the background service worker.

### Keys

| Key pattern | Value |
|-------------|-------|
| `session_{tabId}_{sessionId}` | Full session object |
| `session_index_{tabId}` | Index mapping `sessionId` → metadata |

### Session object (stored)

```jsonc
{
  "sessionId": "...",
  "tabId": 123,
  "startTime": 1711100000000,
  "url": "https://...",
  "events": [],       // non-snapshot events
  "snapshots": [],    // snapshot events (stored separately)
  "lastUpdate": 1711100005000
}
```

### Index entry

```jsonc
{
  "startTime": 1711100000000,
  "lastUpdate": 1711100005000,
  "url": "https://...",
  "eventCount": 42,
  "snapshotCount": 3
}
```

### Limits

| Limit | Value |
|-------|-------|
| Max events per session | 2 000 (oldest trimmed) |
| Max snapshots per session | 50 (oldest trimmed) |
| Max sessions per tab | 10 (oldest evicted) |
| Session idle timeout | 30 minutes → new session |
| Snapshot rate limit | 10 per minute |

Sessions are automatically cleared when their tab is closed.

## Server Storage API (proposed for #73)

The Agent Channel server will expose REST endpoints for upstream session storage. The extension will forward batches when connected.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/agent/sessions` | Upload a session batch |
| `GET` | `/api/agent/sessions` | List sessions (query: `?tabId=`, `?since=`, `?limit=`) |
| `GET` | `/api/agent/sessions/:id/events` | Retrieve full event list for a session |

### `POST /api/agent/sessions` request body

Same as the batch format above, with an additional `tabId` field:

```jsonc
{
  "sessionId": "...",
  "tabId": 123,
  "startTime": 1711100000000,
  "url": "https://...",
  "events": []
}
```

### `GET /api/agent/sessions` response

```jsonc
{
  "sessions": [
    {
      "sessionId": "...",
      "tabId": 123,
      "startTime": 1711100000000,
      "lastUpdate": 1711100005000,
      "url": "https://...",
      "eventCount": 42,
      "snapshotCount": 3
    }
  ]
}
```

### `GET /api/agent/sessions/:id/events` response

```jsonc
{
  "sessionId": "...",
  "events": [],
  "snapshots": []
}
```

## Versioning

This contract is **v1**. When the event schema changes:

1. Increment the version number.
2. Add a `"contractVersion": 1` field to the batch envelope so consumers can detect format changes.
3. Maintain backward compatibility for at least one minor release cycle.
