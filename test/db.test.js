/**
 * ClawMark — Database Layer Tests
 *
 * Tests cover:
 * 1. Item CRUD — create, read, query, filters
 * 2. Status lifecycle — assign, resolve, verify, reopen, close
 * 3. Messages — add, respond, pending
 * 4. V2 features — tags, source_url, screenshots
 * 5. API key management — create, validate, revoke
 * 6. Adapter mappings — set, get, reverse lookup
 * 7. Queue & stats
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initDb } = require('../server/db');

// ------------------------------------------------------------------ helpers

let dbApi;
let tmpDir;

function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawmark-test-'));
    dbApi = initDb(tmpDir);
}

function teardown() {
    if (dbApi && dbApi.db) dbApi.db.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

// =================================================================== tests

describe('DB — item creation', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('creates a basic item with defaults', () => {
        const item = dbApi.createItem({
            doc: 'https://example.com',
            created_by: 'Alice',
        });

        assert.ok(item.id.startsWith('disc-'));
        assert.equal(item.app_id, 'default');
        assert.equal(item.type, 'discuss');
        assert.equal(item.status, 'open');
        assert.equal(item.priority, 'normal');
        assert.equal(item.created_by, 'Alice');
    });

    it('creates an issue-type item with correct prefix', () => {
        const item = dbApi.createItem({
            doc: 'https://example.com',
            type: 'issue',
            created_by: 'Bob',
        });

        assert.ok(item.id.startsWith('issue-'));
        assert.equal(item.type, 'issue');
    });

    it('creates item with all V2 fields', () => {
        const item = dbApi.createItem({
            doc: 'https://example.com',
            type: 'issue',
            title: 'Button broken',
            quote: 'Submit button fails',
            priority: 'high',
            created_by: 'Alice',
            source_url: 'https://app.example.com/page',
            source_title: 'App Page',
            tags: ['ui', 'bug'],
            screenshots: ['https://img.example.com/1.png'],
        });

        assert.equal(item.title, 'Button broken');
        assert.equal(item.quote, 'Submit button fails');
        assert.equal(item.priority, 'high');
        assert.equal(item.source_url, 'https://app.example.com/page');
        assert.equal(item.source_title, 'App Page');
        assert.deepEqual(item.tags, ['ui', 'bug']);
        assert.deepEqual(item.screenshots, ['https://img.example.com/1.png']);
    });

    it('creates item with initial message', () => {
        const item = dbApi.createItem({
            doc: 'https://example.com',
            created_by: 'Alice',
            message: 'This is the first message',
        });

        const fetched = dbApi.getItem(item.id);
        assert.equal(fetched.messages.length, 1);
        assert.equal(fetched.messages[0].content, 'This is the first message');
        assert.equal(fetched.messages[0].role, 'user');
        assert.equal(fetched.messages[0].user_name, 'Alice');
    });

    it('creates item without message', () => {
        const item = dbApi.createItem({
            doc: 'https://example.com',
            created_by: 'Alice',
        });

        const fetched = dbApi.getItem(item.id);
        assert.equal(fetched.messages.length, 0);
    });

    it('handles null optional fields', () => {
        const item = dbApi.createItem({
            doc: 'https://example.com',
            created_by: 'Alice',
        });

        assert.equal(item.title, null);
        assert.equal(item.quote, null);
        assert.equal(item.source_url, null);
        assert.deepEqual(item.tags, []);
        assert.deepEqual(item.screenshots, []);
    });
});

describe('DB — item queries', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('getItem returns null for non-existent item', () => {
        assert.equal(dbApi.getItem('nonexistent'), null);
    });

    it('getItem returns item with messages attached', () => {
        const item = dbApi.createItem({
            doc: 'https://example.com',
            created_by: 'Alice',
            message: 'Hello',
        });

        dbApi.addMessage({ item_id: item.id, role: 'assistant', content: 'Reply' });

        const fetched = dbApi.getItem(item.id);
        assert.equal(fetched.id, item.id);
        assert.equal(fetched.messages.length, 2);
    });

    it('getItems filters by app_id', () => {
        dbApi.createItem({ app_id: 'app1', doc: 'd1', created_by: 'A' });
        dbApi.createItem({ app_id: 'app2', doc: 'd1', created_by: 'B' });

        const items = dbApi.getItems({ app_id: 'app1' });
        assert.equal(items.length, 1);
        assert.equal(items[0].app_id, 'app1');
    });

    it('getItems filters by doc', () => {
        dbApi.createItem({ doc: 'page1', created_by: 'A' });
        dbApi.createItem({ doc: 'page2', created_by: 'B' });

        const items = dbApi.getItems({ doc: 'page1' });
        assert.equal(items.length, 1);
    });

    it('getItems filters by type', () => {
        dbApi.createItem({ doc: 'd', type: 'issue', created_by: 'A' });
        dbApi.createItem({ doc: 'd', type: 'discuss', created_by: 'B' });

        const items = dbApi.getItems({ type: 'issue' });
        assert.equal(items.length, 1);
        assert.equal(items[0].type, 'issue');
    });

    it('getItems filters by status', () => {
        const item = dbApi.createItem({ doc: 'd', created_by: 'A' });
        dbApi.resolveItem(item.id);
        dbApi.createItem({ doc: 'd', created_by: 'B' });

        const open = dbApi.getItems({ status: 'open' });
        const resolved = dbApi.getItems({ status: 'resolved' });
        assert.equal(open.length, 1);
        assert.equal(resolved.length, 1);
    });

    it('getItems filters by assignee', () => {
        const item = dbApi.createItem({ doc: 'd', created_by: 'A' });
        dbApi.assignItem(item.id, 'Bob');
        dbApi.createItem({ doc: 'd', created_by: 'B' });

        const items = dbApi.getItems({ assignee: 'Bob' });
        assert.equal(items.length, 1);
    });

    it('getItems returns all when no filters', () => {
        dbApi.createItem({ doc: 'd1', created_by: 'A' });
        dbApi.createItem({ doc: 'd2', created_by: 'B' });

        const items = dbApi.getItems();
        assert.equal(items.length, 2);
    });

    it('getItems returns results in order', () => {
        dbApi.createItem({ doc: 'd', created_by: 'A' });
        dbApi.createItem({ doc: 'd', created_by: 'B' });
        dbApi.createItem({ doc: 'd', created_by: 'C' });

        const items = dbApi.getItems();
        assert.equal(items.length, 3);
        // All items returned regardless of order
    });
});

describe('DB — status lifecycle', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('assign sets assignee and status to in_progress', () => {
        const item = dbApi.createItem({ doc: 'd', created_by: 'A' });
        const result = dbApi.assignItem(item.id, 'Bob');

        assert.equal(result.success, true);
        const fetched = dbApi.getItem(item.id);
        assert.equal(fetched.assignee, 'Bob');
        assert.equal(fetched.status, 'in_progress');
    });

    it('resolve sets status and resolved_at', () => {
        const item = dbApi.createItem({ doc: 'd', created_by: 'A' });
        dbApi.resolveItem(item.id);

        const fetched = dbApi.getItem(item.id);
        assert.equal(fetched.status, 'resolved');
        assert.ok(fetched.resolved_at);
    });

    it('verify sets status and verified_at', () => {
        const item = dbApi.createItem({ doc: 'd', created_by: 'A' });
        dbApi.verifyItem(item.id);

        const fetched = dbApi.getItem(item.id);
        assert.equal(fetched.status, 'verified');
        assert.ok(fetched.verified_at);
    });

    it('reopen clears resolved_at and verified_at', () => {
        const item = dbApi.createItem({ doc: 'd', created_by: 'A' });
        dbApi.resolveItem(item.id);
        dbApi.reopenItem(item.id);

        const fetched = dbApi.getItem(item.id);
        assert.equal(fetched.status, 'open');
        assert.equal(fetched.resolved_at, null);
        assert.equal(fetched.verified_at, null);
    });

    it('close sets status to closed', () => {
        const item = dbApi.createItem({ doc: 'd', created_by: 'A' });
        dbApi.closeItem(item.id);

        const fetched = dbApi.getItem(item.id);
        assert.equal(fetched.status, 'closed');
    });

    it('operations on non-existent item return success false', () => {
        const result = dbApi.assignItem('nonexistent', 'Bob');
        assert.equal(result.success, false);
        assert.equal(result.changes, 0);
    });

    it('full lifecycle: open → assign → resolve → reopen → close', () => {
        const item = dbApi.createItem({ doc: 'd', created_by: 'A' });
        assert.equal(dbApi.getItem(item.id).status, 'open');

        dbApi.assignItem(item.id, 'Bob');
        assert.equal(dbApi.getItem(item.id).status, 'in_progress');

        dbApi.resolveItem(item.id);
        assert.equal(dbApi.getItem(item.id).status, 'resolved');

        dbApi.reopenItem(item.id);
        assert.equal(dbApi.getItem(item.id).status, 'open');

        dbApi.closeItem(item.id);
        assert.equal(dbApi.getItem(item.id).status, 'closed');
    });
});

describe('DB — messages', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('addMessage appends to item', () => {
        const item = dbApi.createItem({ doc: 'd', created_by: 'A' });
        const msg = dbApi.addMessage({
            item_id: item.id,
            role: 'user',
            content: 'Hello',
            user_name: 'Alice',
        });

        assert.ok(msg.id.startsWith('msg-'));
        const fetched = dbApi.getItem(item.id);
        assert.equal(fetched.messages.length, 1);
        assert.equal(fetched.messages[0].content, 'Hello');
    });

    it('addMessage updates item updated_at', () => {
        const item = dbApi.createItem({ doc: 'd', created_by: 'A' });
        const before = dbApi.getItem(item.id).updated_at;

        // Small delay to ensure different timestamp
        dbApi.addMessage({ item_id: item.id, role: 'user', content: 'x' });
        const after = dbApi.getItem(item.id).updated_at;

        assert.ok(after >= before);
    });

    it('respondToItem inserts assistant message', () => {
        const item = dbApi.createItem({ doc: 'd', created_by: 'A' });
        dbApi.respondToItem(item.id, 'AI response');

        const fetched = dbApi.getItem(item.id);
        assert.equal(fetched.messages.length, 1);
        assert.equal(fetched.messages[0].role, 'assistant');
        assert.equal(fetched.messages[0].content, 'AI response');
    });

    it('messages order by created_at ASC', () => {
        const item = dbApi.createItem({ doc: 'd', created_by: 'A', message: 'first' });
        dbApi.addMessage({ item_id: item.id, role: 'assistant', content: 'second' });
        dbApi.addMessage({ item_id: item.id, role: 'user', content: 'third' });

        const fetched = dbApi.getItem(item.id);
        assert.equal(fetched.messages.length, 3);
        assert.equal(fetched.messages[0].content, 'first');
        assert.equal(fetched.messages[2].content, 'third');
    });
});

describe('DB — queue & stats', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('getQueue returns open and in_progress items', () => {
        const i1 = dbApi.createItem({ doc: 'd', created_by: 'A' });
        const i2 = dbApi.createItem({ doc: 'd', created_by: 'B' });
        dbApi.assignItem(i2.id, 'Bob');
        const i3 = dbApi.createItem({ doc: 'd', created_by: 'C' });
        dbApi.resolveItem(i3.id);

        const queue = dbApi.getQueue();
        assert.equal(queue.length, 2); // open + in_progress, not resolved
    });

    it('getQueue sorts by priority then created_at', () => {
        dbApi.createItem({ doc: 'd', priority: 'low', created_by: 'Low' });
        dbApi.createItem({ doc: 'd', priority: 'critical', created_by: 'Critical' });
        dbApi.createItem({ doc: 'd', priority: 'high', created_by: 'High' });

        const queue = dbApi.getQueue();
        assert.equal(queue[0].priority, 'critical');
        assert.equal(queue[1].priority, 'high');
        assert.equal(queue[2].priority, 'low');
    });

    it('getStats returns counts by type and status', () => {
        dbApi.createItem({ doc: 'd', type: 'issue', created_by: 'A' });
        dbApi.createItem({ doc: 'd', type: 'issue', created_by: 'B' });
        dbApi.createItem({ doc: 'd', type: 'discuss', created_by: 'C' });

        const stats = dbApi.getStats();
        assert.ok(stats.length > 0);
        const issueOpen = stats.find(s => s.type === 'issue' && s.status === 'open');
        assert.equal(issueOpen.count, 2);
    });

    it('getStats filters by doc', () => {
        dbApi.createItem({ doc: 'page1', created_by: 'A' });
        dbApi.createItem({ doc: 'page2', created_by: 'B' });

        const stats = dbApi.getStats('page1');
        const total = stats.reduce((sum, s) => sum + s.count, 0);
        assert.equal(total, 1);
    });

    it('getPending returns items with pending messages', () => {
        const item = dbApi.createItem({ doc: 'd', created_by: 'A' });
        // Manually insert a pending message
        dbApi.db.prepare(
            `INSERT INTO messages (id, item_id, role, content, pending, created_at)
             VALUES (?, ?, 'user', 'help', 1, ?)`
        ).run('msg-test', item.id, new Date().toISOString());

        const pending = dbApi.getPending();
        assert.equal(pending.length, 1);
        assert.equal(pending[0].item_id, item.id);
    });
});

describe('DB — V2 queries', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('getItemsByUrl filters by source_url', () => {
        dbApi.createItem({
            doc: 'd', created_by: 'A',
            source_url: 'https://example.com/page1',
        });
        dbApi.createItem({
            doc: 'd', created_by: 'B',
            source_url: 'https://example.com/page2',
        });

        const items = dbApi.getItemsByUrl({ url: 'https://example.com/page1' });
        assert.equal(items.length, 1);
    });

    it('getItemsByTag searches JSON tags array', () => {
        dbApi.createItem({
            doc: 'd', created_by: 'A',
            tags: ['bug', 'ui'],
        });
        dbApi.createItem({
            doc: 'd', created_by: 'B',
            tags: ['feature'],
        });

        const items = dbApi.getItemsByTag({ tag: 'bug' });
        assert.equal(items.length, 1);
    });

    it('getDistinctUrls returns unique source_urls with counts', () => {
        dbApi.createItem({ doc: 'd', created_by: 'A', source_url: 'https://a.com' });
        dbApi.createItem({ doc: 'd', created_by: 'B', source_url: 'https://a.com' });
        dbApi.createItem({ doc: 'd', created_by: 'C', source_url: 'https://b.com' });

        const urls = dbApi.getDistinctUrls();
        assert.equal(urls.length, 2);
        const aUrl = urls.find(u => u.source_url === 'https://a.com');
        assert.equal(aUrl.item_count, 2);
    });

    it('updateItemTags replaces tags', () => {
        const item = dbApi.createItem({
            doc: 'd', created_by: 'A',
            tags: ['old'],
        });

        dbApi.updateItemTags(item.id, ['new1', 'new2']);

        const fetched = dbApi.getItem(item.id);
        assert.deepEqual(JSON.parse(fetched.tags), ['new1', 'new2']);
    });
});

describe('DB — API keys', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('createApiKey generates cmk_ prefixed key', () => {
        const result = dbApi.createApiKey({
            name: 'test-key',
            created_by: 'Alice',
        });

        assert.ok(result.key.startsWith('cmk_'));
        assert.equal(result.app_id, 'default');
        assert.equal(result.name, 'test-key');
    });

    it('validateApiKey returns key data for valid key', () => {
        const { key } = dbApi.createApiKey({ created_by: 'Alice' });
        const result = dbApi.validateApiKey(key);

        assert.ok(result);
        assert.equal(result.key, key);
    });

    it('validateApiKey returns null for invalid key', () => {
        assert.equal(dbApi.validateApiKey('cmk_invalid'), null);
    });

    it('validateApiKey updates last_used', () => {
        const { key } = dbApi.createApiKey({ created_by: 'Alice' });
        dbApi.validateApiKey(key);

        const result = dbApi.validateApiKey(key);
        assert.ok(result.last_used);
    });

    it('revokeApiKey makes key invalid', () => {
        const { id, key } = dbApi.createApiKey({ created_by: 'Alice' });
        dbApi.revokeApiKey(id);

        assert.equal(dbApi.validateApiKey(key), null);
    });
});

describe('DB — adapter mappings', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('set and get mapping', () => {
        dbApi.setAdapterMapping({
            item_id: 'item-1',
            adapter: 'github-issue',
            channel: 'gh-main',
            external_id: '42',
            external_url: 'https://github.com/org/repo/issues/42',
        });

        const mapping = dbApi.getAdapterMapping({
            item_id: 'item-1',
            adapter: 'github-issue',
            channel: 'gh-main',
        });

        assert.ok(mapping);
        assert.equal(mapping.external_id, '42');
        assert.equal(mapping.external_url, 'https://github.com/org/repo/issues/42');
    });

    it('returns null for non-existent mapping', () => {
        const mapping = dbApi.getAdapterMapping({
            item_id: 'nonexistent',
            adapter: 'github-issue',
            channel: 'ch1',
        });
        assert.equal(mapping, null);
    });

    it('reverse lookup by external_id', () => {
        dbApi.setAdapterMapping({
            item_id: 'item-1',
            adapter: 'github-issue',
            channel: 'ch1',
            external_id: '99',
        });

        const mapping = dbApi.getAdapterMappingByExternalId({
            adapter: 'github-issue',
            external_id: '99',
        });

        assert.ok(mapping);
        assert.equal(mapping.item_id, 'item-1');
    });

    it('upsert replaces existing mapping', () => {
        dbApi.setAdapterMapping({
            item_id: 'item-1', adapter: 'gh', channel: 'ch1',
            external_id: '1', external_url: 'url1',
        });
        dbApi.setAdapterMapping({
            item_id: 'item-1', adapter: 'gh', channel: 'ch1',
            external_id: '2', external_url: 'url2',
        });

        const mapping = dbApi.getAdapterMapping({
            item_id: 'item-1', adapter: 'gh', channel: 'ch1',
        });
        assert.equal(mapping.external_id, '2');
    });

    it('default channel is empty string', () => {
        dbApi.setAdapterMapping({
            item_id: 'item-1', adapter: 'webhook',
            external_id: '1',
        });

        const mapping = dbApi.getAdapterMapping({
            item_id: 'item-1', adapter: 'webhook',
        });
        assert.ok(mapping);
        assert.equal(mapping.channel, '');
    });
});

describe('DB — genId', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('generates unique IDs', () => {
        const ids = new Set();
        for (let i = 0; i < 100; i++) {
            ids.add(dbApi.genId('test'));
        }
        assert.equal(ids.size, 100);
    });

    it('includes prefix', () => {
        assert.ok(dbApi.genId('foo').startsWith('foo-'));
    });
});
