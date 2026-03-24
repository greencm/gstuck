#!/usr/bin/env node
/**
 * transforms.mjs — All file transforms for gstuck sanitization.
 * Called by sanitize.sh after cloning upstream. Runs in output/gstack/.
 *
 * This replaces ~35 sed calls that had cross-platform issues (macOS vs GNU).
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = process.cwd();

// ─── Helpers ──────────────────────────────────────────────────

function readFile(path) {
  return readFileSync(path, 'utf-8');
}

function writeFile(path, content) {
  writeFileSync(path, content);
}

/** Find files matching extensions, excluding node_modules and .git */
function findFiles(dir, extensions, excludeDirs = ['node_modules', '.git', 'test']) {
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

/** Remove lines matching a pattern from a file */
function removeLines(filePath, patterns) {
  if (!existsSync(filePath)) return;
  let content = readFile(filePath);
  for (const pattern of patterns) {
    const regex = typeof pattern === 'string' ? new RegExp(`.*${escapeRegExp(pattern)}.*\\n?`, 'g') : pattern;
    content = content.replace(regex, '');
  }
  writeFile(filePath, content);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Step 4a: Clean gen-skill-docs.ts telemetry lines ─────────

const GEN_SCRIPT = 'scripts/gen-skill-docs.ts';
if (existsSync(GEN_SCRIPT)) {
  let src = readFile(GEN_SCRIPT);

  // Remove telemetry-related lines from the preamble template literal
  const telemetryPatterns = [
    /_TEL=.*gstack-config get telemetry.*\n/g,
    /_TEL_PROMPTED=.*telemetry-prompted.*\n/g,
    /_TEL_START=.*date.*\n/g,
    /_SESSION_ID=.*date.*\n/g,
    /.*echo "TELEMETRY:.*\n/g,
    /.*echo "TEL_PROMPTED:.*\n/g,
    /.*skill-usage\.jsonl.*\n/g,
    /.*mkdir -p ~\/.gstack\/analytics.*\n/g,
    /.*\.pending-.*\n/g,
  ];
  for (const pat of telemetryPatterns) {
    src = src.replace(pat, '');
  }

  // Replace generateUpgradeCheck body
  src = src.replace(
    /function generateUpgradeCheck\(ctx: TemplateContext\): string \{[\s\S]*?\n\}/,
    "function generateUpgradeCheck(ctx: TemplateContext): string {\n  return ''; // [gstuck] Update checks disabled\n}"
  );

  // Replace generateLakeIntro body
  src = src.replace(
    /function generateLakeIntro\(\): string \{[\s\S]*?\n\}/,
    "function generateLakeIntro(): string {\n  return ''; // [gstuck] Lake intro disabled\n}"
  );

  // Replace generateTelemetryPrompt body
  src = src.replace(
    /function generateTelemetryPrompt\(ctx: TemplateContext\): string \{[\s\S]*?\n\}/,
    "function generateTelemetryPrompt(ctx: TemplateContext): string {\n  return ''; // [gstuck] Telemetry prompt disabled\n}"
  );

  // Remove telemetry epilogue section
  src = src.replace(
    /## Telemetry \(run last\)[\s\S]*?(?=## Plan Status Footer)/,
    ''
  );

  writeFile(GEN_SCRIPT, src);
  console.log('  gen-skill-docs.ts: patched');
}

// ─── Step 5: Remove inline analytics from .tmpl and SKILL.md ──

const analyticsPatterns = [
  'skill-usage.jsonl',
  'spec-review.jsonl',
  'eureka.jsonl',
  'mkdir -p ~/.gstack/analytics',
];

for (const f of findFiles(ROOT, ['.tmpl', '.md'], ['node_modules', '.git'])) {
  removeLines(f, analyticsPatterns);
}
console.log('  Removed inline analytics from templates + SKILL.md files');

// ─── Step 6: Remove analytics from hook scripts ──────────────

for (const hook of ['careful/bin/check-careful.sh', 'freeze/bin/check-freeze.sh']) {
  if (existsSync(hook)) {
    removeLines(hook, analyticsPatterns);
    console.log(`  Cleaned hook: ${hook}`);
  }
}

// ─── Step 7: Point upgrade template at gstuck ─────────────────

const UPGRADE_TMPL = 'gstack-upgrade/SKILL.md.tmpl';
if (existsSync(UPGRADE_TMPL)) {
  let src = readFile(UPGRADE_TMPL);
  src = src.replaceAll('https://github.com/garrytan/gstack.git', 'https://github.com/greencm/gstuck.git');
  writeFile(UPGRADE_TMPL, src);
  console.log('  Pointed upgrade template at gstuck');
}

// ─── Step 8: Remove YC referral from office-hours ─────────────

const OH_TMPL = 'office-hours/SKILL.md.tmpl';
if (existsSync(OH_TMPL)) {
  let src = readFile(OH_TMPL);
  src = src.replace(/A personal note from me, Garry Tan[\s\S]*?(?=### Next-skill recommendations)/,
    '### Next-skill recommendations\n\n');
  src = src.replace(/.*ycombinator\.com.*/g, '');
  writeFile(OH_TMPL, src);
  console.log('  Removed YC referral from office-hours');
}

// ─── Step 10: Remove garryslist.org URL ───────────────────────

for (const f of findFiles(ROOT, ['.ts', '.tmpl', '.md'], ['node_modules', '.git'])) {
  let src = readFile(f);
  if (src.includes('garryslist.org')) {
    src = src.replaceAll('https://garryslist.org/posts/boil-the-ocean', '#');
    writeFile(f, src);
  }
}
console.log('  Removed garryslist.org references');

// ─── Step 11: Remove ycombinator.com/apply from all files ─────

for (const f of findFiles(ROOT, ['.md', '.ts'], ['node_modules', '.git'])) {
  removeLines(f, [/.*ycombinator\.com\/apply.*/g]);
}
console.log('  Removed ycombinator.com/apply references');

// ─── Step 12: Replace github.com/garrytan/gstack ─────────────

for (const f of findFiles(ROOT, ['.tmpl', '.md'], ['node_modules', '.git'])) {
  let src = readFile(f);
  if (src.includes('github.com/garrytan/gstack')) {
    src = src.replaceAll('github.com/garrytan/gstack', 'github.com/greencm/gstuck');
    writeFile(f, src);
  }
}
console.log('  Replaced github.com/garrytan/gstack references');

// ─── Step 13: Clean telemetry from pre-generated SKILL.md ─────

const telemetryLinePatterns = [
  /_TEL=.*gstack-config get telemetry.*\n?/g,
  /_TEL_PROMPTED=.*telemetry-prompted.*\n?/g,
  /_TEL_START=.*date.*\n?/g,
  /_SESSION_ID=.*date.*\n?/g,
  /.*echo "TELEMETRY:.*\n?/g,
  /.*echo "TEL_PROMPTED:.*\n?/g,
  /.*\.pending-.*\n?/g,
];

for (const f of findFiles(ROOT, ['SKILL.md'], ['node_modules', '.git'])) {
  let src = readFile(f);
  let changed = false;
  for (const pat of telemetryLinePatterns) {
    const newSrc = src.replace(pat, '');
    if (newSrc !== src) { src = newSrc; changed = true; }
  }
  if (changed) writeFile(f, src);
}
console.log('  Cleaned telemetry from pre-generated SKILL.md preambles');

// ─── Step 15: Rewrite skill paths for gstuck layout ──────────

for (const f of findFiles(ROOT, ['.md', '.tmpl', '.ts'], ['node_modules', '.git', 'test'])) {
  let src = readFile(f);
  if (src.includes('skills/gstack/')) {
    src = src.replaceAll('skills/gstack/', 'skills/gstuck/output/gstack/');
    writeFile(f, src);
  }
}
console.log('  Rewrote skill paths for gstuck layout');

console.log('Transforms complete.');
