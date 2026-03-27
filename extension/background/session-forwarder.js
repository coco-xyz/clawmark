/**
 * ClawMark — Session Forwarder (#61 Phase 2)
 *
 * Bridges extension-local session recording data to the ClawMark Server.
 * Session batches from SessionRecorder (via session-storage.js) are
 * forwarded to POST /api/v2/agent-channel/sessions.
 *
 * Session lifecycle:
 *   1. First batch for a session → POST without session_id → creates server session
 *   2. Subsequent batches → POST with session_id → appends events/snapshots
 *   3. Session end event → POST /api/v2/agent-channel/sessions/:id/finalize
 *
 * Only forwards when:
 *   1. User is authenticated (authToken exists)
 *   2. At least one bound agent exists
 *   3. Session recording is enabled
 *
 * Batching: flushes every FLUSH_INTERVAL_MS or when buffer reaches MAX_BATCH.
 * Retry: on failure, batches re-enqueue; exponential backoff up to 60s.
 *
 * Known limitation: MV3 service worker termination mid-flush will lose the
 * in-flight batch. Acceptable for session replay data (non-critical).
 */

'use strict';

const SESSION_FWD_FLUSH_INTERVAL_MS = 8000;
const SESSION_FWD_MAX_BATCH_EVENTS = 100;
const SESSION_FWD_MAX_QUEUE = 2000;
const SESSION_FWD_MAX_RETRY_DELAY_MS = 60000;
const SESSION_FWD_MAX_SNAPSHOT_HTML = 50000;

// State
let _sessionQueue = [];             // { localSessionId, events[], snapshots[] }
let _sessionFlushTimer = null;
let _sessionRetryDelay = 1000;
let _sessionFlushing = false;
let _sessionHasBoundAgents = false;

// Maps local session IDs to server session IDs
// localSessionId → serverSessionId
const _serverSessionMap = new Map();

// Track sessions that have been finalized on the server
const _finalizedSessions = new Set();

// ── Bound-agent gating ──────────────────────────────────────────────

async function _sessionCheckBoundAgents() {
    try {
        const result = await chrome.storage.sync.get({ boundAgents: [] });
        _sessionHasBoundAgents = Array.isArray(result.boundAgents) && result.boundAgents.length > 0;
    } catch {
        _sessionHasBoundAgents = false;
    }
}

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.boundAgents) {
        const newVal = changes.boundAgents.newValue;
        _sessionHasBoundAgents = Array.isArray(newVal) && newVal.length > 0;
    }
});

_sessionCheckBoundAgents();

// ── Origin validation ───────────────────────────────────────────────

