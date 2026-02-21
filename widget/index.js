/**
 * ClawMark Widget — entry point.
 *
 * Usage (ES module):
 *
 *   import ClawMark from './widget/index.js';
 *
 *   const cm = new ClawMark({
 *     api:  '/api/doc-discuss',
 *     app:  'my-app',
 *     user: null,
 *   });
 *
 *   // Use plugin classes directly:
 *   cm.use(ClawMark.Fab)
 *     .use(ClawMark.Comment, { contentSelector: '.markdown-body' })
 *     .mount();
 *
 *   // Or use the factory helpers for pre-bound options:
 *   cm.use(ClawMark.fab({ fabIcon: '🐛' }))
 *     .use(ClawMark.comment({ contentSelector: '.markdown-body' }))
 *     .mount();
 *
 *   // When the user navigates to a document:
 *   cm.setDoc('docs/intro.md');
 */

import { ClawMark }      from './core/clawmark.js';
import { FabPlugin }     from './plugins/fab/index.js';
import { CommentPlugin } from './plugins/comment/index.js';

// ── Direct plugin references (pass as first arg to cm.use()) ──────────────────
ClawMark.Fab     = FabPlugin;
ClawMark.Comment = CommentPlugin;

// ── Factory helpers — pre-bind options so `cm.use(ClawMark.fab({...}))` works ─
ClawMark.fab = (options = {}) => {
  return class BoundFab extends FabPlugin {
    constructor(core) { super(core, options); }
  };
};

ClawMark.comment = (options = {}) => {
  return class BoundComment extends CommentPlugin {
    constructor(core) { super(core, options); }
  };
};

export default ClawMark;

// Named exports for tree-shaking consumers
export { ClawMark, FabPlugin, CommentPlugin };
