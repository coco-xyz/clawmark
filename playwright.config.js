/**
 * ClawMark — Playwright E2E Configuration
 *
 * Runs API integration tests and browser E2E tests against a local server instance.
 * The server is started automatically via webServer config.
 */

'use strict';

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './e2e',
    timeout: 30_000,
    retries: 0,
    reporter: [['list'], ['json', { outputFile: 'e2e-results.json' }]],

    use: {
        baseURL: 'http://localhost:3459',
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
            },
        },
    ],

    // Start ClawMark server before tests
    webServer: {
        command: 'CLAWMARK_PORT=3459 CLAWMARK_DATA_DIR=./e2e/.tmp-data CLAWMARK_JWT_SECRET=e2e-test-secret-key node server/index.js',
        port: 3459,
        reuseExistingServer: false,
        timeout: 10_000,
    },
});
