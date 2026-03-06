#!/usr/bin/env node

/**
 * ClawMark — Credential Encryption Migration Script
 *
 * Encrypts all plaintext credentials in user_auths table.
 * Safe to run multiple times — skips already-encrypted rows.
 *
 * Usage:
 *   CLAWMARK_ENCRYPTION_KEY=<key> node scripts/encrypt-credentials.js [--data-dir <path>]
 *
 * Options:
 *   --data-dir <path>   Path to data directory (default: ./data)
 *   --dry-run           Show what would be encrypted without writing
 *   --decrypt           Decrypt all rows back to plaintext (for key rotation step 1)
 */

'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { init, isEnabled, isEncrypted, encrypt, decrypt } = require('../server/crypto');

// Parse args
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const decryptMode = args.includes('--decrypt');
const dataDirIdx = args.indexOf('--data-dir');
const dataDir = dataDirIdx !== -1 ? args[dataDirIdx + 1] : (process.env.CLAWMARK_DATA_DIR || path.join(__dirname, '..', 'data'));

// Init encryption
const key = process.env.CLAWMARK_ENCRYPTION_KEY;
if (!key) {
    console.error('ERROR: CLAWMARK_ENCRYPTION_KEY environment variable is required.');
    process.exit(1);
}
init(key);
if (!isEnabled()) {
    console.error('ERROR: Failed to initialize encryption key.');
    process.exit(1);
}

// Open database
const dbPath = path.join(dataDir, 'clawmark.db');
let db;
try {
    db = new Database(dbPath);
} catch (err) {
    console.error(`ERROR: Cannot open database at ${dbPath}: ${err.message}`);
    process.exit(1);
}

const rows = db.prepare('SELECT id, user_name, auth_type, credentials FROM user_auths').all();
console.log(`Found ${rows.length} auth rows in ${dbPath}`);

const update = db.prepare('UPDATE user_auths SET credentials = ?, updated_at = ? WHERE id = ?');
const now = new Date().toISOString();
let processed = 0;
let skipped = 0;

const txn = db.transaction(() => {
    for (const row of rows) {
        if (decryptMode) {
            if (!isEncrypted(row.credentials)) {
                skipped++;
                continue;
            }
            const plaintext = decrypt(row.credentials);
            console.log(`  ${row.id} (${row.auth_type}, ${row.user_name}): decrypt`);
            if (!dryRun) update.run(plaintext, now, row.id);
            processed++;
        } else {
            if (isEncrypted(row.credentials)) {
                skipped++;
                continue;
            }
            const encrypted = encrypt(row.credentials);
            console.log(`  ${row.id} (${row.auth_type}, ${row.user_name}): encrypt`);
            if (!dryRun) update.run(encrypted, now, row.id);
            processed++;
        }
    }
});

txn();
db.close();

const action = decryptMode ? 'decrypted' : 'encrypted';
const prefix = dryRun ? '[DRY RUN] Would have' : 'Successfully';
console.log(`\n${prefix} ${action} ${processed} rows, skipped ${skipped} (already ${decryptMode ? 'plaintext' : 'encrypted'}).`);
