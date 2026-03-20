/**
 * ClawMark — ConsoleProxy Content Script (#66)
 *
 * Captures console output as PerceptionEvents for the Agent Channel.
 * Intercepts console.error and console.warn to produce structured events.
 *
 * Events conform to the PerceptionEvent schema defined in the PRD.
 * Dispatched to background SW via chrome.runtime.sendMessage.
 *
 * NOTE: Runs in the content script isolated world. Captures console calls
 * from other content scripts. Page-originated console calls require a
 * MAIN world bridge (planned for Phase 2).
 *
 * Patches are always-installed once enabled; disable sets a flag so the
 * patches pass through without emitting. This avoids breaking the
 * monkey-patch chain when error-monitor.js also patches console.error.
 */

'use strict';

(() => {
    if (window.__clawmarkConsoleProxy) return;
    window.__clawmarkConsoleProxy = true;

    // ── Config ─────────────────────────────────────────────────────────

    let enabled = false;
    let patchesInstalled = false;
    const DEDUP_WINDOW_MS = 3000;
    const RATE_LIMIT_PER_MIN = 60;
    const MAX_MESSAGE_LENGTH = 1000;
    const FINGERPRINT_MAP_MAX = 100;

    // Keys to redact when serializing objects
    const SENSITIVE_KEYS = /^(password|passwd|secret|token|api_key|apikey|authorization|credential|session_id|cookie|private_key|access_token|refresh_token)$/i;

    // ── State ──────────────────────────────────────────────────────────

    const recentFingerprints = new Map();
    let eventCountThisMinute = 0;
    let minuteResetTimer = null;

    // ── Helpers ────────────────────────────────────────────────────────

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

    function redactValue(key, value) {
        if (typeof key === 'string' && SENSITIVE_KEYS.test(key)) return '[REDACTED]';
        return value;
    }

    function formatArgs(args) {
        return args.map(a => {
            if (a instanceof Error) return `${a.name}: ${a.message}`;
            if (typeof a === 'object' && a !== null) {
                try {
                    return JSON.stringify(a, redactValue).slice(0, 300);
                } catch { return String(a); }
            }
            return String(a);
        }).join(' ').slice(0, MAX_MESSAGE_LENGTH);
    }

    function extractStack(args) {
        for (const a of args) {
            if (a instanceof Error && a.stack) return a.stack;
        }
        try {
            const stack = new Error().stack || '';
            return stack.split('\n').slice(3).join('\n');
        } catch {
            return '';
        }
    }

    function sanitizeUrl(rawUrl) {
        try {
            const u = new URL(rawUrl);
            const sensitive = /^(token|key|secret|password|auth|code|session|access_token|refresh_token|api_key)$/i;
            for (const key of [...u.searchParams.keys()]) {
                if (sensitive.test(key)) u.searchParams.set(key, '[REDACTED]');
            }
            return u.toString();
        } catch {
            return rawUrl;
        }
    }

    function emit(event) {
        if (!enabled) return;
        const fp = `${event.channel}:${event.detail.level}:${event.summary}`.slice(0, 200);
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

    // ── Console patches ────────────────────────────────────────────────

    const prevError = console.error;
    const prevWarn = console.warn;

    function patchedError(...args) {
        prevError.apply(console, args);
        if (!enabled) return;
        const message = formatArgs(args);
        emit({
            channel: 'console',
            severity: 'critical',
            timestamp: Date.now(),
            url: sanitizeUrl(location.href),
            summary: `console.error: ${message.slice(0, 120)}`,
            detail: {
                level: 'error',
                message,
                stack: extractStack(args),
                argCount: args.length,
            },
            context: {},
        });
    }

    function patchedWarn(...args) {
        prevWarn.apply(console, args);
        if (!enabled) return;
        const message = formatArgs(args);
        emit({
            channel: 'console',
            severity: 'warning',
            timestamp: Date.now(),
            url: sanitizeUrl(location.href),
            summary: `console.warn: ${message.slice(0, 120)}`,
            detail: {
                level: 'warn',
                message,
                stack: extractStack(args),
                argCount: args.length,
            },
            context: {},
        });
    }

    // ── Setup ──────────────────────────────────────────────────────────

    function installPatches() {
        if (patchesInstalled) return;
        patchesInstalled = true;
        console.error = patchedError;
        console.warn = patchedWarn;
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
