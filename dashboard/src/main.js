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
    checkLatestVersion, CLIENT_BUILD_INFO, getExtensionInfo,
    getUserSettings, updateUserSettings,
    syncLoginToExtension, syncLogoutToExtension, getAuthFromExtension,
    previewIssues, batchFileIssues,
    getPassiveMonitorSettings, setPassiveMonitorSettings,
    getErrorTrends,
    getAgentActions,
    getQualityReport,
    createBindingToken, listBindings, suspendBinding, resumeBinding, revokeBinding,
} from './api.js';

import { startGoogleLogin, extractAuthCode, getRedirectUri, clearUrlParams } from './auth.js';

// ------------------------------------------------------------------ init

async function init() {
    // Try extension auth first
    const extAuth = await getAuthFromExtension();
    if (extAuth) {
        setAuth(extAuth.token, extAuth.user);
        showApp(extAuth.user);
        return;
    }

    // Handle OAuth callback
    const code = extractAuthCode();
    if (code) {
        clearUrlParams();
        try {
            const result = await loginWithCode(code, getRedirectUri());
            setAuth(result.token, result.user);
            syncLoginToExtension(result.token, result.user);
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

    // Populate sidebar account
    loadSidebarAccount(user);

    loadOverview();
    loadConnection();
    loadBoundAgents();
    loadSitePermissions();
    loadPassiveMonitor();
    loadAuthsList();
    loadRules();
    loadFileIssues();
    loadAbout();

    // Handle old hash routes that were consolidated
    const hash = location.hash.slice(1);
    if (['account', 'connection', 'auths', 'delivery'].includes(hash)) {
        switchTab('settings');
    } else if (hash === 'about') {
        switchTab('about');
    } else if (hash === 'sites') {
        switchTab('overview');
    }
}

// ------------------------------------------------------------------ login

function handleGoogleLogin() {
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
    // Lazy-load monitoring tab on first activation (#87)
    if (tab === 'monitoring') loadMonitoring();
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
            document.querySelector('[data-tab="settings"]').click();
            return;
        }
        const typeFilter = action === 'comments' ? 'comment' : action === 'issues' ? 'issue' : null;
        loadItemsList(typeFilter);
    });
});

// ------------------------------------------------------------------ Account (sidebar)

