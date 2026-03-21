/**
 * ClawMark Chrome Extension — Side Panel
 *
 * 职责：显示当前 URL 的条目列表 + 评论线程
 */

'use strict';

// ------------------------------------------------------------------ state

let items = [];
let currentFilter = 'all';
let currentUrl = '';
let currentItemId = null;
let currentTabId = null;
let capturedErrors = [];
let dismissedErrorIds = new Set();
let sessions = [];

// ------------------------------------------------------------------ debounce + cache

const CACHE_TTL = 30_000; // 30 seconds
const cache = new Map();

function getCached(key) {
    const entry = cache.get(key);
    if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
    cache.delete(key);
    return null;
}

function setCache(key, data) {
    cache.set(key, { data, ts: Date.now() });
}

function invalidateCache(prefix) {
    for (const key of cache.keys()) {
        if (key.startsWith(prefix)) cache.delete(key);
    }
}

let _loadItemsTimer = null;
function debouncedLoadItems(delay = 300) {
    clearTimeout(_loadItemsTimer);
    _loadItemsTimer = setTimeout(() => loadItems(), delay);
}

// ------------------------------------------------------------------ elements

const pageInfo = document.getElementById('page-info');
const itemsContainer = document.getElementById('items-container');
const listView = document.getElementById('list-view');
const threadView = document.getElementById('thread-view');
const threadBack = document.getElementById('thread-back');
const threadHeader = document.getElementById('thread-header');
const threadMessages = document.getElementById('thread-messages');
const replyInput = document.getElementById('reply-input');
const replySubmit = document.getElementById('reply-submit');
const refreshBtn = document.getElementById('refresh');
const sessionsView = document.getElementById('sessions-view');
const sessionsContainer = document.getElementById('sessions-container');
const replayView = document.getElementById('replay-view');
const replayContainer = document.getElementById('replay-container');
const replayBack = document.getElementById('replay-back');

// ------------------------------------------------------------------ init

async function init() {
    // Get current tab URL
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
        currentUrl = tab.url;
        currentTabId = tab.id;
        pageInfo.textContent = tab.title || tab.url;
    }

    loadItems();
    loadErrors();
    loadSessions();

    // Listen for tab changes (debounced to avoid rapid-fire API calls)
    chrome.tabs.onActivated.addListener(async (info) => {
        const tab = await chrome.tabs.get(info.tabId);
        currentTabId = info.tabId;
        if (tab.url !== currentUrl) {
            currentUrl = tab.url;
            pageInfo.textContent = tab.title || tab.url;
            showListView();
            debouncedLoadItems();
        }
        loadErrors();
        loadSessions();
    });

    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (changeInfo.url && tab.active) {
            currentUrl = changeInfo.url;
            currentTabId = tabId;
            pageInfo.textContent = tab.title || changeInfo.url;
            showListView();
            debouncedLoadItems();
        }
        if (tab.active) { loadErrors(); loadSessions(); }
    });
}

// ------------------------------------------------------------------ data

async function loadItems(skipCache = false) {
    const cacheKey = `items:${currentUrl}`;
    if (!skipCache) {
        const cached = getCached(cacheKey);
        if (cached) {
            items = cached;
            updateCounts();
            renderItems();
            return;
        }
    }

    itemsContainer.innerHTML = '<div class="loading">Loading...</div>';

    try {
        const response = await chrome.runtime.sendMessage({
            type: 'GET_ITEMS_BY_URL',
            url: currentUrl,
        });

        if (response.error) throw new Error(response.error);

        items = response.items || [];
        setCache(cacheKey, items);
        updateCounts();
        renderItems();
    } catch (err) {
        itemsContainer.innerHTML = `<div class="error-msg">${err.message}</div>`;
    }
}

async function loadThread(itemId) {
    currentItemId = itemId;

    try {
        const response = await chrome.runtime.sendMessage({
            type: 'GET_ITEM',
            id: itemId,
        });

        if (response.error) throw new Error(response.error);

        renderThread(response);
        showThreadView();
    } catch (err) {
        threadMessages.innerHTML = `<div class="error-msg">${err.message}</div>`;
    }
}

async function sendReply() {
    const content = replyInput.value.trim();
    if (!content || !currentItemId) return;

    replySubmit.disabled = true;
    replySubmit.textContent = '...';

    try {
        const response = await chrome.runtime.sendMessage({
            type: 'ADD_MESSAGE',
            itemId: currentItemId,
            content,
        });

        if (response.error) throw new Error(response.error);

        replyInput.value = '';
        invalidateCache(`items:${currentUrl}`);
        loadThread(currentItemId); // Refresh thread
    } catch (err) {
        alert('Error: ' + err.message);
    } finally {
        replySubmit.disabled = false;
        replySubmit.textContent = 'Send';
    }
}