function _sessionIsAllowedOrigin(url) {
    if (!url) return false;
    try {
        const parsed = new URL(url);
        const defaultServer = typeof ClawMarkConfig !== 'undefined' ? ClawMarkConfig.DEFAULT_SERVER : '';
        if (defaultServer) {
            const defaultParsed = new URL(defaultServer);
            return parsed.origin === defaultParsed.origin;
        }
        return parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

// ── Enqueue ─────────────────────────────────────────────────────────

/**
 * Enqueue a session batch for server upload.
 * Called from service worker when handling session:batch messages.
 *
 * @param {object} batch - { sessionId, startTime, url, events }
 * @param {number} tabId - Source tab ID
 */
function enqueueSessionForServer(batch, tabId) {
    if (!_sessionHasBoundAgents) return;
    if (!batch || !batch.sessionId || !Array.isArray(batch.events) || batch.events.length === 0) return;

    const localSessionId = batch.sessionId;

    // Skip if session already finalized
    if (_finalizedSessions.has(localSessionId)) return;

    // Separate snapshots from regular events
    const events = [];
    const snapshots = [];
    for (const event of batch.events) {
        if (event.type === 'snapshot') {
            snapshots.push({
                trigger: event.data?.trigger || 'unknown',
                timestamp: new Date(event.timestamp).toISOString(),
                html: (event.data?.html || '').slice(0, SESSION_FWD_MAX_SNAPSHOT_HTML),
            });
        } else {
            events.push({
                type: _mapEventType(event.type),
                timestamp: new Date(event.timestamp).toISOString(),
                data: _capEventData(event.data),
            });
        }
    }

    // Check for session-end event → will trigger finalization after flush
    const hasSessionEnd = events.some(e =>
        e.type === 'navigation' && e.data?.action === 'session-end'
    );

    _sessionQueue.push({
        localSessionId,
        tabId,
        url: batch.url || '',
        title: batch.title || '',
        startTime: batch.startTime,
        events,
        snapshots,
        finalize: hasSessionEnd,
    });

    // Cap queue size
    if (_sessionQueue.length > SESSION_FWD_MAX_QUEUE) {
        _sessionQueue = _sessionQueue.slice(-SESSION_FWD_MAX_QUEUE);
    }

    // Schedule flush
    if (!_sessionFlushTimer) {
        const delay = _sessionQueue.length >= SESSION_FWD_MAX_BATCH_EVENTS
            ? 0
            : SESSION_FWD_FLUSH_INTERVAL_MS;
        _sessionFlushTimer = setTimeout(() => {
            _sessionFlushTimer = null;
            _flushSessions();
        }, delay);
    }
}

/**
 * Map content-script event types to server-accepted types.
 */
function _mapEventType(type) {
    const MAP = {
        click: 'click',
        input: 'input',
        scroll: 'scroll',
        navigation: 'navigation',
        error: 'error',
        snapshot: 'snapshot',
        'visibility-change': 'navigation',
    };
    return MAP[type] || type || 'unknown';
}

/**
 * Cap event data to prevent unbounded payloads.
 */
function _capEventData(data) {
    if (!data || typeof data !== 'object') return {};
    const str = JSON.stringify(data);
    if (str.length <= 8192) return data;
    try { return JSON.parse(str.slice(0, 8192)); } catch { return {}; }
}

// ── Flush ───────────────────────────────────────────────────────────

async function _flushSessions() {
    if (_sessionFlushing || _sessionQueue.length === 0) return;
    _sessionFlushing = true;

    // Group queue items by localSessionId for efficient batching
    const grouped = new Map();
    const items = _sessionQueue.splice(0);

    for (const item of items) {
        if (!grouped.has(item.localSessionId)) {
            grouped.set(item.localSessionId, {
                localSessionId: item.localSessionId,
                tabId: item.tabId,
                url: item.url,
                title: item.title,
                startTime: item.startTime,
                events: [],
                snapshots: [],
                finalize: false,
            });
        }
        const g = grouped.get(item.localSessionId);
        g.events.push(...item.events);
        g.snapshots.push(...item.snapshots);
        if (item.finalize) g.finalize = true;
        // Keep latest url/title
        if (item.url) g.url = item.url;
        if (item.title) g.title = item.title;
    }

    let timer;
    try {
        const { authToken } = await chrome.storage.local.get({ authToken: '' });
        if (!authToken) {
            // Re-enqueue
            _sessionQueue.unshift(...items);
            if (_sessionQueue.length > SESSION_FWD_MAX_QUEUE) _sessionQueue.length = SESSION_FWD_MAX_QUEUE;
            _sessionFlushing = false;
            return;
        }

        const config = await chrome.storage.sync.get({ serverUrl: '' });
        const serverUrl = (config.serverUrl || (typeof ClawMarkConfig !== 'undefined' ? ClawMarkConfig.DEFAULT_SERVER : '')).replace(/\/+$/, '');

        if (!serverUrl || !_sessionIsAllowedOrigin(serverUrl)) {
            _sessionQueue.unshift(...items);
            if (_sessionQueue.length > SESSION_FWD_MAX_QUEUE) _sessionQueue.length = SESSION_FWD_MAX_QUEUE;
            _sessionFlushing = false;
            if (serverUrl) console.debug('[session-forwarder] Blocked upload to untrusted origin:', serverUrl);
            return;
        }

        // Process each session group
        for (const [localId, group] of grouped) {
            const ctrl = new AbortController();
            timer = setTimeout(() => ctrl.abort(), 20000);

            const serverSessionId = _serverSessionMap.get(localId);

            try {
                if (serverSessionId) {
                    // Append to existing server session
                    const res = await fetch(`${serverUrl}/api/v2/agent-channel/sessions`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${authToken}`,
                        },
                        body: JSON.stringify({
                            session_id: serverSessionId,
                            events: group.events,
                            snapshots: group.snapshots.length > 0 ? group.snapshots : undefined,
                        }),
                        signal: ctrl.signal,
                    });

                    if (!res.ok) {
                        if (res.status === 401) {
                            console.debug('[session-forwarder] Auth expired, dropping batch');
                        } else if (res.status === 404 || res.status === 409) {
                            // Session not found or finalized — drop and clean up map
                            _serverSessionMap.delete(localId);
                            _finalizedSessions.add(localId);
                            console.debug('[session-forwarder] Session gone/finalized, dropping:', localId);
                        } else {
                            throw new Error(`HTTP ${res.status}`);
                        }
                    }
                } else {
                    // Create new server session
                    const res = await fetch(`${serverUrl}/api/v2/agent-channel/sessions`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${authToken}`,
                        },
                        body: JSON.stringify({
                            tab_id: String(group.tabId || ''),
                            url: group.url,
                            title: group.title,
                            start_time: new Date(group.startTime).toISOString(),
                            events: group.events,
                            snapshots: group.snapshots.length > 0 ? group.snapshots : undefined,
                        }),
                        signal: ctrl.signal,
                    });

                    if (res.ok || res.status === 201) {
                        const data = await res.json();
                        if (data.id) {
                            _serverSessionMap.set(localId, data.id);
                        }
                    } else if (res.status === 401) {
                        console.debug('[session-forwarder] Auth expired, dropping session create');
                    } else {
                        throw new Error(`HTTP ${res.status}`);
                    }
                }

                // Finalize if session ended
                if (group.finalize && _serverSessionMap.has(localId)) {
                    const sid = _serverSessionMap.get(localId);
                    const fCtrl = new AbortController();
                    const fTimer = setTimeout(() => fCtrl.abort(), 10000);
                    try {
                        await fetch(`${serverUrl}/api/v2/agent-channel/sessions/${sid}/finalize`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${authToken}`,
                            },
                            signal: fCtrl.signal,
                        });
                    } catch { /* best effort */ }
                    clearTimeout(fTimer);

                    _serverSessionMap.delete(localId);
                    _finalizedSessions.add(localId);
                }

                _sessionRetryDelay = 1000; // reset backoff on success
            } catch (err) {
                // Re-enqueue this group's items
                _sessionQueue.unshift({
                    localSessionId: localId,
                    tabId: group.tabId,
                    url: group.url,
                    title: group.title,
                    startTime: group.startTime,
                    events: group.events,
                    snapshots: group.snapshots,
                    finalize: group.finalize,
                });
                _scheduleSessionRetry();
                console.debug('[session-forwarder] Flush failed for session', localId, ':', err.message);
            } finally {
                if (timer) { clearTimeout(timer); timer = null; }
            }
        }

        // Cap queue after re-enqueue
        if (_sessionQueue.length > SESSION_FWD_MAX_QUEUE) {
            _sessionQueue.length = SESSION_FWD_MAX_QUEUE;
        }
    } catch (err) {
        _sessionQueue.unshift(...items);
        if (_sessionQueue.length > SESSION_FWD_MAX_QUEUE) _sessionQueue.length = SESSION_FWD_MAX_QUEUE;
        _scheduleSessionRetry();
        console.debug('[session-forwarder] Flush failed:', err.message);
    } finally {
        if (timer) clearTimeout(timer);
        _sessionFlushing = false;
    }
}

function _scheduleSessionRetry() {
    if (_sessionFlushTimer) return;
    _sessionFlushTimer = setTimeout(() => {
        _sessionFlushTimer = null;
        _flushSessions();
    }, _sessionRetryDelay);
    _sessionRetryDelay = Math.min(_sessionRetryDelay * 2, SESSION_FWD_MAX_RETRY_DELAY_MS);
}

// Clean up finalized-sessions set periodically (prevent unbounded growth)
setInterval(() => {
    if (_finalizedSessions.size > 500) {
        _finalizedSessions.clear();
    }
    // Clean up server session map for sessions idle >2h
    // (MV3 workers restart frequently, so this is mostly defensive)
}, 3600000);
