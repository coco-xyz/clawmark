# Technical Design: Data Isolation & Delivery Authorization

**Issue**: GitLab #188 (data isolation) + delivery permission problem
**Author**: jessie-coco
**Status**: Draft — pending review
**Date**: 2026-03-04

---

## 1. Problem Statement

### 1.1 Data Isolation (#188)

All users share `app_id = 'default'`. Any authenticated user can read/write all items in the system regardless of who created them.

**Root cause**: The `items` table uses `app_id` for multi-tenancy, but:
- JWT auth (`type: 'jwt'`) doesn't carry `app_id` — queries fall through to `'default'`
- GET `/api/v2/items` accepts `app_id` as a query parameter with no ownership check
- POST `/api/v2/items` allows `app_id` override from request body

**Current data on test server** (jessie.coco.site/clawmark):
| User | Items | app_id |
|------|-------|--------|
| freefacefly@gmail.com (Kevin) | 113 | default |
| jessie@coco.xyz | 5 | default |
| voyax3@gmail.com | 1 | default |
| Others (Boot/Lucy/Demo) | ~4 | default |

All 123 items visible to everyone.

### 1.2 Delivery Authorization

When a user configures a delivery rule to an external repo (e.g., `voyax/bcat`), the dispatch system falls back to the server's default GitHub token if the user didn't provide their own. This token doesn't have access to the user's repo → 403 → dispatch marked as `exhausted`.

Additionally, label creation failure (403) causes the entire dispatch to fail, even if the issue was created successfully.

**Root cause** (adapters/index.js L254-262): Token inheritance mechanism — `_dispatchSingleTarget()` searches registered adapter channels for a matching token type and reuses the admin's token.

---

## 2. Design

### 2.1 Data Isolation — User-Scoped Queries

**Principle**: Every data query is scoped to the authenticated user. No cross-user data access unless explicitly shared via org membership.

#### 2.1.1 Auth → user_id Binding

Current auth middleware (`v2Auth`) already extracts user identity:
- JWT: `req.v2Auth.user = payload.email`
- API Key: `req.v2Auth.app_id = apiKey.app_id`, `req.v2Auth.user = apiKey.created_by`

**Change**: For JWT auth, auto-resolve `app_id` from the user's apps:

```javascript
// v2Auth middleware addition
if (payload) {
    const userApps = itemsDb.getAppsByUser(payload.userId);
    const defaultApp = userApps.find(a => a.is_default) || userApps[0];
    req.v2Auth = {
        type: 'jwt',
        user: payload.email,
        userId: payload.userId,
        role: payload.role,
        app_id: defaultApp?.id || null  // null = needs app creation
    };
}
```

#### 2.1.2 Auto-Provisioning

On first login (Google OAuth), if the user has no apps:
1. Create an app with `id = uuid`, `name = "<email>'s workspace"`, `user_id = userId`
2. Create an API key bound to that `app_id`
3. Set `is_default = 1`

This happens in the `/api/v2/auth/google` handler after user upsert.

#### 2.1.3 API Endpoint Changes

| Endpoint | Current | After |
|----------|---------|-------|
| `GET /api/v2/items` | `app_id` from query param | `app_id` from `req.v2Auth.app_id` (ignore query param) |
| `POST /api/v2/items` | `app_id` from body or auth | `app_id` from `req.v2Auth.app_id` only |
| `GET /api/v2/items/:id` | No ownership check | Verify `item.app_id === req.v2Auth.app_id` |
| `PUT /api/v2/items/:id` | No ownership check | Verify `item.app_id === req.v2Auth.app_id` |
| `DELETE /api/v2/items/:id` | No ownership check | Verify `item.app_id === req.v2Auth.app_id` |
| `GET /api/v2/items/stats` | `app_id` from query | `app_id` from `req.v2Auth.app_id` |
| `GET /api/v2/routing/rules` | By `userName` param | By `req.v2Auth.user` |
| `POST /api/v2/routing/rules` | `userName` from body | `req.v2Auth.user` only |
| `GET /api/v2/endpoints` | By `req.v2Auth.user` | No change (already correct ✓) |
| `GET /api/v2/dispatch/log` | No user filter | Filter by `item.app_id` |

**Key rule**: Never trust client-supplied `app_id` or `userName`. Always derive from auth token.

#### 2.1.4 Data Migration

Existing items need correct `app_id` assignment:

```sql
-- Step 1: Create apps for existing users
INSERT INTO apps (id, user_id, name, is_default, created_at, updated_at)
SELECT
    lower(hex(randomblob(16))),
    u.id,
    u.email || '''s workspace',
    1,
    datetime('now'),
    datetime('now')
FROM users u
WHERE u.id NOT IN (SELECT user_id FROM apps);

-- Step 2: Reassign items by created_by email → user's app_id
UPDATE items SET app_id = (
    SELECT a.id FROM apps a
    JOIN users u ON a.user_id = u.id
    WHERE u.email = items.created_by
    AND a.is_default = 1
)
WHERE created_by IN (SELECT email FROM users);

-- Step 3: Reassign orphan items (created_by not in users) → keep as 'default'
-- These will only be visible to admin
```

#### 2.1.5 Screenshots / Uploads Isolation

Currently screenshots are stored at `/data/images/<timestamp>-<random>.png` with no user scoping.

**Change**: Store as `/data/images/<app_id>/<filename>`. Serve with ownership check:
- `GET /images/:filename` → check if file belongs to requesting user's app_id

For existing files: keep in place, add a lookup table or embed app_id in metadata.

### 2.2 Delivery Authorization — User-Owned Tokens

