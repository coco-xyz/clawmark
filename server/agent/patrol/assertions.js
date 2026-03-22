/**
 * ClawMark — Patrol Assertion Engine (#79)
 *
 * Evaluates assertions against action results to verify expected state.
 * Supports: element exists, text match, URL match, no console errors,
 * custom JS expression evaluation.
 */

'use strict';

/**
 * Assertion types and their evaluation logic.
 * Each returns { pass: boolean, actual: any, message: string }
 */
const ASSERTION_TYPES = {
    /**
     * Assert an element exists on the page.
     * Expected: { selector: string }
     * Context: { dom: string } (HTML or element list from action result)
     */
    'element-exists': (expected, context) => {
        const selector = expected.selector;
        if (!selector) {
            return { pass: false, actual: null, message: 'Missing selector in assertion' };
        }
        // Context should contain elements or dom info from a prior action result
        const found = context.elements?.includes(selector) ||
                      context.dom?.includes(selector) ||
                      context.result?.found === true;
        return {
            pass: !!found,
            actual: found ? 'found' : 'not found',
            message: found
                ? `Element "${selector}" exists`
                : `Element "${selector}" not found on page`,
        };
    },

    /**
     * Assert text content matches.
     * Expected: { text: string, exact?: boolean }
     * Context: { text: string } (page text or element text from action result)
     */
    'text-match': (expected, context) => {
        const needle = expected.text;
        if (!needle) {
            return { pass: false, actual: null, message: 'Missing text in assertion' };
        }
        const haystack = context.text || context.result?.text || '';
        const pass = expected.exact
            ? haystack === needle
            : haystack.includes(needle);
        return {
            pass,
            actual: haystack.slice(0, 200),
            message: pass
                ? `Text "${needle}" found`
                : `Text "${needle}" not found in content`,
        };
    },

    /**
     * Assert current URL matches.
     * Expected: { url: string, exact?: boolean }
     * Context: { url: string }
     */
    'url-match': (expected, context) => {
        const expectedUrl = expected.url;
        if (!expectedUrl) {
            return { pass: false, actual: null, message: 'Missing url in assertion' };
        }
        const actualUrl = context.url || context.result?.url || '';
        const pass = expected.exact
            ? actualUrl === expectedUrl
            : actualUrl.includes(expectedUrl);
        return {
            pass,
            actual: actualUrl,
            message: pass
                ? `URL matches "${expectedUrl}"`
                : `URL mismatch: expected "${expectedUrl}", got "${actualUrl}"`,
        };
    },

    /**
     * Assert no console errors occurred.
     * Expected: {} (no params needed)
     * Context: { consoleErrors: string[] }
     */
    'no-console-errors': (_expected, context) => {
        const errors = context.consoleErrors || [];
        return {
            pass: errors.length === 0,
            actual: errors.length === 0 ? 'no errors' : errors.slice(0, 5),
            message: errors.length === 0
                ? 'No console errors'
                : `${errors.length} console error(s): ${errors[0]?.slice(0, 100)}`,
        };
    },

    /**
     * Assert a value from action result matches expected.
     * Expected: { path: string, value: any }
     * Context: { result: object }
     */
    'result-match': (expected, context) => {
        const { path, value } = expected;
        if (!path) {
            return { pass: false, actual: null, message: 'Missing path in assertion' };
        }
        const actual = resolvePath(context.result || {}, path);
        const pass = JSON.stringify(actual) === JSON.stringify(value);
        return {
            pass,
            actual,
            message: pass
                ? `result.${path} matches expected`
                : `result.${path}: expected ${JSON.stringify(value)}, got ${JSON.stringify(actual)}`,
        };
    },
};

/**
 * Resolve a dot-separated path on an object.
 * @param {object} obj
 * @param {string} path  e.g. "data.title"
 * @returns {any}
 */
function resolvePath(obj, path) {
    return path.split('.').reduce((o, k) => (o != null ? o[k] : undefined), obj);
}

/**
 * Evaluate a single assertion.
 *
 * @param {object} assertion  { type: string, expected: object }
 * @param {object} context    Runtime context (action result, page state)
 * @returns {{ type: string, pass: boolean, actual: any, message: string }}
 */
function evaluate(assertion, context) {
    const handler = ASSERTION_TYPES[assertion.type];
    if (!handler) {
        return {
            type: assertion.type,
            pass: false,
            actual: null,
            message: `Unknown assertion type: ${assertion.type}`,
        };
    }

    try {
        const result = handler(assertion.expected || {}, context || {});
        return { type: assertion.type, ...result };
    } catch (err) {
        return {
            type: assertion.type,
            pass: false,
            actual: null,
            message: `Assertion error: ${err.message}`,
        };
    }
}

/**
 * Evaluate multiple assertions. Returns all results.
 *
 * @param {object[]} assertions  Array of { type, expected }
 * @param {object}   context     Runtime context
 * @returns {{ results: Array, allPassed: boolean, failCount: number }}
 */
function evaluateAll(assertions, context) {
    const results = assertions.map(a => evaluate(a, context));
    const failCount = results.filter(r => !r.pass).length;
    return {
        results,
        allPassed: failCount === 0,
        failCount,
    };
}

module.exports = {
    evaluate,
    evaluateAll,
    ASSERTION_TYPES,
};
