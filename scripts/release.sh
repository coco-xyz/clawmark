#!/usr/bin/env bash
# scripts/release.sh — ClawMark Full Release Pipeline
#
# Usage:
#   ./scripts/release.sh <version>              # e.g. 0.8.2
#   ./scripts/release.sh <version> --dry-run    # preview only
#   ./scripts/release.sh <version> --yes        # skip confirmation
#
# Full pipeline (9 steps):
#   1. Validate version (semver, must be > current)
#   2. Version bump + changelog
#   3. Commit + tag
#   4. Build test + production zips
#   5. Publish zips to http/public
#   6. Push to GitLab (branch + main merge + tag)
#   7. Create GitLab Release with asset links
#   8. Restart PM2 services + verify
#   9. Self-verify all links + notify
#
# Requires: git, jq, zip, curl, node, pm2

set -euo pipefail

VERSION="${1:-}"
DRY_RUN=false
AUTO_YES=false
shift || true
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --yes|-y)  AUTO_YES=true ;;
  esac
done

# ── Helpers ───────────────────────────────────────────────────────────────────

log()  { echo "▶ $*"; }
err()  { echo "✗ $*" >&2; exit 1; }
info() { echo "  $*"; }
warn() { echo "⚠ $*" >&2; }
ok()   { echo "  ✅ $*"; }
fail() { echo "  ❌ $*" >&2; }

require_cmd() { command -v "$1" &>/dev/null || err "Required command not found: $1"; }

# ── Config ────────────────────────────────────────────────────────────────────

PUBLISH_DIR="${PUBLISH_DIR:-$HOME/zylos/http/public}"
DOWNLOAD_BASE="${DOWNLOAD_BASE:-https://jessie.coco.site}"
GITLAB_REMOTE="gitlab"
GITLAB_API="https://git.coco.xyz/api/v4"
GITLAB_PROJECT_ID="2"  # hxanet/clawmark

# ── Validate ──────────────────────────────────────────────────────────────────

[[ -z "$VERSION" ]] && err "Usage: $0 <version> [--dry-run] [--yes]"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || err "Version must be semver: X.Y.Z (got: $VERSION)"

require_cmd git
require_cmd jq
require_cmd zip
require_cmd curl

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

CURRENT_VERSION=$(jq -r '.version' package.json)
log "Current version: $CURRENT_VERSION → New version: $VERSION"

# Simple semver comparison
semver_gt() {
  local a=$1 b=$2
  IFS='.' read -r a1 a2 a3 <<< "$a"
  IFS='.' read -r b1 b2 b3 <<< "$b"
  [[ "$a1" -gt "$b1" ]] && return 0
  [[ "$a1" -eq "$b1" && "$a2" -gt "$b2" ]] && return 0
  [[ "$a1" -eq "$b1" && "$a2" -eq "$b2" && "$a3" -gt "$b3" ]] && return 0
  return 1
}

semver_gt "$VERSION" "$CURRENT_VERSION" || err "New version ($VERSION) must be greater than current ($CURRENT_VERSION)"

# Extract GitLab token from remote URL
GITLAB_TOKEN=$(git remote get-url "$GITLAB_REMOTE" 2>/dev/null | grep -oP 'glpat-[^@]+' || echo "")
[[ -z "$GITLAB_TOKEN" ]] && warn "No GitLab token found — GitLab Release step will be skipped"

# ── Gather commits since last tag ─────────────────────────────────────────────

LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
if [[ -n "$LAST_TAG" ]]; then
  log "Collecting commits since $LAST_TAG"
  COMMITS=$(git log "${LAST_TAG}..HEAD" --pretty=format:"%s" --no-merges)
else
  log "No previous tag found — collecting all commits"
  COMMITS=$(git log --pretty=format:"%s" --no-merges)
fi

# ── Categorize commits ────────────────────────────────────────────────────────

FEATURES=""
FIXES=""
DOCS=""
CHORE=""
BREAKING=""
SECURITY=""

while IFS= read -r commit; do
  [[ -z "$commit" ]] && continue
  case "$commit" in
    BREAKING*|"!:"*|*"BREAKING CHANGE"*)
      BREAKING+="- $commit"$'\n' ;;
    feat:*|feat\(*\):*)
      FEATURES+="- ${commit#*: }"$'\n' ;;
    fix:*|fix\(*\):*)
      FIXES+="- ${commit#*: }"$'\n' ;;
    security:*|sec:*)
      SECURITY+="- ${commit#*: }"$'\n' ;;
    docs:*)
      DOCS+="- ${commit#*: }"$'\n' ;;
    chore:*|refactor:*|perf:*|test:*|ci:*)
      CHORE+="- $commit"$'\n' ;;
    *)
      CHORE+="- $commit"$'\n' ;;
  esac
