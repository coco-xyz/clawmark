/**
 * ClawMark — GitHub Issue Adapter
 *
 * Creates GitHub Issues from ClawMark events, and syncs status
 * (resolve → close, reopen → reopen).
 *
 * Channel config:
 *   {
 *     adapter: "github-issue",
 *     token: "ghp_...",
 *     repo: "owner/repo",
 *     labels: ["clawmark", "bug"],        // optional: default labels
 *     assignees: ["username"],             // optional: default assignees
 *     template: "default"                  // optional
 *   }
 *
 * Events handled:
 *   - item.created   → creates a new GitHub Issue
 *   - item.resolved  → closes the linked GitHub Issue
 *   - item.closed    → closes the linked GitHub Issue
 *   - item.assigned  → adds assignee to the linked GitHub Issue (if mapping exists)
 */

'use strict';

const https = require('https');

class GitHubIssueAdapter {
    constructor(config) {
        this.type = 'github-issue';
        this.token = config.token;
        this.repo = config.repo; // "owner/repo"
        this.labels = config.labels || ['clawmark'];
        this.assignees = config.assignees || [];
        this.template = config.template || 'default';
        // Track ClawMark item ID → GitHub issue number (in-memory; lost on restart)
        // Production should use DB, but this is sufficient for Phase 3 MVP
        this.issueMap = new Map();
    }

    validate() {
        if (!this.token) return { ok: false, error: 'Missing token' };
        if (!this.repo) return { ok: false, error: 'Missing repo' };
        if (!/^[^/]+\/[^/]+$/.test(this.repo)) {
            return { ok: false, error: 'repo must be in "owner/repo" format' };
        }
        return { ok: true };
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
                // Other events are no-ops for this adapter
                return;
        }
    }

    async _createIssue(item, context) {
        const title = this._buildTitle(item);
        const body = this._buildBody(item, context);

        const priorityLabel = item.priority && item.priority !== 'normal'
            ? `priority:${item.priority}` : null;

        const labels = [...this.labels];
        if (priorityLabel) labels.push(priorityLabel);
        if (item.type) labels.push(`type:${item.type}`);

        // Add item tags as labels (sanitized: max 50 chars, no control chars)
        const tags = typeof item.tags === 'string' ? JSON.parse(item.tags || '[]') : (item.tags || []);
        for (const tag of tags) {
            const sanitized = String(tag).replace(/[\x00-\x1f]/g, '').trim().slice(0, 50);
            if (sanitized) labels.push(sanitized);
        }

        const data = {
            title,
            body,
            labels,
            assignees: this.assignees,
        };

        const result = await this._apiRequest('POST', `/repos/${this.repo}/issues`, data);

        // Track mapping for status sync
        const itemId = item.id || item.item?.id;
        if (itemId && result.number) {
            this.issueMap.set(itemId, result.number);
        }

        return { status: 'created', issue_number: result.number, url: result.html_url };
    }

    async _closeIssue(item, context) {
        const itemId = item.id || item.item?.id;
        const issueNumber = this.issueMap.get(itemId);

        if (!issueNumber) {
            // Can't close what we didn't create — skip silently
            console.log(`[github-issue] No tracked issue for item ${itemId}, skipping close`);
            return;
        }

        const result = await this._apiRequest('PATCH', `/repos/${this.repo}/issues/${issueNumber}`, {
            state: 'closed',
            state_reason: 'completed',
        });

        return { status: 'closed', issue_number: issueNumber };
    }

    async _updateAssignee(item, context) {
        const itemId = item.id || item.item?.id;
        const issueNumber = this.issueMap.get(itemId);

        if (!issueNumber || !item.assignee) return;

        const result = await this._apiRequest('POST', `/repos/${this.repo}/issues/${issueNumber}/assignees`, {
            assignees: [item.assignee],
        });

        return { status: 'assigned', issue_number: issueNumber };
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

        if (item.title) {
            lines.push(`**Title:** ${item.title}`);
        }

        if (item.type) {
            lines.push(`**Type:** ${item.type}`);
        }

        lines.push(`**Priority:** ${item.priority || 'normal'}`);

        if (item.created_by) {
            lines.push(`**Reported by:** ${item.created_by}`);
        }

        if (item.source_url) {
            lines.push(`**Source:** ${item.source_url}`);
        }

        if (item.source_title) {
            lines.push(`**Page:** ${item.source_title}`);
        }

        lines.push('');

        // Quote
        if (item.quote) {
            lines.push('### Selected Text');
            lines.push(`> ${item.quote}`);
            lines.push('');
        }

        // Content/message
        const content = item.messages?.[0]?.content || item.message || '';
        if (content) {
            lines.push('### Description');
            lines.push(content);
            lines.push('');
        }

        // Tags
        const tags = typeof item.tags === 'string' ? JSON.parse(item.tags || '[]') : (item.tags || []);
        if (tags.length > 0) {
            lines.push(`**Tags:** ${tags.join(', ')}`);
            lines.push('');
        }

        // Screenshots
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
        lines.push('*Created by ClawMark*');

        return lines.join('\n');
    }

    _apiRequest(method, path, data) {
        const body = data ? JSON.stringify(data) : '';

        return new Promise((resolve, reject) => {
            const options = {
                hostname: 'api.github.com',
                port: 443,
                path,
                method,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}`,
                    'User-Agent': 'ClawMark/2.0',
                    'Accept': 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                    ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
                },
            };

            const req = https.request(options, (res) => {
                let responseData = '';
                res.on('data', chunk => responseData += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(responseData);
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            resolve(parsed);
                        } else {
                            reject(new Error(`GitHub API ${res.statusCode}: ${parsed.message || responseData.slice(0, 200)}`));
                        }
                    } catch {
                        reject(new Error(`GitHub response parse error: ${responseData.slice(0, 200)}`));
                    }
                });
            });
            req.on('error', reject);
            req.setTimeout(15000, () => {
                req.destroy(new Error('GitHub API request timeout'));
            });
            if (body) req.write(body);
            req.end();
        });
    }
}

module.exports = { GitHubIssueAdapter };
