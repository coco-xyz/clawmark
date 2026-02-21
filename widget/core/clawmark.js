/**
 * ClawMark — headless core.
 *
 * Manages the API client, event bus, and plugin registry.
 * Contains no UI of its own; UI is provided by plugins.
 *
 * Usage:
 *   const cm = new ClawMark({
 *     api:   '/api/doc-discuss',   // ClawMark server base URL
 *     app:   'my-app',             // fallback doc ID when no document is active
 *     user:  null,                 // initial username (null = not logged in)
 *     theme: 'dark',               // 'dark' | 'light' (passed to plugins)
 *   });
 *   cm.use(ClawMark.Fab);
 *   cm.use(ClawMark.Comment);
 *   cm.mount();
 */

import { ApiClient } from './api-client.js';
import { EventBus } from './event-bus.js';

export class ClawMark {
  /**
   * @param {object} config
   * @param {string}  config.api    - API base URL
   * @param {string}  [config.app]  - App/product ID (used as doc when none is set)
   * @param {string}  [config.user] - Logged-in username (or null)
   * @param {string}  [config.theme] - 'dark' (default) | 'light'
   */
  constructor(config = {}) {
    this.config = {
      api:   config.api   || '/api/doc-discuss',
      app:   config.app   || '_product',
      user:  config.user  || null,
      theme: config.theme || 'dark',
    };

    this.api    = new ApiClient({ api: this.config.api, app: this.config.app });
    this.events = new EventBus();

    // Active document context — plugins read & write these.
    this._docId = null;

    // Plugin registry: [{ plugin, options, instance }]
    this._plugins = [];

    this._mounted = false;
  }

  // ─── Document context ──────────────────────────────────────────────────────

  /** Currently active document ID (e.g. 'docs/intro.md'). */
  get docId() { return this._docId; }

  /**
   * Set the active document. Emits 'doc:changed'.
   * Plugins react to this to reload their data.
   */
  setDoc(docId) {
    const prev = this._docId;
    this._docId = docId || null;
    this.events.emit('doc:changed', { docId: this._docId, prev });
  }

  // ─── User context ──────────────────────────────────────────────────────────

  /** Logged-in username, or null. */
  get user() { return this.config.user; }

  /**
   * Update the logged-in user. Emits 'user:changed'.
   */
  setUser(userName) {
    const prev = this.config.user;
    this.config.user = userName || null;
    this.events.emit('user:changed', { user: this.config.user, prev });
  }

  // ─── Plugin system ─────────────────────────────────────────────────────────

  /**
   * Register a plugin class (or factory function) with optional options.
   * Plugins are instantiated lazily during mount().
   *
   * @param {Function} PluginClass  - Constructor with (core, options)
   * @param {object}   [options]    - Passed to the plugin constructor
   * @returns {ClawMark} this (for chaining)
   */
  use(PluginClass, options = {}) {
    if (this._mounted) {
      // Hot-add after mount: instantiate immediately.
      const instance = new PluginClass(this, options);
      instance.mount?.();
      this._plugins.push({ PluginClass, options, instance });
    } else {
      this._plugins.push({ PluginClass, options, instance: null });
    }
    return this;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Mount all registered plugins.
   * Loads the saved session from localStorage so plugins start with the
   * correct user context.
   */
  mount() {
    if (this._mounted) return this;

    // Restore session
    this._restoreSession();

    // Instantiate and mount all plugins
    for (const entry of this._plugins) {
      if (!entry.instance) {
        entry.instance = new entry.PluginClass(this, entry.options);
      }
      entry.instance.mount?.();
    }

    this._mounted = true;
    this.events.emit('core:mounted', { core: this });
    return this;
  }

  /**
   * Destroy all plugins and clean up.
   */
  destroy() {
    for (const { instance } of this._plugins) {
      instance?.destroy?.();
    }
    this._plugins = [];
    this.events.clear();
    this._mounted = false;
    this.events.emit('core:destroyed');
  }

  // ─── Session helpers ───────────────────────────────────────────────────────

  /** Storage key for the persisted session. */
  get _sessionKey() { return 'clawmark-session'; }

  _restoreSession() {
    try {
      const raw = localStorage.getItem(this._sessionKey);
      if (raw) {
        const { userName } = JSON.parse(raw);
        if (userName) {
          this.config.user = userName;
          this.events.emit('user:restored', { user: userName });
        }
      }
    } catch {}
  }

  /**
   * Persist a logged-in session and update the user context.
   */
  saveSession(userName) {
    this.setUser(userName);
    try { localStorage.setItem(this._sessionKey, JSON.stringify({ userName })); } catch {}
    this.events.emit('user:login', { user: userName });
  }

  /**
   * Clear the session (logout).
   */
  clearSession() {
    const prev = this.config.user;
    this.config.user = null;
    try { localStorage.removeItem(this._sessionKey); } catch {}
    this.events.emit('user:logout', { prev });
    this.events.emit('user:changed', { user: null, prev });
  }

  // ─── Utility ───────────────────────────────────────────────────────────────

  /**
   * Show a transient toast notification.
   * Plugins can override by listening to the 'ui:toast' event.
   */
  toast(message, type = 'success') {
    this.events.emit('ui:toast', { message, type });

    // Built-in fallback toast
    let el = document.getElementById('_clawmark-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = '_clawmark-toast';
      el.style.cssText = [
        'position:fixed', 'bottom:60px', 'left:50%', 'transform:translateX(-50%)',
        'color:#fff', 'padding:8px 20px', 'border-radius:20px',
        'font-size:13px', 'z-index:99999',
        'opacity:0', 'transition:opacity 0.3s', 'pointer-events:none',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      ].join(';');
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.style.background = type === 'error' ? '#da3633' : '#238636';
    el.style.opacity = '1';
    clearTimeout(el._timer);
    el._timer = setTimeout(() => { el.style.opacity = '0'; }, type === 'error' ? 3000 : 1800);
  }
}
