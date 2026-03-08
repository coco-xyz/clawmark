/**
 * ClawMark — Playwright Staging E2E Configuration
 *
 * Targets a persistent staging server (jessie.coco.site).
 * Used by the e2e-staging CI job on develop→main MRs.
 *
 * No webServer block — staging is always running, not started by CI.
 */

'use strict';

const { defineConfig } = require('@playwright/test');

const BASE_URL = process.env.STAGING_BASE_URL || 'https://jessie.coco.site';

module.exports = defineConfig({
    testDir: './e2e',
    timeout: 60_000,      // Remote server — allow more time than local
    retries: 1,           // 1 retry for transient network issues
    workers: 1,           // Sequential — staging is a single shared instance
    reporter: [
        ['list'],
        ['json', { outputFile: 'e2e-staging-results.json' }],
    ],

    use: {
        baseURL: BASE_URL,
        extraHTTPHeaders: { 'Accept': 'application/json' },
        // Browser tests
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
    },

    projects: [
        {
            name: 'api',
            testMatch: /api\/.*\.spec\.js/,
        },
        {
            name: 'browser',
            testMatch: /browser\/.*\.spec\.js/,
            use: {
                browserName: 'chromium',
                headless: true,
                baseURL: BASE_URL,
            },
        },
    ],

    // No webServer — staging server is persistent, managed by PM2 on jessie.coco.site
});
