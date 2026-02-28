/**
 * ClawMark — App Management Tests (#65)
 *
 * Tests cover:
 * 1. Apps table — CRUD (create, read, update, delete)
 * 2. Auto-generated AppKey on app creation
 * 3. Key rotation
 * 4. App deletion cascades key revocation
 * 5. API routes — /api/v2/apps/* (JWT-only auth)
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initDb } = require('../server/db');
const { initAuth } = require('../server/auth');
const jwt = require('jsonwebtoken');

// ------------------------------------------------------------------ helpers

let dbApi;
let tmpDir;
const TEST_JWT_SECRET = 'test-secret-key-for-apps';

function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawmark-apps-test-'));
    dbApi = initDb(tmpDir);
}

function teardown() {
    if (dbApi && dbApi.db) dbApi.db.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

function createTestUser(overrides = {}) {
    return dbApi.upsertUser({
        google_id: overrides.google_id || `g-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
        email: overrides.email || `test-${Date.now()}@example.com`,
        name: overrides.name || 'Test User',
        picture: overrides.picture || null,
    });
}

function signToken(user) {
    return jwt.sign(
        { userId: user.id, email: user.email, role: user.role },
        TEST_JWT_SECRET,
        { expiresIn: 3600, algorithm: 'HS256' }
    );
}

function createTestServer() {
    const { router: authRouter, verifyJwt } = initAuth({
        db: dbApi,
        jwtSecret: TEST_JWT_SECRET,
    });
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.locals.VALID_CODES = {};

    // Minimal jwtAuth middleware (same logic as server/index.js)
    function jwtAuth(req, res, next) {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'JWT authentication required' });
        }
        const token = authHeader.slice(7);
        if (token.startsWith('cmk_')) {
            return res.status(401).json({ error: 'JWT authentication required (API keys not accepted for app management)' });
        }
        const payload = verifyJwt(token);
        if (!payload) {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }
        req.jwtUser = { userId: payload.userId, email: payload.email, role: payload.role };
        next();
    }

    // Mount app routes
    app.post('/api/v2/apps', jwtAuth, (req, res) => {
        const { name, description } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ error: 'Missing app name' });
        const result = dbApi.createApp({ user_id: req.jwtUser.userId, name: name.trim(), description: description || null });
        res.json({ success: true, app: result });
    });

    app.get('/api/v2/apps', jwtAuth, (req, res) => {
        const apps = dbApi.getAppsByUser(req.jwtUser.userId);
        res.json({ apps });
    });

    app.get('/api/v2/apps/:id', jwtAuth, (req, res) => {
        const theApp = dbApi.getApp(req.params.id);
        if (!theApp) return res.status(404).json({ error: 'App not found' });
        if (theApp.user_id !== req.jwtUser.userId) return res.status(403).json({ error: 'Not authorized' });
        const keys = dbApi.getAppKeys(theApp.id).map(k => ({
            id: k.id, key: k.key, name: k.name,
            created_at: k.created_at, last_used: k.last_used, revoked: !!k.revoked,
        }));
        res.json({ app: theApp, keys });
    });

    app.put('/api/v2/apps/:id', jwtAuth, (req, res) => {
        const existing = dbApi.getApp(req.params.id);
        if (!existing) return res.status(404).json({ error: 'App not found' });
        if (existing.user_id !== req.jwtUser.userId) return res.status(403).json({ error: 'Not authorized' });
        const { name, description } = req.body;
        if (name !== undefined && !name.trim()) return res.status(400).json({ error: 'App name cannot be empty' });
        const updated = dbApi.updateApp(req.params.id, { name: name ? name.trim() : undefined, description });
        res.json({ success: true, app: updated });
    });

    app.delete('/api/v2/apps/:id', jwtAuth, (req, res) => {
        const existing = dbApi.getApp(req.params.id);
        if (!existing) return res.status(404).json({ error: 'App not found' });
        if (existing.user_id !== req.jwtUser.userId) return res.status(403).json({ error: 'Not authorized' });
        const result = dbApi.deleteApp(req.params.id);
        if (!result.success) return res.status(404).json({ error: 'App not found' });
        res.json({ success: true });
    });

    app.post('/api/v2/apps/:id/rotate-key', jwtAuth, (req, res) => {
        const existing = dbApi.getApp(req.params.id);
        if (!existing) return res.status(404).json({ error: 'App not found' });
        if (existing.user_id !== req.jwtUser.userId) return res.status(403).json({ error: 'Not authorized' });
        const newKey = dbApi.rotateAppKey(req.params.id, req.jwtUser.userId);
        res.json({ success: true, key: newKey.key, key_id: newKey.id });
    });

    return app;
}

async function startServer(app) {
    const http = require('http');
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    return { server, port: server.address().port };
}

// =================================================================== tests

describe('DB — apps table', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('creates an app with auto-generated key', () => {
        const user = createTestUser();
        const app = dbApi.createApp({ user_id: user.id, name: 'My App', description: 'Test app' });
        assert.ok(app.id.startsWith('app-'));
        assert.equal(app.user_id, user.id);
        assert.equal(app.name, 'My App');
        assert.equal(app.description, 'Test app');
        assert.ok(app.key.startsWith('cmk_'));
        assert.ok(app.key_id.startsWith('key-'));
        assert.ok(app.created_at);
    });

    it('creates app without description', () => {
        const user = createTestUser();
        const app = dbApi.createApp({ user_id: user.id, name: 'Minimal App' });
        assert.equal(app.description, null);
    });

    it('gets app by ID', () => {
        const user = createTestUser();
        const created = dbApi.createApp({ user_id: user.id, name: 'Find Me' });
        const found = dbApi.getApp(created.id);
        assert.equal(found.name, 'Find Me');
        assert.equal(found.user_id, user.id);
    });

    it('returns null for unknown app', () => {
        assert.equal(dbApi.getApp('nonexistent'), null);
    });

    it('lists apps by user', () => {
        const user1 = createTestUser({ google_id: 'g-user1', email: 'user1@test.com' });
        const user2 = createTestUser({ google_id: 'g-user2', email: 'user2@test.com' });
        dbApi.createApp({ user_id: user1.id, name: 'App A' });
        dbApi.createApp({ user_id: user1.id, name: 'App B' });
        dbApi.createApp({ user_id: user2.id, name: 'App C' });

        const user1Apps = dbApi.getAppsByUser(user1.id);
        assert.equal(user1Apps.length, 2);
        const user2Apps = dbApi.getAppsByUser(user2.id);
        assert.equal(user2Apps.length, 1);
        assert.equal(user2Apps[0].name, 'App C');
    });

    it('updates app name and description', () => {
        const user = createTestUser();
        const app = dbApi.createApp({ user_id: user.id, name: 'Old Name', description: 'Old desc' });
        const updated = dbApi.updateApp(app.id, { name: 'New Name', description: 'New desc' });
        assert.equal(updated.name, 'New Name');
        assert.equal(updated.description, 'New desc');
    });

    it('updates only description, keeps name', () => {
        const user = createTestUser();
        const app = dbApi.createApp({ user_id: user.id, name: 'Keep Me' });
        const updated = dbApi.updateApp(app.id, { description: 'Added desc' });
        assert.equal(updated.name, 'Keep Me');
        assert.equal(updated.description, 'Added desc');
    });

    it('returns null when updating nonexistent app', () => {
        assert.equal(dbApi.updateApp('nonexistent', { name: 'x' }), null);
    });

    it('deletes app and revokes keys', () => {
        const user = createTestUser();
        const app = dbApi.createApp({ user_id: user.id, name: 'Delete Me' });

        // Verify key works before deletion
        const keyBefore = dbApi.validateApiKey(app.key);
        assert.ok(keyBefore);

        const result = dbApi.deleteApp(app.id);
        assert.equal(result.success, true);

        // App is gone
        assert.equal(dbApi.getApp(app.id), null);

        // Key is revoked
        const keyAfter = dbApi.validateApiKey(app.key);
        assert.equal(keyAfter, null);
    });

    it('returns failure for deleting nonexistent app', () => {
        const result = dbApi.deleteApp('nonexistent');
        assert.equal(result.success, false);
    });
});

describe('DB — app keys', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('lists keys for an app', () => {
        const user = createTestUser();
        const app = dbApi.createApp({ user_id: user.id, name: 'Key App' });
        const keys = dbApi.getAppKeys(app.id);
        assert.equal(keys.length, 1);
        assert.equal(keys[0].key, app.key);
        assert.equal(keys[0].app_id, app.id);
    });

    it('rotates app key — old revoked, new created', () => {
        const user = createTestUser();
        const app = dbApi.createApp({ user_id: user.id, name: 'Rotate App' });
        const oldKey = app.key;

        const newKey = dbApi.rotateAppKey(app.id, user.id);
        assert.ok(newKey.key.startsWith('cmk_'));
        assert.notEqual(newKey.key, oldKey);

        // Old key is revoked
        assert.equal(dbApi.validateApiKey(oldKey), null);

        // New key works
        const valid = dbApi.validateApiKey(newKey.key);
        assert.ok(valid);
        assert.equal(valid.app_id, app.id);
    });

    it('key validates with correct app_id', () => {
        const user = createTestUser();
        const app = dbApi.createApp({ user_id: user.id, name: 'Validate App' });
        const valid = dbApi.validateApiKey(app.key);
        assert.ok(valid);
        assert.equal(valid.app_id, app.id);
    });
});

describe('API — POST /api/v2/apps', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('creates app with valid JWT', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const user = createTestUser();
        const token = signToken(user);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/apps`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ name: 'My Web App', description: 'A test application' }),
            });
            const data = await res.json();
            assert.equal(res.status, 200);
            assert.equal(data.success, true);
            assert.equal(data.app.name, 'My Web App');
            assert.equal(data.app.description, 'A test application');
            assert.ok(data.app.key.startsWith('cmk_'));
            assert.ok(data.app.id.startsWith('app-'));
        } finally {
            server.close();
        }
    });

    it('rejects request without JWT', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/apps`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'No Auth App' }),
            });
            assert.equal(res.status, 401);
        } finally {
            server.close();
        }
    });

    it('rejects request with API key instead of JWT', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const user = createTestUser();
        const app = dbApi.createApp({ user_id: user.id, name: 'Key Only App' });

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/apps`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${app.key}` },
                body: JSON.stringify({ name: 'Should Fail' }),
            });
            assert.equal(res.status, 401);
            const data = await res.json();
            assert.ok(data.error.includes('API keys not accepted'));
        } finally {
            server.close();
        }
    });

    it('rejects missing name', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const user = createTestUser();
        const token = signToken(user);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/apps`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ description: 'No name' }),
            });
            assert.equal(res.status, 400);
        } finally {
            server.close();
        }
    });
});

describe('API — GET /api/v2/apps', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('lists only own apps', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const user1 = createTestUser({ google_id: 'g-list1', email: 'list1@test.com' });
        const user2 = createTestUser({ google_id: 'g-list2', email: 'list2@test.com' });
        dbApi.createApp({ user_id: user1.id, name: 'User1 App' });
        dbApi.createApp({ user_id: user2.id, name: 'User2 App' });
        const token = signToken(user1);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/apps`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const data = await res.json();
            assert.equal(res.status, 200);
            assert.equal(data.apps.length, 1);
            assert.equal(data.apps[0].name, 'User1 App');
        } finally {
            server.close();
        }
    });
});

describe('API — GET /api/v2/apps/:id', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('gets app with keys', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const user = createTestUser();
        const token = signToken(user);
        const app = dbApi.createApp({ user_id: user.id, name: 'Detail App' });

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/apps/${app.id}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const data = await res.json();
            assert.equal(res.status, 200);
            assert.equal(data.app.name, 'Detail App');
            assert.equal(data.keys.length, 1);
            assert.ok(data.keys[0].key.startsWith('cmk_'));
        } finally {
            server.close();
        }
    });

    it('returns 403 for another user\'s app', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const user1 = createTestUser({ google_id: 'g-own1', email: 'own1@test.com' });
        const user2 = createTestUser({ google_id: 'g-own2', email: 'own2@test.com' });
        const app = dbApi.createApp({ user_id: user1.id, name: 'Private App' });
        const token = signToken(user2);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/apps/${app.id}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            assert.equal(res.status, 403);
        } finally {
            server.close();
        }
    });

    it('returns 404 for nonexistent app', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const user = createTestUser();
        const token = signToken(user);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/apps/nonexistent`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            assert.equal(res.status, 404);
        } finally {
            server.close();
        }
    });
});

describe('API — PUT /api/v2/apps/:id', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('updates app name and description', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const user = createTestUser();
        const token = signToken(user);
        const app = dbApi.createApp({ user_id: user.id, name: 'Old', description: 'Old desc' });

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/apps/${app.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ name: 'Updated', description: 'New desc' }),
            });
            const data = await res.json();
            assert.equal(res.status, 200);
            assert.equal(data.app.name, 'Updated');
            assert.equal(data.app.description, 'New desc');
        } finally {
            server.close();
        }
    });

    it('rejects empty name', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const user = createTestUser();
        const token = signToken(user);
        const app = dbApi.createApp({ user_id: user.id, name: 'Keep Name' });

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/apps/${app.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ name: '   ' }),
            });
            assert.equal(res.status, 400);
        } finally {
            server.close();
        }
    });
});

describe('API — DELETE /api/v2/apps/:id', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('deletes app and revokes keys', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const user = createTestUser();
        const token = signToken(user);
        const app = dbApi.createApp({ user_id: user.id, name: 'Delete Me' });

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/apps/${app.id}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
            });
            const data = await res.json();
            assert.equal(res.status, 200);
            assert.equal(data.success, true);

            // App is gone
            assert.equal(dbApi.getApp(app.id), null);
            // Key is revoked
            assert.equal(dbApi.validateApiKey(app.key), null);
        } finally {
            server.close();
        }
    });

    it('returns 403 when deleting another user\'s app', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const user1 = createTestUser({ google_id: 'g-del1', email: 'del1@test.com' });
        const user2 = createTestUser({ google_id: 'g-del2', email: 'del2@test.com' });
        const app = dbApi.createApp({ user_id: user1.id, name: 'Not Yours' });
        const token = signToken(user2);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/apps/${app.id}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
            });
            assert.equal(res.status, 403);
        } finally {
            server.close();
        }
    });
});

describe('API — POST /api/v2/apps/:id/rotate-key', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('rotates key — old revoked, new returned', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const user = createTestUser();
        const token = signToken(user);
        const app = dbApi.createApp({ user_id: user.id, name: 'Rotate App' });
        const oldKey = app.key;

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/apps/${app.id}/rotate-key`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
            });
            const data = await res.json();
            assert.equal(res.status, 200);
            assert.equal(data.success, true);
            assert.ok(data.key.startsWith('cmk_'));
            assert.notEqual(data.key, oldKey);

            // Old key no longer works
            assert.equal(dbApi.validateApiKey(oldKey), null);
            // New key works
            assert.ok(dbApi.validateApiKey(data.key));
        } finally {
            server.close();
        }
    });

    it('returns 403 for another user\'s app', async () => {
        const testApp = createTestServer();
        const { server, port } = await startServer(testApp);
        const user1 = createTestUser({ google_id: 'g-rot1', email: 'rot1@test.com' });
        const user2 = createTestUser({ google_id: 'g-rot2', email: 'rot2@test.com' });
        const app = dbApi.createApp({ user_id: user1.id, name: 'Not Yours' });
        const token = signToken(user2);

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/apps/${app.id}/rotate-key`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
            });
            assert.equal(res.status, 403);
        } finally {
            server.close();
        }
    });
});

describe('App — AppKey works with v2Auth', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('AppKey from app authenticates via validateApiKey with correct app_id', () => {
        const user = createTestUser();
        const app = dbApi.createApp({ user_id: user.id, name: 'Auth App' });
        const validated = dbApi.validateApiKey(app.key);
        assert.ok(validated);
        assert.equal(validated.app_id, app.id);
        assert.equal(validated.created_by, user.id);
    });

    it('rotated key has same app_id', () => {
        const user = createTestUser();
        const app = dbApi.createApp({ user_id: user.id, name: 'Rotate Auth' });
        const newKey = dbApi.rotateAppKey(app.id, user.id);
        const validated = dbApi.validateApiKey(newKey.key);
        assert.ok(validated);
        assert.equal(validated.app_id, app.id);
    });
});
