# ClawMark Native SDK — Multi-Platform Technical Specification

> Issue: #95 | Author: Lucy | Date: 2026-03-28
> Directive: Kevin (2026-03-22) — Pure native SDK, Bugtags model

## 1. Executive Summary

This document evaluates multi-platform native SDK approaches for packaging ClawMark's annotation capability as an embeddable SDK for Web, Android, and iOS. The reference model is Bugtags — pure native, no WebView injection dependency.

**Recommendation:** Kotlin Multiplatform (KMP) for shared business logic + fully native UI per platform. Web SDK remains JavaScript. Backend API is already platform-agnostic.

---

## 2. Bugtags Implementation Analysis

### Android Architecture

| Component | Bugtags Approach |
|-----------|------------------|
| Lifecycle hooks | Manual per-Activity (`onResume/onPause/onDispatchTouchEvent`) |
| Screenshot | `View.draw(Canvas)` on DecorView (no permissions) |
| Annotation overlay | Full-screen Activity on top of host app |
| Invocation | Floating bubble (WindowManager `TYPE_APPLICATION_OVERLAY`), shake (SensorManager), or passive |
| Network interception | Gradle plugin bytecode manipulation (OkHttp/HttpURLConnection wrapping) |
| Data delivery | HTTPS multipart POST (screenshot PNG + metadata JSON) |

**Weaknesses:** Per-Activity hooks are burdensome for integrators. The Gradle plugin adds build complexity. The SDK is inactive/unmaintained.

### iOS Architecture

| Component | Bugtags Approach |
|-----------|------------------|
| Lifecycle hooks | Single `AppDelegate` init; method swizzling for view controller tracking |
| Screenshot | `UIGraphicsBeginImageContextWithOptions` + `layer.render(in:)` |
| Annotation overlay | Separate `UIWindow` (higher windowLevel) with drawing canvas |
| Invocation | Shake (`UIResponder.motionEnded`), screenshot notification, or bubble |
| Network interception | `NSURLProtocol` subclass |
| Data delivery | HTTPS multipart upload |

### Key Takeaway

Bugtags validates the pure-native approach but its integration pattern is dated. Modern SDKs (Instabug, Shake) use `Application.registerActivityLifecycleCallbacks()` on Android to eliminate per-Activity hooks entirely.

---

## 3. Industry Landscape

| SDK | Source | Android | iOS | Cross-Platform | Annotation | Status |
|-----|--------|---------|-----|----------------|------------|--------|
| Bugtags | Closed | Native | Native | No | Canvas draw | Inactive |
| Instabug | Closed | Native | Native | RN, Flutter | Native draw + blur + magnify | Active |
| Shake | Closed | Native | Native | RN, Flutter | Native draw + blackout | Active |
| Buglife | **Open** | Native | Native | No | Native draw | Sunset 2025 |
| UserSnap | Closed | WebView | WebView | Web focus | WebView | Active |
| Gleap | Closed | Native | Native | RN, Flutter, Capacitor | Native + video replay | Active |
| BugshotKit | **Open** | N/A | Native | iOS only | Minimal draw | Maintained |

**Key insight:** All successful SDKs use fully native UI. WebView-based (UserSnap) is the outlier and perceived as lower quality. Buglife (open source, iOS) is the best reference implementation to study.

---

## 4. Three-Platform Architecture

### 4.1 Web SDK (JavaScript)

ClawMark's current Chrome Extension architecture maps directly to an embeddable JS SDK.

**Approach:** Extract the extension's content script logic into a standalone `<script>` tag SDK.

| Component | Source | Adaptation |
|-----------|--------|------------|
| Text selection + toolbar | `extension/content/inject.js` | Remove chrome.runtime deps, use postMessage |
| Screenshot annotation | `extension/content/screenshot.js` | Replace `chrome.tabs.captureVisibleTab` with `html2canvas` or native canvas |
| Upload + dispatch | Service worker logic | Direct REST calls to ClawMark API |
| Auth | chrome.storage JWT | SDK init with API key |

**Integration:**
```html
<script src="https://cdn.clawmark.dev/sdk.js"></script>
<script>ClawMark.init({ apiKey: 'YOUR_KEY' })</script>
```

### 4.2 Android SDK (Native)

**Screenshot capture strategy:**

