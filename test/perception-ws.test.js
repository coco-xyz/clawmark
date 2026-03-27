/**
 * ClawMark — Perception WebSocket Tests (#109 — Phase 4)
 *
 * Tests cover: authentication, binding validation, perception push,
 * annotation push, scope filtering, heartbeat, scope change notification,
 * binding close on suspend/revoke, and connection stats.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocket } = require('ws');
const { initDb } = require('../server/db');
const { initPerceptionWs } = require('../server/ws-perception');
const { hashKey, generateAgentKey } = require('../server/agent-auth');

// ------------------------------------------------------------------ helpers

let server, port, perceptionWs, db, tmpDir;

const APP_ID = 'app-pw-test';
let AGENT_KEY, AGENT_ID, BINDING_ID;

function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawmark-pw-test-'));
    db = initDb(tmpDir);

    // Create app
    const app1 = db.createApp({ user_id: 'user-1', name: 'PW Test App' });
    db.db.prepare('UPDATE apps SET id = ? WHERE id = ?').run(APP_ID, app1.id);
    db.db.prepare('UPDATE api_keys SET app_id = ? WHERE app_id = ?').run(APP_ID, app1.id);

    // Register agent
    const { raw, hash, prefix } = generateAgentKey();
    AGENT_KEY = raw;
    db.registerAgent({
        app_id: APP_ID, name: 'Test Agent',
        key_hash: hash, key_prefix: prefix,
        capabilities: ['perception'], created_by: 'user-1',
    });
    const agent = db.getAgentByKeyHash(hash);
    AGENT_ID = agent.id;

    // Create binding (simulate token flow — directly create active binding)
    const bindingId = 'bind-' + crypto.randomBytes(8).toString('hex');
    const tokenHash = hashKey('cmbt_fake_' + crypto.randomBytes(16).toString('hex'));
    db.createBinding({
        app_id: APP_ID,
        scopes: ['perception', 'annotation', 'action'],
        label: 'test binding',
        token_hash: tokenHash,
        token_expires: new Date(Date.now() + 86400000).toISOString(),
        created_by: 'user-1',
    });
    // Get the binding and activate it
    const bindings = db.getBindingsByApp(APP_ID);
    const binding = bindings[0];
    db.activateBinding(binding.id, {
        agent_id: AGENT_ID,
        agent_name: 'Test Agent',
        agent_type: 'zylos',
        agent_node_url: null,
    });
    BINDING_ID = binding.id;

    server = http.createServer();
    perceptionWs = initPerceptionWs(server, db);
}

async function startServer() {
    await new Promise(r => server.listen(0, r));
    port = server.address().port;
}

async function teardown() {
    if (perceptionWs?.wss) {
        for (const client of perceptionWs.wss.clients) {
            client.terminate();
        }
        perceptionWs.wss.close();
    }
    if (server?.listening) await new Promise(r => server.close(r));
    if (db?.db) db.db.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

function connectAgent(key, bindingId, opts = {}) {
    const url = `ws://127.0.0.1:${port}/ws/agent?key=${encodeURIComponent(key || AGENT_KEY)}&binding=${encodeURIComponent(bindingId || BINDING_ID)}`;
    return new WebSocket(url, opts);
}

function waitForMessage(ws, filter, timeout = 3000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for message')), timeout);
        ws.on('message', function handler(raw) {
            const msg = JSON.parse(raw.toString());
            if (!filter || filter(msg)) {
                clearTimeout(timer);
                ws.removeListener('message', handler);
                resolve(msg);
            }
        });
    });
}

function waitForOpen(ws, timeout = 3000) {
    return new Promise((resolve, reject) => {
        if (ws.readyState === WebSocket.OPEN) return resolve();
        const timer = setTimeout(() => reject(new Error('Timed out waiting for open')), timeout);
        ws.on('open', () => { clearTimeout(timer); resolve(); });
        ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
}

function waitForClose(ws, timeout = 3000) {
    return new Promise((resolve, reject) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        const timer = setTimeout(() => reject(new Error('Timed out waiting for close')), timeout);
        ws.on('close', () => { clearTimeout(timer); resolve(); });
        ws.on('error', () => { /* error precedes close for rejected upgrades */ });
    });
}

// ------------------------------------------------------------------ tests

