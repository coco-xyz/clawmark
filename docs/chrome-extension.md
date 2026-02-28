# Chrome Extension Development Guide

## Prerequisites

- Chrome or Chromium-based browser (version 116+, Manifest V3 support)
- ClawMark server running locally or on staging

## Loading the Extension (Development)

1. Open `chrome://extensions/` in your browser
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `extension/` directory from this repository

The extension will appear in your toolbar. Click the icon to open the popup.

## Project Structure

```
extension/
├── manifest.json              # Manifest V3 configuration
├── background/
│   └── service-worker.js      # Auth, API calls, context menu
├── content/
│   ├── inject.js              # Text selection, floating toolbar
│   └── inject.css             # Toolbar + input overlay styles
├── popup/
│   ├── popup.html             # Settings UI
│   └── popup.js               # Config management
├── sidepanel/
│   ├── panel.html             # Issue list + thread view
│   └── panel.js               # Data loading, rendering
└── icons/
    ├── generate.html           # Icon generation helper
    ├── icon-16.png
    ├── icon-32.png
    ├── icon-48.png
    └── icon-128.png
```

## Configuration

After loading, click the extension icon to open the popup and configure:

- **Server URL**: Your ClawMark server URL (e.g., `http://localhost:3462` for local dev)
- **Invite Code**: The auth code configured in your server's `config.json`

## Key Components

### Service Worker (`background/service-worker.js`)

Handles:
- Authentication state management
- API calls to ClawMark server
- Context menu integration (right-click to report)
- Message routing between content script and popup/side panel

### Content Script (`content/inject.js`)

Injected into all pages. Provides:
- Text selection detection with floating toolbar
- Input overlay for quick feedback
- Communication with service worker via `chrome.runtime.sendMessage`

### Side Panel (`sidepanel/panel.js`)

Chrome's built-in side panel showing:
- List of items for the current page
- Thread view with messages
- Reply functionality

## Debugging

- **Service worker logs**: Go to `chrome://extensions/` → click "service worker" link under your extension
- **Content script logs**: Open DevTools on any page → Console tab (filter by "ClawMark")
- **Popup/Side panel**: Right-click the popup → Inspect

## Building for Production

Currently no build step is required — the extension uses vanilla JS modules. To prepare for Chrome Web Store:

1. Generate icons: Open `extension/icons/generate.html` in a browser, save the generated PNGs
2. Create a ZIP of the `extension/` directory
3. Upload to [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)

## Coexistence with Widget

The Chrome Extension and the embedded widget can run on the same page. They share the same server API but operate independently:

- The widget is embedded by the page developer (via `<script>` tag)
- The extension is installed by the end user
- Both use the same V2 API endpoints
- Items created by either are visible to both
