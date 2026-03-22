/**
 * ClawMark --Patrol Scheduler (#79)
 *
 * Manages scheduled patrol runs using cron expressions.
 * Stores schedule state in-memory; patrols registered at startup.
 * On each tick, checks if any patrol is due and triggers execution.
 */

'use strict';

const { runPatrol, reportFailures } = require('./runner');

/**
 * Parse a cron expression into { minute, hour, dom, month, dow } arrays.
 * Supports: *, star/N, N, N-M, N,M,P (where star = asterisk)
 * @param {string} expr  Standard 5-field cron expression
 * @returns {{ minute: number[], hour: number[], dom: number[], month: number[], dow: number[] }}
 */
function parseCron(expr) {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) throw new Error(`Invalid cron expression: ${expr}`);

    return {
        minute: expandField(parts[0], 0, 59),
        hour: expandField(parts[1], 0, 23),
        dom: expandField(parts[2], 1, 31),
        month: expandField(parts[3], 1, 12),
        dow: expandField(parts[4], 0, 6),
    };
}

/**
 * Expand a single cron field into an array of matching values.
 */
function expandField(field, min, max) {
    if (field === '*') {
        return Array.from({ length: max - min + 1 }, (_, i) => min + i);
    }

    // Step: */N or N-M/S
    if (field.includes('/')) {
        const [range, stepStr] = field.split('/');
        const step = parseInt(stepStr, 10);
        let start = min;
        let end = max;
        if (range !== '*') {
            const [s, e] = range.split('-').map(Number);
            start = s;
            if (e !== undefined) end = e;
        }
        const result = [];
        for (let i = start; i <= end; i += step) {
            result.push(i);
        }
        return result;
    }

    // List: N,M,P
    if (field.includes(',')) {
        return field.split(',').map(Number);
    }

    // Range: N-M
    if (field.includes('-')) {
        const [start, end] = field.split('-').map(Number);
        return Array.from({ length: end - start + 1 }, (_, i) => start + i);
    }

    // Single value
    return [parseInt(field, 10)];
}

/**
 * Check if a Date matches a parsed cron schedule.
 */
function matchesCron(parsed, date) {
    return parsed.minute.includes(date.getMinutes()) &&
           parsed.hour.includes(date.getHours()) &&
           parsed.dom.includes(date.getDate()) &&
           parsed.month.includes(date.getMonth() + 1) &&
           parsed.dow.includes(date.getDay());
}

/**
 * Patrol Scheduler --manages registration and execution of scheduled patrols.
 */
class PatrolScheduler {
    /**
     * @param {object} deps
     * @param {object} deps.db
     * @param {string} deps.agentId
     * @param {string} deps.appId
     * @param {number} [deps.checkIntervalMs=60000] - How often to check schedules
     */
    constructor(deps) {
        this.db = deps.db;
        this.agentId = deps.agentId;
        this.appId = deps.appId;
        this.checkIntervalMs = deps.checkIntervalMs || 60000;

        this._patrols = new Map(); // id -> { script, parsed, lastRun }
        this._timer = null;
        this._running = false;
        this._onResult = deps.onResult || null; // callback for patrol results
    }

    /**
     * Register a patrol script for scheduled execution.
     * @param {object} script - Patrol script with schedule field
     * @param {object} [opts] - Runtime options (params overrides, etc.)
     */
    register(script, opts = {}) {
        if (!script.schedule) {
            throw new Error(`Patrol "${script.id}" has no schedule`);
        }

        this._patrols.set(script.id, {
            script,
            opts,
            parsed: parseCron(script.schedule),
            lastRun: null,
        });
    }

    /**
     * Unregister a patrol script.
     * @param {string} patrolId
     */
    unregister(patrolId) {
        this._patrols.delete(patrolId);
    }

    /**
     * Start the scheduler. Checks every checkIntervalMs for due patrols.
     */
    start() {
        if (this._timer) return;
        this._timer = setInterval(() => this._tick(), this.checkIntervalMs);
    }

    /**
     * Stop the scheduler.
     */
    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    /**
     * Get status of all registered patrols.
     * @returns {Array<{ id: string, name: string, schedule: string, lastRun: string|null }>}
     */
    getStatus() {
        return [...this._patrols.entries()].map(([id, entry]) => ({
            id,
            name: entry.script.name,
            schedule: entry.script.schedule,
            lastRun: entry.lastRun,
        }));
    }

    /**
     * Check for due patrols and execute them.
     * @private
     */
    async _tick() {
        if (this._running) return; // prevent overlap
        this._running = true;

        try {
            const now = new Date();

            for (const [id, entry] of this._patrols) {
                // Skip if already ran this minute
                if (entry.lastRun) {
                    const lastRunMinute = new Date(entry.lastRun);
                    lastRunMinute.setSeconds(0, 0);
                    const nowMinute = new Date(now);
                    nowMinute.setSeconds(0, 0);
                    if (lastRunMinute.getTime() === nowMinute.getTime()) continue;
                }

                if (matchesCron(entry.parsed, now)) {
                    entry.lastRun = now.toISOString();

                    try {
                        const result = await runPatrol(entry.script, {
                            db: this.db,
                            agentId: this.agentId,
                            appId: this.appId,
                        }, entry.opts);

                        // Report failures to perception pipeline
                        if (result.status === 'failed') {
                            reportFailures(result, this.db, this.appId);
                        }

                        if (this._onResult) {
                            this._onResult(result);
                        }
                    } catch (err) {
                        // Log but don't crash scheduler
                        console.error(`Patrol "${id}" execution error:`, err.message);
                    }
                }
            }
        } finally {
            this._running = false;
        }
    }
}

module.exports = {
    PatrolScheduler,
    parseCron,
    matchesCron,
};
