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

// #36: Load .env file if present (zero-dependency alternative to dotenv)
const _fs = require('fs');
const _path = require('path');
const _envPath = _path.resolve(__dirname, '..', '.env');
try {
    const _envContent = _fs.readFileSync(_envPath, 'utf8');
    for (const line of _envContent.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!(key in process.env)) {
            process.env[key] = val;
        }
    }
} catch { /* .env file is optional */ }

const pkg = require('../package.json');

const express = require('express');
const fs = _fs;
const path = _path;
const http = require('http');
const https = require('https');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { execFileSync } = require('child_process');

function readGitValue(args) {
    try {
        return execFileSync('git', args, {
            cwd: path.join(__dirname, '..'),
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        return '';
    }
}

const BUILD_META = {
    commit: readGitValue(['rev-parse', '--short=8', 'HEAD']),
    buildTime: readGitValue(['show', '-s', '--format=%cI', 'HEAD']),
};

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
const PUBLIC_URL = (process.env.CLAWMARK_PUBLIC_URL || config.publicUrl || '').replace(/\/+$/, '');

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

// ---------------------------------------------------------------- credential encryption
const credCrypto = require('./crypto');

// #36: Deprecation helper — warn when secrets are loaded from config.json instead of env vars
function resolveSecret(envVar, configPath, label) {
    const envVal = process.env[envVar];
    if (envVal) return envVal;
    const cfgVal = configPath();
    if (cfgVal) {
        console.warn(`[DEPRECATION] ${label} loaded from config.json. Move to env var ${envVar} instead.`);
        return cfgVal;
    }
    return null;
}

const ENCRYPTION_KEY = resolveSecret(
    'CLAWMARK_ENCRYPTION_KEY',
    () => config.auth && config.auth.encryptionKey,
    'Encryption key',
);
credCrypto.init(ENCRYPTION_KEY);

const { initDb } = require('./db');
const itemsDb = initDb(DATA_DIR);

// Startup check: encryption key is mandatory
if (!credCrypto.isEnabled()) {
    console.error('[FATAL] CLAWMARK_ENCRYPTION_KEY is not set. Credentials must be encrypted at rest.');
    console.error('Generate one with: openssl rand -hex 32');
    console.error('Set env var CLAWMARK_ENCRYPTION_KEY (config.json fallback is deprecated).');
    process.exit(1);
}

// ------------------------------------------------------------------ auth module
const { initAuth } = require('./auth');
const JWT_SECRET = resolveSecret(
    'CLAWMARK_JWT_SECRET',
    () => config.auth && config.auth.jwtSecret,
    'JWT secret',
);

if (!JWT_SECRET && process.env.NODE_ENV === 'production') {
    console.error('[FATAL] CLAWMARK_JWT_SECRET is not set. Refusing to start in production without a JWT secret.');
    console.error('Set env var CLAWMARK_JWT_SECRET (config.json fallback is deprecated).');
    process.exit(1);
}
if (!JWT_SECRET) {
    console.warn('[SECURITY WARNING] JWT_SECRET not configured — authentication is effectively disabled. Do NOT run this in production.');
}

const GOOGLE_CLIENT_ID = resolveSecret(
    'CLAWMARK_GOOGLE_CLIENT_ID',
    () => config.auth && config.auth.googleClientId,
    'Google Client ID',
);
const GOOGLE_CLIENT_SECRET = resolveSecret(
    'CLAWMARK_GOOGLE_CLIENT_SECRET',
    () => config.auth && config.auth.googleClientSecret,
    'Google Client Secret',
);

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
const { autoSeverity } = require('./severity');
const { hashKey, generateAgentKey, createAgentAuth } = require('./agent-auth');
const { initActionWs } = require('./ws-actions');
const { initCdpWs } = require('./ws-cdp');
const { correlate } = require('./agent/session-analyzer');
const { generateReport } = require('./agent/reproduction-generator');
const { initPerceptionWs } = require('./ws-perception');
const { dispatchPerceptionWebhooks, retryFailedDeliveries } = require('./webhook-dispatcher');
const { resolveDeclaration } = require('./target-declaration');
const { recommendRoute, classifyAnnotation, VALID_CLASSIFICATIONS, generateTags, clusterAnnotations, analyzeScreenshot } = require('./ai');
const { createBindingRouter } = require('./binding');

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
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Agent-Key');
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
    max: parseInt(process.env.CLAWMARK_WRITE_RATE_LIMIT_MAX || '30', 10),
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

const agentRegisterLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Agent registration rate limit exceeded' },
});

const guestFeedbackLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Feedback rate limit exceeded, try again later' },
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
    : null;

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
            // Separate recent targets (#48) from regular selections
            const recentSelections = payload._selected_targets.filter(s => s.method === 'recent_target');
            const regularSelections = payload._selected_targets.filter(s => s.method !== 'recent_target');

            if (regularSelections.length > 0) {
                const selected = new Set(regularSelections.map(s =>
                    `${s.target_type}:${s.method}`
                ));
                filteredTargets = targets.filter(t => selected.has(`${t.target_type}:${t.method}`));
                // Fall back to all targets if filter results in empty (safety net)
                if (filteredTargets.length === 0) filteredTargets = targets;
            }

            // Append recent targets as additional dispatch destinations (#48)
            for (const rt of recentSelections) {
                if (rt.target_type && rt.target_config) {
                    const config = typeof rt.target_config === 'string' ? JSON.parse(rt.target_config) : rt.target_config;
                    filteredTargets.push({
                        target_type: rt.target_type,
                        target_config: config,
                        matched_rule: rt.auth_id ? { auth_id: rt.auth_id } : null,
                        method: 'recent_target',
                    });
                }
            }

            delete payload._selected_targets;
        }

        // Filter out no_target entries — nothing to dispatch
        filteredTargets = filteredTargets.filter(t => t.target_type && t.target_config);

        if (filteredTargets.length === 0) {
            console.log(`[routing] ${event}: no targets resolved — skipping dispatch`);
            return [{ target_type: null, status: 'skipped', method: 'no_target' }];
        }

        // Inject auth credentials from user_auths into targets that reference an auth_id.
        // Use spread to create a new object — the original target_config must stay clean
        // because dispatchToTargets serializes it into dispatch_log.
        // #264: Skip targets whose auth_id is missing instead of dispatching with incomplete config.
        const authValidTargets = [];
        for (const t of filteredTargets) {
            if (t.matched_rule && t.matched_rule.auth_id) {
                let auth;
                try { auth = itemsDb.getUserAuth(t.matched_rule.auth_id); } catch (err) {
                    console.error(`[routing] DB error fetching auth ${t.matched_rule.auth_id}: ${err.message}`);
                    continue;
                }
                if (auth) {
                    let creds;
                    try { creds = typeof auth.credentials === 'string' ? JSON.parse(auth.credentials) : auth.credentials; } catch { creds = {}; }
                    t.target_config = { ...t.target_config, ...creds };
                    authValidTargets.push(t);
                } else {
                    console.warn(`[routing] Skipping target: auth ${t.matched_rule.auth_id} referenced by rule ${t.matched_rule.id} not found`);
                }
            } else {
                authValidTargets.push(t);
            }
        }
        if (filteredTargets.length > authValidTargets.length) {
            console.warn(`[routing] ${filteredTargets.length - authValidTargets.length} of ${filteredTargets.length} targets dropped due to missing auth`);
        }
        filteredTargets = authValidTargets;

        // Inject ClawMark server URL for adapters that need to resolve relative image paths (#45)
        if (PUBLIC_URL) {
            for (const t of filteredTargets) {
                if (!t.target_config.server_url) {
                    t.target_config = { ...t.target_config, server_url: PUBLIC_URL };
                }
            }
        }

        console.log(`[routing] ${event}: ${filteredTargets.length} target(s) — ${filteredTargets.map(t => `${t.method}→${t.target_type}`).join(', ')}`);

        // Store routing decision on the item for debugging/auditing
        payload._routing = filteredTargets.map(t => ({ method: t.method, target_type: t.target_type, repo: t.target_config.repo }));

        // Attach recent perception context log to dispatch context (#723)
        let perceptionLog = [];
        try {
            const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
            perceptionLog = itemsDb.getPerceptionEvents({
                app_id: payload.app_id,
                url: payload.source_url || undefined,
                since: fiveMinAgo,
                limit: 20,
            });
        } catch (err) {
            console.error(`[dispatch] Failed to fetch perception context:`, err.message);
        }

        // Multi-target dispatch with tracking — await results (#200)
        try {
            const results = await registry.dispatchToTargets(event, payload, filteredTargets, { perceptionLog });
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
    const url = signImageUrl(req.file.filename);
    res.json({ success: true, url });
});

// Serve uploaded images with signed URL verification (#113)
const crypto = require('crypto');
const IMAGE_SIGN_KEY = ENCRYPTION_KEY || JWT_SECRET || 'clawmark-dev-image-key';
const IMAGE_URL_TTL = 24 * 60 * 60; // 24 hours in seconds

function signImageUrl(filename) {
    const expires = Math.floor(Date.now() / 1000) + IMAGE_URL_TTL;
    const sig = crypto.createHmac('sha256', IMAGE_SIGN_KEY)
        .update(`${filename}:${expires}`)
        .digest('hex')
        .slice(0, 16);
    return `/images/${filename}?e=${expires}&s=${sig}`;
}

