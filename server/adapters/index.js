/**
 * ClawMark — Adapter 注册 + 路由引擎
 *
 * 每个 adapter 是一个 { name, send(event, item, context), validate() } 对象。
 * 路由规则定义在 config.distribution 中，决定哪些事件发到哪些 channel。
 */

'use strict';

class AdapterRegistry {
    constructor() {
        /** @type {Map<string, object>} adapter type name → adapter class/factory */
        this.adapterTypes = new Map();
        /** @type {Map<string, object>} channel name → instantiated adapter */
        this.channels = new Map();
        /** @type {Array} routing rules from config */
        this.rules = [];
        /** @type {object|null} DB instance for adapters that need persistence */
        this.db = null;
    }

    /**
     * Set the database instance. Call before loadConfig so adapters get the DB.
     * @param {object} db  The ClawMark DB API from initDb().
     */
    setDb(db) {
        this.db = db;
    }

    /**
     * Register an adapter type (e.g. 'webhook', 'lark', 'telegram').
     * @param {string} type
     * @param {Function} AdapterClass  Constructor: new AdapterClass(channelConfig)
     */
    registerType(type, AdapterClass) {
        this.adapterTypes.set(type, AdapterClass);
    }

    /**
     * Load distribution config and instantiate channels.
     * @param {object} distributionConfig  config.distribution from config.json
     */
    loadConfig(distributionConfig) {
        if (!distributionConfig) return;

        const { rules = [], channels = {} } = distributionConfig;
        this.rules.push(...rules);

        for (const [name, channelConfig] of Object.entries(channels)) {
            const AdapterClass = this.adapterTypes.get(channelConfig.adapter);
            if (!AdapterClass) {
                console.warn(`[adapters] Unknown adapter type "${channelConfig.adapter}" for channel "${name}", skipping`);
                continue;
            }
            try {
                const instance = new AdapterClass({ ...channelConfig, channelName: name, db: this.db || null });
                const validation = instance.validate ? instance.validate() : { ok: true };
                if (!validation.ok) {
                    console.warn(`[adapters] Channel "${name}" validation failed: ${validation.error}`);
                    continue;
                }
                this.channels.set(name, instance);
                console.log(`[adapters] Channel "${name}" (${channelConfig.adapter}) loaded`);
            } catch (err) {
                console.error(`[adapters] Failed to init channel "${name}":`, err.message);
            }
        }
    }

    /**
     * Dispatch an event through the routing rules.
     * @param {string} event   e.g. 'item.created', 'item.resolved'
     * @param {object} item    The item data
     * @param {object} context Additional context (app_id, etc.)
     */
    async dispatch(event, item, context = {}) {
        const matchingChannels = this._resolveChannels(event, item);
        if (matchingChannels.length === 0) return;

        const results = await Promise.allSettled(
            matchingChannels.map(async (channelName) => {
                const adapter = this.channels.get(channelName);
                if (!adapter) {
                    console.warn(`[adapters] Channel "${channelName}" not found, skipping`);
                    return;
                }
                try {
                    await adapter.send(event, item, context);
                    console.log(`[adapters] ${event} → ${channelName} ✓`);
                } catch (err) {
                    console.error(`[adapters] ${event} → ${channelName} failed:`, err.message);
                    throw err;
                }
            })
        );

        return results;
    }

    /**
     * Match event + item against routing rules, return list of channel names.
     */
    _resolveChannels(event, item) {
        const channelSet = new Set();

        for (const rule of this.rules) {
            if (!rule.match || !rule.channels) continue;
            if (!this._matchRule(rule.match, event, item)) continue;
            for (const ch of rule.channels) {
                channelSet.add(ch);
            }
        }

        return [...channelSet];
    }

    /**
     * Check if an event + item matches a rule's match criteria.
     */
    _matchRule(match, event, item) {
        if (match.event && match.event !== event) return false;
        if (match.type) {
            const types = Array.isArray(match.type) ? match.type : [match.type];
            if (!types.includes(item.type)) return false;
        }
        if (match.priority) {
            const priorities = Array.isArray(match.priority) ? match.priority : [match.priority];
            if (!priorities.includes(item.priority)) return false;
        }
        if (match.status) {
            const statuses = Array.isArray(match.status) ? match.status : [match.status];
            if (!statuses.includes(item.status)) return false;
        }
        if (match.app_id && match.app_id !== item.app_id) return false;
        return true;
    }

    /**
     * Dispatch an event to a dynamically resolved target (not from static rules).
     * Creates an ad-hoc adapter instance using the registered adapter type.
     *
     * @param {string} event        e.g. 'item.created'
     * @param {object} item         The item data
     * @param {string} target_type  Adapter type, e.g. 'github-issue'
     * @param {object} target_config Config for the adapter (repo, labels, etc.)
     * @param {object} context      Additional context
     */
    async dispatchToTarget(event, item, target_type, target_config, context = {}) {
        const AdapterClass = this.adapterTypes.get(target_type);
        if (!AdapterClass) {
            console.error(`[adapters] Unknown adapter type "${target_type}" for dynamic dispatch`);
            return;
        }

        // Inherit token from default channel config if not provided.
        // This is safe because dynamic targets are still GitHub repos the user
        // explicitly configured — we just reuse the PAT from the static config
        // rather than requiring each rule to carry its own token.
        if (target_type === 'github-issue' && !target_config.token) {
            for (const [, adapter] of this.channels) {
                if (adapter.type === 'github-issue' && adapter.token) {
                    target_config.token = adapter.token;
                    break;
                }
            }
        }

        const channelName = `dynamic-${target_type}-${Date.now()}`;
        try {
            const instance = new AdapterClass({ ...target_config, channelName, db: this.db || null });
            const validation = instance.validate ? instance.validate() : { ok: true };
            if (!validation.ok) {
                console.error(`[adapters] Dynamic channel validation failed: ${validation.error}`);
                // Fallback to static dispatch
                return this.dispatch(event, item, context);
            }
            await instance.send(event, item, context);
            console.log(`[adapters] ${event} → dynamic ${target_type} (${target_config.repo || 'custom'}) ✓`);
        } catch (err) {
            console.error(`[adapters] ${event} → dynamic ${target_type} failed:`, err.message);
            throw err;
        }
    }

