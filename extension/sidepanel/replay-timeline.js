/**
 * ClawMark — Replay Timeline (#75 Phase 2)
 *
 * Visual timeline for session replay with event markers and playback controls.
 * Renders click/input/scroll events as markers on a horizontal timeline,
 * highlights errors in red, and provides play/pause, speed, and seek controls.
 *
 * Depends on: panel.js (loaded after, shares globals via window)
 */

'use strict';

const ReplayTimeline = (() => {
    // ── State ───────────────────────────────────────────────────────────

    let session = null;       // Full session data { events, snapshots, ... }
    let allEvents = [];       // Merged + sorted events (events + snapshots)
    let duration = 0;         // Session duration in ms
    let sessionStart = 0;     // Session start timestamp

    let playing = false;
    let playbackSpeed = 1;
    let currentTime = 0;      // Current playback position in ms (relative to session start)
    let playTimer = null;
    let lastTickTime = 0;

    const SPEEDS = [0.5, 1, 2, 4];
    const TICK_INTERVAL = 50;  // ms between playback ticks

    // ── DOM refs (set on mount) ─────────────────────────────────────────

    let container = null;
    let timelineTrack = null;
    let playhead = null;
    let playBtn = null;
    let speedBtn = null;
    let timeDisplay = null;
    let eventDetail = null;
    let eventList = null;

    // ── Public API ──────────────────────────────────────────────────────

    function mount(containerEl) {
        stop(); // P1-1: clear any running playback before replacing DOM
        container = containerEl;
        container.innerHTML = buildHTML();
        bindElements();
        bindEvents();
    }

    async function loadSession(tabId, sessionId) {
        if (!container) return;

        showLoading();

        try {
            const result = await chrome.runtime.sendMessage({
                type: 'GET_SESSION',
                tabId,
                sessionId,
            });

            if (!result || (!result.events && !result.snapshots)) {
                showEmpty('Session data not found.');
                return;
            }

            session = result;
            processSession();
            render();
        } catch (err) {
            showError(err.message);
        }
    }

    function unmount() {
        stop();
        session = null;
        allEvents = [];
        if (container) container.innerHTML = '';
    }

    // ── Session processing ──────────────────────────────────────────────

    function processSession() {
        // Merge events and snapshots, sort by timestamp
        const events = (session.events || []).map(e => ({ ...e, _isSnapshot: false }));
        const snaps = (session.snapshots || []).map(e => ({ ...e, _isSnapshot: true }));
        allEvents = [...events, ...snaps].sort((a, b) => a.timestamp - b.timestamp);

        if (allEvents.length === 0) return;

        sessionStart = session.startTime || allEvents[0].timestamp;
        const lastEvent = allEvents[allEvents.length - 1];
        duration = Math.max(lastEvent.timestamp - sessionStart, 1000); // At least 1s

        currentTime = 0;
    }

    // ── Rendering ───────────────────────────────────────────────────────

    function buildHTML() {
        return `
            <div class="replay-header">
                <div class="replay-info">
                    <span class="replay-url"></span>
                    <span class="replay-stats"></span>
                </div>
            </div>
            <div class="replay-controls">
                <button class="replay-play-btn" title="Play/Pause">&#9654;</button>
                <span class="replay-time">0:00 / 0:00</span>
                <button class="replay-speed-btn" title="Playback speed">1x</button>
            </div>
            <div class="replay-timeline-track">
                <div class="replay-markers"></div>
                <div class="replay-playhead"></div>
            </div>
            <div class="replay-event-detail" style="display:none;"></div>
            <div class="replay-event-list"></div>
        `;
    }

    function bindElements() {
        playBtn = container.querySelector('.replay-play-btn');
        speedBtn = container.querySelector('.replay-speed-btn');
        timeDisplay = container.querySelector('.replay-time');
        timelineTrack = container.querySelector('.replay-timeline-track');
        playhead = container.querySelector('.replay-playhead');
        eventDetail = container.querySelector('.replay-event-detail');
        eventList = container.querySelector('.replay-event-list');
    }

    function bindEvents() {
        playBtn.addEventListener('click', togglePlay);
        speedBtn.addEventListener('click', cycleSpeed);
        timelineTrack.addEventListener('click', onTimelineClick);
    }

    function render() {
        if (!session || allEvents.length === 0) {
            showEmpty('No events in this session.');
            return;
        }

        // Header info
        const hostname = session.url ? (() => { try { return new URL(session.url).hostname; } catch { return session.url; } })() : 'Unknown';
        const errorCount = allEvents.filter(e => e.type === 'error').length;
        container.querySelector('.replay-url').textContent = hostname;
        container.querySelector('.replay-stats').textContent =
            `${allEvents.length} events${errorCount ? ` \u00B7 ${errorCount} errors` : ''} \u00B7 ${formatDurationShort(duration)}`;

        renderMarkers();
        renderEventList();
        updatePlayhead();
        updateTimeDisplay();
    }

    function renderMarkers() {
        const markersEl = container.querySelector('.replay-markers');
        markersEl.innerHTML = '';

        for (let i = 0; i < allEvents.length; i++) {
            const ev = allEvents[i];
            const pos = ((ev.timestamp - sessionStart) / duration) * 100;
            const marker = document.createElement('div');
            marker.className = `replay-marker replay-marker-${ev.type}`;
            if (ev.type === 'error') marker.classList.add('replay-marker-error');
            if (ev._isSnapshot) marker.classList.add('replay-marker-snapshot');
            marker.style.left = `${pos}%`;
            marker.title = markerTooltip(ev);
            marker.dataset.index = i;
            marker.addEventListener('click', (e) => {
                e.stopPropagation();
                seekToEvent(i);
            });
            markersEl.appendChild(marker);
        }
    }

    function renderEventList() {
        // Show filterable event list below timeline
        const significantEvents = allEvents.filter(e =>
            e.type === 'click' || e.type === 'input' || e.type === 'error' || e.type === 'navigation'
        );

        if (significantEvents.length === 0) {
            eventList.innerHTML = '<div class="replay-empty-events">No significant events.</div>';
            return;
        }

        eventList.innerHTML = significantEvents.map((ev) => {
            const realIdx = allEvents.indexOf(ev);
            const relTime = ev.timestamp - sessionStart;
            const isError = ev.type === 'error';
            return `
                <div class="replay-event-row${isError ? ' replay-event-error' : ''}" data-index="${realIdx}">
                    <span class="replay-event-time">${formatDurationShort(relTime)}</span>
                    <span class="replay-event-icon">${eventIcon(ev)}</span>
                    <span class="replay-event-desc">${eventDescription(ev)}</span>
                </div>
            `;
        }).join('');

        eventList.querySelectorAll('.replay-event-row').forEach(row => {
            row.addEventListener('click', () => {
                seekToEvent(parseInt(row.dataset.index, 10));
            });
        });
    }

    function showEventDetail(ev) {
        if (!ev) {
            eventDetail.style.display = 'none';
            return;
        }

        eventDetail.style.display = 'block';
        const relTime = ev.timestamp - sessionStart;

        let detailContent = `
            <div class="replay-detail-header">
                <span class="replay-event-icon">${eventIcon(ev)}</span>
                <strong>${ev.type}</strong>
                <span class="replay-detail-time">${formatDurationShort(relTime)}</span>
                <button class="replay-detail-close">&times;</button>
            </div>
            <div class="replay-detail-body">
        `;

        const d = ev.data || {};

        if (ev.type === 'error') {
            detailContent += `
                <div class="replay-detail-field"><label>Message:</label><span>${escapeHtmlSafe(d.message || '')}</span></div>
                ${d.source ? `<div class="replay-detail-field"><label>Source:</label><span>${escapeHtmlSafe(d.source)}${d.line ? `:${d.line}` : ''}${d.col ? `:${d.col}` : ''}</span></div>` : ''}
                ${d.type ? `<div class="replay-detail-field"><label>Type:</label><span>${escapeHtmlSafe(d.type)}</span></div>` : ''}
            `;
        } else if (ev.type === 'click') {
            detailContent += `
                <div class="replay-detail-field"><label>Element:</label><span>${escapeHtmlSafe(d.tag || '')} ${escapeHtmlSafe(d.selector || '')}</span></div>
                ${d.text ? `<div class="replay-detail-field"><label>Text:</label><span>${escapeHtmlSafe(d.text)}</span></div>` : ''}
                ${d.href ? `<div class="replay-detail-field"><label>Link:</label><span>${escapeHtmlSafe(d.href)}</span></div>` : ''}
                <div class="replay-detail-field"><label>Position:</label><span>(${d.x}, ${d.y})</span></div>
            `;
        } else if (ev.type === 'input') {
            detailContent += `
                <div class="replay-detail-field"><label>Element:</label><span>${escapeHtmlSafe(d.tag || '')}[${escapeHtmlSafe(d.inputType || '')}] ${escapeHtmlSafe(d.name || '')}</span></div>
                <div class="replay-detail-field"><label>Value:</label><span>${d.masked ? '\u2022\u2022\u2022\u2022' : escapeHtmlSafe(d.value || '')}</span></div>
            `;
        } else if (ev.type === 'navigation') {
            detailContent += `
                <div class="replay-detail-field"><label>Action:</label><span>${escapeHtmlSafe(d.action || '')}</span></div>
                ${d.url ? `<div class="replay-detail-field"><label>URL:</label><span>${escapeHtmlSafe(d.url)}</span></div>` : ''}
                ${d.reason ? `<div class="replay-detail-field"><label>Reason:</label><span>${escapeHtmlSafe(d.reason)}</span></div>` : ''}
            `;
        } else if (ev.type === 'scroll') {
            detailContent += `
                <div class="replay-detail-field"><label>Position:</label><span>(${d.x}, ${d.y}) / ${d.maxY}</span></div>
            `;
        }

        detailContent += '</div>';
        eventDetail.innerHTML = detailContent;

        eventDetail.querySelector('.replay-detail-close')?.addEventListener('click', () => {
            eventDetail.style.display = 'none';
        });
    }

    // ── Playback engine ─────────────────────────────────────────────────

    function togglePlay() {
        if (playing) {
            pause();
        } else {
            play();
        }
    }

    function play() {
        if (allEvents.length === 0) return;

        // If at end, restart
        if (currentTime >= duration) {
            currentTime = 0;
        }

        playing = true;
        lastTickTime = Date.now();
        playBtn.innerHTML = '&#9646;&#9646;'; // Pause icon
        playBtn.title = 'Pause';

        playTimer = setInterval(tick, TICK_INTERVAL);
    }

    function pause() {
        playing = false;
        playBtn.innerHTML = '&#9654;'; // Play icon
        playBtn.title = 'Play';
        if (playTimer) {
            clearInterval(playTimer);
            playTimer = null;
        }
    }

    function stop() {
        pause();
        currentTime = 0;
    }

    function tick() {
        const now = Date.now();
        const elapsed = (now - lastTickTime) * playbackSpeed;
        lastTickTime = now;

        currentTime += elapsed;

        if (currentTime >= duration) {
            currentTime = duration;
            pause();
        }

        updatePlayhead();
        updateTimeDisplay();
        highlightCurrentEvent();
    }

    function cycleSpeed() {
        const idx = SPEEDS.indexOf(playbackSpeed);
        playbackSpeed = SPEEDS[(idx + 1) % SPEEDS.length];
        speedBtn.textContent = `${playbackSpeed}x`;
    }

    function seekTo(timeMs) {
        currentTime = Math.max(0, Math.min(timeMs, duration));
        updatePlayhead();
        updateTimeDisplay();
        highlightCurrentEvent();
    }

    function seekToEvent(index) {
        if (index < 0 || index >= allEvents.length) return;
        const ev = allEvents[index];
        seekTo(ev.timestamp - sessionStart);
        showEventDetail(ev);
    }

    function onTimelineClick(e) {
        if (allEvents.length === 0) return;
        const rect = timelineTrack.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        seekTo(ratio * duration);

        // Find nearest event
        const targetTime = sessionStart + currentTime;
        let nearest = 0;
        let minDist = Infinity;
        for (let i = 0; i < allEvents.length; i++) {
            const dist = Math.abs(allEvents[i].timestamp - targetTime);
            if (dist < minDist) {
                minDist = dist;
                nearest = i;
            }
        }
        showEventDetail(allEvents[nearest]);
    }

    function updatePlayhead() {
        if (!playhead || duration === 0) return;
        const pct = (currentTime / duration) * 100;
        playhead.style.left = `${pct}%`;
    }

    function updateTimeDisplay() {
        if (!timeDisplay) return;
        timeDisplay.textContent = `${formatDurationShort(currentTime)} / ${formatDurationShort(duration)}`;
    }

    function highlightCurrentEvent() {
        // Highlight the event row closest to current time
        const targetTime = sessionStart + currentTime;
        const rows = eventList.querySelectorAll('.replay-event-row');
        let nearestRow = null;
        let minDist = Infinity;

        rows.forEach(row => {
            row.classList.remove('replay-event-active');
            const idx = parseInt(row.dataset.index, 10);
            if (idx >= 0 && idx < allEvents.length) {
                const dist = Math.abs(allEvents[idx].timestamp - targetTime);
                if (dist < minDist) {
                    minDist = dist;
                    nearestRow = row;
                }
            }
        });

        if (nearestRow) {
            nearestRow.classList.add('replay-event-active');
            // Scroll into view if needed
            nearestRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    function eventIcon(ev) {
        switch (ev.type) {
            case 'click': return '\uD83D\uDDB1';      // mouse
            case 'input': return '\u2328';              // keyboard
            case 'scroll': return '\u2195';             // up/down arrows
            case 'error': return '\u26A0';              // warning
            case 'navigation': return '\uD83D\uDDFA';  // map
            case 'snapshot': return '\uD83D\uDCF8';    // camera
            default: return '\u25CF';                   // dot
        }
    }

    function eventDescription(ev) {
        const d = ev.data || {};
        switch (ev.type) {
            case 'click':
                return `Click ${escapeHtmlSafe(d.tag || '')}${d.text ? ` "${escapeHtmlSafe(d.text.slice(0, 30))}"` : ''}`;
            case 'input':
                return `Input ${escapeHtmlSafe(d.tag || '')}[${escapeHtmlSafe(d.inputType || '')}]${d.name ? ` name="${escapeHtmlSafe(d.name)}"` : ''}`;
            case 'error':
                return escapeHtmlSafe((d.message || 'Unknown error').slice(0, 80));
            case 'navigation':
                return escapeHtmlSafe(d.action || 'navigate');
            case 'scroll':
                return `Scroll to (${d.x}, ${d.y})`;
            default:
                return ev.type;
        }
    }

    function markerTooltip(ev) {
        const relTime = formatDurationShort(ev.timestamp - sessionStart);
        return `[${relTime}] ${ev.type}: ${eventDescriptionPlain(ev)}`;
    }

    function eventDescriptionPlain(ev) {
        const d = ev.data || {};
        switch (ev.type) {
            case 'click':
                return `Click ${d.tag || ''}${d.text ? ` "${d.text.slice(0, 30)}"` : ''}`;
            case 'input':
                return `Input ${d.tag || ''}[${d.inputType || ''}]${d.name ? ` name="${d.name}"` : ''}`;
            case 'error':
                return (d.message || 'Unknown error').slice(0, 80);
            case 'navigation':
                return d.action || 'navigate';
            case 'scroll':
                return `Scroll to (${d.x}, ${d.y})`;
            default:
                return ev.type;
        }
    }

    function formatDurationShort(ms) {
        if (ms == null || ms < 0) ms = 0;
        const totalSec = Math.floor(ms / 1000);
        const min = Math.floor(totalSec / 60);
        const sec = totalSec % 60;
        return `${min}:${sec.toString().padStart(2, '0')}`;
    }

    function escapeHtmlSafe(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function showLoading() {
        if (!container) return;
        const list = container.querySelector('.replay-event-list');
        if (list) list.innerHTML = '<div class="replay-loading">Loading session...</div>';
    }

    function showEmpty(msg) {
        if (!container) return;
        const list = container.querySelector('.replay-event-list');
        if (list) list.innerHTML = `<div class="replay-empty-events">${escapeHtmlSafe(msg)}</div>`;
    }

    function showError(msg) {
        if (!container) return;
        const list = container.querySelector('.replay-event-list');
        if (list) list.innerHTML = `<div class="replay-error">${escapeHtmlSafe(msg)}</div>`;
    }

    // ── Exports ─────────────────────────────────────────────────────────

    return { mount, loadSession, unmount, stop };
})();
