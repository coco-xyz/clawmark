/**
 * ClawMark — Perception Forwarder Tests (#61 Phase 1)
 *
 * Tests the extension background's event batching and upload logic.
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
 * Load the forwarder module in a sandboxed context with mocked globals.
 * Returns an object with the module's functions and test helpers.
 */
function loadForwarder(chromeMock, fetchMock) {
    const code = fs.readFileSync(
        path.join(__dirname, '..', 'extension', 'background', 'perception-forwarder.js'),
        'utf-8'
    );

    // Track setTimeout calls; allow manual flushing
    const pendingTimers = [];
    const mockSetTimeout = (fn, ms) => {
        const id = pendingTimers.length + 1;
        pendingTimers.push({ fn, ms, id, active: true });
        return id;
    };
    const mockClearTimeout = (id) => {
        const t = pendingTimers.find(p => p.id === id);
        if (t) t.active = false;
    };

    // Wrap code so we can access internal state
    const wrapped = new Function(
        'chrome', 'fetch', 'ClawMarkConfig', 'setTimeout', 'clearTimeout', 'console',
        `${code}
        return {
            enqueueForServer,
            _flush,
            _hasBoundAgents: () => _hasBoundAgents,
            _setHasBoundAgents: (v) => { _hasBoundAgents = v; },
            _queueLength: () => _queue.length,
        };`
    );

    const api = wrapped(chromeMock, fetchMock, { DEFAULT_SERVER: 'http://localhost:9999' }, mockSetTimeout, mockClearTimeout, console);

    return {
        ...api,
        pendingTimers,
        // Fire all pending timers and return promises from async fns
        async flushTimers() {
            const results = [];
            for (const t of pendingTimers.splice(0)) {
                if (t.active) results.push(t.fn());
            }
            await Promise.all(results);
        },
    };
}

// Wait helper
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

// ================================================================= tests

