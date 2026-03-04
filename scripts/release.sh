#!/usr/bin/env bash
# scripts/release.sh — ClawMark Release Helper
#
# Usage:
#   ./scripts/release.sh <version>          # e.g. 0.7.0
#   ./scripts/release.sh <version> --dry-run
#
# What it does:
#   1. Validates version bump (semver, must be > current)
#   2. Updates package.json + extension/manifest.json
#   3. Generates release notes from git log since last tag
#   4. Prepends entry to CHANGELOG.md
#   5. Commits, tags, and optionally pushes
#
# Requires: git, node (for semver check), jq

set -euo pipefail

VERSION="${1:-}"
DRY_RUN=false
[[ "${2:-}" == "--dry-run" ]] && DRY_RUN=true

# ── Helpers ───────────────────────────────────────────────────────────────────

log()  { echo "▶ $*"; }
err()  { echo "✗ $*" >&2; exit 1; }
info() { echo "  $*"; }

require_cmd() { command -v "$1" &>/dev/null || err "Required command not found: $1"; }

# ── Validate ──────────────────────────────────────────────────────────────────

[[ -z "$VERSION" ]] && err "Usage: $0 <version> [--dry-run]"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || err "Version must be semver: X.Y.Z (got: $VERSION)"

require_cmd git
require_cmd jq

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

CURRENT_VERSION=$(jq -r '.version' package.json)
log "Current version: $CURRENT_VERSION → New version: $VERSION"

# Simple semver comparison (no pre-release support)
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
      msg="${commit#feat: }"; msg="${msg#feat(*): }"
      FEATURES+="- $msg"$'\n' ;;
    fix:*|fix\(*\):*)
      msg="${commit#fix: }"; msg="${msg#fix(*): }"
      FIXES+="- $msg"$'\n' ;;
    security:*|sec:*)
      msg="${commit#security: }"; msg="${msg#sec: }"
      SECURITY+="- $msg"$'\n' ;;
    docs:*)
      msg="${commit#docs: }"
      DOCS+="- $msg"$'\n' ;;
    chore:*|refactor:*|perf:*|test:*)
      CHORE+="- $commit"$'\n' ;;
    *)
      CHORE+="- $commit"$'\n' ;;
  esac
done <<< "$COMMITS"

# ── Build release notes ───────────────────────────────────────────────────────

TODAY=$(date +%Y-%m-%d)
NOTES="## [${VERSION}] — ${TODAY}"$'\n\n'

if [[ -n "$BREAKING" ]]; then
  NOTES+="### ⚠️ 破坏性变更 / Breaking Changes"$'\n\n'"$BREAKING"$'\n'
fi
if [[ -n "$FEATURES" ]]; then
  NOTES+="### 新增 / Added"$'\n\n'"$FEATURES"$'\n'
fi
if [[ -n "$FIXES" ]]; then
  NOTES+="### 修复 / Fixed"$'\n\n'"$FIXES"$'\n'
fi
if [[ -n "$SECURITY" ]]; then
  NOTES+="### 安全 / Security"$'\n\n'"$SECURITY"$'\n'
fi
if [[ -n "$DOCS" ]]; then
  NOTES+="### 文档 / Docs"$'\n\n'"$DOCS"$'\n'
fi
if [[ -n "$CHORE" ]]; then
  NOTES+="### 其他 / Chore"$'\n\n'"$CHORE"$'\n'
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Release Notes Preview — v${VERSION}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "$NOTES"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if $DRY_RUN; then
  log "Dry run complete — no files modified."
  exit 0
fi

# ── Confirm ───────────────────────────────────────────────────────────────────

read -rp "Proceed with release v${VERSION}? [y/N] " confirm
[[ "$confirm" =~ ^[Yy]$ ]] || { log "Aborted."; exit 0; }

# ── Apply changes ─────────────────────────────────────────────────────────────

log "Updating package.json..."
tmp=$(mktemp)
jq ".version = \"$VERSION\"" package.json > "$tmp" && mv "$tmp" package.json

MANIFEST="extension/manifest.json"
if [[ -f "$MANIFEST" ]]; then
  log "Updating $MANIFEST..."
  tmp=$(mktemp)
  jq ".version = \"$VERSION\"" "$MANIFEST" > "$tmp" && mv "$tmp" "$MANIFEST"
fi

log "Prepending to CHANGELOG.md..."
HEADER=$(head -5 CHANGELOG.md)
REST=$(tail -n +6 CHANGELOG.md)
{
  echo "$HEADER"
  echo ""
  echo "$NOTES"
  echo "---"
  echo ""
  echo "$REST"
} > CHANGELOG.md.tmp && mv CHANGELOG.md.tmp CHANGELOG.md

log "Committing..."
git add package.json "$MANIFEST" CHANGELOG.md
git commit -m "chore: release v${VERSION}"

log "Tagging v${VERSION}..."
git tag -a "v${VERSION}" -m "Release v${VERSION}"$'\n\n'"$NOTES"

log ""
log "✅ Release v${VERSION} prepared locally."
log "   To push: git push origin develop && git push origin v${VERSION}"
log "   GitLab will auto-create a Release from the tag."
