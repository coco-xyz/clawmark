# ClawMark

**Annotate any webpage. Route feedback anywhere.**

Select text, capture a screenshot, or highlight anything on any page — then send it to GitHub Issues, Lark, Telegram, Slack, or any webhook. One Chrome extension for comments, issues, and smart delivery.

[![Version](https://img.shields.io/badge/version-0.6.9-blue)](https://git.coco.xyz/hxanet/clawmark/-/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## What it does

- **Annotate anything** — select text or take a screenshot on any page, add a comment or raise an issue in seconds
- **Smart routing** — on a GitHub page? auto-routes to that repo. Everywhere else, your rules decide
- **Multi-channel dispatch** — send to GitHub Issues, Lark, Telegram, Slack, or any webhook
- **Web dashboard** — browse all annotations, manage delivery rules, view activity stats
- **Google login** — sign in instantly, no invite codes

---

## Quick Start

### Use the hosted version

No server setup needed:

1. Download the latest `.zip` from [Releases](https://git.coco.xyz/hxanet/clawmark/-/releases)
2. Go to `chrome://extensions` → enable **Developer Mode** → **Load unpacked** → select the `extension/` folder
3. Click the ClawMark icon → **Sign in with Google**
4. Start annotating — annotations go to `api.coco.xyz/clawmark` by default

### Self-host

Run your own server:

```bash
git clone https://git.coco.xyz/hxanet/clawmark.git
cd clawmark
npm install
cp config.example.json config.json   # configure auth + delivery
npm start                             # listens on port 3462
```

Then open the extension → Settings → Connection and point it to your server URL.

---

## How Routing Works

When you annotate a page, ClawMark picks where to send it:

| Priority | Rule | Example |
|----------|------|---------|
| 1 | **Your URL rules** — pattern match | `medium.com/**` → `my/reading-notes` |
| 2 | **GitHub auto-detect** — extract repo from URL | `github.com/coco-xyz/clawmark` → `coco-xyz/clawmark` |
| 3 | **Your default** — personal fallback | everything else → `my/inbox` |
| 4 | **System default** — config.json fallback | → configured repo |

Manage rules from the extension's **Settings** tab or via API:

```bash
# Create a routing rule
curl -X POST https://api.coco.xyz/clawmark/api/v2/routing/rules \
  -H "Authorization: Bearer cmk_..." \
  -H "Content-Type: application/json" \
  -d '{"rule_type":"url_pattern","pattern":"medium.com/**","target_type":"github-issue","target_config":{"repo":"my-org/notes"},"userName":"Kevin"}'

# Test where a URL would route
curl -X POST https://api.coco.xyz/clawmark/api/v2/routing/resolve \
  -H "Authorization: Bearer cmk_..." \
  -H "Content-Type: application/json" \
  -d '{"source_url":"https://github.com/coco-xyz/clawmark/issues/5","userName":"Kevin"}'
```

---

## Dashboard

The web dashboard (`/dashboard`) has three tabs:

- **Overview** — account info, connection status, annotation stats, recent activity
- **Settings** — auth credentials for delivery channels, delivery rules management
- **About** — version info, update guide, project links

---

## Delivery Adapters

Configure under `distribution.channels` in `config.json`:

### GitHub Issues

```json
{
  "my-github": {
    "adapter": "github-issue",
    "token": "ghp_...",
    "repo": "owner/repo",
    "labels": ["clawmark"]
  }
}
```

Lifecycle sync: `item.created` → opens issue · `item.resolved` / `item.closed` → closes it · `item.reopened` → reopens it.

### Lark / Feishu

```json
{
  "lark-dev": {
    "adapter": "lark",
    "webhook_url": "https://open.larksuite.com/open-apis/bot/v2/hook/YOUR_HOOK_ID"
  }
}
```

### Telegram

```json
{
  "telegram-alerts": {
    "adapter": "telegram",
    "bot_token": "123456:ABC...",
    "chat_id": "-100123456789"
  }
}
```

### Webhook

```json
{
  "my-webhook": {
    "adapter": "webhook",
    "url": "https://your-service.com/hook",
    "secret": "optional-hmac-secret"
  }
}
```

HMAC-SHA256 signature sent as `X-ClawMark-Signature` when `secret` is set.

### Routing rules

```json
{
  "distribution": {
    "rules": [
      {
        "match": { "event": "item.created", "type": "issue", "priority": ["high", "critical"] },
        "channels": ["telegram-alerts", "lark-dev", "my-github"]
      }
    ],
    "channels": { ... }
  }
}
```

Match fields: `event`, `type` (`issue` / `discuss` / `comment`), `priority`, `tags`. All optional — omit to match everything.

See [docs/adapters.md](docs/adapters.md) for full reference.

---

## API Reference

Base URL: `/api/v2` · Auth: `Authorization: Bearer cmk_...`

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/items` | GET | List annotations (filter by url, tag, status) |
| `/items` | POST | Create annotation |
| `/items/:id` | GET | Get item + thread |
| `/items/:id/messages` | POST | Add comment |
| `/items/:id/resolve` | POST | Mark resolved |
| `/items/:id/close` | POST | Close |
| `/items/:id/tags` | POST | Add / remove tags |
| `/routing/rules` | GET | List routing rules |
| `/routing/rules` | POST | Create rule |
| `/routing/rules/:id` | PUT | Update rule |
| `/routing/rules/:id` | DELETE | Delete rule |
| `/routing/resolve` | POST | Test routing (dry run) |
| `/urls` | GET | List annotated URLs |
| `/adapters` | GET | List active adapter channels |

Full reference: [docs/api-reference.md](docs/api-reference.md)

---

## Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAWMARK_PORT` | `3462` | Server port |
| `CLAWMARK_DATA_DIR` | `./data` | SQLite database + file uploads |
| `CLAWMARK_CONFIG` | `../config.json` | Config file path |

### config.json structure

```json
{
  "port": 3462,
  "auth": {
    "codes": { "my-code": "MyName" }
  },
  "distribution": {
    "rules": [
      { "match": { "event": "item.created" }, "channels": ["my-github"] }
    ],
    "channels": {
      "my-github": {
        "adapter": "github-issue",
        "token": "ghp_...",
        "repo": "owner/repo",
        "labels": ["clawmark"]
      }
    }
  }
}
```

---

## Architecture

```
Chrome Extension (Manifest V3)
├── content/        Text selection, floating toolbar, screenshot capture
├── background/     Service worker — API client, message routing
├── sidepanel/      Annotation list, discussion threads, filters
└── options/        Dashboard (Overview / Settings / About)

Server (Express + SQLite)
├── V2 API          Items CRUD, tags, messages, auth
├── Routing engine  URL pattern rules + GitHub auto-detect + defaults
├── Adapter system  Multi-channel dispatch (GitHub, Lark, Telegram, webhook)
└── Database        items, messages, user_rules, adapter_mappings, api_keys
```

---

## Development

```bash
npm test    # run all tests (Node.js built-in test runner)
npm start   # start server (port 3462)
```

Extension: load unpacked from `extension/` in `chrome://extensions`.

### Dashboard

The web dashboard is a vanilla JS SPA built with Vite. The base path is configurable via `VITE_BASE_PATH`:

```bash
cd dashboard

# Local development (default base: /clawmark-dashboard/)
npm run dev

# Build for labs.coco.xyz (uses .env.production default: /clawmark/dashboard/)
npm run build

# Build for a custom base path
VITE_BASE_PATH=/my/path/ npm run build
```

Deploy by copying `dashboard/dist/` to the target server's web root.

### Test Environment

For local testing or staging deployments:

```bash
# 1. Server — use a separate config and data dir
cp server/config.example.json config.test.json
# Edit config.test.json: set port, auth, Google OAuth credentials
CLAWMARK_PORT=13458 CLAWMARK_DATA_DIR=./data-test CLAWMARK_CONFIG=./config.test.json node server/index.js

# 2. Dashboard — build with test base path
cd dashboard
VITE_BASE_PATH=/clawmark-test/dashboard/ npm run build
# Deploy dist/ to test server

# 3. Extension — point to test server
# Edit extension/config.js: set serverUrl to your test server URL
```

**Key config differences by environment:**

| Setting | Production | Test/Staging |
|---------|-----------|-------------|
| `CLAWMARK_PORT` | 3462 | 13458 (or any free port) |
| `CLAWMARK_DATA_DIR` | `./data` | `./data-test` (isolated DB) |
| Google OAuth Client ID | Production client ID | Test client ID (same or separate) |
| `VITE_BASE_PATH` | `/clawmark/dashboard/` | `/clawmark-test/dashboard/` |
| Extension `serverUrl` | `https://api.coco.xyz/clawmark` | `https://your-test-host/api/clawmark-test` |

**Important:** Test and production environments must use separate data directories to avoid data contamination. Google OAuth credentials must match the environment's redirect URI configuration in Google Cloud Console.

---

## Links

- **Releases**: [git.coco.xyz/hxanet/clawmark/-/releases](https://git.coco.xyz/hxanet/clawmark/-/releases)
- **Issues**: [git.coco.xyz/hxanet/clawmark/-/issues](https://git.coco.xyz/hxanet/clawmark/-/issues)
- **Website**: [labs.coco.xyz/clawmark](https://labs.coco.xyz/clawmark/)
- **Privacy Policy**: [labs.coco.xyz/clawmark/privacy](https://labs.coco.xyz/clawmark/privacy/)
- **GitHub mirror**: [github.com/coco-xyz/clawmark](https://github.com/coco-xyz/clawmark)

---

## License

[MIT](LICENSE)