app.use('/images', (req, res, next) => {
    const filename = req.path.replace(/^\//, '');
    const { e: expires, s: sig } = req.query;

    // If no signature params, fall back to full v2Auth validation
    if (!expires || !sig) {
        return v2Auth(req, res, next);
    }

    // Verify signature and expiry
    const now = Math.floor(Date.now() / 1000);
    if (Number(expires) < now) {
        return res.status(403).json({ error: 'Image URL has expired.' });
    }

    const expected = crypto.createHmac('sha256', IMAGE_SIGN_KEY)
        .update(`${filename}:${expires}`)
        .digest('hex')
        .slice(0, 16);
    // Timing-safe comparison to prevent timing attacks
    const sigBuf = Buffer.from(sig, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
        return res.status(403).json({ error: 'Invalid image signature.' });
    }

    next();
}, express.static(UPLOAD_DIR));

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

// -- Agent key auth middleware (#68)
const agentAuth = createAgentAuth(itemsDb);

// Combined middleware: accept either v2Auth (JWT/API key) or agent key
function v2AuthOrAgent(req, res, next) {
    if (req.headers['x-agent-key']) {
        return agentAuth(req, res, () => {
            // Map agent to v2Auth-compatible shape so perception handlers work
            req.v2Auth = { app_id: req.agent.app_id, user_name: `agent:${req.agent.id}`, agent: req.agent };
            next();
        });
    }
    v2Auth(req, res, next);
}

// -- Binding routes (#106 Agent Binding)
const bindingRouter = createBindingRouter({
    db: itemsDb,
    jwtSecret: JWT_SECRET,
    v2Auth,
    v2AuthOrAgent,
    apiReadLimiter,
    apiWriteLimiter,
    agentRegisterLimiter,
    getPerceptionWs: () => app.locals.perceptionWs,
});
app.use('/api/v2/bindings', bindingRouter);

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

// -- GET /api/v2/instances — list browser instances (#120)
app.get('/api/v2/instances', apiReadLimiter, v2Auth, (req, res) => {
    if (!req.v2Auth?.userId) return res.status(401).json({ error: 'JWT auth required' });
    const appId = req.v2Auth.app_id;
    if (!appId) return res.json({ instances: [] });

    // Get connected instances from WS runtime state
    const actionWs = app.locals.actionWs;
    const connected = actionWs ? actionWs.getInstanceList(appId) : [];

    // Get saved labels from DB
    const labels = itemsDb.getInstanceLabelsByApp(appId);
    const labelMap = new Map(labels.map(l => [l.instance_id, l]));

    // Merge: connected instances + any labeled instances that are offline
    const seenIds = new Set();
    const instances = [];

    for (const inst of connected) {
        seenIds.add(inst.instance_id);
        const labelRow = labelMap.get(inst.instance_id);
        instances.push({
            instance_id: inst.instance_id,
            label: labelRow?.label || '',
            connected: true,
            last_activity: inst.last_activity,
        });
    }

    // Include offline instances that have labels (user named them before)
    for (const labelRow of labels) {
        if (!seenIds.has(labelRow.instance_id)) {
            instances.push({
                instance_id: labelRow.instance_id,
                label: labelRow.label,
                connected: false,
                last_activity: null,
            });
        }
    }

    res.json({ instances });
});

// -- PUT /api/v2/instances/:id — update instance label (#120)
app.put('/api/v2/instances/:id', apiWriteLimiter, v2Auth, (req, res) => {
    if (!req.v2Auth?.userId) return res.status(401).json({ error: 'JWT auth required' });
    const appId = req.v2Auth.app_id;
    if (!appId) return res.status(400).json({ error: 'Could not resolve app' });

    const instanceId = req.params.id;
    const { label } = req.body;
    if (typeof label !== 'string') return res.status(400).json({ error: 'label must be a string' });
    if (label.length > 64) return res.status(400).json({ error: 'label must be 64 chars or fewer' });

    const result = itemsDb.setInstanceLabel(instanceId, appId, label.trim());
    res.json(result);
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

// -- POST /api/v2/items/batch-file — batch file items as GitLab issues (#44)
app.post('/api/v2/items/batch-file', apiWriteLimiter, v2Auth, async (req, res) => {
    const { item_ids, target } = req.body;

    if (!Array.isArray(item_ids) || item_ids.length === 0) {
        return res.status(400).json({ error: 'item_ids must be a non-empty array' });
    }
    if (item_ids.length > 50) {
        return res.status(400).json({ error: 'Maximum 50 items per batch' });
    }
    if (!target || !target.adapter || !target.project_id) {
        return res.status(400).json({ error: 'target must include adapter and project_id' });
    }

    const resolvedAppId = req.v2Auth?.app_id;
    if (!resolvedAppId) {
        return res.status(400).json({ error: 'Could not resolve app_id' });
    }

    // Resolve auth credentials if auth_id is provided
    let targetConfig = { ...target };
    if (target.auth_id) {
        const auth = itemsDb.getUserAuth(target.auth_id);
        if (!auth) {
            return res.status(400).json({ error: `Auth credential ${target.auth_id} not found` });
        }
        let creds;
        try { creds = typeof auth.credentials === 'string' ? JSON.parse(auth.credentials) : auth.credentials; } catch { creds = {}; }
        targetConfig = { ...targetConfig, ...creds };
    }

    const results = [];
    for (const itemId of item_ids) {
        const item = itemsDb.getItem(itemId);
        if (!item) {
            results.push({ item_id: itemId, status: 'error', error: 'Item not found' });
            continue;
        }
        if (item.app_id !== resolvedAppId) {
            results.push({ item_id: itemId, status: 'error', error: 'Access denied' });
            continue;
        }

        // Auto-severity labeling
        const { severity } = autoSeverity(item);
        const severityLabels = target.auto_severity !== false
            ? [severity]
            : [];

        // Build adapter config with severity labels
        const adapterConfig = {
            ...targetConfig,
            labels: [...(targetConfig.labels || ['clawmark']), ...severityLabels],
        };

        try {
            const adapterResult = await registry.dispatchToTarget(
                'item.created', item, target.adapter, adapterConfig, {}
            );
            results.push({
                item_id: itemId,
                status: 'filed',
                severity,
                url: adapterResult?.url || null,
                issue_iid: adapterResult?.issue_iid || null,
            });
        } catch (err) {
            results.push({
                item_id: itemId,
                status: 'error',
                severity,
                error: err.message,
            });
        }
    }

    const filed = results.filter(r => r.status === 'filed').length;
    const failed = results.filter(r => r.status === 'error').length;

    res.json({
        success: failed === 0,
        summary: { total: item_ids.length, filed, failed },
        results,
    });
});

// -- GET /api/v2/items/:id/severity — preview auto-severity for an item (#44)
app.get('/api/v2/items/:id/severity', apiReadLimiter, v2Auth, (req, res) => {
    const item = itemsDb.getItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (req.v2Auth?.app_id && item.app_id !== req.v2Auth.app_id) {
        return res.status(403).json({ error: 'Access denied' });
    }
    res.json(autoSeverity(item));
});

// -- POST /api/v2/items/preview-issues — preview draft issues before filing (#44)
app.post('/api/v2/items/preview-issues', apiReadLimiter, v2Auth, (req, res) => {
    const { item_ids } = req.body;
    if (!Array.isArray(item_ids) || item_ids.length === 0) {
        return res.status(400).json({ error: 'item_ids must be a non-empty array' });
    }

    const resolvedAppId = req.v2Auth?.app_id;
    if (!resolvedAppId) {
        return res.status(400).json({ error: 'Could not resolve app_id' });
    }

    const drafts = [];
    for (const itemId of item_ids) {
        const item = itemsDb.getItem(itemId);
        if (!item || item.app_id !== resolvedAppId) continue;

        const { severity, label: severityLabel } = autoSeverity(item);
        const tags = typeof item.tags === 'string' ? JSON.parse(item.tags || '[]') : (item.tags || []);
        const screenshots = typeof item.screenshots === 'string' ? JSON.parse(item.screenshots || '[]') : (item.screenshots || []);

        drafts.push({
            item_id: item.id,
            title: item.title || item.quote?.slice(0, 80) || 'Untitled',
            classification: item.classification || 'general',
            severity,
            severity_label: severityLabel,
            source_url: item.source_url,
            source_title: item.source_title,
            quote: item.quote,
            tags,
            screenshots,
            created_at: item.created_at,
            has_dispatches: (itemsDb.getDispatchLog(item.id) || []).length > 0,
        });
    }

    res.json({ drafts });
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
app.get('/api/v2/adapters', apiReadLimiter, v2Auth, (req, res) => {
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

    // #264: Validate auth_id references — filter out targets whose auth credentials are missing
    const totalBeforeFilter = targets.length;
    const validatedTargets = targets.filter(t => {
        if (t.matched_rule && t.matched_rule.auth_id) {
            try {
                const auth = itemsDb.getUserAuth(t.matched_rule.auth_id);
                if (!auth) {
                    console.warn(`[routing/resolve] Dropping target: auth ${t.matched_rule.auth_id} from rule ${t.matched_rule.id} not found`);
                    return false;
                }
            } catch (err) {
                console.error(`[routing/resolve] DB error checking auth ${t.matched_rule.auth_id}: ${err.message}`);
                return false;
            }
        }
        return true;
    });
    const droppedCount = totalBeforeFilter - validatedTargets.length;
    if (droppedCount > 0) {
        console.warn(`[routing/resolve] ${droppedCount} of ${totalBeforeFilter} targets dropped due to missing auth`);
    }

    // Include recent targets for recommendation (#48)
    const appId = req.v2Auth?.app_id;
    let recentTargets = [];
    if (user && appId) {
        try {
            recentTargets = itemsDb.getRecentTargets(user, appId, 5)
                .filter(r => {
                    // #264: Skip recent targets with missing auth
                    if (r.auth_id) {
                        try { if (!itemsDb.getUserAuth(r.auth_id)) return false; }
                        catch { return false; }
                    }
                    return true;
                })
                .map(r => {
                    let config;
                    try { config = JSON.parse(r.target_config); } catch { config = {}; }
                    return {
                        target_type: r.target_type,
                        target_config: redactConfig(config),
                        auth_id: r.auth_id,
                        last_used: r.last_used,
                        use_count: r.use_count,
                    };
                });
        } catch { /* non-critical */ }
    }

    res.json({
        targets: validatedTargets.filter(t => t.target_type && t.target_config).map(t => ({
            target_type: t.target_type,
            target_config: redactConfig(
                typeof t.target_config === 'string' ? JSON.parse(t.target_config) : t.target_config
            ),
            method: t.method,
            matched_rule: t.matched_rule ? { id: t.matched_rule.id, pattern: t.matched_rule.pattern, auth_id: t.matched_rule.auth_id || null } : null,
        })),
        recent_targets: recentTargets,
        // Legacy single-target fields for backward compatibility (e.g., checkTargetInjection)
        target_type: targets[0]?.target_type,
        target_config: targets[0]?.target_config,
        method: targets[0]?.method,
        js_injection: declaration?.js_injection ?? true,
    });
});

// -- GET /api/v2/routing/recent-targets — user's recent dispatch targets (#48)
app.get('/api/v2/routing/recent-targets', apiReadLimiter, v2Auth, (req, res) => {
    const user = req.v2Auth?.user;
    const appId = req.v2Auth?.app_id;
    if (!user) return res.status(400).json({ error: 'Could not determine user' });
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const rows = itemsDb.getRecentTargets(user, appId, limit);
    res.json({
        recent_targets: rows.map(r => {
            let config;
            try { config = JSON.parse(r.target_config); } catch { config = {}; }
            return {
                target_type: r.target_type,
                target_config: redactConfig(config),
                method: r.method,
                auth_id: r.auth_id,
                last_used: r.last_used,
                use_count: r.use_count,
            };
        }),
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

// -- GET /api/v2/analytics/quality-report — quality metrics (#87)
app.get('/api/v2/analytics/quality-report', apiReadLimiter, v2Auth, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    if (!app_id) return res.status(400).json({ error: 'No app context' });
    const days = Math.max(1, Math.min(90, parseInt(req.query.days, 10) || 30));

    try {
        const report = itemsDb.getQualityReport({ app_id, days });
        res.json({ report, days });
    } catch (err) {
        console.error('[analytics] quality-report error:', err.message);
        res.status(500).json({ error: 'Failed to compute quality report' });
    }
});

// -- GET /api/v2/analytics/agent-actions — agent action history (#87)
app.get('/api/v2/analytics/agent-actions', apiReadLimiter, v2Auth, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    if (!app_id) return res.status(400).json({ error: 'No app context' });

    const days = Math.max(1, Math.min(90, parseInt(req.query.days, 10) || 30));
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 100));
    const agent_id = req.query.agent_id || null;
    const action_type = req.query.action_type || null;

    try {
        const actions = itemsDb.getAgentActions({ app_id, agent_id, action_type, days, limit });
        const summary = itemsDb.getAgentActionSummary({ app_id, days });
        res.json({ actions, summary, days });
    } catch (err) {
        console.error('[analytics] agent-actions error:', err.message);
        res.status(500).json({ error: 'Failed to query agent actions' });
    }
});

// -- GET /api/v2/analytics/error-trends — perception error time series (#87)
app.get('/api/v2/analytics/error-trends', apiReadLimiter, v2Auth, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    if (!app_id) return res.status(400).json({ error: 'No app context' });
    const days = Math.max(1, Math.min(90, parseInt(req.query.days, 10) || 7));
    const group_by = ['severity', 'type', 'total'].includes(req.query.group_by) ? req.query.group_by : 'severity';

    try {
        const trends = itemsDb.getErrorTrends({ app_id, days, group_by });
        const summary = itemsDb.getErrorSummary({ app_id, days });
        res.json({ trends, summary, days, group_by });
    } catch (err) {
        console.error('[analytics] error-trends error:', err.message);
        res.status(500).json({ error: 'Failed to query error trends' });
    }
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

// ----------------------------------------------------------------- agent channel (#69 Error Sentinel)

// POST /api/v2/agent-channel/perception — upload perception events from extension
app.post('/api/v2/agent-channel/perception', apiWriteLimiter, v2AuthOrAgent, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    if (!app_id) return res.status(400).json({ error: 'No app context' });

    const { events, instance_id } = req.body;
    if (!Array.isArray(events) || events.length === 0) {
        return res.status(400).json({ error: 'events must be a non-empty array' });
    }
    if (events.length > 100) {
        return res.status(400).json({ error: 'Max 100 events per request' });
    }

    const agent_id = req.agent?.id || null;
    // #118: instance_id from request body (set by extension per Chrome Profile)
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const instanceId = (typeof instance_id === 'string' && UUID_RE.test(instance_id)) ? instance_id : null;
    const enriched = events.map(e => ({
        app_id,
        agent_id,
        instance_id: instanceId,
        type: e.type || 'unknown',
        message: (e.message || '').slice(0, 4096),
        stack: (e.stack || '').slice(0, 8192) || null,
        source: (e.source || '').slice(0, 2048) || null,
        line: e.line || null,
        severity: e.severity || 'error',
        url: (e.url || '').slice(0, 2048) || null,
        fingerprint: e.fingerprint || '',
        context: e.context || {},
    }));

    // Reject events without fingerprints
    const valid = enriched.filter(e => e.fingerprint);
    if (valid.length === 0) {
        return res.status(400).json({ error: 'All events missing fingerprint' });
    }

    try {
        const results = itemsDb.createPerceptionEvents(valid);
        // Log action (#87)
        try {
            itemsDb.logAgentAction({
                app_id,
                agent_id: req.v2Auth?.agent_id || null,
                action_type: 'perception_capture',
                summary: `Captured ${results.length} error event(s)`,
                metadata: { count: results.length },
            });
        } catch { /* non-critical */ }

        // Push to bound agents via perception WS (#109)
        if (app.locals.perceptionWs) {
            setImmediate(() => {
                try { app.locals.perceptionWs.pushPerceptionEvents(app_id, valid); }
                catch (e) { console.debug('[ws-perception] push error:', e.message); }
            });
        }

        // Push to agents on action WS (#127)
        if (app.locals.actionWs) {
            setImmediate(() => {
                try { app.locals.actionWs.broadcastPerception(app_id, valid); }
                catch (e) { console.debug('[ws-actions] perception broadcast error:', e.message); }
            });
        }

        // Trigger webhooks for P0/P1 events (#88)
        const highSeverity = valid.filter(e => e.severity === 'P0' || e.severity === 'P1');
        if (highSeverity.length > 0) {
            // Non-blocking: dispatch in background
            setImmediate(() => {
                for (const event of highSeverity) {
                    const issue = itemsDb.getPerceptionIssue({ app_id, fingerprint: event.fingerprint });
                    dispatchPerceptionWebhooks(itemsDb, event, issue, app_id).catch(err => {
                        console.error('[webhook] Dispatch error:', err.message);
                    });
                }
            });
        }

        res.json({ created: results.length, events: results });
    } catch (err) {
        console.error('[agent-channel] perception POST error:', err.message);
        res.status(500).json({ error: 'Failed to store events' });
    }
});

// GET /api/v2/agent-channel/perception — query perception events (agent consumer)
app.get('/api/v2/agent-channel/perception', apiReadLimiter, v2AuthOrAgent, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    if (!app_id) return res.status(400).json({ error: 'No app context' });

    const cursor = req.query.cursor || null;
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const agent_id = req.query.agent_id || (req.agent?.id) || null;
    const severity = req.query.severity || null;
    const url = req.query.url || null;
    const since = req.query.since || null;
    const until = req.query.until || null;

    try {
        const events = itemsDb.getPerceptionEvents({ app_id, agent_id, cursor, severity, url, since, until, limit });
        const nextCursor = events.length > 0 ? events[events.length - 1].created_at : cursor;
        res.json({ events, cursor: nextCursor, count: events.length });
    } catch (err) {
        console.error('[agent-channel] perception GET error:', err.message);
        res.status(500).json({ error: 'Failed to query events' });
    }
});

// GET /api/v2/agent-channel/perception/stats — aggregated error stats by fingerprint
app.get('/api/v2/agent-channel/perception/stats', apiReadLimiter, v2AuthOrAgent, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    if (!app_id) return res.status(400).json({ error: 'No app context' });

    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    try {
        const stats = itemsDb.getPerceptionStats({ app_id, limit });
        res.json({ stats });
    } catch (err) {
        console.error('[agent-channel] perception stats error:', err.message);
        res.status(500).json({ error: 'Failed to query stats' });
    }
});

// GET /api/v2/agent-channel/perception/issues — tracked perception issues
app.get('/api/v2/agent-channel/perception/issues', apiReadLimiter, v2AuthOrAgent, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    if (!app_id) return res.status(400).json({ error: 'No app context' });

    try {
        const issues = itemsDb.getOpenPerceptionIssues({ app_id });
        res.json({ issues });
    } catch (err) {
        console.error('[agent-channel] perception issues error:', err.message);
        res.status(500).json({ error: 'Failed to query issues' });
    }
});

// POST /api/v2/agent-channel/perception/issues — upsert a tracked issue (agent creates after dedup)
app.post('/api/v2/agent-channel/perception/issues', apiWriteLimiter, v2AuthOrAgent, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    if (!app_id) return res.status(400).json({ error: 'No app context' });

    const { fingerprint, count, first_seen, last_seen, gitlab_issue_id, gitlab_issue_url } = req.body;
    if (!fingerprint) return res.status(400).json({ error: 'fingerprint required' });

    try {
        const result = itemsDb.upsertPerceptionIssue({
            app_id, fingerprint, count, first_seen, last_seen,
            gitlab_issue_id, gitlab_issue_url,
        });
        // Log action (#87)
        try {
            const actionType = result.updated ? 'issue_updated' : 'issue_created';
            itemsDb.logAgentAction({
                app_id,
                agent_id: req.v2Auth?.agent_id || null,
                action_type: actionType,
                target_type: 'perception_issue',
                target_id: fingerprint,
                summary: result.updated
                    ? `Updated issue for ${fingerprint.slice(0, 20)}`
                    : `Created issue for ${fingerprint.slice(0, 20)}`,
                metadata: { gitlab_issue_url: gitlab_issue_url || null },
            });
        } catch { /* non-critical */ }
        res.json(result);
    } catch (err) {
        console.error('[agent-channel] perception issue upsert error:', err.message);
        res.status(500).json({ error: 'Failed to upsert issue' });
    }
});

// ----------------------------------------------------------------- agent webhooks (#88)

// POST /api/v2/agent-channel/webhooks — register a webhook
app.post('/api/v2/agent-channel/webhooks', apiWriteLimiter, v2AuthOrAgent, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    const agent_id = req.v2Auth?.agent?.id;
    if (!app_id || !agent_id) return res.status(400).json({ error: 'Agent authentication required' });

    const { url, secret, event_filters, template, allow_http } = req.body;
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url required' });

    // Validate URL protocol
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' && !(allow_http && parsed.protocol === 'http:')) {
            return res.status(400).json({ error: 'HTTPS required (set allow_http: true for HTTP)' });
        }
    } catch { return res.status(400).json({ error: 'Invalid URL' }); }

    // Max 10 webhooks per agent
    const count = itemsDb.countWebhooksByAgent(agent_id);
    if (count >= 10) return res.status(400).json({ error: 'Max 10 webhooks per agent' });

    // Generate secret if not provided
    const webhookSecret = secret || require('crypto').randomBytes(32).toString('hex');

    try {
        const wh = itemsDb.createWebhook({ app_id, agent_id, url, secret: webhookSecret, event_filters, template, allow_http });
        res.status(201).json({ ...wh, secret: webhookSecret });
    } catch (err) {
        console.error('[webhook] Create error:', err.message);
        res.status(500).json({ error: 'Failed to create webhook' });
    }
});

