/**
 * ClawMark — Target Declaration Discovery
 *
 * Fetches and caches target declarations from:
 *   1. .clawmark.yml — GitHub repo root (via raw.githubusercontent.com)
 *   2. /.well-known/clawmark.json — any website's origin
 *
 * Declarations let project owners specify how annotations should be routed
 * without end-users needing to configure rules manually.
 */

'use strict';

const https = require('https');
const http = require('http');
const yaml = require('js-yaml');

// ── Cache ──
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const NEGATIVE_CACHE_TTL = 2 * 60 * 1000; // 2 minutes for "not found"
const FETCH_TIMEOUT = 5000; // 5 seconds

// Valid adapter types
const VALID_ADAPTERS = ['github-issue', 'github-issues', 'webhook', 'lark', 'telegram', 'email'];

/**
 * Fetch URL with timeout and size limit. Returns body string or null.
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.timeout]
 * @param {number} [options.maxSize]
 * @returns {Promise<string|null>}
 */
function fetchUrl(url, { timeout = FETCH_TIMEOUT, maxSize = 64 * 1024 } = {}) {
    return new Promise((resolve) => {
        try {
            const parsed = new URL(url);
            const mod = parsed.protocol === 'https:' ? https : http;
            const req = mod.get(url, { timeout }, (res) => {
                if (res.statusCode === 301 || res.statusCode === 302) {
                    const location = res.headers.location;
                    res.resume();
                    if (location) {
                        fetchUrl(location, { timeout, maxSize }).then(resolve);
                    } else {
                        resolve(null);
                    }
                    return;
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    resolve(null);
                    return;
                }
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                    if (data.length > maxSize) {
                        res.destroy();
                        resolve(null);
                    }
                });
                res.on('end', () => resolve(data));
                res.on('error', () => resolve(null));
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
        } catch {
            resolve(null);
        }
    });
}

/**
 * Get cached value if still valid.
 * @param {string} key
 * @returns {object|undefined}  { value, negative } or undefined if expired/missing
 */
function getCached(key) {
    const entry = cache.get(key);
    if (!entry) return undefined;
    const ttl = entry.negative ? NEGATIVE_CACHE_TTL : CACHE_TTL;
    if (Date.now() - entry.timestamp > ttl) {
        cache.delete(key);
        return undefined;
    }
    return entry;
}

/**
 * Validate and normalize a declaration object.
 * Returns normalized config or null if invalid.
 *
 * @param {object} raw
 * @returns {{ adapter: string, target_type: string, target_config: object }|null}
 */
function validateDeclaration(raw) {
    if (!raw || typeof raw !== 'object') return null;

    let adapter = raw.adapter;
    if (typeof adapter !== 'string') return null;
    adapter = adapter.trim().toLowerCase();

    // Normalize adapter aliases
    if (adapter === 'github-issues') adapter = 'github-issue';
    if (!VALID_ADAPTERS.includes(adapter) && adapter !== 'github-issue') return null;

    const config = {};

    if (adapter === 'github-issue') {
        const target = raw.target;
        if (!target || typeof target !== 'string') return null;
        // Validate owner/repo format
        if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(target)) return null;
        config.repo = target;
        config.labels = Array.isArray(raw.labels) ? raw.labels.filter(l => typeof l === 'string').slice(0, 10) : ['clawmark'];
        config.assignees = Array.isArray(raw.assignees) ? raw.assignees.filter(a => typeof a === 'string').slice(0, 5) : [];
    } else if (adapter === 'webhook') {
        const endpoint = raw.endpoint;
        if (!endpoint || typeof endpoint !== 'string') return null;
        try { new URL(endpoint); } catch { return null; }
        config.url = endpoint;
        config.method = 'POST';
    } else {
        // Other adapters: pass through raw config
        Object.assign(config, raw);
        delete config.adapter;
    }

    // Optional: accepted annotation types
    if (Array.isArray(raw.types)) {
        config.types = raw.types.filter(t => typeof t === 'string').slice(0, 10);
    }

    return { adapter, target_type: adapter, target_config: config };
}

/**
 * Extract GitHub owner/repo from a URL (same logic as routing.js).
 * @param {string} url
 * @returns {{ owner: string, repo: string }|null}
 */
