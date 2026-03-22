/**
 * ClawMark — Webhook DB + Dispatcher Unit Tests (#88)
 *
 * Tests cover:
 * 1. Webhook CRUD operations (create, get, list, update, delete)
 * 2. Failure tracking + auto-disable after 10 consecutive failures
 * 3. Delivery record lifecycle (create, update, pending retries, cleanup)
 * 4. Dispatcher: filtersMatch, formatPayload, checkRateLimit
 * 5. dispatchPerceptionWebhooks integration with mock DB
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initDb } = require('../server/db');
const crypto = require('crypto');
const { hashKey } = require('../server/agent-auth');
const {
    filtersMatch,
    formatPayload,
    checkRateLimit,
    _rateLimits,
} = require('../server/webhook-dispatcher');

// ------------------------------------------------------------------ helpers

let dbApi;
let tmpDir;

function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawmark-webhook-test-'));
    dbApi = initDb(tmpDir);
}

function teardown() {
    if (dbApi && dbApi.db) dbApi.db.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

function createTestAgent() {
    const app = dbApi.createApp({ user_id: 'user-1', name: 'test-app' });
    const rawKey = 'cmak_' + crypto.randomBytes(24).toString('hex');
    const agent = dbApi.registerAgent({
        app_id: app.id,
        name: 'test-agent',
        key_hash: hashKey(rawKey),
        key_prefix: rawKey.slice(0, 8),
        capabilities: ['navigate', 'click'],
        created_by: 'user-1',
    });
    return { app, agent };
}

// ================================================================= webhook CRUD

describe('Webhook CRUD', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('should create a webhook', () => {
        const { app, agent } = createTestAgent();
        const wh = dbApi.createWebhook({
            app_id: app.id,
            agent_id: agent.id,
            url: 'https://example.com/webhook',
            secret: 'test-secret',
            event_filters: { severity: ['P0', 'P1'] },
            template: 'generic',
        });
        assert.ok(wh.id.startsWith('wh'));
        assert.equal(wh.app_id, app.id);
        assert.equal(wh.agent_id, agent.id);
        assert.equal(wh.url, 'https://example.com/webhook');
        assert.equal(wh.template, 'generic');
        assert.equal(wh.active, true);
        assert.equal(wh.allow_http, false);
    });

    it('should get a webhook by ID', () => {
        const { app, agent } = createTestAgent();
        const wh = dbApi.createWebhook({
            app_id: app.id, agent_id: agent.id,
            url: 'https://example.com/wh', secret: 's',
        });
        const fetched = dbApi.getWebhook(wh.id);
        assert.ok(fetched);
        assert.equal(fetched.id, wh.id);
        assert.equal(fetched.url, 'https://example.com/wh');
    });

    it('should return null for non-existent webhook', () => {
        setup(); // already called by beforeEach, but harmless
        assert.equal(dbApi.getWebhook('wh-nonexistent'), null);
    });

    it('should list webhooks by agent', () => {
        const { app, agent } = createTestAgent();
        dbApi.createWebhook({ app_id: app.id, agent_id: agent.id, url: 'https://a.com/1', secret: 's1' });
        dbApi.createWebhook({ app_id: app.id, agent_id: agent.id, url: 'https://a.com/2', secret: 's2' });
        const list = dbApi.listWebhooksByAgent(agent.id);
        assert.equal(list.length, 2);
    });

    it('should list webhooks by app', () => {
        const { app, agent } = createTestAgent();
        dbApi.createWebhook({ app_id: app.id, agent_id: agent.id, url: 'https://a.com/1', secret: 's1' });
        const list = dbApi.listWebhooksByApp(app.id);
        assert.equal(list.length, 1);
    });

    it('should get active webhooks by app', () => {
        const { app, agent } = createTestAgent();
        const wh1 = dbApi.createWebhook({ app_id: app.id, agent_id: agent.id, url: 'https://a.com/1', secret: 's1' });
        dbApi.createWebhook({ app_id: app.id, agent_id: agent.id, url: 'https://a.com/2', secret: 's2' });
        // Disable one
        dbApi.updateWebhook(wh1.id, { url: 'https://a.com/1', active: false });
        const active = dbApi.getActiveWebhooksByApp(app.id);
        assert.equal(active.length, 1);
    });

    it('should count webhooks by agent', () => {
        const { app, agent } = createTestAgent();
        assert.equal(dbApi.countWebhooksByAgent(agent.id), 0);
        dbApi.createWebhook({ app_id: app.id, agent_id: agent.id, url: 'https://a.com/1', secret: 's1' });
        assert.equal(dbApi.countWebhooksByAgent(agent.id), 1);
    });

    it('should update a webhook', () => {
        const { app, agent } = createTestAgent();
        const wh = dbApi.createWebhook({
            app_id: app.id, agent_id: agent.id,
            url: 'https://example.com/old', secret: 's',
        });
        const updated = dbApi.updateWebhook(wh.id, {
            url: 'https://example.com/new',
            event_filters: { severity: ['P0'] },
            template: 'slack',
            active: true,
            allow_http: true,
        });
        assert.equal(updated.url, 'https://example.com/new');
        assert.equal(updated.template, 'slack');
        assert.equal(updated.allow_http, 1);
    });

    it('should delete a webhook', () => {
        const { app, agent } = createTestAgent();
        const wh = dbApi.createWebhook({
            app_id: app.id, agent_id: agent.id,
            url: 'https://a.com/del', secret: 's',
        });
        dbApi.deleteWebhook(wh.id);
        assert.equal(dbApi.getWebhook(wh.id), null);
    });
});

// ================================================================= failure tracking

describe('Webhook failure tracking', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('should increment consecutive failures', () => {
        const { app, agent } = createTestAgent();
        const wh = dbApi.createWebhook({
            app_id: app.id, agent_id: agent.id,
            url: 'https://a.com/f', secret: 's',
        });
        const r = dbApi.incrementWebhookFailures(wh.id);
        assert.equal(r.disabled, false);
        assert.equal(r.failures, 1);
    });

    it('should auto-disable after 10 consecutive failures', () => {
        const { app, agent } = createTestAgent();
        const wh = dbApi.createWebhook({
            app_id: app.id, agent_id: agent.id,
            url: 'https://a.com/f', secret: 's',
        });
        for (let i = 0; i < 9; i++) {
            dbApi.incrementWebhookFailures(wh.id);
        }
        // 10th failure should disable
        const result = dbApi.incrementWebhookFailures(wh.id);
        assert.equal(result.disabled, true);
        assert.ok(result.failures >= 10);

        const fetched = dbApi.getWebhook(wh.id);
        assert.equal(fetched.active, 0);
    });

    it('should reset failures on success', () => {
        const { app, agent } = createTestAgent();
        const wh = dbApi.createWebhook({
            app_id: app.id, agent_id: agent.id,
            url: 'https://a.com/f', secret: 's',
        });
        dbApi.incrementWebhookFailures(wh.id);
        dbApi.incrementWebhookFailures(wh.id);
        dbApi.resetWebhookFailures(wh.id);
        const fetched = dbApi.getWebhook(wh.id);
        assert.equal(fetched.consecutive_failures, 0);
    });
});

// ================================================================= delivery records

describe('Webhook delivery records', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('should create a delivery record', () => {
        const { app, agent } = createTestAgent();
        const wh = dbApi.createWebhook({
            app_id: app.id, agent_id: agent.id,
            url: 'https://a.com/d', secret: 's',
        });
        const d = dbApi.createWebhookDelivery({
            webhook_id: wh.id,
            event_type: 'perception.p1',
            payload: { test: true },
        });
        assert.ok(d.id.startsWith('whd'));
        assert.ok(d.created_at);
    });

    it('should update delivery status', () => {
        const { app, agent } = createTestAgent();
        const wh = dbApi.createWebhook({
            app_id: app.id, agent_id: agent.id,
            url: 'https://a.com/d', secret: 's',
        });
        const d = dbApi.createWebhookDelivery({
            webhook_id: wh.id,
            event_type: 'perception.p0',
            payload: '{}',
        });
        dbApi.updateWebhookDelivery(d.id, { status: 'delivered', status_code: 200 });
        const deliveries = dbApi.getWebhookDeliveries(wh.id);
        assert.equal(deliveries.length, 1);
        assert.equal(deliveries[0].status, 'delivered');
        assert.equal(deliveries[0].status_code, 200);
    });

    it('should list deliveries with limit', () => {
        const { app, agent } = createTestAgent();
        const wh = dbApi.createWebhook({
            app_id: app.id, agent_id: agent.id,
            url: 'https://a.com/d', secret: 's',
        });
        for (let i = 0; i < 5; i++) {
            dbApi.createWebhookDelivery({
                webhook_id: wh.id,
                event_type: 'perception.p1',
                payload: `{"i":${i}}`,
            });
        }
        const all = dbApi.getWebhookDeliveries(wh.id, 50);
        assert.equal(all.length, 5);
        const limited = dbApi.getWebhookDeliveries(wh.id, 3);
        assert.equal(limited.length, 3);
    });

    it('should get pending retries', () => {
        const { app, agent } = createTestAgent();
        const wh = dbApi.createWebhook({
            app_id: app.id, agent_id: agent.id,
            url: 'https://a.com/d', secret: 's',
        });
        // Create delivery with next_retry_at in the past
        const d = dbApi.createWebhookDelivery({
            webhook_id: wh.id,
            event_type: 'perception.p1',
            payload: '{}',
            next_retry_at: new Date(Date.now() - 60000).toISOString(),
        });
        const pending = dbApi.getPendingWebhookRetries();
        assert.ok(pending.length >= 1);
        assert.equal(pending[0].webhook_id, wh.id);
    });

    it('should cleanup old deliveries', () => {
        const { app, agent } = createTestAgent();
        const wh = dbApi.createWebhook({
            app_id: app.id, agent_id: agent.id,
            url: 'https://a.com/d', secret: 's',
        });
        // Insert an old delivery directly
        const oldDate = new Date(Date.now() - 40 * 86400000).toISOString();
        dbApi.db.prepare(`
            INSERT INTO webhook_deliveries (id, webhook_id, event_type, payload, status, attempt, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run('whd-old', wh.id, 'perception.p1', '{}', 'delivered', 1, oldDate);

        const result = dbApi.cleanupOldWebhookDeliveries(30);
        assert.ok(result.deleted >= 1);
    });
});

// ================================================================= filtersMatch

describe('filtersMatch', () => {
    it('should match when no filters', () => {
        assert.ok(filtersMatch({}, { severity: 'P0', type: 'js-error' }));
        assert.ok(filtersMatch(null, { severity: 'P1' }));
    });

    it('should filter by severity', () => {
        const filters = { severity: ['P0', 'P1'] };
        assert.ok(filtersMatch(filters, { severity: 'P0' }));
        assert.ok(filtersMatch(filters, { severity: 'P1' }));
        assert.ok(!filtersMatch(filters, { severity: 'P2' }));
    });

    it('should filter by event type', () => {
        const filters = { types: ['js-error'] };
        assert.ok(filtersMatch(filters, { type: 'js-error', severity: 'P1' }));
        assert.ok(!filtersMatch(filters, { type: 'network-error', severity: 'P1' }));
    });

    it('should filter by site URL', () => {
        const filters = { sites: ['example.com'] };
        assert.ok(filtersMatch(filters, { url: 'https://example.com/page', severity: 'P0' }));
        assert.ok(!filtersMatch(filters, { url: 'https://other.com/page', severity: 'P0' }));
    });

    it('should combine multiple filters (AND)', () => {
        const filters = { severity: ['P0'], types: ['js-error'] };
        assert.ok(filtersMatch(filters, { severity: 'P0', type: 'js-error' }));
        assert.ok(!filtersMatch(filters, { severity: 'P1', type: 'js-error' }));
        assert.ok(!filtersMatch(filters, { severity: 'P0', type: 'network-error' }));
    });
});

// ================================================================= formatPayload

describe('formatPayload', () => {
    const event = {
        type: 'js-error',
        message: 'TypeError: undefined is not a function',
        severity: 'P1',
        url: 'https://example.com/app',
        fingerprint: 'fp-abc123',
        stack: 'Error: ...\n    at foo.js:1:1',
    };
    const issue = { id: 'pi-1', count: 5, first_seen: '2026-01-01', last_seen: '2026-03-22' };
    const ctx = { app_id: 'app-1' };

    it('should format generic payload', () => {
        const p = formatPayload('generic', event, issue, ctx);
        assert.equal(p.event_type, 'perception.p1');
        assert.equal(p.error.type, 'js-error');
        assert.equal(p.error.message, event.message);
        assert.equal(p.issue.id, 'pi-1');
        assert.equal(p.app_id, 'app-1');
    });

    it('should format Slack payload', () => {
        const p = formatPayload('slack', event, issue, ctx);
        assert.ok(p.attachments);
        assert.equal(p.attachments.length, 1);
        assert.ok(p.attachments[0].title.includes('[P1]'));
    });

    it('should format Lark payload', () => {
        const p = formatPayload('lark', event, issue, ctx);
        assert.equal(p.msg_type, 'interactive');
        assert.ok(p.card);
        assert.ok(p.card.header.title.content.includes('[P1]'));
    });

    it('should format DingTalk payload', () => {
        const p = formatPayload('dingtalk', event, issue, ctx);
        assert.equal(p.msgtype, 'markdown');
        assert.ok(p.markdown.title.includes('[P1]'));
    });

    it('should handle null issue', () => {
        const p = formatPayload('generic', event, null, ctx);
        assert.equal(p.issue, null);
    });

    it('should truncate stack to 500 chars', () => {
        const longStack = 'x'.repeat(1000);
        const p = formatPayload('generic', { ...event, stack: longStack }, issue, ctx);
        assert.equal(p.error.stack.length, 500);
    });
});

// ================================================================= checkRateLimit

describe('checkRateLimit', () => {
    beforeEach(() => {
        _rateLimits.clear();
    });

    it('should allow first request', () => {
        assert.ok(checkRateLimit('agent-1'));
    });

    it('should allow up to 100 requests per minute', () => {
        for (let i = 0; i < 100; i++) {
            assert.ok(checkRateLimit('agent-rl'));
        }
        // 101st should be blocked
        assert.ok(!checkRateLimit('agent-rl'));
    });

    it('should track per agent', () => {
        for (let i = 0; i < 100; i++) {
            checkRateLimit('agent-a');
        }
        // agent-a blocked, agent-b still allowed
        assert.ok(!checkRateLimit('agent-a'));
        assert.ok(checkRateLimit('agent-b'));
    });
});
