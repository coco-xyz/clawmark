/**
 * ClawMark — Example Patrol Scripts (#79)
 *
 * Pre-built patrol script definitions for common flows.
 * Each script is a plain object following the patrol DSL.
 * Parameters use {{param}} syntax for runtime substitution.
 */

'use strict';

/**
 * Login flow patrol — navigates to login page, submits credentials, verifies dashboard.
 */
const loginFlow = {
    id: 'patrol-login-flow',
    name: 'Login Flow',
    schedule: '0 */4 * * *', // every 4 hours
    params: {
        baseUrl: 'https://example.com',
        username: 'test-user',
        password: 'test-pass',
    },
    steps: [
        {
            action: 'navigate',
            payload: { url: '{{baseUrl}}/login' },
            label: 'Navigate to login page',
            assertions: [
                { type: 'url-match', expected: { url: '/login' } },
                { type: 'no-console-errors', expected: {} },
            ],
        },
        {
            action: 'click',
            payload: { selector: '#username' },
            label: 'Focus username field',
        },
        {
            action: 'click',
            payload: { selector: '#password' },
            label: 'Focus password field',
        },
        {
            action: 'click',
            payload: { selector: 'button[type="submit"]' },
            label: 'Submit login form',
        },
        {
            action: 'wait',
            payload: { ms: 2000 },
            label: 'Wait for redirect',
        },
        {
            action: 'screenshot',
            payload: {},
            label: 'Capture post-login state',
            assertions: [
                { type: 'url-match', expected: { url: '/dashboard' } },
                { type: 'no-console-errors', expected: {} },
            ],
        },
    ],
};

/**
 * Basic navigation patrol — visits key pages and checks for errors.
 */
const basicNavigation = {
    id: 'patrol-basic-navigation',
    name: 'Basic Navigation',
    schedule: '0 */6 * * *', // every 6 hours
    params: {
        baseUrl: 'https://example.com',
    },
    steps: [
        {
            action: 'navigate',
            payload: { url: '{{baseUrl}}' },
            label: 'Navigate to homepage',
            assertions: [
                { type: 'url-match', expected: { url: '{{baseUrl}}' } },
                { type: 'no-console-errors', expected: {} },
            ],
        },
        {
            action: 'screenshot',
            payload: {},
            label: 'Screenshot homepage',
        },
        {
            action: 'navigate',
            payload: { url: '{{baseUrl}}/about' },
            label: 'Navigate to about page',
            assertions: [
                { type: 'no-console-errors', expected: {} },
            ],
        },
        {
            action: 'navigate',
            payload: { url: '{{baseUrl}}/contact' },
            label: 'Navigate to contact page',
            assertions: [
                { type: 'no-console-errors', expected: {} },
            ],
        },
    ],
};

/**
 * Form submission patrol — fills and submits a form, verifies success.
 */
const formSubmission = {
    id: 'patrol-form-submission',
    name: 'Form Submission',
    schedule: '0 */8 * * *', // every 8 hours
    params: {
        baseUrl: 'https://example.com',
        formUrl: '/contact',
        submitSelector: 'button[type="submit"]',
    },
    steps: [
        {
            action: 'navigate',
            payload: { url: '{{baseUrl}}{{formUrl}}' },
            label: 'Navigate to form page',
            assertions: [
                { type: 'no-console-errors', expected: {} },
            ],
        },
        {
            action: 'click',
            payload: { selector: 'input[name="name"]' },
            label: 'Click name field',
        },
        {
            action: 'click',
            payload: { selector: 'input[name="email"]' },
            label: 'Click email field',
        },
        {
            action: 'click',
            payload: { selector: 'textarea[name="message"]' },
            label: 'Click message field',
        },
        {
            action: 'click',
            payload: { selector: '{{submitSelector}}' },
            label: 'Submit form',
        },
        {
            action: 'wait',
            payload: { ms: 2000 },
            label: 'Wait for submission response',
        },
        {
            action: 'screenshot',
            payload: {},
            label: 'Capture post-submission state',
            assertions: [
                { type: 'no-console-errors', expected: {} },
            ],
        },
    ],
};

/**
 * Get all built-in patrol scripts.
 * @returns {object[]}
 */
function getBuiltinScripts() {
    return [loginFlow, basicNavigation, formSubmission];
}

/**
 * Get a built-in script by ID.
 * @param {string} id
 * @returns {object|undefined}
 */
function getScriptById(id) {
    return getBuiltinScripts().find(s => s.id === id);
}

module.exports = {
    loginFlow,
    basicNavigation,
    formSubmission,
    getBuiltinScripts,
    getScriptById,
};
