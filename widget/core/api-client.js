/**
 * ClawMark ApiClient — HTTP wrapper for the ClawMark server API.
 *
 * All methods return parsed JSON or throw on network/HTTP errors.
 * The base URL and app ID come from ClawMark core config.
 */
export class ApiClient {
  /**
   * @param {object} config
   * @param {string} config.api  - Base API URL, e.g. '/api/doc-discuss'
   * @param {string} [config.app] - App / product ID used as doc when no docId
   */
  constructor(config) {
    this.base = (config.api || '').replace(/\/$/, '');
    this.defaultDoc = config.app || '_product';
  }

  // ─── Low-level helpers ────────────────────────────────────────────────────

  async _fetch(path, options = {}) {
    const res = await fetch(this.base + path, options);
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`ClawMark API ${res.status}: ${text}`);
    }
    return res.json();
  }

  _get(path) {
    return this._fetch(path);
  }

  _post(path, body) {
    return this._fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  _delete(path, body) {
    return this._fetch(path, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  // ─── Session / Auth ───────────────────────────────────────────────────────

  /**
   * Verify an invite code and return { valid, userName }.
   */
  verifyCode(code) {
    return this._post('/verify', { code });
  }

  // ─── Items (discussions + issues unified V2 API) ──────────────────────────

  /**
   * List all items for a document (lightweight — no messages).
   */
  listItems(docId) {
    return this._get(`/items?doc=${encodeURIComponent(docId || this.defaultDoc)}`);
  }

  /**
   * List all items with full messages for a document.
   */
  listItemsFull(docId) {
    return this._get(`/items-full?doc=${encodeURIComponent(docId || this.defaultDoc)}`);
  }

  /**
   * Get a single item by ID (includes messages).
   */
  getItem(id) {
    return this._get(`/items/${encodeURIComponent(id)}`);
  }

  /**
   * Create a new item (discussion or issue).
   * @param {object} payload
   * @param {string} payload.type         - 'discuss' | 'issue'
   * @param {string} payload.doc
   * @param {string} payload.message
   * @param {string} [payload.quote]
   * @param {string} [payload.quote_position] - JSON XPath position
   * @param {string} [payload.title]
   * @param {string} [payload.priority]
   * @param {string} [payload.userName]
   * @param {string} [payload.source_url]    - Page URL where item was created
   * @param {string} [payload.source_title]  - Page title
   * @param {string[]} [payload.tags]        - Tag labels
   * @param {string[]} [payload.screenshots] - Screenshot URLs
   */
  createItem(payload) {
    const body = {
      doc: payload.doc || this.defaultDoc,
      type: payload.type,
      title: payload.title,
      priority: payload.priority,
      message: payload.message,
      quote: payload.quote,
      userName: payload.userName || 'anonymous',
    };
    if (payload.quote_position) body.quote_position = payload.quote_position;
    if (payload.source_url)     body.source_url = payload.source_url;
    if (payload.source_title)   body.source_title = payload.source_title;
    if (payload.tags?.length)   body.tags = payload.tags;
    if (payload.screenshots?.length) body.screenshots = payload.screenshots;
    return this._post('/items', body);
  }

  /**
   * Add a message to an existing item.
   */
  addMessage(itemId, { content, userName, role = 'user' }) {
    return this._post(`/items/${encodeURIComponent(itemId)}/messages`, {
      role,
      content,
      userName: userName || 'anonymous',
    });
  }

  /**
   * Change item status: 'resolve' | 'reopen' | 'close' | 'assign' | 'verify'.
   */
  updateItemStatus(itemId, action, extra = {}) {
    return this._post(`/items/${encodeURIComponent(itemId)}/${action}`, extra);
  }

  /**
   * Request an AI edit for a resolved discussion.
   */
  requestAiEdit(itemId, userName) {
    return this._post(`/items/${encodeURIComponent(itemId)}/ai-edit`, { user: userName });
  }

  // ─── V1 Discussion API (fallback) ─────────────────────────────────────────

  /**
   * Load discussions using the V1 JSON API (fallback when V2 unavailable).
   */
  async listDiscussionsV1(docId) {
    const data = await this._get(`/discussions?doc=${encodeURIComponent(docId || this.defaultDoc)}`);
    // Normalise to V2 shape
    return (data.discussions || []).map(d => ({
      ...d,
      status: d.applied ? 'resolved' : 'open',
      messages: d.messages || [],
    }));
  }

  /**
   * Post a reply on an existing discussion via V1 API.
   */
  sendMessageV1({ docId, discussionId, quote, message, userName }) {
    return this._post('/discussions', {
      doc: docId || this.defaultDoc,
      discussionId,
      quote,
      message,
      userName: userName || 'anonymous',
    });
  }

  /**
   * Resolve or reopen a discussion via the V1 API.
   */
  resolveV1(docId, discussionId, action) {
    return this._post('/discussions/resolve', {
      doc: docId || this.defaultDoc,
      discussionId,
      action,
    });
  }

  /**
   * Apply a discussion to the document (V1 AI edit).
   */
  applyV1(docId, discussionId, user) {
    return this._post('/apply-single', { doc: docId, discussionId, user });
  }

  // ─── Image upload ─────────────────────────────────────────────────────────

  /**
   * Upload an image file (File or Blob).
   * Returns { url } on success.
   */
  async uploadImage(file, docId) {
    const formData = new FormData();
    formData.append('image', file, file.name || 'image.png');
    formData.append('doc', docId || this.defaultDoc);
    const res = await fetch(this.base + '/upload-image', { method: 'POST', body: formData });
    if (!res.ok) throw new Error('Image upload failed: ' + res.statusText);
    return res.json();
  }

  // ─── Document mtime ───────────────────────────────────────────────────────

  getDocMtime(docId) {
    return this._get(`/doc-mtime?doc=${encodeURIComponent(docId)}`);
  }
}
