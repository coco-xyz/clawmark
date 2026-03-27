'use strict';

const crypto = require('crypto');
const { generateAgentKey, hashKey } = require('./agent-auth');

const VALID_SCOPES = ['perception', 'action', 'session', 'annotation', 'issue', 'admin'];
const MAX_TOKEN_EXPIRY = 7 * 24 * 60 * 60; // 7 days in seconds
const DEFAULT_TOKEN_EXPIRY = 24 * 60 * 60;  // 24 hours

/**
 * Generate a binding token.
 * Format: cmbt_{base64url(JSON payload)}.{HMAC signature}
 */
function generateBindingToken({ app_id, scopes, created_by, expires_in, secret }) {
    const now = new Date();
    const expiresIn = Math.min(expires_in || DEFAULT_TOKEN_EXPIRY, MAX_TOKEN_EXPIRY);
    const expiresAt = new Date(now.getTime() + expiresIn * 1000);

    const payload = {
        app_id,
        scopes,
        created_by,
        created_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        nonce: crypto.randomBytes(16).toString('hex'),
    };

    const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto.createHmac('sha256', secret).update(payloadStr).digest('base64url');
    const token = `cmbt_${payloadStr}.${signature}`;

    return {
        token,
        hash: hashKey(token),
        payload,
        expires_at: expiresAt.toISOString(),
    };
}

/**
 * Parse and verify a binding token.
 * Returns the payload if valid, or null if invalid.
 */
function verifyBindingToken(token, secret) {
    if (!token || !token.startsWith('cmbt_')) return null;

    const withoutPrefix = token.slice(5); // remove 'cmbt_'
    const dotIdx = withoutPrefix.lastIndexOf('.');
    if (dotIdx === -1) return null;

    const payloadStr = withoutPrefix.slice(0, dotIdx);
    const signature = withoutPrefix.slice(dotIdx + 1);

    const expected = crypto.createHmac('sha256', secret).update(payloadStr).digest('base64url');
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;

    try {
        const payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString('utf8'));
        return payload;
    } catch {
        return null;
    }
}

/**
 * Create Express router for binding endpoints.
 * @param {object} opts - { db, jwtSecret, v2Auth, agentAuth, apiReadLimiter, apiWriteLimiter, agentRegisterLimiter }
 */
