/**
 * ClawMark — HxA Connect Adapter
 *
 * Sends ClawMark events to an HxA Connect hub as notifications.
 * Uses HTTP POST to the hub's message endpoint.
 *
 * Channel config:
 *   {
 *     adapter: "hxa-connect",
 *     hub_url: "https://jessie.coco.site/hub",
 *     agent_id: "uuid-of-target-agent",
 *     api_key: "optional-auth-key",
 *     thread_id: "optional-thread-id"
 *   }
 *
 * Events handled:
 *   - item.created    → sends notification to hub
 *   - item.resolved   → sends resolution notification
 *   - item.closed     → sends close notification
 *   - item.assigned   → sends assignment notification
 */

'use strict';

const http = require('http');
const https = require('https');

class HxaConnectAdapter {
    constructor(config) {
        this.type = 'hxa-connect';
        this.hubUrl = config.hub_url;
        this.agentId = config.agent_id;
        this.apiKey = config.api_key || '';
        this.threadId = config.thread_id || null;
    }

    validate() {
        if (!this.hubUrl) return { ok: false, error: 'Missing hub_url' };
        if (!this.agentId) return { ok: false, error: 'Missing agent_id' };
        try {
            const u = new URL(this.hubUrl);
            if (u.protocol !== 'https:' && u.protocol !== 'http:') {
                return { ok: false, error: 'hub_url must use http or https' };
            }
            return { ok: true };
        } catch {
            return { ok: false, error: `Invalid hub_url: ${this.hubUrl}` };
        }
    }

    async send(event, item, context = {}) {
        const message = this._buildMessage(event, item, context);
        return this._post(message);
    }

    _buildMessage(event, item, context) {
        const eventLabel = {
            'item.created': 'New Item',
            'item.resolved': 'Resolved',
            'item.closed': 'Closed',
            'item.assigned': 'Assigned',
        }[event] || event;

        const title = item.title || item.quote?.slice(0, 80) || item.message?.slice(0, 80) || 'ClawMark notification';
        const content = item.quote || item.messages?.[0]?.content || item.message || '';

        const lines = [`[ClawMark] ${eventLabel}: ${title}`];

        if (item.priority && item.priority !== 'normal') {
            lines.push(`Priority: ${item.priority}`);
        }
        if (item.type) lines.push(`Type: ${item.type}`);
        if (item.created_by) lines.push(`By: ${item.created_by}`);
        if (item.assignee) lines.push(`Assignee: ${item.assignee}`);
        if (item.source_url) lines.push(`Source: ${item.source_url}`);
        if (content && content !== title) lines.push(`\n${content.slice(0, 500)}`);

        const tags = typeof item.tags === 'string' ? JSON.parse(item.tags || '[]') : (item.tags || []);
        if (tags.length > 0) lines.push(`Tags: ${tags.join(', ')}`);

        return {
            target: this.agentId,
            thread: this.threadId || `clawmark-${item.id || 'notify'}`,
            content: lines.join('\n'),
            metadata: {
                source: 'clawmark',
                event,
                item_id: item.id || null,
                priority: item.priority || 'normal',
            },
        };
    }

    _post(message) {
        const body = JSON.stringify(message);

        return new Promise((resolve, reject) => {
            try {
                const parsed = new URL(this.hubUrl);
                const isHttps = parsed.protocol === 'https:';
                const path = parsed.pathname.replace(/\/$/, '') + '/message';
                const options = {
                    hostname: parsed.hostname,
                    port: parsed.port || (isHttps ? 443 : 80),
                    path: path + parsed.search,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(body),
                        'User-Agent': 'ClawMark/2.0',
                        ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {}),
                    },
                };

                const req = (isHttps ? https : http).request(options, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            resolve({ status: 'ok', statusCode: res.statusCode });
                        } else {
                            reject(new Error(`HxA Connect returned ${res.statusCode}: ${data.slice(0, 200)}`));
                        }
                    });
                });
                req.on('error', reject);
                req.setTimeout(10000, () => {
                    req.destroy(new Error('HxA Connect request timeout'));
                });
                req.write(body);
                req.end();
            } catch (err) {
                reject(err);
            }
        });
    }
}

module.exports = { HxaConnectAdapter };
