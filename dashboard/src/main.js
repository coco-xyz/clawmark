/**
 * ClawMark Dashboard — Main Application
 *
 * Standalone web SPA replacing the Chrome extension options page.
 * All chrome.runtime.sendMessage calls are replaced with direct HTTP API calls.
 */

'use strict';

import {
    isLoggedIn, getUser, setAuth, clearAuth, getServerUrl, setServerUrl, getDefaultServerUrl,
    loginWithCode, getMe, checkHealth,
    getAnalyticsSummary, getItems,
    getRoutingRules, createRoutingRule, updateRoutingRule, deleteRoutingRule,
    getAuths, createAuth, updateAuth, deleteAuth,
    checkLatestVersion,
    getUserSettings, updateUserSettings,
    getAuthFromExtension, loginViaExtension,
} from './api.js';

import { startGoogleLogin, extractAuthCode, getRedirectUri, clearUrlParams } from './auth.js';

// ------------------------------------------------------------------ init

async function init() {
    // Handle OAuth callback
    const code = extractAuthCode();
    if (code) {
        clearUrlParams();
        try {
            const result = await loginWithCode(code, getRedirectUri());
            setAuth(result.token, result.user);
        } catch (err) {
            showToast('Login failed: ' + err.message, 'error');
        }
    }

    const isWelcome = location.hash === '#welcome';

    // If not logged in locally, try syncing auth from the Chrome extension
    if (!isLoggedIn()) {
        const extAuth = await getAuthFromExtension();
        if (extAuth) {
            setAuth(extAuth.authToken, extAuth.authUser);
        }
    }

    if (isLoggedIn()) {
        // Verify token is still valid
        try {
            const { user } = await getMe();
            setAuth(localStorage.getItem('clawmark_token'), user);
            if (isWelcome) location.hash = 'overview';
            showApp(user);
        } catch {
            clearAuth();
            if (isWelcome) {
                showWelcome();
            } else {
                showLogin();
            }
        }
    } else if (isWelcome) {
        showWelcome();
    } else {
        showLogin();
    }
}

function showWelcome() {
    document.getElementById('welcome-screen').style.display = 'flex';
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'none';
}

function showLogin() {
    document.getElementById('welcome-screen').style.display = 'none';
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
}

function showApp(user) {
    document.getElementById('welcome-screen').style.display = 'none';
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';

    // Populate sidebar user
    const userEl = document.getElementById('sidebar-user');
    if (user) {
        userEl.textContent = user.name || user.email || '';
    }

    loadOverview();
    loadAccount();
    loadConnection();
    loadAuthsList();
    loadRules();
    loadAbout();

    // Handle old hash routes that were consolidated
    const hash = location.hash.slice(1);
    if (['account', 'connection', 'auths'].includes(hash)) {
        switchTab('settings');
    } else if (hash === 'sites' || hash === 'about') {
        switchTab('overview');
    }
}

// ------------------------------------------------------------------ login

async function handleGoogleLogin() {
    // Try extension login first (uses chrome.identity popup — no redirect)
    const result = await loginViaExtension();
    if (result) {
        setAuth(result.token, result.user);
        showApp(result.user);
        return;
    }
    // Fallback: Dashboard's own OAuth redirect flow
    startGoogleLogin();
}

document.getElementById('btn-login').addEventListener('click', handleGoogleLogin);

document.getElementById('btn-welcome-login').addEventListener('click', handleGoogleLogin);

// ------------------------------------------------------------------ tab navigation

const navItems = document.querySelectorAll('.nav-item');
const tabPanels = document.querySelectorAll('.tab-panel');

function switchTab(tab) {
    navItems.forEach(n => n.classList.remove('active'));
    tabPanels.forEach(p => p.classList.remove('active'));
    const navItem = document.querySelector(`.nav-item[data-tab="${tab}"]`);
    if (navItem) navItem.classList.add('active');
    const panel = document.getElementById(`tab-${tab}`);
    if (panel) panel.classList.add('active');
    location.hash = tab;
}

navItems.forEach(item => {
    item.addEventListener('click', () => switchTab(item.dataset.tab));
});

// Restore tab from URL hash
const hashTab = location.hash.slice(1);
if (hashTab && document.getElementById(`tab-${hashTab}`)) {
    switchTab(hashTab);
}

// ------------------------------------------------------------------ toast

function showToast(text, type = 'success') {
    const el = document.getElementById('toast');
    el.textContent = text;
    el.className = `toast visible ${type}`;
    setTimeout(() => { el.className = 'toast'; }, 3000);
}

// ------------------------------------------------------------------ helpers

function escHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function parseConfig(config) {
    if (typeof config !== 'string') return config || {};
    try { return JSON.parse(config); } catch { return {}; }
}

