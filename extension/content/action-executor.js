/**
 * ClawMark — ActionExecutor Content Script (#77)
 *
 * Executes DOM actions received from the background service worker on
 * behalf of an AI agent.  Implements: click, type, navigate, screenshot,
 * scroll, form-fill.
 *
 * Actions arrive via chrome.runtime.onMessage with type "action:execute".
 * Results are returned synchronously through sendResponse.
 *
 * Security layers:
 *   1. Domain allowlist (agentEmbedAllowedDomains in storage.sync)
 *   2. Per-action risk gate (low / medium / high / forbidden)
 *   3. Element visibility wait before interaction
 *
 * Depends on:
 *   - element-finder.js  (window.__clawmarkElementFinder)
 *   - privacy-filter.js  (window.__clawmarkPrivacy — optional, for URL sanitization)
 */

'use strict';

(() => {
    if (window.__clawmarkActionExecutor) return;
    window.__clawmarkActionExecutor = true;

    // ── Config ─────────────────────────────────────────────────────────

    let enabled = false;
    const DEFAULT_TIMEOUT_MS = 5000;

    const DEFAULT_ALLOWED_DOMAINS = [
        'coco.xyz', 'coco.site', 'hxa.net', 'hxa.one',
        'clawmark.dev', 'localhost',
    ];

    let allowedDomains = DEFAULT_ALLOWED_DOMAINS;

    // Risk levels: actions at 'forbidden' are always blocked.
    // 'high' actions require explicit per-action opt-in (future).
    const ACTION_RISK = {
        click:      'medium',
        type:       'medium',
        navigate:   'medium',
        screenshot: 'low',
        scroll:     'low',
        'form-fill':'high',
    };

    // ── Helpers ────────────────────────────────────────────────────────

    function finder() {
        return window.__clawmarkElementFinder || null;
    }

    function isDomainAllowed() {
        const hostname = location.hostname;
        return allowedDomains.some(d =>
            hostname === d || hostname.endsWith('.' + d),
        );
    }

    function makeResult(actionId, success, data) {
        const base = { actionId, success, timestamp: Date.now() };
        if (success) {
            return { ...base, result: data || {} };
        }
        return { ...base, error: String(data) };
    }

    // ── Action Handlers ────────────────────────────────────────────────

    /**
     * Click an element.
     * Options: clickType (single|double|context), offsetX, offsetY
     */
    async function handleClick(action) {
        const f = finder();
        if (!f) throw new Error('ElementFinder not loaded');

        const el = await f.waitForElement(action.target, {
            timeout: action.timeout || DEFAULT_TIMEOUT_MS,
        });

        const rect = el.getBoundingClientRect();
        const x = rect.left + (action.options?.offsetX ?? rect.width / 2);
        const y = rect.top + (action.options?.offsetY ?? rect.height / 2);
        const shared = { bubbles: true, cancelable: true, clientX: x, clientY: y };

        const clickType = action.options?.clickType || 'single';

        if (clickType === 'context') {
            el.dispatchEvent(new MouseEvent('contextmenu', { ...shared, button: 2 }));
        } else if (clickType === 'double') {
            el.dispatchEvent(new MouseEvent('mousedown', shared));
            el.dispatchEvent(new MouseEvent('mouseup', shared));
            el.dispatchEvent(new MouseEvent('click', shared));
            el.dispatchEvent(new MouseEvent('mousedown', shared));
            el.dispatchEvent(new MouseEvent('mouseup', shared));
            el.dispatchEvent(new MouseEvent('click', shared));
            el.dispatchEvent(new MouseEvent('dblclick', shared));
        } else {
            el.dispatchEvent(new MouseEvent('mousedown', shared));
            el.dispatchEvent(new MouseEvent('mouseup', shared));
            el.dispatchEvent(new MouseEvent('click', shared));
        }

        return { clicked: true, selector: action.target };
    }

    /**
     * Type text into an element.
     * Options: clearFirst (default true), append (default false)
     */
    async function handleType(action) {
        const f = finder();
        if (!f) throw new Error('ElementFinder not loaded');

        const el = await f.waitForElement(action.target, {
            timeout: action.timeout || DEFAULT_TIMEOUT_MS,
        });

        el.focus();

        const tag = el.tagName.toLowerCase();
        const isContentEditable = el.isContentEditable;
        const isFormField = tag === 'input' || tag === 'textarea';
        const clearFirst = action.options?.clearFirst !== false && !action.options?.append;

        if (!isContentEditable && !isFormField) {
            throw new Error(`Target is not an input, textarea, or contenteditable: ${action.target}`);
        }

        if (isContentEditable) {
            if (clearFirst) el.textContent = '';
            // Insert text via execCommand for undo-stack compatibility
            document.execCommand('insertText', false, action.value || '');
        } else {
            // Standard input/textarea
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                tag === 'textarea'
                    ? HTMLTextAreaElement.prototype
                    : HTMLInputElement.prototype,
                'value',
            )?.set;

            if (clearFirst && nativeInputValueSetter) {
                nativeInputValueSetter.call(el, '');
                el.dispatchEvent(new Event('input', { bubbles: true }));
            }

            const newValue = clearFirst
                ? (action.value || '')
                : (el.value + (action.value || ''));

            if (nativeInputValueSetter) {
                nativeInputValueSetter.call(el, newValue);
            } else {
                el.value = newValue;
            }

            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }

        return { typed: true, length: (action.value || '').length };
    }

    /**
     * Navigate to a URL or back/forward/reload.
     * value: URL string, or special: "back", "forward", "reload"
     */
    async function handleNavigate(action) {
        const value = action.value || '';

        if (value === 'back') {
            history.back();
            return { navigated: 'back' };
        }
        if (value === 'forward') {
            history.forward();
            return { navigated: 'forward' };
        }
        if (value === 'reload') {
            location.reload();
            return { navigated: 'reload' };
        }

        // URL navigation — only http(s) allowed
        if (!/^https?:\/\//i.test(value)) {
            throw new Error('Only http/https URLs are allowed');
        }

        location.href = value;
        return { navigated: value.slice(0, 200) };
    }

    /**
     * Capture a screenshot via the background service worker.
     * Options: fullPage (boolean), target (CSS selector for element-level)
     */
    async function handleScreenshot(action) {
        if (action.target) {
            // Element screenshot: scroll element into view, then capture
            const f = finder();
            if (!f) throw new Error('ElementFinder not loaded');
            const el = await f.waitForElement(action.target, {
                timeout: action.timeout || DEFAULT_TIMEOUT_MS,
            });
            el.scrollIntoView({ behavior: 'instant', block: 'center' });
            // Small delay for scroll to settle
            await new Promise(r => setTimeout(r, 150));
        }

        const result = await chrome.runtime.sendMessage({ type: 'CAPTURE_TAB' });
        if (result?.error) throw new Error(result.error);
        return { dataUrl: result.dataUrl, timestamp: Date.now() };
    }

    /**
     * Scroll the page or to an element.
     * Options: behavior ("smooth"|"instant"), target (selector),
     *          x/y (pixel offsets), position ("top"|"bottom")
     */
    async function handleScroll(action) {
        const behavior = action.options?.behavior || 'instant';

        // Scroll to element
        if (action.target) {
            const f = finder();
            if (!f) throw new Error('ElementFinder not loaded');
            const el = await f.waitForElement(action.target, {
                timeout: action.timeout || DEFAULT_TIMEOUT_MS,
            });
            el.scrollIntoView({ behavior, block: 'center' });
            return { scrolledTo: action.target };
        }

        // Scroll to named position
        const position = action.options?.position;
        if (position === 'top') {
            window.scrollTo({ top: 0, left: 0, behavior });
            return { scrolledTo: 'top' };
        }
        if (position === 'bottom') {
            window.scrollTo({
                top: document.documentElement.scrollHeight,
                left: 0,
                behavior,
            });
            return { scrolledTo: 'bottom' };
        }

        // Scroll by pixel offsets
        const x = action.options?.x ?? 0;
        const y = action.options?.y ?? 0;
        window.scrollBy({ left: x, top: y, behavior });
        return { scrolledBy: { x, y } };
    }

    /**
     * Fill multiple form fields in sequence.
     * value: { fields: [{ selector, value, type? }] }
     *
     * Supported field types: input, textarea, select, checkbox, radio.
     */
    async function handleFormFill(action) {
        const f = finder();
        if (!f) throw new Error('ElementFinder not loaded');

        const fields = action.value?.fields;
        if (!Array.isArray(fields) || fields.length === 0) {
            throw new Error('form-fill requires value.fields array');
        }

        const results = [];

        for (const field of fields) {
            const el = await f.waitForElement(field.selector, {
                timeout: action.timeout || DEFAULT_TIMEOUT_MS,
            });

            const tag = el.tagName.toLowerCase();
            const inputType = (el.type || '').toLowerCase();

            // Reject filling password fields
            if (inputType === 'password') {
                results.push({ selector: field.selector, skipped: true, reason: 'password field' });
                continue;
            }

            if (tag === 'select') {
                el.value = field.value;
                el.dispatchEvent(new Event('change', { bubbles: true }));
                results.push({ selector: field.selector, filled: true });
            } else if (inputType === 'checkbox') {
                const shouldCheck = field.value === true || field.value === 'true' || field.value === 'checked';
                if (el.checked !== shouldCheck) {
                    el.click();
                }
                results.push({ selector: field.selector, filled: true, checked: el.checked });
            } else if (inputType === 'radio') {
                if (!el.checked) {
                    el.click();
                }
                results.push({ selector: field.selector, filled: true });
            } else {
                // text, email, number, textarea, etc.
                el.focus();
                const setter = Object.getOwnPropertyDescriptor(
                    tag === 'textarea'
                        ? HTMLTextAreaElement.prototype
                        : HTMLInputElement.prototype,
                    'value',
                )?.set;

                if (setter) {
                    setter.call(el, field.value || '');
                } else {
                    el.value = field.value || '';
                }
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                results.push({ selector: field.selector, filled: true });
            }
        }

        return { fields: results, count: results.length };
    }

    // ── Dispatcher ─────────────────────────────────────────────────────

    async function executeAction(action) {
        const { actionId, type } = action;

        // Security: domain check
        if (!isDomainAllowed()) {
            return makeResult(actionId, false, 'Action not permitted: site not in allowed domains');
        }

        // Security: risk gate
        const risk = ACTION_RISK[type];
        if (!risk) {
            return makeResult(actionId, false, `Unknown action type: ${type}`);
        }
        if (risk === 'forbidden') {
            return makeResult(actionId, false, `Action forbidden: ${type}`);
        }

        const startTime = Date.now();

        try {
            let result;
            switch (type) {
                case 'click':
                    result = await handleClick(action);
                    break;
                case 'type':
                    result = await handleType(action);
                    break;
                case 'navigate':
                    result = await handleNavigate(action);
                    break;
                case 'screenshot':
                    result = await handleScreenshot(action);
                    break;
                case 'scroll':
                    result = await handleScroll(action);
                    break;
                case 'form-fill':
                    result = await handleFormFill(action);
                    break;
                default:
                    return makeResult(actionId, false, `Unimplemented action: ${type}`);
            }

            result.durationMs = Date.now() - startTime;
            return makeResult(actionId, true, result);
        } catch (err) {
            return makeResult(actionId, false, err.message);
        }
    }

    // ── Message Listener ───────────────────────────────────────────────

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message.type !== 'action:execute') return false;

        if (!enabled) {
            sendResponse(makeResult(
                message.payload?.actionId,
                false,
                'ActionExecutor not enabled on this page',
            ));
            return false;
        }

        executeAction(message.payload)
            .then(sendResponse)
            .catch(err => {
                sendResponse(makeResult(
                    message.payload?.actionId,
                    false,
                    err.message,
                ));
            });

        return true; // keep channel open for async response
    });

    // ── Settings & Startup ─────────────────────────────────────────────

    async function loadSettings() {
        try {
            const settings = await chrome.storage.sync.get({
                agentActionEnabled: false,
                agentEmbedAllowedDomains: DEFAULT_ALLOWED_DOMAINS,
                agentActionDisabledSites: [],
            });
            allowedDomains = settings.agentEmbedAllowedDomains;
            const siteDisabled = settings.agentActionDisabledSites.includes(location.hostname);
            return settings.agentActionEnabled && !siteDisabled;
        } catch {
            return false;
        }
    }

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        if (changes.agentActionEnabled || changes.agentActionDisabledSites || changes.agentEmbedAllowedDomains) {
            loadSettings().then(shouldEnable => {
                enabled = shouldEnable;
            });
        }
    });

    async function init() {
        const shouldEnable = await loadSettings();
        enabled = shouldEnable;
    }

    init();
})();
