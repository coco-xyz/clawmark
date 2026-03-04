/**
 * ClawMark Chrome Extension — Popup (v2)
 *
 * Current-page focused: master toggle, delivery targets, annotation stats, quick actions.
 * All configuration moved to Dashboard (options page).
 */

'use strict';

// ------------------------------------------------------------------ elements

const masterToggle = document.getElementById('master-toggle');
const gearBtn = document.getElementById('gear-btn');
const disabledOverlay = document.getElementById('disabled-overlay');
const loginPrompt = document.getElementById('login-prompt');
const mainContent = document.getElementById('main-content');
const googleBtn = document.getElementById('google-btn');
const settingsLink = document.getElementById('settings-link');
const tabUrlEl = document.getElementById('tab-url');
const targetListEl = document.getElementById('target-list');
const noTargetsEl = document.getElementById('no-targets');
const commentCountEl = document.getElementById('comment-count');
const issueCountEl = document.getElementById('issue-count');
const recentEl = document.getElementById('recent-annotations');
const emptyAnnotationsEl = document.getElementById('empty-annotations');
const siteSectionEl = document.getElementById('site-section');
const siteInfoEl = document.getElementById('site-info');
const siteBtnEl = document.getElementById('site-btn');
const messageEl = document.getElementById('message');

let currentUrl = '';
let currentHostname = '';
let disabledSites = [];
let isLoggedIn = false;

// ------------------------------------------------------------------ master toggle

async function loadMasterToggle() {
    const result = await chrome.runtime.sendMessage({ type: 'GET_MASTER_TOGGLE' });
    masterToggle.checked = result.masterEnabled;
    updateMasterState(result.masterEnabled);
}

function updateMasterState(enabled) {
    if (enabled) {
        disabledOverlay.classList.remove('visible');
        if (isLoggedIn) {
            mainContent.classList.remove('hidden');
            loginPrompt.classList.remove('visible');
        } else {
            mainContent.classList.add('hidden');
            loginPrompt.classList.add('visible');
        }
    } else {
        disabledOverlay.classList.add('visible');
        mainContent.classList.add('hidden');
        loginPrompt.classList.remove('visible');
    }
}

masterToggle.addEventListener('change', async () => {
    const enabled = masterToggle.checked;
    await chrome.runtime.sendMessage({ type: 'SET_MASTER_TOGGLE', enabled });
    updateMasterState(enabled);
    showMessage(enabled ? 'ClawMark enabled' : 'ClawMark paused', 'success');
});

// ------------------------------------------------------------------ gear -> dashboard

gearBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
});

settingsLink.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
});

// ------------------------------------------------------------------ auth

async function loadAuth() {
    try {
        const state = await chrome.runtime.sendMessage({ type: 'GET_AUTH_STATE' });
        isLoggedIn = !!(state.authToken && state.authUser);
    } catch {
        isLoggedIn = false;
    }
}

googleBtn.addEventListener('click', async () => {
    googleBtn.disabled = true;
    googleBtn.textContent = 'Signing in...';
    try {
        const result = await chrome.runtime.sendMessage({ type: 'LOGIN_GOOGLE' });
        if (result.error) throw new Error(result.error);
        isLoggedIn = true;
        updateMasterState(masterToggle.checked);
        showMessage('Signed in!', 'success');
        loadPageData();
    } catch (err) {
        showMessage(err.message, 'error');
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

// ------------------------------------------------------------------ current tab

async function loadCurrentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;

    currentUrl = tab.url;
    try {
        const url = new URL(tab.url);
        currentHostname = url.hostname;
        // Show truncated URL
        const display = url.hostname + url.pathname;
        tabUrlEl.textContent = display.length > 40 ? display.substring(0, 40) + '...' : display;
    } catch {
        tabUrlEl.textContent = tab.url.substring(0, 40);
    }
}

// ------------------------------------------------------------------ delivery targets

async function loadDeliveryTargets() {
    if (!currentUrl || currentUrl.startsWith('chrome')) {
        noTargetsEl.style.display = 'block';
        return;
    }

    try {
        // Get matched targets for this URL
        const result = await chrome.runtime.sendMessage({
            type: 'RESOLVE_DISPATCH_TARGETS',
            source_url: currentUrl,
            item_type: 'comment',
            tags: [],
        });

        const targets = result.targets || [];
        if (targets.length === 0) {
            noTargetsEl.style.display = 'block';
            return;
        }

        noTargetsEl.style.display = 'none';
        targetListEl.innerHTML = '';

        for (let i = 0; i < targets.length; i++) {
            const t = targets[i];
            const div = document.createElement('div');
            div.className = 'target-item';
            const name = t.name || formatTargetName(t.target_type, t.target_config);
            div.innerHTML = `
                ${i === 0 ? '<span class="target-star">&#x2605;</span>' : '<span style="width:12px;display:inline-block"></span>'}
                <span class="target-name">${escHtml(name)}</span>
                <span class="target-type">${escHtml(t.target_type)}</span>`;
            targetListEl.appendChild(div);
        }
    } catch {
        // Server may not support resolve endpoint yet
        noTargetsEl.textContent = 'Could not load targets';
        noTargetsEl.style.display = 'block';
    }
}

function formatTargetName(type, config) {
    const cfg = typeof config === 'string' ? JSON.parse(config || '{}') : (config || {});
    switch (type) {
        case 'github-issue': return `GitHub: ${cfg.repo || '?'}`;
        case 'lark': return 'Lark Webhook';
        case 'telegram': return `Telegram: ${cfg.chat_id || '?'}`;
        case 'slack': return `Slack: ${cfg.channel || 'webhook'}`;
        case 'webhook': return 'Webhook';
        case 'email': return `Email: ${(cfg.to || []).join(', ') || '?'}`;
        case 'hxa-connect': return 'HxA Connect';
        default: return type;
    }
}

document.getElementById('btn-more-targets').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
});

