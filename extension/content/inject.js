/**
 * ClawMark Chrome Extension — Content Script
 *
 * 职责：
 * - 检测文本选择 → 显示浮动工具栏
 * - 评论/Issue 输入界面
 * - 将消息发送到 background service worker
 */

'use strict';

(() => {
    // Prevent double injection
    if (window.__clawmarkInjected) return;
    window.__clawmarkInjected = true;

    // ----------------------------------------------------------- state

    let currentSelection = null; // { text, range, position }

    // ----------------------------------------------------------- DOM

    function createToolbar() {
        const toolbar = document.createElement('div');
        toolbar.id = 'clawmark-toolbar';
        toolbar.innerHTML = `
            <button data-action="comment"><span class="icon">\u{1F4AC}</span> Comment</button>
            <div class="separator"></div>
            <button data-action="issue"><span class="icon">\u{1F41B}</span> Issue</button>
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
            <textarea placeholder="Write your comment..."></textarea>
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
        overlay.querySelector('textarea').addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                handleSubmit();
            }
            if (e.key === 'Escape') {
                hideInputOverlay();
            }
        });

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

        // Reset tags
        inputOverlay.querySelectorAll('.cm-tag').forEach(t => t.classList.remove('active'));
    }

    function hideInputOverlay() {
        inputOverlay.classList.remove('visible');
    }

    // ----------------------------------------------------------- submit

    async function handleSubmit() {
        const textarea = inputOverlay.querySelector('textarea');
        const content = textarea.value.trim();
        if (!content) return;

        const submitBtn = inputOverlay.querySelector('.cm-submit');
        submitBtn.disabled = true;
        submitBtn.textContent = '...';

        const activeTags = [...inputOverlay.querySelectorAll('.cm-tag.active')].map(t => t.dataset.tag);

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
            title: currentMode === 'issue' ? content.split('\n')[0] : undefined,
            content,
            source_url: window.location.href,
            source_title: document.title,
            quote: currentSelection?.text || undefined,
            quote_position,
            tags: activeTags.length > 0 ? activeTags : undefined,
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
                    rect.left + (rect.width / 2) - 100,
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
