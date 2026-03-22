/**
 * ClawMark — CDP Command Whitelist (#82)
 *
 * Maintains a strict whitelist of allowed CDP commands.
 * Commands not on the whitelist are blocked by default.
 * Admin can extend/restrict via chrome.storage.sync.
 *
 * Imported by service-worker.js via importScripts.
 */

'use strict';

// ── Default whitelist ────────────────────────────────────────────────
// Read-only, observational commands only. Organized by CDP domain.

const CDP_DEFAULT_WHITELIST = new Set([
    // DOM — read-only tree inspection
    'DOM.enable',
    'DOM.disable',
    'DOM.getDocument',
    'DOM.querySelector',
    'DOM.querySelectorAll',
    'DOM.describeNode',
    'DOM.getBoxModel',
    'DOM.getOuterHTML',
    'DOM.getAttributes',
    'DOM.getNodeForLocation',
    'DOM.resolveNode',

    // CSS — computed style inspection
    'CSS.enable',
    'CSS.disable',
    'CSS.getComputedStyleForNode',
    'CSS.getMatchedStylesForNode',
    'CSS.getInlineStylesForNode',

    // Page — screenshots and info
    'Page.enable',
    'Page.disable',
    'Page.captureScreenshot',
    'Page.getFrameTree',
    'Page.getLayoutMetrics',
    'Page.getNavigationHistory',

    // Network — monitoring (enable/disable only)
    'Network.enable',
    'Network.disable',
    'Network.getCookies',
    'Network.getResponseBody',

    // Runtime — read-only evaluation
    'Runtime.enable',
    'Runtime.disable',
    'Runtime.evaluate',
    'Runtime.callFunctionOn',
    'Runtime.getProperties',
    'Runtime.globalLexicalScopeNames',

    // Console — log monitoring
    'Console.enable',
    'Console.disable',

    // Overlay — highlight elements (visual, no mutation)
    'Overlay.enable',
    'Overlay.disable',
    'Overlay.highlightNode',
    'Overlay.hideHighlight',

    // Accessibility — tree inspection
    'Accessibility.enable',
    'Accessibility.disable',
    'Accessibility.getFullAXTree',
    'Accessibility.getPartialAXTree',
]);

// ── Explicit blocklist ───────────────────────────────────────────────
// Even if admin adds these to custom whitelist, they are always blocked.

const CDP_ALWAYS_BLOCKED = new Set([
    // Navigation — use action layer instead
    'Page.navigate',
    'Page.reload',
    'Page.navigateToHistoryEntry',

    // Debugger manipulation
    'Debugger.enable',
    'Debugger.disable',
    'Debugger.pause',
    'Debugger.resume',
    'Debugger.setBreakpoint',
    'Debugger.setBreakpointByUrl',
    'Debugger.removeBreakpoint',

    // Target manipulation — security sensitive
    'Target.createTarget',
    'Target.closeTarget',
    'Target.attachToTarget',
    'Target.detachFromTarget',
    'Target.createBrowserContext',
    'Target.disposeBrowserContext',

    // Browser — process-level control
    'Browser.close',
    'Browser.crashGpuProcess',

    // Security bypass
    'Security.disable',
    'Security.setIgnoreCertificateErrors',

    // Service worker manipulation
    'ServiceWorker.unregister',
    'ServiceWorker.skipWaiting',

    // Storage deletion
    'Storage.clearDataForOrigin',
    'Storage.clearCookies',

    // DOM mutation — use action layer instead
    'DOM.setNodeValue',
    'DOM.setAttributeValue',
    'DOM.setOuterHTML',
    'DOM.removeNode',
    'DOM.moveTo',
    'DOM.setNodeName',

    // Input — use action layer instead
    'Input.dispatchKeyEvent',
    'Input.dispatchMouseEvent',
    'Input.dispatchTouchEvent',
    'Input.insertText',

    // Dangerous network interception
    'Fetch.enable',
    'Fetch.fulfillRequest',
    'Fetch.continueRequest',
    'Fetch.failRequest',
    'Network.setExtraHTTPHeaders',
    'Network.emulateNetworkConditions',
    'Network.setCacheDisabled',

    // Emulation
    'Emulation.setDeviceMetricsOverride',
    'Emulation.setGeolocationOverride',
]);

// ── Runtime whitelist (loaded from storage) ──────────────────────────

let _customAllowed = new Set();
let _customBlocked = new Set();
let _whitelistLoaded = false;

async function _loadCustomWhitelist() {
    try {
        const { cdpCustomAllowed = [], cdpCustomBlocked = [] } =
            await chrome.storage.sync.get({ cdpCustomAllowed: [], cdpCustomBlocked: [] });
        _customAllowed = new Set(cdpCustomAllowed);
        _customBlocked = new Set(cdpCustomBlocked);
        _whitelistLoaded = true;
    } catch {
        _whitelistLoaded = true;
    }
}

// Load on startup
_loadCustomWhitelist();

// Reload on storage change
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && (changes.cdpCustomAllowed || changes.cdpCustomBlocked)) {
        _loadCustomWhitelist();
    }
});

// ── Public API ───────────────────────────────────────────────────────

/**
 * Check if a CDP command is allowed.
 * @param {string} method  CDP method (e.g. "DOM.getDocument")
 * @returns {{ allowed: boolean, reason?: string }}
 */
function cdpWhitelistCheck(method) {
    if (!method || typeof method !== 'string') {
        return { allowed: false, reason: 'Invalid method' };
    }

    // Always-blocked takes priority over everything
    if (CDP_ALWAYS_BLOCKED.has(method)) {
        return { allowed: false, reason: `Command always blocked: ${method}` };
    }

    // Custom blocked by admin
    if (_customBlocked.has(method)) {
        return { allowed: false, reason: `Command blocked by admin: ${method}` };
    }

    // Default whitelist or custom allowed
    if (CDP_DEFAULT_WHITELIST.has(method) || _customAllowed.has(method)) {
        return { allowed: true };
    }

    return { allowed: false, reason: `Command not in whitelist: ${method}` };
}

/**
 * Get current whitelist state for debugging/UI.
 * @returns {{ defaultAllowed: string[], alwaysBlocked: string[], customAllowed: string[], customBlocked: string[] }}
 */
function cdpWhitelistInfo() {
    return {
        defaultAllowed: [...CDP_DEFAULT_WHITELIST],
        alwaysBlocked: [...CDP_ALWAYS_BLOCKED],
        customAllowed: [..._customAllowed],
        customBlocked: [..._customBlocked],
    };
}
