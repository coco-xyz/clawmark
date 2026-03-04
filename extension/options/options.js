/**
 * ClawMark Dashboard (Options Page)
 *
 * Full configuration center — account, connection, delivery rules, site management.
 */

'use strict';

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

// Restore tab from URL hash on load
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
        const rules = await chrome.runtime.sendMessage({ type: 'GET_ROUTING_RULES' });
        document.getElementById('stat-rules').textContent = (rules.rules || []).length;
    } catch {
        document.getElementById('stat-rules').textContent = '—';
    }

    // Stats from recent tabs — we show aggregate counts from current tab as a starting point
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.url && !tab.url.startsWith('chrome')) {
            const counts = await chrome.runtime.sendMessage({ type: 'GET_ANNOTATION_COUNT', url: tab.url });
            document.getElementById('stat-total').textContent = counts.total;
            document.getElementById('stat-comments').textContent = counts.comments;
            document.getElementById('stat-issues').textContent = counts.issues;

            // Render recent activity
            const listEl = document.getElementById('activity-list');
            if (counts.recent && counts.recent.length > 0) {
                listEl.innerHTML = '';
                for (const item of counts.recent) {
                    const icon = item.type === 'issue' ? '\ud83d\udc1b' : '\ud83d\udcac';
                    const time = item.created_at ? new Date(item.created_at).toLocaleString() : '';
                    const el = document.createElement('div');
                    el.className = 'activity-item';
                    el.innerHTML = `
                        <span class="activity-type">${icon}</span>
                        <div class="activity-body">
                            <div class="activity-title">${escHtml(item.title || item.content || '(untitled)')}</div>
                            <div class="activity-meta">${escHtml(time)}</div>
                        </div>`;
                    listEl.appendChild(el);
                }
            }
        }
    } catch { /* non-critical */ }
}

// ------------------------------------------------------------------ Account

async function loadAccount() {
    try {
        const state = await chrome.runtime.sendMessage({ type: 'GET_AUTH_STATE' });
        if (state.authToken && state.authUser) {
            showAccountLoggedIn(state.authUser);
        } else {
            showAccountLoggedOut();
        }
    } catch {
        showAccountLoggedOut();
    }

    const config = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
    document.getElementById('opt-username').value = config.userName || '';
}

