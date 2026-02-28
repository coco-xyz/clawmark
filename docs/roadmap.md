# ClawMark Roadmap

Last updated: 2026-03-01

## Current: v0.3.0 ✅

**Released 2026-02-28** — Decentralized routing system

- **Routing Phase 1**: 4-level priority resolution
  1. User rules (custom glob patterns per user)
  2. GitHub URL auto-detection (extract repo from github.com URLs)
  3. User default adapter
  4. System default adapter
- **User rules CRUD API**: `/api/v2/routing/rules` — create, read, update, delete custom routing rules
- **Dry run**: `/api/v2/routing/resolve` — test routing resolution without creating annotations
- **Dynamic adapter dispatch**: annotations routed to correct adapter based on source URL
- **Test coverage**: 62 tests (24 routing + 38 DB/API)
- **Chrome Web Store**: extension submitted, awaiting Google review
- **Environments**:
  - Testing: https://jessie.coco.site/clawmark (v0.3.0)
  - Production: https://api.coco.xyz/clawmark (needs update from v2.0.0)

## Next: v0.4.0 — Target Declaration Protocol

**Goal**: Let projects declare their own routing preferences, so annotations are automatically routed without users configuring rules manually.

- **`.clawmark.yml`** in repo root — GitHub repos declare their ClawMark config:
  ```yaml
  # .clawmark.yml
  adapter: github-issues
  target: coco-xyz/clawmark
  labels: ["feedback", "clawmark"]
  ```
- **`/.well-known/clawmark.json`** on websites — any website can declare its ClawMark endpoint:
  ```json
  {
    "adapter": "webhook",
    "endpoint": "https://api.example.com/feedback",
    "types": ["issue", "comment"]
  }
  ```
- **Priority upgrade to 5 levels**: target declaration > user rules > GitHub URL auto > user default > system default
- **Discovery**: extension checks for `.clawmark.yml` / `/.well-known/clawmark.json` when user visits a page

## v0.5.0 — AI-Powered Routing & Analysis

**Goal**: Use AI to intelligently classify, route, and analyze annotations.

- **Smart routing**: when no explicit rule or declaration exists, AI analyzes page content and annotation context to suggest the best routing target
- **Annotation classification**: auto-tag annotations (bug, feature request, question, praise, etc.)
- **Smart labels**: AI-generated labels based on content analysis
- **Aggregation**: cluster related annotations across pages/repos, surface trends
- **Routing confidence scores**: show users how confident the routing decision is, allow override

## v0.6.0 — Multi-Channel Distribution

**Goal**: Expand from GitHub Issues to a rich ecosystem of distribution targets.

- **New adapters**:
  - Telegram (bot message to group/channel)
  - Slack (post to channel)
  - Email (digest or per-annotation)
  - Generic webhook (POST to any URL)
  - Linear / Jira (issue tracker integrations)
- **Multi-target distribution**: one annotation → multiple adapters simultaneously
- **Distribution status tracking**: see which adapters received the annotation, retry on failure
- **Adapter marketplace**: community-contributed adapters (connect to hxa-teams template system)

## v1.0.0 — Production Release

**Goal**: Production-ready with full auth, real-time sync, and multi-browser support.

- **OAuth authentication**: replace invite codes with Google/GitHub OAuth
- **Real-time push**: WebSocket connection for live annotation updates (replace polling)
- **Multi-browser**: Firefox, Edge, Safari extensions
- **Complete API documentation + SDK**: TypeScript/JavaScript SDK for embedding
- **Rate limiting & abuse prevention**: production-grade security
- **Analytics dashboard**: annotation volume, routing stats, adapter usage
- **Team management**: org-level settings, shared routing rules, role-based access

## Beyond v1.0

Ideas under consideration (not committed):

- **Annotation threading**: reply chains on annotations
- **Highlight persistence**: save highlighted text positions, re-render on revisit
- **Browser-to-browser sync**: real-time collaborative annotation
- **Embeddable widget v2**: improved embed experience for websites
- **Mobile support**: annotation viewing on mobile browsers
- **Self-hosted option**: deploy ClawMark server on your own infrastructure

## Version History

| Version | Date | Highlights |
|---------|------|------------|
| v0.3.0 | 2026-02-28 | Routing Phase 1, 62 tests, Chrome Web Store submission |
| v0.2.0 | 2026-02-27 | V2 architecture, Chrome extension MVP, adapter framework |
| v0.1.0 | 2026-02-26 | Initial release, basic annotation CRUD |
