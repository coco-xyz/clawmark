# ClawMark Production Deployment Guide

> **Audience:** DevOps team (Daniel / Owen)
> **Version:** ClawMark v0.8.0+
> **Last updated:** 2026-03-09

---

## 1. Environment Overview

ClawMark has two environments. **Production is owned by the DevOps team and must not be touched by Boot or other agents.**

| | Test | Production |
|---|---|---|
| **API URL** | `https://jessie.coco.site/clawmark` | `https://api.coco.xyz/clawmark` |
| **Dashboard** | `https://jessie.coco.site/clawmark-dashboard/` | `https://labs.coco.xyz/clawmark/dashboard` |
| **PM2 name** | `clawmark-test` | `clawmark` |
| **Port** | 3459 | Managed by DevOps (typically 3458) |
| **Owner** | Boot / Jessie (test only) | **DevOps team (Daniel / Owen)** |
| **Ext zip** | `clawmark-v{VERSION}-test.zip` | `clawmark-v{VERSION}-production.zip` |
| **Purpose** | Pre-release validation, staging E2E | Live users |

> ⚠️ **Governance rule:** `api.coco.xyz` is DevOps-managed. Boot is authorised to deploy to test (`jessie.coco.site`) only. Any production deploy must go through Daniel or Owen.

---

## 2. Pre-Upgrade Checklist

Before starting a production upgrade, confirm:

- [ ] The release tag exists on GitLab: `git.coco.xyz/hxanet/clawmark/-/releases`
- [ ] The **production** zip has been downloaded and verified (see §6)
- [ ] Staging E2E gate passed on the develop→main MR
- [ ] v0.8.0+ upgrade: `CLAWMARK_JWT_SECRET` and `CLAWMARK_ENCRYPTION_KEY` are set (see §4)
- [ ] Database backup taken (see §5)
- [ ] Rollback plan ready (see §7)

---

## 3. Upgrade Flow

### 3.1 Find the Release

1. Go to: `https://git.coco.xyz/hxanet/clawmark/-/releases`
2. Select the target version tag (e.g. `v0.8.0`)
3. Download the server package — see §6 for which zip to use

### 3.2 Deploy Steps (Node.js / PM2)

```bash
# 1. Stop the server gracefully
pm2 stop clawmark

# 2. Back up current data
cp -r /opt/clawmark/data /opt/clawmark/data.bak.$(date +%Y%m%d-%H%M%S)

# 3. Pull latest code (or deploy from zip — see §6)
cd /opt/clawmark
git fetch origin
git checkout main
git pull origin main

# 4. Install production dependencies only
npm install --omit=dev

# 5. Run database migrations (if any — see §4.3)
# Migrations run automatically on server start since v0.7.0.
# No manual migration step required.

# 6. Restart server
pm2 restart clawmark --update-env

# 7. Verify health
curl -sf https://api.coco.xyz/clawmark/health
```

### 3.3 Deploy Steps (Docker)

```bash
# 1. Pull new image
docker pull ghcr.io/coco-xyz/clawmark:v0.8.0

# 2. Back up data volume
docker run --rm -v clawmark-data:/data -v $(pwd):/backup \
  alpine tar czf /backup/data.bak.$(date +%Y%m%d).tar.gz /data

# 3. Stop and replace container
docker compose down
# Update image tag in docker-compose.yml, then:
docker compose up -d

# 4. Verify health
curl -sf https://api.coco.xyz/clawmark/health
```

---

## 4. Configuration Management

### 4.1 Required Environment Variables (v0.8.0+)

| Variable | Required | Description |
|----------|----------|-------------|
| `CLAWMARK_JWT_SECRET` | **REQUIRED** | JWT signing secret. Server refuses to start if missing. |
| `CLAWMARK_ENCRYPTION_KEY` | **REQUIRED** | AES-256-GCM key for credential encryption at rest. |
| `CLAWMARK_GOOGLE_CLIENT_ID` | Required for auth | Google OAuth client ID. |
| `CLAWMARK_GOOGLE_CLIENT_SECRET` | Required for auth | Google OAuth client secret. |
| `CLAWMARK_PORT` | Optional | Default: `3458` |
| `CLAWMARK_DATA_DIR` | Optional | Default: `./data` |
| `CLAWMARK_WEBHOOK_URL` | Optional | Webhook endpoint |
| `CLAWMARK_WEBHOOK_SECRET` | Optional | Webhook HMAC secret |
| `GEMINI_API_KEY` | Optional | AI routing / classification features |

### 4.2 Generating Secrets

```bash
# JWT secret (64 hex chars)
openssl rand -hex 32

# Encryption key (64 hex chars)
openssl rand -hex 32
```

> ⚠️ **These secrets must be stable across deploys.** Rotating `CLAWMARK_JWT_SECRET` invalidates all existing user sessions. Rotating `CLAWMARK_ENCRYPTION_KEY` invalidates all encrypted credentials in the database.

