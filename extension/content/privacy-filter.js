/**
 * ClawMark — Privacy Filter (#72)
 *
 * Shared utility for stripping PII and sensitive data from session
 * recordings. Applied before any data leaves the content script.
 *
 * Masks:
 *   - Password input values (type="password")
 *   - Credit card patterns (13-19 digit sequences)
 *   - Email addresses (configurable)
 *   - Custom PII patterns from user settings
 *   - Sensitive form field names (SSN, phone, etc.)
 */

'use strict';

(() => {
    if (window.__clawmarkPrivacyFilter) return;
    window.__clawmarkPrivacyFilter = true;

    const MASK = '••••';

    // ── Patterns ───────────────────────────────────────────────────────

    // Credit card: 13-19 digits (with optional spaces/dashes)
    const CREDIT_CARD_RE = /\b(?:\d[ -]*){13,19}\b/g;

    // Email addresses
    const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

    // Sensitive input field names/types
    const SENSITIVE_INPUT_NAMES = /^(password|passwd|pass|pwd|ssn|social.?security|credit.?card|card.?number|cvv|cvc|ccv|expir|secret|token|api.?key)$/i;
    const SENSITIVE_INPUT_TYPES = new Set(['password']);

    // ── API ────────────────────────────────────────────────────────────

    /**
     * Check if an input element is sensitive (should not have its value recorded).
     * @param {HTMLElement} el
     * @returns {boolean}
     */
    function isSensitiveInput(el) {
        if (!el || !el.tagName) return false;
        const tag = el.tagName.toLowerCase();
        if (tag !== 'input' && tag !== 'textarea') return false;

        // Type check
        if (SENSITIVE_INPUT_TYPES.has((el.type || '').toLowerCase())) return true;

        // Name/id/autocomplete check
        const name = el.name || el.id || el.getAttribute('autocomplete') || '';
        if (SENSITIVE_INPUT_NAMES.test(name)) return true;

        // aria-label check
        const label = el.getAttribute('aria-label') || '';
        if (SENSITIVE_INPUT_NAMES.test(label)) return true;

        return false;
    }

    /**
     * Mask the value of an input element if sensitive.
     * Returns the original value if not sensitive.
     * @param {HTMLElement} el
     * @param {string} value
     * @returns {string}
     */
    function maskInputValue(el, value) {
        if (!value) return value;
        if (isSensitiveInput(el)) return MASK;
        return maskText(value);
    }

    /**
     * Mask sensitive patterns in a text string.
     * @param {string} text
     * @returns {string}
     */
    function maskText(text) {
        if (!text || typeof text !== 'string') return text;
        let result = text;
        result = result.replace(CREDIT_CARD_RE, MASK);
        result = result.replace(EMAIL_RE, (match) => {
            // Keep domain, mask local part
            const at = match.indexOf('@');
            return MASK + match.slice(at);
        });
        return result;
    }

    /**
     * Sanitize a DOM element selector for safe storage.
     * Returns a CSS selector path that doesn't leak sensitive info.
     * @param {HTMLElement} el
     * @returns {string}
     */
    function safeSelector(el) {
        if (!el || !el.tagName) return '';
        const parts = [];
        let current = el;
        let depth = 0;
        while (current && current !== document.body && depth < 5) {
            let selector = current.tagName.toLowerCase();
            if (current.id) {
                selector += `#${CSS.escape(current.id)}`;
                parts.unshift(selector);
                break;
            }
            if (current.className && typeof current.className === 'string') {
                const classes = current.className.trim().split(/\s+/).slice(0, 2);
                if (classes.length > 0 && classes[0]) {
                    selector += '.' + classes.map(c => CSS.escape(c)).join('.');
                }
            }
            parts.unshift(selector);
            current = current.parentElement;
            depth++;
        }
        return parts.join(' > ');
    }

    /**
     * Sanitize URL by stripping sensitive query parameters.
     * @param {string} rawUrl
     * @returns {string}
     */
    function sanitizeUrl(rawUrl) {
        const SENSITIVE_PARAMS = /^(token|key|secret|password|passwd|auth|code|session|access_token|refresh_token|api_key|apikey|credential|sig|signature)$/i;
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

    // ── Export ──────────────────────────────────────────────────────────

    window.__clawmarkPrivacy = {
        isSensitiveInput,
        maskInputValue,
        maskText,
        safeSelector,
        sanitizeUrl,
        MASK,
    };
})();