// GET /api/v2/agent-channel/webhooks — list webhooks
app.get('/api/v2/agent-channel/webhooks', apiReadLimiter, v2AuthOrAgent, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    const agent_id = req.v2Auth?.agent?.id;
    if (!app_id) return res.status(400).json({ error: 'No app context' });

    try {
        const webhooks = agent_id
            ? itemsDb.listWebhooksByAgent(agent_id)
            : itemsDb.listWebhooksByApp(app_id);
        // Strip secrets from list response
        const safe = webhooks.map(({ secret, ...rest }) => rest);
        res.json({ webhooks: safe, count: safe.length });
    } catch (err) {
        console.error('[webhook] List error:', err.message);
        res.status(500).json({ error: 'Failed to list webhooks' });
    }
});

// GET /api/v2/agent-channel/webhooks/:id — get webhook details + recent deliveries
app.get('/api/v2/agent-channel/webhooks/:id', apiReadLimiter, v2AuthOrAgent, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    if (!app_id) return res.status(400).json({ error: 'No app context' });

    try {
        const wh = itemsDb.getWebhook(req.params.id);
        if (!wh || wh.app_id !== app_id) return res.status(404).json({ error: 'Webhook not found' });
        const { secret, ...safe } = wh;
        const deliveries = itemsDb.getWebhookDeliveries(wh.id, 20);
        res.json({ webhook: safe, deliveries });
    } catch (err) {
        console.error('[webhook] Get error:', err.message);
        res.status(500).json({ error: 'Failed to get webhook' });
    }
});

