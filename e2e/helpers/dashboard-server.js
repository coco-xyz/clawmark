/**
 * Simple static server for the dashboard (E2E tests only).
 *
 * Serves the dashboard source directory as static files.
 * The browser tests inject clawmark_server_url into localStorage
 * so API calls go directly to the test server (CORS enabled).
 *
 * Usage: E2E_DASHBOARD_PORT=3492 node e2e/helpers/dashboard-server.js
 */

'use strict';

const express = require('express');
const path = require('path');

const PORT = process.env.E2E_DASHBOARD_PORT || 3492;
const DASHBOARD_ROOT = path.join(__dirname, '..', '..', 'dashboard');

const app = express();

app.use(express.static(DASHBOARD_ROOT));

// SPA fallback
app.get('*', (req, res) => {
    res.sendFile(path.join(DASHBOARD_ROOT, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`[e2e] Dashboard static server on port ${PORT}`);
});
