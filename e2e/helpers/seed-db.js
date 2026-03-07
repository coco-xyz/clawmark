/**
 * Seed the E2E test database with a test user.
 *
 * The server auto-creates the DB schema on startup. This helper
 * inserts a known user so JWT auth works in browser tests.
 *
 * Must be called AFTER the server has started (DB file exists).
 */

'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '.tmp-data', 'clawmark.db');

const TEST_USER = {
    id: 'user-e2e-test-1',
    google_id: 'e2e-test-google-id',
    email: 'e2e-test@example.com',
    name: 'E2E Test User',
    picture: null,
    role: 'member',
};

function seedTestUser() {
    const db = new Database(DB_PATH);
    const now = new Date().toISOString();

    const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(TEST_USER.id);
    if (!existing) {
        db.prepare(
            `INSERT INTO users (id, google_id, email, name, picture, role, created_at, last_login)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(TEST_USER.id, TEST_USER.google_id, TEST_USER.email, TEST_USER.name, TEST_USER.picture, TEST_USER.role, now, now);

        // Create a default app for the user (matches getOrCreateDefaultApp logic)
        db.prepare(
            `INSERT OR IGNORE INTO apps (id, user_id, name, is_default, created_at, updated_at)
             VALUES (?, ?, ?, 1, ?, ?)`
        ).run('app-e2e-default', TEST_USER.id, TEST_USER.email + "'s app", now, now);
    }

    db.close();
}

module.exports = { seedTestUser, TEST_USER };