// PUT /api/v2/agent-channel/webhooks/:id — update webhook
app.put('/api/v2/agent-channel/webhooks/:id', apiWriteLimiter, v2AuthOrAgent, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    if (!app_id) return res.status(400).json({ error: 'No app context' });

    const wh = itemsDb.getWebhook(req.params.id);
    if (!wh || wh.app_id !== app_id) return res.status(404).json({ error: 'Webhook not found' });

    const { url, event_filters, template, active, allow_http } = req.body;

    // Validate URL if changed
    const newUrl = url || wh.url;
    try {
        const parsed = new URL(newUrl);
        const httpAllowed = allow_http !== undefined ? allow_http : wh.allow_http;
        if (parsed.protocol !== 'https:' && !(httpAllowed && parsed.protocol === 'http:')) {
            return res.status(400).json({ error: 'HTTPS required (set allow_http: true for HTTP)' });
        }
    } catch { return res.status(400).json({ error: 'Invalid URL' }); }

    try {
        const updated = itemsDb.updateWebhook(req.params.id, {
            url: newUrl,
            event_filters: event_filters || JSON.parse(wh.event_filters || '{}'),
            template: template || wh.template,
            active: active !== undefined ? active : wh.active,
            allow_http: allow_http !== undefined ? allow_http : wh.allow_http,
        });
        const { secret, ...safe } = updated;
        res.json(safe);
    } catch (err) {
        console.error('[webhook] Update error:', err.message);
        res.status(500).json({ error: 'Failed to update webhook' });
    }
});

// DELETE /api/v2/agent-channel/webhooks/:id — delete webhook
app.delete('/api/v2/agent-channel/webhooks/:id', apiWriteLimiter, v2AuthOrAgent, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    if (!app_id) return res.status(400).json({ error: 'No app context' });

    const wh = itemsDb.getWebhook(req.params.id);
    if (!wh || wh.app_id !== app_id) return res.status(404).json({ error: 'Webhook not found' });

    try {
        itemsDb.deleteWebhook(req.params.id);
        res.json({ deleted: true });
    } catch (err) {
        console.error('[webhook] Delete error:', err.message);
        res.status(500).json({ error: 'Failed to delete webhook' });
    }
});

// POST /api/v2/agent-channel/webhooks/:id/test — send sample payload
app.post('/api/v2/agent-channel/webhooks/:id/test', apiWriteLimiter, v2AuthOrAgent, async (req, res) => {
    const app_id = req.v2Auth?.app_id;
    if (!app_id) return res.status(400).json({ error: 'No app context' });

    const wh = itemsDb.getWebhook(req.params.id);
    if (!wh || wh.app_id !== app_id) return res.status(404).json({ error: 'Webhook not found' });

    const { formatPayload, deliverWebhook } = require('./webhook-dispatcher');
    const sampleEvent = {
        type: 'js-error',
        message: 'Test error: this is a sample P1 webhook payload',
        severity: 'P1',
        url: 'https://example.com/test',
        fingerprint: 'test-fingerprint-sample',
        stack: 'Error: Test error\n    at test.js:1:1',
    };
    const sampleIssue = { id: 'pi-test', count: 42, first_seen: new Date().toISOString(), last_seen: new Date().toISOString() };

    const payload = formatPayload(wh.template, sampleEvent, sampleIssue, { app_id });

    try {
        const result = await deliverWebhook(wh.url, payload, wh.secret, wh.allow_http === 1);
        res.json({ test: true, ...result, payload });
    } catch (err) {
        res.status(500).json({ test: true, ok: false, error: err.message });
    }
});

// GET /api/v2/agent-channel/webhooks/:id/deliveries — list delivery history
app.get('/api/v2/agent-channel/webhooks/:id/deliveries', apiReadLimiter, v2AuthOrAgent, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    if (!app_id) return res.status(400).json({ error: 'No app context' });

    const wh = itemsDb.getWebhook(req.params.id);
    if (!wh || wh.app_id !== app_id) return res.status(404).json({ error: 'Webhook not found' });

    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    try {
        const deliveries = itemsDb.getWebhookDeliveries(wh.id, limit);
        res.json({ deliveries, count: deliveries.length });
    } catch (err) {
        console.error('[webhook] Deliveries query error:', err.message);
        res.status(500).json({ error: 'Failed to query deliveries' });
    }
});

// ----------------------------------------------------------------- agent registration (#68)

// POST /api/v2/agent-channel/register — register a new agent
app.post('/api/v2/agent-channel/register', agentRegisterLimiter, v2Auth, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    if (!app_id) return res.status(400).json({ error: 'No app context' });

    const { name, callback_url, capabilities } = req.body;
    if (!name || typeof name !== 'string' || name.length < 1 || name.length > 100) {
        return res.status(400).json({ error: 'name required (1-100 chars)' });
    }
    if (callback_url && typeof callback_url !== 'string') {
        return res.status(400).json({ error: 'callback_url must be a string' });
    }
    if (capabilities && !Array.isArray(capabilities)) {
        return res.status(400).json({ error: 'capabilities must be an array' });
    }

    try {
        const { raw, hash, prefix } = generateAgentKey();
        const agent = itemsDb.registerAgent({
            app_id,
            name: name.trim(),
            key_hash: hash,
            key_prefix: prefix,
            callback_url: callback_url || null,
            capabilities: capabilities || [],
            created_by: req.v2Auth.user_name || req.v2Auth.user || 'api',
        });
        // Return the raw key ONLY on creation (never shown again)
        res.status(201).json({ ...agent, api_key: raw });
    } catch (err) {
        console.error('[agent-channel] register error:', err.message);
        res.status(500).json({ error: 'Failed to register agent' });
    }
});

