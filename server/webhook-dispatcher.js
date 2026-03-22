'use strict';

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { isSafeUrl } = require('./target-declaration');

/**
 * Webhook Dispatcher (#88)
 *
 * Dispatches perception error notifications to registered webhooks.
 * Supports HMAC-SHA256 signing, retry with exponential backoff,
 * auto-disable after 10 consecutive failures, and rate limiting.
 */

// Rate limiter: agent_id -> { count, windowStart }
const rateLimits = new Map();
const RATE_LIMIT_MAX = 100; // 100 deliveries/minute per agent
const RATE_LIMIT_WINDOW = 60000; // 1 minute

// Retry backoff schedule (attempt -> delay in ms)
const RETRY_DELAYS = [0, 30000, 120000, 600000]; // immediate, 30s, 2min, 10min

/**
 * Check rate limit for an agent.
 * @returns {boolean} true if allowed
 */
function checkRateLimit(agentId) {
    const now = Date.now();
    let entry = rateLimits.get(agentId);
    if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW) {
        entry = { count: 0, windowStart: now };
        rateLimits.set(agentId, entry);
    }
    if (entry.count >= RATE_LIMIT_MAX) return false;
    entry.count++;
    return true;
}

/**
 * Check if webhook event_filters match a perception event.
 */
function filtersMatch(filters, event) {
    if (!filters || Object.keys(filters).length === 0) return true;

    if (filters.severity && filters.severity.length > 0) {
        if (!filters.severity.includes(event.severity)) return false;
    }
    if (filters.types && filters.types.length > 0) {
        if (!filters.types.includes(event.type)) return false;
    }
    if (filters.sites && filters.sites.length > 0) {
        const eventUrl = event.url || '';
        if (!filters.sites.some(site => eventUrl.includes(site))) return false;
    }
    return true;
}

/**
 * Format payload using the specified template.
 */
function formatPayload(template, event, issue, context) {
    const base = {
        event_type: `perception.${(event.severity || 'error').toLowerCase()}`,
        error: {
            type: event.type,
            message: event.message,
            severity: event.severity,
            url: event.url,
            fingerprint: event.fingerprint,
            stack: event.stack ? event.stack.slice(0, 500) : null,
        },
        issue: issue ? {
            id: issue.id,
            count: issue.count,
            first_seen: issue.first_seen,
            last_seen: issue.last_seen,
            gitlab_url: issue.gitlab_issue_url || null,
        } : null,
        timestamp: new Date().toISOString(),
        app_id: context.app_id,
    };

    switch (template) {
        case 'slack':
            return formatSlack(base);
        case 'lark':
            return formatLark(base);
        case 'dingtalk':
            return formatDingTalk(base);
        default:
            return base;
    }
}

function formatSlack(data) {
    const severity = data.error.severity || 'error';
    const color = severity === 'P0' ? '#dc3545' : severity === 'P1' ? '#fd7e14' : '#ffc107';
    return {
        attachments: [{
            color,
            title: `[${severity}] ${data.error.type}: ${(data.error.message || '').slice(0, 100)}`,
            title_link: data.issue?.gitlab_url || undefined,
            fields: [
                { title: 'URL', value: data.error.url || 'N/A', short: true },
                { title: 'Count', value: String(data.issue?.count || 1), short: true },
                { title: 'First Seen', value: data.issue?.first_seen || 'N/A', short: true },
                { title: 'Fingerprint', value: (data.error.fingerprint || '').slice(0, 16), short: true },
            ],
            ts: Math.floor(Date.now() / 1000),
        }],
    };
}

function formatLark(data) {
    const severity = data.error.severity || 'error';
    const color = severity === 'P0' ? 'red' : severity === 'P1' ? 'orange' : 'yellow';
    return {
        msg_type: 'interactive',
        card: {
            header: {
                title: { tag: 'plain_text', content: `[${severity}] ${data.error.type}` },
                template: color,
            },
            elements: [
                {
                    tag: 'div',
                    text: { tag: 'lark_md', content: `**Message:** ${(data.error.message || '').slice(0, 200)}` },
                },
                {
                    tag: 'div',
                    fields: [
                        { is_short: true, text: { tag: 'lark_md', content: `**URL:** ${data.error.url || 'N/A'}` } },
                        { is_short: true, text: { tag: 'lark_md', content: `**Count:** ${data.issue?.count || 1}` } },
                    ],
                },
                ...(data.issue?.gitlab_url ? [{
                    tag: 'action',
                    actions: [{
                        tag: 'button',
                        text: { tag: 'plain_text', content: 'View Issue' },
                        url: data.issue.gitlab_url,
                        type: 'primary',
                    }],
                }] : []),
            ],
        },
    };
}

function formatDingTalk(data) {
    const severity = data.error.severity || 'error';
    const lines = [
        `### [${severity}] ${data.error.type}`,
        `> ${(data.error.message || '').slice(0, 200)}`,
        '',
        `- **URL:** ${data.error.url || 'N/A'}`,
        `- **Count:** ${data.issue?.count || 1}`,
        `- **First Seen:** ${data.issue?.first_seen || 'N/A'}`,
    ];
    if (data.issue?.gitlab_url) {
        lines.push(`- [View Issue](${data.issue.gitlab_url})`);
    }
    return {
        msgtype: 'markdown',
        markdown: {
            title: `[${severity}] ${data.error.type}`,
            text: lines.join('\n'),
        },
    };
}

/**
 * Deliver a webhook payload to a URL with HMAC signing.
 * @returns {Promise<{ ok: boolean, status_code?: number, error?: string }>}
 */
