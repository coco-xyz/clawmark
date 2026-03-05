/**
 * ClawMark — GitLab Issue Adapter
 *
 * Creates GitLab Issues from ClawMark events, and syncs status
 * (resolve → close, reopen → reopen).
 *
 * Channel config:
 *   {
 *     adapter: "gitlab-issue",
 *     token: "glpat-...",
 *     project_id: "hxanet/clawmark" or "123",
 *     base_url: "https://git.coco.xyz",   // optional, defaults to https://gitlab.com
 *     labels: ["clawmark", "bug"],         // optional: default labels
 *     assignees: [42],                     // optional: default assignee user IDs
 *   }
 *
 * Events handled:
 *   - item.created   → creates a new GitLab Issue
 *   - item.resolved  → closes the linked GitLab Issue
 *   - item.closed    → closes the linked GitLab Issue
 *   - item.assigned  → adds assignee to the linked GitLab Issue (if mapping exists)
 */

'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

class GitLabIssueAdapter {
    constructor(config) {
        this.type = 'gitlab-issue';
        this.token = config.token;
        this.projectId = config.project_id; // "namespace/project" or numeric ID
        this.baseUrl = (config.base_url || 'https://gitlab.com').replace(/\/+$/, '');
        this.labels = config.labels || ['clawmark'];
        this.assignees = config.assignees || [];
        this.channelName = config.channelName || '';
        this.db = config.db || null;
        this._memoryMap = new Map();
    }

    validate() {
        if (!this.token) return { ok: false, error: 'Missing token' };
        if (!this.projectId) return { ok: false, error: 'Missing project_id' };
        return { ok: true };
    }

    _setMapping(itemId, issueIid, issueUrl) {
        if (this.db) {
            this.db.setAdapterMapping({
                item_id: itemId,
                adapter: 'gitlab-issue',
                channel: this.channelName,
                external_id: String(issueIid),
                external_url: issueUrl || null,
            });
        } else {
            this._memoryMap.set(itemId, issueIid);
        }
    }

    _getMapping(itemId) {
        if (this.db) {
            const row = this.db.getAdapterMapping({
                item_id: itemId,
                adapter: 'gitlab-issue',
                channel: this.channelName,
            });
            return row ? Number(row.external_id) : null;
        }
        return this._memoryMap.get(itemId) || null;
    }

    async send(event, item, context = {}) {
        switch (event) {
            case 'item.created':
                return this._createIssue(item, context);
            case 'item.resolved':
            case 'item.closed':
                return this._closeIssue(item, context);
            case 'item.assigned':
                return this._updateAssignee(item, context);
            default:
                return;
        }
    }

    async _createIssue(item, context) {
        const title = this._buildTitle(item);
        const description = this._buildBody(item, context);

        const labels = [...this.labels];
        if (item.priority && item.priority !== 'normal') {
            labels.push(`priority::${item.priority}`);
        }
        if (item.type) labels.push(`type::${item.type}`);

        const tags = typeof item.tags === 'string' ? JSON.parse(item.tags || '[]') : (item.tags || []);
        for (const tag of tags) {
            const sanitized = String(tag).replace(/[\x00-\x1f]/g, '').trim().slice(0, 50);
            if (sanitized) labels.push(sanitized);
        }

        const data = {
            title,
            description,
            labels: labels.join(','),
        };

        if (this.assignees.length > 0) {
            data.assignee_ids = this.assignees;
        }

        const encodedProject = encodeURIComponent(this.projectId);
        const result = await this._apiRequest('POST', `/api/v4/projects/${encodedProject}/issues`, data);

        const itemId = item.id || item.item?.id;
        if (itemId && result.iid) {
            this._setMapping(itemId, result.iid, result.web_url);
        }

        return { status: 'created', issue_iid: result.iid, url: result.web_url };
    }

