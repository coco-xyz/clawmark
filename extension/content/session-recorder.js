/**
 * ClawMark — SessionRecorder Content Script (#72)
 *
 * Records user interaction sequences for session replay. Captures clicks,
 * inputs, scrolls, navigation, and errors with timestamps and context.
 *
 * Smart snapshots: DOM context captured at page load, before errors, and
 * after significant user pauses (>3s).
 *
 * Session segmentation: 30-minute idle timeout starts a new session.
 * Events dispatched to background SW in batches (every 5s or 50 events).
 *
 * Privacy: Uses privacy-filter.js to mask passwords, credit cards, and PII.
 *
 * NOTE: Runs in isolated world (same limitation as network-monitor.js
 * and console-proxy.js). DOM events (click, scroll, error) DO cross the
 * world boundary, so user interactions are captured correctly.
 */

'use strict';

(() => {
    if (window.__clawmarkSessionRecorder) return;
    window.__clawmarkSessionRecorder = true;

    // ── Config ─────────────────────────────────────────────────────────

    let enabled = false;
    let listenersInstalled = false;

    const BATCH_INTERVAL_MS = 5000;
    const BATCH_MAX_EVENTS = 50;
    const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
    const PAUSE_THRESHOLD_MS = 3000; // user pause → snapshot
    const SCROLL_THROTTLE_MS = 500;
    const MAX_SNAPSHOT_HTML_LENGTH = 50000;
    const MAX_INPUT_VALUE_LENGTH = 200;
    const MAX_SNAPSHOTS_PER_MINUTE = 10;

    // ── State ──────────────────────────────────────────────────────────

    let sessionId = null;
    let sessionStartTime = 0;
    let eventBuffer = [];
    let batchTimer = null;
    let idleTimer = null;
    let pauseTimer = null;
    let lastActivityTime = 0;
    let lastScrollTime = 0;
    let eventCount = 0;
    let snapshotCountThisMinute = 0;
    let snapshotResetTimer = null;

    // Privacy filter — cached at init (privacy-filter.js loads first per manifest order)
    let _priv = null;
    function priv() {
        if (_priv) return _priv;
        _priv = window.__clawmarkPrivacy || {
            maskInputValue: (_, v) => v,
            maskText: (t) => t,
            safeSelector: () => '',
            sanitizeUrl: (u) => u,
            isSensitiveInput: () => false,
            MASK: '••••',
        };
        return _priv;
    }

    // ── Session management ─────────────────────────────────────────────

    function generateId() {
        return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }

    function startSession() {
        sessionId = generateId();
        sessionStartTime = Date.now();
        eventBuffer = [];
        eventCount = 0;
        lastActivityTime = Date.now();

        recordEvent('navigation', {
            action: 'session-start',
            url: priv().sanitizeUrl(location.href),
            title: document.title,
            referrer: document.referrer ? priv().sanitizeUrl(document.referrer) : '',
            viewport: { width: window.innerWidth, height: window.innerHeight },
        });

        captureSnapshot('page-load');
        resetIdleTimer();
    }

    function endSession(reason) {
        if (!sessionId) return;
        recordEvent('navigation', {
            action: 'session-end',
            reason,
            duration: Date.now() - sessionStartTime,
            eventCount,
        });
        flushBatch();
        sessionId = null;
    }

    function resetIdleTimer() {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            endSession('idle-timeout');
        }, SESSION_IDLE_TIMEOUT_MS);
    }

    function resetPauseTimer() {
        if (pauseTimer) clearTimeout(pauseTimer);
        pauseTimer = setTimeout(() => {
            captureSnapshot('user-pause');
        }, PAUSE_THRESHOLD_MS);
    }

    function onActivity() {
        lastActivityTime = Date.now();
        resetIdleTimer();
        resetPauseTimer();

        // If session ended due to idle, start new one
        if (!sessionId && enabled) {
            try {
                startSession();
            } catch {
                enabled = false;
                cleanup();
            }
        }
    }

    // ── Event recording ────────────────────────────────────────────────

    function recordEvent(type, data) {
        if (!sessionId) return;
        eventCount++;
        eventBuffer.push({
            type,
            timestamp: Date.now(),
            data,
        });

        if (eventBuffer.length >= BATCH_MAX_EVENTS) {
            flushBatch();
        }
    }

    function flushBatch() {
        if (eventBuffer.length === 0 || !sessionId) return;

        const batch = {
            sessionId,
            startTime: sessionStartTime,
            url: priv().sanitizeUrl(location.href),
            events: eventBuffer.splice(0),
        };

        try {
            chrome.runtime.sendMessage({
                type: 'session:batch',
                payload: batch,
            });
        } catch {
            enabled = false;
            cleanup();
        }
    }

    /**
     * Final flush on page unload. Uses sendMessage (best-effort) since
     * sendBeacon requires a server URL and we route through the SW.
     * The background session-storage marks sessions without a session-end
     * event as 'abandoned' after tab close.
     */
    function flushOnUnload() {
        if (eventBuffer.length === 0 || !sessionId) return;
        try {
            chrome.runtime.sendMessage({
                type: 'session:batch',
                payload: {
                    sessionId,
                    startTime: sessionStartTime,
                    url: priv().sanitizeUrl(location.href),
                    events: eventBuffer.splice(0),
                },
            });
        } catch {
            // Best effort — page is unloading
        }
    }

    function startBatchTimer() {
        if (batchTimer) return;
        batchTimer = setInterval(() => {
            if (eventBuffer.length > 0) flushBatch();
        }, BATCH_INTERVAL_MS);
    }

    function stopBatchTimer() {
        if (batchTimer) { clearInterval(batchTimer); batchTimer = null; }
    }

    // ── Smart snapshots ────────────────────────────────────────────────

    /**
     * Sanitize an HTML subtree for safe storage: mask sensitive input
     * values and strip hidden input values.
     */
    function sanitizeHtml(html) {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');

            // Mask sensitive input values
            for (const input of doc.querySelectorAll('input, textarea')) {
                if (priv().isSensitiveInput(input) || input.type === 'hidden') {
                    input.setAttribute('value', priv().MASK);
                } else if (input.value) {
                    input.setAttribute('value', priv().maskText(input.value.slice(0, 100)));
                }
                // Strip textarea content
                if (input.tagName === 'TEXTAREA') {
                    input.textContent = priv().isSensitiveInput(input) ? priv().MASK : priv().maskText((input.textContent || '').slice(0, 100));
                }
            }

            // Strip data-* attributes that may contain PII
            for (const el of doc.querySelectorAll('[data-email], [data-phone], [data-user], [data-token]')) {
                for (const attr of [...el.attributes]) {
                    if (attr.name.startsWith('data-') && /email|phone|user|token|password|secret/i.test(attr.name)) {
                        el.setAttribute(attr.name, '[REDACTED]');
                    }
                }
            }

            return doc.body?.innerHTML?.slice(0, MAX_SNAPSHOT_HTML_LENGTH) || '';
        } catch {
            return priv().maskText(html);
        }
    }

    function captureSnapshot(trigger, targetEl) {
        if (!sessionId) return;

        // Rate-limit snapshots
        if (!snapshotResetTimer) {
            snapshotResetTimer = setTimeout(() => {
                snapshotCountThisMinute = 0;
                snapshotResetTimer = null;
            }, 60000);
        }
        if (++snapshotCountThisMinute > MAX_SNAPSHOTS_PER_MINUTE) return;

        let html = '';
        try {
            if (targetEl) {
                const context = targetEl.closest('form, section, article, main, [role="main"]') || targetEl.parentElement;
                if (context) {
                    html = sanitizeHtml(context.outerHTML);
                }
            } else {
                // Lightweight page snapshot: head meta + body structure
                const meta = Array.from(document.querySelectorAll('meta[name], meta[property]'))
                    .slice(0, 10)
                    .map(m => `<meta ${m.name ? 'name' : 'property'}="${m.name || m.getAttribute('property')}" content="${(m.content || '').slice(0, 100)}">`);
                const bodyClasses = document.body?.className || '';
                html = `<head>${meta.join('')}<title>${document.title}</title></head><body class="${bodyClasses}"><!-- ${document.body?.children?.length || 0} children --></body>`;
            }
        } catch {
            html = '<error>snapshot-failed</error>';
        }

        recordEvent('snapshot', {
            trigger,
            html,
            url: priv().sanitizeUrl(location.href),
            title: document.title,
            selector: targetEl ? priv().safeSelector(targetEl) : '',
        });
    }

    // ── DOM Event Listeners ────────────────────────────────────────────

    function onClick(e) {
        if (!enabled) return;
        onActivity();
        const el = e.target;
        recordEvent('click', {
            selector: priv().safeSelector(el),
            tag: el.tagName?.toLowerCase() || '',
            text: priv().maskText((el.textContent || '').trim().slice(0, 50)),
            href: el.href ? priv().sanitizeUrl(el.href) : undefined,
            x: e.clientX,
            y: e.clientY,
        });
    }

    function onInput(e) {
        if (!enabled) return;
        onActivity();
        const el = e.target;
        if (!el || !el.tagName) return;

        const isSensitive = priv().isSensitiveInput(el);
        recordEvent('input', {
            selector: priv().safeSelector(el),
            tag: el.tagName.toLowerCase(),
            inputType: el.type || 'text',
            name: el.name || '',
            value: isSensitive
                ? priv().MASK
                : priv().maskInputValue(el, (el.value || '').slice(0, MAX_INPUT_VALUE_LENGTH)),
            masked: isSensitive,
        });
    }

    function onScroll() {
        if (!enabled) return;
        const now = Date.now();
        if (now - lastScrollTime < SCROLL_THROTTLE_MS) return;
        lastScrollTime = now;
        onActivity();
        recordEvent('scroll', {
            x: window.scrollX,
            y: window.scrollY,
            maxY: document.documentElement.scrollHeight,
            viewportHeight: window.innerHeight,
        });
    }

    function onBeforeUnload() {
        if (!enabled || !sessionId) return;
        // Record end event and do best-effort flush
        recordEvent('navigation', {
            action: 'session-end',
            reason: 'navigation',
            duration: Date.now() - sessionStartTime,
            eventCount,
        });
        flushOnUnload();
        sessionId = null;
    }

    function onVisibilityChange() {
        if (!enabled || !sessionId) return;
        recordEvent('navigation', {
            action: 'visibility-change',
            hidden: document.hidden,
        });
        // Flush when tab becomes hidden (user may close tab next)
        if (document.hidden && eventBuffer.length > 0) {
            flushBatch();
        }
    }

    function onPopState() {
        if (!enabled) return;
        onActivity();
        recordEvent('navigation', {
            action: 'popstate',
            url: priv().sanitizeUrl(location.href),
            title: document.title,
        });
        captureSnapshot('navigation');
    }

    function onHashChange() {
        if (!enabled) return;
        onActivity();
        recordEvent('navigation', {
            action: 'hashchange',
            url: priv().sanitizeUrl(location.href),
        });
    }

    // ── Setup / Cleanup ────────────────────────────────────────────────

    function installListeners() {
        if (listenersInstalled) return;
        listenersInstalled = true;

        document.addEventListener('click', onClick, { capture: true, passive: true });
        document.addEventListener('input', onInput, { capture: true, passive: true });
        window.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('beforeunload', onBeforeUnload);
        window.addEventListener('visibilitychange', onVisibilityChange);
        window.addEventListener('popstate', onPopState);
        window.addEventListener('hashchange', onHashChange);

        // Error events cross the world boundary — captures page-originated errors
        window.addEventListener('error', (e) => {
            if (!enabled || !sessionId) return;
            recordEvent('error', {
                message: priv().maskText((e.message || '').slice(0, 300)),
                source: e.filename || '',
                line: e.lineno,
                col: e.colno,
            });
            // Resource errors (img/script) have element targets; runtime errors have window
            const targetEl = e.target?.tagName ? e.target : null;
            captureSnapshot('error', targetEl);
        });

        window.addEventListener('unhandledrejection', (e) => {
            if (!enabled || !sessionId) return;
            const reason = e.reason;
            recordEvent('error', {
                message: priv().maskText((reason?.message || String(reason)).slice(0, 300)),
                type: 'unhandled-rejection',
            });
            captureSnapshot('error');
        });
    }

    function cleanup() {
        stopBatchTimer();
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; }
        if (snapshotResetTimer) { clearTimeout(snapshotResetTimer); snapshotResetTimer = null; }
    }

    // ── Settings & Startup ─────────────────────────────────────────────

    async function loadSettings() {
        try {
            const settings = await chrome.storage.sync.get({
                agentPerceptionEnabled: false,
                sessionRecordingEnabled: true, // sub-toggle (only works if perception is on)
                agentPerceptionDisabledSites: [],
            });
            const siteDisabled = settings.agentPerceptionDisabledSites.includes(location.hostname);
            return settings.agentPerceptionEnabled && settings.sessionRecordingEnabled && !siteDisabled;
        } catch {
            return false;
        }
    }

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        if (changes.agentPerceptionEnabled || changes.sessionRecordingEnabled || changes.agentPerceptionDisabledSites) {
            loadSettings().then(shouldEnable => {
                if (shouldEnable && !enabled) {
                    enabled = true;
                    installListeners();
                    startSession();
                    startBatchTimer();
                } else if (!shouldEnable && enabled) {
                    enabled = false;
                    endSession('disabled');
                    cleanup();
                }
            });
        }
    });

    async function init() {
        const shouldEnable = await loadSettings();
        if (shouldEnable) {
            enabled = true;
            installListeners();
            startSession();
            startBatchTimer();
        }
    }

    init();
})();
