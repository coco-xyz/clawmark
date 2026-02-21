# ClawMark

AI-native feedback & collaboration widget for web applications. Drop it into any page to enable:

- **Annotate** — Pin numbered markers on the page, screenshot, and submit as issues
- **Text Feedback** — Quick issue submission with priority, images, and text selection quotes
- **Document Comments** — Select text to start discussions (Google Docs-style), with resolve/reopen and optional AI edit
- **Issue Tracking** — Built-in issue panel with status workflow (open → assigned → resolved → verified)

## Quick Start

### 1. Start the server

```bash
npm install
cp server/config.example.json config.json  # edit as needed
npm start
```

### 2. Add to your page

```html
<script type="module">
  import ClawMark from 'https://your-server/widget/index.js';

  const cm = new ClawMark({
    api:  'http://localhost:3458',
    app:  'my-app',
    user: 'guest'
  });

  cm.use(ClawMark.Fab);                     // floating action button
  cm.use(ClawMark.Comment, {                 // document comments
    contentSelector: '.article-content'
  });
  cm.mount();
</script>
```

## Architecture

```
ClawMark
├── Core (headless)          — API client, event bus, plugin registry
├── Fab Plugin               — FAB button, annotation, issue submit/panel
└── Comment Plugin           — Text selection, discussion threads, AI edit
```

**Headless core** — no UI of its own. All UI is provided by plugins.

**Plugin system** — `cm.use(Plugin, options)` registers plugins that are instantiated on `mount()`. Plugins communicate through the event bus, not direct coupling.

**Unified data model** — Both annotations/issues (from Fab) and document comments (from Comment) are stored as "items" with a shared schema (type, status, messages).

## Server API

The server provides two API versions:

- **V2 Items API** (`/items`) — Canonical CRUD for items (discussions + issues) with SQLite storage
- **V1 Discussions API** (`/discussions`) — JSON-file based, maintained for backward compatibility

Multi-tenant support via `/api/clawmark/:app/items` path prefix.

### Webhooks

Configure outbound webhooks in `config.json` to receive notifications on item events:

```json
{
  "webhook": {
    "url": "https://your-service/webhook",
    "events": ["item.created", "item.resolved"],
    "secret": "your-secret"
  }
}
```

## Configuration

### Server (environment variables)

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAWMARK_PORT` | `3458` | Server port |
| `CLAWMARK_DATA_DIR` | `./data` | Database and upload directory |
| `CLAWMARK_CONFIG` | `../config.json` | Config file path |
| `CLAWMARK_WEBHOOK_URL` | — | Webhook endpoint |
| `CLAWMARK_INVITE_CODES_JSON` | — | JSON map of invite codes |

### Widget options

**ClawMark core:**
| Option | Default | Description |
|--------|---------|-------------|
| `api` | `/api/doc-discuss` | Server base URL |
| `app` | `_product` | App/product ID |
| `user` | `null` | Initial username |
| `theme` | `dark` | `'dark'` or `'light'` |

**Comment plugin:**
| Option | Default | Description |
|--------|---------|-------------|
| `contentSelector` | `'body'` | CSS selector for commentable content |
| `highlight` | `true` | Highlight discussed text inline |
| `aiEdit` | `true` | Show AI edit button on resolved comments |

## License

MIT
