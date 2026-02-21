/**
 * ClawMark FabPlugin
 *
 * Provides the floating action button (FAB) with a popup menu that gives
 * access to:
 *   1. Annotate mode  — click to place numbered pins on the page, then
 *                       screenshot + submit as an issue.
 *   2. Text feedback  — open the issue submission form directly.
 *   3. Issues panel   — list/detail view of issues for the current doc.
 *
 * The plugin is self-contained: it injects its own CSS, creates all its DOM
 * elements, and removes them on destroy().
 *
 * Plugin constructor signature: new FabPlugin(core, options)
 *   core    — ClawMark core instance
 *   options — { fabIcon, fabTitle, fabColor }
 */

// ─── CSS ─────────────────────────────────────────────────────────────────────

const CSS = `
/* FAB button */
.cm-fab {
  position: fixed;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: #8957e5;
  color: #fff;
  border: none;
  font-size: 16px;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(137,87,229,0.4);
  z-index: 9100;
  opacity: 0.5;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.2s, transform 0.15s, box-shadow 0.15s;
  user-select: none;
  touch-action: none;
}
.cm-fab:hover { opacity: 1; transform: scale(1.1); box-shadow: 0 6px 20px rgba(137,87,229,0.6); }
.cm-fab:active { transform: scale(0.95); }

/* FAB menu */
.cm-fab-backdrop {
  position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  z-index: 9099; display: none;
}
.cm-fab-backdrop.visible { display: block; }

.cm-fab-menu {
  position: fixed;
  z-index: 9101;
  display: none;
  flex-direction: column;
  gap: 6px;
}
.cm-fab-menu.visible { display: flex; }

.cm-fab-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 20px;
  color: #e6edf3;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
  transition: background 0.15s, transform 0.1s;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.cm-fab-menu-item:hover { background: #21262d; transform: scale(1.03); }
.cm-fab-menu-item .fab-icon { font-size: 16px; flex-shrink: 0; }

@media (max-width: 768px) {
  .cm-fab { width: 44px; height: 44px; font-size: 18px; }
  .cm-fab-menu-item { font-size: 14px; padding: 10px 16px; }
}

/* ─── Issue panel ─── */
.cm-issue-panel {
  position: fixed; top: 60px; right: 20px; width: 380px; max-height: 70vh;
  background: #161b22; border: 1px solid #30363d; border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.4); z-index: 9102;
  display: none; flex-direction: column;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.cm-issue-panel.visible { display: flex; }

.cm-issue-panel-header {
  padding: 12px 16px; border-bottom: 1px solid #30363d;
  display: flex; justify-content: space-between; align-items: center;
}
.cm-issue-panel-header h3 { margin: 0; font-size: 14px; color: #e6edf3; }
.cm-issue-panel-close {
  background: none; border: none; color: #8b949e; font-size: 20px; cursor: pointer;
}
.cm-issue-panel-filters {
  padding: 8px 16px; border-bottom: 1px solid #21262d; display: flex; gap: 6px; flex-wrap: wrap;
}
.cm-issue-filter-btn {
  padding: 3px 10px; border-radius: 12px; border: 1px solid #30363d;
  background: transparent; color: #8b949e; font-size: 12px; cursor: pointer;
}
.cm-issue-filter-btn.active { background: #8957e5; color: #fff; border-color: #8957e5; }
.cm-issue-filter-btn .count { margin-left: 4px; opacity: 0.7; }
.cm-issue-panel-list { flex: 1; overflow-y: auto; }

.cm-issue-item { padding: 12px 16px; border-bottom: 1px solid #21262d; cursor: pointer; }
.cm-issue-item:hover { background: #21262d; }
.cm-issue-item-title {
  font-size: 13px; color: #e6edf3; margin-bottom: 4px; display: flex; align-items: center; gap: 6px;
}
.cm-issue-item-meta { font-size: 11px; color: #8b949e; }

.cm-issue-priority { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
.cm-issue-priority.critical, .cm-issue-priority.high { background: #f85149; }
.cm-issue-priority.normal { background: #d29922; }
.cm-issue-priority.low { background: #8b949e; }

.cm-issue-status-badge {
  display: inline-block; padding: 1px 6px; border-radius: 10px;
  font-size: 10px; font-weight: 600; margin-left: auto; flex-shrink: 0;
}
.cm-issue-status-badge.open { background: #238636; color: #fff; }
.cm-issue-status-badge.in_progress { background: #1f6feb; color: #fff; }
.cm-issue-status-badge.resolved { background: #8957e5; color: #fff; }
.cm-issue-status-badge.verified { background: #484f58; color: #e6edf3; }

/* Issue detail */
.cm-issue-detail { padding: 16px; overflow-y: auto; flex: 1; }
.cm-issue-detail-back {
  background: none; border: none; color: #8b949e; cursor: pointer; font-size: 13px; margin-bottom: 8px; padding: 0;
}
.cm-issue-detail-back:hover { color: #e6edf3; }
.cm-issue-detail-title { font-size: 16px; color: #e6edf3; margin-bottom: 8px; font-weight: 600; }
.cm-issue-detail-meta { font-size: 12px; color: #8b949e; margin-bottom: 12px; }
.cm-issue-detail-quote {
  font-size: 12px; color: #8b949e; border-left: 3px solid #30363d; padding-left: 8px; margin-bottom: 12px;
}
.cm-issue-detail-messages { margin-bottom: 12px; }
.cm-issue-msg { padding: 8px 0; border-bottom: 1px solid #21262d; font-size: 13px; color: #e6edf3; }
.cm-issue-msg-meta { font-size: 11px; color: #8b949e; margin-bottom: 2px; }
.cm-issue-detail-actions {
  display: flex; gap: 6px; flex-wrap: wrap; padding-top: 8px; border-top: 1px solid #30363d;
}
.cm-issue-action-btn {
  padding: 5px 12px; border-radius: 6px; border: 1px solid #30363d;
  background: #21262d; color: #e6edf3; font-size: 12px; cursor: pointer;
}
.cm-issue-action-btn:hover { background: #30363d; }
.cm-issue-action-btn.primary { background: #238636; border-color: #238636; }
.cm-issue-action-btn.primary:hover { background: #2ea043; }

/* ─── Issue submit modal ─── */
.cm-issue-modal-backdrop {
  position: fixed; top: 0; left: 0; width: 100%; height: 100%;
  background: rgba(0,0,0,0.8); z-index: 9200;
  display: none; justify-content: center; align-items: center;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.cm-issue-modal-backdrop.visible { display: flex; }
.cm-issue-modal-box {
  background: #161b22; border: 1px solid #30363d; border-radius: 12px;
  padding: 24px; width: 460px; max-width: 95vw;
}
.cm-issue-modal-box h3 { margin: 0 0 16px; color: #e6edf3; }
.cm-issue-modal-box label { display: block; font-size: 12px; color: #8b949e; margin-bottom: 4px; }
.cm-issue-modal-box input[type="text"],
.cm-issue-modal-box textarea {
  width: 100%; padding: 10px 12px; background: #0d1117; border: 1px solid #30363d;
  border-radius: 6px; color: #e6edf3; font-size: 13px; margin-bottom: 12px;
  box-sizing: border-box; font-family: inherit;
}
.cm-issue-modal-box input[type="text"]:focus,
.cm-issue-modal-box textarea:focus { outline: none; border-color: #8957e5; }
.cm-issue-modal-box textarea {
  line-height: 1.5; resize: vertical; min-height: 80px;
}
.cm-issue-priority-row { display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; }
.cm-issue-priority-row label {
  color: #e6edf3; font-size: 13px; cursor: pointer;
  display: inline-flex; align-items: center; gap: 2px; white-space: nowrap; margin-bottom: 0;
}
.cm-issue-priority-row input[type="radio"] { margin: 0 2px 0 0; }
.cm-modal-hint { font-size: 12px; color: #8b949e; margin-bottom: 12px; }
.cm-modal-footer { display: flex; gap: 8px; justify-content: flex-end; }
.cm-modal-footer button {
  padding: 8px 16px; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-family: inherit;
}
.cm-btn-cancel { background: #21262d; color: #e6edf3; border: 1px solid #30363d !important; }
.cm-btn-cancel:hover { background: #30363d; }
.cm-btn-submit { background: #8957e5; color: #fff; }
.cm-btn-submit:hover { background: #a371f7; }

/* Image previews inside the modal */
.cm-issue-images-preview {
  display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; max-height: 120px; overflow-y: auto;
}
.cm-img-thumb {
  position: relative; width: 60px; height: 60px; border-radius: 4px; overflow: hidden; border: 1px solid #30363d;
}
.cm-img-thumb img { width: 100%; height: 100%; object-fit: cover; }
.cm-img-remove {
  position: absolute; top: 0; right: 0; width: 16px; height: 16px; background: rgba(0,0,0,0.7);
  color: #f85149; font-size: 12px; line-height: 16px; text-align: center; cursor: pointer;
  border-radius: 0 0 0 4px;
}
.cm-issue-upload-btn {
  display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px;
  border-radius: 6px; border: 1px dashed #30363d; background: transparent;
  color: #8b949e; font-size: 12px; cursor: pointer; margin-bottom: 8px;
}
.cm-issue-upload-btn:hover { border-color: #58a6ff; color: #58a6ff; }

/* Screenshot preview */
.cm-screenshot-thumb {
  position: relative; margin-bottom: 8px; border-radius: 6px; overflow: hidden;
  border: 1px solid #30363d; max-height: 150px; cursor: pointer;
}
.cm-screenshot-thumb img { width: 100%; display: block; object-fit: cover; max-height: 150px; }
.cm-screenshot-badge {
  position: absolute; bottom: 4px; left: 4px; background: rgba(0,0,0,0.7);
  color: #f85149; font-size: 10px; padding: 2px 6px; border-radius: 4px;
}
.cm-screenshot-remove {
  position: absolute; top: 4px; right: 4px; width: 20px; height: 20px;
  background: rgba(0,0,0,0.7); color: #f85149; font-size: 14px; line-height: 20px;
  text-align: center; cursor: pointer; border-radius: 50%;
}

/* ─── Annotation overlay ─── */
.cm-annotation-overlay {
  position: fixed; top: 0; left: 0; width: 100%; height: 100%;
  z-index: 9150; cursor: crosshair;
}
.cm-annotation-toolbar {
  position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
  z-index: 9160; background: #161b22; border: 1px solid #30363d;
  border-radius: 10px; padding: 8px 16px;
  align-items: center; gap: 10px; box-shadow: 0 4px 16px rgba(0,0,0,0.5);
  max-width: calc(100vw - 24px); white-space: nowrap;
  display: none;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.cm-annotation-toolbar.visible { display: flex; }
.cm-annotation-toolbar span { color: #8b949e; font-size: 13px; flex-shrink: 1; overflow: hidden; text-overflow: ellipsis; }
.cm-annotation-toolbar button {
  padding: 5px 12px; border-radius: 6px; font-size: 13px; cursor: pointer; border: none; flex-shrink: 0; white-space: nowrap; font-family: inherit;
}
.cm-annotation-btn-done { background: #238636; color: #fff; }
.cm-annotation-btn-done:hover { background: #2ea043; }
.cm-annotation-btn-cancel { background: #21262d; color: #e6edf3; border: 1px solid #30363d !important; }
.cm-annotation-btn-cancel:hover { background: #30363d; }
.cm-annotation-btn-undo { background: #21262d; color: #e6edf3; border: 1px solid #30363d !important; }
.cm-annotation-btn-undo:hover { background: #30363d; }

@media (max-width: 768px) {
  .cm-annotation-toolbar { padding: 6px 10px; gap: 6px; top: 8px; }
  .cm-annotation-toolbar span { display: none; }
  .cm-annotation-toolbar button { padding: 6px 10px; font-size: 12px; }
}

.cm-annotation-tag {
  position: fixed; z-index: 9155; display: flex; align-items: flex-start; gap: 0; pointer-events: auto;
}
.cm-tag-pin {
  width: 26px; height: 26px; border-radius: 50%; flex-shrink: 0;
  background: #f85149; color: #fff; font-size: 13px; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
  border: 2px solid #fff; box-shadow: 0 2px 8px rgba(248,81,73,0.6);
  cursor: grab;
}
.cm-tag-pin:active { cursor: grabbing; }
.cm-tag-input {
  margin-left: 4px; padding: 4px 8px; border-radius: 6px;
  background: rgba(22,27,34,0.95); border: 1px solid #f85149;
  color: #e6edf3; font-size: 12px; width: 160px; outline: none;
  box-shadow: 0 2px 8px rgba(0,0,0,0.4); font-family: inherit;
}
.cm-tag-input::placeholder { color: #484f58; }
.cm-tag-label {
  margin-left: 4px; padding: 3px 8px; border-radius: 6px;
  background: rgba(22,27,34,0.9); border: 1px solid rgba(248,81,73,0.5);
  color: #e6edf3; font-size: 12px; max-width: 200px; cursor: pointer;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: inherit;
}
.cm-tag-label:hover { border-color: #f85149; }
.cm-tag-delete {
  margin-left: 2px; width: 18px; height: 18px; border-radius: 50%;
  background: rgba(0,0,0,0.6); color: #f85149; font-size: 14px;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; border: none; flex-shrink: 0; line-height: 1;
}
.cm-tag-delete:hover { background: #f85149; color: #fff; }
`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(t) {
  const d = document.createElement('div');
  d.textContent = t;
  return d.innerHTML;
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return mins + 'm ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  return Math.floor(hours / 24) + 'd ago';
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export class FabPlugin {
  /**
   * @param {import('../../core/clawmark.js').ClawMark} core
   * @param {object} options
   * @param {string} [options.fabIcon]  - emoji/char for FAB button (default '🐛')
   * @param {string} [options.fabTitle] - tooltip (default '反馈')
   */
  constructor(core, options = {}) {
    this.core = core;
    this.opts = { fabIcon: '🐛', fabTitle: '反馈', ...options };

    // Internal state
    this._issueFilter  = 'open';
    this._issueCache   = [];
    this._annotationActive = false;
    this._annotationTags   = [];
    this._annotationOverlay = null;
    this._screenshotUrl    = null;
    this._issueImageUrls   = [];

    // FAB drag state
    this._fabDragging = false;
    this._fabMoved    = false;
    this._fabOffX     = 0;
    this._fabOffY     = 0;
    this._fabStartX   = 0;
    this._fabStartY   = 0;

    // DOM references (set in mount)
    this._styleEl      = null;
    this._fab          = null;
    this._fabMenu      = null;
    this._fabBackdrop  = null;
    this._issuePanel   = null;
    this._issueModal   = null;
    this._annotToolbar = null;

    // Bound handlers for proper removal
    this._onMouseMove  = this._onMouseMove.bind(this);
    this._onMouseUp    = this._onMouseUp.bind(this);
    this._onTouchMove  = this._onTouchMove.bind(this);
    this._onTouchEnd   = this._onTouchEnd.bind(this);

    // Unsubscribe functions for core events
    this._unsubs = [];
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  mount() {
    this._injectCSS();
    this._buildDOM();
    this._bindEvents();
    this._initFabPosition();

    // React to doc changes
    this._unsubs.push(
      this.core.events.on('doc:changed', () => {
        this._issueCache = [];
        if (this.core.docId) this._loadIssues();
      })
    );

    // Load issues if a doc is already set
    if (this.core.docId) this._loadIssues();
  }

  destroy() {
    this._unsubs.forEach(fn => fn());
    this._unsubs = [];
    this._removeDOM();
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('mouseup',   this._onMouseUp);
    document.removeEventListener('touchmove', this._onTouchMove);
    document.removeEventListener('touchend',  this._onTouchEnd);
  }

  // ─── CSS ───────────────────────────────────────────────────────────────────

  _injectCSS() {
    this._styleEl = document.createElement('style');
    this._styleEl.id = 'clawmark-fab-styles';
    this._styleEl.textContent = CSS;
    document.head.appendChild(this._styleEl);
  }

  // ─── DOM ───────────────────────────────────────────────────────────────────

  _buildDOM() {
    // FAB backdrop (closes menu on outside click)
    this._fabBackdrop = document.createElement('div');
    this._fabBackdrop.className = 'cm-fab-backdrop';
    document.body.appendChild(this._fabBackdrop);

    // FAB menu
    this._fabMenu = document.createElement('div');
    this._fabMenu.className = 'cm-fab-menu';
    document.body.appendChild(this._fabMenu);

    // FAB button
    this._fab = document.createElement('button');
    this._fab.className = 'cm-fab';
    this._fab.title = this.opts.fabTitle;
    this._fab.textContent = this.opts.fabIcon;
    document.body.appendChild(this._fab);

    // Issue panel
    this._issuePanel = this._buildIssuePanel();
    document.body.appendChild(this._issuePanel);

    // Issue submit modal
    this._issueModal = this._buildIssueModal();
    document.body.appendChild(this._issueModal);

    // Annotation toolbar
    this._annotToolbar = this._buildAnnotationToolbar();
    document.body.appendChild(this._annotToolbar);
  }

  _buildIssuePanel() {
    const panel = document.createElement('div');
    panel.className = 'cm-issue-panel';
    panel.innerHTML = `
      <div class="cm-issue-panel-header">
        <h3 class="cm-issue-panel-title">Issues</h3>
        <button class="cm-issue-panel-close">&times;</button>
      </div>
      <div class="cm-issue-panel-filters">
        <button class="cm-issue-filter-btn active" data-filter="open">Open</button>
        <button class="cm-issue-filter-btn" data-filter="in_progress">In Progress</button>
        <button class="cm-issue-filter-btn" data-filter="resolved">Resolved</button>
        <button class="cm-issue-filter-btn" data-filter="all">All</button>
      </div>
      <div class="cm-issue-panel-list"></div>
      <div class="cm-issue-detail" style="display:none;"></div>
    `;
    return panel;
  }

  _buildIssueModal() {
    const modal = document.createElement('div');
    modal.className = 'cm-issue-modal-backdrop';
    modal.innerHTML = `
      <div class="cm-issue-modal-box">
        <h3>🐛 反馈问题</h3>
        <div class="cm-screenshot-thumb" style="display:none;"></div>
        <label>标题（可选）</label>
        <input type="text" class="cm-issue-title" placeholder="不填则自动生成">
        <label>优先级</label>
        <div class="cm-issue-priority-row">
          <label><input type="radio" name="cm-priority" value="low"> 低</label>
          <label><input type="radio" name="cm-priority" value="normal" checked> 一般</label>
          <label><input type="radio" name="cm-priority" value="high"> 高</label>
          <label><input type="radio" name="cm-priority" value="critical"> 紧急</label>
        </div>
        <label>描述</label>
        <textarea class="cm-issue-desc" rows="5" placeholder="描述你遇到的问题或建议...&#10;&#10;💡 支持 Ctrl+V 粘贴截图"></textarea>
        <div class="cm-issue-images-preview"></div>
        <button class="cm-issue-upload-btn">📎 上传图片</button>
        <input type="file" class="cm-file-input" accept="image/*" multiple style="display:none;">
        <div class="cm-modal-hint cm-quote-hint" style="display:none;"></div>
        <div class="cm-modal-hint cm-doc-hint-wrap" style="display:none;">文档: <span class="cm-doc-hint"></span></div>
        <div class="cm-modal-footer">
          <button class="cm-btn-cancel">取消</button>
          <button class="cm-btn-submit">提交</button>
        </div>
      </div>
    `;
    return modal;
  }

  _buildAnnotationToolbar() {
    const toolbar = document.createElement('div');
    toolbar.className = 'cm-annotation-toolbar';
    toolbar.innerHTML = `
      <span>点击页面标注问题位置</span>
      <button class="cm-annotation-btn-undo">↩ 撤销</button>
      <button class="cm-annotation-btn-cancel">取消</button>
      <button class="cm-annotation-btn-done">完成标注 →</button>
    `;
    return toolbar;
  }

  _removeDOM() {
    [this._styleEl, this._fabBackdrop, this._fabMenu, this._fab,
     this._issuePanel, this._issueModal, this._annotToolbar]
      .forEach(el => el?.remove());
    // Clean up any orphaned annotation tags
    document.querySelectorAll('.cm-annotation-tag').forEach(el => el.remove());
  }

  // ─── Event binding ─────────────────────────────────────────────────────────

  _bindEvents() {
    // FAB drag (mouse)
    this._fab.addEventListener('mousedown', e => {
      e.preventDefault();
      this._fabToAbsolutePos();
      this._fabDragging = true;
      this._fabMoved    = false;
      const rect = this._fab.getBoundingClientRect();
      this._fabOffX   = e.clientX - rect.left;
      this._fabOffY   = e.clientY - rect.top;
      this._fabStartX = e.clientX;
      this._fabStartY = e.clientY;
    });
    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('mouseup',   this._onMouseUp);

    // FAB drag (touch)
    this._fab.addEventListener('touchstart', e => {
      this._fabToAbsolutePos();
      this._fabDragging = true;
      this._fabMoved    = false;
      const t = e.touches[0];
      const rect = this._fab.getBoundingClientRect();
      this._fabOffX   = t.clientX - rect.left;
      this._fabOffY   = t.clientY - rect.top;
      this._fabStartX = t.clientX;
      this._fabStartY = t.clientY;
    }, { passive: true });
    document.addEventListener('touchmove', this._onTouchMove, { passive: false });
    document.addEventListener('touchend',  this._onTouchEnd);

    // FAB click → open/close menu
    this._fab.addEventListener('click', e => {
      e.stopPropagation();
      if (this._fabMoved) { this._fabMoved = false; return; }
      if (this._fabMenu.classList.contains('visible')) {
        this._closeFabMenu();
      } else {
        this._openFabMenu();
      }
    });

    // Backdrop → close menu
    this._fabBackdrop.addEventListener('click', () => this._closeFabMenu());

    // Issue panel close
    this._issuePanel.querySelector('.cm-issue-panel-close')
      .addEventListener('click', () => this._issuePanel.classList.remove('visible'));

    // Issue filter buttons
    this._issuePanel.querySelectorAll('.cm-issue-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this._issuePanel.querySelectorAll('.cm-issue-filter-btn')
          .forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._issueFilter = btn.dataset.filter;
        this._renderIssueList();
      });
    });

    // Modal cancel / backdrop click
    this._issueModal.querySelector('.cm-btn-cancel')
      .addEventListener('click', () => {
        this._issueModal.classList.remove('visible');
        this._cleanupAnnotation();
      });
    this._issueModal.addEventListener('click', e => {
      if (e.target === this._issueModal) {
        this._issueModal.classList.remove('visible');
        this._cleanupAnnotation();
      }
    });

    // Modal submit
    this._issueModal.querySelector('.cm-btn-submit')
      .addEventListener('click', () => this._submitIssue());

    // Modal title enter key
    this._issueModal.querySelector('.cm-issue-title')
      .addEventListener('keypress', e => { if (e.key === 'Enter') this._submitIssue(); });

    // Image upload button
    const uploadBtn = this._issueModal.querySelector('.cm-issue-upload-btn');
    const fileInput = this._issueModal.querySelector('.cm-file-input');
    uploadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async e => {
      for (const file of e.target.files) {
        if (!file.type.startsWith('image/')) continue;
        try {
          this.core.toast('上传图片...');
          const url = await this._uploadImage(file);
          this._addImagePreview(url);
        } catch { this.core.toast('图片上传失败', 'error'); }
      }
      e.target.value = '';
    });

    // Image paste into description
    this._issueModal.querySelector('.cm-issue-desc')
      .addEventListener('paste', async e => {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const item of items) {
          if (item.type.startsWith('image/')) {
            e.preventDefault();
            try {
              this.core.toast('上传图片...');
              const url = await this._uploadImage(item.getAsFile());
              this._addImagePreview(url);
              this.core.toast('图片已添加');
            } catch { this.core.toast('图片上传失败', 'error'); }
            break;
          }
        }
      });

    // Annotation toolbar buttons
    this._annotToolbar.querySelector('.cm-annotation-btn-undo')
      .addEventListener('click', () => {
        if (this._annotationTags.length > 0) {
          const last = this._annotationTags.pop();
          last.el.remove();
          this._renumberTags();
        }
      });
    this._annotToolbar.querySelector('.cm-annotation-btn-cancel')
      .addEventListener('click', () => this._cleanupAnnotation());
    this._annotToolbar.querySelector('.cm-annotation-btn-done')
      .addEventListener('click', () => this._finishAnnotation());
  }

  // ─── FAB drag helpers ──────────────────────────────────────────────────────

  _onMouseMove(e) {
    if (!this._fabDragging) return;
    const dx = e.clientX - this._fabStartX;
    const dy = e.clientY - this._fabStartY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) this._fabMoved = true;
    if (this._fabMoved) {
      this._fab.style.left = (e.clientX - this._fabOffX) + 'px';
      this._fab.style.top  = (e.clientY - this._fabOffY) + 'px';
    }
  }

  _onMouseUp() {
    if (!this._fabDragging) return;
    this._fabDragging = false;
    if (this._fabMoved) {
      this._fabSnapToEdge(parseFloat(this._fab.style.left), parseFloat(this._fab.style.top));
    }
  }

  _onTouchMove(e) {
    if (!this._fabDragging) return;
    const t = e.touches[0];
    const dx = t.clientX - this._fabStartX;
    const dy = t.clientY - this._fabStartY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) this._fabMoved = true;
    if (this._fabMoved) {
      e.preventDefault();
      this._fab.style.left = (t.clientX - this._fabOffX) + 'px';
      this._fab.style.top  = (t.clientY - this._fabOffY) + 'px';
    }
  }

  _onTouchEnd() {
    if (!this._fabDragging) return;
    this._fabDragging = false;
    if (this._fabMoved) {
      this._fabSnapToEdge(parseFloat(this._fab.style.left), parseFloat(this._fab.style.top));
    }
  }

  _fabToAbsolutePos() {
    if (this._fab.style.right && this._fab.style.right !== 'auto') {
      const rect = this._fab.getBoundingClientRect();
      this._fab.style.left   = rect.left + 'px';
      this._fab.style.top    = rect.top  + 'px';
      this._fab.style.right  = 'auto';
      this._fab.style.bottom = 'auto';
    }
  }

  _fabSnapToEdge(x, y) {
    const w  = this._fab.offsetWidth;
    const h  = this._fab.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const M  = 12; // margin
    y = Math.max(M, Math.min(y, vh - h - M));
    x = (x + w / 2 < vw / 2) ? M : vw - w - M;
    this._fab.style.transition = 'left 0.25s, top 0.25s';
    this._fab.style.left = x + 'px';
    this._fab.style.top  = y + 'px';
    setTimeout(() => { this._fab.style.transition = ''; }, 300);
    try { localStorage.setItem('clawmark-fab-pos', JSON.stringify({ x, y })); } catch {}
  }

  _initFabPosition() {
    try {
      const saved = localStorage.getItem('clawmark-fab-pos');
      if (saved) {
        const { x, y } = JSON.parse(saved);
        this._fab.style.left   = x + 'px';
        this._fab.style.top    = y + 'px';
        this._fab.style.right  = 'auto';
        this._fab.style.bottom = 'auto';
        return;
      }
    } catch {}
    // Default: bottom-right
    this._fab.style.right  = '24px';
    this._fab.style.bottom = '24px';
  }

  // ─── FAB menu ──────────────────────────────────────────────────────────────

  _closeFabMenu() {
    this._fabMenu.classList.remove('visible');
    this._fabBackdrop.classList.remove('visible');
  }

  _openFabMenu() {
    const openCount = this._issueCache.filter(
      i => i.type === 'issue' && (i.status === 'open' || i.status === 'in_progress')
    ).length;

    this._fabMenu.innerHTML = `
      <div class="cm-fab-menu-item" data-fab="annotate"><span class="fab-icon">📍</span>标注反馈</div>
      <div class="cm-fab-menu-item" data-fab="text"><span class="fab-icon">💬</span>文字反馈</div>
      <div class="cm-fab-menu-item" data-fab="issues"><span class="fab-icon">📋</span>Issues${openCount > 0 ? ` (${openCount})` : ''}</div>
    `;

    // Position above the FAB
    const fabRect = this._fab.getBoundingClientRect();
    const isLeft  = fabRect.left < window.innerWidth / 2;
    this._fabMenu.style.bottom = (window.innerHeight - fabRect.top + 8) + 'px';
    if (isLeft) {
      this._fabMenu.style.left  = fabRect.left + 'px';
      this._fabMenu.style.right = 'auto';
      this._fabMenu.style.alignItems = 'flex-start';
    } else {
      this._fabMenu.style.right = (window.innerWidth - fabRect.right) + 'px';
      this._fabMenu.style.left  = 'auto';
      this._fabMenu.style.alignItems = 'flex-end';
    }
    this._fabMenu.classList.add('visible');
    this._fabBackdrop.classList.add('visible');

    // Bind item clicks
    this._fabMenu.querySelectorAll('.cm-fab-menu-item').forEach(item => {
      item.addEventListener('click', () => {
        const action = item.dataset.fab;
        this._closeFabMenu();
        if (action === 'annotate') {
          this._resetIssueForm();
          this._enterAnnotationMode();
        } else if (action === 'text') {
          this._resetIssueForm();
          this._openIssueFormDirect();
        } else if (action === 'issues') {
          this._toggleIssuePanel();
        }
      });
    });
  }

  // ─── Issue panel ───────────────────────────────────────────────────────────

  async _loadIssues() {
    const docId = this.core.docId;
    if (!docId) return;
    try {
      const data = await this.core.api.listItems(docId);
      this._issueCache = data.items || [];
      this._renderIssueList();
      this.core.events.emit('fab:issues:loaded', { count: this._issueCache.length });
    } catch { this.core.toast('加载 Issues 失败', 'error'); }
  }

  _renderIssueList() {
    const list = this._issuePanel.querySelector('.cm-issue-panel-list');

    // Update filter counts
    this._issuePanel.querySelectorAll('.cm-issue-filter-btn').forEach(btn => {
      const f = btn.dataset.filter;
      const count = f === 'all'
        ? this._issueCache.filter(i => i.type === 'issue').length
        : this._issueCache.filter(i => i.type === 'issue' && i.status === f).length;
      const existing = btn.querySelector('.count');
      if (existing) existing.textContent = count;
      else if (count > 0) btn.innerHTML += `<span class="count">${count}</span>`;
    });

    const filtered = this._issueCache.filter(i => {
      if (i.type !== 'issue') return false;
      return this._issueFilter === 'all' || i.status === this._issueFilter;
    });

    if (!filtered.length) {
      list.innerHTML = '<div style="padding:24px;text-align:center;color:#8b949e;font-size:13px;">暂无 issues</div>';
      return;
    }

    list.innerHTML = filtered.map(item => {
      const priority = item.priority || 'normal';
      return `<div class="cm-issue-item" data-issue-id="${item.id}">
        <div class="cm-issue-item-title">
          <span class="cm-issue-priority ${priority}"></span>
          <span>${escapeHtml(item.title || '(untitled)')}</span>
          <span class="cm-issue-status-badge ${item.status}">${item.status}</span>
        </div>
        <div class="cm-issue-item-meta">${escapeHtml(item.created_by || '')} · ${timeAgo(item.created_at)}${item.assignee ? ' · → ' + escapeHtml(item.assignee) : ''}</div>
      </div>`;
    }).join('');

    list.querySelectorAll('.cm-issue-item').forEach(el => {
      el.addEventListener('click', () => this._openIssueDetail(el.dataset.issueId));
    });
  }

  async _openIssueDetail(issueId) {
    const detailEl = this._issuePanel.querySelector('.cm-issue-detail');
    const listEl   = this._issuePanel.querySelector('.cm-issue-panel-list');
    const filtersEl = this._issuePanel.querySelector('.cm-issue-panel-filters');

    try {
      const item = await this.core.api.getItem(issueId);
      if (item.error) return;

      listEl.style.display   = 'none';
      filtersEl.style.display = 'none';
      detailEl.style.display  = 'block';

      const msgs = (item.messages || []).filter(m => !m.pending).map(m => {
        const icon = m.role === 'user' ? '👤' : '🤖';
        let content = escapeHtml(m.content).replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) =>
          `<div style="margin:4px 0;"><img src="${src}" alt="${escapeHtml(alt)}" style="max-width:100%;border-radius:4px;border:1px solid #30363d;"></div>`
        );
        return `<div class="cm-issue-msg"><div class="cm-issue-msg-meta">${icon} ${escapeHtml(m.user_name || m.role)} · ${timeAgo(m.created_at)}</div>${content}</div>`;
      }).join('');

      const actions = [];
      if (item.status === 'open')        actions.push(`<button class="cm-issue-action-btn primary" data-action="assign">接单</button>`);
      if (item.status === 'in_progress') actions.push(`<button class="cm-issue-action-btn primary" data-action="resolve">标记解决</button>`);
      if (item.status === 'resolved') {
        actions.push(`<button class="cm-issue-action-btn primary" data-action="verify">确认验收</button>`);
        actions.push(`<button class="cm-issue-action-btn" data-action="reopen">打回</button>`);
      }
      if (item.status !== 'closed') actions.push(`<button class="cm-issue-action-btn" data-action="close">关闭</button>`);

      detailEl.innerHTML = `
        <button class="cm-issue-detail-back">← 返回列表</button>
        <div class="cm-issue-detail-title">${escapeHtml(item.title || '(untitled)')}</div>
        <div class="cm-issue-detail-meta">
          ${item.status} · ${item.priority || 'normal'} · ${escapeHtml(item.created_by || '')} · ${timeAgo(item.created_at)}
          ${item.assignee ? ' · → ' + escapeHtml(item.assignee) : ''}
        </div>
        ${item.quote ? `<div class="cm-issue-detail-quote">"${escapeHtml(item.quote)}"</div>` : ''}
        <div class="cm-issue-detail-messages">${msgs || '<div style="color:#8b949e;font-size:12px;">无消息</div>'}</div>
        <div class="cm-issue-detail-actions" data-issue-id="${item.id}">${actions.join('')}</div>
      `;

      detailEl.querySelector('.cm-issue-detail-back')
        .addEventListener('click', () => this._closeIssueDetail());

      detailEl.querySelectorAll('.cm-issue-action-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const action = btn.dataset.action;
          const id     = btn.closest('.cm-issue-detail-actions').dataset.issueId;
          const extra  = action === 'assign' ? { assignee: this.core.user || 'anonymous' } : {};
          try {
            await this.core.api.updateItemStatus(id, action, extra);
            const label = { assign: '已接单', resolve: '已标记解决', verify: '已验收', reopen: '已打回', close: '已关闭' }[action] || action;
            this.core.toast(label);
            await this._loadIssues();
            this._openIssueDetail(id);
          } catch { this.core.toast('操作失败', 'error'); }
        });
      });
    } catch { this.core.toast('加载详情失败', 'error'); }
  }

  _closeIssueDetail() {
    const detailEl  = this._issuePanel.querySelector('.cm-issue-detail');
    const listEl    = this._issuePanel.querySelector('.cm-issue-panel-list');
    const filtersEl = this._issuePanel.querySelector('.cm-issue-panel-filters');
    detailEl.style.display   = 'none';
    listEl.style.display     = '';
    filtersEl.style.display  = '';
  }

  _toggleIssuePanel() {
    if (this._issuePanel.classList.contains('visible')) {
      this._issuePanel.classList.remove('visible');
    } else {
      this._closeIssueDetail();
      this._loadIssues();
      this._issuePanel.classList.add('visible');
    }
  }

  // ─── Issue form ────────────────────────────────────────────────────────────

  _resetIssueForm() {
    this._issueModal.querySelector('.cm-issue-title').value = '';
    this._issueModal.querySelector('.cm-issue-desc').value  = '';
    this._issueModal.querySelector('input[name="cm-priority"][value="normal"]').checked = true;
    this._issueModal.querySelector('.cm-issue-images-preview').innerHTML = '';
    const ssThumb = this._issueModal.querySelector('.cm-screenshot-thumb');
    ssThumb.innerHTML = '';
    ssThumb.style.display = 'none';
    this._issueImageUrls = [];
    this._screenshotUrl  = null;
  }

  _openIssueFormDirect() {
    const docHintWrap = this._issueModal.querySelector('.cm-doc-hint-wrap');
    const docHint     = this._issueModal.querySelector('.cm-doc-hint');
    const quoteHint   = this._issueModal.querySelector('.cm-quote-hint');

    docHint.textContent = this.core.docId || '';
    docHintWrap.style.display = this.core.docId ? '' : 'none';

    const sel = window.getSelection();
    const selectedText = sel ? sel.toString().trim() : '';
    if (selectedText) {
      quoteHint.textContent = '引用: "' + selectedText.substring(0, 100) + '"';
      quoteHint.style.display = 'block';
      quoteHint.dataset.quote = selectedText;
    } else {
      quoteHint.style.display = 'none';
      quoteHint.dataset.quote = '';
    }

    this._issueModal.classList.add('visible');
    this._issueModal.querySelector('.cm-issue-title').focus();
  }

  // ─── Image upload ──────────────────────────────────────────────────────────

  async _uploadImage(file) {
    const result = await this.core.api.uploadImage(file, this.core.docId || undefined);
    if (result.url) return result.url;
    throw new Error('Upload failed');
  }

  _addImagePreview(url) {
    this._issueImageUrls.push(url);
    const previewDiv = this._issueModal.querySelector('.cm-issue-images-preview');
    const thumb = document.createElement('div');
    thumb.className = 'cm-img-thumb';
    thumb.innerHTML = `<img src="${url}" alt="image"><span class="cm-img-remove">&times;</span>`;
    thumb.querySelector('.cm-img-remove').addEventListener('click', () => {
      this._issueImageUrls = this._issueImageUrls.filter(u => u !== url);
      thumb.remove();
    });
    previewDiv.appendChild(thumb);
  }

  // ─── Issue submit ──────────────────────────────────────────────────────────

  async _submitIssue() {
    let title       = this._issueModal.querySelector('.cm-issue-title').value.trim();
    let description = this._issueModal.querySelector('.cm-issue-desc').value.trim();
    const priority  = (this._issueModal.querySelector('input[name="cm-priority"]:checked')?.value) || 'normal';
    const quote     = this._issueModal.querySelector('.cm-quote-hint').dataset.quote || '';

    // Auto-generate title
    if (!title) {
      const firstTag = this._annotationTags.find(t => t.text);
      if (firstTag) {
        title = firstTag.text.substring(0, 60);
      } else if (description) {
        title = description.split('\n')[0].substring(0, 60);
      } else {
        const docId = this.core.docId;
        title = docId ? docId.replace('.md', '') + ' 问题反馈' : '问题反馈';
      }
    }

    // Screenshot if there are annotation tags
    if (this._annotationTags.length > 0 && !this._screenshotUrl) {
      this.core.toast('截图中...');
      this._issueModal.classList.remove('visible');
      try {
        const h2c = window.html2canvas;
        if (h2c) {
          const canvas = await h2c(document.body, {
            backgroundColor: '#0d1117',
            useCORS: true,
            logging: false,
            ignoreElements: el => el === this._issueModal || el === this._annotToolbar,
          });
          const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
          const result = await this.core.api.uploadImage(blob, this.core.docId || undefined);
          if (result.url) this._screenshotUrl = result.url;
        }
      } catch (err) { console.error('[ClawMark] Screenshot failed:', err); }
      this._issueModal.classList.add('visible');
    }

    // Refresh description with tag annotations
    const tagDescs = this._annotationTags
      .filter(t => t.text)
      .map(t => `#${t.num}: ${t.text}`)
      .join('\n');
    if (tagDescs && !description.includes('#1:')) {
      description = tagDescs + (description ? '\n\n' + description : '');
    }

    // Append screenshot and images
    const attachments = [];
    if (this._screenshotUrl) attachments.push(`![screenshot](${this._screenshotUrl})`);
    this._issueImageUrls.forEach((url, i) => attachments.push(`![image-${i + 1}](${url})`));
    if (attachments.length) {
      description = (description ? description + '\n\n' : '') + attachments.join('\n');
    }

    try {
      const result = await this.core.api.createItem({
        doc:      this.core.docId || undefined,
        type:     'issue',
        title,
        priority,
        message:  description,
        quote,
        userName: this.core.user || 'anonymous',
      });

      if (result.success) {
        this._issueModal.classList.remove('visible');
        this._cleanupAnnotation();
        this.core.toast('Issue 已提交');
        await this._loadIssues();
        this._issuePanel.classList.add('visible');
        this.core.events.emit('fab:issue:created', { item: result.item });
      } else {
        this.core.toast(result.error || '提交失败', 'error');
      }
    } catch { this.core.toast('网络错误', 'error'); }
  }

  // ─── Annotation mode ───────────────────────────────────────────────────────

  _enterAnnotationMode() {
    this._annotationActive = true;
    this._annotationTags   = [];
    this._fab.style.display = 'none';

    this._annotationOverlay = document.createElement('div');
    this._annotationOverlay.className = 'cm-annotation-overlay';
    document.body.appendChild(this._annotationOverlay);
    this._annotToolbar.classList.add('visible');

    this._annotationOverlay.addEventListener('click', e => this._onAnnotationClick(e));
  }

  _onAnnotationClick(e) {
    if (!this._annotationActive) return;
    if (e.target.closest('.cm-annotation-toolbar')) return;
    if (e.target.closest('.cm-annotation-tag'))    return;
    if (e.target.closest('.cm-issue-modal-backdrop')) return;

    const num    = this._annotationTags.length + 1;
    const tagObj = this._createTagElement(e.clientX, e.clientY, num, '');
    this._annotationTags.push(tagObj);
  }

  _createTagElement(cx, cy, num, initialText) {
    const tag = document.createElement('div');
    tag.className = 'cm-annotation-tag';
    tag.style.left      = cx + 'px';
    tag.style.top       = cy + 'px';
    tag.style.transform = 'translate(-13px, -13px)';

    const pin = document.createElement('div');
    pin.className   = 'cm-tag-pin';
    pin.textContent = num;

    const del = document.createElement('span');
    del.className   = 'cm-tag-delete';
    del.textContent = '×';
    del.addEventListener('click', e => {
      e.stopPropagation();
      const idx = this._annotationTags.findIndex(t => t.el === tag);
      if (idx >= 0) {
        this._annotationTags.splice(idx, 1);
        tag.remove();
        this._renumberTags();
      }
    });

    tag.appendChild(pin);

    // Drag to reposition
    let dragOffsetX = 0, dragOffsetY = 0, isDragging = false;
    pin.addEventListener('mousedown', e => {
      e.preventDefault(); e.stopPropagation();
      isDragging = true;
      const rect = tag.getBoundingClientRect();
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;
      const onMove = ev => {
        if (!isDragging) return;
        tag.style.left = (ev.clientX - dragOffsetX + 13) + 'px';
        tag.style.top  = (ev.clientY - dragOffsetY + 13) + 'px';
      };
      const onUp = () => {
        isDragging = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });
    pin.addEventListener('touchstart', e => {
      e.stopPropagation();
      const touch = e.touches[0];
      const rect  = tag.getBoundingClientRect();
      dragOffsetX = touch.clientX - rect.left;
      dragOffsetY = touch.clientY - rect.top;
      const onTouchMove = ev => {
        ev.preventDefault();
        const t = ev.touches[0];
        tag.style.left = (t.clientX - dragOffsetX + 13) + 'px';
        tag.style.top  = (t.clientY - dragOffsetY + 13) + 'px';
      };
      const onTouchEnd = () => {
        document.removeEventListener('touchmove', onTouchMove);
        document.removeEventListener('touchend',  onTouchEnd);
      };
      document.addEventListener('touchmove', onTouchMove, { passive: false });
      document.addEventListener('touchend',  onTouchEnd);
    }, { passive: false });

    const tagObj = { el: tag, x: cx, y: cy, num, text: initialText || '' };

    const showInput = (existingText) => {
      tag.querySelector('.cm-tag-label')?.remove();
      tag.querySelector('.cm-tag-delete')?.remove();

      const input = document.createElement('input');
      input.className   = 'cm-tag-input';
      input.type        = 'text';
      input.placeholder = '描述问题...';
      input.value       = existingText || '';
      input.addEventListener('click',     e => e.stopPropagation());
      input.addEventListener('mousedown', e => e.stopPropagation());

      const finalize = () => {
        const text = input.value.trim();
        tagObj.text = text;
        input.remove();
        if (text) {
          const label = document.createElement('span');
          label.className   = 'cm-tag-label';
          label.textContent = text;
          label.addEventListener('click', e => { e.stopPropagation(); showInput(tagObj.text); });
          tag.appendChild(label);
        }
        tag.appendChild(del);
      };
      input.addEventListener('keydown', e => { if (e.key === 'Enter') finalize(); e.stopPropagation(); });
      input.addEventListener('blur', finalize);
      tag.appendChild(input);
      setTimeout(() => input.focus(), 50);
    };

    if (initialText) {
      const label = document.createElement('span');
      label.className   = 'cm-tag-label';
      label.textContent = initialText;
      label.addEventListener('click', e => { e.stopPropagation(); showInput(tagObj.text); });
      tag.appendChild(label);
      tag.appendChild(del);
    } else {
      showInput('');
    }

    document.body.appendChild(tag);
    return tagObj;
  }

  _renumberTags() {
    this._annotationTags.forEach((t, i) => {
      t.num = i + 1;
      t.el.querySelector('.cm-tag-pin').textContent = t.num;
    });
  }

  _finishAnnotation() {
    // Remove overlay so the form is clickable, but keep tags visible
    if (this._annotationOverlay) {
      this._annotationOverlay.remove();
      this._annotationOverlay = null;
    }
    this._annotToolbar.classList.remove('visible');
    this._annotationActive = false;

    // Pre-fill description from tag texts
    const tagDescs = this._annotationTags
      .filter(t => t.text)
      .map(t => `#${t.num}: ${t.text}`)
      .join('\n');
    if (tagDescs) {
      this._issueModal.querySelector('.cm-issue-desc').value = tagDescs;
    }

    this._openIssueFormDirect();
  }

  _cleanupAnnotation() {
    this._annotationActive = false;
    this._annotToolbar.classList.remove('visible');
    if (this._annotationOverlay) {
      this._annotationOverlay.remove();
      this._annotationOverlay = null;
    }
    this._annotationTags.forEach(t => { try { t.el.remove(); } catch {} });
    this._annotationTags = [];
    document.querySelectorAll('.cm-annotation-tag').forEach(el => el.remove());
    this._fab.style.display = '';
  }
}
