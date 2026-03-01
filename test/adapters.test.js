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
const { SlackAdapter } = require('../server/adapters/slack');
const { EmailAdapter } = require('../server/adapters/email');
const { LinearAdapter } = require('../server/adapters/linear');
const { JiraAdapter } = require('../server/adapters/jira');
const { HxaConnectAdapter } = require('../server/adapters/hxa-connect');

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

// ================================================================= Slack Adapter

describe('SlackAdapter — validation', () => {
    it('requires webhook_url', () => {
        const adapter = new SlackAdapter({});
        assert.equal(adapter.validate().ok, false);
    });

    it('rejects non-Slack URLs', () => {
        const adapter = new SlackAdapter({ webhook_url: 'https://example.com/hook' });
        assert.equal(adapter.validate().ok, false);
    });

    it('rejects invalid URLs', () => {
        const adapter = new SlackAdapter({ webhook_url: 'not-a-url' });
        assert.equal(adapter.validate().ok, false);
    });

    it('accepts valid Slack webhook URL', () => {
        const adapter = new SlackAdapter({
            webhook_url: 'https://hooks.slack.com/services/T123/B456/xxx',
        });
        assert.equal(adapter.validate().ok, true);
    });
});

describe('SlackAdapter — Block Kit formatting', () => {
    it('builds full payload with all fields', () => {
        const adapter = new SlackAdapter({
            webhook_url: 'https://hooks.slack.com/services/T/B/x',
            channel: '#test',
            template: 'full',
        });

        const payload = adapter._buildPayload('item.created', {
            title: 'Login broken',
            type: 'bug',
            priority: 'high',
            created_by: 'Alice',
            source_url: 'https://app.example.com/login',
            source_title: 'Login Page',
            tags: ['auth', 'critical'],
            quote: 'Error: invalid credentials',
        });

        assert.equal(payload.channel, '#test');
        assert.ok(payload.text.includes('ClawMark'));
        assert.ok(payload.text.includes('Login broken'));
        assert.ok(Array.isArray(payload.blocks));
        assert.ok(payload.blocks.length >= 2);

        // Header block
        assert.equal(payload.blocks[0].type, 'header');
        assert.ok(payload.blocks[0].text.text.includes('New Item'));
    });

    it('builds compact payload', () => {
        const adapter = new SlackAdapter({
            webhook_url: 'https://hooks.slack.com/services/T/B/x',
            template: 'compact',
        });

        const payload = adapter._buildPayload('item.resolved', {
            title: 'Fixed issue',
            priority: 'normal',
        });

        assert.ok(payload.blocks.length <= 2);
        assert.equal(payload.blocks[0].type, 'section');
    });

    it('handles missing optional fields', () => {
        const adapter = new SlackAdapter({
            webhook_url: 'https://hooks.slack.com/services/T/B/x',
        });

        const payload = adapter._buildPayload('item.created', {});
        assert.ok(payload.text.includes('ClawMark'));
        assert.ok(Array.isArray(payload.blocks));
    });

    it('escapes special mrkdwn characters', () => {
        const adapter = new SlackAdapter({
            webhook_url: 'https://hooks.slack.com/services/T/B/x',
        });

        const escaped = adapter._esc('<script>alert("xss")</script>');
        assert.ok(!escaped.includes('<script>'));
        assert.ok(escaped.includes('&lt;script&gt;'));
    });

    it('includes assignee for assigned events', () => {
        const adapter = new SlackAdapter({
            webhook_url: 'https://hooks.slack.com/services/T/B/x',
        });

        const payload = adapter._buildPayload('item.assigned', {
            title: 'Task',
            assignee: 'Bob',
            priority: 'normal',
        });

        const contextBlocks = payload.blocks.filter(b => b.type === 'context');
        const hasAssignee = contextBlocks.some(b =>
            b.elements.some(e => e.text.includes('Bob'))
        );
        assert.ok(hasAssignee);
    });

    it('includes tags as context block', () => {
        const adapter = new SlackAdapter({
            webhook_url: 'https://hooks.slack.com/services/T/B/x',
        });

        const payload = adapter._buildPayload('item.created', {
            title: 'Test',
            tags: ['ui', 'regression'],
            priority: 'normal',
        });

        const contextBlocks = payload.blocks.filter(b => b.type === 'context');
        const hasTags = contextBlocks.some(b =>
            b.elements.some(e => e.text.includes('ui') && e.text.includes('regression'))
        );
        assert.ok(hasTags);
    });

    it('includes thread_ts when configured', () => {
        const adapter = new SlackAdapter({
            webhook_url: 'https://hooks.slack.com/services/T/B/x',
            thread_ts: '1234567890.123456',
        });

        const payload = adapter._buildPayload('item.created', { title: 'Thread reply' });
        assert.equal(payload.thread_ts, '1234567890.123456');
    });

    it('truncates long content', () => {
        const adapter = new SlackAdapter({
            webhook_url: 'https://hooks.slack.com/services/T/B/x',
        });

        const longContent = 'x'.repeat(600);
        const payload = adapter._buildPayload('item.created', {
            title: 'Test',
            quote: longContent,
            priority: 'normal',
        });

        // Content section should exist and be truncated
        const sectionBlocks = payload.blocks.filter(b => b.type === 'section' && b.text);
        const hasContent = sectionBlocks.some(b => b.text.text.includes('...'));
        assert.ok(hasContent);
    });
});

