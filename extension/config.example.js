/**
 * ClawMark Extension — Build Configuration Template
 *
 * Copy this file to config.js before running the extension locally.
 * In CI/CD, scripts/build.sh generates config.js automatically.
 *
 * Do NOT commit config.js — it is in .gitignore.
 */

'use strict';

const ClawMarkConfig = {
    DEFAULT_SERVER: 'https://api.coco.xyz/clawmark',
    DASHBOARD_URL: 'https://labs.coco.xyz/clawmark/dash/',
    GOOGLE_CLIENT_ID: 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com',
    EXTENSION_ID: '',
    ENV: 'production',
};

if (typeof Object.freeze === 'function') Object.freeze(ClawMarkConfig);
