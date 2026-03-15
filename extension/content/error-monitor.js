/**
 * ClawMark — ErrorMonitor Content Script (#43 sub-1, #54)
 *
 * Passive error monitoring: captures runtime errors on any page and
 * forwards them to the service worker for storage + badge update.
 *
 * Captures:
 *   - window.onerror / unhandledrejection
 *   - console.error (patched)
 *   - fetch/XHR 4xx/5xx responses
 *   - Resource load failures (img, script, link)
 *   - Long tasks (>200ms via PerformanceObserver)
 *
 * Dedup: fingerprint-based, same fingerprint within 5s is skipped.
 * Rate limit: max 30 errors per minute per tab.
 */

'use strict';

(() => {
    if (window.__clawmarkErrorMonitor) return;
    window.__clawmarkErrorMonitor = true;

    // ── Config (overridden by chrome.storage.sync values) ────────────

    let monitorEnabled = false;       // off by default until settings loaded
    let errorLevelOnly = true;        // only capture errors, not warnings
    const DEDUP_WINDOW_MS = 5000;
    const RATE_LIMIT_PER_MIN = 30;
    const LONG_TASK_THRESHOLD_MS = 200;

    // ── State ────────────────────────────────────────────────────────

    const recentFingerprints = new Map(); // fingerprint → timestamp
    let errorCountThisMinute = 0;
    let minuteResetTimer = null;

    // ── Helpers ──────────────────────────────────────────────────────

    function isDuplicate(type, message) {
        const key = `${type}:${message}`.slice(0, 200);
        const now = Date.now();
        if (recentFingerprints.has(key) && now - recentFingerprints.get(key) < DEDUP_WINDOW_MS) {
            return true;
        }
        recentFingerprints.set(key, now);
        // Prune old entries
        if (recentFingerprints.size > 100) {
            for (const [k, t] of recentFingerprints) {
                if (now - t > DEDUP_WINDOW_MS) recentFingerprints.delete(k);
            }
        }
        return false;
    }

    function rateLimitOk() {
        if (!minuteResetTimer) {
            minuteResetTimer = setTimeout(() => {
                errorCountThisMinute = 0;
                minuteResetTimer = null;
            }, 60000);
        }
        return ++errorCountThisMinute <= RATE_LIMIT_PER_MIN;
    }

    function emit(error) {
        if (!monitorEnabled) return;
        if (errorLevelOnly && error.severity !== 'error') return;
        if (isDuplicate(error.type, error.message)) return;
        if (!rateLimitOk()) return;

        try {
            chrome.runtime.sendMessage({
                type: 'error:captured',
                payload: {
                    ...error,
                    url: location.href,
                    timestamp: Date.now(),
                },
            });
        } catch {
            // Extension context invalidated — stop monitoring
            teardown();
        }
    }

    // ── Listeners ────────────────────────────────────────────────────

    // 1. window error event (addEventListener receives ErrorEvent, not 5 args)
    function onWindowError(event) {
        if (!(event instanceof ErrorEvent)) return;
        emit({
            type: 'js-error',
            message: event.message || String(event),
            stack: event.error?.stack || `${event.filename || ''}:${event.lineno || 0}:${event.colno || 0}`,
            source: event.filename || '',
            severity: 'error',
        });
    }

    // 2. Unhandled promise rejections
    function onUnhandledRejection(event) {
        const reason = event.reason;
        emit({
            type: 'unhandled-rejection',
            message: reason?.message || String(reason),
            stack: reason?.stack || '',
            severity: 'error',
        });
    }

    // 3. console.error patch
    const originalConsoleError = console.error;
    function patchedConsoleError(...args) {
        originalConsoleError.apply(console, args);
        const message = args.map(a => {
            if (a instanceof Error) return a.message;
            if (typeof a === 'object') {
                try { return JSON.stringify(a).slice(0, 200); } catch { return String(a); }
            }
            return String(a);
        }).join(' ');
        emit({
            type: 'console-error',
            message: message.slice(0, 500),
            stack: (args.find(a => a instanceof Error))?.stack || '',
            severity: 'error',
        });
    }

    // 4. fetch intercept for 4xx/5xx + network failures
    const originalFetch = window.fetch;
    async function patchedFetch(...args) {
        let response;
        try {
            response = await originalFetch.apply(window, args);
        } catch (err) {
            const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
            emit({
                type: 'network-error',
                message: `fetch failed: ${err.message} — ${url.slice(0, 200)}`,
                stack: err.stack || '',
                severity: 'error',
            });
            throw err; // re-throw so caller sees the original error
        }
        if (response.status >= 400) {
            const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
            emit({
                type: 'network-error',
                message: `${response.status} ${response.statusText} — ${url.slice(0, 200)}`,
                stack: '',
                severity: response.status >= 500 ? 'error' : 'warning',
            });
        }
        return response;
    }

    // 5. XHR intercept for 4xx/5xx
    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;

    function patchedXHROpen(method, url, ...rest) {
        this.__clawmarkUrl = `${method} ${url}`;
        return originalXHROpen.call(this, method, url, ...rest);
    }

    function patchedXHRSend(...args) {
        this.addEventListener('load', function () {
            if (this.status >= 400) {
                emit({
                    type: 'network-error',
                    message: `${this.status} ${this.statusText} — ${(this.__clawmarkUrl || '').slice(0, 200)}`,
                    stack: '',
                    severity: this.status >= 500 ? 'error' : 'warning',
                });
            }
        }, { once: true });
        return originalXHRSend.apply(this, args);
    }

    // 6. Resource load failures (img, script, link)
    function onResourceError(event) {
        const el = event.target;
        if (!(el instanceof HTMLImageElement || el instanceof HTMLScriptElement || el instanceof HTMLLinkElement)) return;
        const src = el.src || el.href || '';
        emit({
            type: 'resource-error',
            message: `Failed to load ${el.tagName.toLowerCase()}: ${src.slice(0, 200)}`,
            stack: '',
            severity: 'warning',
        });
    }

    // 7. Long tasks (PerformanceObserver)
    let longTaskObserver = null;
    function setupLongTaskObserver() {
        if (typeof PerformanceObserver === 'undefined') return;
        try {
            longTaskObserver = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    if (entry.duration > LONG_TASK_THRESHOLD_MS) {
                        emit({
                            type: 'long-task',
                            message: `Long task: ${Math.round(entry.duration)}ms`,
                            stack: '',
                            severity: 'warning',
                        });
                    }
                }
            });
            longTaskObserver.observe({ type: 'longtask', buffered: false });
        } catch {
            // PerformanceObserver longtask not supported
        }
    }

    // ── Setup / Teardown ─────────────────────────────────────────────

    function setup() {
        window.addEventListener('error', onWindowError);
        window.addEventListener('unhandledrejection', onUnhandledRejection);
        console.error = patchedConsoleError;
        window.fetch = patchedFetch;
        XMLHttpRequest.prototype.open = patchedXHROpen;
        XMLHttpRequest.prototype.send = patchedXHRSend;
        document.addEventListener('error', onResourceError, true); // capture phase
        setupLongTaskObserver();
    }

    function teardown() {
        window.removeEventListener('error', onWindowError);
        window.removeEventListener('unhandledrejection', onUnhandledRejection);
        console.error = originalConsoleError;
        window.fetch = originalFetch;
        XMLHttpRequest.prototype.open = originalXHROpen;
        XMLHttpRequest.prototype.send = originalXHRSend;
        document.removeEventListener('error', onResourceError, true);
        if (longTaskObserver) { longTaskObserver.disconnect(); longTaskObserver = null; }
        if (minuteResetTimer) { clearTimeout(minuteResetTimer); minuteResetTimer = null; }
    }

    // ── Settings & Startup ───────────────────────────────────────────

    async function loadSettings() {
        try {
            const settings = await chrome.storage.sync.get({
                passiveMonitorEnabled: false,
                passiveMonitorErrorOnly: true,
                passiveMonitorDisabledSites: [],
            });
            errorLevelOnly = settings.passiveMonitorErrorOnly;
            const siteDisabled = settings.passiveMonitorDisabledSites.includes(location.hostname);
            return settings.passiveMonitorEnabled && !siteDisabled;
        } catch {
            return false;
        }
    }

    // React to settings changes
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        if (changes.passiveMonitorEnabled || changes.passiveMonitorErrorOnly || changes.passiveMonitorDisabledSites) {
            loadSettings().then(enabled => {
                if (enabled && !monitorEnabled) {
                    monitorEnabled = true;
                    setup();
                } else if (!enabled && monitorEnabled) {
                    monitorEnabled = false;
                    teardown();
                }
            });
        }
    });

    async function init() {
        const enabled = await loadSettings();
        if (enabled) {
            monitorEnabled = true;
            setup();
        }
    }

    init();
})();