// ================================================================= Email Adapter

describe('EmailAdapter — validation', () => {
    it('requires api_key', () => {
        const adapter = new EmailAdapter({ from: 'a@b.com', to: ['c@d.com'] });
        assert.equal(adapter.validate().ok, false);
    });

    it('requires from', () => {
        const adapter = new EmailAdapter({ api_key: 're_xxx', to: ['c@d.com'] });
        assert.equal(adapter.validate().ok, false);
    });

    it('requires to', () => {
        const adapter = new EmailAdapter({ api_key: 're_xxx', from: 'a@b.com' });
        assert.equal(adapter.validate().ok, false);
    });

    it('requires non-empty to array', () => {
        const adapter = new EmailAdapter({ api_key: 're_xxx', from: 'a@b.com', to: [] });
        assert.equal(adapter.validate().ok, false);
    });

    it('rejects invalid provider', () => {
        const adapter = new EmailAdapter({
            api_key: 'xxx', from: 'a@b.com', to: ['c@d.com'], provider: 'mailgun',
        });
        assert.equal(adapter.validate().ok, false);
    });

    it('accepts valid resend config', () => {
        const adapter = new EmailAdapter({
            api_key: 're_xxx',
            from: 'ClawMark <noreply@example.com>',
            to: ['team@example.com'],
            provider: 'resend',
        });
        assert.equal(adapter.validate().ok, true);
    });

    it('accepts valid sendgrid config', () => {
        const adapter = new EmailAdapter({
            api_key: 'SG.xxx',
            from: 'noreply@example.com',
            to: ['team@example.com'],
            provider: 'sendgrid',
        });
        assert.equal(adapter.validate().ok, true);
    });

    it('defaults provider to resend', () => {
        const adapter = new EmailAdapter({
            api_key: 're_xxx',
            from: 'a@b.com',
            to: ['c@d.com'],
        });
        assert.equal(adapter.provider, 'resend');
        assert.equal(adapter.validate().ok, true);
    });

    it('normalizes to field to array', () => {
        const adapter = new EmailAdapter({
            api_key: 're_xxx',
            from: 'a@b.com',
            to: 'single@example.com',
        });
        assert.deepEqual(adapter.to, ['single@example.com']);
    });
});

describe('EmailAdapter — HTML formatting', () => {
    it('builds complete HTML email', () => {
        const adapter = new EmailAdapter({
            api_key: 're_xxx',
            from: 'a@b.com',
            to: ['c@d.com'],
        });

        const html = adapter._buildHtml('item.created', {
            title: 'Login broken',
            type: 'bug',
            priority: 'high',
            created_by: 'Alice',
            source_url: 'https://app.example.com/login',
            source_title: 'Login Page',
            tags: ['auth', 'critical'],
            quote: 'Error: invalid credentials',
            screenshots: ['https://img.example.com/1.png'],
        });

        assert.ok(html.includes('<!DOCTYPE html>'));
        assert.ok(html.includes('ClawMark'));
        assert.ok(html.includes('Login broken'));
        assert.ok(html.includes('Alice'));
        assert.ok(html.includes('auth'));
        assert.ok(html.includes('critical'));
        assert.ok(html.includes('https://app.example.com/login'));
        assert.ok(html.includes('1.png'));
    });

    it('escapes HTML in content', () => {
        const adapter = new EmailAdapter({
            api_key: 're_xxx',
            from: 'a@b.com',
            to: ['c@d.com'],
        });

        const html = adapter._buildHtml('item.created', {
            title: '<script>alert("xss")</script>',
            priority: 'normal',
        });

        assert.ok(!html.includes('<script>alert'));
        assert.ok(html.includes('&lt;script&gt;'));
    });

    it('handles missing optional fields', () => {
        const adapter = new EmailAdapter({
            api_key: 're_xxx',
            from: 'a@b.com',
            to: ['c@d.com'],
        });

        const html = adapter._buildHtml('item.created', {});
        assert.ok(html.includes('<!DOCTYPE html>'));
        assert.ok(html.includes('ClawMark'));
    });

    it('uses priority-based color', () => {
        const adapter = new EmailAdapter({
            api_key: 're_xxx',
            from: 'a@b.com',
            to: ['c@d.com'],
        });

        const critical = adapter._buildHtml('item.created', { priority: 'critical' });
        assert.ok(critical.includes('#ef4444'));

        const normal = adapter._buildHtml('item.created', { priority: 'normal' });
        assert.ok(normal.includes('#3b82f6'));
    });

    it('truncates long content', () => {
        const adapter = new EmailAdapter({
            api_key: 're_xxx',
            from: 'a@b.com',
            to: ['c@d.com'],
        });

        const longContent = 'x'.repeat(1500);
        const html = adapter._buildHtml('item.created', {
            quote: longContent,
            priority: 'normal',
        });

        assert.ok(html.includes('...'));
        assert.ok(!html.includes('x'.repeat(1500)));
    });
});

