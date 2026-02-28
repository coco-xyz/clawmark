/**
 * ClawMark — Routing Resolver (Phase 1)
 *
 * Determines where an annotation should be delivered based on:
 *   1. User-defined routing rules (URL pattern → target)
 *   2. GitHub URL auto-detection (extract org/repo from source_url)
 *   3. Fallback to default channel from config
 *
 * Resolution priority (highest first):
 *   1. Exact user rule match (highest priority value wins)
 *   2. GitHub URL auto-extract
 *   3. User's personal default rule (rule_type = 'default')
 *   4. System default (from config.distribution)
 */

'use strict';

/**
 * Extract GitHub owner/repo from a URL.
 * Handles: github.com/owner/repo, github.com/owner/repo/issues/123, etc.
 *
 * @param {string} url
 * @returns {{ owner: string, repo: string }|null}
 */
function extractGitHubRepo(url) {
    if (!url) return null;
    const m = url.match(/github\.com\/([^/?#]+)\/([^/?#]+)/);
    if (!m) return null;
    const owner = m[1];
    const repo = m[2].replace(/\.git$/, '');
    // Skip GitHub special paths
    if (['settings', 'orgs', 'marketplace', 'explore', 'topics', 'trending',
         'collections', 'events', 'sponsors', 'notifications', 'new', 'login',
         'signup', 'features', 'security', 'pricing', 'enterprise'].includes(owner)) {
        return null;
    }
    return { owner, repo };
}

/**
 * Test if a URL matches a glob-like pattern.
 * Supports: * (any chars), ** (same as *), ? (single char), exact match.
 *
 * @param {string} url     The URL to test (with or without protocol)
 * @param {string} pattern The pattern to match against
 * @returns {boolean}
 */
function matchUrlPattern(url, pattern) {
    if (!url || !pattern) return false;

    // Normalize: strip protocol from both
    const normalize = (s) => s.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const normalUrl = normalize(url);
    const normalPattern = normalize(pattern);

    // Convert glob to regex
    // Note: both * and ** match any characters including /
    // This is intentional — users expect *github.com* to match full URLs.
    const regexStr = normalPattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape regex chars (except * and ?)
        .replace(/\*+/g, '.*')                   // * or ** = any chars including /
        .replace(/\?/g, '.');                     // ? = single char

    try {
        return new RegExp(`^${regexStr}$`, 'i').test(normalUrl);
    } catch {
        return false;
    }
}

/**
 * Resolve routing target for an item.
 *
 * @param {object} params
 * @param {string} params.source_url     The URL being annotated
 * @param {string} params.user_name      The user creating the annotation
 * @param {string} [params.type]         Item type (comment, issue)
 * @param {string} [params.priority]     Item priority
 * @param {Array}  [params.tags]         Item tags
 * @param {object} params.db             ClawMark DB API (with getUserRules)
 * @param {object} params.defaultTarget  Default target from config { repo, token, labels }
 * @returns {{ target_type: string, target_config: object, matched_rule: object|null, method: string }}
 */
function resolveTarget({ source_url, user_name, type, priority, tags, db, defaultTarget }) {
    // Fetch user rules once (used in steps 1 and 3)
    const userRules = (db && user_name) ? db.getUserRules(user_name) : [];

    // Step 1: Check user-defined rules (ordered by priority DESC)
    for (const rule of userRules) {
        if (!rule.enabled) continue;

        if (rule.rule_type === 'url_pattern' && rule.pattern) {
            if (matchUrlPattern(source_url, rule.pattern)) {
                const config = JSON.parse(rule.target_config);
                return {
                    target_type: rule.target_type,
                    target_config: config,
                    matched_rule: rule,
                    method: 'user_rule',
                };
            }
        }

        if (rule.rule_type === 'content_type' && rule.pattern) {
            if (type && rule.pattern === type) {
                const config = JSON.parse(rule.target_config);
                return {
                    target_type: rule.target_type,
                    target_config: config,
                    matched_rule: rule,
                    method: 'user_rule',
                };
            }
        }

        if (rule.rule_type === 'tag_match' && rule.pattern) {
            if (tags && Array.isArray(tags) && tags.includes(rule.pattern)) {
                const config = JSON.parse(rule.target_config);
                return {
                    target_type: rule.target_type,
                    target_config: config,
                    matched_rule: rule,
                    method: 'user_rule',
                };
            }
        }
    }

    // Step 2: GitHub URL auto-detection
    const ghRepo = extractGitHubRepo(source_url);
    if (ghRepo) {
        return {
            target_type: 'github-issue',
            target_config: {
                repo: `${ghRepo.owner}/${ghRepo.repo}`,
                labels: ['clawmark'],
                assignees: [],
            },
            matched_rule: null,
            method: 'github_auto',
        };
    }

    // Step 3: User's personal default rule
    const defaultRule = userRules.find(r => r.rule_type === 'default' && r.enabled);
    if (defaultRule) {
        const config = JSON.parse(defaultRule.target_config);
        return {
            target_type: defaultRule.target_type,
            target_config: config,
            matched_rule: defaultRule,
            method: 'user_default',
        };
    }

    // Step 4: System default
    return {
        target_type: 'github-issue',
        target_config: defaultTarget || { repo: 'coco-xyz/clawmark', labels: ['clawmark'], assignees: [] },
        matched_rule: null,
        method: 'system_default',
    };
}

module.exports = { resolveTarget, extractGitHubRepo, matchUrlPattern };
