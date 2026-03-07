/**
 * ClawMark — Playwright E2E Configuration
 *
 * Runs API integration tests and browser E2E tests against a local server instance.
 * The server is started automatically via webServer config.
 *
 * Smoke tests (project: 'smoke') run against an already-deployed environment
 * and do NOT start a local server. Set BASE_URL env var before running.
 */

'use strict';

const { defineConfig } = require('@playwright/test');

// Smoke tests target external env — skip webServer when only running smoke.
const isSmokeOnly = process.env.SMOKE_ONLY === '1';

const API_PORT = 3491;
const DASHBOARD_PORT = 3492;

module.exports = defineConfig({
    testDir: './e2e',
    timeout: 30_000,
    retries: 0,
    workers: 1,
    reporter: [['list'], ['json', { outputFile: 'e2e-results.json' }]],

    use: {
        baseURL: `http://localhost:${API_PORT}`,
        extraHTTPHeaders: {
            'Accept': 'application/json',
        },
    },

    projects: [
        {
            name: 'api',
            testMatch: /api\/.*\.spec\.js/,
        },
        {
            name: 'e2e',
            testMatch: /browser\/.*\.spec\.js/,
            use: {
                browserName: 'chromium',
                headless: true,
                baseURL: `http://localhost:${DASHBOARD_PORT}`,
            },
        },
        {
            // Smoke tests run against an already-deployed environment.
            // Does NOT start webServer — set BASE_URL env var instead.
            name: 'smoke',
            testMatch: /smoke\/.*\.spec\.js/,
        },
    ],

    // Start ClawMark server + dashboard static server before tests (skipped for smoke)
    webServer: isSmokeOnly ? undefined : [
        {
            command: `CLAWMARK_PORT=${API_PORT} CLAWMARK_DATA_DIR=./e2e/.tmp-data CLAWMARK_JWT_SECRET=e2e-test-secret-key CLAWMARK_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 CLAWMARK_WRITE_RATE_LIMIT_MAX=500 CLAWMARK_CONFIG=./e2e/config.e2e.json node server/index.js`,
            port: API_PORT,
            reuseExistingServer: false,
            timeout: 10_000,
        },
        {
            command: `E2E_DASHBOARD_PORT=${DASHBOARD_PORT} node e2e/helpers/dashboard-server.js`,
            port: DASHBOARD_PORT,
            reuseExistingServer: false,
            timeout: 15_000,
        },
    ],
});
