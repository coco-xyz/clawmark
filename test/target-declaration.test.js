/**
 * ClawMark — Target Declaration Tests
 *
 * Tests cover:
 * 1. Declaration validation (schema, adapter normalization, config extraction)
 * 2. Cache behavior (positive cache, negative cache, TTL expiry)
 * 3. Integration with routing (declaration priority)
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { validateDeclaration, _cache, CACHE_TTL, NEGATIVE_CACHE_TTL } = require('../server/target-declaration');
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

    it('validates webhook adapter with endpoint', () => {
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

    it('rejects null/undefined input', () => {
        assert.equal(validateDeclaration(null), null);
        assert.equal(validateDeclaration(undefined), null);
        assert.equal(validateDeclaration('string'), null);
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

    it('validates lark adapter', () => {
        const result = validateDeclaration({
            adapter: 'lark',
            webhook_url: 'https://open.larksuite.com/hook/xxx',
        });
        assert.ok(result);
        assert.equal(result.target_type, 'lark');
    });

    it('validates telegram adapter', () => {
        const result = validateDeclaration({
            adapter: 'telegram',
            chat_id: '-1001234567890',
        });
        assert.ok(result);
        assert.equal(result.target_type, 'telegram');
    });
});

// ==================================================================
// 2. Cache behavior
// ==================================================================

describe('cache', () => {
    beforeEach(() => {
        _cache.clear();
    });

    it('stores and retrieves positive cache entries', () => {
        const value = { target_type: 'github-issue', target_config: { repo: 'a/b' } };
        _cache.set('test-key', { value, timestamp: Date.now(), negative: false });
        const entry = _cache.get('test-key');
        assert.ok(entry);
        assert.deepStrictEqual(entry.value, value);
    });

    it('stores negative cache entries', () => {
        _cache.set('miss-key', { value: null, timestamp: Date.now(), negative: true });
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
