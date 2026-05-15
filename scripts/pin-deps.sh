#!/usr/bin/env bash
# pin-deps.sh — Lock dependencies by SHA (integrity hash) with supply-chain quarantine.
#
# The real security guarantee is the lockfile: bun.lock records SHA-512 integrity
# hashes for every package tarball. Subsequent installs via `bun install --frozen-lockfile`
# (the bun equivalent of `npm ci`) will fail if any tarball doesn't match its hash.
#
# This script:
#   1. Pins package.json to exact versions (removes ^ ranges)
#   2. Generates bun.lock with integrity hashes
#   3. Verifies every dep was published at least N days ago (quarantine)
#   4. Un-ignores bun.lock so it's committed
#
# All subsequent builds MUST use `bun install --frozen-lockfile` to enforce the hashes.
#
# Usage:
#   bash scripts/pin-deps.sh                       # Default: 7-day quarantine
#   bash scripts/pin-deps.sh --quarantine-days 14  # 14-day quarantine
#   bash scripts/pin-deps.sh --quarantine-days 0   # Skip quarantine (emergency)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT="$ROOT_DIR/output/gstack"
QUARANTINE_DAYS=7

# Parse flags
while [ $# -gt 0 ]; do
  case "$1" in
    --quarantine-days) QUARANTINE_DAYS="$2"; shift 2 ;;
    --quarantine-days=*) QUARANTINE_DAYS="${1#--quarantine-days=}"; shift ;;
    *) shift ;;
  esac
done

if [ ! -d "$OUTPUT" ]; then
  echo "FATAL: output/gstack/ not found — run sanitize.sh first"
  exit 1
fi

cd "$OUTPUT"

echo "=== Pinning dependencies ==="
echo "Quarantine window: ${QUARANTINE_DAYS} days"

# ─── Step 1: Pin exact versions (remove ^ ranges) ─────────────
# This prevents semver drift if someone runs plain `bun install` instead
# of `bun install --frozen-lockfile`. Belt and suspenders.
echo "Pinning package.json to exact versions..."
node -e "
const fs = require('fs');
let pkg = fs.readFileSync('package.json', 'utf-8');
pkg = pkg.replace(/\"\^/g, '\"').replace(/\"~/g, '\"');
fs.writeFileSync('package.json', pkg);
"

# Verify
if grep -qE '"[\^~]' package.json; then
  echo "WARNING: Some dependencies still have range specifiers:"
  grep -E '"[\^~]' package.json
fi

# ─── Step 2: Un-ignore bun.lock ───────────────────────────────
echo "Un-ignoring bun.lock..."
node -e "
const fs = require('fs');
let gi = fs.readFileSync('.gitignore', 'utf-8');
gi = gi.split('\n').filter(l => l.trim() !== 'bun.lock').join('\n');
fs.writeFileSync('.gitignore', gi);
"

# ─── Step 3: Generate lockfile with integrity hashes ───────────
echo "Running bun install to generate lockfile with integrity hashes..."
bun install

if [ ! -f bun.lock ]; then
  echo "FAIL: bun.lock not generated"
  exit 1
fi

# Verify lockfile contains integrity hashes
if ! grep -q 'integrity' bun.lock 2>/dev/null && ! file bun.lock | grep -q 'data' 2>/dev/null; then
  echo "WARNING: bun.lock may not contain integrity hashes — verify manually"
fi

# ─── Step 4: Verify frozen-lockfile works ──────────────────────
echo "Verifying bun install --frozen-lockfile works..."
bun install --frozen-lockfile > /dev/null 2>&1
if [ $? -ne 0 ]; then
  echo "FAIL: bun install --frozen-lockfile failed — lockfile may be corrupt"
  exit 1
fi
echo "  Frozen lockfile install: OK"

# ─── Step 5: Supply-chain quarantine check ─────────────────────
# Verify that pinned package versions were published at least N days ago.
if [ "$QUARANTINE_DAYS" -gt 0 ]; then
  echo ""
  echo "Running supply-chain quarantine check (${QUARANTINE_DAYS}-day window)..."
  QUARANTINE_FAIL=0

  # Extract RESOLVED package versions from node_modules (populated by bun install).
  # Using node_modules instead of package.json specs avoids false UNKNOWN results
  # when a spec is a partial semver like "5" — npm registry time keys require
  # exact versions like "5.3.0". Falls back to the stripped spec if unreadable.
  DEPS=$(node -e "
    const fs = require('fs');
    const path = require('path');
    const pkg = require('./package.json');
    const all = { ...pkg.dependencies, ...(pkg.devDependencies || {}) };
    for (const [name, spec] of Object.entries(all)) {
      let version = spec.replace(/^[\^~]/, '');
      try {
        const installed = JSON.parse(fs.readFileSync(path.join('node_modules', name, 'package.json'), 'utf-8'));
        if (installed.version) version = installed.version;
      } catch {}
      console.log(name + '@' + version);
    }
  ")

  CUTOFF_EPOCH=$(( $(date +%s) - QUARANTINE_DAYS * 86400 ))

  for dep in $DEPS; do
    PKG_NAME="${dep%@*}"
    PKG_VERSION="${dep##*@}"

    # Fetch publish time from npm registry (full metadata includes time field)
    PUBLISH_TIME=$(curl -sf --max-time 15 \
      "https://registry.npmjs.org/${PKG_NAME}" 2>/dev/null \
      | node -e "
        let d = '';
        process.stdin.on('data', c => d += c);
        process.stdin.on('end', () => {
          try {
            const meta = JSON.parse(d);
            const time = meta.time && meta.time['${PKG_VERSION}'];
            if (time) {
              console.log(Math.floor(new Date(time).getTime() / 1000));
            } else {
              console.log('UNKNOWN');
            }
          } catch { console.log('UNKNOWN'); }
        });
      " 2>/dev/null || echo "UNKNOWN")

    if [ "$PUBLISH_TIME" = "UNKNOWN" ]; then
      echo "  WARNING: Could not verify publish time for ${dep} — manual review needed"
      QUARANTINE_FAIL=1
      continue
    fi

    AGE_DAYS=$(( ($(date +%s) - PUBLISH_TIME) / 86400 ))

    if [ "$PUBLISH_TIME" -gt "$CUTOFF_EPOCH" ] 2>/dev/null; then
      echo "  FAIL: ${dep} was published ${AGE_DAYS} days ago (quarantine requires ${QUARANTINE_DAYS}+)"
      QUARANTINE_FAIL=1
    else
      echo "  OK: ${dep} — published ${AGE_DAYS} days ago"
    fi
  done

  if [ "$QUARANTINE_FAIL" -ne 0 ]; then
    echo ""
    echo "QUARANTINE FAILED: One or more dependencies are too recent."
    echo "Options:"
    echo "  1. Wait until the package ages past the quarantine window"
    echo "  2. Pin to an older version that's past the window"
    echo "  3. Override with --quarantine-days 0 (emergency only, document the reason)"
    exit 1
  fi

  echo "Quarantine check passed."
fi

echo ""
echo "=== Dependencies locked ==="
echo "bun.lock generated with SHA-512 integrity hashes."
echo ""
echo "IMPORTANT: All subsequent builds MUST use:"
echo "  bun install --frozen-lockfile"
echo ""
echo "This is the bun equivalent of 'npm ci' — it installs exactly what's"
echo "in bun.lock and fails if any package tarball doesn't match its hash."
