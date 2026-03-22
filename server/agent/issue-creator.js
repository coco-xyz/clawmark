/**
 * ClawMark — GitLab Issue Creator for Perception Events (#69, #74)
 *
 * Creates well-formatted GitLab issues from deduplicated perception errors.
 * Enhanced with session context: reproduction steps, user action timeline,
 * and snapshot references (#74).
 * Uses the GitLab API directly (same pattern as adapters/gitlab-issue.js).
 */

'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

class PerceptionIssueCreator {
    /**
     * @param {object} config
     * @param {string} config.token       - GitLab PAT
     * @param {string} config.project_id  - "namespace/project" or numeric ID
     * @param {string} [config.base_url]  - GitLab instance URL (default: https://gitlab.com)
     * @param {string[]} [config.labels]  - Default labels
     * @param {number[]} [config.assignees] - Default assignee user IDs
     * @param {number} [config.parent_issue_iid] - Parent issue to link to
     */
    constructor(config) {
        this.token = config.token;
        this.projectId = config.project_id;
        this.baseUrl = (config.base_url || 'https://gitlab.com').replace(/\/+$/, '');
        this.labels = config.labels || ['clawmark', 'error-sentinel'];
        this.assignees = config.assignees || [];
        this.parentIssueIid = config.parent_issue_iid || null;
    }

    /**
     * Create a GitLab issue from a deduplicated error group.
     *
     * @param {object} group - Dedup group { fingerprint, count, representative, events }
     * @param {object} [sessionContext] - Optional session context from session-analyzer (#74)
     * @param {object} [sessionContext.report] - Output from reproduction-generator.generateReport()
     * @param {object} [sessionContext.correlation] - Output from session-analyzer.correlate()
     * @returns {Promise<{ iid: number, url: string }>}
     */
    async createIssue(group, sessionContext) {
        const { representative, count, fingerprint, events } = group;
        const title = this._buildTitle(representative);
        const description = this._buildDescription(group, sessionContext);

        const labels = [...this.labels];
        if (representative.severity === 'critical') {
            labels.push('priority::critical');
        } else if (representative.severity === 'error') {
            labels.push('priority::high');
        }

        const encodedProject = encodeURIComponent(this.projectId);
        const data = {
            title,
            description,
            labels: labels.join(','),
        };
        if (this.assignees.length > 0) {
            data.assignee_ids = this.assignees;
        }

        const result = await this._apiRequest(
            'POST',
            `/api/v4/projects/${encodedProject}/issues`,
            data
        );

        console.log(`[issue-creator] Created GitLab issue #${result.iid}: ${title}`);
        return { iid: result.iid, url: result.web_url };
    }

    _buildTitle(event) {
        const typeLabel = {
            'js-error': 'JS',
            'unhandled-rejection': 'Promise',
            'console-error': 'Console',
            'network-error': 'Network',
            'resource-error': 'Resource',
            'long-task': 'Perf',
        }[event.type] || event.type;

        const msg = (event.message || 'Unknown error').slice(0, 80);
        return `[ErrorSentinel][${typeLabel}] ${msg}`;
    }

    _buildDescription(group, sessionContext) {
        const { representative, count, fingerprint, events } = group;
        const firstSeen = events.length > 0
            ? events.reduce((min, e) => e.created_at < min ? e.created_at : min, events[0].created_at)
            : representative.created_at;
        const lastSeen = representative.created_at;

        let ctx = {};
        try { ctx = JSON.parse(representative.context || '{}'); } catch {}

        const lines = [
            '## Error Details',
            '',
            `| Field | Value |`,
            `|-------|-------|`,
            `| **Type** | \`${representative.type}\` |`,
            `| **Severity** | \`${representative.severity}\` |`,
            `| **URL** | ${representative.url || 'N/A'} |`,
            `| **Source** | \`${representative.source || 'N/A'}\`${representative.line ? `:${representative.line}` : ''} |`,
            `| **Fingerprint** | \`${fingerprint}\` |`,
            `| **Occurrences** | ${count} |`,
            `| **First seen** | ${firstSeen} |`,
            `| **Last seen** | ${lastSeen} |`,
            '',
        ];

        if (representative.message) {
            lines.push('## Error Message', '', '```', representative.message, '```', '');
        }

        if (representative.stack) {
            lines.push('## Stack Trace', '', '```', representative.stack.slice(0, 4096), '```', '');
        }

        // Session context: reproduction steps and user action timeline (#74)
        if (sessionContext && sessionContext.report) {
            const report = sessionContext.report;
            if (report.timeline) {
                lines.push('## Reproduction', '', report.timeline, '');
            }
        } else if (ctx.userAction || ctx.sessionPhase) {
            lines.push('## Context', '');
            if (ctx.userAction) lines.push(`- **User Action**: ${ctx.userAction}`);
            if (ctx.sessionPhase) lines.push(`- **Session Phase**: ${ctx.sessionPhase}`);
            lines.push('');
        }

        // Session snapshot reference (#74)
        if (sessionContext && sessionContext.correlation && sessionContext.correlation.closestSnapshot) {
            const snap = sessionContext.correlation.closestSnapshot;
            lines.push('## Snapshot', '');
            lines.push(`Session snapshot at ${snap.timestamp} (ID: \`${snap.id}\`)`, '');
        }

        if (this.parentIssueIid) {
            lines.push(`## Related`, '', `Parent issue: #${this.parentIssueIid}`, '');
        }

        lines.push('---', '*Auto-created by ClawMark Error Sentinel*');

        return lines.join('\n');
    }

    _apiRequest(method, path, data) {
        const parsed = new URL(this.baseUrl);
        const isHttps = parsed.protocol === 'https:';
        const transport = isHttps ? https : http;

        const body = data ? JSON.stringify(data) : null;
        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path,
            method,
            headers: {
                'PRIVATE-TOKEN': this.token,
                'Content-Type': 'application/json',
            },
        };
        if (body) options.headers['Content-Length'] = Buffer.byteLength(body);

        return new Promise((resolve, reject) => {
            const req = transport.request(options, (res) => {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString();
                    if (res.statusCode >= 400) {
                        return reject(new Error(`GitLab API ${res.statusCode}: ${raw.slice(0, 500)}`));
                    }
                    try {
                        resolve(JSON.parse(raw));
                    } catch {
                        reject(new Error(`Invalid JSON: ${raw.slice(0, 200)}`));
                    }
                });
                res.on('error', reject);
            });
            req.on('error', reject);
            req.setTimeout(15000, () => req.destroy(new Error('Request timeout')));
            if (body) req.write(body);
            req.end();
        });
    }
}

module.exports = PerceptionIssueCreator;