function formatTarget(type, config) {
    const cfg = parseConfig(config);
    switch (type) {
        case 'github-issue': return `GitHub: ${cfg.repo || '?'}`;
        case 'gitlab-issue': return `GitLab: ${cfg.project_id || '?'}`;
        case 'lark': return `Lark: ${(cfg.webhook_url || '').substring(0, 40)}`;
        case 'telegram': return `Telegram: ${cfg.chat_id || '?'}`;
        case 'webhook': return `Webhook: ${(cfg.url || '').substring(0, 40)}`;
        case 'slack': return `Slack: ${cfg.channel || (cfg.webhook_url || '').substring(0, 40)}`;
        case 'email': return `Email: ${(cfg.to || []).join(', ').substring(0, 40) || '?'}`;
        case 'linear': return `Linear: ${cfg.team_id || '?'}`;
        case 'jira': return `Jira: ${cfg.project_key || '?'}`;
        case 'hxa-connect': return `HxA: ${cfg.agent_id || '?'}`;
        default: return type;
    }
}

const DISPATCH_ICONS = {
    'github-issue': '\ud83d\udc19', 'gitlab-issue': '\ud83e\udd4a', 'lark': '\ud83d\udc26', 'telegram': '\u2708\ufe0f',
    'webhook': '\ud83d\udd17', 'slack': '\ud83d\udcac', 'email': '\u2709\ufe0f',
    'linear': '\ud83d\udcca', 'jira': '\ud83c\udfaf', 'hxa-connect': '\ud83e\udd16',
};

const DISPATCH_STATUS_COLORS = {
    'delivered': '#22c55e', 'pending': '#f59e0b', 'failed': '#ef4444', 'exhausted': '#dc2626',
};

function renderItemDispatches(dispatches) {
    if (!dispatches || dispatches.length === 0) return '';
    const badges = dispatches.map(d => {
        const icon = DISPATCH_ICONS[d.target_type] || '\u27a1';
        const color = DISPATCH_STATUS_COLORS[d.status] || '#888';
        const label = d.target_type.replace(/-/g, ' ');
        const link = d.external_url
            ? ` <a href="${escHtml(d.external_url)}" target="_blank" class="dispatch-ext-link" title="Open">\u2197</a>`
            : '';
        return `<span class="item-dispatch-badge" style="border-color:${color}" title="${escHtml(label)} \u2014 ${d.status}">${icon}${link}</span>`;
    }).join('');
    return `<div class="item-dispatch-row">${badges}</div>`;
}

// ------------------------------------------------------------------ Overview

async function loadOverview() {
    try {
        const summary = await getAnalyticsSummary();
        document.getElementById('stat-total').textContent = summary.total || 0;
        const commentCount = (summary.byType || []).find(t => t.type === 'comment')?.count || 0;
        const issueCount = (summary.byType || []).find(t => t.type === 'issue')?.count || 0;
        document.getElementById('stat-comments').textContent = commentCount;
        document.getElementById('stat-issues').textContent = issueCount;
        renderTopPages(summary.topUrls || []);
    } catch { /* non-critical */ }

    try {
        const result = await getRoutingRules();
        document.getElementById('stat-rules').textContent = (result.rules || []).length;
    } catch {
        document.getElementById('stat-rules').textContent = '\u2014';
    }
}

function renderTopPages(topUrls) {
    const listEl = document.getElementById('activity-list');
    document.getElementById('activity-heading').textContent = 'Top Annotated Pages';
    if (topUrls.length === 0) {
        listEl.innerHTML = '<div class="empty-state">No annotations yet</div>';
        return;
    }
    listEl.innerHTML = '';
    for (const page of topUrls) {
        const el = document.createElement('div');
        el.className = 'activity-item' + (page.source_url ? ' activity-item-link' : '');
        el.innerHTML = `
            <span class="activity-type">\ud83d\udcc4</span>
            <div class="activity-body">
                <div class="activity-title">${escHtml(page.source_title || page.source_url)}</div>
                <div class="activity-meta">${Number(page.count) || 0} annotation${Number(page.count) !== 1 ? 's' : ''}</div>
            </div>`;
        if (page.source_url) {
            el.addEventListener('click', () => window.open(page.source_url, '_blank'));
        }
        listEl.appendChild(el);
    }
}

