# ClawMark Production Smoke Tests

Quick post-deploy health check. Runs in ~2s against any environment.

## Quick Start

```bash
# Standalone script (no Playwright install required)
BASE_URL=https://clawmark.example.com node e2e/smoke/smoke.js

# With API key for authenticated endpoint checks
BASE_URL=https://clawmark.example.com SMOKE_API_KEY=ak_xxx node e2e/smoke/smoke.js

# Via Playwright (CI-friendly)
BASE_URL=https://clawmark.example.com npx playwright test e2e/smoke/smoke.spec.js --project=smoke
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `BASE_URL` | ✅ | Target environment URL (no trailing slash) |
| `SMOKE_API_KEY` | Optional | API key for `/items` check. Skipped if omitted. |
| `MANIFEST_PATH` | Optional | Server path to extension manifest (e.g. `/extension/manifest.json`). Skipped if omitted. |
| `SMOKE_TIMEOUT` | Optional | Per-request timeout ms. Default: `10000`. |

## Checks

| # | Check | Auth needed |
|---|---|---|
| 1 | `GET /health` → 200 + `{status: "ok", db_ok: true}` | No |
| 2 | `POST /api/v2/auth/google` → 400 (endpoint reachable) | No |
| 3 | `GET /items` → 200 + `{items: Array}` | Yes (`SMOKE_API_KEY`) |
| 4 | `GET /dashboard/endpoints` → 200 HTML | No |
| 5 | `GET $MANIFEST_PATH` → 200 valid JSON with `manifest_version` | No |

## Exit Codes

- `0` — all enabled checks passed → deployment healthy
- `1` — one or more checks failed → investigate before declaring deploy healthy

## CI Integration

```yaml
# GitLab CI (post-deploy stage)
smoke-test:
  stage: post-deploy
  script:
    - BASE_URL=$DEPLOY_URL SMOKE_API_KEY=$CI_SMOKE_KEY node e2e/smoke/smoke.js
  environment: production
```
