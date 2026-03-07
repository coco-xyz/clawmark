# ClawMark API Reference

Base URL: `http://localhost:3458` (or your deployed server URL)

## Authentication

Since v0.8.0, **all API endpoints require authentication**. ClawMark supports two methods:

### Google OAuth → JWT

1. User authenticates via Google OAuth (extension or dashboard)
2. Server returns a JWT token
3. Pass the JWT in all subsequent requests:

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

### API Key

For programmatic access, create an API key via the dashboard or API:

```
Authorization: Bearer cmk_xxxxxxxxxxxxxxxx
```

> **Note:** Invite code authentication was removed in v0.8.0. All requests now require JWT or API key.

---

## Health & Status

### GET /health

```bash
curl http://localhost:3458/health
```

```json
{
  "status": "ok",
  "version": "0.8.0",
  "uptime": 3600.5,
  "db_ok": true,
  "adapters": 2
}
```

### GET /stats

```bash
curl http://localhost:3458/stats?doc=/my-page
```

Returns item counts by status for a given document.

---

## Auth Endpoints

### POST /api/v2/auth/google

Exchange a Google ID token or auth code for a JWT.

```bash
# ID token flow (Chrome extension)
curl -X POST http://localhost:3458/api/v2/auth/google \
  -H "Content-Type: application/json" \
  -d '{"id_token": "eyJhbGciOi..."}'

# Auth code flow (web dashboard)
curl -X POST http://localhost:3458/api/v2/auth/google \
  -H "Content-Type: application/json" \
  -d '{"code": "4/0AX4XfWh..."}'
```

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": { "email": "user@example.com", "name": "User Name" }
}
```

### POST /api/v2/auth/apikey

Create an API key (requires JWT).

```bash
curl -X POST http://localhost:3458/api/v2/auth/apikey \
  -H "Authorization: Bearer eyJhbG..." \
  -H "Content-Type: application/json" \
  -d '{"name": "my-extension"}'
