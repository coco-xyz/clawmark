/**
 * ClawMark — Error Storage Module (#43 sub-2, #55)
 *
 * Handles service worker side of passive QA monitoring:
 *   - Receives error:captured messages from ErrorMonitor content script
 *   - Stores errors per-tab in chrome.storage.local (ring buffer, cap 100)
 *   - Manages badge count (red badge on extension icon)
 *   - Dedup by fingerprint within storage window
 *   - Exposes getErrors / clearErrors for side panel consumption
 *
 * Storage key: `errors_<tabId>` → { errors: [...], count: N }
 * Badge: red background, count = total unread errors across all tabs.
 */

'use strict';

const ERROR_STORAGE_CAP = 100;     // max errors per tab
const ERROR_DEDUP_WINDOW_MS = 10000; // 10s dedup window in storage
const BADGE_COLOR = '#DC2626';      // red-600

// ── Storage helpers ──────────────────────────────────────────────

function storageKey(tabId) {
    return `errors_${tabId}`;
}

/**
 * Get stored errors for a tab.
 * @param {number} tabId
 * @returns {Promise<{errors: Array, count: number}>}
 */
async function getTabErrors(tabId) {
    const key = storageKey(tabId);
    const result = await chrome.storage.local.get({ [key]: { errors: [], count: 0 } });
    return result[key];
}

/**
 * Save errors for a tab.
 */
async function setTabErrors(tabId, data) {
    const key = storageKey(tabId);
    await chrome.storage.local.set({ [key]: data });
}

/**
 * Generate fingerprint for dedup.
 */
function fingerprint(error) {
    return `${error.type}:${(error.message || '').slice(0, 150)}`;
}

/**
 * Check if error is duplicate of recent entries.
 */
function isDuplicateInStorage(errors, newError) {
    const fp = fingerprint(newError);
    const cutoff = Date.now() - ERROR_DEDUP_WINDOW_MS;
    return errors.some(e => e._fingerprint === fp && e.timestamp > cutoff);
}

// ── Core: handle incoming error ──────────────────────────────────

/**
 * Process an error:captured message from content script.
 * @param {object} payload - Error payload from ErrorMonitor
 * @param {number} tabId - Source tab ID
 */
async function handleCapturedError(payload, tabId) {
    if (!tabId) return;

    const data = await getTabErrors(tabId);
    const fp = fingerprint(payload);

    // Dedup check
    if (isDuplicateInStorage(data.errors, payload)) return;

    // Build stored error entry
    const entry = {
        id: `${tabId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: payload.type,
        message: payload.message || '',
        stack: payload.stack || '',
        url: payload.url || '',
        severity: payload.severity || 'error',
        timestamp: payload.timestamp || Date.now(),
        _fingerprint: fp,
        read: false,
    };

    // Append to ring buffer (cap at ERROR_STORAGE_CAP)
    data.errors.push(entry);
    if (data.errors.length > ERROR_STORAGE_CAP) {
        data.errors = data.errors.slice(-ERROR_STORAGE_CAP);
    }
    data.count = data.errors.filter(e => !e.read).length;

    await setTabErrors(tabId, data);
    await updateBadge();

    // Notify side panel that errors changed
    try {
        chrome.runtime.sendMessage({ type: 'ERRORS_UPDATED', tabId }).catch(() => {});
    } catch {
        // Side panel not open — ignore
    }
}

// ── Badge management ─────────────────────────────────────────────

/**
 * Update the extension badge with total unread error count.
 */
async function updateBadge() {
    const allStorage = await chrome.storage.local.get(null);
    let total = 0;
    for (const [key, val] of Object.entries(allStorage)) {
        if (key.startsWith('errors_') && val && typeof val.count === 'number') {
            total += val.count;
        }
    }

    if (total > 0) {
        const text = total > 99 ? '99+' : String(total);
        await chrome.action.setBadgeText({ text });
        await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
    } else {
        await chrome.action.setBadgeText({ text: '' });
    }
}

// ── API for side panel ───────────────────────────────────────────

/**
 * Get all errors for a specific tab.
 * @param {number} tabId
 * @returns {Promise<Array>} List of error entries
 */
async function getErrors(tabId) {
    const data = await getTabErrors(tabId);
    return data.errors;
}

/**
 * Get errors for all tabs (for Errors tab overview).
 * @returns {Promise<Object>} Map of tabId → errors array
 */
async function getAllErrors() {
    const allStorage = await chrome.storage.local.get(null);
    const result = {};
    for (const [key, val] of Object.entries(allStorage)) {
        if (key.startsWith('errors_') && val && Array.isArray(val.errors)) {
            const tabId = key.replace('errors_', '');
            result[tabId] = val.errors;
        }
    }
    return result;
}

/**
 * Clear errors for a specific tab.
 */
async function clearErrors(tabId) {
    await setTabErrors(tabId, { errors: [], count: 0 });
    await updateBadge();
}

/**
 * Clear all stored errors (all tabs).
 */
async function clearAllErrors() {
    const allStorage = await chrome.storage.local.get(null);
    const keysToRemove = Object.keys(allStorage).filter(k => k.startsWith('errors_'));
    if (keysToRemove.length > 0) {
        await chrome.storage.local.remove(keysToRemove);
    }
    await chrome.action.setBadgeText({ text: '' });
}

/**
 * Mark errors as read for a tab.
 */
async function markErrorsRead(tabId) {
    const data = await getTabErrors(tabId);
    data.errors.forEach(e => { e.read = true; });
    data.count = 0;
    await setTabErrors(tabId, data);
    await updateBadge();
}

// ── Tab cleanup ──────────────────────────────────────────────────

/**
 * Clean up storage when a tab is closed.
 */
function setupTabCleanup() {
    chrome.tabs.onRemoved.addListener(async (tabId) => {
        const key = storageKey(tabId);
        await chrome.storage.local.remove(key);
        await updateBadge();
    });
}

// ── Init ─────────────────────────────────────────────────────────

setupTabCleanup();
