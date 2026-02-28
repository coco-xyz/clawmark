/**
 * ClawMark — Routing Resolver Tests
 *
 * Tests cover:
 * 1. GitHub URL auto-extraction
 * 2. URL pattern matching (glob-style)
 * 3. User rule resolution (priority, types, defaults)
 * 4. Fallback to system default
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveTarget, extractGitHubRepo, matchUrlPattern } = require('../server/routing');

// ==================================================================
// 1. GitHub URL extraction
// ==================================================================

describe('extractGitHubRepo', () => {
    it('extracts owner/repo from standard GitHub URL', () => {
        const result = extractGitHubRepo('https://github.com/coco-xyz/clawmark');
        assert.deepStrictEqual(result, { owner: 'coco-xyz', repo: 'clawmark' });
    });

    it('extracts from issue URL', () => {
        const result = extractGitHubRepo('https://github.com/coco-xyz/clawmark/issues/38');
        assert.deepStrictEqual(result, { owner: 'coco-xyz', repo: 'clawmark' });
    });

    it('extracts from PR URL', () => {
        const result = extractGitHubRepo('https://github.com/hxa-k/hxa-teams/pull/7');
        assert.deepStrictEqual(result, { owner: 'hxa-k', repo: 'hxa-teams' });
    });

    it('extracts from blob URL', () => {
        const result = extractGitHubRepo('https://github.com/hxa-k/hxa-teams/blob/main/docs/prd/team-marketplace.md');
        assert.deepStrictEqual(result, { owner: 'hxa-k', repo: 'hxa-teams' });
    });

    it('strips .git suffix', () => {
        const result = extractGitHubRepo('https://github.com/coco-xyz/clawmark.git');
        assert.deepStrictEqual(result, { owner: 'coco-xyz', repo: 'clawmark' });
    });

    it('returns null for non-GitHub URLs', () => {
        assert.strictEqual(extractGitHubRepo('https://docs.anthropic.com/en/docs/welcome'), null);
        assert.strictEqual(extractGitHubRepo('https://medium.com/@user/article'), null);
    });

    it('returns null for GitHub special paths', () => {
        assert.strictEqual(extractGitHubRepo('https://github.com/settings/profile'), null);
        assert.strictEqual(extractGitHubRepo('https://github.com/explore'), null);
        assert.strictEqual(extractGitHubRepo('https://github.com/marketplace/actions'), null);
    });

    it('returns null for null/empty input', () => {
        assert.strictEqual(extractGitHubRepo(null), null);
        assert.strictEqual(extractGitHubRepo(''), null);
        assert.strictEqual(extractGitHubRepo(undefined), null);
    });
});

// ==================================================================
// 2. URL pattern matching
// ==================================================================

describe('matchUrlPattern', () => {
    it('matches exact domain/path', () => {
        assert.ok(matchUrlPattern('https://github.com/coco-xyz/clawmark', 'github.com/coco-xyz/clawmark'));
    });

    it('matches with wildcard segment', () => {
        assert.ok(matchUrlPattern('https://github.com/hxa-k/hxa-teams', 'github.com/hxa-k/*'));
        assert.ok(matchUrlPattern('https://github.com/hxa-k/clawmark', 'github.com/hxa-k/*'));
    });

    it('matches with double wildcard', () => {
        assert.ok(matchUrlPattern('https://github.com/coco-xyz/clawmark/issues/38', 'github.com/coco-xyz/**'));
        assert.ok(matchUrlPattern('https://github.com/coco-xyz/clawmark/blob/main/README.md', 'github.com/coco-xyz/**'));
    });

    it('matches subdomain wildcard', () => {
        assert.ok(matchUrlPattern('https://jessie.coco.xyz/hub/', '*.coco.xyz/**'));
        assert.ok(matchUrlPattern('https://api.coco.xyz/clawmark', '*.coco.xyz/**'));
    });

    it('does not match different paths', () => {
        assert.ok(!matchUrlPattern('https://github.com/other-org/repo', 'github.com/coco-xyz/*'));
    });

    it('strips protocol before matching', () => {
        assert.ok(matchUrlPattern('https://example.com/path', 'http://example.com/path'));
        assert.ok(matchUrlPattern('http://example.com/path', 'example.com/path'));
    });

    it('returns false for null inputs', () => {
        assert.ok(!matchUrlPattern(null, 'github.com/*'));
        assert.ok(!matchUrlPattern('https://github.com', null));
    });
});

// ==================================================================
// 3. Routing resolution
// ==================================================================

describe('resolveTarget', () => {
    // Mock DB with user rules (sorted by priority DESC, like the real DB)
    function mockDb(rules) {
        return {
            getUserRules: (user_name) =>
                rules.filter(r => r.user_name === user_name)
                     .sort((a, b) => (b.priority || 0) - (a.priority || 0)),
        };
    }

    it('resolves GitHub URL auto-detect when no user rules exist', () => {
        const result = resolveTarget({
            source_url: 'https://github.com/hxa-k/hxa-teams/issues/5',
            user_name: 'Kevin',
            db: mockDb([]),
            defaultTarget: { repo: 'coco-xyz/clawmark', labels: ['clawmark'] },
        });

        assert.strictEqual(result.method, 'github_auto');
        assert.strictEqual(result.target_type, 'github-issue');
        assert.strictEqual(result.target_config.repo, 'hxa-k/hxa-teams');
    });

    it('user rule takes priority over GitHub auto-detect', () => {
        const result = resolveTarget({
            source_url: 'https://github.com/hxa-k/hxa-teams/issues/5',
            user_name: 'Kevin',
            db: mockDb([{
                user_name: 'Kevin',
                rule_type: 'url_pattern',
                pattern: 'github.com/hxa-k/**',
                target_type: 'github-issue',
                target_config: JSON.stringify({ repo: 'coco-xyz/clawmark', labels: ['from-hxa-k'] }),
                priority: 10,
                enabled: 1,
            }]),
            defaultTarget: { repo: 'coco-xyz/clawmark', labels: ['clawmark'] },
        });

        assert.strictEqual(result.method, 'user_rule');
        assert.strictEqual(result.target_config.repo, 'coco-xyz/clawmark');
        assert.deepStrictEqual(result.target_config.labels, ['from-hxa-k']);
    });

    it('disabled rules are skipped', () => {
        const result = resolveTarget({
            source_url: 'https://github.com/hxa-k/hxa-teams/issues/5',
            user_name: 'Kevin',
            db: mockDb([{
                user_name: 'Kevin',
                rule_type: 'url_pattern',
                pattern: 'github.com/hxa-k/**',
                target_type: 'github-issue',
                target_config: JSON.stringify({ repo: 'some/other' }),
                priority: 10,
                enabled: 0,  // disabled
            }]),
            defaultTarget: { repo: 'coco-xyz/clawmark', labels: ['clawmark'] },
        });

        // Should fall through to github_auto since rule is disabled
        assert.strictEqual(result.method, 'github_auto');
        assert.strictEqual(result.target_config.repo, 'hxa-k/hxa-teams');
    });

    it('higher priority user rule wins', () => {
        const result = resolveTarget({
            source_url: 'https://medium.com/@user/article-123',
            user_name: 'Kevin',
            db: mockDb([
                {
                    user_name: 'Kevin', rule_type: 'url_pattern',
                    pattern: 'medium.com/**', target_type: 'github-issue',
                    target_config: JSON.stringify({ repo: 'low-priority/repo' }),
                    priority: 1, enabled: 1,
                },
                {
                    user_name: 'Kevin', rule_type: 'url_pattern',
                    pattern: 'medium.com/@user/**', target_type: 'github-issue',
                    target_config: JSON.stringify({ repo: 'high-priority/repo' }),
                    priority: 10, enabled: 1,
                },
            ]),
            defaultTarget: { repo: 'coco-xyz/clawmark' },
        });

        // DB returns sorted by priority DESC, so high-priority rule matches first
        assert.strictEqual(result.method, 'user_rule');
        assert.strictEqual(result.target_config.repo, 'high-priority/repo');
    });

    it('user default rule used when no pattern matches non-GitHub URL', () => {
        const result = resolveTarget({
            source_url: 'https://some-random-site.com/page',
            user_name: 'Kevin',
            db: mockDb([{
                user_name: 'Kevin', rule_type: 'default',
                pattern: null, target_type: 'github-issue',
                target_config: JSON.stringify({ repo: 'kevin/notes' }),
                priority: 0, enabled: 1,
            }]),
            defaultTarget: { repo: 'coco-xyz/clawmark' },
        });

        assert.strictEqual(result.method, 'user_default');
        assert.strictEqual(result.target_config.repo, 'kevin/notes');
    });

    it('falls back to system default when no rules and non-GitHub URL', () => {
        const result = resolveTarget({
            source_url: 'https://docs.anthropic.com/en/docs/welcome',
            user_name: 'Kevin',
            db: mockDb([]),
            defaultTarget: { repo: 'coco-xyz/clawmark', labels: ['clawmark'] },
        });

        assert.strictEqual(result.method, 'system_default');
        assert.strictEqual(result.target_config.repo, 'coco-xyz/clawmark');
    });

    it('works without DB (no user rules checked)', () => {
        const result = resolveTarget({
            source_url: 'https://github.com/coco-xyz/clawmark/issues/1',
            user_name: 'Kevin',
            db: null,
            defaultTarget: { repo: 'coco-xyz/clawmark' },
        });

        assert.strictEqual(result.method, 'github_auto');
        assert.strictEqual(result.target_config.repo, 'coco-xyz/clawmark');
    });

    it('content_type rule matches item type', () => {
        const result = resolveTarget({
            source_url: 'https://some-site.com/page',
            user_name: 'Kevin',
            type: 'issue',
            db: mockDb([{
                user_name: 'Kevin', rule_type: 'content_type',
                pattern: 'issue', target_type: 'github-issue',
                target_config: JSON.stringify({ repo: 'kevin/bugs' }),
                priority: 5, enabled: 1,
            }]),
            defaultTarget: { repo: 'coco-xyz/clawmark' },
        });

        assert.strictEqual(result.method, 'user_rule');
        assert.strictEqual(result.target_config.repo, 'kevin/bugs');
    });

    it('rules from other users are not applied', () => {
        const result = resolveTarget({
            source_url: 'https://medium.com/@user/article',
            user_name: 'Jessie',
            db: mockDb([{
                user_name: 'Kevin', rule_type: 'url_pattern',
                pattern: 'medium.com/**', target_type: 'github-issue',
                target_config: JSON.stringify({ repo: 'kevin/notes' }),
                priority: 10, enabled: 1,
            }]),
            defaultTarget: { repo: 'coco-xyz/clawmark' },
        });

        // Kevin's rule should NOT match for Jessie
        assert.strictEqual(result.method, 'system_default');
    });
});
