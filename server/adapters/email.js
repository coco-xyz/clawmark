/**
 * ClawMark — Email Adapter
 *
 * Sends event notifications via email using HTTP-based email APIs.
 * Supports Resend (default) and SendGrid providers.
 * Zero external dependencies — uses Node.js built-in https.
 *
 * Channel config:
 *   {
 *     adapter: "email",
 *     provider: "resend" | "sendgrid",     // default: "resend"
 *     api_key: "re_xxx..." | "SG.xxx...",
 *     from: "ClawMark <noreply@example.com>",
 *     to: ["team@example.com"],            // array of recipients
 *     subject_prefix: "[ClawMark]",        // optional, default: "[ClawMark]"
 *     template: "full" | "compact"         // optional
 *   }
 */

'use strict';

const https = require('https');

class EmailAdapter {
    constructor(config) {
        this.type = 'email';
        this.provider = config.provider || 'resend';
        this.apiKey = config.api_key;
        this.from = config.from;
        this.to = Array.isArray(config.to) ? config.to : [config.to].filter(Boolean);
        this.subjectPrefix = config.subject_prefix || '[ClawMark]';
        this.template = config.template || 'full';
    }

    validate() {
        if (!this.apiKey) return { ok: false, error: 'Missing api_key' };
        if (!this.from) return { ok: false, error: 'Missing from address' };
        if (!this.to.length) return { ok: false, error: 'Missing to address(es)' };
        if (!['resend', 'sendgrid'].includes(this.provider)) {
            return { ok: false, error: `Invalid provider "${this.provider}". Must be "resend" or "sendgrid"` };
        }
        return { ok: true };
    }

    async send(event, item, context = {}) {
        const subject = this._buildSubject(event, item);
        const html = this._buildHtml(event, item, context);

        if (this.provider === 'sendgrid') {
            return this._sendViaSendGrid(subject, html);
        }
        return this._sendViaResend(subject, html);
    }

    _buildSubject(event, item) {
        const label = this._eventLabel(event);
        const title = item.title || item.quote?.slice(0, 60) || 'New item';
        return `${this.subjectPrefix} ${label}: ${title}`;
    }

    _eventLabel(event) {
        return {
            'item.created': 'New Item',
            'item.resolved': 'Resolved',
            'item.assigned': 'Assigned',
            'item.closed': 'Closed',
            'item.reopened': 'Reopened',
        }[event] || event;
    }

    _buildHtml(event, item, context) {
        const esc = (s) => {
            if (!s) return '';
            return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        };

        const label = this._eventLabel(event);
        const priorityColor = {
            critical: '#ef4444',
            high: '#f97316',
            normal: '#3b82f6',
            low: '#9ca3af',
        }[item.priority] || '#3b82f6';

        const tags = typeof item.tags === 'string' ? JSON.parse(item.tags || '[]') : (item.tags || []);
        const content = item.quote || item.messages?.[0]?.content || item.message || '';
        const truncated = content.length > 1000 ? content.slice(0, 1000) + '...' : content;

        const lines = [];
        lines.push('<!DOCTYPE html><html><head><meta charset="utf-8"></head>');
        lines.push('<body style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333;">');

        // Header bar
        lines.push(`<div style="background:${priorityColor};color:#fff;padding:12px 16px;border-radius:8px 8px 0 0;font-size:14px;font-weight:600;">`);
        lines.push(`[ClawMark] ${esc(label)}</div>`);

        // Body card
        lines.push('<div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;padding:16px;">');

        if (item.title) {
            lines.push(`<h2 style="margin:0 0 8px;font-size:18px;color:#111;">${esc(item.title)}</h2>`);
        }

        // Metadata
        const meta = [];
        if (item.type) meta.push(`<strong>Type:</strong> ${esc(item.type)}`);
        meta.push(`<strong>Priority:</strong> <span style="color:${priorityColor}">${esc(item.priority || 'normal')}</span>`);
        if (item.created_by) meta.push(`<strong>Reporter:</strong> ${esc(item.created_by)}`);
        if (item.assignee) meta.push(`<strong>Assignee:</strong> ${esc(item.assignee)}`);
        lines.push(`<p style="font-size:13px;color:#666;margin:0 0 12px;">${meta.join(' &middot; ')}</p>`);

        // Content
        if (truncated) {
            lines.push(`<blockquote style="margin:0 0 12px;padding:8px 12px;background:#f9fafb;border-left:3px solid ${priorityColor};color:#555;font-size:14px;">`);
            lines.push(`${esc(truncated).replace(/\n/g, '<br>')}</blockquote>`);
        }

        // Tags
        if (tags.length > 0) {
            const tagHtml = tags.map(t =>
                `<span style="display:inline-block;padding:2px 8px;background:#e0e7ff;color:#4338ca;border-radius:4px;font-size:12px;margin-right:4px;">${esc(t)}</span>`
            ).join('');
            lines.push(`<p style="margin:0 0 12px;">${tagHtml}</p>`);
        }

        // Source link
        if (item.source_url) {
            lines.push(`<p style="margin:0 0 8px;font-size:13px;"><a href="${esc(item.source_url)}" style="color:#3b82f6;">${esc(item.source_title || item.source_url)}</a></p>`);
        }

        // Screenshots
        const screenshots = typeof item.screenshots === 'string'
            ? JSON.parse(item.screenshots || '[]') : (item.screenshots || []);
        if (screenshots.length > 0) {
            lines.push('<div style="margin:12px 0;">');
            for (const url of screenshots) {
                lines.push(`<img src="${esc(url)}" alt="screenshot" style="max-width:100%;border-radius:4px;margin-bottom:8px;">`);
            }
            lines.push('</div>');
        }

        lines.push('</div>');

        // Footer
        lines.push('<p style="font-size:11px;color:#9ca3af;margin:12px 0 0;text-align:center;">Sent by ClawMark</p>');
        lines.push('</body></html>');

        return lines.join('\n');
    }

    _sendViaResend(subject, html) {
        const body = JSON.stringify({
            from: this.from,
            to: this.to,
            subject,
            html,
        });

        return this._httpsPost('api.resend.com', '/emails', body, {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
        });
    }

    _sendViaSendGrid(subject, html) {
        const body = JSON.stringify({
            personalizations: [{ to: this.to.map(email => ({ email })) }],
            from: { email: this.from.replace(/^.*<(.+)>$/, '$1') || this.from },
            subject,
            content: [{ type: 'text/html', value: html }],
        });

        return this._httpsPost('api.sendgrid.com', '/v3/mail/send', body, {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
        });
    }

    _httpsPost(hostname, path, body, headers) {
        return new Promise((resolve, reject) => {
            const options = {
                hostname,
                port: 443,
                path,
                method: 'POST',
                headers: {
                    ...headers,
                    'Content-Length': Buffer.byteLength(body),
                },
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve({ status: 'ok', statusCode: res.statusCode });
                    } else {
                        reject(new Error(`Email API error ${res.statusCode}: ${data.slice(0, 300)}`));
                    }
                });
            });
            req.on('error', reject);
            req.setTimeout(15000, () => {
                req.destroy(new Error('Email API request timeout'));
            });
            req.write(body);
            req.end();
        });
    }
}

module.exports = { EmailAdapter };
