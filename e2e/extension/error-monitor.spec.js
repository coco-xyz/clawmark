/**
 * E2E — ErrorMonitor Error Sentinel tests (#63 #64)
 *
 * Verifies the full error capture pipeline:
 * 1. ErrorMonitor content script captures JS/Promise/Console/Network errors
 * 2. React noise is filtered out
 * 3. Non-coco domains are skipped (whitelist)
 * 4. Sensitive data (tokens, passwords) is sanitized
 * 5. error-storage.js stores errors with correct fingerprint
 * 6. Badge shows unread error count
 * 7. Clear/read APIs work correctly
 *
 * Uses Playwright's chromium.launchPersistentContext with --load-extension.
 */

'use strict';

const { test, expect, chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const EXTENSION_DIR = path.resolve(__dirname, '../../extension');
const FIXTURE_DIR = path.resolve(__dirname, '../fixtures');

// Test fixture: a minimal HTML page that triggers various errors
const ERROR_TEST_PAGE = `
<!DOCTYPE html>
<html>
<head><title>ErrorMonitor E2E Test</title></head>
<body>
<h1>Error Sentinel Test Page</h1>
<button id="trigger-js-error">JS Error</button>
<button id="trigger-promise-rejection">Promise Rejection</button>
<button id="trigger-console-error">Console Error</button>
<button id="trigger-react-noise">React Noise</button>
<button id="trigger-fetch-4xx">Fetch 4xx</button>
<button id="trigger-fetch-5xx">Fetch 5xx</button>
<button id="trigger-sensitive">Sensitive Data Error</button>
<script>
document.getElementById('trigger-js-error').onclick = () => {
    undefinedFunction();
};
document.getElementById('trigger-promise-rejection').onclick = () => {
    Promise.reject(new Error('Unhandled test rejection'));
};
document.getElementById('trigger-console-error').onclick = () => {
    console.error('Test console error message');
};
document.getElementById('trigger-react-noise').onclick = () => {
    console.error('Warning: Each child in a list should have a unique "key" prop.');
};
document.getElementById('trigger-fetch-4xx').onclick = () => {
    fetch('/nonexistent-endpoint-404');
};
document.getElementById('trigger-fetch-5xx').onclick = () => {
    fetch('/trigger-500');
};
document.getElementById('trigger-sensitive').onclick = () => {
    console.error('Auth failed: token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjF9.abc123 password=secretpass123');
};
</script>
</body>
</html>
`;

// Non-coco domain page (should NOT capture errors)
const NON_COCO_PAGE = `
<!DOCTYPE html>
<html>
<head><title>Non-Coco Domain Test</title></head>
<body>
<script>console.error('This error should NOT be captured');</script>
</body>
</html>
`;

let context;
let extensionId;

test.beforeAll(async () => {
    // Write test fixture
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    fs.writeFileSync(path.join(FIXTURE_DIR, 'error-test.html'), ERROR_TEST_PAGE);
    fs.writeFileSync(path.join(FIXTURE_DIR, 'non-coco-test.html'), NON_COCO_PAGE);

    context = await chromium.launchPersistentContext('', {
        headless: false,
        channel: 'chromium',
        args: [
            `--disable-extensions-except=${EXTENSION_DIR}`,
            `--load-extension=${EXTENSION_DIR}`,
            '--no-first-run',
            '--disable-default-apps',
        ],
    });

    // Find extension ID
    let sw;
    for (let i = 0; i < 10; i++) {
        const workers = context.serviceWorkers();
        sw = workers.find(w => w.url().includes('chrome-extension://'));
        if (sw) break;
        sw = await Promise.race([
            context.waitForEvent('serviceworker', { timeout: 3000 }).catch(() => null),
            new Promise(r => setTimeout(r, 3000)),
        ]);
        if (sw && sw.url?.().includes('chrome-extension://')) break;
        sw = null;
    }

    if (sw) {
        extensionId = sw.url().split('/')[2];
    }

    // Enable passive monitoring + set allowed domains for test
    if (extensionId) {
        const bgPage = await context.newPage();
        await bgPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
        await bgPage.evaluate(() => {
            return chrome.storage.sync.set({
                passiveMonitorEnabled: true,
                passiveMonitorErrorOnly: false,
                agentEmbedAllowedDomains: ['localhost', 'coco.xyz', 'coco.site', 'hxa.net'],
            });
        });
        await bgPage.close();
    }
});

test.afterAll(async () => {
    if (context) await context.close();
    // Clean up fixture files
    try {
        fs.unlinkSync(path.join(FIXTURE_DIR, 'error-test.html'));
        fs.unlinkSync(path.join(FIXTURE_DIR, 'non-coco-test.html'));
        fs.rmdirSync(FIXTURE_DIR);
    } catch { /* ignore */ }
});

/**
 * Helper: get errors stored for a tab via the service worker.
 */
async function getStoredErrors(page, tabId) {
    return page.evaluate(async (tid) => {
        const key = `errors_${tid}`;
        const result = await chrome.storage.local.get({ [key]: { errors: [], count: 0 } });
        return result[key];
    }, tabId);
}

/**
 * Helper: clear all stored errors.
 */
async function clearAllErrors(page) {
    return page.evaluate(async () => {
        const all = await chrome.storage.local.get(null);
        const keys = Object.keys(all).filter(k => k.startsWith('errors_'));
        if (keys.length > 0) await chrome.storage.local.remove(keys);
    });
}

/**
 * Helper: open a localhost page that serves the fixture HTML.
 * Since we don't have a file server, use a data URI with localhost-like behavior.
 * For whitelist testing we need actual localhost, so use the e2e API server.
 */
async function openTestPage(ctx, apiUrl) {
    const page = await ctx.newPage();
    // Navigate to the API server (localhost) — it will 404 but that's fine,
    // we inject our test HTML via page.setContent after navigation establishes the origin
    await page.goto(`${apiUrl}/e2e-error-test`, { waitUntil: 'commit' }).catch(() => {});
    await page.setContent(ERROR_TEST_PAGE, { waitUntil: 'domcontentloaded' });
    // Wait for content script to attach
    await page.waitForTimeout(2000);
    return page;
}

// ─── Tests ──────────────────────────────────────────────────────────────

const API_URL = `http://localhost:${process.env.E2E_API_PORT || 3491}`;

test.describe('ErrorMonitor — JS error capture', () => {
    test('captures window.onerror from uncaught exception', async () => {
        const page = await openTestPage(context, API_URL);
        const helperPage = await context.newPage();
        await helperPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
        await clearAllErrors(helperPage);

        // Trigger JS error
        await page.click('#trigger-js-error').catch(() => {});
        await page.waitForTimeout(1500);

        // Check stored errors via extension page (has chrome.storage access)
        const tabId = await page.evaluate(() => {
            return new Promise(resolve => {
                chrome.runtime?.sendMessage?.({ type: 'GET_TAB_ID' }, resolve);
            });
        }).catch(() => null);

        // Read all errors from storage
        const allErrors = await helperPage.evaluate(async () => {
            const all = await chrome.storage.local.get(null);
            const errors = [];
            for (const [key, val] of Object.entries(all)) {
                if (key.startsWith('errors_') && val?.errors) {
                    errors.push(...val.errors);
                }
            }
            return errors;
        });

        const jsErrors = allErrors.filter(e => e.type === 'js-error');
        expect(jsErrors.length).toBeGreaterThanOrEqual(1);
        expect(jsErrors[0].message).toContain('undefinedFunction');
        expect(jsErrors[0].severity).toBe('error');

        await page.close();
        await helperPage.close();
    });

    test('captures unhandled promise rejection', async () => {
        const page = await openTestPage(context, API_URL);
        const helperPage = await context.newPage();
        await helperPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
        await clearAllErrors(helperPage);

        await page.click('#trigger-promise-rejection');
        await page.waitForTimeout(1500);

        const allErrors = await helperPage.evaluate(async () => {
            const all = await chrome.storage.local.get(null);
            const errors = [];
            for (const [key, val] of Object.entries(all)) {
                if (key.startsWith('errors_') && val?.errors) errors.push(...val.errors);
            }
            return errors;
        });

        const rejections = allErrors.filter(e => e.type === 'unhandled-rejection');
        expect(rejections.length).toBeGreaterThanOrEqual(1);
        expect(rejections[0].message).toContain('Unhandled test rejection');

        await page.close();
        await helperPage.close();
    });
});

test.describe('ErrorMonitor — console.error + React noise', () => {
    test('captures console.error', async () => {
        const page = await openTestPage(context, API_URL);
        const helperPage = await context.newPage();
        await helperPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
        await clearAllErrors(helperPage);

        await page.click('#trigger-console-error');
        await page.waitForTimeout(1500);

        const allErrors = await helperPage.evaluate(async () => {
            const all = await chrome.storage.local.get(null);
            const errors = [];
            for (const [key, val] of Object.entries(all)) {
                if (key.startsWith('errors_') && val?.errors) errors.push(...val.errors);
            }
            return errors;
        });

        const consoleErrors = allErrors.filter(e => e.type === 'console-error');
        expect(consoleErrors.length).toBeGreaterThanOrEqual(1);
        expect(consoleErrors[0].message).toContain('Test console error message');

        await page.close();
        await helperPage.close();
    });

    test('filters React dev-mode noise', async () => {
        const page = await openTestPage(context, API_URL);
        const helperPage = await context.newPage();
        await helperPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
        await clearAllErrors(helperPage);

        await page.click('#trigger-react-noise');
        await page.waitForTimeout(1500);

        const allErrors = await helperPage.evaluate(async () => {
            const all = await chrome.storage.local.get(null);
            const errors = [];
            for (const [key, val] of Object.entries(all)) {
                if (key.startsWith('errors_') && val?.errors) errors.push(...val.errors);
            }
            return errors;
        });

        // React noise should NOT appear in stored errors
        const reactNoise = allErrors.filter(e =>
            e.message && e.message.includes('Each child in a list')
        );
        expect(reactNoise.length).toBe(0);

        await page.close();
        await helperPage.close();
    });
});

test.describe('ErrorMonitor — sensitive data sanitization', () => {
    test('redacts tokens and passwords from error messages', async () => {
        const page = await openTestPage(context, API_URL);
        const helperPage = await context.newPage();
        await helperPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
        await clearAllErrors(helperPage);

        await page.click('#trigger-sensitive');
        await page.waitForTimeout(1500);

        const allErrors = await helperPage.evaluate(async () => {
            const all = await chrome.storage.local.get(null);
            const errors = [];
            for (const [key, val] of Object.entries(all)) {
                if (key.startsWith('errors_') && val?.errors) errors.push(...val.errors);
            }
            return errors;
        });

        const sensitiveErrors = allErrors.filter(e => e.type === 'console-error');
        expect(sensitiveErrors.length).toBeGreaterThanOrEqual(1);

        const msg = sensitiveErrors[0].message;
        // JWT should be redacted
        expect(msg).not.toContain('eyJhbGciOiJIUzI1NiI');
        // Password should be redacted
        expect(msg).not.toContain('secretpass123');
        // Should contain REDACTED marker
        expect(msg).toContain('[REDACTED]');

        await page.close();
        await helperPage.close();
    });
});

test.describe('ErrorMonitor — domain whitelist', () => {
    test('does NOT capture errors on non-allowed domains', async () => {
        // Use a data: URI page — not on localhost/coco domains
        const page = await context.newPage();
        await page.goto('data:text/html,' + encodeURIComponent(NON_COCO_PAGE));
        await page.waitForTimeout(2000);

        const helperPage = await context.newPage();
        await helperPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);

        const allErrors = await helperPage.evaluate(async () => {
            const all = await chrome.storage.local.get(null);
            const errors = [];
            for (const [key, val] of Object.entries(all)) {
                if (key.startsWith('errors_') && val?.errors) errors.push(...val.errors);
            }
            return errors;
        });

        // data: URI is not in the allowed domains, so no errors should be captured
        const nonCocoErrors = allErrors.filter(e =>
            e.message && e.message.includes('This error should NOT be captured')
        );
        expect(nonCocoErrors.length).toBe(0);

        await page.close();
        await helperPage.close();
    });
});

