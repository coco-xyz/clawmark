#!/usr/bin/env node
/**
 * ClawMark Production Smoke Test
 *
 * Quick post-deploy validation. Covers:
 *   1. /health                     → 200 + {status: 'ok', db_ok: true}
 *   2. Auth endpoint availability  → 400 (reachable, not crashing)
 *   3. /items API (with API key)   → 200 + {items: []}
 *   4. /dashboard/endpoints        → 200 HTML
 *   5. Extension manifest          → 200 JSON (if MANIFEST_PATH is configured)
 *
 * Usage:
 *   BASE_URL=https://clawmark.example.com node e2e/smoke/smoke.js
 *   BASE_URL=http://localhost:3459 SMOKE_API_KEY=ak_xxx node e2e/smoke/smoke.js
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more checks failed
 *
 * Environment:
 *   BASE_URL        Required. Target environment (no trailing slash).
 *   SMOKE_API_KEY   Optional. API key for authenticated endpoint checks.
 *                   If omitted, /items check is skipped with a warning.
 *   MANIFEST_PATH   Optional. Server path to extension manifest (e.g. /extension/manifest.json).
 *                   If omitted, manifest check is skipped.
 *   SMOKE_TIMEOUT   Optional. Per-request timeout in ms (default: 10000).
 */

'use strict';

const BASE_URL  = (process.env.BASE_URL  || '').replace(/\/$/, '');
const API_KEY   = process.env.SMOKE_API_KEY   || '';
const MANIFEST  = process.env.MANIFEST_PATH   || '';
const TIMEOUT   = parseInt(process.env.SMOKE_TIMEOUT || '10000', 10);

if (!BASE_URL) {
    console.error('ERROR: BASE_URL environment variable is required.');
    console.error('  Example: BASE_URL=https://clawmark.example.com node e2e/smoke/smoke.js');
    process.exit(1);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED   = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BOLD  = '\x1b[1m';

let passed = 0;
let failed = 0;
let skipped = 0;

function ok(name) {
    console.log(`  ${GREEN}✓${RESET} ${name}`);
    passed++;
}

function fail(name, reason) {
    console.log(`  ${RED}✗${RESET} ${BOLD}${name}${RESET}`);
    console.log(`    ${RED}→ ${reason}${RESET}`);
    failed++;
}

function skip(name, reason) {
    console.log(`  ${YELLOW}~${RESET} ${name} ${YELLOW}(skipped: ${reason})${RESET}`);
    skipped++;
}

async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        return res;
    } finally {
        clearTimeout(timer);
    }
}

// ─── Checks ──────────────────────────────────────────────────────────────────

async function checkHealth() {
    const name = 'Health: GET /health → 200 + {status: ok, db_ok: true}';
    const url = `${BASE_URL}/health`;
    try {
        const res = await fetchWithTimeout(url);
        if (res.status !== 200) return fail(name, `HTTP ${res.status}`);

        const body = await res.json();
        if (body.status !== 'ok') return fail(name, `status is "${body.status}", expected "ok"`);
        if (body.db_ok !== true)  return fail(name, `db_ok is ${body.db_ok}, expected true`);

        ok(name);
    } catch (err) {
        fail(name, err.message);
    }
}

async function checkAuthEndpoint() {
    const name = 'Auth: POST /api/v2/auth/google → reachable (400 without credentials)';
    const url = `${BASE_URL}/api/v2/auth/google`;
    try {
        const res = await fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        // Expect 400 (missing credentials), not 404/500
        if (res.status === 400) {
            const body = await res.json().catch(() => ({}));
            if (body.error) return ok(name);
            return fail(name, `HTTP 400 but missing error field in response`);
        }
        if (res.status === 404) return fail(name, 'HTTP 404 — auth endpoint not found');
        if (res.status >= 500)  return fail(name, `HTTP ${res.status} — server error`);
        // Any other 4xx is fine (auth is reachable)
        ok(name);
    } catch (err) {
        fail(name, err.message);
    }
}

async function checkItemsApi() {
    const name = 'Items API: GET /api/v2/items → 200 + {items: Array}';
    if (!API_KEY) {
        return skip(name, 'SMOKE_API_KEY not set');
    }
    const url = `${BASE_URL}/api/v2/items`;
    try {
        const res = await fetchWithTimeout(url, {
            headers: { 'Authorization': `Bearer ${API_KEY}` },
        });
        if (res.status === 401) return fail(name, 'HTTP 401 — API key rejected');
        if (res.status !== 200) return fail(name, `HTTP ${res.status}`);

        const body = await res.json();
        if (!Array.isArray(body.items)) {
            return fail(name, `response.items is ${typeof body.items}, expected Array`);
        }
        ok(name);
    } catch (err) {
        fail(name, err.message);
    }
}

async function checkDashboard() {
    const name = 'Dashboard: GET /dashboard/endpoints → 200 HTML';
    const url = `${BASE_URL}/dashboard/endpoints`;
    try {
        const res = await fetchWithTimeout(url);
        if (res.status !== 200) return fail(name, `HTTP ${res.status}`);

        const ct = res.headers.get('content-type') || '';
        if (!ct.includes('text/html')) {
            return fail(name, `Content-Type is "${ct}", expected text/html`);
        }
        ok(name);
    } catch (err) {
        fail(name, err.message);
    }
}

async function checkExtensionManifest() {
    const name = `Extension manifest: GET ${MANIFEST} → 200 JSON with manifest_version`;
    if (!MANIFEST) {
        return skip(name, 'MANIFEST_PATH not set');
    }
    const url = `${BASE_URL}${MANIFEST}`;
    try {
        const res = await fetchWithTimeout(url);
        if (res.status !== 200) return fail(name, `HTTP ${res.status}`);

        const body = await res.json().catch(() => null);
        if (!body) return fail(name, 'Response is not valid JSON');
        if (!body.manifest_version) {
            return fail(name, 'Missing manifest_version field');
        }
        ok(name);
    } catch (err) {
        fail(name, err.message);
    }
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function main() {
    const startMs = Date.now();
    console.log(`\n${BOLD}ClawMark Production Smoke Test${RESET}`);
    console.log(`Target: ${BOLD}${BASE_URL}${RESET}`);
    console.log(`Timeout: ${TIMEOUT}ms per request\n`);

    await checkHealth();
    await checkAuthEndpoint();
    await checkItemsApi();
    await checkDashboard();
    await checkExtensionManifest();

    const elapsed = Date.now() - startMs;
    console.log(`\n──────────────────────────────────────`);
    console.log(`${GREEN}${passed} passed${RESET}  ${failed > 0 ? RED : ''}${failed} failed${RESET}  ${YELLOW}${skipped} skipped${RESET}  (${elapsed}ms)`);

    if (failed > 0) {
        console.log(`\n${RED}${BOLD}SMOKE TEST FAILED${RESET} — deployment may be broken.\n`);
        process.exit(1);
    }

    console.log(`\n${GREEN}${BOLD}SMOKE TEST PASSED${RESET} — deployment looks healthy.\n`);
    process.exit(0);
}

main().catch(err => {
    console.error(`\nUnexpected error: ${err.message}`);
    process.exit(1);
});
