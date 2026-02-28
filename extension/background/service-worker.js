/**
 * ClawMark Chrome Extension — Background Service Worker
 *
 * 职责：
 * - 管理认证状态（API Key / invite code）
 * - 向 ClawMark Server 发 API 请求
 * - 中转 content script ↔ sidepanel 消息
 * - 右键菜单
 */

'use strict';

// ------------------------------------------------------------------ config

const DEFAULT_SERVER = 'https://clawmark.coco.xyz';

async function getConfig() {
    const result = await chrome.storage.sync.get({
        serverUrl: DEFAULT_SERVER,
        apiKey: '',
        inviteCode: '',
        userName: '',
        appId: 'default',
    });
    return result;
}

async function saveConfig(config) {
    await chrome.storage.sync.set(config);
}

// ------------------------------------------------------------------ API

async function apiRequest(method, path, body = null) {
    const config = await getConfig();
    const url = `${config.serverUrl.replace(/\/$/, '')}${path}`;

    const headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) {
        headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    const options = { method, headers };
    if (body) {
        // Inject auth if no API key
        if (!config.apiKey && config.inviteCode) {
            body.code = config.inviteCode;
        }
        if (config.userName && !body.userName) {
            body.userName = config.userName;
        }
        options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    if (!response.ok) {
        const err = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(err.error || `API ${response.status}`);
    }
    return response.json();
}

// ------------------------------------------------------------------ API methods

async function createItem({ type, title, content, source_url, source_title, quote,
                            quote_position, priority, tags, screenshots }) {
    const config = await getConfig();
    return apiRequest('POST', '/api/v2/items', {
        type: type || 'comment',
        title,
        content,
        source_url,
        source_title,
        quote,
        quote_position,
        priority: priority || 'normal',
        tags: tags || [],
        screenshots: screenshots || [],
        app_id: config.appId,
    });
}

async function getItemsByUrl(url) {
    return apiRequest('GET', `/api/v2/items?url=${encodeURIComponent(url)}`);
}

async function getItem(id) {
    return apiRequest('GET', `/api/v2/items/${id}`);
}

async function addMessage(itemId, content) {
    return apiRequest('POST', `/api/v2/items/${itemId}/messages`, {
        role: 'user',
        content,
    });
}

async function updateTags(itemId, add, remove) {
    return apiRequest('POST', `/api/v2/items/${itemId}/tags`, { add, remove });
}

async function resolveItem(itemId) {
    return apiRequest('POST', `/api/v2/items/${itemId}/resolve`, {});
}

async function checkHealth() {
    const config = await getConfig();
    const url = `${config.serverUrl.replace(/\/$/, '')}/health`;
    const res = await fetch(url);
    return res.json();
}

// --------------------------------------------------------- context menu

chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: 'clawmark-comment',
        title: 'ClawMark: 评论选中文本',
        contexts: ['selection'],
    });
    chrome.contextMenus.create({
        id: 'clawmark-issue',
        title: 'ClawMark: 创建 Issue',
        contexts: ['selection', 'page'],
    });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'clawmark-comment' || info.menuItemId === 'clawmark-issue') {
        chrome.tabs.sendMessage(tab.id, {
            type: 'CONTEXT_MENU_ACTION',
            action: info.menuItemId === 'clawmark-comment' ? 'comment' : 'issue',
            selectionText: info.selectionText || '',
            pageUrl: info.pageUrl,
        });
    }
});

// --------------------------------------------------------- side panel

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

// --------------------------------------------------------- message handler

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender).then(sendResponse).catch(err => {
        sendResponse({ error: err.message });
    });
    return true; // async response
});

async function handleMessage(message, sender) {
    switch (message.type) {
        case 'CREATE_ITEM': {
            const result = await createItem(message.data);
            // Notify side panel to refresh after item creation
            chrome.runtime.sendMessage({ type: 'ITEM_CREATED' }).catch(() => {});
            return result;
        }

        case 'GET_ITEMS_BY_URL':
            return getItemsByUrl(message.url);

        case 'GET_ITEM':
            return getItem(message.id);

        case 'ADD_MESSAGE':
            return addMessage(message.itemId, message.content);

        case 'UPDATE_TAGS':
            return updateTags(message.itemId, message.add, message.remove);

        case 'RESOLVE_ITEM':
            return resolveItem(message.itemId);

        case 'GET_CONFIG':
            return getConfig();

        case 'SAVE_CONFIG':
            await saveConfig(message.config);
            return { success: true };

        case 'CHECK_HEALTH':
            return checkHealth();

        case 'OPEN_SIDE_PANEL':
            await chrome.sidePanel.open({ tabId: sender.tab?.id });
            return { success: true };

        default:
            return { error: `Unknown message type: ${message.type}` };
    }
}
