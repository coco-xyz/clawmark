/**
 * E2E test auth helpers.
 *
 * Generates JWT tokens for test users by directly signing with the
 * same secret the test server uses.
 */

'use strict';

const jwt = require('jsonwebtoken');

const JWT_SECRET = 'e2e-test-secret-key';

/**
 * Create a JWT for a test user.
 * The server must be started with CLAWMARK_JWT_SECRET=e2e-test-secret-key.
 */
function createTestToken(user = {}) {
    const payload = {
        userId: user.userId || 1,
        email: user.email || 'e2e-test@example.com',
        role: user.role || 'user',
    };
    return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h', algorithm: 'HS256' });
}

/**
 * Return an Authorization header value for a test user.
 */
function authHeader(user) {
    return `Bearer ${createTestToken(user)}`;
}

module.exports = { createTestToken, authHeader, JWT_SECRET };
