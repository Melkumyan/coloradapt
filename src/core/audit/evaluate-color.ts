import { calculateContrast } from '@core/color';
import { CONTRAST_THRESHOLDS, PERCEPTUAL_DISTANCE_THRESHOLDS } from '@core/conflicts';
import { simulatePair } from '@core/vision';
import type { SvgUnsupportedReason, VisionProfile } from '@domain/models';
import { evidence, hexOf, simulationInfo } from './evidence';
import type { AuditScope, SvgAuditInput, TextAuditInput } from './inputs';
import type {
  AuditAdaptationStatus,
  AuditAssessment,
  AuditCandidate,
  AuditEvidence,
  AuditTargetInput,
  SeverityFactors,
} from './types';

/**
 * M1 / M2 / M3 / M5 evaluators: what the CSS analysis, the vision simulation and the adaptation
 * engine say about one element's foreground and background. Pure; they never see a node.
 *
 * Thresholds are ColorAdapt's own engineering choices (`core/conflicts/thresholds.ts`, shared with
 * the conflict detector), and every report labels them as such. The audit says "related to WCAG
 * 1.4.3", never "fails" it: ColorAdapt does not know a page's text is exempt, disabled, decorative
 * or a logotype.
 */

/** Below this ratio the foreground is practically invisible against the background. */
const NEAR_INVISIBLE_RATIO = 1.5;
/** Contrast target for graphics and icons (non-text). */
const GRAPHIC_CONTRAST_TARGET = 3;

/** Profiles that have a simulation behind them. */
export function simulatedProfiles(profiles: readonly VisionProfile[]): VisionProfile[] {
  return profiles.filter((profile) => profile !== 'normal' && profile !== 'custom');
}

function statusFor(
  profile: VisionProfile | null,
  scope: AuditScope,
  status: AuditAdaptationStatus,
): AuditAdaptationStatus {
  return profile === null || profile === scope.activeProfile ? status : 'not-applicable';
}

interface PairEvaluation {
  readonly evidence: readonly AuditEvidence[];
  readonly summary: string;
  readonly profile: VisionProfile;
  readonly simulatedDistance: number;
  readonly model: ReturnType<typeof simulatePair>['model'];
}

/** CVD distinguishability of a pair for one profile, or `null` when it is fine (or never was). */
function distinguishability(
  foreground: TextAuditInput['foreground'],
  background: TextAuditInput['background'],
  profile: VisionProfile,
): PairEvaluation | null {
  const analysis = simulatePair(foreground, background, profile);
  const { hardToDistinguish, indistinguishable } = PERCEPTUAL_DISTANCE_THRESHOLDS;
  // Only a pair that normal vision tells apart is a color-vision problem; a pair that is already
  // close is a contrast problem and is reported as one.
  if (
    analysis.originalDistance < hardToDistinguish ||
    analysis.simulatedDistance >= hardToDistinguish
  ) {
    return null;
  }
  return {
    profile,
    simulatedDistance: analysis.simulatedDistance,
    model: analysis.model,
    summary: `${hexOf(foreground)} on ${hexOf(background)} is estimated to merge under ${profile} simulation (distance ${analysis.simulatedDistance.toFixed(3)}, threshold ${hardToDistinguish}${analysis.simulatedDistance < indistinguishable ? '; effectively indistinguishable' : ''}).`,
    evidence: [
      evidence.colors(
        `${profile}.colors.simulated`,
        'model-estimate',
        `Simulated colors (${profile})`,
        analysis.simulatedForeground,
        analysis.simulatedBackground,
      ),
      evidence.number(
        `${profile}.distance.original`,
        'observed-fact',
        `Color distance, normal vision (${profile} audit)`,
        analysis.originalDistance,
      ),
      evidence.number(
        `${profile}.distance.simulated`,
        'model-estimate',
        `Color distance, simulated (${profile})`,
        analysis.simulatedDistance,
      ),
      evidence.number(
        `${profile}.distance.threshold`,
        'engineering-threshold',
        `Distinguishability threshold (${profile})`,
        hardToDistinguish,
      ),
    ],
  };
}

function base(
  ruleId: string,
  target: AuditTargetInput,
  fields: Omit<AuditCandidate, 'ruleId' | 'target'>,
): AuditCandidate {
  return { ruleId, target, ...fields };
}

