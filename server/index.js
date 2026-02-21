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

// ---------------------------------------------------------------------- express

const app = express();
app.use(express.json());

// Trust first proxy (for correct IP logging behind nginx/caddy)
app.set('trust proxy', 1);

// ---------------------------------------------------------------------- multer

const upload = multer({
    storage: multer.diskStorage({
        destination: UPLOAD_DIR,
        filename: (req, file, cb) =>
            cb(null, Date.now() + '-' + Math.random().toString(36).substr(2, 6) +
               path.extname(file.originalname || '.png'))
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/'))
});

// ------------------------------------------------------------------ webhook

/**
 * Fire-and-forget POST to the configured webhook URL.
 *
 * @param {string} event   Event name, e.g. 'item.created'
 * @param {object} payload Arbitrary JSON payload
 */
function sendWebhook(event, payload) {
    const url = WEBHOOK.url;
    const allowedEvents = WEBHOOK.events;

    if (!url) return;
    if (allowedEvents && allowedEvents.length && !allowedEvents.includes(event)) return;

    const body = JSON.stringify({ event, payload, timestamp: new Date().toISOString() });
    const secret = WEBHOOK.secret || '';

    try {
        const parsed = new URL(url);
        const isHttps = parsed.protocol === 'https:';
        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                ...(secret ? { 'X-ClawMark-Secret': secret } : {})
            }
        };

        const req = (isHttps ? https : http).request(options, (res) => {
            console.log(`[webhook] ${event} → ${res.statusCode}`);
        });
        req.on('error', (err) => console.error('[webhook] error:', err.message));
        req.write(body);
        req.end();
    } catch (err) {
        console.error('[webhook] failed to send:', err.message);
    }
}

// ------------------------------------------------------------------- auth

// Verify invite code — returns { valid: bool, userName?: string }
app.post('/verify', (req, res) => {
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
app.post('/upload', upload.single('image'), (req, res) => {
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
    const { doc, type, title, quote, quote_position, priority, message, userName, version } = req.body;
    const app_id = resolveAppId(req);

    if (!doc || !userName) return res.status(400).json({ error: 'Missing doc or userName' });
    if (type === 'issue' && !title) return res.status(400).json({ error: 'Issue requires a title' });

    const item = itemsDb.createItem({
        app_id, doc, type: type || 'discuss', title, quote, quote_position,
        priority: priority || 'normal', created_by: userName, version, message
    });

    sendWebhook('item.created', { app_id, item });

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
    itemsDb.assignItem(req.params.id, assignee);
    sendWebhook('item.assigned', { id: req.params.id, assignee });
    res.json({ success: true });
}

// -- POST /items/:id/resolve
function handleResolveItem(req, res) {
    itemsDb.resolveItem(req.params.id);
    sendWebhook('item.resolved', { id: req.params.id });
    res.json({ success: true });
}

// -- POST /items/:id/verify
function handleVerifyItem(req, res) {
    itemsDb.verifyItem(req.params.id);
    res.json({ success: true });
}

// -- POST /items/:id/reopen
function handleReopenItem(req, res) {
    itemsDb.reopenItem(req.params.id);
    res.json({ success: true });
}

// -- POST /items/:id/close
function handleCloseItem(req, res) {
    itemsDb.closeItem(req.params.id);
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
app.get('/items',              handleGetItems);
app.post('/items',             handleCreateItem);
app.get('/items-full',         handleGetItemsFull);
app.get('/items/:id',          handleGetItem);
app.post('/items/:id/messages', handleAddMessage);
app.post('/items/:id/assign',  handleAssignItem);
app.post('/items/:id/resolve', handleResolveItem);
app.post('/items/:id/verify',  handleVerifyItem);
app.post('/items/:id/reopen',  handleReopenItem);
app.post('/items/:id/close',   handleCloseItem);
app.post('/items/:id/respond', handleRespondToItem);

// Namespaced routes (multi-app)
app.get('/api/clawmark/:app/items',              handleGetItems);
app.post('/api/clawmark/:app/items',             handleCreateItem);
app.get('/api/clawmark/:app/items-full',         handleGetItemsFull);
app.get('/api/clawmark/:app/items/:id',          handleGetItem);
app.post('/api/clawmark/:app/items/:id/messages', handleAddMessage);
app.post('/api/clawmark/:app/items/:id/assign',  handleAssignItem);
app.post('/api/clawmark/:app/items/:id/resolve', handleResolveItem);
app.post('/api/clawmark/:app/items/:id/verify',  handleVerifyItem);
app.post('/api/clawmark/:app/items/:id/reopen',  handleReopenItem);
app.post('/api/clawmark/:app/items/:id/close',   handleCloseItem);
app.post('/api/clawmark/:app/items/:id/respond', handleRespondToItem);

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
    res.json({ status: 'ok', uptime: process.uptime() });
});

// ----------------------------------------------------------------- listen

app.listen(PORT, () => {
    console.log(`[+] ClawMark server running on port ${PORT}`);
    console.log(`    data dir : ${DATA_DIR}`);
    console.log(`    webhook  : ${WEBHOOK.url || '(not configured)'}`);
    console.log(`    auth     : ${Object.keys(VALID_CODES).length} invite code(s)`);
});
