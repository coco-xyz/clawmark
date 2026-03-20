/**
 * ClawMark — Session Storage (#72)
 *
 * Stores session recording batches from SessionRecorder content script.
 * Manages session segments per-tab with size limits. When the Agent
 * Channel server API is available (#73), batches will be forwarded upstream.
 *
 * Storage key: `session_${tabId}_${sessionId}`
 * Index key: `session_index_${tabId}` (maps sessionId → metadata)
 *
 * Size budget: ~2MB per tab (enforced by trimming oldest sessions).
 */

'use strict';

const SESSION_MAX_EVENTS_PER_SESSION = 2000;
const SESSION_MAX_SESSIONS_PER_TAB = 10;
const SESSION_MAX_SNAPSHOTS = 50;

/**
 * Handle an incoming session batch from a content script.
 * @param {object} batch - { sessionId, startTime, url, events }
 * @param {number} tabId - Source tab ID
 */
async function handleSessionBatch(batch, tabId) {
    if (!tabId || !batch || !batch.sessionId || !Array.isArray(batch.events)) return;

    const sessionId = batch.sessionId;
    const storageKey = `session_${tabId}_${sessionId}`;
    const indexKey = `session_index_${tabId}`;

    // Load existing session data
    const result = await chrome.storage.local.get([storageKey, indexKey]);
    const session = result[storageKey] || {
        sessionId,
        tabId,
        startTime: batch.startTime,
        url: batch.url,
        events: [],
        snapshots: [],
        lastUpdate: 0,
    };
    const index = result[indexKey] || {};

    // Separate snapshots from regular events
    for (const event of batch.events) {
        if (event.type === 'snapshot') {
            session.snapshots.push(event);
        } else {
            session.events.push(event);
        }
    }

    // Enforce per-session event limit (trim oldest)
    while (session.events.length > SESSION_MAX_EVENTS_PER_SESSION) {
        session.events.shift();
    }
    // Cap snapshots too
    while (session.snapshots.length > SESSION_MAX_SNAPSHOTS) {
        session.snapshots.shift();
    }

    session.lastUpdate = Date.now();
    session.url = batch.url || session.url;

    // Update index
    index[sessionId] = {
        startTime: session.startTime,
        lastUpdate: session.lastUpdate,
        url: session.url,
        eventCount: session.events.length,
        snapshotCount: session.snapshots.length,
    };

    // Enforce max sessions per tab (evict oldest)
    const sessionIds = Object.keys(index);
    if (sessionIds.length > SESSION_MAX_SESSIONS_PER_TAB) {
        const sorted = sessionIds.sort((a, b) => (index[a].lastUpdate || 0) - (index[b].lastUpdate || 0));
        while (Object.keys(index).length > SESSION_MAX_SESSIONS_PER_TAB) {
            const oldId = sorted.shift();
            delete index[oldId];
            await chrome.storage.local.remove(`session_${tabId}_${oldId}`);
        }
    }

    await chrome.storage.local.set({
        [storageKey]: session,
        [indexKey]: index,
    });

    // Notify sidepanel
    chrome.runtime.sendMessage({
        type: 'SESSION_UPDATED',
        tabId,
        sessionId,
    }).catch(() => {});
}

/**
 * Get session index for a tab.
 * @returns {{ [sessionId]: { startTime, lastUpdate, url, eventCount, snapshotCount } }}
 */
async function getSessionIndex(tabId) {
    if (!tabId) return {};
    const key = `session_index_${tabId}`;
    const result = await chrome.storage.local.get(key);
    return result[key] || {};
}

/**
 * Get a specific session's full data.
 */
async function getSession(tabId, sessionId) {
    if (!tabId || !sessionId) return null;
    const key = `session_${tabId}_${sessionId}`;
    const result = await chrome.storage.local.get(key);
    return result[key] || null;
}

/**
 * Get all sessions for a tab (metadata only, not full events).
 */
async function getTabSessions(tabId) {
    const index = await getSessionIndex(tabId);
    return Object.entries(index).map(([id, meta]) => ({
        sessionId: id,
        ...meta,
    }));
}

/**
 * Clear all sessions for a tab.
 */
async function clearTabSessions(tabId) {
    if (!tabId) return;
    const indexKey = `session_index_${tabId}`;
    const result = await chrome.storage.local.get(indexKey);
    const index = result[indexKey] || {};

    const keys = Object.keys(index).map(sid => `session_${tabId}_${sid}`);
    keys.push(indexKey);

    if (keys.length > 0) {
        await chrome.storage.local.remove(keys);
    }
}

/**
 * Clear all session data across all tabs.
 */
async function clearAllSessions() {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter(k => k.startsWith('session_'));
    if (keys.length > 0) {
        await chrome.storage.local.remove(keys);
    }
}

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener(async (tabId) => {
    await clearTabSessions(tabId);
});
