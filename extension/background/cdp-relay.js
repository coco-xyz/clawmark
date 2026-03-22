/**
 * ClawMark — CDP Relay (#82)
 *
 * Receives CDP commands from the server (via WebSocket action channel),
 * validates through whitelist + safety filter, executes via
 * cdp-session-manager, and relays results back.
 *
 * Dependencies (loaded via importScripts before this file):
 * - cdp-whitelist.js  → cdpWhitelistCheck()
 * - cdp-safety.js     → cdpSafetyCheck(), cdpAuditLog()
 * - cdp-session-manager.js → cdpSendCommand(), cdpIsAttached(), cdpAttach()
 *
 * Imported by service-worker.js via importScripts.
 */

'use strict';

// ── Core relay ───────────────────────────────────────────────────────

/**
 * Process a CDP command from the server.
 * Runs whitelist → safety → execute → audit pipeline.
 *
 * @param {object} command
 * @param {string} command.commandId   Unique ID for tracking
 * @param {number} command.tabId       Target tab
 * @param {string} command.method      CDP method (e.g. "DOM.getDocument")
 * @param {object} [command.params]    CDP command parameters
 * @param {object} [command.options]
 * @param {boolean} [command.options.allowSideEffects]  Bypass safety for Runtime.evaluate
 * @returns {Promise<{ commandId: string, success: boolean, result?: object, error?: string, blocked?: boolean, reason?: string }>}
 */
async function cdpRelayCommand(command) {
    const { commandId, tabId, method, params = {}, options = {} } = command;
    const startTime = Date.now();

    if (commandId == null || tabId == null || !method) {
        return {
            commandId: commandId ?? 'unknown',
            success: false,
            error: 'commandId, tabId, and method are required',
        };
    }

    // ── Step 1: Whitelist check ──────────────────────────────────────
    const whitelistResult = cdpWhitelistCheck(method);
    if (!whitelistResult.allowed) {
        cdpAuditLog({
            tabId,
            method,
            params: sanitizeParamsForLog(method, params),
            allowed: false,
            reason: whitelistResult.reason,
        });

        return {
            commandId,
            success: false,
            blocked: true,
            reason: whitelistResult.reason,
        };
    }

    // ── Step 2: Safety check (parameter inspection) ──────────────────
    const safetyResult = cdpSafetyCheck(method, params, options);
    if (!safetyResult.safe) {
        cdpAuditLog({
            tabId,
            method,
            params: sanitizeParamsForLog(method, params),
            allowed: false,
            reason: `Safety: ${safetyResult.reason}`,
        });

        return {
            commandId,
            success: false,
            blocked: true,
            reason: safetyResult.reason,
        };
    }

    // ── Step 3: Check CDP session ────────────────────────────────────
    if (!cdpIsAttached(tabId)) {
        cdpAuditLog({
            tabId,
            method,
            params: sanitizeParamsForLog(method, params),
            allowed: false,
            reason: `No CDP session for tab ${tabId}`,
        });

        return {
            commandId,
            success: false,
            error: `No CDP session for tab ${tabId}. Attach first via cdp:start.`,
        };
    }

    // ── Step 4: Execute ──────────────────────────────────────────────
    // Defense-in-depth: ask V8 to throw on side effects for read-only evals.
    // This catches obfuscation bypasses (string concat, base64, indirect eval)
    // that regex patterns cannot detect.
    let execParams = params;
    if (method === 'Runtime.evaluate' && !options.allowSideEffects) {
        execParams = { ...params, throwOnSideEffect: true };
    }

    try {
        const result = await cdpSendCommand(tabId, method, execParams);
        const durationMs = Date.now() - startTime;

        cdpAuditLog({
            tabId,
            method,
            params: sanitizeParamsForLog(method, params),
            allowed: true,
            success: true,
            durationMs,
        });

        return {
            commandId,
            success: true,
            result: result || {},
            durationMs,
        };
    } catch (err) {
        const durationMs = Date.now() - startTime;

        cdpAuditLog({
            tabId,
            method,
            params: sanitizeParamsForLog(method, params),
            allowed: true,
            success: false,
            reason: err.message,
            durationMs,
        });

        return {
            commandId,
            success: false,
            error: err.message,
            durationMs,
        };
    }
}

// ── Batch relay ──────────────────────────────────────────────────────

/**
 * Process multiple CDP commands sequentially.
 * Stops on first failure if options.stopOnError is true.
 *
 * @param {Array<object>} commands  Array of command objects (same shape as cdpRelayCommand input)
 * @param {object} [options]
 * @param {boolean} [options.stopOnError=false]
 * @returns {Promise<Array<object>>}  Array of results
 */
async function cdpRelayBatch(commands, options = {}) {
    const results = [];

    for (const cmd of commands) {
        const result = await cdpRelayCommand(cmd);
        results.push(result);

        if (options.stopOnError && !result.success) {
            break;
        }
    }

    return results;
}

// ── Param sanitization for audit log ─────────────────────────────────

/**
 * Strip sensitive/large data from params before logging.
 */
function sanitizeParamsForLog(method, params) {
    if (!params) return {};

    const safe = { ...params };

    // Truncate large expressions
    if (safe.expression && safe.expression.length > 200) {
        safe.expression = safe.expression.slice(0, 200) + '...[TRUNCATED]';
    }
    if (safe.functionDeclaration && safe.functionDeclaration.length > 200) {
        safe.functionDeclaration = safe.functionDeclaration.slice(0, 200) + '...[TRUNCATED]';
    }

    // Don't log screenshot data
    if (method === 'Page.captureScreenshot') {
        return { format: safe.format, quality: safe.quality };
    }

    return safe;
}

// ── WS message handler (Phase 2: wired when action channel lands) ───

/**
 * Handle an incoming CDP relay message from the WebSocket.
 * Called by the WS action channel when it receives a cdp:command message.
 *
 * @param {object} message  The parsed WS message payload
 * @param {function} send   Function to send a response back via WS
 */
async function handleCdpRelayMessage(message, send) {
    const { type, payload } = message;

    if (!payload && type !== 'cdp:whitelist-info') {
        send({ type: 'cdp:error', payload: { error: 'Missing payload' } });
        return;
    }

    switch (type) {
        case 'cdp:command': {
            const result = await cdpRelayCommand(payload);
            if (result.blocked) {
                send({ type: 'cdp:blocked', payload: result });
            } else {
                send({ type: 'cdp:result', payload: result });
            }
            break;
        }

        case 'cdp:batch': {
            if (!Array.isArray(payload.commands)) {
                send({ type: 'cdp:error', payload: { error: 'payload.commands must be an array' } });
                break;
            }
            const results = await cdpRelayBatch(payload.commands, payload.options);
            send({ type: 'cdp:batch-result', payload: { results } });
            break;
        }

        case 'cdp:audit-log': {
            const log = cdpGetAuditLog(payload || {});
            send({ type: 'cdp:audit-log', payload: { entries: log } });
            break;
        }

        case 'cdp:whitelist-info': {
            const info = cdpWhitelistInfo();
            send({ type: 'cdp:whitelist-info', payload: info });
            break;
        }

        default:
            send({
                type: 'cdp:error',
                payload: { error: `Unknown CDP relay message type: ${type}` },
            });
    }
}
