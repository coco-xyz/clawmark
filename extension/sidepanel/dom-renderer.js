/**
 * ClawMark — DOM Renderer (#75 Phase 3)
 *
 * Renders recorded DOM snapshots in a sandboxed iframe for session replay.
 * Shows cursor position and click target highlighting during playback.
 *
 * Security: All content is rendered inside a sandboxed iframe with strict CSP.
 * Script tags and event handlers are stripped before injection.
 *
 * Depends on: replay-timeline.js (coordinates via ReplayTimeline hooks)
 */

'use strict';

const DomRenderer = (() => {
    // ── State ───────────────────────────────────────────────────────────

    let iframe = null;
    let container = null;
    let cursorEl = null;
    let clickRippleEl = null;
    let currentSnapshot = null;
    let mounted = false;

    // ── Public API ──────────────────────────────────────────────────────

    function mount(containerEl) {
        if (mounted) unmount();
        container = containerEl;
        mounted = true;

        // Create wrapper
        container.innerHTML = `
            <div class="dom-renderer-wrapper">
                <div class="dom-renderer-frame-container">
                    <div class="dom-renderer-cursor"></div>
                    <div class="dom-renderer-click-ripple"></div>
                </div>
                <div class="dom-renderer-snapshot-info"></div>
            </div>
        `;

        cursorEl = container.querySelector('.dom-renderer-cursor');
        clickRippleEl = container.querySelector('.dom-renderer-click-ripple');

        // Create sandboxed iframe — empty sandbox (no permissions at all).
        // Uses srcdoc instead of doc.write to avoid needing allow-same-origin.
        const frameContainer = container.querySelector('.dom-renderer-frame-container');
        iframe = document.createElement('iframe');
        iframe.className = 'dom-renderer-iframe';
        iframe.sandbox = ''; // Fully sandboxed: no scripts, no forms, no same-origin
        iframe.setAttribute('referrerpolicy', 'no-referrer');
        iframe.title = 'Session replay DOM view';
        frameContainer.prepend(iframe);

        showEmpty();
    }

    function unmount() {
        mounted = false;
        iframe = null;
        cursorEl = null;
        clickRippleEl = null;
        currentSnapshot = null;
        currentHighlightSelector = null;
        if (container) container.innerHTML = '';
        container = null;
    }

    /**
     * Render a snapshot's HTML in the iframe.
     * @param {object} snapshot - Event object with data.html, data.trigger, data.url, data.title
     */
    function renderSnapshot(snapshot) {
        if (!mounted || !iframe) return;
        if (!snapshot || !snapshot.data || !snapshot.data.html) {
            showEmpty();
            return;
        }

        // Skip if same snapshot already rendered
        if (currentSnapshot === snapshot) return;
        currentSnapshot = snapshot;

        const sanitized = sanitizeForIframe(snapshot.data.html);

        // Use srcdoc instead of doc.write — works with empty sandbox (no allow-same-origin)
        iframe.srcdoc = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        color: #333;
        background: #fff;
        padding: 8px;
        overflow: auto;
    }
    img { max-width: 100%; height: auto; }
</style>
</head>
<body>${sanitized}</body>
</html>`;

        // Update snapshot info
        const info = container.querySelector('.dom-renderer-snapshot-info');
        if (info) {
            const trigger = snapshot.data.trigger || 'unknown';
            const title = snapshot.data.title || '';
            info.textContent = `Snapshot: ${trigger}${title ? ` \u2014 ${title}` : ''}`;
        }
    }

    /**
     * Show cursor at a position within the iframe viewport.
     * @param {number} x - Client X coordinate
     * @param {number} y - Client Y coordinate
     */
    function showCursor(x, y) {
        if (!cursorEl || !mounted) return;
        if (!isFinite(Number(x)) || !isFinite(Number(y))) return;
        cursorEl.style.display = 'block';
        cursorEl.style.left = `${Number(x)}px`;
        cursorEl.style.top = `${Number(y)}px`;
    }

    function hideCursor() {
        if (cursorEl) cursorEl.style.display = 'none';
    }

    /**
     * Show a click ripple effect at position.
     * @param {number} x - Client X coordinate
     * @param {number} y - Client Y coordinate
     */
    function showClick(x, y) {
        if (!clickRippleEl || !mounted) return;
        if (!isFinite(Number(x)) || !isFinite(Number(y))) return;
        clickRippleEl.style.left = `${Number(x)}px`;
        clickRippleEl.style.top = `${Number(y)}px`;
        clickRippleEl.classList.remove('active');
        // Force reflow for animation restart
        void clickRippleEl.offsetWidth;
        clickRippleEl.classList.add('active');
    }

    /**
     * Highlight an element in the iframe by CSS selector.
     * With empty sandbox we cannot access iframe.contentDocument,
     * so highlighting is done by re-rendering srcdoc with a highlight
     * style injected for the target selector.
     */
    let currentHighlightSelector = null;

    function highlightElement(selector) {
        if (!mounted || !iframe || !currentSnapshot) return;
        if (selector === currentHighlightSelector) return;
        currentHighlightSelector = selector;

        // Re-render with highlight CSS targeting the selector
        reRenderWithHighlight(selector);
    }

    /**
     * Clear highlight and cursor state.
     */
    function clearOverlays() {
        hideCursor();
        if (currentHighlightSelector) {
            currentHighlightSelector = null;
            // Re-render without highlight
            if (currentSnapshot) {
                const saved = currentSnapshot;
                currentSnapshot = null; // Force re-render
                renderSnapshot(saved);
            }
        }
    }

    function reRenderWithHighlight(selector) {
        if (!iframe || !currentSnapshot || !currentSnapshot.data) return;
        const sanitized = sanitizeForIframe(currentSnapshot.data.html);

        // Build highlight CSS — only inject if selector is valid-looking
        let highlightCss = '';
        if (selector && /^[a-zA-Z0-9#.\-_\[\]=~^$*|:(), >+"'\\]+$/.test(selector)) {
            const escaped = selector.replace(/"/g, '\\"');
            highlightCss = `${escaped} { outline: 2px solid #ef4444 !important; outline-offset: 2px; background: rgba(239, 68, 68, 0.08) !important; }`;
        }

        iframe.srcdoc = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        color: #333;
        background: #fff;
        padding: 8px;
        overflow: auto;
    }
    img { max-width: 100%; height: auto; }
    ${highlightCss}
</style>
</head>
<body>${sanitized}</body>
</html>`;
    }

    // ── Sanitization ────────────────────────────────────────────────────

    // Tags to remove entirely (with content)
    const REMOVE_TAGS = new Set([
        'script', 'object', 'embed', 'applet', 'form', 'base',
        'link', 'iframe', 'frame', 'frameset',
    ]);

    // Dangerous URL schemes
    const DANGEROUS_SCHEMES = /^\s*(javascript|vbscript|data\s*:text\/html)/i;

    /**
     * Strip dangerous content from HTML before rendering in iframe.
     * Defense-in-depth: the iframe has an empty sandbox (no permissions),
     * so even if sanitization is bypassed, scripts cannot execute.
     * Uses DOMParser for reliable attribute/element handling (not regex).
     */
    function sanitizeForIframe(html) {
        if (!html) return '';

        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');

            sanitizeNode(doc.body);

            return doc.body.innerHTML;
        } catch {
            // Fallback: return escaped text if DOMParser fails
            return html.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
    }

    function sanitizeNode(node) {
        if (!node) return;

        // Process children in reverse (removal shifts indices)
        const children = Array.from(node.children);
        for (let i = children.length - 1; i >= 0; i--) {
            const child = children[i];
            const tag = child.tagName.toLowerCase();

            // Remove dangerous elements entirely
            if (REMOVE_TAGS.has(tag)) {
                child.remove();
                continue;
            }

            // Remove <meta http-equiv="refresh">
            if (tag === 'meta' && child.getAttribute('http-equiv')?.toLowerCase() === 'refresh') {
                child.remove();
                continue;
            }

            // Clean attributes on this element
            sanitizeAttributes(child);

            // Recurse
            sanitizeNode(child);
        }
    }

    function sanitizeAttributes(el) {
        // Remove all event handler attributes (on*)
        const attrs = Array.from(el.attributes);
        for (const attr of attrs) {
            const name = attr.name.toLowerCase();

            // Remove event handlers (onclick, onerror, onload, etc.)
            if (name.startsWith('on')) {
                el.removeAttribute(attr.name);
                continue;
            }

            // Sanitize URL attributes
            if (name === 'href' || name === 'src' || name === 'action') {
                if (DANGEROUS_SCHEMES.test(attr.value)) {
                    el.setAttribute(attr.name, name === 'href' ? '#' : '');
                }
            }

            // Remove style attributes containing expression() (legacy IE XSS)
            if (name === 'style' && /expression\s*\(/i.test(attr.value)) {
                el.removeAttribute('style');
            }
        }

        // Strip @import from inline styles
        if (el.tagName.toLowerCase() === 'style' && el.textContent) {
            el.textContent = el.textContent.replace(/@import\s+[^;]+;/gi, '');
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    function showEmpty() {
        if (!iframe) return;
        iframe.srcdoc = `<!DOCTYPE html><html><body style="
            display:flex;align-items:center;justify-content:center;
            height:100vh;color:#888;font-family:sans-serif;font-size:13px;
            background:#f5f5f5;
        "><div style="text-align:center;">
            <div style="font-size:24px;margin-bottom:8px;">\uD83D\uDCF8</div>
            <p>No snapshot at current position</p>
            <p style="font-size:11px;margin-top:4px;">Snapshots are captured at page load, errors, and user pauses.</p>
        </div></body></html>`;
    }

    // ── Exports ─────────────────────────────────────────────────────────

    return { mount, unmount, renderSnapshot, showCursor, hideCursor, showClick, highlightElement, clearOverlays };
})();