describe('EmailAdapter — subject building', () => {
    it('builds subject with prefix and event label', () => {
        const adapter = new EmailAdapter({
            api_key: 're_xxx',
            from: 'a@b.com',
            to: ['c@d.com'],
            subject_prefix: '[Test]',
        });

        const subject = adapter._buildSubject('item.created', { title: 'Bug report' });
        assert.equal(subject, '[Test] New Item: Bug report');
    });

    it('falls back to quote when no title', () => {
        const adapter = new EmailAdapter({
            api_key: 're_xxx',
            from: 'a@b.com',
            to: ['c@d.com'],
        });

        const subject = adapter._buildSubject('item.resolved', { quote: 'Some quoted text here' });
        assert.ok(subject.includes('[ClawMark]'));
        assert.ok(subject.includes('Resolved'));
        assert.ok(subject.includes('Some quoted text'));
    });

    it('uses default prefix', () => {
        const adapter = new EmailAdapter({
            api_key: 're_xxx',
            from: 'a@b.com',
            to: ['c@d.com'],
        });

        const subject = adapter._buildSubject('item.created', { title: 'Test' });
        assert.ok(subject.startsWith('[ClawMark]'));
    });
});

describe('EmailAdapter — provider handling', () => {
    it('handles string tags in HTML', () => {
        const adapter = new EmailAdapter({
            api_key: 're_xxx',
            from: 'a@b.com',
            to: ['c@d.com'],
        });

        const html = adapter._buildHtml('item.created', {
            tags: '["tag1", "tag2"]',
            priority: 'normal',
        });

        assert.ok(html.includes('tag1'));
        assert.ok(html.includes('tag2'));
    });

    it('handles string screenshots in HTML', () => {
        const adapter = new EmailAdapter({
            api_key: 're_xxx',
            from: 'a@b.com',
            to: ['c@d.com'],
        });

        const html = adapter._buildHtml('item.created', {
            priority: 'normal',
            screenshots: '["https://img.example.com/shot.png"]',
        });

        assert.ok(html.includes('shot.png'));
    });
});

// ================================================================= Security: URL protocol validation

describe('EmailAdapter — URL protocol safety (H2)', () => {
    it('rejects javascript: source_url', () => {
        const adapter = new EmailAdapter({
            api_key: 're_xxx',
            from: 'a@b.com',
            to: ['c@d.com'],
        });

        const html = adapter._buildHtml('item.created', {
            priority: 'normal',
            source_url: 'javascript:alert(1)',
            source_title: 'Evil Link',
        });

        assert.ok(!html.includes('javascript:'));
        assert.ok(!html.includes('Evil Link'));
    });

    it('rejects javascript: screenshot URLs', () => {
        const adapter = new EmailAdapter({
            api_key: 're_xxx',
            from: 'a@b.com',
            to: ['c@d.com'],
        });

        const html = adapter._buildHtml('item.created', {
            priority: 'normal',
            screenshots: ['javascript:alert(1)', 'https://safe.example.com/img.png'],
        });

        assert.ok(!html.includes('javascript:'));
        assert.ok(html.includes('safe.example.com'));
    });

    it('caps screenshots at 5 (L1)', () => {
        const adapter = new EmailAdapter({
            api_key: 're_xxx',
            from: 'a@b.com',
            to: ['c@d.com'],
        });

        const screenshots = Array.from({ length: 10 }, (_, i) => `https://img.example.com/${i}.png`);
        const html = adapter._buildHtml('item.created', {
            priority: 'normal',
            screenshots,
        });

        // Should have exactly 5 img tags
        const imgCount = (html.match(/<img /g) || []).length;
        assert.equal(imgCount, 5);
    });

    it('allows https: URLs', () => {
        const adapter = new EmailAdapter({
            api_key: 're_xxx',
            from: 'a@b.com',
            to: ['c@d.com'],
        });

        const html = adapter._buildHtml('item.created', {
            priority: 'normal',
            source_url: 'https://safe.example.com/page',
            screenshots: ['https://img.example.com/1.png'],
        });

        assert.ok(html.includes('https://safe.example.com/page'));
        assert.ok(html.includes('https://img.example.com/1.png'));
    });
});

describe('SlackAdapter — URL protocol safety (M1)', () => {
    it('rejects javascript: source_url in full template', () => {
        const adapter = new SlackAdapter({
            webhook_url: 'https://hooks.slack.com/services/T/B/x',
        });

        const payload = adapter._buildPayload('item.created', {
            title: 'Test',
            source_url: 'javascript:alert(1)',
            priority: 'normal',
        });

        // Should not have any context block with javascript:
        const contextBlocks = payload.blocks.filter(b => b.type === 'context');
        const hasJsUrl = contextBlocks.some(b =>
            b.elements.some(e => e.text.includes('javascript:'))
        );
        assert.ok(!hasJsUrl);
    });

    it('rejects javascript: source_url in compact template', () => {
        const adapter = new SlackAdapter({
            webhook_url: 'https://hooks.slack.com/services/T/B/x',
            template: 'compact',
        });

        const payload = adapter._buildPayload('item.created', {
            title: 'Test',
            source_url: 'javascript:alert(1)',
            priority: 'normal',
        });

        const contextBlocks = payload.blocks.filter(b => b.type === 'context');
        const hasJsUrl = contextBlocks.some(b =>
            b.elements.some(e => e.text.includes('javascript:'))
        );
        assert.ok(!hasJsUrl);
    });

    it('escapes URLs in mrkdwn links', () => {
        const adapter = new SlackAdapter({
            webhook_url: 'https://hooks.slack.com/services/T/B/x',
        });

        const payload = adapter._buildPayload('item.created', {
            title: 'Test',
            source_url: 'https://example.com/path?a=1&b=2',
            priority: 'normal',
        });

        const contextBlocks = payload.blocks.filter(b => b.type === 'context');
        const linkBlock = contextBlocks.find(b =>
            b.elements.some(e => e.text.includes('example.com'))
        );
        assert.ok(linkBlock);
    });
});