// GET /api/v2/agent-channel/me — return current agent's info (authenticated via X-Agent-Key)
app.get('/api/v2/agent-channel/me', apiReadLimiter, v2AuthOrAgent, (req, res) => {
    const agent = req.v2Auth?.agent;
    if (!agent) return res.status(401).json({ error: 'Agent key required' });
    res.json({ id: agent.id, name: agent.name, status: agent.status, key_prefix: agent.key_prefix });
});

// GET /api/v2/agent-channel/agents — list agents for current app
app.get('/api/v2/agent-channel/agents', apiReadLimiter, v2Auth, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    if (!app_id) return res.status(400).json({ error: 'No app context' });
    try {
        const agents = itemsDb.getAgentsByApp(app_id);
        res.json({ agents });
    } catch (err) {
        console.error('[agent-channel] list agents error:', err.message);
        res.status(500).json({ error: 'Failed to list agents' });
    }
});

// GET /api/v2/agent-channel/agents/:id — get agent by ID
app.get('/api/v2/agent-channel/agents/:id', apiReadLimiter, v2Auth, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    if (!app_id) return res.status(400).json({ error: 'No app context' });
    try {
        const agent = itemsDb.getAgentById(req.params.id);
        if (!agent) return res.status(404).json({ error: 'Agent not found' });
        if (agent.app_id !== app_id) return res.status(404).json({ error: 'Agent not found' });
        res.json(agent);
    } catch (err) {
        console.error('[agent-channel] get agent error:', err.message);
        res.status(500).json({ error: 'Failed to get agent' });
    }
});

// PUT /api/v2/agent-channel/agents/:id — update agent metadata
app.put('/api/v2/agent-channel/agents/:id', apiWriteLimiter, v2Auth, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    if (!app_id) return res.status(400).json({ error: 'No app context' });
    const { name, callback_url, capabilities } = req.body;
    try {
        const existing = itemsDb.getAgentById(req.params.id);
        if (!existing) return res.status(404).json({ error: 'Agent not found' });
        if (existing.app_id !== app_id) return res.status(404).json({ error: 'Agent not found' });
        const updated = itemsDb.updateAgent(req.params.id, {
            name: name !== undefined ? String(name).trim() : existing.name,
            callback_url: callback_url !== undefined ? callback_url : existing.callback_url,
            capabilities: capabilities !== undefined ? capabilities : JSON.parse(existing.capabilities || '[]'),
        });
        res.json(updated);
    } catch (err) {
        console.error('[agent-channel] update agent error:', err.message);
        res.status(500).json({ error: 'Failed to update agent' });
    }
});

// DELETE /api/v2/agent-channel/agents/:id — deactivate agent (soft delete)
app.delete('/api/v2/agent-channel/agents/:id', apiWriteLimiter, v2Auth, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    if (!app_id) return res.status(400).json({ error: 'No app context' });
    try {
        const existing = itemsDb.getAgentById(req.params.id);
        if (!existing) return res.status(404).json({ error: 'Agent not found' });
        if (existing.app_id !== app_id) return res.status(404).json({ error: 'Agent not found' });
        itemsDb.deactivateAgent(req.params.id);
        res.json({ id: req.params.id, status: 'inactive' });
    } catch (err) {
        console.error('[agent-channel] deactivate agent error:', err.message);
        res.status(500).json({ error: 'Failed to deactivate agent' });
    }
});

// POST /api/v2/agent-channel/agents/:id/rotate-key — rotate agent API key
app.post('/api/v2/agent-channel/agents/:id/rotate-key', apiWriteLimiter, v2Auth, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    if (!app_id) return res.status(400).json({ error: 'No app context' });
    try {
        const existing = itemsDb.getAgentById(req.params.id);
        if (!existing) return res.status(404).json({ error: 'Agent not found' });
        if (existing.app_id !== app_id) return res.status(404).json({ error: 'Agent not found' });
        const { raw, hash, prefix } = generateAgentKey();
        itemsDb.rotateAgentKey(req.params.id, { key_hash: hash, key_prefix: prefix });
        res.json({ id: req.params.id, api_key: raw, key_prefix: prefix });
    } catch (err) {
        console.error('[agent-channel] rotate key error:', err.message);
        res.status(500).json({ error: 'Failed to rotate key' });
    }
});

// ----------------------------------------------------------------- session storage (#73)

const sessionLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    keyGenerator: (req) => req.v2Auth?.app_id || req.ip,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Session rate limit exceeded, try again later' },
});

// POST /api/v2/agent-channel/sessions — create or append to a session
app.post('/api/v2/agent-channel/sessions', sessionLimiter, v2AuthOrAgent, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    if (!app_id) return res.status(400).json({ error: 'No app context' });

    const { session_id, tab_id, url, title, start_time, events, snapshots, metadata, instance_id } = req.body;
    const agent_id = req.v2Auth?.agent?.id || null;
    // #118: instance_id from request body (set by extension per Chrome Profile)
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const instanceId = (typeof instance_id === 'string' && UUID_RE.test(instance_id)) ? instance_id : null;

    // Validate events array
    if (events && (!Array.isArray(events) || events.length > 1000)) {
        return res.status(400).json({ error: 'events must be an array (max 1000)' });
    }
    if (snapshots && (!Array.isArray(snapshots) || snapshots.length > 100)) {
        return res.status(400).json({ error: 'snapshots must be an array (max 100)' });
    }

    try {
        // If session_id provided, append to existing session (chunked upload)
        if (session_id) {
            const existing = itemsDb.getSession(session_id);
            if (!existing) return res.status(404).json({ error: 'Session not found' });
            if (existing.app_id !== app_id) return res.status(404).json({ error: 'Session not found' });

            const result = itemsDb.appendSessionEvents(session_id, { events, snapshots, agent_id });
            if (!result) return res.status(403).json({ error: 'Agent ownership mismatch' });
            // Push session update to bound agents via WebSocket (#61 Phase 2)
            if (app.locals.perceptionWs) {
                try {
                    app.locals.perceptionWs.pushSessionUpdate(app_id, {
                        action: 'append',
                        session_id,
                        event_count: result.event_count,
                        snapshot_count: result.snapshot_count,
                        url: existing.url,
                        instance_id: instanceId,
                    });
                } catch { /* non-critical */ }
            }
            return res.json(result);
        }

        // Create new session
        const result = itemsDb.createSession({
            app_id,
            agent_id,
            instance_id: instanceId,
            tab_id,
            url,
            title,
            start_time,
            events,
            snapshots,
            metadata,
        });
        // Log action (#87)
        try {
            itemsDb.logAgentAction({
                app_id,
                agent_id: agent_id || null,
                action_type: 'session_start',
                target_type: 'session',
                target_id: result.id,
                summary: `Started session on ${(url || '').slice(0, 80)}`,
                metadata: { url, title },
            });
        } catch { /* non-critical */ }
        // Push session creation to bound agents via WebSocket (#61 Phase 2)
        if (app.locals.perceptionWs) {
            try {
                app.locals.perceptionWs.pushSessionUpdate(app_id, {
                    action: 'start',
                    session_id: result.id,
                    url,
                    title,
                    start_time,
                    event_count: result.event_count || (events || []).length,
                    instance_id: instanceId,
                });
            } catch { /* non-critical */ }
        }
        res.status(201).json(result);
    } catch (err) {
        if (err.message === 'SESSION_TOO_LARGE') {
            return res.status(413).json({ error: 'Session exceeds maximum size (50MB)' });
        }
        if (err.message === 'SESSION_FINALIZED') {
            return res.status(409).json({ error: 'Cannot append to a finalized session' });
        }
        if (err.message === 'INVALID_START_TIME') {
            return res.status(400).json({ error: 'start_time must be ISO 8601 format (e.g. 2026-03-21T10:00:00.000Z)' });
        }
        if (err.message.startsWith('INVALID_EVENT_TYPE:')) {
            const type = err.message.split(':')[1];
            return res.status(400).json({ error: `Invalid event type: ${type}. Allowed: dom-mutation, console-log, console-error, network-error, click, scroll, input, navigation, error, snapshot` });
        }
        console.error('[agent-channel] session POST error:', err.message);
        res.status(500).json({ error: 'Failed to store session' });
    }
});

// POST /api/v2/agent-channel/sessions/:id/finalize — mark session as completed
app.post('/api/v2/agent-channel/sessions/:id/finalize', sessionLimiter, v2AuthOrAgent, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    if (!app_id) return res.status(400).json({ error: 'No app context' });

    try {
        const session = itemsDb.getSession(req.params.id);
        if (!session) return res.status(404).json({ error: 'Session not found' });
        if (session.app_id !== app_id) return res.status(404).json({ error: 'Session not found' });

        const result = itemsDb.finalizeSession(req.params.id);
        // Log action (#87)
        try {
            itemsDb.logAgentAction({
                app_id,
                agent_id: session.agent_id || null,
                action_type: 'session_end',
                target_type: 'session',
                target_id: req.params.id,
                summary: `Finalized session (${result.event_count || 0} events)`,
                metadata: { event_count: result.event_count, snapshot_count: result.snapshot_count },
            });
        } catch { /* non-critical */ }
        // Push finalization to bound agents via WebSocket (#61 Phase 2)
        if (app.locals.perceptionWs) {
            try {
                app.locals.perceptionWs.pushSessionUpdate(app_id, {
                    action: 'finalize',
                    session_id: req.params.id,
                    event_count: result.event_count,
                    snapshot_count: result.snapshot_count,
                    url: session.url,
                    duration_ms: result.end_time && session.start_time
                        ? new Date(result.end_time).getTime() - new Date(session.start_time).getTime()
                        : null,
                });
            } catch { /* non-critical */ }
        }
        res.json(result);
    } catch (err) {
        console.error('[agent-channel] session finalize error:', err.message);
        res.status(500).json({ error: 'Failed to finalize session' });
    }
});

