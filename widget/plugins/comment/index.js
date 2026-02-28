/**
 * ClawMark CommentPlugin
 *
 * Enables text-selection → discussion workflow on any page:
 *   1. User selects text in the content area → a "Discuss" bubble appears.
 *   2. Clicking the bubble opens a discussion panel (card style, resizable).
 *   3. Users can post messages, resolve, reopen, or request an AI edit.
 *   4. All existing discussions for the document are highlighted inline.
 *   5. A comment count badge / topbar counter lets users browse all discussions.
 *
 * Plugin constructor: new CommentPlugin(core, options)
 *   core    — ClawMark core instance
 *   options — { contentSelector, authHandler, panelMode, sidebarPosition,
 *               sidebarWidth, sidebarTopOffset }
 *
 *   contentSelector: CSS selector for the element whose text is selectable
 *                    (default: 'body' — any text on the page).
 *   authHandler:     Optional async function called when the user is not logged
 *                    in. Should resolve once the user has authenticated.
 *                    Defaults to showing the built-in invite-code modal.
 *   panelMode:       'float' (default) — floating panels;
 *                    'sidebar' — slide-in sidebar panel.
 *   sidebarPosition: 'right' (default) | 'left'
 *   sidebarWidth:    sidebar width in px (default: 380)
 *   sidebarTopOffset: top offset in px (default: 0)
 */

// ─── CSS ─────────────────────────────────────────────────────────────────────

