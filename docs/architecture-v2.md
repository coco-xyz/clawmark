# ClawMark V2 Architecture

> Browser extension + open-source collector + multi-channel distribution

## Overview

ClawMark V2 evolves from an embeddable widget into a **message pipeline** with three layers:

```
┌─────────────┐     ┌─────────────────┐     ┌──────────────────┐
│   Produce   │────▶│     Collect      │────▶│    Distribute    │
│  (Browser   │     │  (ClawMark       │     │  (Channel        │
│   Extension)│     │   Server)        │     │   Adapters)      │
└─────────────┘     └─────────────────┘     └──────────────────┘
  Chrome Web Store    clawmark.coco.xyz       Lark / TG / GitHub
                      or self-hosted          / Slack / Email ...
```

**Key principle:** The extension only produces structured messages. The server collects and stores them. Distribution is handled by pluggable adapters on the server side.

## Layer 1: Produce (Browser Extension)

### What it does

- Injects a lightweight UI overlay on any webpage
- User selects text → floating toolbar appears → comment / create issue / tag
- Captures context: page URL, selected text, DOM position, screenshot
- Sends structured messages to the configured ClawMark server

### Chrome Extension Structure (Manifest V3)

```
extension/
├── manifest.json          # Manifest V3, permissions: activeTab, storage, contextMenus
├── background/
│   └── service-worker.js  # Handles auth state, API calls to server
├── content/
│   ├── inject.js          # Content script — detects text selection, renders overlay
│   └── inject.css         # Minimal styles for floating toolbar + side panel
├── sidepanel/
│   ├── panel.html         # Side panel UI — issue list, comment threads, settings
│   └── panel.js
├── popup/
│   ├── popup.html         # Quick actions + login
│   └── popup.js
└── icons/                 # Extension icons (16/32/48/128)
```

### User Flows

**Flow 1: Quick Comment**
1. User selects text on any webpage
2. Floating toolbar appears: 💬 Comment | 🐛 Issue | 🏷️ Tag
3. Click "Comment" → inline input expands
4. Submit → message sent to server with `{ type: "comment", url, quote, position, content, user }`

**Flow 2: Create Issue**
1. Select text or click extension icon → side panel opens
2. Fill: title, priority, description, optional screenshot
3. Submit → `{ type: "issue", url, title, priority, content, screenshots[], user }`

**Flow 3: Browse & Reply**
1. Click extension icon → side panel shows items for current URL
2. View threads, reply to comments, change issue status
3. If highlight persistence is enabled, previously commented text gets highlighted

### Message Schema (Extension → Server)

```typescript
interface ClawMarkMessage {
  // Identity
  type: "comment" | "issue" | "tag";
  app_id: string;              // project/workspace ID

  // Context
  source_url: string;          // full page URL
  source_title: string;        // page <title>
  quote?: string;              // selected text
  quote_position?: {           // for re-highlighting
    xpath: string;
    startOffset: number;
    endOffset: number;
  };
  screenshots?: string[];      // base64 or uploaded URLs

  // Content
  title?: string;              // required for issues
  content: string;             // user's message
  priority?: "low" | "normal" | "high" | "critical";
  tags?: string[];

  // User
  user: string;                // authenticated user ID
  created_at: string;          // ISO 8601
}
```

## Layer 2: Collect (ClawMark Server)

### What it does

- Receives messages from extension (and any other client)
- Stores in SQLite (existing schema, extended)
- Provides REST API for CRUD operations
- Manages auth (invite codes → expand to OAuth later)
- Hosts the widget JS for backward compatibility (embeddable mode still works)

### Evolution from V1

The existing server already handles most of this. Key changes:

| Aspect | V1 (Current) | V2 |
|--------|-------------|-----|
| Client | Embeddable widget | Browser extension + widget |
| Data model | `doc` = document path | `doc` = any URL or document ID |
| Auth | Invite codes only | Invite codes + API keys + OAuth (later) |
| Multi-tenant | `app_id` in path | Same, plus team/workspace concept |
| Distribution | Single webhook URL | Multiple adapters with routing rules |

### Schema Changes

Add to `items` table:

```sql
ALTER TABLE items ADD COLUMN source_url   TEXT;    -- page URL where item was created
ALTER TABLE items ADD COLUMN source_title TEXT;    -- page title
ALTER TABLE items ADD COLUMN tags         TEXT DEFAULT '[]';  -- JSON array of tags
ALTER TABLE items ADD COLUMN screenshots  TEXT DEFAULT '[]';  -- JSON array of URLs
```

### New API Endpoints

