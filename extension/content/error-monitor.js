/**
 * ClawMark — ErrorMonitor Content Script (#63 Error Sentinel)
 *
 * Agent Embed perception layer: captures runtime errors on monitored pages
 * and forwards structured events to the service worker for storage + badge.
 *
 * Captures:
 *   - window.onerror / unhandledrejection
 *   - console.error (patched, React noise filtered)
 *   - fetch/XHR 4xx/5xx + timeout
 *   - Resource load failures (img, script, link)
 *   - Long tasks (>200ms via PerformanceObserver)
 *
 * #63 enhancements:
 *   - Fingerprint: hash(type + message + source + line) with 5s dedup window
 *   - Domain whitelist: only collect on configured allowed domains
 *   - Sensitive data sanitization: strip tokens, passwords, keys
 *   - React noise filtering for console.error
 *   - Fetch timeout detection
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
    const FETCH_TIMEOUT_MS = 30000;

    // Default allowed domains (coco ecosystem)
    const DEFAULT_ALLOWED_DOMAINS = [
        'coco.xyz', 'coco.site', 'hxa.net', 'hxa.one',
        'clawmark.dev', 'localhost',
    ];
    let allowedDomains = [...DEFAULT_ALLOWED_DOMAINS];

    // ── React noise patterns ───────────────────────────────────────

    const REACT_NOISE_PATTERNS = [
        /^Warning:/,
        /Each child in a list should have a unique/,
        /Cannot update a component/,
        /Cannot update during an existing state transition/,
        /findDOMNode is deprecated/,
        /Legacy context API has been detected/,
        /componentWillMount has been renamed/,
        /componentWillReceiveProps has been renamed/,
        /componentWillUpdate has been renamed/,
        /React does not recognize the .* prop/,
        /Invalid DOM property/,
        /Unknown event handler property/,
        /validateDOMNesting/,
    ];

    function isReactNoise(message) {
        return REACT_NOISE_PATTERNS.some(p => p.test(message));
    }

    // ── Sensitive data sanitization ────────────────────────────────

    const SENSITIVE_PATTERNS = [
        // Tokens & keys
        /(?:bearer|token|api[_-]?key|auth(?:orization)?|secret|password|passwd|pwd|credential)[\s]*[=:]\s*["']?[^\s"',}{)]+/gi,
        // JWT tokens
        /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
        // Generic hex/base64 secrets (32+ chars after key= or token=)
        /(?:key|token|secret|password)=[A-Za-z0-9+/=_-]{32,}/gi,
    ];

    function sanitize(text) {
        if (typeof text !== 'string') return text;
        let result = text;
        for (const pattern of SENSITIVE_PATTERNS) {
            result = result.replace(pattern, '[REDACTED]');
        }
        return result;
    }

    // ── Domain whitelist check ─────────────────────────────────────

    function isDomainAllowed() {
        const hostname = location.hostname;
        return allowedDomains.some(domain =>
            hostname === domain || hostname.endsWith('.' + domain)
        );
    }

    // ── Fingerprint dedup (hash of type+message+source+line) ──────

    const recentFingerprints = new Map(); // fingerprint → timestamp
    let errorCountThisMinute = 0;
    let minuteResetTimer = null;

    function hashFingerprint(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
        }
        return hash.toString(36);
    }

    function isDuplicate(type, message, source, line) {
        const raw = `${type}\0${message}\0${source || ''}\0${line || 0}`;
        const key = hashFingerprint(raw);
        const now = Date.now();
        if (recentFingerprints.has(key) && now - recentFingerprints.get(key) < DEDUP_WINDOW_MS) {
            return true;
        }
        recentFingerprints.set(key, now);
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

    // ── Emit ───────────────────────────────────────────────────────

    function emit(error) {
        if (!monitorEnabled) return;
        if (!isDomainAllowed()) return;
        if (errorLevelOnly && error.severity !== 'error') return;
        if (isDuplicate(error.type, error.message, error.source, error.line)) return;
        if (!rateLimitOk()) return;

        try {
            chrome.runtime.sendMessage({
                type: 'error:captured',
                payload: {
                    type: error.type,
                    message: sanitize(error.message),
                    stack: sanitize(error.stack || ''),
                    source: error.source || '',
                    line: error.line || 0,
                    severity: error.severity,
                    url: location.href,
                    timestamp: Date.now(),
                },
            });
        } catch {
            teardown();
        }
    }

    // ── Listeners ────────────────────────────────────────────────────

    // 1. window error event
    function onWindowError(event) {
        if (!(event instanceof ErrorEvent)) return;
        emit({
            type: 'js-error',
            message: event.message || String(event),
            stack: event.error?.stack || `${event.filename || ''}:${event.lineno || 0}:${event.colno || 0}`,
            source: event.filename || '',
            line: event.lineno || 0,
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

    // 3. console.error patch (with React noise filtering)
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

        if (isReactNoise(message)) return;

        emit({
            type: 'console-error',
            message: message.slice(0, 500),
            stack: (args.find(a => a instanceof Error))?.stack || '',
            severity: 'error',
        });
    }

    // 4. fetch intercept for 4xx/5xx + network failures + timeout
    const originalFetch = window.fetch;
    async function patchedFetch(...args) {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';

        // Add timeout via AbortController if caller didn't provide a signal
        let timeoutId;
        let controller;
        const init = args[1] || {};
        if (!init.signal) {
            controller = new AbortController();
            args[1] = { ...init, signal: controller.signal };
            timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        }

        let response;
        try {
            response = await originalFetch.apply(window, args);
        } catch (err) {
            if (timeoutId) clearTimeout(timeoutId);
            const isTimeout = controller && err.name === 'AbortError';
            emit({
                type: 'network-error',
                message: isTimeout
                    ? `fetch timeout (${FETCH_TIMEOUT_MS}ms): ${url.slice(0, 200)}`
                    : `fetch failed: ${err.message} — ${url.slice(0, 200)}`,
                stack: err.stack || '',
                severity: 'error',
            });
            throw err;
        }
        if (timeoutId) clearTimeout(timeoutId);

        if (response.status >= 400) {
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
        this.addEventListener('timeout', function () {
            emit({
                type: 'network-error',
                message: `XHR timeout — ${(this.__clawmarkUrl || '').slice(0, 200)}`,
                stack: '',
                severity: 'error',
            });
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
        document.addEventListener('error', onResourceError, true);
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
                agentEmbedAllowedDomains: DEFAULT_ALLOWED_DOMAINS,
            });
            errorLevelOnly = settings.passiveMonitorErrorOnly;
            allowedDomains = settings.agentEmbedAllowedDomains;
            const siteDisabled = settings.passiveMonitorDisabledSites.includes(location.hostname);
            return settings.passiveMonitorEnabled && !siteDisabled;
        } catch {
            return false;
        }
    }

    // React to settings changes
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        const relevant = changes.passiveMonitorEnabled
            || changes.passiveMonitorErrorOnly
            || changes.passiveMonitorDisabledSites
            || changes.agentEmbedAllowedDomains;
        if (relevant) {
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