function loadSidebarAccount(user) {
    if (!user) user = getUser();
    if (!user) return;

    document.getElementById('sidebar-account-name').textContent = user.name || user.email || 'User';
    document.getElementById('sidebar-account-email').textContent = user.email || '';

    const avatarEl = document.getElementById('sidebar-avatar');
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
    syncLogoutToExtension();
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
                <button class="dup-btn" data-id="${escHtml(rule.id)}" title="Duplicate this rule">Fork</button>
                <button class="del-btn" data-id="${escHtml(rule.id)}">Delete</button>
            </td>`;
        tr.querySelector('.edit-btn').addEventListener('click', () => openRuleModal(rule));
        tr.querySelector('.dup-btn').addEventListener('click', () => duplicateRule(rule));
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

function duplicateRule(rule) {
    // Open modal pre-filled with rule data but as a new rule (fork)
    const forked = { ...rule, id: null };
    // Append " (copy)" to pattern to avoid exact duplicate
    if (forked.pattern) forked.pattern += ' (copy)';
    openRuleModal(forked);
    // Override title to indicate fork
    document.getElementById('rule-modal-title').textContent = 'Fork Rule';
    document.getElementById('rule-modal-save').textContent = 'Save Rule';
    editingRuleId = null; // ensure it creates a new rule
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

// ------------------------------------------------------------------ Passive Monitor (#57)

async function loadPassiveMonitor() {
    const controls = document.getElementById('passive-monitor-controls');
    const noExt = document.getElementById('passive-monitor-no-ext');
    const settings = await getPassiveMonitorSettings();

    if (!settings) {
        controls.style.display = 'none';
        noExt.style.display = 'block';
        return;
    }

    controls.style.display = 'block';
    noExt.style.display = 'none';

    document.getElementById('opt-passive-enabled').checked = settings.passiveMonitorEnabled;
    document.getElementById('opt-passive-error-only').checked = settings.passiveMonitorErrorOnly;
    document.getElementById('opt-passive-disabled-sites').value =
        (settings.passiveMonitorDisabledSites || []).join('\n');
}

document.getElementById('btn-save-passive').addEventListener('click', async () => {
    const statusEl = document.getElementById('passive-save-status');
    statusEl.textContent = 'Saving...';

    const enabled = document.getElementById('opt-passive-enabled').checked;
    const errorOnly = document.getElementById('opt-passive-error-only').checked;
    const sitesRaw = document.getElementById('opt-passive-disabled-sites').value;
    const sites = sitesRaw.split('\n').map(s => s.trim().toLowerCase()).filter(Boolean);

    const ok = await setPassiveMonitorSettings({
        passiveMonitorEnabled: enabled,
        passiveMonitorErrorOnly: errorOnly,
        passiveMonitorDisabledSites: sites,
    });

    if (ok) {
        statusEl.textContent = 'Saved';
        showToast('Passive monitoring settings saved');
    } else {
        statusEl.textContent = 'Failed — extension not available';
        showToast('Failed to save settings', 'error');
    }
    setTimeout(() => { statusEl.textContent = ''; }, 3000);
});

// ------------------------------------------------------------------ Bound Agents (#108 Agent Binding)

let bindings = [];
let bindingPollTimer = null;

async function loadBoundAgents() {
    try {
        const data = await listBindings();
        bindings = Array.isArray(data?.bindings) ? data.bindings : [];
    } catch {
        bindings = [];
    }
    renderBoundAgents();
}

function getBindingStatusInfo(binding) {
    if (binding.status === 'pending') {
        const expires = binding.token_expires ? new Date(binding.token_expires) : null;
        const now = new Date();
        if (expires && expires <= now) return { cls: 'expired', icon: '⊘', label: 'Expired' };
        if (expires) {
            const hours = Math.max(0, Math.floor((expires - now) / 3600000));
            const mins = Math.max(0, Math.floor(((expires - now) % 3600000) / 60000));
            return { cls: 'pending', icon: '⏳', label: `Pending (${hours}h ${mins}m)` };
        }
        return { cls: 'pending', icon: '⏳', label: 'Pending' };
    }
    if (binding.status === 'suspended') return { cls: 'suspended', icon: '⏸', label: 'Suspended' };
    if (binding.status === 'revoked') return { cls: 'revoked', icon: '⊘', label: 'Revoked' };
    // active
    if (binding.connected) return { cls: 'connected', icon: '🟢', label: 'Connected' };
    const lastHb = binding.last_heartbeat ? new Date(binding.last_heartbeat) : null;
    if (lastHb) {
        const ago = Math.floor((Date.now() - lastHb.getTime()) / 60000);
        if (ago < 60) return { cls: 'disconnected', icon: '🔴', label: `Last seen ${ago}m ago` };
        return { cls: 'disconnected', icon: '🔴', label: `Last seen ${Math.floor(ago / 60)}h ago` };
    }
    return { cls: 'disconnected', icon: '🔴', label: 'Offline' };
}

function formatScopes(scopes) {
    if (!Array.isArray(scopes) || scopes.length === 0) return '';
    return scopes.map(s => `<span class="ba-scope-tag">${escHtml(s)}</span>`).join(' ');
}

function renderBoundAgents() {
    const listEl = document.getElementById('bound-agents-list');
    const emptyEl = document.getElementById('bound-agents-empty');

    listEl.querySelectorAll('.bound-agent-item').forEach(el => el.remove());

    if (bindings.length === 0) {
        emptyEl.style.display = '';
        return;
    }
    emptyEl.style.display = 'none';

    // Sort: pending first, then active, then suspended
    const order = { pending: 0, active: 1, suspended: 2, revoked: 3 };
    const sorted = [...bindings].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));

    sorted.forEach(binding => {
        const el = document.createElement('div');
        el.className = 'bound-agent-item';
        const info = getBindingStatusInfo(binding);
        const scopes = typeof binding.scopes === 'string' ? JSON.parse(binding.scopes) : (binding.scopes || []);

        if (binding.status === 'pending') {
            el.innerHTML = `
                <span class="ba-status-dot ${info.cls}" title="${escHtml(info.label)}"></span>
                <div class="ba-info">
                    <div class="ba-name">${info.icon} Pending Invitation${binding.label ? ' — ' + escHtml(binding.label) : ''}</div>
                    <div class="ba-meta">${escHtml(info.label)} · ${formatScopes(scopes)}</div>
                </div>
                <div class="ba-actions">
                    <button class="btn btn-danger btn-small" data-ba-action="revoke" data-ba-id="${escHtml(binding.id)}">Revoke</button>
                </div>
            `;
        } else {
            const name = binding.agent_name || 'Unknown Agent';
            const typeBadge = binding.agent_type ? `<span class="ba-type-tag">${escHtml(binding.agent_type)}</span>` : '';
            const nodeUrl = binding.agent_node_url || '';
            const activatedDate = binding.activated_at ? new Date(binding.activated_at).toLocaleDateString() : '';

            let actions = '';
            if (binding.status === 'active') {
                actions = `
                    <button class="btn btn-secondary btn-small" data-ba-action="suspend" data-ba-id="${escHtml(binding.id)}">Suspend</button>
                    <button class="btn btn-danger btn-small" data-ba-action="unbind" data-ba-id="${escHtml(binding.id)}">Unbind</button>
                `;
            } else if (binding.status === 'suspended') {
                actions = `
                    <button class="btn btn-primary btn-small" data-ba-action="resume" data-ba-id="${escHtml(binding.id)}">Resume</button>
                    <button class="btn btn-danger btn-small" data-ba-action="unbind" data-ba-id="${escHtml(binding.id)}">Unbind</button>
                `;
            }

            el.innerHTML = `
                <span class="ba-status-dot ${info.cls}" title="${escHtml(info.label)}"></span>
                <div class="ba-info">
                    <div class="ba-name">${escHtml(name)} ${typeBadge}</div>
                    <div class="ba-meta">${escHtml(nodeUrl)}${nodeUrl && activatedDate ? ' · ' : ''}${activatedDate ? 'Bound ' + escHtml(activatedDate) : ''} · ${escHtml(info.label)}</div>
                    <div class="ba-scopes">${formatScopes(scopes)}</div>
                </div>
                <div class="ba-actions">${actions}</div>
            `;
        }
        listEl.appendChild(el);
    });

    // Start polling if any pending bindings exist
    const hasPending = bindings.some(b => b.status === 'pending');
    if (hasPending && !bindingPollTimer) {
        bindingPollTimer = setInterval(() => loadBoundAgents(), 10000);
    } else if (!hasPending && bindingPollTimer) {
        clearInterval(bindingPollTimer);
        bindingPollTimer = null;
    }
}

// Bind Agent button — show scopes form
document.getElementById('btn-add-bound-agent').addEventListener('click', () => {
    const form = document.getElementById('bound-agent-form');
    form.style.display = 'block';
    document.getElementById('ba-label').value = '';
    document.getElementById('ba-status').textContent = '';
    // Reset scope checkboxes to defaults
    document.querySelectorAll('.ba-scope-cb').forEach(cb => {
        cb.checked = ['perception', 'action', 'session'].includes(cb.value);
    });
    document.getElementById('ba-label').focus();
});

document.getElementById('btn-cancel-bound-agent').addEventListener('click', () => {
    document.getElementById('bound-agent-form').style.display = 'none';
    document.getElementById('ba-token-result').style.display = 'none';
    document.getElementById('btn-save-bound-agent').style.display = '';
});

// Generate binding token
document.getElementById('btn-save-bound-agent').addEventListener('click', async () => {
    const label = document.getElementById('ba-label').value.trim();
    const statusEl = document.getElementById('ba-status');
    const scopes = [];
    document.querySelectorAll('.ba-scope-cb:checked').forEach(cb => scopes.push(cb.value));

    if (scopes.length === 0) {
        statusEl.textContent = 'Select at least one scope';
        statusEl.style.color = 'var(--danger)';
        return;
    }

    statusEl.textContent = 'Generating token...';
    statusEl.style.color = 'var(--text-muted)';
    document.getElementById('btn-save-bound-agent').disabled = true;

    try {
        const result = await createBindingToken({ scopes, label: label || undefined });

        // Show token result
        const tokenResultEl = document.getElementById('ba-token-result');
        document.getElementById('ba-token-value').textContent = result.token;
        document.getElementById('ba-install-cmd').textContent = result.install_command || '';
        tokenResultEl.style.display = 'block';

        // Hide the form inputs, keep the token result visible
        document.getElementById('btn-save-bound-agent').style.display = 'none';
        statusEl.textContent = '';

        // Reload the list
        await loadBoundAgents();
        showToast('Binding token generated — copy and send to the Agent owner');
    } catch (err) {
        statusEl.textContent = 'Failed: ' + (err.message || 'Unknown error');
        statusEl.style.color = 'var(--danger)';
    } finally {
        document.getElementById('btn-save-bound-agent').disabled = false;
    }
});

// Copy token button
document.getElementById('btn-copy-token')?.addEventListener('click', () => {
    const token = document.getElementById('ba-token-value').textContent;
    navigator.clipboard.writeText(token).then(() => showToast('Token copied to clipboard'));
});

// Copy install command button
document.getElementById('btn-copy-install')?.addEventListener('click', () => {
    const cmd = document.getElementById('ba-install-cmd').textContent;
    navigator.clipboard.writeText(cmd).then(() => showToast('Install command copied'));
});

// Binding list actions (delegated)
document.getElementById('bound-agents-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-ba-action]');
    if (!btn) return;
    const action = btn.dataset.baAction;
    const id = btn.dataset.baId;
    if (!id) return;

    btn.disabled = true;

    try {
        if (action === 'copy-token') {
            if (action === 'suspend') {
            await suspendBinding(id);
            showToast('Binding suspended');
        } else if (action === 'resume') {
            await resumeBinding(id);
            showToast('Binding resumed');
        } else if (action === 'unbind' || action === 'revoke') {
            const binding = bindings.find(b => b.id === id);
            const name = binding?.agent_name || binding?.label || id.slice(0, 8);
            if (!confirm(`Unbind "${name}"? This will revoke the binding and disconnect the Agent.`)) {
                btn.disabled = false;
                return;
            }
            await revokeBinding(id);
            showToast('Binding revoked');
        }

        await loadBoundAgents();
    } catch (err) {
        showToast('Action failed: ' + err.message, 'error');
        btn.disabled = false;
    }
});

// ------------------------------------------------------------------ Site Permissions (#103)

let sitePermissions = { mode: 'blacklist', sites: [] };

async function loadSitePermissions() {
    try {
        const { settings } = await getUserSettings();
        sitePermissions = settings?.sitePermissions || { mode: 'blacklist', sites: [] };
        if (!Array.isArray(sitePermissions.sites)) sitePermissions.sites = [];
    } catch {
        sitePermissions = { mode: 'blacklist', sites: [] };
    }
    renderSitePermissions();
}

function renderSitePermissions() {
    const mode = sitePermissions.mode || 'blacklist';

    // Update mode toggle
    document.querySelectorAll('.sp-mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    const modeLabel = document.getElementById('sp-mode-label');
    const modeDesc = document.getElementById('sp-mode-desc');
    const listTitle = document.getElementById('sp-list-title');
    const listDesc = document.getElementById('sp-list-desc');

    if (mode === 'blacklist') {
        modeLabel.textContent = 'Blacklist';
        modeDesc.textContent = 'monitor all sites except those listed below';
        listTitle.textContent = 'Blocked Sites';
        listDesc.textContent = 'Sites listed here will NOT be monitored. All other sites are monitored by default.';
    } else {
        modeLabel.textContent = 'Whitelist';
        modeDesc.textContent = 'only monitor sites listed below';
        listTitle.textContent = 'Allowed Sites';
        listDesc.textContent = 'Only sites listed here will be monitored. All other sites are ignored.';
    }

    // Render site list
    const listEl = document.getElementById('sp-site-list');
    const emptyEl = document.getElementById('sp-site-empty');
    listEl.querySelectorAll('.sp-site-item').forEach(el => el.remove());

    const sites = sitePermissions.sites;
    if (sites.length === 0) {
        emptyEl.style.display = '';
        return;
    }
    emptyEl.style.display = 'none';

    sites.forEach((site, index) => {
        const el = document.createElement('div');
        el.className = 'sp-site-item';
        el.innerHTML = `
            <div class="sp-site-pattern">${escHtml(site.pattern)}</div>
            <div class="sp-site-controls">
                <span class="sp-chip ${site.error ? 'on' : ''}" data-sp-index="${index}" data-sp-field="error" title="Error monitoring" style="cursor:pointer;">Errors</span>
                <span class="sp-chip ${site.network ? 'on' : ''}" data-sp-index="${index}" data-sp-field="network" title="Network monitoring" style="cursor:pointer;">Network</span>
                <span class="sp-chip ${site.console ? 'on' : ''}" data-sp-index="${index}" data-sp-field="console" title="Console monitoring" style="cursor:pointer;">Console</span>
                <button class="btn btn-ghost btn-small" data-sp-action="remove" data-sp-index="${index}" style="color:var(--danger);padding:2px 6px;">&times;</button>
            </div>
        `;
        listEl.appendChild(el);
    });
}

async function saveSitePermissions() {
    await updateUserSettings({ sitePermissions });
}

document.querySelectorAll('.sp-mode-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
        sitePermissions.mode = btn.dataset.mode;
        await saveSitePermissions();
        renderSitePermissions();
        showToast('Switched to ' + btn.dataset.mode + ' mode');
    });
});

document.getElementById('btn-add-sp-site').addEventListener('click', () => {
    const form = document.getElementById('sp-site-form');
    form.style.display = 'block';
    document.getElementById('sp-pattern').value = '';
    document.getElementById('sp-error-check').checked = true;
    document.getElementById('sp-network-check').checked = true;
    document.getElementById('sp-console-check').checked = true;
    document.getElementById('sp-pattern').focus();
});

document.getElementById('btn-cancel-sp-site').addEventListener('click', () => {
    document.getElementById('sp-site-form').style.display = 'none';
});

document.getElementById('btn-save-sp-site').addEventListener('click', async () => {
    const pattern = document.getElementById('sp-pattern').value.trim().toLowerCase();
    if (!pattern) {
        showToast('Please enter a domain pattern', 'error');
        return;
    }
    if (!/^[a-z0-9*._-]+(\.[a-z0-9*._-]+)*$/.test(pattern)) {
        showToast('Invalid domain pattern', 'error');
        return;
    }
    if (sitePermissions.sites.some(s => s.pattern === pattern)) {
        showToast('This pattern already exists', 'error');
        return;
    }

    sitePermissions.sites.push({
        pattern,
        error: document.getElementById('sp-error-check').checked,
        network: document.getElementById('sp-network-check').checked,
        console: document.getElementById('sp-console-check').checked,
    });

    await saveSitePermissions();
    renderSitePermissions();
    document.getElementById('sp-site-form').style.display = 'none';
    showToast(`Site "${pattern}" added`);
});

document.getElementById('sp-site-list').addEventListener('click', async (e) => {
    // Toggle chip
    const chip = e.target.closest('[data-sp-field]');
    if (chip) {
        const index = parseInt(chip.dataset.spIndex, 10);
        const field = chip.dataset.spField;
        if (index >= 0 && index < sitePermissions.sites.length) {
            sitePermissions.sites[index][field] = !sitePermissions.sites[index][field];
            await saveSitePermissions();
            renderSitePermissions();
        }
        return;
    }
    // Remove site
    const removeBtn = e.target.closest('[data-sp-action="remove"]');
    if (removeBtn) {
        const index = parseInt(removeBtn.dataset.spIndex, 10);
        const site = sitePermissions.sites[index];
        sitePermissions.sites.splice(index, 1);
        await saveSitePermissions();
        renderSitePermissions();
        showToast(`Site "${site.pattern}" removed`);
    }
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

// ------------------------------------------------------------------ file issues (#44)

let fileIssuesDrafts = [];

async function loadFileIssues() {
    // Populate auth dropdown with GitLab-type credentials
    try {
        const { auths } = await getAuths();
        const select = document.getElementById('file-auth-select');
        select.innerHTML = '<option value="">Select a GitLab credential...</option>';
        for (const auth of auths) {
            if (auth.auth_type === 'gitlab_pat' || auth.auth_type === 'custom_header' || auth.auth_type === 'custom_bearer') {
                const opt = document.createElement('option');
                opt.value = auth.id;
                opt.textContent = `${auth.label || auth.auth_type} (${auth.auth_type})`;
                select.appendChild(opt);
            }
        }
    } catch { /* ignore */ }
}

document.getElementById('btn-load-items')?.addEventListener('click', async () => {
    const list = document.getElementById('file-items-list');
    list.innerHTML = '<div class="empty-state">Loading...</div>';

    try {
        const { items } = await getItems({ type: 'issue' });
        // Also load comment-type items classified as bugs
        const { items: comments } = await getItems({ type: 'comment' });
        const allItems = [...items, ...comments.filter(c => c.classification === 'bug')];

        if (allItems.length === 0) {
            list.innerHTML = '<div class="empty-state">No items found. Create annotations first.</div>';
            return;
        }

        // Get preview with severity
        const ids = allItems.map(i => i.id);
        const { drafts } = await previewIssues(ids);
        fileIssuesDrafts = drafts;

        renderFileItems(drafts);
    } catch (err) {
        list.innerHTML = `<div class="empty-state">Error: ${escHtml(err.message)}</div>`;
    }
});

function renderFileItems(drafts) {
    const list = document.getElementById('file-items-list');
    if (drafts.length === 0) {
        list.innerHTML = '<div class="empty-state">No items to file.</div>';
        return;
    }

    const severityColors = { P0: '#dc2626', P1: '#ea580c', P2: '#ca8a04', P3: '#65a30d' };

    list.innerHTML = drafts.map(d => `
        <label class="file-item ${d.has_dispatches ? 'already-filed' : ''}" data-item-id="${escHtml(d.item_id)}">
            <input type="checkbox" class="file-item-check" value="${escHtml(d.item_id)}" ${d.has_dispatches ? '' : 'checked'}>
            <span class="severity-badge" style="background:${severityColors[d.severity] || '#666'}">${escHtml(d.severity)}</span>
            <span class="file-item-classification">${escHtml(d.classification)}</span>
            <span class="file-item-title">${escHtml(d.title)}</span>
            ${d.source_url ? `<span class="file-item-url" title="${escHtml(d.source_url)}">${escHtml(new URL(d.source_url).pathname)}</span>` : ''}
            ${d.has_dispatches ? '<span class="file-item-badge">already filed</span>' : ''}
        </label>
    `).join('');

    updateSelectedCount();

    list.querySelectorAll('.file-item-check').forEach(cb => {
        cb.addEventListener('change', updateSelectedCount);
    });
}

function updateSelectedCount() {
    const checks = document.querySelectorAll('.file-item-check:checked');
    const count = checks.length;
    document.getElementById('file-selected-count').textContent = `${count} item${count !== 1 ? 's' : ''} selected`;
    document.getElementById('btn-file-issues').disabled = count === 0;
}

document.getElementById('btn-select-all')?.addEventListener('click', () => {
    document.querySelectorAll('.file-item-check').forEach(cb => { cb.checked = true; });
    updateSelectedCount();
});

document.getElementById('btn-deselect-all')?.addEventListener('click', () => {
    document.querySelectorAll('.file-item-check').forEach(cb => { cb.checked = false; });
    updateSelectedCount();
});

document.getElementById('btn-file-issues')?.addEventListener('click', async () => {
    const authId = document.getElementById('file-auth-select').value;
    const projectId = document.getElementById('file-project-id').value.trim();
    const baseUrl = document.getElementById('file-base-url').value.trim();
    const extraLabels = document.getElementById('file-labels').value.trim();
    const autoSeverity = document.getElementById('file-auto-severity').checked;

    if (!projectId) {
        showToast('Please enter a GitLab project ID', 'error');
        return;
    }

    const selectedIds = [...document.querySelectorAll('.file-item-check:checked')].map(cb => cb.value);
    if (selectedIds.length === 0) {
        showToast('No items selected', 'error');
        return;
    }

    const target = {
        adapter: 'gitlab-issue',
        project_id: projectId,
        auto_severity: autoSeverity,
    };
    if (authId) target.auth_id = Number(authId);
    if (baseUrl) target.base_url = baseUrl;
    if (extraLabels) target.labels = extraLabels.split(',').map(l => l.trim()).filter(Boolean);

    const btn = document.getElementById('btn-file-issues');
    btn.disabled = true;
    btn.textContent = 'Filing...';

    try {
        const result = await batchFileIssues(selectedIds, target);
        const resultsDiv = document.getElementById('file-results');
        resultsDiv.style.display = 'block';

        const lines = result.results.map(r => {
            if (r.status === 'filed') {
                return `<div class="file-result-success">${escHtml(r.severity)} - Item ${escHtml(r.item_id)} filed${r.url ? ` - <a href="${escHtml(r.url)}" target="_blank">View</a>` : ''}</div>`;
            }
            return `<div class="file-result-error">Item ${escHtml(r.item_id)}: ${escHtml(r.error)}</div>`;
        });

        resultsDiv.innerHTML = `
            <h4>Results: ${result.summary.filed} filed, ${result.summary.failed} failed</h4>
            ${lines.join('')}
        `;

        showToast(`${result.summary.filed} issues filed successfully`, result.summary.failed > 0 ? 'warning' : 'success');
    } catch (err) {
        showToast('Batch file failed: ' + err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'File Selected as GitLab Issues';
    }
});

// ------------------------------------------------------------------ about

async function loadAbout() {
    const setText = (id, value) => {
        document.getElementById(id).textContent = value || '\u2014';
    };
    const formatTime = (value) => {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return value;
        return date.toLocaleString();
    };

    setText('about-client-version', CLIENT_BUILD_INFO.version);
    setText('about-client-commit', CLIENT_BUILD_INFO.commit);
    setText('about-client-build-time', formatTime(CLIENT_BUILD_INFO.buildTime));

    try {
        const health = await checkHealth();
        setText('about-server-version', health.version);
        setText('about-server-commit', health.commit);
        setText('about-server-build-time', formatTime(health.buildTime));
    } catch {
        setText('about-server-version', '');
        setText('about-server-commit', '');
        setText('about-server-build-time', '');
    }

    const extensionInfo = await getExtensionInfo();
    setText('about-extension-version', extensionInfo?.version);
    setText('about-extension-commit', extensionInfo?.commit);
    setText('about-extension-build-time', formatTime(extensionInfo?.buildTime));

    const release = await checkLatestVersion();
    const latestEl = document.getElementById('about-latest-version');
    const latestTimeEl = document.getElementById('about-latest-published-at');
    if (release && release.latestVersion) {
        latestEl.textContent = release.latestVersion;
        latestEl.style.color = '#22c55e';
        latestTimeEl.textContent = formatTime(release.publishedAt) || '\u2014';

        const card = document.getElementById('update-guide-card');
        const text = document.getElementById('update-guide-text');
        const link = document.getElementById('update-guide-link');
        text.textContent = `The latest extension version is ${release.latestVersion}. `
            + 'To update your Chrome extension: download the zip, go to chrome://extensions, '
            + 'enable Developer Mode, click "Load unpacked" and select the extracted folder.';
        link.href = release.downloadUrl || release.releaseUrl || 'https://github.com/coco-xyz/clawmark/releases/latest';
        card.style.display = 'block';
    } else {
        latestEl.textContent = '\u2014';
        latestTimeEl.textContent = '\u2014';
    }
}

// ------------------------------------------------------------------ Monitoring (#87)

const SEVERITY_COLORS = {
    error: '#ef4444',
    warning: '#f59e0b',
    info: '#3b82f6',
    critical: '#dc2626',
};

let monitoringLoaded = false;

async function loadMonitoring() {
    if (monitoringLoaded) return;
    monitoringLoaded = true;

    document.getElementById('err-range-select').addEventListener('change', () => fetchErrorTrends());
    document.getElementById('err-group-select').addEventListener('change', () => fetchErrorTrends());
    document.getElementById('action-type-filter').addEventListener('change', () => fetchAgentActions());
    document.getElementById('action-range-select').addEventListener('change', () => fetchAgentActions());
    document.getElementById('quality-range-select').addEventListener('change', () => fetchQualityReport());
    document.getElementById('btn-export-csv').addEventListener('click', exportMonitoringCSV);
    document.getElementById('btn-export-pdf').addEventListener('click', exportMonitoringPDF);

    fetchErrorTrends();
    fetchAgentActions();
    fetchQualityReport();
}

async function fetchErrorTrends() {
    const days = parseInt(document.getElementById('err-range-select').value, 10) || 7;
    const group_by = document.getElementById('err-group-select').value || 'severity';

    document.getElementById('err-chart-container').innerHTML =
        '<div class="empty-state"><span class="loading-spinner"></span>Loading error trends...</div>';

    try {
        const data = await getErrorTrends({ days, group_by });
        renderErrorSummary(data.summary);
        renderErrorChart(data.trends, data.summary, group_by);
        renderTopErrors(data.summary.topFingerprints || []);
        renderSeverityBars(data.summary.bySeverity || []);
    } catch {
        document.getElementById('err-chart-container').innerHTML =
            '<div class="empty-state"><div class="empty-state-icon">&#x26a0;&#xfe0f;</div>Failed to load error trends</div>';
    }
}

function renderErrorSummary(summary) {
    document.getElementById('err-total').textContent = summary.total || 0;
    document.getElementById('err-last24h').textContent = summary.last24h || 0;
    document.getElementById('err-types').textContent = (summary.byType || []).length;

    const topSev = (summary.bySeverity || [])[0];
    document.getElementById('err-top-severity').textContent = topSev ? topSev.severity : 'none';

    // Spike detection
    const isSpike = summary.spikeRatio > 2 && summary.last24h > 5;

    const spikeAlert = document.getElementById('err-spike-alert');
    if (isSpike) {
        document.getElementById('err-spike-text').textContent =
            `Error spike detected: ${summary.last24h} errors in last 24h (${summary.spikeRatio.toFixed(1)}x above average)`;
        spikeAlert.style.display = 'flex';
    } else {
        spikeAlert.style.display = 'none';
    }

    document.getElementById('err-spike-card').style.borderColor = isSpike ? 'var(--danger)' : '';
}

function renderErrorChart(trends, summary, groupBy) {
    const container = document.getElementById('err-chart-container');

    if (!trends || trends.length === 0) {
        container.innerHTML = '<div class="empty-state">No error data for this period</div>';
        return;
    }

    // Collect unique periods and groups
    const periods = [...new Set(trends.map(t => t.period))].sort();
    const groups = groupBy === 'total'
        ? ['total']
        : [...new Set(trends.map(t => t.group_value || 'unknown'))];

    // Build data matrix: groups x periods -> count
    const matrix = {};
    for (const g of groups) matrix[g] = {};
    for (const t of trends) {
        const g = groupBy === 'total' ? 'total' : (t.group_value || 'unknown');
        matrix[g][t.period] = (matrix[g][t.period] || 0) + t.count;
    }

    // Find max value for scaling
    let maxVal = 0;
    for (const g of groups) {
        for (const p of periods) {
            maxVal = Math.max(maxVal, matrix[g][p] || 0);
        }
    }
    if (maxVal === 0) maxVal = 1;

    // SVG chart dimensions
    const W = 720;
    const H = 240;
    const padL = 48;
    const padR = 16;
    const padT = 16;
    const padB = 40;
    const chartW = W - padL - padR;
    const chartH = H - padT - padB;

    const barGroupW = chartW / periods.length;
    const barW = Math.max(4, Math.min(24, (barGroupW - 4) / groups.length));

    // Y-axis ticks
    const yTicks = 4;
    const yStep = Math.ceil(maxVal / yTicks);

    let svg = `<svg viewBox="0 0 ${W} ${H}" class="err-chart-svg">`;

    // Grid lines + Y labels
    for (let i = 0; i <= yTicks; i++) {
        const val = i * yStep;
        const y = padT + chartH - (val / (yStep * yTicks)) * chartH;
        svg += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="var(--border)" stroke-dasharray="4,4"/>`;
        svg += `<text x="${padL - 8}" y="${y + 4}" text-anchor="end" fill="var(--text-muted)" font-size="11">${val}</text>`;
    }

    // Bars
    for (let pi = 0; pi < periods.length; pi++) {
        const period = periods[pi];
        const groupX = padL + pi * barGroupW + barGroupW / 2;

        for (let gi = 0; gi < groups.length; gi++) {
            const g = groups[gi];
            const val = matrix[g][period] || 0;
            const barH = (val / (yStep * yTicks)) * chartH;
            const x = groupX - (groups.length * barW) / 2 + gi * barW;
            const y = padT + chartH - barH;
            const color = SEVERITY_COLORS[g] || getGroupColor(gi);

            svg += `<rect x="${x}" y="${y}" width="${barW - 1}" height="${barH}" fill="${color}" rx="2">`;
            svg += `<title>${escHtml(g)}: ${val} on ${escHtml(period)}</title>`;
            svg += `</rect>`;
        }

        // X-axis label
        const label = period.length > 5 ? period.slice(5) : period; // Show MM-DD
        svg += `<text x="${groupX}" y="${H - 8}" text-anchor="middle" fill="var(--text-muted)" font-size="10">${escHtml(label)}</text>`;
    }

    svg += '</svg>';

    // Legend
    let legend = '<div class="chart-legend">';
    for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        const color = SEVERITY_COLORS[g] || getGroupColor(gi);
        legend += `<span class="legend-item"><span class="legend-dot" style="background:${color}"></span>${escHtml(g)}</span>`;
    }
    legend += '</div>';

    container.innerHTML = svg + legend;
}

