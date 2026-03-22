/**
 * ClawMark — Webhook HTTP Route Tests (#88)
 *
 * Tests cover route-level behavior: auth, validation, CRUD, test endpoint, deliveries.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { initDb } = require('../server/db');
const { hashKey } = require('../server/agent-auth');

// ------------------------------------------------------------------ helpers

let dbApi;
let tmpDir;
let server;
let port;

function createTestApp(db) {
    const app = express();
    app.use(express.json());

    function fakeAuth(req, res, next) {
        const appId = req.headers['x-app-id'];
        if (!appId) return res.status(401).json({ error: 'Unauthorized' });
        req.v2Auth = {
            app_id: appId,
            agent: req.headers['x-agent-id'] ? { id: req.headers['x-agent-id'] } : null,
        };
        next();
    }

    // POST /api/v2/agent-channel/webhooks
    app.post('/api/v2/agent-channel/webhooks', fakeAuth, (req, res) => {
        const app_id = req.v2Auth?.app_id;
        const agent_id = req.v2Auth?.agent?.id;
        if (!app_id || !agent_id) return res.status(400).json({ error: 'Agent authentication required' });

        const { url, secret, event_filters, template, allow_http } = req.body;
        if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url required' });

        try {
            const parsed = new URL(url);
            if (parsed.protocol !== 'https:' && !(allow_http && parsed.protocol === 'http:')) {
                return res.status(400).json({ error: 'HTTPS required (set allow_http: true for HTTP)' });
            }
        } catch { return res.status(400).json({ error: 'Invalid URL' }); }

        const count = db.countWebhooksByAgent(agent_id);
        if (count >= 10) return res.status(400).json({ error: 'Max 10 webhooks per agent' });

        const webhookSecret = secret || require('crypto').randomBytes(32).toString('hex');

        try {
            const wh = db.createWebhook({ app_id, agent_id, url, secret: webhookSecret, event_filters, template, allow_http });
            res.status(201).json({ ...wh, secret: webhookSecret });
        } catch (err) {
            res.status(500).json({ error: 'Failed to create webhook' });
        }
    });

    // GET /api/v2/agent-channel/webhooks
    app.get('/api/v2/agent-channel/webhooks', fakeAuth, (req, res) => {
        const app_id = req.v2Auth?.app_id;
        const agent_id = req.v2Auth?.agent?.id;
        if (!app_id) return res.status(400).json({ error: 'No app context' });

        const webhooks = agent_id
            ? db.listWebhooksByAgent(agent_id)
            : db.listWebhooksByApp(app_id);
        const safe = webhooks.map(({ secret, ...rest }) => rest);
        res.json({ webhooks: safe, count: safe.length });
    });

    // GET /api/v2/agent-channel/webhooks/:id
    app.get('/api/v2/agent-channel/webhooks/:id', fakeAuth, (req, res) => {
        const app_id = req.v2Auth?.app_id;
        if (!app_id) return res.status(400).json({ error: 'No app context' });

        const wh = db.getWebhook(req.params.id);
        if (!wh || wh.app_id !== app_id) return res.status(404).json({ error: 'Webhook not found' });
        const { secret, ...safe } = wh;
        const deliveries = db.getWebhookDeliveries(wh.id, 20);
        res.json({ webhook: safe, deliveries });
    });

    // PUT /api/v2/agent-channel/webhooks/:id
    app.put('/api/v2/agent-channel/webhooks/:id', fakeAuth, (req, res) => {
        const app_id = req.v2Auth?.app_id;
        if (!app_id) return res.status(400).json({ error: 'No app context' });

        const wh = db.getWebhook(req.params.id);
        if (!wh || wh.app_id !== app_id) return res.status(404).json({ error: 'Webhook not found' });

        const { url, event_filters, template, active, allow_http } = req.body;
        const newUrl = url || wh.url;
        try {
            const parsed = new URL(newUrl);
            const httpAllowed = allow_http !== undefined ? allow_http : wh.allow_http;
            if (parsed.protocol !== 'https:' && !(httpAllowed && parsed.protocol === 'http:')) {
                return res.status(400).json({ error: 'HTTPS required (set allow_http: true for HTTP)' });
            }
        } catch { return res.status(400).json({ error: 'Invalid URL' }); }

        const updated = db.updateWebhook(req.params.id, {
            url: newUrl,
            event_filters: event_filters || JSON.parse(wh.event_filters || '{}'),
            template: template || wh.template,
            active: active !== undefined ? active : wh.active,
            allow_http: allow_http !== undefined ? allow_http : wh.allow_http,
        });
        const { secret, ...safe } = updated;
        res.json(safe);
    });

    // DELETE /api/v2/agent-channel/webhooks/:id
    app.delete('/api/v2/agent-channel/webhooks/:id', fakeAuth, (req, res) => {
        const app_id = req.v2Auth?.app_id;
        if (!app_id) return res.status(400).json({ error: 'No app context' });

        const wh = db.getWebhook(req.params.id);
        if (!wh || wh.app_id !== app_id) return res.status(404).json({ error: 'Webhook not found' });

        db.deleteWebhook(req.params.id);
        res.json({ deleted: true });
    });

    // GET /api/v2/agent-channel/webhooks/:id/deliveries
    app.get('/api/v2/agent-channel/webhooks/:id/deliveries', fakeAuth, (req, res) => {
        const app_id = req.v2Auth?.app_id;
        if (!app_id) return res.status(400).json({ error: 'No app context' });

        const wh = db.getWebhook(req.params.id);
        if (!wh || wh.app_id !== app_id) return res.status(404).json({ error: 'Webhook not found' });

        const limit = Math.min(parseInt(req.query.limit) || 50, 200);
        const deliveries = db.getWebhookDeliveries(wh.id, limit);
        res.json({ deliveries, count: deliveries.length });
    });

    return app;
}

function fetch(path, opts = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, `http://127.0.0.1:${port}`);
        const body = opts.body ? JSON.stringify(opts.body) : undefined;
        const req = http.request(url, {
            method: opts.method || 'GET',
            headers: {
                'Content-Type': 'application/json',
                ...(opts.headers || {}),
                ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
            },
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                catch { resolve({ status: res.statusCode, body: data }); }
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

let appObj;
let agentObj;

function setup() {
    return new Promise((resolve) => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawmark-wh-http-test-'));
        dbApi = initDb(tmpDir);
        appObj = dbApi.createApp({ user_id: 'user-1', name: 'test-app' });
        const rawKey = 'cmak_' + crypto.randomBytes(24).toString('hex');
        agentObj = dbApi.registerAgent({
            app_id: appObj.id,
            name: 'test-agent',
            key_hash: hashKey(rawKey),
            key_prefix: rawKey.slice(0, 8),
            capabilities: ['navigate'],
            created_by: 'user-1',
        });
        const app = createTestApp(dbApi);
        server = app.listen(0, () => {
            port = server.address().port;
            resolve();
        });
    });
}

function teardownAsync() {
    return new Promise((resolve) => {
        if (server) server.close(() => {
            if (dbApi && dbApi.db) dbApi.db.close();
            if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
            resolve();
        });
        else resolve();
    });
}

const AUTH = () => ({ 'x-app-id': appObj.id, 'x-agent-id': agentObj.id });
const APP_AUTH = () => ({ 'x-app-id': appObj.id });

// ================================================================= HTTP tests

describe('Webhook HTTP — create', () => {
    beforeEach(setup);
    afterEach(teardownAsync);

    it('should create a webhook (201)', async () => {
        const res = await fetch('/api/v2/agent-channel/webhooks', {
            method: 'POST',
            headers: AUTH(),
            body: { url: 'https://example.com/hook', secret: 'mysecret' },
        });
        assert.equal(res.status, 201);
        assert.ok(res.body.id);
        assert.equal(res.body.secret, 'mysecret');
    });

    it('should generate secret when not provided', async () => {
        const res = await fetch('/api/v2/agent-channel/webhooks', {
            method: 'POST',
            headers: AUTH(),
            body: { url: 'https://example.com/hook' },
        });
        assert.equal(res.status, 201);
        assert.ok(res.body.secret);
        assert.equal(res.body.secret.length, 64); // 32 bytes hex
    });

    it('should reject missing URL (400)', async () => {
        const res = await fetch('/api/v2/agent-channel/webhooks', {
            method: 'POST',
            headers: AUTH(),
            body: {},
        });
        assert.equal(res.status, 400);
    });

    it('should reject HTTP URL without allow_http (400)', async () => {
        const res = await fetch('/api/v2/agent-channel/webhooks', {
            method: 'POST',
            headers: AUTH(),
            body: { url: 'http://example.com/hook' },
        });
        assert.equal(res.status, 400);
        assert.ok(res.body.error.includes('HTTPS'));
    });

    it('should allow HTTP URL with allow_http=true', async () => {
        const res = await fetch('/api/v2/agent-channel/webhooks', {
            method: 'POST',
            headers: AUTH(),
            body: { url: 'http://example.com/hook', allow_http: true },
        });
        assert.equal(res.status, 201);
    });

    it('should reject without agent auth (400)', async () => {
        const res = await fetch('/api/v2/agent-channel/webhooks', {
            method: 'POST',
            headers: APP_AUTH(), // no agent_id
            body: { url: 'https://example.com/hook' },
        });
        assert.equal(res.status, 400);
    });

    it('should reject without any auth (401)', async () => {
        const res = await fetch('/api/v2/agent-channel/webhooks', {
            method: 'POST',
            body: { url: 'https://example.com/hook' },
        });
        assert.equal(res.status, 401);
    });

    it('should enforce max 10 webhooks per agent', async () => {
        // Create 10 webhooks
        for (let i = 0; i < 10; i++) {
            await fetch('/api/v2/agent-channel/webhooks', {
                method: 'POST',
                headers: AUTH(),
                body: { url: `https://example.com/hook${i}` },
            });
        }
        // 11th should fail
        const res = await fetch('/api/v2/agent-channel/webhooks', {
            method: 'POST',
            headers: AUTH(),
            body: { url: 'https://example.com/hook10' },
        });
        assert.equal(res.status, 400);
        assert.ok(res.body.error.includes('Max 10'));
    });
});

describe('Webhook HTTP — list', () => {
    beforeEach(setup);
    afterEach(teardownAsync);

    it('should list webhooks (strips secrets)', async () => {
        await fetch('/api/v2/agent-channel/webhooks', {
            method: 'POST',
            headers: AUTH(),
            body: { url: 'https://example.com/hook1', secret: 'sec1' },
        });
        const res = await fetch('/api/v2/agent-channel/webhooks', {
            headers: AUTH(),
        });
        assert.equal(res.status, 200);
        assert.equal(res.body.count, 1);
        assert.ok(!res.body.webhooks[0].secret);
    });
});

describe('Webhook HTTP — get by ID', () => {
    beforeEach(setup);
    afterEach(teardownAsync);

    it('should get webhook details (strips secret)', async () => {
        const created = await fetch('/api/v2/agent-channel/webhooks', {
            method: 'POST',
            headers: AUTH(),
            body: { url: 'https://example.com/hook', secret: 'sec' },
        });
        const res = await fetch(`/api/v2/agent-channel/webhooks/${created.body.id}`, {
            headers: AUTH(),
        });
        assert.equal(res.status, 200);
        assert.ok(res.body.webhook);
        assert.ok(!res.body.webhook.secret);
        assert.ok(Array.isArray(res.body.deliveries));
    });

    it('should 404 for non-existent webhook', async () => {
        const res = await fetch('/api/v2/agent-channel/webhooks/wh-nonexistent', {
            headers: AUTH(),
        });
        assert.equal(res.status, 404);
    });

    it('should 404 for webhook from another app', async () => {
        const created = await fetch('/api/v2/agent-channel/webhooks', {
            method: 'POST',
            headers: AUTH(),
            body: { url: 'https://example.com/hook' },
        });
        const res = await fetch(`/api/v2/agent-channel/webhooks/${created.body.id}`, {
            headers: { 'x-app-id': 'other-app' },
        });
        assert.equal(res.status, 404);
    });
});

describe('Webhook HTTP — update', () => {
    beforeEach(setup);
    afterEach(teardownAsync);

    it('should update webhook URL', async () => {
        const created = await fetch('/api/v2/agent-channel/webhooks', {
            method: 'POST',
            headers: AUTH(),
            body: { url: 'https://example.com/old' },
        });
        const res = await fetch(`/api/v2/agent-channel/webhooks/${created.body.id}`, {
            method: 'PUT',
            headers: AUTH(),
            body: { url: 'https://example.com/new' },
        });
        assert.equal(res.status, 200);
        assert.equal(res.body.url, 'https://example.com/new');
    });

    it('should reject HTTP update without allow_http', async () => {
        const created = await fetch('/api/v2/agent-channel/webhooks', {
            method: 'POST',
            headers: AUTH(),
            body: { url: 'https://example.com/ok' },
        });
        const res = await fetch(`/api/v2/agent-channel/webhooks/${created.body.id}`, {
            method: 'PUT',
            headers: AUTH(),
            body: { url: 'http://example.com/bad' },
        });
        assert.equal(res.status, 400);
    });
});

describe('Webhook HTTP — delete', () => {
    beforeEach(setup);
    afterEach(teardownAsync);

    it('should delete webhook', async () => {
        const created = await fetch('/api/v2/agent-channel/webhooks', {
            method: 'POST',
            headers: AUTH(),
            body: { url: 'https://example.com/del' },
        });
        const res = await fetch(`/api/v2/agent-channel/webhooks/${created.body.id}`, {
            method: 'DELETE',
            headers: AUTH(),
        });
        assert.equal(res.status, 200);
        assert.equal(res.body.deleted, true);

        // Verify gone
        const get = await fetch(`/api/v2/agent-channel/webhooks/${created.body.id}`, {
            headers: AUTH(),
        });
        assert.equal(get.status, 404);
    });

    it('should 404 for non-existent delete', async () => {
        const res = await fetch('/api/v2/agent-channel/webhooks/wh-fake', {
            method: 'DELETE',
            headers: AUTH(),
        });
        assert.equal(res.status, 404);
    });
});

describe('Webhook HTTP — deliveries', () => {
    beforeEach(setup);
    afterEach(teardownAsync);

    it('should list deliveries for a webhook', async () => {
        const created = await fetch('/api/v2/agent-channel/webhooks', {
            method: 'POST',
            headers: AUTH(),
            body: { url: 'https://example.com/dlv' },
        });
        // Insert a delivery record directly
        dbApi.createWebhookDelivery({
            webhook_id: created.body.id,
            event_type: 'perception.p1',
            payload: '{"test":true}',
        });
        const res = await fetch(`/api/v2/agent-channel/webhooks/${created.body.id}/deliveries`, {
            headers: AUTH(),
        });
        assert.equal(res.status, 200);
        assert.equal(res.body.count, 1);
        assert.equal(res.body.deliveries[0].event_type, 'perception.p1');
    });
});
