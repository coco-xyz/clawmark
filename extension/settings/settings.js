/**
 * ClawMark Extension — Settings Page
 *
 * Agent binding UI + per-site permissions with chrome.storage.sync persistence.
 */

'use strict';

// ------------------------------------------------------------------ state

let agents = [];
let sitePermissions = { mode: 'blacklist', sites: [] };
let defaultServerUrl = '';

// ------------------------------------------------------------------ elements

const tabBtns = document.querySelectorAll('.tab-btn');
const tabPanels = document.querySelectorAll('.tab-panel');

// Agents
const agentListEl = document.getElementById('agent-list');
const agentEmptyEl = document.getElementById('agent-empty');
const btnAddAgent = document.getElementById('btn-add-agent');
const addAgentForm = document.getElementById('add-agent-form');
const agentNameInput = document.getElementById('agent-name-input');
const agentKeyInput = document.getElementById('agent-key-input');
const agentServerInput = document.getElementById('agent-server-input');
const btnCancelAgent = document.getElementById('btn-cancel-agent');
const btnSaveAgent = document.getElementById('btn-save-agent');
const agentFormStatus = document.getElementById('agent-form-status');

// Sites
const modeLabelText = document.getElementById('mode-label-text');
const modeDescText = document.getElementById('mode-desc-text');
const modeOptions = document.querySelectorAll('.mode-option');
const siteListTitleEl = document.getElementById('site-list-title');
const siteListDescEl = document.getElementById('site-list-desc');
const siteListEl = document.getElementById('site-list');
const siteEmptyEl = document.getElementById('site-empty');
const btnAddSite = document.getElementById('btn-add-site');
const addSiteForm = document.getElementById('add-site-form');
const sitePatternInput = document.getElementById('site-pattern-input');
const siteErrorCheck = document.getElementById('site-error-check');
const siteNetworkCheck = document.getElementById('site-network-check');
const siteConsoleCheck = document.getElementById('site-console-check');
const btnCancelSite = document.getElementById('btn-cancel-site');
const btnSaveSite = document.getElementById('btn-save-site');

// Import/Export
const btnExport = document.getElementById('btn-export');
const btnImport = document.getElementById('btn-import');
const importFileInput = document.getElementById('import-file');

// Toast
const toastEl = document.getElementById('toast');

// ------------------------------------------------------------------ tabs

tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        tabBtns.forEach(b => b.classList.remove('active'));
        tabPanels.forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('tab-' + tab).classList.add('active');
    });
});

// ------------------------------------------------------------------ toast

let toastTimer = null;

function showToast(msg, type) {
    toastEl.textContent = msg;
    toastEl.className = 'toast visible ' + (type || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toastEl.classList.remove('visible');
    }, 3000);
}

// ------------------------------------------------------------------ storage helpers

async function loadSettings() {
    const result = await chrome.storage.sync.get({
        boundAgents: [],
        sitePermissions: { mode: 'blacklist', sites: [] },
    });
    agents = result.boundAgents;
    sitePermissions = result.sitePermissions;

    // Get default server URL from config
    const config = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
    defaultServerUrl = config.serverUrl || '';
}

async function saveAgents() {
    await chrome.storage.sync.set({ boundAgents: agents });
}

async function saveSitePermissions() {
    await chrome.storage.sync.set({ sitePermissions });
}

// ------------------------------------------------------------------ agent rendering

