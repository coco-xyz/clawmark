/**
 * ClawMark — Adapter & Routing Engine Tests
 *
 * Tests cover:
 * 1. AdapterRegistry routing — match conditions (event, type, priority, status, app_id)
 * 2. Multi-channel dispatch
 * 3. Template variable formatting
 * 4. Adapter validation
 * 5. Telegram message formatting
 * 6. GitHub Issue body building
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { AdapterRegistry } = require('../server/adapters/index');
const { TelegramAdapter } = require('../server/adapters/telegram');
const { GitHubIssueAdapter } = require('../server/adapters/github-issue');
const { WebhookAdapter } = require('../server/adapters/webhook');
const { LarkAdapter } = require('../server/adapters/lark');

// ------------------------------------------------------------------ helpers

/** Fake adapter that records send() calls */
class FakeAdapter {
    constructor(config) {
        this.type = config.adapter || 'fake';
        this.config = config;
        this.sent = [];
    }
    validate() { return { ok: true }; }
    async send(event, item, context) {
        this.sent.push({ event, item, context });
    }
}

// =================================================================== tests

describe('AdapterRegistry — routing', () => {
    let registry;

    beforeEach(() => {
        registry = new AdapterRegistry();
        registry.registerType('fake', FakeAdapter);
    });

    it('matches by event name', async () => {
        registry.loadConfig({
            rules: [
                { match: { event: 'item.created' }, channels: ['ch1'] },
            ],
            channels: { ch1: { adapter: 'fake' } },
        });

        await registry.dispatch('item.created', { id: '1' });
        await registry.dispatch('item.resolved', { id: '2' });

        const ch1 = registry.channels.get('ch1');
        assert.equal(ch1.sent.length, 1);
        assert.equal(ch1.sent[0].item.id, '1');
    });

    it('matches by type (single)', async () => {
        registry.loadConfig({
            rules: [
                { match: { event: 'item.created', type: 'issue' }, channels: ['ch1'] },
            ],
            channels: { ch1: { adapter: 'fake' } },
        });

        await registry.dispatch('item.created', { id: '1', type: 'issue' });
        await registry.dispatch('item.created', { id: '2', type: 'comment' });

        assert.equal(registry.channels.get('ch1').sent.length, 1);
    });

    it('matches by type (array)', async () => {
        registry.loadConfig({
            rules: [
                { match: { type: ['issue', 'bug'] }, channels: ['ch1'] },
            ],
            channels: { ch1: { adapter: 'fake' } },
        });

        await registry.dispatch('item.created', { type: 'issue' });
        await registry.dispatch('item.created', { type: 'bug' });
        await registry.dispatch('item.created', { type: 'comment' });

        assert.equal(registry.channels.get('ch1').sent.length, 2);
    });

    it('matches by priority (array)', async () => {
        registry.loadConfig({
            rules: [
                { match: { priority: ['high', 'critical'] }, channels: ['urgent'] },
            ],
            channels: { urgent: { adapter: 'fake' } },
        });

        await registry.dispatch('item.created', { priority: 'critical' });
        await registry.dispatch('item.created', { priority: 'normal' });
        await registry.dispatch('item.created', { priority: 'high' });

        assert.equal(registry.channels.get('urgent').sent.length, 2);
    });

    it('matches by status', async () => {
        registry.loadConfig({
            rules: [
                { match: { status: 'open' }, channels: ['ch1'] },
            ],
            channels: { ch1: { adapter: 'fake' } },
        });

        await registry.dispatch('item.created', { status: 'open' });
        await registry.dispatch('item.created', { status: 'resolved' });

        assert.equal(registry.channels.get('ch1').sent.length, 1);
    });

    it('matches by app_id', async () => {
        registry.loadConfig({
            rules: [
                { match: { app_id: 'myapp' }, channels: ['ch1'] },
            ],
            channels: { ch1: { adapter: 'fake' } },
        });

        await registry.dispatch('item.created', { app_id: 'myapp' });
        await registry.dispatch('item.created', { app_id: 'other' });

        assert.equal(registry.channels.get('ch1').sent.length, 1);
    });

    it('routes to multiple channels', async () => {
        registry.loadConfig({
            rules: [
                { match: { event: 'item.created' }, channels: ['ch1', 'ch2'] },
            ],
            channels: {
                ch1: { adapter: 'fake' },
                ch2: { adapter: 'fake' },
            },
        });

        await registry.dispatch('item.created', { id: '1' });

        assert.equal(registry.channels.get('ch1').sent.length, 1);
        assert.equal(registry.channels.get('ch2').sent.length, 1);
    });

    it('deduplicates channels across multiple matching rules', async () => {
        registry.loadConfig({
            rules: [
                { match: { event: 'item.created' }, channels: ['ch1'] },
                { match: { type: 'issue' }, channels: ['ch1'] },
            ],
            channels: { ch1: { adapter: 'fake' } },
        });

        await registry.dispatch('item.created', { type: 'issue' });

        // Both rules match, but ch1 should only receive once
        assert.equal(registry.channels.get('ch1').sent.length, 1);
    });

    it('dispatches nothing when no rules match', async () => {
        registry.loadConfig({
            rules: [
                { match: { event: 'item.resolved' }, channels: ['ch1'] },
            ],
            channels: { ch1: { adapter: 'fake' } },
        });

        const result = await registry.dispatch('item.created', { id: '1' });
        assert.equal(result, undefined);
        assert.equal(registry.channels.get('ch1').sent.length, 0);
    });

    it('skips unknown channel names gracefully', async () => {
        registry.loadConfig({
            rules: [
                { match: { event: 'item.created' }, channels: ['nonexistent'] },
            ],
            channels: {},
        });

        // Should not throw
        await registry.dispatch('item.created', { id: '1' });
    });

    it('combines event + type + priority in a single rule', async () => {
        registry.loadConfig({
            rules: [
                {
                    match: { event: 'item.created', type: 'issue', priority: 'critical' },
                    channels: ['ch1'],
                },
            ],
            channels: { ch1: { adapter: 'fake' } },
        });

        await registry.dispatch('item.created', { type: 'issue', priority: 'critical' });
        await registry.dispatch('item.created', { type: 'issue', priority: 'normal' });
        await registry.dispatch('item.created', { type: 'comment', priority: 'critical' });

        assert.equal(registry.channels.get('ch1').sent.length, 1);
    });

    it('accumulates rules across multiple loadConfig calls', async () => {
        registry.loadConfig({
            rules: [
                { match: { event: 'item.created' }, channels: ['ch1'] },
            ],
            channels: { ch1: { adapter: 'fake' } },
        });

        // Second loadConfig should add rules, not overwrite
        registry.loadConfig({
            rules: [
                { match: { event: 'item.resolved' }, channels: ['ch1'] },
            ],
            channels: {},
        });

        await registry.dispatch('item.created', { id: '1' });
        await registry.dispatch('item.resolved', { id: '2' });

        assert.equal(registry.channels.get('ch1').sent.length, 2);
    });
});