const CSS = `
/* Comment highlight in content */
.cm-comment-highlight {
  background: rgba(227,179,65,0.2);
  border-bottom: 2px solid #e3b341;
  cursor: pointer;
  border-radius: 2px;
  position: relative;
}
.cm-comment-highlight:hover { background: rgba(227,179,65,0.35); }
.cm-comment-highlight::after {
  content: '💬';
  font-size: 11px;
  position: absolute;
  top: -14px;
  right: 0;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.15s;
}
.cm-comment-highlight:hover::after { opacity: 1; }
.cm-comment-highlight.resolved {
  background: rgba(35,134,54,0.15);
  border-bottom: 2px solid #238636;
  opacity: 0.7;
}
.cm-comment-highlight.resolved:hover { background: rgba(35,134,54,0.25); opacity: 1; }
.cm-comment-highlight.resolved::after { content: '✓'; color: #238636; }

/* Discuss bubble button */
.cm-discuss-btn {
  position: fixed;
  background: #e3b341;
  color: #0d1117;
  border: none;
  border-radius: 50px;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  z-index: 9001;
  display: none;
  box-shadow: 0 4px 16px rgba(227,179,65,0.4);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.cm-discuss-btn:hover { background: #f0c654; }

/* Comment count badge (bottom area) */
.cm-comment-count {
  position: fixed;
  bottom: 20px;
  right: 80px;
  background: #e3b341;
  color: #0d1117;
  padding: 8px 16px;
  border-radius: 20px;
  font-size: 13px;
  display: none;
  z-index: 9000;
  cursor: pointer;
  font-weight: 600;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.cm-comment-count:hover { background: #f0c654; }

/* ─── Discussion panel ─── */
.cm-discuss-panel {
  position: fixed;
  bottom: 20px;
  right: 20px;
  width: 400px;
  height: 520px;
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
  z-index: 9002;
  display: none;
  flex-direction: column;
  min-height: 250px;
  max-height: calc(100vh - 40px);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.cm-discuss-panel.visible { display: flex; }

.cm-discuss-resize-handle {
  position: absolute;
  top: -4px;
  left: 20px;
  right: 20px;
  height: 8px;
  cursor: ns-resize;
  z-index: 9003;
}
.cm-discuss-resize-handle::after {
  content: '';
  display: block;
  width: 40px;
  height: 3px;
  background: #30363d;
  border-radius: 2px;
  margin: 2px auto 0;
}
.cm-discuss-resize-handle:hover::after { background: #e3b341; }

.cm-discuss-header {
  padding: 10px 16px;
  border-bottom: 1px solid #30363d;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.cm-discuss-header h3 { margin: 0; font-size: 14px; color: #e6edf3; }
.cm-discuss-header-actions { display: flex; align-items: center; gap: 8px; }
.cm-discuss-resolve-btn {
  background: none; border: 1px solid #30363d; color: #8b949e;
  border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer;
  display: flex; align-items: center; gap: 4px; transition: all 0.15s; font-family: inherit;
}
.cm-discuss-resolve-btn:hover { border-color: #238636; color: #238636; background: rgba(35,134,54,0.1); }
.cm-discuss-resolve-btn.resolved { border-color: #238636; color: #238636; background: rgba(35,134,54,0.15); }
.cm-discuss-close {
  background: none; border: none; color: #8b949e; font-size: 18px; cursor: pointer; padding: 2px 6px;
}
.cm-discuss-close:hover { color: #e6edf3; }

.cm-discuss-quote {
  padding: 10px 16px;
  background: #0d1117;
  border-left: 3px solid #e3b341;
  margin: 12px 16px 0;
  font-size: 13px;
  color: #8b949e;
  max-height: 60px;
  overflow-y: auto;
  border-radius: 0 6px 6px 0;
}
.cm-discuss-quote.resolved { border-left-color: #238636; opacity: 0.7; }

.cm-discuss-resolved-banner {
  margin: 8px 16px; padding: 8px 12px;
  background: rgba(35,134,54,0.1); border: 1px solid rgba(35,134,54,0.3);
  border-radius: 6px; color: #238636; font-size: 12px;
  display: none; flex-direction: column; gap: 8px;
}
.cm-discuss-resolved-banner.visible { display: flex; }

.cm-ai-edit-btn {
  background: #8957e5; color: #fff; border: none; border-radius: 6px;
  padding: 6px 12px; font-size: 12px; cursor: pointer; width: 100%;
  display: flex; align-items: center; justify-content: center; gap: 4px;
  font-family: inherit;
}
.cm-ai-edit-btn:hover { background: #a371f7; }
.cm-ai-edit-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.cm-ai-edit-btn.done { background: #238636; }
.cm-ai-edit-btn.done:hover { background: #2ea043; }

.cm-discuss-messages { flex: 1; overflow-y: auto; padding: 8px 16px; }
.cm-discuss-message { margin-bottom: 10px; padding: 0; font-size: 13px; line-height: 1.5; }
.cm-discuss-message .cm-msg-header {
  display: flex; align-items: center; gap: 6px; margin-bottom: 3px;
}
.cm-discuss-message .cm-msg-avatar {
  width: 22px; height: 22px; border-radius: 50%; display: flex;
  align-items: center; justify-content: center; font-size: 11px; flex-shrink: 0;
}
.cm-discuss-message.user .cm-msg-avatar   { background: #1f6feb; color: #fff; }
.cm-discuss-message.assistant .cm-msg-avatar { background: #8957e5; color: #fff; }
.cm-msg-name  { font-size: 12px; font-weight: 600; color: #e6edf3; }
.cm-msg-time  { font-size: 11px; color: #484f58; }
.cm-msg-body  { padding-left: 28px; color: #c9d1d9; }
.cm-msg-body p { margin: 0 0 6px; }
.cm-msg-body p:last-child { margin-bottom: 0; }
.cm-discuss-waiting {
  text-align: center; padding: 6px; color: #8b949e; font-size: 12px; font-style: italic;
}

.cm-discuss-input-area {
  padding: 8px 16px 12px; border-top: 1px solid #30363d;
  display: flex; align-items: center; gap: 8px;
}
.cm-discuss-input {
  flex: 1; background: #0d1117; border: 1px solid #30363d; border-radius: 20px;
  padding: 8px 14px; color: #e6edf3; font-size: 13px;
  outline: none; font-family: inherit;
}
.cm-discuss-input:focus { border-color: #e3b341; }
.cm-discuss-input::placeholder { color: #484f58; }
.cm-discuss-send-btn {
  background: none; border: none; color: #8b949e; font-size: 18px;
  cursor: pointer; padding: 4px; flex-shrink: 0; transition: color 0.15s;
}
.cm-discuss-send-btn:hover { color: #e3b341; }
.cm-discuss-send-btn:disabled { opacity: 0.3; cursor: not-allowed; }

/* ─── Discussion list panel ─── */
.cm-discuss-list-panel {
  position: fixed; top: 60px; right: 20px; width: 380px; max-height: 500px;
  background: #161b22; border: 1px solid #30363d; border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.4); z-index: 9001;
  display: none; flex-direction: column;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.cm-discuss-list-panel.visible { display: flex; }
.cm-discuss-list-header {
  padding: 12px 16px; border-bottom: 1px solid #30363d;
  display: flex; justify-content: space-between; align-items: center;
}
.cm-discuss-list-header h3 { margin: 0; font-size: 14px; color: #e6edf3; }
.cm-discuss-list-close { background: none; border: none; color: #8b949e; font-size: 20px; cursor: pointer; }
.cm-discuss-list-tabs {
  display: flex; gap: 0; padding: 0 16px; border-bottom: 1px solid #30363d;
}
.cm-discuss-list-tab {
  padding: 8px 14px; font-size: 12px; color: #8b949e; cursor: pointer;
  border-bottom: 2px solid transparent;
  background: none; border-top: none; border-left: none; border-right: none;
  font-family: inherit;
}
.cm-discuss-list-tab:hover { color: #e6edf3; }
.cm-discuss-list-tab.active { color: #e6edf3; border-bottom-color: #e3b341; }
.cm-discuss-list-items { flex: 1; overflow-y: auto; max-height: 400px; }
.cm-discuss-list-item {
  padding: 12px 16px; border-bottom: 1px solid #21262d; cursor: pointer;
  display: flex; gap: 10px; align-items: flex-start;
}
.cm-discuss-list-item:hover { background: #21262d; }
.cm-item-indicator { width: 3px; border-radius: 2px; min-height: 36px; flex-shrink: 0; margin-top: 2px; }
.cm-item-indicator.open { background: #e3b341; }
.cm-item-indicator.resolved { background: #238636; }
.cm-item-content { flex: 1; min-width: 0; }
.cm-item-quote {
  font-size: 12px; color: #8b949e; margin-bottom: 3px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.cm-item-preview {
  font-size: 13px; color: #c9d1d9;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.cm-item-meta {
  font-size: 11px; color: #484f58; margin-top: 3px;
  display: flex; align-items: center; gap: 6px;
}
.cm-status-badge {
  display: inline-block; padding: 1px 6px; border-radius: 10px;
  font-size: 10px; font-weight: 600;
}
.cm-status-badge.open     { background: rgba(227,179,65,0.2); color: #e3b341; }
.cm-status-badge.resolved { background: rgba(35,134,54,0.2);  color: #238636; }
.cm-discuss-list-empty { padding: 24px 16px; text-align: center; color: #484f58; font-size: 13px; }

/* ─── Auth modal ─── */
.cm-auth-modal {
  position: fixed; top: 0; left: 0; width: 100%; height: 100%;
  background: rgba(0,0,0,0.8); z-index: 9500;
  display: none; justify-content: center; align-items: center;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.cm-auth-modal.visible { display: flex; }
.cm-auth-box {
  background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 24px; width: 300px;
}
.cm-auth-box h3 { margin: 0 0 16px; color: #e6edf3; }
.cm-auth-box input {
  width: 100%; padding: 10px; background: #0d1117; border: 1px solid #30363d;
  border-radius: 6px; color: #e6edf3; font-size: 14px; margin-bottom: 12px;
  box-sizing: border-box; font-family: inherit;
}
.cm-auth-box input:focus { outline: none; border-color: #8957e5; }
.cm-auth-box button {
  width: 100%; padding: 10px; background: #8957e5; color: #fff; border: none;
  border-radius: 6px; cursor: pointer; font-size: 14px; font-family: inherit;
}
.cm-auth-box button:hover { background: #a371f7; }
.cm-auth-error { color: #f85149; font-size: 13px; margin-top: 8px; }

@media (max-width: 768px) {
  .cm-discuss-panel { width: calc(100% - 20px); left: 10px; right: 10px; }
}

/* ─── Sidebar mode ─── */
.cm-comment-sidebar {
  position: fixed;
  top: 0;
  width: 380px;
  height: 100%;
  background: #161b22;
  z-index: 9002;
  display: flex;
  flex-direction: column;
  transition: transform 0.25s ease;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.cm-comment-sidebar.cm-pos-right {
  right: 0;
  border-left: 1px solid #30363d;
  transform: translateX(100%);
}
.cm-comment-sidebar.cm-pos-left {
  left: 0;
  border-right: 1px solid #30363d;
  transform: translateX(-100%);
}
.cm-comment-sidebar.cm-open { transform: translateX(0); }

.cm-sidebar-header {
  padding: 10px 16px;
  border-bottom: 1px solid #30363d;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
}
.cm-sidebar-title {
  flex: 1;
  font-size: 14px;
  font-weight: 600;
  color: #e6edf3;
  margin: 0;
}
.cm-sidebar-back-btn {
  background: none; border: none; color: #8b949e; cursor: pointer;
  font-size: 13px; padding: 4px 8px; border-radius: 4px;
  font-family: inherit;
}
.cm-sidebar-back-btn:hover { background: #21262d; color: #e6edf3; }
.cm-sidebar-resolve-btn {
  background: none; border: 1px solid #30363d; color: #8b949e;
  border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer;
  display: flex; align-items: center; gap: 4px; transition: all 0.15s; font-family: inherit;
}
.cm-sidebar-resolve-btn:hover { border-color: #238636; color: #238636; background: rgba(35,134,54,0.1); }
.cm-sidebar-resolve-btn.resolved { border-color: #238636; color: #238636; background: rgba(35,134,54,0.15); }
.cm-sidebar-close-btn {
  background: none; border: none; color: #8b949e; font-size: 18px;
  cursor: pointer; padding: 2px 6px;
}
.cm-sidebar-close-btn:hover { color: #e6edf3; }

/* Override child panel styles when inside sidebar */
.cm-comment-sidebar .cm-discuss-list-panel,
.cm-comment-sidebar .cm-discuss-panel {
  position: static !important;
  width: auto !important;
  height: auto !important;
  max-height: none !important;
  border: none !important;
  border-radius: 0 !important;
  box-shadow: none !important;
  top: auto !important;
  right: auto !important;
  bottom: auto !important;
  left: auto !important;
  z-index: auto !important;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.cm-comment-sidebar .cm-discuss-list-panel.visible,
.cm-comment-sidebar .cm-discuss-panel.visible {
  display: flex;
}

/* Hide panels' own headers in sidebar (sidebar header replaces them) */
.cm-comment-sidebar .cm-discuss-list-header,
.cm-comment-sidebar .cm-discuss-header,
.cm-comment-sidebar .cm-discuss-resize-handle {
  display: none !important;
}

@media (max-width: 768px) {
  .cm-comment-sidebar { width: 100%; }
}
`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(t) {
  const d = document.createElement('div');
  d.textContent = t;
  return d.innerHTML;
}