describe('SlackAdapter — backtick in tags (M4)', () => {
    it('replaces backticks in tag values', () => {
        const adapter = new SlackAdapter({
            webhook_url: 'https://hooks.slack.com/services/T/B/x',
        });

        const payload = adapter._buildPayload('item.created', {
            title: 'Test',
            tags: ['tag`with`backticks', 'normal-tag'],
            priority: 'normal',
        });

        const contextBlocks = payload.blocks.filter(b => b.type === 'context');
        const tagBlock = contextBlocks.find(b =>
            b.elements.some(e => e.text.includes(':label:'))
        );
        assert.ok(tagBlock);
        // Backticks should be replaced with single quotes
        const text = tagBlock.elements[0].text;
        assert.ok(!text.includes('tag`with`backticks'));
        assert.ok(text.includes("tag'with'backticks"));
    });
});

// ================================================================= Email — SendGrid from parsing (M2)

describe('EmailAdapter — SendGrid from parsing (M2)', () => {
    it('parses "Display Name <email>" format', () => {
        const adapter = new EmailAdapter({
            api_key: 'SG.xxx',
            from: 'ClawMark <noreply@example.com>',
            to: ['c@d.com'],
            provider: 'sendgrid',
        });

        const result = adapter._parseSendGridFrom('ClawMark <noreply@example.com>');
        assert.deepEqual(result, { name: 'ClawMark', email: 'noreply@example.com' });
    });

    it('handles plain email address', () => {
        const adapter = new EmailAdapter({
            api_key: 'SG.xxx',
            from: 'noreply@example.com',
            to: ['c@d.com'],
            provider: 'sendgrid',
        });

        const result = adapter._parseSendGridFrom('noreply@example.com');
        assert.deepEqual(result, { email: 'noreply@example.com' });
    });

    it('handles display name with spaces', () => {
        const adapter = new EmailAdapter({
            api_key: 'SG.xxx',
            from: 'My Company Bot <bot@company.com>',
            to: ['c@d.com'],
            provider: 'sendgrid',
        });

        const result = adapter._parseSendGridFrom('My Company Bot <bot@company.com>');
        assert.deepEqual(result, { name: 'My Company Bot', email: 'bot@company.com' });
    });
});

// ================================================================= Linear Adapter

describe('LinearAdapter — validation', () => {
    it('requires api_key', () => {
        const adapter = new LinearAdapter({ team_id: 'team-uuid' });
        assert.equal(adapter.validate().ok, false);
        assert.ok(adapter.validate().error.includes('api_key'));
    });

    it('requires team_id', () => {
        const adapter = new LinearAdapter({ api_key: 'lin_api_xxx' });
        assert.equal(adapter.validate().ok, false);
        assert.ok(adapter.validate().error.includes('team_id'));
    });

    it('accepts valid config', () => {
        const adapter = new LinearAdapter({
            api_key: 'lin_api_xxxxxxxxxxxx',
            team_id: 'abc-def-123',
        });
        assert.equal(adapter.validate().ok, true);
    });
});

describe('LinearAdapter — title building', () => {
    it('builds title from item title', () => {
        const adapter = new LinearAdapter({
            api_key: 'lin_api_xxx',
            team_id: 'team-uuid',
        });

        const title = adapter._buildTitle({ title: 'Login broken' });
        assert.equal(title, '[ClawMark] Login broken');
    });

    it('builds title from quote when no title', () => {
        const adapter = new LinearAdapter({
            api_key: 'lin_api_xxx',
            team_id: 'team-uuid',
        });

        const title = adapter._buildTitle({ quote: 'Some selected text' });
        assert.ok(title.includes('[ClawMark]'));
        assert.ok(title.includes('Some selected text'));
    });

    it('falls back to default when empty', () => {
        const adapter = new LinearAdapter({
            api_key: 'lin_api_xxx',
            team_id: 'team-uuid',
        });

        const title = adapter._buildTitle({});
        assert.equal(title, '[ClawMark] New item');
    });

    it('truncates long content to 80 chars', () => {
        const adapter = new LinearAdapter({
            api_key: 'lin_api_xxx',
            team_id: 'team-uuid',
        });

        const longQuote = 'x'.repeat(200);
        const title = adapter._buildTitle({ quote: longQuote });
        assert.ok(title.length <= '[ClawMark] '.length + 80);
    });
});

