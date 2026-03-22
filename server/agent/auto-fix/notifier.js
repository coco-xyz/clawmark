/**
 * ClawMark — Auto-Fix Notifier (#86)
 *
 * Posts notifications to team channels (webhook, Lark, Slack)
 * with PR link and error summary after an auto-fix is submitted.
 */

'use strict';

const https = require('https');
const http = require('http');

const NOTIFY_TIMEOUT = 10000; // 10s

/**
 * Format a notification payload for the auto-fix result.
 *
 * @param {object} params
 * @param {object} params.errorEvent - The perception event
 * @param {object} params.fixResult - Fix generator result
 * @param {object} params.mr - Merge request { iid, url }
 * @param {object} [params.issue] - Perception issue record
 * @param {string} [params.template] - Notification template: 'default', 'slack', 'lark'
 * @returns {object} Formatted payload
 */
function formatNotification(params) {
    const { errorEvent, fixResult, mr, issue, template = 'default' } = params;

    const severity = errorEvent.severity || 'error';
    const message = (errorEvent.message || 'Unknown error').slice(0, 100);
    const typeLabel = errorEvent.type || 'error';
    const confidence = fixResult.confidence != null ? `${(fixResult.confidence * 100).toFixed(0)}%` : 'N/A';
    const isDraft = fixResult.isDraft ? ' (Draft)' : '';

    switch (template) {
        case 'slack':
            return formatSlack({ severity, message, typeLabel, confidence, isDraft, mr, issue, fixResult });
        case 'lark':
            return formatLark({ severity, message, typeLabel, confidence, isDraft, mr, issue, fixResult });
        default:
            return formatDefault({ severity, message, typeLabel, confidence, isDraft, mr, issue, fixResult, errorEvent });
    }
}

function formatDefault({ severity, message, typeLabel, confidence, isDraft, mr, issue, fixResult, errorEvent }) {
    return {
        event_type: 'autofix.submitted',
        error: {
            type: typeLabel,
            message: (errorEvent.message || '').slice(0, 200),
            severity,
            url: errorEvent.url || null,
            fingerprint: errorEvent.fingerprint || null,
        },
        fix: {
            confidence: fixResult.confidence,
            is_draft: fixResult.isDraft || false,
            analysis: (fixResult.analysis || '').slice(0, 300),
            description: fixResult.fix?.description || '',
            files_changed: fixResult.fix?.files?.length || 0,
        },
        merge_request: {
            iid: mr.iid,
            url: mr.url,
        },
        issue: issue ? {
            id: issue.gitlab_issue_id,
            url: issue.gitlab_issue_url,
            count: issue.count,
        } : null,
        timestamp: new Date().toISOString(),
    };
}

function formatSlack({ severity, message, typeLabel, confidence, isDraft, mr, issue, fixResult }) {
    const color = severity === 'critical' ? '#dc3545' : severity === 'error' ? '#fd7e14' : '#ffc107';
    return {
        attachments: [{
            color,
            title: `[AutoFix${isDraft}] ${typeLabel}: ${message}`,
            title_link: mr.url,
            fields: [
                { title: 'Confidence', value: confidence, short: true },
                { title: 'MR', value: `!${mr.iid}`, short: true },
                { title: 'Occurrences', value: String(issue?.count || 'N/A'), short: true },
                { title: 'Files Changed', value: String(fixResult.fix?.files?.length || 0), short: true },
            ],
            text: (fixResult.analysis || '').slice(0, 200),
            ts: Math.floor(Date.now() / 1000),
        }],
    };
}

function formatLark({ severity, message, typeLabel, confidence, isDraft, mr, issue, fixResult }) {
    const color = severity === 'critical' ? 'red' : severity === 'error' ? 'orange' : 'yellow';
    return {
        msg_type: 'interactive',
        card: {
            header: {
                title: { tag: 'plain_text', content: `[AutoFix${isDraft}] ${typeLabel}: ${message}` },
                template: color,
            },
            elements: [
                {
                    tag: 'div',
                    text: { tag: 'lark_md', content: (fixResult.analysis || '').slice(0, 300) },
                },
                {
                    tag: 'div',
                    fields: [
                        { is_short: true, text: { tag: 'lark_md', content: `**Confidence:** ${confidence}` } },
                        { is_short: true, text: { tag: 'lark_md', content: `**MR:** !${mr.iid}` } },
                        { is_short: true, text: { tag: 'lark_md', content: `**Occurrences:** ${issue?.count || 'N/A'}` } },
                        { is_short: true, text: { tag: 'lark_md', content: `**Files:** ${fixResult.fix?.files?.length || 0}` } },
                    ],
                },
                {
                    tag: 'action',
                    actions: [{
                        tag: 'button',
                        text: { tag: 'plain_text', content: 'View Merge Request' },
                        url: mr.url,
                        type: 'primary',
                    }],
                },
            ],
        },
    };
}

/**
 * Send notification to a webhook URL.
 *
 * @param {string} url - Webhook URL
 * @param {object} payload - Notification payload
 * @param {object} [opts]
 * @param {boolean} [opts.allowHttp=false]
 * @returns {Promise<{ ok: boolean, status_code?: number, error?: string }>}
 */
async function sendNotification(url, payload, opts = {}) {
    let parsed;
    try { parsed = new URL(url); } catch { return { ok: false, error: 'Invalid URL' }; }

    const isHttps = parsed.protocol === 'https:';
    if (!isHttps && !opts.allowHttp) {
        return { ok: false, error: 'HTTPS required' };
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return { ok: false, error: 'Only HTTP(S) protocols allowed' };
    }

    const transport = isHttps ? https : http;
    const bodyStr = JSON.stringify(payload);

    return new Promise((resolve) => {
        const reqOpts = {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyStr),
                'User-Agent': 'ClawMark-AutoFix/1.0',
            },
        };

        const req = transport.request(reqOpts, (res) => {
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

        req.on('error', (err) => resolve({ ok: false, error: err.message }));
        req.setTimeout(NOTIFY_TIMEOUT, () => {
            req.destroy();
            resolve({ ok: false, error: 'Request timeout' });
        });

        req.write(bodyStr);
        req.end();
    });
}

/**
 * Notify all configured channels about an auto-fix.
 *
 * @param {object} params
 * @param {object} params.errorEvent
 * @param {object} params.fixResult
 * @param {object} params.mr - { iid, url }
 * @param {object} [params.issue]
 * @param {Array<{ url: string, template?: string, allowHttp?: boolean }>} params.channels
 * @returns {Promise<{ sent: number, failed: number }>}
 */
async function notifyAll(params) {
    const { errorEvent, fixResult, mr, issue, channels = [] } = params;

    let sent = 0;
    let failed = 0;

    for (const channel of channels) {
        const payload = formatNotification({
            errorEvent, fixResult, mr, issue,
            template: channel.template || 'default',
        });

        const result = await sendNotification(channel.url, payload, {
            allowHttp: channel.allowHttp || false,
        });

        if (result.ok) {
            sent++;
        } else {
            console.error(`[auto-fix-notifier] Failed to notify ${channel.url}: ${result.error}`);
            failed++;
        }
    }

    return { sent, failed };
}

module.exports = {
    formatNotification,
    sendNotification,
    notifyAll,
};