function renderAgents() {
    // Clear existing agent items (keep empty placeholder)
    const items = agentListEl.querySelectorAll('.agent-item');
    items.forEach(el => el.remove());

    if (agents.length === 0) {
        agentEmptyEl.style.display = '';
        return;
    }
    agentEmptyEl.style.display = 'none';

    agents.forEach((agent, index) => {
        const el = document.createElement('div');
        el.className = 'agent-item';

        const statusClass = agent.status === 'connected' ? 'connected'
            : agent.status === 'disconnected' ? 'disconnected' : 'unknown';

        const keyPreview = agent.keyPrefix || agent.key.slice(0, 12) + '...';

        el.innerHTML = `
            <span class="agent-status-dot ${statusClass}" title="${agent.status || 'unknown'}"></span>
            <div class="agent-info">
                <div class="agent-name">${escapeHtml(agent.name)}</div>
                <div class="agent-key-preview">${escapeHtml(keyPreview)}</div>
            </div>
            <div class="agent-actions">
                <button class="agent-btn" data-action="test" data-index="${index}" title="Test connection">Test</button>
                <button class="agent-btn danger" data-action="remove" data-index="${index}" title="Remove agent">Remove</button>
            </div>
        `;
        agentListEl.appendChild(el);
    });
}

// ------------------------------------------------------------------ agent events

btnAddAgent.addEventListener('click', () => {
    addAgentForm.classList.add('visible');
    btnAddAgent.style.display = 'none';
    agentNameInput.value = '';
    agentKeyInput.value = '';
    agentServerInput.value = '';
    agentFormStatus.textContent = '';
    agentFormStatus.className = 'form-status';
    agentNameInput.focus();
});

btnCancelAgent.addEventListener('click', () => {
    addAgentForm.classList.remove('visible');
    btnAddAgent.style.display = '';
});

btnSaveAgent.addEventListener('click', async () => {
    const key = agentKeyInput.value.trim();
    const serverUrl = agentServerInput.value.trim();

    // Validate key
    if (!key.startsWith('cmak_') || key.length < 10) {
        agentFormStatus.textContent = 'Invalid API key — must start with cmak_ and be at least 10 characters';
        agentFormStatus.className = 'form-status error';
        return;
    }

    // Check for duplicate key
    if (agents.some(a => a.key === key)) {
        agentFormStatus.textContent = 'This API key is already bound';
        agentFormStatus.className = 'form-status error';
        return;
    }

    // Verify key with server and fetch agent info
    agentFormStatus.textContent = 'Verifying key...';
    agentFormStatus.className = 'form-status testing';
    btnSaveAgent.disabled = true;

    try {
        const result = await chrome.runtime.sendMessage({
            type: 'TEST_AGENT_CONNECTION',
            key,
            serverUrl: serverUrl || undefined,
        });

        if (result.error) {
            agentFormStatus.textContent = 'Connection failed: ' + result.error;
            agentFormStatus.className = 'form-status error';
            return;
        }

        // Use server-returned name if user left name blank
        const name = agentNameInput.value.trim() || result.agentName || key.slice(0, 12);

        // Save agent
        const agent = {
            id: generateId(),
            name,
            key,
            keyPrefix: key.slice(0, 12) + '...',
            serverUrl: serverUrl || '',
            status: 'connected',
            agentId: result.agentId || '',
            lastTested: Date.now(),
        };

        agents.push(agent);
        await saveAgents();
        renderAgents();

        addAgentForm.classList.remove('visible');
        btnAddAgent.style.display = '';
        showToast('Agent "' + name + '" connected successfully', 'success');
    } catch (err) {
        agentFormStatus.textContent = 'Error: ' + (err.message || 'Unknown error');
        agentFormStatus.className = 'form-status error';
    } finally {
        btnSaveAgent.disabled = false;
    }
});

agentListEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    const action = btn.dataset.action;
    const index = parseInt(btn.dataset.index, 10);
    if (index < 0 || index >= agents.length) return;

    if (action === 'test') {
        btn.textContent = 'Testing...';
        btn.disabled = true;
        try {
            const agent = agents[index];
            const result = await chrome.runtime.sendMessage({
                type: 'TEST_AGENT_CONNECTION',
                key: agent.key,
                serverUrl: agent.serverUrl || undefined,
            });

            agent.status = result.error ? 'disconnected' : 'connected';
            agent.lastTested = Date.now();
            if (result.agentId) agent.agentId = result.agentId;
            await saveAgents();
            renderAgents();

            showToast(
                result.error
                    ? 'Connection failed: ' + result.error
                    : 'Agent "' + agent.name + '" is connected',
                result.error ? 'error' : 'success'
            );
        } catch (err) {
            showToast('Test failed: ' + err.message, 'error');
        } finally {
            btn.textContent = 'Test';
            btn.disabled = false;
        }
    }

    if (action === 'remove') {
        const agent = agents[index];
        agents.splice(index, 1);
        await saveAgents();
        renderAgents();
        showToast('Agent "' + agent.name + '" removed', 'success');
    }
});