function getGroupColor(index) {
    const palette = ['#5865f2', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
    return palette[index % palette.length];
}

function renderTopErrors(topFingerprints) {
    const tbody = document.getElementById('err-top-tbody');
    const empty = document.getElementById('err-top-empty');

    if (!topFingerprints || topFingerprints.length === 0) {
        tbody.innerHTML = '';
        empty.style.display = 'block';
        return;
    }

    empty.style.display = 'none';
    tbody.innerHTML = topFingerprints.map(fp => `
        <tr>
            <td class="err-msg-cell" title="${escHtml(fp.fingerprint)}">${escHtml((fp.message || '').slice(0, 80))}</td>
            <td>${escHtml(fp.type || 'unknown')}</td>
            <td><span class="severity-badge severity-${escHtml(fp.severity)}">${escHtml(fp.severity)}</span></td>
            <td>${Number(fp.count)}</td>
            <td>${fp.last_seen ? new Date(fp.last_seen).toLocaleString() : '\u2014'}</td>
        </tr>
    `).join('');
}

function renderSeverityBars(bySeverity) {
    const container = document.getElementById('err-severity-bars');
    if (!bySeverity || bySeverity.length === 0) {
        container.innerHTML = '<div class="empty-state">No data</div>';
        return;
    }

    const maxCount = Math.max(...bySeverity.map(s => s.count));
    container.innerHTML = bySeverity.map(s => {
        const pct = maxCount > 0 ? (s.count / maxCount) * 100 : 0;
        const color = SEVERITY_COLORS[s.severity] || '#888';
        return `
            <div class="severity-bar-row">
                <span class="severity-bar-label">${escHtml(s.severity)}</span>
                <div class="severity-bar-track">
                    <div class="severity-bar-fill" style="width:${pct}%;background:${color}"></div>
                </div>
                <span class="severity-bar-count">${s.count}</span>
            </div>`;
    }).join('');
}

// ------------------------------------------------------------------ Agent Actions (#87 Phase 2)

const ACTION_ICONS = {
    perception_capture: '\ud83d\udc41\ufe0f',
    issue_created: '\ud83d\udce2',
    issue_updated: '\ud83d\udd04',
    session_start: '\u25b6\ufe0f',
    session_end: '\u23f9\ufe0f',
};

const ACTION_LABELS = {
    perception_capture: 'Perception Capture',
    issue_created: 'Issue Created',
    issue_updated: 'Issue Updated',
    session_start: 'Session Start',
    session_end: 'Session End',
};

async function fetchAgentActions() {
    const days = parseInt(document.getElementById('action-range-select').value, 10) || 30;
    const action_type = document.getElementById('action-type-filter').value || '';

    document.getElementById('action-list').innerHTML =
        '<div class="empty-state"><span class="loading-spinner"></span>Loading actions...</div>';

    try {
        const params = { days };
        if (action_type) params.action_type = action_type;
        const data = await getAgentActions(params);
        renderActionSummary(action_type ? [] : (data.summary || []));
        renderActionList(data.actions || []);
    } catch {
        document.getElementById('action-list').innerHTML =
            '<div class="empty-state"><div class="empty-state-icon">&#x26a0;&#xfe0f;</div>Failed to load agent actions</div>';
    }
}

function renderActionSummary(summary) {
    const container = document.getElementById('action-summary');
    if (!summary || summary.length === 0) {
        container.innerHTML = '';
        return;
    }
    container.innerHTML = summary.map(s => {
        const icon = ACTION_ICONS[s.action_type] || '\u2022';
        const label = ACTION_LABELS[s.action_type] || s.action_type;
        return `<span class="action-summary-badge">${icon} ${escHtml(label)}: <strong>${Number(s.count)}</strong></span>`;
    }).join('');
}

function renderActionList(actions) {
    const container = document.getElementById('action-list');
    if (!actions || actions.length === 0) {
        container.innerHTML = '<div class="empty-state">No agent actions recorded yet</div>';
        return;
    }

    container.innerHTML = actions.map(a => {
        const icon = ACTION_ICONS[a.action_type] || '\u2022';
        const label = ACTION_LABELS[a.action_type] || a.action_type;
        const time = a.created_at ? new Date(a.created_at).toLocaleString() : '';
        const statusClass = a.status === 'success' ? 'action-status-ok' : 'action-status-fail';
        return `
            <div class="action-item">
                <span class="action-icon">${icon}</span>
                <div class="action-body">
                    <div class="action-title">${escHtml(a.summary)}</div>
                    <div class="action-meta">
                        <span class="action-type-badge">${escHtml(label)}</span>
                        ${a.agent_id ? `<span class="action-agent">Agent: ${escHtml(a.agent_id.slice(0, 12))}</span>` : ''}
                        <span class="${statusClass}">${escHtml(a.status)}</span>
                        <span class="action-time">${escHtml(time)}</span>
                    </div>
                </div>
            </div>`;
    }).join('');
}

// ------------------------------------------------------------------ Quality Report (#87 Phase 3)

async function fetchQualityReport() {
    const days = parseInt(document.getElementById('quality-range-select').value, 10) || 30;

    try {
        const data = await getQualityReport({ days });
        renderQualityReport(data.report, days);
    } catch {
        document.getElementById('quality-details').innerHTML =
            '<div class="empty-state">Failed to load quality report</div>';
    }
}

function formatHours(hours) {
    if (!hours || hours === 0) return '\u2014';
    if (hours < 1) return `${Math.round(hours * 60)}m`;
    if (hours < 24) return `${hours.toFixed(1)}h`;
    return `${(hours / 24).toFixed(1)}d`;
}

function renderTrendArrow(pct) {
    if (!pct || Math.abs(pct) < 1) return '<span class="trend-neutral">\u2014</span>';
    const arrow = pct > 0 ? '\u2191' : '\u2193';
    // For errors, down is good; for coverage, up is good
    const cls = pct > 0 ? 'trend-up' : 'trend-down';
    return `<span class="${cls}">${arrow} ${Math.abs(Math.round(pct))}%</span>`;
}

function renderQualityReport(report, days) {
    // MTTR
    const mttrEl = document.getElementById('q-mttr');
    mttrEl.textContent = formatHours(report.mttr.avgHours);

    // Auto-fix rate
    const autofixEl = document.getElementById('q-autofix');
    autofixEl.textContent = report.autoFixRate + '%';

    // Recurrence rate
    const recurrenceEl = document.getElementById('q-recurrence');
    recurrenceEl.textContent = report.recurrenceRate + '%';

    // Coverage
    const coverageEl = document.getElementById('q-coverage');
    coverageEl.textContent = report.coverage + ' sites';

    // Comparison
    const compEl = document.getElementById('quality-comparison');
    const c = report.comparison;
    const halfLabel = days <= 7 ? 'vs prior half' : `vs prior ${Math.floor(days / 2)}d`;
    compEl.innerHTML = `
        <div class="comparison-row">
            <span class="comparison-label">Errors ${halfLabel}</span>
            <span class="comparison-values">${Number(c.currentErrors)} current / ${Number(c.priorErrors)} prior</span>
            ${renderTrendArrow(c.errorTrend)}
        </div>
        <div class="comparison-row">
            <span class="comparison-label">Issues ${halfLabel}</span>
            <span class="comparison-values">${Number(c.currentIssues)} current / ${Number(c.priorIssues)} prior</span>
            ${renderTrendArrow(c.issueTrend)}
        </div>`;

    // Details
    const detailsEl = document.getElementById('quality-details');
    detailsEl.innerHTML = `
        <div class="quality-detail-grid">
            <div class="quality-detail">
                <span class="detail-label">Resolved issues</span>
                <span class="detail-value">${Number(report.resolvedCount)} / ${Number(report.totalIssues)}</span>
            </div>
            <div class="quality-detail">
                <span class="detail-label">Issues filed to tracker</span>
                <span class="detail-value">${Number(report.filedCount)} / ${Number(report.totalIssues)}</span>
            </div>
            <div class="quality-detail">
                <span class="detail-label">Recurring fingerprints</span>
                <span class="detail-value">${Number(report.recurringFingerprints)} / ${Number(report.totalFingerprints)}</span>
            </div>
            <div class="quality-detail">
                <span class="detail-label">MTTR resolved count</span>
                <span class="detail-value">${Number(report.mttr.resolvedCount)}</span>
            </div>
        </div>`;
}

// ------------------------------------------------------------------ Export (#87 Phase 4)

function exportMonitoringCSV() {
    const rows = [['Section', 'Metric', 'Value']];

    // Error summary from stat cards
    rows.push(['Error Summary', 'Total Errors', document.getElementById('err-total').textContent]);
    rows.push(['Error Summary', 'Last 24h', document.getElementById('err-last24h').textContent]);
    rows.push(['Error Summary', 'Error Types', document.getElementById('err-types').textContent]);
    rows.push(['Error Summary', 'Top Severity', document.getElementById('err-top-severity').textContent]);

    // Top errors from table
    const topRows = document.querySelectorAll('#err-top-tbody tr');
    topRows.forEach(tr => {
        const cells = tr.querySelectorAll('td');
        if (cells.length >= 4) {
            rows.push(['Top Errors', cells[0].textContent.trim(), `${cells[1].textContent} | ${cells[2].textContent} | count:${cells[3].textContent}`]);
        }
    });

    // Quality metrics
    rows.push(['Quality', 'MTTR', document.getElementById('q-mttr').textContent]);
    rows.push(['Quality', 'Issue Filing Rate', document.getElementById('q-autofix').textContent]);
    rows.push(['Quality', 'Recurrence Rate', document.getElementById('q-recurrence').textContent]);
    rows.push(['Quality', 'Coverage', document.getElementById('q-coverage').textContent]);

    // Build CSV with formula injection protection
    const csvSafe = (s) => {
        s = String(s).replace(/"/g, '""');
        if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
        return `"${s}"`;
    };
    const csv = rows.map(r => r.map(csvSafe).join(',')).join('\n');
    downloadFile('clawmark-monitoring-report.csv', csv, 'text/csv');
}

function exportMonitoringPDF() {
    // Generate a printable HTML report and open in new window for print-to-PDF
    const title = 'ClawMark Monitoring Report';
    const date = new Date().toLocaleString();

    const errTotal = document.getElementById('err-total').textContent;
    const errLast24h = document.getElementById('err-last24h').textContent;
    const errTypes = document.getElementById('err-types').textContent;
    const topSev = document.getElementById('err-top-severity').textContent;

    const mttr = document.getElementById('q-mttr').textContent;
    const autofix = document.getElementById('q-autofix').textContent;
    const recurrence = document.getElementById('q-recurrence').textContent;
    const coverage = document.getElementById('q-coverage').textContent;

    // Grab top errors table HTML
    const topTable = document.getElementById('err-top-table');
    const topTableHtml = topTable ? topTable.outerHTML : '';

    // Grab quality details
    const qualityDetails = document.getElementById('quality-details');
    const qualityHtml = qualityDetails ? qualityDetails.innerHTML : '';

    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${escHtml(title)}</title>
<style>
body{font-family:-apple-system,sans-serif;padding:40px;color:#333;max-width:800px;margin:0 auto;}
h1{font-size:24px;margin-bottom:4px;}
.date{color:#666;font-size:13px;margin-bottom:24px;}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin:16px 0;}
.card{text-align:center;padding:16px;border:1px solid #ddd;border-radius:8px;}
.card .val{font-size:28px;font-weight:700;color:#111;}
.card .lbl{font-size:13px;color:#666;margin-top:4px;}
table{width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;}
th,td{padding:8px 12px;border:1px solid #ddd;text-align:left;}
th{background:#f5f5f5;font-weight:600;}
h2{margin-top:32px;font-size:18px;}
@media print{body{padding:20px;}}
</style></head><body>
<h1>${escHtml(title)}</h1>
<div class="date">Generated: ${escHtml(date)}</div>
<h2>Error Summary</h2>
<div class="grid">
<div class="card"><div class="val">${escHtml(errTotal)}</div><div class="lbl">Total Errors</div></div>
<div class="card"><div class="val">${escHtml(errLast24h)}</div><div class="lbl">Last 24h</div></div>
<div class="card"><div class="val">${escHtml(errTypes)}</div><div class="lbl">Error Types</div></div>
<div class="card"><div class="val">${escHtml(topSev)}</div><div class="lbl">Top Severity</div></div>
</div>
<h2>Top Errors</h2>
${topTableHtml}
<h2>Quality Metrics</h2>
<div class="grid">
<div class="card"><div class="val">${escHtml(mttr)}</div><div class="lbl">MTTR</div></div>
<div class="card"><div class="val">${escHtml(autofix)}</div><div class="lbl">Issue Filing Rate</div></div>
<div class="card"><div class="val">${escHtml(recurrence)}</div><div class="lbl">Recurrence Rate</div></div>
<div class="card"><div class="val">${escHtml(coverage)}</div><div class="lbl">Coverage</div></div>
</div>
<h2>Details</h2>
${qualityHtml}
<script>window.print();</script>
</body></html>`;

    // Open in null origin via Blob URL to prevent XSS from DOM-scraped content
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function downloadFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ------------------------------------------------------------------ start

// Handle session expiry from any API call (auth:expired dispatched by apiFetch on 401)
document.addEventListener('auth:expired', () => {
    clearAuth();
    showLogin();
});

init();