// GET /api/v2/agent-channel/sessions — list sessions
app.get('/api/v2/agent-channel/sessions', apiReadLimiter, v2AuthOrAgent, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    if (!app_id) return res.status(400).json({ error: 'No app context' });

    const { agent_id, site, after, limit } = req.query;

    // P2-5: Validate after param format
    const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
    if (after && !ISO_DATE_RE.test(after)) {
        return res.status(400).json({ error: 'after must be ISO 8601 format (e.g. 2026-03-21T00:00:00.000Z)' });
    }

    try {
        const sessions = itemsDb.listSessions({
            app_id,
            agent_id: agent_id || null,
            site: site || null,
            after: after || null,
            limit: parseInt(limit) || 50,
        });
        res.json({ sessions, count: sessions.length });
    } catch (err) {
        console.error('[agent-channel] session list error:', err.message);
        res.status(500).json({ error: 'Failed to list sessions' });
    }
});

// GET /api/v2/agent-channel/sessions/:id — get session detail with events
app.get('/api/v2/agent-channel/sessions/:id', apiReadLimiter, v2AuthOrAgent, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    if (!app_id) return res.status(400).json({ error: 'No app context' });

    try {
        const session = itemsDb.getSession(req.params.id);
        if (!session) return res.status(404).json({ error: 'Session not found' });
        if (session.app_id !== app_id) return res.status(404).json({ error: 'Session not found' });

        const { start_time, end_time, include_snapshots } = req.query;
        const events = itemsDb.getSessionEvents(req.params.id, {
            start_time: start_time || null,
            end_time: end_time || null,
        });

        let snapshots = null;
        if (include_snapshots === 'true' || include_snapshots === '1') {
            snapshots = itemsDb.getSessionSnapshots(req.params.id);
        }

        res.json({ session, events, ...(snapshots !== null ? { snapshots } : {}) });
    } catch (err) {
        console.error('[agent-channel] session detail error:', err.message);
        res.status(500).json({ error: 'Failed to get session' });
    }
});

// GET /api/v2/agent-channel/sessions/:id/snapshots/:snapshotId — get full snapshot HTML
app.get('/api/v2/agent-channel/sessions/:id/snapshots/:snapshotId', apiReadLimiter, v2AuthOrAgent, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    if (!app_id) return res.status(400).json({ error: 'No app context' });

    try {
        const session = itemsDb.getSession(req.params.id);
        if (!session) return res.status(404).json({ error: 'Session not found' });
        if (session.app_id !== app_id) return res.status(404).json({ error: 'Session not found' });

        const snapshot = itemsDb.getSessionSnapshot(req.params.snapshotId);
        if (!snapshot || snapshot.session_id !== req.params.id) {
            return res.status(404).json({ error: 'Snapshot not found' });
        }

        res.json(snapshot);
    } catch (err) {
        console.error('[agent-channel] snapshot detail error:', err.message);
        res.status(500).json({ error: 'Failed to get snapshot' });
    }
});

// GET /api/v2/agent-channel/sessions/:id/analysis — session analysis with correlated errors + reproduction steps (#61)
app.get('/api/v2/agent-channel/sessions/:id/analysis', apiReadLimiter, v2AuthOrAgent, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    if (!app_id) return res.status(400).json({ error: 'No app context' });

    try {
        const session = itemsDb.getSession(req.params.id);
        if (!session) return res.status(404).json({ error: 'Session not found' });
        if (session.app_id !== app_id) return res.status(404).json({ error: 'Session not found' });

        // Find perception errors that occurred during this session
        const errors = itemsDb.getPerceptionEvents({
            app_id,
            since: session.start_time,
            until: session.end_time || new Date().toISOString(),
            severity: 'error',
            limit: 50,
        });

        // Filter errors to those matching this session's URL (same origin)
        let sessionOrigin;
        try { sessionOrigin = new URL(session.url).origin; } catch {}

        const sessionErrors = sessionOrigin
            ? errors.filter(e => { try { return new URL(e.url).origin === sessionOrigin; } catch { return false; } })
            : errors;

        // For each error, generate correlation + reproduction steps
        const analyses = sessionErrors.map(error => {
            try {
                const correlation = correlate(itemsDb, error, {
                    beforeMs: Number(req.query.before_ms) || undefined,
                    afterMs: Number(req.query.after_ms) || undefined,
                });
                if (!correlation) return {
                    error: { id: error.id, type: error.type, severity: error.severity, message: error.message, fingerprint: error.fingerprint, created_at: error.created_at },
                    reproduction: null,
                };

                const report = generateReport(correlation, error);
                return {
                    error: {
                        id: error.id,
                        type: error.type,
                        severity: error.severity,
                        message: error.message,
                        source: error.source,
                        line: error.line,
                        url: error.url,
                        fingerprint: error.fingerprint,
                        created_at: error.created_at,
                    },
                    reproduction: {
                        steps: report.steps,
                        trigger: report.trigger,
                        timeline: report.timeline,
                        snapshot_id: correlation.closestSnapshot?.id || null,
                    },
                };
            } catch (err) {
                return { error: { id: error.id, message: error.message }, reproduction: null };
            }
        });

        res.json({
            session: {
                id: session.id,
                url: session.url,
                title: session.title,
                start_time: session.start_time,
                end_time: session.end_time,
                event_count: session.event_count,
                snapshot_count: session.snapshot_count,
                status: session.status,
            },
            error_count: sessionErrors.length,
            analyses,
        });
    } catch (err) {
        console.error('[agent-channel] session analysis error:', err.message);
        res.status(500).json({ error: 'Failed to analyze session' });
    }
});

// GET /api/v2/agent-channel/perception/issues/:fingerprint/context — full error context with session correlation (#61)
app.get('/api/v2/agent-channel/perception/issues/:fingerprint/context', apiReadLimiter, v2AuthOrAgent, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    if (!app_id) return res.status(400).json({ error: 'No app context' });

    try {
        const issue = itemsDb.getPerceptionIssue({ app_id, fingerprint: req.params.fingerprint });
        if (!issue) return res.status(404).json({ error: 'Issue not found' });

        // Get recent events for this fingerprint
        const events = itemsDb.getPerceptionEventsByFingerprint({
            app_id,
            fingerprint: req.params.fingerprint,
            limit: 5,
        });

        if (events.length === 0) {
            return res.json({ issue, context: null });
        }

        // Use the most recent event for correlation
        const representative = events[0];
        let context = null;
        try {
            const correlation = correlate(itemsDb, representative);
            if (correlation) {
                const report = generateReport(correlation, representative);
                context = {
                    session_id: correlation.session?.id,
                    session_url: correlation.session?.url,
                    steps: report.steps,
                    trigger: report.trigger,
                    timeline: report.timeline,
                    snapshot_id: correlation.closestSnapshot?.id || null,
                };
            }
        } catch {}

        res.json({ issue, context, recent_events: events.length });
    } catch (err) {
        console.error('[agent-channel] perception issue context error:', err.message);
        res.status(500).json({ error: 'Failed to get issue context' });
    }
});

// ----------------------------------------------------------------- action queue REST (#78)

// POST /api/v2/agent-channel/actions — submit action (REST alternative to WebSocket)
app.post('/api/v2/agent-channel/actions', sessionLimiter, v2AuthOrAgent, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    const agent_id = req.v2Auth?.agent?.id;
    if (!app_id || !agent_id) return res.status(400).json({ error: 'Agent auth required' });

    const { action_type, payload, session_id, timeout_ms } = req.body;
    if (!action_type) return res.status(400).json({ error: 'action_type is required' });

    try {
        const action = itemsDb.createAction({
            agent_id,
            app_id,
            session_id: session_id || null,
            type: action_type,
            payload: payload || {},
            timeout_ms: timeout_ms || 30000,
        });
        res.status(201).json(action);
    } catch (err) {
        if (err.message.startsWith('INVALID_ACTION_TYPE:')) {
            const type = err.message.split(':')[1];
            return res.status(400).json({ error: `Invalid action_type: ${type}. Allowed: ${itemsDb.getValidActionTypes().join(', ')}` });
        }
        if (err.message === 'QUEUE_FULL') {
            return res.status(429).json({ error: 'Action queue full (max 100 pending per agent)' });
        }
        console.error('[agent-channel] action POST error:', err.message);
        res.status(500).json({ error: 'Failed to queue action' });
    }
});

// GET /api/v2/agent-channel/actions/:id — poll action status
app.get('/api/v2/agent-channel/actions/:id', apiReadLimiter, v2AuthOrAgent, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    if (!app_id) return res.status(400).json({ error: 'No app context' });

    const action = itemsDb.getAction(req.params.id);
    if (!action) return res.status(404).json({ error: 'Action not found' });
    if (action.app_id !== app_id) return res.status(404).json({ error: 'Action not found' });

    // Parse stored JSON fields
    const result = {
        ...action,
        payload: JSON.parse(action.payload || '{}'),
        result: action.result ? JSON.parse(action.result) : null,
    };
    res.json(result);
});

