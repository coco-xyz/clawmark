# Deployment Guide

## COCO Environments

ClawMark has two official environments. Extension builds are configured via `scripts/build.sh`.

### Production

| Component | URL |
|-----------|-----|
| API Server | `https://api.coco.xyz/clawmark` |
| Dashboard | `https://labs.coco.xyz/clawmark/dashboard` |
| Google OAuth Client ID | `530440081185-32t15m4gqndq7qab6g57a25i6gfc1gmn.apps.googleusercontent.com` |

```bash
./scripts/build.sh production
```

### Test

| Component | URL |
|-----------|-----|
| API Server | `https://jessie.coco.site/clawmark` |
| Dashboard | `https://jessie.coco.site/clawmark-dashboard/` |
| Google OAuth Client ID | Same as production |

```bash
./scripts/build.sh test
```

### Build Output

Each build generates `extension/config.js` (gitignored) and a zip file:
- `clawmark-v{VERSION}-test.zip`
- `clawmark-v{VERSION}-production.zip`

Both zips are uploaded to GitLab Releases and hosted at `jessie.coco.site/`.

---

# Self-Hosted Deployment Guide

## Quick Start

### Option 1: Docker

```bash
docker run -d \
  -p 3458:3458 \
  -v clawmark-data:/data \
  -v ./config.json:/app/config.json:ro \
  -e CLAWMARK_JWT_SECRET="$(openssl rand -hex 32)" \
  -e CLAWMARK_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  ghcr.io/coco-xyz/clawmark:latest
```

Or build from source:

```bash
git clone https://github.com/coco-xyz/clawmark.git
cd clawmark
docker build -t clawmark .
docker run -d -p 3458:3458 -v clawmark-data:/data \
  -e CLAWMARK_JWT_SECRET="your-secret" \
  clawmark
```

### Docker Compose

```yaml
services:
  clawmark:
    build: .
    ports:
      - "3458:3458"
    volumes:
      - clawmark-data:/data
      - ./config.json:/app/config.json:ro
    environment:
      - CLAWMARK_PORT=3458
      - CLAWMARK_DATA_DIR=/data
      - CLAWMARK_JWT_SECRET=${CLAWMARK_JWT_SECRET}
      - CLAWMARK_ENCRYPTION_KEY=${CLAWMARK_ENCRYPTION_KEY}
    restart: unless-stopped

volumes:
  clawmark-data:
```

### Option 2: Node.js

```bash
git clone https://github.com/coco-xyz/clawmark.git
cd clawmark
npm install
cp server/config.example.json config.json
# Edit config.json — at minimum set auth.jwtSecret
npm start
```

Server runs on `http://localhost:3458` by default.

### Option 3: PM2 (Production)

```bash
npm install -g pm2

# Start with PM2
pm2 start server/index.js --name clawmark

# Save PM2 process list
pm2 save

# Auto-start on boot
pm2 startup
```

## Configuration

### config.json

See `server/config.example.json` for a template. Key fields:

| Field | Required | Description |
|-------|----------|-------------|
| `auth.jwtSecret` | **Yes** | JWT signing secret. Generate: `openssl rand -hex 32` |
| `auth.encryptionKey` | Recommended | AES-256-GCM key for credential encryption. Generate: `openssl rand -hex 32` |
| `port` | No | Server port (default: 3458) |
| `dataDir` | No | Data directory (default: `./data`) |
| `webhook` | No | Global webhook config |
| `distribution` | No | Server-side dispatch rules and channels |

### Environment Variables

Override config.json settings via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAWMARK_PORT` | `3458` | Server port |
| `CLAWMARK_DATA_DIR` | `./data` | SQLite database + uploads directory |
| `CLAWMARK_CONFIG` | `../config.json` | Path to config file |
| `CLAWMARK_JWT_SECRET` | — | JWT signing secret (overrides `auth.jwtSecret`) |
| `CLAWMARK_ENCRYPTION_KEY` | — | Credential encryption key (overrides `auth.encryptionKey`) |
| `CLAWMARK_GOOGLE_CLIENT_ID` | — | Google OAuth client ID |
| `CLAWMARK_GOOGLE_CLIENT_SECRET` | — | Google OAuth client secret |
| `CLAWMARK_WEBHOOK_URL` | — | Webhook endpoint (overrides config) |
| `CLAWMARK_WEBHOOK_SECRET` | — | Webhook HMAC secret |
| `GEMINI_API_KEY` | — | Gemini API key for AI features |
| `NODE_ENV` | `production` | Environment name |

See `.env.example` for a template.

## Authentication

ClawMark uses Google OAuth + JWT authentication (since v0.8.0):

1. User signs in via Google OAuth in the extension or dashboard
2. Server verifies the Google token and issues a JWT
3. All API requests require `Authorization: Bearer <jwt>` or `Authorization: Bearer cmk_<api_key>`

Configure Google OAuth credentials:
- Set `CLAWMARK_GOOGLE_CLIENT_ID` and `CLAWMARK_GOOGLE_CLIENT_SECRET` environment variables
- Or configure in your OAuth provider and pass tokens directly

> **Note:** Invite code authentication was removed in v0.8.0.

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
├── clawmark.db          # SQLite database (items, messages, users, credentials)
└── uploads/             # Uploaded images
```

**Backup:** Copy the entire `data/` directory. SQLite is a single file — stop the server or use `.backup` for consistent snapshots.

## Health Check

```bash
curl http://localhost:3458/health
# Returns: {"status":"ok","version":"0.8.0"}
```

## CORS (Cross-Origin Dashboard)

If the Dashboard is hosted on a different domain than the API (e.g., Dashboard on `labs.coco.xyz`, API on `api.coco.xyz`), add the Dashboard origin to `config.json`:

```json
{
  "allowedOrigins": ["https://labs.coco.xyz"]
}
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
