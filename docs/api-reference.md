# ClawMark API Reference

Base URL: `http://localhost:3458` (or your deployed server URL)

## Authentication

ClawMark supports two auth methods:

### Invite Code
Pass `code` in the request body or query string:
```json
{ "code": "your-invite-code", ... }
```

### API Key (V2)
Pass in the `Authorization` header:
```
Authorization: Bearer cmk_xxxxxxxxxxxxxxxx
```

Create API keys via `POST /api/v2/auth/apikey`.

Read endpoints (`GET`) don't require auth. Write endpoints (`POST`) require either method.

---

## Health & Status

### GET /health

```bash
curl http://localhost:3458/health
```

```json
{
  "status": "ok",
  "version": "2.0.0",
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

## Auth

### POST /verify

Validate an invite code.

```bash
curl -X POST http://localhost:3458/verify \
  -H "Content-Type: application/json" \
  -d '{"code": "team-code-1"}'
```

```json
{ "valid": true, "userName": "Alice" }
```

Rate limit: 10 requests per 15 minutes.

### POST /api/v2/auth/apikey

Create an API key (requires invite code).

```bash
curl -X POST http://localhost:3458/api/v2/auth/apikey \
  -H "Content-Type: application/json" \
  -d '{"code": "team-code-1", "name": "my-extension", "app_id": "default"}'
```

```json
{ "success": true, "key": "cmk_xxxxxxxx", "name": "my-extension", "app_id": "default" }
```

---

## V2 Items API

The primary API. Items represent feedback threads (discussions, issues, comments).

### POST /api/v2/items

Create a new item.

```bash
curl -X POST http://localhost:3458/api/v2/items \
  -H "Content-Type: application/json" \
  -d '{
    "type": "issue",
    "doc": "https://example.com/page",
    "title": "Button not working",
    "content": "The submit button does nothing when clicked",
    "priority": "high",
    "userName": "Alice",
    "source_url": "https://example.com/page",
    "source_title": "Example Page",
    "tags": ["bug", "ui"],
    "screenshots": [],
    "code": "team-code-1"
  }'
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | No | `comment`, `issue`, `discuss` (default: `comment`) |
| `doc` | string | No | Document/URL identifier (defaults to `source_url` or `/`) |
| `title` | string | Issue only | Item title (required for type `issue`) |
| `content` | string | No | Message body |
| `priority` | string | No | `low`, `normal`, `high`, `critical` (default: `normal`) |
| `userName` | string | Yes* | Creator name (*not needed if using API key auth) |
| `source_url` | string | No | Page URL where item was created |
| `source_title` | string | No | Page title |
| `tags` | string[] | No | Tags array |
| `screenshots` | string[] | No | Screenshot URLs |
| `app_id` | string | No | App namespace (default: `default`) |
| `version` | string | No | Document version |
| `quote` | string | No | Selected text |
| `quote_position` | object | No | `{ xpath, startOffset, endOffset }` |

### GET /api/v2/items

List items with optional filters.

```bash
# By document
curl "http://localhost:3458/api/v2/items?doc=/my-page"

# By source URL
curl "http://localhost:3458/api/v2/items?url=https://example.com/page"

# By tag
curl "http://localhost:3458/api/v2/items?tag=bug"

# By status and type
curl "http://localhost:3458/api/v2/items?status=open&type=issue"
```

| Query Param | Description |
|-------------|-------------|
| `url` | Filter by source URL |
| `tag` | Filter by tag |
| `doc` | Filter by document path |
| `type` | Filter by type (`issue`, `discuss`, `comment`) |
| `status` | Filter by status (`open`, `resolved`, `closed`) |
| `assignee` | Filter by assignee name |
| `app_id` | App namespace (default: `default`) |

### GET /api/v2/items/:id

Get a single item with messages.

```bash
curl http://localhost:3458/api/v2/items/item-123
```

### POST /api/v2/items/:id/messages

Add a message to an item thread.

