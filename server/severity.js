/**
 * ClawMark — Auto-Severity Mapping (#44)
 *
 * Maps item classification and context to P0-P3 priority labels
 * for GitLab issue filing.
 *
 * Severity levels:
 *   P0 — Critical: service down, data loss, security breach
 *   P1 — High: major feature broken, HTTP 5xx, unhandled exceptions
 *   P2 — Medium: degraded experience, console errors, spinner timeouts
 *   P3 — Low: cosmetic issues, warnings, minor UX friction
 */

'use strict';

/**
 * Determine severity label from item data.
 *
 * @param {object} item  ClawMark item (classification, priority, type, quote, tags, etc.)
 * @returns {{ severity: string, label: string, confidence: string }}
 */
function autoSeverity(item) {
    const classification = (item.classification || '').toLowerCase();
    const priority = (item.priority || 'normal').toLowerCase();
    const quote = (item.quote || '').toLowerCase();
    const content = (item.title || item.message || '').toLowerCase();
    const text = `${quote} ${content}`;
    const tags = Array.isArray(item.tags)
        ? item.tags
        : (typeof item.tags === 'string' ? JSON.parse(item.tags || '[]') : []);
    const tagSet = new Set(tags.map(t => String(t).toLowerCase()));

    // P0: Critical — service down, blank page, data loss
    if (priority === 'critical') return sev('P0', 'Critical', 'high');
    if (/blank.?page|white.?screen|service.?down|data.?loss|security/i.test(text)) {
        return sev('P0', 'Critical', 'medium');
    }
    if (tagSet.has('blank-page') || tagSet.has('service-down') || tagSet.has('security')) {
        return sev('P0', 'Critical', 'medium');
    }

    // P1: High — 5xx errors, unhandled exceptions, major feature broken
    if (priority === 'high') return sev('P1', 'High', 'high');
    if (/5\d{2}\b|http\s*5|internal.?server|unhandled|uncaught|fatal|crash/i.test(text)) {
        return sev('P1', 'High', 'medium');
    }
    if (classification === 'bug' && /error|exception|fail/i.test(text)) {
        return sev('P1', 'High', 'medium');
    }
    if (tagSet.has('http-5xx') || tagSet.has('crash') || tagSet.has('exception')) {
        return sev('P1', 'High', 'medium');
    }

    // P2: Medium — console errors, 4xx, spinner timeouts, degraded UX
    if (classification === 'bug') return sev('P2', 'Medium', 'high');
    if (/4\d{2}\b|http\s*4|timeout|spinner|loading|console\.error/i.test(text)) {
        return sev('P2', 'Medium', 'medium');
    }
    if (tagSet.has('http-4xx') || tagSet.has('timeout') || tagSet.has('console-error')) {
        return sev('P2', 'Medium', 'medium');
    }

    // P3: Low — warnings, cosmetic, feature requests, general feedback
    if (classification === 'feature_request') return sev('P3', 'Low', 'high');
    if (classification === 'question' || classification === 'praise' || classification === 'general') {
        return sev('P3', 'Low', 'medium');
    }
    if (/warning|warn|typo|cosmetic|alignment|spacing/i.test(text)) {
        return sev('P3', 'Low', 'medium');
    }

    // Default: P2 Medium for bugs, P3 for everything else
    if (classification === 'bug') return sev('P2', 'Medium', 'low');
    return sev('P3', 'Low', 'low');
}

function sev(severity, label, confidence) {
    return { severity, label, confidence };
}

module.exports = { autoSeverity };
