# Self-Hosted Deployment Guide

## Quick Start

### Option 1: Node.js

```bash
git clone https://github.com/coco-xyz/clawmark.git
cd clawmark
npm install
cp server/config.example.json config.json
# Edit config.json with your settings
npm start
```

Server runs on `http://localhost:3458` by default.

### Option 2: PM2 (Production)

```bash
npm install -g pm2

# Start with PM2
pm2 start server/index.js --name clawmark -- --config ./config.json

# Save PM2 process list
pm2 save

# Auto-start on boot
pm2 startup
```

## Environment Variables

Override config.json settings via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAWMARK_PORT` | `3458` | Server port |
| `CLAWMARK_DATA_DIR` | `./data` | SQLite database + uploads directory |
| `CLAWMARK_CONFIG` | `../config.json` | Path to config file |
| `CLAWMARK_ENV` | `production` | Environment name (`production`, `staging`) |
| `CLAWMARK_WEBHOOK_URL` | — | Webhook endpoint (overrides config) |
| `CLAWMARK_WEBHOOK_SECRET` | — | Webhook HMAC secret |
| `CLAWMARK_INVITE_CODES_JSON` | — | JSON invite codes (overrides config) |

## Reverse Proxy (Caddy)

```
clawmark.example.com {
    reverse_proxy localhost:3458
}
```

## Reverse Proxy (Nginx)

```nginx
server {
    listen 443 ssl;
    server_name clawmark.example.com;

    location / {
        proxy_pass http://localhost:3458;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Data & Backups

All data is stored in the `dataDir` directory:

```
data/
├── clawmark.db          # SQLite database (items, messages, users)
└── uploads/             # Uploaded images
```

**Backup:** Copy the entire `data/` directory. SQLite is a single file — stop the server or use `.backup` for consistent snapshots.

## Health Check

```bash
curl http://localhost:3458/health
# Returns: {"status":"ok","version":"2.0.0"}
```

## Authentication

ClawMark uses an invite code system. Configure codes in `config.json`:

```json
{
  "auth": {
    "type": "invite-code",
    "codes": {
      "team-code-1": "Alice",
      "team-code-2": "Bob",
      "guest-code": "Guest"
    }
  }
}
```

Each code maps to a display name. Users enter the code in the widget or extension popup to authenticate.

## Multi-Tenant Mode

Serve multiple apps from one server using path-based routing:

```
/api/clawmark/:app/items    → Items for specific app
/items                       → Items using default app ID
```

The `app` parameter isolates data per application. Configure the widget with matching `app` values:

```javascript
const cm = new ClawMark({ api: 'https://clawmark.example.com', app: 'my-app' });
```

## Monitoring

### PM2

```bash
pm2 monit           # Real-time monitoring
pm2 logs clawmark   # View logs
pm2 status          # Process status
```

### Log Output

The server logs to stdout. Use PM2 log management or redirect to a file:

```bash
pm2 start server/index.js --name clawmark --log /var/log/clawmark.log
```
