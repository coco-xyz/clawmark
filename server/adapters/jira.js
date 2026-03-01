/**
 * ClawMark — Jira Cloud Adapter
 *
 * Creates Jira issues from ClawMark events, syncs status changes.
 * Uses Jira Cloud REST API v3.
 *
 * Channel config:
 *   {
 *     adapter: "jira",
 *     domain: "myteam",                     // → myteam.atlassian.net
 *     email: "user@example.com",
 *     api_token: "ATATT3...",
 *     project_key: "PROJ",
 *     issue_type: "Bug",                    // optional, default "Task"
 *     labels: ["clawmark"],                 // optional
 *     priority: "High"                      // optional: Jira priority name
 *   }
 *
 * Events handled:
 *   - item.created   → creates a new Jira Issue
 *   - item.resolved  → transitions the linked issue to "Done"
 *   - item.closed    → transitions the linked issue to "Done"
 */

'use strict';

const https = require('https');

class JiraAdapter {
    constructor(config) {
        this.type = 'jira';
        this.domain = config.domain; // just the subdomain part
        this.email = config.email;
        this.apiToken = config.api_token;
        this.projectKey = config.project_key;
        this.issueType = config.issue_type || 'Task';
        this.labels = config.labels || ['clawmark'];
        this.defaultPriority = config.priority || null;
        this.channelName = config.channelName || '';
        this.db = config.db || null;
        this._memoryMap = new Map();
    }

    validate() {
        if (!this.domain) return { ok: false, error: 'Missing domain' };
        if (!this.email) return { ok: false, error: 'Missing email' };
        if (!this.apiToken) return { ok: false, error: 'Missing api_token' };
        if (!this.projectKey) return { ok: false, error: 'Missing project_key' };
        if (!/^[A-Z][A-Z0-9_]*$/.test(this.projectKey)) {
            return { ok: false, error: 'project_key must be uppercase letters/digits (e.g. "PROJ")' };
        }
        return { ok: true };
    }

    _setMapping(itemId, issueKey, issueUrl) {
        if (this.db) {
            this.db.setAdapterMapping({
                item_id: itemId,
                adapter: 'jira',
                channel: this.channelName,
                external_id: String(issueKey),
                external_url: issueUrl || null,
            });
        } else {
            this._memoryMap.set(itemId, { key: issueKey, url: issueUrl });
        }
    }

    _getMapping(itemId) {
        if (this.db) {
            const row = this.db.getAdapterMapping({
                item_id: itemId,
                adapter: 'jira',
                channel: this.channelName,
            });
            return row ? { key: row.external_id, url: row.external_url } : null;
        }
        return this._memoryMap.get(itemId) || null;
    }

    async send(event, item, context = {}) {
        switch (event) {
            case 'item.created':
                return this._createIssue(item, context);
            case 'item.resolved':
            case 'item.closed':
                return this._transitionIssue(item, 'Done');
            default:
                return;
        }
    }

    async _createIssue(item, context) {
        const summary = this._buildSummary(item);
        const description = this._buildDescription(item, context);

        const fields = {
            project: { key: this.projectKey },
            summary,
            description,
            issuetype: { name: this.issueType },
            labels: [...this.labels],
        };

        if (this.defaultPriority) {
            fields.priority = { name: this.defaultPriority };
        } else if (item.priority) {
            const priorityMap = { critical: 'Highest', high: 'High', normal: 'Medium', low: 'Low' };
            const jiraPriority = priorityMap[item.priority];
            if (jiraPriority) fields.priority = { name: jiraPriority };
        }

        // Add item tags as labels (sanitized for Jira: no spaces, max 255 chars)
        const tags = typeof item.tags === 'string' ? JSON.parse(item.tags || '[]') : (item.tags || []);
        for (const tag of tags) {
            const sanitized = String(tag).replace(/\s+/g, '-').replace(/[^\w-]/g, '').slice(0, 255);
            if (sanitized) fields.labels.push(sanitized);
        }

        const result = await this._apiRequest('POST', '/rest/api/3/issue', { fields });

        const issueKey = result.key;
        const issueUrl = `https://${this.domain}.atlassian.net/browse/${issueKey}`;

        const itemId = item.id || item.item?.id;
        if (itemId && issueKey) {
            this._setMapping(itemId, issueKey, issueUrl);
        }

        return {
            status: 'created',
            issue_key: issueKey,
            url: issueUrl,
            external_id: issueKey,
            external_url: issueUrl,
        };
    }