/** CA-COLOR-001 / -002 / -003 for one text-bearing element. */
export function evaluateText(input: TextAuditInput, scope: AuditScope): AuditCandidate[] {
  const out: AuditCandidate[] = [];
  const { target, foreground, background } = input;
  const pairEvidence = evidence.colors(
    'colors.pair',
    'observed-fact',
    'Foreground / background',
    foreground,
    background,
  );

  if (input.analysisStatus !== 'resolved') {
    out.push(
      base('CA-COLOR-003', target, {
        context: input.analysisStatus,
        profile: null,
        confidence: 'HIGH',
        assessment: 'analysis-limitation',
        summary:
          'ColorAdapt could not resolve a single solid background behind this text, so no contrast conclusion was drawn.',
        evidence: [
          evidence.text(
            'analysis.status',
            'observed-fact',
            'Background analysis',
            input.analysisStatus === 'partial'
              ? 'resolved with a known limit (best effort)'
              : 'gradient, image or mixed background',
          ),
        ],
        factors: {
          functionalImpact: 'none',
          informationLoss: 'none',
          interactive: input.interactive,
          redundancy: 'unknown',
        },
        adaptation: 'unsupported',
        simulation: null,
        recommendation: { adaptation: 'unsupported' },
      }),
    );
    return out;
  }

  const ratio = calculateContrast(foreground, background);
  const targetRatio = input.largeText
    ? CONTRAST_THRESHOLDS.aaLargeText
    : CONTRAST_THRESHOLDS.aaNormalText;
  const observed = `${hexOf(foreground)} on ${hexOf(background)}`;
  if (ratio < targetRatio) {
    const factors: SeverityFactors = {
      functionalImpact: input.interactive
        ? ratio < CONTRAST_THRESHOLDS.aaLargeText
          ? 'major'
          : 'moderate'
        : 'minor',
      informationLoss: ratio < NEAR_INVISIBLE_RATIO ? 'total' : 'partial',
      interactive: input.interactive,
      redundancy: 'unknown',
    };
    const status = statusFor(null, scope, input.adaptation.status);
    out.push(
      base('CA-COLOR-001', target, {
        context: '',
        profile: null,
        confidence: 'HIGH',
        assessment: 'issue',
        summary: `Text contrast is ${ratio.toFixed(2)}:1; ColorAdapt’s target for ${input.largeText ? 'large' : 'normal-size'} text is ${targetRatio}:1.`,
        evidence: [
          pairEvidence,
          evidence.number('contrast.ratio', 'observed-fact', 'Contrast ratio', ratio, ':1'),
          evidence.number(
            'contrast.target',
            'engineering-threshold',
            'Contrast target',
            targetRatio,
            ':1',
          ),
          evidence.text(
            'text.size',
            'observed-fact',
            'Text size class',
            input.largeText ? 'large text' : 'normal text',
          ),
        ],
        factors,
        adaptation: status,
        simulation: null,
        recommendation: {
          observed,
          adaptation: status,
          ...(input.adaptation.suggestionHex
            ? { suggestedHex: input.adaptation.suggestionHex }
            : {}),
        },
      }),
    );
  }

  for (const profile of simulatedProfiles(scope.profiles)) {
    const result = distinguishability(foreground, background, profile);
    if (!result) continue;
    const status = statusFor(profile, scope, input.adaptation.status);
    out.push(
      base('CA-COLOR-002', target, {
        context: '',
        profile,
        confidence: 'HIGH',
        assessment: 'issue',
        summary: result.summary,
        evidence: [pairEvidence, ...result.evidence],
        factors: {
          functionalImpact: input.interactive ? 'major' : 'minor',
          informationLoss:
            result.simulatedDistance < PERCEPTUAL_DISTANCE_THRESHOLDS.indistinguishable
              ? 'total'
              : 'partial',
          interactive: input.interactive,
          redundancy: 'unknown',
        },
        adaptation: status,
        simulation: simulationInfo(profile, result.model),
        recommendation: {
          observed,
          adaptation: status,
          ...(input.adaptation.suggestionHex && profile === scope.activeProfile
            ? { suggestedHex: input.adaptation.suggestionHex }
            : {}),
        },
      }),
    );
  }
  return out;
}

const SVG_REVIEW_REASONS: ReadonlySet<SvgUnsupportedReason> = new Set([
  'paint-gradient',
  'paint-pattern',
  'paint-server',
  'paint-context',
  'multi-paint',
  'use-shared-paint',
  'use-unresolved',
  'use-external',
]);

/** SVGs the chart layer (M7) or the chart heuristic owns are audited as charts, not as icons. */
const SVG_CHART_REASONS: ReadonlySet<SvgUnsupportedReason> = new Set(['chart-owned', 'chart-like']);

