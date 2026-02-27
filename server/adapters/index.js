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
        this.rules = rules;

        for (const [name, channelConfig] of Object.entries(channels)) {
            const AdapterClass = this.adapterTypes.get(channelConfig.adapter);
            if (!AdapterClass) {
                console.warn(`[adapters] Unknown adapter type "${channelConfig.adapter}" for channel "${name}", skipping`);
                continue;
            }
            try {
                const instance = new AdapterClass(channelConfig);
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
