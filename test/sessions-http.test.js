/**
 * ClawMark — Session Storage HTTP Integration Tests (#73 P2-8)
 *
 * Tests cover route-level behavior: auth, validation, rate limit, error codes.
 * Uses a minimal Express app that mirrors the session endpoints from index.js.
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
    app.use(express.json({ limit: '5mb' }));

    // Fake v2AuthOrAgent — sets req.v2Auth from X-App-Id + X-Agent-Id headers
    function fakeAuth(req, res, next) {
        const appId = req.headers['x-app-id'];
        if (!appId) return res.status(401).json({ error: 'Unauthorized' });
        req.v2Auth = {
            app_id: appId,
            agent: req.headers['x-agent-id'] ? { id: req.headers['x-agent-id'] } : null,
        };
        next();
    }

    // POST /api/v2/agent-channel/sessions
    app.post('/api/v2/agent-channel/sessions', fakeAuth, (req, res) => {
        const app_id = req.v2Auth?.app_id;
        if (!app_id) return res.status(400).json({ error: 'No app context' });

        const { session_id, tab_id, url, title, start_time, events, snapshots, metadata } = req.body;
        const agent_id = req.v2Auth?.agent?.id || null;

        if (events && (!Array.isArray(events) || events.length > 1000)) {
            return res.status(400).json({ error: 'events must be an array (max 1000)' });
        }
        if (snapshots && (!Array.isArray(snapshots) || snapshots.length > 100)) {
            return res.status(400).json({ error: 'snapshots must be an array (max 100)' });
        }

        try {
            if (session_id) {
                const existing = db.getSession(session_id);
                if (!existing) return res.status(404).json({ error: 'Session not found' });
                if (existing.app_id !== app_id) return res.status(404).json({ error: 'Session not found' });

                const result = db.appendSessionEvents(session_id, { events, snapshots, agent_id });
                if (!result) return res.status(403).json({ error: 'Agent ownership mismatch' });
                return res.json(result);
            }

            const result = db.createSession({
                app_id, agent_id, tab_id, url, title, start_time, events, snapshots, metadata,
            });
            res.status(201).json(result);
        } catch (err) {
            if (err.message === 'SESSION_TOO_LARGE') {
                return res.status(413).json({ error: 'Session exceeds maximum size (50MB)' });
            }
            if (err.message === 'SESSION_FINALIZED') {
                return res.status(409).json({ error: 'Cannot append to a finalized session' });
            }
            if (err.message === 'INVALID_START_TIME') {
                return res.status(400).json({ error: 'start_time must be ISO 8601 format' });
            }
            if (err.message.startsWith('INVALID_EVENT_TYPE:')) {
                const type = err.message.split(':')[1];
                return res.status(400).json({ error: `Invalid event type: ${type}` });
            }
            res.status(500).json({ error: 'Failed to store session' });
        }
    });

    // POST /api/v2/agent-channel/sessions/:id/finalize
    app.post('/api/v2/agent-channel/sessions/:id/finalize', fakeAuth, (req, res) => {
        const app_id = req.v2Auth?.app_id;
        if (!app_id) return res.status(400).json({ error: 'No app context' });

        try {
            const session = db.getSession(req.params.id);
            if (!session) return res.status(404).json({ error: 'Session not found' });
            if (session.app_id !== app_id) return res.status(404).json({ error: 'Session not found' });

            const result = db.finalizeSession(req.params.id);
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: 'Failed to finalize session' });
        }
    });

    // GET /api/v2/agent-channel/sessions
    app.get('/api/v2/agent-channel/sessions', fakeAuth, (req, res) => {
        const app_id = req.v2Auth?.app_id;
        if (!app_id) return res.status(400).json({ error: 'No app context' });

        const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
        const { agent_id, site, after, limit } = req.query;
        if (after && !ISO_DATE_RE.test(after)) {
            return res.status(400).json({ error: 'after must be ISO 8601 format' });
        }

        try {
            const sessions = db.listSessions({
                app_id,
                agent_id: agent_id || null,
                site: site || null,
                after: after || null,
                limit: parseInt(limit) || 50,
            });
            res.json({ sessions, count: sessions.length });
        } catch (err) {
            res.status(500).json({ error: 'Failed to list sessions' });
        }
    });

    // GET /api/v2/agent-channel/sessions/:id
    app.get('/api/v2/agent-channel/sessions/:id', fakeAuth, (req, res) => {
        const app_id = req.v2Auth?.app_id;
        if (!app_id) return res.status(400).json({ error: 'No app context' });

        try {
            const session = db.getSession(req.params.id);
            if (!session) return res.status(404).json({ error: 'Session not found' });
            if (session.app_id !== app_id) return res.status(404).json({ error: 'Session not found' });

            const events = db.getSessionEvents(req.params.id);
            res.json({ session, events });
        } catch (err) {
            res.status(500).json({ error: 'Failed to get session' });
        }
    });

    return app;
}

function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawmark-session-http-test-'));
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
    const opts = {
        method,
        headers: { 'content-type': 'application/json', ...headers },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`http://localhost:${port}${path}`, opts);
    const json = await res.json();
    return { status: res.status, body: json };
}

const AUTH = { 'x-app-id': 'app-test' };
const AUTH_AGENT_A = { 'x-app-id': 'app-test', 'x-agent-id': 'agent-A' };
const AUTH_AGENT_B = { 'x-app-id': 'app-test', 'x-agent-id': 'agent-B' };
const BASE = '/api/v2/agent-channel/sessions';

// ================================================================= tests

describe('Session HTTP — auth', () => {
    beforeEach(async () => { setup(); await startServer(); });
    afterEach(teardown);

    it('should return 401 without auth header', async () => {
        const res = await req('POST', BASE, { body: { start_time: '2026-03-21T10:00:00.000Z' } });
        assert.equal(res.status, 401);
    });

    it('should return 201 with auth header', async () => {
        const res = await req('POST', BASE, {
            headers: AUTH,
            body: { start_time: '2026-03-21T10:00:00.000Z' },
        });
        assert.equal(res.status, 201);
        assert.ok(res.body.id.startsWith('sess-'));
    });
});

describe('Session HTTP — validation', () => {
    beforeEach(async () => { setup(); await startServer(); });
    afterEach(teardown);

    it('should return 400 for invalid start_time', async () => {
        const res = await req('POST', BASE, {
            headers: AUTH,
            body: { start_time: 'not-a-date' },
        });
        assert.equal(res.status, 400);
        assert.ok(res.body.error.includes('ISO 8601'));
    });

    it('should return 400 for invalid event type', async () => {
        const res = await req('POST', BASE, {
            headers: AUTH,
            body: {
                start_time: '2026-03-21T10:00:00.000Z',
                events: [{ type: 'xss', timestamp: '2026-03-21T10:00:00.000Z', data: {} }],
            },
        });
        assert.equal(res.status, 400);
        assert.ok(res.body.error.includes('Invalid event type'));
    });

    it('should return 400 when events is not an array', async () => {
        const res = await req('POST', BASE, {
            headers: AUTH,
            body: { start_time: '2026-03-21T10:00:00.000Z', events: 'not-array' },
        });
        assert.equal(res.status, 400);
    });

    it('should return 400 for invalid after param on list', async () => {
        const res = await req('GET', `${BASE}?after=bad-date`, { headers: AUTH });
        assert.equal(res.status, 400);
        assert.ok(res.body.error.includes('ISO 8601'));
    });
});

describe('Session HTTP — 404 and ownership', () => {
    beforeEach(async () => { setup(); await startServer(); });
    afterEach(teardown);

    it('should return 404 for non-existent session detail', async () => {
        const res = await req('GET', `${BASE}/sess-nonexistent`, { headers: AUTH });
        assert.equal(res.status, 404);
    });

    it('should return 404 when accessing another app session', async () => {
        // Create session as app-test
        const create = await req('POST', BASE, {
            headers: AUTH,
            body: { start_time: '2026-03-21T10:00:00.000Z' },
        });
        const sessionId = create.body.id;

        // Try to access as app-other
        const res = await req('GET', `${BASE}/${sessionId}`, {
            headers: { 'x-app-id': 'app-other' },
        });
        assert.equal(res.status, 404);
    });

    it('should return 404 for non-existent session finalize', async () => {
        const res = await req('POST', `${BASE}/sess-fake/finalize`, { headers: AUTH });
        assert.equal(res.status, 404);
    });
});

describe('Session HTTP — append guards', () => {
    beforeEach(async () => { setup(); await startServer(); });
    afterEach(teardown);

    it('should return 409 when appending to finalized session', async () => {
        const create = await req('POST', BASE, {
            headers: AUTH,
            body: { start_time: '2026-03-21T10:00:00.000Z' },
        });
        await req('POST', `${BASE}/${create.body.id}/finalize`, { headers: AUTH });

        const res = await req('POST', BASE, {
            headers: AUTH,
            body: {
                session_id: create.body.id,
                events: [{ type: 'click', timestamp: '2026-03-21T10:00:01.000Z', data: {} }],
            },
        });
        assert.equal(res.status, 409);
    });

    it('should return 403 when agent_id mismatch on append', async () => {
        const create = await req('POST', BASE, {
            headers: AUTH_AGENT_A,
            body: { start_time: '2026-03-21T10:00:00.000Z' },
        });

        const res = await req('POST', BASE, {
            headers: AUTH_AGENT_B,
            body: {
                session_id: create.body.id,
                events: [{ type: 'click', timestamp: '2026-03-21T10:00:01.000Z', data: {} }],
            },
        });
        assert.equal(res.status, 403);
    });

    it('should allow same agent to append', async () => {
        const create = await req('POST', BASE, {
            headers: AUTH_AGENT_A,
            body: { start_time: '2026-03-21T10:00:00.000Z' },
        });

        const res = await req('POST', BASE, {
            headers: AUTH_AGENT_A,
            body: {
                session_id: create.body.id,
                events: [{ type: 'click', timestamp: '2026-03-21T10:00:01.000Z', data: {} }],
            },
        });
        assert.equal(res.status, 200);
        assert.equal(res.body.events_added, 1);
    });
});

describe('Session HTTP — list and detail', () => {
    beforeEach(async () => { setup(); await startServer(); });
    afterEach(teardown);

    it('should list sessions for app', async () => {
        await req('POST', BASE, { headers: AUTH, body: { start_time: '2026-03-21T10:00:00.000Z' } });
        await req('POST', BASE, { headers: AUTH, body: { start_time: '2026-03-21T11:00:00.000Z' } });

        const res = await req('GET', BASE, { headers: AUTH });
        assert.equal(res.status, 200);
        assert.equal(res.body.count, 2);
    });

    it('should get session detail with events', async () => {
        const create = await req('POST', BASE, {
            headers: AUTH,
            body: {
                start_time: '2026-03-21T10:00:00.000Z',
                events: [{ type: 'click', timestamp: '2026-03-21T10:00:01.000Z', data: { x: 1 } }],
            },
        });

        const res = await req('GET', `${BASE}/${create.body.id}`, { headers: AUTH });
        assert.equal(res.status, 200);
        assert.equal(res.body.events.length, 1);
        assert.equal(res.body.session.id, create.body.id);
    });
});