| Method | API Level | Permissions | Quality | Recommended |
|--------|-----------|-------------|---------|-------------|
| `PixelCopy.request(Window)` | 26+ (O) | None | High (includes SurfaceView) | Primary |
| `View.draw(Canvas)` on DecorView | All | None | Good (excludes SurfaceView) | Fallback |
| MediaProjection + VirtualDisplay | 21+ (L) | User consent each session | Full screen | Optional (too disruptive for default) |

**Annotation overlay:**
- Custom `View` subclass tracking `MotionEvent.ACTION_MOVE` → `Path` objects
- Render to `Bitmap` via `Canvas(bitmap).drawPath()`
- Tools: pen, arrow, rectangle, circle, text, number markers (matching web feature set)

**Lifecycle integration:**
```kotlin
// Application.onCreate() — single init, no per-Activity hooks
ClawMark.init(this, apiKey = "YOUR_KEY", invocation = InvocationEvent.SHAKE)
```
Uses `Application.registerActivityLifecycleCallbacks()` internally.

**Invocation triggers:**
- Shake detection (SensorManager accelerometer)
- Floating button (in-app `ViewGroup` overlay, avoids `SYSTEM_ALERT_WINDOW` permission)
- Programmatic `ClawMark.show()`
- Screenshot detection (FileObserver on screenshots directory)

**Permissions:** None required for default configuration. No `SYSTEM_ALERT_WINDOW`, no `MediaProjection`.

### 4.3 iOS SDK (Native)

**Screenshot capture:**
```swift
UIGraphicsImageRenderer(size: window.bounds.size).image { ctx in
    window.layer.render(in: ctx.cgContext)
}
```
No permissions required.

**Annotation overlay:**
- Custom `UIWindow` with `windowLevel = .alert - 1`
- `UIView` subclass tracking `touchesBegan/Moved/Ended` → `UIBezierPath`
- Real-time preview via `CAShapeLayer` (GPU-accelerated)
- Same tool set as Android

**Lifecycle integration:**
```swift
// AppDelegate
ClawMark.start(apiKey: "YOUR_KEY")
```
Internally observes `UIApplication.didBecomeActiveNotification`.

**Invocation triggers:**
- Shake (`UIWindow` subclass overriding `motionEnded(_:with:)`)
- `UIApplication.userDidTakeScreenshotNotification` (iOS 11+)
- Floating button (in-app UIWindow)
- Programmatic `ClawMark.show()`

**UIScene support (iOS 13+):** Attach overlay window to `UIWindowScene` from `UIApplication.shared.connectedScenes`.

---

## 5. Code Reuse Evaluation

### Backend (100% reusable)

The ClawMark server already exposes platform-agnostic REST APIs:
- `POST /api/v2/items` — create annotation
- `POST /upload` — upload screenshot
- Routing engine, adapter system, AI module — all backend-side

Native SDKs consume the same API as the web extension. **No backend changes required.**

### Shared Logic (extractable to KMP or shared module)

| Component | Current Location | Reuse Path |
|-----------|-----------------|------------|
| API client | `dashboard/src/api.js` | KMP shared module (Ktor client) |
| Data models | `server/db.js` schema | KMP data classes |
| Routing rules | `server/routing.js` | Backend only (not client-side) |
| Auth flow | `server/auth.js` | API key auth for SDK (simpler than OAuth) |
| Upload logic | `extension/content/inject.js` | KMP multipart upload |

### UI (platform-specific, pattern-reusable)

| Component | Web | Android | iOS |
|-----------|-----|---------|-----|
| Text selection | DOM Range API | `ActionMode.Callback` | `UIMenuController` |
| Screenshot capture | `html2canvas` / canvas | `PixelCopy` / `View.draw` | `UIGraphicsImageRenderer` |
| Drawing canvas | Canvas 2D API | `Canvas` + `Path` | `UIBezierPath` + `CAShapeLayer` |
| Floating trigger | DOM overlay | `ViewGroup` child | `UIWindow` |
| Form/input | HTML form | Compose/XML layout | SwiftUI/UIKit |

UI must be implemented per-platform. However, **tool definitions** (pen width, colors, shapes) and **annotation data format** can be shared.

---

## 6. Work Estimation

