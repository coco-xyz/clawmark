/**
 * ClawMark — Linear Adapter
 *
 * Creates Linear issues from ClawMark events, syncs status changes.
 * Uses Linear's GraphQL API.
 *
 * Channel config:
 *   {
 *     adapter: "linear",
 *     api_key: "lin_api_...",
 *     team_id: "TEAM-UUID",
 *     labels: ["clawmark"],          // optional: label names to apply
 *     assignee_id: "USER-UUID",      // optional: default assignee
 *     priority: 0-4                  // optional: Linear priority (0=none,1=urgent,4=low)
 *   }
 *
 * Events handled:
 *   - item.created   → creates a new Linear Issue
 *   - item.resolved  → marks the linked Linear Issue as "Done"
 *   - item.closed    → marks the linked Linear Issue as "Cancelled"
 */

'use strict';

const https = require('https');

class LinearAdapter {
    constructor(config) {
        this.type = 'linear';
        this.apiKey = config.api_key;
        this.teamId = config.team_id;
        this.labels = config.labels || [];
        this.assigneeId = config.assignee_id || null;
        this.defaultPriority = config.priority != null ? config.priority : 0;
        this.channelName = config.channelName || '';
        this.db = config.db || null;
        this._memoryMap = new Map();
    }

    validate() {
        if (!this.apiKey) return { ok: false, error: 'Missing api_key' };
        if (!this.teamId) return { ok: false, error: 'Missing team_id' };
        return { ok: true };
    }

    _setMapping(itemId, issueId, issueUrl) {
        if (this.db) {
            this.db.setAdapterMapping({
                item_id: itemId,
                adapter: 'linear',
                channel: this.channelName,
                external_id: String(issueId),
                external_url: issueUrl || null,
            });
        } else {
            this._memoryMap.set(itemId, { id: issueId, url: issueUrl });
        }
    }

    _getMapping(itemId) {
        if (this.db) {
            const row = this.db.getAdapterMapping({
                item_id: itemId,
                adapter: 'linear',
                channel: this.channelName,
            });
            return row ? { id: row.external_id, url: row.external_url } : null;
        }
        return this._memoryMap.get(itemId) || null;
    }

    async send(event, item, context = {}) {
        switch (event) {
            case 'item.created':
                return this._createIssue(item, context);
            case 'item.resolved':
                return this._updateState(item, 'done');
            case 'item.closed':
                return this._updateState(item, 'cancelled');
            default:
                return;
        }
    }

    async _createIssue(item, context) {
        const title = this._buildTitle(item);
        const description = this._buildDescription(item, context);

        const priorityMap = { critical: 1, high: 2, normal: 3, low: 4 };
        const priority = priorityMap[item.priority] || this.defaultPriority;

        const variables = {
            input: {
                teamId: this.teamId,
                title,
                description,
                priority,
            },
        };

        if (this.assigneeId) {
            variables.input.assigneeId = this.assigneeId;
        }

        const mutation = `mutation IssueCreate($input: IssueCreateInput!) {
            issueCreate(input: $input) {
                success
                issue {
                    id
                    identifier
                    url
                }
            }
        }`;

        const result = await this._graphql(mutation, variables);

        if (!result.data?.issueCreate?.success) {
            throw new Error(`Linear issue creation failed: ${JSON.stringify(result.errors || result)}`);
        }

        const issue = result.data.issueCreate.issue;
        const itemId = item.id || item.item?.id;
        if (itemId && issue.id) {
            this._setMapping(itemId, issue.id, issue.url);
        }

        return {
            status: 'created',
            issue_id: issue.id,
            identifier: issue.identifier,
            url: issue.url,
            external_id: issue.id,
            external_url: issue.url,
        };
    }

    async _updateState(item, stateName) {
        const itemId = item.id || item.item?.id;
        const mapping = this._getMapping(itemId);

        if (!mapping) {
            console.log(`[linear] No tracked issue for item ${itemId}, skipping state update`);
            return;
        }

        // Get workflow states for the team to find the target state
        const stateQuery = `query {
            workflowStates(filter: { team: { id: { eq: "${this.teamId}" } } }) {
                nodes { id name type }
            }
        }`;

        const statesResult = await this._graphql(stateQuery);
        const states = statesResult.data?.workflowStates?.nodes || [];

        // Match by type (done → "completed" type, cancelled → "cancelled" type)
        const typeMap = { done: 'completed', cancelled: 'cancelled' };
        const targetType = typeMap[stateName] || stateName;
        const targetState = states.find(s => s.type === targetType);

        if (!targetState) {
            console.log(`[linear] No "${targetType}" workflow state found for team ${this.teamId}`);
            return;
        }

        const mutation = `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
            issueUpdate(id: $id, input: $input) { success }
        }`;

        await this._graphql(mutation, {
            id: mapping.id,
            input: { stateId: targetState.id },
        });

        return { status: stateName, issue_id: mapping.id };
    }

    _buildTitle(item) {
        if (item.title) return `[ClawMark] ${item.title}`;
        const content = item.quote || item.messages?.[0]?.content || item.message || '';
        return `[ClawMark] ${content.slice(0, 80) || 'New item'}`;
    }

    _buildDescription(item, context) {
        const lines = [];

        if (item.type) lines.push(`**Type:** ${item.type}`);
        lines.push(`**Priority:** ${item.priority || 'normal'}`);
        if (item.created_by) lines.push(`**Reported by:** ${item.created_by}`);
        if (item.source_url) lines.push(`**Source:** ${item.source_url}`);
        if (item.source_title) lines.push(`**Page:** ${item.source_title}`);

        if (item.quote) {
            lines.push('', '> ' + item.quote.slice(0, 500));
        }

        const content = item.messages?.[0]?.content || item.message || '';
        if (content) {
            lines.push('', content);
        }

        const tags = typeof item.tags === 'string' ? JSON.parse(item.tags || '[]') : (item.tags || []);
        if (tags.length > 0) {
            lines.push('', `**Tags:** ${tags.join(', ')}`);
        }

        lines.push('', '---', '*Created by ClawMark*');
        return lines.join('\n');
    }

    _graphql(query, variables = {}) {
        const body = JSON.stringify({ query, variables });

        return new Promise((resolve, reject) => {
            const options = {
                hostname: 'api.linear.app',
                port: 443,
                path: '/graphql',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': this.apiKey,
                    'User-Agent': 'ClawMark/2.0',
                    'Content-Length': Buffer.byteLength(body),
                },
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            resolve(parsed);
                        } else {
                            reject(new Error(`Linear API ${res.statusCode}: ${data.slice(0, 200)}`));
                        }
                    } catch {
                        reject(new Error(`Linear response parse error: ${data.slice(0, 200)}`));
                    }
                });
            });
            req.on('error', reject);
            req.setTimeout(15000, () => {
                req.destroy(new Error('Linear API request timeout'));
            });
            req.write(body);
            req.end();
        });
    }
}

module.exports = { LinearAdapter };
