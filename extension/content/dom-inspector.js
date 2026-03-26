/**
 * ClawMark — DOMInspector Content Script (#61 Agent Embed)
 *
 * Perception layer: monitors DOM mutations on the current page and emits
 * structured perception events for the Agent Channel.
 *
 * Captures:
 *   - Significant subtree additions/removals (e.g. new modals, error banners)
 *   - Attribute changes that signal state transitions (class, aria-*, hidden, disabled)
 *   - Text content changes on error-like elements (.error, .alert, [role=alert])
 *
 * Design constraints:
 *   - Batches mutations (500ms window) to avoid flooding
 *   - Ignores insignificant mutations (style-only, invisible elements)
 *   - Rate-limited to 20 events/min
 *   - Dedup by mutation fingerprint (5s window)
 */

'use strict';

(() => {
    if (window.__clawmarkDOMInspector) return;
    window.__clawmarkDOMInspector = true;

    // ── Config ─────────────────────────────────────────────────────────

    let enabled = false;
    const DEDUP_WINDOW_MS = 5000;
    const RATE_LIMIT_PER_MIN = 20;
    const BATCH_INTERVAL_MS = 500;
    const FINGERPRINT_MAP_MAX = 100;

    // Selectors that indicate error/alert content worth reporting
    const ALERT_SELECTORS = [
        '[role="alert"]', '[role="status"]', '[role="log"]',
        '.error', '.alert', '.warning', '.notification',
        '.toast', '.snackbar', '.banner',
    ];

    // Attribute changes worth tracking
    const TRACKED_ATTRS = new Set([
        'class', 'hidden', 'disabled', 'aria-hidden', 'aria-expanded',
        'aria-invalid', 'aria-busy', 'data-state', 'data-status',
    ]);

    // Minimum added/removed nodes for subtree change to be significant
    const MIN_SUBTREE_NODES = 3;

    // ── State ──────────────────────────────────────────────────────────

    const recentFingerprints = new Map();
    let eventCountThisMinute = 0;
    let minuteResetTimer = null;
    let pendingMutations = [];
    let batchTimer = null;
    let observer = null;

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

    function buildEvent(severity, summary, detail) {
        return {
            channel: 'dom',
            severity,
            timestamp: Date.now(),
            url: location.href,
            summary,
            detail,
            context: {},
        };
    }

    /**
     * Generate a short CSS path for a DOM element (for human readability).
     */
    function shortSelector(el) {
        if (!el || !el.tagName) return '?';
        const tag = el.tagName.toLowerCase();
        if (el.id) return `${tag}#${el.id}`;
        const cls = [...(el.classList || [])].slice(0, 2).join('.');
        return cls ? `${tag}.${cls}` : tag;
    }

    /**
     * Check if an element matches any alert-like selector.
     */
    function matchesAlert(el) {
        if (!el || el.nodeType !== 1) return false;
        try {
            return ALERT_SELECTORS.some(s => el.matches(s));
        } catch {
            return false;
        }
    }

    /**
     * Check if an element or any of its ancestors is hidden/invisible.
     */
    function isVisible(el) {
        if (!el || el.nodeType !== 1) return false;
        // Quick check — don't use getComputedStyle for perf
        if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
        if (el.offsetParent === null && el.tagName !== 'BODY' && el.tagName !== 'HTML') return false;
        return true;
    }

    // ── Mutation Processing ────────────────────────────────────────────

    function processBatch() {
        batchTimer = null;
        if (!enabled || pendingMutations.length === 0) {
            pendingMutations = [];
            return;
        }

        const batch = pendingMutations;
        pendingMutations = [];

        let addedNodes = 0;
        let removedNodes = 0;
        const alertTexts = [];
        const attrChanges = [];
        const significantAdds = [];

        for (const mutation of batch) {
            if (mutation.type === 'childList') {
                addedNodes += mutation.addedNodes.length;
                removedNodes += mutation.removedNodes.length;

                // Check added nodes for alert-like content
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    if (matchesAlert(node) && isVisible(node)) {
                        const text = (node.textContent || '').trim().slice(0, 200);
                        if (text) alertTexts.push({ selector: shortSelector(node), text });
                    }
                    // Also check children
                    if (node.querySelectorAll) {
                        for (const sel of ALERT_SELECTORS) {
                            try {
                                for (const child of node.querySelectorAll(sel)) {
                                    if (isVisible(child)) {
                                        const text = (child.textContent || '').trim().slice(0, 200);
                                        if (text) alertTexts.push({ selector: shortSelector(child), text });
                                    }
                                }
                            } catch { /* ignore invalid selector */ }
                        }
                    }
                }

                // Track significant subtree additions
                if (mutation.addedNodes.length >= MIN_SUBTREE_NODES) {
                    const target = shortSelector(mutation.target);
                    significantAdds.push(target);
                }
            }

            if (mutation.type === 'attributes') {
                const attr = mutation.attributeName;
                if (!TRACKED_ATTRS.has(attr)) continue;
                const el = mutation.target;
                if (!isVisible(el) && attr !== 'hidden' && attr !== 'aria-hidden') continue;
                const newVal = el.getAttribute(attr);
                const oldVal = mutation.oldValue;
                if (newVal === oldVal) continue;
                attrChanges.push({
                    selector: shortSelector(el),
                    attr,
                    from: (oldVal || '').slice(0, 100),
                    to: (newVal || '').slice(0, 100),
                });
            }
        }

        // Emit alert appearance events (highest priority)
        if (alertTexts.length > 0) {
            const first = alertTexts[0];
            emit(buildEvent(
                'warning',
                `Alert appeared: ${first.text.slice(0, 80)}`,
                {
                    type: 'alert-appeared',
                    alerts: alertTexts.slice(0, 5),
                    count: alertTexts.length,
                }
            ));
        }

        // Emit significant subtree changes
        if (addedNodes >= MIN_SUBTREE_NODES || removedNodes >= MIN_SUBTREE_NODES) {
            const targets = [...new Set(significantAdds)].slice(0, 3).join(', ') || 'document';
            emit(buildEvent(
                'info',
                `DOM subtree changed: +${addedNodes}/-${removedNodes} nodes in ${targets}`,
                {
                    type: 'subtree-change',
                    addedNodes,
                    removedNodes,
                    targets: significantAdds.slice(0, 5),
                }
            ));
        }

        // Emit interesting attribute changes (state transitions)
        for (const change of attrChanges.slice(0, 3)) {
            const isError = change.to.includes('error') || change.to.includes('invalid');
            emit(buildEvent(
                isError ? 'warning' : 'info',
                `${change.selector} [${change.attr}] changed: "${change.from}" → "${change.to}"`,
                {
                    type: 'attribute-change',
                    ...change,
                }
            ));
        }
    }

    function onMutation(mutations) {
        if (!enabled) return;
        pendingMutations.push(...mutations);
        if (!batchTimer) {
            batchTimer = setTimeout(processBatch, BATCH_INTERVAL_MS);
        }
    }

    // ── Setup ──────────────────────────────────────────────────────────

    function startObserving() {
        if (observer) return;
        observer = new MutationObserver(onMutation);
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: [...TRACKED_ATTRS],
            attributeOldValue: true,
        });
    }

    function stopObserving() {
        if (observer) {
            observer.disconnect();
            observer = null;
        }
        pendingMutations = [];
        if (batchTimer) {
            clearTimeout(batchTimer);
            batchTimer = null;
        }
    }

    // ── Settings & Startup ─────────────────────────────────────────────

    async function loadSettings() {
        try {
            const settings = await chrome.storage.sync.get({
                agentPerceptionEnabled: false,
                agentPerceptionDisabledSites: [],
            });
            const siteDisabled = settings.agentPerceptionDisabledSites.includes(location.hostname);
            const shouldEnable = settings.agentPerceptionEnabled && !siteDisabled;

            if (shouldEnable && !enabled) {
                enabled = true;
                startObserving();
            } else if (!shouldEnable && enabled) {
                enabled = false;
                stopObserving();
            }
        } catch {
            // Extension context may be invalidated
        }
    }

    chrome.storage.onChanged.addListener((changes) => {
        if (changes.agentPerceptionEnabled || changes.agentPerceptionDisabledSites) {
            loadSettings();
        }
    });

    loadSettings();
})();
