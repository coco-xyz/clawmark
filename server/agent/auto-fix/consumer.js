/**
 * ClawMark — Auto-Fix Consumer (#86)
 *
 * Orchestrates the full auto-fix pipeline:
 *   perception_issues → blame analysis → LLM fix generation →
 *   branch + commit + push → MR creation → team notification
 *
 * Polls for fix-eligible issues and processes them one at a time.
 * Confidence gating: high-confidence fixes → auto-submit MR;
 * low-confidence fixes → draft MR for human review.
 */

'use strict';

const { analyzeBlame } = require('./blame-analyzer');
const { generateFix, revertFix } = require('./fix-generator');
const { generateBranchName, createBranchAndCommit, runValidation, createMergeRequest, buildMrDescription, cleanup } = require('./pr-creator');
const { notifyAll } = require('./notifier');

class AutoFixConsumer {
    /**
     * @param {object} opts
     * @param {object} opts.db - ClawMark DB API
     * @param {string} opts.app_id - App context
     * @param {string} opts.repoRoot - Git repository root path
     * @param {object} opts.gitlab - { token, project_id, base_url, labels, assignee_ids, reviewer_ids }
     * @param {string} opts.geminiApiKey - Gemini API key for fix generation
     * @param {number} [opts.pollInterval=60000] - Poll interval in ms
     * @param {number} [opts.maxAttempts=3] - Max fix attempts per issue
     * @param {number} [opts.batchSize=5] - Max issues to process per poll
     * @param {number} [opts.confidenceThreshold=0.8] - Threshold for auto-submit vs draft
     * @param {string} [opts.baseBranch='develop'] - Base branch for fix branches
     * @param {Array} [opts.notifyChannels] - Notification webhook channels
     * @param {Function} [opts.callAI] - Override AI call (for testing)
     * @param {Function} [opts.execFn] - Override exec (for testing)
     */
    constructor(opts) {
        this.db = opts.db;
        this.appId = opts.app_id;
        this.repoRoot = opts.repoRoot;
        this.gitlab = opts.gitlab;
        this.geminiApiKey = opts.geminiApiKey;
        this.pollInterval = opts.pollInterval || 60000;
        this.maxAttempts = opts.maxAttempts || 3;
        this.batchSize = opts.batchSize || 5;
        this.confidenceThreshold = opts.confidenceThreshold ?? 0.8;
        this.baseBranch = opts.baseBranch || 'develop';
        this.notifyChannels = opts.notifyChannels || [];
        this.callAI = opts.callAI || null;
        this.execFn = opts.execFn || null;

        this._timer = null;
        this._busy = false;
    }

