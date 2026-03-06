# ClawMark

**Annotate any webpage. Route feedback anywhere.**

ClawMark is a Chrome extension + backend service combo. Select text, take screenshots, or highlight anything on any page — add annotations and automatically dispatch them to GitHub Issues, Lark, Telegram, Slack, or any webhook.

[![Version](https://img.shields.io/badge/version-0.8.0-blue)](https://git.coco.xyz/hxanet/clawmark/-/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[中文文档](README.zh.md)

---

## Key Features

- **Annotate anything** — select text or take a screenshot, create annotations or issues in seconds
- **Smart routing** — auto-detects GitHub repos from URLs; other pages follow your custom rules
- **Multi-channel dispatch** — GitHub Issues, GitLab Issues, Lark, Telegram, Slack, email, webhooks, and more
- **Web dashboard** — browse annotations, manage delivery rules, view activity stats
- **Google login** — one-click sign-in with JWT authentication

---

## Directory Structure

```
clawmark/
├── server/                  Backend service (Express + SQLite)
│   ├── index.js             Entry point — config loading, HTTP server
│   ├── db.js                Database initialization and migrations
│   ├── auth.js              Google OAuth + JWT authentication
│   ├── crypto.js            AES-256-GCM credential encryption
│   ├── routing.js           URL rule matching + GitHub auto-detection
│   ├── target-declaration.js  Dispatch target declarations
│   ├── ai.js                AI-assisted features
│   ├── adapters/            Dispatch adapters
│   │   ├── github-issue.js  GitHub Issues
│   │   ├── gitlab-issue.js  GitLab Issues
│   │   ├── lark.js          Lark / Feishu
│   │   ├── telegram.js      Telegram
│   │   ├── slack.js         Slack
│   │   ├── email.js         Email
│   │   ├── webhook.js       Generic webhook
│   │   ├── hxa-connect.js   HxA Connect
│   │   ├── jira.js          Jira
│   │   ├── linear.js        Linear
│   │   └── index.js         Adapter registry
│   └── config.example.json  Configuration template
├── extension/               Chrome extension (Manifest V3)
│   ├── manifest.json        Extension manifest
│   ├── background/          Service Worker — API communication, message routing
│   ├── content/             Content Script — text selection, floating toolbar, screenshots
│   ├── sidepanel/           Side panel — annotation list, discussion threads, filters
│   ├── popup/               Browser action popup
│   ├── options/             Settings page
│   └── config.js            Build-time environment config (gitignored)
├── dashboard/               Web dashboard (Vite SPA)
│   └── src/                 Frontend source
├── scripts/                 Build and ops scripts
│   ├── build.sh             Build script (supports test / production environments)
│   ├── release.sh           Release script
│   └── encrypt-credentials.js  Credential encryption utility
├── widget/                  Embeddable widget (for third-party pages)
├── docs/                    Project documentation
├── test/                    Test suite (Node.js built-in test runner)
├── config.json              Server config (gitignored)
├── CHANGELOG.md             Changelog
└── CONTRIBUTING.md          Contributing guide
```

---

## Quick Start

### Prerequisites

- Node.js >= 18
- npm
- Chrome browser (for loading the extension)

### Local Development

```bash
# 1. Clone the repository
git clone https://git.coco.xyz/hxanet/clawmark.git
cd clawmark

# 2. Install dependencies
npm install
cd dashboard && npm install && cd ..

# 3. Create the config file
cp server/config.example.json config.json
# Edit config.json — at minimum set jwtSecret (see "Configuration" section below)

# 4. Start the backend
npm start
# Server listens on http://localhost:3458 by default

# 5. Load the Chrome extension
# Open chrome://extensions → enable "Developer mode" → "Load unpacked" → select the extension/ directory

# 6. Build the dashboard (optional)
cd dashboard && npm run build && cd ..
# Build output in dashboard/dist/
```

### Running Tests

```bash
npm test    # Runs all tests (Node.js built-in test runner)
```

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAWMARK_PORT` | `3458` | Server port |
| `CLAWMARK_DATA_DIR` | `./data` | Data directory (SQLite database + file uploads) |
| `CLAWMARK_CONFIG` | `../config.json` | Config file path |

### config.json

Server configuration is managed via `config.json`. Create one from the template:

```bash
cp server/config.example.json config.json
```

Key fields:

```jsonc
{
  "port": 3458,                       // Server port (can also be set via CLAWMARK_PORT)
  "dataDir": "./data",                // Data directory (can also be set via CLAWMARK_DATA_DIR)
  "auth": {
    "jwtSecret": "<random-string>",   // JWT signing secret (required, recommend 64-char hex)
    "encryptionKey": "<32-byte-hex>", // Credential encryption key (recommended, 64-char hex = 32 bytes)
  },
  "webhook": {                        // Global webhook (optional)
    "url": "",
    "events": ["item.created", "item.resolved", "item.assigned"],
    "secret": ""
  },
  "distribution": {                   // Dispatch rules and channels (optional)
    "rules": [...],
    "channels": {...}
  }
}
```

#### Configuration Reference

| Field | Required | Description |
|-------|----------|-------------|
| `auth.jwtSecret` | Yes | JWT signing secret. Required for API authentication — all V1/V2 endpoints require JWT. Generate with `openssl rand -hex 32` |
| `auth.encryptionKey` | Recommended | AES-256-GCM encryption key (32 bytes hex). Encrypts third-party credentials (GitHub tokens, etc.) at rest. Without it, credentials are stored in plaintext. Generate with `openssl rand -hex 32` |
| `port` | No | Server port, defaults to 3458 |
| `dataDir` | No | Data storage path, defaults to `./data` |
| `webhook` | No | Global webhook configuration |
| `distribution` | No | Server-side dispatch rules and channel configuration |

---

## Deployment

### Environment Differences

| Item | Test | Production |
|------|------|------------|
| Backend URL | `jessie.coco.site/clawmark` | `api.coco.xyz/clawmark` |
| Dashboard | `jessie.coco.site/clawmark-dashboard/` | `labs.coco.xyz/clawmark/dashboard` |
| Port | 3459 | 3458 |
| Data directory | `./data-staging` | `./data` |
| Config file | `config.staging.json` | `config.json` |
| PM2 process | `clawmark-staging` | `clawmark-server` |

### Deployment Steps

```bash
# Build extension + dashboard (test or production)
./scripts/build.sh production

# Start/restart the backend
pm2 start server/index.js --name clawmark-server
# or
pm2 restart clawmark-server
```

### Extension Distribution

The build script generates `clawmark-v{version}-{env}.zip` for:
- Chrome Web Store upload
- GitLab Release asset downloads
- Developer mode sideloading

---

## API Overview

### Authentication

Starting from v0.8.0, all API endpoints require JWT authentication (including previously unauthenticated V1 endpoints).

Authentication flow:
1. User signs in via Google OAuth to obtain a JWT
2. Include `Authorization: Bearer <jwt_token>` in requests
3. The extension also supports API Key authentication: `Authorization: Bearer cmk_...`

### Main Endpoints

Base path: `/api/v2`

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/auth/google` | POST | Google OAuth login, returns JWT |
| `/items` | GET | List annotations (filter by url, tag, status) |
| `/items` | POST | Create annotation |
| `/items/:id` | GET | Get annotation details + discussion thread |
| `/items/:id/messages` | POST | Add comment |
| `/items/:id/resolve` | POST | Mark as resolved |
| `/items/:id/close` | POST | Close |
| `/items/:id/tags` | POST | Add/remove tags |
| `/routing/rules` | GET/POST | List/create routing rules |
| `/routing/rules/:id` | PUT/DELETE | Update/delete routing rules |
| `/routing/resolve` | POST | Test routing match (dry run) |
| `/urls` | GET | List annotated URLs |
| `/adapters` | GET | List active dispatch channels |
| `/credentials` | GET/POST/DELETE | Manage user credentials |
| `/dispatch-log` | GET | Query dispatch logs |

Full reference: [docs/api-reference.md](docs/api-reference.md)

---

## Routing Rules

When an annotation is created, ClawMark determines the dispatch target by priority:

| Priority | Rule | Example |
|----------|------|---------|
| 1 | **User URL rules** — regex/wildcard matching | `medium.com/**` → `my/reading-notes` |
| 2 | **GitHub auto-detect** — extract repo from URL | `github.com/coco-xyz/clawmark` → `coco-xyz/clawmark` |
| 3 | **User default** — personal fallback target | Everything else → `my/inbox` |
| 4 | **System default** — config.json fallback | → configured default repo |

---

## Dispatch Adapters

The following dispatch channels are supported, configurable via `distribution.channels` in `config.json` or by adding credentials in the dashboard:

| Adapter | Description |
|---------|-------------|
| `github-issue` | GitHub Issues (lifecycle sync: create/close/reopen) |
| `gitlab-issue` | GitLab Issues |
| `lark` | Lark / Feishu webhook |
| `telegram` | Telegram Bot |
| `slack` | Slack webhook |
| `email` | Email |
| `webhook` | Generic webhook (supports HMAC-SHA256 signature) |
| `hxa-connect` | HxA Connect message bus |
| `jira` | Jira |
| `linear` | Linear |

Detailed configuration reference: [docs/adapters.md](docs/adapters.md)

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
