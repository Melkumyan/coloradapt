import type {
  AdaptationChange,
  AdaptationResult,
  AdaptationSummary,
  AdaptedAdaptation,
  AnalysisResult,
  ColorValue,
  ElementDescriptor,
  UserSettings,
} from '@domain/models';
import { VISION_PROFILE_CONFIDENCE } from '@domain/models';
import type { AdaptationPlan } from '@domain/models';
import { toHex } from '@core/color';
import { clamp01 } from '@shared/utils';
import type { AdaptationConstraints } from './constraints';
import { findAdaptation } from './optimizer';

/**
 * Roles of descriptors that are not analyzed units: SVG elements are only ever
 * adapted as a whole inline `<svg>` (a descriptor with `svg` info, see below);
 * images and charts are later milestones.
 */
const OUT_OF_SCOPE_ROLES: ReadonlySet<ElementDescriptor['role']> = new Set([
  'svg',
  'image',
  'chart',
  'icon',
]);

export interface CreateAdaptationPlanOptions {
  readonly constraints?: Partial<AdaptationConstraints>;
}

type Eligibility = 'eligible' | 'unresolved' | 'skipped';

function isCategoryEnabled(element: ElementDescriptor, settings: UserSettings): boolean {
  switch (element.role) {
    case 'link':
      return settings.improveLinks;
    case 'status':
    case 'badge':
      return settings.improveStatusIndicators;
    default:
      return settings.improveUIColors;
  }
}

/**
 * Fail-safe eligibility: only elements with a confidently resolved solid
 * background (`analysisStatus === 'resolved'`) are adapted; `partial` and
 * `unsupported` are reported as unresolved and never touched.
 */
function classify(element: ElementDescriptor, settings: UserSettings): Eligibility {
  if (element.svg) return classifySvg(element, settings);
  if (OUT_OF_SCOPE_ROLES.has(element.role) || element.disabled) return 'skipped';
  if (!element.hasTextContent && element.role !== 'form-control') return 'skipped';
  if (!isCategoryEnabled(element, settings)) return 'skipped';
  return element.analysisStatus === 'resolved' ? 'eligible' : 'unresolved';
}

/**
 * Fail-safe eligibility of an inline SVG unit (docs/SVG_ANALYSIS.md). Beyond the
 * HTML rules: only a *single visible paint* the analyzer could attribute to
 * rules (`svg.targets`) is adapted; anything it classified (`unsupportedReason`)
 * or could not fully trust (`partialReason`) is reported as unresolved.
 */
function classifySvg(element: ElementDescriptor, settings: UserSettings): Eligibility {
  const svg = element.svg;
  if (!svg || !settings.adaptSVG || !settings.improveUIColors) return 'skipped';
  if (svg.unsupportedReason || svg.partialReason) return 'unresolved';
  if (element.analysisStatus !== 'resolved') return 'unresolved';
  return svg.targets.length > 0 ? 'eligible' : 'skipped';
}

function colorKey(color: ColorValue): string {
  return `${color.r},${color.g},${color.b},${color.alpha}`;
}

function describeChange(result: AdaptedAdaptation): string {
  const before = result.originalVisionAnalysis.simulatedDistance.toFixed(3);
  const after = result.adaptedVisionAnalysis.simulatedDistance.toFixed(3);
  return (
    `Model-guided color adjustment: estimated distinguishability ${before} -> ${after} ` +
    `(${result.profile}, ${result.confidence}); contrast ${result.originalContrast.toFixed(2)}:1 -> ` +
    `${result.adaptedContrast.toFixed(2)}:1.`
  );
}

/**
 * The rules one adapted element needs. An HTML element has one (`color`); an
 * inline SVG has one per paint owner (its `color`/`fill`/`stroke` on the
 * `<svg>`, on shapes, or on `<use>` instances), all with the same adapted value
 * and all owned by the `<svg>` so they live and die together.
 */
function toChanges(element: ElementDescriptor, result: AdaptedAdaptation): AdaptationChange[] {
  const base = {
    originalValue: toHex(result.originalColor),
    adaptedValue: toHex(result.outputColor),
    reason: describeChange(result),
    confidence: result.confidence,
    metrics: {
      originalContrast: result.originalContrast,
      adaptedContrast: result.adaptedContrast,
      originalSimulatedDistance: result.originalVisionAnalysis.simulatedDistance,
      adaptedSimulatedDistance: result.adaptedVisionAnalysis.simulatedDistance,
      changeDistance: result.changeDistance,
      score: result.score,
    },
  };
  if (!element.svg) return [{ ...base, elementId: element.id, property: 'color' }];
  return element.svg.targets.map((target) => ({
    ...base,
    elementId: target.elementId,
    ownerId: element.id,
    property: target.property,
  }));
}

/** What the planner decided for one element. Only `adapted` carries changes. */
export type ElementOutcome =
  | { readonly kind: 'adapted'; readonly changes: readonly AdaptationChange[] }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'noSafeCandidate' }
  | { readonly kind: 'unresolved' }
  | { readonly kind: 'skipped' };

