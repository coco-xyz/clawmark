/**
 * ClawMark — Action Queue Tests (#78)
 *
 * Tests cover:
 * 1. Action creation with valid types
 * 2. Invalid action type rejection
 * 3. Queue depth limit (100)
 * 4. Action status updates
 * 5. Timeout detection
 * 6. Cleanup of old actions
 * 7. Listing and filtering
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawmark-action-test-'));
    db = initDb(tmpDir);
}

function teardown() {
    if (db && db.db) db.db.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

function makeAction(overrides = {}) {
    return {
        agent_id: 'agent-1',
        app_id: 'app-1',
        type: 'click',
        payload: { selector: '#btn' },
        ...overrides,
    };
}

// ================================================================= creation

describe('Action Queue — createAction', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('should create a navigate action', () => {
        const action = db.createAction(makeAction({ type: 'navigate', payload: { url: 'https://example.com' } }));
        assert.ok(action.id.startsWith('act-'));
        assert.equal(action.type, 'navigate');
        assert.equal(action.status, 'queued');
    });

    it('should create a click action', () => {
        const action = db.createAction(makeAction({ type: 'click' }));
        assert.equal(action.type, 'click');
    });

    it('should create an extract action', () => {
        const action = db.createAction(makeAction({ type: 'extract', payload: { selector: '.content' } }));
        assert.equal(action.type, 'extract');
    });

    it('should reject invalid action type', () => {
        assert.throws(() => {
            db.createAction(makeAction({ type: 'delete' }));
        }, /INVALID_ACTION_TYPE/);
    });

    it('should use default timeout of 30000ms', () => {
        const action = db.createAction(makeAction());
        const stored = db.getAction(action.id);
        assert.equal(stored.timeout_ms, 30000);
    });

    it('should accept custom timeout', () => {
        const action = db.createAction(makeAction({ timeout_ms: 60000 }));
        const stored = db.getAction(action.id);
        assert.equal(stored.timeout_ms, 60000);
    });

    it('should store payload as JSON', () => {
        const action = db.createAction(makeAction({ payload: { x: 1, y: 2 } }));
        const stored = db.getAction(action.id);
        assert.equal(stored.payload, '{"x":1,"y":2}');
    });
});

// ================================================================= queue limit

describe('Action Queue — queue depth limit', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('should enforce 100 pending action limit per agent', () => {
        for (let i = 0; i < 100; i++) {
            db.createAction(makeAction());
        }

        assert.throws(() => {
            db.createAction(makeAction());
        }, /QUEUE_FULL/);
    });

    it('should allow more actions after some complete', () => {
        const actions = [];
        for (let i = 0; i < 100; i++) {
            actions.push(db.createAction(makeAction()));
        }

        // Complete one
        db.updateActionStatus(actions[0].id, { status: 'completed', result: { ok: true } });

        // Should now allow one more
        const action = db.createAction(makeAction());
        assert.ok(action.id);
    });

    it('should count per agent, not globally', () => {
        for (let i = 0; i < 100; i++) {
            db.createAction(makeAction({ agent_id: 'agent-1' }));
        }

        // Different agent should still be able to create
        const action = db.createAction(makeAction({ agent_id: 'agent-2' }));
        assert.ok(action.id);
    });
});

// ================================================================= status updates

describe('Action Queue — updateActionStatus', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('should update to dispatched', () => {
        const action = db.createAction(makeAction());
        const updated = db.updateActionStatus(action.id, { status: 'dispatched' });
        assert.equal(updated.status, 'dispatched');

        const stored = db.getAction(action.id);
        assert.equal(stored.status, 'dispatched');
        assert.ok(stored.dispatched_at);
    });

    it('should update to completed with result', () => {
        const action = db.createAction(makeAction());
        db.updateActionStatus(action.id, { status: 'dispatched' });
        db.updateActionStatus(action.id, { status: 'completed', result: { text: 'hello' } });

        const stored = db.getAction(action.id);
        assert.equal(stored.status, 'completed');
        assert.ok(stored.completed_at);
        assert.equal(stored.result, '{"text":"hello"}');
    });

    it('should update to failed with error', () => {
        const action = db.createAction(makeAction());
        db.updateActionStatus(action.id, { status: 'failed', error: 'Element not found' });

        const stored = db.getAction(action.id);
        assert.equal(stored.status, 'failed');
        assert.equal(stored.error, 'Element not found');
    });

    it('should return null for non-existent action', () => {
        const result = db.updateActionStatus('act-nonexistent', { status: 'completed' });
        assert.equal(result, null);
    });
});

// ================================================================= listing

describe('Action Queue — listing', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('should list pending actions by app', () => {
        db.createAction(makeAction({ app_id: 'app-1' }));
        db.createAction(makeAction({ app_id: 'app-1' }));
        db.createAction(makeAction({ app_id: 'app-2' }));

        const actions = db.listPendingActions('app-1');
        assert.equal(actions.length, 2);
    });

    it('should list actions by agent and status', () => {
        const a1 = db.createAction(makeAction());
        db.createAction(makeAction());
        db.updateActionStatus(a1.id, { status: 'completed', result: {} });

        const queued = db.listAgentActions('agent-1', 'queued');
        assert.equal(queued.length, 1);

        const completed = db.listAgentActions('agent-1', 'completed');
        assert.equal(completed.length, 1);
    });

    it('should return actions in FIFO order', () => {
        const a1 = db.createAction(makeAction({ type: 'navigate' }));
        const a2 = db.createAction(makeAction({ type: 'click' }));

        const actions = db.listPendingActions('app-1');
        assert.equal(actions[0].id, a1.id);
        assert.equal(actions[1].id, a2.id);
    });
});

// ================================================================= timeout

describe('Action Queue — timeout detection', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('should detect timed-out actions', () => {
        const action = db.createAction(makeAction({ timeout_ms: 1 })); // 1ms timeout
        db.updateActionStatus(action.id, { status: 'dispatched' });

        // Backdate dispatched_at to ensure timeout
        db.db.prepare('UPDATE action_queue SET dispatched_at = ? WHERE id = ?')
            .run('2026-01-01T00:00:00.000Z', action.id);

        const timedOut = db.getTimedOutActions();
        assert.ok(timedOut.length >= 1);
        assert.equal(timedOut[0].id, action.id);
    });

    it('should not flag non-dispatched actions as timed out', () => {
        db.createAction(makeAction({ timeout_ms: 1 })); // queued, not dispatched

        const timedOut = db.getTimedOutActions();
        assert.equal(timedOut.length, 0);
    });
});

// ================================================================= cleanup

describe('Action Queue — cleanup', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('should delete old completed actions', () => {
        const action = db.createAction(makeAction());
        db.updateActionStatus(action.id, { status: 'completed', result: {} });

        // Backdate
        db.db.prepare('UPDATE action_queue SET updated_at = ? WHERE id = ?')
            .run('2026-01-01T00:00:00.000Z', action.id);

        const result = db.cleanupOldActions(7);
        assert.ok(result.deleted >= 1);

        assert.equal(db.getAction(action.id), null);
    });

    it('should not delete pending actions', () => {
        const action = db.createAction(makeAction());

        // Backdate
        db.db.prepare('UPDATE action_queue SET updated_at = ? WHERE id = ?')
            .run('2026-01-01T00:00:00.000Z', action.id);

        const result = db.cleanupOldActions(7);
        assert.equal(result.deleted, 0);

        assert.ok(db.getAction(action.id));
    });
});