// ------------------------------------------------------------------ render

function updateCounts() {
    document.getElementById('count-all').textContent = items.length;
    document.getElementById('count-comment').textContent = items.filter(i => i.type === 'comment').length;
    document.getElementById('count-issue').textContent = items.filter(i => i.type === 'issue').length;
    const errCount = capturedErrors.length;
    const errEl = document.getElementById('count-errors');
    errEl.textContent = errCount;
    errEl.classList.toggle('has-errors', errCount > 0);
}

function renderItems() {
    if (currentFilter === 'errors') {
        renderErrors();
        return;
    }

    const filtered = currentFilter === 'all'
        ? items
        : items.filter(i => i.type === currentFilter);

    if (filtered.length === 0) {
        itemsContainer.innerHTML = '<div class="empty">No items for this page yet.</div>';
        return;
    }

    itemsContainer.innerHTML = filtered.map(item => {
        const tags = typeof item.tags === 'string' ? JSON.parse(item.tags || '[]') : (item.tags || []);
        const time = formatTime(item.created_at);
        const priorityClass = ['high', 'critical'].includes(item.priority) ? item.priority : '';

        const sourceHost = item.source_url ? (() => { try { return new URL(item.source_url).hostname; } catch { return ''; } })() : '';

        return `
            <div class="item-card" data-id="${item.id}">
                <div class="item-header">
                    <span class="item-type ${item.type}">${item.type}</span>
                    ${item.priority !== 'normal' ? `<span class="item-priority ${priorityClass}">${item.priority}</span>` : ''}
                    <span class="item-priority">${item.status}</span>
                </div>
                ${item.title ? `<div class="item-title">${escapeHtml(item.title)}</div>` : ''}
                ${item.quote ? `<div class="item-quote">${escapeHtml(item.quote)}</div>` : ''}
                ${sourceHost ? `<div class="item-source" title="${escapeHtml(item.source_url)}"><span class="source-icon">\ud83d\udcc4</span> ${escapeHtml(item.source_title || sourceHost)}</div>` : ''}
                ${renderDispatchBadges(item.dispatches)}
                <div class="item-meta">
                    <span>${item.created_by}</span>
                    <span>${time}</span>
                </div>
                ${tags.length > 0 ? `<div class="item-tags">${tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
            </div>
        `;
    }).join('');

    // Click handlers
    itemsContainer.querySelectorAll('.item-card').forEach(card => {
        card.addEventListener('click', () => loadThread(card.dataset.id));
    });
}

function renderThread(item) {
    const tags = typeof item.tags === 'string' ? JSON.parse(item.tags || '[]') : (item.tags || []);

    const threadSourceHost = item.source_url ? (() => { try { return new URL(item.source_url).hostname; } catch { return ''; } })() : '';

    threadHeader.innerHTML = `
        <div class="item-card" style="cursor:default;margin-bottom:0;">
            <div class="item-header">
                <span class="item-type ${item.type}">${item.type}</span>
                <span class="item-priority">${item.status}</span>
            </div>
            ${item.title ? `<div class="item-title">${escapeHtml(item.title)}</div>` : ''}
            ${item.quote ? `<div class="item-quote">${escapeHtml(item.quote)}</div>` : ''}
            ${threadSourceHost ? `<div class="item-source"><span class="source-icon">\ud83d\udcc4</span> <a href="${escapeHtml(item.source_url)}" target="_blank" class="source-link">${escapeHtml(item.source_title || threadSourceHost)}</a></div>` : ''}
            ${tags.length > 0 ? `<div class="item-tags">${tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
            ${renderDispatchDetails(item.dispatches, item.id)}
        </div>
    `;

    const messages = item.messages || [];
    threadMessages.innerHTML = messages.map(msg => `
        <div class="message ${msg.role}">
            <div class="msg-header">
                <span>${escapeHtml(msg.user_name || msg.role)}</span>
                <span>${formatTime(msg.created_at)}</span>
            </div>
            <div class="msg-content">${escapeHtml(msg.content)}</div>
        </div>
    `).join('') || '<div class="empty">No messages yet.</div>';

    threadMessages.scrollTop = threadMessages.scrollHeight;
}

// ------------------------------------------------------------------ views

function showListView() {
    listView.style.display = 'block';
    sessionsView.style.display = 'none';
    replayView.classList.remove('active');
    threadView.classList.remove('active');
    if (typeof ReplayTimeline !== 'undefined') ReplayTimeline.unmount();
    currentItemId = null;
}

function showThreadView() {
    listView.style.display = 'none';
    replayView.classList.remove('active');
    threadView.classList.add('active');
}

function showReplayView(tabId, sessionId) {
    listView.style.display = 'none';
    sessionsView.style.display = 'none';
    threadView.classList.remove('active');
    replayView.classList.add('active');

    if (typeof ReplayTimeline !== 'undefined') {
        ReplayTimeline.mount(replayContainer);
        ReplayTimeline.loadSession(tabId, sessionId);
    }
}

// ------------------------------------------------------------------ events

// Tabs filter
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentFilter = tab.dataset.filter;
        if (currentFilter === 'sessions') {
            listView.querySelector('.content').style.display = 'none';
            sessionsView.style.display = 'block';
            threadView.classList.remove('active');
            loadSessions();
        } else {
            sessionsView.style.display = 'none';
            listView.querySelector('.content').style.display = 'block';
            if (currentFilter === 'errors' && currentTabId) {
                chrome.runtime.sendMessage({ type: 'MARK_ERRORS_READ', tabId: currentTabId }).catch(() => {});
            }
            renderItems();
        }
    });
});