async function loadItemsList(typeFilter) {
    const heading = document.getElementById('activity-heading');
    heading.textContent = typeFilter === 'comment' ? 'All Comments' : typeFilter === 'issue' ? 'All Issues' : 'All Annotations';

    const listEl = document.getElementById('activity-list');
    listEl.innerHTML = '<div class="empty-state">Loading...</div>';

    try {
        const params = {};
        if (typeFilter) params.type = typeFilter;
        const result = await getItems(params);
        const items = result.items || [];

        if (items.length === 0) {
            listEl.innerHTML = '<div class="empty-state">No items found</div>';
            return;
        }

        listEl.innerHTML = '';
        for (const item of items.slice(0, 50)) {
            const icon = item.type === 'issue' ? '\ud83d\udc1b' : '\ud83d\udcac';
            const time = item.created_at ? new Date(item.created_at).toLocaleString() : '';
            const sourceLabel = item.source_title || (item.source_url ? new URL(item.source_url).hostname + new URL(item.source_url).pathname.substring(0, 30) : '');
            const el = document.createElement('div');
            el.className = 'activity-item' + (item.source_url ? ' activity-item-link' : '');
            el.innerHTML = `
                <span class="activity-type">${icon}</span>
                <div class="activity-body">
                    <div class="activity-title">${escHtml(item.title || item.content || '(untitled)')}</div>
                    ${sourceLabel ? `<div class="activity-source">\ud83d\udcc4 ${escHtml(sourceLabel)}</div>` : ''}
                    ${renderItemDispatches(item.dispatches)}
                    <div class="activity-meta">${time ? escHtml(time) : ''}</div>
                </div>`;
            if (item.source_url) {
                el.addEventListener('click', (e) => {
                    if (e.target.closest('.dispatch-ext-link')) return;
                    window.open(item.source_url, '_blank');
                });
            }
            listEl.appendChild(el);
        }
    } catch {
        listEl.innerHTML = '<div class="empty-state">Failed to load items</div>';
    }
}

// Stat card click handlers
document.querySelectorAll('.stat-card.clickable').forEach(card => {
    card.addEventListener('click', () => {
        const action = card.dataset.action;
        if (action === 'rules') {
            document.querySelector('[data-tab="delivery"]').click();
            return;
        }
        const typeFilter = action === 'comments' ? 'comment' : action === 'issues' ? 'issue' : null;
        loadItemsList(typeFilter);
    });
});

// ------------------------------------------------------------------ Account

function loadAccount() {
    const user = getUser();
    if (!user) return;

    document.getElementById('account-name').textContent = user.name || user.email || 'User';
    document.getElementById('account-email').textContent = user.email || '';

    const avatarEl = document.getElementById('account-avatar');
    if (user.picture) {
        avatarEl.textContent = '';
        const img = document.createElement('img');
        img.src = user.picture;
        img.alt = '';
        avatarEl.appendChild(img);
    } else {
        avatarEl.textContent = (user.name || user.email || 'U').charAt(0).toUpperCase();
    }
}

document.getElementById('btn-sign-out').addEventListener('click', () => {
    clearAuth();
    showLogin();
    showToast('Signed out');
});

// ------------------------------------------------------------------ Connection

async function loadConnection() {
    // Try loading server URL from server-side user settings first
    try {
        const { settings } = await getUserSettings();
        if (settings?.server_url) {
            setServerUrl(settings.server_url);
        }
    } catch { /* fallback to localStorage */ }
    document.getElementById('opt-server-url').value = getServerUrl();
    await testConnection();
}

async function testConnection() {
    const dot = document.getElementById('conn-dot');
    const text = document.getElementById('conn-text');
    const versionEl = document.getElementById('server-version');
    dot.classList.remove('connected');
    text.textContent = 'Checking...';

    try {
        const health = await checkHealth();
        if (health.status === 'ok') {
            dot.classList.add('connected');
            text.textContent = 'Connected';
            versionEl.textContent = `Server v${health.version || '?'}`;
        } else {
            text.textContent = 'Server error';
            versionEl.textContent = '\u2014';
        }
    } catch {
        text.textContent = 'Cannot reach server';
        versionEl.textContent = '\u2014';
    }
}

document.getElementById('btn-save-server').addEventListener('click', async () => {
    const input = document.getElementById('opt-server-url');
    const url = input.value.trim();
    if (!url) {
        showToast('Server URL cannot be empty', 'error');
        return;
    }
    setServerUrl(url);
    input.value = getServerUrl();
    // Persist to server-side user settings
    try {
        await updateUserSettings({ server_url: getServerUrl() });
    } catch { /* localStorage fallback already saved */ }
    showToast('Server URL saved');
    await testConnection();
});

document.getElementById('btn-test-server').addEventListener('click', async () => {
    // Temporarily use the input value for testing without saving
    const input = document.getElementById('opt-server-url');
    const url = input.value.trim();
    if (!url) {
        showToast('Server URL cannot be empty', 'error');
        return;
    }
    const dot = document.getElementById('conn-dot');
    const text = document.getElementById('conn-text');
    const versionEl = document.getElementById('server-version');
    dot.classList.remove('connected');
    text.textContent = 'Testing...';
    try {
        const res = await fetch(url.replace(/\/+$/, '') + '/health');
        const health = await res.json();
        if (health.status === 'ok') {
            dot.classList.add('connected');
            text.textContent = 'Connected';
            versionEl.textContent = `Server v${health.version || '?'}`;
            showToast('Connection successful');
        } else {
            text.textContent = 'Server error';
            versionEl.textContent = '\u2014';
            showToast('Server returned an error', 'error');
        }
    } catch {
        text.textContent = 'Cannot reach server';
        versionEl.textContent = '\u2014';
        showToast('Cannot reach server', 'error');
    }
});

