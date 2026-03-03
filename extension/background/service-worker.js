/**
 * ClawMark Chrome Extension — Background Service Worker
 *
 * Manages:
 * - Authentication state (Google OAuth JWT / API Key / invite code)
 * - API requests to ClawMark Server
 * - Message relay between content script ↔ sidepanel
 * - Context menu
 */

'use strict';

// ------------------------------------------------------------------ config

const DEFAULT_SERVER = 'https://api.coco.xyz/clawmark';

// Google OAuth client ID — set by server admin via CLAWMARK_GOOGLE_CLIENT_ID
const GOOGLE_CLIENT_ID = '530440081185-32t15m4gqndq7qab6g57a25i6gfc1gmn.apps.googleusercontent.com';

async function getConfig() {
    const result = await chrome.storage.sync.get({
        serverUrl: DEFAULT_SERVER,
        apiKey: '',
        inviteCode: '',
        userName: '',
        appId: 'default',
        googleClientId: '',
    });
    return result;
}

async function saveConfig(config) {
    await chrome.storage.sync.set(config);
}

// ------------------------------------------------------------------ auth state (JWT)

async function getAuthState() {
    const result = await chrome.storage.local.get({
        authToken: '',
        authUser: null,
    });
    return result;
}

async function setAuthState(token, user) {
    await chrome.storage.local.set({ authToken: token, authUser: user });
}

async function clearAuthState() {
    await chrome.storage.local.remove(['authToken', 'authUser']);
}

// ------------------------------------------------------------------ Google OAuth

