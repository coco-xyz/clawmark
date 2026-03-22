/**
 * ClawMark — Perception Consumer (#69)
 *
 * Agent-side consumer that periodically polls perception events from the server,
 * deduplicates errors, and automatically creates GitLab issues for new unique errors.
 *
 * Usage:
 *   const consumer = new PerceptionConsumer({ db, gitlabConfig, ... });
 *   consumer.start();   // begins polling
 *   consumer.stop();    // stops polling
 */

'use strict';

const { deduplicateEvents, filterBySeverity, generateFingerprint } = require('./error-deduplicator');
const PerceptionIssueCreator = require('./issue-creator');
const { correlate } = require('./session-analyzer');
const { generateReport } = require('./reproduction-generator');

class PerceptionConsumer {
    /**
     * @param {object} opts
     * @param {object} opts.db             - ClawMark DB API (from initDb)
     * @param {string} opts.app_id         - App context for perception queries
     * @param {object} opts.gitlab         - GitLab config { token, project_id, base_url, labels, assignees, parent_issue_iid }
     * @param {number} [opts.pollInterval] - Poll interval in ms (default: 30000)
     * @param {string} [opts.minSeverity]  - Minimum severity to create issues (default: 'error')
     * @param {number} [opts.batchSize]    - Max events per poll (default: 100)
     */
    constructor(opts) {
        this.db = opts.db;
        this.appId = opts.app_id;
        this.pollInterval = opts.pollInterval || 30000;
        this.minSeverity = opts.minSeverity || 'error';
        this.batchSize = opts.batchSize || 100;
        this.cursor = null;
        this._timer = null;
        this._busy = false;

        if (opts.gitlab) {
            this.issueCreator = new PerceptionIssueCreator(opts.gitlab);
        }
    }

    start() {
        if (this._timer) return;
        console.log(`[perception-consumer] Started (app=${this.appId}, interval=${this.pollInterval}ms, severity>=${this.minSeverity})`);
        this._timer = setInterval(() => this._poll(), this.pollInterval);
        // Initial poll immediately
        this._poll();
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
            console.log('[perception-consumer] Stopped');
        }
    }

    async _poll() {
        if (this._busy) return;
        this._busy = true;

        try {
            // 1. Fetch new perception events since last cursor
            const events = this.db.getPerceptionEvents({
                app_id: this.appId,
                cursor: this.cursor,
                limit: this.batchSize,
            });

            if (events.length === 0) {
                this._busy = false;
                return;
            }

            // Update cursor to the last event's timestamp
            this.cursor = events[events.length - 1].created_at;

            console.log(`[perception-consumer] Processing ${events.length} new events (cursor: ${this.cursor})`);

            // 2. Filter by severity threshold
            const filtered = filterBySeverity(events, this.minSeverity);
            if (filtered.length === 0) {
                this._busy = false;
                return;
            }

            // 3. Deduplicate by fingerprint
            const groups = deduplicateEvents(filtered);

            // 4. For each unique error group, check if we already track it
            for (const [fp, group] of groups) {
                await this._processGroup(fp, group);
            }
        } catch (err) {
            console.error('[perception-consumer] Poll error:', err.message);
        } finally {
            this._busy = false;
        }
    }

    async _processGroup(fingerprint, group) {
        const { count, representative } = group;

        // Check if we already have a tracked issue for this fingerprint
        const existing = this.db.getPerceptionIssue({
            app_id: this.appId,
            fingerprint,
        });

        if (existing) {
            // Update count and last_seen
            this.db.upsertPerceptionIssue({
                app_id: this.appId,
                fingerprint,
                count,
                last_seen: representative.created_at,
            });
            return;
        }

        // New unique error — create a tracked issue
        const issueRecord = this.db.upsertPerceptionIssue({
            app_id: this.appId,
            fingerprint,
            count,
            first_seen: group.events[0]?.created_at || representative.created_at,
            last_seen: representative.created_at,
        });

        // Create GitLab issue if creator is configured
        if (this.issueCreator) {
            try {
                // Correlate with session data for enhanced issue reports (#74)
                let sessionContext = null;
                try {
                    const correlation = correlate(this.db, representative);
                    if (correlation) {
                        const report = generateReport(correlation, representative);
                        sessionContext = { correlation, report };
                    }
                } catch (err) {
                    console.warn(`[perception-consumer] Session correlation failed for ${fingerprint}: ${err.message}`);
                }

                const result = await this.issueCreator.createIssue(group, sessionContext);
                // Update the tracked issue with GitLab info
                this.db.upsertPerceptionIssue({
                    app_id: this.appId,
                    fingerprint,
                    count: 0, // don't double-count
                    last_seen: representative.created_at,
                    gitlab_issue_id: String(result.iid),
                    gitlab_issue_url: result.url,
                });
                console.log(`[perception-consumer] Created issue #${result.iid} for fingerprint ${fingerprint}`);
            } catch (err) {
                console.error(`[perception-consumer] Failed to create GitLab issue for ${fingerprint}:`, err.message);
            }
        }
    }
}

module.exports = PerceptionConsumer;
