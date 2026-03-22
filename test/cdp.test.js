/**
 * ClawMark — CDP Channel Tests (#83)
 *
 * Tests cover:
 * 1. CDP audit log DB CRUD
 * 2. WS authentication (agent/extension)
 * 3. Session start/stop + exclusive lock
 * 4. Command relay (agent -> extension -> result)
 * 5. CDP event subscription filtering
 * 6. Rate limiting (30 cmd/s)
 * 7. Idle timeout
 * 8. Cross-app isolation
 * 9. Cleanup of old audit logs
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
const { initCdpWs } = require('../server/ws-cdp');
const { hashKey } = require('../server/agent-auth');

// ------------------------------------------------------------------ helpers

let server, port, cdpWs, db, tmpDir;

const APP_ID = 'app-cdp-test';
const APP_ID_OTHER = 'app-cdp-other';
let AGENT_KEY, AGENT_KEY_2, EXT_KEY, EXT_KEY_OTHER;
let AGENT_ID, AGENT_ID_2;

function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawmark-cdp-test-'));
    db = initDb(tmpDir);

    const app1 = db.createApp({ user_id: 'user-1', name: 'CDP Test App' });
    db.db.prepare('UPDATE apps SET id = ? WHERE id = ?').run(APP_ID, app1.id);
    db.db.prepare('UPDATE api_keys SET app_id = ? WHERE app_id = ?').run(APP_ID, app1.id);
    EXT_KEY = app1.key;

    const app2 = db.createApp({ user_id: 'user-2', name: 'Other App' });
    db.db.prepare('UPDATE apps SET id = ? WHERE id = ?').run(APP_ID_OTHER, app2.id);
    db.db.prepare('UPDATE api_keys SET app_id = ? WHERE app_id = ?').run(APP_ID_OTHER, app2.id);
    EXT_KEY_OTHER = app2.key;

    const rawKey1 = 'cmak_' + crypto.randomBytes(24).toString('hex');
    const rawKey2 = 'cmak_' + crypto.randomBytes(24).toString('hex');
    AGENT_KEY = rawKey1;
    AGENT_KEY_2 = rawKey2;

    const agent1 = db.registerAgent({
        app_id: APP_ID, name: 'CDP Agent 1',
        key_hash: hashKey(rawKey1), key_prefix: rawKey1.slice(0, 8),
        capabilities: ['cdp'], created_by: 'user-1',
    });
    AGENT_ID = agent1.id;

    const agent2 = db.registerAgent({
        app_id: APP_ID, name: 'CDP Agent 2',
        key_hash: hashKey(rawKey2), key_prefix: rawKey2.slice(0, 8),
        capabilities: ['cdp'], created_by: 'user-1',
    });
    AGENT_ID_2 = agent2.id;

    server = http.createServer();
    cdpWs = initCdpWs(server, db);
}

async function startServer() {
    await new Promise(r => server.listen(0, r));
    port = server.address().port;
}

async function teardown() {
    if (cdpWs?.wss) {
        for (const client of cdpWs.wss.clients) {
            client.terminate();
        }
        cdpWs.wss.close();
    }
    if (server?.listening) await new Promise(r => server.close(r));
    if (db?.db) db.db.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

function connect(key) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${port}/ws/agent-channel/cdp`, {
            headers: { 'x-agent-key': key },
        });
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

// ================================================================= DB tests

describe('CDP Audit Log — DB', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('should create an audit log entry', () => {
        const log = db.createCdpAuditLog({
            app_id: APP_ID, agent_id: AGENT_ID, session_key: 'cdp-test-1',
            tab_id: 42, method: 'Runtime.evaluate', params_hash: 'abc123',
        });
        assert.ok(log.id.startsWith('cdp-'));
        assert.ok(log.created_at);
    });

    it('should update audit log with result', () => {
        const log = db.createCdpAuditLog({
            app_id: APP_ID, agent_id: AGENT_ID, session_key: 'cdp-test-2',
            tab_id: 42, method: 'DOM.getDocument',
        });
        db.updateCdpAuditLog(log.id, {
            status: 'success', result_summary: '{"nodeId":1}', duration_ms: 15,
        });
        const logs = db.getCdpAuditBySession('cdp-test-2');
        assert.equal(logs.length, 1);
        assert.equal(logs[0].status, 'success');
        assert.equal(logs[0].duration_ms, 15);
    });

    it('should query by agent', () => {
        db.createCdpAuditLog({ app_id: APP_ID, agent_id: AGENT_ID, session_key: 's1', tab_id: 1, method: 'Page.navigate' });
        db.createCdpAuditLog({ app_id: APP_ID, agent_id: AGENT_ID_2, session_key: 's2', tab_id: 2, method: 'Page.navigate' });
        const logs = db.getCdpAuditByAgent(AGENT_ID);
        assert.equal(logs.length, 1);
    });

    it('should query by app', () => {
        db.createCdpAuditLog({ app_id: APP_ID, agent_id: AGENT_ID, session_key: 's1', tab_id: 1, method: 'Page.navigate' });
        db.createCdpAuditLog({ app_id: APP_ID, agent_id: AGENT_ID_2, session_key: 's2', tab_id: 2, method: 'Runtime.evaluate' });
        const logs = db.getCdpAuditByApp(APP_ID);
        assert.equal(logs.length, 2);
    });

    it('should cleanup old audit logs', () => {
        const log = db.createCdpAuditLog({ app_id: APP_ID, agent_id: AGENT_ID, session_key: 's1', tab_id: 1, method: 'Page.navigate' });
        // Backdate the log
        db.db.prepare('UPDATE cdp_audit_log SET created_at = ? WHERE id = ?').run(
            new Date(Date.now() - 10 * 86400000).toISOString(), log.id
        );
        const result = db.cleanupOldCdpAuditLogs(7);
        assert.equal(result.deleted, 1);
        const remaining = db.getCdpAuditByApp(APP_ID);
        assert.equal(remaining.length, 0);
    });
});

// ================================================================= WS auth

describe('CDP WS — authentication', () => {
    beforeEach(async () => { setup(); await startServer(); });
    afterEach(teardown);

    it('should reject connection without key', async () => {
        await assert.rejects(async () => {
            await new Promise((resolve, reject) => {
                const ws = new WebSocket(`ws://localhost:${port}/ws/agent-channel/cdp`);
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

    it('should accept agent connection with valid key', async () => {
        const ws = await connect(AGENT_KEY);
        const msg = await waitMsg(ws, m => m.type === 'connected');
        assert.equal(msg.role, 'agent');
        assert.equal(msg.app_id, APP_ID);
        ws.close();
    });

    it('should accept extension connection with valid key', async () => {
        const ws = await connect(EXT_KEY);
        const msg = await waitMsg(ws, m => m.type === 'connected');
        assert.equal(msg.role, 'extension');
        ws.close();
    });
});

// ================================================================= session lifecycle

describe('CDP WS — session lifecycle', () => {
    beforeEach(async () => { setup(); await startServer(); });
    afterEach(teardown);

    it('should start a CDP session', async () => {
        const ext = await connect(EXT_KEY);
        await waitMsg(ext, m => m.type === 'connected');

        const agent = await connect(AGENT_KEY);
        await waitMsg(agent, m => m.type === 'connected');

        send(agent, { type: 'cdp:session-start', tabId: 1, domains: ['Runtime', 'DOM'] });

        const started = await waitMsg(agent, m => m.type === 'cdp:session-started');
        assert.equal(started.tabId, 1);
        assert.ok(started.sessionKey);
        assert.deepEqual(started.domains, ['Runtime', 'DOM']);

        // Extension should receive the session-start
        const extMsg = await waitMsg(ext, m => m.type === 'cdp:session-start');
        assert.equal(extMsg.tabId, 1);

        agent.close();
        ext.close();
    });

    it('should reject session start without extension', async () => {
        const agent = await connect(AGENT_KEY);
        await waitMsg(agent, m => m.type === 'connected');

        send(agent, { type: 'cdp:session-start', tabId: 1 });

        const err = await waitMsg(agent, m => m.type === 'cdp:error');
        assert.equal(err.code, 'NO_EXTENSION');

        agent.close();
    });

    it('should enforce exclusive lock (one agent per tab)', async () => {
        const ext = await connect(EXT_KEY);
        await waitMsg(ext, m => m.type === 'connected');

        const agent1 = await connect(AGENT_KEY);
        await waitMsg(agent1, m => m.type === 'connected');
        const agent2 = await connect(AGENT_KEY_2);
        await waitMsg(agent2, m => m.type === 'connected');

        // Agent 1 starts session on tab 1
        send(agent1, { type: 'cdp:session-start', tabId: 1, domains: ['Runtime'] });
        await waitMsg(agent1, m => m.type === 'cdp:session-started');
        await waitMsg(ext, m => m.type === 'cdp:session-start');

        // Agent 2 tries same tab — should be locked
        send(agent2, { type: 'cdp:session-start', tabId: 1 });
        const err = await waitMsg(agent2, m => m.type === 'cdp:error');
        assert.equal(err.code, 'TAB_LOCKED');

        agent1.close();
        agent2.close();
        ext.close();
    });

    it('should stop a CDP session', async () => {
        const ext = await connect(EXT_KEY);
        await waitMsg(ext, m => m.type === 'connected');
        const agent = await connect(AGENT_KEY);
        await waitMsg(agent, m => m.type === 'connected');

        send(agent, { type: 'cdp:session-start', tabId: 1 });
        await waitMsg(agent, m => m.type === 'cdp:session-started');
        await waitMsg(ext, m => m.type === 'cdp:session-start');

        send(agent, { type: 'cdp:session-stop', tabId: 1 });
        const stopped = await waitMsg(agent, m => m.type === 'cdp:session-stopped');
        assert.equal(stopped.tabId, 1);

        agent.close();
        ext.close();
    });

    it('should release lock when agent disconnects', async () => {
        const ext = await connect(EXT_KEY);
        await waitMsg(ext, m => m.type === 'connected');
        const agent1 = await connect(AGENT_KEY);
        await waitMsg(agent1, m => m.type === 'connected');

        send(agent1, { type: 'cdp:session-start', tabId: 1 });
        await waitMsg(agent1, m => m.type === 'cdp:session-started');
        await waitMsg(ext, m => m.type === 'cdp:session-start');

        // Agent 1 disconnects — lock should release
        agent1.close();
        await new Promise(r => setTimeout(r, 100));

        // Agent 2 should now be able to lock the same tab
        const agent2 = await connect(AGENT_KEY_2);
        await waitMsg(agent2, m => m.type === 'connected');
        send(agent2, { type: 'cdp:session-start', tabId: 1, domains: ['Runtime'] });
        const started = await waitMsg(agent2, m => m.type === 'cdp:session-started');
        assert.equal(started.tabId, 1);

        agent2.close();
        ext.close();
    });

    it('should reject session-start with invalid tabId', async () => {
        const ext = await connect(EXT_KEY);
        await waitMsg(ext, m => m.type === 'connected');
        const agent = await connect(AGENT_KEY);
        await waitMsg(agent, m => m.type === 'connected');

        send(agent, { type: 'cdp:session-start', tabId: 'not-a-number' });
        const err = await waitMsg(agent, m => m.type === 'cdp:error');
        assert.equal(err.code, 'INVALID_PARAMS');

        agent.close();
        ext.close();
    });
});

// ================================================================= command relay

describe('CDP WS — command relay', () => {
    beforeEach(async () => { setup(); await startServer(); });
    afterEach(teardown);

    it('should relay command from agent to extension and result back', async () => {
        const ext = await connect(EXT_KEY);
        await waitMsg(ext, m => m.type === 'connected');
        const agent = await connect(AGENT_KEY);
        await waitMsg(agent, m => m.type === 'connected');

        // Start session
        send(agent, { type: 'cdp:session-start', tabId: 1 });
        const started = await waitMsg(agent, m => m.type === 'cdp:session-started');
        await waitMsg(ext, m => m.type === 'cdp:session-start');

        // Agent sends CDP command
        send(agent, { type: 'cdp:command', commandId: 'cmd-1', method: 'Runtime.evaluate', params: { expression: '1+1' }, tabId: 1 });

        // Extension receives command
        const cmd = await waitMsg(ext, m => m.type === 'cdp:command');
        assert.equal(cmd.commandId, 'cmd-1');
        assert.equal(cmd.method, 'Runtime.evaluate');
        assert.deepEqual(cmd.params, { expression: '1+1' });

        // Extension sends result back (no _auditId — tracked server-side)
        send(ext, { type: 'cdp:result', commandId: 'cmd-1', result: { result: { value: 2 } }, durationMs: 5, tabId: 1 });

        // Agent receives result
        const result = await waitMsg(agent, m => m.type === 'cdp:result' && m.commandId === 'cmd-1');
        assert.deepEqual(result.result, { result: { value: 2 } });
        assert.equal(result.durationMs, 5);

        // Verify audit log
        const logs = db.getCdpAuditBySession(started.sessionKey);
        assert.ok(logs.length > 0);
        assert.equal(logs[0].method, 'Runtime.evaluate');

        agent.close();
        ext.close();
    });

    it('should relay error result', async () => {
        const ext = await connect(EXT_KEY);
        await waitMsg(ext, m => m.type === 'connected');
        const agent = await connect(AGENT_KEY);
        await waitMsg(agent, m => m.type === 'connected');

        send(agent, { type: 'cdp:session-start', tabId: 1 });
        await waitMsg(agent, m => m.type === 'cdp:session-started');
        await waitMsg(ext, m => m.type === 'cdp:session-start');

        send(agent, { type: 'cdp:command', commandId: 'cmd-err', method: 'BadDomain.badMethod', tabId: 1 });
        const cmd = await waitMsg(ext, m => m.type === 'cdp:command');

        send(ext, { type: 'cdp:result', commandId: 'cmd-err', error: 'Protocol error', tabId: 1 });

        const result = await waitMsg(agent, m => m.type === 'cdp:result' && m.commandId === 'cmd-err');
        assert.equal(result.error, 'Protocol error');

        agent.close();
        ext.close();
    });

    it('should reject command without active session', async () => {
        const ext = await connect(EXT_KEY);
        await waitMsg(ext, m => m.type === 'connected');
        const agent = await connect(AGENT_KEY);
        await waitMsg(agent, m => m.type === 'connected');

        // No session started, send command directly
        send(agent, { type: 'cdp:command', commandId: 'cmd-no-session', method: 'Runtime.evaluate', tabId: 1 });

        const result = await waitMsg(agent, m => m.type === 'cdp:result' && m.commandId === 'cmd-no-session');
        assert.ok(result.error);

        agent.close();
        ext.close();
    });

    it('should reject command with missing fields', async () => {
        const agent = await connect(AGENT_KEY);
        await waitMsg(agent, m => m.type === 'connected');

        send(agent, { type: 'cdp:command', method: 'Runtime.evaluate' }); // missing commandId and tabId
        const err = await waitMsg(agent, m => m.type === 'cdp:error');
        assert.equal(err.code, 'INVALID_PARAMS');

        agent.close();
    });
});

// ================================================================= event subscription

describe('CDP WS — event subscription', () => {
    beforeEach(async () => { setup(); await startServer(); });
    afterEach(teardown);

    it('should forward events for subscribed domains only', async () => {
        const ext = await connect(EXT_KEY);
        await waitMsg(ext, m => m.type === 'connected');
        const agent = await connect(AGENT_KEY);
        await waitMsg(agent, m => m.type === 'connected');

        // Subscribe to Runtime only
        send(agent, { type: 'cdp:session-start', tabId: 1, domains: ['Runtime'] });
        await waitMsg(agent, m => m.type === 'cdp:session-started');
        await waitMsg(ext, m => m.type === 'cdp:session-start');

        // Extension sends a Runtime event — should be forwarded
        send(ext, { type: 'cdp:event', domain: 'Runtime', method: 'Runtime.consoleAPICalled', params: { type: 'log' }, tabId: 1 });
        const event1 = await waitMsg(agent, m => m.type === 'cdp:event');
        assert.equal(event1.domain, 'Runtime');

        // Extension sends a Network event — should be filtered out
        send(ext, { type: 'cdp:event', domain: 'Network', method: 'Network.requestWillBeSent', params: {}, tabId: 1 });

        // Send a second Runtime event to verify we only get subscribed events
        send(ext, { type: 'cdp:event', domain: 'Runtime', method: 'Runtime.exceptionThrown', params: {}, tabId: 1 });
        const event2 = await waitMsg(agent, m => m.type === 'cdp:event');
        assert.equal(event2.domain, 'Runtime');
        assert.equal(event2.method, 'Runtime.exceptionThrown');

        agent.close();
        ext.close();
    });

    it('should forward all events when no domains specified', async () => {
        const ext = await connect(EXT_KEY);
        await waitMsg(ext, m => m.type === 'connected');
        const agent = await connect(AGENT_KEY);
        await waitMsg(agent, m => m.type === 'connected');

        send(agent, { type: 'cdp:session-start', tabId: 1 }); // no domains = all events
        await waitMsg(agent, m => m.type === 'cdp:session-started');
        await waitMsg(ext, m => m.type === 'cdp:session-start');

        send(ext, { type: 'cdp:event', domain: 'Network', method: 'Network.requestWillBeSent', params: {}, tabId: 1 });
        const event = await waitMsg(agent, m => m.type === 'cdp:event');
        assert.equal(event.domain, 'Network');

        agent.close();
        ext.close();
    });
});

// ================================================================= cross-app isolation

describe('CDP WS — cross-app isolation', () => {
    beforeEach(async () => { setup(); await startServer(); });
    afterEach(teardown);

    it('should not route commands to other apps extension', async () => {
        // Connect extension from app 2
        const ext2 = await connect(EXT_KEY_OTHER);
        await waitMsg(ext2, m => m.type === 'connected');

        // Agent from app 1 tries to start session — no extension in its app
        const agent = await connect(AGENT_KEY);
        await waitMsg(agent, m => m.type === 'connected');

        send(agent, { type: 'cdp:session-start', tabId: 1 });
        const err = await waitMsg(agent, m => m.type === 'cdp:error');
        assert.equal(err.code, 'NO_EXTENSION');

        agent.close();
        ext2.close();
    });
});

// ================================================================= rate limiting

describe('CDP WS — rate limiting', () => {
    beforeEach(async () => { setup(); await startServer(); });
    afterEach(teardown);

    it('should rate limit after 30 commands/second', async () => {
        const ext = await connect(EXT_KEY);
        await waitMsg(ext, m => m.type === 'connected');
        const agent = await connect(AGENT_KEY);
        await waitMsg(agent, m => m.type === 'connected');

        send(agent, { type: 'cdp:session-start', tabId: 1 });
        await waitMsg(agent, m => m.type === 'cdp:session-started');
        await waitMsg(ext, m => m.type === 'cdp:session-start');

        // Send 35 commands rapidly — some will pass to extension, some will be rate-limited
        for (let i = 0; i < 35; i++) {
            send(agent, { type: 'cdp:command', commandId: `rate-${i}`, method: 'Runtime.evaluate', tabId: 1 });
        }

        // Wait briefly for all messages to be processed
        await new Promise(r => setTimeout(r, 200));

        // Check agent's message queue for rate-limited responses
        const rateLimitedMsgs = agent._msgQueue.filter(m => m.type === 'cdp:result' && m.code === 'RATE_LIMITED');
        assert.ok(rateLimitedMsgs.length > 0, `Expected rate-limited responses, got ${rateLimitedMsgs.length}`);

        agent.close();
        ext.close();
    });
});
