/**
 * ClawMark — server/auth.js
 *
 * Google OAuth authentication and JWT token management.
 *
 * Supports two flows:
 *   1. ID Token — Chrome extension sends Google ID token directly
 *   2. Auth Code — Web client sends authorization code for exchange
 */

'use strict';

const jwt = require('jsonwebtoken');
const https = require('https');

/**
 * Initialize auth module.
 *
 * @param {object} opts
 * @param {object} opts.db          ClawMark DB API (from initDb)
 * @param {string} opts.jwtSecret   Secret for signing JWTs
 * @param {string} [opts.googleClientId]     Google OAuth client ID
 * @param {string} [opts.googleClientSecret] Google OAuth client secret
 * @param {number} [opts.tokenExpiresIn]     JWT lifetime in seconds (default: 7 days)
 * @returns {object} Auth API { router, verifyJwt }
 */
function initAuth({ db, jwtSecret, googleClientId, googleClientSecret, tokenExpiresIn = 7 * 24 * 3600, _verifyGoogleIdToken, _exchangeAuthCode } = {}) {
    const express = require('express');
    const rateLimit = require('express-rate-limit');
    const router = express.Router();

    if (!jwtSecret) {
        console.warn('[auth] JWT_SECRET not configured — OAuth endpoints disabled');
        return { router, verifyJwt: () => null };
    }

    if (!googleClientId) {
        console.warn('[auth] GOOGLE_CLIENT_ID not configured — any Google app ID tokens will be accepted');
    }

    // --------------------------------------------------- helpers

    /** Make an HTTPS GET request, return parsed JSON. */
    function httpsGetJson(url) {
        return new Promise((resolve, reject) => {
            https.get(url, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch (e) { reject(new Error('Invalid JSON from Google')); }
                });
            }).on('error', reject);
        });
    }

    /** POST with form-urlencoded body, return parsed JSON. */
    function httpsPostForm(url, params) {
        const body = new URLSearchParams(params).toString();
        const parsed = new URL(url);
        return new Promise((resolve, reject) => {
            const req = https.request({
                hostname: parsed.hostname,
                path: parsed.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(body),
                },
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch (e) { reject(new Error('Invalid JSON from Google')); }
                });
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }

    /** Verify a Google ID token and return the payload (sub, email, name, picture). */
    async function verifyGoogleIdToken(idToken) {
        const payload = await httpsGetJson(
            `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
        );
        if (payload.error_description) {
            throw new Error(payload.error_description);
        }
        // Verify audience matches our client ID
        if (googleClientId && payload.aud !== googleClientId) {
            throw new Error('Token audience mismatch');
        }
        return {
            google_id: payload.sub,
            email: payload.email,
            name: payload.name || payload.email.split('@')[0],
            picture: payload.picture || null,
        };
    }

    /** Exchange an authorization code for tokens, then get user info. */
    async function exchangeAuthCode(code, redirectUri) {
        if (!googleClientId || !googleClientSecret) {
            throw new Error('Google OAuth client credentials not configured');
        }
        // Exchange code for tokens
        const tokens = await httpsPostForm('https://oauth2.googleapis.com/token', {
            code,
            client_id: googleClientId,
            client_secret: googleClientSecret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
        });
        if (tokens.error) {
            throw new Error(tokens.error_description || tokens.error);
        }
        // Get user info from the access token
        const userInfo = await httpsGetJson(
            `https://www.googleapis.com/oauth2/v2/userinfo?access_token=${encodeURIComponent(tokens.access_token)}`
        );
        return {
            google_id: userInfo.id,
            email: userInfo.email,
            name: userInfo.name || userInfo.email.split('@')[0],
            picture: userInfo.picture || null,
        };
    }

    /** Sign a JWT for a user. */
    function signToken(user) {
        return jwt.sign(
            { userId: user.id, email: user.email, role: user.role },
            jwtSecret,
            { expiresIn: tokenExpiresIn, algorithm: 'HS256' }
        );
    }

    /** Verify a JWT and return the payload, or null if invalid. */
    function verifyJwt(token) {
        try {
            return jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
        } catch {
            return null;
        }
    }

    // --------------------------------------------------- routes

    /**
     * POST /api/v2/auth/google
     *
     * Accepts either:
     *   { idToken: "..." }        — Chrome extension flow (ID token from chrome.identity)
     *   { code: "...", redirectUri: "..." } — Web OAuth flow (authorization code)
     *
     * Returns:
     *   { token: "jwt...", user: { id, email, name, picture, role } }
     */
    // Rate limiter for auth endpoints
    const authLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 20,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many auth attempts, try again later' },
    });

    // Allow injecting mock functions for testing
    const doVerifyGoogleIdToken = _verifyGoogleIdToken || verifyGoogleIdToken;
    const doExchangeAuthCode = _exchangeAuthCode || exchangeAuthCode;

    router.post('/google', authLimiter, async (req, res) => {
        try {
            const { idToken, code, redirectUri } = req.body;

            let googleUser;
            if (idToken) {
                googleUser = await doVerifyGoogleIdToken(idToken);
            } else if (code) {
                googleUser = await doExchangeAuthCode(code, redirectUri || '');
            } else {
                return res.status(400).json({ error: 'Provide idToken or code' });
            }

            // Upsert user in database
            const user = db.upsertUser(googleUser);

            // Sign JWT
            const token = signToken(user);

            res.json({
                token,
                user: {
                    id: user.id,
                    email: user.email,
                    name: user.name,
                    picture: user.picture,
                    role: user.role,
                },
            });
        } catch (err) {
            console.error('[auth] Google auth failed:', err.message);
            res.status(401).json({ error: 'Authentication failed' });
        }
    });

    /**
     * GET /api/v2/auth/me
     *
     * Returns current user info from JWT in Authorization header.
     * Header: Authorization: Bearer <jwt>
     */
    router.get('/me', (req, res) => {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Authorization header required' });
        }
        const token = authHeader.slice(7);
        const payload = verifyJwt(token);
        if (!payload) {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }
        const user = db.getUserById(payload.userId);
        if (!user) {
            return res.status(401).json({ error: 'User not found' });
        }
        res.json({
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                picture: user.picture,
                role: user.role,
                created_at: user.created_at,
            },
        });
    });

    /**
     * POST /api/v2/auth/apikey — issue API key (JWT or invite code)
     *
     * Extends existing endpoint to also accept JWT auth.
     * Body: { name, app_id }
     * Auth: Bearer JWT or invite code in body
     */
    router.post('/apikey', (req, res) => {
        const { name, app_id, code } = req.body;
        let created_by;

        // Try JWT first
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.slice(7);
            // Check if it's a JWT (not an API key)
            if (!token.startsWith('cmk_')) {
                const payload = verifyJwt(token);
                if (payload) {
                    created_by = payload.email;
                }
            }
        }

        // Fall back to invite code
        if (!created_by && code) {
            const VALID_CODES = req.app.locals.VALID_CODES || {};
            if (VALID_CODES[code]) {
                created_by = VALID_CODES[code];
            }
        }

        if (!created_by) {
            return res.status(401).json({ error: 'Valid JWT or invite code required' });
        }

        const key = db.createApiKey({ app_id: app_id || 'default', name, created_by });
        res.json({ success: true, ...key });
    });

    return { router, verifyJwt };
}

module.exports = { initAuth };
