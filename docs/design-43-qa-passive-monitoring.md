# Design: QA Passive Monitoring Mode (#43)

## Overview

Add passive error detection during manual testing. ClawMark automatically captures console errors, network failures, and UI exceptions while the user browses — no manual action needed. Detected issues appear in the side panel and can be filed as issues with one click.

## Anomaly Types

| Category | What we capture | Priority |
|----------|----------------|----------|
| **Console errors** | `window.onerror`, `unhandledrejection`, `console.error` calls | P1 |
| **Network failures** | Fetch/XHR 4xx/5xx responses, timeouts, CORS errors | P1 |
| **Resource errors** | Failed image/script/CSS loads (`error` event on elements) | P2 |
| **Performance** | Long tasks (>200ms via PerformanceObserver), layout shifts (CLS >0.1) | P3 |

## Architecture

```
Content Script (inject.js)          Service Worker              Server
┌──────────────────────┐     ┌─────────────────────┐    ┌──────────────┐
│ ErrorMonitor module   │────▶│ Store in IndexedDB   │    │ Existing API │
│ - window.onerror      │     │ Batch + dedupe       │    │ POST /items  │
│ - fetch/XHR intercept │     │ Badge count update   │    └──────────────┘
│ - PerformanceObserver │     │                      │           ▲
│ - Resource error      │     │ On user action:      │───────────┘
└──────────────────────┘     │ file issue via API   │
         ▲                    └─────────────────────┘
         │                            │
   Page context                Side Panel UI
   (MV3 world: MAIN)          shows error list
```

### Implementation Approach: Content Script

**Why content script (not devtools panel):**
- Always active — no need to open DevTools
- Consistent with existing ClawMark injection model
- Can intercept fetch/XHR before they fire
- Side panel already exists for display

**Why not devtools panel:**
- Requires user to open DevTools first — defeats "passive" goal
- Separate extension context, harder to integrate with existing annotation flow

### Content Script: `ErrorMonitor` Module

Add to `inject.js` (gated by injection check, same as existing features):

```js
const ErrorMonitor = {
  errors: [],

  start() {
    // Console errors
    window.addEventListener('error', e => this.capture('js_error', e));
    window.addEventListener('unhandledrejection', e => this.capture('promise_rejection', e));

    // Network: patch fetch + XHR
    this._patchFetch();
    this._patchXHR();

    // Resource load failures
    document.addEventListener('error', e => {
      if (e.target.tagName) this.capture('resource_error', e);
    }, true);

    // Performance (optional, P3)
    if (window.PerformanceObserver) {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          if (entry.duration > 200) this.capture('long_task', entry);
        }
      }).observe({ type: 'longtask', buffered: true });
    }
  },

  capture(type, detail) {
    const error = {
      type,
      message: this._extractMessage(detail),
      url: location.href,
      timestamp: Date.now(),
      stack: detail?.error?.stack || null,
      fingerprint: null // deduplication key
    };
    error.fingerprint = this._fingerprint(error);

    // Deduplicate: same fingerprint within 5s = skip
    if (this.errors.some(e => e.fingerprint === error.fingerprint &&
        Date.now() - e.timestamp < 5000)) return;

    this.errors.push(error);
    chrome.runtime.sendMessage({ type: 'error:captured', data: error });
  }
};
```

### Service Worker Storage

Store errors in `chrome.storage.local` (not IndexedDB — simpler, sufficient for this scale):

```js
// In service-worker.js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'error:captured') {
    storeError(sender.tab.id, msg.data);
    updateBadge(sender.tab.id);
  }
});
```

- **Per-tab storage**: errors keyed by `tab.id` — cleared on navigation
- **Badge**: show error count on extension icon (red badge)
- **Max 100 errors per tab** — oldest dropped (ring buffer)

### Side Panel UI

Add "Errors" tab to existing side panel:

```
┌─────────────────────────────┐
│ [Annotations] [Errors (3)]  │  ← tab bar
├─────────────────────────────┤
│ 🔴 TypeError: Cannot read   │
│    property 'map' of null   │
│    dashboard.js:142          │
│    [File Issue] [Dismiss]    │
│                              │
│ 🟡 GET /api/health 503      │
│    12:34:05                  │
│    [File Issue] [Dismiss]    │
└─────────────────────────────┘
```

**"File Issue" action:**
- Pre-fills the ClawMark annotation form with:
  - Title: error message (truncated)
  - Description: full stack trace + URL + timestamp
  - Type: `bug`
  - Screenshot: auto-captured at error time (reuse existing screenshot.js)
- Dispatches through existing delivery rules (#44 batch filing compatible)

## Data Flow

1. User browses normally
2. `ErrorMonitor` captures errors → sends to service worker
3. Service worker stores + updates badge count
4. User opens side panel → sees error list
5. User clicks "File Issue" → pre-filled annotation → dispatched via rules

## Configuration

Add to Options page:
- **Enable/disable** passive monitoring (default: enabled)
- **Severity filter**: which categories to capture (default: all)
- **Per-site disable**: same pattern as JS injection toggle (#86)

Settings stored in `chrome.storage.sync` (synced across devices).

## Scope Boundaries

**In scope:**
- Error capture (console, network, resource, performance)
- Storage + deduplication in service worker
- Side panel error list with "File Issue" action
- Badge count indicator
- Per-site enable/disable

**Out of scope (future):**
- AI-powered error grouping/triage
- Error trend analysis over time
- Automated issue filing without user confirmation
- DOM mutation monitoring (too noisy)

## Estimation

- **S (~20min):** ErrorMonitor module in content script
- **M (~45min):** Service worker storage + badge + side panel UI
- **M (~45min):** "File Issue" integration with existing dispatch
- **S (~20min):** Options page config

**Total: L (~2.5h)**

## Dependencies

- Existing: `inject.js` injection system, `screenshot.js`, side panel, dispatch API
- New permissions: none (already has `activeTab`, `storage`, `<all_urls>`)
