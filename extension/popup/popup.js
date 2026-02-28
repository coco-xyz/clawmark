/**
 * ClawMark Chrome Extension — Popup
 *
 * 快捷设置：服务端地址、API Key、用户名
 */

'use strict';

const serverUrlInput = document.getElementById('server-url');
const apiKeyInput = document.getElementById('api-key');
const inviteCodeInput = document.getElementById('invite-code');
const userNameInput = document.getElementById('user-name');
const saveBtn = document.getElementById('save-btn');
const panelBtn = document.getElementById('panel-btn');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const messageEl = document.getElementById('message');

// Load config
async function loadConfig() {
    const config = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
    serverUrlInput.value = config.serverUrl || '';
    apiKeyInput.value = config.apiKey || '';
    inviteCodeInput.value = config.inviteCode || '';
    userNameInput.value = config.userName || '';
}

// Save config
saveBtn.addEventListener('click', async () => {
    const config = {
        serverUrl: serverUrlInput.value.trim().replace(/\/$/, '') || 'https://jessie.coco.site/clawmark',
        apiKey: apiKeyInput.value.trim(),
        inviteCode: inviteCodeInput.value.trim(),
        userName: userNameInput.value.trim(),
    };

    await chrome.runtime.sendMessage({ type: 'SAVE_CONFIG', config });
    showMessage('Saved!', 'success');
    checkConnection();
});

// Open side panel
panelBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
        await chrome.sidePanel.open({ tabId: tab.id });
        window.close();
    }
});

// Check connection
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

// Init
loadConfig();
checkConnection();
