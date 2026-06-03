/**
 * Cathedral parity-eval harness (v1.45.0.0 T0b).
 *
 * Compares CURRENT SKILL.md output to a v1.44.1 golden baseline along three
 * axes: STRUCTURE (frontmatter shape), CONTENT (must-preserve phrases per
 * skill family), and SIZE (per-skill byte budget). The fourth axis —
 * BEHAVIORAL parity via LLM-as-judge — runs on top of this harness in the
 * periodic-tier eval suite (paid, ~$0.20 per skill judge call).
 *
 * The structural + content checks ship in v1.45.0.0 as the foundation; the
 * LLM-judge layer lands in v2.0.0.0 alongside the sections/ pattern. Both
 * use this module's APIs.
 *
 * Why a separate harness from skill-size-budget.test.ts: that one enforces
 * size discipline only. This module supports content invariants per skill
 * family (e.g., cso must preserve OWASP/STRIDE; plan-ceo must preserve
 * mode-selection phrasing) so future compression can't silently strip
 * load-bearing prose even when size stays within ratio.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ParityBaseline, SkillBaselineEntry } from './capture-parity-baseline';
import { captureBaseline } from './capture-parity-baseline';

export interface ParityInvariant {
  skill: string;
  /** Phrases that MUST appear in the generated SKILL.md (case-insensitive substring). */
  mustContain?: string[];
  /** Markdown H2 headings that MUST appear. */
  mustHaveHeadings?: string[];
  /** Maximum byte size growth ratio vs baseline. 1.0 = no growth allowed. */
  maxSizeRatio?: number;
  /** Minimum byte size (catches over-stripping cliffs). */
  minBytes?: number;
}

export interface ParityCheckResult {
  skill: string;
  passed: boolean;
  failures: string[];
}

export function checkSkillParity(
  invariant: ParityInvariant,
  current: SkillBaselineEntry,
  baseline: SkillBaselineEntry | undefined,
  repoRoot: string,
): ParityCheckResult {
  const failures: string[] = [];

  // SIZE checks
  if (invariant.maxSizeRatio !== undefined && baseline) {
    const ratio = current.skillMdBytes / baseline.skillMdBytes;
    if (ratio > invariant.maxSizeRatio) {
      failures.push(`size ratio ${ratio.toFixed(3)} > maxSizeRatio ${invariant.maxSizeRatio}`);
    }
  }
  if (invariant.minBytes !== undefined && current.skillMdBytes < invariant.minBytes) {
    failures.push(`size ${current.skillMdBytes} < minBytes ${invariant.minBytes}`);
  }

  // CONTENT checks (read live file for fresh content)
  if (invariant.mustContain?.length || invariant.mustHaveHeadings?.length) {
    const skillMdPath = path.join(repoRoot, invariant.skill, 'SKILL.md');
    let content: string | null = null;
    try {
      content = fs.readFileSync(skillMdPath, 'utf-8');
    } catch (err) {
      failures.push(`cannot read ${skillMdPath}: ${(err as Error).message}`);
    }
    if (content) {
      const lower = content.toLowerCase();
      for (const phrase of invariant.mustContain ?? []) {
        if (!lower.includes(phrase.toLowerCase())) {
          failures.push(`missing required phrase: "${phrase}"`);
        }
      }
      for (const heading of invariant.mustHaveHeadings ?? []) {
        if (!content.includes(heading)) {
          failures.push(`missing required heading: "${heading}"`);
        }
      }
    }
  }

  return {
    skill: invariant.skill,
    passed: failures.length === 0,
    failures,
  };
}

export interface ParityReport {
  baselineTag: string;
  currentCapturedAt: string;
  totalChecks: number;
  passed: number;
  failed: number;
  details: ParityCheckResult[];
}

