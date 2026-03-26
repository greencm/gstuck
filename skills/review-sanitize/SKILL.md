---
name: review-sanitize
version: 2.0.0
description: |
  AI security review for gstuck sanitize PRs. Two-phase workflow:
  Phase 1 (REVIEW): Fetch PR diff from GitHub, scan for telemetry, external URLs,
  network calls, data collection. Never leaves main branch. Produces PASS/FAIL report.
  Phase 2a (PASS): Approve and merge the PR.
  Phase 2b (FAIL): Fix sanitize.sh/transforms.mjs on main, commit, push, re-trigger
  the workflow, and tell the user to re-run /review-sanitize.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
---

# /review-sanitize — AI Security Review for Sanitize PRs

Review the open sanitize PR for security concerns the static `verify.sh` can't catch.

**Key principle:** Never check out the sanitize branch. The review is read-only.
Fetch PR files via git without switching branches. This avoids diverged-branch
problems when the workflow force-pushes after a sanitize.sh fix.

---

## Phase 1: REVIEW

### Step 0: Find the PR

```bash
cd /Users/cmg/src/gstack_review/gstuck
gh pr list --state open --head sanitize/latest --json number,title,url --jq '.[] | "\(.number) \(.title) \(.url)"'
```

If no open PR, tell the user there's nothing to review and stop.

If a PR exists, fetch the branch ref without checking it out:

```bash
git fetch origin sanitize/latest
```

All subsequent commands use `origin/sanitize/latest` (or `FETCH_HEAD`) — never switch branches.

### Step 1: Identify what changed

```bash
git log --oneline main..origin/sanitize/latest | head -20
git diff --stat main..origin/sanitize/latest -- output/
```

Read the upstream SHA and version from the PR branch:

```bash
git show origin/sanitize/latest:upstream.sha
git show origin/sanitize/latest:output/gstack/VERSION
```

### Step 2: Get the full diff of high-risk files

```bash
git diff main..origin/sanitize/latest -- output/gstack/scripts/ output/gstack/bin/ 'output/gstack/**/*.tmpl'
```

These are the highest-risk files — the generator, bin scripts, and templates.

### Step 3: Review generated SKILL.md preambles

Check 3 representative preambles:

```bash
git show origin/sanitize/latest:output/gstack/qa/SKILL.md | head -60
git show origin/sanitize/latest:output/gstack/ship/SKILL.md | head -60
git show origin/sanitize/latest:output/gstack/SKILL.md | head -60
```

Verify the preamble does NOT contain:
- `_TEL=`, `_TEL_PROMPTED`, `_TEL_START`, `_SESSION_ID`
- `skill-usage.jsonl`
- `gstack-telemetry-log`
- `TELEMETRY:` or `TEL_PROMPTED:` echo lines
- `.pending-` marker lines

### Step 4: Scan for new external URLs

Scan the diff for newly added URLs (lines starting with `+`):

```bash
git diff main..origin/sanitize/latest -- output/ \
  | grep '^+' | grep -v '^+++' \
  | grep -oE 'https?://[^ '\''")<>\]]+' \
  | sort -u
```

Filter against the known-safe allowlist below. Any URL NOT on this list is a finding.

**Known-safe URL allowlist:**
- `localhost`, `127.0.0.1` — local references
- `example.com`, `yourapp.com`, `myapp.com`, `staging.myapp.com` — documentation examples
- `app.com` — documentation examples in browse templates
- `github.com/greencm/gstuck` — our repo
- `github.com/settings/profile` — example URL in browse docs
- `github.com/openai/codex` — codex CLI install reference
- `github.com/acme/*` — test fixture fake repos
- `claude.com/claude-code` — Claude Code link in PR templates
- `docs.anthropic.com` — Anthropic docs
- `bun.sh` — Bun runtime (install script + docs link)
- `git-scm.com` — Git website
- `playwright.dev` — Playwright docs reference
- `x.com/garrytan` — Author's Twitter (README bio)
- `ycombinator.com`, `www.ycombinator.com` — YC website (README bio)
- `conductor.build` — Conductor product reference
- `greptile.com` — Greptile product reference

Anything not on this list needs justification. If it's a legitimate documentation
reference, add it to the allowlist in this skill file as part of the PASS flow.

### Step 5: Scan for network calls

Scan the full output tree on the PR branch for executable network calls:

```bash
git diff main..origin/sanitize/latest -- output/ \
  | grep '^+' | grep -v '^+++' \
  | grep -iE 'curl |curl$|fetch\(|XMLHttpRequest|supabase'
```

