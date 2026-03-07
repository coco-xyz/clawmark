/**
 * E2E — Dashboard browser tests
 *
 * Tests the ClawMark dashboard SPA: page load, login screen,
 * authenticated views (Overview, Settings, About tabs).
 *
 * Auth is bootstrapped via localStorage injection + DB seed.
 */

'use strict';

const { test, expect } = require('@playwright/test');
const { injectAuth, injectServerUrl } = require('../helpers/browser-auth');
const { seedTestUser } = require('../helpers/seed-db');

// Seed test user once before all browser tests
test.beforeAll(() => {
    seedTestUser();
});

// ───────────────────────────── Unauthenticated ─────────────────────────────

test.describe('Dashboard — unauthenticated', () => {
    test('shows login screen when not logged in', async ({ page }) => {
        await injectServerUrl(page);
        await page.goto('/');

        await expect(page).toHaveTitle('ClawMark Dashboard');
        await expect(page.locator('#login-screen')).toBeVisible();
        await expect(page.locator('#btn-login')).toBeVisible();
        await expect(page.locator('#btn-login')).toContainText('Sign in with Google');
        // App should be hidden
        await expect(page.locator('#app')).toBeHidden();
    });

    test('shows welcome screen with #welcome hash', async ({ page }) => {
        await injectServerUrl(page);
        await page.goto('/#welcome');

        await expect(page.locator('#welcome-screen')).toBeVisible();
        await expect(page.locator('.welcome-title')).toContainText('Welcome to ClawMark');
        await expect(page.locator('#btn-welcome-login')).toBeVisible();
        await expect(page.locator('#app')).toBeHidden();
    });
});

// ───────────────────────────── Authenticated ───────────────────────────────

test.describe('Dashboard — authenticated', () => {
    test.beforeEach(async ({ page }) => {
        await injectAuth(page);
    });

    // ── Overview tab ──

    test('loads app and shows Overview tab by default', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('#app')).toBeVisible();
        await expect(page.locator('#login-screen')).toBeHidden();

        // Overview tab is active
        await expect(page.locator('#tab-overview')).toBeVisible();
        await expect(page.locator('#tab-overview h1')).toContainText('Overview');
    });

    test('displays connection card with server URL input', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('#opt-server-url')).toBeVisible();
        await expect(page.locator('#btn-save-server')).toBeVisible();
        await expect(page.locator('#btn-test-server')).toBeVisible();
    });

    test('displays stats grid with 4 stat cards', async ({ page }) => {
        await page.goto('/');
        const statCards = page.locator('.stats-grid .stat-card');
        await expect(statCards).toHaveCount(4);

        await expect(page.locator('#stat-total')).toBeVisible();
        await expect(page.locator('#stat-comments')).toBeVisible();
        await expect(page.locator('#stat-issues')).toBeVisible();
        await expect(page.locator('#stat-rules')).toBeVisible();
    });

    test('shows sidebar with user account info', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('.sidebar')).toBeVisible();
        await expect(page.locator('.sidebar-title')).toContainText('ClawMark');
        await expect(page.locator('#btn-sign-out')).toBeVisible();
    });

    // ── Settings tab ──

    test('navigates to Settings tab', async ({ page }) => {
        await page.goto('/');
        await page.locator('[data-tab="settings"]').click();

        await expect(page.locator('#tab-settings')).toBeVisible();
        await expect(page.locator('#tab-settings h1')).toContainText('Settings');
        await expect(page.locator('#tab-overview')).toBeHidden();
    });

    test('Settings tab shows Auth Credentials section', async ({ page }) => {
        await page.goto('/');
        await page.locator('[data-tab="settings"]').click();

        await expect(page.locator('#btn-add-auth')).toBeVisible();
        await expect(page.locator('#auths-table')).toBeVisible();
    });

    test('Settings tab shows Delivery Rules section', async ({ page }) => {
        await page.goto('/');
        await page.locator('[data-tab="settings"]').click();

        await expect(page.locator('#btn-add-rule')).toBeVisible();
        await expect(page.locator('#rules-table')).toBeVisible();

        // Quick add buttons
        const quickAdd = page.locator('.quick-add-btn');
        await expect(quickAdd).toHaveCount(5);
    });

    test('Settings tab opens Add Auth modal', async ({ page }) => {
        await page.goto('/');
        await page.locator('[data-tab="settings"]').click();
        await page.locator('#btn-add-auth').click();

        await expect(page.locator('#auth-modal')).toBeVisible();
        await expect(page.locator('#auth-modal-title')).toContainText('Add Auth');
        await expect(page.locator('#opt-auth-type')).toBeVisible();

        // Close modal
        await page.locator('#auth-modal-close').click();
        await expect(page.locator('#auth-modal')).toBeHidden();
    });

    test('Settings tab opens Add Rule modal', async ({ page }) => {
        await page.goto('/');
        await page.locator('[data-tab="settings"]').click();
        await page.locator('#btn-add-rule').click();

        await expect(page.locator('#rule-modal')).toBeVisible();
        await expect(page.locator('#rule-modal-title')).toContainText('Add Rule');
        await expect(page.locator('#opt-rf-type')).toBeVisible();
        await expect(page.locator('#opt-rf-target')).toBeVisible();

        // Close modal
        await page.locator('#rule-modal-close').click();
        await expect(page.locator('#rule-modal')).toBeHidden();
    });

    // ── About tab ──

    test('navigates to About tab', async ({ page }) => {
        await page.goto('/');
        await page.locator('[data-tab="about"]').click();

        await expect(page.locator('#tab-about')).toBeVisible();
        await expect(page.locator('#tab-about h1')).toContainText('About');
        await expect(page.locator('#tab-overview')).toBeHidden();
    });

    test('About tab shows version info and links', async ({ page }) => {
        await page.goto('/');
        await page.locator('[data-tab="about"]').click();

        await expect(page.locator('#about-server-version')).toBeVisible();
        await expect(page.locator('.link-list')).toBeVisible();
        await expect(page.locator('.link-list a')).toHaveCount(5);
    });

    // ── Sign out ──

    test('sign out returns to login screen', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('#app')).toBeVisible();

        await page.locator('#btn-sign-out').click();

        await expect(page.locator('#login-screen')).toBeVisible();
        await expect(page.locator('#app')).toBeHidden();
    });
});
