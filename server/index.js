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

const pkg = require('../package.json');

const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

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

// Auth config — invite codes REMOVED (data isolation Phase 1, Kevin directive).
// Empty object retained only to prevent runtime errors if any dead code references it.
const VALID_CODES = {};

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

// ------------------------------------------------------------------ auth module
const { initAuth } = require('./auth');
const JWT_SECRET = process.env.CLAWMARK_JWT_SECRET
    || (config.auth && config.auth.jwtSecret)
    || null;

if (!JWT_SECRET && process.env.NODE_ENV === 'production') {
    console.error('[FATAL] CLAWMARK_JWT_SECRET is not set. Refusing to start in production without a JWT secret.');
    console.error('Set CLAWMARK_JWT_SECRET environment variable or auth.jwtSecret in config.json.');
    process.exit(1);
}
if (!JWT_SECRET) {
    console.warn('[SECURITY WARNING] JWT_SECRET not configured — authentication is effectively disabled. Do NOT run this in production.');
}

const GOOGLE_CLIENT_ID = process.env.CLAWMARK_GOOGLE_CLIENT_ID
    || (config.auth && config.auth.googleClientId)
    || null;
const GOOGLE_CLIENT_SECRET = process.env.CLAWMARK_GOOGLE_CLIENT_SECRET
    || (config.auth && config.auth.googleClientSecret)
    || null;

const { router: authRouter, verifyJwt } = initAuth({
    db: itemsDb,
    jwtSecret: JWT_SECRET,
    googleClientId: GOOGLE_CLIENT_ID,
    googleClientSecret: GOOGLE_CLIENT_SECRET,
});

// ------------------------------------------------------------------ adapters

const { AdapterRegistry } = require('./adapters/index');
const { WebhookAdapter } = require('./adapters/webhook');
const { LarkAdapter } = require('./adapters/lark');
const { TelegramAdapter } = require('./adapters/telegram');
const { GitHubIssueAdapter } = require('./adapters/github-issue');
const { SlackAdapter } = require('./adapters/slack');
const { EmailAdapter } = require('./adapters/email');
const { LinearAdapter } = require('./adapters/linear');
const { JiraAdapter } = require('./adapters/jira');
const { HxaConnectAdapter } = require('./adapters/hxa-connect');
const { GitLabIssueAdapter } = require('./adapters/gitlab-issue');
const { resolveTarget, resolveTargets } = require('./routing');
const { resolveDeclaration } = require('./target-declaration');
const { recommendRoute, classifyAnnotation, VALID_CLASSIFICATIONS, generateTags, clusterAnnotations, analyzeScreenshot } = require('./ai');

const registry = new AdapterRegistry();
registry.setDb(itemsDb);
registry.registerType('webhook', WebhookAdapter);
registry.registerType('lark', LarkAdapter);
registry.registerType('telegram', TelegramAdapter);
registry.registerType('github-issue', GitHubIssueAdapter);
registry.registerType('slack', SlackAdapter);
registry.registerType('email', EmailAdapter);
registry.registerType('linear', LinearAdapter);
registry.registerType('jira', JiraAdapter);
registry.registerType('hxa-connect', HxaConnectAdapter);
registry.registerType('gitlab-issue', GitLabIssueAdapter);

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

// Security headers (CSP disabled — needs per-route tuning for dashboard inline scripts + widget iframe)
app.use(helmet({ contentSecurityPolicy: false }));

// ---------------------------------------------------------------------- CORS
const ALLOWED_ORIGINS = config.allowedOrigins || [];
if (ALLOWED_ORIGINS.length) {
    app.use((req, res, next) => {
        const origin = req.headers.origin;
        if (origin && ALLOWED_ORIGINS.includes(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
            res.setHeader('Access-Control-Allow-Credentials', 'true');
            if (req.method === 'OPTIONS') return res.sendStatus(204);
        }
        next();
    });
}

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

const aiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'AI rate limit exceeded, try again later' },
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
/**
 * Dispatch event through the adapter registry.
 * For item.created, returns dispatch results so the caller can surface failures.
 * Other events remain fire-and-forget.
 *
 * @param {string} event   Event name, e.g. 'item.created'
 * @param {object} payload The item/data payload
 * @returns {Array|undefined} Dispatch results for item.created, undefined otherwise
 */
async function sendWebhook(event, payload) {
    if (event === 'item.created') {
        // Fetch target declaration (async — checks .clawmark.yml or /.well-known/clawmark.json)
        let declaration = null;
        try {
            declaration = await resolveDeclaration(payload.source_url);
        } catch (err) {
            console.error(`[declaration] Failed to fetch for ${payload.source_url}:`, err.message);
        }

        // Resolve ALL matching targets (#93 multi-target dispatch)
        const targets = resolveTargets({
            source_url: payload.source_url,
            user_name: payload.created_by,
            type: payload.type,
            priority: payload.priority,
            tags: payload.tags,
            db: itemsDb,
            defaultTarget: defaultGitHubTarget,
            declaration,
        });

        // If user selected specific targets in the UI, filter to only those
        let filteredTargets = targets;
        if (payload._selected_targets && Array.isArray(payload._selected_targets)) {
            const selected = new Set(payload._selected_targets.map(s =>
                `${s.target_type}:${s.method}`
            ));
            filteredTargets = targets.filter(t => selected.has(`${t.target_type}:${t.method}`));
            // Fall back to all targets if filter results in empty (safety net)
            if (filteredTargets.length === 0) filteredTargets = targets;
            delete payload._selected_targets;
        }

        // Inject auth credentials from user_auths into targets that reference an auth_id.
        // Use spread to create a new object — the original target_config must stay clean
        // because dispatchToTargets serializes it into dispatch_log.
        for (const t of filteredTargets) {
            if (t.matched_rule && t.matched_rule.auth_id) {
                const auth = itemsDb.getUserAuth(t.matched_rule.auth_id);
                if (auth) {
                    let creds;
                    try { creds = typeof auth.credentials === 'string' ? JSON.parse(auth.credentials) : auth.credentials; } catch { creds = {}; }
                    t.target_config = { ...t.target_config, ...creds };
                } else {
                    console.warn(`[routing] Auth ${t.matched_rule.auth_id} referenced by rule ${t.matched_rule.id} not found`);
                }
            }
        }

        console.log(`[routing] ${event}: ${filteredTargets.length} target(s) — ${filteredTargets.map(t => `${t.method}→${t.target_type}`).join(', ')}`);

        // Store routing decision on the item for debugging/auditing
        payload._routing = filteredTargets.map(t => ({ method: t.method, target_type: t.target_type, repo: t.target_config.repo }));

        // Multi-target dispatch with tracking — await results (#200)
        try {
            const results = await registry.dispatchToTargets(event, payload, filteredTargets, {});
            return results;
        } catch (err) {
            console.error(`[dispatch] Multi-target dispatch failed for ${event}:`, err.message);
            // Fallback to static dispatch on error
            registry.dispatch(event, payload).catch(e => {
                console.error(`[dispatch] Fallback also failed:`, e.message);
            });
            return [{ target_type: 'unknown', status: 'failed', error: err.message }];
        }
    }

    // Default static dispatch (for non-routed events or system_default routing)
    registry.dispatch(event, payload).catch(err => {
        console.error(`[dispatch] Unexpected error for ${event}:`, err.message);
    });
}

// ------------------------------------------------------------------- auth

// Verify invite code — REMOVED (data isolation Phase 1).
// Returns 410 Gone — invite code mechanism fully removed per Kevin directive.
const verifyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Too many attempts, try again later' } });
app.post('/verify', verifyLimiter, (req, res) => {
    res.status(410).json({ error: 'Invite codes have been removed. Use Google OAuth to sign in.' });
});

// Mount OAuth auth routes
app.use('/api/v2/auth', authRouter);

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

// Get discussions for a document (auth added per #239 C-2)
app.get('/discussions', v2Auth, (req, res) => {
    const { doc, version } = req.query;
    if (!doc) return res.status(400).json({ error: 'Missing doc parameter' });

    const data = loadDiscussions(doc);
    let { discussions } = data;
    if (version) discussions = discussions.filter(d => d.version === version);

    res.json({ discussions });
});

