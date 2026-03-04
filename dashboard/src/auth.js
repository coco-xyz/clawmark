/**
 * ClawMark Dashboard — Google OAuth Flow
 *
 * Uses the authorization code flow:
 * 1. Redirect to Google consent screen
 * 2. Google redirects back with ?code=
 * 3. Exchange code via server POST /api/v2/auth/google
 */

'use strict';

const GOOGLE_CLIENT_ID = '530440081185-32t15m4gqndq7qab6g57a25i6gfc1gmn.apps.googleusercontent.com';

export function getRedirectUri() {
    return window.location.origin + window.location.pathname;
}

export function startGoogleLogin() {
    const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: getRedirectUri(),
        response_type: 'code',
        scope: 'openid email profile',
        access_type: 'offline',
        prompt: 'select_account',
    });
    window.location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
}

export function extractAuthCode() {
    const params = new URLSearchParams(window.location.search);
    return params.get('code');
}

export function clearUrlParams() {
    const url = window.location.pathname;
    window.history.replaceState({}, '', url);
}
