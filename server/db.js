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

    // ------------------------------------------------------------------ schema
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

        CREATE INDEX IF NOT EXISTS idx_items_app_doc   ON items(app_id, doc);
        CREATE INDEX IF NOT EXISTS idx_items_status    ON items(status);
        CREATE INDEX IF NOT EXISTS idx_items_type      ON items(type);
        CREATE INDEX IF NOT EXISTS idx_items_assignee  ON items(assignee);
        CREATE INDEX IF NOT EXISTS idx_messages_item   ON messages(item_id);
    `);

    // ---------------------------------------------------- prepared statements
    const stmts = {
        insertItem: db.prepare(`
            INSERT INTO items
                (id, app_id, doc, type, status, priority, title, quote,
                 quote_position, assignee, created_by, created_at, updated_at,
                 version, metadata)
            VALUES
                (@id, @app_id, @doc, @type, @status, @priority, @title, @quote,
                 @quote_position, @assignee, @created_by, @created_at, @updated_at,
                 @version, @metadata)
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

    // ------------------------------------------------------------- public API

    function createItem({ app_id = 'default', doc, type = 'discuss', title, quote,
                          quote_position, priority = 'normal', created_by, version, message }) {
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
            metadata: '{}'
        });

        if (message) {
            stmts.insertMessage.run({
                id: genId('msg'), item_id: itemId,
                role: 'user', content: message,
                user_name: created_by, pending: 0, created_at: now
            });
        }

        return { id: itemId, app_id, doc, type, status: 'open', created_at: now };
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
    };
}

module.exports = { initDb };
