# ClawMark

Annotate any web page. Report issues, leave comments, and track feedback — all from a Chrome extension.

ClawMark lets you select text on any website, create annotations (comments or issues), and route them to the right place automatically. Annotations on a GitHub repo page go to that repo's issues. Annotations on a blog go wherever you configure.

## Features

- **Chrome Extension** — Select text → floating toolbar → comment or issue in one click
- **Side Panel** — Browse all annotations for the current page, threaded discussions, tag filtering
- **Smart Routing** — Annotations auto-route to the correct GitHub repo based on the page URL
- **User Routing Rules** — Configure custom URL pattern → target mappings (glob-style: `github.com/org/*`, `*.example.com/**`)
- **Multi-Adapter** — Route to GitHub Issues, Lark, Telegram, or any webhook
- **API Key Auth** — Invite codes for onboarding, API keys for programmatic access

## Install

### Chrome Extension

Download from [Releases](https://github.com/coco-xyz/clawmark/releases) or the Chrome Web Store (coming soon).

1. Download the `.zip` from the latest release
2. Unzip, go to `chrome://extensions`, enable Developer Mode
3. Click "Load unpacked" and select the `extension/` folder
4. Click the extension icon → enter server URL and invite code

### Server

```bash
git clone https://github.com/coco-xyz/clawmark.git
cd clawmark
npm install
cp config.example.json config.json   # edit: set auth codes, adapter config
npm start                             # default port 3462
```

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
└── Popup              — server URL, auth config

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

## License

MIT