// Create a new discussion or add a message to an existing one
app.post('/discussions', v2Auth, (req, res) => {
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
app.post('/respond', v2Auth, (req, res) => {
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
app.post('/discussions/resolve', v2Auth, (req, res) => {
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
app.post('/submit-reply', v2Auth, (req, res) => {
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
app.get('/pending', v2Auth, (req, res) => {
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
app.post('/upload', uploadLimiter, v2Auth, upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    const url = '/images/' + req.file.filename;
    res.json({ success: true, url });
});

// Serve uploaded images
app.use('/images', express.static(UPLOAD_DIR));

// Validate that a screenshot URL matches the server-generated upload pattern.
// Multer filenames: <timestamp>-<6char_random>.<ext> (e.g. "1709300000000-a1b2c3.png")
// Rejects arbitrary filenames to prevent cross-user file access via crafted screenshots arrays.
const UPLOAD_FILENAME_RE = /^\d+-[a-z0-9]{6}\.\w+$/;
function sanitizeScreenshotUrl(url) {
    if (typeof url !== 'string') return null;
    const filename = path.basename(url.replace(/^\/images\//, ''));
    return UPLOAD_FILENAME_RE.test(filename) ? filename : null;
}

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

    // Async classification — fire-and-forget, doesn't block response
    const aiApiKey = process.env.GEMINI_API_KEY || config.ai?.apiKey;
    if (aiApiKey) {
        classifyAnnotation({
            source_url, source_title, content: message || title, quote, type,
            apiKey: aiApiKey,
        }).then(({ classification, confidence }) => {
            itemsDb.updateItemClassificationIfNull(item.id, classification, confidence);
        }).catch(err => {
            console.error(`[AI] Auto-classify failed for ${item.id}:`, err.message);
        });
    }

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
//
// DEPRECATED: V1 routes lack authentication and bypass data isolation.
// Use /api/v2/ endpoints instead. Sunset date: 2026-06-01.

// Deprecation middleware for V1 routes
function v1Deprecated(req, res, next) {
    res.set('Deprecation', 'true');
    res.set('Sunset', 'Sat, 01 Jun 2026 00:00:00 GMT');
    res.set('Link', '</api/v2/>; rel="successor-version"');
    next();
}

// Flat routes (default app) — DEPRECATED (auth added per #239 C-2)
app.get('/items',              apiReadLimiter, v1Deprecated, v2Auth, handleGetItems);
app.post('/items',             apiWriteLimiter, v1Deprecated, v2Auth, handleCreateItem);
app.get('/items-full',         apiReadLimiter, v1Deprecated, v2Auth, handleGetItemsFull);
app.get('/items/:id',          apiReadLimiter, v1Deprecated, v2Auth, handleGetItem);
app.post('/items/:id/messages', apiWriteLimiter, v1Deprecated, v2Auth, handleAddMessage);
app.post('/items/:id/assign',  apiWriteLimiter, v1Deprecated, v2Auth, handleAssignItem);
app.post('/items/:id/resolve', apiWriteLimiter, v1Deprecated, v2Auth, handleResolveItem);
app.post('/items/:id/verify',  apiWriteLimiter, v1Deprecated, v2Auth, handleVerifyItem);
app.post('/items/:id/reopen',  apiWriteLimiter, v1Deprecated, v2Auth, handleReopenItem);
app.post('/items/:id/close',   apiWriteLimiter, v1Deprecated, v2Auth, handleCloseItem);
app.post('/items/:id/respond', apiWriteLimiter, v1Deprecated, v2Auth, handleRespondToItem);

// Namespaced routes (multi-app) — DEPRECATED (auth added per #239 C-2)
app.get('/api/clawmark/:app/items',              apiReadLimiter, v1Deprecated, v2Auth, handleGetItems);
app.post('/api/clawmark/:app/items',             apiWriteLimiter, v1Deprecated, v2Auth, handleCreateItem);
app.get('/api/clawmark/:app/items-full',         apiReadLimiter, v1Deprecated, v2Auth, handleGetItemsFull);
app.get('/api/clawmark/:app/items/:id',          apiReadLimiter, v1Deprecated, v2Auth, handleGetItem);
app.post('/api/clawmark/:app/items/:id/messages', apiWriteLimiter, v1Deprecated, v2Auth, handleAddMessage);
app.post('/api/clawmark/:app/items/:id/assign',  apiWriteLimiter, v1Deprecated, v2Auth, handleAssignItem);
app.post('/api/clawmark/:app/items/:id/resolve', apiWriteLimiter, v1Deprecated, v2Auth, handleResolveItem);
app.post('/api/clawmark/:app/items/:id/verify',  apiWriteLimiter, v1Deprecated, v2Auth, handleVerifyItem);
app.post('/api/clawmark/:app/items/:id/reopen',  apiWriteLimiter, v1Deprecated, v2Auth, handleReopenItem);
app.post('/api/clawmark/:app/items/:id/close',   apiWriteLimiter, v1Deprecated, v2Auth, handleCloseItem);
app.post('/api/clawmark/:app/items/:id/respond', apiWriteLimiter, v1Deprecated, v2Auth, handleRespondToItem);

// ================================================================= V2 API
//
// New /api/v2/ endpoints for ClawMark V2.
// Supports source_url, source_title, tags, screenshots.
// Backward compatible — V1 routes above remain unchanged.
// =================================================================

// -- V2 auth middleware: accept JWT or API key (invite codes deprecated)
function v2Auth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7);

        // API key (cmk_ prefix)
        if (token.startsWith('cmk_')) {
            const apiKey = itemsDb.validateApiKey(token);
            if (apiKey) {
                req.v2Auth = { type: 'apikey', app_id: apiKey.app_id, user: apiKey.created_by, keyName: apiKey.name };
                return next();
            }
            return res.status(401).json({ error: 'Invalid API key' });
        }

        // JWT token
        if (verifyJwt) {
            const payload = verifyJwt(token);
            if (payload) {
                // Resolve app_id from user's default app
                const defaultApp = itemsDb.getOrCreateDefaultApp(payload.userId, payload.email);
                req.v2Auth = {
                    type: 'jwt',
                    app_id: defaultApp ? defaultApp.id : null,
                    user: payload.email,
                    userId: payload.userId,
                    role: payload.role,
                };
                return next();
            }
        }

        return res.status(401).json({ error: 'Invalid token' });
    }
    return res.status(401).json({ error: 'Authentication required (JWT or API key)' });
}

// -- GET /api/v2/user/settings — get current user's settings
app.get('/api/v2/user/settings', apiReadLimiter, v2Auth, (req, res) => {
    if (!req.v2Auth?.userId) return res.status(401).json({ error: 'JWT auth required' });
    const settings = itemsDb.getUserSettings(req.v2Auth.userId);
    res.json({ settings });
});

// -- PUT /api/v2/user/settings — update current user's settings (merge patch)
app.put('/api/v2/user/settings', apiWriteLimiter, v2Auth, (req, res) => {
    if (!req.v2Auth?.userId) return res.status(401).json({ error: 'JWT auth required' });
    const patch = req.body;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return res.status(400).json({ error: 'Body must be a JSON object' });
    }
    const settings = itemsDb.updateUserSettings(req.v2Auth.userId, patch);
    res.json({ settings });
});

// -- POST /api/v2/items — create item with full V2 schema
app.post('/api/v2/items', apiWriteLimiter, v2Auth, async (req, res) => {
    const { type, source_url, source_title, quote, quote_position,
            screenshots, title, content, priority, tags, userName, version,
            selected_targets } = req.body;

    const user = req.v2Auth?.user || userName;
    // Always use server-resolved app_id from auth — never trust client-supplied app_id
    const resolvedAppId = req.v2Auth?.app_id;
    if (!resolvedAppId) {
        return res.status(400).json({ error: 'Could not resolve app_id — ensure you are authenticated' });
    }
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

    // Pass selected_targets to constrain dispatch if user made a selection
    if (selected_targets && Array.isArray(selected_targets)) {
        item._selected_targets = selected_targets;
    }

    // Await dispatch results with timeout so we can report failures (#200)
    let dispatches = [];
    try {
        const dispatchPromise = sendWebhook('item.created', item);
        const timeoutPromise = new Promise(resolve =>
            setTimeout(() => resolve([{ target_type: 'unknown', status: 'timeout' }]), 10000)
        );
        dispatches = await Promise.race([dispatchPromise, timeoutPromise]) || [];
    } catch (err) {
        console.error(`[dispatch] Error awaiting dispatch for item ${item.id}:`, err.message);
        dispatches = [{ target_type: 'unknown', status: 'failed', error: err.message }];
    }

    // Build dispatch summary for client
    const dispatchSummary = dispatches.map(d => ({
        target_type: d?.target_type || 'unknown',
        status: d?.status || 'unknown',
        error: d?.error || undefined,
        label: d?.target_type === 'github-issue'
            ? `GitHub`
            : (d?.target_type || 'unknown'),
    }));

    const hasFailed = dispatchSummary.some(d => d.status === 'failed' || d.status === 'timeout');

    // Async classification — fire-and-forget, doesn't block response (M2: only if not already classified)
    const v2AiKey = process.env.GEMINI_API_KEY || config.ai?.apiKey;
    if (v2AiKey) {
        classifyAnnotation({
            source_url: source_url || null, source_title: source_title || null,
            content: content || title, quote, type,
            apiKey: v2AiKey,
        }).then(({ classification, confidence }) => {
            itemsDb.updateItemClassificationIfNull(item.id, classification, confidence);
        }).catch(err => {
            console.error(`[AI] Auto-classify failed for ${item.id}:`, err.message);
        });

        // Auto-analyze screenshots if present (#117)
        if (Array.isArray(screenshots) && screenshots.length > 0) {
            const filename = sanitizeScreenshotUrl(screenshots[0]);
            if (filename) {
                const imagePath = path.resolve(UPLOAD_DIR, filename);
                analyzeScreenshot({
                    imagePath,
                    baseDir: UPLOAD_DIR,
                    source_url: source_url || null,
                    source_title: source_title || null,
                    content: content || title,
                    quote,
                    apiKey: v2AiKey,
                }).then((analysis) => {
                    itemsDb.updateItemScreenshotAnalysis(item.id, analysis);
                }).catch(err => {
                    console.error(`[AI] Auto-analyze screenshot failed for ${item.id}:`, err.message);
                });
            }
        }
    }

    res.json({
        success: true,
        item,
        dispatched: dispatchSummary,
        dispatch_warning: hasFailed ? '部分投递失败，请在面板中查看详情' : undefined,
    });
});

// -- GET /api/v2/items — query with url/tag support
app.get('/api/v2/items', apiReadLimiter, v2Auth, (req, res) => {
    const { url, tag, doc, type, status, assignee } = req.query;
    // Always use server-resolved app_id from auth — never trust client-supplied app_id
    // GL#21: Dashboard always shows user's own data. Admin features are separate.
    const resolvedAppId = req.v2Auth?.app_id;
    if (!resolvedAppId) {
        return res.status(400).json({ error: 'Could not resolve app_id — ensure you are authenticated' });
    }

    // Attach compact dispatch summary to each item
    function attachDispatches(items) {
        for (const item of items) {
            const dispatches = itemsDb.getDispatchLog(item.id);
            if (dispatches.length > 0) {
                item.dispatches = dispatches.map(d => ({
                    target_type: d.target_type, status: d.status,
                    external_url: d.external_url, method: d.method,
                }));
            }
        }
        return items;
    }

    if (url) {
        const items = itemsDb.getItemsByUrl({ app_id: resolvedAppId, url });
        return res.json({ items: attachDispatches(items) });
    }
    if (tag) {
        const items = itemsDb.getItemsByTag({ app_id: resolvedAppId, tag });
        return res.json({ items: attachDispatches(items) });
    }

    const items = itemsDb.getItems({ app_id: resolvedAppId, doc, type, status, assignee });
    res.json({ items: attachDispatches(items) });
});

// -- GET /api/v2/items/:id
app.get('/api/v2/items/:id', apiReadLimiter, v2Auth, (req, res) => {
    const item = itemsDb.getItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    // Enforce app_id scoping: user can only access items in their app
    if (req.v2Auth?.app_id && item.app_id !== req.v2Auth.app_id) {
        return res.status(403).json({ error: 'Access denied — item belongs to a different app' });
    }
    // Parse JSON fields for client convenience
    if (typeof item.tags === 'string') item.tags = JSON.parse(item.tags || '[]');
    if (typeof item.screenshots === 'string') item.screenshots = JSON.parse(item.screenshots || '[]');
    if (typeof item.screenshot_analysis === 'string') {
        try { item.screenshot_analysis = JSON.parse(item.screenshot_analysis); } catch { /* leave as string */ }
    }
    // Include dispatch status if dispatches exist
    const dispatches = itemsDb.getDispatchLog(item.id);
    if (dispatches.length > 0) {
        item.dispatches = dispatches.map(d => ({
            id: d.id, target_type: d.target_type, status: d.status,
            external_url: d.external_url, method: d.method,
        }));
    }
    res.json(item);
});

// -- POST /api/v2/items/:id/tags — add or remove tags
app.post('/api/v2/items/:id/tags', apiWriteLimiter, v2Auth, (req, res) => {
    const { add, remove } = req.body;
    const item = itemsDb.getItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (req.v2Auth?.app_id && item.app_id !== req.v2Auth.app_id) {
        return res.status(403).json({ error: 'Access denied — item belongs to a different app' });
    }

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
    if (req.v2Auth?.app_id && item.app_id !== req.v2Auth.app_id) {
        return res.status(403).json({ error: 'Access denied — item belongs to a different app' });
    }

    const user = req.v2Auth?.user || userName;
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
    const item = itemsDb.getItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (req.v2Auth?.app_id && item.app_id !== req.v2Auth.app_id) {
        return res.status(403).json({ error: 'Access denied — item belongs to a different app' });
    }
    const result = itemsDb.resolveItem(req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Item not found' });
    sendWebhook('item.resolved', { id: req.params.id });
    res.json({ success: true });
});

// -- POST /api/v2/items/:id/assign
app.post('/api/v2/items/:id/assign', apiWriteLimiter, v2Auth, (req, res) => {
    const { assignee } = req.body;
    if (!assignee) return res.status(400).json({ error: 'Missing assignee' });
    const item = itemsDb.getItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (req.v2Auth?.app_id && item.app_id !== req.v2Auth.app_id) {
        return res.status(403).json({ error: 'Access denied — item belongs to a different app' });
    }
    const result = itemsDb.assignItem(req.params.id, assignee);
    if (!result.changes) return res.status(404).json({ error: 'Item not found' });
    sendWebhook('item.assigned', { id: req.params.id, assignee });
    res.json({ success: true });
});

// -- POST /api/v2/items/:id/close
app.post('/api/v2/items/:id/close', apiWriteLimiter, v2Auth, (req, res) => {
    const item = itemsDb.getItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (req.v2Auth?.app_id && item.app_id !== req.v2Auth.app_id) {
        return res.status(403).json({ error: 'Access denied — item belongs to a different app' });
    }
    const result = itemsDb.closeItem(req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Item not found' });
    sendWebhook('item.closed', { id: req.params.id });
    res.json({ success: true });
});

// -- POST /api/v2/items/:id/reopen
app.post('/api/v2/items/:id/reopen', apiWriteLimiter, v2Auth, (req, res) => {
    const item = itemsDb.getItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (req.v2Auth?.app_id && item.app_id !== req.v2Auth.app_id) {
        return res.status(403).json({ error: 'Access denied — item belongs to a different app' });
    }
    const result = itemsDb.reopenItem(req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Item not found' });
    res.json({ success: true });
});

// -- GET /api/v2/urls — list all annotated URLs for an app
app.get('/api/v2/urls', apiReadLimiter, v2Auth, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    if (!app_id) {
        return res.status(400).json({ error: 'Could not resolve app_id — ensure you are authenticated' });
    }
    const urls = itemsDb.getDistinctUrls(app_id);
    res.json({ urls });
});

// -- POST /api/v2/auth/apikey-legacy — DEPRECATED (data isolation Phase 1)
// Invite codes are no longer supported. Returns 410 Gone.
app.post('/api/v2/auth/apikey-legacy', apiWriteLimiter, (req, res) => {
    res.status(410).json({ error: 'Invite codes are deprecated. Use JWT auth via /api/v2/auth/apikey.' });
});

// -- GET /api/v2/adapters — list adapter channels and their status
app.get('/api/v2/adapters', (req, res) => {
    res.json({ channels: registry.getStatus(), rules: registry.rules.length });
});

// ================================================================= Distribution Log API (#93)
//
// Query dispatch status for items. Authenticated via V2 auth.
// =================================================================

// -- GET /api/v2/distributions/:item_id — get dispatch log for an item
app.get('/api/v2/distributions/:item_id', apiReadLimiter, v2Auth, (req, res) => {
    // Verify item belongs to caller's app
    const item = itemsDb.getItem(req.params.item_id);
    if (item && req.v2Auth?.app_id && item.app_id !== req.v2Auth.app_id) {
        return res.status(403).json({ error: 'Access denied — item belongs to a different app' });
    }
    const log = itemsDb.getDispatchLog(req.params.item_id);
    const parsed = log.map(entry => {
        try { entry.target_config = redactConfig(JSON.parse(entry.target_config)); } catch {
            entry.target_config = {};
        }
        return entry;
    });
    res.json({ item_id: req.params.item_id, dispatches: parsed });
});

// -- POST /api/v2/distributions/:item_id/retry — retry failed dispatches for an item
app.post('/api/v2/distributions/:item_id/retry', apiWriteLimiter, v2Auth, async (req, res) => {
    // Verify item belongs to caller's app
    const item = itemsDb.getItem(req.params.item_id);
    if (item && req.v2Auth?.app_id && item.app_id !== req.v2Auth.app_id) {
        return res.status(403).json({ error: 'Access denied — item belongs to a different app' });
    }
    const log = itemsDb.getDispatchLog(req.params.item_id);
    const failed = log.filter(e => e.status === 'failed' || e.status === 'exhausted');
    if (failed.length === 0) {
        return res.json({ message: 'No failed dispatches to retry', retried: 0 });
    }

    // Reset failed entries to pending with retries=0
    for (const entry of failed) {
        itemsDb.updateDispatchEntry(entry.id, {
            status: 'pending', retries: 0, last_error: null,
        });
    }

    res.json({ message: `Reset ${failed.length} dispatch(es) for retry`, retried: failed.length });
});

// ================================================================= Routing Rules API
//
// CRUD for user routing rules. Authenticated via V2 auth.
// =================================================================

// -- GET /api/v2/routing/rules — list rules (for current user or all if admin)
app.get('/api/v2/routing/rules', apiReadLimiter, v2Auth, (req, res) => {
    // Always use auth-resolved user identity — never trust client-supplied user param
    const user = req.v2Auth?.user;

    // Build auth name lookup for this user
    const authMap = {};
    if (user) {
        for (const auth of itemsDb.getUserAuths(user)) {
            authMap[auth.id] = auth.name;
        }
    }

    const parseRuleConfig = (rule) => {
        if (typeof rule.target_config === 'string') {
            try { rule.target_config = JSON.parse(rule.target_config); } catch {}
        }
        rule.target_config = redactConfig(rule.target_config);
        // Attach auth name for display
        if (rule.auth_id) {
            rule.auth_name = authMap[rule.auth_id] || null;
        }
        return rule;
    };
    if (!user) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    const rules = itemsDb.getUserRules(user).map(parseRuleConfig);
    res.json({ rules });
});

// -- POST /api/v2/routing/rules — create a routing rule
app.post('/api/v2/routing/rules', apiWriteLimiter, v2Auth, (req, res) => {
    const { rule_type, pattern, target_type, target_config, priority, auth_id } = req.body;
    // Always use auth-resolved user identity — never trust client-supplied userName
    const user = req.v2Auth?.user;

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

    // Validate auth_id belongs to this user
    if (auth_id) {
        const auth = itemsDb.getUserAuth(auth_id);
        if (!auth || auth.user_name !== user) {
            return res.status(400).json({ error: 'Invalid auth_id — auth not found or not owned by you' });
        }
    }

    const rule = itemsDb.createUserRule({
        user_name: user, rule_type, pattern,
        target_type, target_config, priority: priority || 0,
        auth_id: auth_id || null,
    });

    res.json({ success: true, rule });
});

// -- PUT /api/v2/routing/rules/:id — update a routing rule (ownership check)
app.put('/api/v2/routing/rules/:id', apiWriteLimiter, v2Auth, (req, res) => {
    const { rule_type, pattern, target_type, target_config, priority, enabled, auth_id } = req.body;

    // Ownership check: verify the rule belongs to this user
    const existing = itemsDb.getUserRule(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Rule not found' });
    if (existing.user_name !== req.v2Auth?.user) {
        return res.status(403).json({ error: 'Not authorized to modify this rule' });
    }

    // Validate auth_id belongs to this user
    if (auth_id) {
        const auth = itemsDb.getUserAuth(auth_id);
        if (!auth || auth.user_name !== req.v2Auth?.user) {
            return res.status(400).json({ error: 'Invalid auth_id — auth not found or not owned by you' });
        }
    }

    const updated = itemsDb.updateUserRule(req.params.id, {
        rule_type, pattern, target_type, target_config, priority, enabled,
        auth_id: auth_id !== undefined ? auth_id : undefined,
    });

    if (!updated) return res.status(404).json({ error: 'Rule not found' });
    if (typeof updated.target_config === 'string') {
        try { updated.target_config = JSON.parse(updated.target_config); } catch {}
    }
    res.json({ success: true, rule: updated });
});

// -- DELETE /api/v2/routing/rules/:id — delete a routing rule (ownership check)
app.delete('/api/v2/routing/rules/:id', apiWriteLimiter, v2Auth, (req, res) => {
    // Ownership check: verify the rule belongs to this user
    const existing = itemsDb.getUserRule(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Rule not found' });
    if (existing.user_name !== req.v2Auth?.user) {
        return res.status(403).json({ error: 'Not authorized to delete this rule' });
    }

    const result = itemsDb.deleteUserRule(req.params.id);
    if (!result.success) return res.status(404).json({ error: 'Rule not found' });
    res.json({ success: true });
});

// -- POST /api/v2/routing/resolve — test routing resolution (dry run)
// Returns ALL matching targets so the extension can show dispatch preview.
app.post('/api/v2/routing/resolve', apiReadLimiter, v2Auth, async (req, res) => {
    const { source_url, type, priority, tags } = req.body;
    // Always use auth-resolved user identity
    const user = req.v2Auth?.user;

    // Fetch target declaration
    let declaration = null;
    try {
        declaration = await resolveDeclaration(source_url);
    } catch { /* ignore */ }

    const targets = resolveTargets({
        source_url, user_name: user, type, priority, tags,
        db: itemsDb, defaultTarget: defaultGitHubTarget,
        declaration,
    });

    res.json({
        targets: targets.map(t => ({
            target_type: t.target_type,
            target_config: redactConfig(
                typeof t.target_config === 'string' ? JSON.parse(t.target_config) : t.target_config
            ),
            method: t.method,
            matched_rule: t.matched_rule ? { id: t.matched_rule.id, pattern: t.matched_rule.pattern, auth_id: t.matched_rule.auth_id || null } : null,
        })),
        // Legacy single-target fields for backward compatibility (e.g., checkTargetInjection)
        target_type: targets[0]?.target_type,
        target_config: targets[0]?.target_config,
        method: targets[0]?.method,
        js_injection: declaration?.js_injection ?? true,
    });
});

// ================================================================= Auth Management API
//
// CRUD for user auth credentials. Decouples credentials from routing rules.
// =================================================================

/** Redact credentials for safe API responses. */
function redactCredentials(creds) {
    if (!creds || typeof creds !== 'object') return creds;
    const redacted = { ...creds };
    for (const key of Object.keys(redacted)) {
        const val = String(redacted[key]);
        if (val.length > 8) {
            redacted[key] = val.slice(0, 4) + '***' + val.slice(-4);
        } else if (val.length > 0) {
            redacted[key] = '***';
        }
    }
    return redacted;
}

const parseAuthCreds = (auth) => {
    if (typeof auth.credentials === 'string') {
        try { auth.credentials = JSON.parse(auth.credentials); } catch {}
    }
    auth.credentials = redactCredentials(auth.credentials);
    return auth;
};

// -- GET /api/v2/auths — list auths for current user
app.get('/api/v2/auths', apiReadLimiter, v2Auth, (req, res) => {
    const user = req.v2Auth?.user;
    if (!user) return res.status(400).json({ error: 'Could not determine user' });
    const auths = itemsDb.getUserAuths(user).map(parseAuthCreds);
    res.json({ auths });
});

// -- POST /api/v2/auths — create a new auth
app.post('/api/v2/auths', apiWriteLimiter, v2Auth, (req, res) => {
    const { name, auth_type, credentials } = req.body;
    const user = req.v2Auth?.user;
    if (!user) return res.status(400).json({ error: 'Could not determine user' });
    if (!name || !name.trim()) return res.status(400).json({ error: 'Missing auth name' });
    if (!auth_type) return res.status(400).json({ error: 'Missing auth_type' });
    if (!credentials || typeof credentials !== 'object') {
        return res.status(400).json({ error: 'Missing credentials object' });
    }

    const validTypes = ['github-pat', 'gitlab-pat', 'lark-webhook', 'telegram-bot', 'slack-webhook',
                         'email-api', 'linear-api', 'jira-api', 'hxa-api', 'webhook-secret'];
    if (!validTypes.includes(auth_type)) {
        return res.status(400).json({ error: `Invalid auth_type. Must be one of: ${validTypes.join(', ')}` });
    }

    const auth = itemsDb.createUserAuth({ user_name: user, name: name.trim(), auth_type, credentials });
    res.json({ success: true, auth: parseAuthCreds(auth) });
});

// -- PUT /api/v2/auths/:id — update an auth
app.put('/api/v2/auths/:id', apiWriteLimiter, v2Auth, (req, res) => {
    const existing = itemsDb.getUserAuth(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Auth not found' });
    if (existing.user_name !== req.v2Auth?.user) {
        return res.status(403).json({ error: 'Not authorized to modify this auth' });
    }

    const { name, auth_type, credentials } = req.body;

    if (auth_type) {
        const validTypes = ['github-pat', 'gitlab-pat', 'lark-webhook', 'telegram-bot', 'slack-webhook',
                             'email-api', 'linear-api', 'jira-api', 'hxa-api', 'webhook-secret'];
        if (!validTypes.includes(auth_type)) {
            return res.status(400).json({ error: `Invalid auth_type. Must be one of: ${validTypes.join(', ')}` });
        }
    }

    const updated = itemsDb.updateUserAuth(req.params.id, { name, auth_type, credentials });
    if (!updated) return res.status(404).json({ error: 'Auth not found' });
    res.json({ success: true, auth: parseAuthCreds(updated) });
});

// -- DELETE /api/v2/auths/:id — delete an auth (fails if rules reference it)
app.delete('/api/v2/auths/:id', apiWriteLimiter, v2Auth, (req, res) => {
    const existing = itemsDb.getUserAuth(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Auth not found' });
    if (existing.user_name !== req.v2Auth?.user) {
        return res.status(403).json({ error: 'Not authorized to delete this auth' });
    }

    const result = itemsDb.deleteUserAuth(req.params.id);
    if (!result.success) {
        return res.status(409).json({ error: result.error || 'Cannot delete auth' });
    }
    res.json({ success: true });
});

// -- POST /api/v2/routing/recommend — AI-powered routing recommendation
app.post('/api/v2/routing/recommend', aiLimiter, v2Auth, async (req, res) => {
    const aiApiKey = process.env.GEMINI_API_KEY || config.ai?.apiKey;
    if (!aiApiKey) {
        return res.status(503).json({ error: 'AI routing not configured (missing API key)' });
    }

    const { source_url, source_title, content, quote, type, priority, tags } = req.body;
    if (!source_url) {
        return res.status(400).json({ error: 'source_url is required' });
    }

    const user = req.v2Auth?.user;
    const userRules = user ? itemsDb.getUserRules(user) : [];
    const userEndpoints = user ? itemsDb.getEndpoints(user) : [];

    try {
        const recommendation = await recommendRoute({
            source_url, source_title, content, quote,
            type, priority, tags,
            userRules, userEndpoints,
            apiKey: aiApiKey,
        });
        res.json({ recommendation });
    } catch (err) {
        console.error('[AI] Recommendation failed:', err.message);
        res.status(500).json({ error: 'AI recommendation failed' });
    }
});

// -- POST /api/v2/items/:id/classify — AI-powered classification (manual trigger/correction)
app.post('/api/v2/items/:id/classify', aiLimiter, v2Auth, async (req, res) => {
    const aiApiKey = process.env.GEMINI_API_KEY || config.ai?.apiKey;
    if (!aiApiKey) {
        return res.status(503).json({ error: 'AI classification not configured (missing API key)' });
    }

    const item = itemsDb.getItem(req.params.id);
    if (!item) {
        return res.status(404).json({ error: 'Item not found' });
    }

    // Ownership check — user can only classify items in their app scope
    const userAppId = req.v2Auth?.app_id;
    if (item.app_id !== userAppId) {
        return res.status(403).json({ error: 'Access denied — item belongs to a different app' });
    }

    // Allow manual override via body
    const { classification: manualClassification } = req.body;

    if (manualClassification) {
        if (!VALID_CLASSIFICATIONS.includes(manualClassification)) {
            return res.status(400).json({ error: `Invalid classification. Must be one of: ${VALID_CLASSIFICATIONS.join(', ')}` });
        }
        itemsDb.updateItemClassification(item.id, manualClassification, 1.0);
        return res.json({ classification: manualClassification, confidence: 1.0, reasoning: 'Manual override', source: 'manual' });
    }

    // AI classification
    try {
        const firstMessage = item.messages?.[0]?.content;
        const result = await classifyAnnotation({
            source_url: item.source_url,
            source_title: item.source_title,
            content: firstMessage || item.title,
            quote: item.quote,
            type: item.type,
            apiKey: aiApiKey,
        });
        itemsDb.updateItemClassification(item.id, result.classification, result.confidence);
        res.json({ ...result, source: 'ai' });
    } catch (err) {
        console.error('[AI] Classification failed:', err.message);
        res.status(500).json({ error: 'AI classification failed' });
    }
});

// -- GET /api/v2/items/by-classification/:classification — filter items by classification
app.get('/api/v2/items/by-classification/:classification', apiReadLimiter, v2Auth, (req, res) => {
    if (!VALID_CLASSIFICATIONS.includes(req.params.classification)) {
        return res.status(400).json({ error: `Invalid classification. Must be one of: ${VALID_CLASSIFICATIONS.join(', ')}` });
    }
    const app_id = req.v2Auth?.app_id;
    const items = itemsDb.getItemsByClassification({ app_id, classification: req.params.classification });
    res.json({ items });
});

// -- POST /api/v2/items/:id/generate-tags — AI-powered tag generation
app.post('/api/v2/items/:id/generate-tags', aiLimiter, v2Auth, async (req, res) => {
    const aiApiKey = process.env.GEMINI_API_KEY || config.ai?.apiKey;
    if (!aiApiKey) {
        return res.status(503).json({ error: 'AI tagging not configured (missing API key)' });
    }

    const item = itemsDb.getItem(req.params.id);
    if (!item) {
        return res.status(404).json({ error: 'Item not found' });
    }

    // Ownership check — user can only tag items in their app scope
    const userAppId = req.v2Auth?.app_id;
    if (item.app_id !== userAppId) {
        return res.status(403).json({ error: 'Access denied — item belongs to a different app' });
    }

    const existingTags = (() => {
        try { return JSON.parse(item.tags || '[]'); } catch { return []; }
    })();

    try {
        const firstMessage = item.messages?.[0]?.content;
        const result = await generateTags({
            source_url: item.source_url,
            source_title: item.source_title,
            content: firstMessage || item.title,
            quote: item.quote,
            type: item.type,
            existingTags,
            apiKey: aiApiKey,
        });

        if (result.tags.length > 0) {
            const { merge } = req.body || {};
            const merged = merge !== false ? [...existingTags, ...result.tags] : result.tags;
            // Cap total tags at 25 to prevent unbounded growth
            const finalTags = [...new Set(merged.map(t => t.toLowerCase()))].slice(0, 25);
            itemsDb.updateItemTags(item.id, finalTags);
            res.json({ tags: finalTags, generated: result.tags, reasoning: result.reasoning, source: 'ai' });
        } else {
            res.json({ tags: existingTags, generated: [], reasoning: result.reasoning, source: 'ai' });
        }
    } catch (err) {
        console.error('[AI] Tag generation failed:', err.message);
        res.status(500).json({ error: 'AI tag generation failed' });
    }
});


// ================================================================= Analytics API
//
// Aggregation, trends, hot topics, and AI-powered clustering.
// =================================================================

// -- GET /api/v2/analytics/summary — dashboard overview stats
// GL#21: Always show user's own data. Admin features are separate.
app.get('/api/v2/analytics/summary', apiReadLimiter, v2Auth, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    const summary = itemsDb.getAnalyticsSummary(app_id, { allApps: false });
    res.json(summary);
});

// -- GET /api/v2/analytics/trends — time-series annotation volume
app.get('/api/v2/analytics/trends', apiReadLimiter, v2Auth, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    const period = ['day', 'week', 'month'].includes(req.query.period) ? req.query.period : 'day';
    const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
    const group_by = ['classification', 'type', 'status', 'total'].includes(req.query.group_by) ? req.query.group_by : 'total';

    const trends = itemsDb.getAnalyticsTrends({ app_id, period, days, group_by, allApps: false });
    res.json({ trends, period, days, group_by });
});

// -- GET /api/v2/analytics/hot-topics — currently trending topics
app.get('/api/v2/analytics/hot-topics', apiReadLimiter, v2Auth, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    const hours = Math.max(1, Math.min(720, parseInt(req.query.hours, 10) || 24));
    const threshold = Math.max(1, Math.min(100, parseInt(req.query.threshold, 10) || 2));

    const hotTopics = itemsDb.getHotTopics({ app_id, hours, threshold, allApps: false });
    res.json(hotTopics);
});

// -- GET /api/v2/analytics/clusters — AI-powered annotation clustering
app.get('/api/v2/analytics/clusters', aiLimiter, v2Auth, async (req, res) => {
    const aiApiKey = process.env.GEMINI_API_KEY || config.ai?.apiKey;
    if (!aiApiKey) {
        return res.status(503).json({ error: 'AI clustering not configured (missing API key)' });
    }

    const app_id = req.v2Auth?.app_id;
    const days = Math.max(1, Math.min(90, parseInt(req.query.days, 10) || 7));
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 50));

    try {
        const items = itemsDb.getRecentItemsForClustering({ app_id, days, limit });
        if (items.length === 0) {
            return res.json({ clusters: [], summary: 'No annotations found in the specified time range' });
        }

        const result = await clusterAnnotations({ items, apiKey: aiApiKey });
        res.json(result);
    } catch (err) {
        console.error('[AI] Clustering failed:', err.message);
        res.status(500).json({ error: 'AI clustering failed' });
    }
});

// -- POST /api/v2/items/:id/analyze — AI-powered screenshot analysis (#117)
app.post('/api/v2/items/:id/analyze', aiLimiter, v2Auth, async (req, res) => {
    const aiApiKey = process.env.GEMINI_API_KEY || config.ai?.apiKey;
    if (!aiApiKey) {
        return res.status(503).json({ error: 'AI analysis not available' });
    }

    const item = itemsDb.getItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (req.v2Auth?.app_id && item.app_id !== req.v2Auth.app_id) {
        return res.status(403).json({ error: 'Access denied — item belongs to a different app' });
    }

    let screenshots = item.screenshots;
    if (typeof screenshots === 'string') {
        try { screenshots = JSON.parse(screenshots); } catch { screenshots = []; }
    }
    if (!Array.isArray(screenshots) || screenshots.length === 0) {
        return res.status(400).json({ error: 'Item has no screenshots to analyze' });
    }

    try {
        // Analyze the first screenshot (primary annotation)
        const filename = sanitizeScreenshotUrl(screenshots[0]);
        if (!filename) {
            return res.status(400).json({ error: 'Invalid screenshot reference' });
        }
        const imagePath = path.resolve(UPLOAD_DIR, filename);

        const analysis = await analyzeScreenshot({
            imagePath,
            baseDir: UPLOAD_DIR,
            source_url: item.source_url,
            source_title: item.source_title,
            content: item.messages?.[0]?.content || item.title || item.quote,
            quote: item.quote,
            apiKey: aiApiKey,
        });

        // Store result in DB
        itemsDb.updateItemScreenshotAnalysis(item.id, analysis);

        res.json({ success: true, analysis });
    } catch (err) {
        console.error('[AI] Screenshot analysis error:', err.message);
        res.status(500).json({ error: 'Screenshot analysis failed' });
    }
});

// ================================================================= Endpoints API
//
// CRUD for user delivery endpoints. Authenticated via V2 auth.
// =================================================================

/** Redact sensitive fields from an adapter config object. */
function redactConfig(config) {
    if (!config || typeof config !== 'object') return config;
    const redacted = { ...config };
    const sensitiveKeys = ['api_key', 'bot_token', 'token', 'secret', 'api_token'];
    for (const key of sensitiveKeys) {
        if (redacted[key]) {
            const val = String(redacted[key]);
            redacted[key] = val.length > 8 ? val.slice(0, 4) + '***' + val.slice(-4) : '***';
        }
    }
    // Redact webhook URLs that embed tokens (Slack, Lark)
    if (redacted.webhook_url) {
        try {
            const u = new URL(redacted.webhook_url);
            if (u.hostname.endsWith('slack.com') || u.hostname.includes('larksuite.com') || u.hostname.includes('feishu.cn')) {
                const parts = u.pathname.split('/');
                if (parts.length > 3) {
                    redacted.webhook_url = `${u.origin}/${parts.slice(1, 3).join('/')}/***`;
                }
            }
        } catch {}
    }
    return redacted;
}

const parseEndpointConfig = (ep) => {
    if (typeof ep.config === 'string') {
        try { ep.config = JSON.parse(ep.config); } catch {}
    }
    ep.config = redactConfig(ep.config);
    return ep;
};

// -- GET /api/v2/endpoints — list endpoints for current user
app.get('/api/v2/endpoints', apiReadLimiter, v2Auth, (req, res) => {
    const user = req.v2Auth?.user;
    if (!user) return res.status(400).json({ error: 'Could not determine user' });
    const endpoints = itemsDb.getEndpoints(user).map(parseEndpointConfig);
    res.json({ endpoints });
});

// -- POST /api/v2/endpoints — create a new endpoint
app.post('/api/v2/endpoints', apiWriteLimiter, v2Auth, (req, res) => {
    const { name, type, config, is_default } = req.body;
    const user = req.v2Auth?.user;
    if (!user) return res.status(400).json({ error: 'Could not determine user' });
    if (!name || !name.trim()) return res.status(400).json({ error: 'Missing endpoint name' });
    if (!type) return res.status(400).json({ error: 'Missing endpoint type' });

    const validTypes = ['github-issue', 'lark', 'telegram', 'webhook', 'slack', 'email'];
    if (!validTypes.includes(type)) {
        return res.status(400).json({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` });
    }

    // Validate required config fields by type
    const cfg = typeof config === 'string' ? JSON.parse(config) : (config || {});
    switch (type) {
        case 'github-issue':
            if (!cfg.repo) return res.status(400).json({ error: 'GitHub endpoint requires "repo" in config' });
            break;
        case 'webhook':
            if (!cfg.url) return res.status(400).json({ error: 'Webhook endpoint requires "url" in config' });
            break;
        case 'lark':
            if (!cfg.webhook_url) return res.status(400).json({ error: 'Lark endpoint requires "webhook_url" in config' });
            break;
        case 'telegram':
            if (!cfg.chat_id) return res.status(400).json({ error: 'Telegram endpoint requires "chat_id" in config' });
            break;
        case 'slack':
            if (!cfg.webhook_url) return res.status(400).json({ error: 'Slack endpoint requires "webhook_url" in config' });
            break;
        case 'email':
            if (!cfg.api_key) return res.status(400).json({ error: 'Email endpoint requires "api_key" in config' });
            if (!cfg.from) return res.status(400).json({ error: 'Email endpoint requires "from" in config' });
            // Normalize to to array
            if (cfg.to && !Array.isArray(cfg.to)) cfg.to = [cfg.to];
            if (!cfg.to || cfg.to.length === 0) return res.status(400).json({ error: 'Email endpoint requires "to" in config' });
            break;
    }

    const endpoint = itemsDb.createEndpoint({
        user_name: user, name: name.trim(), type, config: cfg, is_default: is_default ? 1 : 0,
    });

    res.json({ success: true, endpoint: parseEndpointConfig(endpoint) });
});

// -- GET /api/v2/endpoints/:id — get a single endpoint
app.get('/api/v2/endpoints/:id', apiReadLimiter, v2Auth, (req, res) => {
    const endpoint = itemsDb.getEndpoint(req.params.id);
    if (!endpoint) return res.status(404).json({ error: 'Endpoint not found' });
    // Ensure user owns this endpoint
    if (endpoint.user_name !== req.v2Auth?.user) {
        return res.status(403).json({ error: 'Not authorized to access this endpoint' });
    }
    res.json({ endpoint: parseEndpointConfig(endpoint) });
});

// -- PUT /api/v2/endpoints/:id — update an endpoint
app.put('/api/v2/endpoints/:id', apiWriteLimiter, v2Auth, (req, res) => {
    const existing = itemsDb.getEndpoint(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Endpoint not found' });
    if (existing.user_name !== req.v2Auth?.user) {
        return res.status(403).json({ error: 'Not authorized to modify this endpoint' });
    }

    const { name, type, config } = req.body;

    // Validate type if provided
    if (type) {
        const validTypes = ['github-issue', 'lark', 'telegram', 'webhook', 'slack', 'email'];
        if (!validTypes.includes(type)) {
            return res.status(400).json({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` });
        }
    }

    // Validate required config fields for the resolved type
    const resolvedType = type || existing.type;
    const cfg = config ? (typeof config === 'string' ? JSON.parse(config) : config) : null;
    if (cfg) {
        switch (resolvedType) {
            case 'github-issue':
                if (!cfg.repo) return res.status(400).json({ error: 'GitHub endpoint requires "repo" in config' });
                break;
            case 'webhook':
                if (!cfg.url) return res.status(400).json({ error: 'Webhook endpoint requires "url" in config' });
                break;
            case 'lark':
                if (!cfg.webhook_url) return res.status(400).json({ error: 'Lark endpoint requires "webhook_url" in config' });
                break;
            case 'telegram':
                if (!cfg.chat_id) return res.status(400).json({ error: 'Telegram endpoint requires "chat_id" in config' });
                break;
            case 'slack':
                if (!cfg.webhook_url) return res.status(400).json({ error: 'Slack endpoint requires "webhook_url" in config' });
                break;
            case 'email':
                if (!cfg.api_key) return res.status(400).json({ error: 'Email endpoint requires "api_key" in config' });
                if (!cfg.from) return res.status(400).json({ error: 'Email endpoint requires "from" in config' });
                if (cfg.to && !Array.isArray(cfg.to)) cfg.to = [cfg.to];
                if (!cfg.to || cfg.to.length === 0) return res.status(400).json({ error: 'Email endpoint requires "to" in config' });
                break;
        }
    }

    const updated = itemsDb.updateEndpoint(req.params.id, { name, type, config: cfg });
    if (!updated) return res.status(404).json({ error: 'Endpoint not found' });
    res.json({ success: true, endpoint: parseEndpointConfig(updated) });
});

// -- DELETE /api/v2/endpoints/:id — delete an endpoint
app.delete('/api/v2/endpoints/:id', apiWriteLimiter, v2Auth, (req, res) => {
    const existing = itemsDb.getEndpoint(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Endpoint not found' });
    if (existing.user_name !== req.v2Auth?.user) {
        return res.status(403).json({ error: 'Not authorized to delete this endpoint' });
    }
    const result = itemsDb.deleteEndpoint(req.params.id);
    if (!result.success) return res.status(404).json({ error: 'Endpoint not found' });
    res.json({ success: true });
});

// -- POST /api/v2/endpoints/:id/default — set an endpoint as default
app.post('/api/v2/endpoints/:id/default', apiWriteLimiter, v2Auth, (req, res) => {
    const existing = itemsDb.getEndpoint(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Endpoint not found' });
    if (existing.user_name !== req.v2Auth?.user) {
        return res.status(403).json({ error: 'Not authorized to modify this endpoint' });
    }
    const updated = itemsDb.setEndpointDefault(req.params.id);
    if (!updated) return res.status(404).json({ error: 'Endpoint not found' });
    res.json({ success: true, endpoint: parseEndpointConfig(updated) });
});

// ================================================================= Apps API
//
// CRUD for user apps + AppKey management. JWT-only auth.
// =================================================================

// JWT-only middleware — apps require a logged-in user, not API keys
function jwtAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'JWT authentication required' });
    }
    const token = authHeader.slice(7);
    if (token.startsWith('cmk_')) {
        return res.status(401).json({ error: 'JWT authentication required (API keys not accepted for app management)' });
    }
    if (!verifyJwt) {
        return res.status(503).json({ error: 'JWT authentication not configured' });
    }
    const payload = verifyJwt(token);
    if (!payload) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
    req.jwtUser = { userId: payload.userId, email: payload.email, role: payload.role };
    next();
}

// -- POST /api/v2/apps — create a new app (auto-generates AppKey)
app.post('/api/v2/apps', apiWriteLimiter, jwtAuth, (req, res) => {
    const { name, description } = req.body;
    if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Missing app name' });
    }

    const result = itemsDb.createApp({
        user_id: req.jwtUser.userId,
        name: name.trim(),
        description: description || null,
    });

    res.json({ success: true, app: result });
});

// -- GET /api/v2/apps — list my apps
app.get('/api/v2/apps', apiReadLimiter, jwtAuth, (req, res) => {
    const apps = itemsDb.getAppsByUser(req.jwtUser.userId);
    res.json({ apps });
});

// -- GET /api/v2/apps/:id — get app details + keys
app.get('/api/v2/apps/:id', apiReadLimiter, jwtAuth, (req, res) => {
    const theApp = itemsDb.getApp(req.params.id);
    if (!theApp) return res.status(404).json({ error: 'App not found' });
    if (theApp.user_id !== req.jwtUser.userId) {
        return res.status(403).json({ error: 'Not authorized to access this app' });
    }
    const keys = itemsDb.getAppKeys(theApp.id).map(k => ({
        id: k.id, key: k.key, name: k.name,
        created_at: k.created_at, last_used: k.last_used, revoked: !!k.revoked,
    }));
    res.json({ app: theApp, keys });
});

// -- PUT /api/v2/apps/:id — update app name/description
app.put('/api/v2/apps/:id', apiWriteLimiter, jwtAuth, (req, res) => {
    const existing = itemsDb.getApp(req.params.id);
    if (!existing) return res.status(404).json({ error: 'App not found' });
    if (existing.user_id !== req.jwtUser.userId) {
        return res.status(403).json({ error: 'Not authorized to modify this app' });
    }
    const { name, description } = req.body;
    if (name !== undefined && !name.trim()) {
        return res.status(400).json({ error: 'App name cannot be empty' });
    }
    const updated = itemsDb.updateApp(req.params.id, {
        name: name ? name.trim() : undefined,
        description,
    });
    res.json({ success: true, app: updated });
});

// -- DELETE /api/v2/apps/:id — delete app + revoke keys
app.delete('/api/v2/apps/:id', apiWriteLimiter, jwtAuth, (req, res) => {
    const existing = itemsDb.getApp(req.params.id);
    if (!existing) return res.status(404).json({ error: 'App not found' });
    if (existing.user_id !== req.jwtUser.userId) {
        return res.status(403).json({ error: 'Not authorized to delete this app' });
    }
    const result = itemsDb.deleteApp(req.params.id);
    if (!result.success) return res.status(404).json({ error: 'App not found' });
    res.json({ success: true });
});

// -- POST /api/v2/apps/:id/rotate-key — rotate AppKey
app.post('/api/v2/apps/:id/rotate-key', apiWriteLimiter, jwtAuth, (req, res) => {
    const existing = itemsDb.getApp(req.params.id);
    if (!existing) return res.status(404).json({ error: 'App not found' });
    if (existing.user_id !== req.jwtUser.userId) {
        return res.status(403).json({ error: 'Not authorized to rotate keys for this app' });
    }
    const newKey = itemsDb.rotateAppKey(req.params.id, req.jwtUser.userId);
    res.json({ success: true, key: newKey.key, key_id: newKey.id });
});

// ================================================================= Orgs API
//
// Organization CRUD + member management + RBAC. JWT-only auth.
// =================================================================

// RBAC role hierarchy: owner > admin > member
const ROLE_LEVEL = { owner: 3, admin: 2, member: 1 };

/**
 * Middleware factory: require the caller to hold at least `minRole` in the org.
 * Extracts org_id from req.params.id. Attaches req.orgRole on success.
 */
function requireOrgRole(minRole) {
    return (req, res, next) => {
        const orgId = req.params.id;
        const role = itemsDb.getOrgMemberRole(orgId, req.jwtUser.userId);
        if (!role) {
            return res.status(403).json({ error: 'Not a member of this organization' });
        }
        if ((ROLE_LEVEL[role] || 0) < (ROLE_LEVEL[minRole] || 0)) {
            return res.status(403).json({ error: `Requires ${minRole} role or higher` });
        }
        req.orgRole = role;
        next();
    };
}

// Validate slug: lowercase alphanumeric + hyphens, 2-64 chars, no leading/trailing hyphen
function isValidSlug(slug) {
    return /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(slug) || /^[a-z0-9]{1,2}$/.test(slug);
}

// -- POST /api/v2/orgs — create organization
app.post('/api/v2/orgs', apiWriteLimiter, jwtAuth, (req, res) => {
    const { name, slug, description } = req.body;
    if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Missing organization name' });
    }
    if (!slug || !slug.trim()) {
        return res.status(400).json({ error: 'Missing organization slug' });
    }
    const cleanSlug = slug.trim().toLowerCase();
    if (!isValidSlug(cleanSlug)) {
        return res.status(400).json({ error: 'Invalid slug: use lowercase letters, numbers, and hyphens (2-64 chars)' });
    }
    // Check slug uniqueness
    if (itemsDb.getOrgBySlug(cleanSlug)) {
        return res.status(409).json({ error: 'Slug already taken' });
    }
    const org = itemsDb.createOrg({
        name: name.trim(),
        slug: cleanSlug,
        description: description || null,
        created_by: req.jwtUser.userId,
    });
    res.json({ success: true, org });
});

// -- GET /api/v2/orgs — list user's organizations
app.get('/api/v2/orgs', apiReadLimiter, jwtAuth, (req, res) => {
    const orgs = itemsDb.getOrgsByUser(req.jwtUser.userId);
    res.json({ orgs });
});

// -- GET /api/v2/orgs/:id — get org details (member only)
app.get('/api/v2/orgs/:id', apiReadLimiter, jwtAuth, requireOrgRole('member'), (req, res) => {
    const org = itemsDb.getOrg(req.params.id);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    res.json({ org, role: req.orgRole });
});

// -- PUT /api/v2/orgs/:id — update org (admin/owner only)
app.put('/api/v2/orgs/:id', apiWriteLimiter, jwtAuth, requireOrgRole('admin'), (req, res) => {
    const { name, slug, description } = req.body;
    if (name !== undefined && !name.trim()) {
        return res.status(400).json({ error: 'Organization name cannot be empty' });
    }
    if (slug !== undefined) {
        const cleanSlug = slug.trim().toLowerCase();
        if (!isValidSlug(cleanSlug)) {
            return res.status(400).json({ error: 'Invalid slug' });
        }
        const existing = itemsDb.getOrgBySlug(cleanSlug);
        if (existing && existing.id !== req.params.id) {
            return res.status(409).json({ error: 'Slug already taken' });
        }
    }
    const updated = itemsDb.updateOrg(req.params.id, {
        name: name ? name.trim() : undefined,
        slug: slug ? slug.trim().toLowerCase() : undefined,
        description,
    });
    if (!updated) return res.status(404).json({ error: 'Organization not found' });
    res.json({ success: true, org: updated });
});

// -- DELETE /api/v2/orgs/:id — delete org (owner only)
app.delete('/api/v2/orgs/:id', apiWriteLimiter, jwtAuth, requireOrgRole('owner'), (req, res) => {
    const result = itemsDb.deleteOrg(req.params.id);
    if (!result.success) return res.status(404).json({ error: 'Organization not found' });
    res.json({ success: true });
});

// -- GET /api/v2/orgs/:id/members — list members (member only)
app.get('/api/v2/orgs/:id/members', apiReadLimiter, jwtAuth, requireOrgRole('member'), (req, res) => {
    const members = itemsDb.getOrgMembers(req.params.id);
    res.json({ members });
});

// -- POST /api/v2/orgs/:id/members — add member (admin/owner only)
app.post('/api/v2/orgs/:id/members', apiWriteLimiter, jwtAuth, requireOrgRole('admin'), (req, res) => {
    const { user_id, role } = req.body;
    if (!user_id) {
        return res.status(400).json({ error: 'Missing user_id' });
    }
    const validRoles = ['member', 'admin'];
    const memberRole = role || 'member';
    if (!validRoles.includes(memberRole)) {
        return res.status(400).json({ error: 'Invalid role. Use member or admin' });
    }
    // Cannot add owner role via this endpoint
    if (role === 'owner') {
        return res.status(400).json({ error: 'Cannot assign owner role via member invitation' });
    }
    // Check if user exists
    const user = itemsDb.getUserById(user_id);
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }
    // Check if already a member
    const existingRole = itemsDb.getOrgMemberRole(req.params.id, user_id);
    if (existingRole) {
        return res.status(409).json({ error: 'User is already a member of this organization' });
    }
    const member = itemsDb.addOrgMember(req.params.id, user_id, memberRole, req.jwtUser.userId);
    res.json({ success: true, member });
});

// -- PUT /api/v2/orgs/:id/members/:userId — update member role (owner only)
app.put('/api/v2/orgs/:id/members/:userId', apiWriteLimiter, jwtAuth, requireOrgRole('owner'), (req, res) => {
    const { role } = req.body;
    if (!role) {
        return res.status(400).json({ error: 'Missing role' });
    }
    const validRoles = ['member', 'admin', 'owner'];
    if (!validRoles.includes(role)) {
        return res.status(400).json({ error: 'Invalid role' });
    }
    // Check target is a member
    const currentRole = itemsDb.getOrgMemberRole(req.params.id, req.params.userId);
    if (!currentRole) {
        return res.status(404).json({ error: 'User is not a member of this organization' });
    }
    // Cannot change own role
    if (req.params.userId === req.jwtUser.userId) {
        return res.status(400).json({ error: 'Cannot change your own role' });
    }
    const result = itemsDb.updateOrgMemberRole(req.params.id, req.params.userId, role);
    if (!result.success) return res.status(404).json({ error: 'Member not found' });
    res.json({ success: true });
});

// -- DELETE /api/v2/orgs/:id/members/:userId — remove member (admin/owner, or self-leave)
app.delete('/api/v2/orgs/:id/members/:userId', apiWriteLimiter, jwtAuth, (req, res) => {
    const callerRole = itemsDb.getOrgMemberRole(req.params.id, req.jwtUser.userId);
    if (!callerRole) {
        return res.status(403).json({ error: 'Not a member of this organization' });
    }

    const isSelf = req.params.userId === req.jwtUser.userId;
    const targetRole = itemsDb.getOrgMemberRole(req.params.id, req.params.userId);
    if (!targetRole) {
        return res.status(404).json({ error: 'User is not a member of this organization' });
    }

    if (isSelf) {
        // Self-leave: owners cannot leave (must transfer ownership first)
        if (callerRole === 'owner') {
            return res.status(400).json({ error: 'Owner cannot leave. Transfer ownership first.' });
        }
    } else {
        // Removing another member: need admin+ role and cannot remove someone with higher/equal role
        if ((ROLE_LEVEL[callerRole] || 0) < ROLE_LEVEL['admin']) {
            return res.status(403).json({ error: 'Requires admin role or higher' });
        }
        if ((ROLE_LEVEL[targetRole] || 0) >= (ROLE_LEVEL[callerRole] || 0)) {
            return res.status(403).json({ error: 'Cannot remove a member with equal or higher role' });
        }
    }

    const result = itemsDb.removeOrgMember(req.params.id, req.params.userId);
    if (!result.success) return res.status(404).json({ error: 'Member not found' });
    res.json({ success: true });
});

// ================================================================= Dashboard
//
// Serve the endpoint management dashboard as a standalone HTML page.
// =================================================================

app.get('/dashboard/endpoints', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard', 'endpoints.html'));
});

// ----------------------------------------------------------------- queue

// Get the consumer queue — open + in-progress items sorted by priority
app.get('/queue', v2Auth, (req, res) => {
    const items = itemsDb.getQueue();
    res.json({ items });
});

// ----------------------------------------------------------------- stats

app.get('/stats', v2Auth, (req, res) => {
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
        version: pkg.version,
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
    console.log(`    auth      : JWT + API key (invite codes deprecated)`);
    console.log(`    api v2    : /api/v2/*`);

    // Start dispatch retry worker (every 30s, exponential backoff per entry)
    let retryBusy = false;
    setInterval(() => {
        if (retryBusy) return;
        retryBusy = true;
        registry.retryFailed().then(n => {
            if (n > 0) console.log(`[dispatch] Retried ${n} failed dispatch(es)`);
        }).catch(err => {
            console.error('[dispatch] Retry worker error:', err.message);
        }).finally(() => { retryBusy = false; });
    }, 30000);
});
