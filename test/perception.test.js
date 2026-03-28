/**
 * ClawMark — Perception Consumer Tests (#69)
 *
 * Tests cover:
 * 1. Error deduplicator — fingerprint generation, normalization, dedup grouping
 * 2. Perception DB — event storage, cursor-based retrieval, issue tracking
 * 3. Issue formatting — title and description generation
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initDb } = require('../server/db');
const {
    generateFingerprint,
    normalizeMessage,
    normalizeStack,
    deduplicateEvents,
    filterBySeverity,
} = require('../server/agent/error-deduplicator');

// ------------------------------------------------------------------ helpers

let dbApi;
let tmpDir;

function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawmark-perception-test-'));
    dbApi = initDb(tmpDir);
}

function teardown() {
    if (dbApi && dbApi.db) dbApi.db.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

function makeEvent(overrides = {}) {
    return {
        type: 'js-error',
        message: 'TypeError: Cannot read property "foo" of undefined',
        stack: 'at Object.handler (app.js:42:10)\nat dispatch (router.js:100:5)',
        source: 'app.js',
        line: 42,
        severity: 'error',
        url: 'https://example.com/page',
        fingerprint: 'abc123',
        context: {},
        created_at: new Date().toISOString(),
        ...overrides,
    };
}

// ================================================================= deduplicator

describe('Error Deduplicator — normalizeMessage', () => {
    it('should replace URLs', () => {
        const result = normalizeMessage('Failed to load https://api.example.com/users/123');
        assert.ok(result.includes('<URL>'));
        assert.ok(!result.includes('https://'));
    });

    it('should replace hex IDs', () => {
        const result = normalizeMessage('Item abc123def456 not found');
        assert.ok(result.includes('<HEX>'));
    });

    it('should replace numbers', () => {
        const result = normalizeMessage('Error at line 42 col 10');
        assert.ok(!result.includes('42'));
        assert.ok(result.includes('N'));
    });
});

describe('Error Deduplicator — normalizeStack', () => {
    it('should extract first 3 frames', () => {
        const stack = `Error: fail
    at foo (app.js:1:1)
    at bar (app.js:2:2)
    at baz (app.js:3:3)
    at qux (app.js:4:4)`;
        const result = normalizeStack(stack);
        const lines = result.split('\n');
        assert.equal(lines.length, 3);
    });

    it('should strip line/col numbers', () => {
        const stack = `Error: fail
    at foo (app.js:42:10)`;
        const result = normalizeStack(stack);
        assert.ok(!result.includes(':42:10'));
    });

    it('should handle empty stack', () => {
        assert.equal(normalizeStack(''), '');
        assert.equal(normalizeStack(null), '');
    });
});

describe('Error Deduplicator — generateFingerprint', () => {
    it('should produce consistent fingerprints', () => {
        const event = makeEvent();
        const fp1 = generateFingerprint(event);
        const fp2 = generateFingerprint(event);
        assert.equal(fp1, fp2);
    });

    it('should produce different fingerprints for different errors', () => {
        const fp1 = generateFingerprint(makeEvent({ message: 'Error A' }));
        const fp2 = generateFingerprint(makeEvent({ message: 'Error B' }));
        assert.notEqual(fp1, fp2);
    });

    it('should produce same fingerprint when only numbers differ', () => {
        const fp1 = generateFingerprint(makeEvent({ message: 'Error at line 42' }));
        const fp2 = generateFingerprint(makeEvent({ message: 'Error at line 99' }));
        assert.equal(fp1, fp2);
    });
});

describe('Error Deduplicator — deduplicateEvents', () => {
    it('should group events by fingerprint', () => {
        const events = [
            makeEvent({ fingerprint: 'aaa', created_at: '2026-01-01T00:00:00Z' }),
            makeEvent({ fingerprint: 'bbb', created_at: '2026-01-01T00:00:01Z' }),
            makeEvent({ fingerprint: 'aaa', created_at: '2026-01-01T00:00:02Z' }),
        ];
        const groups = deduplicateEvents(events);
        assert.equal(groups.size, 2);
        assert.equal(groups.get('aaa').count, 2);
        assert.equal(groups.get('bbb').count, 1);
    });

    it('should keep most recent event as representative', () => {
        const events = [
            makeEvent({ fingerprint: 'aaa', created_at: '2026-01-01T00:00:00Z', message: 'old' }),
            makeEvent({ fingerprint: 'aaa', created_at: '2026-01-01T00:00:05Z', message: 'new' }),
        ];
        const groups = deduplicateEvents(events);
        assert.equal(groups.get('aaa').representative.message, 'new');
    });
});

describe('Error Deduplicator — filterBySeverity', () => {
    it('should filter by error threshold', () => {
        const events = [
            makeEvent({ severity: 'error' }),
            makeEvent({ severity: 'warning' }),
            makeEvent({ severity: 'info' }),
            makeEvent({ severity: 'critical' }),
        ];
        const result = filterBySeverity(events, 'error');
        assert.equal(result.length, 2); // error + critical
    });

    it('should include warnings when threshold is warning', () => {
        const events = [
            makeEvent({ severity: 'error' }),
            makeEvent({ severity: 'warning' }),
            makeEvent({ severity: 'info' }),
        ];
        const result = filterBySeverity(events, 'warning');
        assert.equal(result.length, 2); // error + warning
    });
});

// ================================================================= DB layer

describe('DB — perception events', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('should create and retrieve perception events', () => {
        const result = dbApi.createPerceptionEvent({
            app_id: 'test-app',
            type: 'js-error',
            message: 'Test error',
            stack: 'at foo:1:1',
            source: 'test.js',
            line: 1,
            severity: 'error',
            url: 'https://example.com',
            fingerprint: 'fp001',
            context: { userAction: 'click' },
        });
        assert.ok(result.id);
        assert.ok(result.created_at);

        const events = dbApi.getPerceptionEvents({ app_id: 'test-app' });
        assert.equal(events.length, 1);
        assert.equal(events[0].fingerprint, 'fp001');
        assert.equal(events[0].message, 'Test error');
    });

    it('should batch create events', () => {
        const events = [
            { app_id: 'test-app', type: 'js-error', message: 'Error 1', fingerprint: 'fp001', severity: 'error' },
            { app_id: 'test-app', type: 'js-error', message: 'Error 2', fingerprint: 'fp002', severity: 'error' },
            { app_id: 'test-app', type: 'js-error', message: 'Error 3', fingerprint: 'fp001', severity: 'error' },
        ];
        const results = dbApi.createPerceptionEvents(events);
        assert.equal(results.length, 3);

        const all = dbApi.getPerceptionEvents({ app_id: 'test-app' });
        assert.equal(all.length, 3);
    });

    it('should respect cursor-based pagination', () => {
        // Use explicit timestamps to avoid same-millisecond collision
        const now = Date.now();
        const cursor = new Date(now - 2000).toISOString();

        // Insert event with timestamp before cursor
        dbApi.db.prepare(`
            INSERT INTO perception_events (id, app_id, type, message, severity, fingerprint, context, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run('pe-old', 'test-app', 'js-error', 'Old', 'error', 'fp001', '{}', new Date(now - 3000).toISOString());

        // Insert event with timestamp after cursor
        dbApi.db.prepare(`
            INSERT INTO perception_events (id, app_id, type, message, severity, fingerprint, context, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run('pe-new', 'test-app', 'js-error', 'New', 'error', 'fp002', '{}', new Date(now - 1000).toISOString());

        const events = dbApi.getPerceptionEvents({
            app_id: 'test-app',
            cursor,
        });
        assert.equal(events.length, 1);
        assert.equal(events[0].message, 'New');
    });

    it('should return stats by fingerprint', () => {
        dbApi.createPerceptionEvents([
            { app_id: 'test-app', type: 'js-error', message: 'A', fingerprint: 'fp001', severity: 'error' },
            { app_id: 'test-app', type: 'js-error', message: 'A', fingerprint: 'fp001', severity: 'error' },
            { app_id: 'test-app', type: 'js-error', message: 'B', fingerprint: 'fp002', severity: 'error' },
        ]);

        const stats = dbApi.getPerceptionStats({ app_id: 'test-app' });
        assert.equal(stats.length, 2);
        // fp001 should have count 2 (sorted by count DESC)
        assert.equal(stats[0].fingerprint, 'fp001');
        assert.equal(stats[0].count, 2);
    });

    it('should isolate events by app_id', () => {
        dbApi.createPerceptionEvent({
            app_id: 'app-a', type: 'js-error', message: 'A', fingerprint: 'fp001', severity: 'error',
        });
        dbApi.createPerceptionEvent({
            app_id: 'app-b', type: 'js-error', message: 'B', fingerprint: 'fp002', severity: 'error',
        });

        const eventsA = dbApi.getPerceptionEvents({ app_id: 'app-a' });
        assert.equal(eventsA.length, 1);
        assert.equal(eventsA[0].message, 'A');
    });

    // #118: instance_id support
    it('should store and return instance_id on perception events', () => {
        const result = dbApi.createPerceptionEvent({
            app_id: 'test-app',
            instance_id: 'inst-aaaa-bbbb',
            type: 'js-error',
            message: 'Instance error',
            fingerprint: 'fp-inst',
            severity: 'error',
        });
        assert.ok(result.id);
        assert.equal(result.instance_id, 'inst-aaaa-bbbb');

        const events = dbApi.getPerceptionEvents({ app_id: 'test-app' });
        assert.equal(events.length, 1);
        assert.equal(events[0].instance_id, 'inst-aaaa-bbbb');
    });

    it('should default instance_id to null when not provided', () => {
        dbApi.createPerceptionEvent({
            app_id: 'test-app',
            type: 'js-error',
            message: 'No instance',
            fingerprint: 'fp-noinst',
            severity: 'error',
        });

        const events = dbApi.getPerceptionEvents({ app_id: 'test-app' });
        assert.equal(events.length, 1);
        assert.equal(events[0].instance_id, null);
    });

    it('should batch create events with instance_id', () => {
        const events = [
            { app_id: 'test-app', instance_id: 'inst-1', type: 'js-error', message: 'E1', fingerprint: 'fp1', severity: 'error' },
            { app_id: 'test-app', instance_id: 'inst-2', type: 'js-error', message: 'E2', fingerprint: 'fp2', severity: 'error' },
        ];
        const results = dbApi.createPerceptionEvents(events);
        assert.equal(results.length, 2);
        assert.equal(results[0].instance_id, 'inst-1');
        assert.equal(results[1].instance_id, 'inst-2');

        const all = dbApi.getPerceptionEvents({ app_id: 'test-app' });
        assert.equal(all.length, 2);
        const instances = new Set(all.map(e => e.instance_id));
        assert.ok(instances.has('inst-1'));
        assert.ok(instances.has('inst-2'));
    });
});

describe('DB — perception issues', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('should create and retrieve perception issue', () => {
        const result = dbApi.upsertPerceptionIssue({
            app_id: 'test-app',
            fingerprint: 'fp001',
            count: 5,
            first_seen: '2026-01-01T00:00:00Z',
            last_seen: '2026-01-01T01:00:00Z',
        });
        assert.ok(result.id || result.created);

        const issue = dbApi.getPerceptionIssue({ app_id: 'test-app', fingerprint: 'fp001' });
        assert.ok(issue);
        assert.equal(issue.fingerprint, 'fp001');
        assert.equal(issue.count, 5);
    });

    it('should update existing issue count', () => {
        dbApi.upsertPerceptionIssue({
            app_id: 'test-app', fingerprint: 'fp001', count: 3,
            first_seen: '2026-01-01T00:00:00Z', last_seen: '2026-01-01T01:00:00Z',
        });
        dbApi.upsertPerceptionIssue({
            app_id: 'test-app', fingerprint: 'fp001', count: 2,
            last_seen: '2026-01-01T02:00:00Z',
        });

        const issue = dbApi.getPerceptionIssue({ app_id: 'test-app', fingerprint: 'fp001' });
        assert.equal(issue.count, 5); // 3 + 2
    });

    it('should track GitLab issue link', () => {
        dbApi.upsertPerceptionIssue({
            app_id: 'test-app', fingerprint: 'fp001', count: 1,
            first_seen: '2026-01-01T00:00:00Z', last_seen: '2026-01-01T00:00:00Z',
        });
        dbApi.upsertPerceptionIssue({
            app_id: 'test-app', fingerprint: 'fp001', count: 0,
            last_seen: '2026-01-01T00:00:00Z',
            gitlab_issue_id: '42',
            gitlab_issue_url: 'https://git.example.com/issues/42',
        });

        const issue = dbApi.getPerceptionIssue({ app_id: 'test-app', fingerprint: 'fp001' });
        assert.equal(issue.gitlab_issue_id, '42');
        assert.equal(issue.gitlab_issue_url, 'https://git.example.com/issues/42');
    });

    it('should list open issues', () => {
        dbApi.upsertPerceptionIssue({
            app_id: 'test-app', fingerprint: 'fp001', count: 10,
            first_seen: '2026-01-01T00:00:00Z', last_seen: '2026-01-01T01:00:00Z',
        });
        dbApi.upsertPerceptionIssue({
            app_id: 'test-app', fingerprint: 'fp002', count: 3,
            first_seen: '2026-01-01T00:00:00Z', last_seen: '2026-01-01T01:00:00Z',
        });

        const issues = dbApi.getOpenPerceptionIssues({ app_id: 'test-app' });
        assert.equal(issues.length, 2);
        // Sorted by count DESC
        assert.equal(issues[0].fingerprint, 'fp001');
    });
});
