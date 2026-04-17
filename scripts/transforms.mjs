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

/** Strip telemetry from a preamble source file (resolvers/preamble.ts or gen-skill-docs.ts).
 *  Guts functions and removes telemetry lines so the build generates clean output. */
function gutPreambleSource(filePath) {
  if (!existsSync(filePath)) return;
  let src = readFile(filePath);

  // Gut generateUpgradeCheck
  src = src.replace(
    /function generateUpgradeCheck\(ctx: TemplateContext\): string \{[\s\S]*?\n\}/,
    "function generateUpgradeCheck(ctx: TemplateContext): string {\n  return ''; // [gstuck] Update checks disabled\n}"
  );

  // Gut generateLakeIntro
  src = src.replace(
    /function generateLakeIntro\(\): string \{[\s\S]*?\n\}/,
    "function generateLakeIntro(): string {\n  return ''; // [gstuck] Lake intro disabled\n}"
  );

  // Gut generateTelemetryPrompt
  src = src.replace(
    /function generateTelemetryPrompt\(ctx: TemplateContext\): string \{[\s\S]*?\n\}/,
    "function generateTelemetryPrompt(ctx: TemplateContext): string {\n  return ''; // [gstuck] Telemetry prompt disabled\n}"
  );

  // Strip "## Telemetry (run last)" epilogue section from template literals
  src = src.replace(
    /## Telemetry \(run last\)[\s\S]*?(?=## Plan Mode Safe Operations|## Plan Status Footer|`;\s*\n\})/g,
    ''
  );

  // Strip telemetry/analytics/timeline lines from preamble bash template
  const telemetryLinePatterns = [
    /^.*_TEL=.*gstack-config get telemetry.*\n?/gm,
    /^.*_TEL_PROMPTED=.*telemetry-prompted.*\n?/gm,
    /^.*_TEL_START=.*\n?/gm,
    /^.*_SESSION_ID=.*\n?/gm,
    /^.*echo "TELEMETRY:.*\n?/gm,
    /^.*echo "TEL_PROMPTED:.*\n?/gm,
    /^.*mkdir -p ~\/\.gstack\/analytics.*\n?/gm,
    /^.*skill-usage\.jsonl.*\n?/gm,
    /^.*\.pending-.*\n?/gm,
    /^.*gstack-telemetry-log.*\n?/gm,
    /^.*gstack-timeline-log.*\n?/gm,
    /^.*gstack-timeline-read.*\n?/gm,
    /^.*>> ~\/\.gstack\/analytics\/.*\n?/gm,
    /^.*\.gstack\/analytics.*\n?/gm,
    // Session tracking
    /^.*mkdir -p ~\/\.gstack\/sessions.*\n?/gm,
    /^.*touch ~\/\.gstack\/sessions.*\n?/gm,
    /^.*_SESSIONS=.*\.gstack\/sessions.*\n?/gm,
    /^.*find ~\/\.gstack\/sessions.*\n?/gm,
    // Update check
    /^.*gstack-update-check.*\n?/gm,
    /^.*\[ -n "\$_UPD" \].*\n?/gm,
    // gstack-telemetry-log in escaped form (template literals)
    /.*gstack-telemetry-log.*\\n/g,
    /.*>> ~\/\.gstack\/analytics\/.*\\n/g,
    // "# Session timeline" comment lines
    /^.*# Session timeline.*\n?/gm,
    // "# zsh-compatible" comment before .pending loop
    /^.*# zsh-compatible.*\n?/gm,
    // Telemetry gating blocks
    /^.*if \[ "\$_TEL" != "off" \].*\n?/gm,
    /^.*fi\n?/gm,  // this is too broad — skip
  ];

  // Apply all except the overly-broad 'fi' pattern
  for (const pat of telemetryLinePatterns.slice(0, -1)) {
    src = src.replace(pat, '');
  }

  // Remove entire .pending-* processing loop (the for...done block)
  // Line-by-line stripping leaves orphaned fi/done/break fragments
  src = src.replace(/# zsh-compatible[^\n]*\nfor _PF in[\s\S]*?done/g, '');
  src = src.replace(/for _PF in \$\(find ~\/\.gstack\/analytics[\s\S]*?done/g, '');

  // Handle dangling if/fi blocks left after stripping telemetry lines inside them
  src = src.replace(/if \[ "\$_TEL" != "off" \]; then\s*fi/g, '');
  src = src.replace(/if \[ "\$_TEL" != "off" \] && \[.*?\]; then\s*fi/g, '');
  // Clean up orphaned fragments: lone fi, break, done on their own lines
  src = src.replace(/^\s*fi\s*\n\s*fi\s*\n/gm, '');
  src = src.replace(/^\s*break\s*\n\s*done\s*\n/gm, '');

  // Strip lake intro tracking lines
  src = src.replace(/^.*_LAKE_SEEN=.*completeness-intro-seen.*\n?/gm, '');
  src = src.replace(/^.*echo "LAKE_INTRO:.*\n?/gm, '');

  // Strip lake intro markdown instruction block (in template literals)
  src = src.replace(/If \`LAKE_INTRO\` is \`no\`[\s\S]*?touch ~\/\.gstack\/\.completeness-intro-seen[\s\S]*?This only happens once\.\n?\n?/g, '');

  // Strip telemetry prompt markdown instruction block (in template literals)
  src = src.replace(/If \`TEL_PROMPTED\` is \`no\`[\s\S]*?This only happens once\. If \`TEL_PROMPTED\` is \`yes\`, skip this entirely\.\n?\n?/g, '');

  // Strip proactive prompt gated on TEL_PROMPTED
  src = src.replace(/If \`PROACTIVE_PROMPTED\` is \`no\` AND \`TEL_PROMPTED\` is \`yes\`[\s\S]*?Always run:\n\`\`\`bash\n/g, '');

  // Strip upgrade check instructions
  src = src.replace(/If output shows \`UPGRADE_AVAILABLE[\s\S]*?If \`JUST_UPGRADED[^\n]*continue\.\n?\n?/g, '');

  writeFile(filePath, src);
  console.log(`  ${filePath}: gutted preamble + telemetry functions`);
}

// ─── Step 4: Gut preamble source ─────────────────────────────
// Primary defense: gut telemetry at source so the build generates clean output.
// Works on both the original gen-skill-docs.ts and the refactored resolvers/.

gutPreambleSource('scripts/resolvers/preamble.ts');
gutPreambleSource('scripts/gen-skill-docs.ts');

// ─── Step 5: Remove inline analytics from .tmpl and SKILL.md ──

const analyticsPatterns = [
  'skill-usage.jsonl',
  'spec-review.jsonl',
  'eureka.jsonl',
  'mkdir -p ~/.gstack/analytics',
  'gstack-timeline-log',
  'gstack-timeline-read',
  'gstack-telemetry-log',
  'gstack-telemetry-sync',
];

for (const f of findFiles(ROOT, ['.tmpl', '.md'], ['node_modules', '.git'])) {
  removeLines(f, analyticsPatterns);
}
console.log('  Removed inline analytics/telemetry from templates + SKILL.md files');

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
// Check all text file types (bin scripts, extension JS/HTML, setup, docs)

for (const f of findFiles(ROOT, ['.tmpl', '.md', '.sh', '.ts', '.js', '.html'], ['node_modules', '.git'])) {
  let src = readFile(f);
  if (src.includes('github.com/garrytan/gstack')) {
    src = src.replaceAll('github.com/garrytan/gstack', 'github.com/greencm/gstuck');
    writeFile(f, src);
  }
}
// Also check extensionless scripts (setup, bin/gstack-config, bin/gstack-repo-mode, etc.)
for (const f of ['setup', ...readdirSync('bin').map(n => join('bin', n))]) {
  if (!existsSync(f) || statSync(f).isDirectory()) continue;
  let src = readFile(f);
  if (src.includes('github.com/garrytan/gstack')) {
    src = src.replaceAll('github.com/garrytan/gstack', 'github.com/greencm/gstuck');
    writeFile(f, src);
  }
}
console.log('  Replaced github.com/garrytan/gstack references');

// ─── Step 13: Clean telemetry from pre-generated SKILL.md ─────

const pregenTelemetryPatterns = [
  /_TEL=.*gstack-config get telemetry.*\n?/g,
  /_TEL_PROMPTED=.*telemetry-prompted.*\n?/g,
  /_TEL_START=.*date.*\n?/g,
  /_SESSION_ID=.*date.*\n?/g,
  /.*echo "TELEMETRY:.*\n?/g,
  /.*echo "TEL_PROMPTED:.*\n?/g,
  /.*\.pending-.*\n?/g,
  /.*gstack-telemetry-log.*\n?/g,
  /.*gstack-timeline-log.*\n?/g,
  /.*gstack-timeline-read.*\n?/g,
  /.*timeline\.jsonl.*\n?/g,
  /.*mkdir -p ~\/\.gstack\/analytics.*\n?/g,
  /.*mkdir -p ~\/\.gstack\/sessions.*\n?/g,
  /.*touch ~\/\.gstack\/sessions.*\n?/g,
  /.*_SESSIONS=.*\.gstack\/sessions.*\n?/g,
  /.*find ~\/\.gstack\/sessions.*\n?/g,
  /.*gstack-update-check.*\n?/g,
  /.*\[ -n "\$_UPD" \].*\n?/g,
  /.*skill-usage\.jsonl.*\n?/g,
  /.*>> ~\/\.gstack\/analytics\/.*\n?/g,
];

for (const f of findFiles(ROOT, ['SKILL.md'], ['node_modules', '.git'])) {
  let src = readFile(f);
  let changed = false;
  for (const pat of pregenTelemetryPatterns) {
    const newSrc = src.replace(pat, '');
    if (newSrc !== src) { src = newSrc; changed = true; }
  }
  // Strip telemetry epilogue sections
  if (src.includes('## Telemetry (run last)')) {
    src = src.replace(/## Telemetry \(run last\)[\s\S]*?(?=\n## (?!Telemetry)|$)/g, '');
    changed = true;
  }
  // Strip bullet-list telemetry references
  if (src.includes('Telemetry (run last)')) {
    src = src.replace(/^.*Telemetry \(run last\).*\n?/gm, '');
    changed = true;
  }
  // Strip orphaned "if _TEL ... fi" blocks left after line removal
  const telIfFi = src.replace(/if \[ "\$_TEL" != "off" \]; then\s*fi\n?/g, '');
  if (telIfFi !== src) { src = telIfFi; changed = true; }
  // Strip orphaned .pending loop fragments (# zsh-compatible block)
  const pendingLoop = src.replace(/# zsh-compatible[^\n]*\n(?:\s*(?:if \[ -f "\$_PF" \]|fi|rm -f "\$_PF"|break|done)[^\n]*\n)*/g, '');
  if (pendingLoop !== src) { src = pendingLoop; changed = true; }
  // Strip lake intro tracking from preamble
  const lakeLines = src.replace(/^.*_LAKE_SEEN=.*completeness-intro-seen.*\n?/gm, '').replace(/^.*echo "LAKE_INTRO:.*\n?/gm, '');
  if (lakeLines !== src) { src = lakeLines; changed = true; }
  // Strip lake intro section (markdown instructions)
  const lakeIntro = src.replace(/If `LAKE_INTRO` is `no`[\s\S]*?touch ~\/\.gstack\/\.completeness-intro-seen[\s\S]*?This only happens once\.\n?\n?/g, '');
  if (lakeIntro !== src) { src = lakeIntro; changed = true; }
  // Strip telemetry prompt section (markdown instructions)
  const telPrompt = src.replace(/If `TEL_PROMPTED` is `no`[\s\S]*?This only happens once\. If `TEL_PROMPTED` is `yes`, skip this entirely\.\n?\n?/g, '');
  if (telPrompt !== src) { src = telPrompt; changed = true; }
  // Strip proactive prompt section gated on TEL_PROMPTED
  const proactiveTel = src.replace(/If `PROACTIVE_PROMPTED` is `no` AND `TEL_PROMPTED` is `yes`[\s\S]*?skip this entirely\.\n?\n?/g, '');
  if (proactiveTel !== src) { src = proactiveTel; changed = true; }
  // Strip upgrade check instructions
  const upgradeCheck = src.replace(/If output shows `UPGRADE_AVAILABLE[\s\S]*?If `JUST_UPGRADED[^\n]*continue\.\n?\n?/g, '');
  if (upgradeCheck !== src) { src = upgradeCheck; changed = true; }
  if (changed) writeFile(f, src);
}
console.log('  Cleaned telemetry from pre-generated SKILL.md preambles');

// ─── Step 15: Rewrite skill paths for gstuck layout ──────────
// Match skills/gstack followed by / or end-of-string-literal (' or ")
// This catches both path references (skills/gstack/bin/...) and config
// values ('skills/gstack') that upstream uses in HOST_PATHS objects.

for (const f of findFiles(ROOT, ['.md', '.tmpl', '.ts'], ['node_modules', '.git', 'test'])) {
  let src = readFile(f);
  if (src.includes('skills/gstack')) {
    src = src.replace(/skills\/gstack(?=[/'"])/g, 'skills/gstuck/output/gstack');
    writeFile(f, src);
  }
}
console.log('  Rewrote skill paths for gstuck layout');

// ─── Step 16: Remove analytics script from package.json ────────

const PKG_JSON = 'package.json';
if (existsSync(PKG_JSON)) {
  let pkg = readFile(PKG_JSON);
  pkg = pkg.replace(/\n\s*"analytics":\s*"[^"]*",?/g, '');
  // Clean trailing comma before closing brace in scripts block
  pkg = pkg.replace(/,(\s*\})/g, '$1');
  writeFile(PKG_JSON, pkg);
  console.log('  Removed analytics script from package.json');
}

// ─── Step 17: Strip telemetry config section from gstack-config ───

const GSTACK_CONFIG = 'bin/gstack-config';
if (existsSync(GSTACK_CONFIG)) {
  let src = readFile(GSTACK_CONFIG);
  // Remove the telemetry section from CONFIG_HEADER
  const cleaned = src.replace(/# ─── Telemetry ─[^\n]*\n(?:#[^\n]*\n)*/g, '');
  if (cleaned !== src) {
    writeFile(GSTACK_CONFIG, cleaned);
    console.log('  Stripped telemetry config section from gstack-config');
  }
}

console.log('Transforms complete.');
