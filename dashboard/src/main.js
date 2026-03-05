/**
 * ClawMark Dashboard — Main Application
 *
 * Standalone web SPA replacing the Chrome extension options page.
 * All chrome.runtime.sendMessage calls are replaced with direct HTTP API calls.
 */

'use strict';

import {
    isLoggedIn, getUser, setAuth, clearAuth, getServerUrl,
    loginWithCode, getMe, checkHealth,
    getAnalyticsSummary, getItems,
    getRoutingRules, createRoutingRule, updateRoutingRule, deleteRoutingRule,
    checkLatestVersion,
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
    loadRules();
    loadAbout();
}

// ------------------------------------------------------------------ login

document.getElementById('btn-login').addEventListener('click', () => {
    startGoogleLogin();
});

document.getElementById('btn-welcome-login').addEventListener('click', () => {
    startGoogleLogin();
});

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
            const el = document.createElement('div');
            el.className = 'activity-item' + (item.source_url ? ' activity-item-link' : '');
            el.innerHTML = `
                <span class="activity-type">${icon}</span>
                <div class="activity-body">
                    <div class="activity-title">${escHtml(item.title || item.content || '(untitled)')}</div>
                    <div class="activity-meta">${escHtml(item.source_title || item.source_url || '')}${time ? ' \u00b7 ' + escHtml(time) : ''}</div>
                </div>`;
            if (item.source_url) {
                el.addEventListener('click', () => window.open(item.source_url, '_blank'));
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
        tr.innerHTML = `
            <td><span class="type-badge">${escHtml(rule.rule_type)}</span></td>
            <td title="${escHtml(patternText)}">${escHtml(patternText)}</td>
            <td title="${escHtml(formatTarget(rule.target_type, rule.target_config))}">${escHtml(formatTarget(rule.target_type, rule.target_config))}</td>
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

function openRuleModal(rule) {
    editingRuleId = rule ? rule.id : null;
    document.getElementById('rule-modal-title').textContent = rule ? 'Edit Rule' : 'Add Rule';
    document.getElementById('rule-modal-save').textContent = rule ? 'Update Rule' : 'Save Rule';

    rfType.value = rule ? rule.rule_type : 'url_pattern';
    rfPattern.value = rule ? (rule.pattern || '') : '';
    rfTarget.value = rule ? rule.target_type : 'github-issue';
    rfPriority.value = rule ? (rule.priority || 0) : 0;

    const isDefault = rfType.value === 'default';
    rfPatternLabel.style.display = isDefault ? 'none' : 'block';
    rfPattern.style.display = isDefault ? 'none' : 'block';

    updateTargetFields(rfTarget.value, rule ? parseConfig(rule.target_config) : null);
    ruleModal.style.display = 'flex';
}

function closeRuleModal() {
    ruleModal.style.display = 'none';
    editingRuleId = null;
}

document.getElementById('btn-add-rule').addEventListener('click', () => openRuleModal(null));
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
    updateTargetFields(rfTarget.value);
});

// Mask a credential string: show only last 4 chars
function maskSecret(val) {
    if (!val) return '';
    return val.length > 4 ? '••••' + val.slice(-4) : '••••';
}

// Sentinel for "unchanged" password fields
const SECRET_UNCHANGED = '••••____UNCHANGED____';

function updateTargetFields(targetType, existingConfig) {
    const cfg = existingConfig || {};
    const isEdit = !!existingConfig;
    // For password fields when editing: show masked placeholder, don't expose real value
    const secretVal = (v) => isEdit && v ? SECRET_UNCHANGED : escHtml(v || '');
    const secretPlaceholder = (v) => isEdit && v ? maskSecret(v) : '';
    let html = '';
    switch (targetType) {
        case 'github-issue':
            html = `
                <label>Repository (owner/repo)</label>
                <input type="text" class="input" id="tc-repo" placeholder="owner/repo" value="${escHtml(cfg.repo || '')}">
                <label>Labels (comma-separated)</label>
                <input type="text" class="input" id="tc-labels" placeholder="clawmark, bug" value="${escHtml((cfg.labels || []).join(', '))}">`;
            break;
        case 'lark':
            html = `<label>Webhook URL</label><input type="password" class="input" id="tc-webhook" data-secret="1" placeholder="${secretPlaceholder(cfg.webhook_url) || 'https://open.larksuite.com/...'}" value="${secretVal(cfg.webhook_url)}">`;
            break;
        case 'telegram':
            html = `
                <label>Bot Token</label><input type="password" class="input" id="tc-bot-token" data-secret="1" placeholder="${secretPlaceholder(cfg.bot_token)}" value="${secretVal(cfg.bot_token)}">
                <label>Chat ID</label><input type="text" class="input" id="tc-chat-id" value="${escHtml(cfg.chat_id || '')}">`;
            break;
        case 'webhook':
            html = `
                <label>Webhook URL</label><input type="text" class="input" id="tc-url" value="${escHtml(cfg.url || '')}">
                <label>Secret (optional)</label><input type="password" class="input" id="tc-secret" data-secret="1" placeholder="${secretPlaceholder(cfg.secret)}" value="${secretVal(cfg.secret)}">`;
            break;
        case 'slack':
            html = `
                <label>Webhook URL</label><input type="password" class="input" id="tc-slack-webhook" data-secret="1" placeholder="${secretPlaceholder(cfg.webhook_url)}" value="${secretVal(cfg.webhook_url)}">
                <label>Channel (optional)</label><input type="text" class="input" id="tc-slack-channel" value="${escHtml(cfg.channel || '')}">`;
            break;
        case 'email':
            html = `
                <label>Provider</label>
                <select class="input" id="tc-email-provider">
                    <option value="resend"${(cfg.provider || 'resend') === 'resend' ? ' selected' : ''}>Resend</option>
                    <option value="sendgrid"${cfg.provider === 'sendgrid' ? ' selected' : ''}>SendGrid</option>
                </select>
                <label>API Key</label><input type="password" class="input" id="tc-email-apikey" data-secret="1" placeholder="${secretPlaceholder(cfg.api_key)}" value="${secretVal(cfg.api_key)}">
                <label>From</label><input type="text" class="input" id="tc-email-from" value="${escHtml(cfg.from || '')}">
                <label>To (comma-separated)</label><input type="text" class="input" id="tc-email-to" value="${escHtml((cfg.to || []).join(', '))}">`;
            break;
        case 'linear':
            html = `
                <label>API Key</label><input type="password" class="input" id="tc-linear-apikey" data-secret="1" placeholder="${secretPlaceholder(cfg.api_key)}" value="${secretVal(cfg.api_key)}">
                <label>Team ID</label><input type="text" class="input" id="tc-linear-team" value="${escHtml(cfg.team_id || '')}">
                <label>Assignee ID (optional)</label><input type="text" class="input" id="tc-linear-assignee" value="${escHtml(cfg.assignee_id || '')}">`;
            break;
        case 'jira':
            html = `
                <label>Domain</label><input type="text" class="input" id="tc-jira-domain" value="${escHtml(cfg.domain || '')}">
                <label>Email</label><input type="text" class="input" id="tc-jira-email" value="${escHtml(cfg.email || '')}">
                <label>API Token</label><input type="password" class="input" id="tc-jira-token" data-secret="1" placeholder="${secretPlaceholder(cfg.api_token)}" value="${secretVal(cfg.api_token)}">
                <label>Project Key</label><input type="text" class="input" id="tc-jira-project" value="${escHtml(cfg.project_key || '')}">
                <label>Issue Type (optional)</label><input type="text" class="input" id="tc-jira-issuetype" value="${escHtml(cfg.issue_type || '')}">`;
            break;
        case 'hxa-connect':
            html = `
                <label>Hub URL</label><input type="text" class="input" id="tc-hxa-hub" value="${escHtml(cfg.hub_url || '')}">
                <label>Agent ID</label><input type="text" class="input" id="tc-hxa-agent" value="${escHtml(cfg.agent_id || '')}">
                <label>API Key (optional)</label><input type="password" class="input" id="tc-hxa-apikey" data-secret="1" placeholder="${secretPlaceholder(cfg.api_key)}" value="${secretVal(cfg.api_key)}">
                <label>Thread ID (optional)</label><input type="text" class="input" id="tc-hxa-thread" value="${escHtml(cfg.thread_id || '')}">`;
            break;
    }
    targetFieldsEl.innerHTML = html;
    // Clear sentinel on focus so user starts fresh
    targetFieldsEl.querySelectorAll('[data-secret]').forEach(el => {
        el.addEventListener('focus', () => {
            if (el.value === SECRET_UNCHANGED) el.value = '';
        }, { once: true });
    });
}

// Get field value; return undefined if it's the unchanged sentinel (so server keeps existing)
function fieldVal(id) {
    const v = (document.getElementById(id)?.value || '').trim();
    return v === SECRET_UNCHANGED ? undefined : v;
}

function getTargetConfig() {
    const type = rfTarget.value;
    const omitUndefined = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
    switch (type) {
        case 'github-issue': {
            const repo = fieldVal('tc-repo') || '';
            const labelsRaw = fieldVal('tc-labels') || '';
            const labels = labelsRaw ? labelsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
            return { repo, labels, assignees: [] };
        }
        case 'lark':
            return omitUndefined({ webhook_url: fieldVal('tc-webhook') });
        case 'telegram':
            return omitUndefined({ bot_token: fieldVal('tc-bot-token'), chat_id: fieldVal('tc-chat-id') || '' });
        case 'webhook': {
            const url = fieldVal('tc-url') || '';
            const secret = fieldVal('tc-secret');
            const cfg = { url };
            if (secret !== undefined && secret) cfg.secret = secret;
            return cfg;
        }
        case 'slack': {
            const wh = fieldVal('tc-slack-webhook');
            const ch = fieldVal('tc-slack-channel') || '';
            const cfg = omitUndefined({ webhook_url: wh });
            if (ch) cfg.channel = ch;
            return cfg;
        }
        case 'email': {
            const provider = document.getElementById('tc-email-provider')?.value || 'resend';
            const apiKey = fieldVal('tc-email-apikey');
            const from = fieldVal('tc-email-from') || '';
            const toRaw = fieldVal('tc-email-to') || '';
            const to = toRaw ? toRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
            const cfg = { provider, from, to };
            if (apiKey !== undefined) cfg.api_key = apiKey;
            return cfg;
        }
        case 'linear': {
            const apiKey = fieldVal('tc-linear-apikey');
            const teamId = fieldVal('tc-linear-team') || '';
            const assigneeId = fieldVal('tc-linear-assignee') || '';
            const cfg = omitUndefined({ api_key: apiKey });
            cfg.team_id = teamId;
            if (assigneeId) cfg.assignee_id = assigneeId;
            return cfg;
        }
        case 'jira': {
            const domain = fieldVal('tc-jira-domain') || '';
            const email = fieldVal('tc-jira-email') || '';
            const apiToken = fieldVal('tc-jira-token');
            const projectKey = fieldVal('tc-jira-project') || '';
            const issueType = fieldVal('tc-jira-issuetype') || '';
            const cfg = omitUndefined({ domain, email, api_token: apiToken, project_key: projectKey });
            if (issueType) cfg.issue_type = issueType;
            return cfg;
        }
        case 'hxa-connect': {
            const hubUrl = fieldVal('tc-hxa-hub') || '';
            const agentId = fieldVal('tc-hxa-agent') || '';
            const apiKey = fieldVal('tc-hxa-apikey');
            const threadId = fieldVal('tc-hxa-thread') || '';
            const cfg = { hub_url: hubUrl, agent_id: agentId };
            if (apiKey !== undefined && apiKey) cfg.api_key = apiKey;
            if (threadId) cfg.thread_id = threadId;
            return cfg;
        }
        default:
            return {};
    }
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