export type PlanningMemo = Map<string, AdaptationResult>;

/** Normalized planning inputs derived once from the settings. */
export interface PlanningContext {
  readonly settings: UserSettings;
  readonly profile: UserSettings['visionProfile'];
  readonly strength: number;
  readonly options: CreateAdaptationPlanOptions;
}

export function createPlanningContext(
  settings: UserSettings,
  options: CreateAdaptationPlanOptions = {},
): PlanningContext {
  return {
    settings,
    profile: settings.visionProfile,
    strength: Number.isFinite(settings.adaptationStrength)
      ? clamp01(settings.adaptationStrength)
      : 0,
    options,
  };
}

/**
 * Plans one element in isolation — the unit both the full plan and the
 * incremental (delta) path are built from. `memo` caches optimizer results
 * per distinct color pair and may be shared across calls with one context.
 */
export function planElement(
  element: ElementDescriptor,
  context: PlanningContext,
  memo: PlanningMemo,
): ElementOutcome {
  if (!context.settings.enabled) return { kind: 'skipped' };
  const eligibility = classify(element, context.settings);
  if (eligibility === 'skipped') return { kind: 'skipped' };
  if (eligibility === 'unresolved') return { kind: 'unresolved' };

  const { foreground, background } = element.colorPair;
  const key = `${colorKey(foreground)}|${colorKey(background)}`;
  let result = memo.get(key);
  if (!result) {
    result = findAdaptation({
      foreground,
      background,
      profile: context.profile,
      strength: context.strength,
      constraints: context.options.constraints,
    });
    memo.set(key, result);
  }

  switch (result.status) {
    case 'adapted':
      return { kind: 'adapted', changes: toChanges(element, result) };
    case 'unchanged':
      return { kind: 'unchanged' };
    case 'no-safe-candidate':
      return { kind: 'noSafeCandidate' };
    case 'unsupported':
      return { kind: 'unresolved' };
  }
}

export interface DetailedAdaptationPlan {
  readonly plan: AdaptationPlan;
  /** Per-element decision, by element id — the seed of incremental bookkeeping. */
  readonly outcomes: ReadonlyMap<string, ElementOutcome>;
}

/**
 * Builds a DOM-independent {@link AdaptationPlan} from an analysis: runs the
 * foreground optimizer once per distinct color pair (many elements share
 * pairs) and keeps only `adapted` outcomes as changes. The plan holds data
 * only; applying it (stylesheet) is the content layer's job.
 *
 * Limitation: each element is adapted in isolation against its own resolved
 * background. A foreground used on several backgrounds, or a shared CSS
 * variable, is never optimized jointly (docs/ADAPTATION_ENGINE.md).
 */
export function createDetailedAdaptationPlan(
  analysis: AnalysisResult,
  settings: UserSettings,
  options: CreateAdaptationPlanOptions = {},
): DetailedAdaptationPlan {
  const context = createPlanningContext(settings, options);
  const confidence = VISION_PROFILE_CONFIDENCE[context.profile];

  const counts = { ...EMPTY_COUNTS };
  const changes: AdaptationChange[] = [];
  const outcomes = new Map<string, ElementOutcome>();
  const memo: PlanningMemo = new Map();

  if (settings.enabled) {
    for (const element of analysis.elements) {
      const outcome = planElement(element, context, memo);
      outcomes.set(element.id, outcome);
      countOutcome(counts, outcome);
      if (outcome.kind === 'adapted') changes.push(...outcome.changes);
    }
  }

  const plan: AdaptationPlan = {
    profile: context.profile,
    confidence,
    strength: context.strength,
    changes,
    summary: toSummary(counts),
  };
  return { plan, outcomes };
}

export function createAdaptationPlan(
  analysis: AnalysisResult,
  settings: UserSettings,
  options: CreateAdaptationPlanOptions = {},
): AdaptationPlan {
  return createDetailedAdaptationPlan(analysis, settings, options).plan;
}

/** Mutable tallies of {@link ElementOutcome} kinds (plus `notApplied`, set by the content layer). */
export interface OutcomeCounts {
  adapted: number;
  unchanged: number;
  noSafeCandidate: number;
  notApplied: number;
  unresolved: number;
  skipped: number;
}

const EMPTY_COUNTS: Readonly<OutcomeCounts> = {
  adapted: 0,
  unchanged: 0,
  noSafeCandidate: 0,
  notApplied: 0,
  unresolved: 0,
  skipped: 0,
};

export function createOutcomeCounts(): OutcomeCounts {
  return { ...EMPTY_COUNTS };
}

export function countOutcome(counts: OutcomeCounts, outcome: ElementOutcome, delta = 1): void {
  counts[outcome.kind] += delta;
}

export function toSummary(counts: Readonly<OutcomeCounts>): AdaptationSummary {
  return { ...counts, problemsDetected: counts.adapted + counts.noSafeCandidate };
}
