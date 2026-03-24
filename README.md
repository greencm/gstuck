# gstuck

Pinned, telemetry-removed fork of **[gstack](https://github.com/garrytan/gstack)** by [Garry Tan](https://github.com/garrytan).

gstack is an excellent Claude Code skill pack — headless browser, QA workflows, code review, shipping tools, and more. **gstuck** removes telemetry, phone-home behavior, and marketing content, and pins all dependencies by SHA.

> **gstuck is not a replacement for gstack.** It's gstack with the network calls stripped out.
> All credit for the skills, architecture, and browser tooling belongs to the upstream project.
> If you don't need pinned deps or telemetry removal, **use [gstack](https://github.com/garrytan/gstack) directly** — it's better maintained and has more features.

## What's different

| Concern | gstack | gstuck |
|---------|--------|--------|
| Supabase telemetry | Opt-in, phones home | Removed entirely |
| GitHub update checks | Every invocation | Removed |
| Local analytics JSONL | Always writes repo name | Removed |
| Auto-upgrade | Pulls from public GitHub | Disabled |
| YC referral content | In /office-hours skill | Removed |
| npm dependencies | `^` semver ranges | Exact versions + SHA-512 lockfile |
| Supply-chain quarantine | None | 7-day delay on commits + npm packages |

Everything else is identical — same skills, same browse binary, same workflows.

## Install

### For Claude Code users

```bash
git clone https://github.com/greencm/gstuck.git ~/.claude/skills/gstuck
cd ~/.claude/skills/gstuck/output/gstack && ./setup
```

Then add to your project's `CLAUDE.md`:

```markdown
## Skills

gstuck (pinned gstack fork — telemetry removed) is installed at `~/.claude/skills/gstuck/output/gstack/`.
Available skills: /qa, /review, /ship, /browse, /investigate, /design-review, /office-hours,
/plan-ceo-review, /plan-eng-review, /plan-design-review, /cso, /retro, /codex, /careful,
/freeze, /guard, /benchmark, /canary, /land-and-deploy, /design-consultation, /document-release
```

### Vendored in a project repo

```bash
# Copy the sanitized output into your repo
cp -R output/gstack/ .claude/skills/gstack/
cd .claude/skills/gstack && ./setup
git add .claude/skills/gstack
git commit -m "Vendor gstuck (pinned gstack, telemetry removed)"
```

### Updating

gstuck has no auto-update mechanism (that's the point). Updates are managed by
the maintainer via the daily sanitization workflow.

**If you cloned directly:**
```bash
cd ~/.claude/skills/gstuck && git pull && cd output/gstack && ./setup
```

**If you vendored in-repo:** Copy the new `output/gstack/` over the old one and re-run `./setup`.

## How it works

gstuck is not a traditional fork. It's a **sanitization pipeline** — a set of scripts
that take a clean upstream gstack commit, apply deterministic transforms to remove
all network calls and telemetry, pin dependencies by SHA, and verify the result.

```
upstream gstack (pinned SHA, 7-day quarantine)
  → sanitize.sh (remove telemetry, update checks, marketing, session scanning)
    → pin-deps.sh (exact versions + SHA-512 lockfile + npm quarantine)
      → bun run build (regenerate SKILL.md from modified templates)
        → verify.sh (static grep gate for banned patterns)
          → AI security review (diff-based review for new concerns)
            → output/gstack/ (ready to use)
```

A **daily GitHub Action** runs this pipeline automatically and opens a PR when
upstream has new changes past the quarantine window. A human reviews and merges.

### Supply-chain quarantine

Two layers, both configurable:

1. **Upstream commit quarantine** — only sanitize commits that are at least 7 days old.
   If the gstack repo is compromised today, gstuck won't pull it in for a week.

2. **npm dependency quarantine** — only install package versions published at least 7 days
   ago. All packages are locked by SHA-512 integrity hash in `bun.lock`. Builds use
   `bun install --frozen-lockfile` (equivalent of `npm ci`).

## For maintainers

See [CLAUDE.md](CLAUDE.md) for the full workflow — sanitize, pin, build, verify,
and the AI security review protocol.

### Manual run

```bash
git clone https://github.com/garrytan/gstack.git ../gstack   # one-time mirror
bash scripts/sanitize.sh --local ../gstack                     # resolve safe SHA + sanitize
bash scripts/pin-deps.sh                                       # lock deps + quarantine
cd output/gstack && bun install --frozen-lockfile && bun run build
cd ../.. && bash scripts/verify.sh                             # static gate
```

Then run the AI security review per CLAUDE.md.

### Reviewing a sanitize PR

When the daily action opens a PR, review it with Claude Code:

```
# TODO: automate this as a GitHub Action with Claude
# For now, run manually in the PR branch:
```

Check the diff for new external URLs, network calls, or data collection patterns.
See CLAUDE.md "Verify: AI Security Review" for the structured protocol.

## License

gstuck's sanitization scripts are MIT licensed.
The upstream gstack code is [MIT licensed](https://github.com/garrytan/gstack/blob/main/LICENSE) by Garry Tan.

## Attribution

This project exists because [gstack](https://github.com/garrytan/gstack) is genuinely useful.
Thank you to Garry Tan and contributors for building it.
