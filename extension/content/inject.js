/**
 * ClawMark Chrome Extension — Content Script
 *
 * Features:
 * - Text selection → floating toolbar
 * - Comment/Issue input overlay
 * - Screenshot capture + annotation (#69)
 * - Image paste + drag-drop (#70)
 * - Message relay to background service worker
 */

'use strict';

(() => {
    // Prevent double injection
    if (window.__clawmarkInjected) return;
    window.__clawmarkInjected = true;

    // ----------------------------------------------------------- state

    let currentSelection = null; // { text, range, position }
    let pendingImages = [];      // { dataUrl, uploaded: bool, url: string }

    // ----------------------------------------------------------- DOM

    function createToolbar() {
        const toolbar = document.createElement('div');
        toolbar.id = 'clawmark-toolbar';
        toolbar.innerHTML = `
            <button data-action="comment"><span class="icon">\u{1F4AC}</span> Comment</button>
            <div class="separator"></div>
            <button data-action="issue"><span class="icon">\u{1F41B}</span> Issue</button>
            <div class="separator"></div>
            <button data-action="screenshot"><span class="icon">\u{1F4F7}</span> Screenshot</button>
            <div class="separator"></div>
            <button data-action="sidepanel"><span class="icon">\u{1F4CB}</span> Panel</button>
        `;
        document.body.appendChild(toolbar);

        toolbar.addEventListener('click', (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;
            const action = btn.dataset.action;
            if (action === 'comment') showInputOverlay('comment');
            else if (action === 'issue') showInputOverlay('issue');
            else if (action === 'screenshot') startScreenshot();
            else if (action === 'sidepanel') openSidePanel();
            hideToolbar();
        });

        return toolbar;
    }

    function createInputOverlay() {
        const overlay = document.createElement('div');
        overlay.id = 'clawmark-input-overlay';
        overlay.innerHTML = `
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
        document.body.appendChild(overlay);

        // Close
        overlay.querySelector('.cm-close').addEventListener('click', hideInputOverlay);

        // Tags toggle
        overlay.querySelectorAll('.cm-tag').forEach(tag => {
            tag.addEventListener('click', () => tag.classList.toggle('active'));
        });

        // Submit
        overlay.querySelector('.cm-submit').addEventListener('click', handleSubmit);

        // Keyboard shortcuts
        const textarea = overlay.querySelector('textarea');
        textarea.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                handleSubmit();
            }
            if (e.key === 'Escape') {
                hideInputOverlay();
            }
        });

        // Paste image (#70)
        textarea.addEventListener('paste', handlePaste);

        // Drag & drop image (#70)
        overlay.addEventListener('dragover', (e) => {
            e.preventDefault();
            overlay.classList.add('cm-dragover');
        });
        overlay.addEventListener('dragleave', () => {
            overlay.classList.remove('cm-dragover');
        });
        overlay.addEventListener('drop', handleDrop);

        return overlay;
    }

    function createToast() {
        const toast = document.createElement('div');
        toast.id = 'clawmark-toast';
        document.body.appendChild(toast);
        return toast;
    }

    const toolbar = createToolbar();
    const inputOverlay = createInputOverlay();
    const toast = createToast();

    // ----------------------------------------------------------- toolbar

    function showToolbar(x, y) {
        toolbar.style.left = `${x}px`;
        toolbar.style.top = `${y}px`;
        toolbar.classList.add('visible');
    }

    function hideToolbar() {
        toolbar.classList.remove('visible');
    }

    // ----------------------------------------------------------- screenshot (#69)

    function startScreenshot() {
        if (typeof window.__clawmarkStartScreenshot !== 'function') {
            showToast('Screenshot module not loaded', 'error');
            return;
        }

        window.__clawmarkStartScreenshot(async (dataUrl) => {
            if (!dataUrl) return; // cancelled

            // Add to pending images
            addPendingImage(dataUrl);

            // Show input overlay if not visible (screenshot can open it)
            if (!inputOverlay.classList.contains('visible')) {
                showInputOverlay('comment');
            }
        });
    }

    // ----------------------------------------------------------- image management

    function addPendingImage(dataUrl) {
        const img = { dataUrl, uploaded: false, url: null };
        pendingImages.push(img);
        renderImagePreviews();
    }

    function removePendingImage(index) {
        pendingImages.splice(index, 1);
        renderImagePreviews();
    }

    function renderImagePreviews() {
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
            if (img.uploaded && img.url) {
                urls.push(img.url);
                continue;
            }
            try {
                const result = await chrome.runtime.sendMessage({
                    type: 'UPLOAD_IMAGE',
                    dataUrl: img.dataUrl,
                });
                if (result.error) throw new Error(result.error);
                img.uploaded = true;
                img.url = result.url;
                urls.push(result.url);
            } catch (err) {
                console.error('[ClawMark] Image upload failed:', err);
                // Skip failed uploads
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
        inputOverlay.classList.remove('cm-dragover');

        const files = e.dataTransfer?.files;
        if (!files) return;

        for (const file of files) {
            if (file.type.startsWith('image/')) {
                blobToDataUrl(file).then(addPendingImage);
            }
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
        currentMode = mode;
        const title = inputOverlay.querySelector('.cm-title');
        const textarea = inputOverlay.querySelector('textarea');
        const quoteEl = inputOverlay.querySelector('.cm-quote');
        const submitBtn = inputOverlay.querySelector('.cm-submit');

        title.textContent = mode === 'issue' ? 'Create Issue' : 'Comment';
        textarea.placeholder = mode === 'issue' ? 'Issue title and description...' : 'Write your comment...';
        submitBtn.textContent = mode === 'issue' ? 'Create Issue' : 'Submit';

        // Show quote
        if (currentSelection?.text) {
            quoteEl.textContent = currentSelection.text.slice(0, 200);
            quoteEl.style.display = 'block';
        } else {
            quoteEl.style.display = 'none';
        }

        // Position near selection or center
        if (currentSelection?.position) {
            const { x, y } = currentSelection.position;
            const left = Math.min(x, window.innerWidth - 340);
            const top = Math.min(y + 10, window.innerHeight - 300);
            inputOverlay.style.left = `${left}px`;
            inputOverlay.style.top = `${top}px`;
        } else {
            inputOverlay.style.left = `${(window.innerWidth - 320) / 2}px`;
            inputOverlay.style.top = `${window.innerHeight / 3}px`;
        }

        inputOverlay.classList.add('visible');
        textarea.value = '';
        textarea.focus();

        // Reset tags (but keep images if screenshot was just taken)
        inputOverlay.querySelectorAll('.cm-tag').forEach(t => t.classList.remove('active'));
    }

    function hideInputOverlay() {
        inputOverlay.classList.remove('visible');
        pendingImages = [];
        renderImagePreviews();
    }

    // ----------------------------------------------------------- submit

    async function handleSubmit() {
        const textarea = inputOverlay.querySelector('textarea');
        const content = textarea.value.trim();
        if (!content && pendingImages.length === 0) return;

        const submitBtn = inputOverlay.querySelector('.cm-submit');
        submitBtn.disabled = true;
        submitBtn.textContent = pendingImages.length > 0 ? 'Uploading...' : '...';

        const activeTags = [...inputOverlay.querySelectorAll('.cm-tag.active')].map(t => t.dataset.tag);

        // Upload images first
        let screenshots = [];
        if (pendingImages.length > 0) {
            screenshots = await uploadPendingImages();
        }

        // Build quote position from saved range
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
        toast.textContent = message;
        toast.className = `visible ${type}`;
        clearTimeout(toast._timer);
        toast._timer = setTimeout(() => {
            toast.classList.remove('visible');
        }, 3000);
    }

    // ----------------------------------------------------------- selection detection

    document.addEventListener('mouseup', (e) => {
        // Ignore clicks on our own UI
        if (e.target.closest('#clawmark-toolbar') || e.target.closest('#clawmark-input-overlay')) return;
        if (e.target.closest('#clawmark-area-selector') || e.target.closest('#clawmark-annotation-editor')) return;

        // Small delay to let selection finalize
        setTimeout(() => {
            const selection = window.getSelection();
            const text = selection?.toString().trim();

            if (text && text.length > 1) {
                const range = selection.getRangeAt(0);
                const rect = range.getBoundingClientRect();

                currentSelection = {
                    text,
                    range: range.cloneRange(),
                    position: {
                        x: rect.left + window.scrollX,
                        y: rect.bottom + window.scrollY,
                    },
                };

                showToolbar(
                    rect.left + (rect.width / 2) - 120,
                    rect.bottom + 8
                );
            } else {
                currentSelection = null;
                hideToolbar();
            }
        }, 10);
    });

    // Hide toolbar on scroll or click elsewhere
    document.addEventListener('mousedown', (e) => {
        if (!e.target.closest('#clawmark-toolbar') && !e.target.closest('#clawmark-input-overlay')) {
            hideToolbar();
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            hideToolbar();
            hideInputOverlay();
        }
    });

    // ----------------------------------------------------------- context menu handler

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'CONTEXT_MENU_ACTION') {
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
})();
