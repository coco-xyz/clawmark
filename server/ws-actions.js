'use strict';

const { WebSocketServer } = require('ws');
const { hashKey } = require('./agent-auth');

/**
 * Action WebSocket handler (#78, #119 multi-instance routing)
 *
 * Manages bidirectional WebSocket connections between agents and extensions
 * for real-time action dispatch and result delivery.
 *
 * Protocol messages:
 *   Agent → Server:   { type: 'action', action_type, payload, session_id?, target_instance?, timeout_ms? }
 *   Server → Ext:     { type: 'action', action_id, action_type, payload }
 *   Ext → Server:     { type: 'result', action_id, result?, error?, instance_id? }
 *   Server → Agent:   { type: 'result', action_id, status, result?, error?, instance_id? }
 *   Both:             { type: 'pong' } (response to ping)
 */

const HEARTBEAT_INTERVAL = 30000;
const MAX_PAYLOAD = 1 * 1024 * 1024; // 1 MB

function initActionWs(server, db, opts = {}) {
    const VALID_ACTION_TYPES = new Set(db.getValidActionTypes());
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

    // Connection registries: app_id → Set<ws>
    const agentConnections = new Map();    // agent sockets by app_id
    const extensionConnections = new Map(); // extension sockets by app_id
    // #119: instance_id → ws (for targeted action dispatch)
    const instanceConnections = new Map();
    // #119: session_id → instance_id (sticky routing within a session)
    const sessionInstanceMap = new Map();

    // ------------------------------------------------- upgrade handler
    server.on('upgrade', (req, socket, head) => {
        // #119: support both exact path and path with query params
        let pathname, searchParams;
        try {
            const url = new URL(req.url, 'http://localhost');
            pathname = url.pathname;
            searchParams = url.searchParams;
        } catch {
            if (req.url === '/ws/agent-channel/actions') {
                pathname = req.url;
                searchParams = new URLSearchParams();
            } else {
                return;
            }
        }
        if (pathname !== '/ws/agent-channel/actions') return;

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
            // #119: extension may provide instance_id via query param (set by #118)
            const instanceId = searchParams.get('instance_id') || null;
            authContext = { role: 'extension', app_id: apiKey.app_id, instance_id: instanceId };
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
        ws.lastActivity = Date.now(); // #119: track activity for fallback routing

        // Register connection
        const registry = ctx.role === 'agent' ? agentConnections : extensionConnections;
        if (!registry.has(ctx.app_id)) registry.set(ctx.app_id, new Set());
        registry.get(ctx.app_id).add(ws);

        // #119: register instance connection if instance_id is present
        if (ctx.role === 'extension' && ctx.instance_id) {
            instanceConnections.set(ctx.instance_id, ws);
        }

        // Send welcome
        wsSend(ws, { type: 'connected', role: ctx.role, app_id: ctx.app_id, instance_id: ctx.instance_id || null });

        // If extension connects, dispatch any queued actions
        if (ctx.role === 'extension') {
            dispatchQueuedActions(ctx.app_id);
        }

        ws.on('pong', () => { ws.isAlive = true; });

        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch { return; }

            ws.lastActivity = Date.now(); // #119: update activity on every message

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
            // #119: clean up instance connection
            if (ctx.role === 'extension' && ctx.instance_id) {
                if (instanceConnections.get(ctx.instance_id) === ws) {
                    instanceConnections.delete(ctx.instance_id);
                }
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
        const { action_type, payload, session_id, target_instance, timeout_ms } = msg;

        if (!action_type || !VALID_ACTION_TYPES.has(action_type)) {
            return wsSend(ws, { type: 'error', error: `Invalid action_type. Allowed: ${[...VALID_ACTION_TYPES].join(', ')}` });
        }

        // #119: resolve target instance — explicit > session sticky > fallback
        let resolvedInstance = target_instance || null;
        if (!resolvedInstance && session_id) {
            resolvedInstance = sessionInstanceMap.get(session_id) || null;
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
            dispatchAction(action.id, ctx.app_id, resolvedInstance);
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

        // #119: include instance_id in result (from extension context or message)
        const instanceId = msg.instance_id || ctx.instance_id || null;

        // #119: bind session to instance for sticky routing
        if (action.session_id && instanceId) {
            sessionInstanceMap.set(action.session_id, instanceId);
        }

        // Push result to the agent on action WS
        const resultData = {
            action_id,
            action_type: action.type,
            status,
            result: result || null,
            error: error || null,
            instance_id: instanceId,
        };

        const agentSockets = agentConnections.get(ctx.app_id);
        if (agentSockets) {
            for (const agentWs of agentSockets) {
                if (agentWs.authContext.agent_id === action.agent_id) {
                    wsSend(agentWs, { type: 'result', ...resultData });
                }
            }
        }

        // Also push to agents on perception WS
        if (opts.onResult) opts.onResult(action.agent_id, action.app_id, resultData);
    }

    // ------------------------------------------------- dispatch helpers

    /**
     * #119: Find the best extension socket for dispatch.
     * Priority: targeted instance > session-sticky instance > most recently active.
     */
    function findExtensionSocket(appId, targetInstance) {
        // 1. Targeted instance — exact match
        if (targetInstance) {
            const targeted = instanceConnections.get(targetInstance);
            if (targeted && targeted.readyState === 1 && targeted.authContext.app_id === appId) {
                return targeted;
            }
            // Target specified but not connected — return null (don't fallback silently)
            return null;
        }

        // 2. Fallback — most recently active extension for this app
        const extSockets = extensionConnections.get(appId);
        if (!extSockets || extSockets.size === 0) return null;

        let best = null;
        let bestActivity = 0;
        for (const ws of extSockets) {
            if (ws.readyState !== 1) continue; // WebSocket.OPEN
            if ((ws.lastActivity || 0) > bestActivity) {
                bestActivity = ws.lastActivity || 0;
                best = ws;
            }
        }
        return best;
    }

    function dispatchAction(actionId, appId, targetInstance) {
        const action = db.getAction(actionId);
        if (!action || action.status !== 'queued') return false;

        const ext = findExtensionSocket(appId, targetInstance);
        if (!ext) return false;

        // B2 fix: send WS first, then update DB — if socket is dead, action stays queued
        try {
            ext.send(JSON.stringify({
                type: 'action',
                action_id: action.id,
                action_type: action.type,
                payload: JSON.parse(action.payload),
                session_id: action.session_id,
                timeout_ms: action.timeout_ms,
            }));
        } catch { return false; } // TOCTOU: socket closed between readyState check and send

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

            const timeoutResult = {
                action_id: action.id,
                action_type: action.type,
                status: 'failed',
                error: 'Action timed out',
            };

            // Notify on action WS
            const agentSockets = agentConnections.get(action.app_id);
            if (agentSockets) {
                for (const agentWs of agentSockets) {
                    if (agentWs.authContext.agent_id === action.agent_id) {
                        wsSend(agentWs, { type: 'result', ...timeoutResult });
                    }
                }
            }

            // Notify on perception WS
            if (opts.onResult) opts.onResult(action.agent_id, action.app_id, timeoutResult);
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
        return {
            agents, extensions,
            instances: instanceConnections.size,
            apps: new Set([...agentConnections.keys(), ...extensionConnections.keys()]).size,
        };
    }

    // #120: list connected instances for a given app_id
    function getInstanceList(appId) {
        const result = [];
        for (const [instanceId, ws] of instanceConnections) {
            if (ws.readyState !== 1) continue; // WebSocket.OPEN
            if (ws.authContext.app_id !== appId) continue;
            result.push({
                instance_id: instanceId,
                connected: true,
                last_activity: ws.lastActivity || null,
            });
        }
        return result;
    }

    return { wss, checkTimeouts, dispatchAction, dispatchQueuedActions, getStats, getInstanceList };
}

module.exports = { initActionWs };
