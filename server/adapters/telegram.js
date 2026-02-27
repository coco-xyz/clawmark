/**
 * ClawMark — Telegram Adapter
 *
 * Sends event notifications to Telegram chats via Bot API.
 *
 * Channel config:
 *   {
 *     adapter: "telegram",
 *     bot_token: "123456:ABC-DEF...",
 *     chat_id: "-100123456789" | "123456789",
 *     template: "full" | "compact" | "default",
 *     parse_mode: "MarkdownV2" | "HTML" (default: "MarkdownV2")
 *   }
 */

'use strict';

const https = require('https');

class TelegramAdapter {
    constructor(config) {
        this.type = 'telegram';
        this.botToken = config.bot_token;
        this.chatId = config.chat_id;
        this.template = config.template || 'default';
        this.parseMode = config.parse_mode || 'MarkdownV2';
    }

    validate() {
        if (!this.botToken) return { ok: false, error: 'Missing bot_token' };
        if (!this.chatId) return { ok: false, error: 'Missing chat_id' };
        if (!/^\d+:[A-Za-z0-9_-]+$/.test(this.botToken)) {
            return { ok: false, error: 'Invalid bot_token format' };
        }
        return { ok: true };
    }

    async send(event, item, context = {}) {
        const text = this._formatMessage(event, item, context);
        return this._sendMessage(text);
    }

    _formatMessage(event, item, context) {
        const eventLabel = {
            'item.created': 'New Item',
            'item.resolved': 'Resolved',
            'item.assigned': 'Assigned',
            'item.closed': 'Closed',
            'discussion.created': 'New Discussion',
            'discussion.message': 'New Message',
        }[event] || event;

        const priorityIcon = {
            critical: '\u{1F534}',
            high: '\u{1F7E0}',
            normal: '\u{1F535}',
            low: '\u{26AA}',
        }[item.priority] || '\u{1F535}';

        const typeLabel = item.type === 'issue' ? 'Issue' : item.type === 'comment' ? 'Comment' : 'Discussion';

        // MarkdownV2 requires escaping special characters
        const esc = (s) => {
            if (!s) return '';
            return String(s).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
        };

        if (this.parseMode === 'HTML') {
            return this._formatHtml(eventLabel, priorityIcon, typeLabel, item);
        }

        // MarkdownV2 format (default)
        const lines = [];
        lines.push(`*\\[ClawMark\\] ${esc(eventLabel)}*`);
        lines.push('');

        if (item.title) {
            lines.push(`*${esc(typeLabel)}*: ${esc(item.title)}`);
        }

        const content = item.quote || item.messages?.[0]?.content || item.message || '';
        if (content) {
            const truncated = content.length > 300 ? content.slice(0, 300) + '...' : content;
            lines.push(`>${esc(truncated)}`);
        }

        lines.push('');
        lines.push(`${priorityIcon} ${esc(item.priority || 'normal')}`);

        if (item.created_by) {
            lines.push(`By: ${esc(item.created_by)}`);
        }

        if (item.source_url) {
            lines.push(`[Source](${esc(item.source_url)})`);
        }

        const tags = typeof item.tags === 'string' ? JSON.parse(item.tags || '[]') : (item.tags || []);
        if (tags.length > 0) {
            lines.push(`Tags: ${tags.map(t => esc(t)).join(', ')}`);
        }

        if (item.assignee && event === 'item.assigned') {
            lines.push(`Assigned to: ${esc(item.assignee)}`);
        }

        return lines.join('\n');
    }

    _formatHtml(eventLabel, priorityIcon, typeLabel, item) {
        const esc = (s) => {
            if (!s) return '';
            return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        };

        const lines = [];
        lines.push(`<b>[ClawMark] ${esc(eventLabel)}</b>`);
        lines.push('');

        if (item.title) {
            lines.push(`<b>${esc(typeLabel)}</b>: ${esc(item.title)}`);
        }

        const content = item.quote || item.messages?.[0]?.content || item.message || '';
        if (content) {
            const truncated = content.length > 300 ? content.slice(0, 300) + '...' : content;
            lines.push(`<blockquote>${esc(truncated)}</blockquote>`);
        }

        lines.push(`${priorityIcon} ${esc(item.priority || 'normal')}`);

        if (item.created_by) {
            lines.push(`By: ${esc(item.created_by)}`);
        }

        if (item.source_url) {
            lines.push(`<a href="${esc(item.source_url)}">Source</a>`);
        }

        return lines.join('\n');
    }

    _sendMessage(text) {
        const body = JSON.stringify({
            chat_id: this.chatId,
            text,
            parse_mode: this.parseMode,
            disable_web_page_preview: true,
        });

        return new Promise((resolve, reject) => {
            const options = {
                hostname: 'api.telegram.org',
                port: 443,
                path: `/bot${this.botToken}/sendMessage`,
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
                        const parsed = JSON.parse(data);
                        if (parsed.ok) {
                            resolve({ status: 'ok', message_id: parsed.result?.message_id });
                        } else {
                            reject(new Error(`Telegram API error: ${parsed.description || data.slice(0, 200)}`));
                        }
                    } catch {
                        reject(new Error(`Telegram response parse error: ${data.slice(0, 200)}`));
                    }
                });
            });
            req.on('error', reject);
            req.setTimeout(10000, () => {
                req.destroy(new Error('Telegram request timeout'));
            });
            req.write(body);
            req.end();
        });
    }
}

module.exports = { TelegramAdapter };