Store secrets in your secrets manager (Vault / AWS SSM / 1Password) — **not in the repo or .env files committed to git.**

### 4.3 Database Migrations

ClawMark uses SQLite with automatic schema migrations.

- Migrations run **automatically on server start** (since v0.7.0)
- No manual `migrate` command is needed
- Migration status is logged to stdout on startup:
  ```
  [db] migration: dispatch_log cleanup — skipped (already applied)
  ```
- If a migration fails, the server will log the error and exit — check logs before declaring success

### 4.4 v0.8.0 Breaking Change: JWT Auth

**This is a breaking change for users upgrading from v0.7.x or earlier.**

| Before v0.8.0 | v0.8.0+ |
|---|---|
| Invite codes supported (`auth.codes`) | Invite codes removed |
| Anonymous access allowed on some endpoints | All endpoints require JWT |
| `auth.jwtSecret` optional | `auth.jwtSecret` **mandatory** (server won't start without it) |

**Upgrade action:** Ensure `CLAWMARK_JWT_SECRET` is set before restarting. Existing users will need to re-authenticate via Google OAuth after upgrade.

---

## 5. Backup & Data

All persistent data is in the `dataDir` (default: `./data`):

```
data/
├── clawmark.db       # SQLite — all items, messages, users, credentials
└── uploads/          # Uploaded images
```

### Backup Procedure

```bash
# Option A: Simple copy (stop server first for consistency)
pm2 stop clawmark
cp -r ./data ./data.bak.$(date +%Y%m%d-%H%M%S)
pm2 start clawmark

# Option B: SQLite hot backup (no downtime)
sqlite3 ./data/clawmark.db ".backup './data.bak.$(date +%Y%m%d-%H%M%S)/clawmark.db'"
```

**Recommended:** Run an automated daily backup before any upgrade.

---

## 6. Dual Zip: Test vs Production (GL#35)

Each release tag includes **two extension zips**:

| Zip | Points to | Use for |
|-----|-----------|---------|
| `clawmark-v{VERSION}-test.zip` | `https://jessie.coco.site/clawmark` | QA / staging validation |
| `clawmark-v{VERSION}-production.zip` | `https://api.coco.xyz/clawmark` | Chrome Web Store upload |

**Important:**
- The zips differ only in their embedded API URL (`extension/config.js`)
- **Always upload the `-production.zip` to Chrome Web Store** — the test zip points to the wrong server
- Both zips are uploaded to the GitLab Release artifacts automatically by CI
- Download from: `https://git.coco.xyz/hxanet/clawmark/-/releases/v{VERSION}`

### Build Locally (if needed)

```bash
./scripts/build.sh production   # generates clawmark-v{VERSION}-production.zip
./scripts/build.sh test         # generates clawmark-v{VERSION}-test.zip
```

---

## 7. Rollback Plan

### Rollback to Previous Version

```bash
# 1. Stop current server
pm2 stop clawmark

# 2. Restore data backup (if DB migrations ran)
cp -r ./data.bak.YYYYMMDD-HHMMSS ./data

# 3. Checkout previous version tag
git checkout v0.7.1   # substitute target version

# 4. Reinstall dependencies
npm install --omit=dev

# 5. Restart
pm2 restart clawmark --update-env

# 6. Verify
curl -sf https://api.coco.xyz/clawmark/health
```

> ⚠️ **Downgrade warning:** Rolling back after v0.8.0 DB migrations may leave the database in a state incompatible with older server code. Always restore from backup when rolling back across major versions.

---

## 8. Health Checks

### API Health Endpoint

```bash
curl https://api.coco.xyz/clawmark/health
# Expected: {"status":"ok","version":"0.8.0"}
```

### Additional Checks After Deploy

```bash
# Auth endpoint reachable
curl -I https://api.coco.xyz/clawmark/auth/google

# Dashboard loads
curl -I https://labs.coco.xyz/clawmark/dashboard

# PM2 process status
pm2 status clawmark

# Recent logs (look for errors / migration output)
pm2 logs clawmark --lines 50
```

### Monitoring

```bash
pm2 monit              # Real-time CPU / memory
pm2 logs clawmark      # Tail logs
```

---

## 9. Quick Reference

```
Release page:   https://git.coco.xyz/hxanet/clawmark/-/releases
Production API: https://api.coco.xyz/clawmark
Dashboard:      https://labs.coco.xyz/clawmark/dashboard
Health check:   GET /health → {"status":"ok","version":"X.Y.Z"}
PM2 name:       clawmark
Data dir:       ./data (SQLite + uploads)
```

---

## Related Docs

- [Deployment (self-hosted)](deployment.md)
- [Release process](release-process.md)
- [Architecture](architecture-v2.md)
- [API reference](api-reference.md)