// ------------------------------------------------------------------ site permissions rendering

function renderSitePermissions() {
    // Update mode UI
    const mode = sitePermissions.mode;
    modeOptions.forEach(opt => {
        opt.classList.toggle('active', opt.dataset.mode === mode);
    });

    if (mode === 'blacklist') {
        modeLabelText.textContent = 'Blacklist';
        modeDescText.textContent = 'monitor all sites except those listed below';
        siteListTitleEl.textContent = 'Blocked Sites';
        siteListDescEl.textContent = 'Sites listed here will NOT be monitored. All other sites are monitored by default.';
    } else {
        modeLabelText.textContent = 'Whitelist';
        modeDescText.textContent = 'only monitor sites listed below';
        siteListTitleEl.textContent = 'Allowed Sites';
        siteListDescEl.textContent = 'Only sites listed here will be monitored. All other sites are ignored.';
    }

    // Render site list
    const items = siteListEl.querySelectorAll('.site-item');
    items.forEach(el => el.remove());

    const sites = sitePermissions.sites;
    if (sites.length === 0) {
        siteEmptyEl.style.display = '';
        return;
    }
    siteEmptyEl.style.display = 'none';

    sites.forEach((site, index) => {
        const el = document.createElement('div');
        el.className = 'site-item';

        el.innerHTML = `
            <div class="site-pattern">
                <div class="site-pattern-text">${escapeHtml(site.pattern)}</div>
            </div>
            <div class="site-controls">
                <label class="monitor-toggle" title="Error monitoring">
                    <input type="checkbox" data-index="${index}" data-field="error" ${site.error ? 'checked' : ''}>
                    <span class="monitor-chip">Errors</span>
                </label>
                <label class="monitor-toggle" title="Network monitoring">
                    <input type="checkbox" data-index="${index}" data-field="network" ${site.network ? 'checked' : ''}>
                    <span class="monitor-chip">Network</span>
                </label>
                <label class="monitor-toggle" title="Console monitoring">
                    <input type="checkbox" data-index="${index}" data-field="console" ${site.console ? 'checked' : ''}>
                    <span class="monitor-chip">Console</span>
                </label>
                <button class="site-remove" data-action="remove-site" data-index="${index}" title="Remove">&times;</button>
            </div>
        `;
        siteListEl.appendChild(el);
    });
}

// ------------------------------------------------------------------ site permission events

modeOptions.forEach(opt => {
    opt.addEventListener('click', async () => {
        sitePermissions.mode = opt.dataset.mode;
        await saveSitePermissions();
        renderSitePermissions();
        showToast('Switched to ' + opt.dataset.mode + ' mode', 'success');
    });
});

btnAddSite.addEventListener('click', () => {
    addSiteForm.classList.add('visible');
    btnAddSite.style.display = 'none';
    sitePatternInput.value = '';
    siteErrorCheck.checked = true;
    siteNetworkCheck.checked = true;
    siteConsoleCheck.checked = true;
    sitePatternInput.focus();
});

btnCancelSite.addEventListener('click', () => {
    addSiteForm.classList.remove('visible');
    btnAddSite.style.display = '';
});

