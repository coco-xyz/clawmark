/**
 * ClawMark — Session Analyzer (#74)
 *
 * Correlates session replay data with perception error events.
 * Given a perception error, finds the matching session segment (configurable
 * time window around the error) and returns correlated session events + snapshots.
 */

'use strict';

const DEFAULT_BEFORE_MS = 30000; // 30s before error
const DEFAULT_AFTER_MS  = 10000; // 10s after error

/**
 * Find sessions that overlap a given timestamp.
 *
 * @param {object}   db        - ClawMark DB API
 * @param {string}   appId     - App context
 * @param {string}   errorTime - ISO 8601 timestamp of the error
 * @param {string}   [url]     - Page URL to narrow session search
 * @returns {object[]} Matching sessions
 */
function findOverlappingSessions(db, appId, errorTime, url) {
    const sessions = db.listSessions({
        app_id: appId,
        site: url ? new URL(url).hostname : undefined,
        limit: 50,
    });

    const errorTs = new Date(errorTime).getTime();
    return sessions.filter(s => {
        const start = new Date(s.start_time).getTime();
        const end = s.end_time ? new Date(s.end_time).getTime() : Date.now();
        return errorTs >= start && errorTs <= end;
    });
}

/**
 * Fetch session events in a time window around an error.
 *
 * @param {object}   db        - ClawMark DB API
 * @param {string}   sessionId - Session to query
 * @param {string}   errorTime - ISO 8601 timestamp of the error
 * @param {object}   [opts]
 * @param {number}   [opts.beforeMs] - Window before error (default: 30000)
 * @param {number}   [opts.afterMs]  - Window after error (default: 10000)
 * @returns {object[]} Session events in the window, ordered by timestamp
 */
function getSessionSegment(db, sessionId, errorTime, opts = {}) {
    const beforeMs = opts.beforeMs ?? DEFAULT_BEFORE_MS;
    const afterMs  = opts.afterMs  ?? DEFAULT_AFTER_MS;

    const errorTs = new Date(errorTime).getTime();
    const startTime = new Date(errorTs - beforeMs).toISOString();
    const endTime   = new Date(errorTs + afterMs).toISOString();

    return db.getSessionEvents(sessionId, { start_time: startTime, end_time: endTime });
}

/**
 * Identify the user action that most likely triggered the error.
 * Looks backwards from the error timestamp for the most recent user-initiated event.
 *
 * @param {object[]} events   - Session events (ordered by timestamp ASC)
 * @param {string}   errorTime - ISO 8601 timestamp of the error
 * @returns {object|null} The triggering event, or null
 */
function findTriggeringAction(events, errorTime) {
    const userActionTypes = new Set(['click', 'scroll']);
    const errorTs = new Date(errorTime).getTime();

    let candidate = null;
    for (const evt of events) {
        const evtTs = new Date(evt.timestamp).getTime();
        if (evtTs > errorTs) break;
        if (userActionTypes.has(evt.type)) {
            candidate = evt;
        }
    }
    return candidate;
}

/**
 * Full correlation: given a perception error event, find the best matching
 * session and return correlated context.
 *
 * @param {object}   db          - ClawMark DB API
 * @param {object}   errorEvent  - Perception event object
 * @param {object}   [opts]
 * @param {number}   [opts.beforeMs]
 * @param {number}   [opts.afterMs]
 * @returns {object|null} { session, events, trigger, snapshots } or null if no session found
 */
function correlate(db, errorEvent, opts = {}) {
    const appId = errorEvent.app_id;
    const errorTime = errorEvent.created_at;

    const sessions = findOverlappingSessions(db, appId, errorTime, errorEvent.url);
    if (sessions.length === 0) return null;

    // Prefer session whose URL matches the error URL most closely
    let bestSession = sessions[0];
    if (errorEvent.url && sessions.length > 1) {
        for (const s of sessions) {
            if (s.url && errorEvent.url.startsWith(s.url)) {
                bestSession = s;
                break;
            }
        }
    }

    const events = getSessionSegment(db, bestSession.id, errorTime, opts);
    const trigger = findTriggeringAction(events, errorTime);
    const snapshots = db.getSessionSnapshots(bestSession.id);

    // Find closest snapshot to error time
    let closestSnapshot = null;
    if (snapshots.length > 0) {
        const errorTs = new Date(errorTime).getTime();
        let minDist = Infinity;
        for (const snap of snapshots) {
            const dist = Math.abs(new Date(snap.timestamp).getTime() - errorTs);
            if (dist < minDist) {
                minDist = dist;
                closestSnapshot = snap;
            }
        }
    }

    return {
        session: bestSession,
        events,
        trigger,
        closestSnapshot,
    };
}

module.exports = {
    findOverlappingSessions,
    getSessionSegment,
    findTriggeringAction,
    correlate,
    DEFAULT_BEFORE_MS,
    DEFAULT_AFTER_MS,
};
