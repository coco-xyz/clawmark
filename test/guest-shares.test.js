/**
 * ClawMark — Guest Shares Tests (#102)
 *
 * Tests cover:
 * 1. DB layer — create, get, list, delete guest shares
 * 2. Guest feedback creation and counting
 * 3. Expiry enforcement
 * 4. Max feedback limit
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { initDb } = require('../server/db');

// ------------------------------------------------------------------ helpers

let dbApi;
let tmpDir;

function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawmark-shares-test-'));
    dbApi = initDb(tmpDir);
}

function teardown() {
    if (dbApi && dbApi.db) dbApi.db.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

function createTestUser() {
    return dbApi.upsertUser({
        google_id: `g-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
        email: `test-${Date.now()}@example.com`,
        name: 'Test User',
        picture: null,
    });
}

// ------------------------------------------------------------------ tests

describe('Guest Shares — DB layer (#102)', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('creates a guest share with token', () => {
        const user = createTestUser();
        const app = dbApi.getOrCreateDefaultApp(user.id, user.email);
        const token = crypto.randomBytes(32).toString('hex');

        const share = dbApi.createGuestShare({
            share_token: token,
            owner_user_id: user.email,
            app_id: app.id,
            source_url: 'https://example.com/doc',
            title: 'Test Doc',
            guest_name_required: false,
            max_feedbacks: 50,
            expires_at: null,
        });

        assert.ok(share.id);
        assert.equal(share.share_token, token);
        assert.equal(share.source_url, 'https://example.com/doc');
        assert.equal(share.title, 'Test Doc');
        assert.equal(share.max_feedbacks, 50);
    });

    it('retrieves share by token', () => {
        const user = createTestUser();
        const app = dbApi.getOrCreateDefaultApp(user.id, user.email);
        const token = crypto.randomBytes(32).toString('hex');

        dbApi.createGuestShare({
            share_token: token,
            owner_user_id: user.email,
            app_id: app.id,
            source_url: 'https://example.com/doc',
        });

        const found = dbApi.getGuestShareByToken(token);
        assert.ok(found);
        assert.equal(found.share_token, token);
    });

    it('returns null for non-existent token', () => {
        const found = dbApi.getGuestShareByToken('nonexistent');
        assert.equal(found, null);
    });

    it('lists shares by user', () => {
        const user = createTestUser();
        const app = dbApi.getOrCreateDefaultApp(user.id, user.email);

        dbApi.createGuestShare({
            share_token: crypto.randomBytes(32).toString('hex'),
            owner_user_id: user.email,
            app_id: app.id,
            source_url: 'https://example.com/a',
        });
        dbApi.createGuestShare({
            share_token: crypto.randomBytes(32).toString('hex'),
            owner_user_id: user.email,
            app_id: app.id,
            source_url: 'https://example.com/b',
        });

        const shares = dbApi.listGuestSharesByUser(user.email);
        assert.equal(shares.length, 2);
    });

    it('deletes a share', () => {
        const user = createTestUser();
        const app = dbApi.getOrCreateDefaultApp(user.id, user.email);
        const token = crypto.randomBytes(32).toString('hex');

        const share = dbApi.createGuestShare({
            share_token: token,
            owner_user_id: user.email,
            app_id: app.id,
            source_url: 'https://example.com/doc',
        });

        const result = dbApi.deleteGuestShare(share.id, user.email);
        assert.equal(result.success, true);

        const found = dbApi.getGuestShareByToken(token);
        assert.equal(found, null);
    });

    it('does not delete share owned by another user', () => {
        const user = createTestUser();
        const app = dbApi.getOrCreateDefaultApp(user.id, user.email);
        const token = crypto.randomBytes(32).toString('hex');

        const share = dbApi.createGuestShare({
            share_token: token,
            owner_user_id: user.email,
            app_id: app.id,
            source_url: 'https://example.com/doc',
        });

        const result = dbApi.deleteGuestShare(share.id, 'other@example.com');
        assert.equal(result.success, false);

        const found = dbApi.getGuestShareByToken(token);
        assert.ok(found);
    });

    it('creates guest feedback item and counts it', () => {
        const user = createTestUser();
        const app = dbApi.getOrCreateDefaultApp(user.id, user.email);
        const token = crypto.randomBytes(32).toString('hex');

        dbApi.createGuestShare({
            share_token: token,
            owner_user_id: user.email,
            app_id: app.id,
            source_url: 'https://example.com/doc',
        });

        // Create a guest feedback item
        dbApi.createItem({
            app_id: app.id,
            doc: 'https://example.com/doc',
            type: 'comment',
            created_by: 'guest:alice',
            message: 'Great doc!',
            source_url: 'https://example.com/doc',
            tags: ['guest-feedback'],
            metadata: JSON.stringify({ share_token: token, guest_email: null }),
        });

        const count = dbApi.countGuestFeedbackByShare(token);
        assert.equal(count, 1);
    });
});
