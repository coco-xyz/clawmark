/**
 * ClawMark — Binding Tests (#106)
 *
 * Tests cover:
 * 1. Token generation and verification
 * 2. Binding DB CRUD
 * 3. Handshake flow (token → agent creation → binding activation)
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initDb } = require('../server/db');
const { generateBindingToken, verifyBindingToken, VALID_SCOPES } = require('../server/binding');
const { hashKey, generateAgentKey } = require('../server/agent-auth');

// ------------------------------------------------------------------ helpers

let dbApi;
let tmpDir;
const TEST_SECRET = 'test-jwt-secret-for-binding-tests-32chars!!';

function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawmark-binding-test-'));
    dbApi = initDb(tmpDir);
}

function teardown() {
    if (dbApi && dbApi.db) dbApi.db.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ================================================================= Token generation

describe('Binding Token — generateBindingToken', () => {
    it('should generate a token with cmbt_ prefix', () => {
        const result = generateBindingToken({
            app_id: 'app-1',
            scopes: ['perception'],
            created_by: 'user@test.com',
            expires_in: 3600,
            secret: TEST_SECRET,
        });

        assert.ok(result.token.startsWith('cmbt_'));
        assert.ok(result.hash);
        assert.ok(result.expires_at);
        assert.deepStrictEqual(result.payload.scopes, ['perception']);
        assert.strictEqual(result.payload.app_id, 'app-1');
    });

    it('should cap expiry at 7 days', () => {
        const result = generateBindingToken({
            app_id: 'app-1',
            scopes: ['perception'],
            created_by: 'user@test.com',
            expires_in: 999999999, // way beyond 7 days
            secret: TEST_SECRET,
        });

        const expires = new Date(result.expires_at);
        const maxExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000 + 5000);
        assert.ok(expires <= maxExpiry, 'Token expiry should not exceed 7 days');
    });

    it('should default to 24h expiry', () => {
        const result = generateBindingToken({
            app_id: 'app-1',
            scopes: ['perception'],
            created_by: 'user@test.com',
            secret: TEST_SECRET,
        });

        const expires = new Date(result.expires_at);
        const expected = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const diff = Math.abs(expires.getTime() - expected.getTime());
        assert.ok(diff < 5000, `Expiry should be ~24h from now (diff: ${diff}ms)`);
    });
});

describe('Binding Token — verifyBindingToken', () => {
    it('should verify a valid token', () => {
        const { token } = generateBindingToken({
            app_id: 'app-1',
            scopes: ['perception', 'action'],
            created_by: 'user@test.com',
            secret: TEST_SECRET,
        });

        const payload = verifyBindingToken(token, TEST_SECRET);
        assert.ok(payload);
        assert.strictEqual(payload.app_id, 'app-1');
        assert.deepStrictEqual(payload.scopes, ['perception', 'action']);
    });

    it('should reject token with wrong secret', () => {
        const { token } = generateBindingToken({
            app_id: 'app-1',
            scopes: ['perception'],
            created_by: 'user@test.com',
            secret: TEST_SECRET,
        });

        const payload = verifyBindingToken(token, 'wrong-secret');
        assert.strictEqual(payload, null);
    });

    it('should reject malformed token', () => {
        assert.strictEqual(verifyBindingToken('not-a-token', TEST_SECRET), null);
        assert.strictEqual(verifyBindingToken('cmbt_invalid', TEST_SECRET), null);
        assert.strictEqual(verifyBindingToken('', TEST_SECRET), null);
        assert.strictEqual(verifyBindingToken(null, TEST_SECRET), null);
    });
});

// ================================================================= DB Binding CRUD

describe('Binding DB — createBinding', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('should create a binding with pending status', () => {
        const binding = dbApi.createBinding({
            app_id: 'app-1',
            scopes: ['perception', 'action'],
            label: 'Test binding',
            token_hash: 'hash-123',
            token_expires: new Date(Date.now() + 86400000).toISOString(),
            created_by: 'user@test.com',
        });

        assert.ok(binding.id.startsWith('bind-'));
        assert.strictEqual(binding.status, 'pending');
        assert.deepStrictEqual(binding.scopes, ['perception', 'action']);
    });

    it('should fetch binding by ID with parsed scopes', () => {
        const created = dbApi.createBinding({
            app_id: 'app-1',
            scopes: ['perception'],
            token_hash: 'hash-456',
            token_expires: new Date(Date.now() + 86400000).toISOString(),
            created_by: 'user@test.com',
        });

        const fetched = dbApi.getBindingById(created.id);
        assert.ok(fetched);
        assert.deepStrictEqual(fetched.scopes, ['perception']);
        assert.strictEqual(fetched.status, 'pending');
        assert.strictEqual(fetched.token_used, 0);
    });

    it('should fetch binding by token hash', () => {
        const created = dbApi.createBinding({
            app_id: 'app-1',
            scopes: ['perception'],
            token_hash: 'unique-hash-789',
            token_expires: new Date(Date.now() + 86400000).toISOString(),
            created_by: 'user@test.com',
        });

        const fetched = dbApi.getBindingByTokenHash('unique-hash-789');
        assert.ok(fetched);
        assert.strictEqual(fetched.id, created.id);
    });

    it('should return null for non-existent token hash', () => {
        const fetched = dbApi.getBindingByTokenHash('does-not-exist');
        assert.strictEqual(fetched, null);
    });
});

describe('Binding DB — activateBinding', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('should activate a pending binding', () => {
        const created = dbApi.createBinding({
            app_id: 'app-1',
            scopes: ['perception', 'action'],
            token_hash: 'hash-activate',
            token_expires: new Date(Date.now() + 86400000).toISOString(),
            created_by: 'user@test.com',
        });

        const activated = dbApi.activateBinding(created.id, {
            agent_id: 'agent-1',
            agent_name: 'TestAgent',
            agent_type: 'zylos',
            agent_node_url: 'test.coco.site',
        });

        assert.strictEqual(activated.status, 'active');
        assert.strictEqual(activated.agent_id, 'agent-1');
        assert.strictEqual(activated.agent_name, 'TestAgent');
        assert.strictEqual(activated.token_used, 1);
        assert.ok(activated.activated_at);
    });
});

describe('Binding DB — updateBindingScopes', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('should update scopes', () => {
        const created = dbApi.createBinding({
            app_id: 'app-1',
            scopes: ['perception'],
            token_hash: 'hash-scopes',
            token_expires: new Date(Date.now() + 86400000).toISOString(),
            created_by: 'user@test.com',
        });

        const updated = dbApi.updateBindingScopes(created.id, ['perception', 'action', 'session']);
        assert.deepStrictEqual(updated.scopes, ['perception', 'action', 'session']);
    });
});

describe('Binding DB — updateBindingStatus', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('should suspend and resume a binding', () => {
        const created = dbApi.createBinding({
            app_id: 'app-1',
            scopes: ['perception'],
            token_hash: 'hash-status',
            token_expires: new Date(Date.now() + 86400000).toISOString(),
            created_by: 'user@test.com',
        });

        dbApi.activateBinding(created.id, {
            agent_id: 'agent-1',
            agent_name: 'Test',
        });

        const suspended = dbApi.updateBindingStatus(created.id, 'suspended');
        assert.strictEqual(suspended.status, 'suspended');

        const resumed = dbApi.updateBindingStatus(created.id, 'active');
        assert.strictEqual(resumed.status, 'active');
    });

    it('should revoke a binding', () => {
        const created = dbApi.createBinding({
            app_id: 'app-1',
            scopes: ['perception'],
            token_hash: 'hash-revoke',
            token_expires: new Date(Date.now() + 86400000).toISOString(),
            created_by: 'user@test.com',
        });

        const revoked = dbApi.updateBindingStatus(created.id, 'revoked');
        assert.strictEqual(revoked.status, 'revoked');

        // Revoked bindings should not appear in app listings
        const list = dbApi.getBindingsByApp('app-1');
        assert.strictEqual(list.length, 0);
    });
});

describe('Binding DB — getBindingsByApp', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('should list non-revoked bindings for an app', () => {
        dbApi.createBinding({ app_id: 'app-1', scopes: ['perception'], token_hash: 'h1', token_expires: new Date(Date.now() + 86400000).toISOString(), created_by: 'u' });
        dbApi.createBinding({ app_id: 'app-1', scopes: ['action'], token_hash: 'h2', token_expires: new Date(Date.now() + 86400000).toISOString(), created_by: 'u' });
        dbApi.createBinding({ app_id: 'app-2', scopes: ['perception'], token_hash: 'h3', token_expires: new Date(Date.now() + 86400000).toISOString(), created_by: 'u' });

        const app1Bindings = dbApi.getBindingsByApp('app-1');
        assert.strictEqual(app1Bindings.length, 2);

        const app2Bindings = dbApi.getBindingsByApp('app-2');
        assert.strictEqual(app2Bindings.length, 1);
    });
});

describe('Binding — VALID_SCOPES', () => {
    it('should have all expected scopes', () => {
        assert.deepStrictEqual(VALID_SCOPES, ['perception', 'action', 'session', 'annotation', 'issue', 'admin']);
    });
});
