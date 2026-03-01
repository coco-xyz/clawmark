/**
 * ClawMark Chrome Extension — Popup
 *
 * Config and authentication UI
 */

'use strict';

// ------------------------------------------------------------------ elements

const serverUrlInput = document.getElementById('server-url');
const apiKeyInput = document.getElementById('api-key');
const inviteCodeInput = document.getElementById('invite-code');
const googleClientIdInput = document.getElementById('google-client-id');
const userNameInput = document.getElementById('user-name');
const saveBtn = document.getElementById('save-btn');
const panelBtn = document.getElementById('panel-btn');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const messageEl = document.getElementById('message');

// Auth elements
const userInfoEl = document.getElementById('user-info');
const userAvatarEl = document.getElementById('user-avatar');
const userDisplayNameEl = document.getElementById('user-display-name');
const userEmailEl = document.getElementById('user-email');
const signOutBtn = document.getElementById('sign-out-btn');
const googleBtn = document.getElementById('google-btn');
const authNoteEl = document.getElementById('auth-note');

// Manual auth toggle
const manualAuthToggle = document.getElementById('manual-auth-toggle');
const manualAuthArrow = document.getElementById('manual-auth-arrow');
const manualAuthSection = document.getElementById('manual-auth-section');

// ------------------------------------------------------------------ auth UI

function showLoggedIn(user) {
    userInfoEl.classList.add('visible');
    googleBtn.classList.remove('visible');
    authNoteEl.classList.remove('visible');

    userDisplayNameEl.textContent = user.name || user.email || 'User';
    userEmailEl.textContent = user.email || '';

    // Avatar: use picture URL or initials
    if (user.picture) {
        userAvatarEl.innerHTML = `<img src="${user.picture}" alt="">`;
    } else {
        const initials = (user.name || user.email || 'U').charAt(0).toUpperCase();
        userAvatarEl.textContent = initials;
    }
}

function showLoggedOut() {
    userInfoEl.classList.remove('visible');
    googleBtn.classList.add('visible');
    authNoteEl.classList.add('visible');
}

async function loadAuthState() {
    try {
        const state = await chrome.runtime.sendMessage({ type: 'GET_AUTH_STATE' });
        if (state.authToken && state.authUser) {
            showLoggedIn(state.authUser);
        } else {
            showLoggedOut();
        }
    } catch {
        showLoggedOut();
    }
}

// ------------------------------------------------------------------ config

async function loadConfig() {
    const config = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
    serverUrlInput.value = config.serverUrl || '';
    apiKeyInput.value = config.apiKey || '';
    inviteCodeInput.value = config.inviteCode || '';
    googleClientIdInput.value = config.googleClientId || '';
    userNameInput.value = config.userName || '';
}

saveBtn.addEventListener('click', async () => {
    const config = {
        serverUrl: serverUrlInput.value.trim().replace(/\/$/, '') || DEFAULT_SERVER_URL,
        apiKey: apiKeyInput.value.trim(),
        inviteCode: inviteCodeInput.value.trim(),
        googleClientId: googleClientIdInput.value.trim(),
        userName: userNameInput.value.trim(),
    };

    await chrome.runtime.sendMessage({ type: 'SAVE_CONFIG', config });
    showMessage('Saved!', 'success');
    checkConnection();
});

const DEFAULT_SERVER_URL = 'https://api.coco.xyz/clawmark';

// ------------------------------------------------------------------ Google sign-in

googleBtn.addEventListener('click', async () => {
    googleBtn.disabled = true;
    googleBtn.textContent = 'Signing in...';

    try {
        const result = await chrome.runtime.sendMessage({ type: 'LOGIN_GOOGLE' });
        if (result.error) throw new Error(result.error);
        showLoggedIn(result.user);
        showMessage('Signed in!', 'success');
        // Update username field if populated by OAuth
        if (result.user?.name) {
            userNameInput.value = result.user.name;
        }
    } catch (err) {
        showMessage(err.message, 'error');
        showLoggedOut();
    } finally {
        googleBtn.disabled = false;
        googleBtn.innerHTML = `
            <svg viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Sign in with Google`;
    }
});

// ------------------------------------------------------------------ sign out

signOutBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'LOGOUT' });
    showLoggedOut();
    showMessage('Signed out', 'success');
});

// ------------------------------------------------------------------ manual auth toggle

manualAuthToggle.addEventListener('click', () => {
    const isOpen = manualAuthSection.classList.toggle('open');
    manualAuthArrow.classList.toggle('open', isOpen);
});

// ------------------------------------------------------------------ open side panel

panelBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
        await chrome.sidePanel.open({ tabId: tab.id });
        window.close();
    }
});

// ------------------------------------------------------------------ connection check

async function checkConnection() {
    statusText.textContent = 'Checking...';
    statusDot.classList.remove('connected');

    try {
        const health = await chrome.runtime.sendMessage({ type: 'CHECK_HEALTH' });
        if (health.status === 'ok') {
            statusDot.classList.add('connected');
            statusText.textContent = `Connected (v${health.version || '?'})`;
        } else {
            statusText.textContent = 'Server error';
        }
    } catch (err) {
        statusText.textContent = 'Disconnected';
    }
}

function showMessage(text, type) {
    messageEl.textContent = text;
    messageEl.className = `message ${type}`;
    setTimeout(() => { messageEl.textContent = ''; }, 3000);
}

// ------------------------------------------------------------------ injection toggle

const injectionToggle = document.getElementById('injection-toggle');
const siteToggleEl = document.getElementById('site-toggle');
const siteLabelEl = document.getElementById('site-label');
const siteBtnEl = document.getElementById('site-btn');

let currentHostname = '';
let disabledSites = [];

async function loadInjectionSetting() {
    try {
        const setting = await chrome.runtime.sendMessage({ type: 'GET_INJECTION_SETTING' });
        injectionToggle.checked = setting.jsInjectionEnabled;
        disabledSites = setting.disabledSites || [];

        // Get current tab hostname for per-site toggle
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.url) {
            try {
                currentHostname = new URL(tab.url).hostname;
                if (currentHostname && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
                    siteLabelEl.textContent = currentHostname;
                    updateSiteButton();
                    siteToggleEl.classList.add('visible');
                }
            } catch {}
        }
    } catch {}
}

function updateSiteButton() {
    const isDisabled = disabledSites.includes(currentHostname);
    siteBtnEl.textContent = isDisabled ? 'Disabled' : 'Enabled';
    siteBtnEl.classList.toggle('disabled-site', isDisabled);
}

injectionToggle.addEventListener('change', async () => {
    await chrome.runtime.sendMessage({
        type: 'SET_INJECTION_SETTING',
        jsInjectionEnabled: injectionToggle.checked,
    });
    showMessage(injectionToggle.checked ? 'Overlay enabled' : 'Overlay disabled', 'success');
});

siteBtnEl.addEventListener('click', async () => {
    const isDisabled = disabledSites.includes(currentHostname);
    if (isDisabled) {
        disabledSites = disabledSites.filter(h => h !== currentHostname);
    } else {
        disabledSites.push(currentHostname);
    }
    await chrome.runtime.sendMessage({
        type: 'SET_INJECTION_SETTING',
        disabledSites,
    });
    updateSiteButton();
    showMessage(isDisabled ? `Enabled for ${currentHostname}` : `Disabled for ${currentHostname}`, 'success');
});

// ------------------------------------------------------------------ delivery settings

const deliveryToggle = document.getElementById('delivery-toggle');
const deliveryArrow = document.getElementById('delivery-arrow');
const deliveryBody = document.getElementById('delivery-body');
const rulesCountEl = document.getElementById('rules-count');
const rulesListEl = document.getElementById('rules-list');
const rulesLoadingEl = document.getElementById('rules-loading');
const addRuleBtn = document.getElementById('add-rule-btn');
const ruleFormEl = document.getElementById('rule-form');
const rfType = document.getElementById('rf-type');
const rfPattern = document.getElementById('rf-pattern');
const rfPatternLabel = document.getElementById('rf-pattern-label');
const rfTarget = document.getElementById('rf-target');
const targetFieldsEl = document.getElementById('target-fields');
const rfPriority = document.getElementById('rf-priority');
const rfSave = document.getElementById('rf-save');
const rfCancel = document.getElementById('rf-cancel');

