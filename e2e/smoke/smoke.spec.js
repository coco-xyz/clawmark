/**
 * ClawMark Production Smoke Test — Playwright spec
 *
 * Mirrors smoke.js but runs through Playwright for CI pipeline integration.
 * Designed to run against an already-deployed environment (no webServer startup).
 *
 * Run via:
 *   BASE_URL=https://clawmark.example.com npx playwright test e2e/smoke/smoke.spec.js
 *   BASE_URL=http://localhost:3459 SMOKE_API_KEY=ak_xxx npx playwright test e2e/smoke/smoke.spec.js
 *
 * See smoke.js for full environment variable reference.
 */

'use strict';

const { test, expect } = require('@playwright/test');

const BASE_URL  = (process.env.BASE_URL  || '').replace(/\/$/, '');
const API_KEY   = process.env.SMOKE_API_KEY   || '';
const MANIFEST  = process.env.MANIFEST_PATH   || '';

// Validate BASE_URL is set
test.beforeAll(() => {
    if (!BASE_URL) throw new Error('BASE_URL environment variable is required for smoke tests.');
});

test.describe('Smoke — Health', () => {
    test('GET /health returns 200 with status:ok and db_ok:true', async ({ request }) => {
        const res = await request.get(`${BASE_URL}/health`);
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.status).toBe('ok');
        expect(body.db_ok).toBe(true);
        expect(typeof body.version).toBe('string');
        expect(typeof body.uptime).toBe('number');
    });
});

test.describe('Smoke — Auth', () => {
    test('POST /api/v2/auth/google is reachable (returns 400 without credentials)', async ({ request }) => {
        const res = await request.post(`${BASE_URL}/api/v2/auth/google`, {
            data: {},
        });
        // 400 = reachable + correctly validating input
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(body.error).toBeTruthy();
    });
});

test.describe('Smoke — Items API', () => {
    test('GET /api/v2/items returns 200 with items array', async ({ request }) => {
        test.skip(!API_KEY, 'SMOKE_API_KEY not set — skipping authenticated check');

        const res = await request.get(`${BASE_URL}/api/v2/items`, {
            headers: { 'Authorization': `Bearer ${API_KEY}` },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body.items)).toBe(true);
    });
});

test.describe('Smoke — Dashboard', () => {
    test('GET /dashboard/endpoints returns 200 HTML', async ({ request }) => {
        const res = await request.get(`${BASE_URL}/dashboard/endpoints`);
        expect(res.status()).toBe(200);
        const ct = res.headers()['content-type'] || '';
        expect(ct).toContain('text/html');
    });
});

test.describe('Smoke — Extension Manifest', () => {
    test('Extension manifest is downloadable and valid', async ({ request }) => {
        test.skip(!MANIFEST, 'MANIFEST_PATH not set — skipping manifest check');

        const res = await request.get(`${BASE_URL}${MANIFEST}`);
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.manifest_version).toBeTruthy();
    });
});
