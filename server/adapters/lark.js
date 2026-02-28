/**
 * ClawMark — Lark (Feishu) Adapter
 *
 * 通过 Lark 机器人 Webhook 发送消息到群组。
 *
 * Channel config:
 *   {
 *     adapter: "lark",
 *     webhook_url: "https://open.larksuite.com/open-apis/bot/v2/hook/xxx",
 *     template: "issue" | "comment" | "default",
 *     secret: "optional signing secret"
 *   }
 */

'use strict';

const https = require('https');

class LarkAdapter {
    constructor(config) {
        this.type = 'lark';
        this.webhookUrl = config.webhook_url;
        this.template = config.template || 'default';
        this.secret = config.secret || '';
    }

    validate() {
        if (!this.webhookUrl) return { ok: false, error: 'Missing webhook_url' };
        try {
            const u = new URL(this.webhookUrl);
            if (!u.hostname.includes('larksuite.com') && !u.hostname.includes('feishu.cn')) {
                return { ok: false, error: 'webhook_url must be a Lark/Feishu URL' };
            }
            return { ok: true };
        } catch {
            return { ok: false, error: `Invalid webhook_url: ${this.webhookUrl}` };
        }
    }

    async send(event, item, context = {}) {
        const card = this._buildCard(event, item, context);
        const body = JSON.stringify(card);

        return new Promise((resolve, reject) => {
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
                    try {
                        const result = JSON.parse(data);
                        if (result.code === 0 || result.StatusCode === 0) {
                            resolve({ status: 'ok' });
                        } else {
                            reject(new Error(`Lark API error: ${data.slice(0, 200)}`));
                        }
                    } catch {
                        reject(new Error(`Lark response parse error: ${data.slice(0, 200)}`));
                    }
                });
            });
            req.on('error', reject);
            req.setTimeout(10000, () => {
                req.destroy(new Error('Lark request timeout'));
            });
            req.write(body);
            req.end();
        });
    }

    _buildCard(event, item, context) {
        const eventLabel = {
            'item.created': '新条目',
            'item.resolved': '已解决',
            'item.assigned': '已分配',
            'item.closed': '已关闭',
        }[event] || event;

        const priorityEmoji = {
            critical: '🔴',
            high: '🟠',
            normal: '🔵',
            low: '⚪',
        }[item.priority] || '🔵';

        const typeLabel = item.type === 'issue' ? 'Issue' : 'Comment';

        // Build Lark interactive card
        const elements = [];

        // Title line
        if (item.title) {
            elements.push({
                tag: 'div',
                text: { tag: 'lark_md', content: `**${typeLabel}**: ${item.title}` },
            });
        }

        // Content / quote
        const content = item.quote || item.messages?.[0]?.content || '';
        if (content) {
            elements.push({
                tag: 'div',
                text: { tag: 'lark_md', content: content.slice(0, 500) },
            });
        }

        // Metadata line
        const meta = [
            `${priorityEmoji} ${item.priority || 'normal'}`,
            item.created_by ? `提交人: ${item.created_by}` : '',
            item.source_url ? `来源: ${item.source_url}` : '',
        ].filter(Boolean).join(' | ');

        elements.push({
            tag: 'div',
            text: { tag: 'lark_md', content: meta },
        });

        // Tags
        const tags = typeof item.tags === 'string' ? JSON.parse(item.tags || '[]') : (item.tags || []);
        if (tags.length > 0) {
            elements.push({
                tag: 'div',
                text: { tag: 'lark_md', content: `标签: ${tags.join(', ')}` },
            });
        }

        return {
            msg_type: 'interactive',
            card: {
                header: {
                    title: { tag: 'plain_text', content: `[ClawMark] ${eventLabel} — ${typeLabel}` },
                    template: item.priority === 'critical' ? 'red' : item.priority === 'high' ? 'orange' : 'blue',
                },
                elements,
            },
        };
    }
}

module.exports = { LarkAdapter };