```

```json
{ "success": true, "key": "cmk_xxxxxxxx", "name": "my-extension" }
```

---

## V2 Items API

The primary API. Items represent feedback threads (discussions, issues, comments).

All V2 endpoints require `Authorization: Bearer <jwt_or_api_key>`.

### POST /api/v2/items

Create a new item.

```bash
curl -X POST http://localhost:3458/api/v2/items \
  -H "Authorization: Bearer cmk_..." \
  -H "Content-Type: application/json" \
  -d '{
    "type": "issue",
    "doc": "https://example.com/page",
    "title": "Button not working",
    "content": "The submit button does nothing when clicked",
    "priority": "high",
    "source_url": "https://example.com/page",
    "source_title": "Example Page",
    "tags": ["bug", "ui"],
    "screenshots": []
  }'
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | No | `comment`, `issue`, `discuss` (default: `comment`) |
| `doc` | string | No | Document/URL identifier (defaults to `source_url` or `/`) |
| `title` | string | Issue only | Item title (required for type `issue`) |
| `content` | string | No | Message body |
| `priority` | string | No | `low`, `normal`, `high`, `critical` (default: `normal`) |
| `source_url` | string | No | Page URL where item was created |
| `source_title` | string | No | Page title |
| `tags` | string[] | No | Tags array |
| `screenshots` | string[] | No | Screenshot URLs |
| `app_id` | string | No | App namespace (default: user's app_id) |
| `version` | string | No | Document version |
| `quote` | string | No | Selected text |
| `quote_position` | object | No | `{ xpath, startOffset, endOffset }` |

### GET /api/v2/items

List items with optional filters.

```bash
# By source URL
curl -H "Authorization: Bearer cmk_..." \
  "http://localhost:3458/api/v2/items?url=https://example.com/page"

# By tag
curl -H "Authorization: Bearer cmk_..." \
  "http://localhost:3458/api/v2/items?tag=bug"

# By status and type
curl -H "Authorization: Bearer cmk_..." \
  "http://localhost:3458/api/v2/items?status=open&type=issue"
```

| Query Param | Description |
|-------------|-------------|
| `url` | Filter by source URL |
| `tag` | Filter by tag |
| `doc` | Filter by document path |
| `type` | Filter by type (`issue`, `discuss`, `comment`) |
| `status` | Filter by status (`open`, `resolved`, `closed`) |
| `assignee` | Filter by assignee name |
| `app_id` | App namespace |

### GET /api/v2/items/:id

Get a single item with messages.

### POST /api/v2/items/:id/messages

Add a message to an item thread.

```bash
curl -X POST http://localhost:3458/api/v2/items/item-123/messages \
  -H "Authorization: Bearer cmk_..." \
  -H "Content-Type: application/json" \
  -d '{"content": "I can reproduce this"}'
```

### POST /api/v2/items/:id/tags

Add or remove tags.

```bash
curl -X POST http://localhost:3458/api/v2/items/item-123/tags \
  -H "Authorization: Bearer cmk_..." \
  -H "Content-Type: application/json" \
  -d '{"add": ["urgent"], "remove": ["low-priority"]}'
```

### POST /api/v2/items/:id/assign

Assign an item.

### POST /api/v2/items/:id/resolve

Mark as resolved.

### POST /api/v2/items/:id/close

Close an item.

### POST /api/v2/items/:id/reopen

Reopen a closed/resolved item.

---

## Routing API

### GET /api/v2/routing/rules

List user's routing rules.

### POST /api/v2/routing/rules

Create a routing rule.

```bash
curl -X POST http://localhost:3458/api/v2/routing/rules \
  -H "Authorization: Bearer cmk_..." \
  -H "Content-Type: application/json" \
  -d '{"rule_type":"url_pattern","pattern":"medium.com/**","target_type":"github-issue","target_config":{"repo":"my-org/notes"}}'
```

### PUT /api/v2/routing/rules/:id

Update a routing rule.

### DELETE /api/v2/routing/rules/:id

Delete a routing rule.

### POST /api/v2/routing/resolve

Test routing (dry run).

```bash
curl -X POST http://localhost:3458/api/v2/routing/resolve \
  -H "Authorization: Bearer cmk_..." \
  -H "Content-Type: application/json" \
  -d '{"source_url":"https://github.com/coco-xyz/clawmark/issues/5"}'
```

---

## Credentials API

### GET /api/v2/credentials

List user's stored credentials (metadata only, secrets redacted).

### POST /api/v2/credentials

Store a credential.

### DELETE /api/v2/credentials/:id

Delete a credential.

---

## Other Endpoints

### GET /api/v2/urls

List all annotated URLs.

### GET /api/v2/adapters

List distribution adapter channels and status.

### GET /api/v2/dispatch-log

Query dispatch history.

### POST /upload

Upload an image (max 5MB, image formats only). Requires auth.

---

## V1 Items API (Deprecated)

> **Deprecated since v0.8.0.** Sunset date: 2026-06-01. Migrate to V2 API.

V1 endpoints now require JWT authentication (same as V2). Responses include `Deprecation` and `Sunset` headers.

| Flat Path | Namespaced Path | Method | Description |
|-----------|-----------------|--------|-------------|
| `/items` | `/api/clawmark/:app/items` | GET | List items |
| `/items` | `/api/clawmark/:app/items` | POST | Create item |
| `/items/:id` | `/api/clawmark/:app/items/:id` | GET | Get item |
| `/items/:id/messages` | `/api/clawmark/:app/items/:id/messages` | POST | Add message |
| `/items/:id/resolve` | `/api/clawmark/:app/items/:id/resolve` | POST | Resolve |
| `/items/:id/close` | `/api/clawmark/:app/items/:id/close` | POST | Close |
| `/items/:id/reopen` | `/api/clawmark/:app/items/:id/reopen` | POST | Reopen |

---

## Rate Limits

| Category | Limit |
|----------|-------|
| Read endpoints (GET) | 120 req/min |
| Write endpoints (POST) | 30 req/min |
| Upload | 10 req/min |
| AI endpoints | 15 req/min |

Rate limit headers are included in responses (`RateLimit-*`).
