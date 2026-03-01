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

const DEFAULT_SERVER = 'https://clawmark.coco.xyz';

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

chrome.runtime.onInstalled.addListener(() => {
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
                updates.disabledSites = message.disabledSites;
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

        default:
            return { error: `Unknown message type: ${message.type}` };
    }
}

// ------------------------------------------------------------------ target declaration check (#86)

const _declarationCache = new Map();
const DECLARATION_CACHE_TTL = 5 * 60 * 1000;
const DECLARATION_NEGATIVE_TTL = 2 * 60 * 1000;

/**
 * Extract GitHub owner/repo from a URL.
 * Supports github.com/owner/repo paths.
 */
function extractGitHub(url) {
    try {
        const parsed = new URL(url);
        if (parsed.hostname !== 'github.com') return null;
        const parts = parsed.pathname.split('/').filter(Boolean);
        if (parts.length >= 2) return { owner: parts[0], repo: parts[1] };
    } catch {}
    return null;
}

/**
 * Check target declaration for js_injection field.
 * Fetches .well-known/clawmark.json (websites) or .clawmark.yml (GitHub).
 * Returns { js_injection: bool } or null.
 */
async function checkTargetInjection(url) {
    if (!url) return { js_injection: true };

    try {
        const parsed = new URL(url);
        // Skip non-http(s) URLs
        if (!parsed.protocol.startsWith('http')) return { js_injection: true };

        const cacheKey = parsed.origin;
        const cached = _declarationCache.get(cacheKey);
        if (cached && Date.now() - cached.ts < (cached.negative ? DECLARATION_NEGATIVE_TTL : DECLARATION_CACHE_TTL)) {
            return { js_injection: cached.value };
        }

        let declaration = null;

        const gh = extractGitHub(url);
        if (gh) {
            // GitHub: try .clawmark.yml from raw.githubusercontent.com
            for (const branch of ['main', 'master']) {
                try {
                    const res = await fetch(
                        `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${branch}/.clawmark.yml`
                    );
                    if (res.ok) {
                        const text = await res.text();
                        // Simple YAML parse: look for js_injection field
                        declaration = parseJsInjectionFromYaml(text);
                        break;
                    }
                } catch {}
            }
        } else if (parsed.protocol === 'https:') {
            // Non-GitHub HTTPS: try /.well-known/clawmark.json
            try {
                const res = await fetch(`${parsed.origin}/.well-known/clawmark.json`, {
                    signal: AbortSignal.timeout(5000),
                });
                if (res.ok) {
                    const json = await res.json();
                    if (json && typeof json === 'object') {
                        declaration = json.js_injection === false ? false : true;
                    }
                }
            } catch {}
        }

        const result = declaration === false ? false : true;
        _declarationCache.set(cacheKey, { value: result, ts: Date.now(), negative: declaration === null });

        // Evict old entries
        if (_declarationCache.size > 500) {
            const oldest = _declarationCache.keys().next().value;
            _declarationCache.delete(oldest);
        }

        return { js_injection: result };
    } catch {
        return { js_injection: true };
    }
}

/**
 * Parse js_injection field from YAML text without a full YAML parser.
 * Returns false if js_injection: false, true otherwise.
 */
function parseJsInjectionFromYaml(text) {
    const match = text.match(/^js_injection:\s*(false|true|no|yes)/mi);
    if (match) {
        const val = match[1].toLowerCase();
        return val === 'false' || val === 'no' ? false : true;
    }
    return true; // default: allowed
}
