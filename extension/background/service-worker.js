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

importScripts('../config.js');

// ------------------------------------------------------------------ config

const DEFAULT_SERVER = ClawMarkConfig.DEFAULT_SERVER;
const GOOGLE_CLIENT_ID = ClawMarkConfig.GOOGLE_CLIENT_ID
    || 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com';

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

    const responseUrl = await new Promise((resolve, reject) => {
        chrome.identity.launchWebAuthFlow({
            url: authUrl.toString(),
            interactive: true,
        }, (callbackUrl) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve(callbackUrl);
            }
        });
    });

    const code = new URL(responseUrl).searchParams.get('code');

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
    if (data.user?.name && !config.userName) {
        await saveConfig({ ...config, userName: data.user.name });
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

// ------------------------------------------------------------------ Welcome page on install

chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        const dashUrl = ClawMarkConfig.DASHBOARD_URL || 'https://labs.coco.xyz/clawmark/dashboard';
        chrome.tabs.create({ url: dashUrl + '#welcome' });
    }

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

// ---- External messages (from dashboard web page via externally_connectable)
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    handleExternalMessage(message, sender).then(sendResponse).catch(err => {
        sendResponse({ error: err.message });
    });
    return true;
});

async function handleExternalMessage(message, sender) {
    switch (message.type) {
        case 'GET_AUTH_STATE': {
            const state = await getAuthState();
            const authenticated = !!(state.authToken && state.authUser);
            return {
                authenticated,
                authUser: authenticated
                    ? { name: state.authUser.name, email: state.authUser.email }
                    : null,
            };
        }
        case 'DASHBOARD_LOGIN': {
            // Dashboard completed OAuth and wants to sync token to extension
            if (!message.token || !message.user) return { error: 'Missing token or user' };
            // Validate token with the server before accepting
            try {
                const config = await getConfig();
                const serverUrl = config.serverUrl.replace(/\/$/, '');
                const verifyResp = await fetch(`${serverUrl}/api/v2/auth/me`, {
                    headers: { 'Authorization': `Bearer ${message.token}` },
                });
                if (!verifyResp.ok) return { error: 'Invalid or expired token' };
                const data = await verifyResp.json();
                const verifiedUser = data.user || data;
                await setAuthState(message.token, verifiedUser);
            } catch {
                return { error: 'Token validation failed' };
            }
            chrome.runtime.sendMessage({ type: 'AUTH_STATE_CHANGED' }).catch(() => {});
            return { success: true };
        }
        case 'DASHBOARD_LOGOUT': {
            await clearAuthState();
            chrome.runtime.sendMessage({ type: 'AUTH_STATE_CHANGED' }).catch(() => {});
            return { success: true };
        }
        case 'PING':
            return { pong: true, version: chrome.runtime.getManifest().version };
        default:
            return { error: `Unknown external message: ${message.type}` };
    }
}

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

        // Auth management
        case 'GET_AUTHS':
            return apiRequest('GET', '/api/v2/auths');

        // Retry failed dispatches for an item (#200)
        case 'RETRY_DISPATCHES':
            return apiRequest('POST', `/api/v2/distributions/${message.itemId}/retry`);

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
                return { error: true, comments: 0, issues: 0, total: 0, recent: [] };
            }
        }

        // Global analytics summary for dashboard overview
        case 'GET_ANALYTICS_SUMMARY': {
            try {
                return await apiRequest('GET', '/api/v2/analytics/summary');
            } catch {
                return { error: true };
            }
        }

        // Get all items (optional type filter) for dashboard list view
        case 'GET_ALL_ITEMS': {
            try {
                const params = new URLSearchParams();
                if (message.itemType) params.set('type', message.itemType);
                const qs = params.toString();
                return await apiRequest('GET', `/api/v2/items${qs ? '?' + qs : ''}`);
            } catch {
                return { error: true, items: [] };
            }
        }

        case 'CHECK_VERSION':
            return checkForUpdate();

        case 'OPEN_OPTIONS_PAGE': {
            const dashUrl = ClawMarkConfig.DASHBOARD_URL || 'https://labs.coco.xyz/clawmark/dashboard';
            const hash = message.hash ? '#' + message.hash : '';
            chrome.tabs.create({ url: dashUrl + hash });
            return { success: true };
        }

        default:
            return { error: `Unknown message type: ${message.type}` };
    }
}

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