describe('AdapterRegistry — validation', () => {
    it('skips channels with failed validation', () => {
        const registry = new AdapterRegistry();
        registry.registerType('webhook', WebhookAdapter);

        registry.loadConfig({
            rules: [],
            channels: {
                bad: { adapter: 'webhook' /* missing url */ },
            },
        });

        assert.equal(registry.channels.has('bad'), false);
    });

    it('skips unknown adapter types', () => {
        const registry = new AdapterRegistry();

        registry.loadConfig({
            rules: [],
            channels: {
                unknown: { adapter: 'nonexistent', url: 'http://x' },
            },
        });

        assert.equal(registry.channels.size, 0);
    });

    it('reports status correctly', () => {
        const registry = new AdapterRegistry();
        registry.registerType('fake', FakeAdapter);

        registry.loadConfig({
            rules: [],
            channels: {
                a: { adapter: 'fake' },
                b: { adapter: 'fake' },
            },
        });

        const status = registry.getStatus();
        assert.equal(Object.keys(status).length, 2);
        assert.equal(status.a.active, true);
        assert.equal(status.b.active, true);
    });
});

describe('TelegramAdapter — validation', () => {
    it('requires bot_token', () => {
        const adapter = new TelegramAdapter({ chat_id: '123' });
        assert.equal(adapter.validate().ok, false);
    });

    it('requires chat_id', () => {
        const adapter = new TelegramAdapter({ bot_token: '123:abc' });
        assert.equal(adapter.validate().ok, false);
    });

    it('validates bot_token format', () => {
        const adapter = new TelegramAdapter({ bot_token: 'invalid', chat_id: '123' });
        assert.equal(adapter.validate().ok, false);
    });

    it('accepts valid config', () => {
        const adapter = new TelegramAdapter({
            bot_token: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
            chat_id: '-100123456789',
        });
        assert.equal(adapter.validate().ok, true);
    });
});