    /**
     * Dispatch an event to multiple targets in parallel (multi-target #93).
     * Creates dispatch_log entries for tracking and retries.
     *
     * @param {string} event        e.g. 'item.created'
     * @param {object} item         The item data
     * @param {Array}  targets      Array of { target_type, target_config, method }
     * @param {object} context      Additional context
     * @returns {Array} Array of { dispatch_id, target_type, status, error? }
     */
    async dispatchToTargets(event, item, targets, context = {}) {
        if (!this.db) {
            console.error('[adapters] Cannot track multi-target dispatch: no DB set');
            return [];
        }

        // Create dispatch_log entries for each target
        const entries = targets.map(t => ({
            dispatch_id: this.db.createDispatchEntry({
                item_id: item.id,
                target_type: t.target_type,
                target_config: t.target_config,
                method: t.method,
            }),
            ...t,
        }));

        // Dispatch all targets in parallel
        const results = await Promise.allSettled(
            entries.map(async (entry) => {
                try {
                    const result = await this._dispatchSingleTarget(event, item, entry.target_type, entry.target_config, context);
                    this.db.updateDispatchEntry(entry.dispatch_id, {
                        status: 'sent',
                        retries: 0,
                        external_id: result?.external_id || null,
                        external_url: result?.external_url || null,
                    });
                    console.log(`[adapters] ${event} → ${entry.target_type} ✓ (dispatch ${entry.dispatch_id})`);
                    return { dispatch_id: entry.dispatch_id, target_type: entry.target_type, status: 'sent' };
                } catch (err) {
                    this.db.updateDispatchEntry(entry.dispatch_id, {
                        status: 'failed',
                        retries: 1,
                        last_error: err.message,
                    });
                    console.error(`[adapters] ${event} → ${entry.target_type} failed (dispatch ${entry.dispatch_id}):`, err.message);
                    return { dispatch_id: entry.dispatch_id, target_type: entry.target_type, status: 'failed', error: err.message };
                }
            })
        );

        return results.map(r => r.status === 'fulfilled' ? r.value : r.reason);
    }

    /**
     * Internal: dispatch to a single target and return result metadata.
     * Unlike dispatchToTarget(), this returns external_id/url from the adapter.
     */
    async _dispatchSingleTarget(event, item, target_type, target_config, context = {}) {
        const AdapterClass = this.adapterTypes.get(target_type);
        if (!AdapterClass) {
            throw new Error(`Unknown adapter type "${target_type}"`);
        }

        // Inherit token from default channel for github-issue
        if (target_type === 'github-issue' && !target_config.token) {
            for (const [, adapter] of this.channels) {
                if (adapter.type === 'github-issue' && adapter.token) {
                    target_config.token = adapter.token;
                    break;
                }
            }
        }

        const channelName = `dynamic-${target_type}-${Date.now()}`;
        const instance = new AdapterClass({ ...target_config, channelName, db: this.db || null });
        const validation = instance.validate ? instance.validate() : { ok: true };
        if (!validation.ok) {
            throw new Error(`Validation failed: ${validation.error}`);
        }
        const result = await instance.send(event, item, context);
        return result || {};
    }

    /**
     * Retry failed dispatches (called periodically).
     * Exponential backoff: retry_delay = 2^retries * 5 seconds.
     * Max 3 retries per entry.
     */
    async retryFailed() {
        if (!this.db) return 0;

        const pending = this.db.getPendingDispatches();
        if (pending.length === 0) return 0;

        let retried = 0;
        for (const entry of pending) {
            // Exponential backoff check
            const backoffMs = Math.pow(2, entry.retries) * 5000;
            const lastUpdate = new Date(entry.updated_at).getTime();
            if (Date.now() - lastUpdate < backoffMs) continue;

            let item;
            try {
                item = this.db.getItem(entry.item_id);
            } catch (_) { /* ignore */ }
            if (!item) {
                this.db.updateDispatchEntry(entry.id, {
                    status: 'cancelled', retries: entry.retries,
                    last_error: 'Item not found',
                });
                continue;
            }

            const config = JSON.parse(entry.target_config);
            try {
                const result = await this._dispatchSingleTarget('item.created', item, entry.target_type, config, {});
                this.db.updateDispatchEntry(entry.id, {
                    status: 'sent',
                    retries: entry.retries + 1,
                    external_id: result?.external_id || null,
                    external_url: result?.external_url || null,
                });
                console.log(`[adapters] Retry #${entry.retries + 1} → ${entry.target_type} ✓ (dispatch ${entry.id})`);
                retried++;
            } catch (err) {
                const newRetries = entry.retries + 1;
                this.db.updateDispatchEntry(entry.id, {
                    status: newRetries >= 3 ? 'exhausted' : 'failed',
                    retries: newRetries,
                    last_error: err.message,
                });
                console.error(`[adapters] Retry #${newRetries} → ${entry.target_type} failed (dispatch ${entry.id}):`, err.message);
            }
        }

        return retried;
    }

    /**
     * Get status of all registered channels.
     */
    getStatus() {
        const status = {};
        for (const [name, adapter] of this.channels) {
            status[name] = {
                type: adapter.type || 'unknown',
                active: true,
            };
        }
        return status;
    }
}

module.exports = { AdapterRegistry };