### Phase 1: Core SDK (MVP — capture + annotate + submit)

| Task | Web | Android | iOS |
|------|-----|---------|-----|
| SDK init + config | S | S | S |
| Screenshot capture | M | M | S |
| Annotation canvas (pen, arrow, rect) | M (extract from extension) | L | L |
| Form overlay (title, tags, comment) | S (extract from extension) | M | M |
| API client + upload | S (extract from extension) | M | M |
| Invocation triggers | S | M | S |
| **Subtotal** | **M (~45min)** | **L (~90min)** | **L (~90min)** |

### Phase 2: Enhanced Features

| Task | Web | Android | iOS |
|------|-----|---------|-----|
| Text selection annotation | Already exists | M | M |
| Additional tools (circle, text, number) | S | M | M |
| Network interceptor | N/A | L | M |
| Session replay | Already exists | L | L |
| Offline queue + retry | S | M | M |

### Phase 3: Polish + Distribution

| Task | Scope |
|------|-------|
| KMP shared module (API client, models, upload) | L |
| Android: publish to Maven Central / JitPack | M |
| iOS: publish to CocoaPods / SPM | M |
| Web: publish to npm + CDN | S |
| Integration docs + sample apps | M per platform |

### Total Estimate

| Phase | Effort |
|-------|--------|
| Phase 1 (MVP) | ~4-5 sessions |
| Phase 2 (Enhanced) | ~5-6 sessions |
| Phase 3 (Distribution) | ~3-4 sessions |
| **Total** | **~12-15 sessions** |

---

## 7. COCO APP Integration Path

COCO APP uses Capacitor for native packaging. Two integration options:

### Option A: Capacitor Plugin (Recommended for M1)
- Wrap the Web SDK as a Capacitor plugin
- Use Capacitor's native bridge for screenshot capture (`@capacitor/screen-capture` or custom)
- Minimal native code — leverages existing web annotation UI
- **Estimate:** M (~45min) for the plugin wrapper

### Option B: Native SDK Embed (Recommended for M2+)
- Embed the Android/iOS native SDK directly into the Capacitor app
- Full native annotation experience
- Requires Phase 1 completion for both platforms
- **Estimate:** S per platform (just init + config in native layer)

**Recommended path:** Option A for immediate integration (M1), migrate to Option B when native SDKs mature (M2).

---

## 8. Recommended Architecture Decision

```
                    ┌──────────────┐
                    │  ClawMark    │
                    │  Backend API │
                    └──────┬───────┘
                           │ REST + WebSocket
              ┌────────────┼────────────┐
              │            │            │
     ┌────────▼───┐  ┌────▼─────┐  ┌──▼────────┐
     │  Web SDK   │  │ Android  │  │  iOS SDK  │
     │ (JS/TS)    │  │   SDK    │  │ (Swift)   │
     │            │  │ (Kotlin) │  │           │
     └────────────┘  └──────────┘  └───────────┘
                     └─────┬──────┘
                   KMP Shared Module
                  (API client, models,
                   upload, offline queue)
```

**Key decisions:**
1. **Pure native UI** per platform (no WebView annotation)
2. **KMP shared module** for business logic (API client, data models, upload queue)
3. **Web SDK extracted** from existing Chrome Extension code
4. **API key auth** for SDK (simpler than OAuth — no Google sign-in in mobile SDK)
5. **No `SYSTEM_ALERT_WINDOW`** permission — use in-app overlay approach
6. **Shake + screenshot notification** as default invocation (no floating bubble by default)

---

## 9. References

- [Bugtags Android](https://github.com/bugtags/Bugtags-Android) — reference implementation (inactive)
- [Buglife iOS](https://github.com/Buglife/Buglife-iOS) — best open-source reference
- [BugshotKit](https://github.com/marcoarment/BugshotKit) — minimal iOS reference
- [Android PixelCopy](https://developer.android.com/reference/android/view/PixelCopy)
- [iOS UIGraphicsImageRenderer](https://developer.apple.com/documentation/uikit/uigraphicsimagerenderer)
- [Kotlin Multiplatform](https://kotlinlang.org/docs/multiplatform.html)
- [Instabug Docs](https://docs.instabug.com/) — industry benchmark
- [Shake Docs](https://docs.shakebugs.com/) — modern SDK reference