async function loginWithGoogle() {
    const config = await getConfig();
    const clientId = config.googleClientId || GOOGLE_CLIENT_ID;
    if (!clientId) {
        throw new Error('Google Client ID not configured');
    }

    const redirectUrl = chrome.identity.getRedirectURL();

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUrl);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'openid email profile');
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');

    const responseUrl = await chrome.identity.launchWebAuthFlow({
        url: authUrl.toString(),
        interactive: true,
    });

    const url = new URL(responseUrl);
    const code = url.searchParams.get('code');
    if (!code) {
        throw new Error('No authorization code received');
    }

    // Exchange code for JWT via our backend
    const serverUrl = config.serverUrl.replace(/\/$/, '');
    const response = await fetch(`${serverUrl}/api/v2/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, redirectUri: redirectUrl }),
    });

    if (!response.ok) {
        const err = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(err.error || `Login failed: ${response.status}`);
    }

    const data = await response.json();
    await setAuthState(data.token, data.user);

    // Update userName from OAuth profile if not manually set
    if (!config.userName) {
        const displayName = data.user?.name
            || (data.user?.email ? data.user.email.split('@')[0] : '');
        if (displayName) {
            await saveConfig({ ...config, userName: displayName });
        }
    }

    // Broadcast auth state change
    chrome.runtime.sendMessage({ type: 'AUTH_STATE_CHANGED' }).catch(() => {});

    return data;
}

async function logout() {
    await clearAuthState();
    chrome.runtime.sendMessage({ type: 'AUTH_STATE_CHANGED' }).catch(() => {});
    return { success: true };
}

async function checkAuth() {
    const { authToken } = await getAuthState();
    if (!authToken) return { authenticated: false };

    try {
        const config = await getConfig();
        const serverUrl = config.serverUrl.replace(/\/$/, '');
        const response = await fetch(`${serverUrl}/api/v2/auth/me`, {
            headers: { 'Authorization': `Bearer ${authToken}` },
        });

        if (!response.ok) {
            // Token invalid/expired — clear it
            await clearAuthState();
            return { authenticated: false };
        }

        const data = await response.json();
        // /auth/me returns flat user object (not nested under .user)
        const user = data.user || data;
        await setAuthState(authToken, user);
        return { authenticated: true, user };
    } catch {
        return { authenticated: false, error: 'Network error' };
    }
}

// ------------------------------------------------------------------ API

async function apiRequest(method, path, body = null) {
    const config = await getConfig();
    const { authToken } = await getAuthState();
    const url = `${config.serverUrl.replace(/\/$/, '')}${path}`;

    const headers = { 'Content-Type': 'application/json' };

    // Auth priority: API key > JWT > invite code (body)
    if (config.apiKey) {
        headers['Authorization'] = `Bearer ${config.apiKey}`;
    } else if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
    }

    const options = { method, headers };
    if (body) {
        // Inject invite code only if no other auth
        if (!config.apiKey && !authToken && config.inviteCode) {
            body.code = config.inviteCode;
        }
        if (config.userName && !body.userName) {
            body.userName = config.userName;
        }
        options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    if (!response.ok) {
        // If 401 with JWT, token may be expired — clear auth
        if (response.status === 401 && authToken && !config.apiKey) {
            await clearAuthState();
            chrome.runtime.sendMessage({ type: 'AUTH_STATE_CHANGED' }).catch(() => {});
        }
        const err = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(err.error || `API ${response.status}`);
    }
    return response.json();
}

// ------------------------------------------------------------------ API methods

async function createItem({ type, title, content, source_url, source_title, quote,
                            quote_position, priority, tags, screenshots, selected_targets }) {
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
        selected_targets,
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

// ------------------------------------------------------------------ screenshot + upload

async function captureTab(tabId) {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
    return { dataUrl };
}

async function uploadImage(dataUrl) {
    const config = await getConfig();
    const { authToken } = await getAuthState();
    const serverUrl = config.serverUrl.replace(/\/$/, '');

    // Convert data URL to blob
    const res = await fetch(dataUrl);
    const blob = await res.blob();

    const formData = new FormData();
    formData.append('image', blob, `screenshot-${Date.now()}.png`);

    const headers = {};
    if (config.apiKey) {
        headers['Authorization'] = `Bearer ${config.apiKey}`;
    } else if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
    }

    const response = await fetch(`${serverUrl}/upload`, {
        method: 'POST',
        headers,
        body: formData,
    });

    if (!response.ok) {
        const err = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(err.error || `Upload failed: ${response.status}`);
    }

    const data = await response.json();
    // Return full URL (server returns relative path like /images/filename)
    return { url: `${serverUrl}${data.url}` };
}

// --------------------------------------------------------- context menu

chrome.runtime.onInstalled.addListener((details) => {
    chrome.contextMenus.create({
        id: 'clawmark-comment',
        title: 'ClawMark: Comment on selection',
        contexts: ['selection'],
    });
    chrome.contextMenus.create({
        id: 'clawmark-issue',
        title: 'ClawMark: Create Issue',
        contexts: ['selection', 'page'],
    });

    // Open welcome page on fresh install
    if (details.reason === 'install') {
        const optionsUrl = chrome.runtime.getURL('options/options.html') + '?tab=welcome';
        chrome.tabs.create({ url: optionsUrl });
    }
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
            // Update badge count for the sender tab
            if (sender.tab?.id) {
                _badgeCache.delete(sender.tab.id);
                updateBadge(sender.tab.id);
            }
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

        // Auth messages
        case 'LOGIN_GOOGLE':
            return loginWithGoogle();

        case 'LOGOUT':
            return logout();

        case 'GET_AUTH_STATE':
            return getAuthState();

        case 'CHECK_AUTH':
            return checkAuth();

        // JS injection toggle
        case 'GET_INJECTION_SETTING': {
            const { jsInjectionEnabled = true, disabledSites = [] } = await chrome.storage.sync.get({
                jsInjectionEnabled: true,
                disabledSites: [],
            });
            return { jsInjectionEnabled, disabledSites };
        }

        case 'SET_INJECTION_SETTING': {
            const updates = {};
            if (typeof message.jsInjectionEnabled === 'boolean') {
                updates.jsInjectionEnabled = message.jsInjectionEnabled;
            }
            if (Array.isArray(message.disabledSites)) {
                // M-5: validate entries are strings; M-3: cap at 100 sites
                updates.disabledSites = message.disabledSites
                    .filter(s => typeof s === 'string' && s.length > 0)
                    .slice(0, 100);
            }
            await chrome.storage.sync.set(updates);
            return { success: true };
        }

        // Target declaration check (#86) — checks if site disables JS injection
        case 'CHECK_TARGET_INJECTION':
            return checkTargetInjection(message.url);

        // Screenshot + upload messages
        case 'CAPTURE_TAB':
            return captureTab(sender.tab?.id);

        case 'UPLOAD_IMAGE':
            return uploadImage(message.dataUrl);

        // Dispatch target preview (#115)
        case 'RESOLVE_DISPATCH_TARGETS':
            return apiRequest('POST', '/api/v2/routing/resolve', {
                source_url: message.source_url,
                type: message.item_type,
                tags: message.tags,
            });

        // Routing rules CRUD
        case 'GET_ROUTING_RULES':
            return apiRequest('GET', '/api/v2/routing/rules');

        case 'CREATE_ROUTING_RULE':
            return apiRequest('POST', '/api/v2/routing/rules', message.data);

        case 'UPDATE_ROUTING_RULE':
            return apiRequest('PUT', `/api/v2/routing/rules/${message.id}`, message.data);

        case 'DELETE_ROUTING_RULE':
            return apiRequest('DELETE', `/api/v2/routing/rules/${message.id}`);

        // Master toggle (global on/off)
        case 'GET_MASTER_TOGGLE': {
            const { masterEnabled = true } = await chrome.storage.sync.get({ masterEnabled: true });
            return { masterEnabled };
        }

        case 'SET_MASTER_TOGGLE': {
            await chrome.storage.sync.set({ masterEnabled: message.enabled });
            // Broadcast to all content scripts
            const tabs = await chrome.tabs.query({});
            for (const tab of tabs) {
                chrome.tabs.sendMessage(tab.id, {
                    type: 'MASTER_TOGGLE_CHANGED',
                    enabled: message.enabled,
                }).catch(() => {});
            }
            return { success: true };
        }

        // Get annotation count for a URL (for popup badge)
        case 'GET_ANNOTATION_COUNT': {
            try {
                const result = await getItemsByUrl(message.url);
                const items = result.items || [];
                const comments = items.filter(i => i.type === 'comment').length;
                const issues = items.filter(i => i.type === 'issue').length;
                return { comments, issues, total: items.length, recent: items.slice(0, 3) };
            } catch {
                return { comments: 0, issues: 0, total: 0, recent: [] };
            }
        }

        default:
            return { error: `Unknown message type: ${message.type}` };
    }
}

// ------------------------------------------------------------------ badge count

const _badgeCache = new Map();          // tabId -> { count, ts }
const BADGE_CACHE_TTL = 30 * 1000;      // 30 seconds

async function updateBadge(tabId) {
    if (!tabId) return;

    try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab?.url || tab.url.startsWith('chrome') || tab.url.startsWith('about:')) {
            chrome.action.setBadgeText({ text: '', tabId });
            return;
        }

        // Check cache
        const cached = _badgeCache.get(tabId);
        if (cached && Date.now() - cached.ts < BADGE_CACHE_TTL) {
            const text = cached.count > 0 ? String(cached.count) : '';
            chrome.action.setBadgeText({ text, tabId });
            return;
        }

        const result = await getItemsByUrl(tab.url);
        const items = result.items || [];
        const count = items.length;

        _badgeCache.set(tabId, { count, ts: Date.now() });

        // Evict old cache entries if too many
        if (_badgeCache.size > 200) {
            const oldest = _badgeCache.keys().next().value;
            _badgeCache.delete(oldest);
        }

        chrome.action.setBadgeText({ text: count > 0 ? String(count) : '', tabId });
        chrome.action.setBadgeBackgroundColor({ color: '#5865f2', tabId });
    } catch {
        // Silently fail — badge is non-critical
    }
}

// Update badge when tab is activated
chrome.tabs.onActivated.addListener(({ tabId }) => {
    updateBadge(tabId);
});

// Update badge when tab URL changes (navigation complete)
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'complete') {
        // Invalidate cache for this tab since URL may have changed
        _badgeCache.delete(tabId);
        updateBadge(tabId);
    }
});

// Clean up badge cache when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
    _badgeCache.delete(tabId);
});

// ------------------------------------------------------------------ target declaration check (#86)
//
// Delegates to server-side /api/v2/routing/resolve which has full SSRF
// protection, proper YAML parsing, and correct cache granularity.

const _declarationCache = new Map();
const DECLARATION_CACHE_TTL = 5 * 60 * 1000;
const DECLARATION_NEGATIVE_TTL = 2 * 60 * 1000;
const DECLARATION_CACHE_MAX = 500;

/**
 * Check target declaration for js_injection field via server API.
 * Returns { js_injection: bool }.
 */
async function checkTargetInjection(url) {
    if (!url) return { js_injection: true };

    try {
        const parsed = new URL(url);
        if (!parsed.protocol.startsWith('http')) return { js_injection: true };

        // Cache key: full origin + pathname for proper per-repo granularity
        const cacheKey = parsed.origin + parsed.pathname;
        const cached = _declarationCache.get(cacheKey);
        if (cached && Date.now() - cached.ts < (cached.negative ? DECLARATION_NEGATIVE_TTL : DECLARATION_CACHE_TTL)) {
            return { js_injection: cached.value };
        }

        // Call server API — it handles SSRF protection, YAML parsing, declaration fetching
        let jsInjection = true;
        try {
            const result = await apiRequest('POST', '/api/v2/routing/resolve', { source_url: url });
            if (result && result.js_injection === false) jsInjection = false;
        } catch {
            // Server unreachable — default to allowed
        }

        // Evict oldest before insert to respect limit
        if (_declarationCache.size >= DECLARATION_CACHE_MAX) {
            const oldest = _declarationCache.keys().next().value;
            _declarationCache.delete(oldest);
        }
        _declarationCache.set(cacheKey, { value: jsInjection, ts: Date.now(), negative: jsInjection === true });

        return { js_injection: jsInjection };
    } catch {
        return { js_injection: true };
    }
}