**Principle**: The server never uses its own credentials to deliver to user-specified targets. Users must provide their own tokens.

#### 2.2.1 Remove Token Inheritance

Delete the fallback logic in `adapters/index.js` L254-262:

```javascript
// REMOVE THIS BLOCK:
if (target_type === 'github-issue' && !config.token) {
    for (const [, adapter] of this.channels) {
        if (adapter.type === 'github-issue' && adapter.token) {
            config.token = adapter.token;
            break;
        }
    }
}
```

Replace with validation:

```javascript
if (!config.token && !config.webhook_url && !config.api_key) {
    throw new Error(`No credentials provided for ${target_type}. User must configure their own token.`);
}
```

#### 2.2.2 Token Validation on Rule Save

When a user creates/updates a delivery rule, validate the provided credentials:

```javascript
// POST /api/v2/routing/rules — add validation step
async function validateDeliveryCredentials(target_type, target_config) {
    switch (target_type) {
        case 'github-issue': {
            // Test: can we create issues in this repo?
            const res = await fetch(`https://api.github.com/repos/${target_config.repo}`, {
                headers: { Authorization: `Bearer ${target_config.token}` }
            });
            if (!res.ok) throw new Error(`GitHub token cannot access ${target_config.repo}`);
            const repo = await res.json();
            if (!repo.permissions?.push) throw new Error(`Token lacks write access to ${target_config.repo}`);
            return true;
        }
        case 'linear': {
            // Test Linear API key
            const res = await fetch('https://api.linear.app/graphql', {
                method: 'POST',
                headers: { Authorization: target_config.api_key, 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: '{ viewer { id } }' })
            });
            if (!res.ok) throw new Error('Linear API key is invalid');
            return true;
        }
        // Webhook types (slack, lark, telegram) — skip validation (no reliable test)
        default:
            return true;
    }
}
```

Return clear error to user if validation fails, so they know to fix their token.

#### 2.2.3 Server Token Scope

The server's default GitHub token (in `config.distribution.channels`) is ONLY used for:
- System-level notifications (e.g., posting to `coco-xyz/clawmark` issues)
- Static distribution rules defined in config

It is **never** used for user-initiated delivery. This boundary is enforced by the dispatch method:
- `method: 'user_rule'` or `method: 'user_default'` → user's token required
- `method: 'system_default'` → server token allowed (but only to configured system repos)
- `method: 'github_auto'` → user's token required (since target is derived from browsed URL)

#### 2.2.4 Label Creation — Best-Effort

Change the GitHub adapter to treat label operations as non-fatal:

```javascript
// adapters/github-issue.js
async send(event, item, context) {
    // 1. Create issue (required — fail if this fails)
    const issue = await this.createIssue(item);

    // 2. Add labels (best-effort — log warning, don't throw)
    try {
        await this.addLabels(issue.number, this.config.labels);
    } catch (labelErr) {
        console.warn(`[github-issue] Label creation failed (non-fatal): ${labelErr.message}`);
        // Don't throw — issue was created successfully
    }

    return { external_id: issue.number, external_url: issue.html_url };
}
```

---

## 3. Migration Plan

### Phase 1: Data Isolation (P0 — security fix)

1. **DB migration**: Add `is_default` column to `apps` table. Create apps for existing users. Reassign items.
2. **Auth middleware**: Resolve `app_id` from user's apps for JWT auth.
3. **API hardening**: All endpoints use `req.v2Auth.app_id` — ignore client-supplied values.
4. **Extension update**: Remove `app_id` from request payloads (server derives it).
5. **Test**: Verify user A cannot see user B's items.

### Phase 2: Delivery Auth (P1 — functional fix)

1. **Remove token inheritance** in adapter registry.
2. **Add credential validation** on rule create/update.
3. **Label best-effort**: GitHub adapter catches label errors without failing dispatch.
4. **UI update**: Delivery rule form requires token field for external targets.
5. **Test**: Create rule to external repo with invalid token → should reject. Valid token → should succeed.

### Phase 3: Credential Security (P2 — hardening)

1. Encrypt `target_config` and endpoint `config` at rest (AES-256-GCM, key from env var).
2. Implement token rotation / expiry tracking.
3. Audit log for credential access.

---

## 4. Affected Files

| File | Changes |
|------|---------|
| `server/auth.js` | Auto-provision app on first login |
| `server/index.js` | All item/rule/stats endpoints use `req.v2Auth.app_id` |
| `server/db.js` | Migration script, `getItemsByAppId()` enforced |
| `server/routing.js` | Pass user context through resolution |
| `server/adapters/index.js` | Remove token inheritance, add validation |
| `server/adapters/github-issue.js` | Label best-effort |
| `extension/src/api.js` | Remove `app_id` from payloads |
| `extension/src/options/` | Delivery rule form — token required field |

---

## 5. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Existing data migration breaks items | Run migration in transaction; backup DB first |
| Extension cached with old `app_id` logic | Server ignores client `app_id` — backward compatible |
| Users without Google OAuth (invite code only) | Invite code users get a shared "guest" app — limited access |
| Token validation adds latency to rule save | Validation is one-time (on save), not on every dispatch |
| GitHub API rate limit on validation | Cache validation result; re-validate only on 401 during dispatch |

---

## 6. Open Questions

1. **Org-level sharing**: Should we implement org membership now (Phase 1) or defer? Current design is user-level isolation only.
2. **Invite code deprecation**: Should we remove invite codes entirely once all users are on Google OAuth?
3. **API key migration**: Existing API keys are bound to `app_id = 'default'`. Reassign to user's new app_id, or revoke and reissue?
