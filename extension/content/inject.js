/**
 * ClawMark Chrome Extension — Content Script
 *
 * Features:
 * - Text selection → floating toolbar
 * - Comment/Issue input overlay
 * - Screenshot capture + annotation (#69)
 * - Image paste + drag-drop (#70)
 * - JS injection toggle (#86) — global, per-site, and target declaration
 * - Message relay to background service worker
 */

'use strict';

(() => {
    // Prevent double injection
    if (window.__clawmarkInjected) return;
    window.__clawmarkInjected = true;

    // ----------------------------------------------------------- injection check (#86)

    let injectionActive = false;
    let targetDisabled = false; // true if target declaration says js_injection: false

    /**
     * Check if JS injection is allowed.
     * Priority: target declaration disabled > user per-site > user global.
     */
    async function checkInjectionEnabled() {
        // Target declaration override — not changeable by user toggle
        if (targetDisabled) return false;

        try {
            const { jsInjectionEnabled = true, disabledSites = [] } =
                await chrome.storage.sync.get({ jsInjectionEnabled: true, disabledSites: [] });
            if (!jsInjectionEnabled) return false;
            if (disabledSites.includes(location.hostname)) return false;
            return true;
        } catch {
            return true;
        }
    }

    /**
     * Check target declaration for js_injection field via service worker.
     */
    async function checkTargetDeclaration() {
        try {
            const result = await chrome.runtime.sendMessage({
                type: 'CHECK_TARGET_INJECTION',
                url: location.href,
            });
            if (result && result.js_injection === false) {
                targetDisabled = true;
                return false;
            }
            return true;
        } catch {
            return true; // default to allowed on error
        }
    }

    // Listen for user setting changes to enable/disable dynamically
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        if (changes.jsInjectionEnabled || changes.disabledSites) {
            checkInjectionEnabled().then(enabled => {
                if (enabled && !injectionActive) {
                    injectionActive = true;
                    initOverlay();
                } else if (!enabled && injectionActive) {
                    injectionActive = false;
                    teardownOverlay();
                }
            });
        }
    });

    // ----------------------------------------------------------- state

    let currentSelection = null; // { text, range, position }
    let pendingImages = [];      // { dataUrl, uploaded: bool, url: string }

    // DOM references — initialized in initOverlay(), nulled in teardownOverlay()
    let toolbar = null;
    let inputOverlay = null;
    let toast = null;

    // ----------------------------------------------------------- init / teardown (#86)

    function initOverlay() {
        if (toolbar) return; // already initialized
        toolbar = createToolbar();
        inputOverlay = createInputOverlay();
        toast = createToast();
        attachSelectionListeners();
    }

    function teardownOverlay() {
        if (toolbar) { toolbar.remove(); toolbar = null; }
        if (inputOverlay) { inputOverlay.remove(); inputOverlay = null; }
        if (toast) { toast.remove(); toast = null; }
        detachSelectionListeners();
    }

    // ----------------------------------------------------------- DOM

    function createToolbar() {
        const el = document.createElement('div');
        el.id = 'clawmark-toolbar';
        el.innerHTML = `
            <button data-action="comment"><span class="icon">\u{1F4AC}</span> Comment</button>
            <div class="separator"></div>
            <button data-action="issue"><span class="icon">\u{1F41B}</span> Issue</button>
            <div class="separator"></div>
            <button data-action="screenshot"><span class="icon">\u{1F4F7}</span> Screenshot</button>
            <div class="separator"></div>
            <button data-action="sidepanel"><span class="icon">\u{1F4CB}</span> Panel</button>
        `;
        document.body.appendChild(el);

        el.addEventListener('click', (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;
            const action = btn.dataset.action;
            if (action === 'comment') showInputOverlay('comment');
            else if (action === 'issue') showInputOverlay('issue');
            else if (action === 'screenshot') startScreenshot();
            else if (action === 'sidepanel') openSidePanel();
            hideToolbar();
        });

        return el;
    }

    function createInputOverlay() {
        const el = document.createElement('div');
        el.id = 'clawmark-input-overlay';
        el.innerHTML = `
            <div class="cm-header">
                <span class="cm-title">Comment</span>
                <button class="cm-close">\u00D7</button>
            </div>
            <div class="cm-quote"></div>
            <div class="cm-images"></div>
            <textarea placeholder="Write your comment..."></textarea>
            <div class="cm-drop-hint">Paste or drag images here</div>
            <div class="cm-footer">
                <div class="cm-tags">
                    <button class="cm-tag" data-tag="bug">bug</button>
                    <button class="cm-tag" data-tag="feature">feature</button>
                    <button class="cm-tag" data-tag="question">question</button>
                </div>
                <button class="cm-submit">Submit</button>
            </div>
        `;
        document.body.appendChild(el);

        el.querySelector('.cm-close').addEventListener('click', hideInputOverlay);

        el.querySelectorAll('.cm-tag').forEach(tag => {
            tag.addEventListener('click', () => tag.classList.toggle('active'));
        });

        el.querySelector('.cm-submit').addEventListener('click', handleSubmit);

        const textarea = el.querySelector('textarea');
        textarea.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') handleSubmit();
            if (e.key === 'Escape') hideInputOverlay();
        });

        textarea.addEventListener('paste', handlePaste);

        el.addEventListener('dragover', (e) => {
            e.preventDefault();
            el.classList.add('cm-dragover');
        });
        el.addEventListener('dragleave', () => el.classList.remove('cm-dragover'));
        el.addEventListener('drop', handleDrop);

        return el;
    }

    function createToast() {
        const el = document.createElement('div');
        el.id = 'clawmark-toast';
        document.body.appendChild(el);
        return el;
    }

    // ----------------------------------------------------------- toolbar

    function showToolbar(x, y) {
        if (!toolbar) return;
        toolbar.style.left = `${x}px`;
        toolbar.style.top = `${y}px`;
        toolbar.classList.add('visible');
    }

    function hideToolbar() {
        if (toolbar) toolbar.classList.remove('visible');
    }

    // ----------------------------------------------------------- screenshot (#69)

    function startScreenshot() {
        if (typeof window.__clawmarkStartScreenshot !== 'function') {
            showToast('Screenshot module not loaded', 'error');
            return;
        }

        window.__clawmarkStartScreenshot(async (dataUrl) => {
            if (!dataUrl) return;
            addPendingImage(dataUrl);
            if (inputOverlay && !inputOverlay.classList.contains('visible')) {
                showInputOverlay('comment');
            }
        });
    }

    // ----------------------------------------------------------- image management

    function addPendingImage(dataUrl) {
        pendingImages.push({ dataUrl, uploaded: false, url: null });
        renderImagePreviews();
    }

    function removePendingImage(index) {
        pendingImages.splice(index, 1);
        renderImagePreviews();
    }

    function renderImagePreviews() {
        if (!inputOverlay) return;
        const container = inputOverlay.querySelector('.cm-images');
        container.innerHTML = pendingImages.map((img, i) => `
            <div class="cm-image-preview">
                <img src="${img.dataUrl}" alt="Screenshot">
                <button class="cm-image-remove" data-index="${i}">\u00D7</button>
            </div>
        `).join('');

        container.querySelectorAll('.cm-image-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                removePendingImage(parseInt(btn.dataset.index));
            });
        });
    }

    async function uploadPendingImages() {
        const urls = [];
        for (const img of pendingImages) {
            if (img.uploaded && img.url) { urls.push(img.url); continue; }
            try {
                const result = await chrome.runtime.sendMessage({
                    type: 'UPLOAD_IMAGE', dataUrl: img.dataUrl,
                });
                if (result.error) throw new Error(result.error);
                img.uploaded = true;
                img.url = result.url;
                urls.push(result.url);
            } catch (err) {
                console.error('[ClawMark] Image upload failed:', err);
            }
        }
        return urls;
    }

    // ----------------------------------------------------------- paste + drag-drop (#70)

    function handlePaste(e) {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                e.preventDefault();
                const blob = item.getAsFile();
                if (blob) blobToDataUrl(blob).then(addPendingImage);
                return;
            }
        }
    }

    function handleDrop(e) {
        e.preventDefault();
        if (inputOverlay) inputOverlay.classList.remove('cm-dragover');
        const files = e.dataTransfer?.files;
        if (!files) return;
        for (const file of files) {
            if (file.type.startsWith('image/')) blobToDataUrl(file).then(addPendingImage);
        }
    }

    function blobToDataUrl(blob) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.readAsDataURL(blob);
        });
    }

    // ----------------------------------------------------------- input overlay

    let currentMode = 'comment';

    function showInputOverlay(mode) {
        if (!inputOverlay) return;
        currentMode = mode;
        const title = inputOverlay.querySelector('.cm-title');
        const textarea = inputOverlay.querySelector('textarea');
        const quoteEl = inputOverlay.querySelector('.cm-quote');
        const submitBtn = inputOverlay.querySelector('.cm-submit');

        title.textContent = mode === 'issue' ? 'Create Issue' : 'Comment';
        textarea.placeholder = mode === 'issue' ? 'Issue title and description...' : 'Write your comment...';
        submitBtn.textContent = mode === 'issue' ? 'Create Issue' : 'Submit';

        if (currentSelection?.text) {
            quoteEl.textContent = currentSelection.text.slice(0, 200);
            quoteEl.style.display = 'block';
        } else {
            quoteEl.style.display = 'none';
        }

        if (currentSelection?.position) {
            const { x, y } = currentSelection.position;
            inputOverlay.style.left = `${Math.min(x, window.innerWidth - 340)}px`;
            inputOverlay.style.top = `${Math.min(y + 10, window.innerHeight - 300)}px`;
        } else {
            inputOverlay.style.left = `${(window.innerWidth - 320) / 2}px`;
            inputOverlay.style.top = `${window.innerHeight / 3}px`;
        }

        inputOverlay.classList.add('visible');
        textarea.value = '';
        textarea.focus();
        inputOverlay.querySelectorAll('.cm-tag').forEach(t => t.classList.remove('active'));
    }

    function hideInputOverlay() {
        if (!inputOverlay) return;
        inputOverlay.classList.remove('visible');
        pendingImages = [];
        renderImagePreviews();
    }

    // ----------------------------------------------------------- submit

    async function handleSubmit() {
        if (!inputOverlay) return;
        const textarea = inputOverlay.querySelector('textarea');
        const content = textarea.value.trim();
        if (!content && pendingImages.length === 0) return;

        const submitBtn = inputOverlay.querySelector('.cm-submit');
        submitBtn.disabled = true;
        submitBtn.textContent = pendingImages.length > 0 ? 'Uploading...' : '...';

        const activeTags = [...inputOverlay.querySelectorAll('.cm-tag.active')].map(t => t.dataset.tag);

        let screenshots = [];
        if (pendingImages.length > 0) screenshots = await uploadPendingImages();

        let quote_position = null;
        if (currentSelection?.range) {
            try {
                const range = currentSelection.range;
                const container = range.startContainer.parentElement;
                quote_position = {
                    xpath: getXPath(container),
                    startOffset: range.startOffset,
                    endOffset: range.endOffset,
                };
            } catch {}
        }

        const data = {
            type: currentMode === 'issue' ? 'issue' : 'comment',
            title: currentMode === 'issue' ? (content.split('\n')[0] || 'Screenshot') : undefined,
            content: content || 'Screenshot annotation',
            source_url: window.location.href,
            source_title: document.title,
            quote: currentSelection?.text || undefined,
            quote_position,
            tags: activeTags.length > 0 ? activeTags : undefined,
            screenshots,
        };

        try {
            const response = await chrome.runtime.sendMessage({ type: 'CREATE_ITEM', data });
            if (response.error) throw new Error(response.error);
            showToast('Submitted!', 'success');
            hideInputOverlay();
        } catch (err) {
            showToast(`Error: ${err.message}`, 'error');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = currentMode === 'issue' ? 'Create Issue' : 'Submit';
        }
    }

    // ----------------------------------------------------------- toast

    function showToast(message, type = 'success') {
        if (!toast) return;
        toast.textContent = message;
        toast.className = `visible ${type}`;
        clearTimeout(toast._timer);
        toast._timer = setTimeout(() => toast.classList.remove('visible'), 3000);
    }

    // ----------------------------------------------------------- selection detection

    function onMouseUp(e) {
        if (e.target.closest('#clawmark-toolbar') || e.target.closest('#clawmark-input-overlay')) return;
        if (e.target.closest('#clawmark-area-selector') || e.target.closest('#clawmark-annotation-editor')) return;

        setTimeout(() => {
            const selection = window.getSelection();
            const text = selection?.toString().trim();

            if (text && text.length > 1) {
                const range = selection.getRangeAt(0);
                const rect = range.getBoundingClientRect();
                currentSelection = {
                    text,
                    range: range.cloneRange(),
                    position: { x: rect.left + window.scrollX, y: rect.bottom + window.scrollY },
                };
                showToolbar(rect.left + (rect.width / 2) - 120, rect.bottom + 8);
            } else {
                currentSelection = null;
                hideToolbar();
            }
        }, 10);
    }

    function onMouseDown(e) {
        if (!e.target.closest('#clawmark-toolbar') && !e.target.closest('#clawmark-input-overlay')) {
            hideToolbar();
        }
    }

    function onKeyDown(e) {
        if (e.key === 'Escape') {
            hideToolbar();
            hideInputOverlay();
        }
    }

    function attachSelectionListeners() {
        document.addEventListener('mouseup', onMouseUp);
        document.addEventListener('mousedown', onMouseDown);
        document.addEventListener('keydown', onKeyDown);
    }

    function detachSelectionListeners() {
        document.removeEventListener('mouseup', onMouseUp);
        document.removeEventListener('mousedown', onMouseDown);
        document.removeEventListener('keydown', onKeyDown);
    }

    // ----------------------------------------------------------- context menu handler

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'CONTEXT_MENU_ACTION') {
            if (!injectionActive) {
                sendResponse({ ok: false, reason: 'injection_disabled' });
                return;
            }
            if (message.selectionText) {
                currentSelection = {
                    text: message.selectionText,
                    range: window.getSelection()?.rangeCount ? window.getSelection().getRangeAt(0).cloneRange() : null,
                    position: null,
                };
            }
            showInputOverlay(message.action);
            sendResponse({ ok: true });
        }
    });

    // ----------------------------------------------------------- side panel

    function openSidePanel() {
        chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' });
    }

    // ----------------------------------------------------------- helpers

    function getXPath(element) {
        if (!element) return '';
        const parts = [];
        let current = element;
        while (current && current !== document.body) {
            let index = 0;
            let sibling = current.previousElementSibling;
            while (sibling) {
                if (sibling.tagName === current.tagName) index++;
                sibling = sibling.previousElementSibling;
            }
            parts.unshift(`${current.tagName.toLowerCase()}[${index + 1}]`);
            current = current.parentElement;
        }
        return '/body/' + parts.join('/');
    }

    // ----------------------------------------------------------- startup

    async function startup() {
        // Check target declaration first (immutable — target owner's choice)
        await checkTargetDeclaration();

        // Check user settings (global + per-site)
        const enabled = await checkInjectionEnabled();
        if (enabled) {
            injectionActive = true;
            initOverlay();
        }
    }

    startup();
})();
