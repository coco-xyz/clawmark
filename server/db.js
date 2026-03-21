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
const { encrypt, decrypt, isEncrypted } = require('./crypto');

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
            org_id      TEXT,
            is_default  INTEGER DEFAULT 0,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_apps_user ON apps(user_id);

        CREATE TABLE IF NOT EXISTS organizations (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            slug        TEXT NOT NULL UNIQUE,
            description TEXT,
            created_by  TEXT NOT NULL,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_orgs_slug ON organizations(slug);
        CREATE INDEX IF NOT EXISTS idx_orgs_created_by ON organizations(created_by);

        CREATE TABLE IF NOT EXISTS user_auths (
            id          TEXT PRIMARY KEY,
            user_name   TEXT NOT NULL,
            name        TEXT NOT NULL,
            auth_type   TEXT NOT NULL,
            credentials TEXT NOT NULL DEFAULT '{}',
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_user_auths_user ON user_auths(user_name);
        CREATE INDEX IF NOT EXISTS idx_user_auths_type ON user_auths(user_name, auth_type);

        CREATE TABLE IF NOT EXISTS org_members (
            id          TEXT PRIMARY KEY,
            org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            user_id     TEXT NOT NULL,
            role        TEXT NOT NULL DEFAULT 'member',
            invited_by  TEXT,
            joined_at   TEXT NOT NULL,
            UNIQUE(org_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_org_members_org ON org_members(org_id);
        CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_id);
    `);

    // ------------------------------------------- schema migration: V2 columns
    // Add V2 columns to existing databases that lack them.
    const existingCols = db.pragma('table_info(items)').map(c => c.name);
    const v2Columns = [
        ['source_url',   'TEXT'],
        ['source_title', 'TEXT'],
        ['tags',         "TEXT DEFAULT '[]'"],
        ['screenshots',  "TEXT DEFAULT '[]'"],
        ['classification', 'TEXT'],
        ['classification_confidence', 'REAL'],
        ['classified_at', 'TEXT'],
    ];
    for (const [col, typedef] of v2Columns) {
        if (!existingCols.includes(col)) {
            db.exec(`ALTER TABLE items ADD COLUMN ${col} ${typedef}`);
            console.log(`[db] migrated: added column items.${col}`);
        }
    }

    // V2 indexes (safe to run after migration)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_items_source_url ON items(source_url)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_items_classification ON items(classification)`);

    // ----------------------------------------- schema migration: org_id columns
    // Add org_id column to apps and user_rules for existing databases.
    const appCols = db.pragma('table_info(apps)').map(c => c.name);
    if (!appCols.includes('org_id')) {
        db.exec(`ALTER TABLE apps ADD COLUMN org_id TEXT`);
        console.log('[db] migrated: added column apps.org_id');
    }

    const ruleCols = db.pragma('table_info(user_rules)').map(c => c.name);
    if (!ruleCols.includes('org_id')) {
        db.exec(`ALTER TABLE user_rules ADD COLUMN org_id TEXT`);
        console.log('[db] migrated: added column user_rules.org_id');
    }

    // org_id indexes (must run after migration adds the columns)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_apps_org ON apps(org_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_user_rules_org ON user_rules(org_id)`);

    // ----------------------------------------- schema migration: user_rules.auth_id
    const ruleColsAuth = db.pragma('table_info(user_rules)').map(c => c.name);
    if (!ruleColsAuth.includes('auth_id')) {
        db.exec(`ALTER TABLE user_rules ADD COLUMN auth_id TEXT`);
        console.log('[db] migrated: added column user_rules.auth_id');
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_user_rules_auth ON user_rules(auth_id)`);

    // ----------------------------------------- schema migration: dispatch_log.auth_id
    // NOTE: dispatch_log table is created further below. Only migrate if it already exists.
    const dlExistsAuth = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='dispatch_log'`).get();
    if (dlExistsAuth) {
        const dispatchCols = db.pragma('table_info(dispatch_log)').map(c => c.name);
        if (!dispatchCols.includes('auth_id')) {
            db.exec(`ALTER TABLE dispatch_log ADD COLUMN auth_id TEXT`);
            console.log('[db] migrated: added column dispatch_log.auth_id');
        }
    }

    // ----------------------------- schema migration: apps.is_default (data isolation Phase 1)
    const appCols2 = db.pragma('table_info(apps)').map(c => c.name);
    if (!appCols2.includes('is_default')) {
        db.exec(`ALTER TABLE apps ADD COLUMN is_default INTEGER DEFAULT 0`);
        console.log('[db] migrated: added column apps.is_default');
    }
    // UNIQUE constraint: only one default app per user.
    // SQLite partial unique indexes require version >= 3.8.0; safe on Node better-sqlite3.
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_user_default
             ON apps(user_id) WHERE is_default = 1`);

    // ----------------------------- schema migration: dispatch_log.app_id (data isolation Phase 1)
    // NOTE: dispatch_log table is created further below. Only migrate if it already exists.
    const dlTableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='dispatch_log'`).get();
    if (dlTableExists) {
        const dlColsP1 = db.pragma('table_info(dispatch_log)').map(c => c.name);
        if (!dlColsP1.includes('app_id')) {
            db.exec(`ALTER TABLE dispatch_log ADD COLUMN app_id TEXT`);
            console.log('[db] migrated: added column dispatch_log.app_id');
        }
        db.exec(`CREATE INDEX IF NOT EXISTS idx_dispatch_log_app ON dispatch_log(app_id)`);
    }

    // ----------------------------- schema migration: users.settings (per-user preferences)
    const userCols = db.pragma('table_info(users)').map(c => c.name);
    if (!userCols.includes('settings')) {
        db.exec(`ALTER TABLE users ADD COLUMN settings TEXT DEFAULT '{}'`);
        console.log('[db] migrated: added column users.settings');
    }

    // ----------------------------- migrations registry (GL#34: prevent repeated data wipes)
    db.exec(`
        CREATE TABLE IF NOT EXISTS _migrations (
            name        TEXT PRIMARY KEY,
            applied_at  TEXT NOT NULL
        )
    `);

    function runOnce(name, fn) {
        const row = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(name);
        if (row) return;
        fn();
        db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
        console.log(`[db] migration applied: ${name}`);
    }

    // ----------------------------- data migration: clear legacy test data (data isolation Phase 1)
    // Kevin directive: "don't do data migration — just clear the database and rebuild"
    // Runs ONCE via _migrations table (GL#34 fix — previously ran on every restart).
    runOnce('phase1_clear_legacy_data', () => {
        const legacyItems = db.prepare(`SELECT COUNT(*) AS cnt FROM items WHERE app_id = 'default'`).get();
        const legacyKeys = db.prepare(`SELECT COUNT(*) AS cnt FROM api_keys WHERE app_id = 'default'`).get();

        if (legacyItems.cnt > 0 || legacyKeys.cnt > 0) {
            console.log(`[db] Phase 1 cleanup: clearing legacy test data (${legacyItems.cnt} items, ${legacyKeys.cnt} keys with app_id='default')`);
            db.exec(`DELETE FROM items WHERE app_id = 'default'`);
            db.exec(`DELETE FROM api_keys WHERE app_id = 'default'`);
            if (dlTableExists) {
                db.exec(`DELETE FROM dispatch_log WHERE app_id IS NULL OR app_id = 'default'`);
            }
            db.exec(`DELETE FROM apps WHERE is_default = 0 OR is_default IS NULL`);
            console.log('[db] Phase 1 cleanup: legacy test data cleared. Users will get fresh apps on next login.');
        }
    });

    // ----------------------------------------- schema: dispatch_log (v0.6.0 #93)
    db.exec(`
        CREATE TABLE IF NOT EXISTS dispatch_log (
            id              TEXT PRIMARY KEY,
            item_id         TEXT NOT NULL,
            target_type     TEXT NOT NULL,
            target_config   TEXT NOT NULL DEFAULT '{}',
            event           TEXT NOT NULL DEFAULT 'item.created',
            status          TEXT NOT NULL DEFAULT 'pending',
            retries         INTEGER NOT NULL DEFAULT 0,
            last_error      TEXT,
            external_id     TEXT,
            external_url    TEXT,
            method          TEXT,
            app_id          TEXT,
            auth_id         TEXT,
            created_at      TEXT NOT NULL,
            updated_at      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_dispatch_log_item ON dispatch_log(item_id);
        CREATE INDEX IF NOT EXISTS idx_dispatch_log_status ON dispatch_log(status);
        CREATE INDEX IF NOT EXISTS idx_dispatch_log_app ON dispatch_log(app_id);
    `);

    // ----------------------------------------- schema migration: dispatch_log event column
    const dlCols = db.pragma('table_info(dispatch_log)').map(c => c.name);
    if (!dlCols.includes('event')) {
        db.exec(`ALTER TABLE dispatch_log ADD COLUMN event TEXT NOT NULL DEFAULT 'item.created'`);
    }

    // ----------------------------------------- schema migration: screenshot_analysis (#117)
    const itemCols2 = db.pragma('table_info(items)').map(c => c.name);
    if (!itemCols2.includes('screenshot_analysis')) {
        db.exec(`ALTER TABLE items ADD COLUMN screenshot_analysis TEXT`);
        console.log('[db] migrated: added column items.screenshot_analysis');
    }
    if (!itemCols2.includes('analyzed_at')) {
        db.exec(`ALTER TABLE items ADD COLUMN analyzed_at TEXT`);
        console.log('[db] migrated: added column items.analyzed_at');
    }

    // ----------------------------------------- schema: perception_events (#69 Error Sentinel)
    db.exec(`
        CREATE TABLE IF NOT EXISTS perception_events (
            id              TEXT PRIMARY KEY,
            app_id          TEXT NOT NULL,
            type            TEXT NOT NULL,
            message         TEXT NOT NULL,
            stack           TEXT,
            source          TEXT,
            line            INTEGER,
            severity        TEXT NOT NULL DEFAULT 'error',
            url             TEXT,
            fingerprint     TEXT NOT NULL,
            context         TEXT DEFAULT '{}',
            created_at      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_perception_app ON perception_events(app_id);
        CREATE INDEX IF NOT EXISTS idx_perception_fingerprint ON perception_events(app_id, fingerprint);
        CREATE INDEX IF NOT EXISTS idx_perception_created ON perception_events(app_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_perception_type ON perception_events(app_id, type);
    `);

    // ----------------------------------------- schema: perception_issues (#69 dedup tracking)
    db.exec(`
        CREATE TABLE IF NOT EXISTS perception_issues (
            id              TEXT PRIMARY KEY,
            app_id          TEXT NOT NULL,
            fingerprint     TEXT NOT NULL,
            gitlab_issue_id TEXT,
            gitlab_issue_url TEXT,
            first_seen      TEXT NOT NULL,
            last_seen       TEXT NOT NULL,
            count           INTEGER NOT NULL DEFAULT 1,
            status          TEXT NOT NULL DEFAULT 'open',
            UNIQUE(app_id, fingerprint)
        );
        CREATE INDEX IF NOT EXISTS idx_pissues_app ON perception_issues(app_id);
        CREATE INDEX IF NOT EXISTS idx_pissues_fp ON perception_issues(app_id, fingerprint);
    `);

    // ----------------------------------------- schema: sessions (#73 Session Storage)
    db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
            id              TEXT PRIMARY KEY,
            app_id          TEXT NOT NULL,
            agent_id        TEXT,
            tab_id          TEXT,
            url             TEXT,
            title           TEXT,
            start_time      TEXT NOT NULL,
            end_time        TEXT,
            event_count     INTEGER NOT NULL DEFAULT 0,
            snapshot_count  INTEGER NOT NULL DEFAULT 0,
            total_size      INTEGER NOT NULL DEFAULT 0,
            status          TEXT NOT NULL DEFAULT 'active',
            metadata        TEXT DEFAULT '{}',
            created_at      TEXT NOT NULL,
            updated_at      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_app ON sessions(app_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(app_id, agent_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_start ON sessions(app_id, start_time);
        CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS session_events (
            id              TEXT PRIMARY KEY,
            session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            type            TEXT NOT NULL,
            timestamp       TEXT NOT NULL,
            data            TEXT NOT NULL DEFAULT '{}',
            size            INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id);
        CREATE INDEX IF NOT EXISTS idx_session_events_ts ON session_events(session_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events(session_id, type);
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS session_snapshots (
            id              TEXT PRIMARY KEY,
            session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            trigger         TEXT NOT NULL DEFAULT 'manual',
            timestamp       TEXT NOT NULL,
            html            TEXT NOT NULL,
            size            INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_session_snapshots_session ON session_snapshots(session_id);
        CREATE INDEX IF NOT EXISTS idx_session_snapshots_ts ON session_snapshots(session_id, timestamp);
    `);

    // ------------------------------------------------- schema: agents table (#68)
    db.exec(`
        CREATE TABLE IF NOT EXISTS agents (
            id              TEXT PRIMARY KEY,
            app_id          TEXT NOT NULL,
            name            TEXT NOT NULL,
            key_hash        TEXT NOT NULL UNIQUE,
            key_prefix      TEXT NOT NULL,
            callback_url    TEXT,
            capabilities    TEXT DEFAULT '[]',
            status          TEXT NOT NULL DEFAULT 'active',
            created_by      TEXT NOT NULL,
            created_at      TEXT NOT NULL,
            updated_at      TEXT NOT NULL,
            last_seen       TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_agents_app ON agents(app_id);
        CREATE INDEX IF NOT EXISTS idx_agents_key_hash ON agents(key_hash);
        CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
        CREATE INDEX IF NOT EXISTS idx_agents_key_prefix ON agents(key_prefix);
    `);

    // ----------------------------------------- schema: agent_actions (#87 Dashboard)
    db.exec(`
        CREATE TABLE IF NOT EXISTS agent_actions (
            id              TEXT PRIMARY KEY,
            app_id          TEXT NOT NULL,
            agent_id        TEXT,
            action_type     TEXT NOT NULL,
            target_type     TEXT,
            target_id       TEXT,
            summary         TEXT NOT NULL,
            status          TEXT NOT NULL DEFAULT 'success',
            metadata        TEXT DEFAULT '{}',
            created_at      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_actions_app ON agent_actions(app_id);
        CREATE INDEX IF NOT EXISTS idx_agent_actions_agent ON agent_actions(app_id, agent_id);
        CREATE INDEX IF NOT EXISTS idx_agent_actions_type ON agent_actions(app_id, action_type);
        CREATE INDEX IF NOT EXISTS idx_agent_actions_created ON agent_actions(app_id, created_at);
    `);

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

    // ------------------------------------------------- perception statements (#69)
    const perceptionStmts = {
        insertEvent: db.prepare(`
            INSERT INTO perception_events
                (id, app_id, type, message, stack, source, line, severity, url, fingerprint, context, created_at)
            VALUES
                (@id, @app_id, @type, @message, @stack, @source, @line, @severity, @url, @fingerprint, @context, @created_at)
        `),
        getEvents: db.prepare(`
            SELECT * FROM perception_events
            WHERE app_id = ? AND created_at > ?
            ORDER BY created_at ASC
            LIMIT ?
        `),
        getEventsByFingerprint: db.prepare(`
            SELECT * FROM perception_events
            WHERE app_id = ? AND fingerprint = ?
            ORDER BY created_at DESC
            LIMIT ?
        `),
        countByFingerprint: db.prepare(`
            SELECT fingerprint, COUNT(*) as count, MIN(created_at) as first_seen, MAX(created_at) as last_seen
            FROM perception_events
            WHERE app_id = ?
            GROUP BY fingerprint
            ORDER BY count DESC
            LIMIT ?
        `),
        insertIssue: db.prepare(`
            INSERT OR IGNORE INTO perception_issues
                (id, app_id, fingerprint, first_seen, last_seen, count, status)
            VALUES
                (@id, @app_id, @fingerprint, @first_seen, @last_seen, @count, @status)
        `),
        getIssue: db.prepare(
            'SELECT * FROM perception_issues WHERE app_id = ? AND fingerprint = ?'
        ),
        updateIssue: db.prepare(`
            UPDATE perception_issues
            SET last_seen = @last_seen, count = @count,
                gitlab_issue_id = COALESCE(@gitlab_issue_id, gitlab_issue_id),
                gitlab_issue_url = COALESCE(@gitlab_issue_url, gitlab_issue_url)
            WHERE app_id = @app_id AND fingerprint = @fingerprint
        `),
        getOpenIssues: db.prepare(
            "SELECT * FROM perception_issues WHERE app_id = ? AND status = 'open' ORDER BY count DESC"
        ),
    };

    // ------------------------------------------------- session statements (#73)
    const sessionStmts = {
        insertSession: db.prepare(`
            INSERT INTO sessions
                (id, app_id, agent_id, tab_id, url, title, start_time, end_time,
                 event_count, snapshot_count, total_size, status, metadata, created_at, updated_at)
            VALUES
                (@id, @app_id, @agent_id, @tab_id, @url, @title, @start_time, @end_time,
                 @event_count, @snapshot_count, @total_size, @status, @metadata, @created_at, @updated_at)
        `),
        getSession: db.prepare('SELECT * FROM sessions WHERE id = ?'),
        listSessions: db.prepare(`
            SELECT id, app_id, agent_id, tab_id, url, title, start_time, end_time,
                   event_count, snapshot_count, total_size, status, created_at, updated_at
            FROM sessions
            WHERE app_id = ? AND start_time > ?
            ORDER BY start_time DESC
            LIMIT ?
        `),
        listSessionsByAgent: db.prepare(`
            SELECT id, app_id, agent_id, tab_id, url, title, start_time, end_time,
                   event_count, snapshot_count, total_size, status, created_at, updated_at
            FROM sessions
            WHERE app_id = ? AND agent_id = ? AND start_time > ?
            ORDER BY start_time DESC
            LIMIT ?
        `),
        listSessionsBySite: db.prepare(`
            SELECT id, app_id, agent_id, tab_id, url, title, start_time, end_time,
                   event_count, snapshot_count, total_size, status, created_at, updated_at
            FROM sessions
            WHERE app_id = ? AND url LIKE ? ESCAPE '\\' AND start_time > ?
            ORDER BY start_time DESC
            LIMIT ?
        `),
        updateSession: db.prepare(`
            UPDATE sessions
            SET end_time = @end_time, event_count = @event_count, snapshot_count = @snapshot_count,
                total_size = @total_size, status = @status, updated_at = @updated_at
            WHERE id = @id
        `),
        insertEvent: db.prepare(`
            INSERT INTO session_events (id, session_id, type, timestamp, data, size)
            VALUES (@id, @session_id, @type, @timestamp, @data, @size)
        `),
        getEvents: db.prepare(`
            SELECT * FROM session_events
            WHERE session_id = ?
            ORDER BY timestamp ASC
        `),
        getEventsInRange: db.prepare(`
            SELECT * FROM session_events
            WHERE session_id = ? AND timestamp >= ? AND timestamp <= ?
            ORDER BY timestamp ASC
        `),
        insertSnapshot: db.prepare(`
            INSERT INTO session_snapshots (id, session_id, trigger, timestamp, html, size)
            VALUES (@id, @session_id, @trigger, @timestamp, @html, @size)
        `),
        getSnapshots: db.prepare(`
            SELECT id, session_id, trigger, timestamp, size FROM session_snapshots
            WHERE session_id = ?
            ORDER BY timestamp ASC
        `),
        getSnapshot: db.prepare('SELECT * FROM session_snapshots WHERE id = ?'),
        deleteOldSessions: db.prepare(`
            DELETE FROM sessions WHERE status = 'completed' AND updated_at < ?
        `),
        deleteOrphanSessions: db.prepare(`
            DELETE FROM sessions WHERE status = 'active' AND updated_at < ?
        `),
        countByApp: db.prepare(`
            SELECT COUNT(*) AS count FROM sessions WHERE app_id = ?
        `),
    };

    // ------------------------------------------------- user_rules statements
    const ruleStmts = {
        insertRule: db.prepare(`
            INSERT INTO user_rules (id, user_name, rule_type, pattern, target_type, target_config, priority, enabled, auth_id, created_at, updated_at)
            VALUES (@id, @user_name, @rule_type, @pattern, @target_type, @target_config, @priority, @enabled, @auth_id, @created_at, @updated_at)
        `),
        getRulesByUser: db.prepare(
            'SELECT * FROM user_rules WHERE user_name = ? ORDER BY priority DESC, created_at ASC'
        ),
        getRuleById: db.prepare('SELECT * FROM user_rules WHERE id = ?'),
        updateRule: db.prepare(`
            UPDATE user_rules
            SET rule_type = @rule_type, pattern = @pattern, target_type = @target_type,
                target_config = @target_config, priority = @priority, enabled = @enabled,
                auth_id = @auth_id, updated_at = @updated_at
            WHERE id = @id
        `),
        deleteRule: db.prepare('DELETE FROM user_rules WHERE id = ?'),
        getAllRules: db.prepare('SELECT * FROM user_rules ORDER BY user_name, priority DESC'),
    };

    // ------------------------------------------------- agent statements (#68)
    const agentStmts = {
        insertAgent: db.prepare(`
            INSERT INTO agents (id, app_id, name, key_hash, key_prefix, callback_url, capabilities, status, created_by, created_at, updated_at)
            VALUES (@id, @app_id, @name, @key_hash, @key_prefix, @callback_url, @capabilities, @status, @created_by, @created_at, @updated_at)
        `),
        getAgentById: db.prepare('SELECT * FROM agents WHERE id = ?'),
        getAgentByKeyHash: db.prepare("SELECT * FROM agents WHERE key_hash = ? AND status = 'active'"),
        getAgentsByApp: db.prepare('SELECT id, app_id, name, key_prefix, callback_url, capabilities, status, created_by, created_at, updated_at, last_seen FROM agents WHERE app_id = ? ORDER BY created_at DESC'),
        updateAgent: db.prepare(`
            UPDATE agents SET name = @name, callback_url = @callback_url, capabilities = @capabilities, updated_at = @updated_at WHERE id = @id
        `),
        deactivateAgent: db.prepare("UPDATE agents SET status = 'inactive', updated_at = ? WHERE id = ?"),
        updateAgentLastSeen: db.prepare('UPDATE agents SET last_seen = ? WHERE id = ?'),
        updateAgentKey: db.prepare('UPDATE agents SET key_hash = @key_hash, key_prefix = @key_prefix, updated_at = @updated_at WHERE id = @id'),
    };

    // ------------------------------------------------- user_auths statements
    const authStmts = {
        insertAuth: db.prepare(`
            INSERT INTO user_auths (id, user_name, name, auth_type, credentials, created_at, updated_at)
            VALUES (@id, @user_name, @name, @auth_type, @credentials, @created_at, @updated_at)
        `),
        getAuthsByUser: db.prepare(
            'SELECT * FROM user_auths WHERE user_name = ? ORDER BY auth_type, created_at ASC'
        ),
        getAuthById: db.prepare('SELECT * FROM user_auths WHERE id = ?'),
        updateAuth: db.prepare(`
            UPDATE user_auths
            SET name = @name, auth_type = @auth_type, credentials = @credentials, updated_at = @updated_at
            WHERE id = @id
        `),
        deleteAuth: db.prepare('DELETE FROM user_auths WHERE id = ?'),
        countRulesUsingAuth: db.prepare(
            'SELECT COUNT(*) AS cnt FROM user_rules WHERE auth_id = ?'
        ),
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

    function getItemsByUrl({ app_id, url }) {
        if (app_id) {
            return db.prepare(
                'SELECT * FROM items WHERE app_id = ? AND source_url = ? ORDER BY created_at DESC'
            ).all(app_id, url);
        }
        return db.prepare(
            'SELECT * FROM items WHERE source_url = ? ORDER BY created_at DESC'
        ).all(url);
    }

    function getItemsByTag({ app_id, tag }) {
        // SQLite JSON: tags is stored as '["bug","ui"]', search with LIKE
        if (app_id) {
            return db.prepare(
                `SELECT * FROM items WHERE app_id = ? AND tags LIKE ? ORDER BY created_at DESC`
            ).all(app_id, `%"${tag}"%`);
        }
        return db.prepare(
            `SELECT * FROM items WHERE tags LIKE ? ORDER BY created_at DESC`
        ).all(`%"${tag}"%`);
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

    function updateItemClassification(item_id, classification, confidence) {
        const now = new Date().toISOString();
        return db.prepare(
            'UPDATE items SET classification = ?, classification_confidence = ?, classified_at = ?, updated_at = ? WHERE id = ?'
        ).run(classification, confidence, now, now, item_id);
    }

    function updateItemClassificationIfNull(item_id, classification, confidence) {
        const now = new Date().toISOString();
        return db.prepare(
            'UPDATE items SET classification = ?, classification_confidence = ?, classified_at = ?, updated_at = ? WHERE id = ? AND classification IS NULL'
        ).run(classification, confidence, now, now, item_id);
    }

    function updateItemScreenshotAnalysis(item_id, analysis) {
        const now = new Date().toISOString();
        return db.prepare(
            'UPDATE items SET screenshot_analysis = ?, analyzed_at = ?, updated_at = ? WHERE id = ?'
        ).run(JSON.stringify(analysis), now, now, item_id);
    }

    function getItemsByClassification({ app_id = 'default', classification, limit = 500 }) {
        return db.prepare(
            'SELECT * FROM items WHERE app_id = ? AND classification = ? ORDER BY created_at DESC LIMIT ?'
        ).all(app_id, classification, limit);
    }

    function updateItemTags(item_id, tags) {
        const now = new Date().toISOString();
        return db.prepare(
            'UPDATE items SET tags = ?, updated_at = ? WHERE id = ?'
        ).run(JSON.stringify(tags), now, item_id);
    }

    // ---------------------------------------------------------- API key methods

    function createApiKey({ app_id, name, created_by }) {
        if (!app_id || app_id === 'default') {
            throw new Error('app_id is required and cannot be "default" — create or resolve a user-specific app first');
        }
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

    function createUserRule({ user_name, rule_type, pattern, target_type, target_config, priority = 0, enabled = 1, auth_id = null }) {
        const now = new Date().toISOString();
        const id = genId('rule');
        ruleStmts.insertRule.run({
            id, user_name, rule_type,
            pattern: pattern || null,
            target_type,
            target_config: typeof target_config === 'string' ? target_config : JSON.stringify(target_config),
            priority, enabled,
            auth_id: auth_id || null,
            created_at: now, updated_at: now,
        });
        return { id, user_name, rule_type, pattern, target_type, target_config, priority, enabled, auth_id, created_at: now };
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
            auth_id: updates.auth_id !== undefined ? (updates.auth_id || null) : (existing.auth_id || null),
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

    // ----------------------------------------------------- user auth methods

    /** Decrypt credentials field in a user_auths row (in-place). */
    function decryptAuthRow(row) {
        if (!row) return row;
        if (isEncrypted(row.credentials)) {
            try {
                row.credentials = decrypt(row.credentials);
            } catch (err) {
                throw new Error(`Failed to decrypt credentials for auth ${row.id}: ${err.message}. Check CLAWMARK_ENCRYPTION_KEY.`);
            }
        }
        return row;
    }

    function createUserAuth({ user_name, name, auth_type, credentials }) {
        const now = new Date().toISOString();
        const id = genId('auth');
        const credStr = typeof credentials === 'string' ? credentials : JSON.stringify(credentials);
        authStmts.insertAuth.run({
            id, user_name, name,
            auth_type,
            credentials: encrypt(credStr),
            created_at: now, updated_at: now,
        });
        return { id, user_name, name, auth_type, credentials, created_at: now, updated_at: now };
    }

    function getUserAuths(user_name) {
        return authStmts.getAuthsByUser.all(user_name).map(decryptAuthRow);
    }

    function getUserAuth(id) {
        return decryptAuthRow(authStmts.getAuthById.get(id)) || null;
    }

    function updateUserAuth(id, updates) {
        const existing = authStmts.getAuthById.get(id);
        if (!existing) return null;
        const now = new Date().toISOString();
        let credStr;
        if (updates.credentials) {
            credStr = typeof updates.credentials === 'string' ? updates.credentials : JSON.stringify(updates.credentials);
            credStr = encrypt(credStr);
        } else {
            credStr = existing.credentials; // already encrypted (or plaintext legacy)
        }
        const merged = {
            id,
            name: updates.name ?? existing.name,
            auth_type: updates.auth_type ?? existing.auth_type,
            credentials: credStr,
            updated_at: now,
        };
        authStmts.updateAuth.run(merged);
        return decryptAuthRow(authStmts.getAuthById.get(id));
    }

    function deleteUserAuth(id) {
        // Check if any rules reference this auth
        const usage = authStmts.countRulesUsingAuth.get(id);
        if (usage && usage.cnt > 0) {
            return { success: false, error: `Auth is used by ${usage.cnt} rule(s). Remove them first.` };
        }
        const result = authStmts.deleteAuth.run(id);
        return { success: result.changes > 0 };
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

    /**
     * Get or create the default app for a user. Uses a UNIQUE partial index
     * on (user_id) WHERE is_default=1 to prevent race conditions.
     *
     * @param {string} userId  User's internal ID (from users table)
     * @param {string} email   User's email (used for naming)
     * @returns {object}       The default app row
     */
    function getOrCreateDefaultApp(userId, email) {
        // Try to find existing default app first
        const existing = db.prepare(
            'SELECT * FROM apps WHERE user_id = ? AND is_default = 1'
        ).get(userId);
        if (existing) return existing;

        // Create one — UNIQUE index on (user_id) WHERE is_default=1 prevents duplicates
        const now = new Date().toISOString();
        const id = genId('app');
        try {
            db.prepare(
                `INSERT INTO apps (id, user_id, name, description, is_default, created_at, updated_at)
                 VALUES (?, ?, ?, NULL, 1, ?, ?)`
            ).run(id, userId, `${email}'s app`, now, now);

            const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(id);

            // Auto-generate an AppKey for the new default app
            createApiKey({ app_id: id, name: `${email}'s app key`, created_by: email });

            return app;
        } catch (err) {
            // If UNIQUE constraint fires (race condition), another call won — just fetch theirs
            if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || (err.message && err.message.includes('UNIQUE'))) {
                return db.prepare(
                    'SELECT * FROM apps WHERE user_id = ? AND is_default = 1'
                ).get(userId);
            }
            throw err;
        }
    }

    function createApp({ user_id, name, description }) {
        const now = new Date().toISOString();
        const id = genId('app');
        db.prepare(
            `INSERT INTO apps (id, user_id, name, description, is_default, created_at, updated_at)
             VALUES (?, ?, ?, ?, 0, ?, ?)`
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

    // ------------------------------------------------- organization methods

    function createOrg({ name, slug, description, created_by }) {
        const now = new Date().toISOString();
        const id = genId('org');
        db.prepare(
            `INSERT INTO organizations (id, name, slug, description, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(id, name, slug, description || null, created_by, now, now);
        // Add creator as owner
        const memId = genId('mem');
        db.prepare(
            `INSERT INTO org_members (id, org_id, user_id, role, invited_by, joined_at)
             VALUES (?, ?, ?, 'owner', ?, ?)`
        ).run(memId, id, created_by, created_by, now);
        return { id, name, slug, description: description || null, created_by, created_at: now, updated_at: now };
    }

    function getOrg(id) {
        return db.prepare('SELECT * FROM organizations WHERE id = ?').get(id) || null;
    }

    function getOrgBySlug(slug) {
        return db.prepare('SELECT * FROM organizations WHERE slug = ?').get(slug) || null;
    }

    function getOrgsByUser(user_id) {
        return db.prepare(
            `SELECT o.*, om.role AS user_role
             FROM organizations o
             JOIN org_members om ON om.org_id = o.id
             WHERE om.user_id = ?
             ORDER BY o.created_at DESC`
        ).all(user_id);
    }

    function updateOrg(id, updates) {
        const existing = db.prepare('SELECT * FROM organizations WHERE id = ?').get(id);
        if (!existing) return null;
        const now = new Date().toISOString();
        const name = updates.name ?? existing.name;
        const slug = updates.slug ?? existing.slug;
        const description = updates.description !== undefined ? updates.description : existing.description;
        db.prepare(
            'UPDATE organizations SET name = ?, slug = ?, description = ?, updated_at = ? WHERE id = ?'
        ).run(name, slug, description, now, id);
        return { ...existing, name, slug, description, updated_at: now };
    }

    function deleteOrg(id) {
        const existing = db.prepare('SELECT * FROM organizations WHERE id = ?').get(id);
        if (!existing) return { success: false };
        // org_members cascade-deleted by FK. Also clean up org_id refs in apps and user_rules.
        db.prepare('UPDATE apps SET org_id = NULL WHERE org_id = ?').run(id);
        db.prepare('UPDATE user_rules SET org_id = NULL WHERE org_id = ?').run(id);
        const result = db.prepare('DELETE FROM organizations WHERE id = ?').run(id);
        return { success: result.changes > 0 };
    }

    function addOrgMember(org_id, user_id, role, invited_by) {
        const now = new Date().toISOString();
        const id = genId('mem');
        db.prepare(
            `INSERT INTO org_members (id, org_id, user_id, role, invited_by, joined_at)
             VALUES (?, ?, ?, ?, ?, ?)`
        ).run(id, org_id, user_id, role || 'member', invited_by || null, now);
        return { id, org_id, user_id, role: role || 'member', invited_by: invited_by || null, joined_at: now };
    }

    function removeOrgMember(org_id, user_id) {
        const result = db.prepare(
            'DELETE FROM org_members WHERE org_id = ? AND user_id = ?'
        ).run(org_id, user_id);
        return { success: result.changes > 0 };
    }

    function updateOrgMemberRole(org_id, user_id, role) {
        const result = db.prepare(
            'UPDATE org_members SET role = ? WHERE org_id = ? AND user_id = ?'
        ).run(role, org_id, user_id);
        return { success: result.changes > 0 };
    }

    function getOrgMembers(org_id) {
        return db.prepare(
            `SELECT om.*, u.email, u.name AS user_name, u.picture
             FROM org_members om
             JOIN users u ON u.id = om.user_id
             WHERE om.org_id = ?
             ORDER BY
                 CASE om.role
                     WHEN 'owner' THEN 0
                     WHEN 'admin' THEN 1
                     WHEN 'member' THEN 2
                 END,
                 om.joined_at ASC`
        ).all(org_id);
    }

    function getOrgMemberRole(org_id, user_id) {
        const row = db.prepare(
            'SELECT role FROM org_members WHERE org_id = ? AND user_id = ?'
        ).get(org_id, user_id);
        return row ? row.role : null;
    }

    // ------------------------------------------------- user settings (#199)

    function getUserSettings(userId) {
        const row = db.prepare('SELECT settings FROM users WHERE id = ?').get(userId);
        if (!row || !row.settings) return {};
        try { return JSON.parse(row.settings); } catch { return {}; }
    }

    function updateUserSettings(userId, patch) {
        const current = getUserSettings(userId);
        const merged = { ...current, ...patch };
        db.prepare('UPDATE users SET settings = ? WHERE id = ?')
            .run(JSON.stringify(merged), userId);
        return merged;
    }

    // ------------------------------------------------- dispatch log methods (#93)

    const dispatchStmts = {
        insert: db.prepare(`
            INSERT INTO dispatch_log (id, item_id, app_id, target_type, target_config, event, status, retries, method, auth_id, created_at, updated_at)
            VALUES (@id, @item_id, @app_id, @target_type, @target_config, @event, @status, @retries, @method, @auth_id, @created_at, @updated_at)
        `),
        updateStatus: db.prepare(`
            UPDATE dispatch_log
            SET status = @status, retries = @retries, last_error = @last_error,
                external_id = @external_id, external_url = @external_url, updated_at = @updated_at
            WHERE id = @id
        `),
        getByItem: db.prepare(
            'SELECT * FROM dispatch_log WHERE item_id = ? ORDER BY created_at ASC'
        ),
        getPending: db.prepare(
            `SELECT * FROM dispatch_log WHERE status IN ('pending', 'failed') AND retries < 3 ORDER BY created_at ASC`
        ),
        getById: db.prepare('SELECT * FROM dispatch_log WHERE id = ?'),
    };

    function createDispatchEntry({ item_id, app_id, target_type, target_config, event, method, auth_id }) {
        const now = new Date().toISOString();
        const id = genId('dsp');
        dispatchStmts.insert.run({
            id, item_id, app_id: app_id || null, target_type,
            target_config: typeof target_config === 'string' ? target_config : JSON.stringify(target_config),
            event: event || 'item.created',
            status: 'pending', retries: 0, method: method || null,
            auth_id: auth_id || null,
            created_at: now, updated_at: now,
        });
        return id;
    }

    function updateDispatchEntry(id, { status, retries, last_error, external_id, external_url }) {
        const now = new Date().toISOString();
        dispatchStmts.updateStatus.run({
            id, status, retries: retries ?? 0,
            last_error: last_error || null,
            external_id: external_id || null,
            external_url: external_url || null,
            updated_at: now,
        });
    }

    function getDispatchLog(item_id) {
        return dispatchStmts.getByItem.all(item_id);
    }

    function getPendingDispatches() {
        return dispatchStmts.getPending.all();
    }

    function getDispatchEntry(id) {
        return dispatchStmts.getById.get(id) || null;
    }

    /**
     * Get recent unique dispatch targets for a user (#48).
     * Queries dispatch_log joined with items to find distinct targets
     * the user has successfully dispatched to, ordered by most recent.
     *
     * @param {string} userName  The user's name/email
     * @param {string} appId    The app_id scope
     * @param {number} [limit=10] Max results
     * @returns {Array<{ target_type, target_config, method, auth_id, last_used, use_count }>}
     */
    const recentTargetsStmt = db.prepare(`
        SELECT dl.target_type, dl.target_config, dl.method, dl.auth_id,
               MAX(dl.created_at) as last_used, COUNT(*) as use_count
        FROM dispatch_log dl
        JOIN items i ON dl.item_id = i.id
        WHERE i.created_by = ? AND dl.app_id = ? AND dl.status = 'sent'
        GROUP BY dl.target_type, dl.target_config
        ORDER BY last_used DESC
        LIMIT ?
    `);

    function getRecentTargets(userName, appId, limit = 10) {
        return recentTargetsStmt.all(userName, appId, limit);
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

    // ------------------------------------------------- analytics methods

    function getAnalyticsTrends({ app_id = 'default', period = 'day', days = 30, group_by = 'total', allApps = false }) {
        const cutoff = new Date(Date.now() - days * 86400000).toISOString();
        const appWhere = allApps ? '1=1' : 'app_id = ?';
        const appParams = allApps ? [] : [app_id];

        let dateFormat;
        switch (period) {
            case 'week':  dateFormat = "strftime('%Y-W%W', created_at)"; break;
            case 'month': dateFormat = "strftime('%Y-%m', created_at)";  break;
            default:      dateFormat = "strftime('%Y-%m-%d', created_at)"; break;
        }

        let groupCol = '';
        let selectCol = '';
        if (group_by === 'classification') {
            groupCol = ', classification';
            selectCol = ', classification AS group_value';
        } else if (group_by === 'type') {
            groupCol = ', type';
            selectCol = ', type AS group_value';
        } else if (group_by === 'status') {
            groupCol = ', status';
            selectCol = ', status AS group_value';
        }

        const query = `
            SELECT ${dateFormat} AS period, COUNT(*) AS count${selectCol}
            FROM items
            WHERE ${appWhere} AND created_at >= ?
            GROUP BY ${dateFormat}${groupCol}
            ORDER BY period ASC
        `;
        return db.prepare(query).all(...appParams, cutoff);
    }

    function getAnalyticsSummary(app_id = 'default', { allApps = false } = {}) {
        const where = allApps ? '1=1' : 'app_id = ?';
        const params = allApps ? [] : [app_id];

        const total = db.prepare(
            `SELECT COUNT(*) AS count FROM items WHERE ${where}`
        ).get(...params).count;

        const byStatus = db.prepare(
            `SELECT status, COUNT(*) AS count FROM items WHERE ${where} GROUP BY status ORDER BY count DESC`
        ).all(...params);

        const byType = db.prepare(
            `SELECT type, COUNT(*) AS count FROM items WHERE ${where} GROUP BY type ORDER BY count DESC`
        ).all(...params);

        const byClassification = db.prepare(
            `SELECT classification, COUNT(*) AS count FROM items WHERE ${where} AND classification IS NOT NULL GROUP BY classification ORDER BY count DESC`
        ).all(...params);

        const topUrls = db.prepare(
            `SELECT source_url, source_title, COUNT(*) AS count
             FROM items WHERE ${where} AND source_url IS NOT NULL
             GROUP BY source_url ORDER BY count DESC LIMIT 10`
        ).all(...params);

        const topTags = db.prepare(
            `SELECT tags FROM items WHERE ${where} AND tags != '[]' AND tags IS NOT NULL`
        ).all(...params);

        // Aggregate tag counts from JSON arrays
        const tagCounts = {};
        for (const row of topTags) {
            try {
                const tags = JSON.parse(row.tags);
                for (const t of tags) {
                    tagCounts[t] = (tagCounts[t] || 0) + 1;
                }
            } catch { /* skip malformed */ }
        }
        const tagList = Object.entries(tagCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
            .map(([tag, count]) => ({ tag, count }));

        const recentActivity = db.prepare(
            `SELECT strftime('%Y-%m-%d', created_at) AS day, COUNT(*) AS count
             FROM items WHERE ${where} AND created_at >= datetime('now', '-7 days')
             GROUP BY day ORDER BY day ASC`
        ).all(...params);

        return { total, byStatus, byType, byClassification, topUrls, topTags: tagList, recentActivity };
    }

    function getHotTopics({ app_id = 'default', hours = 24, threshold = 2, allApps = false }) {
        const cutoff = new Date(Date.now() - hours * 3600000).toISOString();
        const appWhere = allApps ? '1=1' : 'app_id = ?';
        const appParams = allApps ? [] : [app_id];

        // Hot by URL
        const hotUrls = db.prepare(
            `SELECT source_url, source_title, COUNT(*) AS count
             FROM items WHERE ${appWhere} AND created_at >= ? AND source_url IS NOT NULL
             GROUP BY source_url HAVING count >= ?
             ORDER BY count DESC LIMIT 20`
        ).all(...appParams, cutoff, threshold);

        // Hot by classification
        const hotClassifications = db.prepare(
            `SELECT classification, COUNT(*) AS count
             FROM items WHERE ${appWhere} AND created_at >= ? AND classification IS NOT NULL
             GROUP BY classification HAVING count >= ?
             ORDER BY count DESC`
        ).all(...appParams, cutoff, threshold);

        // Hot by tags
        const recentTagged = db.prepare(
            `SELECT tags FROM items WHERE ${appWhere} AND created_at >= ? AND tags != '[]' AND tags IS NOT NULL`
        ).all(...appParams, cutoff);

        const tagCounts = {};
        for (const row of recentTagged) {
            try {
                const tags = JSON.parse(row.tags);
                for (const t of tags) { tagCounts[t] = (tagCounts[t] || 0) + 1; }
            } catch { /* skip */ }
        }
        const hotTags = Object.entries(tagCounts)
            .filter(([, c]) => c >= threshold)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
            .map(([tag, count]) => ({ tag, count }));

        return { hotUrls, hotClassifications, hotTags, window_hours: hours, threshold };
    }

    function getRecentItemsForClustering({ app_id = 'default', days = 7, limit = 100 }) {
        const cutoff = new Date(Date.now() - days * 86400000).toISOString();
        return db.prepare(
            `SELECT id, source_url, source_title, title, quote, type, classification, tags, created_at
             FROM items WHERE app_id = ? AND created_at >= ?
             ORDER BY created_at DESC LIMIT ?`
        ).all(app_id, cutoff, limit);
    }

    // ------------------------------------------------- perception methods (#69)

    function createPerceptionEvent({ app_id, type, message, stack, source, line, severity, url, fingerprint, context }) {
        const id = genId('pe');
        const now = new Date().toISOString();
        perceptionStmts.insertEvent.run({
            id, app_id, type, message: message || '',
            stack: stack || null, source: source || null, line: line || null,
            severity: severity || 'error', url: url || null,
            fingerprint, context: JSON.stringify(context || {}), created_at: now,
        });
        return { id, created_at: now };
    }

    function createPerceptionEvents(events) {
        const insertMany = db.transaction((evts) => {
            const results = [];
            for (const evt of evts) {
                results.push(createPerceptionEvent(evt));
            }
            return results;
        });
        return insertMany(events);
    }

    function getPerceptionEvents({ app_id, cursor, limit = 100 }) {
        const after = cursor || '1970-01-01T00:00:00.000Z';
        return perceptionStmts.getEvents.all(app_id, after, Math.min(limit, 500));
    }

    function getPerceptionEventsByFingerprint({ app_id, fingerprint, limit = 20 }) {
        return perceptionStmts.getEventsByFingerprint.all(app_id, fingerprint, limit);
    }

    function getPerceptionStats({ app_id, limit = 50 }) {
        return perceptionStmts.countByFingerprint.all(app_id, limit);
    }

    function upsertPerceptionIssue({ app_id, fingerprint, count, first_seen, last_seen, gitlab_issue_id, gitlab_issue_url }) {
        const existing = perceptionStmts.getIssue.get(app_id, fingerprint);
        if (existing) {
            perceptionStmts.updateIssue.run({
                app_id, fingerprint,
                last_seen: last_seen || new Date().toISOString(),
                count: (existing.count || 0) + (count ?? 1),
                gitlab_issue_id: gitlab_issue_id || null,
                gitlab_issue_url: gitlab_issue_url || null,
            });
            return { ...existing, updated: true };
        }
        const id = genId('pi');
        perceptionStmts.insertIssue.run({
            id, app_id, fingerprint,
            first_seen: first_seen || new Date().toISOString(),
            last_seen: last_seen || new Date().toISOString(),
            count: count ?? 1,
            status: 'open',
        });
        return { id, created: true };
    }

    function getPerceptionIssue({ app_id, fingerprint }) {
        return perceptionStmts.getIssue.get(app_id, fingerprint);
    }

    function getOpenPerceptionIssues({ app_id }) {
        return perceptionStmts.getOpenIssues.all(app_id);
    }

    // ------------------------------------------------- agent actions (#87 Dashboard)

    const actionStmts = {
        insert: db.prepare(`
            INSERT INTO agent_actions (id, app_id, agent_id, action_type, target_type, target_id, summary, status, metadata, created_at)
            VALUES (@id, @app_id, @agent_id, @action_type, @target_type, @target_id, @summary, @status, @metadata, @created_at)
        `),
        query: db.prepare(`
            SELECT * FROM agent_actions
            WHERE app_id = ? AND created_at >= ?
            ORDER BY created_at DESC
            LIMIT ?
        `),
        queryByAgent: db.prepare(`
            SELECT * FROM agent_actions
            WHERE app_id = ? AND agent_id = ? AND created_at >= ?
            ORDER BY created_at DESC
            LIMIT ?
        `),
        queryByType: db.prepare(`
            SELECT * FROM agent_actions
            WHERE app_id = ? AND action_type = ? AND created_at >= ?
            ORDER BY created_at DESC
            LIMIT ?
        `),
        queryByAgentAndType: db.prepare(`
            SELECT * FROM agent_actions
            WHERE app_id = ? AND agent_id = ? AND action_type = ? AND created_at >= ?
            ORDER BY created_at DESC
            LIMIT ?
        `),
        countByType: db.prepare(`
            SELECT action_type, COUNT(*) AS count
            FROM agent_actions
            WHERE app_id = ? AND created_at >= ?
            GROUP BY action_type
            ORDER BY count DESC
        `),
    };

    function logAgentAction({ app_id, agent_id, action_type, target_type, target_id, summary, status, metadata }) {
        const id = genId('act');
        actionStmts.insert.run({
            id,
            app_id,
            agent_id: agent_id || null,
            action_type,
            target_type: target_type || null,
            target_id: target_id || null,
            summary: (summary || '').slice(0, 500),
            status: status || 'success',
            metadata: typeof metadata === 'object' ? JSON.stringify(metadata) : (metadata || '{}'),
            created_at: new Date().toISOString(),
        });
        return id;
    }

    function getAgentActions({ app_id, agent_id, action_type, days = 30, limit = 100 }) {
        const cutoff = new Date(Date.now() - days * 86400000).toISOString();
        const safeLimit = Math.min(limit, 500);

        if (agent_id && action_type) {
            return actionStmts.queryByAgentAndType.all(app_id, agent_id, action_type, cutoff, safeLimit);
        }
        if (agent_id) {
            return actionStmts.queryByAgent.all(app_id, agent_id, cutoff, safeLimit);
        }
        if (action_type) {
            return actionStmts.queryByType.all(app_id, action_type, cutoff, safeLimit);
        }
        return actionStmts.query.all(app_id, cutoff, safeLimit);
    }

    function getAgentActionSummary({ app_id, days = 30 }) {
        const cutoff = new Date(Date.now() - days * 86400000).toISOString();
        return actionStmts.countByType.all(app_id, cutoff);
    }

    // ------------------------------------------------- error trends (#87 Dashboard)

    function getErrorTrends({ app_id, days = 7, group_by = 'severity' }) {
        const cutoff = new Date(Date.now() - days * 86400000).toISOString();
        const dateFormat = "strftime('%Y-%m-%d', created_at)";

        let groupCol = '';
        let selectCol = '';
        if (group_by === 'total') {
            selectCol = ", 'total' AS group_value";
        } else if (group_by === 'severity') {
            groupCol = ', severity';
            selectCol = ', severity AS group_value';
        } else if (group_by === 'type') {
            groupCol = ', type';
            selectCol = ', type AS group_value';
        }

        const query = `
            SELECT ${dateFormat} AS period, COUNT(*) AS count${selectCol}
            FROM perception_events
            WHERE app_id = ? AND created_at >= ?
            GROUP BY ${dateFormat}${groupCol}
            ORDER BY period ASC
        `;
        return db.prepare(query).all(app_id, cutoff);
    }

    function getErrorSummary({ app_id, days = 7 }) {
        const cutoff = new Date(Date.now() - days * 86400000).toISOString();

        const total = db.prepare(
            'SELECT COUNT(*) AS count FROM perception_events WHERE app_id = ? AND created_at >= ?'
        ).get(app_id, cutoff).count;

        const bySeverity = db.prepare(
            'SELECT severity, COUNT(*) AS count FROM perception_events WHERE app_id = ? AND created_at >= ? GROUP BY severity ORDER BY count DESC'
        ).all(app_id, cutoff);

        const byType = db.prepare(
            'SELECT type, COUNT(*) AS count FROM perception_events WHERE app_id = ? AND created_at >= ? GROUP BY type ORDER BY count DESC'
        ).all(app_id, cutoff);

        const topFingerprints = db.prepare(`
            SELECT fingerprint, message, severity, type, url, COUNT(*) AS count, MAX(created_at) AS last_seen
            FROM perception_events
            WHERE app_id = ? AND created_at >= ?
            GROUP BY fingerprint
            ORDER BY count DESC
            LIMIT 10
        `).all(app_id, cutoff);

        // Spike detection: compare last 24h vs prior period average
        const last24h = db.prepare(
            'SELECT COUNT(*) AS count FROM perception_events WHERE app_id = ? AND created_at >= ?'
        ).get(app_id, new Date(Date.now() - 86400000).toISOString()).count;

        const priorAvg = days > 1
            ? db.prepare(`
                SELECT CAST(COUNT(*) AS REAL) / ? AS avg_daily
                FROM perception_events
                WHERE app_id = ? AND created_at >= ? AND created_at < ?
              `).get(days - 1, app_id, cutoff, new Date(Date.now() - 86400000).toISOString()).avg_daily
            : last24h;

        const spikeRatio = priorAvg > 0 ? last24h / priorAvg : 0;

        return { total, bySeverity, byType, topFingerprints, last24h, priorAvgDaily: priorAvg, spikeRatio };
    }

    // ------------------------------------------------- session methods (#73)

    const MAX_SESSION_SIZE = 50 * 1024 * 1024; // 50MB

    // P2-4: Allowed event types per contract
    const VALID_EVENT_TYPES = new Set([
        'dom-mutation', 'console-log', 'console-error', 'network-error', 'click', 'scroll',
    ]);

    // P2-5: ISO 8601 date format validation
    const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

    function createSession({ app_id, agent_id, tab_id, url, title, start_time, events, snapshots, metadata }) {
        // P2-5: Validate start_time format
        if (start_time && !ISO_DATE_RE.test(start_time)) {
            throw new Error('INVALID_START_TIME');
        }

        const now = new Date().toISOString();
        const sessionId = genId('sess');

        const eventsData = (events || []).slice(0, 1000);
        const snapshotsData = (snapshots || []).slice(0, 100);

        // P2-4: Validate event types
        for (const e of eventsData) {
            if (e.type && !VALID_EVENT_TYPES.has(e.type)) {
                throw new Error(`INVALID_EVENT_TYPE:${e.type}`);
            }
        }

        // Calculate total size
        let totalSize = 0;
        for (const e of eventsData) {
            totalSize += JSON.stringify(e.data || {}).length;
        }
        for (const s of snapshotsData) {
            totalSize += (s.html || '').length;
        }

        if (totalSize > MAX_SESSION_SIZE) {
            throw new Error('SESSION_TOO_LARGE');
        }

        const insertAll = db.transaction(() => {
            sessionStmts.insertSession.run({
                id: sessionId,
                app_id,
                agent_id: agent_id || null,
                tab_id: tab_id || null,
                url: (url || '').slice(0, 2048) || null,
                title: (title || '').slice(0, 512) || null,
                start_time: start_time || now,
                end_time: null,
                event_count: eventsData.length,
                snapshot_count: snapshotsData.length,
                total_size: totalSize,
                status: 'active',
                metadata: JSON.stringify(metadata || {}),
                created_at: now,
                updated_at: now,
            });

            for (const evt of eventsData) {
                const dataStr = JSON.stringify(evt.data || {});
                sessionStmts.insertEvent.run({
                    id: genId('sevt'),
                    session_id: sessionId,
                    type: evt.type || 'unknown',
                    timestamp: evt.timestamp || now,
                    data: dataStr,
                    size: dataStr.length,
                });
            }

            for (const snap of snapshotsData) {
                const html = (snap.html || '').slice(0, 50000);
                sessionStmts.insertSnapshot.run({
                    id: genId('ssnap'),
                    session_id: sessionId,
                    trigger: snap.trigger || 'manual',
                    timestamp: snap.timestamp || now,
                    html,
                    size: html.length,
                });
            }
        });

        insertAll();

        return {
            id: sessionId,
            app_id,
            event_count: eventsData.length,
            snapshot_count: snapshotsData.length,
            total_size: totalSize,
            created_at: now,
        };
    }

    function appendSessionEvents(sessionId, { events, snapshots, agent_id }) {
        const session = sessionStmts.getSession.get(sessionId);
        if (!session) return null;

        // P2-2: Verify agent ownership — prevent cross-agent injection
        if (agent_id && session.agent_id && session.agent_id !== agent_id) {
            return null;
        }

        // P2-6: Reject append to finalized sessions
        if (session.status === 'completed') {
            throw new Error('SESSION_FINALIZED');
        }

        const now = new Date().toISOString();
        const eventsData = (events || []).slice(0, 1000);
        const snapshotsData = (snapshots || []).slice(0, 100);

        // P2-4: Validate event types
        for (const e of eventsData) {
            if (e.type && !VALID_EVENT_TYPES.has(e.type)) {
                throw new Error(`INVALID_EVENT_TYPE:${e.type}`);
            }
        }

        let addedSize = 0;
        for (const e of eventsData) addedSize += JSON.stringify(e.data || {}).length;
        for (const s of snapshotsData) addedSize += (s.html || '').length;

        if (session.total_size + addedSize > MAX_SESSION_SIZE) {
            throw new Error('SESSION_TOO_LARGE');
        }

        const appendAll = db.transaction(() => {
            for (const evt of eventsData) {
                const dataStr = JSON.stringify(evt.data || {});
                sessionStmts.insertEvent.run({
                    id: genId('sevt'),
                    session_id: sessionId,
                    type: evt.type || 'unknown',
                    timestamp: evt.timestamp || now,
                    data: dataStr,
                    size: dataStr.length,
                });
            }

            for (const snap of snapshotsData) {
                const html = (snap.html || '').slice(0, 50000);
                sessionStmts.insertSnapshot.run({
                    id: genId('ssnap'),
                    session_id: sessionId,
                    trigger: snap.trigger || 'manual',
                    timestamp: snap.timestamp || now,
                    html,
                    size: html.length,
                });
            }

            sessionStmts.updateSession.run({
                id: sessionId,
                end_time: session.end_time,
                event_count: session.event_count + eventsData.length,
                snapshot_count: session.snapshot_count + snapshotsData.length,
                total_size: session.total_size + addedSize,
                status: session.status,
                updated_at: now,
            });
        });

        appendAll();

        return {
            id: sessionId,
            events_added: eventsData.length,
            snapshots_added: snapshotsData.length,
            total_size: session.total_size + addedSize,
        };
    }

    function finalizeSession(sessionId) {
        const session = sessionStmts.getSession.get(sessionId);
        if (!session) return null;
        const now = new Date().toISOString();
        sessionStmts.updateSession.run({
            id: sessionId,
            end_time: now,
            event_count: session.event_count,
            snapshot_count: session.snapshot_count,
            total_size: session.total_size,
            status: 'completed',
            updated_at: now,
        });
        return { id: sessionId, status: 'completed', end_time: now };
    }

    function listSessions({ app_id, agent_id, site, after, limit = 50 }) {
        const cutoff = after || '1970-01-01T00:00:00.000Z';
        const maxLimit = Math.min(limit, 200);
        if (agent_id) {
            return sessionStmts.listSessionsByAgent.all(app_id, agent_id, cutoff, maxLimit);
        }
        if (site) {
            // P2-3: Escape LIKE wildcards to prevent logic bypass
            const escapedSite = site.replace(/[%_]/g, '\\$&');
            return sessionStmts.listSessionsBySite.all(app_id, `%${escapedSite}%`, cutoff, maxLimit);
        }
        return sessionStmts.listSessions.all(app_id, cutoff, maxLimit);
    }

    function getSession(sessionId) {
        return sessionStmts.getSession.get(sessionId) || null;
    }

    function getSessionEvents(sessionId, { start_time, end_time } = {}) {
        if (start_time && end_time) {
            return sessionStmts.getEventsInRange.all(sessionId, start_time, end_time);
        }
        return sessionStmts.getEvents.all(sessionId);
    }

    function getSessionSnapshots(sessionId) {
        return sessionStmts.getSnapshots.all(sessionId);
    }

    function getSessionSnapshot(snapshotId) {
        return sessionStmts.getSnapshot.get(snapshotId) || null;
    }

    function cleanupOldSessions(retentionDays = 30, orphanDays = 7) {
        const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
        const orphanCutoff = new Date(Date.now() - orphanDays * 86400000).toISOString();
        const completed = sessionStmts.deleteOldSessions.run(cutoff);
        // P2-7: Clean up orphaned active sessions (e.g. extension crash)
        const orphaned = sessionStmts.deleteOrphanSessions.run(orphanCutoff);
        return { deleted: completed.changes + orphaned.changes, completed: completed.changes, orphaned: orphaned.changes };
    }

    // ------------------------------------------------- agent methods (#68)

    function registerAgent({ app_id, name, key_hash, key_prefix, callback_url, capabilities, created_by }) {
        const id = genId('agent');
        const now = new Date().toISOString();
        agentStmts.insertAgent.run({
            id, app_id, name, key_hash, key_prefix,
            callback_url: callback_url || null,
            capabilities: JSON.stringify(capabilities || []),
            status: 'active',
            created_by,
            created_at: now,
            updated_at: now,
        });
        return { id, app_id, name, key_prefix, callback_url: callback_url || null, capabilities: capabilities || [], status: 'active', created_by, created_at: now, updated_at: now };
    }

    function getAgentById(id) {
        const row = agentStmts.getAgentById.get(id);
        if (!row) return null;
        // Exclude key_hash from returned object
        const { key_hash, ...agent } = row;
        return agent;
    }

    function getAgentByKeyHash(keyHash) {
        return agentStmts.getAgentByKeyHash.get(keyHash) || null;
    }

    function getAgentsByApp(app_id) {
        return agentStmts.getAgentsByApp.all(app_id);
    }

    function updateAgent(id, { name, callback_url, capabilities }) {
        const now = new Date().toISOString();
        agentStmts.updateAgent.run({
            id, name, callback_url: callback_url || null,
            capabilities: JSON.stringify(capabilities || []),
            updated_at: now,
        });
        return getAgentById(id);
    }

    function deactivateAgent(id) {
        const now = new Date().toISOString();
        agentStmts.deactivateAgent.run(now, id);
    }

    function updateAgentLastSeen(id) {
        const now = new Date().toISOString();
        agentStmts.updateAgentLastSeen.run(now, id);
    }

    function rotateAgentKey(id, { key_hash, key_prefix }) {
        const now = new Date().toISOString();
        agentStmts.updateAgentKey.run({ id, key_hash, key_prefix, updated_at: now });
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
        getItemsByClassification,
        getDistinctUrls,
        updateItemTags,
        updateItemClassification,
        updateItemClassificationIfNull,
        updateItemScreenshotAnalysis,
        createApiKey,
        validateApiKey,
        revokeApiKey,
        // Adapter mappings
        setAdapterMapping,
        getAdapterMapping,
        getAdapterMappingByExternalId,
        // Dispatch log (#93)
        createDispatchEntry,
        updateDispatchEntry,
        getDispatchLog,
        getPendingDispatches,
        getDispatchEntry,
        getRecentTargets,
        // User routing rules
        createUserRule,
        getUserRules,
        getUserRule,
        updateUserRule,
        deleteUserRule,
        getAllUserRules,
        // User auths
        createUserAuth,
        getUserAuths,
        getUserAuth,
        updateUserAuth,
        deleteUserAuth,
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
        getOrCreateDefaultApp,
        createApp,
        getApp,
        getAppsByUser,
        updateApp,
        deleteApp,
        getAppKeys,
        rotateAppKey,
        // Analytics
        getAnalyticsTrends,
        getAnalyticsSummary,
        getHotTopics,
        getRecentItemsForClustering,
        // Organizations
        createOrg,
        getOrg,
        getOrgBySlug,
        getOrgsByUser,
        updateOrg,
        deleteOrg,
        addOrgMember,
        removeOrgMember,
        updateOrgMemberRole,
        getOrgMembers,
        getOrgMemberRole,
        // User Settings
        getUserSettings,
        updateUserSettings,
        // Agents (#68)
        registerAgent,
        getAgentById,
        getAgentByKeyHash,
        getAgentsByApp,
        updateAgent,
        deactivateAgent,
        updateAgentLastSeen,
        rotateAgentKey,
        // Perception (#69 Error Sentinel)
        createPerceptionEvent,
        createPerceptionEvents,
        getPerceptionEvents,
        getPerceptionEventsByFingerprint,
        getPerceptionStats,
        upsertPerceptionIssue,
        getPerceptionIssue,
        getOpenPerceptionIssues,
        getErrorTrends,
        getErrorSummary,
        logAgentAction,
        getAgentActions,
        getAgentActionSummary,
        // Sessions (#73)
        createSession,
        appendSessionEvents,
        finalizeSession,
        listSessions,
        getSession,
        getSessionEvents,
        getSessionSnapshots,
        getSessionSnapshot,
        cleanupOldSessions,
    };
}

module.exports = { initDb };