export function isChartSvgReason(reason: SvgUnsupportedReason | undefined): boolean {
  return reason !== undefined && SVG_CHART_REASONS.has(reason);
}

/** CA-SVG-001 / -002 for one outermost inline SVG that is not decorative. */
export function evaluateSvg(input: SvgAuditInput, scope: AuditScope): AuditCandidate[] {
  const { target, svg, foreground, background } = input;
  if (isChartSvgReason(svg.unsupportedReason)) return [];

  const limitation =
    svg.unsupportedReason ??
    svg.partialReason ??
    (input.analysisStatus !== 'resolved' ? 'background-unresolved' : null);
  if (limitation !== null) {
    const assessment: AuditAssessment =
      svg.unsupportedReason && SVG_REVIEW_REASONS.has(svg.unsupportedReason)
        ? 'manual-review'
        : 'analysis-limitation';
    const status: AuditAdaptationStatus = 'unsupported';
    return [
      base('CA-SVG-002', target, {
        context: limitation,
        profile: null,
        confidence: 'HIGH',
        assessment,
        summary: `ColorAdapt does not analyze this SVG’s colors (${limitation}).`,
        evidence: [
          evidence.text('svg.reason', 'observed-fact', 'Why it is not analyzed', limitation),
          evidence.number('svg.paints', 'observed-fact', 'Distinct paints', svg.paintCount),
          evidence.number('svg.shapes', 'observed-fact', 'Painted shapes', svg.shapeCount),
        ],
        factors: {
          functionalImpact: 'none',
          informationLoss: 'none',
          interactive: input.interactive,
          redundancy: 'unknown',
        },
        adaptation: status,
        simulation: null,
        recommendation: { reason: limitation, adaptation: status },
      }),
    ];
  }

  const out: AuditCandidate[] = [];
  const observed = `${hexOf(foreground)} on ${hexOf(background)}`;
  const pairEvidence = evidence.colors(
    'colors.pair',
    'observed-fact',
    'SVG paint / background',
    foreground,
    background,
  );
  const ratio = calculateContrast(foreground, background);
  const factorsFor = (total: boolean): SeverityFactors => ({
    functionalImpact: input.interactive ? 'major' : 'minor',
    informationLoss: total ? 'total' : 'partial',
    interactive: input.interactive,
    redundancy: 'unknown',
  });
  if (ratio < GRAPHIC_CONTRAST_TARGET) {
    const status = statusFor(null, scope, input.adaptation.status);
    out.push(
      base('CA-SVG-001', target, {
        context: 'contrast',
        profile: null,
        confidence: 'HIGH',
        assessment: 'issue',
        summary: `The SVG’s paint has ${ratio.toFixed(2)}:1 contrast with its background; ColorAdapt’s target for graphics is ${GRAPHIC_CONTRAST_TARGET}:1.`,
        evidence: [
          pairEvidence,
          evidence.number('contrast.ratio', 'observed-fact', 'Contrast ratio', ratio, ':1'),
          evidence.number(
            'contrast.target',
            'engineering-threshold',
            'Contrast target (graphics)',
            GRAPHIC_CONTRAST_TARGET,
            ':1',
          ),
        ],
        factors: factorsFor(ratio < NEAR_INVISIBLE_RATIO),
        adaptation: status,
        simulation: null,
        recommendation: {
          observed,
          trigger: 'contrast',
          adaptation: status,
          ...(input.adaptation.suggestionHex
            ? { suggestedHex: input.adaptation.suggestionHex }
            : {}),
        },
      }),
    );
  }
  for (const profile of simulatedProfiles(scope.profiles)) {
    const result = distinguishability(foreground, background, profile);
    if (!result) continue;
    const status = statusFor(profile, scope, input.adaptation.status);
    out.push(
      base('CA-SVG-001', target, {
        context: 'distinguishability',
        profile,
        confidence: 'HIGH',
        assessment: 'issue',
        summary: result.summary,
        evidence: [pairEvidence, ...result.evidence],
        factors: factorsFor(
          result.simulatedDistance < PERCEPTUAL_DISTANCE_THRESHOLDS.indistinguishable,
        ),
        adaptation: status,
        simulation: simulationInfo(profile, result.model),
        recommendation: {
          observed,
          trigger: 'distinguishability',
          adaptation: status,
          ...(input.adaptation.suggestionHex && profile === scope.activeProfile
            ? { suggestedHex: input.adaptation.suggestionHex }
            : {}),
        },
      }),
    );
  }
  return out;
}