// ------------------------------------------------------------------ Version check (GitLab #2)
//
// Performance-critical: NEVER block popup on network. Return cached data
// immediately; refresh in background with a short timeout.

const VERSION_CHECK_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const VERSION_FETCH_TIMEOUT = 5000; // 5 seconds — abort if GitHub is slow/blocked

async function checkForUpdate() {
    const currentVersion = chrome.runtime.getManifest().version;
    const noUpdate = { hasUpdate: false, currentVersion, latestVersion: currentVersion, downloadUrl: '' };

    // Always return cached result immediately if available (even if stale)
    let cached = null;
    try {
        const { versionCache } = await chrome.storage.local.get('versionCache');
        if (versionCache?.data) {
            cached = versionCache;
            // Cache is fresh — return without network call
            if (Date.now() - versionCache.ts < VERSION_CHECK_CACHE_TTL) {
                return versionCache.data;
            }
        }
    } catch { /* proceed */ }

    // Cache is stale or missing — fetch with timeout, but return stale data
    // immediately if we have it. The fetch refreshes the cache for next time.
    const staleResult = cached?.data || noUpdate;

    // Fire-and-forget background refresh (don't await)
    _refreshVersionCache(currentVersion).catch(() => {});

    return staleResult;
}

/** Background version check with AbortController timeout. */
async function _refreshVersionCache(currentVersion) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VERSION_FETCH_TIMEOUT);

    try {
        const res = await fetch(
            'https://api.github.com/repos/coco-xyz/clawmark/releases/latest',
            {
                headers: { 'Accept': 'application/vnd.github.v3+json' },
                signal: controller.signal,
            }
        );
        clearTimeout(timer);

        if (!res.ok) return;

        const release = await res.json();
        const latestTag = (release.tag_name || '').replace(/^v/, '');

        let downloadUrl = '';
        for (const asset of (release.assets || [])) {
            if (asset.name && asset.name.endsWith('.zip')) {
                downloadUrl = asset.browser_download_url;
                break;
            }
        }
        if (!downloadUrl) {
            downloadUrl = release.html_url || 'https://github.com/coco-xyz/clawmark/releases/latest';
        }

        const hasUpdate = compareVersions(latestTag, currentVersion) > 0;
        const data = { hasUpdate, currentVersion, latestVersion: latestTag, downloadUrl };
        await chrome.storage.local.set({ versionCache: { data, ts: Date.now() } });
    } catch {
        clearTimeout(timer);
        // Timeout or network error — silently ignore, keep stale cache
    }
}

/**
 * Compare semver strings. Returns >0 if a > b, <0 if a < b, 0 if equal.
 */
function compareVersions(a, b) {
    if (!a || !b) return 0;
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = pa[i] || 0;
        const nb = pb[i] || 0;
        if (na !== nb) return na - nb;
    }
    return 0;
}

// ------------------------------------------------------------------ Badge updater (Phase 2)

async function updateBadgeForTab(tabId, url) {
    if (!url || url.startsWith('chrome') || url.startsWith('chrome-extension')) {
        await chrome.action.setBadgeText({ tabId, text: '' });
        return;
    }
    try {
        const result = await getItemsByUrl(url);
        const total = (result.items || []).length;
        if (total > 0) {
            const label = total > 99 ? '99+' : String(total);
            await chrome.action.setBadgeText({ tabId, text: label });
            await chrome.action.setBadgeBackgroundColor({ tabId, color: '#5865f2' });
        } else {
            await chrome.action.setBadgeText({ tabId, text: '' });
        }
    } catch {
        await chrome.action.setBadgeText({ tabId, text: '' });
    }
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    try {
        const tab = await chrome.tabs.get(tabId);
        if (tab?.url) await updateBadgeForTab(tabId, tab.url);
    } catch {}
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab?.url) {
        await updateBadgeForTab(tabId, tab.url);
    }
});
