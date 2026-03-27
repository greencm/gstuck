#!/usr/bin/env bash
# sanitize.sh — Transform upstream gstack into a pinned, telemetry-removed version.
# Operates on a fresh clone in output/gstack/.
# Idempotent: safe to re-run.
#
# The entry point is always a commit that's at least QUARANTINE_DAYS old.
# This means if the upstream repo is compromised today, we won't pull it
# in until the quarantine window expires — giving time for detection.
#
# Usage:
#   bash scripts/sanitize.sh                          # Clone from GitHub, 7-day quarantine
#   bash scripts/sanitize.sh --local ../gstack        # Use local checkout (faster)
#   bash scripts/sanitize.sh --quarantine-days 14     # 14-day commit quarantine
#   bash scripts/sanitize.sh --quarantine-days 0      # Skip quarantine (emergency)
#   bash scripts/sanitize.sh --resolve-sha ../gstack  # Print the quarantine-safe SHA and exit
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT="$ROOT_DIR/output/gstack"
LOCAL_SOURCE=""
QUARANTINE_DAYS=7
RESOLVE_SHA_ONLY=""

# Parse flags
while [ $# -gt 0 ]; do
  case "$1" in
    --local) LOCAL_SOURCE="$2"; shift 2 ;;
    --local=*) LOCAL_SOURCE="${1#--local=}"; shift ;;
    --quarantine-days) QUARANTINE_DAYS="$2"; shift 2 ;;
    --quarantine-days=*) QUARANTINE_DAYS="${1#--quarantine-days=}"; shift ;;
    --resolve-sha) RESOLVE_SHA_ONLY="$2"; shift 2 ;;
    --resolve-sha=*) RESOLVE_SHA_ONLY="${1#--resolve-sha=}"; shift ;;
    *) shift ;;
  esac
done

# ─── Resolve quarantine-safe SHA ───────────────────────────────
resolve_quarantine_sha() {
  local repo_path="$1"
  local days="$2"

  if [ "$days" -eq 0 ]; then
    (cd "$repo_path" && git rev-parse HEAD)
    return
  fi

  local cutoff_date
  if date -v-1d +%Y-%m-%d >/dev/null 2>&1; then
    cutoff_date="$(date -v-${days}d -u +%Y-%m-%dT%H:%M:%SZ)"
  else
    cutoff_date="$(date -u -d "$days days ago" +%Y-%m-%dT%H:%M:%SZ)"
  fi

  local sha
  sha="$(cd "$repo_path" && git log --format='%H' --before="$cutoff_date" -1 origin/main 2>/dev/null || true)"

  if [ -z "$sha" ]; then
    echo "FATAL: No commit found on origin/main older than $days days ($cutoff_date)" >&2
    exit 1
  fi

  echo "$sha"
}

# ─── Handle --resolve-sha mode ────────────────────────────────
if [ -n "$RESOLVE_SHA_ONLY" ]; then
  REPO_PATH="$(cd "$RESOLVE_SHA_ONLY" && pwd)"
  (cd "$REPO_PATH" && git fetch --quiet origin 2>/dev/null || true)
  SHA=$(resolve_quarantine_sha "$REPO_PATH" "$QUARANTINE_DAYS")
  COMMIT_DATE="$(cd "$REPO_PATH" && git show -s --format='%ci' "$SHA" 2>/dev/null || echo 'unknown')"
  AGE_EPOCH="$(cd "$REPO_PATH" && git show -s --format='%ct' "$SHA" 2>/dev/null || echo 0)"
  AGE_DAYS=$(( ($(date +%s) - AGE_EPOCH) / 86400 ))
  echo "$SHA"
  echo "  Commit date: $COMMIT_DATE ($AGE_DAYS days ago)" >&2
  echo "  Quarantine: ${QUARANTINE_DAYS} days" >&2
  exit 0
fi

# ─── Read or resolve upstream SHA ──────────────────────────────
SHA_FILE="$ROOT_DIR/upstream.sha"
SHA=""
[ -f "$SHA_FILE" ] && SHA="$(cat "$SHA_FILE" | tr -d '[:space:]')"

echo "=== gstuck sanitization ==="
echo "Quarantine window: ${QUARANTINE_DAYS} days"

GIT_REPO=""
if [ -n "$LOCAL_SOURCE" ]; then
  GIT_REPO="$(cd "$LOCAL_SOURCE" && pwd)"
  (cd "$GIT_REPO" && git fetch --quiet origin 2>/dev/null || true)
fi

# Resolve or verify SHA
if [ -z "$SHA" ] && [ -n "$GIT_REPO" ]; then
  echo "No upstream.sha pinned — resolving quarantine-safe SHA..."
  SHA=$(resolve_quarantine_sha "$GIT_REPO" "$QUARANTINE_DAYS")
  echo "$SHA" > "$SHA_FILE"
  echo "Wrote $SHA to upstream.sha"
