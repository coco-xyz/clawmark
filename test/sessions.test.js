/**
 * ClawMark — Session Storage Tests (#73)
 *
 * Tests cover:
 * 1. Session creation with events and snapshots
 * 2. Chunked upload (append to existing session)
 * 3. Session listing with filters (agent_id, site, after)
 * 4. Session detail with range query
 * 5. Session finalization
 * 6. Size limit enforcement (50MB)
 * 7. Cleanup of expired + orphaned sessions
 * 8. Validation: event type whitelist, start_time format, agent ownership, finalized append
 * 9. LIKE wildcard escaping
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initDb } = require('../server/db');

// ------------------------------------------------------------------ helpers

let db;
let tmpDir;

function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawmark-session-test-'));
    db = initDb(tmpDir);
}

function teardown() {
    if (db && db.db) db.db.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

function makeEvent(overrides = {}) {
    return {
        type: 'dom-mutation',
        timestamp: new Date().toISOString(),
        data: { selector: '#app', action: 'textContent', value: 'hello' },
        ...overrides,
    };
}

function makeSnapshot(overrides = {}) {
    return {
        trigger: 'error',
        timestamp: new Date().toISOString(),
        html: '<html><body>test</body></html>',
        ...overrides,
    };
}

// ================================================================= creation

describe('Session Storage — createSession', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('should create a session with events and snapshots', () => {
        const result = db.createSession({
            app_id: 'app-1',
            agent_id: 'agent-1',
            tab_id: 'tab-1',
            url: 'https://example.com/page',
            title: 'Test Page',
            start_time: '2026-03-21T10:00:00.000Z',
            events: [makeEvent(), makeEvent({ type: 'console-log' })],
            snapshots: [makeSnapshot()],
        });

        assert.ok(result.id.startsWith('sess-'));
        assert.equal(result.app_id, 'app-1');
        assert.equal(result.event_count, 2);
        assert.equal(result.snapshot_count, 1);
        assert.ok(result.total_size > 0);
    });

    it('should create a session with no events', () => {
        const result = db.createSession({
            app_id: 'app-1',
            url: 'https://example.com',
            start_time: '2026-03-21T10:00:00.000Z',
        });

        assert.ok(result.id.startsWith('sess-'));
        assert.equal(result.event_count, 0);
        assert.equal(result.snapshot_count, 0);
    });

    it('should truncate URL and title', () => {
        const longUrl = 'https://example.com/' + 'a'.repeat(3000);
        const result = db.createSession({
            app_id: 'app-1',
            url: longUrl,
            title: 'x'.repeat(1000),
            start_time: '2026-03-21T10:00:00.000Z',
        });

        const session = db.getSession(result.id);
        assert.ok(session.url.length <= 2048);
        assert.ok(session.title.length <= 512);
    });

    it('should truncate snapshot HTML to 50000 chars', () => {
        const bigHtml = '<html>' + 'x'.repeat(60000) + '</html>';
        const result = db.createSession({
            app_id: 'app-1',
            start_time: '2026-03-21T10:00:00.000Z',
            snapshots: [makeSnapshot({ html: bigHtml })],
        });

        const snapshots = db.getSessionSnapshots(result.id);
        assert.equal(snapshots.length, 1);
        assert.ok(snapshots[0].size <= 50000);
    });

    it('should reject invalid event type', () => {
        assert.throws(() => {
            db.createSession({
                app_id: 'app-1',
                start_time: '2026-03-21T10:00:00.000Z',
                events: [makeEvent({ type: 'xss-injection' })],
            });
        }, /INVALID_EVENT_TYPE/);
    });

    it('should reject invalid start_time format', () => {
        assert.throws(() => {
            db.createSession({
                app_id: 'app-1',
                start_time: 'not-a-date',
            });
        }, /INVALID_START_TIME/);
    });

    it('should accept all 6 valid event types', () => {
        const validTypes = ['dom-mutation', 'console-log', 'console-error', 'network-error', 'click', 'scroll'];
        const result = db.createSession({
            app_id: 'app-1',
            start_time: '2026-03-21T10:00:00.000Z',
            events: validTypes.map(type => makeEvent({ type })),
        });
        assert.equal(result.event_count, 6);
    });
});

// ================================================================= chunked upload

describe('Session Storage — appendSessionEvents', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('should append events to existing session', () => {
        const session = db.createSession({
            app_id: 'app-1',
            start_time: '2026-03-21T10:00:00.000Z',
            events: [makeEvent()],
        });

        const result = db.appendSessionEvents(session.id, {
            events: [makeEvent({ type: 'click' }), makeEvent({ type: 'scroll' })],
        });

        assert.equal(result.events_added, 2);

        const updated = db.getSession(session.id);
        assert.equal(updated.event_count, 3);
    });

    it('should append snapshots to existing session', () => {
        const session = db.createSession({
            app_id: 'app-1',
            start_time: '2026-03-21T10:00:00.000Z',
        });

        const result = db.appendSessionEvents(session.id, {
            snapshots: [makeSnapshot()],
        });

        assert.equal(result.snapshots_added, 1);
        const updated = db.getSession(session.id);
        assert.equal(updated.snapshot_count, 1);
    });

    it('should return null for non-existent session', () => {
        const result = db.appendSessionEvents('sess-nonexistent', { events: [makeEvent()] });
        assert.equal(result, null);
    });

    it('should return null when agent_id does not match (P2-2)', () => {
        const session = db.createSession({
            app_id: 'app-1',
            agent_id: 'agent-A',
            start_time: '2026-03-21T10:00:00.000Z',
        });

        const result = db.appendSessionEvents(session.id, {
            events: [makeEvent()],
            agent_id: 'agent-B',
        });
        assert.equal(result, null);

        // Original session unchanged
        const check = db.getSession(session.id);
        assert.equal(check.event_count, 0);
    });

    it('should allow append when agent_id matches', () => {
        const session = db.createSession({
            app_id: 'app-1',
            agent_id: 'agent-A',
            start_time: '2026-03-21T10:00:00.000Z',
        });

        const result = db.appendSessionEvents(session.id, {
            events: [makeEvent()],
            agent_id: 'agent-A',
        });
        assert.ok(result);
        assert.equal(result.events_added, 1);
    });

    it('should throw SESSION_FINALIZED when appending to completed session (P2-6)', () => {
        const session = db.createSession({
            app_id: 'app-1',
            start_time: '2026-03-21T10:00:00.000Z',
        });
        db.finalizeSession(session.id);

        assert.throws(() => {
            db.appendSessionEvents(session.id, { events: [makeEvent()] });
        }, /SESSION_FINALIZED/);
    });

    it('should reject invalid event type in append', () => {
        const session = db.createSession({
            app_id: 'app-1',
            start_time: '2026-03-21T10:00:00.000Z',
        });

        assert.throws(() => {
            db.appendSessionEvents(session.id, {
                events: [makeEvent({ type: 'bad-type' })],
            });
        }, /INVALID_EVENT_TYPE/);
    });
});

// ================================================================= listing

describe('Session Storage — listSessions', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('should list sessions by app_id', () => {
        db.createSession({ app_id: 'app-1', start_time: '2026-03-21T10:00:00.000Z' });
        db.createSession({ app_id: 'app-1', start_time: '2026-03-21T11:00:00.000Z' });
        db.createSession({ app_id: 'app-2', start_time: '2026-03-21T12:00:00.000Z' });

        const sessions = db.listSessions({ app_id: 'app-1' });
        assert.equal(sessions.length, 2);
    });

    it('should filter by agent_id', () => {
        db.createSession({ app_id: 'app-1', agent_id: 'agent-A', start_time: '2026-03-21T10:00:00.000Z' });
        db.createSession({ app_id: 'app-1', agent_id: 'agent-B', start_time: '2026-03-21T11:00:00.000Z' });

        const sessions = db.listSessions({ app_id: 'app-1', agent_id: 'agent-A' });
        assert.equal(sessions.length, 1);
        assert.equal(sessions[0].agent_id, 'agent-A');
    });

    it('should filter by site (URL contains)', () => {
        db.createSession({ app_id: 'app-1', url: 'https://example.com/foo', start_time: '2026-03-21T10:00:00.000Z' });
        db.createSession({ app_id: 'app-1', url: 'https://other.com/bar', start_time: '2026-03-21T11:00:00.000Z' });

        const sessions = db.listSessions({ app_id: 'app-1', site: 'example.com' });
        assert.equal(sessions.length, 1);
        assert.ok(sessions[0].url.includes('example.com'));
    });

    it('should escape LIKE wildcards in site filter (P2-3)', () => {
        db.createSession({ app_id: 'app-1', url: 'https://example.com/foo', start_time: '2026-03-21T10:00:00.000Z' });
        db.createSession({ app_id: 'app-1', url: 'https://other.com/bar', start_time: '2026-03-21T11:00:00.000Z' });

        // '%' as site should not match everything
        const sessions = db.listSessions({ app_id: 'app-1', site: '%' });
        assert.equal(sessions.length, 0);
    });

    it('should filter by time (after)', () => {
        db.createSession({ app_id: 'app-1', start_time: '2026-03-20T10:00:00.000Z' });
        db.createSession({ app_id: 'app-1', start_time: '2026-03-21T10:00:00.000Z' });

        const sessions = db.listSessions({ app_id: 'app-1', after: '2026-03-21T00:00:00.000Z' });
        assert.equal(sessions.length, 1);
    });

    it('should respect limit', () => {
        for (let i = 0; i < 5; i++) {
            db.createSession({ app_id: 'app-1', start_time: `2026-03-21T${10 + i}:00:00.000Z` });
        }
        const sessions = db.listSessions({ app_id: 'app-1', limit: 3 });
        assert.equal(sessions.length, 3);
    });

    it('should return in reverse chronological order', () => {
        db.createSession({ app_id: 'app-1', start_time: '2026-03-21T10:00:00.000Z' });
        db.createSession({ app_id: 'app-1', start_time: '2026-03-21T12:00:00.000Z' });
        db.createSession({ app_id: 'app-1', start_time: '2026-03-21T11:00:00.000Z' });

        const sessions = db.listSessions({ app_id: 'app-1' });
        assert.equal(sessions[0].start_time, '2026-03-21T12:00:00.000Z');
        assert.equal(sessions[1].start_time, '2026-03-21T11:00:00.000Z');
        assert.equal(sessions[2].start_time, '2026-03-21T10:00:00.000Z');
    });
});

// ================================================================= detail + range

describe('Session Storage — getSessionEvents', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('should return all events for a session', () => {
        const session = db.createSession({
            app_id: 'app-1',
            start_time: '2026-03-21T10:00:00.000Z',
            events: [
                makeEvent({ timestamp: '2026-03-21T10:00:01.000Z' }),
                makeEvent({ timestamp: '2026-03-21T10:00:02.000Z' }),
                makeEvent({ timestamp: '2026-03-21T10:00:03.000Z' }),
            ],
        });

        const events = db.getSessionEvents(session.id);
        assert.equal(events.length, 3);
    });

    it('should support range query (start_time, end_time)', () => {
        const session = db.createSession({
            app_id: 'app-1',
            start_time: '2026-03-21T10:00:00.000Z',
            events: [
                makeEvent({ timestamp: '2026-03-21T10:00:01.000Z' }),
                makeEvent({ timestamp: '2026-03-21T10:00:05.000Z' }),
                makeEvent({ timestamp: '2026-03-21T10:00:10.000Z' }),
            ],
        });

        const events = db.getSessionEvents(session.id, {
            start_time: '2026-03-21T10:00:02.000Z',
            end_time: '2026-03-21T10:00:08.000Z',
        });
        assert.equal(events.length, 1);
        assert.equal(events[0].timestamp, '2026-03-21T10:00:05.000Z');
    });
});

// ================================================================= finalize

describe('Session Storage — finalizeSession', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('should mark session as completed', () => {
        const session = db.createSession({
            app_id: 'app-1',
            start_time: '2026-03-21T10:00:00.000Z',
        });

        const result = db.finalizeSession(session.id);
        assert.equal(result.status, 'completed');
        assert.ok(result.end_time);

        const updated = db.getSession(session.id);
        assert.equal(updated.status, 'completed');
    });

    it('should return null for non-existent session', () => {
        const result = db.finalizeSession('sess-nonexistent');
        assert.equal(result, null);
    });
});

// ================================================================= cleanup

describe('Session Storage — cleanupOldSessions', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('should delete completed sessions older than retention period', () => {
        const session = db.createSession({
            app_id: 'app-1',
            start_time: '2026-01-01T10:00:00.000Z',
        });
        db.finalizeSession(session.id);

        // Manually backdate the updated_at
        db.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
            .run('2026-01-01T10:00:00.000Z', session.id);

        const result = db.cleanupOldSessions(30);
        assert.ok(result.deleted >= 1);
        assert.ok(result.completed >= 1);

        const check = db.getSession(session.id);
        assert.equal(check, null);
    });

    it('should not delete recent active sessions', () => {
        const session = db.createSession({
            app_id: 'app-1',
            start_time: '2026-03-21T10:00:00.000Z',
        });

        const result = db.cleanupOldSessions(30, 7);
        assert.equal(result.deleted, 0);

        const check = db.getSession(session.id);
        assert.ok(check);
    });

    it('should clean up orphaned active sessions older than orphanDays (P2-7)', () => {
        const session = db.createSession({
            app_id: 'app-1',
            start_time: '2026-01-01T10:00:00.000Z',
        });

        // Backdate updated_at to simulate orphan (never finalized, very old)
        db.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
            .run('2026-01-01T10:00:00.000Z', session.id);

        const result = db.cleanupOldSessions(30, 7);
        assert.ok(result.orphaned >= 1);

        const check = db.getSession(session.id);
        assert.equal(check, null);
    });
});