done <<< "$COMMITS"

# ── Build release notes ───────────────────────────────────────────────────────

TODAY=$(date +%Y-%m-%d)
NOTES="## [${VERSION}] — ${TODAY}"$'\n\n'

[[ -n "$BREAKING" ]] && NOTES+="### ⚠️ 破坏性变更"$'\n\n'"$BREAKING"$'\n'
[[ -n "$FEATURES" ]] && NOTES+="### ✨ 新增"$'\n\n'"$FEATURES"$'\n'
[[ -n "$FIXES" ]]    && NOTES+="### 🐛 修复"$'\n\n'"$FIXES"$'\n'
[[ -n "$SECURITY" ]] && NOTES+="### 🔒 安全"$'\n\n'"$SECURITY"$'\n'
[[ -n "$DOCS" ]]     && NOTES+="### 📋 文档"$'\n\n'"$DOCS"$'\n'
[[ -n "$CHORE" ]]    && NOTES+="### 🔧 其他"$'\n\n'"$CHORE"$'\n'

# GitLab release description (notes + download table + metadata)
GITLAB_NOTES="$NOTES"
GITLAB_NOTES+="### 📥 下载"$'\n\n'
GITLAB_NOTES+="| 环境 | 链接 |"$'\n'
GITLAB_NOTES+="|------|------|"$'\n'
GITLAB_NOTES+="| Production | [clawmark-v${VERSION}-production.zip](${DOWNLOAD_BASE}/clawmark-v${VERSION}-production.zip) |"$'\n'
GITLAB_NOTES+="| Test | [clawmark-v${VERSION}-test.zip](${DOWNLOAD_BASE}/clawmark-v${VERSION}-test.zip) |"$'\n\n'
GITLAB_NOTES+="- **版本号**: v${VERSION} | **发布日期**: ${TODAY} | **上一版本**: ${LAST_TAG:-none}"$'\n\n'
GITLAB_NOTES+="---"$'\n'
GITLAB_NOTES+="*ClawMark — AI-native feedback & annotation for any web page*"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Release Notes Preview — v${VERSION}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "$NOTES"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if $DRY_RUN; then
  log "Dry run complete — no files modified."
  exit 0
fi

if ! $AUTO_YES; then
  read -rp "Proceed with release v${VERSION}? [y/N] " confirm
  [[ "$confirm" =~ ^[Yy]$ ]] || { log "Aborted."; exit 0; }
fi

# ══════════════════════════════════════════════════════════════════════════════
# STEP 1-2: Version bump + changelog
# ══════════════════════════════════════════════════════════════════════════════

log "Step 1/9: Version bump..."

tmp=$(mktemp)
jq ".version = \"$VERSION\"" package.json > "$tmp" && mv "$tmp" package.json
info "package.json → $VERSION"

MANIFEST="extension/manifest.json"
if [[ -f "$MANIFEST" ]]; then
  tmp=$(mktemp)
  jq ".version = \"$VERSION\"" "$MANIFEST" > "$tmp" && mv "$tmp" "$MANIFEST"
  info "manifest.json → $VERSION"
fi

log "Step 2/9: Updating CHANGELOG.md..."
if [[ -f CHANGELOG.md ]]; then
  HEADER=$(head -5 CHANGELOG.md)
  REST=$(tail -n +6 CHANGELOG.md)
  { echo "$HEADER"; echo ""; echo "$NOTES"; echo "---"; echo ""; echo "$REST"; } > CHANGELOG.md.tmp && mv CHANGELOG.md.tmp CHANGELOG.md
  info "CHANGELOG.md updated"
fi

# ══════════════════════════════════════════════════════════════════════════════
# STEP 3: Commit + tag
# ══════════════════════════════════════════════════════════════════════════════

log "Step 3/9: Commit + tag..."
git add package.json "$MANIFEST" CHANGELOG.md
git commit -m "chore: release v${VERSION}"
git tag -a "v${VERSION}" -m "Release v${VERSION}"$'\n\n'"$NOTES"
ok "Committed and tagged v${VERSION}"

# ══════════════════════════════════════════════════════════════════════════════
# STEP 4: Build test + production zips
# ══════════════════════════════════════════════════════════════════════════════

