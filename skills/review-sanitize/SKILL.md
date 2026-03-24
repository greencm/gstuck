---
name: review-sanitize
version: 1.0.0
description: |
  AI security review for gstuck sanitize PRs. Reviews the diff between main
  and the sanitize branch for new external URLs, network calls, data collection,
  telemetry, or re-added gutted functions. Produces a structured PASS/FAIL report.
  Use when a sanitize PR is open and needs review before merging.
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# /review-sanitize — AI Security Review for Sanitize PRs

Review the diff from the current sanitize PR for security concerns that
the static `verify.sh` can't catch — new patterns introduced by upstream.

## Step 1: Identify what changed

```bash
git log --oneline main..HEAD | head -20
```

```bash
git diff --stat main..HEAD -- output/
```

Read the diff summary. Note how many files changed and in which areas.

## Step 2: Get the full diff of changed source files

```bash
git diff main..HEAD -- output/gstack/scripts/ output/gstack/bin/ output/gstack/**/*.tmpl
```

These are the highest-risk files — the generator, bin scripts, and templates.

## Step 3: Review generated SKILL.md preambles

Pick 3 representative generated SKILL.md files and check their preamble bash blocks:

```bash
head -60 output/gstack/qa/SKILL.md
head -60 output/gstack/ship/SKILL.md
head -60 output/gstack/SKILL.md
```

Verify the preamble does NOT contain:
- `_TEL=`, `_TEL_PROMPTED`, `_TEL_START`, `_SESSION_ID`
- `skill-usage.jsonl`
- `gstack-telemetry-log`
- `TELEMETRY:` or `TEL_PROMPTED:` echo lines
- `.pending-` marker lines

## Step 4: Scan for new external URLs

```bash
cd output/gstack
grep -rn 'https\?://' --include='*.md' --include='*.tmpl' --include='*.sh' --include='*.ts' . \
  | grep -v node_modules | grep -v '.git/' | grep -v CHANGELOG.md \
  | grep -v 'localhost' | grep -v 'example.com' | grep -v 'yourapp.com' \
  | grep -v 'app.example.com' | grep -v 'staging.app.com' | grep -v 'prod.app.com' \
  | grep -v 'greencm/gstuck'
```

Every URL in this output needs justification. Known-safe URLs:
- `https://github.com/greencm/gstuck` — our repo
- `https://claude.com/claude-code` — Claude Code link in PR templates
- `localhost` / `example.com` / `yourapp.com` — documentation examples

Anything else is a finding.

## Step 5: Scan for network calls

```bash
cd output/gstack
grep -rn 'curl \|curl$\|fetch(\|WebFetch\|WebSearch\|XMLHttpRequest\|supabase' \
  --include='*.md' --include='*.tmpl' --include='*.sh' --include='*.ts' . \
  | grep -v node_modules | grep -v '.git/' | grep -v 'test/' | grep -v CHANGELOG.md
```

WebSearch/WebFetch in SKILL.md templates are expected (skills use them for research).
`curl` in bin/ scripts or preamble bash blocks is a finding.

## Step 6: Scan for analytics/telemetry writes

```bash
cd output/gstack
grep -rn 'analytics\|\.jsonl\|telemetry\|\.pending-' \
  --include='*.md' --include='*.tmpl' --include='*.sh' --include='*.ts' . \
  | grep -v node_modules | grep -v '.git/' | grep -v test/ | grep -v CHANGELOG.md
```

Any `>> ~/.gstack/analytics/` write is a finding.
References to analytics in prose/comments are OK.

## Step 7: Scan for identifying information collection

```bash
cd output/gstack
grep -rn 'hostname\|whoami\|uname\|sha256\|installation_id\|device.id\|machine.id' \
  --include='*.md' --include='*.tmpl' --include='*.sh' --include='*.ts' . \
  | grep -v node_modules | grep -v '.git/' | grep -v test/
```

## Step 8: Check gutted functions are still gutted

```bash
grep -A2 'function generateUpgradeCheck\|function generateLakeIntro\|function generateTelemetryPrompt' \
  output/gstack/scripts/gen-skill-docs.ts
```

Each should contain `return '';` and nothing else.

## Step 9: Produce the report

Based on the findings from steps 1-8, produce this report:

```
GSTUCK SECURITY REVIEW — <upstream SHA from upstream.sha>
=======================================
Upstream version: <from output/gstack/VERSION>
Files changed: <count from step 1>
Files reviewed: <count>

External URLs: [list each non-safe URL with file:line, or NONE]
Network calls: [list each unexpected curl/fetch with file:line, or NONE]
Analytics writes: [list each JSONL/analytics write with file:line, or NONE]
Identifying info: [list each hostname/whoami/hash with file:line, or NONE]
Gutted functions: [STILL GUTTED or list any that were re-added]

VERDICT: PASS / FAIL
```

If PASS: Tell the user the PR is safe to merge.
If FAIL: List each finding with file:line and what needs to be added to `sanitize.sh`.
