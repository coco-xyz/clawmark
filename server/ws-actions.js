'use strict';

const { WebSocketServer } = require('ws');
const { hashKey } = require('./agent-auth');

/**
 * Action WebSocket handler (#78)
 *
 * Manages bidirectional WebSocket connections between agents and extensions
 * for real-time action dispatch and result delivery.
 *
 * Protocol messages:
 *   Agent → Server:   { type: 'action', action_type, payload, session_id?, timeout_ms? }
 *   Server → Ext:     { type: 'action', action_id, action_type, payload }
 *   Ext → Server:     { type: 'result', action_id, result?, error? }
 *   Server → Agent:   { type: 'result', action_id, status, result?, error? }
 *   Both:             { type: 'pong' } (response to ping)
 */

const HEARTBEAT_INTERVAL = 30000;
const MAX_PAYLOAD = 1 * 1024 * 1024; // 1 MB

function initActionWs(server, db) {
    const VALID_ACTION_TYPES = new Set(db.getValidActionTypes());
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

    // Connection registries: app_id → Set<ws>
    const agentConnections = new Map();    // agent sockets by app_id
    const extensionConnections = new Map(); // extension sockets by app_id

    // ------------------------------------------------- upgrade handler
    server.on('upgrade', (req, socket, head) => {
        if (req.url !== '/ws/agent-channel/actions') return;

        const key = req.headers['x-agent-key'];
        if (!key) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }

        // Authenticate: cmak_ = agent, cmk_ = extension (app key)
        const hash = hashKey(key);
        let authContext;

        if (key.startsWith('cmak_')) {
            const agent = db.getAgentByKeyHash(hash);
            if (!agent) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }
            authContext = { role: 'agent', agent_id: agent.id, app_id: agent.app_id };
            try { db.updateAgentLastSeen(agent.id); } catch (e) { console.debug('updateAgentLastSeen failed:', e.message); }
        } else if (key.startsWith('cmk_')) {
            const apiKey = db.validateApiKey(key);
            if (!apiKey) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }
            authContext = { role: 'extension', app_id: apiKey.app_id };
        } else {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
            ws.authContext = authContext;
            wss.emit('connection', ws, req);
        });
    });

    // ------------------------------------------------- connection handler
    wss.on('connection', (ws) => {
        const ctx = ws.authContext;
        ws.isAlive = true;

        // Register connection
        const registry = ctx.role === 'agent' ? agentConnections : extensionConnections;
        if (!registry.has(ctx.app_id)) registry.set(ctx.app_id, new Set());
        registry.get(ctx.app_id).add(ws);

        // Send welcome
        wsSend(ws, { type: 'connected', role: ctx.role, app_id: ctx.app_id });

        // If extension connects, dispatch any queued actions
        if (ctx.role === 'extension') {
            dispatchQueuedActions(ctx.app_id);
        }

        ws.on('pong', () => { ws.isAlive = true; });

        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch { return; }

            if (msg.type === 'pong') { ws.isAlive = true; return; }

            if (ctx.role === 'agent' && msg.type === 'action') {
                handleAgentAction(ws, ctx, msg);
            } else if (ctx.role === 'extension' && msg.type === 'result') {
                handleExtensionResult(ws, ctx, msg);
            }
        });

        ws.on('close', () => {
            const set = registry.get(ctx.app_id);
            if (set) {
                set.delete(ws);
                if (set.size === 0) registry.delete(ctx.app_id);
            }
        });
    });

    // ------------------------------------------------- heartbeat
    const heartbeatTimer = setInterval(() => {
        wss.clients.forEach((ws) => {
            if (!ws.isAlive) return ws.terminate();
            ws.isAlive = false;
            ws.ping();
        });
    }, HEARTBEAT_INTERVAL);

    wss.on('close', () => clearInterval(heartbeatTimer));

    // ------------------------------------------------- agent action handler
    function handleAgentAction(ws, ctx, msg) {
        const { action_type, payload, session_id, timeout_ms } = msg;

        if (!action_type || !VALID_ACTION_TYPES.has(action_type)) {
            return wsSend(ws, { type: 'error', error: `Invalid action_type. Allowed: ${[...VALID_ACTION_TYPES].join(', ')}` });
        }

        try {
            const action = db.createAction({
                agent_id: ctx.agent_id,
                app_id: ctx.app_id,
                session_id: session_id || null,
                type: action_type,
                payload: payload || {},
                timeout_ms: timeout_ms || 30000,
            });

            wsSend(ws, { type: 'action_queued', action_id: action.id, status: 'queued' });

            // Try to dispatch immediately to connected extension
            dispatchAction(action.id, ctx.app_id);
        } catch (err) {
            if (err.message === 'QUEUE_FULL') {
                return wsSend(ws, { type: 'error', error: 'Action queue full (max 100 pending)' });
            }
            wsSend(ws, { type: 'error', error: 'Failed to queue action' });
        }
    }

    // ------------------------------------------------- extension result handler
    function handleExtensionResult(ws, ctx, msg) {
        const { action_id, result, error } = msg;
        if (!action_id) return;

        const action = db.getAction(action_id);
        if (!action || action.app_id !== ctx.app_id) return;
        if (action.status === 'completed' || action.status === 'failed') return;

        const status = error ? 'failed' : 'completed';
        let updated;
        try {
            updated = db.updateActionStatus(action_id, { status, result, error });
        } catch { return; } // Invalid transition
        if (!updated) return;

        // Push result only to the agent that created this action
        const agentSockets = agentConnections.get(ctx.app_id);
        if (agentSockets) {
            for (const agentWs of agentSockets) {
                if (agentWs.authContext.agent_id === action.agent_id) {
                    wsSend(agentWs, {
                        type: 'result',
                        action_id,
                        action_type: action.type,
                        status,
                        result: result || null,
                        error: error || null,
                    });
                }
            }
        }
    }

    // ------------------------------------------------- dispatch helpers
    function dispatchAction(actionId, appId) {
        const extSockets = extensionConnections.get(appId);
        if (!extSockets || extSockets.size === 0) return false;

        const action = db.getAction(actionId);
        if (!action || action.status !== 'queued') return false;

        // B2 fix: send WS first, then update DB — if socket is dead, action stays queued
        const ext = extSockets.values().next().value;
        if (ext.readyState !== 1) return false; // WebSocket.OPEN

        ext.send(JSON.stringify({
            type: 'action',
            action_id: action.id,
            action_type: action.type,
            payload: JSON.parse(action.payload),
            session_id: action.session_id,
            timeout_ms: action.timeout_ms,
        }));

        db.updateActionStatus(actionId, { status: 'dispatched' });
        return true;
    }

    function dispatchQueuedActions(appId) {
        const actions = db.listPendingActions(appId, 50);
        for (const action of actions) {
            if (action.status === 'queued') {
                dispatchAction(action.id, appId);
            }
        }
    }

    // ------------------------------------------------- timeout checker
    function checkTimeouts() {
        const timedOut = db.getTimedOutActions();
        for (const action of timedOut) {
            let updated;
            try {
                updated = db.updateActionStatus(action.id, { status: 'failed', error: 'Action timed out' });
            } catch { continue; } // Race: status already changed
            if (!updated) continue;

            // Notify only the agent that created this action
            const agentSockets = agentConnections.get(action.app_id);
            if (agentSockets) {
                for (const agentWs of agentSockets) {
                    if (agentWs.authContext.agent_id === action.agent_id) {
                        wsSend(agentWs, {
                            type: 'result',
                            action_id: action.id,
                            action_type: action.type,
                            status: 'failed',
                            error: 'Action timed out',
                        });
                    }
                }
            }
        }
        return timedOut.length;
    }

    // ------------------------------------------------- util
    function wsSend(ws, data) {
        if (ws.readyState === 1) { // WebSocket.OPEN
            ws.send(JSON.stringify(data));
        }
    }

    function getStats() {
        let agents = 0, extensions = 0;
        for (const set of agentConnections.values()) agents += set.size;
        for (const set of extensionConnections.values()) extensions += set.size;
        return { agents, extensions, apps: new Set([...agentConnections.keys(), ...extensionConnections.keys()]).size };
    }

    return { wss, checkTimeouts, dispatchAction, dispatchQueuedActions, getStats };
}

module.exports = { initActionWs };
