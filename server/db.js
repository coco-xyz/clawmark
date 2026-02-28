/**
 * ClawMark — db.js
 * SQLite database layer for items and messages.
 *
 * Configuration via environment variables or an explicit config object:
 *   CLAWMARK_DATA_DIR  — directory that holds clawmark.db and the legacy JSON data dir
 *
 * The module exports a factory `initDb(dataDir)` that returns the db API,
 * so the server can pass the resolved data directory at startup.
 */

'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Generate a unique ID with a given prefix
function genId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Initialize the database at `dataDir/clawmark.db`.
 *
 * @param {string} dataDir  Absolute path to the data directory.
 * @returns {object}        The ClawMark DB API.
 */
function initDb(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });

    const dbPath = path.join(dataDir, 'clawmark.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // ------------------------------------------------- schema: base tables
    // Create tables without V2 columns first (safe for both new and existing DBs)
    db.exec(`
        CREATE TABLE IF NOT EXISTS items (
            id              TEXT PRIMARY KEY,
            app_id          TEXT NOT NULL DEFAULT 'default',
            doc             TEXT NOT NULL,
            type            TEXT NOT NULL DEFAULT 'discuss',
            status          TEXT NOT NULL DEFAULT 'open',
            priority        TEXT DEFAULT 'normal',
            title           TEXT,
            quote           TEXT,
            quote_position  TEXT,
            assignee        TEXT,
            created_by      TEXT NOT NULL,
            created_at      TEXT NOT NULL,
            updated_at      TEXT NOT NULL,
            resolved_at     TEXT,
            verified_at     TEXT,
            version         TEXT,
            metadata        TEXT DEFAULT '{}'
        );

        CREATE TABLE IF NOT EXISTS messages (
            id          TEXT PRIMARY KEY,
            item_id     TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
            role        TEXT NOT NULL,
            content     TEXT NOT NULL,
            user_name   TEXT,
            pending     INTEGER DEFAULT 0,
            created_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS api_keys (
            id          TEXT PRIMARY KEY,
            app_id      TEXT NOT NULL DEFAULT 'default',
            key         TEXT NOT NULL UNIQUE,
            name        TEXT,
            created_by  TEXT NOT NULL,
            created_at  TEXT NOT NULL,
            last_used   TEXT,
            revoked     INTEGER DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_items_app_doc   ON items(app_id, doc);
        CREATE INDEX IF NOT EXISTS idx_items_status    ON items(status);
        CREATE INDEX IF NOT EXISTS idx_items_type      ON items(type);
        CREATE INDEX IF NOT EXISTS idx_items_assignee  ON items(assignee);
        CREATE INDEX IF NOT EXISTS idx_messages_item   ON messages(item_id);
        CREATE INDEX IF NOT EXISTS idx_api_keys_key    ON api_keys(key);

        CREATE TABLE IF NOT EXISTS adapter_mappings (
            item_id     TEXT NOT NULL,
            adapter     TEXT NOT NULL,
            channel     TEXT NOT NULL DEFAULT '',
            external_id TEXT NOT NULL,
            external_url TEXT,
            created_at  TEXT NOT NULL,
            PRIMARY KEY (item_id, adapter, channel)
        );
        CREATE INDEX IF NOT EXISTS idx_adapter_mappings_external
            ON adapter_mappings(adapter, external_id);

        CREATE TABLE IF NOT EXISTS user_rules (
            id              TEXT PRIMARY KEY,
            user_name       TEXT NOT NULL,
            rule_type       TEXT NOT NULL,
            pattern         TEXT,
            target_type     TEXT NOT NULL,
            target_config   TEXT NOT NULL,
            priority        INTEGER DEFAULT 0,
            enabled         INTEGER DEFAULT 1,
            created_at      TEXT NOT NULL,
            updated_at      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_user_rules_user ON user_rules(user_name, priority DESC);

        CREATE TABLE IF NOT EXISTS users (
            id              TEXT PRIMARY KEY,
            google_id       TEXT UNIQUE,
            email           TEXT NOT NULL UNIQUE,
            name            TEXT NOT NULL,
            picture         TEXT,
            role            TEXT NOT NULL DEFAULT 'member',
            created_at      TEXT NOT NULL,
            last_login      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);
        CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

        CREATE TABLE IF NOT EXISTS endpoints (
            id          TEXT PRIMARY KEY,
            user_name   TEXT NOT NULL,
            name        TEXT NOT NULL,
            type        TEXT NOT NULL,
            config      TEXT NOT NULL DEFAULT '{}',
            is_default  INTEGER DEFAULT 0,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_endpoints_user_default ON endpoints(user_name, is_default);

        CREATE TABLE IF NOT EXISTS apps (
            id          TEXT PRIMARY KEY,
            user_id     TEXT NOT NULL,
            name        TEXT NOT NULL,
            description TEXT,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_apps_user ON apps(user_id);
    `);

    // ------------------------------------------- schema migration: V2 columns
    // Add V2 columns to existing databases that lack them.
    const existingCols = db.pragma('table_info(items)').map(c => c.name);
    const v2Columns = [
        ['source_url',   'TEXT'],
        ['source_title', 'TEXT'],
        ['tags',         "TEXT DEFAULT '[]'"],
        ['screenshots',  "TEXT DEFAULT '[]'"],
    ];
    for (const [col, typedef] of v2Columns) {
        if (!existingCols.includes(col)) {
            db.exec(`ALTER TABLE items ADD COLUMN ${col} ${typedef}`);
            console.log(`[db] migrated: added column items.${col}`);
        }
    }

    // V2 indexes (safe to run after migration)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_items_source_url ON items(source_url)`);

    // ---------------------------------------------------- prepared statements
    const stmts = {
        insertItem: db.prepare(`
            INSERT INTO items
                (id, app_id, doc, type, status, priority, title, quote,
                 quote_position, assignee, created_by, created_at, updated_at,
                 version, metadata, source_url, source_title, tags, screenshots)
            VALUES
                (@id, @app_id, @doc, @type, @status, @priority, @title, @quote,
                 @quote_position, @assignee, @created_by, @created_at, @updated_at,
                 @version, @metadata, @source_url, @source_title, @tags, @screenshots)
        `),
        insertMessage: db.prepare(`
            INSERT INTO messages (id, item_id, role, content, user_name, pending, created_at)
            VALUES (@id, @item_id, @role, @content, @user_name, @pending, @created_at)
        `),
        getItem: db.prepare('SELECT * FROM items WHERE id = ?'),
        getQueue: db.prepare(`
            SELECT * FROM items
            WHERE status IN ('open', 'in_progress')
            ORDER BY
                CASE priority
                    WHEN 'critical' THEN 0
                    WHEN 'high'     THEN 1
                    WHEN 'normal'   THEN 2
                    WHEN 'low'      THEN 3
                END,
                created_at ASC
        `),
        getMessages: db.prepare('SELECT * FROM messages WHERE item_id = ? ORDER BY created_at ASC'),
        updateItemStatus: db.prepare(`
            UPDATE items
            SET status = @status, updated_at = @updated_at,
                resolved_at = @resolved_at, verified_at = @verified_at
            WHERE id = @id
        `),
        updateItemAssignee: db.prepare(`
            UPDATE items
            SET assignee = @assignee, status = @status, updated_at = @updated_at
            WHERE id = @id
        `),
        updatePendingMessage: db.prepare(`
            UPDATE messages
            SET content = ?, pending = 0, created_at = ?
            WHERE item_id = ? AND pending = 1
        `),
        countByDocAndStatus: db.prepare(`
            SELECT status, COUNT(*) as count FROM items WHERE doc = ? GROUP BY status
        `),
        countAll: db.prepare(`
            SELECT type, status, COUNT(*) as count FROM items GROUP BY type, status
        `),
    };

    // ------------------------------------------------- endpoint statements
    const endpointStmts = {
        insertEndpoint: db.prepare(`
            INSERT INTO endpoints (id, user_name, name, type, config, is_default, created_at, updated_at)
            VALUES (@id, @user_name, @name, @type, @config, @is_default, @created_at, @updated_at)
        `),
        getEndpointsByUser: db.prepare(
            'SELECT * FROM endpoints WHERE user_name = ? ORDER BY is_default DESC, created_at ASC'
        ),
        getEndpointById: db.prepare('SELECT * FROM endpoints WHERE id = ?'),
        updateEndpoint: db.prepare(`
            UPDATE endpoints
            SET name = @name, type = @type, config = @config, updated_at = @updated_at
            WHERE id = @id
        `),
        deleteEndpoint: db.prepare('DELETE FROM endpoints WHERE id = ?'),
        clearDefaultForUser: db.prepare(
            'UPDATE endpoints SET is_default = 0, updated_at = ? WHERE user_name = ? AND is_default = 1'
        ),
        setDefault: db.prepare(
            'UPDATE endpoints SET is_default = 1, updated_at = ? WHERE id = ?'
        ),
    };

    // ------------------------------------------------- user_rules statements
    const ruleStmts = {
        insertRule: db.prepare(`
            INSERT INTO user_rules (id, user_name, rule_type, pattern, target_type, target_config, priority, enabled, created_at, updated_at)
            VALUES (@id, @user_name, @rule_type, @pattern, @target_type, @target_config, @priority, @enabled, @created_at, @updated_at)
        `),
        getRulesByUser: db.prepare(
            'SELECT * FROM user_rules WHERE user_name = ? ORDER BY priority DESC, created_at ASC'
        ),
        getRuleById: db.prepare('SELECT * FROM user_rules WHERE id = ?'),
        updateRule: db.prepare(`
            UPDATE user_rules
            SET rule_type = @rule_type, pattern = @pattern, target_type = @target_type,
                target_config = @target_config, priority = @priority, enabled = @enabled, updated_at = @updated_at
            WHERE id = @id
        `),
        deleteRule: db.prepare('DELETE FROM user_rules WHERE id = ?'),
        getAllRules: db.prepare('SELECT * FROM user_rules ORDER BY user_name, priority DESC'),
    };

    // ------------------------------------------------------------- public API

    function createItem({ app_id = 'default', doc, type = 'discuss', title, quote,
                          quote_position, priority = 'normal', created_by, version, message,
                          source_url, source_title, tags, screenshots }) {
        const now = new Date().toISOString();
        const itemId = genId(type === 'issue' ? 'issue' : 'disc');

        stmts.insertItem.run({
            id: itemId, app_id, doc, type,
            status: 'open', priority,
            title: title || null,
            quote: quote || null,
            quote_position: quote_position || null,
            assignee: null,
            created_by,
            created_at: now,
            updated_at: now,
            version: version || 'latest',
            metadata: '{}',
            source_url: source_url || null,
            source_title: source_title || null,
            tags: JSON.stringify(tags || []),
            screenshots: JSON.stringify(screenshots || []),
        });

        if (message) {
            stmts.insertMessage.run({
                id: genId('msg'), item_id: itemId,
                role: 'user', content: message,
                user_name: created_by, pending: 0, created_at: now
            });
        }

        return { id: itemId, app_id, doc, type, status: 'open', priority,
                 title: title || null, quote: quote || null,
                 created_by, created_at: now, message: message || null,
                 source_url: source_url || null, source_title: source_title || null,
                 tags: tags || [], screenshots: screenshots || [] };
    }

    function addMessage({ item_id, role, content, user_name }) {
        const now = new Date().toISOString();
        const msgId = genId('msg');

        stmts.insertMessage.run({
            id: msgId, item_id,
            role, content,
            user_name: user_name || null,
            pending: 0, created_at: now
        });

        db.prepare('UPDATE items SET updated_at = ? WHERE id = ?').run(now, item_id);
        return { id: msgId, created_at: now };
    }

    function respondToItem(item_id, response) {
        const now = new Date().toISOString();
        const updated = stmts.updatePendingMessage.run(response, now, item_id);
        if (updated.changes === 0) {
            stmts.insertMessage.run({
                id: genId('msg'), item_id,
                role: 'assistant', content: response,
                user_name: null, pending: 0, created_at: now
            });
        }
        db.prepare('UPDATE items SET updated_at = ? WHERE id = ?').run(now, item_id);
        return { success: true };
    }

    function assignItem(item_id, assignee) {
        const now = new Date().toISOString();
        const result = stmts.updateItemAssignee.run({ id: item_id, assignee, status: 'in_progress', updated_at: now });
        return { success: result.changes > 0, changes: result.changes };
    }

    function resolveItem(item_id) {
        const now = new Date().toISOString();
        const result = stmts.updateItemStatus.run({ id: item_id, status: 'resolved', updated_at: now, resolved_at: now, verified_at: null });
        return { success: result.changes > 0, changes: result.changes };
    }

    function verifyItem(item_id) {
        const now = new Date().toISOString();
        const result = stmts.updateItemStatus.run({ id: item_id, status: 'verified', updated_at: now, resolved_at: null, verified_at: now });
        return { success: result.changes > 0, changes: result.changes };
    }

    function reopenItem(item_id) {
        const now = new Date().toISOString();
        const result = stmts.updateItemStatus.run({ id: item_id, status: 'open', updated_at: now, resolved_at: null, verified_at: null });
        return { success: result.changes > 0, changes: result.changes };
    }

    function closeItem(item_id) {
        const now = new Date().toISOString();
        const result = stmts.updateItemStatus.run({ id: item_id, status: 'closed', updated_at: now, resolved_at: null, verified_at: null });
        return { success: result.changes > 0, changes: result.changes };
    }

    function getItem(id) {
        const item = stmts.getItem.get(id);
        if (!item) return null;
        item.messages = stmts.getMessages.all(id);
        return item;
    }

    function getItems({ app_id, doc, type, status, assignee } = {}) {
        let query = 'SELECT * FROM items WHERE 1=1';
        const params = [];
        if (app_id)  { query += ' AND app_id = ?';  params.push(app_id); }
        if (doc)     { query += ' AND doc = ?';      params.push(doc); }
        if (type)    { query += ' AND type = ?';     params.push(type); }
        if (status)  { query += ' AND status = ?';   params.push(status); }
        if (assignee){ query += ' AND assignee = ?'; params.push(assignee); }
        query += ' ORDER BY created_at DESC';
        return db.prepare(query).all(...params);
    }

    function getQueue() {
        return stmts.getQueue.all();
    }

    function getStats(doc) {
        if (doc) return stmts.countByDocAndStatus.all(doc);
        return stmts.countAll.all();
    }

    function getPending() {
        return db.prepare(`
            SELECT i.id as item_id, i.app_id, i.doc, i.quote, i.type,
                   m.content as last_message
            FROM items i
            JOIN messages m ON m.item_id = i.id AND m.pending = 1
            ORDER BY i.created_at DESC
        `).all();
    }

    // ---------------------------------------------------------- V2 query methods

    function getItemsByUrl({ app_id = 'default', url }) {
        return db.prepare(
            'SELECT * FROM items WHERE app_id = ? AND source_url = ? ORDER BY created_at DESC'
        ).all(app_id, url);
    }

    function getItemsByTag({ app_id = 'default', tag }) {
        // SQLite JSON: tags is stored as '["bug","ui"]', search with LIKE
        return db.prepare(
            `SELECT * FROM items WHERE app_id = ? AND tags LIKE ? ORDER BY created_at DESC`
        ).all(app_id, `%"${tag}"%`);
    }

    function getDistinctUrls(app_id = 'default') {
        return db.prepare(
            `SELECT DISTINCT source_url, source_title, COUNT(*) as item_count
             FROM items
             WHERE app_id = ? AND source_url IS NOT NULL
             GROUP BY source_url
             ORDER BY MAX(created_at) DESC`
        ).all(app_id);
    }

    function updateItemTags(item_id, tags) {
        const now = new Date().toISOString();
        return db.prepare(
            'UPDATE items SET tags = ?, updated_at = ? WHERE id = ?'
        ).run(JSON.stringify(tags), now, item_id);
    }

    // ---------------------------------------------------------- API key methods

    function createApiKey({ app_id = 'default', name, created_by }) {
        const now = new Date().toISOString();
        const id = genId('key');
        const key = 'cmk_' + require('crypto').randomBytes(24).toString('hex');
        db.prepare(
            `INSERT INTO api_keys (id, app_id, key, name, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
        ).run(id, app_id, key, name || null, created_by, now);
        return { id, key, app_id, name, created_at: now };
    }

    function validateApiKey(key) {
        const row = db.prepare(
            'SELECT * FROM api_keys WHERE key = ? AND revoked = 0'
        ).get(key);
        if (row) {
            db.prepare('UPDATE api_keys SET last_used = ? WHERE id = ?')
              .run(new Date().toISOString(), row.id);
        }
        return row || null;
    }

    function revokeApiKey(id) {
        return db.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ?').run(id);
    }

    // ----------------------------------------------------- user rules methods

    function createUserRule({ user_name, rule_type, pattern, target_type, target_config, priority = 0, enabled = 1 }) {
        const now = new Date().toISOString();
        const id = genId('rule');
        ruleStmts.insertRule.run({
            id, user_name, rule_type,
            pattern: pattern || null,
            target_type,
            target_config: typeof target_config === 'string' ? target_config : JSON.stringify(target_config),
            priority, enabled,
            created_at: now, updated_at: now,
        });
        return { id, user_name, rule_type, pattern, target_type, target_config, priority, enabled, created_at: now };
    }

    function getUserRules(user_name) {
        return ruleStmts.getRulesByUser.all(user_name);
    }

    function getUserRule(id) {
        return ruleStmts.getRuleById.get(id) || null;
    }

    function updateUserRule(id, updates) {
        const existing = ruleStmts.getRuleById.get(id);
        if (!existing) return null;
        const now = new Date().toISOString();
        const merged = {
            id,
            rule_type: updates.rule_type ?? existing.rule_type,
            pattern: updates.pattern !== undefined ? updates.pattern : existing.pattern,
            target_type: updates.target_type ?? existing.target_type,
            target_config: updates.target_config
                ? (typeof updates.target_config === 'string' ? updates.target_config : JSON.stringify(updates.target_config))
                : existing.target_config,
            priority: updates.priority ?? existing.priority,
            enabled: updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : existing.enabled,
            updated_at: now,
        };
        ruleStmts.updateRule.run(merged);
        return ruleStmts.getRuleById.get(id);
    }

    function deleteUserRule(id) {
        const result = ruleStmts.deleteRule.run(id);
        return { success: result.changes > 0 };
    }

    function getAllUserRules() {
        return ruleStmts.getAllRules.all();
    }

    // ---------------------------------------------------- endpoint methods

    function createEndpoint({ user_name, name, type, config, is_default = 0 }) {
        const now = new Date().toISOString();
        const id = genId('ep');
        const configStr = typeof config === 'string' ? config : JSON.stringify(config || {});

        // If this is the first endpoint for the user, make it default
        const existing = endpointStmts.getEndpointsByUser.all(user_name);
        const shouldDefault = existing.length === 0 ? 1 : (is_default ? 1 : 0);

        if (shouldDefault) {
            endpointStmts.clearDefaultForUser.run(now, user_name);
        }

        endpointStmts.insertEndpoint.run({
            id, user_name, name, type,
            config: configStr,
            is_default: shouldDefault,
            created_at: now, updated_at: now,
        });
        return { id, user_name, name, type, config: configStr, is_default: shouldDefault, created_at: now, updated_at: now };
    }

    function getEndpoints(user_name) {
        return endpointStmts.getEndpointsByUser.all(user_name);
    }

    function getEndpoint(id) {
        return endpointStmts.getEndpointById.get(id) || null;
    }

    function updateEndpoint(id, updates) {
        const existing = endpointStmts.getEndpointById.get(id);
        if (!existing) return null;
        const now = new Date().toISOString();
        const merged = {
            id,
            name: updates.name ?? existing.name,
            type: updates.type ?? existing.type,
            config: updates.config
                ? (typeof updates.config === 'string' ? updates.config : JSON.stringify(updates.config))
                : existing.config,
            updated_at: now,
        };
        endpointStmts.updateEndpoint.run(merged);
        return endpointStmts.getEndpointById.get(id);
    }

    function deleteEndpoint(id) {
        const existing = endpointStmts.getEndpointById.get(id);
        if (!existing) return { success: false };
        const result = endpointStmts.deleteEndpoint.run(id);
        // If we deleted the default, promote the next one
        if (existing.is_default) {
            const remaining = endpointStmts.getEndpointsByUser.all(existing.user_name);
            if (remaining.length > 0) {
                const now = new Date().toISOString();
                endpointStmts.setDefault.run(now, remaining[0].id);
            }
        }
        return { success: result.changes > 0 };
    }

    function setEndpointDefault(id) {
        const existing = endpointStmts.getEndpointById.get(id);
        if (!existing) return null;
        const now = new Date().toISOString();
        endpointStmts.clearDefaultForUser.run(now, existing.user_name);
        endpointStmts.setDefault.run(now, id);
        return endpointStmts.getEndpointById.get(id);
    }

    // ---------------------------------------------------------- app methods

    function createApp({ user_id, name, description }) {
        const now = new Date().toISOString();
        const id = genId('app');
        db.prepare(
            `INSERT INTO apps (id, user_id, name, description, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`
        ).run(id, user_id, name, description || null, now, now);

        // Auto-generate an AppKey for the new app
        const key = createApiKey({ app_id: id, name: `${name} key`, created_by: user_id });

        return {
            id, user_id, name, description: description || null,
            created_at: now, updated_at: now,
            key: key.key, key_id: key.id,
        };
    }

    function getApp(id) {
        return db.prepare('SELECT * FROM apps WHERE id = ?').get(id) || null;
    }

    function getAppsByUser(user_id) {
        return db.prepare(
            'SELECT * FROM apps WHERE user_id = ? ORDER BY created_at DESC'
        ).all(user_id);
    }

    function updateApp(id, updates) {
        const existing = db.prepare('SELECT * FROM apps WHERE id = ?').get(id);
        if (!existing) return null;
        const now = new Date().toISOString();
        const name = updates.name ?? existing.name;
        const description = updates.description !== undefined ? updates.description : existing.description;
        db.prepare(
            'UPDATE apps SET name = ?, description = ?, updated_at = ? WHERE id = ?'
        ).run(name, description, now, id);
        return { ...existing, name, description, updated_at: now };
    }

    function deleteApp(id) {
        const existing = db.prepare('SELECT * FROM apps WHERE id = ?').get(id);
        if (!existing) return { success: false };
        // Revoke all keys for this app
        db.prepare('UPDATE api_keys SET revoked = 1 WHERE app_id = ?').run(id);
        const result = db.prepare('DELETE FROM apps WHERE id = ?').run(id);
        return { success: result.changes > 0 };
    }

    function getAppKeys(app_id) {
        return db.prepare(
            'SELECT id, app_id, key, name, created_by, created_at, last_used, revoked FROM api_keys WHERE app_id = ? ORDER BY created_at DESC'
        ).all(app_id);
    }

    function rotateAppKey(app_id, created_by) {
        const now = new Date().toISOString();
        // Revoke existing active keys for this app
        db.prepare('UPDATE api_keys SET revoked = 1 WHERE app_id = ? AND revoked = 0').run(app_id);
        // Create a new key
        const app = db.prepare('SELECT name FROM apps WHERE id = ?').get(app_id);
        const keyName = app ? `${app.name} key` : 'rotated key';
        return createApiKey({ app_id, name: keyName, created_by });
    }

    // ------------------------------------------------- adapter mapping methods

    function setAdapterMapping({ item_id, adapter, channel = '', external_id, external_url }) {
        const now = new Date().toISOString();
        db.prepare(`
            INSERT OR REPLACE INTO adapter_mappings
                (item_id, adapter, channel, external_id, external_url, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(item_id, adapter, channel, String(external_id), external_url || null, now);
    }

    function getAdapterMapping({ item_id, adapter, channel = '' }) {
        return db.prepare(
            'SELECT * FROM adapter_mappings WHERE item_id = ? AND adapter = ? AND channel = ?'
        ).get(item_id, adapter, channel) || null;
    }

    function getAdapterMappingByExternalId({ adapter, external_id }) {
        return db.prepare(
            'SELECT * FROM adapter_mappings WHERE adapter = ? AND external_id = ?'
        ).get(adapter, String(external_id)) || null;
    }

    // --------------------------------------------------- JSON migration (opt-in)
    /**
     * Migrate legacy JSON discussion files into SQLite.
     * Only runs when the database is empty. Pass the path to the old data/
     * directory that contained the per-doc *.json files.
     *
     * @param {string} legacyDataDir  Path to the old `data/` folder.
     */
    function migrateFromJson(legacyDataDir) {
        if (!legacyDataDir) return;

        const count = db.prepare('SELECT COUNT(*) as c FROM items').get().c;
        if (count > 0) {
            console.log(`[db] Already has ${count} items, skipping JSON migration`);
            return;
        }

        if (!fs.existsSync(legacyDataDir)) {
            console.log('[db] Legacy data directory not found, skipping migration');
            return;
        }

        const files = fs.readdirSync(legacyDataDir).filter(f => f.endsWith('.json'));
        let migrated = 0;

        const migrate = db.transaction(() => {
            for (const file of files) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(legacyDataDir, file), 'utf8'));
                    const docId = data.docId || file.replace('.json', '').replace(/_/g, '/');

                    for (const disc of (data.discussions || [])) {
                        const now = disc.createdAt || new Date().toISOString();
                        const itemId = disc.id || genId('disc');

                        stmts.insertItem.run({
                            id: itemId, app_id: 'default', doc: docId,
                            type: 'discuss',
                            status: disc.applied ? 'resolved' : 'open',
                            priority: 'normal', title: null,
                            quote: disc.quote || null, quote_position: null,
                            assignee: null,
                            created_by: disc.messages?.[0]?.userName || 'unknown',
                            created_at: now, updated_at: now,
                            version: disc.version || 'latest', metadata: '{}'
                        });

                        for (const msg of (disc.messages || [])) {
                            stmts.insertMessage.run({
                                id: genId('msg'), item_id: itemId,
                                role: msg.role, content: msg.content,
                                user_name: msg.userName || null,
                                pending: msg.pending ? 1 : 0,
                                created_at: msg.timestamp || now
                            });
                        }

                        migrated++;
                    }
                } catch (err) {
                    console.error(`[-] Migration error in ${file}:`, err.message);
                }
            }
        });

        migrate();
        console.log(`[db] Migrated ${migrated} discussions from JSON to SQLite`);
    }

    // ---------------------------------------------------------- user methods

    function upsertUser({ google_id, email, name, picture }) {
        const now = new Date().toISOString();
        const existing = db.prepare('SELECT * FROM users WHERE google_id = ?').get(google_id);
        if (existing) {
            db.prepare(
                'UPDATE users SET email = ?, name = ?, picture = ?, last_login = ? WHERE id = ?'
            ).run(email, name, picture || null, now, existing.id);
            return { ...existing, email, name, picture, last_login: now };
        }
        const id = genId('user');
        db.prepare(
            `INSERT INTO users (id, google_id, email, name, picture, role, created_at, last_login)
             VALUES (?, ?, ?, ?, ?, 'member', ?, ?)`
        ).run(id, google_id, email, name, picture || null, now, now);
        return { id, google_id, email, name, picture, role: 'member', created_at: now, last_login: now };
    }

    function getUserById(id) {
        return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
    }

    function getUserByEmail(email) {
        return db.prepare('SELECT * FROM users WHERE email = ?').get(email) || null;
    }

    return {
        db,
        genId,
        createItem,
        addMessage,
        respondToItem,
        assignItem,
        resolveItem,
        verifyItem,
        reopenItem,
        closeItem,
        getItem,
        getItems,
        getQueue,
        getStats,
        getPending,
        migrateFromJson,
        // V2
        getItemsByUrl,
        getItemsByTag,
        getDistinctUrls,
        updateItemTags,
        createApiKey,
        validateApiKey,
        revokeApiKey,
        // Adapter mappings
        setAdapterMapping,
        getAdapterMapping,
        getAdapterMappingByExternalId,
        // User routing rules
        createUserRule,
        getUserRules,
        getUserRule,
        updateUserRule,
        deleteUserRule,
        getAllUserRules,
        // Users
        upsertUser,
        getUserById,
        getUserByEmail,
        // Endpoints
        createEndpoint,
        getEndpoints,
        getEndpoint,
        updateEndpoint,
        deleteEndpoint,
        setEndpointDefault,
        // Apps
        createApp,
        getApp,
        getAppsByUser,
        updateApp,
        deleteApp,
        getAppKeys,
        rotateAppKey,
    };
}

module.exports = { initDb };