btnSaveSite.addEventListener('click', async () => {
    const pattern = sitePatternInput.value.trim().toLowerCase();

    if (!pattern) {
        showToast('Please enter a domain pattern', 'error');
        return;
    }

    // Basic pattern validation
    if (!/^[a-z0-9*._-]+(\.[a-z0-9*._-]+)*$/.test(pattern)) {
        showToast('Invalid domain pattern', 'error');
        return;
    }

    // Check duplicate
    if (sitePermissions.sites.some(s => s.pattern === pattern)) {
        showToast('This pattern already exists', 'error');
        return;
    }

    sitePermissions.sites.push({
        pattern,
        error: siteErrorCheck.checked,
        network: siteNetworkCheck.checked,
        console: siteConsoleCheck.checked,
    });

    await saveSitePermissions();
    renderSitePermissions();

    addSiteForm.classList.remove('visible');
    btnAddSite.style.display = '';
    showToast('Site "' + pattern + '" added', 'success');
});

siteListEl.addEventListener('click', async (e) => {
    const removeBtn = e.target.closest('[data-action="remove-site"]');
    if (removeBtn) {
        const index = parseInt(removeBtn.dataset.index, 10);
        const site = sitePermissions.sites[index];
        sitePermissions.sites.splice(index, 1);
        await saveSitePermissions();
        renderSitePermissions();
        showToast('Site "' + site.pattern + '" removed', 'success');
    }
});

siteListEl.addEventListener('change', async (e) => {
    const checkbox = e.target;
    if (checkbox.dataset.index == null || !checkbox.dataset.field) return;

    const index = parseInt(checkbox.dataset.index, 10);
    const field = checkbox.dataset.field;

    if (index >= 0 && index < sitePermissions.sites.length) {
        sitePermissions.sites[index][field] = checkbox.checked;
        await saveSitePermissions();
    }
});

// ------------------------------------------------------------------ export/import

btnExport.addEventListener('click', () => {
    const data = {
        version: 1,
        exportedAt: new Date().toISOString(),
        agents: agents.map(a => ({
            name: a.name,
            key: a.key,
            serverUrl: a.serverUrl,
        })),
        sitePermissions,
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'clawmark-settings.json';
    a.click();
    URL.revokeObjectURL(url);
    showToast('Settings exported', 'success');
});

btnImport.addEventListener('click', () => {
    importFileInput.click();
});

importFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
        const text = await file.text();
        const data = JSON.parse(text);

        if (!data.version || data.version !== 1) {
            showToast('Unsupported settings file version', 'error');
            return;
        }

        // Import agents
        if (Array.isArray(data.agents)) {
            agents = data.agents.map(a => ({
                id: generateId(),
                name: a.name || 'Imported Agent',
                key: a.key || '',
                keyPrefix: (a.key || '').slice(0, 12) + '...',
                serverUrl: a.serverUrl || '',
                status: 'unknown',
                agentId: '',
                lastTested: 0,
            })).filter(a => a.key.startsWith('cmak_'));
            await saveAgents();
        }

        // Import site permissions
        if (data.sitePermissions) {
            sitePermissions = {
                mode: data.sitePermissions.mode === 'whitelist' ? 'whitelist' : 'blacklist',
                sites: Array.isArray(data.sitePermissions.sites)
                    ? data.sitePermissions.sites.map(s => ({
                        pattern: String(s.pattern || ''),
                        error: s.error !== false,
                        network: s.network !== false,
                        console: s.console !== false,
                    })).filter(s => s.pattern)
                    : [],
            };
            await saveSitePermissions();
        }

        renderAgents();
        renderSitePermissions();
        showToast('Settings imported successfully', 'success');
    } catch (err) {
        showToast('Import failed: ' + err.message, 'error');
    }

    // Reset file input so the same file can be re-imported
    importFileInput.value = '';
});

// ------------------------------------------------------------------ helpers

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ------------------------------------------------------------------ init

async function init() {
    await loadSettings();
    renderAgents();
    renderSitePermissions();

    // Set default server URL placeholder
    if (defaultServerUrl) {
        agentServerInput.placeholder = defaultServerUrl;
    }
}

init();
