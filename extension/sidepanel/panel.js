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

// ------------------------------------------------------------------ init

async function init() {
    // Get current tab URL
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
        currentUrl = tab.url;
        pageInfo.textContent = tab.title || tab.url;
    }

    loadItems();

    // Listen for tab changes
    chrome.tabs.onActivated.addListener(async (info) => {
        const tab = await chrome.tabs.get(info.tabId);
        if (tab.url !== currentUrl) {
            currentUrl = tab.url;
            pageInfo.textContent = tab.title || tab.url;
            showListView();
            loadItems();
        }
    });

    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (changeInfo.url && tab.active) {
            currentUrl = changeInfo.url;
            pageInfo.textContent = tab.title || changeInfo.url;
            showListView();
            loadItems();
        }
    });
}

// ------------------------------------------------------------------ data

async function loadItems() {
    itemsContainer.innerHTML = '<div class="loading">Loading...</div>';

    try {
        const response = await chrome.runtime.sendMessage({
            type: 'GET_ITEMS_BY_URL',
            url: currentUrl,
        });

        if (response.error) throw new Error(response.error);

        items = response.items || [];
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
}

function renderItems() {
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

        return `
            <div class="item-card" data-id="${item.id}">
                <div class="item-header">
                    <span class="item-type ${item.type}">${item.type}</span>
                    ${item.priority !== 'normal' ? `<span class="item-priority ${priorityClass}">${item.priority}</span>` : ''}
                    <span class="item-priority">${item.status}</span>
                </div>
                ${item.title ? `<div class="item-title">${escapeHtml(item.title)}</div>` : ''}
                ${item.quote ? `<div class="item-quote">${escapeHtml(item.quote)}</div>` : ''}
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

    threadHeader.innerHTML = `
        <div class="item-card" style="cursor:default;margin-bottom:0;">
            <div class="item-header">
                <span class="item-type ${item.type}">${item.type}</span>
                <span class="item-priority">${item.status}</span>
            </div>
            ${item.title ? `<div class="item-title">${escapeHtml(item.title)}</div>` : ''}
            ${item.quote ? `<div class="item-quote">${escapeHtml(item.quote)}</div>` : ''}
            ${tags.length > 0 ? `<div class="item-tags">${tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
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
    threadView.classList.remove('active');
    currentItemId = null;
}

function showThreadView() {
    listView.style.display = 'none';
    threadView.classList.add('active');
}

// ------------------------------------------------------------------ events

// Tabs filter
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentFilter = tab.dataset.filter;
        renderItems();
    });
});

threadBack.addEventListener('click', showListView);
refreshBtn.addEventListener('click', () => {
    if (currentItemId) loadThread(currentItemId);
    else loadItems();
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

// ------------------------------------------------------------------ start

init();
