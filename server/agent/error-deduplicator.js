/**
 * ClawMark — Error Deduplicator (#69)
 *
 * Groups similar errors by fingerprint (message + stack trace signature).
 * Determines whether a perception event represents a new unique error
 * or a duplicate of an already-tracked issue.
 */

'use strict';

const crypto = require('crypto');

/**
 * Generate a stable fingerprint from error properties.
 * Uses message + stack trace signature (first 3 frames) + error type.
 *
 * @param {object} event - Perception event
 * @returns {string} Hex fingerprint
 */
function generateFingerprint(event) {
    const parts = [
        event.type || 'unknown',
        normalizeMessage(event.message || ''),
        normalizeStack(event.stack || ''),
    ];
    return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

/**
 * Normalize error message for dedup — strip variable parts like IDs, timestamps, URLs.
 */
function normalizeMessage(msg) {
    return msg
        .replace(/https?:\/\/[^\s"']+/g, '<URL>')        // URLs
        .replace(/\b[0-9a-f]{8,}\b/gi, '<HEX>')          // hex IDs
        .replace(/\b\d{10,}\b/g, '<NUM>')                 // timestamps/large numbers
        .replace(/\d+/g, 'N')                             // all remaining numbers
        .trim();
}

/**
 * Normalize stack trace — extract first 3 meaningful frames, strip line/col numbers.
 */
function normalizeStack(stack) {
    if (!stack) return '';
    const frames = stack.split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('at '))
        .slice(0, 3)
        .map(frame => frame.replace(/:\d+:\d+\)?$/, '').replace(/https?:\/\/[^/]+/, ''));
    return frames.join('\n');
}

/**
 * Deduplicate a batch of perception events.
 * Returns groups keyed by fingerprint, with event count and representative event.
 *
 * @param {Array} events - Raw perception events
 * @returns {Map<string, { fingerprint, count, representative, events }>}
 */
function deduplicateEvents(events) {
    const groups = new Map();

    for (const event of events) {
        const fp = event.fingerprint || generateFingerprint(event);
        if (groups.has(fp)) {
            const group = groups.get(fp);
            group.count++;
            group.events.push(event);
            // Keep the most recent as representative
            if (event.created_at > group.representative.created_at) {
                group.representative = event;
            }
        } else {
            groups.set(fp, {
                fingerprint: fp,
                count: 1,
                representative: event,
                events: [event],
            });
        }
    }

    return groups;
}

/**
 * Filter events that exceed a severity threshold.
 *
 * @param {Array} events
 * @param {string} minSeverity - 'error' or 'warning'
 * @returns {Array}
 */
function filterBySeverity(events, minSeverity = 'error') {
    const severityOrder = { critical: 0, error: 1, warning: 2, info: 3 };
    const threshold = severityOrder[minSeverity] ?? 1;
    return events.filter(e => (severityOrder[e.severity] ?? 1) <= threshold);
}

module.exports = {
    generateFingerprint,
    normalizeMessage,
    normalizeStack,
    deduplicateEvents,
    filterBySeverity,
};