function formatTime(ts) {
  if (!ts) return '';
  const d   = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export class CommentPlugin {
  /**
   * @param {import('../../core/clawmark.js').ClawMark} core
   * @param {object} options
   * @param {string}   [options.contentSelector] - CSS selector for the content area
   * @param {Function} [options.authHandler]     - async fn() called when auth needed
   */
  constructor(core, options = {}) {
    this.core = core;
    this.opts = {
      contentSelector:  options.contentSelector  || 'body',
      authHandler:      options.authHandler      || null,
      panelMode:        options.panelMode        || 'float',
      sidebarPosition:  options.sidebarPosition  || 'right',
      sidebarWidth:     options.sidebarWidth     || 380,
      sidebarTopOffset: options.sidebarTopOffset || 0,
    };
    this._isSidebar = this.opts.panelMode === 'sidebar';

    // State
    this._discussions       = [];
    this._currentDiscId     = null;
    this._selectedText      = '';
    this._listFilter        = 'open';
    this._pollingInterval   = null;

    // DOM
    this._styleEl      = null;
    this._discussBtn   = null;
    this._panel        = null;
    this._listPanel    = null;
    this._commentCount = null;
    this._authModal    = null;
    this._sidebar      = null;
    this._sidebarHeader = null;

    // Pending auth resolve
    this._authResolve = null;

    // Bound handlers
    this._onMouseUp     = this._onSelectionChange.bind(this);
    this._onTouchEnd    = this._onSelectionChange.bind(this);
    this._onMouseMoveDoc = this._onDocMouseMove.bind(this);
    this._unsubs        = [];
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  mount() {
    this._injectCSS();
    this._buildDOM();
    this._bindEvents();

    this._unsubs.push(
      this.core.events.on('doc:changed', () => {
        this._discussions   = [];
        this._currentDiscId = null;
        this._stopPolling();
        this._clearHighlights();
        this._updateCommentCount();
        if (this.core.docId) this._loadAllDiscussions();
      }),
      this.core.events.on('user:changed', () => {
        this._renderUserState();
      }),
    );

    if (this.core.docId) this._loadAllDiscussions();
    this._renderUserState();
  }

  destroy() {
    this._unsubs.forEach(fn => fn());
    this._unsubs = [];
    this._stopPolling();
    this._removeDOM();
    document.removeEventListener('mouseup',    this._onMouseUp);
    document.removeEventListener('touchend',   this._onTouchEnd);
    document.removeEventListener('mousemove',  this._onMouseMoveDoc);
  }

  // ─── CSS ───────────────────────────────────────────────────────────────────

  _injectCSS() {
    this._styleEl = document.createElement('style');
    this._styleEl.id = 'clawmark-comment-styles';
    this._styleEl.textContent = CSS;
    document.head.appendChild(this._styleEl);
  }

  // ─── DOM ───────────────────────────────────────────────────────────────────

  _buildDOM() {
    // Discuss bubble button (always on body — appears near text selection)
    this._discussBtn = document.createElement('button');
    this._discussBtn.className = 'cm-discuss-btn';
    this._discussBtn.innerHTML = '&#128172; 讨论';
    document.body.appendChild(this._discussBtn);

    // Comment count badge (float mode only)
    this._commentCount = document.createElement('div');
    this._commentCount.className = 'cm-comment-count';
    if (!this._isSidebar) document.body.appendChild(this._commentCount);

    // Discussion panel
    this._panel = this._buildPanel();

    // Discussion list panel
    this._listPanel = this._buildListPanel();

    // Auth modal (always on body)
    this._authModal = this._buildAuthModal();
    document.body.appendChild(this._authModal);

    if (this._isSidebar) {
      this._buildSidebar();
    } else {
      document.body.appendChild(this._panel);
      document.body.appendChild(this._listPanel);
    }
  }

  _buildSidebar() {
    this._sidebar = document.createElement('div');
    this._sidebar.className = `cm-comment-sidebar cm-pos-${this.opts.sidebarPosition}`;
    if (this.opts.sidebarWidth !== 380) {
      this._sidebar.style.width = this.opts.sidebarWidth + 'px';
    }
    if (this.opts.sidebarTopOffset) {
      this._sidebar.style.top = this.opts.sidebarTopOffset + 'px';
      this._sidebar.style.height = `calc(100% - ${this.opts.sidebarTopOffset}px)`;
    }

    // Sidebar header
    this._sidebarHeader = document.createElement('div');
    this._sidebarHeader.className = 'cm-sidebar-header';
    this._sidebarHeader.innerHTML = `
      <button class="cm-sidebar-back-btn" style="display:none;">← Back</button>
      <span class="cm-sidebar-title">Comments</span>
      <button class="cm-sidebar-resolve-btn" style="display:none;">✓ Resolve</button>
      <button class="cm-sidebar-close-btn">✕</button>
    `;

    this._sidebar.appendChild(this._sidebarHeader);
    this._sidebar.appendChild(this._listPanel);
    this._sidebar.appendChild(this._panel);
    document.body.appendChild(this._sidebar);

    // Start with list view visible
    this._listPanel.classList.add('visible');
  }

  _buildPanel() {
    const el = document.createElement('div');
    el.className = 'cm-discuss-panel';
    el.innerHTML = `
      <div class="cm-discuss-resize-handle"></div>
      <div class="cm-discuss-header">
        <h3 class="cm-discuss-header-title">讨论</h3>
        <div class="cm-discuss-header-actions">
          <button class="cm-discuss-resolve-btn">✓ Resolve</button>
          <button class="cm-discuss-close">✕</button>
        </div>
      </div>
      <div class="cm-discuss-quote"></div>
      <div class="cm-discuss-resolved-banner">
        <span>✅ Resolved</span>
        <button class="cm-ai-edit-btn">🤖 AI 改文档</button>
      </div>
      <div class="cm-discuss-messages"></div>
      <div class="cm-discuss-input-area">
        <input type="text" class="cm-discuss-input" placeholder="Reply..." />
        <button class="cm-discuss-send-btn">▷</button>
      </div>
    `;
    return el;
  }

  _buildListPanel() {
    const el = document.createElement('div');
    el.className = 'cm-discuss-list-panel';
    el.innerHTML = `
      <div class="cm-discuss-list-header">
        <h3 class="cm-discuss-list-title">Comments</h3>
        <button class="cm-discuss-list-close">✕</button>
      </div>
      <div class="cm-discuss-list-tabs">
        <button class="cm-discuss-list-tab active" data-filter="open">Open</button>
        <button class="cm-discuss-list-tab" data-filter="resolved">Resolved</button>
        <button class="cm-discuss-list-tab" data-filter="all">All</button>
      </div>
      <div class="cm-discuss-list-items"></div>
    `;
    return el;
  }

  _buildAuthModal() {
    const el = document.createElement('div');
    el.className = 'cm-auth-modal';
    el.innerHTML = `
      <div class="cm-auth-box">
        <h3>🔒 登录</h3>
        <p style="color:#8b949e;font-size:13px;margin:0 0 12px;">输入邀请码登录，参与文档讨论</p>
        <input type="text" class="cm-invite-input" placeholder="邀请码">
        <button class="cm-auth-submit">确认</button>
        <div class="cm-auth-error"></div>
      </div>
    `;
    return el;
  }

  _removeDOM() {
    if (this._isSidebar) this._sidebar?.remove();
    [this._styleEl, this._discussBtn, this._commentCount,
     this._panel, this._listPanel, this._authModal]
      .forEach(el => el?.remove());
    this._clearHighlights();
  }

  // ─── Events ────────────────────────────────────────────────────────────────

  _bindEvents() {
    // Text selection
    document.addEventListener('mouseup',  this._onMouseUp);
    document.addEventListener('touchend', this._onTouchEnd);

    // Dismiss discuss button when mouse moves far away
    document.addEventListener('mousemove', this._onMouseMoveDoc);

    // Discuss button click
    this._discussBtn.addEventListener('click', () => {
      this._discussBtn.style.display = 'none';
      if (!this.core.user) {
        this._requireAuth().then(() => this._openPanel(true));
      } else {
        this._openPanel(true);
      }
    });

    // Panel close
    this._panel.querySelector('.cm-discuss-close')
      .addEventListener('click', () => this._closePanel());

    // Resolve button
    this._panel.querySelector('.cm-discuss-resolve-btn')
      .addEventListener('click', () => this._toggleResolve());

    // AI edit button
    this._panel.querySelector('.cm-ai-edit-btn')
      .addEventListener('click', () => this._requestAiEdit());

    // Resize handle (drag to resize panel height)
    const resizeHandle = this._panel.querySelector('.cm-discuss-resize-handle');
    let isResizing = false, startY = 0, startHeight = 0;
    resizeHandle.addEventListener('mousedown', e => {
      isResizing   = true;
      startY       = e.clientY;
      startHeight  = this._panel.offsetHeight;
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!isResizing) return;
      const newH = Math.max(250, Math.min(startHeight - (e.clientY - startY), window.innerHeight - 40));
      this._panel.style.height = newH + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (isResizing) { isResizing = false; document.body.style.userSelect = ''; }
    });

    // Send message
    const sendBtn   = this._panel.querySelector('.cm-discuss-send-btn');
    const inputEl   = this._panel.querySelector('.cm-discuss-input');
    sendBtn.addEventListener('click',      () => this._sendMessage());
    inputEl.addEventListener('keypress', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._sendMessage(); }
    });

    // Image paste in input
    inputEl.addEventListener('paste', async e => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          try {
            const result = await this.core.api.uploadImage(item.getAsFile(), this.core.docId || undefined);
            inputEl.value += (inputEl.value ? ' ' : '') +
              (result.url ? `![image](${result.url})` : '[图片上传失败]');
          } catch { inputEl.value += ' [图片上传失败]'; }
          break;
        }
      }
    });

    // Comment count → open list panel
    this._commentCount.addEventListener('click', () => this._openListPanel());

    // List panel close
    this._listPanel.querySelector('.cm-discuss-list-close')
      .addEventListener('click', () => {
        if (this._isSidebar) this.close();
        else this._listPanel.classList.remove('visible');
      });

    // Sidebar-specific bindings
    if (this._isSidebar && this._sidebarHeader) {
      this._sidebarHeader.querySelector('.cm-sidebar-close-btn')
        .addEventListener('click', () => this.close());
      this._sidebarHeader.querySelector('.cm-sidebar-back-btn')
        .addEventListener('click', () => this._sidebarShowList());
      this._sidebarHeader.querySelector('.cm-sidebar-resolve-btn')
        .addEventListener('click', () => this._toggleResolve());
    }

    // List panel tab clicks
    this._listPanel.querySelectorAll('.cm-discuss-list-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        this._listFilter = tab.dataset.filter;
        this._listPanel.querySelectorAll('.cm-discuss-list-tab')
          .forEach(t => t.classList.toggle('active', t === tab));
        this._renderDiscussList();
      });
    });

    // Auth modal submit
    this._authModal.querySelector('.cm-auth-submit')
      .addEventListener('click', () => this._submitAuth());
    this._authModal.querySelector('.cm-invite-input')
      .addEventListener('keypress', e => { if (e.key === 'Enter') this._submitAuth(); });
  }

  // ─── Text selection ────────────────────────────────────────────────────────

  _onSelectionChange(e) {
    setTimeout(() => {
      const sel  = window.getSelection();
      const text = sel ? sel.toString().trim() : '';

      // Check if selection is inside our configured content area
      const contentRoot = document.querySelector(this.opts.contentSelector) || document.body;
      const insideContent = sel && sel.anchorNode && contentRoot.contains(sel.anchorNode);

      if (text && text.length > 1 && insideContent) {
        this._selectedText = text;
        this._discussBtn.style.display = 'block';
        if (window.innerWidth > 768) {
          const rect = sel.getRangeAt(0).getBoundingClientRect();
          this._discussBtn.style.left   = Math.max(10, Math.min(rect.left + rect.width / 2 - 40, window.innerWidth - 90)) + 'px';
          this._discussBtn.style.top    = (rect.bottom + window.scrollY + 10) + 'px';
          this._discussBtn.style.bottom = 'auto';
          this._discussBtn.style.right  = 'auto';
        } else {
          this._discussBtn.style.bottom = '80px';
          this._discussBtn.style.right  = '20px';
          this._discussBtn.style.left   = 'auto';
          this._discussBtn.style.top    = 'auto';
        }
      } else if (e && !this._discussBtn.contains(e.target)) {
        this._discussBtn.style.display = 'none';
      }
    }, 100);
  }

  _onDocMouseMove(e) {
    // Hide the discuss button if the pointer drifts far from it
    if (this._discussBtn.style.display !== 'block') return;
    const rect = this._discussBtn.getBoundingClientRect();
    const cx   = rect.left + rect.width  / 2;
    const cy   = rect.top  + rect.height / 2;
    if (Math.hypot(e.clientX - cx, e.clientY - cy) > 200) {
      this._discussBtn.style.display = 'none';
    }
  }

  // ─── Panel open / close ────────────────────────────────────────────────────

  _openPanel(isNew) {
    const quoteEl     = this._panel.querySelector('.cm-discuss-quote');
    const titleEl     = this._panel.querySelector('.cm-discuss-header-title');
    const resolveBtn  = this._panel.querySelector('.cm-discuss-resolve-btn');
    const resolvedBnr = this._panel.querySelector('.cm-discuss-resolved-banner');
    const inputArea   = this._panel.querySelector('.cm-discuss-input-area');
    const messagesEl  = this._panel.querySelector('.cm-discuss-messages');

    const quote = this._selectedText.substring(0, 200) +
      (this._selectedText.length > 200 ? '...' : '');
    quoteEl.textContent = quote;
    quoteEl.classList.remove('resolved');

    if (isNew) {
      messagesEl.innerHTML = '';
      this._currentDiscId  = null;
      resolvedBnr.classList.remove('visible');
      resolveBtn.classList.remove('resolved');
      resolveBtn.textContent = '✓ Resolve';
      inputArea.style.display = 'flex';
      titleEl.textContent = '新讨论';
    }

    if (this._isSidebar) {
      this._listPanel.classList.remove('visible');
      this._panel.classList.add('visible');
      this._sidebar.classList.add('cm-open');
      this._sidebarUpdateHeader('detail');
    } else {
      this._panel.classList.add('visible');
    }
    this._panel.querySelector('.cm-discuss-input').focus();
  }

  _closePanel() {
    if (this._isSidebar) {
      // Go back to list view within the sidebar
      this._panel.classList.remove('visible');
      this._sidebarShowList();
    } else {
      this._panel.classList.remove('visible');
    }
    this._stopPolling();
  }

  // ─── Send message ──────────────────────────────────────────────────────────

  async _sendMessage() {
    const inputEl = this._panel.querySelector('.cm-discuss-input');
    const sendBtn = this._panel.querySelector('.cm-discuss-send-btn');
    const message = inputEl.value.trim();
    if (!message || !this.core.user) return;

    sendBtn.disabled = true;
    try {
      if (this._currentDiscId) {
        // Reply on existing discussion — try V2, fallback to V1
        try {
          await this.core.api.addMessage(this._currentDiscId, {
            content:  message,
            userName: this.core.user,
          });
        } catch {
          await this.core.api.sendMessageV1({
            docId:        this.core.docId,
            discussionId: this._currentDiscId,
            quote:        this._selectedText,
            message,
            userName:     this.core.user,
          });
        }
      } else {
        // Create new discussion
        const result = await this.core.api.createItem({
          doc:          this.core.docId,
          type:         'discuss',
          quote:        this._selectedText,
          message,
          userName:     this.core.user,
          source_url:   this.core.sourceUrl || undefined,
          source_title: this.core.sourceTitle || undefined,
        });
        if (result.success) this._currentDiscId = result.item.id;
      }

      inputEl.value = '';
      await this._loadDiscussion(this._currentDiscId);
      this._startPolling();
    } catch (err) { console.error('[ClawMark CommentPlugin] sendMessage:', err); }
    sendBtn.disabled = false;
  }

  // ─── Load single discussion ────────────────────────────────────────────────

  async _loadDiscussion(id) {
    if (!id) return;
    try {
      // Try V2
      const item = await this.core.api.getItem(id);
      if (item && !item.error) {
        const idx = this._discussions.findIndex(d => d.id === id);
        if (idx !== -1) this._discussions[idx] = item; else this._discussions.push(item);
        this._renderDiscussion(item);
        this._updateCommentCount();
        this._highlightComments();
        return;
      }
    } catch {}

    // Fallback: V1 reload
    try {
      const v1 = await this.core.api.listDiscussionsV1(this.core.docId);
      const disc = v1.find(d => d.id === id);
      if (disc) {
        const idx = this._discussions.findIndex(d => d.id === id);
        if (idx !== -1) this._discussions[idx] = disc; else this._discussions.push(disc);
        this._renderDiscussion(disc);
      }
    } catch {}
  }

  // ─── Render discussion panel ───────────────────────────────────────────────

  _renderDiscussion(item) {
    const msgs        = (item.messages || []).filter(m => !m.pending);
    const isResolved  = item.status === 'resolved' || item.status === 'closed';
    const titleEl     = this._panel.querySelector('.cm-discuss-header-title');
    const quoteEl     = this._panel.querySelector('.cm-discuss-quote');
    const resolveBtn  = this._panel.querySelector('.cm-discuss-resolve-btn');
    const resolvedBnr = this._panel.querySelector('.cm-discuss-resolved-banner');
    const aiEditBtn   = this._panel.querySelector('.cm-ai-edit-btn');
    const inputArea   = this._panel.querySelector('.cm-discuss-input-area');
    const messagesEl  = this._panel.querySelector('.cm-discuss-messages');

    titleEl.textContent = isResolved ? '已解决' : '讨论';
    quoteEl.textContent = (item.quote || '').substring(0, 200);
    quoteEl.classList.toggle('resolved', isResolved);

    resolveBtn.classList.toggle('resolved', isResolved);
    resolveBtn.textContent = isResolved ? '✓ Resolved' : '✓ Resolve';

    resolvedBnr.classList.toggle('visible', isResolved);
    inputArea.style.display = isResolved ? 'none' : 'flex';

    // AI edit button state
    let meta = {};
    try { meta = item.metadata ? (typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata) : {}; } catch {}
    if (meta.aiEditRequested) {
      aiEditBtn.textContent = '✅ 已通知，等待文档更新';
      aiEditBtn.classList.add('done');
      aiEditBtn.disabled = true;
    } else {
      aiEditBtn.textContent = '🤖 AI 改文档';
      aiEditBtn.classList.remove('done');
      aiEditBtn.disabled = false;
    }

    // Render messages
    const DOMPurify = window.DOMPurify;
    const marked    = window.marked;

    messagesEl.innerHTML = msgs.map(m => {
      const isUser = m.role === 'user';
      const name   = isUser ? (m.user_name || m.userName || 'User') : 'Assistant';
      const initial = name.charAt(0).toUpperCase();
      const time   = formatTime(m.created_at || m.timestamp);
      let body;
      if (isUser) {
        body = escapeHtml(m.content);
      } else if (DOMPurify && marked) {
        body = DOMPurify.sanitize(marked.parse(m.content));
      } else {
        body = escapeHtml(m.content);
      }
      return `<div class="cm-discuss-message ${m.role}">
        <div class="cm-msg-header">
          <div class="cm-msg-avatar">${initial}</div>
          <span class="cm-msg-name">${escapeHtml(name)}</span>
          <span class="cm-msg-time">${time}</span>
        </div>
        <div class="cm-msg-body">${body}</div>
      </div>`;
    }).join('');

    // Waiting indicator
    if (!isResolved && msgs.length > 0 && msgs[msgs.length - 1].role === 'user') {
      messagesEl.innerHTML += '<div class="cm-discuss-waiting">正在回复...</div>';
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;

    // Update sidebar header if in detail view
    if (this._isSidebar) this._sidebarUpdateHeader('detail');
  }

  // ─── Resolve / reopen ──────────────────────────────────────────────────────

  async _toggleResolve() {
    if (!this._currentDiscId) return;
    const disc = this._discussions.find(d => d.id === this._currentDiscId);
    const isResolved = disc && (disc.status === 'resolved' || disc.status === 'closed');
    const action = isResolved ? 'reopen' : 'resolve';
    try {
      try {
        await this.core.api.updateItemStatus(this._currentDiscId, action);
      } catch {
        await this.core.api.resolveV1(this.core.docId, this._currentDiscId, action);
      }
      await this._loadDiscussion(this._currentDiscId);
      await this._loadAllDiscussions();
    } catch (err) { console.error('[ClawMark CommentPlugin] toggleResolve:', err); }
  }

  // ─── AI edit ───────────────────────────────────────────────────────────────

  async _requestAiEdit() {
    if (!this._currentDiscId || !this.core.user) return;
    const aiEditBtn = this._panel.querySelector('.cm-ai-edit-btn');
    aiEditBtn.disabled = true;
    aiEditBtn.textContent = '⏳ 正在通知...';
    try {
      try {
        await this.core.api.requestAiEdit(this._currentDiscId, this.core.user);
        aiEditBtn.textContent = '✅ 已通知，等待文档更新';
        aiEditBtn.classList.add('done');
      } catch {
        await this.core.api.applyV1(this.core.docId, this._currentDiscId, this.core.user);
        aiEditBtn.textContent = '✅ 已通知，等待文档更新';
        aiEditBtn.classList.add('done');
      }
    } catch {
      aiEditBtn.textContent = '❌ 发送失败';
      setTimeout(() => {
        aiEditBtn.textContent = '🤖 AI 改文档';
        aiEditBtn.disabled = false;
        aiEditBtn.classList.remove('done');
      }, 2000);
    }
  }

  // ─── Polling ───────────────────────────────────────────────────────────────

  _startPolling() {
    this._stopPolling();
    this._pollingInterval = setInterval(async () => {
      if (this._currentDiscId) await this._loadDiscussion(this._currentDiscId);
    }, 3000);
  }

  _stopPolling() {
    if (this._pollingInterval) { clearInterval(this._pollingInterval); this._pollingInterval = null; }
  }

  // ─── Load all discussions ──────────────────────────────────────────────────

  async _loadAllDiscussions() {
    if (!this.core.docId) return;

    let v2Items = [], v1Items = [];

    try {
      const data = await this.core.api.listItemsFull(this.core.docId);
      v2Items = data.items || [];
    } catch {}

    try {
      v1Items = await this.core.api.listDiscussionsV1(this.core.docId);
    } catch {}

    const v2Ids = new Set(v2Items.map(i => i.id));
    this._discussions = [...v2Items, ...v1Items.filter(d => !v2Ids.has(d.id))];

    // Filter to only discussions (not issues)
    this._discussions = this._discussions.filter(d => !d.type || d.type === 'discuss');

    this._updateCommentCount();
    this._highlightComments();
  }

  // ─── Comment count badge ───────────────────────────────────────────────────

  _updateCommentCount() {
    const openCount  = this._discussions.filter(d => this._discStatus(d) === 'open').length;
    const totalCount = this._discussions.length;

    this.core.events.emit('comment:count:updated', { open: openCount, total: totalCount });

    if (this._isSidebar) {
      // Sidebar mode: update sidebar header if list view is active
      if (this._listPanel.classList.contains('visible')) {
        this._sidebarUpdateHeader('list');
      }
      return;
    }

    // Float mode: update badge
    if (totalCount > 0) {
      const label = openCount > 0 ? `💬 ${openCount} open` : `💬 ${totalCount} comments`;
      this._commentCount.textContent    = label;
      this._commentCount.style.display  = 'block';
    } else {
      this._commentCount.style.display  = 'none';
    }
  }

  _discStatus(disc) {
    if (disc.status === 'resolved' || disc.status === 'closed' || disc.status === 'verified') return 'resolved';
    return 'open';
  }

  // ─── Inline comment highlights ─────────────────────────────────────────────

  _clearHighlights() {
    document.querySelectorAll('.cm-comment-highlight').forEach(el => {
      el.replaceWith(document.createTextNode(el.textContent));
    });
  }

  _highlightComments() {
    this._clearHighlights();
    const contentRoot = document.querySelector(this.opts.contentSelector) || document.body;

    this._discussions.forEach(disc => {
      if (!disc.quote || disc.quote.trim().length < 10) return;
      const needle = disc.quote.substring(0, 50);
      const walker = document.createTreeWalker(contentRoot, NodeFilter.SHOW_TEXT, null, false);
      let node;
      while ((node = walker.nextNode())) {
        const idx = node.textContent.indexOf(needle);
        if (idx !== -1) {
          const range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, Math.min(idx + disc.quote.length, node.textContent.length));
          const span = document.createElement('span');
          span.className = 'cm-comment-highlight' + (this._discStatus(disc) === 'resolved' ? ' resolved' : '');
          span.dataset.discussionId = disc.id;
          span.addEventListener('click', () => this._openDiscussionById(disc.id));
          try { range.surroundContents(span); } catch {}
          break;
        }
      }
    });
  }

  _openDiscussionById(id) {
    const disc = this._discussions.find(d => d.id === id);
    if (!disc) return;
    this._selectedText  = disc.quote || '';
    this._currentDiscId = disc.id;
    this._renderDiscussion(disc);
    if (this._isSidebar) {
      this._listPanel.classList.remove('visible');
      this._panel.classList.add('visible');
      this._sidebar.classList.add('cm-open');
      this._sidebarUpdateHeader('detail');
    } else {
      this._panel.classList.add('visible');
    }
    this._startPolling();
  }

  // ─── Discussion list panel ─────────────────────────────────────────────────

  _openListPanel() {
    if (!this._discussions.length) return;
    const openCount     = this._discussions.filter(d => this._discStatus(d) === 'open').length;
    const resolvedCount = this._discussions.filter(d => this._discStatus(d) === 'resolved').length;

    if (openCount === 0 && this._listFilter === 'open') this._listFilter = 'all';

    this._listPanel.querySelector('.cm-discuss-list-title').textContent = `Comments (${this._discussions.length})`;
    this._listPanel.querySelectorAll('.cm-discuss-list-tab').forEach(tab => {
      const f = tab.dataset.filter;
      if      (f === 'open')     tab.textContent = `Open (${openCount})`;
      else if (f === 'resolved') tab.textContent = `Resolved (${resolvedCount})`;
      else                       tab.textContent = `All (${this._discussions.length})`;
      tab.classList.toggle('active', f === this._listFilter);
    });

    this._renderDiscussList();

    if (this._isSidebar) {
      this._panel.classList.remove('visible');
      this._listPanel.classList.add('visible');
      this._sidebar.classList.add('cm-open');
      this._sidebarUpdateHeader('list');
    } else {
      this._listPanel.classList.add('visible');
    }
  }

  _renderDiscussList() {
    const itemsEl = this._listPanel.querySelector('.cm-discuss-list-items');
    const filtered = this._listFilter === 'all'
      ? this._discussions
      : this._discussions.filter(d => this._discStatus(d) === this._listFilter);

    if (!filtered.length) {
      const labels = { open: '没有进行中的讨论', resolved: '没有已解决的讨论', all: '没有讨论' };
      itemsEl.innerHTML = `<div class="cm-discuss-list-empty">${labels[this._listFilter] || '没有讨论'}</div>`;
      return;
    }

    itemsEl.innerHTML = filtered.map(disc => {
      const last     = (disc.messages || []).filter(m => !m.pending).pop();
      const status   = this._discStatus(disc);
      const time     = formatTime(disc.created_at || disc.createdAt);
      const msgCount = (disc.messages || []).filter(m => !m.pending).length;
      const quoteSnip = (disc.quote || '').substring(0, 60);
      const quoteEllipsis = (disc.quote || '').length > 60 ? '...' : '';
      const previewSnip = (last?.content || '').substring(0, 80);
      const previewEllipsis = (last?.content || '').length > 80 ? '...' : '';
      return `<div class="cm-discuss-list-item" data-id="${disc.id}">
        <div class="cm-item-indicator ${status}"></div>
        <div class="cm-item-content">
          <div class="cm-item-quote">"${escapeHtml(quoteSnip)}${quoteEllipsis}"</div>
          <div class="cm-item-preview">${escapeHtml(previewSnip)}${previewEllipsis}</div>
          <div class="cm-item-meta">
            <span class="cm-status-badge ${status}">${status === 'resolved' ? 'Resolved' : 'Open'}</span>
            <span>${msgCount} replies</span>
            <span>${time}</span>
          </div>
        </div>
      </div>`;
    }).join('');

    itemsEl.querySelectorAll('.cm-discuss-list-item').forEach(item => {
      item.addEventListener('click', () => {
        this._listPanel.classList.remove('visible');
        this._openDiscussionById(item.dataset.id);
      });
    });
  }

  // ─── Auth ──────────────────────────────────────────────────────────────────

  _requireAuth() {
    if (this.core.user) return Promise.resolve();

    // Custom auth handler provided by integrator
    if (this.opts.authHandler) return this.opts.authHandler();

    // Built-in invite-code modal
    return new Promise(resolve => {
      this._authResolve = resolve;
      this._authModal.querySelector('.cm-invite-input').value = '';
      this._authModal.querySelector('.cm-auth-error').textContent = '';
      this._authModal.classList.add('visible');
      this._authModal.querySelector('.cm-invite-input').focus();
    });
  }

  async _submitAuth() {
    const input = this._authModal.querySelector('.cm-invite-input');
    const error = this._authModal.querySelector('.cm-auth-error');
    const code  = input.value.trim();
    if (!code) return;
    try {
      const result = await this.core.api.verifyCode(code);
      if (result.valid) {
        this.core.saveSession(result.userName);
        this._authModal.classList.remove('visible');
        this._renderUserState();
        if (this._authResolve) { this._authResolve(); this._authResolve = null; }
      } else {
        error.textContent = '无效的邀请码';
      }
    } catch {
      error.textContent = '验证失败，请重试';
    }
  }

  _renderUserState() {
    // Expose to integrators via event — no built-in user badge in core
    this.core.events.emit('comment:user:changed', { user: this.core.user });
  }

  // ─── Sidebar public API ───────────────────────────────────────────────────

  /** Toggle the sidebar open/closed. No-op in float mode. */
  toggle() {
    if (!this._isSidebar) return;
    if (this._sidebar.classList.contains('cm-open')) this.close();
    else this.open();
  }

  /** Open the sidebar (list view). No-op in float mode. */
  open() {
    if (!this._isSidebar) return;
    this._loadAllDiscussions();
    this._sidebarShowList();
    this._sidebar.classList.add('cm-open');
  }

  /** Close the sidebar. No-op in float mode. */
  close() {
    if (!this._isSidebar) return;
    this._sidebar.classList.remove('cm-open');
    this._stopPolling();
  }

  /** Whether the sidebar is currently open. */
  get isOpen() {
    return this._isSidebar && this._sidebar?.classList.contains('cm-open');
  }

  // ─── Sidebar helpers ──────────────────────────────────────────────────────

  _sidebarShowList() {
    if (!this._isSidebar) return;
    this._panel.classList.remove('visible');
    this._listPanel.classList.add('visible');
    this._renderDiscussList();
    this._sidebarUpdateHeader('list');
  }

  _sidebarUpdateHeader(view) {
    if (!this._sidebarHeader) return;
    const backBtn    = this._sidebarHeader.querySelector('.cm-sidebar-back-btn');
    const title      = this._sidebarHeader.querySelector('.cm-sidebar-title');
    const resolveBtn = this._sidebarHeader.querySelector('.cm-sidebar-resolve-btn');

    if (view === 'list') {
      backBtn.style.display    = 'none';
      resolveBtn.style.display = 'none';
      const openCount = this._discussions.filter(d => this._discStatus(d) === 'open').length;
      const total     = this._discussions.length;
      title.textContent = total > 0
        ? `Comments${openCount > 0 ? ` (${openCount} open)` : ` (${total})`}`
        : 'Comments';
    } else {
      backBtn.style.display    = '';
      resolveBtn.style.display = '';
      const disc = this._discussions.find(d => d.id === this._currentDiscId);
      const isResolved = disc && (disc.status === 'resolved' || disc.status === 'closed');
      resolveBtn.classList.toggle('resolved', !!isResolved);
      resolveBtn.textContent = isResolved ? '✓ Resolved' : '✓ Resolve';
      title.textContent = isResolved ? '已解决' : '讨论';
    }
  }
}
