/**
 * ClawMark — Perception Forwarder (#61 Phase 1)
 *
 * Bridges extension-local perception events to the ClawMark Server.
 * Events from ErrorMonitor, ConsoleProxy, NetworkMonitor, DOMInspector,
 * PerfMonitor, and SessionRecorder content scripts are queued here and
 * batch-uploaded to POST /api/v2/agent-channel/perception.
 *
 * Only forwards when:
 *   1. User is authenticated (authToken exists)
 *   2. At least one bound agent exists (boundAgents in chrome.storage.sync)
 *
 * Batching: uploads every FLUSH_INTERVAL_MS or when queue reaches MAX_BATCH.
 * Retry: on failure, events stay in queue; exponential backoff up to 60s.
 */

'use strict';

const FLUSH_INTERVAL_MS = 5000;
const MAX_BATCH = 50;
const MAX_QUEUE = 500;
const MAX_RETRY_DELAY_MS = 60000;

let _queue = [];
let _flushTimer = null;
let _retryDelay = 1000;
let _flushing = false;
let _hasBoundAgents = false;
const _recentFingerprints = new Map(); // fingerprint → timestamp for dedup
const FORWARDER_DEDUP_WINDOW_MS = 10000;

// Check bound agents on startup and when storage changes
async function _checkBoundAgents() {
    try {
        const result = await chrome.storage.sync.get({ boundAgents: [] });
        _hasBoundAgents = Array.isArray(result.boundAgents) && result.boundAgents.length > 0;
    } catch {
        _hasBoundAgents = false;
    }
}

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.boundAgents) {
        const newVal = changes.boundAgents.newValue;
        _hasBoundAgents = Array.isArray(newVal) && newVal.length > 0;
    }
});

// Initialize on load
_checkBoundAgents();

/**
 * Enqueue a perception event for server upload.
 * Called from handlePerceptionEvent and handleCapturedError paths.
 *
 * @param {object} event - Must have at least: type, message, url, severity
 * @param {number} tabId - Source tab
 */
function enqueueForServer(event, tabId) {
    if (!_hasBoundAgents) return;
    if (!event || (!event.type && !event.channel)) return;

    // Build fingerprint and dedup
    const fp = `${event.channel || event.type}:${(event.summary || event.message || '').slice(0, 150)}`;
    const now = Date.now();
    const lastSeen = _recentFingerprints.get(fp);
    if (lastSeen && now - lastSeen < FORWARDER_DEDUP_WINDOW_MS) return;
    _recentFingerprints.set(fp, now);

    // Prune old fingerprints periodically
    if (_recentFingerprints.size > 1000) {
        for (const [k, ts] of _recentFingerprints) {
            if (now - ts > FORWARDER_DEDUP_WINDOW_MS) _recentFingerprints.delete(k);
        }
    }

    const entry = {
        type: event.channel || event.type || 'unknown',
        message: (event.summary || event.message || '').slice(0, 4096),
        stack: (event.stack || event.detail?.stack || '').slice(0, 8192) || '',
        source: (event.source || event.detail?.source || '').slice(0, 2048) || '',
        line: event.line || event.detail?.line || null,
        severity: _mapSeverity(event.severity),
        url: (event.url || '').slice(0, 2048) || '',
        fingerprint: fp,
        context: event.context || {},
        _tabId: tabId,
        _ts: event.timestamp || Date.now(),
    };

    _queue.push(entry);

    // Cap queue size
    if (_queue.length > MAX_QUEUE) {
        _queue = _queue.slice(-MAX_QUEUE);
    }

    // Flush immediately if batch full, otherwise schedule
    if (_queue.length >= MAX_BATCH) {
        _flush();
    } else if (!_flushTimer) {
        _flushTimer = setTimeout(() => {
            _flushTimer = null;
            _flush();
        }, FLUSH_INTERVAL_MS);
    }
}

/**
 * Map content-script severity values to server-expected values.
 */
function _mapSeverity(sev) {
    if (!sev) return 'error';
    const s = String(sev).toLowerCase();
    if (s === 'critical' || s === 'p0') return 'P0';
    if (s === 'error' || s === 'p1') return 'P1';
    if (s === 'warning' || s === 'p2') return 'P2';
    if (s === 'info' || s === 'p3') return 'info';
    return 'info'; // unknown severities default to info
}

/**
 * Flush queued events to the server.
 */
async function _flush() {
    if (_flushing || _queue.length === 0) return;
    _flushing = true;

    // Grab batch
    const batch = _queue.splice(0, MAX_BATCH);

    // Strip internal fields before upload
    const payload = batch.map(({ _tabId, _ts, ...rest }) => rest);

    try {
        const { authToken } = await chrome.storage.local.get({ authToken: '' });
        if (!authToken) {
            // Not authenticated — put events back
            _queue.unshift(...batch);
            if (_queue.length > MAX_QUEUE) _queue.length = MAX_QUEUE;
            _flushing = false;
            return;
        }

        const config = await chrome.storage.sync.get({ serverUrl: '' });
        const serverUrl = (config.serverUrl || (typeof ClawMarkConfig !== 'undefined' ? ClawMarkConfig.DEFAULT_SERVER : '')).replace(/\/+$/, '');
        if (!serverUrl) {
            _queue.unshift(...batch);
            if (_queue.length > MAX_QUEUE) _queue.length = MAX_QUEUE;
            _flushing = false;
            return;
        }

        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);

        const res = await fetch(`${serverUrl}/api/v2/agent-channel/perception`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`,
            },
            body: JSON.stringify({ events: payload }),
            signal: ctrl.signal,
        });

        clearTimeout(timer);

        if (res.ok) {
            _retryDelay = 1000; // reset backoff on success
        } else if (res.status === 401) {
            // Auth expired — drop batch, don't retry
            console.debug('[perception-forwarder] Auth expired, dropping batch');
        } else {
            // Server error — put events back for retry, cap queue
            _queue.unshift(...batch);
            if (_queue.length > MAX_QUEUE) _queue.length = MAX_QUEUE;
            _scheduleRetry();
        }
    } catch (err) {
        // Network error — put events back, cap queue
        _queue.unshift(...batch);
        if (_queue.length > MAX_QUEUE) _queue.length = MAX_QUEUE;
        _scheduleRetry();
        console.debug('[perception-forwarder] Flush failed:', err.message);
    } finally {
        _flushing = false;
    }
}

function _scheduleRetry() {
    if (_flushTimer) return; // already scheduled
    _flushTimer = setTimeout(() => {
        _flushTimer = null;
        _flush();
    }, _retryDelay);
    _retryDelay = Math.min(_retryDelay * 2, MAX_RETRY_DELAY_MS);
}