elif [ -n "$SHA" ] && [ -n "$GIT_REPO" ] && [ "$QUARANTINE_DAYS" -gt 0 ]; then
  COMMIT_EPOCH="$(cd "$GIT_REPO" && git show -s --format='%ct' "$SHA" 2>/dev/null || echo 0)"
  if [ "$COMMIT_EPOCH" -gt 0 ]; then
    CUTOFF_EPOCH=$(( $(date +%s) - QUARANTINE_DAYS * 86400 ))
    if [ "$COMMIT_EPOCH" -gt "$CUTOFF_EPOCH" ]; then
      AGE_DAYS=$(( ($(date +%s) - COMMIT_EPOCH) / 86400 ))
      echo "FAIL: Pinned SHA $SHA is only ${AGE_DAYS} days old (quarantine requires ${QUARANTINE_DAYS}+)"
      exit 1
    fi
    AGE_DAYS=$(( ($(date +%s) - COMMIT_EPOCH) / 86400 ))
    echo "Pinned SHA $SHA is ${AGE_DAYS} days old — quarantine OK"
  fi
fi

[ -z "$SHA" ] && { echo "FATAL: No SHA resolved."; exit 1; }
echo "Upstream SHA: $SHA"

# ─── Step 1: Fresh clone at pinned SHA ─────────────────────────
if [ -d "$OUTPUT" ]; then
  echo "Removing previous output..."
  rm -rf "$OUTPUT"
fi

if [ -n "$LOCAL_SOURCE" ]; then
  echo "Copying from local source: $LOCAL_SOURCE"
  LOCAL_RESOLVED="$(cd "$LOCAL_SOURCE" && pwd)"
  LOCAL_SHA="$(cd "$LOCAL_RESOLVED" && git rev-parse HEAD 2>/dev/null || true)"
  if [ "$LOCAL_SHA" != "$SHA" ]; then
    echo "Checking out $SHA in local source..."
    (cd "$LOCAL_RESOLVED" && git checkout --quiet "$SHA")
  fi
  mkdir -p "$OUTPUT"
  rsync -a --exclude='.git' --exclude='node_modules' --exclude='browse/dist' \
    "$LOCAL_RESOLVED/" "$OUTPUT/"
else
  echo "Cloning upstream at $SHA..."
  git clone --quiet https://github.com/garrytan/gstack.git "$OUTPUT"
  cd "$OUTPUT"
  git checkout --quiet "$SHA"
  rm -rf .git
fi

cd "$OUTPUT"
echo "Source ready."

# ─── Step 2: Delete Supabase infrastructure ────────────────────
echo "Removing supabase/..."
rm -rf supabase/

# ─── Step 2b: Delete analytics infrastructure ────────────────────
echo "Removing analytics CLI and tests..."
rm -f scripts/analytics.ts test/analytics.test.ts

# ─── Step 2c: Delete .agents/ directory (Agent SDK layout not used) ──
if [ -d ".agents" ]; then
  echo "Removing .agents/..."
  rm -rf .agents/
fi

# ─── Step 3: No-op telemetry/update bin scripts ────────────────
for script in bin/gstack-telemetry-log bin/gstack-telemetry-sync bin/gstack-update-check bin/gstack-analytics bin/gstack-community-dashboard; do
  if [ -f "$script" ]; then
    echo "  No-op: $script"
    printf '#!/usr/bin/env bash\n# [gstuck] Neutralized.\nexit 0\n' > "$script"
    chmod +x "$script"
  fi
done

# ─── Step 9: Stub cross-tool session scanner ──────────────────
if [ -f "bin/gstack-global-discover.ts" ]; then
  echo "  Stubbing gstack-global-discover.ts"
  cat > "bin/gstack-global-discover.ts" << 'STUB'
#!/usr/bin/env bun
// [gstuck] Cross-tool session scanning disabled.
console.log(JSON.stringify({
  window: "0d", start_date: new Date().toISOString().split("T")[0],
  repos: [], tools: { claude_code: { total_sessions: 0, repos: 0 }, codex: { total_sessions: 0, repos: 0 }, gemini: { total_sessions: 0, repos: 0 } },
  total_sessions: 0, total_repos: 0,
}, null, 2));
STUB
fi

# ─── Steps 4-15: All file transforms (node — cross-platform) ──
echo "Running file transforms..."
node "$SCRIPT_DIR/transforms.mjs"

# ─── Step 14: Append gstuck entry to CHANGELOG.md ─────────────
if [ -f "CHANGELOG.md" ]; then
  echo "Appending gstuck changelog entry..."
  UPSTREAM_VERSION="$(cat VERSION 2>/dev/null | tr -d '[:space:]' || echo 'unknown')"
  SANITIZE_DATE="$(date -u +%Y-%m-%d)"
  ENTRY="## gstuck (based on upstream v${UPSTREAM_VERSION}, sanitized ${SANITIZE_DATE})

### Removed
- Supabase telemetry system (all phone-home calls to frugpmstpnojnhfyimgv.supabase.co)
- GitHub update checks (raw.githubusercontent.com fetches on every invocation)
- Local analytics JSONL writes (unconditional repo-name logging)
- Telemetry opt-in prompt
- YC referral content and tracked URLs (ycombinator.com/apply?ref=gstack)
- Lake intro browser open (garryslist.org)
- Auto-upgrade from public GitHub
- Cross-tool session scanner (~/.claude/, ~/.codex/, ~/.gemini/ reads)

### Changed
- Dependencies pinned to exact versions (no ^ ranges)
- bun.lock committed for reproducible builds
- Supply-chain quarantine check (configurable, default 7 days)
- Skill paths rewritten for gstuck layout

---

"
  printf '%s' "$ENTRY" | cat - CHANGELOG.md > CHANGELOG.tmp && mv CHANGELOG.tmp CHANGELOG.md
fi

echo ""
echo "=== Sanitization complete ==="
echo "Run scripts/pin-deps.sh next."
