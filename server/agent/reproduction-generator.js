/**
 * ClawMark — Reproduction Steps Generator (#74)
 *
 * Analyzes session event sequences leading to an error and produces
 * human-readable reproduction steps for issue reports.
 */

'use strict';

/**
 * Describe a single session event in human-readable language.
 *
 * @param {object} event - Session event { type, timestamp, data }
 * @returns {string} Human-readable description
 */
function describeEvent(event) {
    let data = {};
    try { data = typeof event.data === 'string' ? JSON.parse(event.data) : (event.data || {}); } catch {}

    switch (event.type) {
        case 'click': {
            const target = data.selector || data.tag || 'element';
            const text = data.text ? ` "${data.text.slice(0, 40)}"` : '';
            return `Click on ${target}${text}`;
        }
        case 'scroll':
            return `Scroll ${data.direction || 'page'}${data.position ? ` to ${data.position}` : ''}`;
        case 'console-error':
            return `Console error: ${(data.message || '').slice(0, 80)}`;
        case 'console-log':
            return `Console log: ${(data.message || '').slice(0, 80)}`;
        case 'network-error': {
            const method = data.method || 'GET';
            const url = data.url || 'unknown';
            const status = data.status ? ` (${data.status})` : '';
            return `Network error: ${method} ${url.slice(0, 80)}${status}`;
        }
        case 'dom-mutation':
            return `DOM change: ${(data.summary || data.type || 'mutation').slice(0, 60)}`;
        default:
            return `${event.type}: ${JSON.stringify(data).slice(0, 60)}`;
    }
}

/**
 * Generate ordered reproduction steps from a session event sequence.
 * Filters to user-visible actions and significant events.
 *
 * @param {object[]} events    - Session events ordered by timestamp ASC
 * @param {string}   errorTime - ISO 8601 timestamp of the error
 * @param {object}   [opts]
 * @param {number}   [opts.maxSteps] - Maximum number of steps (default: 15)
 * @returns {string[]} Ordered reproduction steps
 */
function generateSteps(events, errorTime, opts = {}) {
    const maxSteps = opts.maxSteps ?? 15;
    const errorTs = new Date(errorTime).getTime();

    // Only include events before or at error time
    const preError = events.filter(e => new Date(e.timestamp).getTime() <= errorTs);

    // Prioritize user actions and significant events
    const significant = preError.filter(e =>
        e.type === 'click' || e.type === 'scroll' ||
        e.type === 'network-error' || e.type === 'console-error'
    );

    // If too few significant events, include all pre-error events
    const source = significant.length >= 2 ? significant : preError;

    // Take the last N events leading to the error
    const relevant = source.slice(-maxSteps);

    return relevant.map((evt, i) => {
        const desc = describeEvent(evt);
        return `${i + 1}. ${desc}`;
    });
}

/**
 * Generate a full reproduction report combining steps with error context.
 *
 * @param {object}   correlation - Output from session-analyzer.correlate()
 * @param {object}   errorEvent  - The perception error event
 * @param {object}   [opts]
 * @param {number}   [opts.maxSteps]
 * @returns {object} { steps: string[], trigger: string|null, timeline: string }
 */
function generateReport(correlation, errorEvent, opts = {}) {
    const steps = generateSteps(correlation.events, errorEvent.created_at, opts);

    let trigger = null;
    if (correlation.trigger) {
        trigger = describeEvent(correlation.trigger);
    }

    // Build a compact timeline string for issue descriptions
    const timelineLines = [];
    if (correlation.session.url) {
        timelineLines.push(`Page: ${correlation.session.url}`);
    }
    if (steps.length > 0) {
        timelineLines.push('', '### Steps to reproduce', '');
        timelineLines.push(...steps);
    }
    if (trigger) {
        timelineLines.push('', `**Triggering action**: ${trigger}`);
    }
    timelineLines.push('', `**Error occurred at**: ${errorEvent.created_at}`);

    return {
        steps,
        trigger,
        timeline: timelineLines.join('\n'),
    };
}

module.exports = {
    describeEvent,
    generateSteps,
    generateReport,
};
