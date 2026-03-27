# openclaw

Node.js SDK for [ClawMark](https://github.com/coco-xyz/clawmark) Agent Channel — perception events, action dispatch, and real-time WebSocket communication.

## Install

```bash
npm install openclaw ws
```

> `ws` is a peer dependency required for WebSocket action execution. If you only use the HTTP perception API, `ws` is optional.

## Quick Start

```typescript
import { OpenClaw } from 'openclaw';

const claw = new OpenClaw({
  serverUrl: 'https://clawmark.example.com',
  agentKey: 'cmak_xxxxxxxxxxxx', // from POST /api/v2/agent-channel/register
});

// 1. Report errors detected by your agent
await claw.perception.report([
  {
    type: 'runtime-error',
    message: 'TypeError: Cannot read property "x" of undefined',
    fingerprint: 'abc123def456',
    severity: 'error',
    url: 'https://example.com/dashboard',
  },
]);

// 2. Connect to WebSocket and execute browser actions
await claw.actions.connect();

const result = await claw.actions.execute({
  type: 'click',
  target: '#submit-btn',
  timeout: 5000,
});
console.log('Action result:', result);

// 3. Listen for events
claw.on('action:result', (msg) => {
  console.log(`Action ${msg.action_id}: ${msg.status}`);
});

claw.on('disconnected', (code, reason) => {
  console.log(`Disconnected: ${code} ${reason}`);
});

// 4. Clean up
claw.actions.disconnect();
```

## API Reference

### `new OpenClaw(options)`

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `serverUrl` | `string` | Yes | — | ClawMark server URL |
| `agentKey` | `string` | Yes | — | Agent API key (`cmak_` prefix) |
| `timeout` | `number` | No | `10000` | HTTP request timeout (ms) |

### Perception API

#### `claw.perception.report(events)`

Upload perception events to ClawMark.

```typescript
await claw.perception.report([
  {
    type: 'runtime-error',     // runtime-error | network-error | console-error | slow-request | resource-error | long-task
    message: 'Error message',
    stack: 'at App.render ...',
    source: 'app.js',
    line: 42,
    severity: 'error',        // critical | error | warning | info
    url: 'https://example.com',
    fingerprint: 'unique-id',  // required — used for deduplication
    context: { userAgent: 'Chrome/120' },
  },
]);
```

#### `claw.perception.query(options?)`

Query events with cursor-based pagination.

```typescript
const { events, cursor, count } = await claw.perception.query({
  cursor: null,      // from previous response
  limit: 100,        // max 500
  severity: 'error',
  since: '2026-03-01T00:00:00Z',
});
```

#### `claw.perception.stats(limit?)`

Get aggregated error statistics by fingerprint.

```typescript
const { stats } = await claw.perception.stats(50);
// [{ fingerprint, type, message, count, first_seen, last_seen }]
```

#### `claw.perception.issues()`

Get tracked perception issues.

#### `claw.perception.upsertIssue(input)`

Create or update a tracked issue.

```typescript
await claw.perception.upsertIssue({
  fingerprint: 'abc123',
  count: 5,
  gitlab_issue_id: '95',
  gitlab_issue_url: 'https://git.coco.xyz/hxanet/clawmark/-/issues/95',
});
```

### Action API

#### `claw.actions.connect()`

Connect to the Action WebSocket. Auto-reconnects with exponential backoff on disconnect.

#### `claw.actions.disconnect()`

Disconnect from the WebSocket.

#### `claw.actions.execute(request)`

Execute a browser action and wait for the result (returns a Promise).

```typescript
// Click
await claw.actions.execute({ type: 'click', target: '#btn' });

// Type text
await claw.actions.execute({
  type: 'type',
  target: '#input-email',
  value: 'user@example.com',
});

// Navigate
await claw.actions.execute({ type: 'navigate', value: 'https://example.com' });

// Screenshot
const shot = await claw.actions.execute({ type: 'screenshot' });

// Scroll
await claw.actions.execute({
  type: 'scroll',
  target: '#section-3',
  options: { behavior: 'smooth' },
});
```

**Action types:** `click` | `type` | `navigate` | `screenshot` | `scroll` | `form-fill`

### Events

```typescript
claw.on('connected', () => { });
claw.on('disconnected', (code, reason) => { });
claw.on('error', (err) => { });
claw.on('action:queued', (msg) => { });
claw.on('action:result', (msg) => { });
```

### Error Handling

```typescript
import { AuthError, HttpError, RateLimitError, ActionTimeoutError, NotConnectedError } from 'openclaw';

try {
  await claw.perception.report(events);
} catch (err) {
  if (err instanceof AuthError) {
    // Invalid or expired agent key (401)
  } else if (err instanceof RateLimitError) {
    // Too many requests (429)
  } else if (err instanceof HttpError) {
    // Other HTTP error — err.statusCode, err.body
  }
}

try {
  await claw.actions.execute({ type: 'click', target: '#btn', timeout: 3000 });
} catch (err) {
  if (err instanceof ActionTimeoutError) {
    // Action timed out — err.actionId
  } else if (err instanceof NotConnectedError) {
    // WebSocket not connected
  }
}
```

## Authentication

The SDK uses **Agent API Keys** (`cmak_` prefix) for authentication. These are obtained by registering an agent via the ClawMark management API:

```bash
curl -X POST https://clawmark.example.com/api/v2/agent-channel/register \
  -H "Authorization: Bearer $APP_JWT" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent", "capabilities": ["perception", "action"]}'
```

The `api_key` in the response is your `agentKey`. It is only returned once — store it securely.

## Requirements

- Node.js >= 18.0.0
- `ws` >= 8.0.0 (peer dependency, required for WebSocket actions)

## License

MIT
