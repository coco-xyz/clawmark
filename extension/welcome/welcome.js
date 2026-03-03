/**
 * ClawMark Welcome Page — shown on first install
 */

'use strict';

const googleBtn = document.getElementById('google-btn');
const successMsg = document.getElementById('success-msg');
const errorMsg = document.getElementById('error-msg');
const advancedToggle = document.getElementById('advanced-toggle');
const advancedArrow = document.getElementById('advanced-arrow');
const advancedSection = document.getElementById('advanced-section');
const serverUrlInput = document.getElementById('server-url');
const saveBtn = document.getElementById('save-btn');

// ---- Google sign-in

googleBtn.addEventListener('click', async () => {
    googleBtn.disabled = true;
    googleBtn.textContent = 'Signing in...';
    errorMsg.classList.remove('visible');

    try {
        const result = await chrome.runtime.sendMessage({ type: 'LOGIN_GOOGLE' });
        if (result.error) throw new Error(result.error);

        // Login succeeded — show success
        googleBtn.style.display = 'none';
        document.querySelector('.hint').style.display = 'none';
        advancedToggle.style.display = 'none';
        advancedSection.classList.remove('open');
        successMsg.classList.add('visible');
    } catch (err) {
        errorMsg.textContent = err.message;
        errorMsg.classList.add('visible');
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

// ---- Advanced settings toggle

advancedToggle.addEventListener('click', () => {
    const isOpen = advancedSection.classList.toggle('open');
    advancedArrow.classList.toggle('open', isOpen);
});

// ---- Load current server URL

async function loadServerUrl() {
    try {
        const config = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
        serverUrlInput.value = config.serverUrl || '';
    } catch {}
}

// ---- Save server URL

saveBtn.addEventListener('click', async () => {
    const url = serverUrlInput.value.trim().replace(/\/$/, '');
    if (!url) return;

    try {
        const config = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
        config.serverUrl = url;
        await chrome.runtime.sendMessage({ type: 'SAVE_CONFIG', config });
        saveBtn.textContent = 'Saved!';
        setTimeout(() => { saveBtn.textContent = 'Save'; }, 2000);
    } catch (err) {
        saveBtn.textContent = 'Error';
        setTimeout(() => { saveBtn.textContent = 'Save'; }, 2000);
    }
});

// ---- Check if already logged in

async function checkExistingAuth() {
    try {
        const state = await chrome.runtime.sendMessage({ type: 'GET_AUTH_STATE' });
        if (state.authToken && state.authUser) {
            // Already logged in — show success state
            googleBtn.style.display = 'none';
            document.querySelector('.hint').style.display = 'none';
            successMsg.classList.add('visible');
        }
    } catch {}
}

// ---- Init

loadServerUrl();
checkExistingAuth();