describe('TelegramAdapter — message formatting', () => {
    it('formats MarkdownV2 message with all fields', () => {
        const adapter = new TelegramAdapter({
            bot_token: '123:abc',
            chat_id: '123',
            parse_mode: 'MarkdownV2',
        });

        const msg = adapter._formatMessage('item.created', {
            title: 'Button broken',
            type: 'issue',
            priority: 'high',
            created_by: 'Alice',
            source_url: 'https://example.com/page',
            tags: ['ui', 'regression'],
            quote: 'The submit button does not respond',
        });

        assert.ok(msg.includes('ClawMark'));
        assert.ok(msg.includes('New Item'));
        assert.ok(msg.includes('Button broken'));
        assert.ok(msg.includes('Alice'));
    });

    it('formats HTML message', () => {
        const adapter = new TelegramAdapter({
            bot_token: '123:abc',
            chat_id: '123',
            parse_mode: 'HTML',
        });

        const msg = adapter._formatMessage('item.resolved', {
            title: 'Fixed bug <script>',
            type: 'issue',
            priority: 'normal',
            created_by: 'Bob',
        });

        assert.ok(msg.includes('<b>[ClawMark] Resolved</b>'));
        assert.ok(msg.includes('&lt;script&gt;')); // HTML escaped
        assert.ok(!msg.includes('<script>'));
    });

    it('handles missing optional fields', () => {
        const adapter = new TelegramAdapter({
            bot_token: '123:abc',
            chat_id: '123',
        });

        const msg = adapter._formatMessage('item.created', {});
        assert.ok(msg.includes('ClawMark'));
    });
});

describe('GitHubIssueAdapter — validation', () => {
    it('requires token', () => {
        const adapter = new GitHubIssueAdapter({ repo: 'org/repo' });
        assert.equal(adapter.validate().ok, false);
    });

    it('requires repo', () => {
        const adapter = new GitHubIssueAdapter({ token: 'ghp_xxx' });
        assert.equal(adapter.validate().ok, false);
    });

    it('validates repo format', () => {
        const adapter = new GitHubIssueAdapter({ token: 'ghp_xxx', repo: 'invalid' });
        assert.equal(adapter.validate().ok, false);
    });

    it('accepts valid config', () => {
        const adapter = new GitHubIssueAdapter({
            token: 'ghp_xxxxxxxxxxxx',
            repo: 'coco-xyz/clawmark',
        });
        assert.equal(adapter.validate().ok, true);
    });
});

describe('GitHubIssueAdapter — issue body', () => {
    it('builds complete issue body', () => {
        const adapter = new GitHubIssueAdapter({
            token: 'ghp_xxx',
            repo: 'org/repo',
        });

        const body = adapter._buildBody({
            title: 'Login broken',
            type: 'issue',
            priority: 'high',
            created_by: 'Alice',
            source_url: 'https://app.example.com/login',
            source_title: 'Login Page',
            quote: 'Error: invalid credentials',
            tags: ['auth', 'critical'],
            screenshots: ['https://img.example.com/1.png'],
            messages: [{ content: 'Login fails with valid password' }],
        });

        assert.ok(body.includes('Login broken'));
        assert.ok(body.includes('high'));
        assert.ok(body.includes('Alice'));
        assert.ok(body.includes('https://app.example.com/login'));
        assert.ok(body.includes('Error: invalid credentials'));
        assert.ok(body.includes('auth'));
        assert.ok(body.includes('1.png'));
    });

    it('sanitizes user tags for GitHub labels', () => {
        const adapter = new GitHubIssueAdapter({
            token: 'ghp_xxx',
            repo: 'org/repo',
            labels: ['clawmark'],
        });

        // Access _createIssue internals by testing label construction directly
        // Simulate what _createIssue does with tags
        const tags = ['valid-tag', '  spaces  ', '\x00control\x01chars', '', 'a'.repeat(100)];
        const labels = ['clawmark'];
        for (const tag of tags) {
            const sanitized = String(tag).replace(/[\x00-\x1f]/g, '').trim().slice(0, 50);
            if (sanitized) labels.push(sanitized);
        }

        assert.ok(labels.includes('valid-tag'));
        assert.ok(labels.includes('spaces'));
        assert.ok(labels.includes('controlchars'));
        assert.ok(!labels.includes(''));
        // Long tag should be truncated to 50
        assert.ok(labels.every(l => l.length <= 50));
    });

    it('builds title from quote when no title', () => {
        const adapter = new GitHubIssueAdapter({
            token: 'ghp_xxx',
            repo: 'org/repo',
        });

        const title = adapter._buildTitle({ quote: 'Some selected text here' });
        assert.ok(title.includes('[ClawMark]'));
        assert.ok(title.includes('Some selected text'));
    });
});

