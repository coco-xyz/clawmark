/**
 * ClawMark — CDP Tab Targeter (#81)
 *
 * Identifies and resolves target tabs for CDP session attachment.
 * Supports targeting by tab ID, URL exact match, and URL pattern (glob).
 *
 * Imported by service-worker.js via importScripts.
 */

'use strict';

// ── Core ────────────────────────────────────────────────────────────

/**
 * Resolve a tab target to a concrete tab ID.
 *
 * @param {object} target  Target specification
 * @param {number} [target.tabId]      Direct tab ID
 * @param {string} [target.url]        Exact URL match
 * @param {string} [target.urlPattern] URL pattern with * wildcards
 * @returns {Promise<{ tabId: number, tab: chrome.tabs.Tab } | { error: string }>}
 */
async function resolveTabTarget(target) {
    if (!target) return { error: 'target is required' };

    // Direct tab ID
    if (target.tabId) {
        try {
            const tab = await chrome.tabs.get(target.tabId);
            return { tabId: tab.id, tab };
        } catch {
            return { error: `Tab ${target.tabId} not found` };
        }
    }

    // URL exact match
    if (target.url) {
        const tabs = await chrome.tabs.query({ url: target.url });
        if (tabs.length === 0) {
            return { error: `No tab found with URL: ${target.url}` };
        }
        // Prefer the active tab if multiple match
        const active = tabs.find(t => t.active) || tabs[0];
        return { tabId: active.id, tab: active };
    }

    // URL pattern (glob)
    if (target.urlPattern) {
        const tabs = await chrome.tabs.query({ url: target.urlPattern });
        if (tabs.length === 0) {
            return { error: `No tab matches pattern: ${target.urlPattern}` };
        }
        const active = tabs.find(t => t.active) || tabs[0];
        return { tabId: active.id, tab: active };
    }

    return { error: 'target must have tabId, url, or urlPattern' };
}

/**
 * List all tabs that could be targeted (non-chrome:// tabs).
 * @returns {Promise<Array<{ tabId: number, url: string, title: string, active: boolean }>>}
 */
async function listTargetableTabs() {
    const allTabs = await chrome.tabs.query({});
    return allTabs
        .filter(t => t.url && /^https?:\/\//.test(t.url))
        .map(t => ({
            tabId: t.id,
            url: t.url,
            title: t.title || '',
            active: t.active,
            windowId: t.windowId,
        }));
}