```
POST   /api/v2/items              # Create item (accepts full ClawMarkMessage)
GET    /api/v2/items?url=...      # List items by source URL
GET    /api/v2/items?tag=...      # List items by tag
POST   /api/v2/items/:id/tags     # Add/remove tags
GET    /api/v2/urls               # List all annotated URLs for an app
POST   /api/v2/auth/apikey        # Issue API key for extension
```

Existing V2 endpoints (`/items`, `/items/:id/messages`, etc.) remain unchanged for backward compatibility.

### Deployment

- **Official hosted**: `clawmark.coco.xyz` — managed by COCO
- **Self-hosted**: `npm install && npm start` — anyone can run their own
- Extension settings: server URL defaults to `clawmark.coco.xyz`, user can change to self-hosted

## Layer 3: Distribute (Channel Adapters)

### What it does

- On item events (created, resolved, assigned, etc.), route notifications to external channels
- Each channel = one adapter module
- Routing rules determine which events go where

### Adapter Architecture

```
server/adapters/
├── index.js           # Adapter registry + routing engine
├── webhook.js         # Generic webhook (existing, upgraded)
├── lark.js            # Lark group/bot message
├── telegram.js        # Telegram bot message
├── github-issue.js    # Create/sync GitHub issues
├── slack.js           # Slack webhook/bot
└── email.js           # Email notification
```

Each adapter implements:

```javascript
class Adapter {
  constructor(config) { }

  /** Format and send a notification for the given event. */
  async send(event, item, context) { }

  /** Validate adapter config (called on startup). */
  validate() { return { ok: true }; }
}
```

### Routing Rules (config.json)

```json
{
  "distribution": {
    "rules": [
      {
        "match": { "event": "item.created", "type": "issue", "priority": ["high", "critical"] },
        "channels": ["lark-dev", "telegram-alerts"]
      },
      {
        "match": { "event": "item.created", "type": "comment" },
        "channels": ["lark-feedback"]
      },
      {
        "match": { "event": "item.resolved" },
        "channels": ["webhook-default"]
      }
    ],
    "channels": {
      "lark-dev": {
        "adapter": "lark",
        "webhook_url": "https://open.larksuite.com/open-apis/bot/v2/hook/xxx",
        "template": "issue"
      },
      "telegram-alerts": {
        "adapter": "telegram",
        "bot_token": "...",
        "chat_id": "-100xxx"
      },
      "lark-feedback": {
        "adapter": "lark",
        "webhook_url": "https://open.larksuite.com/open-apis/bot/v2/hook/yyy",
        "template": "comment"
      },
      "webhook-default": {
        "adapter": "webhook",
        "url": "https://your-service/webhook"
      }
    }
  }
}
```

### Message Templates

Each adapter supports templates for formatting:

```
[ClawMark] New issue: {{title}}
Priority: {{priority}} | By: {{user}}
URL: {{source_url}}
---
{{content}}
```

## Migration Path

### Phase 1: Server Upgrade (Week 1-2)
- Add `source_url`, `source_title`, `tags`, `screenshots` columns
- Add `/api/v2/` endpoints
- Build adapter registry + routing engine
- Implement webhook adapter (upgrade existing) + Lark adapter
- **Owner: Lucy**

### Phase 2: Browser Extension MVP (Week 2-4)
- Manifest V3 scaffold
- Content script: text selection → floating toolbar
- Side panel: item list, comment threads
- Background service worker: auth, API calls
- Connect to ClawMark server API
- **Owner: Lucy (frontend) + Jessie (review)**

### Phase 3: Distribution Adapters (Week 3-4)
- Telegram adapter
- GitHub Issue adapter
- Routing rules engine
- Config UI in side panel (admin)
- **Owner: Boot**

### Phase 4: Polish & Launch (Week 4-5)
- Chrome Web Store submission
- clawmark.coco.xyz deployment
- Documentation site
- Existing widget backward compatibility verified
- **Owner: Team**

## Open Questions

1. **Auth evolution** — Invite codes work for MVP. When do we add OAuth / SSO?
2. **Highlight persistence** — Storing DOM positions is fragile (page changes break them). Accept this limitation or invest in robust anchoring (e.g., text fingerprinting)?
3. **Real-time sync** — Extension polls the server, or do we add WebSocket / SSE for live updates?
4. **Offline support** — Queue messages locally when offline and sync when back?
5. **Firefox / Safari** — Chrome first, but Manifest V3 is cross-browser compatible. Timeline for other browsers?

## Relationship to HxA Ecosystem

- **ClawMark Server** = standalone HxA component (open source, independently deployable)
- **Distribution layer** can optionally use **HxA Connect** for channel routing instead of built-in adapters
- **COCO Dashboard** integration: ClawMark items feed into dashboard's issue tracker
- Extension is a **producer** in the HxA message bus architecture
