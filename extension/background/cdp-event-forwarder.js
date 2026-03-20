/**
 * ClawMark — CDP Event Forwarder (#81)
 *
 * Subscribes to CDP domains (Network, Runtime, DOM, Page) and forwards
 * events to the background service worker's internal event system.
 * Events are stored in a ring buffer per tab for retrieval via message API.
 *
 * Imported by service-worker.js via importScripts.
 */

'use strict';

// ── Config ──────────────────────────────────────────────────────────

const CDP_EVENT_BUFFER_CAP = 500;      // max CDP events per tab
const CDP_SUPPORTED_DOMAINS = ['Network', 'Runtime', 'DOM', 'Page'];

// ── Storage ─────────────────────────────────────────────────────────

// In-memory ring buffer per tab (not persisted to storage.local to
// avoid thrashing — CDP events are high-frequency)
// Map<tabId, Array<{ domain, method, params, timestamp }>>
const cdpEventBuffers = new Map();

function getEventBuffer(tabId) {
    if (!cdpEventBuffers.has(tabId)) {
        cdpEventBuffers.set(tabId, []);
    }
    return cdpEventBuffers.get(tabId);
}

// ── Event handler ───────────────────────────────────────────────────

/**
 * Handle a CDP event from chrome.debugger.onEvent.
 * Buffers the event and optionally broadcasts to interested listeners.
 */
function handleCdpEvent(source, method, params) {
    const tabId = source.tabId;
    if (!tabId) return;

    // Only process events from active CDP sessions
    if (!cdpIsAttached(tabId)) return;

    // Parse domain from method (e.g. "Network.requestWillBeSent" → "Network")
    const dotIdx = method.indexOf('.');
    const domain = dotIdx > 0 ? method.slice(0, dotIdx) : method;

    if (!CDP_SUPPORTED_DOMAINS.includes(domain)) return;

    const event = {
        domain,
        method,
        params: sanitizeCdpEvent(domain, method, params),
        timestamp: Date.now(),
    };

    // Ring buffer
    const buffer = getEventBuffer(tabId);
    buffer.push(event);
    if (buffer.length > CDP_EVENT_BUFFER_CAP) {
        buffer.splice(0, buffer.length - CDP_EVENT_BUFFER_CAP);
    }
}

/**
 * Sanitize CDP event params to strip sensitive data before storage.
 * - Network: strip cookie values, auth headers
 * - Runtime: strip large script sources
 */
function sanitizeCdpEvent(domain, method, params) {
    if (!params) return params;

    // Shallow copy to avoid mutating original
    const safe = { ...params };

    if (domain === 'Network') {
        // Strip cookie values from request/response headers
        if (safe.request?.headers) {
            safe.request = { ...safe.request, headers: redactHeaders(safe.request.headers) };
        }
        if (safe.response?.headers) {
            safe.response = { ...safe.response, headers: redactHeaders(safe.response.headers) };
        }
        // Strip request body (may contain credentials)
        if (safe.request?.postData && safe.request.postData.length > 1000) {
            safe.request = { ...safe.request, postData: '[TRUNCATED]' };
        }
    }

    if (domain === 'Runtime') {
        // Truncate large script sources
        if (safe.scriptSource && safe.scriptSource.length > 2000) {
            safe.scriptSource = safe.scriptSource.slice(0, 2000) + '...[TRUNCATED]';
        }
        // Truncate large console messages
        if (safe.args && Array.isArray(safe.args)) {
            safe.args = safe.args.map(arg => {
                if (arg.value && typeof arg.value === 'string' && arg.value.length > 500) {
                    return { ...arg, value: arg.value.slice(0, 500) + '...[TRUNCATED]' };
                }
                return arg;
            });
        }
    }

    return safe;
}

const SENSITIVE_HEADERS = /^(cookie|set-cookie|authorization|x-api-key|x-auth-token|proxy-authorization)$/i;

function redactHeaders(headers) {
    if (!headers || typeof headers !== 'object') return headers;
    const redacted = {};
    for (const [key, value] of Object.entries(headers)) {
        redacted[key] = SENSITIVE_HEADERS.test(key) ? '[REDACTED]' : value;
    }
    return redacted;
}

// ── Register listener ───────────────────────────────────────────────

chrome.debugger.onEvent.addListener(handleCdpEvent);

// ── Retrieval API ───────────────────────────────────────────────────

/**
 * Get buffered CDP events for a tab.
 * @param {number} tabId
 * @param {object} [filter]
 * @param {string} [filter.domain]  Filter by CDP domain
 * @param {number} [filter.since]   Only events after this timestamp
 * @param {number} [filter.limit]   Max events to return (default 100)
 * @returns {Array<object>}
 */
function getCdpEvents(tabId, filter = {}) {
    const buffer = cdpEventBuffers.get(tabId) || [];

    let events = buffer;

    if (filter.domain) {
        events = events.filter(e => e.domain === filter.domain);
    }
    if (filter.since) {
        events = events.filter(e => e.timestamp > filter.since);
    }

    const limit = filter.limit || 100;
    return events.slice(-limit);
}

/**
 * Clear CDP event buffer for a tab.
 */
function clearCdpEvents(tabId) {
    cdpEventBuffers.delete(tabId);
}

/**
 * Clear all CDP event buffers.
 */
function clearAllCdpEvents() {
    cdpEventBuffers.clear();
}

// Clean up on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
    cdpEventBuffers.delete(tabId);
});

// ── High-level: attach + enable domains ─────────────────────────────

/**
 * Start a full CDP session: attach + enable specified domains.
 * @param {number} tabId
 * @param {string[]} [domains]  Domains to enable (default: all supported)
 * @returns {Promise<{ success: boolean, domains: string[], error?: string }>}
 */
async function cdpStartSession(tabId, domains) {
    const domainsToEnable = (domains || CDP_SUPPORTED_DOMAINS)
        .filter(d => CDP_SUPPORTED_DOMAINS.includes(d));

    const attachResult = await cdpAttach(tabId);
    if (!attachResult.success) {
        return { success: false, domains: [], error: attachResult.error };
    }

    const enabled = [];
    const errors = [];

    for (const domain of domainsToEnable) {
        try {
            await cdpEnableDomain(tabId, domain);
            enabled.push(domain);
        } catch (err) {
            errors.push(`${domain}: ${err.message}`);
        }
    }

    return {
        success: true,
        domains: enabled,
        errors: errors.length > 0 ? errors : undefined,
    };
}

/**
 * Stop a CDP session: disable domains + detach.
 * @param {number} tabId
 * @returns {Promise<{ success: boolean }>}
 */
async function cdpStopSession(tabId) {
    // Disable domains first (best effort)
    const session = cdpSessions.get(tabId);
    if (session?.domains) {
        for (const domain of session.domains) {
            try {
                await cdpSendCommand(tabId, `${domain}.disable`);
            } catch {
                // Ignore — may already be detached
            }
        }
    }

    // Clear event buffer
    clearCdpEvents(tabId);

    // Detach
    return cdpDetach(tabId);
}
