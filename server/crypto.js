/**
 * ClawMark — Credential Encryption (AES-256-GCM)
 *
 * Encrypts/decrypts sensitive data at rest using AES-256-GCM with random IV.
 * Format: "enc:<iv>:<authTag>:<ciphertext>" (all base64-encoded).
 *
 * Requires CLAWMARK_ENCRYPTION_KEY environment variable (32 bytes, hex or base64).
 */

'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const PREFIX = 'enc:';

let _key = null;

/**
 * Load and validate the encryption key from environment or config.
 * @param {string|null} rawKey - hex or base64 encoded 32-byte key
 * @returns {Buffer|null}
 */
function loadKey(rawKey) {
    if (!rawKey) return null;

    let buf;
    if (/^[0-9a-f]{64}$/i.test(rawKey)) {
        buf = Buffer.from(rawKey, 'hex');
    } else {
        buf = Buffer.from(rawKey, 'base64');
    }

    if (buf.length !== 32) {
        throw new Error(`CLAWMARK_ENCRYPTION_KEY must be 32 bytes (got ${buf.length}). Use 64 hex chars or 44 base64 chars.`);
    }
    return buf;
}

/**
 * Initialize the crypto module with the given key.
 * @param {string|null} rawKey
 */
function init(rawKey) {
    _key = loadKey(rawKey);
}

/**
 * @returns {boolean} Whether encryption is available.
 */
function isEnabled() {
    return _key !== null;
}

/**
 * Check if a string is already encrypted (has the enc: prefix).
 * @param {string} text
 * @returns {boolean}
 */
function isEncrypted(text) {
    return typeof text === 'string' && text.startsWith(PREFIX);
}

/**
 * Encrypt plaintext. Returns "enc:<iv>:<tag>:<ciphertext>" (base64).
 * If encryption is not enabled, returns the plaintext unchanged.
 * @param {string} plaintext
 * @returns {string}
 */
function encrypt(plaintext) {
    if (!_key) return plaintext;
    if (isEncrypted(plaintext)) return plaintext; // already encrypted

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, _key, iv, { authTagLength: TAG_LENGTH });

    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return PREFIX + [iv, tag, encrypted].map(b => b.toString('base64')).join(':');
}

/**
 * Decrypt an encrypted string. Returns plaintext.
 * If the string is not encrypted (no prefix), returns it as-is (backward compat).
 * @param {string} text
 * @returns {string}
 */
function decrypt(text) {
    if (!isEncrypted(text)) return text; // plaintext passthrough

    if (!_key) {
        throw new Error('Cannot decrypt: CLAWMARK_ENCRYPTION_KEY is not configured');
    }

    const parts = text.slice(PREFIX.length).split(':');
    if (parts.length !== 3) {
        throw new Error('Invalid encrypted format');
    }

    const [ivB64, tagB64, ciphertextB64] = parts;
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ciphertext = Buffer.from(ciphertextB64, 'base64');

    const decipher = crypto.createDecipheriv(ALGORITHM, _key, iv, { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(tag);

    return decipher.update(ciphertext) + decipher.final('utf8');
}

module.exports = { init, isEnabled, isEncrypted, encrypt, decrypt, PREFIX };