document.getElementById('btn-reset-server').addEventListener('click', async () => {
    setServerUrl(null);
    document.getElementById('opt-server-url').value = getDefaultServerUrl();
    // Clear server-side setting too
    try {
        await updateUserSettings({ server_url: null });
    } catch { /* ignore */ }
    showToast('Server URL reset to default');
    await testConnection();
});

// ------------------------------------------------------------------ Delivery Rules

let allRules = [];
let editingRuleId = null;

async function loadRules() {
    try {
        const result = await getRoutingRules();
        allRules = result.rules || [];
        renderRulesTable();
    } catch {
        allRules = [];
        renderRulesTable();
    }
}

function renderRulesTable() {
    const tbody = document.getElementById('rules-tbody');
    const emptyEl = document.getElementById('rules-empty');
    tbody.innerHTML = '';

    if (allRules.length === 0) {
        emptyEl.style.display = 'block';
        return;
    }
    emptyEl.style.display = 'none';

    for (const rule of allRules) {
        const tr = document.createElement('tr');
        const patternText = rule.rule_type === 'default' ? '(default)' : (rule.pattern || '\u2014');
        const authBadge = rule.auth_name ? ` <span class="type-badge" style="font-size:11px;background:var(--bg-secondary);">${escHtml(rule.auth_name)}</span>` : (rule.auth_id ? ' <span class="type-badge" style="font-size:11px;background:#f59e0b22;color:#f59e0b;">auth?</span>' : '');
        tr.innerHTML = `
            <td><span class="type-badge">${escHtml(rule.rule_type)}</span></td>
            <td title="${escHtml(patternText)}">${escHtml(patternText)}</td>
            <td title="${escHtml(formatTarget(rule.target_type, rule.target_config))}">${escHtml(formatTarget(rule.target_type, rule.target_config))}${authBadge}</td>
            <td>${rule.priority || 0}</td>
            <td class="actions-cell">
                <button class="edit-btn" data-id="${escHtml(rule.id)}">Edit</button>
                <button class="del-btn" data-id="${escHtml(rule.id)}">Delete</button>
            </td>`;
        tr.querySelector('.edit-btn').addEventListener('click', () => openRuleModal(rule));
        tr.querySelector('.del-btn').addEventListener('click', () => doDeleteRule(rule.id));
        tbody.appendChild(tr);
    }
}

// ---- Rule Modal

const ruleModal = document.getElementById('rule-modal');
const rfType = document.getElementById('opt-rf-type');
const rfPattern = document.getElementById('opt-rf-pattern');
const rfPatternLabel = document.getElementById('opt-rf-pattern-label');
const rfTarget = document.getElementById('opt-rf-target');
const rfPriority = document.getElementById('opt-rf-priority');
const targetFieldsEl = document.getElementById('opt-target-fields');

// Credential keys that may exist inline in old target_config (pre-auth-management)
const INLINE_CRED_KEYS = ['token', 'bot_token', 'webhook_url', 'secret', 'api_key', 'api_token'];
let editingRuleOrigConfig = null; // preserve original config for inline credential migration

function hasInlineCredentials(cfg) {
    if (!cfg) return false;
    return INLINE_CRED_KEYS.some(k => cfg[k]);
}

function openRuleModal(rule) {
    editingRuleId = rule ? rule.id : null;
    editingRuleOrigConfig = rule ? parseConfig(rule.target_config) : null;
    document.getElementById('rule-modal-title').textContent = rule ? 'Edit Rule' : 'Add Rule';
    document.getElementById('rule-modal-save').textContent = rule ? 'Update Rule' : 'Save Rule';

    rfType.value = rule ? rule.rule_type : 'url_pattern';
    rfPattern.value = rule ? (rule.pattern || '') : '';
    rfTarget.value = rule ? rule.target_type : 'github-issue';
    rfPriority.value = rule ? (rule.priority || 0) : 0;

    const isDefault = rfType.value === 'default';
    rfPatternLabel.style.display = isDefault ? 'none' : 'block';
    rfPattern.style.display = isDefault ? 'none' : 'block';

    updateTargetFields(rfTarget.value, editingRuleOrigConfig, rule ? rule.auth_id : null);
    ruleModal.style.display = 'flex';
}

function closeRuleModal() {
    ruleModal.style.display = 'none';
    editingRuleId = null;
}

document.getElementById('btn-add-rule').addEventListener('click', () => openRuleModal(null));

// Quick-add templates — open modal pre-filled with common setups
const RULE_TEMPLATES = {
    github: { rule_type: 'default', target_type: 'github-issue', target_config: {} },
    gitlab: { rule_type: 'default', target_type: 'gitlab-issue', target_config: {} },
    lark: { rule_type: 'default', target_type: 'lark', target_config: {} },
    telegram: { rule_type: 'default', target_type: 'telegram', target_config: {} },
    slack: { rule_type: 'default', target_type: 'slack', target_config: {} },
};