```bash
curl -X POST http://localhost:3458/api/v2/items/item-123/messages \
  -H "Content-Type: application/json" \
  -d '{"content": "I can reproduce this", "userName": "Bob", "code": "team-code-1"}'
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | string | Yes | Message text |
| `role` | string | No | `user` or `assistant` (default: `user`) |
| `userName` | string | No | Sender name |

### POST /api/v2/items/:id/tags

Add or remove tags.

```bash
curl -X POST http://localhost:3458/api/v2/items/item-123/tags \
  -H "Content-Type: application/json" \
  -d '{"add": ["urgent"], "remove": ["low-priority"], "code": "team-code-1"}'
```

### POST /api/v2/items/:id/assign

Assign an item to someone.

```bash
curl -X POST http://localhost:3458/api/v2/items/item-123/assign \
  -H "Content-Type: application/json" \
  -d '{"assignee": "Bob", "code": "team-code-1"}'
```

### POST /api/v2/items/:id/resolve

Mark an item as resolved.

### POST /api/v2/items/:id/close

Close an item.

### POST /api/v2/items/:id/reopen

Reopen a closed/resolved item.

### GET /api/v2/urls

List all annotated URLs for an app.

```bash
curl "http://localhost:3458/api/v2/urls?app_id=default"
```

```json
{ "urls": ["https://example.com/page1", "https://example.com/page2"] }
```

### GET /api/v2/adapters

List distribution adapter channels and status.

```bash
curl http://localhost:3458/api/v2/adapters
```

```json
{ "channels": { "telegram-alerts": { "type": "telegram", "ok": true } }, "rules": 2 }
```

---

## V1 Items API (Legacy)

Same functionality as V2 but without V2-specific fields (source_url, tags, screenshots) and no API key auth. All routes support both flat and namespaced paths.

| Flat Path | Namespaced Path | Method | Description |
|-----------|-----------------|--------|-------------|
| `/items` | `/api/clawmark/:app/items` | GET | List items |
| `/items` | `/api/clawmark/:app/items` | POST | Create item |
| `/items/:id` | `/api/clawmark/:app/items/:id` | GET | Get item |
| `/items/:id/messages` | `/api/clawmark/:app/items/:id/messages` | POST | Add message |
| `/items/:id/assign` | `/api/clawmark/:app/items/:id/assign` | POST | Assign |
| `/items/:id/resolve` | `/api/clawmark/:app/items/:id/resolve` | POST | Resolve |
| `/items/:id/verify` | `/api/clawmark/:app/items/:id/verify` | POST | Verify |
| `/items/:id/reopen` | `/api/clawmark/:app/items/:id/reopen` | POST | Reopen |
| `/items/:id/close` | `/api/clawmark/:app/items/:id/close` | POST | Close |
| `/items/:id/respond` | `/api/clawmark/:app/items/:id/respond` | POST | AI respond |
| `/items-full` | `/api/clawmark/:app/items-full` | GET | Items with messages |

---

## Discussion API (Legacy)

File-based discussion system (pre-V2). Still functional for backward compatibility.

| Path | Method | Description |
|------|--------|-------------|
| `/discussions?doc=...` | GET | Get discussions for a document |
| `/discussions` | POST | Create discussion or add message |
| `/discussions/resolve` | POST | Resolve/reopen discussion |
| `/respond` | POST | AI response to discussion |
| `/submit-reply` | POST | Admin reply |
| `/pending` | GET | List pending discussions |

---

## Upload

### POST /upload

Upload an image (max 5MB, image formats only).

```bash
curl -X POST http://localhost:3458/upload \
  -F "image=@screenshot.png"
```

```json
{ "success": true, "url": "/images/1709123456-abc123.png" }
```

Rate limit: 10 uploads per minute.

---

## Queue

### GET /queue

Get open and in-progress items sorted by priority.

```bash
curl http://localhost:3458/queue
```

---

## Rate Limits

| Category | Limit |
|----------|-------|
| Read endpoints (GET) | 120 req/min |
| Write endpoints (POST) | 30 req/min |
| Upload | 10 req/min |
| Verify | 10 req/15 min |

Rate limit headers are included in responses (`RateLimit-*`).
