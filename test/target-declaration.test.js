/**
 * ClawMark — Target Declaration Tests
 *
 * Tests cover:
 * 1. Declaration validation (schema, adapter normalization, config extraction)
 * 2. SSRF prevention (isPrivateIP, isSafeUrl, webhook endpoint validation)
 * 3. Cache behavior (positive cache, negative cache, TTL expiry, size limit)
 * 4. Integration with routing (declaration priority)
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
    validateDeclaration, isPrivateIP, isSafeUrl,
    _cache, _setCache, CACHE_TTL, NEGATIVE_CACHE_TTL, CACHE_MAX_SIZE, MAX_REDIRECTS,
} = require('../server/target-declaration');
const { resolveTarget } = require('../server/routing');

// ==================================================================
// 1. Declaration validation
// ==================================================================

describe('validateDeclaration', () => {
    it('validates github-issues adapter with target', () => {
        const result = validateDeclaration({
            adapter: 'github-issues',
            target: 'coco-xyz/clawmark',
            labels: ['feedback', 'clawmark'],
        });
        assert.ok(result);
        assert.equal(result.target_type, 'github-issue'); // normalized
        assert.equal(result.target_config.repo, 'coco-xyz/clawmark');
        assert.deepStrictEqual(result.target_config.labels, ['feedback', 'clawmark']);
        assert.deepStrictEqual(result.target_config.assignees, []);
    });

    it('validates github-issue adapter (singular form)', () => {
        const result = validateDeclaration({
            adapter: 'github-issue',
            target: 'owner/repo',
        });
        assert.ok(result);
        assert.equal(result.target_type, 'github-issue');
        assert.equal(result.target_config.repo, 'owner/repo');
    });

    it('validates webhook adapter with HTTPS endpoint', () => {
        const result = validateDeclaration({
            adapter: 'webhook',
            endpoint: 'https://api.example.com/feedback',
            types: ['issue', 'comment'],
        });
        assert.ok(result);
        assert.equal(result.target_type, 'webhook');
        assert.equal(result.target_config.url, 'https://api.example.com/feedback');
        assert.equal(result.target_config.method, 'POST');
        assert.deepStrictEqual(result.target_config.types, ['issue', 'comment']);
    });

    it('rejects webhook with HTTP endpoint (SSRF prevention)', () => {
        assert.equal(validateDeclaration({
            adapter: 'webhook',
            endpoint: 'http://api.example.com/feedback',
        }), null);
    });

    it('rejects webhook with localhost endpoint (SSRF prevention)', () => {
        assert.equal(validateDeclaration({
            adapter: 'webhook',
            endpoint: 'https://localhost/hook',
        }), null);
        assert.equal(validateDeclaration({
            adapter: 'webhook',
            endpoint: 'https://127.0.0.1/hook',
        }), null);
        assert.equal(validateDeclaration({
            adapter: 'webhook',
            endpoint: 'https://0.0.0.0/hook',
        }), null);
        assert.equal(validateDeclaration({
            adapter: 'webhook',
            endpoint: 'https://[::1]/hook',
        }), null);
    });

    it('defaults labels to ["clawmark"] for github-issue', () => {
        const result = validateDeclaration({
            adapter: 'github-issues',
            target: 'owner/repo',
        });
        assert.deepStrictEqual(result.target_config.labels, ['clawmark']);
    });

    it('rejects missing adapter', () => {
        assert.equal(validateDeclaration({ target: 'owner/repo' }), null);
    });

    it('rejects non-string adapter', () => {
        assert.equal(validateDeclaration({ adapter: 123, target: 'owner/repo' }), null);
    });

    it('rejects unknown adapter', () => {
        assert.equal(validateDeclaration({ adapter: 'ftp', target: 'x/y' }), null);
    });

    it('rejects github-issue without target', () => {
        assert.equal(validateDeclaration({ adapter: 'github-issues' }), null);
    });

    it('rejects github-issue with invalid target format', () => {
        assert.equal(validateDeclaration({ adapter: 'github-issues', target: 'no-slash' }), null);
        assert.equal(validateDeclaration({ adapter: 'github-issues', target: 'a/b/c' }), null);
    });

    it('rejects webhook without endpoint', () => {
        assert.equal(validateDeclaration({ adapter: 'webhook' }), null);
    });

    it('rejects webhook with invalid URL', () => {
        assert.equal(validateDeclaration({ adapter: 'webhook', endpoint: 'not-a-url' }), null);
    });

    it('rejects null/undefined/array input', () => {
        assert.equal(validateDeclaration(null), null);
        assert.equal(validateDeclaration(undefined), null);
        assert.equal(validateDeclaration('string'), null);
        assert.equal(validateDeclaration([1, 2]), null);
    });

    it('truncates labels array to 10 items', () => {
        const labels = Array.from({ length: 15 }, (_, i) => `label-${i}`);
        const result = validateDeclaration({
            adapter: 'github-issues',
            target: 'owner/repo',
            labels,
        });
        assert.equal(result.target_config.labels.length, 10);
    });

    it('filters non-string labels', () => {
        const result = validateDeclaration({
            adapter: 'github-issues',
            target: 'owner/repo',
            labels: ['valid', 123, null, 'also-valid'],
        });
        assert.deepStrictEqual(result.target_config.labels, ['valid', 'also-valid']);
    });

    it('handles case-insensitive adapter names', () => {
        const result = validateDeclaration({
            adapter: 'GitHub-Issues',
            target: 'owner/repo',
        });
        assert.ok(result);
        assert.equal(result.target_type, 'github-issue');
    });

    it('validates lark adapter with safe fields only', () => {
        const result = validateDeclaration({
            adapter: 'lark',
            webhook_url: 'https://open.larksuite.com/hook/xxx',
            evil_field: 'should-not-copy',
        });
        assert.ok(result);
        assert.equal(result.target_type, 'lark');
        assert.equal(result.target_config.webhook_url, 'https://open.larksuite.com/hook/xxx');
        assert.equal(result.target_config.evil_field, undefined);
    });

    it('validates telegram adapter with safe fields only', () => {
        const result = validateDeclaration({
            adapter: 'telegram',
            chat_id: '-1001234567890',
            dangerous_field: 'should-not-copy',
        });
        assert.ok(result);
        assert.equal(result.target_type, 'telegram');
        assert.equal(result.target_config.chat_id, '-1001234567890');
        assert.equal(result.target_config.dangerous_field, undefined);
    });
});

// ==================================================================
// 1b. js_injection field (#86)
// ==================================================================

describe('validateDeclaration js_injection field', () => {
    it('defaults js_injection to true when not specified', () => {
        const result = validateDeclaration({
            adapter: 'github-issue',
            target: 'owner/repo',
        });
        assert.ok(result);
        assert.equal(result.js_injection, true);
    });

    it('sets js_injection to false when explicitly false', () => {
        const result = validateDeclaration({
            adapter: 'github-issue',
            target: 'owner/repo',
            js_injection: false,
        });
        assert.ok(result);
        assert.equal(result.js_injection, false);
    });

    it('sets js_injection to false when string "false"', () => {
        // YAML FAILSAFE_SCHEMA returns all scalars as strings
        const result = validateDeclaration({
            adapter: 'github-issue',
            target: 'owner/repo',
            js_injection: 'false',
        });
        assert.ok(result);
        assert.equal(result.js_injection, false);
    });

    it('keeps js_injection true when explicitly true', () => {
        const result = validateDeclaration({
            adapter: 'github-issue',
            target: 'owner/repo',
            js_injection: true,
        });
        assert.ok(result);
        assert.equal(result.js_injection, true);
    });

    it('keeps js_injection true for non-boolean values', () => {
        const result = validateDeclaration({
            adapter: 'github-issue',
            target: 'owner/repo',
            js_injection: 'yes',
        });
        assert.ok(result);
        assert.equal(result.js_injection, true);
    });

    it('works with webhook adapter', () => {
        const result = validateDeclaration({
            adapter: 'webhook',
            endpoint: 'https://example.com/hook',
            js_injection: false,
        });
        assert.ok(result);
        assert.equal(result.js_injection, false);
        assert.equal(result.target_config.url, 'https://example.com/hook');
    });

    it('works with telegram adapter', () => {
        const result = validateDeclaration({
            adapter: 'telegram',
            chat_id: '-100123',
            js_injection: false,
        });
        assert.ok(result);
        assert.equal(result.js_injection, false);
    });

    it('returns null for invalid declaration regardless of js_injection', () => {
        const result = validateDeclaration({
            js_injection: false,
            // missing adapter
        });
        assert.equal(result, null);
    });
});

// ==================================================================
// 2. SSRF prevention
// ==================================================================

describe('isPrivateIP', () => {
    it('detects IPv4 loopback', () => {
        assert.equal(isPrivateIP('127.0.0.1'), true);
        assert.equal(isPrivateIP('127.0.0.2'), true);
        assert.equal(isPrivateIP('127.255.255.255'), true);
    });

    it('detects Class A private (10.x)', () => {
        assert.equal(isPrivateIP('10.0.0.1'), true);
        assert.equal(isPrivateIP('10.255.255.255'), true);
    });

    it('detects Class B private (172.16-31.x)', () => {
        assert.equal(isPrivateIP('172.16.0.1'), true);
        assert.equal(isPrivateIP('172.31.255.255'), true);
        assert.equal(isPrivateIP('172.15.0.1'), false);
        assert.equal(isPrivateIP('172.32.0.1'), false);
    });

    it('detects Class C private (192.168.x)', () => {
        assert.equal(isPrivateIP('192.168.0.1'), true);
        assert.equal(isPrivateIP('192.168.255.255'), true);
    });

    it('detects link-local / cloud metadata (169.254.x)', () => {
        assert.equal(isPrivateIP('169.254.169.254'), true);
        assert.equal(isPrivateIP('169.254.0.1'), true);
    });

    it('detects 0.0.0.0', () => {
        assert.equal(isPrivateIP('0.0.0.0'), true);
    });

    it('detects IPv6 loopback', () => {
        assert.equal(isPrivateIP('::1'), true);
    });

    it('detects IPv6 link-local', () => {
        assert.equal(isPrivateIP('fe80::1'), true);
    });

    it('detects IPv6 unique local', () => {
        assert.equal(isPrivateIP('fc00::1'), true);
        assert.equal(isPrivateIP('fd12::1'), true);
    });

    it('allows public IPs', () => {
        assert.equal(isPrivateIP('8.8.8.8'), false);
        assert.equal(isPrivateIP('1.1.1.1'), false);
        assert.equal(isPrivateIP('185.199.108.153'), false);
    });

    it('rejects null/empty', () => {
        assert.equal(isPrivateIP(null), true);
        assert.equal(isPrivateIP(''), true);
    });
});

describe('isSafeUrl', () => {
    it('rejects HTTP URLs', async () => {
        assert.equal(await isSafeUrl('http://example.com'), false);
    });

    it('allows HTTPS URLs with trusted hosts', async () => {
        assert.equal(await isSafeUrl('https://raw.githubusercontent.com/owner/repo/main/file'), true);
    });

    it('rejects non-URL strings', async () => {
        assert.equal(await isSafeUrl('not-a-url'), false);
    });
});

describe('fetchUrl security', () => {
    it('has max redirects limit of 3', () => {
        assert.equal(MAX_REDIRECTS, 3);
    });
});

// ==================================================================
// 3. Cache behavior
// ==================================================================

describe('cache', () => {
    beforeEach(() => {
        _cache.clear();
    });

    it('stores and retrieves positive cache entries', () => {
        const value = { target_type: 'github-issue', target_config: { repo: 'a/b' } };
        _setCache('test-key', value, false);
        const entry = _cache.get('test-key');
        assert.ok(entry);
        assert.deepStrictEqual(entry.value, value);
    });

    it('stores negative cache entries', () => {
        _setCache('miss-key', null, true);
        const entry = _cache.get('miss-key');
        assert.ok(entry);
        assert.equal(entry.value, null);
        assert.equal(entry.negative, true);
    });

    it('positive cache TTL is 5 minutes', () => {
        assert.equal(CACHE_TTL, 5 * 60 * 1000);
    });

    it('negative cache TTL is 2 minutes', () => {
        assert.equal(NEGATIVE_CACHE_TTL, 2 * 60 * 1000);
    });

    it('cache max size is 1000', () => {
        assert.equal(CACHE_MAX_SIZE, 1000);
    });

    it('evicts oldest entry when full', () => {
        for (let i = 0; i < CACHE_MAX_SIZE; i++) {
            _cache.set(`key-${i}`, { value: null, timestamp: Date.now(), negative: true });
        }
        assert.equal(_cache.size, CACHE_MAX_SIZE);
        _setCache('new-key', null, true);
        assert.equal(_cache.size, CACHE_MAX_SIZE);
        assert.equal(_cache.has('key-0'), false);
        assert.equal(_cache.has('new-key'), true);
    });
});

// ==================================================================
// 3. Routing integration — declaration priority
// ==================================================================

describe('resolveTarget with declaration', () => {
    const mockDb = {
        getUserRules: () => [{
            id: 1, user_name: 'alice', rule_type: 'url_pattern',
            pattern: '*github.com/coco-xyz/*', target_type: 'webhook',
            target_config: '{"url":"https://hook.example.com"}',
            priority: 10, enabled: 1,
        }],
    };

    const defaultTarget = { repo: 'coco-xyz/clawmark', labels: ['clawmark'], assignees: [] };

    it('declaration takes priority over user rules', () => {
        const declaration = {
            target_type: 'github-issue',
            target_config: { repo: 'coco-xyz/feedback', labels: ['declared'] },
        };
        const result = resolveTarget({
            source_url: 'https://github.com/coco-xyz/clawmark',
            user_name: 'alice',
            db: mockDb,
            defaultTarget,
            declaration,
        });
        assert.equal(result.method, 'target_declaration');
        assert.equal(result.target_config.repo, 'coco-xyz/feedback');
        assert.deepStrictEqual(result.target_config.labels, ['declared']);
    });

    it('declaration takes priority over github auto-detect', () => {
        const declaration = {
            target_type: 'webhook',
            target_config: { url: 'https://api.example.com/hook' },
        };
        const result = resolveTarget({
            source_url: 'https://github.com/some-org/some-repo',
            user_name: 'bob',
            db: { getUserRules: () => [] },
            defaultTarget,
            declaration,
        });
        assert.equal(result.method, 'target_declaration');
        assert.equal(result.target_type, 'webhook');
    });

    it('falls through to user rules when no declaration', () => {
        const result = resolveTarget({
            source_url: 'https://github.com/coco-xyz/clawmark',
            user_name: 'alice',
            db: mockDb,
            defaultTarget,
            declaration: null,
        });
        assert.equal(result.method, 'user_rule');
        assert.equal(result.target_type, 'webhook');
    });

    it('falls through when declaration is undefined', () => {
        const result = resolveTarget({
            source_url: 'https://github.com/coco-xyz/clawmark',
            user_name: 'alice',
            db: mockDb,
            defaultTarget,
        });
        assert.equal(result.method, 'user_rule');
    });

    it('falls through when declaration has no target_type', () => {
        const result = resolveTarget({
            source_url: 'https://github.com/coco-xyz/clawmark',
            user_name: 'alice',
            db: mockDb,
            defaultTarget,
            declaration: { target_config: { repo: 'a/b' } },
        });
        assert.equal(result.method, 'user_rule');
    });

    it('falls through when declaration has no target_config', () => {
        const result = resolveTarget({
            source_url: 'https://github.com/coco-xyz/clawmark',
            user_name: 'alice',
            db: mockDb,
            defaultTarget,
            declaration: { target_type: 'github-issue' },
        });
        assert.equal(result.method, 'user_rule');
    });

    it('5-level priority chain: declaration > user_rule > github_auto > user_default > system_default', () => {
        // Level 1: declaration
        const r1 = resolveTarget({
            source_url: 'https://github.com/org/repo',
            user_name: 'alice', db: mockDb, defaultTarget,
            declaration: { target_type: 'lark', target_config: { webhook: 'x' } },
        });
        assert.equal(r1.method, 'target_declaration');

        // Level 2: user rule (no declaration)
        const r2 = resolveTarget({
            source_url: 'https://github.com/coco-xyz/something',
            user_name: 'alice', db: mockDb, defaultTarget,
        });
        assert.equal(r2.method, 'user_rule');

        // Level 3: github auto (no declaration, no matching user rule)
        const r3 = resolveTarget({
            source_url: 'https://github.com/other-org/other-repo',
            user_name: 'nobody', db: { getUserRules: () => [] }, defaultTarget,
        });
        assert.equal(r3.method, 'github_auto');

        // Level 4: user default (no declaration, no URL match, not github)
        const r4 = resolveTarget({
            source_url: 'https://example.com/page',
            user_name: 'defaulter',
            db: { getUserRules: () => [{
                id: 99, rule_type: 'default', target_type: 'webhook',
                target_config: '{"url":"https://default.example.com"}',
                enabled: 1,
            }] },
            defaultTarget,
        });
        assert.equal(r4.method, 'user_default');

        // Level 5: system default (nothing matches)
        const r5 = resolveTarget({
            source_url: 'https://example.com/page',
            user_name: 'nobody', db: { getUserRules: () => [] }, defaultTarget,
        });
        assert.equal(r5.method, 'system_default');
    });
});
