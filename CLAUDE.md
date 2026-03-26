# gstuck

Pinned, telemetry-removed fork of [gstack](https://github.com/garrytan/gstack).
Removes telemetry, update checks, marketing content, and locks all dependencies by SHA.

Repo: https://github.com/greencm/gstuck

## Commit style

Do not add Co-Authored-By lines to commits.

## Quick Start: Build locally

```bash
git clone https://github.com/garrytan/gstack.git ../gstack    # one-time upstream mirror
bash scripts/sanitize.sh --local ../gstack                     # resolve safe SHA + sanitize
bash scripts/pin-deps.sh                                       # lock deps + npm quarantine
cd output/gstack && bun install --frozen-lockfile && bun run build
cd ../.. && bash scripts/verify.sh                             # static verification
```

## Daily Workflow

A **GitHub Action** (`.github/workflows/sanitize.yml`) runs daily at 06:00 UTC:

1. Clones upstream gstack
2. Resolves the latest commit that's past the 7-day quarantine
3. If the SHA changed: sanitize → pin deps → build → verify
4. Opens a PR with the sanitized output

**You review and merge the PR** using the `/review-sanitize` Claude workflow (below).

## Commands

```bash
# Sanitize (resolves quarantine-safe SHA automatically)
bash scripts/sanitize.sh --local ../gstack             # 7-day commit quarantine (default)
bash scripts/sanitize.sh --local ../gstack --quarantine-days 14  # custom window
bash scripts/sanitize.sh --local ../gstack --quarantine-days 0   # skip (emergency)

# Just check what SHA would be used
bash scripts/sanitize.sh --resolve-sha ../gstack       # prints SHA + age, no changes

# Pin dependencies
bash scripts/pin-deps.sh                               # 7-day npm quarantine (default)
bash scripts/pin-deps.sh --quarantine-days 14          # custom window
bash scripts/pin-deps.sh --quarantine-days 0           # skip (emergency)

# Verify + build
bash scripts/verify.sh                                 # static grep-based gate
cd output/gstack && bun install --frozen-lockfile && bun run build  # build
```

## Supply-Chain Quarantine (Two Layers)

Both the upstream gstack code and its npm dependencies must be old enough
before we'll use them.

### Layer 1: Upstream Commit Quarantine (`sanitize.sh`)

The entry point is always a commit that's at least N days old (default: 7).
If the upstream repo is compromised today, we won't pull it in for 7 days —
giving time for the community to detect, report, and revert.

- If `upstream.sha` is empty or missing: auto-resolves the quarantine-safe SHA
- If `upstream.sha` is pinned: verifies the pinned commit is old enough, fails if not
- `--resolve-sha ../gstack`: prints the safe SHA without making changes (dry run)

### Layer 2: npm Dependency Quarantine (`pin-deps.sh`)

Each npm package must have been published at least N days ago (default: 7).
`bun.lock` records **SHA-512 integrity hashes** for every package tarball.

### Build-time enforcement

**All builds MUST use `bun install --frozen-lockfile`** (the bun equivalent of
`npm ci`). This installs exactly what's in `bun.lock` and fails if any package
tarball doesn't match its SHA-512 hash.

## /review-sanitize — AI Security Review for Sanitize PRs

When the daily action opens a PR, run `/review-sanitize` to review it.

**TODO:** Automate this as a GitHub Action with Claude API so PRs get
auto-reviewed. For now, run manually.

### Two-phase workflow

**Phase 1 (REVIEW):** Fetches the PR diff via `git fetch` + `git diff` without
checking out the sanitize branch. Scans for telemetry, external URLs, network
calls, data collection, re-added gutted functions, and new telemetry files.
Produces a PASS/FAIL report.

**Phase 2a (PASS):** Approve and merge the PR.

**Phase 2b (FAIL):** Fix `sanitize.sh` / `transforms.mjs` on main (already there —
never left), commit, push, re-trigger the workflow, then loop back to Phase 1.

### Why we never check out the sanitize branch

The `sanitize/latest` branch is force-pushed by the workflow. If we check it out
locally and then push fixes to main + re-trigger, the local branch diverges from
remote and requires `git reset --hard` to recover. By using `git fetch` +
`git show origin/sanitize/latest:path` we avoid this entirely.

### What the review checks

- **External URLs** — any new `https://` not on the known-safe allowlist
- **Network calls** — `curl`, `fetch(`, Supabase, HTTP clients in executable code
- **Analytics/telemetry writes** — `~/.gstack/analytics/`, `skill-usage.jsonl`, `.pending-*`
- **Identifying information** — `hostname`, `whoami`, `uname`, SHA-256 of user info
- **Gutted functions** — `generateUpgradeCheck`, `generateLakeIntro`, `generateTelemetryPrompt`
- **New telemetry files** — any added files related to analytics/telemetry infrastructure

See `.claude/skills/review-sanitize/SKILL.md` for the full protocol and allowlists.

## Installing gstuck (for users)

**Global install:**
```bash
git clone https://github.com/greencm/gstuck.git ~/.claude/skills/gstuck
cd ~/.claude/skills/gstuck/output/gstack && ./setup
```

**Vendored in a project repo:**
```bash
cp -R output/gstack/ .claude/skills/gstack/
cd .claude/skills/gstack && ./setup
git add .claude/skills/gstack && git commit -m "Vendor gstuck"
```

**User upgrades:**
```bash
cd ~/.claude/skills/gstuck && git pull && cd output/gstack && ./setup
```

No auto-update prompts will ever appear. Upgrades flow through this repo.

## What Was Removed

| Category | What | Why |
|----------|------|-----|
| Supabase telemetry | `supabase/` dir, sync scripts | Phones home to hardcoded Supabase instance |
| Update checks | `bin/gstack-update-check` | Fetches from GitHub + pings Supabase every invocation |
| Local analytics | JSONL writes in preambles/hooks | Logs repo names and skill usage unconditionally |
| Telemetry prompt | Opt-in dialog in preamble | Asks users to enable telemetry |
| YC referral | office-hours pitch + tracked URL | Marketing content with referral tracking |
| Lake intro | Browser open to garryslist.org | Opens external URL on first use |
| Auto-upgrade | git clone/reset from public GitHub | Pulls arbitrary code from upstream |
| Session scanner | Cross-tool discovery script | Reads ~/.claude/, ~/.codex/, ~/.gemini/ |
| Unpinned deps | `^` ranges in package.json | Locked by SHA-512 integrity hash |