function extractGitHubInfo(url) {
    if (!url) return null;
    const m = url.match(/github\.com\/([^/?#]+)\/([^/?#]+)/);
    if (!m) return null;
    const owner = m[1];
    const repo = m[2].replace(/\.git$/, '');
    const skip = ['settings', 'orgs', 'marketplace', 'explore', 'topics', 'trending',
        'collections', 'events', 'sponsors', 'notifications', 'new', 'login',
        'signup', 'features', 'security', 'pricing', 'enterprise'];
    if (skip.includes(owner)) return null;
    return { owner, repo };
}

/**
 * Fetch .clawmark.yml from a GitHub repo.
 * Tries main branch first, falls back to master.
 *
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<object|null>} validated declaration or null
 */
async function fetchClawmarkYml(owner, repo) {
    const cacheKey = `yml:${owner}/${repo}`;
    const cached = getCached(cacheKey);
    if (cached !== undefined) return cached.value;

    for (const branch of ['main', 'master']) {
        const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/.clawmark.yml`;
        const body = await fetchUrl(url);
        if (body) {
            try {
                const parsed = yaml.load(body);
                const declaration = validateDeclaration(parsed);
                if (declaration) {
                    cache.set(cacheKey, { value: declaration, timestamp: Date.now(), negative: false });
                    return declaration;
                }
            } catch {
                // Invalid YAML — treat as not found
            }
        }
    }

    cache.set(cacheKey, { value: null, timestamp: Date.now(), negative: true });
    return null;
}

/**
 * Fetch /.well-known/clawmark.json from a URL's origin.
 *
 * @param {string} sourceUrl
 * @returns {Promise<object|null>} validated declaration or null
 */
async function fetchWellKnown(sourceUrl) {
    let origin;
    try {
        origin = new URL(sourceUrl).origin;
    } catch {
        return null;
    }

    // Don't fetch well-known from GitHub (use .clawmark.yml instead)
    if (origin.includes('github.com')) return null;

    const cacheKey = `wk:${origin}`;
    const cached = getCached(cacheKey);
    if (cached !== undefined) return cached.value;

    const url = `${origin}/.well-known/clawmark.json`;
    const body = await fetchUrl(url);
    if (body) {
        try {
            const parsed = JSON.parse(body);
            const declaration = validateDeclaration(parsed);
            if (declaration) {
                cache.set(cacheKey, { value: declaration, timestamp: Date.now(), negative: false });
                return declaration;
            }
        } catch {
            // Invalid JSON
        }
    }

    cache.set(cacheKey, { value: null, timestamp: Date.now(), negative: true });
    return null;
}

/**
 * Resolve target declaration for a source URL.
 * Tries .clawmark.yml (GitHub) or /.well-known/clawmark.json (other sites).
 *
 * @param {string} sourceUrl
 * @returns {Promise<{ target_type: string, target_config: object }|null>}
 */
async function resolveDeclaration(sourceUrl) {
    if (!sourceUrl) return null;

    // GitHub URLs → try .clawmark.yml
    const gh = extractGitHubInfo(sourceUrl);
    if (gh) {
        return fetchClawmarkYml(gh.owner, gh.repo);
    }

    // Other URLs → try /.well-known/clawmark.json
    return fetchWellKnown(sourceUrl);
}

/**
 * Clear all cached declarations.
 */
function clearCache() {
    cache.clear();
}

/**
 * Get cache stats (for diagnostics).
 */
function getCacheStats() {
    let valid = 0, expired = 0;
    const now = Date.now();
    for (const [, entry] of cache) {
        const ttl = entry.negative ? NEGATIVE_CACHE_TTL : CACHE_TTL;
        if (now - entry.timestamp > ttl) expired++;
        else valid++;
    }
    return { total: cache.size, valid, expired };
}

module.exports = {
    resolveDeclaration,
    fetchClawmarkYml,
    fetchWellKnown,
    validateDeclaration,
    clearCache,
    getCacheStats,
    // Exposed for testing
    _cache: cache,
    _fetchUrl: fetchUrl,
    CACHE_TTL,
    NEGATIVE_CACHE_TTL,
};