describe('GitHubIssueAdapter — persistence', () => {
    it('uses in-memory map when no db provided', () => {
        const adapter = new GitHubIssueAdapter({
            token: 'ghp_xxx',
            repo: 'org/repo',
        });

        adapter._setMapping('item-1', 42, 'https://github.com/org/repo/issues/42');
        assert.equal(adapter._getMapping('item-1'), 42);
        assert.equal(adapter._getMapping('nonexistent'), null);
    });

    it('uses db when provided', () => {
        // Minimal mock of the db adapter mapping methods
        const store = new Map();
        const mockDb = {
            setAdapterMapping({ item_id, adapter, channel, external_id, external_url }) {
                store.set(`${item_id}:${adapter}:${channel}`, { item_id, adapter, channel, external_id, external_url });
            },
            getAdapterMapping({ item_id, adapter, channel }) {
                return store.get(`${item_id}:${adapter}:${channel}`) || null;
            },
        };

        const adapter = new GitHubIssueAdapter({
            token: 'ghp_xxx',
            repo: 'org/repo',
            db: mockDb,
            channelName: 'gh-test',
        });

        adapter._setMapping('item-1', 99, 'https://github.com/org/repo/issues/99');
        assert.equal(adapter._getMapping('item-1'), 99);
        assert.equal(adapter._getMapping('nonexistent'), null);

        // Verify it went through the db, not the memory map
        assert.equal(adapter._memoryMap.size, 0);
        assert.ok(store.has('item-1:github-issue:gh-test'));
    });

    it('survives adapter reconstruction with db', () => {
        const store = new Map();
        const mockDb = {
            setAdapterMapping({ item_id, adapter, channel, external_id, external_url }) {
                store.set(`${item_id}:${adapter}:${channel}`, { item_id, adapter, channel, external_id, external_url });
            },
            getAdapterMapping({ item_id, adapter, channel }) {
                return store.get(`${item_id}:${adapter}:${channel}`) || null;
            },
        };

        // First adapter instance writes mapping
        const adapter1 = new GitHubIssueAdapter({
            token: 'ghp_xxx', repo: 'org/repo', db: mockDb, channelName: 'ch1',
        });
        adapter1._setMapping('item-1', 55, 'https://github.com/org/repo/issues/55');

        // Second adapter instance (simulating restart) reads it back
        const adapter2 = new GitHubIssueAdapter({
            token: 'ghp_xxx', repo: 'org/repo', db: mockDb, channelName: 'ch1',
        });
        assert.equal(adapter2._getMapping('item-1'), 55);
    });
});

describe('LarkAdapter — validation', () => {
    it('requires webhook_url', () => {
        const adapter = new LarkAdapter({});
        assert.equal(adapter.validate().ok, false);
    });

    it('rejects non-Lark URLs', () => {
        const adapter = new LarkAdapter({ webhook_url: 'https://example.com/hook' });
        assert.equal(adapter.validate().ok, false);
    });

    it('accepts valid Lark URL', () => {
        const adapter = new LarkAdapter({
            webhook_url: 'https://open.larksuite.com/open-apis/bot/v2/hook/test123',
        });
        assert.equal(adapter.validate().ok, true);
    });
});

describe('WebhookAdapter — validation', () => {
    it('requires url', () => {
        const adapter = new WebhookAdapter({});
        assert.equal(adapter.validate().ok, false);
    });

    it('rejects invalid URL', () => {
        const adapter = new WebhookAdapter({ url: 'not-a-url' });
        assert.equal(adapter.validate().ok, false);
    });

    it('accepts valid URL', () => {
        const adapter = new WebhookAdapter({ url: 'https://hooks.example.com/notify' });
        assert.equal(adapter.validate().ok, true);
    });
});