    async _transitionIssue(item, targetName) {
        const itemId = item.id || item.item?.id;
        const mapping = this._getMapping(itemId);

        if (!mapping) {
            console.log(`[jira] No tracked issue for item ${itemId}, skipping transition`);
            return;
        }

        // Get available transitions
        const transitions = await this._apiRequest(
            'GET',
            `/rest/api/3/issue/${mapping.key}/transitions`
        );

        const target = (transitions.transitions || []).find(
            t => t.name.toLowerCase() === targetName.toLowerCase()
        );

        if (!target) {
            console.log(`[jira] No "${targetName}" transition available for ${mapping.key}`);
            return;
        }

        await this._apiRequest(
            'POST',
            `/rest/api/3/issue/${mapping.key}/transitions`,
            { transition: { id: target.id } }
        );

        return { status: 'transitioned', issue_key: mapping.key, transition: targetName };
    }

    _buildSummary(item) {
        if (item.title) return `[ClawMark] ${item.title}`;
        const content = item.quote || item.messages?.[0]?.content || item.message || '';
        return `[ClawMark] ${content.slice(0, 80) || 'New item'}`;
    }

    _buildDescription(item, context) {
        // Jira Cloud v3 uses ADF (Atlassian Document Format)
        const nodes = [];

        // Header
        nodes.push({
            type: 'heading',
            attrs: { level: 2 },
            content: [{ type: 'text', text: 'ClawMark Item' }],
        });

        // Metadata paragraph
        const metaLines = [];
        if (item.type) metaLines.push(`Type: ${item.type}`);
        metaLines.push(`Priority: ${item.priority || 'normal'}`);
        if (item.created_by) metaLines.push(`Reported by: ${item.created_by}`);
        if (item.source_url) metaLines.push(`Source: ${item.source_url}`);
        if (item.source_title) metaLines.push(`Page: ${item.source_title}`);

        if (metaLines.length > 0) {
            nodes.push({
                type: 'paragraph',
                content: metaLines.map((line, i) => {
                    const parts = [{ type: 'text', text: line }];
                    if (i < metaLines.length - 1) parts.push({ type: 'hardBreak' });
                    return parts;
                }).flat(),
            });
        }

        // Quote
        if (item.quote) {
            nodes.push({
                type: 'blockquote',
                content: [{
                    type: 'paragraph',
                    content: [{ type: 'text', text: item.quote.slice(0, 500) }],
                }],
            });
        }

        // Content
        const content = item.messages?.[0]?.content || item.message || '';
        if (content) {
            nodes.push({
                type: 'paragraph',
                content: [{ type: 'text', text: content }],
            });
        }

        // Tags
        const tags = typeof item.tags === 'string' ? JSON.parse(item.tags || '[]') : (item.tags || []);
        if (tags.length > 0) {
            nodes.push({
                type: 'paragraph',
                content: [
                    { type: 'text', text: 'Tags: ', marks: [{ type: 'strong' }] },
                    { type: 'text', text: tags.join(', ') },
                ],
            });
        }

        // Footer
        nodes.push({
            type: 'rule',
        });
        nodes.push({
            type: 'paragraph',
            content: [{ type: 'text', text: 'Created by ClawMark', marks: [{ type: 'em' }] }],
        });

        return {
            type: 'doc',
            version: 1,
            content: nodes,
        };
    }

    _apiRequest(method, path, data) {
        const body = data ? JSON.stringify(data) : '';
        const auth = Buffer.from(`${this.email}:${this.apiToken}`).toString('base64');

        return new Promise((resolve, reject) => {
            const options = {
                hostname: `${this.domain}.atlassian.net`,
                port: 443,
                path,
                method,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Basic ${auth}`,
                    'User-Agent': 'ClawMark/2.0',
                    'Accept': 'application/json',
                    ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
                },
            };

            const req = https.request(options, (res) => {
                let responseData = '';
                res.on('data', chunk => responseData += chunk);
                res.on('end', () => {
                    // 204 No Content is valid for transitions
                    if (res.statusCode === 204) {
                        resolve({});
                        return;
                    }
                    try {
                        const parsed = JSON.parse(responseData);
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            resolve(parsed);
                        } else {
                            const msg = parsed.errorMessages?.join(', ') || parsed.message || responseData.slice(0, 200);
                            reject(new Error(`Jira API ${res.statusCode}: ${msg}`));
                        }
                    } catch {
                        reject(new Error(`Jira response parse error: ${responseData.slice(0, 200)}`));
                    }
                });
            });
            req.on('error', reject);
            req.setTimeout(15000, () => {
                req.destroy(new Error('Jira API request timeout'));
            });
            if (body) req.write(body);
            req.end();
        });
    }
}

module.exports = { JiraAdapter };
