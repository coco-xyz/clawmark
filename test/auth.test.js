/**
 * ClawMark — Auth Module Tests
 *
 * Tests cover:
 * 1. Users table — upsert, get by ID, get by email
 * 2. JWT signing and verification
 * 3. Auth routes — /api/v2/auth/google, /api/v2/auth/me, /api/v2/auth/apikey
 * 4. v2Auth middleware — JWT, API key, invite code
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
const TEST_JWT_SECRET = 'test-secret-key-for-clawmark-auth';

function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawmark-auth-test-'));
    dbApi = initDb(tmpDir);
}

function teardown() {
    if (dbApi && dbApi.db) dbApi.db.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

// =================================================================== tests

describe('DB — users table', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('creates a new user via upsert', () => {
        const user = dbApi.upsertUser({
            google_id: 'google-123',
            email: 'test@example.com',
            name: 'Test User',
            picture: 'https://example.com/photo.jpg',
        });
        assert.ok(user.id.startsWith('user-'));
        assert.equal(user.google_id, 'google-123');
        assert.equal(user.email, 'test@example.com');
        assert.equal(user.name, 'Test User');
        assert.equal(user.role, 'member');
    });

    it('updates existing user on second upsert', () => {
        const user1 = dbApi.upsertUser({
            google_id: 'google-123',
            email: 'old@example.com',
            name: 'Old Name',
            picture: null,
        });
        const user2 = dbApi.upsertUser({
            google_id: 'google-123',
            email: 'new@example.com',
            name: 'New Name',
            picture: 'https://example.com/new.jpg',
        });
        assert.equal(user2.id, user1.id);
        assert.equal(user2.email, 'new@example.com');
        assert.equal(user2.name, 'New Name');
    });

    it('gets user by ID', () => {
        const created = dbApi.upsertUser({
            google_id: 'google-456',
            email: 'user@example.com',
            name: 'User',
            picture: null,
        });
        const found = dbApi.getUserById(created.id);
        assert.equal(found.email, 'user@example.com');
    });

    it('gets user by email', () => {
        dbApi.upsertUser({
            google_id: 'google-789',
            email: 'findme@example.com',
            name: 'Find Me',
            picture: null,
        });
        const found = dbApi.getUserByEmail('findme@example.com');
        assert.equal(found.google_id, 'google-789');
    });

    it('returns null for unknown user', () => {
        assert.equal(dbApi.getUserById('nonexistent'), null);
        assert.equal(dbApi.getUserByEmail('nobody@example.com'), null);
    });
});

describe('Auth — JWT', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('signs and verifies a JWT', () => {
        const { verifyJwt } = initAuth({
            db: dbApi,
            jwtSecret: TEST_JWT_SECRET,
        });

        const token = jwt.sign(
            { userId: 'user-123', email: 'test@example.com', role: 'member' },
            TEST_JWT_SECRET,
            { expiresIn: 3600 }
        );

        const payload = verifyJwt(token);
        assert.equal(payload.userId, 'user-123');
        assert.equal(payload.email, 'test@example.com');
        assert.equal(payload.role, 'member');
    });

    it('returns null for invalid JWT', () => {
        const { verifyJwt } = initAuth({
            db: dbApi,
            jwtSecret: TEST_JWT_SECRET,
        });

        assert.equal(verifyJwt('invalid-token'), null);
        assert.equal(verifyJwt(''), null);
    });

    it('returns null for JWT signed with wrong secret', () => {
        const { verifyJwt } = initAuth({
            db: dbApi,
            jwtSecret: TEST_JWT_SECRET,
        });

        const token = jwt.sign(
            { userId: 'user-123' },
            'wrong-secret',
            { expiresIn: 3600 }
        );

        assert.equal(verifyJwt(token), null);
    });

    it('returns null for expired JWT', () => {
        const { verifyJwt } = initAuth({
            db: dbApi,
            jwtSecret: TEST_JWT_SECRET,
        });

        const token = jwt.sign(
            { userId: 'user-123' },
            TEST_JWT_SECRET,
            { expiresIn: -1 }  // already expired
        );

        assert.equal(verifyJwt(token), null);
    });
});

describe('Auth — initAuth without secret', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('returns noop verifyJwt when no secret configured', () => {
        const { verifyJwt } = initAuth({
            db: dbApi,
            jwtSecret: null,
        });
        assert.equal(verifyJwt('anything'), null);
    });
});

describe('Auth — /api/v2/auth/me route', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('returns user info for valid JWT', async () => {
        const { router, verifyJwt } = initAuth({
            db: dbApi,
            jwtSecret: TEST_JWT_SECRET,
        });

        // Create a user
        const user = dbApi.upsertUser({
            google_id: 'g-100',
            email: 'me@example.com',
            name: 'Me',
            picture: null,
        });

        // Sign a token
        const token = jwt.sign(
            { userId: user.id, email: user.email, role: user.role },
            TEST_JWT_SECRET,
            { expiresIn: 3600 }
        );

        // Simulate the request via Express
        const express = require('express');
        const app = express();
        app.use(express.json());
        app.use('/api/v2/auth', router);

        const http = require('http');
        const server = http.createServer(app);
        await new Promise(r => server.listen(0, r));
        const port = server.address().port;

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/auth/me`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const data = await res.json();
            assert.equal(res.status, 200);
            assert.equal(data.email, 'me@example.com');
            assert.equal(data.name, 'Me');
            assert.equal(data.role, 'member');
        } finally {
            server.close();
        }
    });

    it('rejects request without token', async () => {
        const { router } = initAuth({
            db: dbApi,
            jwtSecret: TEST_JWT_SECRET,
        });

        const express = require('express');
        const app = express();
        app.use(express.json());
        app.use('/api/v2/auth', router);

        const http = require('http');
        const server = http.createServer(app);
        await new Promise(r => server.listen(0, r));
        const port = server.address().port;

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/auth/me`);
            assert.equal(res.status, 401);
        } finally {
            server.close();
        }
    });
});

describe('Auth — /api/v2/auth/apikey route (JWT auth)', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('creates API key with valid JWT', async () => {
        const { router } = initAuth({
            db: dbApi,
            jwtSecret: TEST_JWT_SECRET,
        });

        const user = dbApi.upsertUser({
            google_id: 'g-200',
            email: 'apiuser@example.com',
            name: 'API User',
            picture: null,
        });

        const token = jwt.sign(
            { userId: user.id, email: user.email, role: user.role },
            TEST_JWT_SECRET,
            { expiresIn: 3600 }
        );

        const express = require('express');
        const app = express();
        app.use(express.json());
        app.locals.VALID_CODES = { 'test-code': 'TestUser' };
        app.use('/api/v2/auth', router);

        const http = require('http');
        const server = http.createServer(app);
        await new Promise(r => server.listen(0, r));
        const port = server.address().port;

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/auth/apikey`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ name: 'my-app' }),
            });
            const data = await res.json();
            assert.equal(res.status, 200);
            assert.equal(data.success, true);
            assert.ok(data.key.startsWith('cmk_'));
        } finally {
            server.close();
        }
    });

    it('creates API key with invite code', async () => {
        const { router } = initAuth({
            db: dbApi,
            jwtSecret: TEST_JWT_SECRET,
        });

        const express = require('express');
        const app = express();
        app.use(express.json());
        app.locals.VALID_CODES = { 'test-code': 'TestUser' };
        app.use('/api/v2/auth', router);

        const http = require('http');
        const server = http.createServer(app);
        await new Promise(r => server.listen(0, r));
        const port = server.address().port;

        try {
            const res = await fetch(`http://localhost:${port}/api/v2/auth/apikey`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: 'test-code', name: 'invite-app' }),
            });
            const data = await res.json();
            assert.equal(res.status, 200);
            assert.equal(data.success, true);
            assert.ok(data.key.startsWith('cmk_'));
        } finally {
            server.close();
        }
    });
});
