/**
 * ClawMark — Session Forwarder Tests (#61 Phase 2)
 *
 * Tests the extension background's session batching and upload logic.
 * Mocks chrome.storage and fetch APIs since this runs in Node.
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------------ helpers

function createChromeMock(opts = {}) {
    const syncStore = { boundAgents: [], serverUrl: 'http://localhost:9999', ...(opts.sync || {}) };
    const localStore = { authToken: 'test-jwt-token', ...(opts.local || {}) };
    const changeListeners = [];

    return {
        storage: {
            sync: {
                get: async (defaults) => {
                    const r = {};
                    for (const [k, v] of Object.entries(defaults || {})) {
                        r[k] = syncStore[k] !== undefined ? syncStore[k] : v;
                    }
                    return r;
                },
                set: async (obj) => {
                    const changes = {};
                    for (const [k, v] of Object.entries(obj)) {
                        changes[k] = { oldValue: syncStore[k], newValue: v };
                        syncStore[k] = v;
                    }
                    for (const fn of changeListeners) fn(changes, 'sync');
                },
            },
            local: {
                get: async (defaults) => {
                    const r = {};
                    for (const [k, v] of Object.entries(defaults || {})) {
                        r[k] = localStore[k] !== undefined ? localStore[k] : v;
                    }
                    return r;
                },
            },
            onChanged: {
                addListener: (fn) => changeListeners.push(fn),
            },
        },
        _syncStore: syncStore,
        _localStore: localStore,
    };
}

/**
 * Load the session forwarder module in a sandboxed context with mocked globals.
 */
function loadSessionForwarder(chromeMock, fetchMock) {
    const code = fs.readFileSync(
        path.join(__dirname, '..', 'extension', 'background', 'session-forwarder.js'),
        'utf-8'
    );

    const pendingTimers = [];
    let timerCounter = 0;
    const mockSetTimeout = (fn, ms) => {
        const id = ++timerCounter;
        pendingTimers.push({ fn, ms, id, active: true });
        return id;
    };
    const mockClearTimeout = (id) => {
        const t = pendingTimers.find(p => p.id === id);
        if (t) t.active = false;
    };
    const pendingIntervals = [];
    const mockSetInterval = (fn, ms) => {
        const id = ++timerCounter;
        pendingIntervals.push({ fn, ms, id });
        return id;
    };

    const wrapped = new Function(
        'chrome', 'fetch', 'ClawMarkConfig', 'setTimeout', 'clearTimeout', 'setInterval', 'console', 'Date', 'Map', 'Set', 'JSON', 'Array', 'String', 'AbortController', 'Error',
        `${code}
        return {
            enqueueSessionForServer,
            _flushSessions,
            _sessionHasBoundAgents: () => _sessionHasBoundAgents,
            _queueLength: () => _sessionQueue.length,
            _serverSessionMapSize: () => _serverSessionMap.size,
            _finalizedSize: () => _finalizedSessions.size,
        };`
    );

    const api = wrapped(
        chromeMock, fetchMock, { DEFAULT_SERVER: 'http://localhost:9999' },
        mockSetTimeout, mockClearTimeout, mockSetInterval, console,
        Date, Map, Set, JSON, Array, String, AbortController, Error
    );

    return {
        ...api,
        pendingTimers,
        async flushTimers() {
            // Clear any pending timers (don't fire them — we'll call flush directly)
            pendingTimers.splice(0);
            // Call flush directly and await it properly
            await api._flushSessions();
        },
    };
}

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

// ================================================================= tests

