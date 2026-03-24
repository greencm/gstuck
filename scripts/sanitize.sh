#!/usr/bin/env bash
# sanitize.sh — Transform upstream gstack into an pinned, telemetry-removed version.
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
# Find the latest commit on main that's at least QUARANTINE_DAYS old.
# This is the entry point — we never sanitize anything newer.
resolve_quarantine_sha() {
  local repo_path="$1"
  local days="$2"

  if [ "$days" -eq 0 ]; then
    # No quarantine — use HEAD
    (cd "$repo_path" && git rev-parse HEAD)
    return
  fi

  # Find the latest commit at least N days old
  local cutoff_date
  if date -v-1d +%Y-%m-%d >/dev/null 2>&1; then
    # macOS date
    cutoff_date="$(date -v-${days}d -u +%Y-%m-%dT%H:%M:%SZ)"
  else
    # GNU date
    cutoff_date="$(date -u -d "$days days ago" +%Y-%m-%dT%H:%M:%SZ)"
  fi

  local sha
  sha="$(cd "$repo_path" && git log --format='%H' --before="$cutoff_date" -1 origin/main 2>/dev/null || true)"

  if [ -z "$sha" ]; then
    echo "FATAL: No commit found on origin/main older than $days days ($cutoff_date)" >&2
    echo "  This means all commits are within the quarantine window." >&2
    echo "  Options:" >&2
    echo "    1. Wait for commits to age past the window" >&2
    echo "    2. Use --quarantine-days 0 (emergency only)" >&2
    exit 1
  fi

  echo "$sha"
}

# ─── Handle --resolve-sha mode (print SHA and exit) ───────────
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

if [ -f "$SHA_FILE" ]; then
  SHA="$(cat "$SHA_FILE" | tr -d '[:space:]')"
fi

echo "=== gstuck sanitization ==="
echo "Quarantine window: ${QUARANTINE_DAYS} days"

# ─── Step 0: Ensure we have a git repo to resolve against ─────
# We need a git repo to verify the commit age. Use --local source
# or clone a bare copy.
GIT_REPO=""
if [ -n "$LOCAL_SOURCE" ]; then
  GIT_REPO="$(cd "$LOCAL_SOURCE" && pwd)"
  (cd "$GIT_REPO" && git fetch --quiet origin 2>/dev/null || true)
else
  # For remote clone, we'll verify after cloning
  GIT_REPO=""
fi

# ─── Step 0b: Resolve SHA if not pinned, or verify pinned SHA age ──
if [ -z "$SHA" ] && [ -n "$GIT_REPO" ]; then
  echo "No upstream.sha pinned — resolving quarantine-safe SHA..."
  SHA=$(resolve_quarantine_sha "$GIT_REPO" "$QUARANTINE_DAYS")
  echo "$SHA" > "$SHA_FILE"
  echo "Wrote $SHA to upstream.sha"
elif [ -n "$SHA" ] && [ -n "$GIT_REPO" ] && [ "$QUARANTINE_DAYS" -gt 0 ]; then
  # Verify the pinned SHA is old enough
  COMMIT_EPOCH="$(cd "$GIT_REPO" && git show -s --format='%ct' "$SHA" 2>/dev/null || echo 0)"
  if [ "$COMMIT_EPOCH" -eq 0 ]; then
    echo "WARNING: Could not verify commit date for $SHA — proceeding with caution"
  else
    CUTOFF_EPOCH=$(( $(date +%s) - QUARANTINE_DAYS * 86400 ))
    if [ "$COMMIT_EPOCH" -gt "$CUTOFF_EPOCH" ]; then
      AGE_DAYS=$(( ($(date +%s) - COMMIT_EPOCH) / 86400 ))
      echo "FAIL: Pinned SHA $SHA is only ${AGE_DAYS} days old (quarantine requires ${QUARANTINE_DAYS}+)"
      echo ""
      echo "Options:"
      echo "  1. Wait for the commit to age past the quarantine window"
      echo "  2. Resolve a safe SHA: bash scripts/sanitize.sh --resolve-sha ../gstack"
      echo "  3. Override with --quarantine-days 0 (emergency only)"
      exit 1
    fi
    AGE_DAYS=$(( ($(date +%s) - COMMIT_EPOCH) / 86400 ))
    echo "Pinned SHA $SHA is ${AGE_DAYS} days old — quarantine OK"
  fi
