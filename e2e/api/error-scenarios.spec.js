/**
 * E2E — Error scenarios
 *
 * Comprehensive coverage of auth failures, permission errors,
 * invalid input, and resource-not-found cases across the v2 API.
 */

'use strict';

const { test, expect } = require('@playwright/test');
const { authHeader, createTestToken, JWT_SECRET } = require('../helpers/auth');
const jwt = require('jsonwebtoken');

const TEST_USER = {
    userId: 1003,
    email: 'error-scenarios-e2e@example.com',
    role: 'user',
};

test.describe('Auth error scenarios', () => {
    test('no Authorization header → 401', async ({ request }) => {
        for (const path of ['/api/v2/items', '/api/v2/endpoints', '/api/v2/apps', '/api/v2/orgs']) {
            const res = await request.get(path);
            expect(res.status(), `GET ${path} should return 401`).toBe(401);
        }
    });

    test('empty Bearer token → 401', async ({ request }) => {
        const res = await request.get('/api/v2/items', {
            headers: { Authorization: 'Bearer ' },
        });
        expect(res.status()).toBe(401);
    });

    test('malformed token (not JWT) → 401', async ({ request }) => {
        const res = await request.get('/api/v2/items', {
            headers: { Authorization: 'Bearer this.is.garbage' },
        });
        expect(res.status()).toBe(401);
    });

    test('JWT signed with wrong secret → 401', async ({ request }) => {
        const badToken = jwt.sign({ userId: 1, email: 'test@example.com', role: 'user' }, 'wrong-secret');
        const res = await request.get('/api/v2/items', {
            headers: { Authorization: `Bearer ${badToken}` },
        });
        expect(res.status()).toBe(401);
    });

    test('expired JWT → 401', async ({ request }) => {
        const expiredToken = jwt.sign(
            { userId: 1, email: 'test@example.com', role: 'user' },
            JWT_SECRET,
            { expiresIn: '-1s' }
        );
        const res = await request.get('/api/v2/items', {
            headers: { Authorization: `Bearer ${expiredToken}` },
        });
        expect(res.status()).toBe(401);
    });

    test('POST /api/v2/auth/google — rejects empty body → 400', async ({ request }) => {
        const res = await request.post('/api/v2/auth/google', { data: {} });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(body.error).toContain('idToken');
    });

    test('POST /api/v2/auth/google — rejects invalid idToken → 401', async ({ request }) => {
        const res = await request.post('/api/v2/auth/google', {
            data: { idToken: 'not-a-real-google-token' },
        });
        expect(res.status()).toBe(401);
    });

    test('GET /api/v2/auth/me — valid JWT but user not in DB → 401', async ({ request }) => {
        // userId 9999 won't exist in a fresh test DB
        const token = createTestToken({ userId: 9999, email: 'ghost@example.com' });
        const res = await request.get('/api/v2/auth/me', {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(res.status()).toBe(401);
        const body = await res.json();
        expect(body.error).toBe('User not found');
    });

    test('deprecated POST /api/v2/auth/apikey-legacy → 410', async ({ request }) => {
        const res = await request.post('/api/v2/auth/apikey-legacy', {
            data: { invite_code: 'any-code' },
        });
        expect(res.status()).toBe(410);
    });
});

test.describe('Items error scenarios', () => {
    test('POST /api/v2/items — no source_url falls back gracefully', async ({ request }) => {
        // Without source_url the item uses '/' as doc — should still succeed
        const res = await request.post('/api/v2/items', {
            headers: { Authorization: authHeader(TEST_USER) },
            data: {
                type: 'comment',
                content: 'Item with no source_url',
            },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.item.doc).toBe('/');
    });

    test('GET /api/v2/items/:id — without auth → 401', async ({ request }) => {
        const res = await request.get('/api/v2/items/some-item-id');
        expect(res.status()).toBe(401);
    });

    test('GET /api/v2/items/:id — non-existent id → 404', async ({ request }) => {
        const res = await request.get('/api/v2/items/does-not-exist-12345', {
            headers: { Authorization: authHeader(TEST_USER) },
        });
        expect(res.status()).toBe(404);
        const body = await res.json();
        expect(body.error).toMatch(/not found/i);
    });

    test('POST /api/v2/items/:id/resolve — non-existent item → 404', async ({ request }) => {
        const res = await request.post('/api/v2/items/nonexistent-item/resolve', {
            headers: { Authorization: authHeader(TEST_USER) },
            data: {},
        });
        expect(res.status()).toBe(404);
    });

    test('POST /api/v2/items/:id/close — non-existent item → 404', async ({ request }) => {
        const res = await request.post('/api/v2/items/nonexistent-item/close', {
            headers: { Authorization: authHeader(TEST_USER) },
            data: {},
        });
        expect(res.status()).toBe(404);
    });

    test('POST /api/v2/items/:id/reopen — non-existent item → 404', async ({ request }) => {
        const res = await request.post('/api/v2/items/nonexistent-item/reopen', {
            headers: { Authorization: authHeader(TEST_USER) },
            data: {},
        });
        expect(res.status()).toBe(404);
    });

    test('GET /api/v2/items/:id — cross-user access → 403', async ({ request }) => {
        // Create item as userA
        const userA = { userId: 2001, email: 'user-a-errors@example.com', role: 'user' };
        const createRes = await request.post('/api/v2/items', {
            headers: { Authorization: authHeader(userA) },
            data: { type: 'comment', source_url: 'https://usera.example.com', content: 'userA item' },
        });
        expect(createRes.status()).toBe(200);
        const itemId = (await createRes.json()).item.id;

        // Access as TEST_USER (different app_id)
        const res = await request.get(`/api/v2/items/${itemId}`, {
            headers: { Authorization: authHeader(TEST_USER) },
        });
        expect(res.status()).toBe(403);
        const body = await res.json();
        expect(body.error).toMatch(/access denied/i);
    });
});

test.describe('Endpoints error scenarios', () => {
    // Type-specific validation errors are covered in endpoints-crud.spec.js.
    // These tests cover read-only 401 and unauthenticated access.

    test('GET /api/v2/endpoints — without auth → 401', async ({ request }) => {
        const res = await request.get('/api/v2/endpoints');
        expect(res.status()).toBe(401);
    });

    test('GET /api/v2/endpoints/:id — without auth → 401', async ({ request }) => {
        const res = await request.get('/api/v2/endpoints/some-id');
        expect(res.status()).toBe(401);
    });
});

test.describe('Analytics error scenarios', () => {
    test('GET /api/v2/analytics/summary — without auth → 401', async ({ request }) => {
        const res = await request.get('/api/v2/analytics/summary');
        expect(res.status()).toBe(401);
    });

    test('GET /api/v2/analytics/trends — without auth → 401', async ({ request }) => {
        const res = await request.get('/api/v2/analytics/trends');
        expect(res.status()).toBe(401);
    });

    test('GET /api/v2/analytics/summary — authenticated returns valid structure', async ({ request }) => {
        const res = await request.get('/api/v2/analytics/summary', {
            headers: { Authorization: authHeader(TEST_USER) },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body).toHaveProperty('total');
        expect(body).toHaveProperty('byStatus');
        expect(body).toHaveProperty('byType');
        expect(Array.isArray(body.byStatus)).toBe(true);
    });
});