describe('Perception Forwarder', () => {

    describe('when no bound agents', () => {
        it('should not queue events', async () => {
            const chrome = createChromeMock({ sync: { boundAgents: [] } });
            const fwd = loadForwarder(chrome, async () => ({ ok: true }));
            // Wait for async _checkBoundAgents
            await tick();

            fwd.enqueueForServer({ type: 'console', message: 'test', url: 'http://x.com', severity: 'error' }, 1);
            assert.equal(fwd._queueLength(), 0);
            assert.equal(fwd.pendingTimers.length, 0);
        });
    });

    describe('when bound agents exist', () => {
        let chrome, fetchCalls, fwd;

        beforeEach(async () => {
            fetchCalls = [];
            const fetchMock = async (url, opts) => {
                fetchCalls.push({ url, opts });
                return { ok: true, status: 200, json: async () => ({ created: 1 }) };
            };
            chrome = createChromeMock({
                sync: { boundAgents: [{ id: 'agent1', name: 'QA Bot' }] },
                local: { authToken: 'test-jwt-token' },
            });
            fwd = loadForwarder(chrome, fetchMock);
            await tick(); // let _checkBoundAgents resolve
        });

        it('should queue events and schedule flush timer', () => {
            fwd.enqueueForServer({
                channel: 'console',
                message: 'TypeError: x is not a function',
                url: 'https://example.com',
                severity: 'error',
            }, 1);
            assert.equal(fwd._queueLength(), 1);
            assert.equal(fwd.pendingTimers.length, 1);
        });

        it('should POST events to server on flush', async () => {
            fwd.enqueueForServer({
                channel: 'console',
                summary: 'TypeError',
                message: 'TypeError: x is not a function',
                url: 'https://example.com',
                severity: 'error',
            }, 1);

            await fwd.flushTimers();

            assert.equal(fetchCalls.length, 1);
            const call = fetchCalls[0];
            assert.ok(call.url.includes('/api/v2/agent-channel/perception'));
            assert.equal(call.opts.method, 'POST');

            const body = JSON.parse(call.opts.body);
            assert.ok(Array.isArray(body.events));
            assert.equal(body.events.length, 1);
            assert.ok(body.events[0].fingerprint);
            assert.equal(body.events[0]._tabId, undefined, 'internal fields should be stripped');
            assert.equal(body.events[0]._ts, undefined, 'internal fields should be stripped');
        });

        it('should batch multiple events into one request', async () => {
            for (let i = 0; i < 5; i++) {
                fwd.enqueueForServer({
                    channel: 'network',
                    message: `Error ${i}`,
                    url: 'https://example.com',
                    severity: 'error',
                }, 1);
            }

            await fwd.flushTimers();

            assert.equal(fetchCalls.length, 1);
            const body = JSON.parse(fetchCalls[0].opts.body);
            assert.equal(body.events.length, 5);
        });

        it('should map severity correctly', async () => {
            fwd.enqueueForServer({ channel: 'console', message: 'crit', url: 'http://x.com', severity: 'critical' }, 1);
            fwd.enqueueForServer({ channel: 'console', message: 'warn', url: 'http://x.com', severity: 'warning' }, 1);
            fwd.enqueueForServer({ channel: 'console', message: 'info', url: 'http://x.com', severity: 'info' }, 1);

            await fwd.flushTimers();

            const body = JSON.parse(fetchCalls[0].opts.body);
            assert.equal(body.events[0].severity, 'P0');
            assert.equal(body.events[1].severity, 'P2');
            assert.equal(body.events[2].severity, 'info');
        });

        it('should include auth header', async () => {
            fwd.enqueueForServer({ channel: 'console', message: 'test', url: 'http://x.com', severity: 'error' }, 1);
            await fwd.flushTimers();

            assert.equal(fetchCalls[0].opts.headers['Authorization'], 'Bearer test-jwt-token');
            assert.equal(fetchCalls[0].opts.headers['Content-Type'], 'application/json');
        });

        it('should generate fingerprint from channel + summary/message', async () => {
            fwd.enqueueForServer({
                channel: 'dom',
                summary: 'Element removed: #app',
                url: 'http://x.com',
                severity: 'info',
            }, 1);
            await fwd.flushTimers();

            const body = JSON.parse(fetchCalls[0].opts.body);
            assert.equal(body.events[0].fingerprint, 'dom:Element removed: #app');
        });

        it('should fall back to type when channel is absent', async () => {
            fwd.enqueueForServer({
                type: 'js-error',
                message: 'ReferenceError: x is not defined',
                url: 'http://x.com',
                severity: 'error',
            }, 1);
            await fwd.flushTimers();

            const body = JSON.parse(fetchCalls[0].opts.body);
            assert.ok(body.events[0].fingerprint.startsWith('js-error:'));
        });
    });

    describe('when auth is missing', () => {
        it('should not upload and preserve queue', async () => {
            const fetchCalls = [];
            const chrome = createChromeMock({
                sync: { boundAgents: [{ id: 'a1' }] },
                local: { authToken: '' },
            });
            const fwd = loadForwarder(chrome, async (url, opts) => {
                fetchCalls.push({ url, opts });
                return { ok: true };
            });
            await tick();

            fwd.enqueueForServer({ channel: 'console', message: 'test', url: 'http://x.com', severity: 'error' }, 1);
            await fwd.flushTimers();

            assert.equal(fetchCalls.length, 0);
            assert.equal(fwd._queueLength(), 1, 'events should remain in queue');
        });
    });

    describe('error handling', () => {
        it('should retry on server error', async () => {
            let callCount = 0;
            const chrome = createChromeMock({
                sync: { boundAgents: [{ id: 'a1' }] },
                local: { authToken: 'jwt' },
            });
            const fwd = loadForwarder(chrome, async () => {
                callCount++;
                if (callCount === 1) return { ok: false, status: 500 };
                return { ok: true, status: 200, json: async () => ({}) };
            });
            await tick();

            fwd.enqueueForServer({ channel: 'console', message: 'test', url: 'http://x.com', severity: 'error' }, 1);

            // First flush — fails
            await fwd.flushTimers();
            assert.equal(callCount, 1);
            assert.equal(fwd._queueLength(), 1, 'events put back in queue');
            assert.ok(fwd.pendingTimers.some(t => t.active), 'retry timer scheduled');

            // Retry — succeeds
            await fwd.flushTimers();
            assert.equal(callCount, 2);
            assert.equal(fwd._queueLength(), 0, 'queue drained on success');
        });

        it('should drop events on 401', async () => {
            const chrome = createChromeMock({
                sync: { boundAgents: [{ id: 'a1' }] },
                local: { authToken: 'expired' },
            });
            const fwd = loadForwarder(chrome, async () => ({ ok: false, status: 401 }));
            await tick();

            fwd.enqueueForServer({ channel: 'console', message: 'test', url: 'http://x.com', severity: 'error' }, 1);
            await fwd.flushTimers();

            assert.equal(fwd._queueLength(), 0, 'events should be dropped on auth failure');
            assert.ok(!fwd.pendingTimers.some(t => t.active), 'no retry scheduled');
        });

        it('should retry on network error', async () => {
            let callCount = 0;
            const chrome = createChromeMock({
                sync: { boundAgents: [{ id: 'a1' }] },
                local: { authToken: 'jwt' },
            });
            const fwd = loadForwarder(chrome, async () => {
                callCount++;
                if (callCount === 1) throw new Error('Network error');
                return { ok: true };
            });
            await tick();

            fwd.enqueueForServer({ channel: 'console', message: 'test', url: 'http://x.com', severity: 'error' }, 1);
            await fwd.flushTimers();
            assert.equal(fwd._queueLength(), 1, 'events preserved on network error');

            await fwd.flushTimers();
            assert.equal(callCount, 2);
        });
    });

    describe('dynamic agent binding', () => {
        it('should start forwarding when agents are bound at runtime', async () => {
            const chrome = createChromeMock({ sync: { boundAgents: [] } });
            const fwd = loadForwarder(chrome, async () => ({ ok: true }));
            await tick();

            // Not forwarding yet
            fwd.enqueueForServer({ channel: 'console', message: 'test', url: 'http://x.com', severity: 'error' }, 1);
            assert.equal(fwd._queueLength(), 0);

            // Simulate storage change (agent bound)
            await chrome.storage.sync.set({ boundAgents: [{ id: 'new-agent' }] });

            // Now forwarding works
            fwd.enqueueForServer({ channel: 'console', message: 'test2', url: 'http://x.com', severity: 'error' }, 1);
            assert.equal(fwd._queueLength(), 1);
        });

        it('should stop forwarding when all agents unbound', async () => {
            const chrome = createChromeMock({ sync: { boundAgents: [{ id: 'a1' }] } });
            const fwd = loadForwarder(chrome, async () => ({ ok: true }));
            await tick();

            // Forwarding works
            fwd.enqueueForServer({ channel: 'console', message: 'test', url: 'http://x.com', severity: 'error' }, 1);
            assert.equal(fwd._queueLength(), 1);

            // Unbind all agents
            await chrome.storage.sync.set({ boundAgents: [] });

            fwd.enqueueForServer({ channel: 'console', message: 'test2', url: 'http://x.com', severity: 'error' }, 1);
            // Queue stays at 1 (the old event), new one not added
            assert.equal(fwd._queueLength(), 1);
        });
    });
});