export function runParityChecks(opts: {
  repoRoot: string;
  baseline: ParityBaseline;
  invariants: ParityInvariant[];
}): ParityReport {
  const { repoRoot, baseline, invariants } = opts;
  const current = captureBaseline({ repoRoot });
  const details: ParityCheckResult[] = [];
  for (const invariant of invariants) {
    const baselineEntry = baseline.skills[invariant.skill];
    const currentEntry = current.skills[invariant.skill];
    if (!currentEntry) {
      details.push({
        skill: invariant.skill,
        passed: false,
        failures: [`skill removed: ${invariant.skill} present in baseline but not current state`],
      });
      continue;
    }
    details.push(checkSkillParity(invariant, currentEntry, baselineEntry, repoRoot));
  }
  return {
    baselineTag: baseline.tag,
    currentCapturedAt: current.capturedAt,
    totalChecks: details.length,
    passed: details.filter(d => d.passed).length,
    failed: details.filter(d => !d.passed).length,
    details,
  };
}

/**
 * Standard invariant registry — the v1.45.0.0 set.
 *
 * Each entry pins what must-not-break in a skill family. Extend as future
 * skills land. Phase B (v2.0.0.0) adds LLM-judge invariants on top of these.
 */
export const PARITY_INVARIANTS: ParityInvariant[] = [
  {
    skill: 'cso',
    mustContain: ['OWASP', 'STRIDE', 'daily', 'comprehensive', 'verif'],
    mustHaveHeadings: ['## Preamble', '## When to invoke'],
    maxSizeRatio: 1.05,
    minBytes: 30_000,
  },
  {
    skill: 'ship',
    mustContain: [
      'VERSION',
      'CHANGELOG',
      'review',
      'merge',
      'PR',
    ],
    mustHaveHeadings: ['## Preamble', '## When to invoke'],
    maxSizeRatio: 1.05,
    minBytes: 80_000,
  },
  {
    skill: 'plan-ceo-review',
    mustContain: [
      'SCOPE EXPANSION',
      'SELECTIVE EXPANSION',
      'HOLD SCOPE',
      'SCOPE REDUCTION',
    ],
    mustHaveHeadings: ['## Preamble', '## When to invoke'],
    maxSizeRatio: 1.05,
    minBytes: 80_000,
  },
  {
    skill: 'plan-eng-review',
    mustContain: [
      'Architecture',
      'Code Quality',
      'Test',
      'Performance',
    ],
    mustHaveHeadings: ['## Preamble', '## When to invoke'],
    maxSizeRatio: 1.05,
    minBytes: 70_000,
  },
  {
    skill: 'plan-design-review',
    mustContain: [
      'design',
      'visual',
    ],
    mustHaveHeadings: ['## Preamble', '## When to invoke'],
    maxSizeRatio: 1.05,
    minBytes: 70_000,
  },
  {
    skill: 'review',
    mustContain: ['confidence', 'P1', 'P2'],
    mustHaveHeadings: ['## Preamble', '## When to invoke'],
    maxSizeRatio: 1.05,
    minBytes: 70_000,
  },
  {
    skill: 'qa',
    mustContain: ['bug', 'browse', 'fix'],
    mustHaveHeadings: ['## Preamble', '## When to invoke'],
    maxSizeRatio: 1.05,
    minBytes: 50_000,
  },
  {
    skill: 'investigate',
    mustContain: ['root cause', 'hypothes'],
    mustHaveHeadings: ['## Preamble', '## When to invoke'],
    maxSizeRatio: 1.05,
    minBytes: 30_000,
  },
  {
    skill: 'office-hours',
    mustContain: ['design doc', 'problem statement'],
    mustHaveHeadings: ['## Preamble', '## When to invoke'],
    maxSizeRatio: 1.05,
    minBytes: 70_000,
  },
  {
    skill: 'autoplan',
    mustContain: ['ceo', 'eng', 'design'],
    mustHaveHeadings: ['## Preamble', '## When to invoke'],
    maxSizeRatio: 1.05,
    minBytes: 70_000,
  },
];