    start() {
        if (this._timer) return;
        console.log(`[auto-fix] Started (app=${this.appId}, interval=${this.pollInterval}ms, threshold=${this.confidenceThreshold})`);
        this._timer = setInterval(() => this._poll(), this.pollInterval);
        this._poll();
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
            console.log('[auto-fix] Stopped');
        }
    }

    async _poll() {
        if (this._busy) return;
        this._busy = true;

        try {
            const candidates = this.db.getAutoFixCandidates({
                app_id: this.appId,
                maxAttempts: this.maxAttempts,
                limit: this.batchSize,
            });

            if (candidates.length === 0) {
                this._busy = false;
                return;
            }

            console.log(`[auto-fix] Processing ${candidates.length} candidates`);

            for (const issue of candidates) {
                await this._processIssue(issue);
            }
        } catch (err) {
            console.error('[auto-fix] Poll error:', err.message);
        } finally {
            this._busy = false;
        }
    }

    /**
     * Process a single perception issue through the auto-fix pipeline.
     */
    async _processIssue(issue) {
        const { fingerprint } = issue;
        const now = new Date().toISOString();

        // Mark as in-progress
        this.db.updateAutoFixStatus({
            app_id: this.appId,
            fingerprint,
            fix_status: 'in_progress',
            fix_attempt_count: (issue.fix_attempt_count || 0) + 1,
            last_fix_attempt: now,
        });

        try {
            // 1. Get the representative error event
            const events = this.db.getPerceptionEventsByFingerprint({
                app_id: this.appId,
                fingerprint,
                limit: 1,
            });

            if (!events || events.length === 0) {
                this._markFailed(fingerprint, 'No events found for fingerprint');
                return;
            }

            const errorEvent = events[0];
            console.log(`[auto-fix] Analyzing ${fingerprint}: ${(errorEvent.message || '').slice(0, 60)}`);

            // 2. Blame analysis
            let blameResult = null;
            try {
                blameResult = await analyzeBlame(errorEvent, this.repoRoot, {
                    execFn: this.execFn,
                });
            } catch (err) {
                console.warn(`[auto-fix] Blame analysis failed for ${fingerprint}: ${err.message}`);
            }

            if (!blameResult) {
                this._markFailed(fingerprint, 'Could not identify source file from stack trace');
                return;
            }

            // 3. Generate fix
            const fixResult = await generateFix({
                errorEvent,
                blameResult,
                repoRoot: this.repoRoot,
                apiKey: this.geminiApiKey,
                callAI: this.callAI,
                confidenceThreshold: this.confidenceThreshold,
            });

            if (!fixResult.fix || fixResult.confidence === 0) {
                this._markFailed(fingerprint, `Fix generation failed: ${fixResult.analysis}`);
                return;
            }

            const isDraft = fixResult.isDraft;
            console.log(`[auto-fix] Fix generated for ${fingerprint}: confidence=${fixResult.confidence}, draft=${isDraft}`);

            // 4. Create branch, apply fix, commit, push
            const branchName = generateBranchName(issue.gitlab_issue_id, errorEvent.message);

            const branchResult = await createBranchAndCommit({
                repoRoot: this.repoRoot,
                branchName,
                baseBranch: this.baseBranch,
                fix: fixResult.fix,
                errorEvent,
                blameResult,
                execFn: this.execFn,
            });

            if (!branchResult.success) {
                // Cleanup branch on failure
                await cleanup(this.repoRoot, branchName, this.baseBranch, { execFn: this.execFn });
                this._markFailed(fingerprint, `Branch/commit failed: ${branchResult.error}`);
                return;
            }

            // 5. Run validation
            const validation = await runValidation(this.repoRoot, { execFn: this.execFn });
            if (!validation.passed) {
                // Revert and cleanup
                revertFix(fixResult.fix, this.repoRoot);
                await cleanup(this.repoRoot, branchName, this.baseBranch, { execFn: this.execFn });
                const failedCmds = validation.results.filter(r => !r.ok).map(r => r.cmd).join(', ');
                this._markFailed(fingerprint, `Validation failed: ${failedCmds}`);
                return;
            }

            // 6. Create MR
            const mrDescription = buildMrDescription(errorEvent, fixResult, blameResult, issue);
            const typeLabel = errorEvent.type === 'js-error' ? 'JS' : errorEvent.type || 'error';
            const mrTitle = `[AutoFix][${typeLabel}] ${(errorEvent.message || 'error').slice(0, 80)}`;

            const mr = await createMergeRequest({
                token: this.gitlab.token,
                project_id: this.gitlab.project_id,
                source_branch: branchName,
                target_branch: this.baseBranch,
                title: mrTitle,
                description: mrDescription,
                labels: [...(this.gitlab.labels || []), 'auto-fix'],
                assignee_ids: this.gitlab.assignee_ids || [],
                reviewer_ids: this.gitlab.reviewer_ids || [],
                draft: isDraft,
                base_url: this.gitlab.base_url,
            });

            console.log(`[auto-fix] Created MR !${mr.iid} for ${fingerprint} (draft=${isDraft})`);

            // 7. Update DB
            this.db.updateAutoFixStatus({
                app_id: this.appId,
                fingerprint,
                fix_status: 'submitted',
                fix_branch: branchName,
                fix_pr_url: mr.url,
                fix_pr_id: String(mr.iid),
                fix_confidence: fixResult.confidence,
            });

            // 8. Log agent action
            if (this.db.logAgentAction) {
                this.db.logAgentAction({
                    app_id: this.appId,
                    agent_id: 'auto-fix',
                    action_type: 'create_mr',
                    target_type: 'merge_request',
                    target_id: String(mr.iid),
                    summary: `Auto-fix MR !${mr.iid} for error: ${(errorEvent.message || '').slice(0, 100)}`,
                    status: isDraft ? 'draft' : 'submitted',
                    metadata: JSON.stringify({
                        confidence: fixResult.confidence,
                        fingerprint,
                        branch: branchName,
                    }),
                });
            }

            // 9. Notify team
            if (this.notifyChannels.length > 0) {
                try {
                    await notifyAll({
                        errorEvent, fixResult, mr, issue,
                        channels: this.notifyChannels,
                    });
                } catch (err) {
                    console.warn(`[auto-fix] Notification failed: ${err.message}`);
                }
            }

            // 10. Switch back to base branch
            await cleanup(this.repoRoot, branchName, this.baseBranch, { execFn: this.execFn });

        } catch (err) {
            console.error(`[auto-fix] Pipeline error for ${fingerprint}:`, err.message);
            this._markFailed(fingerprint, err.message);
        }
    }

    _markFailed(fingerprint, reason) {
        console.warn(`[auto-fix] Failed for ${fingerprint}: ${reason}`);
        this.db.updateAutoFixStatus({
            app_id: this.appId,
            fingerprint,
            fix_status: 'failed',
        });
    }
}

module.exports = AutoFixConsumer;
