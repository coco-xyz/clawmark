/**
 * ClawMark — server/index.js
 *
 * Standalone backend for the ClawMark annotation & feedback widget.
 * No Zylos-specific dependencies; configure entirely via environment
 * variables or config.json.
 *
 * Environment variables (all optional):
 *   CLAWMARK_PORT       Port to listen on              (default: 3458)
 *   CLAWMARK_DATA_DIR   Directory for DB + uploads     (default: ./data)
 *   CLAWMARK_CONFIG     Path to config.json            (default: ../config.json)
 */

'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const multer = require('multer');
const rateLimit = require('express-rate-limit');

// ---------------------------------------------------------------------- config

const CONFIG_PATH = process.env.CLAWMARK_CONFIG
    || path.join(__dirname, '..', 'config.json');

let config = {};
try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch {
    // Config file is optional; fall back to env vars and defaults below.
}

const PORT = process.env.CLAWMARK_PORT || config.port || 3458;

const DATA_DIR = path.resolve(
    process.env.CLAWMARK_DATA_DIR || config.dataDir || path.join(__dirname, '..', 'data')
);
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

// Auth config — invite-code map  { code: displayName }
// Sourced from config.auth.codes; may be overridden by CLAWMARK_INVITE_CODES_JSON env var.
let VALID_CODES = (config.auth && config.auth.codes) || {};
if (process.env.CLAWMARK_INVITE_CODES_JSON) {
    try {
        VALID_CODES = JSON.parse(process.env.CLAWMARK_INVITE_CODES_JSON);
    } catch {
        console.warn('[!] Could not parse CLAWMARK_INVITE_CODES_JSON — ignoring');
    }
}

// Webhook config
const WEBHOOK = (config.webhook) || {};
// CLAWMARK_WEBHOOK_URL env var overrides config file
if (process.env.CLAWMARK_WEBHOOK_URL) WEBHOOK.url = process.env.CLAWMARK_WEBHOOK_URL;
if (process.env.CLAWMARK_WEBHOOK_SECRET) WEBHOOK.secret = process.env.CLAWMARK_WEBHOOK_SECRET;

// ---------------------------------------------------------------------- boot

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const { initDb } = require('./db');
const itemsDb = initDb(DATA_DIR);

// ------------------------------------------------------------------ adapters

const { AdapterRegistry } = require('./adapters/index');
const { WebhookAdapter } = require('./adapters/webhook');
const { LarkAdapter } = require('./adapters/lark');
const { TelegramAdapter } = require('./adapters/telegram');
const { GitHubIssueAdapter } = require('./adapters/github-issue');
const { resolveTarget } = require('./routing');

const registry = new AdapterRegistry();
registry.setDb(itemsDb);
registry.registerType('webhook', WebhookAdapter);
registry.registerType('lark', LarkAdapter);
registry.registerType('telegram', TelegramAdapter);
registry.registerType('github-issue', GitHubIssueAdapter);

// Load distribution config
if (config.distribution) {
    registry.loadConfig(config.distribution);
}

// Legacy webhook → auto-register as 'webhook-legacy' channel if no distribution config
if (WEBHOOK.url && !config.distribution) {
    registry.loadConfig({
        rules: [
            { match: { event: 'item.created' }, channels: ['webhook-legacy'] },
            { match: { event: 'item.resolved' }, channels: ['webhook-legacy'] },
            { match: { event: 'item.assigned' }, channels: ['webhook-legacy'] },
            { match: { event: 'discussion.created' }, channels: ['webhook-legacy'] },
            { match: { event: 'discussion.message' }, channels: ['webhook-legacy'] },
        ],
        channels: {
            'webhook-legacy': {
                adapter: 'webhook',
                url: WEBHOOK.url,
                secret: WEBHOOK.secret || '',
                events: WEBHOOK.events || null,
            },
        },
    });
}

// ---------------------------------------------------------------------- express

const app = express();
app.use(express.json({ limit: '512kb' }));

// Trust first proxy (for correct IP logging behind nginx/caddy)
app.set('trust proxy', 1);

// ------------------------------------------------------------------ rate limiting

const apiReadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Rate limit exceeded, try again later' },
});

const apiWriteLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Rate limit exceeded, try again later' },
});

const uploadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Upload rate limit exceeded' },
});

// ---------------------------------------------------------------------- multer

