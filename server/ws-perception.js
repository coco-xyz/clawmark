'use strict';

const { WebSocketServer } = require('ws');
const { hashKey } = require('./agent-auth');

/**
 * Perception WebSocket handler (#109 — Phase 4: Agent binding push)
 *
 * Real-time push of perception events and annotations to bound agents,
 * replacing HTTP polling. Agents connect with their agent key + binding ID.
 *
 * Protocol:
 *   Connection: wss://{server}/ws/agent?key={cmak_key}&binding={binding_id}
 *
 *   Server → Agent (push):
 *     { type: "perception", binding_id, payload: { ...PerceptionEvent } }
 *     { type: "annotation",  binding_id, payload: { text, url, user, ... } }
 *     { type: "scope_changed", binding_id, scopes: [...] }
 *
 *   Agent → Server (upstream):
 *     { type: "action",    binding_id, payload: { action_type, target, params } }
 *     { type: "heartbeat", binding_id, payload: { status, version } }
 *
 *   Server → Agent:
 *     { type: "heartbeat_ack" }
 */

const HEARTBEAT_INTERVAL = 30000;
const MAX_PAYLOAD = 1 * 1024 * 1024; // 1 MB

function initPerceptionWs(server, db, opts = {}) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

    // Connection registries
    // binding_id → Set<ws>  (one binding can have multiple replicas)
    const bindingConnections = new Map();
    // app_id → Set<binding_id>  (for broadcasting by app)
    const appBindings = new Map();

    // ------------------------------------------------- upgrade handler
    server.on('upgrade', (req, socket, head) => {
        // Parse URL — handle both /ws/agent and /ws/agent?key=...&binding=...
        let pathname, searchParams;
        try {
            const url = new URL(req.url, 'http://localhost');
            pathname = url.pathname;
            searchParams = url.searchParams;
        } catch {
            socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
            socket.destroy();
            return;
        }

        if (pathname !== '/ws/agent') return; // let other upgrade handlers deal with it

        const agentKey = searchParams.get('key');
        const bindingId = searchParams.get('binding');

        if (!agentKey || !bindingId) {
            socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
            socket.destroy();
            return;
        }

        if (!agentKey.startsWith('cmak_')) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }

        // Authenticate agent
        const hash = hashKey(agentKey);
        const agent = db.getAgentByKeyHash(hash);
        if (!agent) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }

        // Validate binding
        const binding = db.getBindingById(bindingId);
        if (!binding) {
            socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            socket.destroy();
            return;
        }

        // Binding must belong to this agent and be active
        if (binding.agent_id !== agent.id) {
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
        }
        if (binding.status !== 'active') {
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
        }

        let scopes;
        try {
            scopes = Array.isArray(binding.scopes) ? binding.scopes : JSON.parse(binding.scopes || '[]');
        } catch {
            socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
            socket.destroy();
            return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
            ws.authContext = {
                agent_id: agent.id,
                app_id: binding.app_id,
                binding_id: binding.id,
                scopes,
            };
            wss.emit('connection', ws, req);
        });
    });

    // ------------------------------------------------- connection handler
    wss.on('connection', (ws) => {
        const ctx = ws.authContext;
        ws.isAlive = true;

        // Register in binding registry
        if (!bindingConnections.has(ctx.binding_id)) bindingConnections.set(ctx.binding_id, new Set());
        bindingConnections.get(ctx.binding_id).add(ws);

        // Register in app registry
        if (!appBindings.has(ctx.app_id)) appBindings.set(ctx.app_id, new Set());
        appBindings.get(ctx.app_id).add(ctx.binding_id);

        // Mark connected in DB
        try { db.updateBindingHeartbeat(ctx.binding_id, true); } catch {}
        try { db.updateAgentLastSeen(ctx.agent_id); } catch {}

        // Send welcome
        wsSend(ws, {
            type: 'connected',
            binding_id: ctx.binding_id,
            scopes: ctx.scopes,
        });

        console.log(`[ws-perception] Agent ${ctx.agent_id} connected (binding: ${ctx.binding_id})`);

        ws.on('pong', () => { ws.isAlive = true; });

        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch { return; }

            if (msg.type === 'pong') { ws.isAlive = true; return; }

            if (msg.type === 'heartbeat') {
                handleHeartbeat(ws, ctx, msg);
            } else if (msg.type === 'action') {
                handleAction(ws, ctx, msg);
            }
        });

        ws.on('close', () => {
            const set = bindingConnections.get(ctx.binding_id);
            if (set) {
                set.delete(ws);
                if (set.size === 0) {
                    bindingConnections.delete(ctx.binding_id);
                    // Clean up app registry
                    const appSet = appBindings.get(ctx.app_id);
                    if (appSet) {
                        appSet.delete(ctx.binding_id);
                        if (appSet.size === 0) appBindings.delete(ctx.app_id);
                    }
                    // Mark disconnected in DB
                    try { db.updateBindingHeartbeat(ctx.binding_id, false); } catch {}
                }
            }
            console.log(`[ws-perception] Agent ${ctx.agent_id} disconnected (binding: ${ctx.binding_id})`);
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

    // ------------------------------------------------- message handlers
    function handleHeartbeat(ws, ctx, msg) {
        try { db.updateBindingHeartbeat(ctx.binding_id, true); } catch {}
        wsSend(ws, { type: 'heartbeat_ack' });
    }

    function handleAction(ws, ctx, msg) {
        if (!ctx.scopes.includes('action')) {
            return wsSend(ws, { type: 'error', error: 'action scope not granted' });
        }
        // Forward to action system — create action via DB
        const { action_type, payload, session_id } = msg.payload || msg;
        if (!action_type) {
            return wsSend(ws, { type: 'error', error: 'action_type required' });
        }
        try {
            const action = db.createAction({
                agent_id: ctx.agent_id,
                app_id: ctx.app_id,
                session_id: session_id || null,
                type: action_type,
                payload: payload || {},
                timeout_ms: msg.timeout_ms || 30000,
            });
            wsSend(ws, { type: 'action_queued', action_id: action.id, status: 'queued' });
            // Trigger dispatch to extension via action WS
            if (opts.onActionCreated) opts.onActionCreated(action.id, ctx.app_id);
        } catch (err) {
            wsSend(ws, { type: 'error', error: err.message === 'QUEUE_FULL' ? 'Action queue full' : 'Failed to queue action' });
        }
    }

    // ------------------------------------------------- push methods (called from HTTP routes)

    /**
     * Push perception events to all bound agents for an app.
     * Filters by binding scopes — only pushes to agents with 'perception' scope.
     */
    function pushPerceptionEvents(app_id, events) {
        const bindingIds = appBindings.get(app_id);
        if (!bindingIds || bindingIds.size === 0) return 0;

        let pushed = 0;
        for (const bindingId of bindingIds) {
            const sockets = bindingConnections.get(bindingId);
            if (!sockets) continue;

            for (const ws of sockets) {
                if (!ws.authContext.scopes.includes('perception')) continue;
                for (const event of events) {
                    wsSend(ws, {
                        type: 'perception',
                        binding_id: bindingId,
                        payload: event,
                    });
                    pushed++;
                }
            }
        }
        return pushed;
    }

    /**
     * Push an annotation/item to all bound agents for an app.
     * Requires 'annotation' scope.
     */
    function pushAnnotation(app_id, annotation) {
        const bindingIds = appBindings.get(app_id);
        if (!bindingIds || bindingIds.size === 0) return 0;

        let pushed = 0;
        for (const bindingId of bindingIds) {
            const sockets = bindingConnections.get(bindingId);
            if (!sockets) continue;

            for (const ws of sockets) {
                if (!ws.authContext.scopes.includes('annotation')) continue;
                wsSend(ws, {
                    type: 'annotation',
                    binding_id: bindingId,
                    payload: annotation,
                });
                pushed++;
            }
        }
        return pushed;
    }

    /**
     * Notify agents when their binding scopes change.
     */
    function pushScopeChanged(binding_id, newScopes) {
        const sockets = bindingConnections.get(binding_id);
        if (!sockets) return;

        for (const ws of sockets) {
            ws.authContext.scopes = [...newScopes]; // defensive copy
            wsSend(ws, {
                type: 'scope_changed',
                binding_id,
                scopes: newScopes,
            });
        }
    }

    /**
     * Push session update to all bound agents for an app.
     * Requires 'session' scope. Sends session metadata + event summary
     * (not full events, to avoid flooding the WebSocket).
     */
    function pushSessionUpdate(app_id, sessionUpdate) {
        const bindingIds = appBindings.get(app_id);
        if (!bindingIds || bindingIds.size === 0) return 0;

        let pushed = 0;
        for (const bindingId of bindingIds) {
            const sockets = bindingConnections.get(bindingId);
            if (!sockets) continue;

            for (const ws of sockets) {
                if (!ws.authContext.scopes.includes('session')) continue;
                wsSend(ws, {
                    type: 'session',
                    binding_id: bindingId,
                    payload: sessionUpdate,
                });
                pushed++;
            }
        }
        return pushed;
    }

    /**
     * Push an action result to agents connected via this WS.
     * Called by the action WS when an extension submits a result,
     * so agents on the perception WS also receive action outcomes.
     */
    function pushActionResult(agent_id, app_id, resultData) {
        const bindingIds = appBindings.get(app_id);
        if (!bindingIds || bindingIds.size === 0) return 0;

        let pushed = 0;
        for (const bindingId of bindingIds) {
            const sockets = bindingConnections.get(bindingId);
            if (!sockets) continue;

            for (const ws of sockets) {
                if (ws.authContext.agent_id !== agent_id) continue;
                if (!ws.authContext.scopes.includes('action')) continue;
                wsSend(ws, {
                    type: 'action_result',
                    binding_id: bindingId,
                    ...resultData,
                });
                pushed++;
            }
        }
        return pushed;
    }

    /**
     * Force-close all connections for a binding (on suspend/revoke).
     */
    function closeBinding(binding_id) {
        const sockets = bindingConnections.get(binding_id);
        if (!sockets) return;

        for (const ws of sockets) {
            wsSend(ws, { type: 'binding_closed', binding_id, reason: 'suspended_or_revoked' });
            ws.close(1000, 'binding closed');
        }
    }

    // ------------------------------------------------- util
    function wsSend(ws, data) {
        if (ws.readyState === 1) { // WebSocket.OPEN
            ws.send(JSON.stringify(data));
        }
    }

    function getStats() {
        let connections = 0;
        for (const set of bindingConnections.values()) connections += set.size;
        return {
            connections,
            bindings: bindingConnections.size,
            apps: appBindings.size,
        };
    }

    return {
        wss,
        pushPerceptionEvents,
        pushAnnotation,
        pushSessionUpdate,
        pushScopeChanged,
        pushActionResult,
        closeBinding,
        getStats,
    };
}

module.exports = { initPerceptionWs };