**Expected (not findings):**
- `WebSearch` / `WebFetch` in SKILL.md templates — skills use these for research
- `fetch()` in `browse/src/` — local Chromium IPC over 127.0.0.1
- `curl -fsSL https://bun.sh/install` — bun installation instruction
- `await fetch('/api/...')` in documentation examples

**Findings:** `curl` in bin/ scripts or preamble bash blocks. Any `supabase` reference.

### Step 6: Scan for analytics/telemetry

```bash
git diff main..origin/sanitize/latest -- output/ \
  | grep '^+' | grep -v '^+++' \
  | grep -iE 'analytics/|skill-usage\.jsonl|telemetry|\.pending-'
```

**Findings:** Any `>> ~/.gstack/analytics/` write path. Any `skill-usage.jsonl` reference
in non-test, non-TODOS files.

**Expected (not findings):**
- `reviews.jsonl` — local review state tracking in `~/.gstack/projects/`
- Prose mentions of "analytics" or "telemetry" in TODOS.md, CHANGELOG.md, docs
- `analytics` as a word in non-write contexts (e.g., "developer analytics dashboard")

### Step 7: Scan for identifying information collection

```bash
git diff main..origin/sanitize/latest -- output/ \
  | grep '^+' | grep -v '^+++' \
  | grep -iE 'hostname|whoami|uname|sha256|installation_id|device\.id|machine\.id'
```

**Expected (not findings):**
- `whoami` for local file naming (`USER=$(whoami)` in plan-eng-review, office-hours)
- `hostname` in browse/src/ for URL parsing and SSRF protection
- `hostname` / `uname` in documentation or prose

**Findings:** Any that hash, collect, or transmit identifying info.

### Step 8: Check gutted functions are still gutted

```bash
git show origin/sanitize/latest:output/gstack/scripts/gen-skill-docs.ts \
  | grep -A2 'function generateUpgradeCheck\|function generateLakeIntro\|function generateTelemetryPrompt'
```

Each should either not exist (fully removed by sanitize) or contain `return '';`.
If any has a real implementation body, that's a finding.

### Step 9: Check for new files that should be stripped

Look for new files in the diff that are telemetry/analytics infrastructure:

```bash
git diff --name-status main..origin/sanitize/latest -- output/ | grep '^A' | grep -iE 'analytics|telemetry|supabase'
```

Any new file related to telemetry infrastructure is a finding — it needs to be
added to `sanitize.sh` or `transforms.mjs` for deletion.

### Step 10: Produce the report

```
GSTUCK SECURITY REVIEW — <upstream SHA>
=======================================
Upstream version: <VERSION>
Files changed: <count>
Files reviewed: <count>

External URLs: [list each non-allowlisted URL, or NONE]
Network calls: [list each unexpected call with context, or NONE]
Analytics writes: [list each finding, or NONE]
Identifying info: [list each finding, or NONE]
Gutted functions: [STILL GUTTED / FULLY REMOVED, or list re-added]
New telemetry files: [list, or NONE]

VERDICT: PASS / FAIL
```

---

## Phase 2a: PASS

If the review found no issues:

1. Approve the PR:
   ```bash
   gh pr review <NUMBER> --approve --body "<one-line summary of review>"
   ```

2. Tell the user the PR is safe to merge.

If the user says to merge:
   ```bash
   gh pr merge <NUMBER> --merge
   ```

If the allowlist needed updating (new safe URLs found), mention it — the skill
file can be updated in a separate commit.

---

## Phase 2b: FAIL

If the review found issues:

1. Comment on the PR with findings:
   ```bash
   gh pr comment <NUMBER> --body "<findings summary>"
   ```

2. Fix the sanitize scripts. You are already on `main` (never left). Edit:
   - `scripts/sanitize.sh` — for file deletions (`rm -f`)
   - `scripts/transforms.mjs` — for content transforms (line removal, regex replacement)

3. Commit and push the fix to main:
   ```bash
   git add scripts/sanitize.sh scripts/transforms.mjs
   git commit -m "<descriptive message about what was stripped>"
   git push
   ```

4. Re-trigger the workflow:
   ```bash
   gh workflow run sanitize.yml
   ```

5. Wait for it to complete:
   ```bash
   gh run list --workflow=sanitize.yml --limit 1 --json databaseId,status --jq '.[0]'
   # Then watch:
   gh run watch <ID> --exit-status
   ```

6. Once the workflow succeeds, loop back to Phase 1 (re-fetch, re-review).
   The `git fetch origin sanitize/latest` will pick up the new force-pushed branch
   cleanly because we never checked it out locally.