function showAccountLoggedIn(user) {
    document.getElementById('account-logged-in').style.display = 'block';
    document.getElementById('account-logged-out').style.display = 'none';
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

function showAccountLoggedOut() {
    document.getElementById('account-logged-in').style.display = 'none';
    document.getElementById('account-logged-out').style.display = 'block';
}

document.getElementById('btn-google-login').addEventListener('click', async function() {
    this.disabled = true;
    this.textContent = 'Signing in...';
    try {
        const result = await chrome.runtime.sendMessage({ type: 'LOGIN_GOOGLE' });
        if (result.error) throw new Error(result.error);
        showAccountLoggedIn(result.user);
        showToast('Signed in!');
        if (result.user?.name) {
            document.getElementById('opt-username').value = result.user.name;
        }
    } catch (err) {
        showToast(err.message, 'error');
        showAccountLoggedOut();
    } finally {
        this.disabled = false;
        this.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
        </svg> Sign in with Google`;
    }
});

document.getElementById('btn-sign-out').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'LOGOUT' });
    showAccountLoggedOut();
    showToast('Signed out');
});

document.getElementById('btn-save-username').addEventListener('click', async () => {
    const config = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
    config.userName = document.getElementById('opt-username').value.trim();
    await chrome.runtime.sendMessage({ type: 'SAVE_CONFIG', config });
    showToast('Username saved');
});

// ------------------------------------------------------------------ Connection

async function loadConnection() {
    const config = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
    document.getElementById('opt-server-url').value = config.serverUrl || '';
    testConnection();
}

async function testConnection() {
    const dot = document.getElementById('conn-dot');
    const text = document.getElementById('conn-text');
    const versionEl = document.getElementById('server-version');
    dot.classList.remove('connected');
    text.textContent = 'Checking...';

    try {
        const health = await chrome.runtime.sendMessage({ type: 'CHECK_HEALTH' });
        if (health.status === 'ok') {
            dot.classList.add('connected');
            text.textContent = 'Connected';
            versionEl.textContent = `Server v${health.version || '?'}`;
        } else {
            text.textContent = '服务器异常，请稍后重试';
            versionEl.textContent = '—';
        }
    } catch {
        text.textContent = '无法连接服务器，请检查网络或 Server URL';
        versionEl.textContent = '—';
    }
}

document.getElementById('btn-save-connection').addEventListener('click', async () => {
    const config = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
    const url = document.getElementById('opt-server-url').value.trim().replace(/\/$/, '');
    config.serverUrl = url || 'https://api.coco.xyz/clawmark';
    await chrome.runtime.sendMessage({ type: 'SAVE_CONFIG', config });
    showToast('Server URL saved');
    testConnection();
});

document.getElementById('btn-test-connection').addEventListener('click', testConnection);

// ------------------------------------------------------------------ Delivery Rules

let allRules = [];
let editingRuleId = null;

async function loadRules() {
    try {
        const result = await chrome.runtime.sendMessage({ type: 'GET_ROUTING_RULES' });
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
        tr.querySelector('.del-btn').addEventListener('click', () => deleteRule(rule.id));
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

function updateTargetFields(targetType, existingConfig) {
    const cfg = existingConfig || {};
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
            html = `
                <label>Webhook URL</label>
                <input type="text" class="input" id="tc-webhook" placeholder="https://open.larksuite.com/..." value="${escHtml(cfg.webhook_url || '')}">`;
            break;
        case 'telegram':
            html = `
                <label>Bot Token</label>
                <input type="password" class="input" id="tc-bot-token" placeholder="123456:ABC-DEF..." value="${escHtml(cfg.bot_token || '')}">
                <label>Chat ID</label>
                <input type="text" class="input" id="tc-chat-id" placeholder="-100123456789" value="${escHtml(cfg.chat_id || '')}">`;
            break;
        case 'webhook':
            html = `
                <label>Webhook URL</label>
                <input type="text" class="input" id="tc-url" placeholder="https://your-endpoint.com/webhook" value="${escHtml(cfg.url || '')}">
                <label>Secret (optional)</label>
                <input type="password" class="input" id="tc-secret" placeholder="signing secret" value="${escHtml(cfg.secret || '')}">`;
            break;
        case 'slack':
            html = `
                <label>Webhook URL</label>
                <input type="text" class="input" id="tc-slack-webhook" placeholder="https://hooks.slack.com/services/..." value="${escHtml(cfg.webhook_url || '')}">
                <label>Channel (optional)</label>
                <input type="text" class="input" id="tc-slack-channel" placeholder="#channel-name" value="${escHtml(cfg.channel || '')}">`;
            break;
        case 'email':
            html = `
                <label>Provider</label>
                <select class="input" id="tc-email-provider">
                    <option value="resend"${(cfg.provider || 'resend') === 'resend' ? ' selected' : ''}>Resend</option>
                    <option value="sendgrid"${cfg.provider === 'sendgrid' ? ' selected' : ''}>SendGrid</option>
                </select>
                <label>API Key</label>
                <input type="password" class="input" id="tc-email-apikey" value="${escHtml(cfg.api_key || '')}">
                <label>From</label>
                <input type="text" class="input" id="tc-email-from" value="${escHtml(cfg.from || '')}">
                <label>To (comma-separated)</label>
                <input type="text" class="input" id="tc-email-to" value="${escHtml((cfg.to || []).join(', '))}">`;
            break;
        case 'linear':
            html = `
                <label>API Key</label>
                <input type="password" class="input" id="tc-linear-apikey" value="${escHtml(cfg.api_key || '')}">
                <label>Team ID</label>
                <input type="text" class="input" id="tc-linear-team" value="${escHtml(cfg.team_id || '')}">
                <label>Assignee ID (optional)</label>
                <input type="text" class="input" id="tc-linear-assignee" value="${escHtml(cfg.assignee_id || '')}">`;
            break;
        case 'jira':
            html = `
                <label>Domain</label>
                <input type="text" class="input" id="tc-jira-domain" value="${escHtml(cfg.domain || '')}">
                <label>Email</label>
                <input type="text" class="input" id="tc-jira-email" value="${escHtml(cfg.email || '')}">
                <label>API Token</label>
                <input type="password" class="input" id="tc-jira-token" value="${escHtml(cfg.api_token || '')}">
                <label>Project Key</label>
                <input type="text" class="input" id="tc-jira-project" value="${escHtml(cfg.project_key || '')}">
                <label>Issue Type (optional)</label>
                <input type="text" class="input" id="tc-jira-issuetype" value="${escHtml(cfg.issue_type || '')}">`;
            break;
        case 'hxa-connect':
            html = `
                <label>Hub URL</label>
                <input type="text" class="input" id="tc-hxa-hub" value="${escHtml(cfg.hub_url || '')}">
                <label>Agent ID</label>
                <input type="text" class="input" id="tc-hxa-agent" value="${escHtml(cfg.agent_id || '')}">
                <label>API Key (optional)</label>
                <input type="password" class="input" id="tc-hxa-apikey" value="${escHtml(cfg.api_key || '')}">
                <label>Thread ID (optional)</label>
                <input type="text" class="input" id="tc-hxa-thread" value="${escHtml(cfg.thread_id || '')}">`;
            break;
    }
    targetFieldsEl.innerHTML = html;
}

function getTargetConfig() {
    const type = rfTarget.value;
    switch (type) {
        case 'github-issue': {
            const repo = (document.getElementById('tc-repo')?.value || '').trim();
            const labelsRaw = (document.getElementById('tc-labels')?.value || '').trim();
            const labels = labelsRaw ? labelsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
            return { repo, labels, assignees: [] };
        }
        case 'lark':
            return { webhook_url: (document.getElementById('tc-webhook')?.value || '').trim() };
        case 'telegram':
            return {
                bot_token: (document.getElementById('tc-bot-token')?.value || '').trim(),
                chat_id: (document.getElementById('tc-chat-id')?.value || '').trim(),
            };
        case 'webhook': {
            const url = (document.getElementById('tc-url')?.value || '').trim();
            const secret = (document.getElementById('tc-secret')?.value || '').trim();
            const cfg = { url };
            if (secret) cfg.secret = secret;
            return cfg;
        }
        case 'slack': {
            const wh = (document.getElementById('tc-slack-webhook')?.value || '').trim();
            const ch = (document.getElementById('tc-slack-channel')?.value || '').trim();
            const cfg = { webhook_url: wh };
            if (ch) cfg.channel = ch;
            return cfg;
        }
        case 'email': {
            const provider = document.getElementById('tc-email-provider')?.value || 'resend';
            const apiKey = (document.getElementById('tc-email-apikey')?.value || '').trim();
            const from = (document.getElementById('tc-email-from')?.value || '').trim();
            const toRaw = (document.getElementById('tc-email-to')?.value || '').trim();
            const to = toRaw ? toRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
            return { provider, api_key: apiKey, from, to };
        }
        case 'linear': {
            const apiKey = (document.getElementById('tc-linear-apikey')?.value || '').trim();
            const teamId = (document.getElementById('tc-linear-team')?.value || '').trim();
            const assigneeId = (document.getElementById('tc-linear-assignee')?.value || '').trim();
            const cfg = { api_key: apiKey, team_id: teamId };
            if (assigneeId) cfg.assignee_id = assigneeId;
            return cfg;
        }
        case 'jira': {
            const domain = (document.getElementById('tc-jira-domain')?.value || '').trim();
            const email = (document.getElementById('tc-jira-email')?.value || '').trim();
            const apiToken = (document.getElementById('tc-jira-token')?.value || '').trim();
            const projectKey = (document.getElementById('tc-jira-project')?.value || '').trim();
            const issueType = (document.getElementById('tc-jira-issuetype')?.value || '').trim();
            const cfg = { domain, email, api_token: apiToken, project_key: projectKey };
            if (issueType) cfg.issue_type = issueType;
            return cfg;
        }
        case 'hxa-connect': {
            const hubUrl = (document.getElementById('tc-hxa-hub')?.value || '').trim();
            const agentId = (document.getElementById('tc-hxa-agent')?.value || '').trim();
            const apiKey = (document.getElementById('tc-hxa-apikey')?.value || '').trim();
            const threadId = (document.getElementById('tc-hxa-thread')?.value || '').trim();
            const cfg = { hub_url: hubUrl, agent_id: agentId };
            if (apiKey) cfg.api_key = apiKey;
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
            await chrome.runtime.sendMessage({ type: 'UPDATE_ROUTING_RULE', id: editingRuleId, data });
            showToast('Rule updated');
        } else {
            await chrome.runtime.sendMessage({ type: 'CREATE_ROUTING_RULE', data });
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

async function deleteRule(id) {
    if (!confirm('Delete this routing rule?')) return;
    try {
        await chrome.runtime.sendMessage({ type: 'DELETE_ROUTING_RULE', id });
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
                target_config: typeof rule.target_config === 'string'
                    ? JSON.parse(rule.target_config)
                    : rule.target_config,
                priority: rule.priority || 0,
            };
            await chrome.runtime.sendMessage({ type: 'CREATE_ROUTING_RULE', data });
            imported++;
        }

        showToast(`Imported ${imported} rules`);
        await loadRules();
    } catch (err) {
        showToast(`Import failed: ${err.message}`, 'error');
    }
    e.target.value = '';
});

// ------------------------------------------------------------------ Site Management (Phase 3: blacklist/whitelist + bulk)

let currentSiteMode = 'blacklist'; // 'blacklist' | 'whitelist'
let currentSiteList = [];

async function loadSites() {
    try {
        const setting = await chrome.runtime.sendMessage({ type: 'GET_INJECTION_SETTING' });
        currentSiteList = setting.disabledSites || [];
        currentSiteMode = setting.siteMode || 'blacklist';
    } catch {
        currentSiteList = [];
        currentSiteMode = 'blacklist';
    }
    renderSiteMode();
    renderSiteList(currentSiteList);
}

function renderSiteMode() {
    const blacklistRadio = document.getElementById('mode-blacklist');
    const whitelistRadio = document.getElementById('mode-whitelist');
    if (blacklistRadio) blacklistRadio.checked = currentSiteMode === 'blacklist';
    if (whitelistRadio) whitelistRadio.checked = currentSiteMode === 'whitelist';
    updateSiteListLabels();
}

function updateSiteListLabels() {
    const titleEl = document.getElementById('site-list-title');
    const descEl = document.getElementById('site-list-desc');
    const toggleAllBtn = document.getElementById('btn-toggle-all-sites');
    if (currentSiteMode === 'whitelist') {
        if (titleEl) titleEl.textContent = '已启用的网站（白名单）';
        if (descEl) descEl.textContent = '仅这些网站会启用 ClawMark 标注功能。';
        if (toggleAllBtn) toggleAllBtn.textContent = '清空列表';
    } else {
        if (titleEl) titleEl.textContent = '已禁用的网站（黑名单）';
        if (descEl) descEl.textContent = '列表中的网站将禁用 ClawMark 标注功能。';
        if (toggleAllBtn) toggleAllBtn.textContent = '全部启用（清空）';
    }
}

async function saveSiteSettings() {
    await chrome.runtime.sendMessage({
        type: 'SET_INJECTION_SETTING',
        disabledSites: currentSiteList,
        siteMode: currentSiteMode,
    });
}

function renderSiteList(sites) {
    const listEl = document.getElementById('site-list');
    listEl.innerHTML = '';

    if (sites.length === 0) {
        const emptyMsg = currentSiteMode === 'whitelist' ? '白名单为空（所有网站均被禁用）' : '列表为空（所有网站均已启用）';
        listEl.innerHTML = `<li class="empty-state">${emptyMsg}</li>`;
        return;
    }

    for (const hostname of sites) {
        const li = document.createElement('li');
        li.className = 'site-item';
        const btnLabel = currentSiteMode === 'whitelist' ? '移除' : '启用';
        li.innerHTML = `
            <span class="site-hostname">${escHtml(hostname)}</span>
            <button class="btn btn-secondary remove-site-btn">${btnLabel}</button>`;

        li.querySelector('.remove-site-btn').addEventListener('click', async () => {
            currentSiteList = currentSiteList.filter(s => s !== hostname);
            await saveSiteSettings();
            const msg = currentSiteMode === 'whitelist' ? `已从白名单移除 ${hostname}` : `已为 ${hostname} 重新启用`;
            showToast(msg);
            renderSiteList(currentSiteList);
        });

        listEl.appendChild(li);
    }
}

// Mode toggle
document.querySelectorAll('input[name="site-mode"]').forEach(radio => {
    radio.addEventListener('change', async (e) => {
        const newMode = e.target.value;
        // P2-1: confirm before clearing list if it has entries
        if (currentSiteList.length > 0) {
            const modeLabel = newMode === 'whitelist' ? '白名单' : '黑名单';
            const confirmed = confirm(`切换到${modeLabel}模式会清空当前列表（${currentSiteList.length} 个网站），确定继续？`);
            if (!confirmed) {
                // revert radio selection
                const prevRadio = document.querySelector(`input[name="site-mode"][value="${currentSiteMode}"]`);
                if (prevRadio) prevRadio.checked = true;
                return;
            }
        }
        currentSiteMode = newMode;
        currentSiteList = []; // clear list when switching mode
        await saveSiteSettings();
        updateSiteListLabels();
        renderSiteList(currentSiteList);
        showToast(currentSiteMode === 'whitelist' ? '已切换到白名单模式' : '已切换到黑名单模式');
    });
});

// Add site manually
document.getElementById('btn-add-site')?.addEventListener('click', async () => {
    const input = document.getElementById('site-add-input');
    if (!input) return;
    const raw = input.value.trim().toLowerCase();
    if (!raw) return;
    // Normalize: strip protocol/path
    let hostname = raw.replace(/^https?:\/\//, '').split('/')[0];
    if (!hostname) return;
    if (currentSiteList.includes(hostname)) {
        showToast(`${hostname} 已在列表中`, 'error');
        return;
    }
    currentSiteList = [...currentSiteList, hostname];
    await saveSiteSettings();
    input.value = '';
    const msg = currentSiteMode === 'whitelist' ? `已添加到白名单: ${hostname}` : `已禁用: ${hostname}`;
    showToast(msg);
    renderSiteList(currentSiteList);
});

// Enter key in add input
document.getElementById('site-add-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-add-site')?.click();
});

// Toggle all / clear
document.getElementById('btn-toggle-all-sites')?.addEventListener('click', async () => {
    currentSiteList = [];
    await saveSiteSettings();
    showToast(currentSiteMode === 'whitelist' ? '白名单已清空' : '已为所有网站启用');
    renderSiteList(currentSiteList);
});

// ------------------------------------------------------------------ About

function loadAbout() {
    const manifest = chrome.runtime.getManifest();
    document.getElementById('about-version').textContent = manifest.version;
}

// ------------------------------------------------------------------ Init

loadOverview();
loadAccount();
loadConnection();
loadRules();
loadSites();
loadAbout();

// Listen for auth state changes
chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'AUTH_STATE_CHANGED') {
        loadAccount();
    }
});

// ------------------------------------------------------------------ Welcome page (Phase 2)

function initWelcome() {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('welcome')) return;

    // Show welcome section, hide sidebar + main tabs
    const welcomeSection = document.getElementById('welcome-section');
    if (!welcomeSection) return;
    welcomeSection.style.display = 'flex';

    // Hide normal nav and main content
    const sidebar = document.querySelector('.sidebar');
    const mainContent = document.querySelector('main');
    if (sidebar) sidebar.style.display = 'none';
    if (mainContent) {
        // Hide all tab panels
        mainContent.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
    }

    // Welcome → login button
    document.getElementById('btn-welcome-login')?.addEventListener('click', () => {
        // Navigate to account tab with login trigger
        window.location.href = 'options.html?tab=account&login=1';
    });

    // Show advanced settings toggle
    document.getElementById('btn-show-advanced')?.addEventListener('click', () => {
        const panel = document.getElementById('welcome-advanced-panel');
        if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });

    // Go to connection settings
    document.getElementById('btn-go-connection')?.addEventListener('click', () => {
        window.location.href = 'options.html?tab=connection';
    });

    // Skip welcome
    document.getElementById('btn-welcome-skip')?.addEventListener('click', (e) => {
        e.preventDefault();
        window.location.href = 'options.html';
    });
}

// Handle ?tab= param for direct tab navigation
function handleTabParam() {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get('tab');
    if (!tab) return;
    const navItem = document.querySelector(`.nav-item[data-tab="${tab}"]`);
    if (navItem) navItem.click();
    // Handle login=1 trigger
    if (params.get('login') === '1') {
        setTimeout(() => {
            document.getElementById('btn-google-login')?.click();
        }, 300);
    }
}

// Init welcome + tab routing
initWelcome();
handleTabParam();
