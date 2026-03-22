/**
 * ClawMark — Session Analyzer & Reproduction Generator Tests (#74)
 *
 * Tests cover:
 * 1. Session-error correlation (overlapping sessions, time-window segments)
 * 2. Triggering action identification
 * 3. Reproduction step generation
 * 4. Enhanced issue description with session context
 * 5. Graceful degradation when session data is unavailable
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initDb } = require('../server/db');
const {
    findOverlappingSessions,
    getSessionSegment,
    findTriggeringAction,
    correlate,
} = require('../server/agent/session-analyzer');
const {
    describeEvent,
    generateSteps,
    generateReport,
} = require('../server/agent/reproduction-generator');
const PerceptionIssueCreator = require('../server/agent/issue-creator');

// ------------------------------------------------------------------ helpers

let db;
let tmpDir;

function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawmark-session-analyzer-test-'));
    db = initDb(tmpDir);
}

function teardown() {
    if (db && db.db) db.db.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

function makeSessionEvent(type, timestampOffset, data = {}) {
    return {
        type,
        timestamp: new Date(Date.parse('2026-03-21T10:00:00.000Z') + timestampOffset).toISOString(),
        data: JSON.stringify(data),
    };
}

function makePerceptionEvent(overrides = {}) {
    return {
        type: 'js-error',
        message: 'TypeError: Cannot read property "x" of null',
        stack: 'at handler (app.js:42:10)\nat dispatch (router.js:100:5)',
        source: 'app.js',
        line: 42,
        severity: 'error',
        url: 'https://example.com/page',
        fingerprint: 'test-fp-001',
        context: '{}',
        ...overrides,
    };
}

// Create a session with events spanning a time range
function createTestSession(appId, startOffset, events) {
    const startTime = new Date(Date.parse('2026-03-21T10:00:00.000Z') + startOffset).toISOString();
    return db.createSession({
        app_id: appId,
        agent_id: null,
        url: 'https://example.com/page',
        start_time: startTime,
        events: events || [],
        snapshots: [],
    });
}

// ------------------------------------------------------------------ Session Analyzer

describe('Session Analyzer (#74)', () => {
    beforeEach(setup);
    afterEach(teardown);

    describe('findOverlappingSessions', () => {
        it('should find sessions that contain the error timestamp', () => {
            // Session from T+0 to T+60s
            const sess = createTestSession('app-1', 0, [
                makeSessionEvent('click', 5000),
                makeSessionEvent('scroll', 30000),
            ]);
            db.finalizeSession(sess.id);

            const errorTime = new Date(Date.parse('2026-03-21T10:00:30.000Z')).toISOString();
            const results = findOverlappingSessions(db, 'app-1', errorTime);
            assert.ok(results.length >= 1);
        });

        it('should not find sessions from a different app', () => {
            createTestSession('app-OTHER', 0, [
                makeSessionEvent('click', 5000),
            ]);

            const errorTime = new Date(Date.parse('2026-03-21T10:00:05.000Z')).toISOString();
            const results = findOverlappingSessions(db, 'app-1', errorTime);
            assert.equal(results.length, 0);
        });

        it('should include active (non-finalized) sessions', () => {
            // Active session — no end_time, treated as ongoing
            createTestSession('app-1', 0, [
                makeSessionEvent('click', 1000),
            ]);

            const errorTime = new Date(Date.parse('2026-03-21T10:05:00.000Z')).toISOString();
            const results = findOverlappingSessions(db, 'app-1', errorTime);
            assert.ok(results.length >= 1);
        });
    });

    describe('getSessionSegment', () => {
        it('should return events within the time window around error', () => {
            const sess = createTestSession('app-1', 0, [
                makeSessionEvent('click', 5000),       // T+5s — within 30s before
                makeSessionEvent('scroll', 20000),      // T+20s — within 30s before
                makeSessionEvent('click', 29000),       // T+29s — within 30s before
                makeSessionEvent('dom-mutation', 60000), // T+60s — outside window
            ]);

            // Error at T+30s, window: T+0s to T+40s
            const errorTime = new Date(Date.parse('2026-03-21T10:00:30.000Z')).toISOString();
            const events = getSessionSegment(db, sess.id, errorTime);
            assert.equal(events.length, 3);
        });

        it('should respect custom window sizes', () => {
            const sess = createTestSession('app-1', 0, [
                makeSessionEvent('click', 5000),   // T+5s
                makeSessionEvent('scroll', 8000),   // T+8s
                makeSessionEvent('click', 12000),   // T+12s
            ]);

            // Error at T+10s, window: 5s before (T+5s) to 2s after (T+12s)
            const errorTime = new Date(Date.parse('2026-03-21T10:00:10.000Z')).toISOString();
            const events = getSessionSegment(db, sess.id, errorTime, {
                beforeMs: 5000,
                afterMs: 2000,
            });
            assert.equal(events.length, 3);
        });
    });

    describe('findTriggeringAction', () => {
        it('should find the last user action before error', () => {
            const events = [
                { type: 'click', timestamp: '2026-03-21T10:00:05.000Z', data: '{"selector":"button.submit"}' },
                { type: 'dom-mutation', timestamp: '2026-03-21T10:00:06.000Z', data: '{}' },
                { type: 'scroll', timestamp: '2026-03-21T10:00:08.000Z', data: '{}' },
                { type: 'console-error', timestamp: '2026-03-21T10:00:10.000Z', data: '{}' },
            ];

            const trigger = findTriggeringAction(events, '2026-03-21T10:00:10.000Z');
            assert.ok(trigger);
            assert.equal(trigger.type, 'scroll');
        });

        it('should return null when no user actions precede the error', () => {
            const events = [
                { type: 'dom-mutation', timestamp: '2026-03-21T10:00:05.000Z', data: '{}' },
                { type: 'console-error', timestamp: '2026-03-21T10:00:10.000Z', data: '{}' },
            ];

            const trigger = findTriggeringAction(events, '2026-03-21T10:00:10.000Z');
            assert.equal(trigger, null);
        });
    });

    describe('correlate', () => {
        it('should return full correlation for matching session', () => {
            createTestSession('app-1', 0, [
                makeSessionEvent('click', 5000, { selector: 'button.save' }),
                makeSessionEvent('scroll', 15000),
                makeSessionEvent('click', 25000, { selector: 'input#name' }),
            ]);

            const errorEvent = makePerceptionEvent({
                app_id: 'app-1',
                created_at: '2026-03-21T10:00:28.000Z',
            });

            const result = correlate(db, errorEvent);
            assert.ok(result);
            assert.ok(result.session);
            assert.ok(result.events.length > 0);
            assert.ok(result.trigger); // Last click at T+25s
        });

        it('should return null when no session matches', () => {
            const errorEvent = makePerceptionEvent({
                app_id: 'app-1',
                created_at: '2026-03-21T12:00:00.000Z',
            });

            const result = correlate(db, errorEvent);
            assert.equal(result, null);
        });
    });
});

// ------------------------------------------------------------------ Reproduction Generator

describe('Reproduction Generator (#74)', () => {
    describe('describeEvent', () => {
        it('should describe click events', () => {
            const desc = describeEvent({
                type: 'click',
                timestamp: '2026-03-21T10:00:05.000Z',
                data: JSON.stringify({ selector: 'button.submit', text: 'Save' }),
            });
            assert.ok(desc.includes('Click'));
            assert.ok(desc.includes('button.submit'));
            assert.ok(desc.includes('Save'));
        });

        it('should describe network errors', () => {
            const desc = describeEvent({
                type: 'network-error',
                timestamp: '2026-03-21T10:00:05.000Z',
                data: JSON.stringify({ method: 'POST', url: 'https://api.example.com/save', status: 500 }),
            });
            assert.ok(desc.includes('Network error'));
            assert.ok(desc.includes('POST'));
            assert.ok(desc.includes('500'));
        });

        it('should handle events with missing data gracefully', () => {
            const desc = describeEvent({
                type: 'click',
                timestamp: '2026-03-21T10:00:05.000Z',
                data: '{}',
            });
            assert.ok(desc.includes('Click'));
        });
    });

    describe('generateSteps', () => {
        it('should generate ordered steps from events', () => {
            const events = [
                { type: 'click', timestamp: '2026-03-21T10:00:05.000Z', data: '{"selector":"button.login"}' },
                { type: 'network-error', timestamp: '2026-03-21T10:00:06.000Z', data: '{"method":"POST","url":"/api/auth","status":500}' },
                { type: 'console-error', timestamp: '2026-03-21T10:00:07.000Z', data: '{"message":"Auth failed"}' },
            ];

            const steps = generateSteps(events, '2026-03-21T10:00:08.000Z');
            assert.equal(steps.length, 3);
            assert.ok(steps[0].startsWith('1.'));
            assert.ok(steps[2].startsWith('3.'));
        });

        it('should limit steps to maxSteps', () => {
            const events = Array.from({ length: 20 }, (_, i) => ({
                type: 'click',
                timestamp: new Date(Date.parse('2026-03-21T10:00:00.000Z') + i * 1000).toISOString(),
                data: `{"selector":"el-${i}"}`,
            }));

            const steps = generateSteps(events, '2026-03-21T10:00:25.000Z', { maxSteps: 5 });
            assert.equal(steps.length, 5);
        });

        it('should only include events before or at error time', () => {
            const events = [
                { type: 'click', timestamp: '2026-03-21T10:00:05.000Z', data: '{}' },
                { type: 'click', timestamp: '2026-03-21T10:00:15.000Z', data: '{}' },
            ];

            const steps = generateSteps(events, '2026-03-21T10:00:10.000Z');
            assert.equal(steps.length, 1);
        });
    });

    describe('generateReport', () => {
        it('should produce a complete report with timeline', () => {
            const correlation = {
                session: { id: 'sess-1', url: 'https://example.com/page' },
                events: [
                    { type: 'click', timestamp: '2026-03-21T10:00:05.000Z', data: '{"selector":"button.save"}' },
                    { type: 'network-error', timestamp: '2026-03-21T10:00:06.000Z', data: '{"method":"POST","url":"/api/save","status":500}' },
                ],
                trigger: { type: 'click', timestamp: '2026-03-21T10:00:05.000Z', data: '{"selector":"button.save"}' },
                closestSnapshot: null,
            };
            const errorEvent = makePerceptionEvent({ created_at: '2026-03-21T10:00:07.000Z' });

            const report = generateReport(correlation, errorEvent);
            assert.ok(report.steps.length > 0);
            assert.ok(report.trigger);
            assert.ok(report.timeline.includes('Steps to reproduce'));
            assert.ok(report.timeline.includes('example.com/page'));
        });

        it('should handle correlation without trigger', () => {
            const correlation = {
                session: { id: 'sess-1', url: 'https://example.com' },
                events: [
                    { type: 'dom-mutation', timestamp: '2026-03-21T10:00:05.000Z', data: '{}' },
                ],
                trigger: null,
                closestSnapshot: null,
            };
            const errorEvent = makePerceptionEvent({ created_at: '2026-03-21T10:00:07.000Z' });

            const report = generateReport(correlation, errorEvent);
            assert.equal(report.trigger, null);
            assert.ok(report.timeline.includes('Error occurred at'));
        });
    });
});

// ------------------------------------------------------------------ Enhanced Issue Creator

describe('Enhanced Issue Creator (#74)', () => {
    it('should include reproduction steps in description when session context provided', () => {
        const creator = new PerceptionIssueCreator({
            token: 'test',
            project_id: 'test/project',
        });

        const group = {
            fingerprint: 'fp-001',
            count: 3,
            representative: makePerceptionEvent({ created_at: '2026-03-21T10:00:10.000Z' }),
            events: [makePerceptionEvent({ created_at: '2026-03-21T10:00:08.000Z' })],
        };

        const sessionContext = {
            report: {
                steps: ['1. Click on button.save', '2. Network error: POST /api/save (500)'],
                trigger: 'Click on button.save',
                timeline: 'Page: https://example.com/page\n\n### Steps to reproduce\n\n1. Click on button.save\n2. Network error: POST /api/save (500)\n\n**Triggering action**: Click on button.save\n\n**Error occurred at**: 2026-03-21T10:00:10.000Z',
            },
            correlation: {
                closestSnapshot: { id: 'snap-001', timestamp: '2026-03-21T10:00:09.000Z' },
            },
        };

        const desc = creator._buildDescription(group, sessionContext);
        assert.ok(desc.includes('Steps to reproduce'));
        assert.ok(desc.includes('Click on button.save'));
        assert.ok(desc.includes('Snapshot'));
        assert.ok(desc.includes('snap-001'));
    });

    it('should fall back to basic context when no session context', () => {
        const creator = new PerceptionIssueCreator({
            token: 'test',
            project_id: 'test/project',
        });

        const group = {
            fingerprint: 'fp-002',
            count: 1,
            representative: makePerceptionEvent({
                created_at: '2026-03-21T10:00:10.000Z',
                context: JSON.stringify({ userAction: 'button click', sessionPhase: 'checkout' }),
            }),
            events: [makePerceptionEvent({ created_at: '2026-03-21T10:00:10.000Z' })],
        };

        const desc = creator._buildDescription(group);
        assert.ok(desc.includes('Context'));
        assert.ok(desc.includes('button click'));
        assert.ok(!desc.includes('Steps to reproduce'));
    });

    it('should handle session context without snapshot', () => {
        const creator = new PerceptionIssueCreator({
            token: 'test',
            project_id: 'test/project',
        });

        const group = {
            fingerprint: 'fp-003',
            count: 1,
            representative: makePerceptionEvent({ created_at: '2026-03-21T10:00:10.000Z' }),
            events: [makePerceptionEvent({ created_at: '2026-03-21T10:00:10.000Z' })],
        };

        const sessionContext = {
            report: {
                steps: ['1. Click on element'],
                trigger: null,
                timeline: '### Steps to reproduce\n\n1. Click on element\n\n**Error occurred at**: 2026-03-21T10:00:10.000Z',
            },
            correlation: { closestSnapshot: null },
        };

        const desc = creator._buildDescription(group, sessionContext);
        assert.ok(desc.includes('Steps to reproduce'));
        assert.ok(!desc.includes('Snapshot'));
    });
});