threadBack.addEventListener('click', showListView);
replayBack.addEventListener('click', () => {
    if (typeof ReplayTimeline !== 'undefined') ReplayTimeline.unmount();
    replayView.classList.remove('active');
    // Restore sessions tab view by clicking the sessions tab
    const sessionsTab = document.querySelector('.tab[data-filter="sessions"]');
    if (sessionsTab) sessionsTab.click();
});
refreshBtn.addEventListener('click', () => {
    invalidateCache(`items:${currentUrl}`);
    if (currentItemId) loadThread(currentItemId);
    else loadItems(true);
    loadErrors();
    loadSessions();
});
replySubmit.addEventListener('click', sendReply);
replyInput.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') sendReply();
});

// ------------------------------------------------------------------ helpers

function formatTime(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    const now = new Date();
    const diff = now - d;

    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
    return d.toLocaleDateString();
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ------------------------------------------------------------------ dispatch display (#115)

const TARGET_ICONS = {
    'github-issue': '\u{1F4CB}', lark: '\u{1F426}', telegram: '\u{2709}',
    webhook: '\u{1F517}', slack: '\u{1F4AC}', email: '\u{1F4E7}',
    linear: '\u25B6', jira: '\u{1F3AF}', 'hxa-connect': '\u{1F310}',
};

const STATUS_COLORS = { sent: '#22c55e', pending: '#eab308', failed: '#ef4444' };

function renderDispatchBadges(dispatches) {
    if (!dispatches || dispatches.length === 0) return '';
    return `<div class="dispatch-badges">${dispatches.map(d => {
        const icon = TARGET_ICONS[d.target_type] || '\u27A1';
        const color = STATUS_COLORS[d.status] || '#888';
        const title = `${d.target_type} (${d.method?.replace('_', ' ') || ''}) \u2014 ${d.status}`;
        return `<span class="dispatch-badge" style="border-color:${color}" title="${escapeHtml(title)}">${icon}</span>`;
    }).join('')}</div>`;
}

function renderDispatchDetails(dispatches, itemId) {
    if (!dispatches || dispatches.length === 0) return '';
    const hasFailed = dispatches.some(d => d.status === 'failed' || d.status === 'exhausted');
    return `<div class="dispatch-details">
        <div class="dispatch-details-label">Dispatched to:</div>
        ${dispatches.map(d => {
            const icon = TARGET_ICONS[d.target_type] || '\u27A1';
            const color = STATUS_COLORS[d.status] || '#888';
            const statusLabel = d.status === 'exhausted' ? 'failed' : d.status;
            const errorTitle = d.last_error ? ` — ${d.last_error}` : '';
            const linkHtml = d.external_url
                ? `<a href="${escapeHtml(d.external_url)}" target="_blank" class="dispatch-link">\u2197</a>`
                : '';
            return `<div class="dispatch-detail-row">
                <span>${icon}</span>
                <span class="dispatch-detail-type">${escapeHtml(d.target_type)}</span>
                <span class="dispatch-detail-status" style="color:${color}" title="${escapeHtml(errorTitle)}">${statusLabel}</span>
                ${linkHtml}
            </div>`;
        }).join('')}
        ${hasFailed && itemId ? `<button class="dispatch-retry-btn" data-item-id="${escapeHtml(String(itemId))}">重试失败的投递</button>` : ''}
    </div>`;
}

// Retry failed dispatches (#200)
document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.dispatch-retry-btn');
    if (!btn) return;
    const itemId = btn.dataset.itemId;
    if (!itemId) return;
    btn.disabled = true;
    btn.textContent = '重试中...';
    try {
        await chrome.runtime.sendMessage({ type: 'RETRY_DISPATCHES', itemId });
        btn.textContent = '已提交重试';
        // Refresh item list after a short delay to show updated status
        setTimeout(() => loadItems(true), 2000);
    } catch (err) {
        btn.textContent = '重试失败';
        btn.disabled = false;
    }
});

