/**
 * ClawMark — Patrol Scripts Tests (#79)
 *
 * Tests assertion engine, runner, scheduler, and example scripts.
 * Run: node --test test/patrol.test.js
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, evaluateAll } = require('../server/agent/patrol/assertions');
const { runPatrol, reportFailures, interpolateParams } = require('../server/agent/patrol/runner');
const { parseCron, matchesCron, PatrolScheduler } = require('../server/agent/patrol/scheduler');
const { getBuiltinScripts, getScriptById } = require('../server/agent/patrol/scripts');

// ── Assertion Engine Tests ──────────────────────────────────────────

describe('Patrol Assertions', () => {
    describe('element-exists', () => {
        it('passes when element found in context', () => {
            const result = evaluate(
                { type: 'element-exists', expected: { selector: '.btn' } },
                { elements: ['.btn', '.header'] }
            );
            assert.ok(result.pass);
        });

        it('fails when element not found', () => {
            const result = evaluate(
                { type: 'element-exists', expected: { selector: '.missing' } },
                { elements: ['.btn'] }
            );
            assert.ok(!result.pass);
            assert.ok(result.message.includes('not found'));
        });

        it('passes when result.found is true', () => {
            const result = evaluate(
                { type: 'element-exists', expected: { selector: '#app' } },
                { result: { found: true } }
            );
            assert.ok(result.pass);
        });

        it('fails with missing selector', () => {
            const result = evaluate(
                { type: 'element-exists', expected: {} },
                {}
            );
            assert.ok(!result.pass);
            assert.ok(result.message.includes('Missing selector'));
        });
    });

    describe('text-match', () => {
        it('passes on substring match', () => {
            const result = evaluate(
                { type: 'text-match', expected: { text: 'hello' } },
                { text: 'say hello world' }
            );
            assert.ok(result.pass);
        });

        it('fails when text not found', () => {
            const result = evaluate(
                { type: 'text-match', expected: { text: 'goodbye' } },
                { text: 'hello world' }
            );
            assert.ok(!result.pass);
        });

        it('exact match mode', () => {
            const result = evaluate(
                { type: 'text-match', expected: { text: 'hello', exact: true } },
                { text: 'hello world' }
            );
            assert.ok(!result.pass); // not exact

            const result2 = evaluate(
                { type: 'text-match', expected: { text: 'hello', exact: true } },
                { text: 'hello' }
            );
            assert.ok(result2.pass);
        });

        it('reads from result.text', () => {
            const result = evaluate(
                { type: 'text-match', expected: { text: 'dashboard' } },
                { result: { text: 'Welcome to dashboard' } }
            );
            assert.ok(result.pass);
        });
    });

    describe('url-match', () => {
        it('passes on substring URL match', () => {
            const result = evaluate(
                { type: 'url-match', expected: { url: '/dashboard' } },
                { url: 'https://example.com/dashboard' }
            );
            assert.ok(result.pass);
        });

        it('fails on mismatch', () => {
            const result = evaluate(
                { type: 'url-match', expected: { url: '/admin' } },
                { url: 'https://example.com/dashboard' }
            );
            assert.ok(!result.pass);
            assert.ok(result.message.includes('mismatch'));
        });

        it('exact URL match mode', () => {
            const result = evaluate(
                { type: 'url-match', expected: { url: 'https://example.com', exact: true } },
                { url: 'https://example.com/path' }
            );
            assert.ok(!result.pass);
        });
    });

    describe('no-console-errors', () => {
        it('passes when no errors', () => {
            const result = evaluate(
                { type: 'no-console-errors', expected: {} },
                { consoleErrors: [] }
            );
            assert.ok(result.pass);
        });

        it('fails when errors present', () => {
            const result = evaluate(
                { type: 'no-console-errors', expected: {} },
                { consoleErrors: ['TypeError: x is undefined'] }
            );
            assert.ok(!result.pass);
            assert.ok(result.message.includes('1 console error'));
        });

        it('passes with no context', () => {
            const result = evaluate(
                { type: 'no-console-errors', expected: {} },
                {}
            );
            assert.ok(result.pass);
        });
    });

    describe('result-match', () => {
        it('matches nested path', () => {
            const result = evaluate(
                { type: 'result-match', expected: { path: 'data.title', value: 'Test' } },
                { result: { data: { title: 'Test' } } }
            );
            assert.ok(result.pass);
        });

        it('fails on mismatch', () => {
            const result = evaluate(
                { type: 'result-match', expected: { path: 'status', value: 200 } },
                { result: { status: 404 } }
            );
            assert.ok(!result.pass);
        });
    });

    describe('evaluateAll', () => {
        it('returns aggregate results', () => {
            const { results, allPassed, failCount } = evaluateAll([
                { type: 'url-match', expected: { url: '/home' } },
                { type: 'no-console-errors', expected: {} },
                { type: 'text-match', expected: { text: 'missing' } },
            ], { url: '/home', consoleErrors: [], text: 'welcome' });

            assert.equal(results.length, 3);
            assert.ok(!allPassed);
            assert.equal(failCount, 1);
        });

        it('all pass', () => {
            const { allPassed, failCount } = evaluateAll([
                { type: 'no-console-errors', expected: {} },
            ], { consoleErrors: [] });

            assert.ok(allPassed);
            assert.equal(failCount, 0);
        });
    });

    describe('unknown type', () => {
        it('fails gracefully', () => {
            const result = evaluate({ type: 'nonexistent', expected: {} }, {});
            assert.ok(!result.pass);
            assert.ok(result.message.includes('Unknown assertion type'));
        });
    });
});

// ── Parameter Interpolation Tests ───────────────────────────────────

describe('Parameter Interpolation', () => {
    it('replaces {{param}} in payload values', () => {
        const result = interpolateParams(
            { url: '{{baseUrl}}/login', selector: '#btn' },
            { baseUrl: 'https://example.com' }
        );
        assert.equal(result.url, 'https://example.com/login');
        assert.equal(result.selector, '#btn');
    });

    it('leaves unmatched params as-is', () => {
        const result = interpolateParams(
            { url: '{{baseUrl}}/{{path}}' },
            { baseUrl: 'https://example.com' }
        );
        assert.equal(result.url, 'https://example.com/{{path}}');
    });

    it('handles non-string values', () => {
        const result = interpolateParams(
            { url: '{{base}}', timeout: 5000 },
            { base: 'https://x.com' }
        );
        assert.equal(result.timeout, 5000);
    });

    it('handles empty params', () => {
        const result = interpolateParams({ url: '/test' }, {});
        assert.equal(result.url, '/test');
    });
});

// ── Runner Tests ────────────────────────────────────────────────────

describe('Patrol Runner', () => {
    function mockDb(actionResults = {}) {
        let actionCounter = 0;
        const actions = new Map();
        const perceptionEvents = [];

        return {
            createAction(opts) {
                const id = ++actionCounter;
                const action = { id, ...opts, status: 'completed', result: actionResults[opts.type] || {} };
                actions.set(id, action);
                return action;
            },
            getAction(id) {
                return actions.get(id);
            },
            createPerceptionEvents(events) {
                perceptionEvents.push(...events);
                return events.map((e, i) => ({ id: i + 1, ...e }));
            },
            _perceptionEvents: perceptionEvents,
        };
    }

    it('runs a simple patrol with passing assertions', async () => {
        const db = mockDb({ navigate: { url: 'https://example.com' } });

        const script = {
            id: 'test-patrol',
            name: 'Test Patrol',
            steps: [
                {
                    action: 'navigate',
                    payload: { url: 'https://example.com' },
                    label: 'Go to homepage',
                    assertions: [
                        { type: 'url-match', expected: { url: 'example.com' } },
                    ],
                },
            ],
        };

        const result = await runPatrol(script, {
            db, agentId: 'agent-1', appId: 'app-1',
        });

        assert.equal(result.status, 'passed');
        assert.equal(result.steps.length, 1);
        assert.equal(result.steps[0].status, 'passed');
    });

    it('reports failed assertions', async () => {
        const db = mockDb({ navigate: { url: 'https://example.com/wrong' } });

        const script = {
            id: 'test-fail',
            name: 'Fail Patrol',
            steps: [
                {
                    action: 'navigate',
                    payload: { url: 'https://example.com' },
                    assertions: [
                        { type: 'url-match', expected: { url: '/dashboard', exact: true } },
                    ],
                },
            ],
        };

        const result = await runPatrol(script, {
            db, agentId: 'agent-1', appId: 'app-1',
        });

        assert.equal(result.status, 'failed');
        assert.equal(result.steps[0].status, 'failed');
    });

    it('dry-run skips assertions', async () => {
        const db = mockDb({ navigate: {} });

        const script = {
            id: 'dry-test',
            name: 'Dry Run',
            steps: [
                {
                    action: 'navigate',
                    payload: { url: 'https://example.com' },
                    assertions: [
                        { type: 'url-match', expected: { url: '/will-not-match' } },
                    ],
                },
            ],
        };

        const result = await runPatrol(script, {
            db, agentId: 'agent-1', appId: 'app-1',
        }, { dryRun: true });

        // Should not fail because assertions are skipped
        assert.equal(result.steps[0].status, 'skipped');
        assert.equal(result.dryRun, true);
    });

    it('handles wait steps', async () => {
        const db = mockDb();

        const script = {
            id: 'wait-test',
            name: 'Wait Test',
            steps: [
                { action: 'wait', payload: { ms: 10 } },
            ],
        };

        const result = await runPatrol(script, {
            db, agentId: 'agent-1', appId: 'app-1',
        });

        assert.equal(result.status, 'passed');
        assert.equal(result.steps[0].action, 'wait');
    });

    it('stops on action error', async () => {
        let actionCounter = 0;
        const db = {
            createAction() {
                actionCounter++;
                return { id: actionCounter, status: 'failed', error: 'Element not found' };
            },
            getAction(id) {
                return { id, status: 'failed', error: 'Element not found' };
            },
        };

        const script = {
            id: 'error-test',
            name: 'Error Test',
            steps: [
                { action: 'click', payload: { selector: '.missing' } },
                { action: 'screenshot', payload: {} },
            ],
        };

        const result = await runPatrol(script, {
            db, agentId: 'agent-1', appId: 'app-1',
        }, { stepTimeout: 1000 });

        assert.equal(result.status, 'failed');
        assert.equal(result.steps.length, 1); // second step not executed
        assert.equal(result.steps[0].status, 'error');
    });

    it('calls onStep callback', async () => {
        const db = mockDb({ navigate: {} });
        const steps = [];

        const script = {
            id: 'cb-test',
            name: 'Callback Test',
            steps: [
                { action: 'navigate', payload: { url: 'https://x.com' } },
                { action: 'wait', payload: { ms: 10 } },
            ],
        };

        await runPatrol(script, {
            db, agentId: 'agent-1', appId: 'app-1',
        }, { onStep: (s) => steps.push(s) });

        assert.equal(steps.length, 2);
    });

    it('interpolates params in step payloads', async () => {
        let capturedPayload;
        const db = {
            createAction(opts) {
                capturedPayload = opts.payload;
                return { id: 1, ...opts, status: 'completed', result: {} };
            },
            getAction() { return { id: 1, status: 'completed', result: '{}' }; },
        };

        const script = {
            id: 'param-test',
            name: 'Param Test',
            params: { baseUrl: 'https://default.com' },
            steps: [
                { action: 'navigate', payload: { url: '{{baseUrl}}/page' } },
            ],
        };

        await runPatrol(script, {
            db, agentId: 'agent-1', appId: 'app-1',
        }, { params: { baseUrl: 'https://override.com' } });

        assert.equal(capturedPayload.url, 'https://override.com/page');
    });
});

// ── Failure Reporting Tests ─────────────────────────────────────────

describe('Failure Reporting', () => {
    it('creates perception events for failed assertions', () => {
        const events = [];
        const db = {
            createPerceptionEvents(e) {
                events.push(...e);
                return e;
            },
        };

        const patrolResult = {
            patrolId: 'test-patrol',
            name: 'Test',
            status: 'failed',
            steps: [
                {
                    stepIndex: 0,
                    label: 'Navigate',
                    action: 'navigate',
                    status: 'failed',
                    actionResult: { url: 'https://example.com' },
                    assertionResults: {
                        results: [
                            { type: 'url-match', pass: false, actual: '/wrong', message: 'URL mismatch' },
                            { type: 'no-console-errors', pass: true, actual: 'no errors', message: 'ok' },
                        ],
                        allPassed: false,
                        failCount: 1,
                    },
                },
            ],
        };

        const count = reportFailures(patrolResult, db, 'app-1');
        assert.equal(count, 1);
        assert.equal(events.length, 1);
        assert.ok(events[0].fingerprint.startsWith('patrol-'));
        assert.ok(events[0].message.includes('URL mismatch'));
    });

    it('skips reporting when all passed', () => {
        const db = { createPerceptionEvents: () => [] };

        const patrolResult = {
            patrolId: 'ok', name: 'OK', status: 'passed',
            steps: [{ stepIndex: 0, status: 'passed', assertionResults: null }],
        };

        const count = reportFailures(patrolResult, db, 'app-1');
        assert.equal(count, 0);
    });
});

// ── Cron Parser Tests ───────────────────────────────────────────────

describe('Cron Parser', () => {
    it('parses simple cron', () => {
        const parsed = parseCron('0 */4 * * *');
        assert.deepEqual(parsed.minute, [0]);
        assert.deepEqual(parsed.hour, [0, 4, 8, 12, 16, 20]);
    });

    it('parses specific values', () => {
        const parsed = parseCron('30 8 * * 1');
        assert.deepEqual(parsed.minute, [30]);
        assert.deepEqual(parsed.hour, [8]);
        assert.deepEqual(parsed.dow, [1]);
    });

    it('parses ranges', () => {
        const parsed = parseCron('0 9-17 * * *');
        assert.deepEqual(parsed.hour, [9, 10, 11, 12, 13, 14, 15, 16, 17]);
    });

    it('parses lists', () => {
        const parsed = parseCron('0,30 * * * *');
        assert.deepEqual(parsed.minute, [0, 30]);
    });

    it('rejects invalid cron', () => {
        assert.throws(() => parseCron('invalid'), /Invalid cron/);
    });

    it('matches a date', () => {
        const parsed = parseCron('0 */4 * * *');
        const match = new Date('2026-03-22T08:00:00');
        const noMatch = new Date('2026-03-22T09:00:00');

        assert.ok(matchesCron(parsed, match));
        assert.ok(!matchesCron(parsed, noMatch));
    });
});

