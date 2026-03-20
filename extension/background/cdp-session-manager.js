/**
 * ClawMark — CDP Session Manager (#81)
 *
 * Manages chrome.debugger sessions for CDP (Chrome DevTools Protocol)
 * integration. Handles attach/detach lifecycle, auto re-attach on
 * navigation, and clean detach on tab close or extension unload.
 *
 * Only one CDP session per tab. Sessions are opt-in: attach only when
 * CDP mode is explicitly enabled for a tab.
 *
 * Imported by service-worker.js via importScripts.
 */

'use strict';

// ── State ───────────────────────────────────────────────────────────

// Map<tabId, { attached: boolean, version: string, domains: Set<string>, attachedAt: number }>
const cdpSessions = new Map();

const CDP_PROTOCOL_VERSION = '1.3';

// ── Core ────────────────────────────────────────────────────────────

/**
 * Attach to a tab's debugger session.
 * @param {number} tabId
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function cdpAttach(tabId) {
    if (!tabId) return { success: false, error: 'tabId is required' };

    // Already attached?
    const existing = cdpSessions.get(tabId);
    if (existing?.attached) {
        return { success: true, alreadyAttached: true };
    }

    try {
        await chrome.debugger.attach({ tabId }, CDP_PROTOCOL_VERSION);

        cdpSessions.set(tabId, {
            attached: true,
            version: CDP_PROTOCOL_VERSION,
            domains: new Set(),
            attachedAt: Date.now(),
        });

        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

/**
 * Detach from a tab's debugger session.
 * @param {number} tabId
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function cdpDetach(tabId) {
    if (!tabId) return { success: false, error: 'tabId is required' };

    const session = cdpSessions.get(tabId);
    if (!session?.attached) {
        cdpSessions.delete(tabId);
        return { success: true, alreadyDetached: true };
    }

    try {
        await chrome.debugger.detach({ tabId });
    } catch {
        // Already detached or tab closed — ignore
    }

    cdpSessions.delete(tabId);
    return { success: true };
}

/**
 * Send a CDP command to an attached tab.
 * @param {number} tabId
 * @param {string} method  CDP method (e.g. "Runtime.evaluate", "DOM.getDocument")
 * @param {object} [params]  CDP command parameters
 * @returns {Promise<object>}  CDP result
 */
async function cdpSendCommand(tabId, method, params = {}) {
    const session = cdpSessions.get(tabId);
    if (!session?.attached) {
        throw new Error(`No CDP session for tab ${tabId}`);
    }

    try {
        const result = await chrome.debugger.sendCommand({ tabId }, method, params);
        return result;
    } catch (err) {
        // If session was lost, clean up
        if (/not attached|no target/i.test(err.message)) {
            cdpSessions.delete(tabId);
        }
        throw err;
    }
}

/**
 * Check if a tab has an active CDP session.
 * @param {number} tabId
 * @returns {boolean}
 */
function cdpIsAttached(tabId) {
    return cdpSessions.get(tabId)?.attached === true;
}

/**
 * Get info about all active CDP sessions.
 * @returns {Array<{ tabId: number, attachedAt: number, domains: string[] }>}
 */
function cdpGetSessions() {
    const result = [];
    for (const [tabId, session] of cdpSessions) {
        if (session.attached) {
            result.push({
                tabId,
                attachedAt: session.attachedAt,
                domains: [...session.domains],
            });
        }
    }
    return result;
}

/**
 * Detach all active CDP sessions (used during extension shutdown).
 */
async function cdpDetachAll() {
    const promises = [];
    for (const tabId of cdpSessions.keys()) {
        promises.push(cdpDetach(tabId));
    }
    await Promise.allSettled(promises);
}

// ── Auto re-attach on navigation ────────────────────────────────────

// When a tab navigates, the debugger session may drop. Re-attach if
// the tab was previously attached.
const _pendingReattach = new Set();

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') {
        const session = cdpSessions.get(tabId);
        if (session?.attached) {
            // Mark session as potentially detached (Chrome may or may not drop it)
            _pendingReattach.add(tabId);
        }
        return;
    }

    if (changeInfo.status !== 'complete') return;
    if (!_pendingReattach.has(tabId)) return;
    _pendingReattach.delete(tabId);

    // Verify session is still alive by sending a harmless command
    chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: '1',
        returnByValue: true,
    }).catch(() => {
        // Session dropped — re-attach
        const session = cdpSessions.get(tabId);
        if (!session) return;

        cdpSessions.delete(tabId);
        cdpAttach(tabId).then(result => {
            if (result.success && session.domains.size > 0) {
                // Re-enable previously subscribed domains
                for (const domain of session.domains) {
                    cdpEnableDomain(tabId, domain).catch(() => {});
                }
            }
        }).catch(() => {});
    });
});

// ── Clean detach on tab close ───────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
    cdpSessions.delete(tabId);
    _pendingReattach.delete(tabId);
});

// ── Debugger detach event ───────────────────────────────────────────

chrome.debugger.onDetach.addListener((source, reason) => {
    const tabId = source.tabId;
    if (tabId) {
        cdpSessions.delete(tabId);
    }
});

// ── Domain subscription helpers ─────────────────────────────────────

/**
 * Enable a CDP domain on an attached tab.
 * @param {number} tabId
 * @param {string} domain  e.g. "Network", "Runtime", "DOM", "Page"
 * @returns {Promise<object>}
 */
async function cdpEnableDomain(tabId, domain) {
    const result = await cdpSendCommand(tabId, `${domain}.enable`);
    const session = cdpSessions.get(tabId);
    if (session) session.domains.add(domain);
    return result;
}

/**
 * Disable a CDP domain on an attached tab.
 * @param {number} tabId
 * @param {string} domain
 * @returns {Promise<object>}
 */
async function cdpDisableDomain(tabId, domain) {
    const result = await cdpSendCommand(tabId, `${domain}.disable`);
    const session = cdpSessions.get(tabId);
    if (session) session.domains.delete(domain);
    return result;
}
