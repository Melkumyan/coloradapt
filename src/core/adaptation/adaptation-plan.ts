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

/** Roles M3 never adapts (SVG/images/charts are later milestones). */
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
  if (OUT_OF_SCOPE_ROLES.has(element.role) || element.disabled) return 'skipped';
  if (!element.hasTextContent && element.role !== 'form-control') return 'skipped';
  if (!isCategoryEnabled(element, settings)) return 'skipped';
  return element.analysisStatus === 'resolved' ? 'eligible' : 'unresolved';
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

function toChange(elementId: string, result: AdaptedAdaptation): AdaptationChange {
  return {
    elementId,
    property: 'color',
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
export function createAdaptationPlan(
  analysis: AnalysisResult,
  settings: UserSettings,
  options: CreateAdaptationPlanOptions = {},
): AdaptationPlan {
  const profile = settings.visionProfile;
  const strength = Number.isFinite(settings.adaptationStrength)
    ? clamp01(settings.adaptationStrength)
    : 0;
  const confidence = VISION_PROFILE_CONFIDENCE[profile];

  const counts = {
    adapted: 0,
    unchanged: 0,
    noSafeCandidate: 0,
    notApplied: 0,
    unresolved: 0,
    skipped: 0,
  };
  const changes: AdaptationChange[] = [];

  if (settings.enabled) {
    const memo = new Map<string, AdaptationResult>();

    for (const element of analysis.elements) {
      const eligibility = classify(element, settings);
      if (eligibility === 'skipped') {
        counts.skipped += 1;
        continue;
      }
      if (eligibility === 'unresolved') {
        counts.unresolved += 1;
        continue;
      }

      const { foreground, background } = element.colorPair;
      const key = `${colorKey(foreground)}|${colorKey(background)}`;
      let result = memo.get(key);
      if (!result) {
        result = findAdaptation({
          foreground,
          background,
          profile,
          strength,
          constraints: options.constraints,
        });
        memo.set(key, result);
      }

      switch (result.status) {
        case 'adapted':
          counts.adapted += 1;
          changes.push(toChange(element.id, result));
          break;
        case 'unchanged':
          counts.unchanged += 1;
          break;
        case 'no-safe-candidate':
          counts.noSafeCandidate += 1;
          break;
        case 'unsupported':
          counts.unresolved += 1;
          break;
      }
    }
  }

  const summary: AdaptationSummary = {
    ...counts,
    problemsDetected: counts.adapted + counts.noSafeCandidate,
  };
  return { profile, confidence, strength, changes, summary };
}
