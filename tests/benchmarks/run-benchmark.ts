import type { AdaptationResult, ColorValue, ModelConfidence, VisionProfile } from '@domain/models';
import { convertColor, parseColor, toHex } from '@core/color';
import {
  constraintsFor,
  contrastFloor,
  findAdaptation,
  searchStagesFor,
  type SearchStage,
} from '@core/adaptation';
import { VISION_PROFILE_CONFIDENCE } from '@domain/models';
import { ADAPTATION_PAIRS, type BenchmarkPair } from './adaptation-pairs';

export interface BenchmarkRow {
  readonly pairId: string;
  readonly category: BenchmarkPair['category'];
  readonly profile: VisionProfile;
  readonly strength: number;
  readonly confidence: ModelConfidence;
  readonly foreground: string;
  readonly background: string;
  readonly status: AdaptationResult['status'];
  readonly reason: string;
  /** Applied color (the original unless `adapted`). */
  readonly output: string;
  readonly originalSimulatedDistance: number | null;
  readonly adaptedSimulatedDistance: number | null;
  readonly distanceImprovement: number | null;
  readonly originalContrast: number | null;
  readonly adaptedContrast: number | null;
  /** OKLab distance original -> output ("design change"). */
  readonly designChange: number | null;
  /** Hue shift in degrees (OKLCH); `null` when either color is near-neutral. */
  readonly hueShift: number | null;
  readonly lightnessShift: number | null;
  readonly candidateCount: number;
  readonly stagesSearched: number;
  /** Stage that produced the optimizer's choice; `null` unless adapted. */
  readonly selectedStage: SearchStage | null;
  readonly hardViolations: readonly string[];
}

export interface BenchmarkAggregate {
  readonly rows: number;
  readonly unchanged: number;
  readonly adapted: number;
  readonly noSafeCandidate: number;
  readonly unsupported: number;
  readonly medianDesignChange: number | null;
  readonly p95DesignChange: number | null;
  readonly medianDistanceImprovement: number | null;
  readonly contrastRegressions: number;
  /** Rows that actually ran a search (early exits evaluate no candidates). */
  readonly searchedRows: number;
  /** Candidate evaluations per searched row. */
  readonly candidateCount: { readonly median: number; readonly p95: number; readonly max: number };
  readonly medianHueShift: number | null;
  readonly stages: Readonly<Record<SearchStage | 'none', number>>;
  readonly hardViolations: number;
}

const NEUTRAL_CHROMA = 0.04;

export function parseHex(hex: string): ColorValue {
  const color = parseColor(hex);
  if (!color) throw new Error(`bad benchmark color ${hex}`);
  return { ...color, alpha: 1 };
}

function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? null;
}

function onEightBitGrid(color: ColorValue): boolean {
  return [color.r, color.g, color.b].every(
    (channel) =>
      channel >= 0 && channel <= 1 && Math.abs(channel * 255 - Math.round(channel * 255)) < 1e-9,
  );
}

function allFinite(...values: Array<number | null>): boolean {
  return values.every((value) => value === null || Number.isFinite(value));
}

/** Hard safety rules every `adapted` row must satisfy, independent of any average. */
function hardViolations(result: AdaptationResult, strength: number): string[] {
  const violations: string[] = [];
  const constraints = constraintsFor(result.confidence);

  if (result.confidence === 'UNSUPPORTED' && result.status !== 'unsupported') {
    violations.push('unsupported-model-adapted');
  }
  if (result.stats.candidateCount > constraints.maxCandidateEvaluations) {
    violations.push('candidate-budget-exceeded');
  }
  if (result.status !== 'adapted') {
    if (toHex(result.outputColor) !== toHex(result.originalColor)) {
      violations.push('non-adapted-output-changed');
    }
    return violations;
  }

  const numbers = [
    result.adaptedContrast,
    result.changeDistance,
    result.score,
    result.adaptedVisionAnalysis.simulatedDistance,
    result.outputColor.r,
    result.outputColor.g,
    result.outputColor.b,
  ];
  if (!allFinite(...numbers)) violations.push('non-finite-number');
  if (!onEightBitGrid(result.outputColor) || result.outputColor.alpha !== 1) {
    violations.push('out-of-gamut-or-unquantized-output');
  }
  if (
    result.adaptedContrast <
    contrastFloor(result.originalContrast, constraints.contrastRegressionTolerance) - 1e-9
  ) {
    violations.push('contrast-floor');
  }
  if (result.changeDistance > constraints.maxDesignChange + 1e-9) {
    violations.push('design-change-cap');
  }
  if (strength >= 1) {
    if (result.adaptedVisionAnalysis.simulatedDistance < constraints.targetSimulatedDistance) {
      violations.push('simulated-distance-below-target');
    }
  } else if (
    result.adaptedVisionAnalysis.simulatedDistance < result.originalVisionAnalysis.simulatedDistance
  ) {
    violations.push('simulated-distance-regressed');
  }
  return violations;
}