let routingRules = [];
let editingRuleId = null;
let rulesLoaded = false;

deliveryToggle.addEventListener('click', () => {
    const isOpen = deliveryBody.classList.toggle('open');
    deliveryArrow.classList.toggle('open', isOpen);
    if (isOpen && !rulesLoaded) loadRoutingRules();
});

async function loadRoutingRules() {
    rulesLoadingEl.style.display = 'block';
    try {
        const result = await chrome.runtime.sendMessage({ type: 'GET_ROUTING_RULES' });
        routingRules = result.rules || [];
        rulesLoaded = true;
        renderRules();
    } catch (err) {
        rulesLoadingEl.textContent = 'Failed to load rules';
    }
}

function renderRules() {
    rulesLoadingEl.style.display = 'none';
    // Remove old rule cards
    rulesListEl.querySelectorAll('.rule-card, .rules-empty').forEach(el => el.remove());

    rulesCountEl.textContent = `Rules (${routingRules.length})`;

    if (routingRules.length === 0) {
        rulesListEl.insertAdjacentHTML('beforeend',
            '<div class="rules-empty">No routing rules yet</div>');
        return;
    }

    for (const rule of routingRules) {
        const card = document.createElement('div');
        card.className = 'rule-card';

        const patternText = rule.rule_type === 'default'
            ? '(default fallback)'
            : (rule.pattern || '—');

        const targetText = formatTarget(rule.target_type, rule.target_config);

        card.innerHTML = `
            <div class="rule-pattern">
                <span class="type-badge">${escHtml(rule.rule_type)}</span>
                ${escHtml(patternText)}
            </div>
            <div class="rule-target">&rarr; ${escHtml(targetText)}</div>
            <div class="rule-actions">
                <button class="edit-btn" data-id="${escHtml(rule.id)}">Edit</button>
                <button class="del-btn" data-id="${escHtml(rule.id)}">Delete</button>
            </div>`;

        card.querySelector('.edit-btn').addEventListener('click', () => editRule(rule));
        card.querySelector('.del-btn').addEventListener('click', () => deleteRule(rule.id));

        rulesListEl.appendChild(card);
    }
}

function parseConfig(config) {
    if (typeof config !== 'string') return config || {};
    try { return JSON.parse(config); } catch { return {}; }
}

function formatTarget(type, config) {
    const cfg = parseConfig(config);
    switch (type) {
        case 'github-issue': return `GitHub: ${cfg.repo || '?'}`;
        case 'lark': return `Lark: ${(cfg.webhook_url || '').substring(0, 30)}...`;
        case 'telegram': return `Telegram: ${cfg.chat_id || '?'}`;
        case 'webhook': return `Webhook: ${(cfg.url || '').substring(0, 30)}...`;
        case 'slack': return `Slack: ${cfg.channel || (cfg.webhook_url || '').substring(0, 30) + '...'}`;
        case 'email': return `Email: ${(cfg.to || []).join(', ').substring(0, 30) || '?'}`;
        default: return type;
    }
}

function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

// ---- target config fields

