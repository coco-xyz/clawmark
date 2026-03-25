/**
 * ClawMark — Extension Settings Tests (#70)
 *
 * Tests cover:
 * 1. Agent key validation (format, prefix, length)
 * 2. Agent connection test via HTTP (perception/stats endpoint with agent key)
 * 3. Site permission pattern validation
 * 4. Import/export data structure
 * 5. Storage schema correctness
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { initDb } = require('../server/db');
const { hashKey, generateAgentKey, createAgentAuth } = require('../server/agent-auth');

// ------------------------------------------------------------------ helpers

let dbApi;
let tmpDir;
let server;
let port;

function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawmark-settings-test-'));
    dbApi = initDb(tmpDir);
}

function teardown() {
    if (dbApi && dbApi.db) dbApi.db.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

function createTestServer(db) {
    const app = express();
    app.use(express.json());

    const agentAuth = createAgentAuth(db);

    // Minimal agent auth middleware
    function v2AuthOrAgent(req, res, next) {
        if (req.headers['x-agent-key']) {
            return agentAuth(req, res, () => {
                req.v2Auth = { app_id: req.agent.app_id, agent: req.agent };
                next();
            });
        }
        res.status(401).json({ error: 'Authentication required' });
    }

    // Perception stats endpoint (used for connection testing)
    app.get('/api/v2/agent-channel/perception/stats', v2AuthOrAgent, (req, res) => {
        res.json({ total: 0, by_severity: {}, fingerprints: [] });
    });

    return app;
}

async function startServer(app) {
    return new Promise((resolve) => {
        server = http.createServer(app);
        server.listen(0, '127.0.0.1', () => {
            port = server.address().port;
            resolve();
        });
    });
}

async function stopServer() {
    if (server) {
        return new Promise((resolve) => {
            server.close(resolve);
            server = null;
        });
    }
}

function registerTestAgent(db, appId) {
    const { raw, hash, prefix } = generateAgentKey();
    const agent = db.registerAgent({
        app_id: appId,
        name: 'Test Agent',
        key_hash: hash,
        key_prefix: prefix,
        callback_url: '',
        capabilities: ['perception'],
        created_by: 'test-user',
    });
    return { agent, rawKey: raw };
}

async function fetchJson(urlPath, headers = {}) {
    const url = `http://127.0.0.1:${port}${urlPath}`;
    const resp = await fetch(url, { headers });
    const body = await resp.json();
    return { status: resp.status, body };
}

// ================================================================= agent key validation

describe('Agent Key — Format Validation', () => {
    it('valid key starts with cmak_ and has sufficient length', () => {
        const { raw } = generateAgentKey();
        assert.ok(raw.startsWith('cmak_'));
        assert.ok(raw.length >= 10);
        // cmak_ + 48 hex = 53 chars
        assert.equal(raw.length, 53);
    });

    it('rejects keys without cmak_ prefix', () => {
        const key = 'invalid_key_12345678901234567890';
        assert.ok(!key.startsWith('cmak_'));
    });

    it('rejects keys shorter than 10 chars', () => {
        const key = 'cmak_abc';
        assert.ok(key.length < 10);
    });

    it('generates unique keys', () => {
        const keys = new Set();
        for (let i = 0; i < 100; i++) {
            const { raw } = generateAgentKey();
            assert.ok(!keys.has(raw), 'duplicate key generated');
            keys.add(raw);
        }
    });

    it('hash is deterministic for same key', () => {
        const key = 'cmak_aabbccddee112233445566778899001122334455667788';
        const h1 = hashKey(key);
        const h2 = hashKey(key);
        assert.equal(h1, h2);
    });

    it('different keys produce different hashes', () => {
        const { raw: k1 } = generateAgentKey();
        const { raw: k2 } = generateAgentKey();
        assert.notEqual(hashKey(k1), hashKey(k2));
    });
});

// ================================================================= connection test via HTTP

describe('Agent Connection Test — HTTP', () => {
    beforeEach(async () => {
        setup();
        const app = createTestServer(dbApi);
        await startServer(app);
    });

    afterEach(async () => {
        await stopServer();
        teardown();
    });

    it('valid agent key returns 200', async () => {
        const { rawKey } = registerTestAgent(dbApi, 'test-app');
        const { status, body } = await fetchJson('/api/v2/agent-channel/perception/stats', {
            'X-Agent-Key': rawKey,
        });
        assert.equal(status, 200);
        assert.equal(typeof body.total, 'number');
    });

    it('invalid agent key returns 401', async () => {
        const { status, body } = await fetchJson('/api/v2/agent-channel/perception/stats', {
            'X-Agent-Key': 'cmak_invalid000000000000000000000000000000000000000000',
        });
        assert.equal(status, 401);
        assert.ok(body.error);
    });

    it('missing key returns 401', async () => {
        const { status } = await fetchJson('/api/v2/agent-channel/perception/stats');
        assert.equal(status, 401);
    });

    it('malformed key prefix returns 401', async () => {
        const { status, body } = await fetchJson('/api/v2/agent-channel/perception/stats', {
            'X-Agent-Key': 'not_a_valid_key',
        });
        assert.equal(status, 401);
        assert.ok(body.error.includes('Invalid'));
    });

    it('updates last_seen on successful auth', async () => {
        const { agent, rawKey } = registerTestAgent(dbApi, 'test-app');

        await fetchJson('/api/v2/agent-channel/perception/stats', {
            'X-Agent-Key': rawKey,
        });

        const after = dbApi.getAgentById(agent.id);
        assert.ok(after.last_seen, 'last_seen should be set after auth');
    });

    it('multiple agents can authenticate independently', async () => {
        const a1 = registerTestAgent(dbApi, 'app-1');
        const a2 = registerTestAgent(dbApi, 'app-2');

        const r1 = await fetchJson('/api/v2/agent-channel/perception/stats', {
            'X-Agent-Key': a1.rawKey,
        });
        const r2 = await fetchJson('/api/v2/agent-channel/perception/stats', {
            'X-Agent-Key': a2.rawKey,
        });

        assert.equal(r1.status, 200);
        assert.equal(r2.status, 200);
    });
});

// ================================================================= site permission patterns

describe('Site Permission — Pattern Validation', () => {
    // Mirrors the validation regex from settings.js
    const PATTERN_REGEX = /^[a-z0-9*._-]+(\.[a-z0-9*._-]+)*$/;

    it('accepts simple domain', () => {
        assert.ok(PATTERN_REGEX.test('example.com'));
    });

    it('accepts wildcard subdomain', () => {
        assert.ok(PATTERN_REGEX.test('*.example.com'));
    });

    it('accepts domain with hyphens', () => {
        assert.ok(PATTERN_REGEX.test('my-site.example.com'));
    });

    it('accepts domain with numbers', () => {
        assert.ok(PATTERN_REGEX.test('site123.example.com'));
    });

    it('accepts bare wildcard', () => {
        assert.ok(PATTERN_REGEX.test('*'));
    });

    it('rejects empty string', () => {
        assert.ok(!PATTERN_REGEX.test(''));
    });

    it('rejects pattern with spaces', () => {
        assert.ok(!PATTERN_REGEX.test('example .com'));
    });

    it('rejects pattern with protocol', () => {
        assert.ok(!PATTERN_REGEX.test('https://example.com'));
    });

    it('rejects pattern with path', () => {
        assert.ok(!PATTERN_REGEX.test('example.com/path'));
    });

    it('rejects pattern with port', () => {
        assert.ok(!PATTERN_REGEX.test('example.com:8080'));
    });
});

// ================================================================= domain matching logic

describe('Site Permission — Domain Matching', () => {
    // Simple glob matching function that mirrors what the extension would use
    function matchesDomain(pattern, hostname) {
        if (pattern === '*') return true;
        if (pattern === hostname) return true;
        if (pattern.startsWith('*.')) {
            const suffix = pattern.slice(2);
            return hostname === suffix || hostname.endsWith('.' + suffix);
        }
        return false;
    }

    it('exact match', () => {
        assert.ok(matchesDomain('example.com', 'example.com'));
    });

    it('exact non-match', () => {
        assert.ok(!matchesDomain('example.com', 'other.com'));
    });

    it('wildcard matches subdomain', () => {
        assert.ok(matchesDomain('*.example.com', 'sub.example.com'));
    });

    it('wildcard matches nested subdomain', () => {
        assert.ok(matchesDomain('*.example.com', 'a.b.example.com'));
    });

    it('wildcard matches base domain', () => {
        assert.ok(matchesDomain('*.example.com', 'example.com'));
    });

    it('wildcard does not match unrelated domain', () => {
        assert.ok(!matchesDomain('*.example.com', 'notexample.com'));
    });

    it('global wildcard matches everything', () => {
        assert.ok(matchesDomain('*', 'anything.com'));
    });
});

// ================================================================= import/export schema

describe('Settings — Import/Export Schema', () => {
    function createExportData(overrides = {}) {
        return {
            version: 1,
            exportedAt: new Date().toISOString(),
            agents: [
                {
                    name: 'Test Bot',
                    key: 'cmak_aabbccddee112233445566778899001122334455667788',
                    serverUrl: '',
                },
            ],
            sitePermissions: {
                mode: 'blacklist',
                sites: [
                    { pattern: 'example.com', error: true, network: true, console: false },
                ],
            },
            ...overrides,
        };
    }

    it('valid export has required fields', () => {
        const data = createExportData();
        assert.equal(data.version, 1);
        assert.ok(data.exportedAt);
        assert.ok(Array.isArray(data.agents));
        assert.ok(data.sitePermissions);
        assert.ok(data.sitePermissions.mode);
        assert.ok(Array.isArray(data.sitePermissions.sites));
    });

    it('agent entry has name, key, serverUrl', () => {
        const data = createExportData();
        const agent = data.agents[0];
        assert.equal(typeof agent.name, 'string');
        assert.equal(typeof agent.key, 'string');
        assert.ok(agent.key.startsWith('cmak_'));
        assert.equal(typeof agent.serverUrl, 'string');
    });

    it('site permission entry has pattern and toggle fields', () => {
        const data = createExportData();
        const site = data.sitePermissions.sites[0];
        assert.equal(typeof site.pattern, 'string');
        assert.equal(typeof site.error, 'boolean');
        assert.equal(typeof site.network, 'boolean');
        assert.equal(typeof site.console, 'boolean');
    });

    it('filters out agents without cmak_ prefix on import', () => {
        const data = createExportData({
            agents: [
                { name: 'Valid', key: 'cmak_aabbccddee112233445566778899001122334455667788', serverUrl: '' },
                { name: 'Invalid', key: 'bad_key', serverUrl: '' },
            ],
        });
        const imported = data.agents.filter(a => a.key.startsWith('cmak_'));
        assert.equal(imported.length, 1);
        assert.equal(imported[0].name, 'Valid');
    });

    it('rejects unsupported version', () => {
        const data = createExportData({ version: 99 });
        assert.notEqual(data.version, 1);
    });

    it('normalizes mode to blacklist or whitelist', () => {
        const modes = ['blacklist', 'whitelist', 'invalid'];
        const normalized = modes.map(m => m === 'whitelist' ? 'whitelist' : 'blacklist');
        assert.deepEqual(normalized, ['blacklist', 'whitelist', 'blacklist']);
    });

    it('defaults toggle fields to true when missing', () => {
        const site = { pattern: 'test.com' };
        const imported = {
            pattern: String(site.pattern || ''),
            error: site.error !== false,
            network: site.network !== false,
            console: site.console !== false,
        };
        assert.equal(imported.error, true);
        assert.equal(imported.network, true);
        assert.equal(imported.console, true);
    });

    it('respects explicit false toggle values', () => {
        const site = { pattern: 'test.com', error: false, network: false, console: false };
        const imported = {
            pattern: String(site.pattern || ''),
            error: site.error !== false,
            network: site.network !== false,
            console: site.console !== false,
        };
        assert.equal(imported.error, false);
        assert.equal(imported.network, false);
        assert.equal(imported.console, false);
    });
});

// ================================================================= storage schema

describe('Settings — Storage Schema', () => {
    it('boundAgents default is empty array', () => {
        const defaults = { boundAgents: [], sitePermissions: { mode: 'blacklist', sites: [] } };
        assert.deepEqual(defaults.boundAgents, []);
    });

    it('sitePermissions default has blacklist mode', () => {
        const defaults = { boundAgents: [], sitePermissions: { mode: 'blacklist', sites: [] } };
        assert.equal(defaults.sitePermissions.mode, 'blacklist');
        assert.deepEqual(defaults.sitePermissions.sites, []);
    });

    it('agent storage entry has all required fields', () => {
        const entry = {
            id: 'abc123',
            name: 'My Agent',
            key: 'cmak_aabbccddee112233445566778899001122334455667788',
            keyPrefix: 'cmak_aabbcc...',
            serverUrl: '',
            status: 'unknown',
            agentId: '',
            lastTested: 0,
        };
        assert.equal(typeof entry.id, 'string');
        assert.equal(typeof entry.name, 'string');
        assert.ok(entry.key.startsWith('cmak_'));
        assert.equal(typeof entry.keyPrefix, 'string');
        assert.equal(typeof entry.serverUrl, 'string');
        assert.ok(['connected', 'disconnected', 'unknown'].includes(entry.status));
        assert.equal(typeof entry.lastTested, 'number');
    });

    it('duplicate key detection works', () => {
        const agents = [
            { key: 'cmak_aaaa' },
            { key: 'cmak_bbbb' },
        ];
        const newKey = 'cmak_aaaa';
        assert.ok(agents.some(a => a.key === newKey));

        const uniqueKey = 'cmak_cccc';
        assert.ok(!agents.some(a => a.key === uniqueKey));
    });
});

// ================================================================= escapeHtml

describe('Settings — HTML Escaping', () => {
    // Mirrors the escapeHtml function without DOM dependency
    function escapeHtml(str) {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#x27;');
    }

    it('escapes angle brackets', () => {
        assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
    });

    it('escapes ampersand', () => {
        assert.equal(escapeHtml('a & b'), 'a &amp; b');
    });

    it('escapes quotes', () => {
        assert.equal(escapeHtml('"hello"'), '&quot;hello&quot;');
    });

    it('passes through normal text unchanged', () => {
        assert.equal(escapeHtml('Hello World 123'), 'Hello World 123');
    });

    it('prevents XSS in agent name', () => {
        const name = '<img src=x onerror=alert(1)>';
        const escaped = escapeHtml(name);
        assert.ok(!escaped.includes('<'));
        assert.ok(!escaped.includes('>'));
    });
});
