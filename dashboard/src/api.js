/**
 * ClawMark Dashboard — API Client
 *
 * Direct HTTP calls to the ClawMark server, replacing chrome.runtime.sendMessage.
 */

'use strict';

const STORAGE_KEY_TOKEN = 'clawmark_token';
const STORAGE_KEY_USER = 'clawmark_user';
const STORAGE_KEY_SERVER = 'clawmark_server_url';

const DEFAULT_SERVER = import.meta.env.VITE_SERVER_URL
    || (window.location.origin + '/clawmark');

export function getServerUrl() {
    return localStorage.getItem(STORAGE_KEY_SERVER) || DEFAULT_SERVER;
}

export function setServerUrl(url) {
    if (url) {
        localStorage.setItem(STORAGE_KEY_SERVER, url.replace(/\/+$/, ''));
    } else {
        localStorage.removeItem(STORAGE_KEY_SERVER);
    }
}

export function getDefaultServerUrl() {
    return DEFAULT_SERVER;
}

export function getToken() {
    return localStorage.getItem(STORAGE_KEY_TOKEN);
}

export function getUser() {
    const raw = localStorage.getItem(STORAGE_KEY_USER);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
}

export function setAuth(token, user) {
    localStorage.setItem(STORAGE_KEY_TOKEN, token);
    localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(user));
}

export function clearAuth() {
    localStorage.removeItem(STORAGE_KEY_TOKEN);
    localStorage.removeItem(STORAGE_KEY_USER);
}

export function isLoggedIn() {
    return !!getToken();
}

/**
 * Make an authenticated API call.
 */
async function apiFetch(path, opts = {}) {
    const url = getServerUrl() + path;
    const token = getToken();
    const headers = { ...opts.headers };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(url, { ...opts, headers });
    if (res.status === 401) {
        clearAuth();
        window.location.reload();
        throw new Error('Session expired');
    }
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
}

// ---- Auth

export async function loginWithCode(code, redirectUri) {
    return apiFetch('/api/v2/auth/google', {
        method: 'POST',
        body: { code, redirectUri },
    });
}

export async function getMe() {
    return apiFetch('/api/v2/auth/me');
}

// ---- Health

export async function checkHealth() {
    const url = getServerUrl() + '/health';
    const res = await fetch(url);
    return res.json();
}

// ---- Analytics

export async function getAnalyticsSummary() {
    return apiFetch('/api/v2/analytics/summary');
}

// ---- Items

export async function getItems(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return apiFetch('/api/v2/items' + (qs ? '?' + qs : ''));
}

// ---- Routing Rules

export async function getRoutingRules() {
    return apiFetch('/api/v2/routing/rules');
}

export async function createRoutingRule(data) {
    return apiFetch('/api/v2/routing/rules', {
        method: 'POST',
        body: data,
    });
}

export async function updateRoutingRule(id, data) {
    return apiFetch(`/api/v2/routing/rules/${id}`, {
        method: 'PUT',
        body: data,
    });
}

export async function deleteRoutingRule(id) {
    return apiFetch(`/api/v2/routing/rules/${id}`, {
        method: 'DELETE',
    });
}

// ---- User Settings (per-user server-side storage)

export async function getUserSettings() {
    return apiFetch('/api/v2/user/settings');
}

export async function updateUserSettings(patch) {
    return apiFetch('/api/v2/user/settings', {
        method: 'PUT',
        body: patch,
    });
}

// ---- Version check (GitHub API, no auth needed)

export async function checkLatestVersion() {
    try {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 5000);
        const res = await fetch(
            'https://api.github.com/repos/coco-xyz/clawmark/releases/latest',
            { signal: controller.signal }
        );
        if (!res.ok) return null;
        const release = await res.json();
        const latestTag = (release.tag_name || '').replace(/^v/, '');
        let downloadUrl = release.html_url;
        for (const asset of (release.assets || [])) {
            if (asset.name && asset.name.endsWith('.zip')) {
                downloadUrl = asset.browser_download_url;
                break;
            }
        }
        return { latestVersion: latestTag, downloadUrl };
    } catch {
        return null;
    }
}
