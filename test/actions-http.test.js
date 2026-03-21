/**
 * ClawMark — Action Queue HTTP Integration Tests (#78)
 *
 * Tests cover route-level behavior: auth, validation, status codes, result submission.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { initDb } = require('../server/db');

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

    // POST /api/v2/agent-channel/actions
    app.post('/api/v2/agent-channel/actions', fakeAuth, (req, res) => {
        const app_id = req.v2Auth?.app_id;
        const agent_id = req.v2Auth?.agent?.id;
        if (!app_id || !agent_id) return res.status(400).json({ error: 'Agent auth required' });

        const { action_type, payload, session_id, timeout_ms } = req.body;
        if (!action_type) return res.status(400).json({ error: 'action_type is required' });

        try {
            const action = db.createAction({
                agent_id, app_id,
                session_id: session_id || null,
                type: action_type,
                payload: payload || {},
                timeout_ms: timeout_ms || 30000,
            });
            res.status(201).json(action);
        } catch (err) {
            if (err.message.startsWith('INVALID_ACTION_TYPE:')) {
                return res.status(400).json({ error: `Invalid action_type` });
            }
            if (err.message === 'QUEUE_FULL') {
                return res.status(429).json({ error: 'Queue full' });
            }
            res.status(500).json({ error: 'Failed' });
        }
    });

    // GET /api/v2/agent-channel/actions/:id
    app.get('/api/v2/agent-channel/actions/:id', fakeAuth, (req, res) => {
        const action = db.getAction(req.params.id);
        if (!action) return res.status(404).json({ error: 'Not found' });
        if (action.app_id !== req.v2Auth.app_id) return res.status(404).json({ error: 'Not found' });
        res.json({ ...action, payload: JSON.parse(action.payload || '{}'), result: action.result ? JSON.parse(action.result) : null });
    });

    // POST /api/v2/agent-channel/actions/:id/result
    app.post('/api/v2/agent-channel/actions/:id/result', fakeAuth, (req, res) => {
        const action = db.getAction(req.params.id);
        if (!action) return res.status(404).json({ error: 'Not found' });
        if (action.app_id !== req.v2Auth.app_id) return res.status(404).json({ error: 'Not found' });
        if (action.status === 'completed' || action.status === 'failed') {
            return res.status(409).json({ error: 'Already resolved' });
        }
        const { result, error } = req.body;
        const status = error ? 'failed' : 'completed';
        db.updateActionStatus(action.id, { status, result, error });
        res.json({ action_id: action.id, status });
    });

    // GET /api/v2/agent-channel/actions
    app.get('/api/v2/agent-channel/actions', fakeAuth, (req, res) => {
        const agent_id = req.v2Auth?.agent?.id;
        const actions = agent_id
            ? db.listAgentActions(agent_id, req.query.status || 'queued', 50)
            : db.listPendingActions(req.v2Auth.app_id, 50);
        res.json({ actions, count: actions.length });
    });

    return app;
}

function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawmark-action-http-test-'));
    dbApi = initDb(tmpDir);
}

async function startServer() {
    const app = createTestApp(dbApi);
    server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    port = server.address().port;
}

async function teardown() {
    if (server) await new Promise(r => server.close(r));
    if (dbApi && dbApi.db) dbApi.db.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function req(method, path, { body, headers = {} } = {}) {
    const opts = { method, headers: { 'content-type': 'application/json', ...headers } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`http://localhost:${port}${path}`, opts);
    const json = await res.json();
    return { status: res.status, body: json };
}

const AUTH = { 'x-app-id': 'app-test', 'x-agent-id': 'agent-test' };
const AUTH_EXT = { 'x-app-id': 'app-test' };
const BASE = '/api/v2/agent-channel/actions';

// ================================================================= tests

describe('Action HTTP — create', () => {
    beforeEach(async () => { setup(); await startServer(); });
    afterEach(teardown);

    it('should return 401 without auth', async () => {
        const res = await req('POST', BASE, { body: { action_type: 'click' } });
        assert.equal(res.status, 401);
    });

    it('should return 400 without agent_id', async () => {
        const res = await req('POST', BASE, { headers: AUTH_EXT, body: { action_type: 'click' } });
        assert.equal(res.status, 400);
    });

    it('should return 400 without action_type', async () => {
        const res = await req('POST', BASE, { headers: AUTH, body: {} });
        assert.equal(res.status, 400);
    });

    it('should return 400 for invalid action_type', async () => {
        const res = await req('POST', BASE, { headers: AUTH, body: { action_type: 'hack' } });
        assert.equal(res.status, 400);
    });

    it('should return 201 for valid action', async () => {
        const res = await req('POST', BASE, { headers: AUTH, body: { action_type: 'click', payload: { selector: '#btn' } } });
        assert.equal(res.status, 201);
        assert.ok(res.body.id.startsWith('act-'));
        assert.equal(res.body.status, 'queued');
    });
});

describe('Action HTTP — poll and result', () => {
    beforeEach(async () => { setup(); await startServer(); });
    afterEach(teardown);

    it('should get action by id', async () => {
        const create = await req('POST', BASE, { headers: AUTH, body: { action_type: 'navigate', payload: { url: 'https://x.com' } } });
        const res = await req('GET', `${BASE}/${create.body.id}`, { headers: AUTH });
        assert.equal(res.status, 200);
        assert.equal(res.body.type, 'navigate');
        assert.deepEqual(res.body.payload, { url: 'https://x.com' });
    });

    it('should return 404 for non-existent action', async () => {
        const res = await req('GET', `${BASE}/act-nope`, { headers: AUTH });
        assert.equal(res.status, 404);
    });

    it('should return 404 for other app action', async () => {
        const create = await req('POST', BASE, { headers: AUTH, body: { action_type: 'click' } });
        const res = await req('GET', `${BASE}/${create.body.id}`, { headers: { 'x-app-id': 'other-app', 'x-agent-id': 'a' } });
        assert.equal(res.status, 404);
    });

    it('should submit result via REST', async () => {
        const create = await req('POST', BASE, { headers: AUTH, body: { action_type: 'extract' } });
        const res = await req('POST', `${BASE}/${create.body.id}/result`, { headers: AUTH_EXT, body: { result: { text: 'hello' } } });
        assert.equal(res.status, 200);
        assert.equal(res.body.status, 'completed');

        // Verify
        const poll = await req('GET', `${BASE}/${create.body.id}`, { headers: AUTH });
        assert.equal(poll.body.status, 'completed');
        assert.deepEqual(poll.body.result, { text: 'hello' });
    });

    it('should return 409 for already-resolved action', async () => {
        const create = await req('POST', BASE, { headers: AUTH, body: { action_type: 'click' } });
        await req('POST', `${BASE}/${create.body.id}/result`, { headers: AUTH_EXT, body: { result: {} } });
        const res = await req('POST', `${BASE}/${create.body.id}/result`, { headers: AUTH_EXT, body: { result: {} } });
        assert.equal(res.status, 409);
    });

    it('should submit error result', async () => {
        const create = await req('POST', BASE, { headers: AUTH, body: { action_type: 'click' } });
        const res = await req('POST', `${BASE}/${create.body.id}/result`, { headers: AUTH_EXT, body: { error: 'Element not found' } });
        assert.equal(res.status, 200);
        assert.equal(res.body.status, 'failed');
    });
});

describe('Action HTTP — list', () => {
    beforeEach(async () => { setup(); await startServer(); });
    afterEach(teardown);

    it('should list actions for agent', async () => {
        await req('POST', BASE, { headers: AUTH, body: { action_type: 'click' } });
        await req('POST', BASE, { headers: AUTH, body: { action_type: 'navigate', payload: { url: 'https://x.com' } } });

        const res = await req('GET', BASE, { headers: AUTH });
        assert.equal(res.status, 200);
        assert.equal(res.body.count, 2);
    });
});
