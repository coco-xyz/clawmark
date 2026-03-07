/**
 * E2E — Endpoints API full CRUD lifecycle (v2)
 *
 * Tests: create → read (list + single) → update → set-default → delete
 *
 * Endpoints are per-user (keyed by email from JWT).
 * Uses JWT auth — no Google OAuth needed.
 */

'use strict';

const { test, expect } = require('@playwright/test');
const { authHeader } = require('../helpers/auth');

const TEST_USER = {
    userId: 1002,
    email: 'endpoints-crud-e2e@example.com',
    role: 'user',
};

let webhookEndpointId;
let githubEndpointId;

test.describe('Endpoints API — full CRUD lifecycle', () => {
    test.describe.configure({ mode: 'serial' });
    // ---------------------------------------------------------------- create

    test('POST /api/v2/endpoints — creates a webhook endpoint', async ({ request }) => {
        const res = await request.post('/api/v2/endpoints', {
            headers: { Authorization: authHeader(TEST_USER) },
            data: {
                name: 'E2E Webhook',
                type: 'webhook',
                config: { url: 'https://webhook.example.com/hook', secret: 'test-secret' },
                is_default: false,
            },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.endpoint).toBeDefined();
        expect(body.endpoint.id).toBeTruthy();
        expect(body.endpoint.name).toBe('E2E Webhook');
        expect(body.endpoint.type).toBe('webhook');
        expect(body.endpoint.config).toBeDefined();
        expect(body.endpoint.config.url).toBe('https://webhook.example.com/hook');
        webhookEndpointId = body.endpoint.id;
    });

    test('POST /api/v2/endpoints — creates a github-issue endpoint', async ({ request }) => {
        const res = await request.post('/api/v2/endpoints', {
            headers: { Authorization: authHeader(TEST_USER) },
            data: {
                name: 'E2E GitHub Issues',
                type: 'github-issue',
                config: { repo: 'coco-xyz/test-repo', token: 'ghp_test_token' },
            },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.endpoint.type).toBe('github-issue');
        expect(body.endpoint.config.repo).toBe('coco-xyz/test-repo');
        githubEndpointId = body.endpoint.id;
    });

    test('POST /api/v2/endpoints — rejects without authentication', async ({ request }) => {
        const res = await request.post('/api/v2/endpoints', {
            data: {
                name: 'No Auth Endpoint',
                type: 'webhook',
                config: { url: 'https://example.com' },
            },
        });
        expect(res.status()).toBe(401);
    });

    test('POST /api/v2/endpoints — rejects missing endpoint name', async ({ request }) => {
        const res = await request.post('/api/v2/endpoints', {
            headers: { Authorization: authHeader(TEST_USER) },
            data: {
                type: 'webhook',
                config: { url: 'https://example.com' },
            },
        });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(body.error).toMatch(/name/i);
    });

    test('POST /api/v2/endpoints — rejects invalid endpoint type', async ({ request }) => {
        const res = await request.post('/api/v2/endpoints', {
            headers: { Authorization: authHeader(TEST_USER) },
            data: {
                name: 'Bad Type',
                type: 'invalid-type',
                config: {},
            },
        });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(body.error).toMatch(/invalid type/i);
    });

    test('POST /api/v2/endpoints — rejects webhook missing url in config', async ({ request }) => {
        const res = await request.post('/api/v2/endpoints', {
            headers: { Authorization: authHeader(TEST_USER) },
            data: {
                name: 'Bad Webhook',
                type: 'webhook',
                config: {},
            },
        });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(body.error).toMatch(/url/i);
    });

    test('POST /api/v2/endpoints — rejects github-issue missing repo in config', async ({ request }) => {
        const res = await request.post('/api/v2/endpoints', {
            headers: { Authorization: authHeader(TEST_USER) },
            data: {
                name: 'Bad GitHub',
                type: 'github-issue',
                config: {},
            },
        });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(body.error).toMatch(/repo/i);
    });

    // ---------------------------------------------------------------- read list

    test('GET /api/v2/endpoints — lists endpoints for authenticated user', async ({ request }) => {
        const res = await request.get('/api/v2/endpoints', {
            headers: { Authorization: authHeader(TEST_USER) },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body.endpoints)).toBe(true);
        // Both created endpoints should appear
        const ids = body.endpoints.map(e => e.id);
        expect(ids).toContain(webhookEndpointId);
        expect(ids).toContain(githubEndpointId);
    });

    test('GET /api/v2/endpoints — returns empty list for new user', async ({ request }) => {
        const freshUser = { userId: 1098, email: 'fresh-user-endpoints@example.com', role: 'user' };
        const res = await request.get('/api/v2/endpoints', {
            headers: { Authorization: authHeader(freshUser) },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.endpoints).toEqual([]);
    });

    test('GET /api/v2/endpoints — rejects without authentication', async ({ request }) => {
        const res = await request.get('/api/v2/endpoints');
        expect(res.status()).toBe(401);
    });

    // ---------------------------------------------------------------- read single

    test('GET /api/v2/endpoints/:id — returns the created endpoint', async ({ request }) => {
        expect(webhookEndpointId).toBeTruthy();
        const res = await request.get(`/api/v2/endpoints/${webhookEndpointId}`, {
            headers: { Authorization: authHeader(TEST_USER) },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.endpoint.id).toBe(webhookEndpointId);
        expect(body.endpoint.name).toBe('E2E Webhook');
        expect(body.endpoint.type).toBe('webhook');
    });

    test('GET /api/v2/endpoints/:id — returns 404 for non-existent endpoint', async ({ request }) => {
        const res = await request.get('/api/v2/endpoints/nonexistent-endpoint-id', {
            headers: { Authorization: authHeader(TEST_USER) },
        });
        expect(res.status()).toBe(404);
    });

    test('GET /api/v2/endpoints/:id — returns 403 for endpoint belonging to another user', async ({ request }) => {
        // Create endpoint as another user
        const otherUser = { userId: 1097, email: 'other-endpoints@example.com', role: 'user' };
        const createRes = await request.post('/api/v2/endpoints', {
            headers: { Authorization: authHeader(otherUser) },
            data: {
                name: 'Other User Endpoint',
                type: 'webhook',
                config: { url: 'https://other.example.com/hook' },
            },
        });
        expect(createRes.status()).toBe(200);
        const otherId = (await createRes.json()).endpoint.id;

        // Try to read it as TEST_USER
        const res = await request.get(`/api/v2/endpoints/${otherId}`, {
            headers: { Authorization: authHeader(TEST_USER) },
        });
        expect(res.status()).toBe(403);
    });

    // ---------------------------------------------------------------- update

    test('PUT /api/v2/endpoints/:id — updates endpoint name', async ({ request }) => {
        expect(webhookEndpointId).toBeTruthy();
        const res = await request.put(`/api/v2/endpoints/${webhookEndpointId}`, {
            headers: { Authorization: authHeader(TEST_USER) },
            data: { name: 'E2E Webhook — Updated' },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.endpoint.name).toBe('E2E Webhook — Updated');
    });

    test('PUT /api/v2/endpoints/:id — updates endpoint config', async ({ request }) => {
        expect(webhookEndpointId).toBeTruthy();
        const res = await request.put(`/api/v2/endpoints/${webhookEndpointId}`, {
            headers: { Authorization: authHeader(TEST_USER) },
            data: {
                config: { url: 'https://webhook.example.com/updated-hook', secret: 'new-secret' },
            },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.endpoint.config.url).toBe('https://webhook.example.com/updated-hook');
    });

    test('PUT /api/v2/endpoints/:id — returns 403 for endpoint belonging to another user', async ({ request }) => {
        const otherUser = { userId: 1096, email: 'put-other-endpoints@example.com', role: 'user' };
        const createRes = await request.post('/api/v2/endpoints', {
            headers: { Authorization: authHeader(otherUser) },
            data: {
                name: 'Another Other Endpoint',
                type: 'webhook',
                config: { url: 'https://another.example.com/hook' },
            },
        });
        const otherId = (await createRes.json()).endpoint.id;

        const res = await request.put(`/api/v2/endpoints/${otherId}`, {
            headers: { Authorization: authHeader(TEST_USER) },
            data: { name: 'Stolen Name' },
        });
        expect(res.status()).toBe(403);
    });

    test('PUT /api/v2/endpoints/:id — returns 404 for non-existent endpoint', async ({ request }) => {
        const res = await request.put('/api/v2/endpoints/nonexistent-endpoint-id', {
            headers: { Authorization: authHeader(TEST_USER) },
            data: { name: 'New Name' },
        });
        expect(res.status()).toBe(404);
    });

    // ---------------------------------------------------------------- set-default

    test('POST /api/v2/endpoints/:id/default — sets webhook as default', async ({ request }) => {
        expect(webhookEndpointId).toBeTruthy();
        const res = await request.post(`/api/v2/endpoints/${webhookEndpointId}/default`, {
            headers: { Authorization: authHeader(TEST_USER) },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.endpoint.is_default).toBeTruthy(); // DB stores 1, not boolean true
    });

    // ---------------------------------------------------------------- type-specific validation

    test('POST /api/v2/endpoints — rejects lark missing webhook_url', async ({ request }) => {
        const res = await request.post('/api/v2/endpoints', {
            headers: { Authorization: authHeader(TEST_USER) },
            data: { name: 'Bad Lark', type: 'lark', config: {} },
        });
        expect(res.status()).toBe(400);
        expect((await res.json()).error).toMatch(/webhook_url/i);
    });

    test('POST /api/v2/endpoints — rejects telegram missing chat_id', async ({ request }) => {
        const res = await request.post('/api/v2/endpoints', {
            headers: { Authorization: authHeader(TEST_USER) },
            data: { name: 'Bad TG', type: 'telegram', config: {} },
        });
        expect(res.status()).toBe(400);
        expect((await res.json()).error).toMatch(/chat_id/i);
    });

    test('POST /api/v2/endpoints — rejects email missing api_key', async ({ request }) => {
        const res = await request.post('/api/v2/endpoints', {
            headers: { Authorization: authHeader(TEST_USER) },
            data: {
                name: 'Bad Email', type: 'email',
                config: { from: 'test@example.com', to: ['dest@example.com'] },
            },
        });
        expect(res.status()).toBe(400);
        expect((await res.json()).error).toMatch(/api_key/i);
    });

    // ---------------------------------------------------------------- delete

    test('DELETE /api/v2/endpoints/:id — deletes the github endpoint', async ({ request }) => {
        expect(githubEndpointId).toBeTruthy();
        const res = await request.delete(`/api/v2/endpoints/${githubEndpointId}`, {
            headers: { Authorization: authHeader(TEST_USER) },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);

        // Verify it's gone
        const getRes = await request.get(`/api/v2/endpoints/${githubEndpointId}`, {
            headers: { Authorization: authHeader(TEST_USER) },
        });
        expect(getRes.status()).toBe(404);
    });

    test('DELETE /api/v2/endpoints/:id — returns 403 for endpoint belonging to another user', async ({ request }) => {
        const otherUser = { userId: 1095, email: 'delete-other-endpoints@example.com', role: 'user' };
        const createRes = await request.post('/api/v2/endpoints', {
            headers: { Authorization: authHeader(otherUser) },
            data: {
                name: 'Delete Target',
                type: 'webhook',
                config: { url: 'https://delete.example.com/hook' },
            },
        });
        const otherId = (await createRes.json()).endpoint.id;

        const res = await request.delete(`/api/v2/endpoints/${otherId}`, {
            headers: { Authorization: authHeader(TEST_USER) },
        });
        expect(res.status()).toBe(403);
    });

    test('DELETE /api/v2/endpoints/:id — returns 404 for non-existent endpoint', async ({ request }) => {
        const res = await request.delete('/api/v2/endpoints/nonexistent-endpoint-id', {
            headers: { Authorization: authHeader(TEST_USER) },
        });
        expect(res.status()).toBe(404);
    });

    test('DELETE /api/v2/endpoints/:id — deletes the webhook endpoint', async ({ request }) => {
        expect(webhookEndpointId).toBeTruthy();
        const res = await request.delete(`/api/v2/endpoints/${webhookEndpointId}`, {
            headers: { Authorization: authHeader(TEST_USER) },
        });
        expect(res.status()).toBe(200);
        expect((await res.json()).success).toBe(true);
    });
});
