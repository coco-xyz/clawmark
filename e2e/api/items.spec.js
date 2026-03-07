/**
 * E2E — API authorization guards
 *
 * Verifies all v2 API endpoints reject unauthenticated requests.
 * Authenticated CRUD lifecycle tests are in a separate file (GL#39).
 */

'use strict';

const { test, expect } = require('@playwright/test');

test.describe('Items API — unauthorized access', () => {
    test('POST /api/v2/items rejects without auth', async ({ request }) => {
        const res = await request.post('/api/v2/items', {
            data: {
                url: 'https://example.com/test',
                type: 'annotation',
                title: 'Test annotation',
                body: 'This is a test',
            },
        });
        expect(res.status()).toBe(401);
    });

    test('GET /api/v2/items rejects without auth', async ({ request }) => {
        const res = await request.get('/api/v2/items');
        expect(res.status()).toBe(401);
    });

    test('GET /api/v2/analytics/summary rejects without auth', async ({ request }) => {
        const res = await request.get('/api/v2/analytics/summary');
        expect(res.status()).toBe(401);
    });
});

test.describe('Endpoints API — v2', () => {
    test('GET /api/v2/endpoints rejects without auth', async ({ request }) => {
        const res = await request.get('/api/v2/endpoints');
        expect(res.status()).toBe(401);
    });
});

test.describe('Apps API — v2', () => {
    test('GET /api/v2/apps rejects without auth', async ({ request }) => {
        const res = await request.get('/api/v2/apps');
        expect(res.status()).toBe(401);
    });

    test('POST /api/v2/apps rejects without auth', async ({ request }) => {
        const res = await request.post('/api/v2/apps', {
            data: { name: 'test-app' },
        });
        expect(res.status()).toBe(401);
    });
});

test.describe('Orgs API — v2', () => {
    test('GET /api/v2/orgs rejects without auth', async ({ request }) => {
        const res = await request.get('/api/v2/orgs');
        expect(res.status()).toBe(401);
    });

    test('POST /api/v2/orgs rejects without auth', async ({ request }) => {
        const res = await request.post('/api/v2/orgs', {
            data: { name: 'test-org' },
        });
        expect(res.status()).toBe(401);
    });
});
