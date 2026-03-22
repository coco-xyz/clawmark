/**
 * ClawMark — Patrol Runner (#79)
 *
 * Executes patrol scripts step-by-step via the Action Queue.
 * Each step: action → wait for result → run assertions → log.
 * Failed assertions feed into perception pipeline as regression events.
 *
 * Patrol scripts are plain objects (DSL):
 *   { id, name, params?, steps: [{ action, assertions? }] }
 *
 * Depends on:
 * - Action Queue (#78) for executing browser actions
 * - Perception pipeline for reporting assertion failures
 * - db API for logging patrol results
 */

'use strict';

const crypto = require('crypto');
const { evaluateAll } = require('./assertions');

/**
 * @typedef {object} PatrolStep
 * @property {string}   action      - Action type: navigate, click, screenshot, wait, type
 * @property {object}   [payload]   - Action payload (url, selector, text, ms, etc.)
 * @property {object[]} [assertions] - Assertions to evaluate after action completes
 * @property {string}   [label]     - Human-readable step description
 */

/**
 * @typedef {object} PatrolScript
 * @property {string}       id      - Unique patrol ID
 * @property {string}       name    - Human-readable name
 * @property {PatrolStep[]} steps   - Ordered steps
 * @property {object}       [params] - Default parameters (can be overridden at runtime)
 * @property {string}       [schedule] - Cron expression for scheduling
 */

/**
 * @typedef {object} StepResult
 * @property {number}  stepIndex
 * @property {string}  label
 * @property {string}  action
 * @property {string}  status   - 'passed' | 'failed' | 'error' | 'skipped'
 * @property {object}  [actionResult]
 * @property {object}  [assertionResults]
 * @property {string}  [error]
 * @property {number}  durationMs
 */

// Action types that map directly to Action Queue
const QUEUE_ACTIONS = new Set(['navigate', 'click', 'screenshot']);

// Local actions handled by the runner itself
const LOCAL_ACTIONS = new Set(['wait', 'type', 'assert-only']);

/**
 * Execute a patrol script.
 *
 * @param {PatrolScript} script   - Patrol script definition
 * @param {object}       deps     - Dependencies
 * @param {object}       deps.db  - ClawMark DB API
 * @param {string}       deps.agentId
 * @param {string}       deps.appId
 * @param {object}       [opts]
 * @param {object}       [opts.params]    - Runtime parameter overrides
 * @param {boolean}      [opts.dryRun]    - Skip assertions (AC8)
 * @param {number}       [opts.stepTimeout] - Per-step timeout ms (default: 30000)
 * @param {function}     [opts.onStep]    - Callback after each step
 * @returns {Promise<{ patrolId: string, name: string, status: string, steps: StepResult[], startTime: string, endTime: string, durationMs: number }>}
 */
async function runPatrol(script, deps, opts = {}) {
    const { db, agentId, appId } = deps;
    const params = { ...script.params, ...opts.params };
    const dryRun = opts.dryRun || false;
    const stepTimeout = opts.stepTimeout || 30000;
    const startTime = new Date().toISOString();
    const stepResults = [];

    // Accumulate context across steps (URL, console errors, etc.)
    const runContext = {
        url: null,
        consoleErrors: [],
        lastResult: null,
    };

    let overallStatus = 'passed';

    for (let i = 0; i < script.steps.length; i++) {
        const step = script.steps[i];
        const stepStart = Date.now();
        const label = step.label || `Step ${i + 1}: ${step.action}`;

        // Interpolate parameters into payload
        const payload = interpolateParams(step.payload || {}, params);

        let actionResult = null;
        let stepStatus = 'passed';
        let error = null;

        try {
            if (QUEUE_ACTIONS.has(step.action)) {
                // Execute via Action Queue
                actionResult = await executeQueueAction(
                    db, agentId, appId, step.action, payload, stepTimeout
                );

                // Update running context from action results
                if (step.action === 'navigate' && payload.url) {
                    runContext.url = payload.url;
                }
                if (actionResult?.url) {
                    runContext.url = actionResult.url;
                }
                if (actionResult?.consoleErrors) {
                    runContext.consoleErrors.push(...actionResult.consoleErrors);
                }
                runContext.lastResult = actionResult;

            } else if (step.action === 'wait') {
                const ms = payload.ms || 1000;
                await sleep(ms);

            } else if (step.action === 'type') {
                // 'type' is executed as a click + value set via action queue
                // For now, treat as a navigate-equivalent custom action
                actionResult = await executeQueueAction(
                    db, agentId, appId, 'click', payload, stepTimeout
                );
                runContext.lastResult = actionResult;

            } else if (step.action === 'assert-only') {
                // No action, just run assertions against current context

            } else {
                throw new Error(`Unknown action type: ${step.action}`);
            }
        } catch (err) {
            stepStatus = 'error';
            error = err.message;
            overallStatus = 'failed';
        }

        // Run assertions (unless dry-run or step errored)
        let assertionResults = null;
        if (step.assertions?.length > 0 && !dryRun && stepStatus !== 'error') {
            const context = {
                ...runContext,
                result: actionResult,
                url: runContext.url,
                consoleErrors: runContext.consoleErrors,
            };
            assertionResults = evaluateAll(step.assertions, context);

            if (!assertionResults.allPassed) {
                stepStatus = 'failed';
                overallStatus = 'failed';
            }
        }

        if (dryRun && step.assertions?.length > 0) {
            stepStatus = 'skipped';
        }

        const stepResult = {
            stepIndex: i,
            label,
            action: step.action,
            status: stepStatus,
            actionResult: actionResult ? summarizeResult(actionResult) : null,
            assertionResults: assertionResults || null,
            error,
            durationMs: Date.now() - stepStart,
        };

        stepResults.push(stepResult);

        if (opts.onStep) {
            opts.onStep(stepResult);
        }

        // Stop on error (action failure stops the patrol)
        if (stepStatus === 'error') {
            break;
        }
    }

    const endTime = new Date().toISOString();

    return {
        patrolId: script.id,
        name: script.name,
        status: overallStatus,
        steps: stepResults,
        startTime,
        endTime,
        durationMs: new Date(endTime) - new Date(startTime),
        dryRun,
    };
}