fi

if [ -z "$SHA" ]; then
  echo "FATAL: No SHA resolved. Provide upstream.sha or use --local with a git repo."
  exit 1
fi

echo "Upstream SHA: $SHA"

# ─── Step 1: Fresh clone at pinned SHA ─────────────────────────
if [ -d "$OUTPUT" ]; then
  echo "Removing previous output..."
  rm -rf "$OUTPUT"
fi

if [ -n "$LOCAL_SOURCE" ]; then
  echo "Copying from local source: $LOCAL_SOURCE"
  LOCAL_RESOLVED="$(cd "$LOCAL_SOURCE" && pwd)"
  # Verify the SHA matches
  LOCAL_SHA="$(cd "$LOCAL_RESOLVED" && git rev-parse HEAD 2>/dev/null || true)"
  if [ "$LOCAL_SHA" != "$SHA" ]; then
    echo "Checking out $SHA in local source..."
    (cd "$LOCAL_RESOLVED" && git checkout --quiet "$SHA")
  fi
  # Copy (exclude .git, node_modules, browse/dist)
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
echo "Removing supabase/ (hardcoded Supabase URL + anon key + edge functions)..."
rm -rf supabase/

# ─── Step 3: No-op telemetry/update bin scripts ────────────────
NOOP_SCRIPTS=(
  "bin/gstack-telemetry-log"
  "bin/gstack-telemetry-sync"
  "bin/gstack-update-check"
  "bin/gstack-analytics"
  "bin/gstack-community-dashboard"
)

for script in "${NOOP_SCRIPTS[@]}"; do
  if [ -f "$script" ]; then
    echo "  No-op: $script"
    cat > "$script" << 'NOOP'
#!/usr/bin/env bash
# [gstuck] This script has been neutralized for gstuck.
# Original functionality removed: telemetry/update-check/analytics.
exit 0
NOOP
    chmod +x "$script"
  fi
done

# ─── Step 4: Modify scripts/gen-skill-docs.ts ──────────────────
# This is the single source of truth for all generated SKILL.md preambles.
GEN_SCRIPT="scripts/gen-skill-docs.ts"
echo "Modifying $GEN_SCRIPT..."

if [ ! -f "$GEN_SCRIPT" ]; then
  echo "FATAL: $GEN_SCRIPT not found — upstream may have restructured"
  exit 1
fi

# 4a: Remove telemetry lines from generatePreamble() bash block
# These are inside a template literal, so we match the literal strings.

# Remove _TEL config read and related lines
sed -i '' '/_TEL=.*gstack-config get telemetry/d' "$GEN_SCRIPT"
sed -i '' '/_TEL_PROMPTED=.*telemetry-prompted/d' "$GEN_SCRIPT"
sed -i '' '/_TEL_START=.*date/d' "$GEN_SCRIPT"
sed -i '' '/_SESSION_ID=.*date/d' "$GEN_SCRIPT"
sed -i '' '/echo "TELEMETRY:/d' "$GEN_SCRIPT"
sed -i '' '/echo "TEL_PROMPTED:/d' "$GEN_SCRIPT"

# Remove unconditional JSONL write (writes repo name to analytics)
sed -i '' '/skill-usage\.jsonl/d' "$GEN_SCRIPT"
sed -i '' '/mkdir -p ~\/.gstack\/analytics/d' "$GEN_SCRIPT"

# Remove .pending-* finalization loop
sed -i '' '/\.pending-/d' "$GEN_SCRIPT"

# 4b: Empty generateUpgradeCheck()
# Match the function and replace its body with return ''
node -e "
const fs = require('fs');
let src = fs.readFileSync('$GEN_SCRIPT', 'utf-8');

// Replace generateUpgradeCheck body
src = src.replace(
  /function generateUpgradeCheck\(ctx: TemplateContext\): string \{[\s\S]*?\n\}/,
  'function generateUpgradeCheck(ctx: TemplateContext): string {\n  return \\'\\'; // [gstuck] Update checks disabled\n}'
);