document.querySelectorAll('.quick-add-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const tpl = RULE_TEMPLATES[btn.dataset.template];
        if (!tpl) return;
        openRuleModal(null); // open empty modal first
        rfType.value = tpl.rule_type;
        rfTarget.value = tpl.target_type;
        rfPattern.value = '';
        rfPriority.value = 0;
        const isDefault = tpl.rule_type === 'default';
        rfPatternLabel.style.display = isDefault ? 'none' : 'block';
        rfPattern.style.display = isDefault ? 'none' : 'block';
        updateTargetFields(tpl.target_type, tpl.target_config, null);
    });
});
document.getElementById('rule-modal-close').addEventListener('click', closeRuleModal);
document.getElementById('rule-modal-cancel').addEventListener('click', closeRuleModal);
ruleModal.addEventListener('click', (e) => {
    if (e.target === ruleModal) closeRuleModal();
});

rfType.addEventListener('change', () => {
    const isDefault = rfType.value === 'default';
    rfPatternLabel.style.display = isDefault ? 'none' : 'block';
    rfPattern.style.display = isDefault ? 'none' : 'block';
});

rfTarget.addEventListener('change', () => {
    updateTargetFields(rfTarget.value, null, null);
});

// Mask a credential string: show only last 4 chars
function maskSecret(val) {
    if (!val) return '';
    return val.length > 4 ? '••••' + val.slice(-4) : '••••';
}

// Sentinel for "unchanged" password fields
const SECRET_UNCHANGED = '••••____UNCHANGED____';

// Map target types to compatible auth types
const TARGET_AUTH_TYPES = {
    'github-issue': ['github-pat'],
    'gitlab-issue': ['gitlab-pat'],
    'lark': ['lark-webhook'],
    'telegram': ['telegram-bot'],
    'webhook': ['webhook-secret'],
    'slack': ['slack-webhook'],
    'email': ['email-api'],
    'linear': ['linear-api'],
    'jira': ['jira-api'],
    'hxa-connect': ['hxa-api'],
};

function buildAuthSelector(targetType, selectedAuthId) {
    const compatibleTypes = TARGET_AUTH_TYPES[targetType] || [];
    const compatible = allAuths.filter(a => compatibleTypes.includes(a.auth_type));
    if (compatible.length === 0) {
        return `<label>Auth</label><div class="help-text" style="margin-bottom:8px;">No ${compatibleTypes.join('/')} auths configured. <a href="#" onclick="document.querySelector('[data-tab=settings]').click();return false;">Add one first</a>.</div>
            <input type="hidden" id="tc-auth-id" value="">`;
    }
    let opts = '<option value="">(none)</option>';
    for (const a of compatible) {
        const sel = a.id === selectedAuthId ? ' selected' : '';
        opts += `<option value="${escHtml(a.id)}"${sel}>${escHtml(a.name)}</option>`;
    }
    return `<label>Auth</label><select class="input" id="tc-auth-id">${opts}</select>`;
}

function updateTargetFields(targetType, existingConfig, selectedAuthId) {
    const cfg = existingConfig || {};
    let html = '';

    // Warn if this rule has inline credentials but no auth assigned yet
    if (editingRuleId && hasInlineCredentials(cfg) && !selectedAuthId) {
        html += `<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:6px;padding:8px 12px;margin-bottom:8px;font-size:0.85em;">
            ⚠️ This rule has inline credentials. Please create an Auth in the Auth tab and select it here. Inline credentials will be preserved until you assign an auth.
        </div>`;
    }

    html += buildAuthSelector(targetType, selectedAuthId);
    switch (targetType) {
        case 'github-issue':
            html += `
                <label>Repository (owner/repo)</label>
                <input type="text" class="input" id="tc-repo" placeholder="owner/repo" value="${escHtml(cfg.repo || '')}">
                <label>Labels (comma-separated)</label>
                <input type="text" class="input" id="tc-labels" placeholder="clawmark, bug" value="${escHtml((cfg.labels || []).join(', '))}">`;
            break;
        case 'gitlab-issue':
            html += `
                <label>Project (namespace/project or ID)</label>
                <input type="text" class="input" id="tc-project-id" placeholder="hxanet/clawmark or 123" value="${escHtml(cfg.project_id || '')}">
                <label>GitLab URL (optional, default: https://gitlab.com)</label>
                <input type="text" class="input" id="tc-base-url" placeholder="https://gitlab.com" value="${escHtml(cfg.base_url || '')}">
                <label>Labels (comma-separated)</label>
                <input type="text" class="input" id="tc-gl-labels" placeholder="clawmark, bug" value="${escHtml((cfg.labels || []).join(', '))}">`;
            break;
        case 'lark':
            // Webhook URL is now in auth credentials
            break;
        case 'telegram':
            html += `<label>Chat ID</label><input type="text" class="input" id="tc-chat-id" value="${escHtml(cfg.chat_id || '')}">`;
            break;
        case 'webhook':
            html += `<label>Webhook URL</label><input type="text" class="input" id="tc-url" value="${escHtml(cfg.url || '')}">`;
            break;
        case 'slack':
            html += `<label>Channel (optional)</label><input type="text" class="input" id="tc-slack-channel" value="${escHtml(cfg.channel || '')}">`;
            break;
        case 'email':
            html += `
                <label>To (comma-separated)</label><input type="text" class="input" id="tc-email-to" value="${escHtml((cfg.to || []).join(', '))}">`;
            break;
        case 'linear':
            html += `
                <label>Team ID</label><input type="text" class="input" id="tc-linear-team" value="${escHtml(cfg.team_id || '')}">
                <label>Assignee ID (optional)</label><input type="text" class="input" id="tc-linear-assignee" value="${escHtml(cfg.assignee_id || '')}">`;
            break;
        case 'jira':
            html += `
                <label>Project Key</label><input type="text" class="input" id="tc-jira-project" value="${escHtml(cfg.project_key || '')}">
                <label>Issue Type (optional)</label><input type="text" class="input" id="tc-jira-issuetype" value="${escHtml(cfg.issue_type || '')}">`;
            break;
        case 'hxa-connect':
            html += `
                <label>Hub URL</label><input type="text" class="input" id="tc-hxa-hub" value="${escHtml(cfg.hub_url || '')}">
                <label>Agent ID</label><input type="text" class="input" id="tc-hxa-agent" value="${escHtml(cfg.agent_id || '')}">
                <label>Thread ID (optional)</label><input type="text" class="input" id="tc-hxa-thread" value="${escHtml(cfg.thread_id || '')}">`;
            break;
    }
    targetFieldsEl.innerHTML = html;
}

