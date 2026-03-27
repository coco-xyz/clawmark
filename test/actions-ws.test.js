/**
 * ClawMark — Action WebSocket Tests (#78)
 *
 * Tests cover: authentication, action submission, result delivery,
 * cross-app isolation, and heartbeat handling.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocket } = require('ws');
const { initDb } = require('../server/db');
const { initActionWs } = require('../server/ws-actions');
const { hashKey } = require('../server/agent-auth');

// ------------------------------------------------------------------ helpers

let server, port, actionWs, db, tmpDir;

const APP_ID = 'app-ws-test';
const APP_ID_OTHER = 'app-ws-other';
let AGENT_KEY, AGENT_KEY_2, EXT_KEY, EXT_KEY_OTHER;

// Track onResult callbacks for cross-WS integration tests
let lastOnResult = null;

function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawmark-ws-test-'));
    db = initDb(tmpDir);

    // Create apps via createApp (requires user_id)
    const app1 = db.createApp({ user_id: 'user-1', name: 'WS Test App' });
    db.db.prepare('UPDATE apps SET id = ? WHERE id = ?').run(APP_ID, app1.id);
    // Update the auto-generated api_key's app_id too
    db.db.prepare('UPDATE api_keys SET app_id = ? WHERE app_id = ?').run(APP_ID, app1.id);
    EXT_KEY = app1.key; // auto-generated cmk_ key

    const app2 = db.createApp({ user_id: 'user-2', name: 'Other App' });
    db.db.prepare('UPDATE apps SET id = ? WHERE id = ?').run(APP_ID_OTHER, app2.id);
    db.db.prepare('UPDATE api_keys SET app_id = ? WHERE app_id = ?').run(APP_ID_OTHER, app2.id);
    EXT_KEY_OTHER = app2.key;

    // Register agents (cmak_ keys are hashed in the agents table)
    const rawKey1 = 'cmak_' + require('crypto').randomBytes(24).toString('hex');
    const rawKey2 = 'cmak_' + require('crypto').randomBytes(24).toString('hex');
    AGENT_KEY = rawKey1;
    AGENT_KEY_2 = rawKey2;

    db.registerAgent({
        app_id: APP_ID, name: 'Agent 1',
        key_hash: hashKey(rawKey1), key_prefix: rawKey1.slice(0, 8),
        capabilities: ['actions'], created_by: 'user-1',
    });
    db.registerAgent({
        app_id: APP_ID, name: 'Agent 2',
        key_hash: hashKey(rawKey2), key_prefix: rawKey2.slice(0, 8),
        capabilities: ['actions'], created_by: 'user-1',
    });

    lastOnResult = null;
    server = http.createServer();
    actionWs = initActionWs(server, db, {
        onResult: (agentId, appId, data) => { lastOnResult = { agentId, appId, data }; },
    });
}

async function startServer() {
    await new Promise(r => server.listen(0, r));
    port = server.address().port;
}

async function teardown() {
    // Close all WS clients first
    if (actionWs?.wss) {
        for (const client of actionWs.wss.clients) {
            client.terminate();
        }
        actionWs.wss.close();
    }
    if (server?.listening) await new Promise(r => server.close(r));
    if (db?.db) db.db.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

function connect(key) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${port}/ws/agent-channel/actions`, {
            headers: { 'x-agent-key': key },
        });
        // Buffer messages from the start so we don't miss early ones
        ws._msgQueue = [];
        ws._msgWaiters = [];
        ws.on('message', (raw) => {
            const msg = JSON.parse(raw.toString());
            const waiter = ws._msgWaiters.find(w => !w.filter || w.filter(msg));
            if (waiter) {
                ws._msgWaiters.splice(ws._msgWaiters.indexOf(waiter), 1);
                clearTimeout(waiter.timer);
                waiter.resolve(msg);
            } else {
                ws._msgQueue.push(msg);
            }
        });
        ws.on('open', () => resolve(ws));
        ws.on('error', reject);
    });
}

function waitMsg(ws, filter, timeout = 2000) {
    // Check buffered messages first
    const idx = ws._msgQueue.findIndex(m => !filter || filter(m));
    if (idx !== -1) {
        return Promise.resolve(ws._msgQueue.splice(idx, 1)[0]);
    }
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const i = ws._msgWaiters.findIndex(w => w.resolve === resolve);
            if (i !== -1) ws._msgWaiters.splice(i, 1);
            reject(new Error('waitMsg timeout'));
        }, timeout);
        ws._msgWaiters.push({ filter, resolve, timer });
    });
}

function send(ws, data) {
    ws.send(JSON.stringify(data));
}

// ================================================================= auth

describe('Action WS — authentication', () => {
    beforeEach(async () => { setup(); await startServer(); });
    afterEach(teardown);

    it('should reject connection without key', async () => {
        await assert.rejects(async () => {
            await new Promise((resolve, reject) => {
                const ws = new WebSocket(`ws://localhost:${port}/ws/agent-channel/actions`);
                ws.on('open', () => { ws.close(); resolve(); });
                ws.on('error', reject);
            });
        });
    });

    it('should reject connection with invalid agent key', async () => {
        await assert.rejects(async () => {
            await connect('cmak_invalid-key-000000000000000000000000');
        });
    });

    it('should reject connection with unknown prefix', async () => {
        await assert.rejects(async () => {
            await connect('xxx_bad-prefix');
        });
    });

    it('should accept agent connection with valid cmak_ key', async () => {
        const ws = await connect(AGENT_KEY);
        const msg = await waitMsg(ws, m => m.type === 'connected');
        assert.equal(msg.role, 'agent');
        assert.equal(msg.app_id, APP_ID);
        ws.close();
    });

    it('should accept extension connection with valid cmk_ key', async () => {
        const ws = await connect(EXT_KEY);
        const msg = await waitMsg(ws, m => m.type === 'connected');
        assert.equal(msg.role, 'extension');
        assert.equal(msg.app_id, APP_ID);
        ws.close();
    });
});

// ================================================================= action submit

describe('Action WS — action submission', () => {
    beforeEach(async () => { setup(); await startServer(); });
    afterEach(teardown);

    it('should queue a valid action from agent', async () => {
        const agentWs = await connect(AGENT_KEY);
        await waitMsg(agentWs, m => m.type === 'connected');

        send(agentWs, { type: 'action', action_type: 'navigate', payload: { url: 'https://example.com' } });
        const msg = await waitMsg(agentWs, m => m.type === 'action_queued');
        assert.equal(msg.status, 'queued');
        assert.ok(msg.action_id.startsWith('act-'));
        agentWs.close();
    });

    it('should reject invalid action_type', async () => {
        const agentWs = await connect(AGENT_KEY);
        await waitMsg(agentWs, m => m.type === 'connected');

        send(agentWs, { type: 'action', action_type: 'delete' });
        const msg = await waitMsg(agentWs, m => m.type === 'error');
        assert.ok(msg.error.includes('Invalid action_type'));
        agentWs.close();
    });

    it('should dispatch action to connected extension immediately', async () => {
        const extWs = await connect(EXT_KEY);
        await waitMsg(extWs, m => m.type === 'connected');

        const agentWs = await connect(AGENT_KEY);
        await waitMsg(agentWs, m => m.type === 'connected');

        send(agentWs, { type: 'action', action_type: 'click', payload: { selector: '#btn' } });
        await waitMsg(agentWs, m => m.type === 'action_queued');

        const extMsg = await waitMsg(extWs, m => m.type === 'action');
        assert.equal(extMsg.action_type, 'click');
        assert.deepEqual(extMsg.payload, { selector: '#btn' });
        assert.ok(extMsg.action_id);

        agentWs.close();
        extWs.close();
    });
});

// ================================================================= result delivery

describe('Action WS — result delivery', () => {
    beforeEach(async () => { setup(); await startServer(); });
    afterEach(teardown);

    it('should deliver result from extension to agent', async () => {
        const extWs = await connect(EXT_KEY);
        await waitMsg(extWs, m => m.type === 'connected');

        const agentWs = await connect(AGENT_KEY);
        await waitMsg(agentWs, m => m.type === 'connected');

        send(agentWs, { type: 'action', action_type: 'screenshot', payload: {} });
        const queued = await waitMsg(agentWs, m => m.type === 'action_queued');
        await waitMsg(extWs, m => m.type === 'action');

        send(extWs, { type: 'result', action_id: queued.action_id, result: { screenshot: 'base64...' } });

        const result = await waitMsg(agentWs, m => m.type === 'result');
        assert.equal(result.action_id, queued.action_id);
        assert.equal(result.status, 'completed');
        assert.deepEqual(result.result, { screenshot: 'base64...' });

        agentWs.close();
        extWs.close();
    });

    it('should deliver error result from extension to agent', async () => {
        const extWs = await connect(EXT_KEY);
        await waitMsg(extWs, m => m.type === 'connected');

        const agentWs = await connect(AGENT_KEY);
        await waitMsg(agentWs, m => m.type === 'connected');

        send(agentWs, { type: 'action', action_type: 'click', payload: { selector: '#missing' } });
        const queued = await waitMsg(agentWs, m => m.type === 'action_queued');
        await waitMsg(extWs, m => m.type === 'action');

        send(extWs, { type: 'result', action_id: queued.action_id, error: 'Element not found' });

        const result = await waitMsg(agentWs, m => m.type === 'result');
        assert.equal(result.status, 'failed');
        assert.equal(result.error, 'Element not found');

        agentWs.close();
        extWs.close();
    });

    it('should only deliver result to the agent that created the action', async () => {
        const extWs = await connect(EXT_KEY);
        await waitMsg(extWs, m => m.type === 'connected');

        const agent1 = await connect(AGENT_KEY);
        await waitMsg(agent1, m => m.type === 'connected');
        const agent2 = await connect(AGENT_KEY_2);
        await waitMsg(agent2, m => m.type === 'connected');

        // Agent 1 sends action
        send(agent1, { type: 'action', action_type: 'navigate', payload: { url: 'https://example.com' } });
        const queued = await waitMsg(agent1, m => m.type === 'action_queued');
        await waitMsg(extWs, m => m.type === 'action');

        // Extension sends result
        send(extWs, { type: 'result', action_id: queued.action_id, result: { ok: true } });

        // Agent 1 should receive result
        const result = await waitMsg(agent1, m => m.type === 'result');
        assert.equal(result.action_id, queued.action_id);

        // Agent 2 should NOT receive result
        await assert.rejects(
            waitMsg(agent2, m => m.type === 'result', 500),
            /timeout/
        );

        agent1.close();
        agent2.close();
        extWs.close();
    });
});

// ================================================================= cross-app isolation

describe('Action WS — cross-app isolation', () => {
    beforeEach(async () => { setup(); await startServer(); });
    afterEach(teardown);

    it('should not dispatch actions to extensions of different app', async () => {
        const extOther = await connect(EXT_KEY_OTHER);
        await waitMsg(extOther, m => m.type === 'connected');

        const agentWs = await connect(AGENT_KEY);
        await waitMsg(agentWs, m => m.type === 'connected');

        send(agentWs, { type: 'action', action_type: 'click', payload: { selector: '#btn' } });
        await waitMsg(agentWs, m => m.type === 'action_queued');

        await assert.rejects(
            waitMsg(extOther, m => m.type === 'action', 500),
            /timeout/
        );

        agentWs.close();
        extOther.close();
    });

    it('should not allow extension to submit result for other app action', async () => {
        const extWs = await connect(EXT_KEY);
        await waitMsg(extWs, m => m.type === 'connected');

        const agentWs = await connect(AGENT_KEY);
        await waitMsg(agentWs, m => m.type === 'connected');

        send(agentWs, { type: 'action', action_type: 'navigate', payload: { url: 'https://x.com' } });
        const queued = await waitMsg(agentWs, m => m.type === 'action_queued');
        await waitMsg(extWs, m => m.type === 'action');

        const extOther = await connect(EXT_KEY_OTHER);
        await waitMsg(extOther, m => m.type === 'connected');
        send(extOther, { type: 'result', action_id: queued.action_id, result: { hacked: true } });

        await assert.rejects(
            waitMsg(agentWs, m => m.type === 'result', 500),
            /timeout/
        );

        const action = db.getAction(queued.action_id);
        assert.equal(action.status, 'dispatched');

        agentWs.close();
        extWs.close();
        extOther.close();
    });
});

// ================================================================= heartbeat

describe('Action WS — heartbeat', () => {
    beforeEach(async () => { setup(); await startServer(); });
    afterEach(teardown);

    it('should respond to pong messages', async () => {
        const agentWs = await connect(AGENT_KEY);
        await waitMsg(agentWs, m => m.type === 'connected');

        send(agentWs, { type: 'pong' });

        await new Promise(r => setTimeout(r, 100));
        assert.equal(agentWs.readyState, WebSocket.OPEN);
        agentWs.close();
    });
});

// ================================================================= queued dispatch on connect

describe('Action WS — queued dispatch on connect', () => {
    beforeEach(async () => { setup(); await startServer(); });
    afterEach(teardown);

    it('should dispatch queued actions when extension connects', async () => {
        const agentWs = await connect(AGENT_KEY);
        await waitMsg(agentWs, m => m.type === 'connected');

        send(agentWs, { type: 'action', action_type: 'screenshot', payload: {} });
        const queued = await waitMsg(agentWs, m => m.type === 'action_queued');

        const before = db.getAction(queued.action_id);
        assert.equal(before.status, 'queued');

        const extWs = await connect(EXT_KEY);
        await waitMsg(extWs, m => m.type === 'connected');

        const actionMsg = await waitMsg(extWs, m => m.type === 'action');
        assert.equal(actionMsg.action_id, queued.action_id);
        assert.equal(actionMsg.action_type, 'screenshot');

        const after = db.getAction(queued.action_id);
        assert.equal(after.status, 'dispatched');

        agentWs.close();
        extWs.close();
    });
});

// ================================================================= cross-WS result callback

describe('Action WS — cross-WS result callback (perception bridge)', () => {
    beforeEach(async () => { setup(); await startServer(); });
    afterEach(teardown);

    it('should call onResult when extension submits success result', async () => {
        const extWs = await connect(EXT_KEY);
        await waitMsg(extWs, m => m.type === 'connected');

        const agentWs = await connect(AGENT_KEY);
        await waitMsg(agentWs, m => m.type === 'connected');

        send(agentWs, { type: 'action', action_type: 'click', payload: { selector: '#x' } });
        const queued = await waitMsg(agentWs, m => m.type === 'action_queued');
        await waitMsg(extWs, m => m.type === 'action');

        send(extWs, { type: 'result', action_id: queued.action_id, result: { clicked: true } });
        await waitMsg(agentWs, m => m.type === 'result');

        assert.ok(lastOnResult, 'onResult callback should have been called');
        assert.equal(lastOnResult.appId, APP_ID);
        assert.equal(lastOnResult.data.action_id, queued.action_id);
        assert.equal(lastOnResult.data.status, 'completed');
        assert.deepEqual(lastOnResult.data.result, { clicked: true });

        agentWs.close();
        extWs.close();
    });

    it('should call onResult when extension submits error result', async () => {
        const extWs = await connect(EXT_KEY);
        await waitMsg(extWs, m => m.type === 'connected');

        const agentWs = await connect(AGENT_KEY);
        await waitMsg(agentWs, m => m.type === 'connected');

        send(agentWs, { type: 'action', action_type: 'click', payload: { selector: '#missing' } });
        const queued = await waitMsg(agentWs, m => m.type === 'action_queued');
        await waitMsg(extWs, m => m.type === 'action');

        send(extWs, { type: 'result', action_id: queued.action_id, error: 'Element not found' });
        await waitMsg(agentWs, m => m.type === 'result');

        assert.ok(lastOnResult, 'onResult callback should have been called');
        assert.equal(lastOnResult.data.status, 'failed');
        assert.equal(lastOnResult.data.error, 'Element not found');

        agentWs.close();
        extWs.close();
    });

    it('should call onResult on action timeout', async () => {
        const agentWs = await connect(AGENT_KEY);
        await waitMsg(agentWs, m => m.type === 'connected');

        // Create action with very short timeout via DB directly
        const agent = db.getAgentByKeyHash(hashKey(AGENT_KEY));
        const action = db.createAction({
            agent_id: agent.id,
            app_id: APP_ID,
            type: 'click',
            payload: { selector: '#x' },
            timeout_ms: 1, // 1ms — will time out immediately
        });
        db.updateActionStatus(action.id, { status: 'dispatched' });

        // Wait for the action to be older than timeout
        await new Promise(r => setTimeout(r, 50));
        actionWs.checkTimeouts();

        assert.ok(lastOnResult, 'onResult callback should have been called on timeout');
        assert.equal(lastOnResult.data.action_id, action.id);
        assert.equal(lastOnResult.data.status, 'failed');
        assert.equal(lastOnResult.data.error, 'Action timed out');

        agentWs.close();
    });
});
