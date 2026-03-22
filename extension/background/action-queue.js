/**
 * ClawMark — Action Queue (#77)
 *
 * Background service worker module that manages the action execution queue.
 * Routes actions from the server/dashboard to the correct tab's content
 * script (ActionExecutor) and collects results.
 *
 * Storage: chrome.storage.local with key `actions_{tabId}`
 *
 * Imported by service-worker.js (importScripts or top-level).
 */

'use strict';

// ── Config ──────────────────────────────────────────────────────────

const ACTION_QUEUE_CAP = 50;            // max queued actions per tab
const ACTION_HISTORY_CAP = 100;         // max completed actions (global)

// ── Storage helpers ─────────────────────────────────────────────────

async function getActionQueue(tabId) {
    const key = `actions_${tabId}`;
    const result = await chrome.storage.local.get(key);
    return result[key] || [];
}

async function setActionQueue(tabId, queue) {
    const key = `actions_${tabId}`;
    await chrome.storage.local.set({ [key]: queue.slice(-ACTION_QUEUE_CAP) });
}

async function getActionHistory() {
    const result = await chrome.storage.local.get('action_history');
    return result.action_history || [];
}

async function setActionHistory(history) {
    await chrome.storage.local.set({
        action_history: history.slice(-ACTION_HISTORY_CAP),
    });
}

// ── Core ────────────────────────────────────────────────────────────

/**
 * Dispatch an action to a tab's ActionExecutor content script.
 * Returns the ActionResult from the content script.
 *
 * @param {number} tabId  Target browser tab
 * @param {object} action  AgentAction object
 * @returns {Promise<object>}  ActionResult
 */
async function dispatchAction(tabId, action) {
    if (!tabId) throw new Error('tabId is required');
    if (!action?.actionId || !action?.type) {
        throw new Error('action must have actionId and type');
    }

    // Record in queue
    const queue = await getActionQueue(tabId);
    const entry = {
        ...action,
        tabId,
        dispatchedAt: Date.now(),
        status: 'dispatching',
    };
    queue.push(entry);
    await setActionQueue(tabId, queue);

    // Send to content script
    let result;
    try {
        result = await chrome.tabs.sendMessage(tabId, {
            type: 'action:execute',
            payload: action,
        });
    } catch (err) {
        result = {
            actionId: action.actionId,
            success: false,
            error: `Failed to reach content script: ${err.message}`,
            timestamp: Date.now(),
        };
    }

    // Update queue entry with result
    const updatedQueue = await getActionQueue(tabId);
    const idx = updatedQueue.findIndex(a => a.actionId === action.actionId);
    if (idx !== -1) {
        updatedQueue[idx].status = result.success ? 'completed' : 'failed';
        updatedQueue[idx].result = result;
        updatedQueue[idx].completedAt = Date.now();
        await setActionQueue(tabId, updatedQueue);
    }

    // Append to global history
    const history = await getActionHistory();
    history.push({
        actionId: action.actionId,
        type: action.type,
        tabId,
        success: result.success,
        error: result.error,
        dispatchedAt: entry.dispatchedAt,
        completedAt: Date.now(),
    });
    await setActionHistory(history);

    return result;
}

/**
 * Get pending/completed actions for a tab.
 */
async function getTabActions(tabId) {
    return getActionQueue(tabId);
}

/**
 * Get global action history.
 */
async function getGlobalActionHistory() {
    return getActionHistory();
}

/**
 * Clear action queue for a tab.
 */
async function clearTabActions(tabId) {
    const key = `actions_${tabId}`;
    await chrome.storage.local.remove(key);
}

/**
 * Clear all action queues and history.
 */
async function clearAllActions() {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter(k => k.startsWith('actions_'));
    keys.push('action_history');
    await chrome.storage.local.remove(keys);
}

// Clean up when tab closes
chrome.tabs.onRemoved.addListener((tabId) => {
    clearTabActions(tabId).catch(() => {});
});