// Get field value; return undefined if it's the unchanged sentinel (so server keeps existing)
function fieldVal(id) {
    const v = (document.getElementById(id)?.value || '').trim();
    return v === SECRET_UNCHANGED ? undefined : v;
}

function getTargetConfig() {
    const type = rfTarget.value;
    const authId = getSelectedAuthId();
    let cfg;
    switch (type) {
        case 'github-issue': {
            const repo = fieldVal('tc-repo') || '';
            const labelsRaw = fieldVal('tc-labels') || '';
            const labels = labelsRaw ? labelsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
            cfg = { repo, labels, assignees: [] };
            break;
        }
        case 'gitlab-issue': {
            const projectId = fieldVal('tc-project-id') || '';
            const baseUrl = fieldVal('tc-base-url') || '';
            const glLabelsRaw = fieldVal('tc-gl-labels') || '';
            const glLabels = glLabelsRaw ? glLabelsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
            cfg = { project_id: projectId, labels: glLabels };
            if (baseUrl) cfg.base_url = baseUrl;
            break;
        }
        case 'lark':
            cfg = {}; break;
        case 'telegram':
            cfg = { chat_id: fieldVal('tc-chat-id') || '' }; break;
        case 'webhook':
            cfg = { url: fieldVal('tc-url') || '' }; break;
        case 'slack': {
            const ch = fieldVal('tc-slack-channel') || '';
            cfg = ch ? { channel: ch } : {};
            break;
        }
        case 'email': {
            const toRaw = fieldVal('tc-email-to') || '';
            const to = toRaw ? toRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
            cfg = { to };
            break;
        }
        case 'linear': {
            cfg = { team_id: fieldVal('tc-linear-team') || '' };
            const assigneeId = fieldVal('tc-linear-assignee') || '';
            if (assigneeId) cfg.assignee_id = assigneeId;
            break;
        }
        case 'jira': {
            cfg = { project_key: fieldVal('tc-jira-project') || '' };
            const issueType = fieldVal('tc-jira-issuetype') || '';
            if (issueType) cfg.issue_type = issueType;
            break;
        }
        case 'hxa-connect': {
            cfg = { hub_url: fieldVal('tc-hxa-hub') || '', agent_id: fieldVal('tc-hxa-agent') || '' };
            const threadId = fieldVal('tc-hxa-thread') || '';
            if (threadId) cfg.thread_id = threadId;
            break;
        }
        default:
            cfg = {}; break;
    }

    // Preserve inline credentials from old rules when no auth is selected.
    // This prevents silently wiping credentials on edit-save of pre-migration rules.
    if (!authId && editingRuleOrigConfig && hasInlineCredentials(editingRuleOrigConfig)) {
        for (const k of INLINE_CRED_KEYS) {
            if (editingRuleOrigConfig[k] && !(k in cfg)) {
                cfg[k] = editingRuleOrigConfig[k];
            }
        }
    }

    return cfg;
}

function getSelectedAuthId() {
    return document.getElementById('tc-auth-id')?.value || null;
}

