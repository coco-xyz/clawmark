/**
 * E2E — Items API full CRUD lifecycle (v2)
 *
 * Tests the complete item lifecycle:
 *   create → read (list + single) → tag → message → resolve → reopen → close
 *
 * Uses JWT auth — v2Auth middleware auto-creates the user's default app,
 * so no Google OAuth bootstrap is needed for these tests.
 */

'use strict';

const { test, expect } = require('@playwright/test');
const { authHeader, createTestToken } = require('../helpers/auth');

// Unique test user per run to avoid cross-test contamination
const TEST_USER = {
    userId: 1001,
    email: 'items-crud-e2e@example.com',
    role: 'user',
};

let createdItemId;

test.describe('Items API — full CRUD lifecycle', () => {
    test.describe.configure({ mode: 'serial' });
    // ---------------------------------------------------------------- create

    test('POST /api/v2/items — creates an item with required fields', async ({ request }) => {
        const res = await request.post('/api/v2/items', {
            headers: { Authorization: authHeader(TEST_USER) },
            data: {
                type: 'comment',
                source_url: 'https://example.com/test-page',
                source_title: 'Test Page',
                content: 'This is a CRUD e2e test comment',
                priority: 'normal',
            },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.item).toBeDefined();
        expect(body.item.id).toBeTruthy();
        expect(body.item.type).toBe('comment');
        expect(body.item.status).toBe('open');
        expect(body.item.source_url).toBe('https://example.com/test-page');
        expect(body.item.source_title).toBe('Test Page');
        // Save id for subsequent tests
        createdItemId = body.item.id;
    });

    test('POST /api/v2/items — creates an annotation item', async ({ request }) => {
        const res = await request.post('/api/v2/items', {
            headers: { Authorization: authHeader(TEST_USER) },
            data: {
                type: 'annotation',
                source_url: 'https://example.com/article',
                source_title: 'Test Article',
                quote: 'Selected text from the page',
                content: 'My annotation on the selected text',
                priority: 'high',
                tags: ['e2e', 'annotation'],
            },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.item.type).toBe('annotation');
        expect(body.item.quote).toBe('Selected text from the page');
        expect(body.item.priority).toBe('high');
    });

    test('POST /api/v2/items — rejects without authentication', async ({ request }) => {
        const res = await request.post('/api/v2/items', {
            data: {
                type: 'comment',
                source_url: 'https://example.com',
                content: 'no auth',
            },
        });
        expect(res.status()).toBe(401);
    });

    test('POST /api/v2/items — rejects with invalid token', async ({ request }) => {
        const res = await request.post('/api/v2/items', {
            headers: { Authorization: 'Bearer not-a-valid-token' },
            data: {
                type: 'comment',
                source_url: 'https://example.com',
                content: 'bad token',
            },
        });
        expect(res.status()).toBe(401);
    });

    // ---------------------------------------------------------------- read list

    test('GET /api/v2/items — lists items for authenticated user', async ({ request }) => {
        const res = await request.get('/api/v2/items', {
            headers: { Authorization: authHeader(TEST_USER) },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body.items)).toBe(true);
        // Should contain the item we created
        const found = body.items.find(i => i.id === createdItemId);
        expect(found).toBeDefined();
    });

    test('GET /api/v2/items?url= — filters items by URL', async ({ request }) => {
        const res = await request.get('/api/v2/items?url=https://example.com/test-page', {
            headers: { Authorization: authHeader(TEST_USER) },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body.items)).toBe(true);
        expect(body.items.length).toBeGreaterThan(0);
        expect(body.items.every(i => i.source_url === 'https://example.com/test-page')).toBe(true);
    });

    test('GET /api/v2/items?type=annotation — filters items by type', async ({ request }) => {
        const res = await request.get('/api/v2/items?type=annotation', {
            headers: { Authorization: authHeader(TEST_USER) },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body.items)).toBe(true);
        expect(body.items.every(i => i.type === 'annotation')).toBe(true);
    });

    test('GET /api/v2/items?status=open — filters items by status', async ({ request }) => {
        const res = await request.get('/api/v2/items?status=open', {
            headers: { Authorization: authHeader(TEST_USER) },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.items.every(i => i.status === 'open')).toBe(true);
    });

    // ---------------------------------------------------------------- read single

    test('GET /api/v2/items/:id — returns the created item', async ({ request }) => {
        expect(createdItemId).toBeTruthy();
        const res = await request.get(`/api/v2/items/${createdItemId}`, {
            headers: { Authorization: authHeader(TEST_USER) },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.id).toBe(createdItemId);
        expect(body.type).toBe('comment');
        expect(body.status).toBe('open');
    });

    test('GET /api/v2/items/:id — returns 404 for non-existent item', async ({ request }) => {
        const res = await request.get('/api/v2/items/nonexistent-item-id-99999', {
            headers: { Authorization: authHeader(TEST_USER) },
        });
        expect(res.status()).toBe(404);
    });

    test('GET /api/v2/items/:id — returns 403 for item belonging to another user', async ({ request }) => {
        // Create an item as another user
        const otherUser = { userId: 1099, email: 'other-user@example.com', role: 'user' };
        const createRes = await request.post('/api/v2/items', {
            headers: { Authorization: authHeader(otherUser) },
            data: {
                type: 'comment',
                source_url: 'https://other.example.com',
                content: 'other user item',
            },
        });
        expect(createRes.status()).toBe(200);
        const otherId = (await createRes.json()).item.id;

        // Try to read it as TEST_USER
        const res = await request.get(`/api/v2/items/${otherId}`, {
            headers: { Authorization: authHeader(TEST_USER) },
        });
        expect(res.status()).toBe(403);
    });

    // ---------------------------------------------------------------- tags

    test('POST /api/v2/items/:id/tags — adds tags to an item', async ({ request }) => {
        expect(createdItemId).toBeTruthy();
        const res = await request.post(`/api/v2/items/${createdItemId}/tags`, {
            headers: { Authorization: authHeader(TEST_USER) },
            data: { tags: ['e2e', 'test', 'crud'] },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
    });

    // ---------------------------------------------------------------- messages

    test('POST /api/v2/items/:id/messages — adds a message to an item', async ({ request }) => {
        expect(createdItemId).toBeTruthy();
        const res = await request.post(`/api/v2/items/${createdItemId}/messages`, {
            headers: { Authorization: authHeader(TEST_USER) },
            data: {
                content: 'This is a follow-up message on the item',
                userName: TEST_USER.email,
            },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
    });

    // ---------------------------------------------------------------- lifecycle transitions

    test('POST /api/v2/items/:id/resolve — resolves an open item', async ({ request }) => {
        expect(createdItemId).toBeTruthy();
        const res = await request.post(`/api/v2/items/${createdItemId}/resolve`, {
            headers: { Authorization: authHeader(TEST_USER) },
            data: {},
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);

        // Verify status changed
        const getRes = await request.get(`/api/v2/items/${createdItemId}`, {
            headers: { Authorization: authHeader(TEST_USER) },
        });
        const item = await getRes.json();
        expect(item.status).toBe('resolved');
        expect(item.resolved_at).toBeTruthy();
    });

    test('POST /api/v2/items/:id/reopen — reopens a resolved item', async ({ request }) => {
        expect(createdItemId).toBeTruthy();
        const res = await request.post(`/api/v2/items/${createdItemId}/reopen`, {
            headers: { Authorization: authHeader(TEST_USER) },
            data: {},
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);

        // Verify status changed back to open
        const getRes = await request.get(`/api/v2/items/${createdItemId}`, {
            headers: { Authorization: authHeader(TEST_USER) },
        });
        const item = await getRes.json();
        expect(item.status).toBe('open');
    });

    test('POST /api/v2/items/:id/close — closes an open item', async ({ request }) => {
        expect(createdItemId).toBeTruthy();
        const res = await request.post(`/api/v2/items/${createdItemId}/close`, {
            headers: { Authorization: authHeader(TEST_USER) },
            data: {},
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);

        // Verify status changed to closed
        const getRes = await request.get(`/api/v2/items/${createdItemId}`, {
            headers: { Authorization: authHeader(TEST_USER) },
        });
        const item = await getRes.json();
        expect(item.status).toBe('closed');
    });

    test('GET /api/v2/items?status=closed — closed items appear in filtered list', async ({ request }) => {
        const res = await request.get('/api/v2/items?status=closed', {
            headers: { Authorization: authHeader(TEST_USER) },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.items.some(i => i.id === createdItemId)).toBe(true);
    });
});
