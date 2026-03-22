'use strict';

const crypto = require('crypto');

/**
 * Hash an agent API key with SHA-256.
 * @param {string} raw  The raw key (cmak_...)
 * @returns {string}    Hex-encoded SHA-256 hash
 */
function hashKey(raw) {
    return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Generate a new agent API key.
 * Format: cmak_ + 48 hex chars (24 random bytes)
 * @returns {{ raw: string, hash: string, prefix: string }}
 */
function generateAgentKey() {
    const raw = 'cmak_' + crypto.randomBytes(24).toString('hex');
    return { raw, hash: hashKey(raw), prefix: raw.slice(0, 12) + '...' };
}

/**
 * Create Express middleware that authenticates agents via X-Agent-Key header.
 * @param {object} db  The ClawMark DB API (from initDb)
 * @returns {Function} Express middleware
 */
function createAgentAuth(db) {
    return function agentAuth(req, res, next) {
        const key = req.headers['x-agent-key'];
        if (!key) return res.status(401).json({ error: 'X-Agent-Key header required' });
        if (!key.startsWith('cmak_')) return res.status(401).json({ error: 'Invalid agent key format' });

        const hash = hashKey(key);
        const agent = db.getAgentByKeyHash(hash);
        if (!agent) return res.status(401).json({ error: 'Invalid or inactive agent key' });

        req.agent = agent;
        // Update last_seen asynchronously (don't block request)
        try { db.updateAgentLastSeen(agent.id); } catch {}
        next();
    };
}

module.exports = { hashKey, generateAgentKey, createAgentAuth };