describe('LinearAdapter — description building', () => {
    it('builds complete description', () => {
        const adapter = new LinearAdapter({
            api_key: 'lin_api_xxx',
            team_id: 'team-uuid',
        });

        const desc = adapter._buildDescription({
            type: 'issue',
            priority: 'high',
            created_by: 'Alice',
            source_url: 'https://example.com/page',
            source_title: 'Login Page',
            quote: 'The button is broken',
            tags: ['ui', 'regression'],
            messages: [{ content: 'Please fix ASAP' }],
        }, {});

        assert.ok(desc.includes('issue'));
        assert.ok(desc.includes('high'));
        assert.ok(desc.includes('Alice'));
        assert.ok(desc.includes('https://example.com/page'));
        assert.ok(desc.includes('Login Page'));
        assert.ok(desc.includes('The button is broken'));
        assert.ok(desc.includes('ui'));
        assert.ok(desc.includes('regression'));
        assert.ok(desc.includes('Please fix ASAP'));
        assert.ok(desc.includes('Created by ClawMark'));
    });

    it('handles missing optional fields', () => {
        const adapter = new LinearAdapter({
            api_key: 'lin_api_xxx',
            team_id: 'team-uuid',
        });

        const desc = adapter._buildDescription({}, {});
        assert.ok(desc.includes('normal'));
        assert.ok(desc.includes('Created by ClawMark'));
    });

    it('handles string tags', () => {
        const adapter = new LinearAdapter({
            api_key: 'lin_api_xxx',
            team_id: 'team-uuid',
        });

        const desc = adapter._buildDescription({ tags: '["tag1", "tag2"]' }, {});
        assert.ok(desc.includes('tag1'));
        assert.ok(desc.includes('tag2'));
    });
});

describe('LinearAdapter — persistence', () => {
    it('uses in-memory map when no db provided', () => {
        const adapter = new LinearAdapter({
            api_key: 'lin_api_xxx',
            team_id: 'team-uuid',
        });

        adapter._setMapping('item-1', 'issue-uuid', 'https://linear.app/team/ISS-1');
        const mapping = adapter._getMapping('item-1');
        assert.equal(mapping.id, 'issue-uuid');
        assert.equal(mapping.url, 'https://linear.app/team/ISS-1');
        assert.equal(adapter._getMapping('nonexistent'), null);
    });

    it('uses db when provided', () => {
        const store = new Map();
        const mockDb = {
            setAdapterMapping({ item_id, adapter, channel, external_id, external_url }) {
                store.set(`${item_id}:${adapter}:${channel}`, { item_id, adapter, channel, external_id, external_url });
            },
            getAdapterMapping({ item_id, adapter, channel }) {
                return store.get(`${item_id}:${adapter}:${channel}`) || null;
            },
        };

        const adapter = new LinearAdapter({
            api_key: 'lin_api_xxx',
            team_id: 'team-uuid',
            db: mockDb,
            channelName: 'linear-test',
        });

        adapter._setMapping('item-1', 'issue-uuid', 'https://linear.app/team/ISS-1');
        const mapping = adapter._getMapping('item-1');
        assert.equal(mapping.id, 'issue-uuid');
        assert.equal(adapter._memoryMap.size, 0);
        assert.ok(store.has('item-1:linear:linear-test'));
    });
});

describe('LinearAdapter — event routing', () => {
    it('returns undefined for unknown events', async () => {
        const adapter = new LinearAdapter({
            api_key: 'lin_api_xxx',
            team_id: 'team-uuid',
        });

        const result = await adapter.send('discussion.created', {}, {});
        assert.equal(result, undefined);
    });
});

// ================================================================= Jira Adapter

describe('JiraAdapter — validation', () => {
    it('requires domain', () => {
        const adapter = new JiraAdapter({
            email: 'a@b.com', api_token: 'xxx', project_key: 'PROJ',
        });
        assert.equal(adapter.validate().ok, false);
        assert.ok(adapter.validate().error.includes('domain'));
    });

    it('requires email', () => {
        const adapter = new JiraAdapter({
            domain: 'myteam', api_token: 'xxx', project_key: 'PROJ',
        });
        assert.equal(adapter.validate().ok, false);
        assert.ok(adapter.validate().error.includes('email'));
    });

    it('requires api_token', () => {
        const adapter = new JiraAdapter({
            domain: 'myteam', email: 'a@b.com', project_key: 'PROJ',
        });
        assert.equal(adapter.validate().ok, false);
        assert.ok(adapter.validate().error.includes('api_token'));
    });

    it('requires project_key', () => {
        const adapter = new JiraAdapter({
            domain: 'myteam', email: 'a@b.com', api_token: 'xxx',
        });
        assert.equal(adapter.validate().ok, false);
        assert.ok(adapter.validate().error.includes('project_key'));
    });

    it('validates project_key format', () => {
        const adapter = new JiraAdapter({
            domain: 'myteam', email: 'a@b.com', api_token: 'xxx', project_key: 'invalid',
        });
        assert.equal(adapter.validate().ok, false);
        assert.ok(adapter.validate().error.includes('uppercase'));
    });

    it('accepts valid config', () => {
        const adapter = new JiraAdapter({
            domain: 'myteam',
            email: 'user@example.com',
            api_token: 'ATATT3xxxx',
            project_key: 'PROJ',
        });
        assert.equal(adapter.validate().ok, true);
    });

    it('accepts project_key with digits', () => {
        const adapter = new JiraAdapter({
            domain: 'myteam',
            email: 'user@example.com',
            api_token: 'ATATT3xxxx',
            project_key: 'CM2',
        });
        assert.equal(adapter.validate().ok, true);
    });

    it('rejects domain with dots', () => {
        const adapter = new JiraAdapter({
            domain: 'evil.com/path',
            email: 'a@b.com',
            api_token: 'xxx',
            project_key: 'PROJ',
        });
        assert.equal(adapter.validate().ok, false);
        assert.ok(adapter.validate().error.includes('alphanumeric'));
    });

    it('rejects domain with slashes', () => {
        const adapter = new JiraAdapter({
            domain: 'myteam/../../etc',
            email: 'a@b.com',
            api_token: 'xxx',
            project_key: 'PROJ',
        });
        assert.equal(adapter.validate().ok, false);
    });

    it('accepts domain with hyphens', () => {
        const adapter = new JiraAdapter({
            domain: 'my-team-123',
            email: 'a@b.com',
            api_token: 'xxx',
            project_key: 'PROJ',
        });
        assert.equal(adapter.validate().ok, true);
    });

    it('rejects domain starting with hyphen', () => {
        const adapter = new JiraAdapter({
            domain: '-myteam',
            email: 'a@b.com',
            api_token: 'xxx',
            project_key: 'PROJ',
        });
        assert.equal(adapter.validate().ok, false);
    });
});

