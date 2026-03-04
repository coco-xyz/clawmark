# ClawMark

**Annotate any web page.** Select text, screenshot, or highlight — then route feedback to GitHub Issues, Lark, Telegram, Slack, or any webhook. One Chrome extension for comments, issues, and smart delivery.

[![GitHub release](https://img.shields.io/github/v/release/coco-xyz/clawmark)](https://github.com/coco-xyz/clawmark/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Why ClawMark

- **One-click annotation** — Select text on any page → floating toolbar → comment or issue, done
- **Smart routing** — Annotate a GitHub page? It auto-routes to that repo. A blog? Wherever you configure
- **9 delivery targets** — GitHub Issues, Lark, Telegram, Slack, Email, Linear, Jira, HxA Connect, Webhook
- **Dashboard** — Browse all annotations for any page, threaded discussions, tag filtering, site management
- **Google login** — One-click sign in, no invite codes needed
- **Open source** — Self-host the server, or use the hosted version

## Quick Start

### Use the Hosted Version

The fastest way — no server setup needed:

1. Install the extension from [Releases](https://github.com/coco-xyz/clawmark/releases) (Chrome Web Store coming soon)
2. Go to `chrome://extensions` → enable Developer Mode → Load unpacked → select `extension/`
3. Click the extension icon → Sign in with Google
4. Start annotating — annotations route to `api.coco.xyz/clawmark` by default

### Self-Host (Open Source)

Run your own ClawMark server:

```bash
git clone https://github.com/coco-xyz/clawmark.git
cd clawmark
npm install
cp config.example.json config.json   # edit: set auth codes, adapter config
npm start                             # default port 3462
```

Then point the extension to your server URL in Settings → Connection.

## How Routing Works

When you annotate a page, ClawMark determines where to send it:

| Priority | Method | Example |
|----------|--------|---------|
| 1 | **User rules** — URL pattern match | `medium.com/**` → `my/reading-notes` |
| 2 | **GitHub auto-detect** — extract org/repo from URL | `github.com/coco-xyz/clawmark/issues/38` → `coco-xyz/clawmark` |
| 3 | **User default** — personal fallback target | Everything else → `my/inbox` |
| 4 | **System default** — config.json fallback | → `coco-xyz/clawmark` |

### Manage Routing Rules

```bash
# Create a rule
curl -X POST https://api.coco.xyz/clawmark/api/v2/routing/rules \
  -H "Authorization: Bearer cmk_..." \
  -H "Content-Type: application/json" \
  -d '{"rule_type":"url_pattern","pattern":"medium.com/**","target_type":"github-issue","target_config":{"repo":"my-org/notes"},"userName":"Kevin"}'

# Test where a URL would route (dry run)
curl -X POST https://api.coco.xyz/clawmark/api/v2/routing/resolve \
  -H "Authorization: Bearer cmk_..." \
  -H "Content-Type: application/json" \
  -d '{"source_url":"https://github.com/hxa-k/hxa-teams/issues/5","userName":"Kevin"}'
```

## API

Base: `/api/v2`

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/items` | GET | Query items (filter by url, tag, status) |
| `/items` | POST | Create annotation |
| `/items/:id` | GET | Get item with messages |
| `/items/:id/messages` | POST | Add comment to thread |
| `/items/:id/resolve` | POST | Mark resolved |
| `/items/:id/close` | POST | Close item |
| `/items/:id/tags` | POST | Add/remove tags |
| `/routing/rules` | GET | List routing rules |
| `/routing/rules` | POST | Create routing rule |
| `/routing/rules/:id` | PUT | Update rule |
| `/routing/rules/:id` | DELETE | Delete rule |
| `/routing/resolve` | POST | Test routing (dry run) |
| `/urls` | GET | List all annotated URLs |
| `/adapters` | GET | List active adapter channels |

Auth: `Authorization: Bearer cmk_...` header or `code` query parameter.

## Adapters

Configure in `config.json` under `distribution`:

| Adapter | Target | Use Case |
|---------|--------|----------|
| `github-issue` | GitHub repo | Create issues from annotations |
| `lark` | Lark group | Send notification cards |
| `telegram` | Telegram chat | Send messages |
| `webhook` | Any URL | Custom integration |

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAWMARK_PORT` | `3462` | Server port |
| `CLAWMARK_DATA_DIR` | `./data` | SQLite database + uploads |
| `CLAWMARK_CONFIG` | `../config.json` | Config file path |

### config.json

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

## Architecture

```
Chrome Extension (Manifest V3)
├── Content Script     — text selection, floating toolbar, input overlay
├── Service Worker     — API client, message routing
├── Side Panel         — item list, discussion threads, filters
└── Options Page       — dashboard, account, delivery rules, site management

Server (Express + SQLite)
├── V2 API             — items CRUD, tags, messages, auth
├── Routing Resolver   — user rules + GitHub auto-detect + defaults
├── Adapter Registry   — multi-channel dispatch (GitHub, Lark, TG, webhook)
└── Database           — items, messages, user_rules, adapter_mappings, api_keys
```

## Development

```bash
npm test              # run all tests (Node.js built-in test runner)
npm start             # start server
```

## Links

- **Website**: [labs.coco.xyz/clawmark](https://labs.coco.xyz/clawmark/)
- **Releases**: [GitHub Releases](https://github.com/coco-xyz/clawmark/releases)
- **Privacy Policy**: [labs.coco.xyz/clawmark/privacy](https://labs.coco.xyz/clawmark/privacy/)
- **Issues**: [GitHub Issues](https://github.com/coco-xyz/clawmark/issues)

## License

MIT
