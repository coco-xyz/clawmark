/**
 * ClawMark — Target Declaration Discovery
 *
 * Fetches and caches target declarations from:
 *   1. .clawmark.yml — GitHub repo root (via raw.githubusercontent.com)
 *   2. /.well-known/clawmark.json — any website's origin
 *
 * Declarations let project owners specify how annotations should be routed
 * without end-users needing to configure rules manually.
 *
 * Security:
 *   - HTTPS only (no HTTP)
 *   - Private/internal IP blocking (SSRF prevention)
 *   - Redirect depth limit (max 3)
 *   - Response size limit (64KB)
 *   - Cache size limit (1000 entries)
 */

'use strict';

const https = require('https');
const { lookup } = require('dns/promises');
const yaml = require('js-yaml');
const { extractGitHubRepo } = require('./routing');

// ── Cache ──
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const NEGATIVE_CACHE_TTL = 2 * 60 * 1000; // 2 minutes for "not found"
const CACHE_MAX_SIZE = 1000;
const FETCH_TIMEOUT = 5000; // 5 seconds
const MAX_REDIRECTS = 3;

// Valid adapter types
const VALID_ADAPTERS = ['github-issue', 'github-issues', 'webhook', 'lark', 'telegram', 'email'];

// Allowed fetch hosts (only these origins are trusted for .clawmark.yml)
const TRUSTED_HOSTS = ['raw.githubusercontent.com'];

/**
 * Check if an IP address is private/internal (SSRF prevention).
 * Blocks: loopback, link-local, private ranges, cloud metadata.
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateIP(ip) {
    if (!ip) return true;
    // IPv4
    if (/^127\./.test(ip)) return true;                // loopback
    if (/^10\./.test(ip)) return true;                  // Class A private
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true; // Class B private
    if (/^192\.168\./.test(ip)) return true;            // Class C private
    if (/^169\.254\./.test(ip)) return true;            // link-local (cloud metadata!)
    if (ip === '0.0.0.0') return true;
    // IPv6
    if (ip === '::1') return true;                      // loopback
    if (/^fe80:/i.test(ip)) return true;                // link-local
    if (/^fc00:/i.test(ip)) return true;                // unique local
    if (/^fd/i.test(ip)) return true;                   // unique local
    return false;
}

/**
 * Validate that a URL is safe to fetch (SSRF prevention).
 * - Must be HTTPS
 * - Must not resolve to a private IP
 * @param {string} url
 * @returns {Promise<boolean>}
 */
async function isSafeUrl(url) {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') return false;
        // Trusted hosts bypass DNS check (GitHub raw content)
        if (TRUSTED_HOSTS.includes(parsed.hostname)) return true;
        // Resolve DNS and check IP
        const { address } = await lookup(parsed.hostname);
        return !isPrivateIP(address);
    } catch {
        return false;
    }
}

/**
 * Fetch URL with timeout, size limit, HTTPS-only, and SSRF protection.
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.timeout]
 * @param {number} [options.maxSize]
 * @param {number} [options.redirectsLeft]
 * @returns {Promise<string|null>}
 */
async function fetchUrl(url, { timeout = FETCH_TIMEOUT, maxSize = 64 * 1024, redirectsLeft = MAX_REDIRECTS } = {}) {
    // SSRF protection: validate URL before fetching
    const safe = await isSafeUrl(url);
    if (!safe) return null;

    return new Promise((resolve) => {
        try {
            const req = https.get(url, { timeout }, (res) => {
                if ((res.statusCode === 301 || res.statusCode === 302) && redirectsLeft > 0) {
                    const location = res.headers.location;
                    res.resume();
                    if (location) {
                        // Resolve relative redirects
                        let absoluteLocation;
                        try { absoluteLocation = new URL(location, url).href; } catch { resolve(null); return; }
                        fetchUrl(absoluteLocation, { timeout, maxSize, redirectsLeft: redirectsLeft - 1 }).then(resolve);
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
 * Set cache entry with size eviction.
 */
function setCache(key, value, negative) {
    // Evict oldest entries if cache is full
    if (cache.size >= CACHE_MAX_SIZE) {
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
    }
    cache.set(key, { value, timestamp: Date.now(), negative });
}

/**
 * Validate and normalize a declaration object.
 * Returns normalized config or null if invalid.
 *
 * @param {object} raw
 * @returns {{ adapter: string, target_type: string, target_config: object }|null}
 */
function validateDeclaration(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

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
        if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(target)) return null;
        config.repo = target;
        config.labels = Array.isArray(raw.labels) ? raw.labels.filter(l => typeof l === 'string').slice(0, 10) : ['clawmark'];
        config.assignees = Array.isArray(raw.assignees) ? raw.assignees.filter(a => typeof a === 'string').slice(0, 5) : [];
    } else if (adapter === 'webhook') {
        const endpoint = raw.endpoint;
        if (!endpoint || typeof endpoint !== 'string') return null;
        // Webhook endpoint must be HTTPS, no private IPs
        try {
            const parsed = new URL(endpoint);
            if (parsed.protocol !== 'https:') return null;
            // Block obvious private hostnames (async DNS check happens at dispatch time)
            const host = parsed.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
            if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(host)) return null;
        } catch { return null; }
        config.url = endpoint;
        config.method = 'POST';
    } else {
        // Other adapters: only copy known safe fields
        const safeFields = ['webhook_url', 'chat_id', 'channel', 'token', 'bot_token'];
        for (const field of safeFields) {
            if (raw[field] !== undefined && (typeof raw[field] === 'string' || typeof raw[field] === 'number')) {
                config[field] = raw[field];
            }
        }
    }

    // Optional: accepted annotation types
    if (Array.isArray(raw.types)) {
        config.types = raw.types.filter(t => typeof t === 'string').slice(0, 10);
    }

    return { adapter, target_type: adapter, target_config: config };
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
        const url = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${branch}/.clawmark.yml`;
        const body = await fetchUrl(url);
        if (body) {
            try {
                const parsed = yaml.load(body, { schema: yaml.FAILSAFE_SCHEMA });
                const declaration = validateDeclaration(parsed);
                if (declaration) {
                    setCache(cacheKey, declaration, false);
                    return declaration;
                }
            } catch {
                // Invalid YAML
            }
        }
    }

    setCache(cacheKey, null, true);
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
        const parsed = new URL(sourceUrl);
        if (parsed.protocol !== 'https:') return null;
        origin = parsed.origin;
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
                setCache(cacheKey, declaration, false);
                return declaration;
            }
        } catch {
            // Invalid JSON
        }
    }

    setCache(cacheKey, null, true);
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
    const gh = extractGitHubRepo(sourceUrl);
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
    isPrivateIP,
    isSafeUrl,
    // Exposed for testing
    _cache: cache,
    _fetchUrl: fetchUrl,
    _setCache: setCache,
    CACHE_TTL,
    NEGATIVE_CACHE_TTL,
    CACHE_MAX_SIZE,
    MAX_REDIRECTS,
};