log "Step 4/9: Building extension zips..."
bash scripts/build.sh test
TEST_ZIP="${REPO_ROOT}/clawmark-v${VERSION}-test.zip"
[[ -f "$TEST_ZIP" ]] && ok "Test zip built" || fail "Test zip not found"

bash scripts/build.sh production
PROD_ZIP="${REPO_ROOT}/clawmark-v${VERSION}-production.zip"
[[ -f "$PROD_ZIP" ]] && ok "Production zip built" || fail "Production zip not found"

# ══════════════════════════════════════════════════════════════════════════════
# STEP 5: Publish to http/public
# ══════════════════════════════════════════════════════════════════════════════

log "Step 5/9: Publishing zips..."
if [[ -d "$PUBLISH_DIR" ]]; then
  cp "$TEST_ZIP" "$PUBLISH_DIR/"
  cp "$PROD_ZIP" "$PUBLISH_DIR/"
  cp "$PROD_ZIP" "$PUBLISH_DIR/clawmark-latest.zip"
  ok "Published to $PUBLISH_DIR/"
else
  warn "Publish dir $PUBLISH_DIR not found — skipping"
fi

# ══════════════════════════════════════════════════════════════════════════════
# STEP 6: Push to GitLab
# ══════════════════════════════════════════════════════════════════════════════

log "Step 6/9: Pushing to GitLab..."
CURRENT_BRANCH=$(git branch --show-current)
git push "$GITLAB_REMOTE" "$CURRENT_BRANCH" 2>&1 || warn "Push $CURRENT_BRANCH failed"

if [[ "$CURRENT_BRANCH" == "develop" ]]; then
  git checkout main
  git pull "$GITLAB_REMOTE" main 2>/dev/null || true
  git merge develop --no-edit
  git push "$GITLAB_REMOTE" main 2>&1 || warn "Push main failed"
  git checkout develop
  ok "Merged develop → main"
fi

git push "$GITLAB_REMOTE" "v${VERSION}" 2>&1 || warn "Push tag failed"
ok "Pushed tag v${VERSION}"

# ══════════════════════════════════════════════════════════════════════════════
# STEP 7: Create GitLab Release
# ══════════════════════════════════════════════════════════════════════════════