// ------------------------------------------------------------------ annotation stats

async function loadAnnotationStats() {
    if (!currentUrl || currentUrl.startsWith('chrome')) {
        emptyAnnotationsEl.style.display = 'block';
        return;
    }

    try {
        const counts = await chrome.runtime.sendMessage({
            type: 'GET_ANNOTATION_COUNT',
            url: currentUrl,
        });

        commentCountEl.textContent = counts.comments;
        issueCountEl.textContent = counts.issues;

        if (counts.error) {
            emptyAnnotationsEl.style.display = 'block';
            recentEl.innerHTML = '';
            return;
        }

        if (counts.total === 0) {
            emptyAnnotationsEl.style.display = 'block';
            recentEl.innerHTML = '';
            // Clear badge when no annotations
            chrome.action.setBadgeText({ text: '' });
            return;
        }

        emptyAnnotationsEl.style.display = 'none';
        recentEl.innerHTML = '';

        for (const item of (counts.recent || []).slice(0, 3)) {
            const text = item.quote || item.content || item.title || '';
            const time = item.created_at ? timeAgo(new Date(item.created_at)) : '';
            const div = document.createElement('div');
            div.className = 'recent-item';
            div.innerHTML = `<span class="quote">"${escHtml(text.substring(0, 40))}"</span><span class="time">${escHtml(time)}</span>`;
            recentEl.appendChild(div);
        }

        // View all button
        const viewAll = document.createElement('button');
        viewAll.className = 'view-all';
        viewAll.textContent = 'View all \u2192';
        viewAll.addEventListener('click', async () => {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab) {
                await chrome.sidePanel.open({ tabId: tab.id });
                window.close();
            }
        });
        recentEl.appendChild(viewAll);

        // Update badge
        if (counts.total > 0) {
            chrome.action.setBadgeText({ text: String(counts.total) });
            chrome.action.setBadgeBackgroundColor({ color: '#5865f2' });
        }
    } catch {
        emptyAnnotationsEl.style.display = 'block';
    }
}

function timeAgo(date) {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

// ------------------------------------------------------------------ site toggle

async function loadSiteToggle() {
    if (!currentHostname || currentUrl.startsWith('chrome://') || currentUrl.startsWith('chrome-extension://')) {
        return;
    }

    const setting = await chrome.runtime.sendMessage({ type: 'GET_INJECTION_SETTING' });
    disabledSites = setting.disabledSites || [];

    siteInfoEl.textContent = currentHostname;
    updateSiteBtn();
    siteSectionEl.classList.add('visible');
}

function updateSiteBtn() {
    const isDisabled = disabledSites.includes(currentHostname);
    siteBtnEl.textContent = isDisabled ? 'Disabled' : 'Enabled';
    siteBtnEl.classList.toggle('disabled-state', isDisabled);
}

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
    updateSiteBtn();
    showMessage(isDisabled ? `Enabled for ${currentHostname}` : `Disabled for ${currentHostname}`, 'success');
});

// ------------------------------------------------------------------ quick actions

document.getElementById('btn-screenshot').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
        chrome.tabs.sendMessage(tab.id, { type: 'START_SCREENSHOT' });
        window.close();
    }
});

document.getElementById('btn-panel').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
        await chrome.sidePanel.open({ tabId: tab.id });
        window.close();
    }
});

// ------------------------------------------------------------------ helpers

function escHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function showMessage(text, type) {
    messageEl.textContent = text;
    messageEl.className = `message ${type}`;
    setTimeout(() => { messageEl.textContent = ''; messageEl.className = 'message'; }, 3000);
}

// ------------------------------------------------------------------ page data loader

async function loadPageData() {
    await loadCurrentTab();
    loadDeliveryTargets();
    loadAnnotationStats();
    loadSiteToggle();
}

// ------------------------------------------------------------------ version check

async function checkVersion() {
    try {
        const result = await chrome.runtime.sendMessage({ type: 'CHECK_VERSION' });
        if (!result.hasUpdate) return;

        const banner = document.getElementById('update-banner');
        const versionEl = document.getElementById('update-version');
        const linkEl = document.getElementById('update-link');
        const dismissEl = document.getElementById('update-dismiss');

        versionEl.textContent = 'v' + result.latestVersion;
        linkEl.href = result.downloadUrl;

        banner.classList.add('visible');

        dismissEl.addEventListener('click', () => {
            banner.classList.remove('visible');
        }, { once: true });
    } catch {
        // Version check is non-critical — fail silently
    }
}

// ------------------------------------------------------------------ init

async function init() {
    await loadAuth();
    await loadMasterToggle();

    if (isLoggedIn && masterToggle.checked) {
        loadPageData();
    }

    // Non-blocking version check
    checkVersion();
}

init();
