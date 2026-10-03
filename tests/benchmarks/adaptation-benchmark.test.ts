import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { VisionProfile } from '@domain/models';
import { VISION_PROFILE_CONFIDENCE } from '@domain/models';
import { convertColor } from '@core/color';
import { ADAPTATION_PAIRS } from './adaptation-pairs';
import { aggregate, parseHex, runBenchmark } from './run-benchmark';
import { buildReport, writeReport } from './report';

const REPORT_DIR = path.resolve(import.meta.dirname, '../../benchmark-report');
const DICHROMATS: readonly VisionProfile[] = ['protanopia', 'deuteranopia', 'tritanopia'];
const ANOMALIES: readonly VisionProfile[] = ['protanomaly', 'deuteranomaly'];

const dichromatRows = runBenchmark(DICHROMATS);
const anomalyRows = runBenchmark(ANOMALIES);

describe('adaptation benchmark: palette', () => {
  it('has 30-60 deterministic, well-formed pairs covering every category', () => {
    expect(ADAPTATION_PAIRS.length).toBeGreaterThanOrEqual(30);
    expect(ADAPTATION_PAIRS.length).toBeLessThanOrEqual(60);
    expect(new Set(ADAPTATION_PAIRS.map((p) => p.id)).size).toBe(ADAPTATION_PAIRS.length);
    expect(new Set(ADAPTATION_PAIRS.map((p) => p.category)).size).toBe(15);
    for (const pair of ADAPTATION_PAIRS) {
      expect(pair.foreground).toMatch(/^#[0-9a-f]{6}$/);
      expect(pair.background).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('is reproducible: two runs give identical rows', () => {
    expect(runBenchmark(DICHROMATS)).toEqual(dichromatRows);
  });
});

describe('adaptation benchmark: hard safety (protan / deutan / tritan, strength 1)', () => {
  it('evaluates every pair under every profile', () => {
    expect(dichromatRows).toHaveLength(ADAPTATION_PAIRS.length * DICHROMATS.length);
  });

  it('has no hard violation in any row', () => {
    const violations = dichromatRows.flatMap((row) =>
      row.hardViolations.map((v) => `${row.profile}/${row.pairId}: ${v}`),
    );
    expect(violations).toEqual([]);
  });

  it('keeps every number finite and every output on the 8-bit sRGB grid', () => {
    for (const row of dichromatRows) {
      for (const value of [
        row.originalSimulatedDistance,
        row.adaptedSimulatedDistance,
        row.originalContrast,
        row.adaptedContrast,
        row.designChange,
        row.lightnessShift,
      ]) {
        if (value !== null) expect(Number.isFinite(value)).toBe(true);
      }
      expect(row.output).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('never exceeds the structural candidate budget', () => {
    const { candidateCount } = aggregate(dichromatRows);
    expect(candidateCount.max).toBeLessThanOrEqual(800);
  });

  it('leaves non-adapted rows byte-identical to the original', () => {
    for (const row of dichromatRows) {
      if (row.status !== 'adapted') expect(row.output).toBe(row.foreground);
    }
  });

  it('adapts something, and leaves accessible pairs alone', () => {
    const agg = aggregate(dichromatRows);
    expect(agg.adapted).toBeGreaterThan(0);
    expect(agg.unchanged).toBeGreaterThan(0);
    for (const profile of DICHROMATS) {
      for (const id of ['red-white-2', 'green-white-2', 'red-black-3']) {
        const row = dichromatRows.find((r) => r.profile === profile && r.pairId === id);
        // High-contrast neutral-background pairs are already distinguishable.
        expect(row?.status, `${profile}/${id}`).toBe('unchanged');
      }
    }
  });
});

describe('adaptation benchmark: anomalies (M2 MODEL_ASSUMPTION) and unsupported', () => {
  it('has no hard violation under protanomaly / deuteranomaly', () => {
    expect(anomalyRows.flatMap((r) => r.hardViolations)).toEqual([]);
    for (const row of anomalyRows) expect(row.confidence).toBe('MODEL_ASSUMPTION');
  });

  it('never adapts under the unsupported custom profile', () => {
    const rows = runBenchmark(['custom']);
    expect(rows.every((row) => row.status === 'unsupported')).toBe(true);
    expect(rows.every((row) => row.output === row.foreground)).toBe(true);
    expect(rows.flatMap((r) => r.hardViolations)).toEqual([]);
  });

  it('tags rows with the confidence of their profile', () => {
    for (const row of [...dichromatRows, ...anomalyRows]) {
      expect(row.confidence).toBe(VISION_PROFILE_CONFIDENCE[row.profile]);
    }
  });
});

describe('adaptation benchmark: strength interpolation', () => {
  it('is safe, deterministic and explainable at strength 0.25 / 0.5 / 0.75', () => {
    for (const strength of [0.25, 0.5, 0.75]) {
      const rows = runBenchmark(DICHROMATS, strength);
      expect(
        rows.flatMap((r) => r.hardViolations.map((v) => `${r.pairId}@${strength}: ${v}`)),
      ).toEqual([]);
      expect(runBenchmark(DICHROMATS, strength)).toEqual(rows);
      for (const row of rows) {
        if (row.status === 'no-safe-candidate') {
          expect([
            'strength-interpolation-unsafe',
            'no-candidate-meets-constraints',
            'search-budget-exhausted',
          ]).toContain(row.reason);
        }
      }
    }
  });

  it('a smaller strength never changes the design more than strength 1', () => {
    const full = runBenchmark(DICHROMATS, 1);
    for (const strength of [0.25, 0.5, 0.75]) {
      const partial = runBenchmark(DICHROMATS, strength);
      partial.forEach((row, index) => {
        const reference = full[index]!;
        if (row.status === 'adapted' && reference.status === 'adapted') {
          expect(row.designChange!).toBeLessThanOrEqual(reference.designChange! + 1e-9);
        }
      });
    }
  });

  it('strength 0 changes nothing', () => {
    const rows = runBenchmark(DICHROMATS, 0);
    expect(rows.every((r) => r.status === 'unchanged' && r.output === r.foreground)).toBe(true);
  });
});

describe('adaptation benchmark: design preservation and search stages (diagnostics)', () => {
  const adapted = dichromatRows.filter((row) => row.status === 'adapted');

  it('does not reach for aggressive hue search when a smaller change is possible', () => {
    const agg = aggregate(dichromatRows);
    // Diagnostic bound, not a product KPI: most solvable pairs are solved before wide-hue search.
    expect(agg.stages['wide-hue']).toBeLessThanOrEqual(agg.adapted / 2);
  });

  it('keeps the typical design change well under the cap', () => {
    const agg = aggregate(dichromatRows);
    expect(agg.medianDesignChange!).toBeLessThan(0.2);
  });

  it('does not systematically push colors to the extremes of lightness', () => {
    const extreme = adapted.filter((row) => {
      const pair = ADAPTATION_PAIRS.find((p) => p.id === row.pairId)!;
      const before = convertColor(parseHex(pair.foreground)).l;
      const after = convertColor(parseHex(row.output)).l;
      return before > 0.15 && before < 0.9 && (after < 0.1 || after > 0.95);
    });
    expect(extreme.length).toBeLessThanOrEqual(adapted.length / 10);
  });

  it('preserves hue: typical hue shift is small, and large ones are rare', () => {
    const agg = aggregate(dichromatRows);
    expect(agg.medianHueShift ?? 0).toBeLessThanOrEqual(10);
    const large = adapted.filter((row) => (row.hueShift ?? 0) > 45);
    expect(large.length).toBeLessThanOrEqual(adapted.length / 10);
  });

  it('searches within the structural budget: p95 candidates well under the cap', () => {
    const agg = aggregate(dichromatRows);
    expect(agg.searchedRows).toBeGreaterThan(0);
    expect(agg.candidateCount.p95).toBeLessThanOrEqual(400);
  });
});

describe('adaptation benchmark: report', () => {
  it('writes machine-readable JSON and a before/after HTML page', () => {
    const profiles = [...DICHROMATS, ...ANOMALIES];
    const report = buildReport(profiles, [...dichromatRows, ...anomalyRows]);
    writeReport(REPORT_DIR, report);

    expect(report.aggregate.rows).toBe(ADAPTATION_PAIRS.length * profiles.length);
    expect(report.aggregate.hardViolations).toBe(0);
  });
});
