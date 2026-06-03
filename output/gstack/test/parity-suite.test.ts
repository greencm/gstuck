/**
 * Cathedral parity suite — gate-tier (free, structural + content checks).
 *
 * Runs every PARITY_INVARIANTS check against the current SKILL.md output
 * vs the v1.44.1 baseline. Failures get an actionable, per-skill report
 * showing missing phrases, missing headings, and size ratios.
 *
 * Periodic-tier LLM-judge parity (paid) lands in Phase B (v2.0.0.0)
 * alongside the sections/ extraction. Plumbing is in parity-harness.ts.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { runParityChecks, PARITY_INVARIANTS } from './helpers/parity-harness';
import type { ParityBaseline } from './helpers/capture-parity-baseline';

const REPO_ROOT = path.resolve(import.meta.dir, '..');
const BASELINE_PATH = path.join(REPO_ROOT, 'test', 'fixtures', 'parity-baseline-v1.44.1.json');

describe('parity suite vs v1.44.1 baseline (gate, free)', () => {
  test('baseline exists', () => {
    expect(fs.existsSync(BASELINE_PATH)).toBe(true);
  });

  test('all PARITY_INVARIANTS pass', () => {
    const baseline: ParityBaseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
    const report = runParityChecks({
      repoRoot: REPO_ROOT,
      baseline,
      invariants: PARITY_INVARIANTS,
    });

    // eslint-disable-next-line no-console
    console.log(
      `[parity] ${report.passed}/${report.totalChecks} skills passed parity vs ${baseline.tag}`,
    );

    if (report.failed === 0) return;

    const failureMessages = report.details
      .filter(d => !d.passed)
      .map(d => `  ${d.skill}:\n    - ${d.failures.join('\n    - ')}`)
      .join('\n');
    throw new Error(
      `${report.failed} skill(s) failed parity checks vs v1.44.1:\n${failureMessages}`,
    );
  });
});
