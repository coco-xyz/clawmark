'use strict';

const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { hashKey } = require('./agent-auth');

/**
 * CDP Channel WebSocket handler (#83)
 *
 * Relays CDP (Chrome DevTools Protocol) commands between AI agents and
 * browser extensions. Agents send CDP commands, server forwards to the
 * extension's CDP session, extension returns results.
 *
 * Protocol messages:
 *   Agent  -> Server: { type: 'cdp:session-start', tabId, domains? }
 *   Server -> Agent:  { type: 'cdp:session-started', sessionKey, tabId }
 *   Agent  -> Server: { type: 'cdp:command', commandId, method, params?, tabId }
 *   Server -> Agent:  { type: 'cdp:result', commandId, result?, error?, durationMs }
 *   Server -> Agent:  { type: 'cdp:event', domain, method, params, tabId }
 *   Agent  -> Server: { type: 'cdp:session-stop', tabId }
 *   Server -> Agent:  { type: 'cdp:session-stopped', tabId }
 *   Both:             { type: 'pong' } (heartbeat response)
 *
 * Auth: cmak_ (agent key) or cmk_ (extension/app key)
 * Exclusive lock: one agent per tab CDP session (Phase 1)
 */

const HEARTBEAT_INTERVAL = 30000;
const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const COMMAND_TIMEOUT = 30000; // 30 seconds per command
const MAX_PAYLOAD = 1 * 1024 * 1024; // 1 MB
const RATE_LIMIT_WINDOW = 1000; // 1 second
const RATE_LIMIT_MAX = 30; // 30 commands/second per agent