describe('Perception WebSocket (#109)', () => {

    beforeEach(async () => {
        setup();
        await startServer();
    });

    afterEach(async () => {
        await teardown();
    });

    it('connects with valid agent key and binding', async () => {
        const ws = connectAgent();
        const msg = await waitForMessage(ws, m => m.type === 'connected');
        assert.equal(msg.type, 'connected');
        assert.equal(msg.binding_id, BINDING_ID);
        assert.ok(Array.isArray(msg.scopes));
        ws.close();
    });

    it('rejects connection without key', async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent?binding=${BINDING_ID}`);
        await waitForClose(ws);
        assert.equal(ws.readyState, WebSocket.CLOSED);
    });

    it('rejects connection without binding', async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent?key=${AGENT_KEY}`);
        await waitForClose(ws);
        assert.equal(ws.readyState, WebSocket.CLOSED);
    });

    it('rejects invalid agent key', async () => {
        const ws = connectAgent('cmak_invalid_key_1234567890');
        await waitForClose(ws);
        assert.equal(ws.readyState, WebSocket.CLOSED);
    });

    it('rejects non-cmak key', async () => {
        const ws = connectAgent('cmk_not_agent_key');
        await waitForClose(ws);
        assert.equal(ws.readyState, WebSocket.CLOSED);
    });

    it('rejects binding belonging to different agent', async () => {
        // Create another agent
        const { raw: key2, hash: hash2, prefix: prefix2 } = generateAgentKey();
        db.registerAgent({
            app_id: APP_ID, name: 'Other Agent',
            key_hash: hash2, key_prefix: prefix2,
            capabilities: [], created_by: 'user-1',
        });
        // Try connecting with other agent's key but original binding
        const ws = connectAgent(key2, BINDING_ID);
        await waitForClose(ws);
        assert.equal(ws.readyState, WebSocket.CLOSED);
    });

    it('rejects suspended binding', async () => {
        db.updateBindingStatus(BINDING_ID, 'suspended');
        const ws = connectAgent();
        await waitForClose(ws);
        assert.equal(ws.readyState, WebSocket.CLOSED);
    });

    it('pushes perception events to connected agent', async () => {
        const ws = connectAgent();
        await waitForMessage(ws, m => m.type === 'connected');

        const msgPromise = waitForMessage(ws, m => m.type === 'perception');
        perceptionWs.pushPerceptionEvents(APP_ID, [{
            type: 'error',
            message: 'Test error',
            severity: 'P1',
            url: 'https://example.com',
            fingerprint: 'fp-123',
        }]);

        const msg = await msgPromise;
        assert.equal(msg.type, 'perception');
        assert.equal(msg.binding_id, BINDING_ID);
        assert.equal(msg.payload.message, 'Test error');
        ws.close();
    });

    it('pushes annotations to connected agent', async () => {
        const ws = connectAgent();
        await waitForMessage(ws, m => m.type === 'connected');

        const msgPromise = waitForMessage(ws, m => m.type === 'annotation');
        perceptionWs.pushAnnotation(APP_ID, {
            text: 'Selected text',
            url: 'https://example.com/page',
            user: 'test-user',
        });

        const msg = await msgPromise;
        assert.equal(msg.type, 'annotation');
        assert.equal(msg.payload.text, 'Selected text');
        ws.close();
    });

    it('filters by perception scope', async () => {
        // Create a binding with no perception scope
        const tokenHash2 = hashKey('cmbt_fake2_' + crypto.randomBytes(16).toString('hex'));
        db.createBinding({
            app_id: APP_ID,
            scopes: ['action'],  // no perception
            label: 'no-perception',
            token_hash: tokenHash2,
            token_expires: new Date(Date.now() + 86400000).toISOString(),
            created_by: 'user-1',
        });
        const bindings = db.getBindingsByApp(APP_ID);
        const newBinding = bindings.find(b => b.id !== BINDING_ID && b.status === 'pending');

        // Create a second agent for this binding
        const { raw: key2, hash: hash2, prefix: prefix2 } = generateAgentKey();
        db.registerAgent({
            app_id: APP_ID, name: 'No-Perception Agent',
            key_hash: hash2, key_prefix: prefix2,
            capabilities: [], created_by: 'user-1',
        });
        const agent2 = db.getAgentByKeyHash(hash2);
        db.activateBinding(newBinding.id, {
            agent_id: agent2.id,
            agent_name: 'No-Perception Agent',
            agent_type: 'zylos',
        });

        // Connect with second agent
        const ws2 = connectAgent(key2, newBinding.id);
        await waitForMessage(ws2, m => m.type === 'connected');

        // Push perception — should NOT arrive on ws2
        const received = [];
        ws2.on('message', raw => {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'perception') received.push(msg);
        });

        perceptionWs.pushPerceptionEvents(APP_ID, [{ message: 'test', fingerprint: 'fp' }]);

        // Wait briefly then check
        await new Promise(r => setTimeout(r, 200));
        assert.equal(received.length, 0, 'Agent without perception scope should not receive events');
        ws2.close();
    });

    it('handles heartbeat', async () => {
        const ws = connectAgent();
        await waitForMessage(ws, m => m.type === 'connected');

        ws.send(JSON.stringify({
            type: 'heartbeat',
            binding_id: BINDING_ID,
            payload: { status: 'healthy', version: '0.1.0' },
        }));

        const msg = await waitForMessage(ws, m => m.type === 'heartbeat_ack');
        assert.equal(msg.type, 'heartbeat_ack');
        ws.close();
    });

    it('notifies scope change', async () => {
        const ws = connectAgent();
        await waitForMessage(ws, m => m.type === 'connected');

        const msgPromise = waitForMessage(ws, m => m.type === 'scope_changed');
        perceptionWs.pushScopeChanged(BINDING_ID, ['perception', 'session']);

        const msg = await msgPromise;
        assert.equal(msg.type, 'scope_changed');
        assert.deepEqual(msg.scopes, ['perception', 'session']);
        ws.close();
    });

    it('closes connection on binding close', async () => {
        const ws = connectAgent();
        await waitForMessage(ws, m => m.type === 'connected');

        const closePromise = waitForClose(ws);
        perceptionWs.closeBinding(BINDING_ID);
        await closePromise;
        assert.equal(ws.readyState, WebSocket.CLOSED);
    });

    it('marks DB connected/disconnected', async () => {
        const ws = connectAgent();
        await waitForMessage(ws, m => m.type === 'connected');

        // Check DB connected flag
        const b1 = db.getBindingById(BINDING_ID);
        assert.equal(b1.connected, 1);

        ws.close();
        await waitForClose(ws);
        // Small delay for close handler
        await new Promise(r => setTimeout(r, 100));

        const b2 = db.getBindingById(BINDING_ID);
        assert.equal(b2.connected, 0);
    });

    it('reports stats correctly', async () => {
        const stats0 = perceptionWs.getStats();
        assert.equal(stats0.connections, 0);

        const ws = connectAgent();
        await waitForMessage(ws, m => m.type === 'connected');

        const stats1 = perceptionWs.getStats();
        assert.equal(stats1.connections, 1);
        assert.equal(stats1.bindings, 1);
        assert.equal(stats1.apps, 1);

        ws.close();
        await waitForClose(ws);
        await new Promise(r => setTimeout(r, 100));

        const stats2 = perceptionWs.getStats();
        assert.equal(stats2.connections, 0);
    });

    it('pushes session updates to agents with session scope', async () => {
        // Add session scope to binding
        db.updateBindingScopes(BINDING_ID, ['perception', 'session']);

        const ws = connectAgent();
        await waitForMessage(ws, m => m.type === 'connected');
        // Reconnect to pick up new scopes
        ws.close();
        await waitForClose(ws);
        await new Promise(r => setTimeout(r, 100));

        const ws2 = connectAgent();
        await waitForMessage(ws2, m => m.type === 'connected');

        const msgPromise = waitForMessage(ws2, m => m.type === 'session');
        const pushed = perceptionWs.pushSessionUpdate(APP_ID, {
            action: 'start',
            session_id: 'sess-test-123',
            url: 'https://example.com',
            event_count: 5,
        });

        const msg = await msgPromise;
        assert.equal(msg.type, 'session');
        assert.equal(msg.binding_id, BINDING_ID);
        assert.equal(msg.payload.action, 'start');
        assert.equal(msg.payload.session_id, 'sess-test-123');
        assert.ok(pushed > 0, 'should push to at least one agent');
        ws2.close();
    });

    it('does not push session updates to agents without session scope', async () => {
        // Ensure only perception scope
        db.updateBindingScopes(BINDING_ID, ['perception']);

        const ws = connectAgent();
        await waitForMessage(ws, m => m.type === 'connected');
        ws.close();
        await waitForClose(ws);
        await new Promise(r => setTimeout(r, 100));

        const ws2 = connectAgent();
        await waitForMessage(ws2, m => m.type === 'connected');

        const pushed = perceptionWs.pushSessionUpdate(APP_ID, {
            action: 'start',
            session_id: 'sess-no-scope',
        });
        assert.equal(pushed, 0, 'should not push to agents without session scope');
        ws2.close();
    });

    it('rejects action without action scope', async () => {
        // Modify binding to have only perception scope
        db.updateBindingScopes(BINDING_ID, ['perception']);

        const ws = connectAgent();
        const connected = await waitForMessage(ws, m => m.type === 'connected');
        // Re-connect since scopes are read at connection time — close and create new binding
        ws.close();
        await waitForClose(ws);
        await new Promise(r => setTimeout(r, 100));

        // Reconnect (scopes updated in DB, will be read fresh)
        const ws2 = connectAgent();
        await waitForMessage(ws2, m => m.type === 'connected');

        ws2.send(JSON.stringify({
            type: 'action',
            payload: { action_type: 'click', target: '#btn' },
        }));

        const msg = await waitForMessage(ws2, m => m.type === 'error');
        assert.ok(msg.error.includes('scope'));
        ws2.close();
    });
});