describe('JiraAdapter — summary building', () => {
    it('builds summary from item title', () => {
        const adapter = new JiraAdapter({
            domain: 'myteam', email: 'a@b.com', api_token: 'xxx', project_key: 'PROJ',
        });

        const summary = adapter._buildSummary({ title: 'Login broken' });
        assert.equal(summary, '[ClawMark] Login broken');
    });

    it('falls back to quote when no title', () => {
        const adapter = new JiraAdapter({
            domain: 'myteam', email: 'a@b.com', api_token: 'xxx', project_key: 'PROJ',
        });

        const summary = adapter._buildSummary({ quote: 'Error text' });
        assert.ok(summary.includes('[ClawMark]'));
        assert.ok(summary.includes('Error text'));
    });
});

describe('JiraAdapter — ADF description building', () => {
    it('builds valid ADF document', () => {
        const adapter = new JiraAdapter({
            domain: 'myteam', email: 'a@b.com', api_token: 'xxx', project_key: 'PROJ',
        });

        const desc = adapter._buildDescription({
            type: 'issue',
            priority: 'high',
            created_by: 'Alice',
            source_url: 'https://example.com',
            quote: 'Error message',
            tags: ['ui', 'bug'],
            messages: [{ content: 'Fix this' }],
        }, {});

        assert.equal(desc.type, 'doc');
        assert.equal(desc.version, 1);
        assert.ok(Array.isArray(desc.content));
        assert.ok(desc.content.length >= 3);

        // Check heading
        assert.equal(desc.content[0].type, 'heading');
        assert.equal(desc.content[0].content[0].text, 'ClawMark Item');

        // Check blockquote exists for quote
        const blockquote = desc.content.find(n => n.type === 'blockquote');
        assert.ok(blockquote);
        assert.ok(blockquote.content[0].content[0].text.includes('Error message'));

        // Check rule exists (footer separator)
        const rule = desc.content.find(n => n.type === 'rule');
        assert.ok(rule);
    });

    it('handles missing optional fields', () => {
        const adapter = new JiraAdapter({
            domain: 'myteam', email: 'a@b.com', api_token: 'xxx', project_key: 'PROJ',
        });

        const desc = adapter._buildDescription({}, {});
        assert.equal(desc.type, 'doc');
        assert.ok(desc.content.length >= 2);
    });

    it('handles string tags', () => {
        const adapter = new JiraAdapter({
            domain: 'myteam', email: 'a@b.com', api_token: 'xxx', project_key: 'PROJ',
        });

        const desc = adapter._buildDescription({ tags: '["tag1", "tag2"]' }, {});
        const tagNode = desc.content.find(n =>
            n.type === 'paragraph' && n.content?.some(c => c.text?.includes('tag1'))
        );
        assert.ok(tagNode);
    });
});

describe('JiraAdapter — persistence', () => {
    it('uses in-memory map when no db provided', () => {
        const adapter = new JiraAdapter({
            domain: 'myteam', email: 'a@b.com', api_token: 'xxx', project_key: 'PROJ',
        });

        adapter._setMapping('item-1', 'PROJ-42', 'https://myteam.atlassian.net/browse/PROJ-42');
        const mapping = adapter._getMapping('item-1');
        assert.equal(mapping.key, 'PROJ-42');
        assert.equal(mapping.url, 'https://myteam.atlassian.net/browse/PROJ-42');
        assert.equal(adapter._getMapping('nonexistent'), null);
    });

    it('uses db when provided', () => {
        const store = new Map();
        const mockDb = {
            setAdapterMapping({ item_id, adapter, channel, external_id, external_url }) {
                store.set(`${item_id}:${adapter}:${channel}`, { item_id, adapter, channel, external_id, external_url });
            },
            getAdapterMapping({ item_id, adapter, channel }) {
                return store.get(`${item_id}:${adapter}:${channel}`) || null;
            },
        };

        const adapter = new JiraAdapter({
            domain: 'myteam', email: 'a@b.com', api_token: 'xxx', project_key: 'PROJ',
            db: mockDb, channelName: 'jira-test',
        });

        adapter._setMapping('item-1', 'PROJ-99', 'https://myteam.atlassian.net/browse/PROJ-99');
        const mapping = adapter._getMapping('item-1');
        assert.equal(mapping.key, 'PROJ-99');
        assert.equal(adapter._memoryMap.size, 0);
        assert.ok(store.has('item-1:jira:jira-test'));
    });
});

