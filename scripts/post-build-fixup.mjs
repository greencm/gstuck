#!/usr/bin/env node
/**
 * post-build-fixup.mjs — Catch-all path rewrite that runs AFTER `bun run build`.
 *
 * The build step regenerates SKILL.md files from templates via gen-skill-docs.ts.
 * Even though transforms.mjs patches gen-skill-docs.ts pre-build, new upstream
 * code paths can reintroduce old `skills/gstack/` paths. This script is the
 * safety net — it rewrites any surviving old paths in the final output.
 *
 * Also removes the `.agents/` directory (Agent SDK layout not used by gstuck).
 *
 * Called from the workflow between `bun run build` and `verify.sh`.
 * Runs in output/gstack/.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();

function findFiles(dir, extensions, excludeDirs = ['node_modules', '.git']) {
  const results = [];
  function walk(d) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        if (!excludeDirs.includes(entry.name)) walk(full);
      } else if (extensions.some(ext => entry.name.endsWith(ext))) {
        results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}

let fixed = 0;

// ─── Remove host-specific directories (not used by gstuck) ──
for (const dir of ['.agents', '.factory']) {
  const dirPath = join(ROOT, dir);
  if (existsSync(dirPath)) {
    rmSync(dirPath, { recursive: true, force: true });
    console.log(`  Removed ${dir}/ directory`);
  }
}

// ─── Rewrite any surviving skills/gstack/ paths ──────────────────────
for (const f of findFiles(ROOT, ['.md', '.tmpl', '.ts', '.sh'])) {
  let src = readFileSync(f, 'utf-8');
  if (src.includes('skills/gstack/') && !src.includes('skills/gstuck/output/gstack/')) {
    // File has old paths but no new paths — simple replace
    src = src.replaceAll('skills/gstack/', 'skills/gstuck/output/gstack/');
    writeFileSync(f, src);
    fixed++;
  } else if (src.includes('skills/gstack/')) {
    // File has both old and new paths — only replace instances not already rewritten
    // Match skills/gstack/ that is NOT preceded by "output/"
    const re = /(?<!output\/)gstack\//g;
    const newSrc = src.replace(/skills\/gstack\//g, (match, offset) => {
      // Check if this is already inside skills/gstuck/output/gstack/
      const before = src.substring(Math.max(0, offset - 20), offset);
      if (before.includes('gstuck/output/')) return match;
      return 'skills/gstuck/output/gstack/';
    });
    if (newSrc !== src) {
      writeFileSync(f, newSrc);
      fixed++;
    }
  }
}

if (fixed > 0) {
  console.log(`  Fixed skills/gstack/ paths in ${fixed} file(s)`);
} else {
  console.log('  No surviving skills/gstack/ paths found');
}

// ─── Strip telemetry epilogue from generated SKILL.md files ─────────
// The build may regenerate "## Telemetry (run last)" sections even after
// transforms.mjs patches gen-skill-docs.ts. Strip them from final output.
let telFixed = 0;
for (const f of findFiles(ROOT, ['.md'])) {
  let src = readFileSync(f, 'utf-8');
  let changed = false;
  if (src.includes('## Telemetry (run last)')) {
    // Strip from "## Telemetry (run last)" to end of file or next ## heading
    src = src.replace(/## Telemetry \(run last\)[\s\S]*?(?=\n## (?!Telemetry)|$)/g, '');
    changed = true;
  }
  // Also strip bullet-list references like "- Telemetry (run last)"
  if (src.includes('Telemetry (run last)')) {
    src = src.replace(/^.*Telemetry \(run last\).*\n?/gm, '');
    changed = true;
  }
  if (changed) {
    writeFileSync(f, src.trimEnd() + '\n');
    telFixed++;
  }
}
if (telFixed > 0) {
  console.log(`  Stripped telemetry epilogue from ${telFixed} SKILL.md file(s)`);
}

// ─── Strip all telemetry patterns from generated SKILL.md files ─────
// The build regenerates SKILL.md from templates. Even with gen-skill-docs.ts
// patched, new code paths can reintroduce telemetry. Strip everything broadly.
let telPatFixed = 0;
for (const f of findFiles(ROOT, ['.md', '.tmpl'])) {
  let src = readFileSync(f, 'utf-8');
  const before = src;

  // Strip lines referencing ~/.gstack/analytics/ (mkdir, find, writes, prose)
  src = src.replace(/^.*~\/\.gstack\/analytics.*\n?/gm, '');
  // Strip telemetry variable lines
  src = src.replace(/^.*_TEL=.*gstack-config get telemetry.*\n?/gm, '');
  src = src.replace(/^.*_TEL_PROMPTED=.*telemetry-prompted.*\n?/gm, '');
  src = src.replace(/^.*_TEL_START=.*\n?/gm, '');
  src = src.replace(/^.*_SESSION_ID=.*\n?/gm, '');
  // Strip telemetry echo lines
  src = src.replace(/^.*echo "TELEMETRY:.*\n?/gm, '');
  src = src.replace(/^.*echo "TEL_PROMPTED:.*\n?/gm, '');
  // Strip .pending-* telemetry finalization lines
  src = src.replace(/^.*\.pending-.*\n?/gm, '');
  // Strip gstack-telemetry-log calls
  src = src.replace(/^.*gstack-telemetry-log.*\n?/gm, '');
  // Strip telemetry opt-in prompt and config set telemetry lines
  src = src.replace(/^.*gstack-config set telemetry.*\n?/gm, '');
  src = src.replace(/^.*\.telemetry-prompted.*\n?/gm, '');
  // Strip skill-usage.jsonl references
  src = src.replace(/^.*skill-usage\.jsonl.*\n?/gm, '');
  // Clean up empty bash code blocks left behind
  src = src.replace(/```bash\s*```/g, '');

  if (src !== before) {
    writeFileSync(f, src);
    telPatFixed++;
  }
}
if (telPatFixed > 0) {
  console.log(`  Stripped telemetry patterns from ${telPatFixed} file(s)`);
}

// ─── Strip analytics writes from bin/ scripts ────────────────────────
// Bin scripts (no extension) are not covered by the .md/.tmpl sweep above.
// gstack-codex-probe v1.42+ introduces _gstack_codex_log_event() which
// writes to ~/.gstack/analytics/skill-usage.jsonl — strip the write path.
//
// gstack-skill-start/gstack-skill-end (v1.69+) also spawn gstack-telemetry-log
// directly, guarded by `[ -x "$_BIN/gstack-telemetry-log" ]`. The binary itself
// is already neutralized to a no-op by sanitize.sh before this runs, but the
// call sites are stripped too (defense in depth). Line-based instead of a
// single regex because the call can span multiple backslash-continued lines,
// and naively deleting just the matching line would leave orphaned argument
// fragments or an unmatched `fi` behind.
function stripTelemetryLogCalls(src) {
  const lines = src.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\bgstack-telemetry-log\b/.test(line)) {
      const ifIndent = line.match(/^([ \t]*)if\b/);
      if (ifIndent) {
        // Guarding if-block: drop through the matching `fi` at the same indent.
        const closer = `${ifIndent[1]}fi`;
        i++;
        while (i < lines.length && lines[i] !== closer) i++;
      } else {
        // Bare call: drop this line and any backslash-continuation lines.
        while (/\\$/.test(lines[i]) && i + 1 < lines.length) i++;
      }
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

const binDir = join(ROOT, 'bin');
if (existsSync(binDir)) {
  let binFixed = 0;
  for (const entry of readdirSync(binDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const f = join(binDir, entry.name);
    let src = readFileSync(f, 'utf-8');
    const before = src;
    src = src.replace(/^.*(?:~\/|(?:\$HOME\/)?)\.gstack\/analytics.*\n?/gm, '');
    src = src.replace(/^.*skill-usage\.jsonl.*\n?/gm, '');
    src = stripTelemetryLogCalls(src);
    // The two line-strips above can leave a guard if-block with nothing left
    // in its body (e.g. `if [ "$_TEL" != "off" ]; then\nfi`) — `then` directly
    // followed by `fi` is a bash syntax error, not a harmless no-op. Drop the
    // now-empty block entirely.
    src = src.replace(/^([ \t]*)if\b[^\n]*; then\n\1fi\n?/gm, '');
    if (src !== before) {
      writeFileSync(f, src);
      binFixed++;
    }
  }
  if (binFixed > 0) {
    console.log(`  Stripped analytics writes from ${binFixed} bin script(s)`);
  }
}

// ─── Strip ycombinator.com/apply from generated output ──────────────
// Belt-and-suspenders: transforms.mjs sanitizes .tmpl pre-build, but if
// the build ever regenerates content we also catch it here in the output.
let ycFixed = 0;
for (const f of findFiles(ROOT, ['.md', '.tmpl'])) {
  let src = readFileSync(f, 'utf-8');
  const before = src;
  src = src.replace(/^.*ycombinator\.com\/apply.*\n?/gm, '');
  if (src !== before) {
    writeFileSync(f, src);
    ycFixed++;
  }
}
if (ycFixed > 0) {
  console.log(`  Stripped ycombinator.com/apply from ${ycFixed} file(s)`);
}

// ─── Strip telemetry/Supabase content from docs ─────────────────────
for (const f of findFiles(ROOT, ['.md'])) {
  let src = readFileSync(f, 'utf-8');
  if (src.includes('## Privacy & Telemetry')) {
    src = src.replace(/## Privacy & Telemetry[\s\S]*?(?=\n## |$)/g, '');
    src = src.trimEnd() + '\n';
    writeFileSync(f, src);
    console.log(`  Stripped Privacy & Telemetry section from ${f}`);
  }
}

// ─── Null reportAttemptTelemetry in browse/src/security.ts ─────────
// v1.45+ added a security module that fires gstack-telemetry-log with
// attack_attempt events. The binary is neutralized (exit 0) but the live
// call still finds and spawns it — which would hit a real binary if the
// user has upstream gstack installed alongside gstuck.
// Replace the function body with a no-op using brace-depth counting.
const securityTs = join(ROOT, 'browse', 'src', 'security.ts');
if (existsSync(securityTs)) {
  let src = readFileSync(securityTs, 'utf-8');
  const MARKER = '// [gstuck] Telemetry disabled.';
  if (src.includes('function reportAttemptTelemetry(') && !src.includes(MARKER)) {
    const funcStart = src.indexOf('function reportAttemptTelemetry(');
    const openBrace = src.indexOf('{', funcStart);
    let depth = 1;
    let i = openBrace + 1;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    // i is now one past the closing brace
    const nulled = src.slice(0, openBrace + 1) +
      `\n  ${MARKER}\n` +
      src.slice(i - 1);
    writeFileSync(securityTs, nulled);
    console.log('  Nulled reportAttemptTelemetry() in browse/src/security.ts');
  }
}

console.log('Post-build fixup complete.');
