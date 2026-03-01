/**
 * ClawMark — Slack Adapter
 *
 * Sends event notifications to Slack channels via Incoming Webhook.
 * Uses Block Kit for rich formatting.
 *
 * Channel config:
 *   {
 *     adapter: "slack",
 *     webhook_url: "https://hooks.slack.com/services/T.../B.../xxx",
 *     channel: "#channel-name",          // optional: override channel
 *     username: "ClawMark",              // optional: bot username
 *     icon_emoji: ":bookmark:",          // optional: bot icon
 *     thread_ts: "1234567890.123456",    // optional: reply to thread
 *     template: "full" | "compact"       // optional: message template
 *   }
 */

'use strict';

const https = require('https');

/** Return url only if it uses http(s) protocol; empty string otherwise. */
function safeUrl(url) {
    if (!url) return '';
    try {
        const u = new URL(String(url));
        return (u.protocol === 'http:' || u.protocol === 'https:') ? url : '';
    } catch {
        return '';
    }
}

class SlackAdapter {
    constructor(config) {
        this.type = 'slack';
        this.webhookUrl = config.webhook_url;
        this.channel = config.channel || null;
        this.username = config.username || 'ClawMark';
        this.iconEmoji = config.icon_emoji || ':bookmark:';
        this.threadTs = config.thread_ts || null;
        this.template = config.template || 'full';
    }

    validate() {
        if (!this.webhookUrl) return { ok: false, error: 'Missing webhook_url' };
        try {
            const u = new URL(this.webhookUrl);
            if (!u.hostname.endsWith('slack.com')) {
                return { ok: false, error: 'webhook_url must be a Slack URL (*.slack.com)' };
            }
            return { ok: true };
        } catch {
            return { ok: false, error: `Invalid webhook_url: ${this.webhookUrl}` };
        }
    }

    async send(event, item, context = {}) {
        const payload = this._buildPayload(event, item, context);
        return this._post(payload);
    }

    _buildPayload(event, item, context) {
        const blocks = this.template === 'compact'
            ? this._buildCompactBlocks(event, item, context)
            : this._buildFullBlocks(event, item, context);

        const payload = {
            blocks,
            text: this._fallbackText(event, item), // fallback for notifications
        };

        if (this.channel) payload.channel = this.channel;
        if (this.username) payload.username = this.username;
        if (this.iconEmoji) payload.icon_emoji = this.iconEmoji;
        if (this.threadTs) payload.thread_ts = this.threadTs;

        return payload;
    }

    _fallbackText(event, item) {
        const label = this._eventLabel(event);
        return `[ClawMark] ${label}: ${item.title || item.quote || 'New item'}`;
    }

    _eventLabel(event) {
        return {
            'item.created': 'New Item',
            'item.resolved': 'Resolved',
            'item.assigned': 'Assigned',
            'item.closed': 'Closed',
            'item.reopened': 'Reopened',
            'discussion.created': 'New Discussion',
            'discussion.message': 'New Message',
        }[event] || event;
    }

    _priorityEmoji(priority) {
        return {
            critical: ':red_circle:',
            high: ':large_orange_circle:',
            normal: ':large_blue_circle:',
            low: ':white_circle:',
        }[priority] || ':large_blue_circle:';
    }

    _buildFullBlocks(event, item, context) {
        const blocks = [];
        const label = this._eventLabel(event);
        const emoji = this._priorityEmoji(item.priority);

        // Header
        blocks.push({
            type: 'header',
            text: { type: 'plain_text', text: `[ClawMark] ${label}`, emoji: true },
        });

        // Title + type
        const fields = [];
        if (item.title) {
            fields.push({ type: 'mrkdwn', text: `*Title:*\n${this._esc(item.title)}` });
        }
        if (item.type) {
            fields.push({ type: 'mrkdwn', text: `*Type:*\n${this._esc(item.type)}` });
        }
        fields.push({ type: 'mrkdwn', text: `*Priority:*\n${emoji} ${this._esc(item.priority || 'normal')}` });
        if (item.created_by) {
            fields.push({ type: 'mrkdwn', text: `*Reporter:*\n${this._esc(item.created_by)}` });
        }

        if (fields.length > 0) {
            blocks.push({ type: 'section', fields });
        }

        // Content / quote
        const content = item.quote || item.messages?.[0]?.content || item.message || '';
        if (content) {
            const truncated = content.length > 500 ? content.slice(0, 500) + '...' : content;
            blocks.push({
                type: 'section',
                text: { type: 'mrkdwn', text: `> ${this._esc(truncated).replace(/\n/g, '\n> ')}` },
            });
        }

        // Tags (backtick-wrapped; tags containing backticks may break inline code formatting,
        // but this is a cosmetic edge case — Slack mrkdwn only requires &<> escaping)
        const tags = typeof item.tags === 'string' ? JSON.parse(item.tags || '[]') : (item.tags || []);
        if (tags.length > 0) {
            blocks.push({
                type: 'context',
                elements: [{ type: 'mrkdwn', text: `:label: ${tags.map(t => `\`${this._esc(t).replace(/`/g, "'")}\``).join(' ')}` }],
            });
        }

        // Source link (http/https only, URL escaped for mrkdwn)
        const safeSource = safeUrl(item.source_url);
        if (safeSource) {
            blocks.push({
                type: 'context',
                elements: [{ type: 'mrkdwn', text: `:link: <${this._esc(safeSource)}|${this._esc(item.source_title || 'Source')}>` }],
            });
        }

        // Assignee (for assigned events)
        if (item.assignee && event === 'item.assigned') {
            blocks.push({
                type: 'context',
                elements: [{ type: 'mrkdwn', text: `:bust_in_silhouette: Assigned to *${this._esc(item.assignee)}*` }],
            });
        }

        return blocks;
    }

    _buildCompactBlocks(event, item, context) {
        const label = this._eventLabel(event);
        const emoji = this._priorityEmoji(item.priority);
        const title = item.title || item.quote?.slice(0, 80) || 'New item';

        const text = `*[ClawMark] ${label}*  ${emoji}\n${this._esc(title)}`;

        const blocks = [
            { type: 'section', text: { type: 'mrkdwn', text } },
        ];

        const safeCompactSource = safeUrl(item.source_url);
        if (safeCompactSource) {
            blocks.push({
                type: 'context',
                elements: [{ type: 'mrkdwn', text: `<${this._esc(safeCompactSource)}|View source>` }],
            });
        }

        return blocks;
    }

    /** Escape Slack mrkdwn special chars */
    _esc(s) {
        if (!s) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    _post(payload) {
        const body = JSON.stringify(payload);

        return new Promise((resolve, reject) => {
            try {
                const parsed = new URL(this.webhookUrl);
                const options = {
                    hostname: parsed.hostname,
                    port: 443,
                    path: parsed.pathname + parsed.search,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(body),
                    },
                };

                const req = https.request(options, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            resolve({ status: 'ok' });
                        } else {
                            reject(new Error(`Slack webhook error ${res.statusCode}: ${data.slice(0, 200)}`));
                        }
                    });
                });
                req.on('error', reject);
                req.setTimeout(10000, () => {
                    req.destroy(new Error('Slack request timeout'));
                });
                req.write(body);
                req.end();
            } catch (err) {
                reject(err);
            }
        });
    }
}

module.exports = { SlackAdapter };