    async _closeIssue(item, context) {
        const itemId = item.id || item.item?.id;
        const issueIid = this._getMapping(itemId);

        if (!issueIid) {
            console.log(`[gitlab-issue] No tracked issue for item ${itemId}, skipping close`);
            return;
        }

        const encodedProject = encodeURIComponent(this.projectId);
        await this._apiRequest('PUT', `/api/v4/projects/${encodedProject}/issues/${issueIid}`, {
            state_event: 'close',
        });

        return { status: 'closed', issue_iid: issueIid };
    }

    async _updateAssignee(item, context) {
        const itemId = item.id || item.item?.id;
        const issueIid = this._getMapping(itemId);

        if (!issueIid || !item.assignee) return;

        const encodedProject = encodeURIComponent(this.projectId);
        await this._apiRequest('PUT', `/api/v4/projects/${encodedProject}/issues/${issueIid}`, {
            assignee_ids: [item.assignee],
        });

        return { status: 'assigned', issue_iid: issueIid };
    }

    _buildTitle(item) {
        if (item.title) return `[ClawMark] ${item.title}`;
        const content = item.quote || item.messages?.[0]?.content || item.message || '';
        const summary = content.slice(0, 80);
        return `[ClawMark] ${summary || 'New item'}`;
    }

    _buildBody(item, context) {
        const lines = [];
        lines.push('## ClawMark Item');
        lines.push('');
        if (item.title) lines.push(`**Title:** ${item.title}`);
        if (item.type) lines.push(`**Type:** ${item.type}`);
        lines.push(`**Priority:** ${item.priority || 'normal'}`);
        if (item.created_by) lines.push(`**Reported by:** ${item.created_by}`);
        if (item.source_url) lines.push(`**Source:** ${item.source_url}`);
        if (item.source_title) lines.push(`**Page:** ${item.source_title}`);
        lines.push('');

        if (item.quote) {
            lines.push('### Selected Text');
            lines.push(`> ${item.quote}`);
            lines.push('');
        }

        const content = item.messages?.[0]?.content || item.message || '';
        if (content) {
            lines.push('### Description');
            lines.push(content);
            lines.push('');
        }

        const tags = typeof item.tags === 'string' ? JSON.parse(item.tags || '[]') : (item.tags || []);
        if (tags.length > 0) {
            lines.push(`**Tags:** ${tags.join(', ')}`);
            lines.push('');
        }

        const screenshots = typeof item.screenshots === 'string'
            ? JSON.parse(item.screenshots || '[]') : (item.screenshots || []);
        if (screenshots.length > 0) {
            lines.push('### Screenshots');
            for (const url of screenshots) {
                lines.push(`![screenshot](${url})`);
            }
            lines.push('');
        }

        lines.push('---');
        lines.push('*Created by [ClawMark](https://github.com/coco-xyz/clawmark) — Annotate any web page · [Website](https://labs.coco.xyz/clawmark/)*');
        return lines.join('\n');
    }

    _apiRequest(method, path, data) {
        const body = data ? JSON.stringify(data) : '';
        const parsed = new URL(this.baseUrl);

        return new Promise((resolve, reject) => {
            const isHttps = parsed.protocol === 'https:';
            const transport = isHttps ? https : http;

            const options = {
                hostname: parsed.hostname,
                port: parsed.port || (isHttps ? 443 : 80),
                path,
                method,
                headers: {
                    'Content-Type': 'application/json',
                    'PRIVATE-TOKEN': this.token,
                    'User-Agent': 'ClawMark/2.0',
                    ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
                },
            };

            const req = transport.request(options, (res) => {
                let responseData = '';
                res.on('data', chunk => responseData += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(responseData);
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            resolve(parsed);
                        } else {
                            reject(new Error(`GitLab API ${res.statusCode}: ${parsed.message || parsed.error || responseData.slice(0, 200)}`));
                        }
                    } catch {
                        reject(new Error(`GitLab response parse error: ${responseData.slice(0, 200)}`));
                    }
                });
            });
            req.on('error', reject);
            req.setTimeout(15000, () => {
                req.destroy(new Error('GitLab API request timeout'));
            });
            if (body) req.write(body);
            req.end();
        });
    }
}

module.exports = { GitLabIssueAdapter };
