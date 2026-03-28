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

// ─── Remove .agents/ directory (Agent SDK layout not used by gstuck) ──
const agentsDir = join(ROOT, '.agents');
if (existsSync(agentsDir)) {
  rmSync(agentsDir, { recursive: true, force: true });
  console.log('  Removed .agents/ directory');
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
  if (src.includes('## Telemetry (run last)')) {
    // Strip from "## Telemetry (run last)" to end of file or next ## heading
    src = src.replace(/## Telemetry \(run last\)[\s\S]*?(?=\n## (?!Telemetry)|$)/g, '');
    // Clean up trailing whitespace
    src = src.trimEnd() + '\n';
    writeFileSync(f, src);
    telFixed++;
  }
}
if (telFixed > 0) {
  console.log(`  Stripped telemetry epilogue from ${telFixed} SKILL.md file(s)`);
}

// ─── Strip any ~/.gstack/analytics/ write lines from all files ──────
// Catches all JSONL variants (skill-usage.jsonl, spec-review.jsonl, etc.)
let analyticsFixed = 0;
for (const f of findFiles(ROOT, ['.md', '.tmpl', '.ts'])) {
  let src = readFileSync(f, 'utf-8');
  if (src.includes('~/.gstack/analytics/')) {
    const before = src;
    // Remove entire lines that write to analytics
    src = src.replace(/^.*>> ~\/\.gstack\/analytics\/.*\n?/gm, '');
    // Remove bash code blocks that became empty after stripping
    src = src.replace(/```bash\s*```/g, '');
    if (src !== before) {
      writeFileSync(f, src);
      analyticsFixed++;
    }
  }
}
if (analyticsFixed > 0) {
  console.log(`  Stripped analytics write lines from ${analyticsFixed} file(s)`);
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

console.log('Post-build fixup complete.');
