/**
 * ClawMark — NetworkMonitor Content Script (#66)
 *
 * Captures network activity as PerceptionEvents for the Agent Channel.
 * Intercepts fetch() and XMLHttpRequest to monitor:
 *   - Failed requests (4xx/5xx status codes)
 *   - CORS errors (opaque responses, TypeError on fetch)
 *   - Slow requests (exceeding configurable threshold)
 *   - Network failures (DNS, timeout, connection refused)
 *
 * Events conform to the PerceptionEvent schema defined in the PRD.
 * Dispatched to background SW via chrome.runtime.sendMessage.
 *
 * NOTE: Runs in the content script isolated world. Captures requests made
 * by other content scripts (e.g. inject.js). Page-originated requests
 * require a MAIN world bridge (planned for Phase 2).
 *
 * Patches are always-installed once enabled; disable sets a flag so the
 * patches pass through without emitting. This avoids breaking the
 * monkey-patch chain when error-monitor.js also patches fetch/XHR.
 */

'use strict';

(() => {
    if (window.__clawmarkNetworkMonitor) return;
    window.__clawmarkNetworkMonitor = true;

    // ── Config ─────────────────────────────────────────────────────────

    let enabled = false;
    let patchesInstalled = false;
    const DEDUP_WINDOW_MS = 5000;
    const RATE_LIMIT_PER_MIN = 50;
    const SLOW_REQUEST_THRESHOLD_MS = 3000;
    const FINGERPRINT_MAP_MAX = 100;

    // Sensitive query param names to strip from URLs
    const SENSITIVE_PARAMS = /^(token|key|secret|password|passwd|auth|code|session|access_token|refresh_token|api_key|apikey|credential|sig|signature)$/i;

    // ── State ──────────────────────────────────────────────────────────

    const recentFingerprints = new Map();
    let eventCountThisMinute = 0;
    let minuteResetTimer = null;

    // ── Helpers ────────────────────────────────────────────────────────

    // NOTE: Duplicated in privacy-filter.js. This script may load before
    // privacy-filter.js so it keeps its own copy for independence.
    function sanitizeUrl(rawUrl) {
        try {
            const u = new URL(rawUrl, location.origin);
            for (const key of [...u.searchParams.keys()]) {
                if (SENSITIVE_PARAMS.test(key)) {
                    u.searchParams.set(key, '[REDACTED]');
                }
            }
            return u.toString();
        } catch {
            return rawUrl;
        }
    }

    function isDuplicate(fingerprint) {
        const now = Date.now();
        if (recentFingerprints.has(fingerprint) &&
            now - recentFingerprints.get(fingerprint) < DEDUP_WINDOW_MS) {
            return true;
        }
        recentFingerprints.set(fingerprint, now);
        if (recentFingerprints.size > FINGERPRINT_MAP_MAX) {
            for (const [k, t] of recentFingerprints) {
                if (now - t > DEDUP_WINDOW_MS) recentFingerprints.delete(k);
            }
        }
        return false;
    }

    function rateLimitOk() {
        if (!minuteResetTimer) {
            minuteResetTimer = setTimeout(() => {
                eventCountThisMinute = 0;
                minuteResetTimer = null;
            }, 60000);
        }
        return ++eventCountThisMinute <= RATE_LIMIT_PER_MIN;
    }

    function severityFromStatus(status) {
        if (status >= 500) return 'critical';
        if (status >= 400) return 'warning';
        return 'info';
    }

    function emit(event) {
        if (!enabled) return;
        const fp = `${event.channel}:${event.summary}`.slice(0, 200);
        if (isDuplicate(fp)) return;
        if (!rateLimitOk()) return;

        try {
            chrome.runtime.sendMessage({
                type: 'perception:event',
                payload: event,
            });
        } catch {
            enabled = false;
        }
    }

    function buildPerceptionEvent(severity, summary, detail) {
        return {
            channel: 'network',
            severity,
            timestamp: Date.now(),
            url: sanitizeUrl(location.href),
            summary,
            detail,
            context: {},
        };
    }

    // ── Fetch intercept ────────────────────────────────────────────────

    const prevFetch = window.fetch;

    async function patchedFetch(...args) {
        if (!enabled) return prevFetch.apply(window, args);

        const startTime = Date.now();
        const rawUrl = typeof args[0] === 'string'
            ? args[0]
            : args[0]?.url || '';
        const method = (args[1]?.method || (args[0]?.method) || 'GET').toUpperCase();
        const safeUrl = sanitizeUrl(rawUrl);
        const urlShort = safeUrl.slice(0, 200);

        let response;
        try {
            response = await prevFetch.apply(window, args);
        } catch (err) {
            const isCors = err.message && /failed to fetch|cors|network/i.test(err.message);
            emit(buildPerceptionEvent(
                'critical',
                isCors
                    ? `CORS/network error: ${method} ${urlShort}`
                    : `Fetch failed: ${err.message} — ${method} ${urlShort}`,
                {
                    method,
                    url: safeUrl,
                    error: err.message,
                    type: isCors ? 'cors' : 'network-failure',
                    duration: Date.now() - startTime,
                }
            ));
            throw err;
        }

        const duration = Date.now() - startTime;

        if (response.status >= 400) {
            emit(buildPerceptionEvent(
                severityFromStatus(response.status),
                `${response.status} ${response.statusText} — ${method} ${urlShort}`,
                {
                    method,
                    url: safeUrl,
                    status: response.status,
                    statusText: response.statusText,
                    duration,
                    type: 'http-error',
                }
            ));
        }

        if (duration > SLOW_REQUEST_THRESHOLD_MS && response.status < 400) {
            emit(buildPerceptionEvent(
                'warning',
                `Slow request: ${duration}ms — ${method} ${urlShort}`,
                {
                    method,
                    url: safeUrl,
                    status: response.status,
                    duration,
                    type: 'slow-request',
                }
            ));
        }

        return response;
    }

    // ── XHR intercept ──────────────────────────────────────────────────

    const prevXHROpen = XMLHttpRequest.prototype.open;
    const prevXHRSend = XMLHttpRequest.prototype.send;

    function patchedXHROpen(method, url, ...rest) {
        this.__cmNetMethod = (method || 'GET').toUpperCase();
        this.__cmNetUrl = String(url);
        this.__cmNetStart = null;
        return prevXHROpen.call(this, method, url, ...rest);
    }

    function patchedXHRSend(...args) {
        this.__cmNetStart = Date.now();

        this.addEventListener('loadend', function () {
            if (!enabled) return;
            const duration = this.__cmNetStart ? Date.now() - this.__cmNetStart : 0;
            const method = this.__cmNetMethod || 'GET';
            const safeUrl = sanitizeUrl(this.__cmNetUrl || '');
            const urlShort = safeUrl.slice(0, 200);

            if (this.status === 0 && this.readyState === 4) {
                emit(buildPerceptionEvent(
                    'critical',
                    `XHR network error: ${method} ${urlShort}`,
                    {
                        method,
                        url: safeUrl,
                        status: 0,
                        duration,
                        type: 'network-failure',
                    }
                ));
            } else if (this.status >= 400) {
                emit(buildPerceptionEvent(
                    severityFromStatus(this.status),
                    `${this.status} ${this.statusText} — XHR ${method} ${urlShort}`,
                    {
                        method,
                        url: safeUrl,
                        status: this.status,
                        statusText: this.statusText,
                        duration,
                        type: 'http-error',
                    }
                ));
            }

            if (duration > SLOW_REQUEST_THRESHOLD_MS && this.status > 0 && this.status < 400) {
                emit(buildPerceptionEvent(
                    'warning',
                    `Slow XHR: ${duration}ms — ${method} ${urlShort}`,
                    {
                        method,
                        url: safeUrl,
                        status: this.status,
                        duration,
                        type: 'slow-request',
                    }
                ));
            }
        }, { once: true });

        return prevXHRSend.apply(this, args);
    }

    // ── Setup ──────────────────────────────────────────────────────────

    function installPatches() {
        if (patchesInstalled) return;
        patchesInstalled = true;
        window.fetch = patchedFetch;
        XMLHttpRequest.prototype.open = patchedXHROpen;
        XMLHttpRequest.prototype.send = patchedXHRSend;
    }

    // ── Settings & Startup ─────────────────────────────────────────────

    async function loadSettings() {
        try {
            const settings = await chrome.storage.sync.get({
                agentPerceptionEnabled: false,
                agentPerceptionDisabledSites: [],
            });
            const siteDisabled = settings.agentPerceptionDisabledSites.includes(location.hostname);
            return settings.agentPerceptionEnabled && !siteDisabled;
        } catch {
            return false;
        }
    }

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        if (changes.agentPerceptionEnabled || changes.agentPerceptionDisabledSites) {
            loadSettings().then(shouldEnable => {
                if (shouldEnable && !enabled) {
                    enabled = true;
                    installPatches();
                } else if (!shouldEnable && enabled) {
                    enabled = false;
                    // Patches stay installed but pass through when enabled=false
                }
            });
        }
    });

    async function init() {
        const shouldEnable = await loadSettings();
        if (shouldEnable) {
            enabled = true;
            installPatches();
        }
    }

    init();
})();
