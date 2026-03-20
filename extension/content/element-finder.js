/**
 * ClawMark — Element Finder (#77)
 *
 * Robust element location utility for ActionExecutor.
 * Supports CSS selectors and XPath expressions with configurable
 * retry + wait for element visibility.
 *
 * Shared via window.__clawmarkElementFinder.
 */

'use strict';

(() => {
    if (window.__clawmarkElementFinder) return;
    window.__clawmarkElementFinder = true;

    // ── Config ─────────────────────────────────────────────────────────

    const DEFAULT_TIMEOUT_MS = 5000;
    const POLL_INTERVAL_MS = 200;

    // ── Core ───────────────────────────────────────────────────────────

    /**
     * Resolve a single element from a selector string.
     * Supports CSS selectors and XPath (prefixed with "xpath:").
     * @param {string} selector
     * @returns {Element|null}
     */
    function resolveElement(selector) {
        if (!selector || typeof selector !== 'string') return null;

        if (selector.startsWith('xpath:')) {
            const xpath = selector.slice(6);
            try {
                const result = document.evaluate(
                    xpath,
                    document,
                    null,
                    XPathResult.FIRST_ORDERED_NODE_TYPE,
                    null,
                );
                return result.singleNodeValue;
            } catch {
                return null;
            }
        }

        try {
            return document.querySelector(selector);
        } catch {
            return null;
        }
    }

    /**
     * Check if an element is visible in the viewport (non-zero size, not hidden).
     * @param {Element} el
     * @returns {boolean}
     */
    function isVisible(el) {
        if (!el) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (parseFloat(style.opacity) === 0) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    /**
     * Wait for an element matching `selector` to appear and be visible.
     * Polls at POLL_INTERVAL_MS. Rejects after `timeout` ms.
     *
     * @param {string} selector  CSS selector or "xpath:..." expression
     * @param {object} [opts]
     * @param {number} [opts.timeout=5000]  Max wait in ms
     * @param {boolean} [opts.visible=true] Require element to be visible
     * @returns {Promise<Element>}
     */
    function waitForElement(selector, opts = {}) {
        const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
        const requireVisible = opts.visible !== false;

        return new Promise((resolve, reject) => {
            const start = Date.now();

            function check() {
                const el = resolveElement(selector);
                if (el && (!requireVisible || isVisible(el))) {
                    resolve(el);
                    return;
                }
                if (Date.now() - start >= timeout) {
                    reject(new Error(
                        `Element not found after ${timeout}ms: ${selector.slice(0, 120)}`,
                    ));
                    return;
                }
                setTimeout(check, POLL_INTERVAL_MS);
            }

            check();
        });
    }

    // ── Export ──────────────────────────────────────────────────────────

    window.__clawmarkElementFinder = {
        resolveElement,
        isVisible,
        waitForElement,
        DEFAULT_TIMEOUT_MS,
    };
})();