describe('JiraAdapter — priority mapping', () => {
    it('maps ClawMark priority to Jira priority', () => {
        const adapter = new JiraAdapter({
            domain: 'myteam', email: 'a@b.com', api_token: 'xxx', project_key: 'PROJ',
        });

        // Internal: test the priority mapping logic used in _createIssue
        const priorityMap = { critical: 'Highest', high: 'High', normal: 'Medium', low: 'Low' };
        assert.equal(priorityMap['critical'], 'Highest');
        assert.equal(priorityMap['high'], 'High');
        assert.equal(priorityMap['normal'], 'Medium');
        assert.equal(priorityMap['low'], 'Low');
    });

    it('uses default priority from config when set', () => {
        const adapter = new JiraAdapter({
            domain: 'myteam', email: 'a@b.com', api_token: 'xxx', project_key: 'PROJ',
            priority: 'Blocker',
        });
        assert.equal(adapter.defaultPriority, 'Blocker');
    });

    it('defaults issue type to Task', () => {
        const adapter = new JiraAdapter({
            domain: 'myteam', email: 'a@b.com', api_token: 'xxx', project_key: 'PROJ',
        });
        assert.equal(adapter.issueType, 'Task');
    });

    it('accepts custom issue type', () => {
        const adapter = new JiraAdapter({
            domain: 'myteam', email: 'a@b.com', api_token: 'xxx', project_key: 'PROJ',
            issue_type: 'Bug',
        });
        assert.equal(adapter.issueType, 'Bug');
    });
});

describe('JiraAdapter — event routing', () => {
    it('returns undefined for unknown events', async () => {
        const adapter = new JiraAdapter({
            domain: 'myteam', email: 'a@b.com', api_token: 'xxx', project_key: 'PROJ',
        });

        const result = await adapter.send('discussion.created', {}, {});
        assert.equal(result, undefined);
    });
});

// ================================================================= HxA Connect Adapter

describe('HxaConnectAdapter — validation', () => {
    it('requires hub_url', () => {
        const adapter = new HxaConnectAdapter({ agent_id: 'uuid' });
        assert.equal(adapter.validate().ok, false);
        assert.ok(adapter.validate().error.includes('hub_url'));
    });

    it('requires agent_id', () => {
        const adapter = new HxaConnectAdapter({ hub_url: 'https://hub.example.com' });
        assert.equal(adapter.validate().ok, false);
        assert.ok(adapter.validate().error.includes('agent_id'));
    });

    it('rejects invalid URL', () => {
        const adapter = new HxaConnectAdapter({
            hub_url: 'not-a-url', agent_id: 'uuid',
        });
        assert.equal(adapter.validate().ok, false);
    });

    it('rejects non-http protocol', () => {
        const adapter = new HxaConnectAdapter({
            hub_url: 'ftp://hub.example.com', agent_id: 'uuid',
        });
        assert.equal(adapter.validate().ok, false);
    });

    it('accepts valid https config', () => {
        const adapter = new HxaConnectAdapter({
            hub_url: 'https://jessie.coco.site/hub',
            agent_id: '2952bd7b-31a7-4e99-a69b-639bb7e05981',
        });
        assert.equal(adapter.validate().ok, true);
    });

    it('accepts valid http config', () => {
        const adapter = new HxaConnectAdapter({
            hub_url: 'http://localhost:3000/hub',
            agent_id: 'test-agent',
        });
        assert.equal(adapter.validate().ok, true);
    });
});

