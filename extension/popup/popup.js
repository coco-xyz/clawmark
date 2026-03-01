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

// ------------------------------------------------------------------ init

loadConfig();
loadAuthState();
loadInjectionSetting();
checkConnection();
