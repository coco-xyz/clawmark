# ClawMark E2E Tests

Playwright-based E2E test suite covering API integration, browser UI, and production smoke tests.

## Quick Start

```bash
# Install dependencies (dev deps required for Playwright)
NODE_ENV=development npm install

# Run API tests only
npx playwright test --project=api

# Run browser E2E tests only
npx playwright test --project=e2e

# Run all local tests (API + browser)
npx playwright test --project=api --project=e2e

# Run smoke tests against a deployed environment
BASE_URL=https://jessie.coco.site SMOKE_ONLY=1 npx playwright test --project=smoke
```

## Test Structure

```
e2e/
  api/              API integration tests (no browser needed)
    auth.spec.js        Auth endpoints + JWT validation
    endpoints-crud.spec.js  Endpoint CRUD lifecycle
    error-scenarios.spec.js Error handling + edge cases
    health.spec.js      Health check + stats endpoints
    items.spec.js       Unauthorized access checks
    items-crud.spec.js  Full item CRUD lifecycle (create→tag→resolve→close)
  browser/          Browser E2E tests (Chromium headless)
    dashboard.spec.js   Dashboard SPA: login, tabs, modals, sign-out
  extension/        Chrome extension E2E (headed mode required)
    extension.spec.js   Extension load + basic flow
  smoke/            Production smoke tests (external env)
    smoke.spec.js       Health, auth, items, dashboard reachability
  helpers/          Shared test utilities
    auth.js             JWT token generation for test users
    browser-auth.js     localStorage injection for browser tests
    dashboard-server.js Static file server for dashboard
    seed-db.js          Test database seeding
```

## CI Pipeline

Tests run automatically on every MR and merge to develop/main:

| Job | Stage | What it tests | Trigger |
|-----|-------|---------------|---------|
| `e2e-api` | e2e | API endpoints (77 tests) | All MRs + develop/main |
| `e2e-browser` | e2e | Dashboard UI (14 tests) | All MRs + develop/main |
| `e2e-staging` | e2e-staging | Full suite against staging | develop→main MRs only |

## Configuration

- `playwright.config.js` — Local test config (auto-starts test server on port 3491)
- `playwright.staging.config.js` — Staging config (uses persistent server, no auto-start)

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | - | Must be `development` for npm to install Playwright |
| `BASE_URL` | - | Smoke/staging test target URL |
| `SMOKE_API_KEY` | - | API key for authenticated smoke tests |
| `SMOKE_ONLY` | - | Set to `1` to skip webServer startup |