// ------------------------------------------------------------------ errors (#56)

const ERROR_TYPE_LABELS = {
    'js-error': 'JS Error',
    'unhandled-rejection': 'Promise',
    'console-error': 'Console',
    'network-error': 'Network',
    'resource-error': 'Resource',
    'long-task': 'Slow Task',
};

async function loadErrors() {
    if (!currentTabId) return;
    try {
        const errors = await chrome.runtime.sendMessage({
            type: 'GET_ERRORS',
            tabId: currentTabId,
        });
        const allErrors = Array.isArray(errors) ? errors : [];
        // Load persisted dismissed IDs for this tab
        const storeKey = `dismissed_errors_${currentTabId}`;
        const stored = await chrome.storage.local.get({ [storeKey]: [] });
        dismissedErrorIds = new Set(stored[storeKey]);
        capturedErrors = allErrors.filter(e => !dismissedErrorIds.has(e.id));
    } catch {
        capturedErrors = [];
    }
    updateCounts();
    if (currentFilter === 'errors') renderErrors();
}

function renderErrors() {
    if (capturedErrors.length === 0) {
        itemsContainer.innerHTML = '<div class="empty">No errors captured on this page.</div>';
        return;
    }

    // Show newest first
    const sorted = [...capturedErrors].reverse();

    const toolbar = `<div class="errors-toolbar">
        <button id="clear-all-errors">Clear All</button>
    </div>`;

    const cards = sorted.map(err => {
        const typeLabel = ERROR_TYPE_LABELS[err.type] || err.type;
        const isWarning = err.severity === 'warning';
        const time = formatTime(new Date(err.timestamp).toISOString());
        const message = escapeHtml(err.message || '(no message)');
        const stack = err.stack ? escapeHtml(err.stack.split('\n').slice(0, 2).join('\n')) : '';

        return `
            <div class="error-card" data-error-id="${escapeHtml(err.id)}">
                <div class="error-header">
                    <span class="error-severity ${isWarning ? 'warning' : 'error'}"></span>
                    <span class="error-type-badge ${isWarning ? 'warning' : ''}">${typeLabel}</span>
                    <span style="flex:1"></span>
                    <span style="font-size:11px;color:#666">${time}</span>
                </div>
                <div class="error-message">${message}</div>
                ${stack ? `<div class="error-stack">${stack}</div>` : ''}
                <div class="error-meta">
                    <span></span>
                    <div class="error-actions">
                        <button class="error-action-btn file-issue" data-error-id="${escapeHtml(err.id)}">File Issue</button>
                        <button class="error-action-btn dismiss" data-error-id="${escapeHtml(err.id)}">Dismiss</button>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    itemsContainer.innerHTML = toolbar + cards;

    // Clear all button
    document.getElementById('clear-all-errors')?.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ type: 'CLEAR_ERRORS', tabId: currentTabId });
        capturedErrors = [];
        dismissedErrorIds.clear();
        await chrome.storage.local.remove(`dismissed_errors_${currentTabId}`);
        updateCounts();
        renderErrors();
    });

    // File Issue buttons
    itemsContainer.querySelectorAll('.error-action-btn.file-issue').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            fileIssueFromError(btn.dataset.errorId);
        });
    });

    // Dismiss buttons
    itemsContainer.querySelectorAll('.error-action-btn.dismiss').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            dismissError(btn.dataset.errorId);
        });
    });
}

async function fileIssueFromError(errorId) {
    const err = capturedErrors.find(e => e.id === errorId);
    if (!err) return;

    const typeLabel = ERROR_TYPE_LABELS[err.type] || err.type;
    const title = `[${typeLabel}] ${(err.message || '').slice(0, 120)}`;
    const content = [
        `**Error Type:** ${typeLabel}`,
        `**Severity:** ${err.severity}`,
        `**URL:** ${err.url}`,
        `**Time:** ${new Date(err.timestamp).toISOString()}`,
        err.stack ? `\n**Stack:**\n\`\`\`\n${err.stack}\n\`\`\`` : '',
    ].filter(Boolean).join('\n');

    const btn = itemsContainer.querySelector(`.file-issue[data-error-id="${errorId}"]`);
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Filing...';
    }

    try {
        const result = await chrome.runtime.sendMessage({
            type: 'CREATE_ITEM',
            data: {
                type: 'issue',
                title,
                content,
                source_url: err.url,
                source_title: document.title || err.url,
                priority: err.severity === 'error' ? 'high' : 'normal',
                tags: ['auto-detected', err.type],
            },
        });

        if (result.error) throw new Error(result.error);

        if (btn) btn.textContent = 'Filed!';

        // Refresh items list since we created a new item
        invalidateCache(`items:${currentUrl}`);
        loadItems(true);
    } catch (e) {
        if (btn) {
            btn.textContent = 'Failed';
            btn.disabled = false;
        }
    }
}