/**
 * Execute an action via the Action Queue and poll for result.
 */
async function executeQueueAction(db, agentId, appId, actionType, payload, timeoutMs) {
    const action = db.createAction({
        agent_id: agentId,
        app_id: appId,
        type: actionType,
        payload,
        timeout_ms: timeoutMs,
    });

    // Poll for completion
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await sleep(500);
        const current = db.getAction(action.id);
        if (!current) {
            throw new Error(`Action ${action.id} disappeared`);
        }
        if (current.status === 'completed') {
            return typeof current.result === 'string'
                ? JSON.parse(current.result)
                : current.result;
        }
        if (current.status === 'failed') {
            throw new Error(current.error || `Action ${actionType} failed`);
        }
    }

    throw new Error(`Action ${actionType} timed out after ${timeoutMs}ms`);
}

/**
 * Report patrol assertion failures as perception events.
 *
 * @param {object}   patrolResult - Output from runPatrol()
 * @param {object}   db           - ClawMark DB API
 * @param {string}   appId
 */
function reportFailures(patrolResult, db, appId) {
    const events = [];

    for (const step of patrolResult.steps) {
        if (step.status !== 'failed' || !step.assertionResults) continue;

        for (const assertion of step.assertionResults.results) {
            if (assertion.pass) continue;

            const fingerprint = crypto.createHash('sha256')
                .update(`patrol:${patrolResult.patrolId}:${step.stepIndex}:${assertion.type}:${assertion.message}`)
                .digest('hex')
                .slice(0, 16);

            events.push({
                app_id: appId,
                type: 'console-error',
                message: `[Patrol ${patrolResult.name}] ${step.label}: ${assertion.message}`,
                severity: 'error',
                url: patrolResult.steps.find(s => s.action === 'navigate')?.actionResult?.url || '',
                fingerprint: `patrol-${fingerprint}`,
                context: {
                    patrol_id: patrolResult.patrolId,
                    patrol_name: patrolResult.name,
                    step_index: step.stepIndex,
                    assertion_type: assertion.type,
                    expected: step.assertionResults,
                    actual: assertion.actual,
                },
            });
        }
    }

    if (events.length > 0) {
        db.createPerceptionEvents(events);
    }

    return events.length;
}

/**
 * Interpolate {{param}} placeholders in payload values.
 */
function interpolateParams(payload, params) {
    if (!params || Object.keys(params).length === 0) return payload;

    const result = {};
    for (const [key, val] of Object.entries(payload)) {
        if (typeof val === 'string') {
            result[key] = val.replace(/\{\{(\w+)\}\}/g, (_, name) =>
                params[name] !== undefined ? String(params[name]) : `{{${name}}}`
            );
        } else {
            result[key] = val;
        }
    }
    return result;
}

/**
 * Summarize an action result for logging (trim large fields).
 */
function summarizeResult(result) {
    if (!result) return null;
    const summary = { ...result };
    // Trim screenshot data
    if (summary.data && typeof summary.data === 'string' && summary.data.length > 200) {
        summary.data = summary.data.slice(0, 50) + '...[TRUNCATED]';
    }
    return summary;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
    runPatrol,
    reportFailures,
    interpolateParams,
    QUEUE_ACTIONS,
    LOCAL_ACTIONS,
};