// POST /api/v2/agent-channel/actions/:id/result — extension submits result (webhook fallback)
app.post('/api/v2/agent-channel/actions/:id/result', sessionLimiter, v2AuthOrAgent, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    if (!app_id) return res.status(400).json({ error: 'No app context' });

    const action = itemsDb.getAction(req.params.id);
    if (!action) return res.status(404).json({ error: 'Action not found' });
    if (action.app_id !== app_id) return res.status(404).json({ error: 'Action not found' });
    if (action.status === 'completed' || action.status === 'failed') {
        return res.status(409).json({ error: 'Action already resolved' });
    }

    const { result, error } = req.body;
    const status = error ? 'failed' : 'completed';
    try {
        const updated = itemsDb.updateActionStatus(action.id, { status, result, error });
        if (!updated) return res.status(409).json({ error: 'Status race condition' });
        res.json({ action_id: action.id, status });
    } catch (err) {
        if (err.message?.startsWith('INVALID_TRANSITION')) {
            return res.status(409).json({ error: 'Invalid state transition' });
        }
        throw err;
    }
});

// GET /api/v2/agent-channel/actions — list agent's actions
app.get('/api/v2/agent-channel/actions', apiReadLimiter, v2AuthOrAgent, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    const agent_id = req.v2Auth?.agent?.id;
    if (!app_id) return res.status(400).json({ error: 'No app context' });

    const { status, limit } = req.query;
    try {
        let actions;
        if (agent_id) {
            actions = itemsDb.listAgentActions(agent_id, status || 'queued', parseInt(limit) || 50);
        } else {
            actions = itemsDb.listPendingActions(app_id, parseInt(limit) || 50);
        }
        res.json({ actions, count: actions.length });
    } catch (err) {
        console.error('[agent-channel] action list error:', err.message);
        res.status(500).json({ error: 'Failed to list actions' });
    }
});

// ----------------------------------------------------------------- CDP audit log (#83)

// GET /api/v2/agent-channel/cdp/audit — query CDP audit logs
app.get('/api/v2/agent-channel/cdp/audit', apiReadLimiter, v2AuthOrAgent, (req, res) => {
    const app_id = req.v2Auth?.app_id;
    const agent_id = req.v2Auth?.agent?.id;
    if (!app_id) return res.status(400).json({ error: 'No app context' });

    const { session_key, limit } = req.query;
    const safeLimit = Math.min(parseInt(limit) || 100, 500);

    try {
        let logs;
        if (session_key) {
            // Filter by app_id to prevent cross-app leakage (P2 fix)
            logs = itemsDb.getCdpAuditBySession(session_key, safeLimit)
                .filter(l => l.app_id === app_id);
        } else if (agent_id) {
            logs = itemsDb.getCdpAuditByAgent(agent_id, safeLimit)
                .filter(l => l.app_id === app_id);
        } else {
            logs = itemsDb.getCdpAuditByApp(app_id, safeLimit);
        }
        res.json({ logs, count: logs.length });
    } catch (err) {
        console.error('[cdp] Audit query error:', err.message);
        res.status(500).json({ error: 'Failed to query CDP audit logs' });
    }
});

// ----------------------------------------------------------------- health

// Build metadata for /health (#2)
const serverCommit = (() => {
    try { return require('child_process').execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim(); }
    catch { return process.env.COMMIT_HASH || 'unknown'; }
})();
const serverBuildTime = (() => {
    try { return require('child_process').execSync('git show -s --format=%cI HEAD', { encoding: 'utf-8' }).trim(); }
    catch { return process.env.BUILD_TIME || new Date().toISOString(); }
})();

// ================================================================= Guest Share (#102)
// Share links for non-technical users to submit feedback without
// installing the extension or logging in.
// =================================================================

// -- Create share link (authenticated)
app.post('/api/v2/shares', apiWriteLimiter, v2Auth, (req, res) => {
    const { source_url, title, guest_name_required, max_feedbacks, expires_in_hours } = req.body;
    if (!source_url) return res.status(400).json({ error: 'source_url is required' });
    if (!/^https?:\/\//i.test(source_url)) return res.status(400).json({ error: 'source_url must be an HTTP or HTTPS URL' });

    const share_token = crypto.randomBytes(32).toString('hex');
    const expires_at = expires_in_hours
        ? new Date(Date.now() + expires_in_hours * 60 * 60 * 1000).toISOString()
        : null;

    const share = itemsDb.createGuestShare({
        share_token,
        owner_user_id: req.v2Auth.user,
        app_id: req.v2Auth.app_id,
        source_url,
        title,
        guest_name_required: !!guest_name_required,
        max_feedbacks: max_feedbacks || 100,
        expires_at,
    });

    res.json({ success: true, share, share_url: `/share/${share_token}` });
});

// -- List my shares (authenticated)
app.get('/api/v2/shares', apiReadLimiter, v2Auth, (req, res) => {
    const shares = itemsDb.listGuestSharesByUser(req.v2Auth.user);
    res.json({ shares });
});

// -- Delete a share (authenticated)
app.delete('/api/v2/shares/:id', apiWriteLimiter, v2Auth, (req, res) => {
    const result = itemsDb.deleteGuestShare(req.params.id, req.v2Auth.user);
    if (!result.success) return res.status(404).json({ error: 'Share not found' });
    res.json({ success: true });
});

// -- Get share info + existing feedback (public, no auth)
app.get('/api/v2/shares/:token/info', apiReadLimiter, (req, res) => {
    const share = itemsDb.getGuestShareByToken(req.params.token);
    if (!share) return res.status(404).json({ error: 'Share not found' });

    if (share.expires_at && new Date(share.expires_at) < new Date()) {
        return res.status(410).json({ error: 'This share link has expired' });
    }

    const feedbacks = itemsDb.db.prepare(`
        SELECT id, quote, created_by, created_at,
               (SELECT content FROM messages WHERE item_id = items.id ORDER BY created_at ASC LIMIT 1) AS content
        FROM items
        WHERE app_id = ? AND created_by LIKE 'guest:%' AND metadata LIKE ?
        ORDER BY created_at DESC
    `).all(share.app_id, `%"share_token":"${share.share_token}"%`);

    res.json({
        title: share.title,
        source_url: share.source_url,
        guest_name_required: !!share.guest_name_required,
        feedbacks,
    });
});

// -- Submit guest feedback (public, rate-limited)
app.post('/api/v2/shares/:token/feedback', guestFeedbackLimiter, (req, res) => {
    const share = itemsDb.getGuestShareByToken(req.params.token);
    if (!share) return res.status(404).json({ error: 'Share not found' });

    if (share.expires_at && new Date(share.expires_at) < new Date()) {
        return res.status(410).json({ error: 'This share link has expired' });
    }

    const feedbackCount = itemsDb.countGuestFeedbackByShare(share.share_token);
    if (feedbackCount >= share.max_feedbacks) {
        return res.status(429).json({ error: 'Maximum feedback limit reached for this share' });
    }

    const { name, email, content, quote } = req.body;
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
        return res.status(400).json({ error: 'content is required' });
    }
    if (content.length > 5000) {
        return res.status(400).json({ error: 'content too long (max 5000 characters)' });
    }
    if (share.guest_name_required && (!name || typeof name !== 'string' || name.trim().length === 0)) {
        return res.status(400).json({ error: 'name is required for this share' });
    }

    // Sanitize inputs
    const safeName = name ? String(name).slice(0, 100).trim() : 'anonymous';
    const safeEmail = email ? String(email).slice(0, 200).trim() : null;
    const safeContent = String(content).slice(0, 5000).trim();
    const safeQuote = quote ? String(quote).slice(0, 2000).trim() : null;

    const guestUser = `guest:${safeName}`;

    const item = itemsDb.createItem({
        app_id: share.app_id,
        doc: share.source_url,
        type: 'comment',
        title: null,
        quote: safeQuote,
        quote_position: null,
        priority: 'normal',
        created_by: guestUser,
        version: null,
        message: safeContent,
        source_url: share.source_url,
        source_title: share.title || null,
        tags: ['guest-feedback'],
        screenshots: [],
        metadata: JSON.stringify({ share_token: share.share_token, guest_email: safeEmail }),
    });

    // Dispatch via delivery rules (same as authenticated items)
    sendWebhook('item.created', item).catch(err => {
        console.error(`[dispatch] Guest feedback dispatch error for ${item.id}:`, err.message);
    });

    res.json({ success: true, id: item.id });
});

