/**
 * ClawMark — Webhook Adapter
 *
 * 通用 webhook 分发：将事件 POST 到配置的 URL。
 * 升级自原有的 sendWebhook 函数，现在是标准 adapter 接口。
 *
 * Channel config:
 *   { adapter: "webhook", url: "https://...", secret: "optional", events: ["item.created"] }
 */

'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');

class WebhookAdapter {
    constructor(config) {
        this.type = 'webhook';
        this.url = config.url;
        this.secret = config.secret || '';
        this.events = config.events || null; // null = all events
        this.template = config.template || null;
    }

    validate() {
        if (!this.url) return { ok: false, error: 'Missing url' };
        try {
            new URL(this.url);
            return { ok: true };
        } catch {
            return { ok: false, error: `Invalid url: ${this.url}` };
        }
    }

    async send(event, item, context = {}) {
        // Event filter
        if (this.events && this.events.length && !this.events.includes(event)) return;

        const body = JSON.stringify({
            event,
            payload: item,
            context,
            timestamp: new Date().toISOString(),
        });

        return new Promise((resolve, reject) => {
            try {
                const parsed = new URL(this.url);
                const isHttps = parsed.protocol === 'https:';
                const options = {
                    hostname: parsed.hostname,
                    port: parsed.port || (isHttps ? 443 : 80),
                    path: parsed.pathname + parsed.search,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(body),
                        'User-Agent': 'ClawMark/2.0',
                        ...(this.secret ? {
                            'X-ClawMark-Signature': 'sha256=' + crypto.createHmac('sha256', this.secret).update(body).digest('hex'),
                        } : {}),
                    },
                };

                const req = (isHttps ? https : http).request(options, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            resolve({ status: res.statusCode });
                        } else {
                            reject(new Error(`Webhook returned ${res.statusCode}: ${data.slice(0, 200)}`));
                        }
                    });
                });
                req.on('error', reject);
                req.setTimeout(10000, () => {
                    req.destroy(new Error('Webhook request timeout'));
                });
                req.write(body);
                req.end();
            } catch (err) {
                reject(err);
            }
        });
    }
}

module.exports = { WebhookAdapter };