// ── Scheduler Tests ─────────────────────────────────────────────────

describe('Patrol Scheduler', () => {
    it('registers and lists patrols', () => {
        const scheduler = new PatrolScheduler({
            db: {}, agentId: 'a', appId: 'b',
        });

        scheduler.register({
            id: 'p1', name: 'Patrol 1', schedule: '0 * * * *', steps: [],
        });

        const status = scheduler.getStatus();
        assert.equal(status.length, 1);
        assert.equal(status[0].id, 'p1');
    });

    it('unregisters patrols', () => {
        const scheduler = new PatrolScheduler({
            db: {}, agentId: 'a', appId: 'b',
        });

        scheduler.register({ id: 'p1', name: 'P1', schedule: '* * * * *', steps: [] });
        scheduler.unregister('p1');
        assert.equal(scheduler.getStatus().length, 0);
    });

    it('rejects patrols without schedule', () => {
        const scheduler = new PatrolScheduler({
            db: {}, agentId: 'a', appId: 'b',
        });

        assert.throws(
            () => scheduler.register({ id: 'p1', name: 'P1', steps: [] }),
            /no schedule/
        );
    });
});

// ── Built-in Scripts Tests ──────────────────────────────────────────

describe('Built-in Patrol Scripts', () => {
    it('returns all built-in scripts', () => {
        const scripts = getBuiltinScripts();
        assert.ok(scripts.length >= 3);
        for (const s of scripts) {
            assert.ok(s.id);
            assert.ok(s.name);
            assert.ok(Array.isArray(s.steps));
            assert.ok(s.steps.length > 0);
        }
    });

    it('finds script by ID', () => {
        const script = getScriptById('patrol-login-flow');
        assert.ok(script);
        assert.equal(script.name, 'Login Flow');
    });

    it('returns undefined for unknown ID', () => {
        assert.equal(getScriptById('nonexistent'), undefined);
    });

    it('all scripts have valid action types', () => {
        const validActions = new Set(['navigate', 'click', 'screenshot', 'wait', 'type', 'assert-only']);
        for (const script of getBuiltinScripts()) {
            for (const step of script.steps) {
                assert.ok(validActions.has(step.action),
                    `Script "${script.id}" step "${step.label}" has invalid action: ${step.action}`);
            }
        }
    });

    it('all scripts have schedules', () => {
        for (const script of getBuiltinScripts()) {
            assert.ok(script.schedule, `Script "${script.id}" missing schedule`);
            // Should not throw
            parseCron(script.schedule);
        }
    });
});