function initCdpWs(server, db) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

    // Connection registries: app_id -> Set<ws>
    const agentConnections = new Map();
    const extensionConnections = new Map();

    // CDP session locks: "app_id:tabId" -> { agent_id, sessionKey, domains, startedAt }
    const cdpLocks = new Map();

    // Server-side audit tracking: "app_id:commandId" -> { auditId, sentAt, tabId }
    const pendingCommands = new Map();

    // Rate limiter: agent_id -> { timestamps: number[] }
    const rateLimits = new Map();

    // ------------------------------------------------- upgrade handler
    server.on('upgrade', (req, socket, head) => {
        if (req.url !== '/ws/agent-channel/cdp') return;

        const key = req.headers['x-agent-key'];
        if (!key) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }

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
        ws.lastActivity = Date.now();

        const registry = ctx.role === 'agent' ? agentConnections : extensionConnections;
        if (!registry.has(ctx.app_id)) registry.set(ctx.app_id, new Set());
        registry.get(ctx.app_id).add(ws);

        wsSend(ws, { type: 'connected', role: ctx.role, app_id: ctx.app_id });

        ws.on('pong', () => { ws.isAlive = true; });

        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch { return; }

            ws.lastActivity = Date.now();

            if (msg.type === 'pong') { ws.isAlive = true; return; }

            if (ctx.role === 'agent') {
                switch (msg.type) {
                    case 'cdp:session-start': handleSessionStart(ws, ctx, msg); break;
                    case 'cdp:session-stop': handleSessionStop(ws, ctx, msg); break;
                    case 'cdp:command': handleCdpCommand(ws, ctx, msg); break;
                }
            } else if (ctx.role === 'extension') {
                switch (msg.type) {
                    case 'cdp:result': handleCdpResult(ws, ctx, msg); break;
                    case 'cdp:event': handleCdpEvent(ws, ctx, msg); break;
                }
            }
        });

        ws.on('close', () => {
            const set = registry.get(ctx.app_id);
            if (set) {
                set.delete(ws);
                if (set.size === 0) registry.delete(ctx.app_id);
            }

            // Clean up CDP locks and rate limiter entries owned by this agent
            if (ctx.role === 'agent') {
                for (const [lockKey, lock] of cdpLocks) {
                    if (lock.agent_id === ctx.agent_id && lockKey.startsWith(ctx.app_id + ':')) {
                        cdpLocks.delete(lockKey);
                    }
                }
                rateLimits.delete(ctx.agent_id);
            }
        });
    });

    // ------------------------------------------------- heartbeat + idle timeout
    const heartbeatTimer = setInterval(() => {
        const now = Date.now();
        wss.clients.forEach((ws) => {
            if (!ws.isAlive) return ws.terminate();
            // Idle timeout for agents
            if (ws.authContext.role === 'agent' && now - ws.lastActivity > IDLE_TIMEOUT) {
                wsSend(ws, { type: 'error', code: 'IDLE_TIMEOUT', error: 'Connection closed due to inactivity' });
                return ws.terminate();
            }
            ws.isAlive = false;
            ws.ping();
        });
    }, HEARTBEAT_INTERVAL);

    wss.on('close', () => {
        clearInterval(heartbeatTimer);
        clearInterval(commandTimeoutTimer);
    });

    // ------------------------------------------------- command timeout checker (P5)
    const commandTimeoutTimer = setInterval(() => {
        const now = Date.now();
        for (const [cmdKey, tracked] of pendingCommands) {
            if (now - tracked.sentAt > COMMAND_TIMEOUT) {
                pendingCommands.delete(cmdKey);
                // Update audit log
                if (tracked.auditId) {
                    try { db.updateCdpAuditLog(tracked.auditId, { status: 'failed', error: 'Command timed out (30s)', duration_ms: COMMAND_TIMEOUT }); } catch { /* ignore */ }
                }
                // Notify the agent
                const [appId] = cmdKey.split(':');
                const commandId = cmdKey.slice(appId.length + 1);
                const lockKey = `${appId}:${tracked.tabId}`;
                const lock = cdpLocks.get(lockKey);
                if (lock) {
                    const agentSockets = agentConnections.get(appId);
                    if (agentSockets) {
                        for (const agentWs of agentSockets) {
                            if (agentWs.authContext.agent_id === lock.agent_id) {
                                wsSend(agentWs, { type: 'cdp:result', commandId, error: 'Command timed out (30s)' });
                            }
                        }
                    }
                }
            }
        }
    }, 5000);

    // ------------------------------------------------- rate limiter
    function checkRateLimit(agentId) {
        const now = Date.now();
        let entry = rateLimits.get(agentId);
        if (!entry) {
            entry = { timestamps: [] };
            rateLimits.set(agentId, entry);
        }
        // Remove timestamps outside the window
        entry.timestamps = entry.timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);
        if (entry.timestamps.length >= RATE_LIMIT_MAX) return false;
        entry.timestamps.push(now);
        return true;
    }

    // ------------------------------------------------- tab ID validation helper
    function validateTabId(tabId) {
        return typeof tabId === 'number' && Number.isInteger(tabId) && tabId > 0;
    }

    // ------------------------------------------------- session start
    function handleSessionStart(ws, ctx, msg) {
        const { tabId, domains } = msg;
        if (!validateTabId(tabId)) {
            return wsSend(ws, { type: 'cdp:error', error: 'tabId (positive integer) is required', code: 'INVALID_PARAMS' });
        }

        const lockKey = `${ctx.app_id}:${tabId}`;
        const existing = cdpLocks.get(lockKey);

        // Exclusive lock: one agent per tab
        if (existing && existing.agent_id !== ctx.agent_id) {
            return wsSend(ws, { type: 'cdp:error', error: `Tab ${tabId} is locked by another agent`, code: 'TAB_LOCKED' });
        }

        // Same agent re-starting: return existing session key instead of overwriting
        if (existing && existing.agent_id === ctx.agent_id) {
            return wsSend(ws, { type: 'cdp:session-started', sessionKey: existing.sessionKey, tabId, domains: [...existing.domains] });
        }

        const sessionKey = `cdp-${ctx.app_id}-${tabId}-${Date.now()}`;
        const subscribedDomains = Array.isArray(domains) ? domains : [];

        cdpLocks.set(lockKey, {
            agent_id: ctx.agent_id,
            sessionKey,
            domains: new Set(subscribedDomains),
            startedAt: Date.now(),
        });

        // Forward session-start to extension so it can attach CDP
        const extSockets = extensionConnections.get(ctx.app_id);
        if (!extSockets || extSockets.size === 0) {
            cdpLocks.delete(lockKey);
            return wsSend(ws, { type: 'cdp:error', error: 'No extension connected', code: 'NO_EXTENSION' });
        }

        const ext = extSockets.values().next().value;
        if (ext.readyState !== 1) {
            cdpLocks.delete(lockKey);
            return wsSend(ws, { type: 'cdp:error', error: 'Extension not ready', code: 'NO_EXTENSION' });
        }

        try {
            ext.send(JSON.stringify({
                type: 'cdp:session-start',
                tabId,
                domains: subscribedDomains,
                sessionKey,
            }));
        } catch {
            cdpLocks.delete(lockKey);
            return wsSend(ws, { type: 'cdp:error', error: 'Failed to reach extension', code: 'NO_EXTENSION' });
        }

        wsSend(ws, { type: 'cdp:session-started', sessionKey, tabId, domains: subscribedDomains });
    }

    // ------------------------------------------------- session stop
    function handleSessionStop(ws, ctx, msg) {
        const { tabId } = msg;
        if (!tabId) return;

        const lockKey = `${ctx.app_id}:${tabId}`;
        const lock = cdpLocks.get(lockKey);

        if (!lock || lock.agent_id !== ctx.agent_id) {
            return wsSend(ws, { type: 'cdp:error', error: 'No active CDP session for this tab', code: 'NO_SESSION' });
        }

        // Forward stop to extension
        const extSockets = extensionConnections.get(ctx.app_id);
        if (extSockets) {
            for (const ext of extSockets) {
                try {
                    ext.send(JSON.stringify({ type: 'cdp:session-stop', tabId, sessionKey: lock.sessionKey }));
                } catch { /* ignore */ }
            }
        }

        cdpLocks.delete(lockKey);
        wsSend(ws, { type: 'cdp:session-stopped', tabId });
    }

    // ------------------------------------------------- CDP command handler
    function handleCdpCommand(ws, ctx, msg) {
        const { commandId, method, params, tabId } = msg;
        if (!commandId || !method || !validateTabId(tabId)) {
            return wsSend(ws, { type: 'cdp:error', error: 'commandId, method, and tabId (positive integer) are required', code: 'INVALID_PARAMS' });
        }

        // Verify session lock
        const lockKey = `${ctx.app_id}:${tabId}`;
        const lock = cdpLocks.get(lockKey);
        if (!lock || lock.agent_id !== ctx.agent_id) {
            return wsSend(ws, { type: 'cdp:result', commandId, error: 'No active CDP session for this tab' });
        }

        // Rate limit check
        if (!checkRateLimit(ctx.agent_id)) {
            return wsSend(ws, { type: 'cdp:result', commandId, error: 'Rate limited (30 commands/second)', code: 'RATE_LIMITED' });
        }

        // Hash params for audit (don't store raw params — may contain sensitive data)
        const paramsHash = params ? crypto.createHash('sha256').update(JSON.stringify(params)).digest('hex').slice(0, 16) : null;

        // Audit log
        let auditId;
        try {
            const audit = db.createCdpAuditLog({
                app_id: ctx.app_id,
                agent_id: ctx.agent_id,
                session_key: lock.sessionKey,
                tab_id: tabId,
                method,
                params_hash: paramsHash,
            });
            auditId = audit.id;
        } catch (err) {
            console.error('[cdp] Audit log error:', err.message);
        }

        // Forward to extension
        const extSockets = extensionConnections.get(ctx.app_id);
        if (!extSockets || extSockets.size === 0) {
            if (auditId) try { db.updateCdpAuditLog(auditId, { status: 'failed', error: 'No extension connected' }); } catch { /* ignore */ }
            return wsSend(ws, { type: 'cdp:result', commandId, error: 'No extension connected' });
        }

        const ext = extSockets.values().next().value;
        if (ext.readyState !== 1) {
            if (auditId) try { db.updateCdpAuditLog(auditId, { status: 'failed', error: 'Extension not ready' }); } catch { /* ignore */ }
            return wsSend(ws, { type: 'cdp:result', commandId, error: 'Extension not ready' });
        }

        try {
            ext.send(JSON.stringify({
                type: 'cdp:command',
                commandId,
                method,
                params: params || {},
                tabId,
                sessionKey: lock.sessionKey,
            }));
        } catch {
            if (auditId) try { db.updateCdpAuditLog(auditId, { status: 'failed', error: 'Send failed' }); } catch { /* ignore */ }
            return wsSend(ws, { type: 'cdp:result', commandId, error: 'Failed to reach extension' });
        }

        // Track command server-side for audit + timeout (P2: don't trust extension-provided _auditId)
        const cmdKey = `${ctx.app_id}:${commandId}`;
        pendingCommands.set(cmdKey, { auditId, sentAt: Date.now(), tabId });
    }

    // ------------------------------------------------- CDP result from extension
    function handleCdpResult(ws, ctx, msg) {
        const { commandId, result, error, durationMs, tabId } = msg;
        if (!commandId) return;

        // Look up audit tracking server-side (P2: never trust extension-provided _auditId)
        const cmdKey = `${ctx.app_id}:${commandId}`;
        const tracked = pendingCommands.get(cmdKey);
        if (tracked) {
            pendingCommands.delete(cmdKey);
            const elapsed = tracked.auditId ? (durationMs ?? Date.now() - tracked.sentAt) : null;
            if (tracked.auditId) {
                try {
                    db.updateCdpAuditLog(tracked.auditId, {
                        status: error ? 'failed' : 'success',
                        result_summary: result ? JSON.stringify(result).slice(0, 200) : null,
                        error: error || null,
                        duration_ms: elapsed,
                    });
                } catch { /* ignore */ }
            }
        }

        // Find the agent that owns this tab session
        const resolvedTabId = tabId || (tracked ? tracked.tabId : null);
        const lockKey = `${ctx.app_id}:${resolvedTabId}`;
        const lock = cdpLocks.get(lockKey);
        if (!lock) return;

        // Route result to the correct agent
        const agentSockets = agentConnections.get(ctx.app_id);
        if (agentSockets) {
            for (const agentWs of agentSockets) {
                if (agentWs.authContext.agent_id === lock.agent_id) {
                    wsSend(agentWs, {
                        type: 'cdp:result',
                        commandId,
                        result: result || null,
                        error: error || null,
                        durationMs: durationMs || null,
                    });
                }
            }
        }
    }

    // ------------------------------------------------- CDP event from extension
    function handleCdpEvent(ws, ctx, msg) {
        const { domain, method, params, tabId } = msg;
        if (!tabId || !method) return;

        const lockKey = `${ctx.app_id}:${tabId}`;
        const lock = cdpLocks.get(lockKey);
        if (!lock) return;

        // Only forward if agent subscribed to this domain
        const eventDomain = domain || method.split('.')[0];
        if (lock.domains.size > 0 && !lock.domains.has(eventDomain)) return;

        // Route event to the owning agent
        const agentSockets = agentConnections.get(ctx.app_id);
        if (agentSockets) {
            for (const agentWs of agentSockets) {
                if (agentWs.authContext.agent_id === lock.agent_id) {
                    wsSend(agentWs, {
                        type: 'cdp:event',
                        domain: eventDomain,
                        method,
                        params: params || {},
                        tabId,
                    });
                }
            }
        }
    }

    // ------------------------------------------------- util
    function wsSend(ws, data) {
        if (ws.readyState === 1) {
            ws.send(JSON.stringify(data));
        }
    }

    function getStats() {
        let agents = 0, extensions = 0;
        for (const set of agentConnections.values()) agents += set.size;
        for (const set of extensionConnections.values()) extensions += set.size;
        return {
            agents,
            extensions,
            activeSessions: cdpLocks.size,
            apps: new Set([...agentConnections.keys(), ...extensionConnections.keys()]).size,
        };
    }

    return { wss, getStats };
}

module.exports = { initCdpWs };
