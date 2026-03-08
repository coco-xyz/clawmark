/**
 * E2E browser auth helpers.
 *
 * Injects JWT token + user info into localStorage so the dashboard
 * treats the session as authenticated (bypasses Google OAuth).
 * Reuses createTestToken from the shared auth helper.
 */

'use strict';

const { createTestToken } = require('./auth');

const API_PORT = process.env.E2E_API_PORT || 3491;

const TEST_USER = {
    userId: 'user-e2e-test-1',
    email: 'e2e-test@example.com',
    name: 'E2E Test User',
    picture: '',
};

/**
 * Inject auth state into the page's localStorage before navigation.
 * Must be called BEFORE page.goto().
 *
 * Server URL points directly to the API server. The E2E server config
 * enables CORS for the dashboard origin.
 */
async function injectAuth(page, user = TEST_USER) {
    const token = createTestToken(user);
    const serverUrl = `http://localhost:${API_PORT}`;
    await page.addInitScript(({ token, user, serverUrl }) => {
        localStorage.setItem('clawmark_token', token);
        localStorage.setItem('clawmark_user', JSON.stringify(user));
        localStorage.setItem('clawmark_server_url', serverUrl);
    }, { token, user, serverUrl });
}

/**
 * Set server URL in localStorage without auth (for unauthenticated tests).
 */
async function injectServerUrl(page) {
    const serverUrl = `http://localhost:${API_PORT}`;
    await page.addInitScript(({ serverUrl }) => {
        localStorage.setItem('clawmark_server_url', serverUrl);
    }, { serverUrl });
}

module.exports = { injectAuth, injectServerUrl, TEST_USER };
