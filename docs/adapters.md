# Distribution Adapters

ClawMark's distribution system routes item events (created, resolved, assigned, etc.) to external channels via configurable adapters. Configure adapters in `config.json` under the `distribution` key.

## Configuration Structure

```json
{
  "distribution": {
    "rules": [...],
    "channels": {...}
  }
}
```

### Rules

Rules determine which events go to which channels. Each rule has a `match` condition and a list of target `channels`.

```json
{
  "match": {
    "event": "item.created",
    "type": "issue",
    "priority": ["high", "critical"]
  },
  "channels": ["telegram-alerts", "lark-dev"]
}
```

**Match fields:**

| Field | Type | Description |
|-------|------|-------------|
| `event` | string | Event type: `item.created`, `item.resolved`, `item.assigned`, `item.closed`, `message.added` |
| `type` | string | Item type: `issue`, `discuss`, `comment` |
| `priority` | string[] | Priority levels: `critical`, `high`, `medium`, `low` |
| `tags` | string[] | Match items with any of these tags |

All match fields are optional. Omitted fields match everything.

### Channels

Named channel configurations that reference an adapter type and its settings.

## Available Adapters

### Webhook

Generic HTTP webhook with optional HMAC signature verification.

```json
{
  "webhook-default": {
    "adapter": "webhook",
    "url": "https://your-service.com/webhook",
    "secret": "optional-hmac-secret",
    "method": "POST"
  }
}
```

**Payload format:** JSON with `event`, `item`, `timestamp` fields. When `secret` is set, requests include an `X-ClawMark-Signature` header (HMAC-SHA256).

### Telegram

Sends notifications to a Telegram chat via Bot API.

```json
{
  "telegram-alerts": {
    "adapter": "telegram",
    "bot_token": "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
    "chat_id": "-100123456789",
    "parse_mode": "HTML",
    "proxy": ""
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `bot_token` | Yes | Telegram Bot API token (from @BotFather) |
| `chat_id` | Yes | Target chat/group/channel ID |
| `parse_mode` | No | `"HTML"` (default) or `"MarkdownV2"` |
| `proxy` | No | HTTP/SOCKS proxy URL for restricted networks |

**Setup:**
1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Get the bot token
3. Add the bot to your target group/channel
4. Get the `chat_id` (use `getUpdates` API or [@userinfobot](https://t.me/userinfobot))

### Lark / Feishu

Sends interactive card messages to a Lark webhook.

```json
{
  "lark-dev": {
    "adapter": "lark",
    "webhook_url": "https://open.larksuite.com/open-apis/bot/v2/hook/YOUR_HOOK_ID"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `webhook_url` | Yes | Lark/Feishu Incoming Webhook URL |

**Setup:**
1. In your Lark group, add a Custom Bot (group settings → Bots → Add Bot)
2. Copy the webhook URL
3. Messages are sent as interactive cards with priority color coding

### GitHub Issue

Creates and syncs GitHub Issues from ClawMark items.

```json
{
  "github-bugs": {
    "adapter": "github-issue",
    "token": "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "repo": "your-org/your-repo",
    "labels": ["clawmark", "bug"],
    "assignees": ["username"]
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `token` | Yes | GitHub Personal Access Token with `repo` scope |
| `repo` | Yes | Target repository in `owner/repo` format |
| `labels` | No | Labels to add to created issues |
| `assignees` | No | GitHub usernames to auto-assign |

**Lifecycle sync:**
- `item.created` → Creates a GitHub Issue
- `item.resolved` → Closes the GitHub Issue
- `item.closed` → Closes the GitHub Issue
- `item.reopened` → Reopens the GitHub Issue

## Example: Full Configuration

```json
{
  "distribution": {
    "rules": [
      {
        "match": { "event": "item.created", "type": "issue", "priority": ["high", "critical"] },
        "channels": ["telegram-alerts", "lark-dev", "github-bugs"]
      },
      {
        "match": { "event": "item.created", "type": "discuss" },
        "channels": ["lark-dev"]
      },
      {
        "match": { "event": "item.resolved" },
        "channels": ["telegram-alerts", "github-bugs"]
      }
    ],
    "channels": {
      "telegram-alerts": {
        "adapter": "telegram",
        "bot_token": "YOUR_BOT_TOKEN",
        "chat_id": "YOUR_CHAT_ID"
      },
      "lark-dev": {
        "adapter": "lark",
        "webhook_url": "YOUR_LARK_WEBHOOK"
      },
      "github-bugs": {
        "adapter": "github-issue",
        "token": "YOUR_GITHUB_TOKEN",
        "repo": "your-org/your-repo",
        "labels": ["clawmark"]
      }
    }
  }
}
```

## Writing Custom Adapters

Create a new file in `server/adapters/` that exports a class with:

```javascript
export class MyAdapter {
  constructor(channelConfig) {
    // channelConfig = the channel object from config.json
  }

  async send(event, item, channelConfig) {
    // event: { type: 'item.created', ... }
    // item: the full item object
    // Return true on success
  }
}
```

Register it in `server/adapters/index.js` by adding to the adapter registry.