document.getElementById('rule-modal-save').addEventListener('click', async () => {
    const type = rfType.value;
    const target = rfTarget.value;
    const pattern = rfPattern.value.trim();

    if (type !== 'default' && !pattern) {
        showToast('Pattern is required', 'error');
        return;
    }

    const saveBtn = document.getElementById('rule-modal-save');
    saveBtn.disabled = true;

    try {
        const data = {
            rule_type: type,
            pattern: type === 'default' ? null : pattern,
            target_type: target,
            target_config: getTargetConfig(),
            priority: Math.max(0, Math.min(100, parseInt(rfPriority.value, 10) || 0)),
            auth_id: getSelectedAuthId(),
        };

        if (editingRuleId) {
            await updateRoutingRule(editingRuleId, data);
            showToast('Rule updated');
        } else {
            await createRoutingRule(data);
            showToast('Rule created');
        }

        closeRuleModal();
        await loadRules();
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        saveBtn.disabled = false;
    }
});

async function doDeleteRule(id) {
    if (!confirm('Delete this routing rule?')) return;
    try {
        await deleteRoutingRule(id);
        showToast('Rule deleted');
        await loadRules();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// ---- Export / Import

document.getElementById('btn-export-rules').addEventListener('click', () => {
    if (allRules.length === 0) {
        showToast('No rules to export', 'error');
        return;
    }
    const blob = new Blob([JSON.stringify(allRules, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `clawmark-rules-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Rules exported');
});

document.getElementById('btn-import-rules').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
        const text = await file.text();
        const rules = JSON.parse(text);
        if (!Array.isArray(rules)) throw new Error('Expected an array of rules');
        let imported = 0;
        for (const rule of rules) {
            const data = {
                rule_type: rule.rule_type,
                pattern: rule.pattern,
                target_type: rule.target_type,
                target_config: typeof rule.target_config === 'string' ? JSON.parse(rule.target_config) : rule.target_config,
                priority: rule.priority || 0,
            };
            await createRoutingRule(data);
            imported++;
        }
        showToast(`Imported ${imported} rules`);
        await loadRules();
    } catch (err) {
        showToast(`Import failed: ${err.message}`, 'error');
    }
    e.target.value = '';
});

// ------------------------------------------------------------------ Auth Management

let allAuths = [];
let editingAuthId = null;

async function loadAuthsList() {
    try {
        const result = await getAuths();
        allAuths = result.auths || [];
        renderAuthsTable();
    } catch {
        allAuths = [];
        renderAuthsTable();
    }
}

function renderAuthsTable() {
    const tbody = document.getElementById('auths-tbody');
    const emptyEl = document.getElementById('auths-empty');
    tbody.innerHTML = '';

    if (allAuths.length === 0) {
        emptyEl.style.display = 'block';
        return;
    }
    emptyEl.style.display = 'none';

    for (const auth of allAuths) {
        const creds = typeof auth.credentials === 'string' ? JSON.parse(auth.credentials) : (auth.credentials || {});
        const credSummary = Object.entries(creds).map(([k, v]) => `${k}: ${v}`).join(', ');
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${escHtml(auth.name)}</td>
            <td><span class="type-badge">${escHtml(auth.auth_type)}</span></td>
            <td title="${escHtml(credSummary)}">${escHtml(credSummary).substring(0, 50)}</td>
            <td class="actions-cell">
                <button class="edit-btn" data-id="${escHtml(auth.id)}">Edit</button>
                <button class="del-btn" data-id="${escHtml(auth.id)}">Delete</button>
            </td>`;
        tr.querySelector('.edit-btn').addEventListener('click', () => openAuthModal(auth));
        tr.querySelector('.del-btn').addEventListener('click', () => doDeleteAuth(auth.id));
        tbody.appendChild(tr);
    }
}

// Auth type → credential fields config
const AUTH_TYPE_FIELDS = {
    'github-pat':     [{ key: 'token', label: 'Personal Access Token', secret: true }],
    'gitlab-pat':     [{ key: 'token', label: 'Personal Access Token', secret: true }],
    'lark-webhook':   [{ key: 'webhook_url', label: 'Webhook URL', secret: true }, { key: 'secret', label: 'Secret (optional)', secret: true }],
    'telegram-bot':   [{ key: 'bot_token', label: 'Bot Token', secret: true }],
    'slack-webhook':  [{ key: 'webhook_url', label: 'Webhook URL', secret: true }],
    'email-api':      [{ key: 'api_key', label: 'API Key', secret: true }, { key: 'provider', label: 'Provider (resend/sendgrid)', secret: false }, { key: 'from', label: 'From Email', secret: false }],
    'linear-api':     [{ key: 'api_key', label: 'API Key', secret: true }],
    'jira-api':       [{ key: 'email', label: 'Email', secret: false }, { key: 'api_token', label: 'API Token', secret: true }, { key: 'domain', label: 'Domain', secret: false }],
    'hxa-api':        [{ key: 'api_key', label: 'API Key', secret: true }],
    'webhook-secret': [{ key: 'secret', label: 'Secret', secret: true }],
};

const AUTH_UNCHANGED = '••••____UNCHANGED____';

function updateAuthFields(authType, existingCreds) {
    const fieldsEl = document.getElementById('opt-auth-fields');
    const fields = AUTH_TYPE_FIELDS[authType] || [];
    const creds = existingCreds || {};
    const isEdit = !!existingCreds;

    let html = '';
    for (const f of fields) {
        const inputType = f.secret ? 'password' : 'text';
        const val = isEdit && f.secret && creds[f.key] ? AUTH_UNCHANGED : escHtml(creds[f.key] || '');
        html += `<label>${escHtml(f.label)}</label>
            <input type="${inputType}" class="input auth-cred-field" data-key="${f.key}" ${f.secret ? 'data-secret="1"' : ''} value="${val}">`;
    }
    fieldsEl.innerHTML = html;
    fieldsEl.querySelectorAll('[data-secret]').forEach(el => {
        el.addEventListener('focus', () => {
            if (el.value === AUTH_UNCHANGED) el.value = '';
        }, { once: true });
    });
}

function getAuthCredentials() {
    const fields = document.querySelectorAll('.auth-cred-field');
    const creds = {};
    for (const field of fields) {
        const val = field.value.trim();
        if (val === AUTH_UNCHANGED) continue; // Keep existing
        if (val) creds[field.dataset.key] = val;
    }
    return creds;
}

const authModal = document.getElementById('auth-modal');
const authTypeSelect = document.getElementById('opt-auth-type');

authTypeSelect.addEventListener('change', () => {
    updateAuthFields(authTypeSelect.value);
});

function openAuthModal(auth) {
    editingAuthId = auth ? auth.id : null;
    document.getElementById('auth-modal-title').textContent = auth ? 'Edit Auth' : 'Add Auth';
    document.getElementById('auth-modal-save').textContent = auth ? 'Update Auth' : 'Save Auth';
    document.getElementById('opt-auth-name').value = auth ? auth.name : '';
    authTypeSelect.value = auth ? auth.auth_type : 'github-pat';
    const creds = auth ? (typeof auth.credentials === 'string' ? JSON.parse(auth.credentials) : auth.credentials) : null;
    updateAuthFields(authTypeSelect.value, creds);
    authModal.style.display = 'flex';
}

function closeAuthModal() {
    authModal.style.display = 'none';
    editingAuthId = null;
}

document.getElementById('btn-add-auth').addEventListener('click', () => openAuthModal(null));
document.getElementById('auth-modal-close').addEventListener('click', closeAuthModal);
document.getElementById('auth-modal-cancel').addEventListener('click', closeAuthModal);
authModal.addEventListener('click', (e) => { if (e.target === authModal) closeAuthModal(); });

document.getElementById('auth-modal-save').addEventListener('click', async () => {
    const name = document.getElementById('opt-auth-name').value.trim();
    const auth_type = authTypeSelect.value;
    if (!name) { showToast('Name is required', 'error'); return; }

    const credentials = getAuthCredentials();
    if (Object.keys(credentials).length === 0 && !editingAuthId) {
        showToast('At least one credential field is required', 'error');
        return;
    }

    const saveBtn = document.getElementById('auth-modal-save');
    saveBtn.disabled = true;
    try {
        const data = { name, auth_type, credentials };
        if (editingAuthId) {
            await updateAuth(editingAuthId, data);
            showToast('Auth updated');
        } else {
            await createAuth(data);
            showToast('Auth created');
        }
        closeAuthModal();
        await loadAuthsList();
        // Also refresh rules (they show auth_name)
        await loadRules();
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        saveBtn.disabled = false;
    }
});

async function doDeleteAuth(id) {
    if (!confirm('Delete this auth? (Will fail if any rules still reference it.)')) return;
    try {
        await deleteAuth(id);
        showToast('Auth deleted');
        await loadAuthsList();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// ------------------------------------------------------------------ About

async function loadAbout() {
    // Server version
    try {
        const health = await checkHealth();
        document.getElementById('about-server-version').textContent = health.version || '\u2014';
    } catch {
        document.getElementById('about-server-version').textContent = '\u2014';
    }

    // Latest GitHub release
    const release = await checkLatestVersion();
    const latestEl = document.getElementById('about-latest-version');
    if (release && release.latestVersion) {
        latestEl.textContent = release.latestVersion;
        latestEl.style.color = '#22c55e';

        // Show update guide with download link
        const card = document.getElementById('update-guide-card');
        const text = document.getElementById('update-guide-text');
        const link = document.getElementById('update-guide-link');
        text.textContent = `The latest extension version is ${release.latestVersion}. `
            + 'To update your Chrome extension: download the zip, go to chrome://extensions, '
            + 'enable Developer Mode, click "Load unpacked" and select the extracted folder.';
        link.href = release.downloadUrl || 'https://github.com/coco-xyz/clawmark/releases/latest';
        card.style.display = 'block';
    } else {
        latestEl.textContent = '\u2014';
    }
}

// ------------------------------------------------------------------ start

init();
