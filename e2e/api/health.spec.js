/**
 * E2E — Health & basic server checks
 */

'use strict';

const { test, expect } = require('@playwright/test');

test.describe('Server Health', () => {
    test('GET /health returns 200', async ({ request }) => {
        const res = await request.get('/health');
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.status).toBe('ok');
    });

    test('GET /stats returns 401 without auth', async ({ request }) => {
        const res = await request.get('/stats');
        expect(res.status()).toBe(401);
    });
});