async function dismissError(errorId) {
    dismissedErrorIds.add(errorId);
    capturedErrors = capturedErrors.filter(e => e.id !== errorId);
    // Persist dismissed IDs so they survive panel reopens
    const storeKey = `dismissed_errors_${currentTabId}`;
    await chrome.storage.local.set({ [storeKey]: [...dismissedErrorIds] });
    updateCounts();
    renderErrors();
}

// ------------------------------------------------------------------ cross-script events

// Auto-refresh when content script creates a new item or auth state changes
chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'ITEM_CREATED' || message.type === 'AUTH_STATE_CHANGED') {
        invalidateCache(`items:${currentUrl}`);
        loadItems(true);
    }
    if (message.type === 'ERRORS_UPDATED') {
        loadErrors();
    }
    if (message.type === 'SESSION_UPDATED') {
        loadSessions();
    }
});

// ------------------------------------------------------------------ sessions (#75)

async function loadSessions() {
    if (!currentTabId) {
        sessions = [];
        renderSessions();
        return;
    }

    try {
        const result = await chrome.runtime.sendMessage({
            type: 'GET_TAB_SESSIONS',
            tabId: currentTabId,
        });
        sessions = Array.isArray(result) ? result : [];
        // Sort by most recent first
        sessions.sort((a, b) => (b.lastUpdate || 0) - (a.lastUpdate || 0));
    } catch {
        sessions = [];
    }

    const countEl = document.getElementById('count-sessions');
    if (countEl) countEl.textContent = sessions.length;
    renderSessions();
}

function renderSessions() {
    if (!sessionsContainer) return;

    if (sessions.length === 0) {
        sessionsContainer.innerHTML = `
            <div class="sessions-empty">
                <div class="sessions-empty-icon">\u{1F3AC}</div>
                <p>No sessions recorded</p>
                <p style="font-size:11px;margin-top:4px;">Session recording captures user interactions on this page.</p>
            </div>`;
        return;
    }

    sessionsContainer.innerHTML = sessions.map(s => {
        const url = escapeHtml(s.url || 'Unknown');
        const hostname = s.url ? (() => { try { return new URL(s.url).hostname; } catch { return s.url; } })() : 'Unknown';
        const events = s.eventCount || 0;
        const snapshots = s.snapshotCount || 0;
        const startTime = s.startTime ? formatTime(new Date(s.startTime).toISOString()) : '';
        const duration = (s.startTime && s.lastUpdate)
            ? formatDuration(s.lastUpdate - s.startTime)
            : '';

        return `
            <div class="session-card" data-session-id="${escapeHtml(s.sessionId)}">
                <div class="session-url" title="${url}">${escapeHtml(hostname)}</div>
                <div class="session-meta">
                    <span class="session-events">\u25CF ${events} events</span>
                    <span class="session-snapshots">\u25A0 ${snapshots} snapshots</span>
                </div>
                <div class="session-time">
                    ${startTime}${duration ? ` \u00B7 ${duration}` : ''}
                </div>
            </div>`;
    }).join('');

    // Click session card → open replay timeline
    sessionsContainer.querySelectorAll('.session-card').forEach(card => {
        card.addEventListener('click', () => {
            showReplayView(currentTabId, card.dataset.sessionId);
        });
    });
}

function formatDuration(ms) {
    if (!ms || ms < 0) return '';
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (minutes < 60) return `${minutes}m ${secs}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
}

// ------------------------------------------------------------------ start

init();