async function deliverWebhook(url, body, secret, allowHttp = false) {
    // SSRF protection
    const safe = await isSafeUrl(url);
    if (!safe) {
        return { ok: false, error: 'URL blocked by SSRF protection' };
    }

    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    const signature = crypto.createHmac('sha256', secret).update(bodyStr).digest('hex');

    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';

    if (!isHttps && !allowHttp) {
        return { ok: false, error: 'HTTPS required (set allow_http to enable HTTP)' };
    }

    const transport = isHttps ? https : http;

    return new Promise((resolve) => {
        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyStr),
                'User-Agent': 'ClawMark/2.0',
                'X-ClawMark-Signature': `sha256=${signature}`,
                'X-ClawMark-Event': 'perception.error',
            },
        };

        const req = transport.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve({ ok: true, status_code: res.statusCode });
                } else {
                    resolve({ ok: false, status_code: res.statusCode, error: `HTTP ${res.statusCode}: ${data.slice(0, 200)}` });
                }
            });
        });

        req.on('error', (err) => {
            resolve({ ok: false, error: err.message });
        });

        req.setTimeout(10000, () => {
            req.destroy();
            resolve({ ok: false, error: 'Request timeout (10s)' });
        });

        req.write(bodyStr);
        req.end();
    });
}

/**
 * Dispatch perception event to all matching webhooks for an app.
 * Non-blocking — errors are logged, not thrown.
 */
async function dispatchPerceptionWebhooks(db, event, issue, appId) {
    const webhooks = db.getActiveWebhooksByApp(appId);
    if (!webhooks || webhooks.length === 0) return 0;

    let dispatched = 0;

    for (const wh of webhooks) {
        // Parse event filters
        let filters;
        try { filters = JSON.parse(wh.event_filters || '{}'); } catch { filters = {}; }

        if (!filtersMatch(filters, event)) continue;

        // Check rate limit for the agent
        if (!checkRateLimit(wh.agent_id)) {
            console.log(`[webhook] Rate limited: agent ${wh.agent_id}, webhook ${wh.id}`);
            continue;
        }

        // Format payload
        const payload = formatPayload(wh.template, event, issue, { app_id: appId });

        // Create delivery record
        const delivery = db.createWebhookDelivery({
            webhook_id: wh.id,
            event_type: `perception.${(event.severity || 'error').toLowerCase()}`,
            payload,
        });

        // Deliver
        try {
            const result = await deliverWebhook(wh.url, payload, wh.secret, wh.allow_http === 1);

            if (result.ok) {
                db.updateWebhookDelivery(delivery.id, { status: 'delivered', status_code: result.status_code });
                db.resetWebhookFailures(wh.id);
                dispatched++;
            } else {
                // Schedule retry
                const nextRetry = new Date(Date.now() + RETRY_DELAYS[1]).toISOString();
                db.updateWebhookDelivery(delivery.id, {
                    status: 'pending',
                    status_code: result.status_code,
                    error: result.error,
                });
                // Update next_retry_at via raw query (simpler than adding another prepared statement)
                db.db.prepare('UPDATE webhook_deliveries SET next_retry_at = ?, attempt = 1 WHERE id = ?').run(nextRetry, delivery.id);

                const failResult = db.incrementWebhookFailures(wh.id);
                if (failResult.disabled) {
                    console.log(`[webhook] Auto-disabled webhook ${wh.id} after ${failResult.failures} consecutive failures`);
                }
            }
        } catch (err) {
            console.error(`[webhook] Dispatch error for webhook ${wh.id}:`, err.message);
            db.updateWebhookDelivery(delivery.id, { status: 'failed', error: err.message });
            db.incrementWebhookFailures(wh.id);
        }
    }

    return dispatched;
}

/**
 * Retry failed webhook deliveries.
 * Called on a 30s polling interval.
 */
async function retryFailedDeliveries(db) {
    const pending = db.getPendingWebhookRetries();
    if (!pending || pending.length === 0) return 0;

    let retried = 0;

    for (const delivery of pending) {
        if (delivery.attempt > 3) {
            db.updateWebhookDelivery(delivery.id, { status: 'failed', error: 'Max retries exceeded' });
            continue;
        }

        const wh = db.getWebhook(delivery.webhook_id);
        if (!wh || !wh.active) {
            db.updateWebhookDelivery(delivery.id, { status: 'skipped', error: 'Webhook inactive or deleted' });
            continue;
        }

        let payload;
        try { payload = JSON.parse(delivery.payload); } catch { payload = delivery.payload; }

        try {
            const result = await deliverWebhook(wh.url, payload, wh.secret, wh.allow_http === 1);

            if (result.ok) {
                db.updateWebhookDelivery(delivery.id, { status: 'delivered', status_code: result.status_code });
                db.resetWebhookFailures(wh.id);
                retried++;
            } else {
                const nextAttempt = delivery.attempt + 1;
                if (nextAttempt > 3) {
                    db.updateWebhookDelivery(delivery.id, { status: 'failed', status_code: result.status_code, error: result.error });
                } else {
                    const nextRetry = new Date(Date.now() + RETRY_DELAYS[nextAttempt]).toISOString();
                    db.db.prepare('UPDATE webhook_deliveries SET next_retry_at = ?, attempt = ? WHERE id = ?').run(nextRetry, nextAttempt, delivery.id);
                }
                db.incrementWebhookFailures(wh.id);
            }
        } catch (err) {
            console.error(`[webhook] Retry error for delivery ${delivery.id}:`, err.message);
            db.updateWebhookDelivery(delivery.id, { status: 'failed', error: err.message });
            db.incrementWebhookFailures(wh.id);
        }
    }

    return retried;
}

module.exports = {
    dispatchPerceptionWebhooks,
    retryFailedDeliveries,
    deliverWebhook,
    formatPayload,
    filtersMatch,
    checkRateLimit,
    // Exposed for testing
    _rateLimits: rateLimits,
};