// Replace generateLakeIntro body
src = src.replace(
  /function generateLakeIntro\(\): string \{[\s\S]*?\n\}/,
  'function generateLakeIntro(): string {\n  return \\'\\'; // [gstuck] Lake intro disabled\n}'
);

// Replace generateTelemetryPrompt body
src = src.replace(
  /function generateTelemetryPrompt\(ctx: TemplateContext\): string \{[\s\S]*?\n\}/,
  'function generateTelemetryPrompt(ctx: TemplateContext): string {\n  return \\'\\'; // [gstuck] Telemetry prompt disabled\n}'
);

// Remove telemetry epilogue section (between '## Telemetry (run last)' and '## Plan Status Footer')
src = src.replace(
  /## Telemetry \(run last\)[\s\S]*?(?=## Plan Status Footer)/,
  ''
);

fs.writeFileSync('$GEN_SCRIPT', src);
console.log('  gen-skill-docs.ts: replaced 3 functions + removed telemetry epilogue');
"

# ─── Step 5: Remove inline analytics from templates AND pre-generated files ──
echo "Removing inline analytics from all skill files..."
# Clean .tmpl (source), SKILL.md (pre-generated), and other .md files
find . \( -name '*.tmpl' -o -name 'SKILL.md' \) \
  -exec sed -i '' '/mkdir -p ~\/.gstack\/analytics/d' {} +
find . \( -name '*.tmpl' -o -name 'SKILL.md' \) \
  -exec sed -i '' '/skill-usage\.jsonl/d' {} +
find . \( -name '*.tmpl' -o -name 'SKILL.md' \) \
  -exec sed -i '' '/spec-review\.jsonl/d' {} +
find . \( -name '*.tmpl' -o -name 'SKILL.md' \) \
  -exec sed -i '' '/eureka\.jsonl/d' {} +

# ─── Step 6: Remove analytics from hook scripts ────────────────
for hook in careful/bin/check-careful.sh freeze/bin/check-freeze.sh; do
  if [ -f "$hook" ]; then
    echo "  Cleaning hook: $hook"
    sed -i '' '/mkdir -p ~\/.gstack\/analytics/d' "$hook"
    sed -i '' '/skill-usage\.jsonl/d' "$hook"
    # Also remove the spec-review.jsonl line if present
    sed -i '' '/spec-review\.jsonl/d' "$hook"
  fi
done

# ─── Step 7: Neutralize gstack-upgrade template ────────────────
UPGRADE_TMPL="gstack-upgrade/SKILL.md.tmpl"
if [ -f "$UPGRADE_TMPL" ]; then
  echo "Neutralizing upgrade template..."
  sed -i '' 's|https://github.com/garrytan/gstack.git|ENTERPRISE_GSTACK_REPO_URL|g' "$UPGRADE_TMPL"
  sed -i '' 's|git reset --hard origin/main|echo "[gstuck] Upgrades managed by your organization. See gstuck README."|g' "$UPGRADE_TMPL"
fi

# ─── Step 8: Remove YC referral from office-hours ──────────────
OH_TMPL="office-hours/SKILL.md.tmpl"
if [ -f "$OH_TMPL" ]; then
  echo "Removing YC referral content from office-hours..."
  # Remove lines containing YC referral URL
  sed -i '' '/ycombinator\.com\/apply/d' "$OH_TMPL"
  # Remove the tiered pitch content (Garry Tan personal notes)
  # These are multi-paragraph blocks — use node for reliable multi-line removal
  node -e "
const fs = require('fs');
let src = fs.readFileSync('$OH_TMPL', 'utf-8');