const upload = multer({
    storage: multer.diskStorage({
        destination: UPLOAD_DIR,
        filename: (req, file, cb) =>
            cb(null, Date.now() + '-' + Math.random().toString(36).substr(2, 6) +
               path.extname(file.originalname || '.png'))
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico']);
        const ext = path.extname(file.originalname || '').toLowerCase();
        cb(null, file.mimetype.startsWith('image/') && ALLOWED_EXT.has(ext));
    }
});

// ------------------------------------------------------------------ dispatch

// Default target from config (used as fallback by routing resolver)
const defaultGitHubTarget = config.distribution?.channels?.['github-clawmark']
    ? {
        repo: config.distribution.channels['github-clawmark'].repo,
        labels: config.distribution.channels['github-clawmark'].labels || ['clawmark'],
        assignees: config.distribution.channels['github-clawmark'].assignees || [],
    }
    : { repo: 'coco-xyz/clawmark', labels: ['clawmark'], assignees: [] };

/**
 * Dispatch event through the adapter registry (fire-and-forget).
 * For item.created events, uses the routing resolver to determine the target.
 * Other events fall through to static rules.
 *
 * @param {string} event   Event name, e.g. 'item.created'
 * @param {object} payload The item/data payload
 */
function sendWebhook(event, payload) {
    if (event === 'item.created') {
        // Use routing resolver to find the right target
        const routing = resolveTarget({
            source_url: payload.source_url,
            user_name: payload.created_by,
            type: payload.type,
            priority: payload.priority,
            tags: payload.tags,
            db: itemsDb,
            defaultTarget: defaultGitHubTarget,
        });

        console.log(`[routing] ${event}: ${routing.method} → ${routing.target_type} (${routing.target_config.repo || 'custom'})`);

        // Store routing decision on the item for debugging/auditing
        payload._routing = { method: routing.method, target_type: routing.target_type, repo: routing.target_config.repo };

        if (routing.method !== 'system_default') {
            // Dynamic dispatch to the resolved target
            registry.dispatchToTarget(event, payload, routing.target_type, { ...routing.target_config }, {}).catch(err => {
                console.error(`[dispatch] Routed dispatch failed for ${event}, falling back to default:`, err.message);
                // Fallback to static dispatch on error
                registry.dispatch(event, payload).catch(e => {
                    console.error(`[dispatch] Fallback also failed:`, e.message);
                });
            });
            return;
        }
    }

    // Default static dispatch (for non-routed events or system_default routing)
    registry.dispatch(event, payload).catch(err => {
        console.error(`[dispatch] Unexpected error for ${event}:`, err.message);
    });
}

// ------------------------------------------------------------------- auth

// Verify invite code — returns { valid: bool, userName?: string }
const verifyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Too many attempts, try again later' } });
app.post('/verify', verifyLimiter, (req, res) => {
    const { code } = req.body;
    if (code && VALID_CODES[code]) {
        res.json({ valid: true, userName: VALID_CODES[code] });
    } else {
        res.json({ valid: false });
    }
});

// -------------------------------------------------------------- discussion helpers

// Discussion files live in DATA_DIR as <safeId>.json
function getDiscussionFile(docId) {
    const safeId = docId.replace(/[^a-zA-Z0-9\-_.]/g, '_');
    return path.join(DATA_DIR, `${safeId}.json`);
}

function loadDiscussions(docId) {
    const filePath = getDiscussionFile(docId);
    if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    return { docId, discussions: [] };
}

function saveDiscussions(docId, data) {
    const filePath = getDiscussionFile(docId);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// --------------------------------------------------------- discussion endpoints

// Get discussions for a document
app.get('/discussions', (req, res) => {
    const { doc, version } = req.query;
    if (!doc) return res.status(400).json({ error: 'Missing doc parameter' });

    const data = loadDiscussions(doc);
    let { discussions } = data;
    if (version) discussions = discussions.filter(d => d.version === version);

    res.json({ discussions });
});

// Create a new discussion or add a message to an existing one
app.post('/discussions', (req, res) => {
    const { doc, version, discussionId, quote, message, userName } = req.body;

    if (!doc || !message || !userName) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const data = loadDiscussions(doc);

    if (discussionId) {
        // Append to existing discussion
        const discussion = data.discussions.find(d => d.id === discussionId);
        if (!discussion) return res.status(404).json({ error: 'Discussion not found' });

        discussion.messages.push({
            role: 'user',
            content: message,
            userName,
            timestamp: new Date().toISOString()
        });

        saveDiscussions(doc, data);

        sendWebhook('discussion.message', { doc, discussionId, userName, message });
        res.json({ success: true, discussionId });
    } else {
        // New discussion
        const newDiscussion = {
            id: `disc-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            quote: quote || '',
            version: version || 'latest',
            createdAt: new Date().toISOString(),
            messages: [{
                role: 'user',
                content: message,
                userName,
                timestamp: new Date().toISOString()
            }]
        };

        data.discussions.push(newDiscussion);
        saveDiscussions(doc, data);

        sendWebhook('discussion.created', { doc, discussionId: newDiscussion.id, userName, quote, message });
        res.json({ success: true, discussionId: newDiscussion.id });
    }
});

// Post a response to a discussion (called by an AI agent or admin)
app.post('/respond', (req, res) => {
    const { doc, discussionId, response } = req.body;
    if (!doc || !discussionId || !response) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const data = loadDiscussions(doc);
    const discussion = data.discussions.find(d => d.id === discussionId);
    if (!discussion) return res.status(404).json({ error: 'Discussion not found' });

    const pendingIdx = discussion.messages.findIndex(m => m.pending);
    if (pendingIdx !== -1) {
        discussion.messages[pendingIdx] = {
            role: 'assistant',
            content: response,
            timestamp: new Date().toISOString()
        };
    } else {
        discussion.messages.push({
            role: 'assistant',
            content: response,
            timestamp: new Date().toISOString()
        });
    }

    saveDiscussions(doc, data);
    res.json({ success: true });
});

// Resolve or reopen a discussion
app.post('/discussions/resolve', (req, res) => {
    const { doc, discussionId, action } = req.body;
    if (!doc || !discussionId) return res.status(400).json({ error: 'Missing doc or discussionId' });

    const data = loadDiscussions(doc);
    const disc = data.discussions.find(d => d.id === discussionId);
    if (!disc) return res.status(404).json({ error: 'Discussion not found' });

    if (action === 'reopen') {
        disc.applied = false;
        disc.appliedAt = null;
    } else {
        disc.applied = true;
        disc.appliedAt = new Date().toISOString();
    }

    saveDiscussions(doc, data);
    res.json({ success: true });
});

// Submit a reply via API (for AI agent or admin use)
app.post('/submit-reply', (req, res) => {
    const { doc, discussionId, reply } = req.body;
    if (!doc || !discussionId || !reply) {
        return res.status(400).json({ error: 'Missing doc, discussionId, or reply' });
    }

    const data = loadDiscussions(doc);
    const discussion = data.discussions.find(d => d.id === discussionId);
    if (!discussion) return res.status(404).json({ error: 'Discussion not found' });

    const pendingIdx = discussion.messages.findIndex(m => m.pending);
    if (pendingIdx !== -1) {
        discussion.messages[pendingIdx] = {
            role: 'assistant',
            content: reply,
            timestamp: new Date().toISOString()
        };
    } else {
        discussion.messages.push({
            role: 'assistant',
            content: reply,
            timestamp: new Date().toISOString()
        });
    }

    saveDiscussions(doc, data);
    res.json({ success: true });
});

// List pending discussions (discussions that have an unanswered pending message)
app.get('/pending', (req, res) => {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
    const pending = [];

    for (const file of files) {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
            for (const disc of data.discussions || []) {
                if (disc.messages.some(m => m.pending)) {
                    pending.push({
                        docId: data.docId,
                        discussionId: disc.id,
                        quote: disc.quote,
                        lastMessage: disc.messages.filter(m => m.role === 'user').pop()?.content
                    });
                }
            }
        } catch (err) {
            console.error(`[-] Skipping corrupt file ${file}:`, err.message);
        }
    }

    res.json({ pending });
});

// -------------------------------------------------------------- image upload

// Upload an image (screenshots, attachments, etc.)
app.post('/upload', uploadLimiter, upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    const url = '/images/' + req.file.filename;
    res.json({ success: true, url });
});

// Serve uploaded images
app.use('/images', express.static(UPLOAD_DIR));

// ----------------------------------------------------------------- V2 items API
//
// Items are the canonical data model: each item is a discussion thread or
// an issue ticket, identified by (app_id, doc, id).
//
// Routes support an optional :app path segment for multi-app deployments.
// For MVP a single 'default' app is used when the segment is omitted.

function resolveAppId(req) {
    return (req.params && req.params.app) || 'default';
}

// -- GET /items  or  GET /api/clawmark/:app/items
function handleGetItems(req, res) {
    const { doc, type, status, assignee } = req.query;
    const app_id = resolveAppId(req);
    const items = itemsDb.getItems({ app_id, doc, type, status, assignee });
    res.json({ items });
}

// -- GET /items/:id
function handleGetItem(req, res) {
    const item = itemsDb.getItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    res.json(item);
}

// -- POST /items
function handleCreateItem(req, res) {
    const { doc, type, title, quote, quote_position, priority, message, userName, version,
            source_url, source_title, tags, screenshots } = req.body;
    const app_id = resolveAppId(req);

    if (!doc || !userName) return res.status(400).json({ error: 'Missing doc or userName' });
    if (type === 'issue' && !title) return res.status(400).json({ error: 'Issue requires a title' });

    const item = itemsDb.createItem({
        app_id, doc, type: type || 'discuss', title, quote, quote_position,
        priority: priority || 'normal', created_by: userName, version, message,
        source_url, source_title, tags, screenshots
    });

    sendWebhook('item.created', item);

    res.json({ success: true, item });
}

// -- POST /items/:id/messages
function handleAddMessage(req, res) {
    const { role, content, userName } = req.body;
    if (!content) return res.status(400).json({ error: 'Missing content' });

    const item = itemsDb.getItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const result = itemsDb.addMessage({
        item_id: req.params.id,
        role: role || 'user',
        content,
        user_name: userName
    });

    res.json({ success: true, message: result });
}

// -- POST /items/:id/assign
function handleAssignItem(req, res) {
    const { assignee } = req.body;
    if (!assignee) return res.status(400).json({ error: 'Missing assignee' });
    const result = itemsDb.assignItem(req.params.id, assignee);
    if (!result.changes) return res.status(404).json({ error: 'Item not found' });
    sendWebhook('item.assigned', { id: req.params.id, assignee });
    res.json({ success: true });
}

// -- POST /items/:id/resolve
function handleResolveItem(req, res) {
    const result = itemsDb.resolveItem(req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Item not found' });
    sendWebhook('item.resolved', { id: req.params.id });
    res.json({ success: true });
}

// -- POST /items/:id/verify
function handleVerifyItem(req, res) {
    const result = itemsDb.verifyItem(req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Item not found' });
    res.json({ success: true });
}

// -- POST /items/:id/reopen
function handleReopenItem(req, res) {
    const result = itemsDb.reopenItem(req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Item not found' });
    res.json({ success: true });
}

// -- POST /items/:id/close
function handleCloseItem(req, res) {
    const result = itemsDb.closeItem(req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Item not found' });
    res.json({ success: true });
}

// -- POST /items/:id/respond
function handleRespondToItem(req, res) {
    const { response } = req.body;
    if (!response) return res.status(400).json({ error: 'Missing response' });

    const item = itemsDb.getItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    itemsDb.respondToItem(req.params.id, response);
    res.json({ success: true });
}

// -- GET /items-full
function handleGetItemsFull(req, res) {
    const { doc } = req.query;
    const app_id = resolveAppId(req);
    if (!doc) return res.status(400).json({ error: 'Missing doc' });
    const items = itemsDb.getItems({ app_id, doc, type: 'discuss' });
    const full = items.map(item => itemsDb.getItem(item.id));
    res.json({ items: full });
}

// Register routes — both with and without :app prefix
//   /items                    → default app
//   /api/clawmark/:app/items  → named app (multi-tenant)

// Flat routes (default app)
app.get('/items',              apiReadLimiter, handleGetItems);
app.post('/items',             apiWriteLimiter, handleCreateItem);
app.get('/items-full',         apiReadLimiter, handleGetItemsFull);
app.get('/items/:id',          apiReadLimiter, handleGetItem);
app.post('/items/:id/messages', apiWriteLimiter, handleAddMessage);
app.post('/items/:id/assign',  apiWriteLimiter, handleAssignItem);
app.post('/items/:id/resolve', apiWriteLimiter, handleResolveItem);
app.post('/items/:id/verify',  apiWriteLimiter, handleVerifyItem);
app.post('/items/:id/reopen',  apiWriteLimiter, handleReopenItem);
app.post('/items/:id/close',   apiWriteLimiter, handleCloseItem);
app.post('/items/:id/respond', apiWriteLimiter, handleRespondToItem);

// Namespaced routes (multi-app)
app.get('/api/clawmark/:app/items',              apiReadLimiter, handleGetItems);
app.post('/api/clawmark/:app/items',             apiWriteLimiter, handleCreateItem);
app.get('/api/clawmark/:app/items-full',         apiReadLimiter, handleGetItemsFull);
app.get('/api/clawmark/:app/items/:id',          apiReadLimiter, handleGetItem);
app.post('/api/clawmark/:app/items/:id/messages', apiWriteLimiter, handleAddMessage);
app.post('/api/clawmark/:app/items/:id/assign',  apiWriteLimiter, handleAssignItem);
app.post('/api/clawmark/:app/items/:id/resolve', apiWriteLimiter, handleResolveItem);
app.post('/api/clawmark/:app/items/:id/verify',  apiWriteLimiter, handleVerifyItem);
app.post('/api/clawmark/:app/items/:id/reopen',  apiWriteLimiter, handleReopenItem);
app.post('/api/clawmark/:app/items/:id/close',   apiWriteLimiter, handleCloseItem);
app.post('/api/clawmark/:app/items/:id/respond', apiWriteLimiter, handleRespondToItem);

// ================================================================= V2 API
//
// New /api/v2/ endpoints for ClawMark V2.
// Supports source_url, source_title, tags, screenshots.
// Backward compatible — V1 routes above remain unchanged.
// =================================================================

// -- V2 auth middleware: accept invite code OR API key (always required)
function v2Auth(req, res, next) {
    // API key in Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const key = authHeader.slice(7);
        const apiKey = itemsDb.validateApiKey(key);
        if (apiKey) {
            req.v2Auth = { type: 'apikey', app_id: apiKey.app_id, user: apiKey.created_by, keyName: apiKey.name };
            return next();
        }
        return res.status(401).json({ error: 'Invalid API key' });
    }
    // Invite code in body or query
    const code = req.body?.code || req.query?.code;
    if (code && VALID_CODES[code]) {
        req.v2Auth = { type: 'invite', user: VALID_CODES[code] };
        return next();
    }
    return res.status(401).json({ error: 'Authentication required (API key or invite code)' });
}

// -- POST /api/v2/items — create item with full V2 schema
app.post('/api/v2/items', apiWriteLimiter, v2Auth, (req, res) => {
    const { type, app_id, source_url, source_title, quote, quote_position,
            screenshots, title, content, priority, tags, userName, version } = req.body;

    const user = userName || req.v2Auth?.user;
    const resolvedAppId = app_id || req.v2Auth?.app_id || 'default';
    const doc = source_url || req.body.doc || '/';

    if (!user) return res.status(400).json({ error: 'Missing userName' });

    const item = itemsDb.createItem({
        app_id: resolvedAppId,
        doc,
        type: type || 'comment',
        title,
        quote,
        quote_position: quote_position ? JSON.stringify(quote_position) : null,
        priority: priority || 'normal',
        created_by: user,
        version,
        message: content,
        source_url: source_url || null,
        source_title: source_title || null,
        tags: tags || [],
        screenshots: screenshots || [],
    });

    sendWebhook('item.created', item);
    res.json({ success: true, item });
});

// -- GET /api/v2/items — query with url/tag support
app.get('/api/v2/items', apiReadLimiter, v2Auth, (req, res) => {
    const { url, tag, doc, type, status, assignee, app_id } = req.query;
    const resolvedAppId = app_id || 'default';

    if (url) {
        const items = itemsDb.getItemsByUrl({ app_id: resolvedAppId, url });
        return res.json({ items });
    }
    if (tag) {
        const items = itemsDb.getItemsByTag({ app_id: resolvedAppId, tag });
        return res.json({ items });
    }

    const items = itemsDb.getItems({ app_id: resolvedAppId, doc, type, status, assignee });
    res.json({ items });
});

// -- GET /api/v2/items/:id
app.get('/api/v2/items/:id', apiReadLimiter, v2Auth, (req, res) => {
    const item = itemsDb.getItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    // Parse JSON fields for client convenience
    if (typeof item.tags === 'string') item.tags = JSON.parse(item.tags || '[]');
    if (typeof item.screenshots === 'string') item.screenshots = JSON.parse(item.screenshots || '[]');
    res.json(item);
});

// -- POST /api/v2/items/:id/tags — add or remove tags
app.post('/api/v2/items/:id/tags', apiWriteLimiter, v2Auth, (req, res) => {
    const { add, remove } = req.body;
    const item = itemsDb.getItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    let tags = typeof item.tags === 'string' ? JSON.parse(item.tags || '[]') : (item.tags || []);

    if (add) {
        const toAdd = Array.isArray(add) ? add : [add];
        tags = [...new Set([...tags, ...toAdd])];
    }
    if (remove) {
        const toRemove = new Set(Array.isArray(remove) ? remove : [remove]);
        tags = tags.filter(t => !toRemove.has(t));
    }

    itemsDb.updateItemTags(req.params.id, tags);
    res.json({ success: true, tags });
});

// -- POST /api/v2/items/:id/messages
app.post('/api/v2/items/:id/messages', apiWriteLimiter, v2Auth, (req, res) => {
    const { role, content, userName } = req.body;
    if (!content) return res.status(400).json({ error: 'Missing content' });

    const item = itemsDb.getItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const user = userName || req.v2Auth?.user;
    const result = itemsDb.addMessage({
        item_id: req.params.id,
        role: role || 'user',
        content,
        user_name: user,
    });

    res.json({ success: true, message: result });
});

// -- POST /api/v2/items/:id/resolve
app.post('/api/v2/items/:id/resolve', apiWriteLimiter, v2Auth, (req, res) => {
    const result = itemsDb.resolveItem(req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Item not found' });
    sendWebhook('item.resolved', { id: req.params.id });
    res.json({ success: true });
});

// -- POST /api/v2/items/:id/assign
app.post('/api/v2/items/:id/assign', apiWriteLimiter, v2Auth, (req, res) => {
    const { assignee } = req.body;
    if (!assignee) return res.status(400).json({ error: 'Missing assignee' });
    const result = itemsDb.assignItem(req.params.id, assignee);
    if (!result.changes) return res.status(404).json({ error: 'Item not found' });
    sendWebhook('item.assigned', { id: req.params.id, assignee });
    res.json({ success: true });
});

// -- POST /api/v2/items/:id/close
app.post('/api/v2/items/:id/close', apiWriteLimiter, v2Auth, (req, res) => {
    const result = itemsDb.closeItem(req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Item not found' });
    sendWebhook('item.closed', { id: req.params.id });
    res.json({ success: true });
});

// -- POST /api/v2/items/:id/reopen
app.post('/api/v2/items/:id/reopen', apiWriteLimiter, v2Auth, (req, res) => {
    const result = itemsDb.reopenItem(req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Item not found' });
    res.json({ success: true });
});

// -- GET /api/v2/urls — list all annotated URLs for an app
app.get('/api/v2/urls', apiReadLimiter, (req, res) => {
    const app_id = req.query.app_id || 'default';
    const urls = itemsDb.getDistinctUrls(app_id);
    res.json({ urls });
});

// -- POST /api/v2/auth/apikey — issue API key (requires invite code)
app.post('/api/v2/auth/apikey', apiWriteLimiter, (req, res) => {
    const { code, name, app_id } = req.body;
    if (!code || !VALID_CODES[code]) {
        return res.status(401).json({ error: 'Valid invite code required to create API key' });
    }
    const created_by = VALID_CODES[code];
    const key = itemsDb.createApiKey({ app_id: app_id || 'default', name, created_by });
    res.json({ success: true, ...key });
});

// -- GET /api/v2/adapters — list adapter channels and their status
app.get('/api/v2/adapters', (req, res) => {
    res.json({ channels: registry.getStatus(), rules: registry.rules.length });
});

// ================================================================= Routing Rules API
//
// CRUD for user routing rules. Authenticated via V2 auth.
// =================================================================

// -- GET /api/v2/routing/rules — list rules (for current user or all if admin)
app.get('/api/v2/routing/rules', apiReadLimiter, v2Auth, (req, res) => {
    const user = req.query.user || req.v2Auth?.user;
    const parseRuleConfig = (rule) => {
        if (typeof rule.target_config === 'string') {
            try { rule.target_config = JSON.parse(rule.target_config); } catch {}
        }
        return rule;
    };
    if (user) {
        const rules = itemsDb.getUserRules(user).map(parseRuleConfig);
        return res.json({ rules });
    }
    const rules = itemsDb.getAllUserRules().map(parseRuleConfig);
    res.json({ rules });
});

// -- POST /api/v2/routing/rules — create a routing rule
app.post('/api/v2/routing/rules', apiWriteLimiter, v2Auth, (req, res) => {
    const { rule_type, pattern, target_type, target_config, priority, userName } = req.body;
    const user = userName || req.v2Auth?.user;

    if (!user) return res.status(400).json({ error: 'Missing userName' });
    if (!rule_type) return res.status(400).json({ error: 'Missing rule_type' });
    if (!target_type) return res.status(400).json({ error: 'Missing target_type' });
    if (!target_config) return res.status(400).json({ error: 'Missing target_config' });

    const validTypes = ['url_pattern', 'content_type', 'tag_match', 'default'];
    if (!validTypes.includes(rule_type)) {
        return res.status(400).json({ error: `Invalid rule_type. Must be one of: ${validTypes.join(', ')}` });
    }
    if (rule_type !== 'default' && !pattern) {
        return res.status(400).json({ error: 'Pattern is required for non-default rules' });
    }

    const rule = itemsDb.createUserRule({
        user_name: user, rule_type, pattern,
        target_type, target_config, priority: priority || 0,
    });

    res.json({ success: true, rule });
});

// -- PUT /api/v2/routing/rules/:id — update a routing rule
app.put('/api/v2/routing/rules/:id', apiWriteLimiter, v2Auth, (req, res) => {
    const { rule_type, pattern, target_type, target_config, priority, enabled } = req.body;

    const updated = itemsDb.updateUserRule(req.params.id, {
        rule_type, pattern, target_type, target_config, priority, enabled,
    });

    if (!updated) return res.status(404).json({ error: 'Rule not found' });
    if (typeof updated.target_config === 'string') {
        try { updated.target_config = JSON.parse(updated.target_config); } catch {}
    }
    res.json({ success: true, rule: updated });
});

// -- DELETE /api/v2/routing/rules/:id — delete a routing rule
app.delete('/api/v2/routing/rules/:id', apiWriteLimiter, v2Auth, (req, res) => {
    const result = itemsDb.deleteUserRule(req.params.id);
    if (!result.success) return res.status(404).json({ error: 'Rule not found' });
    res.json({ success: true });
});

// -- POST /api/v2/routing/resolve — test routing resolution (dry run)
app.post('/api/v2/routing/resolve', apiReadLimiter, v2Auth, (req, res) => {
    const { source_url, userName, type, priority, tags } = req.body;
    const user = userName || req.v2Auth?.user;

    const result = resolveTarget({
        source_url, user_name: user, type, priority, tags,
        db: itemsDb, defaultTarget: defaultGitHubTarget,
    });

    res.json({
        target_type: result.target_type,
        target_config: result.target_config,
        method: result.method,
        matched_rule: result.matched_rule ? { id: result.matched_rule.id, pattern: result.matched_rule.pattern } : null,
    });
});

// ----------------------------------------------------------------- queue

// Get the consumer queue — open + in-progress items sorted by priority
app.get('/queue', (req, res) => {
    const items = itemsDb.getQueue();
    res.json({ items });
});

// ----------------------------------------------------------------- stats

app.get('/stats', (req, res) => {
    const { doc } = req.query;
    const stats = itemsDb.getStats(doc);
    res.json({ stats });
});

// ----------------------------------------------------------------- health

app.get('/health', (req, res) => {
    let dbOk = true;
    try { itemsDb.db.prepare('SELECT 1').get(); } catch { dbOk = false; }
    res.json({
        status: 'ok',
        version: '0.3.0',
        uptime: process.uptime(),
        db_ok: dbOk,
        adapters: Object.keys(registry.getStatus()).length,
    });
});

// ----------------------------------------------------------------- listen

app.listen(PORT, () => {
    console.log(`[+] ClawMark V2 server running on port ${PORT}`);
    console.log(`    data dir  : ${DATA_DIR}`);
    console.log(`    adapters  : ${Object.keys(registry.getStatus()).length} channel(s)`);
    console.log(`    auth      : ${Object.keys(VALID_CODES).length} invite code(s)`);
    console.log(`    api v2    : /api/v2/*`);
});
