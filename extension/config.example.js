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
    GOOGLE_CLIENT_ID: '530440081185-32t15m4gqndq7qab6g57a25i6gfc1gmn.apps.googleusercontent.com',
    ENV: 'production',
};

if (typeof Object.freeze === 'function') Object.freeze(ClawMarkConfig);
