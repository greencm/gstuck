#!/usr/bin/env bash
# verify.sh — Static verification gate for sanitized gstack.
# Greps for known phone-home patterns. Fails if any survive.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT="$SCRIPT_DIR/../output/gstack"

if [ ! -d "$OUTPUT" ]; then
  echo "FATAL: output/gstack/ not found — run sanitize.sh first"
  exit 1
fi

cd "$OUTPUT"

echo "=== Static Verification ==="
FAIL=0

# ─── Banned patterns (must not exist in output) ───────────────
BANNED_PATTERNS=(
  "frugpmstpnojnhfyimgv.supabase.co"
  "raw.githubusercontent.com/garrytan"
  "ycombinator.com/apply"
  "garryslist.org"
)

for pattern in "${BANNED_PATTERNS[@]}"; do
  # Exclude CHANGELOG.md (historical upstream docs) and test/ (validation fixtures)
  MATCHES=$(grep -r --include='*.md' --include='*.tmpl' --include='*.sh' --include='*.ts' \
    -l "$pattern" . 2>/dev/null \
    | grep -v node_modules | grep -v '.git/' | grep -v CHANGELOG.md | grep -v 'test/' || true)
  if [ -n "$MATCHES" ]; then
    echo "FAIL: pattern '$pattern' found in:"
    echo "$MATCHES" | sed 's/^/  /'
    FAIL=1
  fi
done

# ─── Check github.com/garrytan/gstack.git in upgrade template ─
if [ -f "gstack-upgrade/SKILL.md.tmpl" ]; then
  if grep -q 'github.com/garrytan/gstack.git' "gstack-upgrade/SKILL.md.tmpl"; then
    echo "FAIL: upstream clone URL still in gstack-upgrade template"
    FAIL=1
  fi
fi

# ─── No telemetry epilogue in generated SKILL.md files ────────
TEL_EPILOGUE=$(grep -rn 'Telemetry (run last)' --include='*.md' . 2>/dev/null \
  | grep -v node_modules | grep -v CHANGELOG.md | grep -v test/ || true)
if [ -n "$TEL_EPILOGUE" ]; then
  echo "FAIL: telemetry epilogue found in generated skills:"
  echo "$TEL_EPILOGUE" | head -5 | sed 's/^/  /'
  FAIL=1
fi

# ─── No JSONL writes in generated SKILL.md files ──────────────
# Exclude CHANGELOG.md — it documents upstream history (not active code)
JSONL_MATCHES=$(grep -r 'skill-usage\.jsonl' --include='*.md' . 2>/dev/null \
  | grep -v node_modules | grep -v CHANGELOG.md || true)
if [ -n "$JSONL_MATCHES" ]; then
  echo "FAIL: skill-usage.jsonl write found in generated skills:"
  echo "$JSONL_MATCHES" | sed 's/^/  /'
  FAIL=1
fi

# ─── No JSONL writes in templates ─────────────────────────────
TMPL_JSONL=$(grep -r 'skill-usage\.jsonl' --include='*.tmpl' . 2>/dev/null || true)
if [ -n "$TMPL_JSONL" ]; then
  echo "FAIL: skill-usage.jsonl write found in templates:"
  echo "$TMPL_JSONL" | sed 's/^/  /'
  FAIL=1
fi

# ─── Telemetry bin scripts are no-ops ─────────────────────────
for script in bin/gstack-telemetry-log bin/gstack-telemetry-sync bin/gstack-update-check; do
  if [ -f "$script" ]; then
    if ! grep -q 'exit 0' "$script"; then
      echo "FAIL: $script is not a no-op"
      FAIL=1
    fi
    # Also check it doesn't contain curl, supabase, or other active code
    if grep -q 'curl\|supabase\|ENDPOINT\|JSONL_FILE' "$script"; then
      echo "FAIL: $script still contains active telemetry code"
      FAIL=1
    fi
  fi
done

# ─── .github/ directory should not exist ─────────────────────
if [ -d ".github" ]; then
  echo "FAIL: .github/ directory still exists (upstream CI infrastructure)"
  FAIL=1
fi

# ─── supabase/ directory should not exist ─────────────────────
if [ -d "supabase" ]; then
  echo "FAIL: supabase/ directory still exists"
  FAIL=1
fi

# ─── No telemetry prompt in gen-skill-docs.ts ─────────────────
if [ -f "scripts/gen-skill-docs.ts" ]; then
  if grep -q 'Help gstack get better' "scripts/gen-skill-docs.ts"; then
    echo "FAIL: telemetry opt-in prompt still in gen-skill-docs.ts"
    FAIL=1
  fi
  if grep -q 'generateUpgradeCheck' "scripts/gen-skill-docs.ts" && \
     ! grep -q 'gstuck.*disabled' "scripts/gen-skill-docs.ts"; then
    echo "WARN: generateUpgradeCheck may not be properly neutralized"
  fi
fi

# ─── Skill paths rewritten for gstuck layout ─────────────────
# Generated SKILL.md preambles must not reference the old skills/gstack/ path
# Exclude test/ (test fixtures reference old paths), CHANGELOG, README
OLD_PATH_MATCHES=$(grep -rn 'skills/gstack/' --include='*.md' --include='*.ts' --include='*.tmpl' . 2>/dev/null \
  | grep -v node_modules | grep -v CHANGELOG | grep -v README \
  | grep -v 'test/' | grep -v 'skills/gstuck/output/gstack/' || true)
if [ -n "$OLD_PATH_MATCHES" ]; then
  echo "FAIL: old skills/gstack/ paths found (should be skills/gstuck/output/gstack/):"
  echo "$OLD_PATH_MATCHES" | head -10 | sed 's/^/  /'
  FAIL=1
fi

# ─── Dependency pinning checks ────────────────────────────────
if grep -q '"\^' package.json 2>/dev/null; then
  echo "FAIL: package.json still has ^ range dependencies"
  FAIL=1
fi

if grep -q '^bun\.lock$' .gitignore 2>/dev/null; then
  echo "FAIL: bun.lock is still gitignored"
  FAIL=1
fi

# ─── Summary ──────────────────────────────────────────────────
echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "PASS: All static verification checks passed."
else
  echo "FAIL: One or more verification checks failed. See above."
fi

exit $FAIL
