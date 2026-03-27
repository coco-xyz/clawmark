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

    // GET /api/v2/agent-channel/sessions/:id/analysis (#61)
    const { correlate } = require('../server/agent/session-analyzer');
    const { generateReport } = require('../server/agent/reproduction-generator');

    app.get('/api/v2/agent-channel/sessions/:id/analysis', fakeAuth, (req, res) => {
        const app_id = req.v2Auth?.app_id;
        if (!app_id) return res.status(400).json({ error: 'No app context' });

        try {
            const session = db.getSession(req.params.id);
            if (!session) return res.status(404).json({ error: 'Session not found' });
            if (session.app_id !== app_id) return res.status(404).json({ error: 'Session not found' });

            const errors = db.getPerceptionEvents({
                app_id,
                since: session.start_time,
                until: session.end_time || new Date().toISOString(),
                severity: 'error',
                limit: 50,
            });

            let sessionOrigin;
            try { sessionOrigin = new URL(session.url).origin; } catch {}

            const sessionErrors = sessionOrigin
                ? errors.filter(e => { try { return new URL(e.url).origin === sessionOrigin; } catch { return false; } })
                : errors;

            const analyses = sessionErrors.map(error => {
                try {
                    const correlation = correlate(db, error);
                    if (!correlation) return { error: { id: error.id, message: error.message }, reproduction: null };
                    const report = generateReport(correlation, error);
                    return {
                        error: { id: error.id, type: error.type, severity: error.severity, message: error.message, fingerprint: error.fingerprint, created_at: error.created_at },
                        reproduction: { steps: report.steps, trigger: report.trigger, timeline: report.timeline, snapshot_id: correlation.closestSnapshot?.id || null },
                    };
                } catch { return { error: { id: error.id, message: error.message }, reproduction: null }; }
            });

            res.json({ session: { id: session.id, url: session.url, status: session.status, event_count: session.event_count }, error_count: sessionErrors.length, analyses });
        } catch (err) {
            res.status(500).json({ error: 'Failed to analyze session' });
        }
    });

    // GET /api/v2/agent-channel/perception/issues/:fingerprint/context (#61)
    app.get('/api/v2/agent-channel/perception/issues/:fingerprint/context', fakeAuth, (req, res) => {
        const app_id = req.v2Auth?.app_id;
        if (!app_id) return res.status(400).json({ error: 'No app context' });

        try {
            const issue = db.getPerceptionIssue({ app_id, fingerprint: req.params.fingerprint });
            if (!issue) return res.status(404).json({ error: 'Issue not found' });

            const events = db.getPerceptionEventsByFingerprint({ app_id, fingerprint: req.params.fingerprint, limit: 5 });
            if (events.length === 0) return res.json({ issue, context: null });

            const representative = events[0];
            let context = null;
            try {
                const correlation = correlate(db, representative);
                if (correlation) {
                    const report = generateReport(correlation, representative);
                    context = { session_id: correlation.session?.id, steps: report.steps, trigger: report.trigger };
                }
            } catch {}

            res.json({ issue, context, recent_events: events.length });
        } catch (err) {
            res.status(500).json({ error: 'Failed to get issue context' });
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

// ================================================================= session analysis (#61)

describe('Session HTTP — analysis endpoint', () => {
    beforeEach(async () => { setup(); await startServer(); });
    afterEach(teardown);

    it('should return 404 for non-existent session', async () => {
        const res = await req('GET', `${BASE}/sess_nonexistent/analysis`, { headers: AUTH });
        assert.equal(res.status, 404);
    });

    it('should return 401 without auth', async () => {
        const res = await req('GET', `${BASE}/sess_test/analysis`);
        assert.equal(res.status, 401);
    });

    it('should return analysis with zero errors when no perception events', async () => {
        const create = await req('POST', BASE, {
            headers: AUTH,
            body: {
                url: 'https://example.com/page',
                start_time: '2026-03-21T10:00:00.000Z',
                events: [{ type: 'click', timestamp: '2026-03-21T10:00:01.000Z', data: { x: 100, y: 200 } }],
            },
        });
        assert.equal(create.status, 201);

        const res = await req('GET', `${BASE}/${create.body.id}/analysis`, { headers: AUTH });
        assert.equal(res.status, 200);
        assert.equal(res.body.error_count, 0);
        assert.deepEqual(res.body.analyses, []);
        assert.ok(res.body.session.id);
    });

    it('should include perception errors in analysis', async () => {
        // Create a session with start_time in past and no end_time (still active)
        const create = await req('POST', BASE, {
            headers: AUTH,
            body: {
                url: 'https://example.com/app',
                start_time: '2020-01-01T00:00:00.000Z',
                events: [
                    { type: 'click', timestamp: '2020-01-01T00:00:02.000Z', data: { x: 50, y: 100 } },
                ],
            },
        });
        assert.equal(create.status, 201);

        // Insert a perception error — created_at will be "now" (within the active session)
        dbApi.createPerceptionEvent({
            app_id: 'app-test',
            type: 'js-error',
            severity: 'error',
            message: 'TypeError: Cannot read property of undefined',
            url: 'https://example.com/app',
            source: 'app.js',
            line: 42,
            fingerprint: 'fp_test_correlation',
        });

        const res = await req('GET', `${BASE}/${create.body.id}/analysis`, { headers: AUTH });
        assert.equal(res.status, 200);
        assert.ok(res.body.error_count >= 1, 'should find at least 1 error');
        assert.ok(res.body.analyses.length >= 1, 'should have at least 1 analysis');
        // Each analysis has error and reproduction fields
        const analysis = res.body.analyses[0];
        assert.ok(analysis.error, 'should have error object');
        assert.ok(analysis.error.id, 'error should have id');
    });

    it('should not leak sessions from other apps', async () => {
        const create = await req('POST', BASE, {
            headers: AUTH,
            body: { start_time: '2026-03-21T10:00:00.000Z' },
        });
        assert.equal(create.status, 201);

        const res = await req('GET', `${BASE}/${create.body.id}/analysis`, { headers: { 'x-app-id': 'other-app' } });
        assert.equal(res.status, 404);
    });
});

describe('Session HTTP — perception issue context endpoint', () => {
    beforeEach(async () => { setup(); await startServer(); });
    afterEach(teardown);

    it('should return 404 for unknown fingerprint', async () => {
        const res = await req('GET', '/api/v2/agent-channel/perception/issues/fp_unknown/context', { headers: AUTH });
        assert.equal(res.status, 404);
    });

    it('should return issue context with null context when no sessions', async () => {
        // Insert a perception event + tracked issue
        dbApi.createPerceptionEvent({
            app_id: 'app-test',
            type: 'js-error',
            severity: 'error',
            message: 'ReferenceError: x is not defined',
            url: 'https://example.com/page',
            fingerprint: 'fp_ctx_test',
            created_at: '2026-03-21T10:00:00.000Z',
        });
        dbApi.upsertPerceptionIssue({
            app_id: 'app-test',
            fingerprint: 'fp_ctx_test',
            count: 1,
            first_seen: '2026-03-21T10:00:00.000Z',
            last_seen: '2026-03-21T10:00:00.000Z',
        });

        const res = await req('GET', '/api/v2/agent-channel/perception/issues/fp_ctx_test/context', { headers: AUTH });
        assert.equal(res.status, 200);
        assert.ok(res.body.issue);
        assert.equal(res.body.recent_events, 1);
        // No sessions exist so context should be null
        assert.equal(res.body.context, null);
    });

    it('should return 401 without auth', async () => {
        const res = await req('GET', '/api/v2/agent-channel/perception/issues/fp_test/context');
        assert.equal(res.status, 401);
    });
});
