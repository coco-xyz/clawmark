/**
 * ClawMark EventBus — simple pub/sub for plugin communication.
 */
export class EventBus {
  constructor() {
    this._handlers = {};
  }

  /**
   * Subscribe to an event.
   * @param {string} event
   * @param {Function} handler
   * @returns {Function} unsubscribe function
   */
  on(event, handler) {
    if (!this._handlers[event]) this._handlers[event] = [];
    this._handlers[event].push(handler);
    return () => this.off(event, handler);
  }

  /**
   * Subscribe once — auto-unsubscribes after the first emit.
   */
  once(event, handler) {
    const wrapper = (...args) => {
      handler(...args);
      this.off(event, wrapper);
    };
    return this.on(event, wrapper);
  }

  /**
   * Unsubscribe a handler.
   */
  off(event, handler) {
    if (!this._handlers[event]) return;
    this._handlers[event] = this._handlers[event].filter(h => h !== handler);
  }

  /**
   * Emit an event with optional payload.
   */
  emit(event, payload) {
    (this._handlers[event] || []).forEach(h => {
      try { h(payload); } catch (err) { console.error('[ClawMark EventBus]', event, err); }
    });
  }

  /**
   * Remove all handlers for an event (or all events if none specified).
   */
  clear(event) {
    if (event) {
      delete this._handlers[event];
    } else {
      this._handlers = {};
    }
  }
}