function createBindingRouter(opts) {
    const express = require('express');
    const router = express.Router();
    const { db, jwtSecret, v2Auth, v2AuthOrAgent, apiReadLimiter, apiWriteLimiter, agentRegisterLimiter, getPerceptionWs } = opts;

    // ------ POST /create-token — generate a binding token
    router.post('/create-token', apiWriteLimiter, v2Auth, (req, res) => {
        const app_id = req.v2Auth?.app_id;
        if (!app_id) return res.status(400).json({ error: 'App context required' });

        const { scopes, expires_in, label } = req.body || {};

        // Validate scopes
        if (!Array.isArray(scopes) || scopes.length === 0) {
            return res.status(400).json({ error: 'scopes must be a non-empty array' });
        }
        const invalidScopes = scopes.filter(s => !VALID_SCOPES.includes(s));
        if (invalidScopes.length > 0) {
            return res.status(400).json({ error: `Invalid scopes: ${invalidScopes.join(', ')}. Valid: ${VALID_SCOPES.join(', ')}` });
        }

        try {
            const { token, hash, expires_at } = generateBindingToken({
                app_id,
                scopes,
                created_by: req.v2Auth.user_name || req.v2Auth.user || 'api',
                expires_in,
                secret: jwtSecret,
            });

            const binding = db.createBinding({
                app_id,
                scopes,
                label: label || null,
                token_hash: hash,
                token_expires: expires_at,
                created_by: req.v2Auth.user_name || req.v2Auth.user || 'api',
            });

            res.status(201).json({
                binding_id: binding.id,
                token, // only returned once
                scopes,
                expires_at,
                label: label || null,
                install_command: `curl -fsSL https://jessie.coco.site/clawmark/install.sh | bash -s -- --token ${token}`,
            });
        } catch (err) {
            console.error('[binding] create-token error:', err.message);
            res.status(500).json({ error: 'Failed to create binding token' });
        }
    });

    // ------ POST /handshake — agent uses binding token to establish connection
    router.post('/handshake', agentRegisterLimiter, (req, res) => {
        const { binding_token, agent_info } = req.body || {};

        if (!binding_token) return res.status(400).json({ error: 'binding_token required' });
        if (!agent_info || !agent_info.name) return res.status(400).json({ error: 'agent_info.name required' });

        // Verify token signature
        const payload = verifyBindingToken(binding_token, jwtSecret);
        if (!payload) return res.status(400).json({ error: 'token_invalid' });

        // Check expiry
        if (new Date(payload.expires_at) < new Date()) {
            return res.status(400).json({ error: 'token_expired' });
        }

        // Find binding by token hash
        const tokenHash = hashKey(binding_token);
        const binding = db.getBindingByTokenHash(tokenHash);
        if (!binding) return res.status(400).json({ error: 'token_invalid' });

        // Check if already used
        if (binding.token_used) {
            return res.status(400).json({ error: 'token_used' });
        }

        // Check binding status
        if (binding.status !== 'pending') {
            return res.status(400).json({ error: 'binding_not_pending' });
        }

        try {
            // Register a new agent (or reuse if agent_info provides an existing key)
            const { raw: agentKey, hash: agentKeyHash, prefix: agentKeyPrefix } = generateAgentKey();

            db.registerAgent({
                app_id: binding.app_id,
                name: agent_info.name,
                key_hash: agentKeyHash,
                key_prefix: agentKeyPrefix,
                callback_url: agent_info.callback_url || null,
                capabilities: JSON.stringify(agent_info.capabilities || []),
                created_by: `binding:${binding.id}`,
            });

            // Get the newly created agent to find its id
            const agent = db.getAgentByKeyHash(agentKeyHash);

            // Activate binding
            const activated = db.activateBinding(binding.id, {
                agent_id: agent.id,
                agent_name: agent_info.name,
                agent_type: agent_info.type || 'zylos',
                agent_node_url: agent_info.node_url || null,
            });

            res.json({
                binding_id: binding.id,
                agent_id: agent.id,
                agent_key: agentKey, // only returned once
                scopes: activated.scopes,
                ws_endpoint: (() => {
                    const proto = req.get('x-forwarded-proto') === 'https' ? 'wss' : 'ws';
                    const host = process.env.CLAWMARK_PUBLIC_URL || `${proto}://${req.get('host')}`;
                    return host.replace(/^http/, 'ws') + '/ws/agent';
                })(),
                app_info: {
                    app_id: binding.app_id,
                },
            });
        } catch (err) {
            console.error('[binding] handshake error:', err.message);
            res.status(500).json({ error: 'Handshake failed' });
        }
    });

    // ------ GET /me — agent checks own binding info (authenticated via agent key)
    // MUST be before /:id to avoid Express treating "me" as an :id param
    router.get('/me', apiReadLimiter, v2AuthOrAgent, (req, res) => {
        const agent = req.v2Auth?.agent || req.agent;
        if (!agent) return res.status(401).json({ error: 'Agent auth required' });

        try {
            const bindings = db.getBindingsByAgent(agent.id);
            res.json({
                agent_id: agent.id,
                agent_name: agent.name,
                bindings: bindings.map(b => {
                    const { token_hash, ...safe } = b;
                    return safe;
                }),
            });
        } catch (err) {
            console.error('[binding] me error:', err.message);
            res.status(500).json({ error: 'Failed to get binding info' });
        }
    });

    // ------ POST /heartbeat — agent heartbeat
    router.post('/heartbeat', apiWriteLimiter, v2AuthOrAgent, (req, res) => {
        const agent = req.v2Auth?.agent || req.agent;
        if (!agent) return res.status(401).json({ error: 'Agent auth required' });

        const { binding_id, status, version } = req.body || {};
        if (!binding_id) return res.status(400).json({ error: 'binding_id required' });

        const binding = db.getBindingById(binding_id);
        if (!binding || binding.agent_id !== agent.id) {
            return res.status(404).json({ error: 'Binding not found' });
        }

        db.updateBindingHeartbeat(binding_id, true);
        res.json({ ok: true });
    });

    // ------ GET / — list bindings for current app
    router.get('/', apiReadLimiter, v2Auth, (req, res) => {
        const app_id = req.v2Auth?.app_id;
        if (!app_id) return res.status(400).json({ error: 'App context required' });

        try {
            const bindings = db.getBindingsByApp(app_id);
            res.json({ bindings });
        } catch (err) {
            console.error('[binding] list error:', err.message);
            res.status(500).json({ error: 'Failed to list bindings' });
        }
    });

    // ------ GET /:id — binding detail
    router.get('/:id', apiReadLimiter, v2Auth, (req, res) => {
        const app_id = req.v2Auth?.app_id;
        if (!app_id) return res.status(400).json({ error: 'App context required' });

        const binding = db.getBindingById(req.params.id);
        if (!binding || binding.app_id !== app_id) {
            return res.status(404).json({ error: 'Binding not found' });
        }
        // Strip token_hash from response
        const { token_hash, ...safe } = binding;
        res.json(safe);
    });

    // ------ PUT /:id — update binding (scopes, label)
    router.put('/:id', apiWriteLimiter, v2Auth, (req, res) => {
        const app_id = req.v2Auth?.app_id;
        if (!app_id) return res.status(400).json({ error: 'App context required' });

        const binding = db.getBindingById(req.params.id);
        if (!binding || binding.app_id !== app_id) {
            return res.status(404).json({ error: 'Binding not found' });
        }

        const { scopes } = req.body || {};
        if (scopes) {
            if (!Array.isArray(scopes)) return res.status(400).json({ error: 'scopes must be an array' });
            const invalid = scopes.filter(s => !VALID_SCOPES.includes(s));
            if (invalid.length > 0) return res.status(400).json({ error: `Invalid scopes: ${invalid.join(', ')}` });

            const updated = db.updateBindingScopes(req.params.id, scopes);
            // Notify connected agent of scope change (#109)
            const pws = getPerceptionWs && getPerceptionWs();
            if (pws) pws.pushScopeChanged(req.params.id, scopes);
            const { token_hash, ...safe } = updated;
            return res.json(safe);
        }

        res.status(400).json({ error: 'Nothing to update' });
    });

    // ------ POST /:id/suspend — suspend binding
    router.post('/:id/suspend', apiWriteLimiter, v2Auth, (req, res) => {
        const app_id = req.v2Auth?.app_id;
        if (!app_id) return res.status(400).json({ error: 'App context required' });

        const binding = db.getBindingById(req.params.id);
        if (!binding || binding.app_id !== app_id) return res.status(404).json({ error: 'Binding not found' });
        if (binding.status !== 'active') return res.status(400).json({ error: 'Can only suspend active bindings' });

        const updated = db.updateBindingStatus(req.params.id, 'suspended');
        // Close WebSocket connections for suspended binding (#109)
        const pws2 = getPerceptionWs && getPerceptionWs();
        if (pws2) pws2.closeBinding(req.params.id);
        const { token_hash, ...safe } = updated;
        res.json(safe);
    });

    // ------ POST /:id/resume — resume suspended binding
    router.post('/:id/resume', apiWriteLimiter, v2Auth, (req, res) => {
        const app_id = req.v2Auth?.app_id;
        if (!app_id) return res.status(400).json({ error: 'App context required' });

        const binding = db.getBindingById(req.params.id);
        if (!binding || binding.app_id !== app_id) return res.status(404).json({ error: 'Binding not found' });
        if (binding.status !== 'suspended') return res.status(400).json({ error: 'Can only resume suspended bindings' });

        const updated = db.updateBindingStatus(req.params.id, 'active');
        const { token_hash, ...safe } = updated;
        res.json(safe);
    });

    // ------ DELETE /:id — revoke binding
    router.delete('/:id', apiWriteLimiter, v2Auth, (req, res) => {
        const app_id = req.v2Auth?.app_id;
        if (!app_id) return res.status(400).json({ error: 'App context required' });

        const binding = db.getBindingById(req.params.id);
        if (!binding || binding.app_id !== app_id) return res.status(404).json({ error: 'Binding not found' });

        db.updateBindingStatus(req.params.id, 'revoked');

        // Close WebSocket connections for revoked binding (#109)
        const pws3 = getPerceptionWs && getPerceptionWs();
        if (pws3) pws3.closeBinding(req.params.id);

        // Also deactivate the associated agent if exists
        if (binding.agent_id) {
            try { db.deactivateAgent(binding.agent_id); } catch {}
        }

        res.json({ id: req.params.id, status: 'revoked' });
    });

    return router;
}

module.exports = { createBindingRouter, generateBindingToken, verifyBindingToken, VALID_SCOPES };