export function evaluatePair(
  pair: BenchmarkPair,
  profile: VisionProfile,
  strength = 1,
): BenchmarkRow {
  const foreground = parseHex(pair.foreground);
  const background = parseHex(pair.background);
  const result = findAdaptation({ foreground, background, profile, strength });
  const analyzed = result.status !== 'unsupported';
  const adapted = result.status === 'adapted';

  const before = convertColor(foreground);
  const after = adapted ? convertColor(result.outputColor) : null;
  const chromatic = after !== null && before.c >= NEUTRAL_CHROMA && after.c >= NEUTRAL_CHROMA;
  const hueShift =
    chromatic && after ? Math.abs(((((after.h - before.h) % 360) + 540) % 360) - 180) : null;

  const stages = searchStagesFor(before);
  return {
    pairId: pair.id,
    category: pair.category,
    profile,
    strength,
    confidence: VISION_PROFILE_CONFIDENCE[profile],
    foreground: pair.foreground,
    background: pair.background,
    status: result.status,
    reason: result.reason,
    output: toHex(result.outputColor),
    originalSimulatedDistance: analyzed ? result.originalVisionAnalysis.simulatedDistance : null,
    adaptedSimulatedDistance: adapted ? result.adaptedVisionAnalysis.simulatedDistance : null,
    distanceImprovement: adapted
      ? result.adaptedVisionAnalysis.simulatedDistance -
        result.originalVisionAnalysis.simulatedDistance
      : null,
    originalContrast: analyzed ? result.originalContrast : null,
    adaptedContrast: adapted ? result.adaptedContrast : null,
    designChange: adapted ? result.changeDistance : null,
    hueShift,
    lightnessShift: adapted && after ? after.l - before.l : null,
    candidateCount: result.stats.candidateCount,
    stagesSearched: result.stats.stagesSearched,
    selectedStage: adapted ? (stages[result.stats.stagesSearched - 1] ?? null) : null,
    hardViolations: hardViolations(result, strength),
  };
}

export function runBenchmark(
  profiles: readonly VisionProfile[],
  strength = 1,
  pairs: readonly BenchmarkPair[] = ADAPTATION_PAIRS,
): BenchmarkRow[] {
  return profiles.flatMap((profile) => pairs.map((pair) => evaluatePair(pair, profile, strength)));
}

export function aggregate(rows: readonly BenchmarkRow[]): BenchmarkAggregate {
  const adaptedRows = rows.filter((row) => row.status === 'adapted');
  const counts = rows.map((row) => row.candidateCount).filter((count) => count > 0);
  const stages: Record<SearchStage | 'none', number> = {
    'lightness-chroma': 0,
    'small-hue': 0,
    'wide-hue': 0,
    none: 0,
  };
  for (const row of rows) {
    if (row.status === 'adapted' && row.selectedStage) stages[row.selectedStage] += 1;
    else if (row.status === 'no-safe-candidate') stages.none += 1;
  }
  return {
    rows: rows.length,
    unchanged: rows.filter((row) => row.status === 'unchanged').length,
    adapted: adaptedRows.length,
    noSafeCandidate: rows.filter((row) => row.status === 'no-safe-candidate').length,
    unsupported: rows.filter((row) => row.status === 'unsupported').length,
    medianDesignChange: quantile(
      adaptedRows.map((row) => row.designChange ?? 0),
      0.5,
    ),
    p95DesignChange: quantile(
      adaptedRows.map((row) => row.designChange ?? 0),
      0.95,
    ),
    medianDistanceImprovement: quantile(
      adaptedRows.map((row) => row.distanceImprovement ?? 0),
      0.5,
    ),
    contrastRegressions: rows.filter((row) => row.hardViolations.includes('contrast-floor')).length,
    searchedRows: counts.length,
    medianHueShift: quantile(
      adaptedRows.flatMap((row) => (row.hueShift === null ? [] : [row.hueShift])),
      0.5,
    ),
    candidateCount: {
      median: quantile(counts, 0.5) ?? 0,
      p95: quantile(counts, 0.95) ?? 0,
      max: Math.max(0, ...counts),
    },
    stages,
    hardViolations: rows.reduce((sum, row) => sum + row.hardViolations.length, 0),
  };
}
