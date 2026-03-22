/**
 * ClawMark — CDP Safety Filter (#82)
 *
 * Inspects CDP command parameters for dangerous patterns.
 * Focused on Runtime.evaluate and Runtime.callFunctionOn, which
 * can execute arbitrary JS. Other commands are checked by the whitelist.
 *
 * Imported by service-worker.js via importScripts.
 */

'use strict';

// ── Patterns that indicate side effects in JS expressions ────────────

const SIDE_EFFECT_PATTERNS = [
    // DOM mutation
    /\.\s*(innerHTML|outerHTML|innerText|textContent)\s*=/,
    /\.\s*(setAttribute|removeAttribute|appendChild|removeChild|insertBefore|replaceChild|remove)\s*\(/,
    /\.\s*(insertAdjacentHTML|insertAdjacentElement|insertAdjacentText)\s*\(/,
    /document\s*\.\s*(write|writeln|createElement|createTextNode)\s*\(/,

    // Navigation / location
    /\b(window\s*\.\s*)?location\s*[.=]/,
    /\bwindow\s*\.\s*(open|close|navigate)\s*\(/,
    /\bhistory\s*\.\s*(pushState|replaceState|go|back|forward)\s*\(/,

    // Network requests
    /\bfetch\s*\(/,
    /\bnew\s+XMLHttpRequest\b/,
    /\b(xhr|request|req|http)\s*\.\s*(send|open)\s*\(/i,
    /\bnew\s+WebSocket\b/,
    /\bnew\s+EventSource\b/,
    /\bnavigator\s*\.\s*sendBeacon\s*\(/,

    // Script injection
    /\bdocument\s*\.\s*createElement\s*\(\s*['"`]script['"`]\s*\)/,
    /\beval\s*\(/,
    /\bnew\s+Function\s*\(/,
    /\bsetTimeout\s*\(/,
    /\bsetInterval\s*\(/,

    // Storage mutation
    /\b(localStorage|sessionStorage)\s*\.\s*(setItem|removeItem|clear)\s*\(/,
    /\bdocument\s*\.\s*cookie\s*=/,
    /\bindexedDB\s*\.\s*(open|deleteDatabase)\s*\(/,

    // Form submission / interaction (focus removed — common in read-only inspection;
    // throwOnSideEffect provides defense-in-depth for actual side effects)
    /\.\s*submit\s*\(\s*\)/,
    /\.\s*click\s*\(\s*\)/,

    // Event dispatch
    /\.\s*dispatchEvent\s*\(/,

    // Class/style mutation
    /\.\s*classList\s*\.\s*(add|remove|toggle|replace)\s*\(/,
    /\.\s*style\s*\.\s*\w+\s*=/,
];

// ── Safety check for Runtime.evaluate ────────────────────────────────

/**
 * Check if a Runtime.evaluate expression is safe (read-only).
 * @param {string} expression  JS expression to evaluate
 * @param {object} [options]
 * @param {boolean} [options.allowSideEffects=false]  Skip safety check
 * @returns {{ safe: boolean, reason?: string, pattern?: string }}
 */
function cdpSafetyCheckExpression(expression, options = {}) {
    if (options.allowSideEffects) {
        return { safe: true };
    }

    if (!expression || typeof expression !== 'string') {
        return { safe: false, reason: 'Expression is required' };
    }

    // Check each pattern
    for (const pattern of SIDE_EFFECT_PATTERNS) {
        if (pattern.test(expression)) {
            return {
                safe: false,
                reason: 'Expression contains potential side effects',
                pattern: pattern.source,
            };
        }
    }

    return { safe: true };
}

// ── Safety check for Runtime.callFunctionOn ──────────────────────────

/**
 * Check if a callFunctionOn declaration is safe.
 * @param {string} functionDeclaration
 * @param {object} [options]
 * @param {boolean} [options.allowSideEffects=false]
 * @returns {{ safe: boolean, reason?: string, pattern?: string }}
 */
function cdpSafetyCheckFunction(functionDeclaration, options = {}) {
    if (options.allowSideEffects) {
        return { safe: true };
    }

    if (!functionDeclaration || typeof functionDeclaration !== 'string') {
        return { safe: false, reason: 'Function declaration is required' };
    }

    for (const pattern of SIDE_EFFECT_PATTERNS) {
        if (pattern.test(functionDeclaration)) {
            return {
                safe: false,
                reason: 'Function contains potential side effects',
                pattern: pattern.source,
            };
        }
    }

    return { safe: true };
}

// ── Main safety gate ─────────────────────────────────────────────────

/**
 * Run safety checks on a CDP command + params.
 * Only Runtime.evaluate and Runtime.callFunctionOn get deep inspection.
 * @param {string} method
 * @param {object} params
 * @param {object} [options]
 * @param {boolean} [options.allowSideEffects=false]
 * @returns {{ safe: boolean, reason?: string }}
 */
function cdpSafetyCheck(method, params = {}, options = {}) {
    if (method === 'Runtime.evaluate') {
        if (!params.expression) {
            return { safe: false, reason: 'Runtime.evaluate requires expression parameter' };
        }
        return cdpSafetyCheckExpression(params.expression, options);
    }

    if (method === 'Runtime.callFunctionOn') {
        if (!params.functionDeclaration) {
            return { safe: false, reason: 'Runtime.callFunctionOn requires functionDeclaration parameter' };
        }
        return cdpSafetyCheckFunction(params.functionDeclaration, options);
    }

    // All other whitelisted commands are considered safe at the parameter level
    return { safe: true };
}

// ── Audit log ────────────────────────────────────────────────────────

const CDP_AUDIT_LOG_CAP = 200;
const _cdpAuditLog = [];

/**
 * Record a CDP command execution in the audit log.
 * @param {object} entry
 * @param {number} entry.tabId
 * @param {string} entry.method
 * @param {object} [entry.params]  Sanitized params (no secrets)
 * @param {boolean} entry.allowed
 * @param {string} [entry.reason]  Block reason if not allowed
 * @param {boolean} [entry.success]  Execution success (if allowed)
 * @param {number} [entry.durationMs]
 */
function cdpAuditLog(entry) {
    _cdpAuditLog.push({
        ...entry,
        timestamp: Date.now(),
    });
    // Batch trim: only trim when 25% over cap to avoid frequent splices.
    // Single splice operation is atomic w.r.t. the array state.
    if (_cdpAuditLog.length > CDP_AUDIT_LOG_CAP * 1.25) {
        _cdpAuditLog.splice(0, _cdpAuditLog.length - CDP_AUDIT_LOG_CAP);
    }
}

/**
 * Get audit log entries.
 * @param {object} [filter]
 * @param {number} [filter.tabId]
 * @param {number} [filter.since]
 * @param {number} [filter.limit=50]
 * @returns {Array<object>}
 */
function cdpGetAuditLog(filter = {}) {
    let entries = _cdpAuditLog;

    if (filter.tabId) {
        entries = entries.filter(e => e.tabId === filter.tabId);
    }
    if (filter.since) {
        entries = entries.filter(e => e.timestamp > filter.since);
    }

    const limit = filter.limit || 50;
    return entries.slice(-limit);
}

/**
 * Clear the audit log.
 */
function cdpClearAuditLog() {
    _cdpAuditLog.length = 0;
}