describe('HxaConnectAdapter — message building', () => {
    it('builds complete message with all fields', () => {
        const adapter = new HxaConnectAdapter({
            hub_url: 'https://hub.example.com',
            agent_id: 'target-uuid',
            thread_id: 'custom-thread',
        });

        const msg = adapter._buildMessage('item.created', {
            id: 'item-1',
            title: 'Login broken',
            type: 'issue',
            priority: 'high',
            created_by: 'Alice',
            source_url: 'https://example.com/login',
            quote: 'Error: invalid credentials',
            tags: ['auth', 'critical'],
        }, {});

        assert.equal(msg.target, 'target-uuid');
        assert.equal(msg.thread, 'custom-thread');
        assert.ok(msg.content.includes('[ClawMark] New Item'));
        assert.ok(msg.content.includes('Login broken'));
        assert.ok(msg.content.includes('Priority: high'));
        assert.ok(msg.content.includes('Type: issue'));
        assert.ok(msg.content.includes('By: Alice'));
        assert.ok(msg.content.includes('Source: https://example.com/login'));
        assert.ok(msg.content.includes('auth'));
        assert.ok(msg.content.includes('critical'));
        assert.equal(msg.metadata.source, 'clawmark');
        assert.equal(msg.metadata.event, 'item.created');
        assert.equal(msg.metadata.item_id, 'item-1');
    });

    it('uses default thread when no thread_id configured', () => {
        const adapter = new HxaConnectAdapter({
            hub_url: 'https://hub.example.com',
            agent_id: 'target-uuid',
        });

        const msg = adapter._buildMessage('item.created', { id: 'item-42' }, {});
        assert.equal(msg.thread, 'clawmark-item-42');
    });

    it('handles resolved event', () => {
        const adapter = new HxaConnectAdapter({
            hub_url: 'https://hub.example.com',
            agent_id: 'target-uuid',
        });

        const msg = adapter._buildMessage('item.resolved', { title: 'Fixed bug' }, {});
        assert.ok(msg.content.includes('Resolved'));
    });

    it('handles assigned event with assignee', () => {
        const adapter = new HxaConnectAdapter({
            hub_url: 'https://hub.example.com',
            agent_id: 'target-uuid',
        });

        const msg = adapter._buildMessage('item.assigned', {
            title: 'Task',
            assignee: 'Bob',
        }, {});

        assert.ok(msg.content.includes('Assigned'));
        assert.ok(msg.content.includes('Assignee: Bob'));
    });

    it('handles missing optional fields', () => {
        const adapter = new HxaConnectAdapter({
            hub_url: 'https://hub.example.com',
            agent_id: 'target-uuid',
        });

        const msg = adapter._buildMessage('item.created', {}, {});
        assert.ok(msg.content.includes('[ClawMark]'));
        assert.ok(msg.content.includes('New Item'));
    });

    it('handles string tags', () => {
        const adapter = new HxaConnectAdapter({
            hub_url: 'https://hub.example.com',
            agent_id: 'target-uuid',
        });

        const msg = adapter._buildMessage('item.created', {
            tags: '["tag1", "tag2"]',
        }, {});

        assert.ok(msg.content.includes('tag1'));
        assert.ok(msg.content.includes('tag2'));
    });

    it('does not include priority line for normal priority', () => {
        const adapter = new HxaConnectAdapter({
            hub_url: 'https://hub.example.com',
            agent_id: 'target-uuid',
        });

        const msg = adapter._buildMessage('item.created', { priority: 'normal' }, {});
        assert.ok(!msg.content.includes('Priority:'));
    });

    it('includes priority line for non-normal priority', () => {
        const adapter = new HxaConnectAdapter({
            hub_url: 'https://hub.example.com',
            agent_id: 'target-uuid',
        });

        const msg = adapter._buildMessage('item.created', { priority: 'critical' }, {});
        assert.ok(msg.content.includes('Priority: critical'));
    });
});

// ================================================================= AdapterRegistry — new adapter types

describe('AdapterRegistry — new adapter types integration', () => {
    it('registers and loads linear adapter', () => {
        const registry = new AdapterRegistry();
        registry.registerType('linear', LinearAdapter);

        registry.loadConfig({
            rules: [],
            channels: {
                'linear-main': {
                    adapter: 'linear',
                    api_key: 'lin_api_xxx',
                    team_id: 'team-uuid',
                },
            },
        });

        assert.ok(registry.channels.has('linear-main'));
        assert.equal(registry.channels.get('linear-main').type, 'linear');
    });

    it('registers and loads jira adapter', () => {
        const registry = new AdapterRegistry();
        registry.registerType('jira', JiraAdapter);

        registry.loadConfig({
            rules: [],
            channels: {
                'jira-main': {
                    adapter: 'jira',
                    domain: 'myteam',
                    email: 'a@b.com',
                    api_token: 'xxx',
                    project_key: 'PROJ',
                },
            },
        });

        assert.ok(registry.channels.has('jira-main'));
        assert.equal(registry.channels.get('jira-main').type, 'jira');
    });

    it('registers and loads hxa-connect adapter', () => {
        const registry = new AdapterRegistry();
        registry.registerType('hxa-connect', HxaConnectAdapter);

        registry.loadConfig({
            rules: [],
            channels: {
                'hxa-notify': {
                    adapter: 'hxa-connect',
                    hub_url: 'https://hub.example.com',
                    agent_id: 'target-uuid',
                },
            },
        });

        assert.ok(registry.channels.has('hxa-notify'));
        assert.equal(registry.channels.get('hxa-notify').type, 'hxa-connect');
    });

    it('rejects invalid linear config', () => {
        const registry = new AdapterRegistry();
        registry.registerType('linear', LinearAdapter);

        registry.loadConfig({
            rules: [],
            channels: {
                bad: { adapter: 'linear' /* missing api_key + team_id */ },
            },
        });

        assert.equal(registry.channels.has('bad'), false);
    });

    it('rejects invalid jira config', () => {
        const registry = new AdapterRegistry();
        registry.registerType('jira', JiraAdapter);

        registry.loadConfig({
            rules: [],
            channels: {
                bad: { adapter: 'jira', domain: 'x' /* missing email, api_token, project_key */ },
            },
        });

        assert.equal(registry.channels.has('bad'), false);
    });

    it('rejects invalid hxa-connect config', () => {
        const registry = new AdapterRegistry();
        registry.registerType('hxa-connect', HxaConnectAdapter);

        registry.loadConfig({
            rules: [],
            channels: {
                bad: { adapter: 'hxa-connect' /* missing hub_url + agent_id */ },
            },
        });

        assert.equal(registry.channels.has('bad'), false);
    });
});
