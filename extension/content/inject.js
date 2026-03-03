/**
 * ClawMark Chrome Extension — Content Script
 *
 * Features:
 * - Text selection → floating toolbar
 * - Comment/Issue input overlay
 * - Screenshot capture + annotation (#69)
 * - Image paste + drag-drop (#70)
 * - JS injection toggle (#86) — global, per-site, and target declaration
 * - Draggable + resizable overlay with smart positioning (Phase 1.5)
 * - Custom tags with localStorage persistence (Phase 1.5)
 * - Toolbar overflow menu (Phase 1.5)
 * - Submit progress indicator (Phase 1.5)
 * - Message relay to background service worker
 */

'use strict';

(() => {
    // Prevent double injection
    if (window.__clawmarkInjected) return;
    window.__clawmarkInjected = true;

    // ----------------------------------------------------------- injection check (#86)

    let injectionActive = false;
    let masterEnabled = true;
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
    // Generation counter prevents race conditions from rapid toggles (M-1)
    let toggleGeneration = 0;

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        if (!masterEnabled) return;
        if (changes.jsInjectionEnabled || changes.disabledSites) {
            const gen = ++toggleGeneration;
            checkInjectionEnabled().then(enabled => {
                if (gen !== toggleGeneration) return; // stale — newer toggle supersedes
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

    // Named document-level listeners for cleanup (P1 fix: prevent listener leaks)
    let _onDocClickOverflow = null;
    let _onDocMouseMoveDrag = null;
    let _onDocMouseUpDrag = null;
    let _onDocMouseMoveResize = null;
    let _onDocMouseUpResize = null;

    // ----------------------------------------------------------- init / teardown (#86)

    function initOverlay() {
        if (toolbar) return; // already initialized
        toolbar = createToolbar();
        inputOverlay = createInputOverlay();
        toast = createToast();
        attachSelectionListeners();
    }

    function teardownOverlay() {
        // Remove document-level listeners from drag/resize/overflow
        if (_onDocClickOverflow) { document.removeEventListener('click', _onDocClickOverflow); _onDocClickOverflow = null; }
        if (_onDocMouseMoveDrag) { document.removeEventListener('mousemove', _onDocMouseMoveDrag); _onDocMouseMoveDrag = null; }
        if (_onDocMouseUpDrag) { document.removeEventListener('mouseup', _onDocMouseUpDrag); _onDocMouseUpDrag = null; }
        if (_onDocMouseMoveResize) { document.removeEventListener('mousemove', _onDocMouseMoveResize); _onDocMouseMoveResize = null; }
        if (_onDocMouseUpResize) { document.removeEventListener('mouseup', _onDocMouseUpResize); _onDocMouseUpResize = null; }

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
            <div class="cm-overflow-wrapper">
                <button data-action="overflow"><span class="icon">\u22EE</span></button>
                <div class="cm-overflow-menu">
                    <button data-action="sidepanel"><span class="icon">\u{1F4CB}</span> Panel</button>
                    <button data-action="copy-selection"><span class="icon">\u{1F4CB}</span> Copy Selection</button>
                </div>
            </div>
        `;
        document.body.appendChild(el);

        el.addEventListener('click', (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;
            const action = btn.dataset.action;
            if (action === 'comment') { showInputOverlay('comment'); hideToolbar(); }
            else if (action === 'issue') { showInputOverlay('issue'); hideToolbar(); }
            else if (action === 'screenshot') { startScreenshot(); hideToolbar(); }
            else if (action === 'sidepanel') { openSidePanel(); hideToolbar(); }
            else if (action === 'copy-selection') { copySelection(); hideToolbar(); }
            else if (action === 'overflow') {
                const menu = el.querySelector('.cm-overflow-menu');
                menu.classList.toggle('visible');
                e.stopPropagation();
            }
        });

        // Close overflow menu on outside click (named for cleanup)
        _onDocClickOverflow = (e) => {
            if (!e.target.closest('.cm-overflow-wrapper')) {
                const menu = el.querySelector('.cm-overflow-menu');
                if (menu) menu.classList.remove('visible');
            }
        };
        document.addEventListener('click', _onDocClickOverflow);

        return el;
    }

    function copySelection() {
        if (currentSelection?.text) {
            navigator.clipboard.writeText(currentSelection.text).then(() => {
                showToast('Copied to clipboard', 'success');
            }).catch(() => {
                showToast('Copy failed', 'error');
            });
        }
    }

    function createInputOverlay() {
        const el = document.createElement('div');
        el.id = 'clawmark-input-overlay';

        // Load custom tags from localStorage
        const customTags = loadCustomTags();
        const customTagsHtml = customTags.map(tag =>
            `<button class="cm-tag cm-tag-custom" data-tag="${escHtml(tag)}">${escHtml(tag)}<span class="cm-tag-remove" data-remove-tag="${escHtml(tag)}">\u00D7</span></button>`
        ).join('');

        el.innerHTML = `
            <div class="cm-header">
                <span class="cm-title">Comment</span>
                <button class="cm-close">\u00D7</button>
            </div>
            <div class="cm-quote"></div>
            <div class="cm-dispatch-preview" style="display:none;">
                <div class="cm-dispatch-label">\u{1F4EE} Dispatch to:</div>
                <div class="cm-dispatch-targets"></div>
            </div>
            <div class="cm-images"></div>
            <textarea placeholder="Write your comment..."></textarea>
            <div class="cm-drop-hint">Paste or drag images here</div>
            <div class="cm-progress-bar"><div class="cm-progress-fill"></div></div>
            <div class="cm-footer">
                <div class="cm-tags">
                    <button class="cm-tag" data-tag="bug">bug</button>
                    <button class="cm-tag" data-tag="feature">feature</button>
                    <button class="cm-tag" data-tag="question">question</button>
                    ${customTagsHtml}
                    <button class="cm-tag-add">+ Custom</button>
                </div>
                <button class="cm-submit">Submit</button>
            </div>
            <div class="cm-resize-handle"></div>
        `;
        document.body.appendChild(el);

        el.querySelector('.cm-close').addEventListener('click', hideInputOverlay);

        // Tag click delegation (handles built-in + custom tags)
        el.querySelector('.cm-tags').addEventListener('click', (e) => {
            const removeBtn = e.target.closest('.cm-tag-remove');
            if (removeBtn) {
                e.stopPropagation();
                const tagName = removeBtn.dataset.removeTag;
                removeCustomTag(tagName);
                return;
            }
            const tag = e.target.closest('.cm-tag');
            if (tag) {
                tag.classList.toggle('active');
                return;
            }
            const addBtn = e.target.closest('.cm-tag-add');
            if (addBtn) {
                showCustomTagInput(addBtn);
            }
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

        // Drag support
        initDrag(el);

        // Resize support
        initResize(el);

        return el;
    }

    // ----------------------------------------------------------- custom tags

    function loadCustomTags() {
        try {
            const stored = localStorage.getItem('clawmark_custom_tags');
            return stored ? JSON.parse(stored) : [];
        } catch { return []; }
    }

    function saveCustomTags(tags) {
        try {
            localStorage.setItem('clawmark_custom_tags', JSON.stringify(tags));
        } catch {}
    }

    function showCustomTagInput(addBtn) {
        // Don't add another input if one already exists
        if (addBtn.parentElement.querySelector('.cm-tag-input')) return;

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'cm-tag-input';
        input.placeholder = 'tag name';
        input.maxLength = 20;

        addBtn.parentElement.insertBefore(input, addBtn);
        input.focus();

        let committed = false;
        function commit() {
            if (committed) return;
            committed = true;
            const name = input.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
            input.remove();
            if (!name) return;

            const tags = loadCustomTags();
            if (tags.includes(name)) return; // duplicate

            tags.push(name);
            saveCustomTags(tags);
            addCustomTagButton(name, addBtn);
        }

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { e.preventDefault(); committed = true; input.remove(); }
        });
        input.addEventListener('blur', commit);
    }

    function addCustomTagButton(name, beforeEl) {
        const btn = document.createElement('button');
        btn.className = 'cm-tag cm-tag-custom';
        btn.dataset.tag = name;
        btn.innerHTML = `${escHtml(name)}<span class="cm-tag-remove" data-remove-tag="${escHtml(name)}">\u00D7</span>`;
        beforeEl.parentElement.insertBefore(btn, beforeEl);
    }

    function removeCustomTag(tagName) {
        if (!inputOverlay) return;
        const tags = loadCustomTags().filter(t => t !== tagName);
        saveCustomTags(tags);
        // Remove button from DOM
        const btns = inputOverlay.querySelectorAll('.cm-tag-custom');
        btns.forEach(btn => {
            if (btn.dataset.tag === tagName) btn.remove();
        });
    }

    // ----------------------------------------------------------- drag

    function initDrag(el) {
        const header = el.querySelector('.cm-header');
        let isDragging = false;
        let dragStartX, dragStartY, overlayStartX, overlayStartY;

        header.addEventListener('mousedown', (e) => {
            if (e.target.closest('.cm-close')) return; // don't drag from close button
            isDragging = true;
            header.classList.add('cm-dragging');
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            overlayStartX = el.offsetLeft;
            overlayStartY = el.offsetTop;
            e.preventDefault();
        });

        _onDocMouseMoveDrag = (e) => {
            if (!isDragging) return;
            const dx = e.clientX - dragStartX;
            const dy = e.clientY - dragStartY;

            let newX = overlayStartX + dx;
            let newY = overlayStartY + dy;

            // Clamp to viewport
            const w = el.offsetWidth;
            const h = el.offsetHeight;
            newX = Math.max(0, Math.min(newX, window.innerWidth - w));
            newY = Math.max(0, Math.min(newY, window.innerHeight - h));

            el.style.left = `${newX}px`;
            el.style.top = `${newY}px`;
        };
        document.addEventListener('mousemove', _onDocMouseMoveDrag);

        _onDocMouseUpDrag = () => {
            if (!isDragging) return;
            isDragging = false;
            header.classList.remove('cm-dragging');
            saveOverlayPosition();
        };
        document.addEventListener('mouseup', _onDocMouseUpDrag);
    }

    // ----------------------------------------------------------- resize

    function initResize(el) {
        const handle = el.querySelector('.cm-resize-handle');
        let isResizing = false;
        let resizeStartX, resizeStartY, startWidth, startHeight;

        handle.addEventListener('mousedown', (e) => {
            isResizing = true;
            resizeStartX = e.clientX;
            resizeStartY = e.clientY;
            startWidth = el.offsetWidth;
            startHeight = el.offsetHeight;
            e.preventDefault();
            e.stopPropagation();
        });

        _onDocMouseMoveResize = (e) => {
            if (!isResizing) return;
            const dx = e.clientX - resizeStartX;
            const dy = e.clientY - resizeStartY;

            const newWidth = Math.max(300, Math.min(startWidth + dx, window.innerWidth - 40));
            const newHeight = Math.max(200, Math.min(startHeight + dy, window.innerHeight - 40));

            el.style.width = `${newWidth}px`;
            el.style.height = `${newHeight}px`;
        };
        document.addEventListener('mousemove', _onDocMouseMoveResize);

        _onDocMouseUpResize = () => {
            if (!isResizing) return;
            isResizing = false;
            saveOverlayPosition();
        };
        document.addEventListener('mouseup', _onDocMouseUpResize);
    }

    // ----------------------------------------------------------- position & size memory

    function saveOverlayPosition() {
        if (!inputOverlay) return;
        try {
            const pos = {
                left: inputOverlay.offsetLeft,
                top: inputOverlay.offsetTop,
                width: inputOverlay.offsetWidth,
                height: inputOverlay.offsetHeight,
            };
            localStorage.setItem('clawmark_overlay_pos', JSON.stringify(pos));
        } catch {}
    }

    function loadOverlayPosition() {
        try {
            const stored = localStorage.getItem('clawmark_overlay_pos');
            if (!stored) return null;
            const pos = JSON.parse(stored);
            // Validate it would be on-screen
            if (pos.left + pos.width > window.innerWidth + 50) return null;
            if (pos.top + pos.height > window.innerHeight + 50) return null;
            if (pos.left < -50 || pos.top < -50) return null;
            // Clamp to current viewport
            pos.left = Math.max(0, Math.min(pos.left, window.innerWidth - pos.width));
            pos.top = Math.max(0, Math.min(pos.top, window.innerHeight - pos.height));
            return pos;
        } catch { return null; }
    }

    function createToast() {
        const el = document.createElement('div');
        el.id = 'clawmark-toast';
        document.body.appendChild(el);
        return el;
    }

    // ----------------------------------------------------------- toolbar

    function showToolbar(centerX, y) {
        if (!toolbar) return;
        toolbar.classList.add('visible');
        const tw = toolbar.offsetWidth;
        const th = toolbar.offsetHeight;
        const x = Math.max(0, Math.min(centerX - tw / 2, window.innerWidth - tw));
        const clampedY = Math.max(0, Math.min(y, window.innerHeight - th));
        toolbar.style.left = `${x}px`;
        toolbar.style.top = `${clampedY}px`;
    }

    function hideToolbar() {
        if (toolbar) {
            toolbar.classList.remove('visible');
            const menu = toolbar.querySelector('.cm-overflow-menu');
            if (menu) menu.classList.remove('visible');
        }
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

        // Smart positioning: try remembered position first, then compute
        const remembered = loadOverlayPosition();
        if (remembered) {
            inputOverlay.style.left = `${remembered.left}px`;
            inputOverlay.style.top = `${remembered.top}px`;
            inputOverlay.style.width = `${remembered.width}px`;
            inputOverlay.style.height = `${remembered.height}px`;
        } else if (currentSelection?.position) {
            positionNearSelection();
        } else {
            // Center on screen
            inputOverlay.style.width = '';
            inputOverlay.style.height = '';
            inputOverlay.style.left = `${(window.innerWidth - 320) / 2}px`;
            inputOverlay.style.top = `${window.innerHeight / 3}px`;
        }

        inputOverlay.classList.add('visible');
        textarea.value = '';
        textarea.focus();
        inputOverlay.querySelectorAll('.cm-tag').forEach(t => t.classList.remove('active'));

        // Hide progress bar
        const progressBar = inputOverlay.querySelector('.cm-progress-bar');
        if (progressBar) {
            progressBar.classList.remove('visible', 'indeterminate');
            progressBar.querySelector('.cm-progress-fill').style.width = '0%';
        }

        // Fetch dispatch targets preview (#115)
        loadDispatchPreview();
    }

    function positionNearSelection() {
        if (!inputOverlay || !currentSelection?.position) return;
        const { x, y } = currentSelection.position;
        const overlayW = inputOverlay.offsetWidth || 320;
        const overlayH = inputOverlay.offsetHeight || 300;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const scrollX = window.scrollX;
        const scrollY = window.scrollY;

        // Convert from document coords to viewport coords
        let posX = x - scrollX;
        let posY = y - scrollY + 10; // 10px gap below selection

        // If not enough space below, appear above
        if (posY + overlayH > vh) {
            const selRect = currentSelection.range?.getBoundingClientRect();
            if (selRect) {
                posY = selRect.top - overlayH - 10;
            } else {
                posY = y - scrollY - overlayH - 10;
            }
        }

        // Clamp left/right to viewport
        if (posX + overlayW > vw) posX = vw - overlayW - 8;
        if (posX < 8) posX = 8;

        // Clamp top/bottom
        if (posY + overlayH > vh) posY = vh - overlayH - 8;
        if (posY < 8) posY = 8;

        inputOverlay.style.width = '';
        inputOverlay.style.height = '';
        inputOverlay.style.left = `${posX}px`;
        inputOverlay.style.top = `${posY}px`;
    }

    let resolvedTargets = [];

    async function loadDispatchPreview() {
        const previewEl = inputOverlay.querySelector('.cm-dispatch-preview');
        const targetsEl = inputOverlay.querySelector('.cm-dispatch-targets');
        if (!previewEl || !targetsEl) return;

        const activeTags = [...inputOverlay.querySelectorAll('.cm-tag.active')].map(t => t.dataset.tag);

        try {
            const result = await chrome.runtime.sendMessage({
                type: 'RESOLVE_DISPATCH_TARGETS',
                source_url: window.location.href,
                item_type: currentMode === 'issue' ? 'issue' : 'comment',
                tags: activeTags.length > 0 ? activeTags : undefined,
            });

            resolvedTargets = result.targets || [];

            let html = resolvedTargets.map((t, i) => {
                const label = formatTargetLabel(t);
                return `<label class="cm-dispatch-target">
                    <input type="checkbox" checked data-idx="${i}" />
                    <span class="cm-target-icon">${getTargetIcon(t.target_type)}</span>
                    <span class="cm-target-label">${escHtml(label)}</span>
                    <span class="cm-target-method">${escHtml(t.method.replace('_', ' '))}</span>
                </label>`;
            }).join('');

            // Always show the ClawMark fallback destination
            html += `<label class="cm-dispatch-target cm-dispatch-fallback">
                <input type="checkbox" checked disabled />
                <span class="cm-target-icon">\u{1F4BE}</span>
                <span class="cm-target-label">ClawMark</span>
                <span class="cm-target-method">saved</span>
            </label>`;

            targetsEl.innerHTML = html;
            previewEl.style.display = 'block';
        } catch {
            // Even on error, show the fallback
            targetsEl.innerHTML = `<label class="cm-dispatch-target cm-dispatch-fallback">
                <input type="checkbox" checked disabled />
                <span class="cm-target-icon">\u{1F4BE}</span>
                <span class="cm-target-label">ClawMark</span>
                <span class="cm-target-method">saved</span>
            </label>`;
            previewEl.style.display = 'block';
        }
    }

    function formatTargetLabel(target) {
        const cfg = target.target_config || {};
        if (cfg.repo) return cfg.repo;
        if (cfg.chat_id) return `Chat ${cfg.chat_id}`;
        if (cfg.webhook_url) return 'Webhook';
        if (cfg.channel) return cfg.channel;
        if (cfg.email) return cfg.email;
        if (cfg.team_id) return `Linear team`;
        if (cfg.project_key) return `Jira ${cfg.project_key}`;
        if (cfg.thread_id) return `HxA thread`;
        return target.target_type;
    }

    function getTargetIcon(type) {
        const icons = {
            'github-issue': '\u{1F4CB}',
            'lark': '\u{1F426}',
            'telegram': '\u{2709}',
            'webhook': '\u{1F517}',
            'slack': '\u{1F4AC}',
            'email': '\u{1F4E7}',
            'linear': '\u{25B6}',
            'jira': '\u{1F3AF}',
            'hxa-connect': '\u{1F310}',
        };
        return icons[type] || '\u{27A1}';
    }

    function escHtml(s) {
        if (!s) return '';
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
    }

    function hideInputOverlay() {
        if (!inputOverlay) return;
        inputOverlay.classList.remove('visible');
        pendingImages = [];
        renderImagePreviews();
    }

    // ----------------------------------------------------------- progress bar

    function showProgressBar(indeterminate) {
        if (!inputOverlay) return;
        const bar = inputOverlay.querySelector('.cm-progress-bar');
        if (!bar) return;
        bar.classList.add('visible');
        if (indeterminate) {
            bar.classList.add('indeterminate');
        } else {
            bar.classList.remove('indeterminate');
        }
    }

    function setProgress(pct) {
        if (!inputOverlay) return;
        const fill = inputOverlay.querySelector('.cm-progress-fill');
        if (!fill) return;
        fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    }

    function hideProgressBar() {
        if (!inputOverlay) return;
        const bar = inputOverlay.querySelector('.cm-progress-bar');
        if (!bar) return;
        bar.classList.remove('visible', 'indeterminate');
        bar.querySelector('.cm-progress-fill').style.width = '0%';
    }

    // ----------------------------------------------------------- submit

    function humanizeError(msg) {
        if (!msg) return '提交失败，请稍后重试';
        const m = msg.toLowerCase();
        if (m.includes('network') || m.includes('fetch') || m.includes('failed to fetch') || m.includes('networkerror')) {
            return '无法连接服务器，请检查网络连接';
        }
        if (m.includes('401') || m.includes('unauthorized') || m.includes('auth')) {
            return '登录已过期，请重新登录';
        }
        if (m.includes('403') || m.includes('forbidden')) {
            return '没有权限执行此操作';
        }
        if (m.includes('404')) {
            return '资源不存在，请刷新后重试';
        }
        if (m.includes('500') || m.includes('server error') || m.includes('internal')) {
            return '服务器错误，请稍后重试';
        }
        if (m.includes('timeout') || m.includes('timed out')) {
            return '请求超时，请检查网络后重试';
        }
        if (m.includes('disconnected') || m.includes('disconnect')) {
            return '无法连接服务器，请检查网络';
        }
        // Fallback: show original but cap length
        return msg.length > 60 ? msg.substring(0, 60) + '…' : msg;
    }

    async function handleSubmit() {
        if (!inputOverlay) return;
        const textarea = inputOverlay.querySelector('textarea');
        const content = textarea.value.trim();
        if (!content && pendingImages.length === 0) return;

        const submitBtn = inputOverlay.querySelector('.cm-submit');
        const progressBar = inputOverlay.querySelector('.cm-progress-bar');
        submitBtn.disabled = true;
        submitBtn.textContent = pendingImages.length > 0 ? 'Uploading...' : 'Submitting...';

        // Show progress bar (Phase 1.5 API)
        if (pendingImages.length > 0) {
            showProgressBar(false);
            setProgress(10);
        } else {
            showProgressBar(true);
        }

        const activeTags = [...inputOverlay.querySelectorAll('.cm-tag.active')].map(t => t.dataset.tag);

        let screenshots = [];
        if (pendingImages.length > 0) {
            setProgress(20);
            screenshots = await uploadPendingImages();
            setProgress(60);
        }

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

        // Collect selected dispatch targets (#115)
        let selected_targets = undefined;
        const checkboxes = inputOverlay.querySelectorAll('.cm-dispatch-target input[type="checkbox"]');
        if (checkboxes.length > 0) {
            const selected = [];
            checkboxes.forEach(cb => {
                if (cb.checked) {
                    const idx = parseInt(cb.dataset.idx, 10);
                    if (resolvedTargets[idx]) {
                        selected.push({
                            target_type: resolvedTargets[idx].target_type,
                            method: resolvedTargets[idx].method,
                        });
                    }
                }
            });
            // Only send selection if user deselected something (otherwise let server use all)
            if (selected.length < resolvedTargets.length && selected.length > 0) {
                selected_targets = selected;
            }
        }

        setProgress(70);

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
            selected_targets,
        };

        try {
            setProgress(80);
            const response = await chrome.runtime.sendMessage({ type: 'CREATE_ITEM', data });
            if (response.error) throw new Error(response.error);

            setProgress(100);

            // Build informative toast with dispatch destinations
            const dispatched = response.dispatched || [];
            const targetNames = dispatched.length > 0
                ? dispatched.map(d => d.label || d.target_type).join(', ')
                : resolvedTargets.map(t => formatTargetLabel(t)).join(', ');
            const summary = targetNames
                ? `Saved \u2192 ${targetNames}`
                : 'Saved to ClawMark';
            showToast(summary, 'success');
            resolvedTargets = [];
            hideInputOverlay();
            maybeShowShortcutTip();
        } catch (err) {
            showToast(humanizeError(err.message), 'error');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = currentMode === 'issue' ? 'Create Issue' : 'Submit';
            hideProgressBar();
        }
    }

    // ----------------------------------------------------------- shortcut tip (Phase 3)

    function maybeShowShortcutTip() {
        // Show once after first successful annotation
        const STORAGE_KEY = 'clawmark_shortcut_tip_shown';
        chrome.storage.local.get([STORAGE_KEY], (result) => {
            if (result[STORAGE_KEY]) return;
            chrome.storage.local.set({ [STORAGE_KEY]: true });
            showShortcutTip();
        });
    }

    function showShortcutTip() {
        const existing = document.getElementById('clawmark-shortcut-tip');
        if (existing) return;

        const isMac = navigator.platform.toUpperCase().includes('MAC');
        const shortcut = isMac ? '⌘+Shift+X' : 'Ctrl+Shift+X';

        const tip = document.createElement('div');
        tip.id = 'clawmark-shortcut-tip';
        tip.innerHTML = `
            <span>💡 快捷键 <kbd>${shortcut}</kbd> 可随时打开标注面板</span>
            <button class="tip-close" title="关闭">×</button>
        `;
        document.body.appendChild(tip);

        tip.querySelector('.tip-close').addEventListener('click', () => tip.remove());

        // Auto-dismiss after 8s
        setTimeout(() => { if (tip.parentNode) tip.remove(); }, 8000);
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
                showToolbar(rect.left + (rect.width / 2), rect.bottom + 8);
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

        if (message.type === 'MASTER_TOGGLE_CHANGED') {
            masterEnabled = message.enabled;
            if (!masterEnabled && injectionActive) {
                injectionActive = false;
                teardownOverlay();
            } else if (masterEnabled && !injectionActive) {
                const gen = ++toggleGeneration;
                checkInjectionEnabled().then(enabled => {
                    if (gen !== toggleGeneration) return;
                    if (enabled) {
                        injectionActive = true;
                        initOverlay();
                    }
                });
            }
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
        // Check master toggle first (global on/off for all pages)
        try {
            const result = await chrome.runtime.sendMessage({ type: 'GET_MASTER_TOGGLE' });
            masterEnabled = result.masterEnabled;
        } catch {
            masterEnabled = true; // default to enabled on error
        }

        if (!masterEnabled) return;

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
