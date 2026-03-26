/**
 * ClawMark — PerfMonitor Content Script (#61 Agent Embed)
 *
 * Perception layer: captures Web Vitals and performance metrics as
 * structured perception events for the Agent Channel.
 *
 * Captures:
 *   - LCP  (Largest Contentful Paint) — threshold: >2500ms = warning, >4000ms = critical
 *   - CLS  (Cumulative Layout Shift)  — threshold: >0.1 = warning, >0.25 = critical
 *   - INP  (Interaction to Next Paint) — threshold: >200ms = warning, >500ms = critical
 *   - FCP  (First Contentful Paint)    — threshold: >1800ms = warning, >3000ms = critical
 *   - TTFB (Time to First Byte)       — threshold: >800ms = warning, >1800ms = critical
 *
 * Design:
 *   - Uses PerformanceObserver API (standard, no library dependency)
 *   - Reports once per page load (not continuous) to avoid noise
 *   - CLS is accumulated across layout-shift entries until page hide
 */

'use strict';

(() => {
    if (window.__clawmarkPerfMonitor) return;
    window.__clawmarkPerfMonitor = true;

    // ── Config ─────────────────────────────────────────────────────────

    let enabled = false;

    const THRESHOLDS = {
        lcp:  { warn: 2500, crit: 4000 },
        cls:  { warn: 0.1,  crit: 0.25 },
        inp:  { warn: 200,  crit: 500 },
        fcp:  { warn: 1800, crit: 3000 },
        ttfb: { warn: 800,  crit: 1800 },
    };

    // ── State ──────────────────────────────────────────────────────────

    const reported = new Set(); // track which metrics we've already reported
    let clsValue = 0;
    let clsEntries = [];
    const observers = [];

    // ── Helpers ────────────────────────────────────────────────────────

    function emit(event) {
        if (!enabled) return;
        try {
            chrome.runtime.sendMessage({
                type: 'perception:event',
                payload: event,
            });
        } catch {
            enabled = false;
        }
    }

    function severity(metric, value) {
        const t = THRESHOLDS[metric];
        if (!t) return 'info';
        if (value >= t.crit) return 'critical';
        if (value >= t.warn) return 'warning';
        return 'info';
    }

    function reportMetric(metric, value, detail) {
        if (reported.has(metric)) return;
        reported.add(metric);

        const sev = severity(metric, value);
        // Only report warnings and critical — info-level vitals are noise
        if (sev === 'info') return;

        const unit = metric === 'cls' ? '' : 'ms';
        const formatted = metric === 'cls' ? value.toFixed(3) : Math.round(value);

        emit({
            channel: 'perf',
            severity: sev,
            timestamp: Date.now(),
            url: location.href,
            summary: `${metric.toUpperCase()} = ${formatted}${unit} (${sev})`,
            detail: {
                type: 'web-vital',
                metric,
                value: Number(formatted),
                rating: sev,
                ...detail,
            },
            context: {},
        });
    }

    // ── Observers ──────────────────────────────────────────────────────

    function observeLCP() {
        try {
            const obs = new PerformanceObserver((list) => {
                const entries = list.getEntries();
                const last = entries[entries.length - 1];
                if (last) {
                    reportMetric('lcp', last.startTime, {
                        element: last.element ? last.element.tagName?.toLowerCase() : undefined,
                        size: last.size,
                    });
                }
            });
            obs.observe({ type: 'largest-contentful-paint', buffered: true });
            observers.push(obs);
        } catch { /* PerformanceObserver not supported for this type */ }
    }

    function observeCLS() {
        try {
            const obs = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    if (!entry.hadRecentInput) {
                        clsValue += entry.value;
                        clsEntries.push({
                            value: entry.value,
                            sources: (entry.sources || []).slice(0, 2).map(s => ({
                                node: s.node ? s.node.tagName?.toLowerCase() : undefined,
                            })),
                        });
                    }
                }
            });
            obs.observe({ type: 'layout-shift', buffered: true });
            observers.push(obs);
        } catch { /* PerformanceObserver not supported for this type */ }
    }

    function observeINP() {
        try {
            const obs = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    // INP is the worst interaction delay — report the highest
                    if (entry.duration > (reported._inpMax || 0)) {
                        reported._inpMax = entry.duration;
                    }
                }
            });
            obs.observe({ type: 'event', buffered: true, durationThreshold: 40 });
            observers.push(obs);
        } catch { /* PerformanceObserver not supported for this type */ }
    }

    function observeFCP() {
        try {
            const obs = new PerformanceObserver((list) => {
                const entries = list.getEntries();
                const fcp = entries.find(e => e.name === 'first-contentful-paint');
                if (fcp) {
                    reportMetric('fcp', fcp.startTime);
                }
            });
            obs.observe({ type: 'paint', buffered: true });
            observers.push(obs);
        } catch { /* PerformanceObserver not supported for this type */ }
    }

    function observeTTFB() {
        try {
            const nav = performance.getEntriesByType('navigation')[0];
            if (nav && nav.responseStart) {
                reportMetric('ttfb', nav.responseStart);
            }
        } catch { /* navigation timing not available */ }
    }

    // ── Lifecycle ──────────────────────────────────────────────────────

    // Report CLS and INP on page hide (final values)
    function onVisibilityChange() {
        if (document.visibilityState === 'hidden') {
            if (clsValue > 0) {
                reportMetric('cls', clsValue, {
                    entries: clsEntries.slice(-5),
                });
            }
            if (reported._inpMax > 0) {
                reportMetric('inp', reported._inpMax);
            }
        }
    }

    function startObserving() {
        observeLCP();
        observeCLS();
        observeINP();
        observeFCP();
        observeTTFB();
        document.addEventListener('visibilitychange', onVisibilityChange);
    }

    function stopObserving() {
        for (const obs of observers) {
            try { obs.disconnect(); } catch { /* ignore */ }
        }
        observers.length = 0;
        document.removeEventListener('visibilitychange', onVisibilityChange);
    }

    // ── Settings & Startup ─────────────────────────────────────────────

    async function loadSettings() {
        try {
            const settings = await chrome.storage.sync.get({
                agentPerceptionEnabled: false,
                agentPerceptionDisabledSites: [],
            });
            const siteDisabled = settings.agentPerceptionDisabledSites.includes(location.hostname);
            const shouldEnable = settings.agentPerceptionEnabled && !siteDisabled;

            if (shouldEnable && !enabled) {
                enabled = true;
                startObserving();
            } else if (!shouldEnable && enabled) {
                enabled = false;
                stopObserving();
            }
        } catch {
            // Extension context may be invalidated
        }
    }

    chrome.storage.onChanged.addListener((changes) => {
        if (changes.agentPerceptionEnabled || changes.agentPerceptionDisabledSites) {
            loadSettings();
        }
    });

    loadSettings();
})();