// -- Share page (server-rendered HTML, no auth)
app.get('/share/:token', apiReadLimiter, (req, res) => {
    const share = itemsDb.getGuestShareByToken(req.params.token);
    if (!share) return res.status(404).send('Share not found');

    if (share.expires_at && new Date(share.expires_at) < new Date()) {
        return res.status(410).send('This share link has expired');
    }

    const escHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const pageTitle = escHtml(share.title || share.source_url);
    const nameRequired = share.guest_name_required ? 'true' : 'false';

    res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Feedback — ${pageTitle}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f0f0f;color:#e0e0e0;min-height:100vh;display:flex;justify-content:center;padding:20px}
.container{max-width:600px;width:100%}
h1{font-size:1.4rem;margin-bottom:4px;color:#fff}
.subtitle{color:#888;font-size:0.85rem;margin-bottom:24px;word-break:break-all}
.subtitle a{color:#6b9fff;text-decoration:none}
.subtitle a:hover{text-decoration:underline}
.form-group{margin-bottom:16px}
label{display:block;font-size:0.85rem;color:#aaa;margin-bottom:4px}
input,textarea{width:100%;padding:10px 12px;background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#e0e0e0;font-size:0.95rem;outline:none;transition:border-color 0.2s}
input:focus,textarea:focus{border-color:#6b9fff}
textarea{min-height:120px;resize:vertical;font-family:inherit}
.btn{padding:10px 24px;background:#2563eb;color:#fff;border:none;border-radius:6px;font-size:0.95rem;cursor:pointer;transition:background 0.2s}
.btn:hover{background:#1d4ed8}
.btn:disabled{opacity:0.5;cursor:not-allowed}
.msg{padding:12px;border-radius:6px;margin-top:12px;font-size:0.9rem}
.msg.ok{background:#064e3b;color:#6ee7b7;border:1px solid #065f46}
.msg.err{background:#7f1d1d;color:#fca5a5;border:1px solid #991b1b}
.feedbacks{margin-top:32px}
.feedbacks h2{font-size:1.1rem;margin-bottom:12px;color:#ccc}
.fb-card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:8px;padding:12px 16px;margin-bottom:10px}
.fb-card .fb-meta{font-size:0.8rem;color:#888;margin-bottom:6px}
.fb-card .fb-quote{font-style:italic;color:#999;border-left:2px solid #444;padding-left:8px;margin-bottom:6px;font-size:0.9rem}
.fb-card .fb-content{color:#ddd;font-size:0.95rem;white-space:pre-wrap}
.powered{text-align:center;margin-top:24px;font-size:0.75rem;color:#555}
.powered a{color:#666;text-decoration:none}
</style>
</head>
<body>
<div class="container">
<h1>${pageTitle}</h1>
<p class="subtitle"><a href="${escHtml(share.source_url)}" target="_blank" rel="noopener">${escHtml(share.source_url)}</a></p>

<form id="fbForm">
  <div class="form-group" id="nameGroup">
    <label for="guestName">Your name${share.guest_name_required ? ' *' : ' (optional)'}</label>
    <input type="text" id="guestName" maxlength="100" placeholder="Name">
  </div>
  <div class="form-group">
    <label for="guestContent">Your feedback *</label>
    <textarea id="guestContent" maxlength="5000" placeholder="Share your thoughts..." required></textarea>
  </div>
  <button type="submit" class="btn" id="submitBtn">Submit Feedback</button>
  <div id="msgBox" style="display:none"></div>
</form>

<div class="feedbacks" id="feedbackList"></div>
<p class="powered">Powered by <a href="https://labs.coco.xyz/clawmark/" target="_blank">ClawMark</a></p>
</div>

<script>
(function(){
  const TOKEN = ${JSON.stringify(share.share_token)};
  const NAME_REQ = ${nameRequired};
  const API = '/api/v2/shares/' + TOKEN;

  const form = document.getElementById('fbForm');
  const nameInput = document.getElementById('guestName');
  const contentInput = document.getElementById('guestContent');
  const submitBtn = document.getElementById('submitBtn');
  const msgBox = document.getElementById('msgBox');
  const feedbackList = document.getElementById('feedbackList');

  function escH(s){ const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

  function showMsg(text, ok){
    msgBox.textContent = text;
    msgBox.className = 'msg ' + (ok ? 'ok' : 'err');
    msgBox.style.display = 'block';
  }

  function loadFeedbacks(){
    fetch(API + '/info').then(r=>r.json()).then(data=>{
      if(!data.feedbacks || data.feedbacks.length === 0){
        feedbackList.innerHTML = '';
        return;
      }
      let html = '<h2>Feedback (' + data.feedbacks.length + ')</h2>';
      data.feedbacks.forEach(fb => {
        const name = escH((fb.created_by||'').replace(/^guest:/,'') || 'anonymous');
        const date = new Date(fb.created_at).toLocaleString();
        html += '<div class="fb-card">';
        html += '<div class="fb-meta">' + name + ' &middot; ' + date + '</div>';
        if(fb.quote) html += '<div class="fb-quote">' + escH(fb.quote) + '</div>';
        html += '<div class="fb-content">' + escH(fb.content || '') + '</div>';
        html += '</div>';
      });
      feedbackList.innerHTML = html;
    }).catch(()=>{});
  }

  form.addEventListener('submit', function(e){
    e.preventDefault();
    const name = nameInput.value.trim();
    const content = contentInput.value.trim();
    if(!content){ showMsg('Please enter your feedback.', false); return; }
    if(NAME_REQ && !name){ showMsg('Please enter your name.', false); return; }

    submitBtn.disabled = true;
    msgBox.style.display = 'none';

    fetch(API + '/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name||undefined, content: content }),
    }).then(r => r.json().then(d => ({ ok: r.ok, data: d })))
      .then(({ ok, data }) => {
        if(ok){
          showMsg('Thank you for your feedback!', true);
          contentInput.value = '';
          loadFeedbacks();
        } else {
          showMsg(data.error || 'Failed to submit feedback.', false);
        }
      })
      .catch(() => showMsg('Network error, please try again.', false))
      .finally(() => { submitBtn.disabled = false; });
  });

  loadFeedbacks();
})();
</script>
</body>
</html>`);
});

app.get('/health', (req, res) => {
    let dbOk = true;
    try { itemsDb.db.prepare('SELECT 1').get(); } catch { dbOk = false; }
    res.json({
        status: 'ok',
        version: pkg.version,
        commit: serverCommit,
        buildTime: serverBuildTime,
        uptime: process.uptime(),
        db_ok: dbOk,
        adapters: Object.keys(registry.getStatus()).length,
    });
});

// ----------------------------------------------------------------- listen

const server = app.listen(PORT, () => {
    console.log(`[+] ClawMark V2 server running on port ${PORT}`);
    console.log(`    data dir  : ${DATA_DIR}`);
    console.log(`    adapters  : ${Object.keys(registry.getStatus()).length} channel(s)`);
    console.log(`    auth      : JWT + API key (invite codes deprecated)`);
    console.log(`    api v2    : /api/v2/*`);
    console.log(`    ws        : /ws/agent-channel/actions`);
    console.log(`    ws        : /ws/agent-channel/cdp`);
    console.log(`    ws        : /ws/agent (perception push)`);

    // Deferred reference: perceptionWs calls actionWs.dispatchAction, actionWs calls perceptionWs.pushActionResult.
    // Use closures to break the circular init dependency.
    let actionWsRef = null;

    // Perception Push WebSocket (#109 — Phase 4: Agent binding)
    const perceptionWs = initPerceptionWs(server, itemsDb, {
        onActionCreated: (actionId, appId) => actionWsRef?.dispatchAction(actionId, appId),
    });
    app.locals.perceptionWs = perceptionWs;

    // Action WebSocket (#78)
    const actionWs = initActionWs(server, itemsDb, {
        onResult: (agentId, appId, data) => perceptionWs.pushActionResult(agentId, appId, data),
    });
    actionWsRef = actionWs;
    app.locals.actionWs = actionWs;

    // CDP Channel WebSocket (#83)
    const cdpWs = initCdpWs(server, itemsDb);

    // Action timeout checker: every 5s
    setInterval(() => {
        const n = actionWs.checkTimeouts();
        if (n > 0) console.log(`[action] Timed out ${n} action(s)`);
    }, 5000);

    // Action cleanup: daily, delete completed/failed actions older than 7 days
    const runActionCleanup = () => {
        try {
            const result = itemsDb.cleanupOldActions(7);
            if (result.deleted > 0) console.log(`[action] Cleaned up ${result.deleted} old action(s)`);
        } catch (err) {
            console.error('[action] Cleanup error:', err.message);
        }
    };
    runActionCleanup();
    setInterval(runActionCleanup, 24 * 60 * 60 * 1000);

    // Session + action cleanup job: run daily + on startup (#73, #87)
    const runSessionCleanup = () => {
        try {
            const result = itemsDb.cleanupOldSessions(30, 7);
            if (result.deleted > 0) {
                console.log(`[session] Cleaned up ${result.completed} expired + ${result.orphaned} orphaned session(s)`);
            }
        } catch (err) {
            console.error('[session] Cleanup error:', err.message);
        }
        try {
            const result = itemsDb.cleanupOldActions(90);
            if (result.deleted > 0) {
                console.log(`[actions] Cleaned up ${result.deleted} old action(s) (>90d)`);
            }
        } catch (err) {
            console.error('[actions] Cleanup error:', err.message);
        }
        try {
            const result = itemsDb.cleanupOldCdpAuditLogs(7);
            if (result.deleted > 0) {
                console.log(`[cdp] Cleaned up ${result.deleted} old audit log(s) (>7d)`);
            }
        } catch (err) {
            console.error('[cdp] Cleanup error:', err.message);
        }
        try {
            const result = itemsDb.cleanupOldWebhookDeliveries(30);
            if (result.deleted > 0) {
                console.log(`[webhook] Cleaned up ${result.deleted} old delivery(ies) (>30d)`);
            }
        } catch (err) {
            console.error('[webhook] Cleanup error:', err.message);
        }
    };
    runSessionCleanup(); // run on startup
    setInterval(runSessionCleanup, 24 * 60 * 60 * 1000); // every 24h

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

    // Webhook retry worker (#88): every 30s, retry failed webhook deliveries
    let webhookRetryBusy = false;
    setInterval(() => {
        if (webhookRetryBusy) return;
        webhookRetryBusy = true;
        retryFailedDeliveries(itemsDb).then(n => {
            if (n > 0) console.log(`[webhook] Retried ${n} failed delivery(ies)`);
        }).catch(err => {
            console.error('[webhook] Retry worker error:', err.message);
        }).finally(() => { webhookRetryBusy = false; });
    }, 30000);
});
