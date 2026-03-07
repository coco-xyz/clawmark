# ClawMark — CLAUDE.md

## Project Overview

ClawMark is a Chrome extension + dashboard for web annotation and feedback dispatch. Users select text on any webpage to create annotations, which are automatically dispatched to GitHub Issues, Lark, Telegram, etc. via configurable delivery rules.

## Code Review (Mandatory)

Every PR must complete a codex review before merge. No exceptions.

1. Reviewer runs iterative review rounds (R1, R2, ...) checking 6 dimensions: Correctness, Security, Types & contracts, Edge cases, Integration, Dead code
2. Each finding is classified P1 (crash/security), P2 (logic/type), or P3 (style). P1 + P2 = MUST FIX.
3. Fix all issues, re-review the full PR (not just fixes), repeat until CLEAN (0 P1 + 0 P2)
4. PR description must include the CLEAN report summary
5. Full standard: `HxANet/hxa-teams/projects/engineering/codex-review-standard.md`

## Architecture

```
extension/          Chrome Extension (Manifest V3)
  ├── manifest.json   Version + permissions
  ├── background/     Service worker
  ├── content/        Content scripts (inject.js, screenshot)
  ├── popup/          Browser action popup
  ├── sidepanel/      Side panel UI
  ├── options/        Options page
  └── config.js       Server URL + settings

dashboard/          Web Dashboard (vanilla JS SPA)
  └── src/
      ├── index.html  Entry point
      ├── main.js     App logic (annotations, rules, auth, settings)
      ├── api.js      API client
      ├── auth.js     Auth management
      └── style.css   Styles

server/             Node.js API server
  └── server.js       Express API + SQLite + dispatch engine
```

## Branching

- `main` — stable releases
- `develop` — integration branch (all MRs target here)
- Feature branches: `feat/{issue}-description`, `fix/{issue}-description`

## Release Checklist (MANDATORY)

Every release MUST follow these steps. No exceptions.

1. **Version bump**: Update `extension/manifest.json` version
2. **Build zip**: `zip -r clawmark-v{VERSION}.zip extension/`
3. **Publish zip**: Copy to `~/zylos/http/public/clawmark-v{VERSION}.zip` + update `clawmark-latest.zip`
4. **Tag**: `git tag -a v{VERSION} -m "v{VERSION}: {summary}"` → `git push gitlab v{VERSION}`
5. **GitLab Release**: Create release via API with release notes + attach zip as asset link
6. **Notify**: Post to Lark testing group with download link + install instructions

### RC (Release Candidate) Flow

- RC tags: `v{VERSION}-rc.{N}` (e.g., v0.6.6-rc.1)
- RC → fixes → RC+1 → ... → official release
- Official release: merge develop → main, tag without `-rc`

## GitLab is PRIMARY

- Repo: `git.coco.xyz/hxanet/clawmark`
- All MRs target `develop` branch
- GitHub (`coco-xyz/clawmark`) kept in sync via PRs

## Test Environment

- Dashboard: `jessie.coco.site/clawmark-dashboard/`
- Extension: load unpacked from `extension/` directory
- Auto-deploy: push to main → git pull + pm2 restart

## Auth System

Dashboard Auth tab manages credentials for delivery dispatch:
- 9 auth types: GitHub PAT/OAuth, GitLab PAT, Lark, Telegram, Slack, Notion, Custom Header/Bearer
- Credentials are user-scoped and referenced by delivery rules
- Server-side storage with encryption