describe('Session Forwarder', () => {

    describe('when no bound agents', () => {
        it('should not queue session batches', async () => {
            const chrome = createChromeMock({ sync: { boundAgents: [] } });
            const fwd = loadSessionForwarder(chrome, async () => ({ ok: true }));
            await tick();

            fwd.enqueueSessionForServer({
                sessionId: 'sess-1',
                startTime: Date.now(),
                url: 'https://example.com',
                events: [{ type: 'click', timestamp: Date.now(), data: {} }],
            }, 1);

            assert.equal(fwd._queueLength(), 0);
        });
    });

    describe('when bound agents exist', () => {
        let chrome, fetchCalls, fetchResponses, fwd;

        beforeEach(async () => {
            fetchCalls = [];
            fetchResponses = []; // queue of responses
            const fetchMock = async (url, opts) => {
                fetchCalls.push({ url, opts });
                const resp = fetchResponses.shift() || {
                    ok: true, status: 201,
                    json: async () => ({ id: 'srv-sess-1', event_count: 1, snapshot_count: 0 }),
                };
                return resp;
            };
            chrome = createChromeMock({
                sync: { boundAgents: [{ id: 'agent1', name: 'QA Bot' }] },
                local: { authToken: 'test-jwt-token' },
            });
            fwd = loadSessionForwarder(chrome, fetchMock);
            await tick();
        });

        it('should queue session batches and schedule flush', () => {
            fwd.enqueueSessionForServer({
                sessionId: 'sess-1',
                startTime: Date.now(),
                url: 'https://example.com',
                events: [{ type: 'click', timestamp: Date.now(), data: { selector: '#btn' } }],
            }, 1);

            assert.equal(fwd._queueLength(), 1);
            assert.ok(fwd.pendingTimers.length >= 1, 'should have scheduled a flush timer');
        });

        it('should create a new server session on first flush', async () => {
            fwd.enqueueSessionForServer({
                sessionId: 'sess-1',
                startTime: Date.now() - 1000,
                url: 'https://example.com/page',
                title: 'Test Page',
                events: [
                    { type: 'click', timestamp: Date.now(), data: { selector: '#btn', tag: 'button' } },
                    { type: 'scroll', timestamp: Date.now(), data: { x: 0, y: 100 } },
                ],
            }, 42);

            await fwd.flushTimers();

            assert.equal(fetchCalls.length, 1, 'should make exactly one POST');
            const call = fetchCalls[0];
            assert.ok(call.url.includes('/api/v2/agent-channel/sessions'));
            assert.equal(call.opts.method, 'POST');

            const body = JSON.parse(call.opts.body);
            assert.equal(body.tab_id, '42');
            assert.equal(body.url, 'https://example.com/page');
            assert.equal(body.title, 'Test Page');
            assert.ok(body.start_time, 'should include ISO start_time');
            assert.ok(Array.isArray(body.events));
            assert.equal(body.events.length, 2);
            assert.equal(body.events[0].type, 'click');
        });

        it('should append to existing server session on subsequent flushes', async () => {
            // First batch — creates session
            fwd.enqueueSessionForServer({
                sessionId: 'sess-1',
                startTime: Date.now() - 2000,
                url: 'https://example.com',
                events: [{ type: 'click', timestamp: Date.now(), data: {} }],
            }, 1);
            await fwd.flushTimers();
            assert.equal(fetchCalls.length, 1);
            assert.equal(fwd._serverSessionMapSize(), 1, 'should map local to server session ID');

            // Second batch — appends
            fetchResponses.push({
                ok: true, status: 200,
                json: async () => ({ event_count: 3, snapshot_count: 0 }),
            });
            fwd.enqueueSessionForServer({
                sessionId: 'sess-1',
                startTime: Date.now() - 2000,
                url: 'https://example.com',
                events: [
                    { type: 'scroll', timestamp: Date.now(), data: { y: 200 } },
                    { type: 'input', timestamp: Date.now(), data: { tag: 'input' } },
                ],
            }, 1);
            await fwd.flushTimers();

            assert.equal(fetchCalls.length, 2);
            const body = JSON.parse(fetchCalls[1].opts.body);
            assert.ok(body.session_id, 'should include server session_id for append');
            assert.equal(body.session_id, 'srv-sess-1');
            assert.equal(body.events.length, 2);
        });

        it('should separate snapshots from regular events', async () => {
            const now = Date.now();
            fwd.enqueueSessionForServer({
                sessionId: 'sess-snap',
                startTime: now - 1000,
                url: 'https://example.com',
                events: [
                    { type: 'click', timestamp: now, data: { selector: '#x' } },
                    { type: 'snapshot', timestamp: now + 100, data: { trigger: 'page-load', html: '<div>test</div>' } },
                    { type: 'scroll', timestamp: now + 200, data: { y: 50 } },
                ],
            }, 1);

            await fwd.flushTimers();

            const body = JSON.parse(fetchCalls[0].opts.body);
            assert.equal(body.events.length, 2, 'snapshots should be separated from events');
            assert.ok(body.snapshots, 'should include snapshots array');
            assert.equal(body.snapshots.length, 1);
            assert.equal(body.snapshots[0].trigger, 'page-load');
            assert.ok(body.snapshots[0].html.includes('<div>test</div>'));
        });

        it('should finalize session when session-end event is received', async () => {
            // Create session
            fwd.enqueueSessionForServer({
                sessionId: 'sess-fin',
                startTime: Date.now() - 5000,
                url: 'https://example.com',
                events: [{ type: 'click', timestamp: Date.now(), data: {} }],
            }, 1);
            await fwd.flushTimers();

            // End session — has session-end event
            fetchResponses.push(
                // Append response
                { ok: true, status: 200, json: async () => ({ event_count: 2 }) },
                // Finalize response
                { ok: true, status: 200, json: async () => ({ status: 'completed' }) },
            );
            fwd.enqueueSessionForServer({
                sessionId: 'sess-fin',
                startTime: Date.now() - 5000,
                url: 'https://example.com',
                events: [{
                    type: 'navigation',
                    timestamp: Date.now(),
                    data: { action: 'session-end', reason: 'idle-timeout', duration: 5000, eventCount: 2 },
                }],
            }, 1);
            await fwd.flushTimers();

            // Should have: create(1) + append(2) + finalize(3)
            assert.equal(fetchCalls.length, 3, 'should POST append + finalize');
            const finalizeCall = fetchCalls[2];
            assert.ok(finalizeCall.url.includes('/finalize'), 'third call should be finalize');
            assert.equal(fwd._finalizedSize(), 1, 'session should be in finalized set');
        });

        it('should skip enqueue for finalized sessions', async () => {
            // Create + finalize
            fwd.enqueueSessionForServer({
                sessionId: 'sess-done',
                startTime: Date.now(),
                url: 'https://example.com',
                events: [{ type: 'click', timestamp: Date.now(), data: {} }],
            }, 1);
            await fwd.flushTimers();

            fetchResponses.push(
                { ok: true, status: 200, json: async () => ({ event_count: 1 }) },
                { ok: true, status: 200, json: async () => ({}) },
            );
            fwd.enqueueSessionForServer({
                sessionId: 'sess-done',
                startTime: Date.now(),
                url: 'https://example.com',
                events: [{ type: 'navigation', timestamp: Date.now(), data: { action: 'session-end' } }],
            }, 1);
            await fwd.flushTimers();

            const prevCallCount = fetchCalls.length;

            // Try to enqueue more events for finalized session
            fwd.enqueueSessionForServer({
                sessionId: 'sess-done',
                startTime: Date.now(),
                url: 'https://example.com',
                events: [{ type: 'click', timestamp: Date.now(), data: {} }],
            }, 1);

            assert.equal(fwd._queueLength(), 0, 'should not queue events for finalized sessions');
        });

        it('should not enqueue empty event batches', () => {
            fwd.enqueueSessionForServer({
                sessionId: 'sess-empty',
                startTime: Date.now(),
                url: 'https://example.com',
                events: [],
            }, 1);

            assert.equal(fwd._queueLength(), 0);
        });

        it('should not enqueue invalid batches', () => {
            fwd.enqueueSessionForServer(null, 1);
            fwd.enqueueSessionForServer({}, 1);
            fwd.enqueueSessionForServer({ sessionId: 'x' }, 1);
            fwd.enqueueSessionForServer({ sessionId: 'x', events: 'not-array' }, 1);

            assert.equal(fwd._queueLength(), 0);
        });

        it('should not flush when auth token is missing', async () => {
            chrome._localStore.authToken = '';

            fwd.enqueueSessionForServer({
                sessionId: 'sess-noauth',
                startTime: Date.now(),
                url: 'https://example.com',
                events: [{ type: 'click', timestamp: Date.now(), data: {} }],
            }, 1);

            await fwd.flushTimers();
            assert.equal(fetchCalls.length, 0, 'should not make any fetch calls');
            assert.ok(fwd._queueLength() > 0, 'events should remain in queue');
        });

        it('should block upload to untrusted origins', async () => {
            chrome._syncStore.serverUrl = 'http://evil.com:1234';

            fwd.enqueueSessionForServer({
                sessionId: 'sess-evil',
                startTime: Date.now(),
                url: 'https://example.com',
                events: [{ type: 'click', timestamp: Date.now(), data: {} }],
            }, 1);

            await fwd.flushTimers();
            assert.equal(fetchCalls.length, 0, 'should block upload to untrusted origin');
        });

        it('should map event types correctly', async () => {
            const now = Date.now();
            fwd.enqueueSessionForServer({
                sessionId: 'sess-types',
                startTime: now - 1000,
                url: 'https://example.com',
                events: [
                    { type: 'click', timestamp: now, data: {} },
                    { type: 'input', timestamp: now + 10, data: {} },
                    { type: 'scroll', timestamp: now + 20, data: {} },
                    { type: 'navigation', timestamp: now + 30, data: { action: 'popstate' } },
                    { type: 'error', timestamp: now + 40, data: { message: 'oops' } },
                ],
            }, 1);

            await fwd.flushTimers();

            const body = JSON.parse(fetchCalls[0].opts.body);
            const types = body.events.map(e => e.type);
            assert.deepEqual(types, ['click', 'input', 'scroll', 'navigation', 'error']);
        });

        it('should cap event data size', async () => {
            const bigData = { value: 'x'.repeat(20000) };
            fwd.enqueueSessionForServer({
                sessionId: 'sess-big',
                startTime: Date.now(),
                url: 'https://example.com',
                events: [{ type: 'input', timestamp: Date.now(), data: bigData }],
            }, 1);

            await fwd.flushTimers();

            const body = JSON.parse(fetchCalls[0].opts.body);
            const dataStr = JSON.stringify(body.events[0].data);
            assert.ok(dataStr.length <= 8200, 'event data should be capped');
        });

        it('should handle 404 on append (session gone)', async () => {
            // Create session
            fwd.enqueueSessionForServer({
                sessionId: 'sess-gone',
                startTime: Date.now(),
                url: 'https://example.com',
                events: [{ type: 'click', timestamp: Date.now(), data: {} }],
            }, 1);
            await fwd.flushTimers();

            // Append gets 404
            fetchResponses.push({
                ok: false, status: 404,
                json: async () => ({ error: 'Session not found' }),
            });
            fwd.enqueueSessionForServer({
                sessionId: 'sess-gone',
                startTime: Date.now(),
                url: 'https://example.com',
                events: [{ type: 'scroll', timestamp: Date.now(), data: {} }],
            }, 1);
            await fwd.flushTimers();

            // Session should be removed from map and added to finalized
            assert.equal(fwd._serverSessionMapSize(), 0);
            assert.equal(fwd._finalizedSize(), 1);
        });

        it('should group batches for same session on flush', async () => {
            const now = Date.now();

            // Enqueue two batches for same session before flush
            fwd.enqueueSessionForServer({
                sessionId: 'sess-group',
                startTime: now - 1000,
                url: 'https://example.com',
                events: [{ type: 'click', timestamp: now, data: {} }],
            }, 1);
            fwd.enqueueSessionForServer({
                sessionId: 'sess-group',
                startTime: now - 1000,
                url: 'https://example.com',
                events: [{ type: 'scroll', timestamp: now + 100, data: {} }],
            }, 1);

            await fwd.flushTimers();

            // Should create one session with both events combined
            assert.equal(fetchCalls.length, 1);
            const body = JSON.parse(fetchCalls[0].opts.body);
            assert.equal(body.events.length, 2);
        });

        it('should cap snapshot HTML size', async () => {
            const bigHtml = '<div>' + 'x'.repeat(60000) + '</div>';
            fwd.enqueueSessionForServer({
                sessionId: 'sess-snap-cap',
                startTime: Date.now(),
                url: 'https://example.com',
                events: [
                    { type: 'snapshot', timestamp: Date.now(), data: { trigger: 'error', html: bigHtml } },
                ],
            }, 1);

            await fwd.flushTimers();

            const body = JSON.parse(fetchCalls[0].opts.body);
            assert.ok(body.snapshots[0].html.length <= 50000, 'snapshot HTML should be capped');
        });
    });

    describe('bound agents storage listener', () => {
        it('should react to storage changes for boundAgents', async () => {
            const chrome = createChromeMock({ sync: { boundAgents: [] } });
            const fwd = loadSessionForwarder(chrome, async () => ({
                ok: true, status: 201,
                json: async () => ({ id: 'srv-1', event_count: 1 }),
            }));
            await tick();

            // Should not queue when no agents
            fwd.enqueueSessionForServer({
                sessionId: 'sess-react',
                startTime: Date.now(),
                url: 'https://x.com',
                events: [{ type: 'click', timestamp: Date.now(), data: {} }],
            }, 1);
            assert.equal(fwd._queueLength(), 0);

            // Simulate storage change — agents added
            await chrome.storage.sync.set({ boundAgents: [{ id: 'a1' }] });
            await tick();

            // Should now queue
            fwd.enqueueSessionForServer({
                sessionId: 'sess-react2',
                startTime: Date.now(),
                url: 'https://x.com',
                events: [{ type: 'click', timestamp: Date.now(), data: {} }],
            }, 1);
            assert.equal(fwd._queueLength(), 1);
        });
    });
});
