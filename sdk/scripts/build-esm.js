#!/usr/bin/env node
/**
 * Post-build step: generate ESM wrapper (.mjs) from CJS output.
 * Re-exports everything from the CJS build via a thin ESM shim.
 */
const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, '..', 'dist');
const esmContent = `// ESM wrapper — auto-generated
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const mod = require('./index.js');

export const OpenClaw = mod.OpenClaw;
export const OpenClawError = mod.OpenClawError;
export const AuthError = mod.AuthError;
export const HttpError = mod.HttpError;
export const RateLimitError = mod.RateLimitError;
export const ActionTimeoutError = mod.ActionTimeoutError;
export const NotConnectedError = mod.NotConnectedError;
export default mod.OpenClaw;
`;

fs.writeFileSync(path.join(distDir, 'index.mjs'), esmContent);
console.log('ESM wrapper generated: dist/index.mjs');