function updateTargetFields(targetType, existingConfig) {
    const cfg = existingConfig || {};
    let html = '';

    switch (targetType) {
        case 'github-issue':
            html = `
                <label>Repository (owner/repo)</label>
                <input type="text" id="tc-repo" placeholder="owner/repo" value="${escHtml(cfg.repo || '')}">
                <label>Labels (comma-separated)</label>
                <input type="text" id="tc-labels" placeholder="clawmark, bug" value="${escHtml((cfg.labels || []).join(', '))}">`;
            break;
        case 'lark':
            html = `
                <label>Webhook URL</label>
                <input type="text" id="tc-webhook" placeholder="https://open.larksuite.com/..." value="${escHtml(cfg.webhook_url || '')}">`;
            break;
        case 'telegram':
            html = `
                <label>Bot Token</label>
                <input type="password" id="tc-bot-token" placeholder="123456:ABC-DEF..." value="${escHtml(cfg.bot_token || '')}">
                <label>Chat ID</label>
                <input type="text" id="tc-chat-id" placeholder="-100123456789" value="${escHtml(cfg.chat_id || '')}">`;
            break;
        case 'webhook':
            html = `
                <label>Webhook URL</label>
                <input type="text" id="tc-url" placeholder="https://your-endpoint.com/webhook" value="${escHtml(cfg.url || '')}">
                <label>Secret (optional)</label>
                <input type="password" id="tc-secret" placeholder="signing secret" value="${escHtml(cfg.secret || '')}">`;
            break;
        case 'slack':
            html = `
                <label>Webhook URL</label>
                <input type="text" id="tc-slack-webhook" placeholder="https://hooks.slack.com/services/T.../B.../xxx" value="${escHtml(cfg.webhook_url || '')}">
                <label>Channel (optional)</label>
                <input type="text" id="tc-slack-channel" placeholder="#channel-name" value="${escHtml(cfg.channel || '')}">`;
            break;
        case 'email':
            html = `
                <label>Provider</label>
                <select id="tc-email-provider">
                    <option value="resend"${(cfg.provider || 'resend') === 'resend' ? ' selected' : ''}>Resend</option>
                    <option value="sendgrid"${cfg.provider === 'sendgrid' ? ' selected' : ''}>SendGrid</option>
                </select>
                <label>API Key</label>
                <input type="password" id="tc-email-apikey" placeholder="re_xxx... or SG.xxx..." value="${escHtml(cfg.api_key || '')}">
                <label>From</label>
                <input type="text" id="tc-email-from" placeholder="ClawMark <noreply@example.com>" value="${escHtml(cfg.from || '')}">
                <label>To (comma-separated)</label>
                <input type="text" id="tc-email-to" placeholder="team@example.com, lead@example.com" value="${escHtml((cfg.to || []).join(', '))}">`;
            break;
        case 'linear':
            html = `
                <label>API Key</label>
                <input type="password" id="tc-linear-apikey" placeholder="lin_api_..." value="${escHtml(cfg.api_key || '')}">
                <label>Team ID</label>
                <input type="text" id="tc-linear-team" placeholder="team UUID" value="${escHtml(cfg.team_id || '')}">
                <label>Assignee ID (optional)</label>
                <input type="text" id="tc-linear-assignee" placeholder="user UUID" value="${escHtml(cfg.assignee_id || '')}">`;
            break;
        case 'jira':
            html = `
                <label>Domain</label>
                <input type="text" id="tc-jira-domain" placeholder="myteam (→ myteam.atlassian.net)" value="${escHtml(cfg.domain || '')}">
                <label>Email</label>
                <input type="text" id="tc-jira-email" placeholder="user@example.com" value="${escHtml(cfg.email || '')}">
                <label>API Token</label>
                <input type="password" id="tc-jira-token" placeholder="ATATT3..." value="${escHtml(cfg.api_token || '')}">
                <label>Project Key</label>
                <input type="text" id="tc-jira-project" placeholder="PROJ" value="${escHtml(cfg.project_key || '')}">
                <label>Issue Type (optional)</label>
                <input type="text" id="tc-jira-issuetype" placeholder="Task, Bug, Story..." value="${escHtml(cfg.issue_type || '')}">`;
            break;
        case 'hxa-connect':
            html = `
                <label>Hub URL</label>
                <input type="text" id="tc-hxa-hub" placeholder="https://hub.example.com" value="${escHtml(cfg.hub_url || '')}">
                <label>Agent ID</label>
                <input type="text" id="tc-hxa-agent" placeholder="agent UUID" value="${escHtml(cfg.agent_id || '')}">
                <label>API Key (optional)</label>
                <input type="password" id="tc-hxa-apikey" placeholder="Bearer token" value="${escHtml(cfg.api_key || '')}">
                <label>Thread ID (optional)</label>
                <input type="text" id="tc-hxa-thread" placeholder="custom-thread-id" value="${escHtml(cfg.thread_id || '')}">`;
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
            const webhookUrl = (document.getElementById('tc-slack-webhook')?.value || '').trim();
            const channel = (document.getElementById('tc-slack-channel')?.value || '').trim();
            const cfg = { webhook_url: webhookUrl };
            if (channel) cfg.channel = channel;
            return cfg;
        }
        case 'email': {
            const provider = (document.getElementById('tc-email-provider')?.value || 'resend');
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

rfType.addEventListener('change', () => {
    const isDefault = rfType.value === 'default';
    rfPatternLabel.style.display = isDefault ? 'none' : 'block';
    rfPattern.style.display = isDefault ? 'none' : 'block';
});

rfTarget.addEventListener('change', () => {
    updateTargetFields(rfTarget.value);
});

// ---- add / edit / delete

addRuleBtn.addEventListener('click', () => {
    editingRuleId = null;
    rfType.value = 'url_pattern';
    rfPattern.value = '';
    rfTarget.value = 'github-issue';
    rfPriority.value = '0';
    rfPatternLabel.style.display = 'block';
    rfPattern.style.display = 'block';
    updateTargetFields('github-issue');
    rfSave.textContent = 'Save Rule';
    ruleFormEl.classList.add('open');
});

function editRule(rule) {
    editingRuleId = rule.id;
    rfType.value = rule.rule_type;
    rfPattern.value = rule.pattern || '';
    rfTarget.value = rule.target_type;
    rfPriority.value = rule.priority || 0;

    const isDefault = rule.rule_type === 'default';
    rfPatternLabel.style.display = isDefault ? 'none' : 'block';
    rfPattern.style.display = isDefault ? 'none' : 'block';

    updateTargetFields(rule.target_type, parseConfig(rule.target_config));

    rfSave.textContent = 'Update Rule';
    ruleFormEl.classList.add('open');
}

rfCancel.addEventListener('click', () => {
    ruleFormEl.classList.remove('open');
    editingRuleId = null;
});

function validateRuleForm() {
    const type = rfType.value;
    const target = rfTarget.value;
    if (type !== 'default' && !rfPattern.value.trim()) return 'Pattern is required';
    const cfg = getTargetConfig();
    if (target === 'github-issue' && !cfg.repo) return 'Repository is required';
    if (target === 'lark' && !cfg.webhook_url) return 'Webhook URL is required';
    if (target === 'telegram' && (!cfg.bot_token || !cfg.chat_id)) return 'Bot Token and Chat ID are required';
    if (target === 'webhook' && !cfg.url) return 'Webhook URL is required';
    if (target === 'slack' && !cfg.webhook_url) return 'Slack Webhook URL is required';
    if (target === 'email' && (!cfg.api_key || !cfg.from || !cfg.to?.length)) return 'API Key, From, and To are required';
    return null;
}

rfSave.addEventListener('click', async () => {
    const error = validateRuleForm();
    if (error) { showMessage(error, 'error'); return; }

    const isEditing = !!editingRuleId;
    rfSave.disabled = true;
    rfSave.textContent = 'Saving...';

    try {
        const priority = Math.max(0, Math.min(100, parseInt(rfPriority.value, 10) || 0));
        const data = {
            rule_type: rfType.value,
            pattern: rfType.value === 'default' ? null : rfPattern.value.trim(),
            target_type: rfTarget.value,
            target_config: getTargetConfig(),
            priority,
        };

        if (isEditing) {
            await chrome.runtime.sendMessage({ type: 'UPDATE_ROUTING_RULE', id: editingRuleId, data });
        } else {
            await chrome.runtime.sendMessage({ type: 'CREATE_ROUTING_RULE', data });
        }

        ruleFormEl.classList.remove('open');
        editingRuleId = null;
        showMessage(isEditing ? 'Rule updated' : 'Rule created', 'success');
        await loadRoutingRules();
    } catch (err) {
        showMessage(err.message, 'error');
    } finally {
        rfSave.disabled = false;
        rfSave.textContent = 'Save Rule';
    }
});

async function deleteRule(id) {
    if (!confirm('Delete this routing rule?')) return;
    try {
        await chrome.runtime.sendMessage({ type: 'DELETE_ROUTING_RULE', id });
        showMessage('Rule deleted', 'success');
        await loadRoutingRules();
    } catch (err) {
        showMessage(err.message, 'error');
    }
}

// ------------------------------------------------------------------ init

loadConfig();
loadAuthState();
loadInjectionSetting();
checkConnection();