// Remove the personal note blocks from Garry Tan
src = src.replace(/A personal note from me, Garry Tan[\s\S]*?(?=### Next-skill recommendations)/,
  '### Next-skill recommendations\n\n');

// Remove remaining 'ycombinator.com' references
src = src.replace(/.*ycombinator\.com.*/g, '');

fs.writeFileSync('$OH_TMPL', src);
console.log('  Removed YC referral content');
"
fi

# ─── Step 9: Neutralize cross-tool session scanner ─────────────
DISCOVER="bin/gstack-global-discover.ts"
if [ -f "$DISCOVER" ]; then
  echo "Stubbing gstack-global-discover.ts..."
  cat > "$DISCOVER" << 'STUB'
#!/usr/bin/env bun
// [gstuck] Cross-tool session scanning disabled.
// Original script read ~/.claude/, ~/.codex/, ~/.gemini/ session data.
console.log(JSON.stringify({
  window: "0d",
  start_date: new Date().toISOString().split("T")[0],
  repos: [],
  tools: { claude_code: { total_sessions: 0, repos: 0 }, codex: { total_sessions: 0, repos: 0 }, gemini: { total_sessions: 0, repos: 0 } },
  total_sessions: 0,
  total_repos: 0,
}, null, 2));
STUB
fi

# ─── Step 10: Remove garryslist.org URL from all file types ────
echo "Removing garryslist.org references..."
find . \( -name '*.ts' -o -name '*.tmpl' -o -name '*.md' \) \
  -not -path '*/node_modules/*' \
  -exec sed -i '' 's|https://garryslist.org/posts/boil-the-ocean|#|g' {} + 2>/dev/null || true

# ─── Step 11: Remove YC referral from pre-generated SKILL.md files ────
echo "Removing ycombinator.com/apply from pre-generated files..."
find . -name '*.md' -not -path '*/node_modules/*' \
  -exec sed -i '' '/ycombinator\.com\/apply/d' {} + 2>/dev/null || true
# Also clean the test that validates the YC content
find . -name '*.ts' -not -path '*/node_modules/*' \
  -exec sed -i '' '/ycombinator\.com\/apply/d' {} + 2>/dev/null || true

# ─── Step 12: Clean up github.com/garrytan references ─────────
# These are in example output text — cosmetic but remove org-specific branding
find . \( -name '*.tmpl' -o -name '*.md' \) -not -path '*/node_modules/*' \
  -exec sed -i '' 's|github\.com/garrytan/gstack|github.com/greencm/gstuck|g' {} + 2>/dev/null || true

# ─── Step 13: Clean telemetry-related lines from pre-generated SKILL.md ──
# The preamble in pre-generated files has telemetry vars and pending marker lines
echo "Cleaning telemetry from pre-generated SKILL.md preambles..."
find . -name 'SKILL.md' -not -path '*/node_modules/*' \
  -exec sed -i '' '/_TEL=.*gstack-config get telemetry/d' {} +
find . -name 'SKILL.md' -not -path '*/node_modules/*' \
  -exec sed -i '' '/_TEL_PROMPTED=.*telemetry-prompted/d' {} +
find . -name 'SKILL.md' -not -path '*/node_modules/*' \
  -exec sed -i '' '/_TEL_START=.*date/d' {} +
find . -name 'SKILL.md' -not -path '*/node_modules/*' \
  -exec sed -i '' '/_SESSION_ID=.*date/d' {} +
find . -name 'SKILL.md' -not -path '*/node_modules/*' \
  -exec sed -i '' '/echo "TELEMETRY:/d' {} +
find . -name 'SKILL.md' -not -path '*/node_modules/*' \
  -exec sed -i '' '/echo "TEL_PROMPTED:/d' {} +
find . -name 'SKILL.md' -not -path '*/node_modules/*' \
  -exec sed -i '' '/\.pending-/d' {} +

# ─── Step 14: Append gstuck entry to CHANGELOG.md ────
if [ -f "CHANGELOG.md" ]; then
  echo "Appending gstuck changelog entry..."
  UPSTREAM_VERSION="$(cat VERSION 2>/dev/null | tr -d '[:space:]' || echo 'unknown')"
  SANITIZE_DATE="$(date -u +%Y-%m-%d)"
  # Prepend gstuck entry before upstream changelog
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
- gstack-upgrade template points to ENTERPRISE_GSTACK_REPO_URL

---

"
  # Prepend to existing changelog
  echo "$ENTRY$(cat CHANGELOG.md)" > CHANGELOG.md
fi

echo ""
echo "=== Sanitization complete ==="
echo "Run scripts/pin-deps.sh next."