log "Step 7/9: Creating GitLab Release..."
if [[ -n "$GITLAB_TOKEN" ]]; then
  RELEASE_PAYLOAD=$(python3 -c "
import json, sys
desc = sys.stdin.read()
print(json.dumps({
    'name': 'ClawMark v$VERSION',
    'tag_name': 'v$VERSION',
    'description': desc,
    'assets': {
        'links': [
            {'name': 'clawmark-v$VERSION-production.zip', 'url': '$DOWNLOAD_BASE/clawmark-v$VERSION-production.zip', 'link_type': 'package'},
            {'name': 'clawmark-v$VERSION-test.zip', 'url': '$DOWNLOAD_BASE/clawmark-v$VERSION-test.zip', 'link_type': 'package'}
        ]
    }
}))
" <<< "$GITLAB_NOTES")

  HTTP_CODE=$(curl -s -o /tmp/release-result.json -w "%{http_code}" \
    --request POST --header "PRIVATE-TOKEN: $GITLAB_TOKEN" --header "Content-Type: application/json" \
    "$GITLAB_API/projects/$GITLAB_PROJECT_ID/releases" --data "$RELEASE_PAYLOAD")

  if [[ "$HTTP_CODE" == "201" ]]; then
    ok "GitLab Release created"
  else
    warn "Create returned $HTTP_CODE — updating existing..."
    curl -s --request PUT --header "PRIVATE-TOKEN: $GITLAB_TOKEN" --header "Content-Type: application/json" \
      "$GITLAB_API/projects/$GITLAB_PROJECT_ID/releases/v${VERSION}" \
      --data "$(python3 -c "import json,sys; print(json.dumps({'name':'ClawMark v$VERSION','description':sys.stdin.read()}))" <<< "$GITLAB_NOTES")" > /dev/null
    for LINK_DATA in \
      "{\"name\":\"clawmark-v${VERSION}-production.zip\",\"url\":\"${DOWNLOAD_BASE}/clawmark-v${VERSION}-production.zip\",\"link_type\":\"package\"}" \
      "{\"name\":\"clawmark-v${VERSION}-test.zip\",\"url\":\"${DOWNLOAD_BASE}/clawmark-v${VERSION}-test.zip\",\"link_type\":\"package\"}"; do
      curl -s --request POST --header "PRIVATE-TOKEN: $GITLAB_TOKEN" --header "Content-Type: application/json" \
        "$GITLAB_API/projects/$GITLAB_PROJECT_ID/releases/v${VERSION}/assets/links" \
        --data "$LINK_DATA" > /dev/null 2>&1 || true
    done
    ok "GitLab Release updated"
  fi
else
  warn "No GitLab token — skipping"
fi

# ══════════════════════════════════════════════════════════════════════════════
# STEP 8: Restart PM2 + verify
# ══════════════════════════════════════════════════════════════════════════════

log "Step 8/9: Restart + verify..."
if command -v pm2 &>/dev/null; then
  pm2 restart clawmark 2>/dev/null && ok "Restarted clawmark" || warn "clawmark restart failed"
  pm2 restart clawmark-test 2>/dev/null && ok "Restarted clawmark-test" || warn "clawmark-test restart failed"
  sleep 2
fi

# Deploy dashboard to Caddy serving directory
DASHBOARD_DEPLOY_DIR="$HOME/zylos/http/clawmark-dashboard"
if [ -d "$DASHBOARD_DEPLOY_DIR" ] && [ -d "dashboard/dist" ]; then
  rm -rf "$DASHBOARD_DEPLOY_DIR"/*
  cp -r dashboard/dist/* "$DASHBOARD_DEPLOY_DIR/"
  ok "Dashboard deployed to $DASHBOARD_DEPLOY_DIR"
fi

# ══════════════════════════════════════════════════════════════════════════════
# STEP 9: Self-verify + notify
# ══════════════════════════════════════════════════════════════════════════════

log "Step 9/9: Self-verify + notify..."
VERIFY_PASS=true

# Verify download links
for URL in \
  "${DOWNLOAD_BASE}/clawmark-v${VERSION}-production.zip" \
  "${DOWNLOAD_BASE}/clawmark-v${VERSION}-test.zip" \
  "${DOWNLOAD_BASE}/clawmark-latest.zip"; do
  HTTP_CODE=$(curl -sI -o /dev/null -w "%{http_code}" "$URL" 2>/dev/null || echo "000")
  if [[ "$HTTP_CODE" == "200" ]]; then
    ok "$URL → 200"
  else
    fail "$URL → $HTTP_CODE"
    VERIFY_PASS=false
  fi
done

# Verify GitLab Release exists
if [[ -n "$GITLAB_TOKEN" ]]; then
  GL_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \
    "$GITLAB_API/projects/$GITLAB_PROJECT_ID/releases/v${VERSION}")
  [[ "$GL_STATUS" == "200" ]] && ok "GitLab Release exists" || { fail "GitLab Release not found ($GL_STATUS)"; VERIFY_PASS=false; }
fi

# Verify manifest version inside zip
MANIFEST_VER=$(unzip -p "$PROD_ZIP" manifest.json 2>/dev/null | jq -r '.version' 2>/dev/null || echo "unknown")
[[ "$MANIFEST_VER" == "$VERSION" ]] && ok "Manifest version: $MANIFEST_VER" || { fail "Manifest mismatch: $MANIFEST_VER"; VERIFY_PASS=false; }

# Notify via C4
C4_SEND="$HOME/zylos/.claude/skills/comm-bridge/scripts/c4-send.js"
LARK_FEEDS="oc_df3133671613b5a4e03da37e31eae69b"

if [[ -x "$(command -v node)" && -f "$C4_SEND" ]]; then
  NOTIFY_MSG="**ClawMark v${VERSION} Released**
$(echo "$FEATURES" | head -5)$(echo "$FIXES" | head -5)
Download:
- Production: ${DOWNLOAD_BASE}/clawmark-v${VERSION}-production.zip
- Test: ${DOWNLOAD_BASE}/clawmark-v${VERSION}-test.zip
- GitLab: https://git.coco.xyz/hxanet/clawmark/-/releases/v${VERSION}"
  node "$C4_SEND" "lark" "$LARK_FEEDS" "$NOTIFY_MSG" 2>/dev/null && ok "Lark notified" || warn "Lark notification failed"
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if $VERIFY_PASS; then
  log "✅ ClawMark v${VERSION} released and verified!"
else
  log "⚠️  ClawMark v${VERSION} released with verification warnings"
fi
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
info "GitLab: https://git.coco.xyz/hxanet/clawmark/-/releases/v${VERSION}"
info "Prod:   ${DOWNLOAD_BASE}/clawmark-v${VERSION}-production.zip"
info "Test:   ${DOWNLOAD_BASE}/clawmark-v${VERSION}-test.zip"