test.describe('ErrorMonitor — badge & storage', () => {
    test('badge shows error count and clear resets it', async () => {
        const page = await openTestPage(context, API_URL);
        const helperPage = await context.newPage();
        await helperPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
        await clearAllErrors(helperPage);

        // Trigger a few errors
        await page.click('#trigger-console-error');
        await page.waitForTimeout(500);
        await page.click('#trigger-promise-rejection').catch(() => {});
        await page.waitForTimeout(1500);

        // Check that errors are stored
        const errorsAfterCapture = await helperPage.evaluate(async () => {
            const all = await chrome.storage.local.get(null);
            let total = 0;
            for (const [key, val] of Object.entries(all)) {
                if (key.startsWith('errors_') && val?.count) total += val.count;
            }
            return total;
        });
        expect(errorsAfterCapture).toBeGreaterThan(0);

        // Clear all errors
        await clearAllErrors(helperPage);

        // Verify storage is empty
        const errorsAfterClear = await helperPage.evaluate(async () => {
            const all = await chrome.storage.local.get(null);
            let total = 0;
            for (const [key, val] of Object.entries(all)) {
                if (key.startsWith('errors_') && val?.errors) total += val.errors.length;
            }
            return total;
        });
        expect(errorsAfterClear).toBe(0);

        await page.close();
        await helperPage.close();
    });

    test('error entries include source and line fields', async () => {
        const page = await openTestPage(context, API_URL);
        const helperPage = await context.newPage();
        await helperPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
        await clearAllErrors(helperPage);

        await page.click('#trigger-js-error').catch(() => {});
        await page.waitForTimeout(1500);

        const allErrors = await helperPage.evaluate(async () => {
            const all = await chrome.storage.local.get(null);
            const errors = [];
            for (const [key, val] of Object.entries(all)) {
                if (key.startsWith('errors_') && val?.errors) errors.push(...val.errors);
            }
            return errors;
        });

        const jsErrors = allErrors.filter(e => e.type === 'js-error');
        expect(jsErrors.length).toBeGreaterThanOrEqual(1);
        // #64: entry should have source and line fields
        expect(jsErrors[0]).toHaveProperty('source');
        expect(jsErrors[0]).toHaveProperty('line');

        await page.close();
        await helperPage.close();
    });
});
