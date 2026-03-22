/**
 * ClawMark — Perception Event Storage (#66)
 *
 * Stores PerceptionEvents from NetworkMonitor and ConsoleProxy content
 * scripts. Events are kept in chrome.storage.local per-tab with a ring
 * buffer. When the Agent Channel server API is available (#67/#68),
 * events will also be forwarded upstream.
 *
 * Storage key: `perception_${tabId}`
 * Each entry conforms to the PerceptionEvent schema from the PRD.
 */

'use strict';

const PERCEPTION_MAX_PER_TAB = 200;
const PERCEPTION_DEDUP_WINDOW_MS = 10000;

/**
 * Handle an incoming PerceptionEvent from a content script.
 * @param {object} event - PerceptionEvent payload
 * @param {number} tabId - Source tab ID
 */
async function handlePerceptionEvent(event, tabId) {
    if (!tabId || !event) return;

    const key = `perception_${tabId}`;
    const result = await chrome.storage.local.get(key);
    const events = result[key] || [];

    // Dedup: same channel + summary within window
    const fp = `${event.channel}:${event.summary}`.slice(0, 200);
    const now = Date.now();
    const isDup = events.some(e =>
        e._fingerprint === fp &&
        now - e.timestamp < PERCEPTION_DEDUP_WINDOW_MS
    );
    if (isDup) return;

    // Add metadata
    const entry = {
        ...event,
        id: `${tabId}-${now}-${Math.random().toString(36).slice(2, 8)}`,
        _fingerprint: fp,
    };

    events.push(entry);

    // Ring buffer — trim oldest
    while (events.length > PERCEPTION_MAX_PER_TAB) {
        events.shift();
    }

    await chrome.storage.local.set({ [key]: events });

    // Notify sidepanel / popup
    chrome.runtime.sendMessage({ type: 'PERCEPTION_UPDATED', tabId }).catch(() => {});
}

/**
 * Get all perception events for a tab.
 */
function stripInternal(events) {
    return events.map(({ _fingerprint, ...rest }) => rest);
}

async function getPerceptionEvents(tabId) {
    if (!tabId) return [];
    const key = `perception_${tabId}`;
    const result = await chrome.storage.local.get(key);
    return stripInternal(result[key] || []);
}

/**
 * Get perception events across all tabs.
 */
async function getAllPerceptionEvents() {
    const all = await chrome.storage.local.get(null);
    const result = {};
    for (const [key, value] of Object.entries(all)) {
        if (key.startsWith('perception_') && Array.isArray(value)) {
            const tabId = key.replace('perception_', '');
            result[tabId] = stripInternal(value);
        }
    }
    return result;
}

/**
 * Clear perception events for a tab.
 */
async function clearPerceptionEvents(tabId) {
    if (!tabId) return;
    await chrome.storage.local.remove(`perception_${tabId}`);
}

/**
 * Clear all perception events.
 */
async function clearAllPerceptionEvents() {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter(k => k.startsWith('perception_'));
    if (keys.length > 0) {
        await chrome.storage.local.remove(keys);
    }
}

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener(async (tabId) => {
    await chrome.storage.local.remove(`perception_${tabId}`);
});
