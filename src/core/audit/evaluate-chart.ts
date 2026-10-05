import {
  analyzePairs,
  existingSignature,
  signaturesDistinct,
  type ChartDescriptor,
  type ChartSeries,
} from '@core/charts';
import type { ChartUnsupportedReason, VisionProfile } from '@domain/models';
import { simulatedProfiles } from './evaluate-color';
import { evidence, simulationInfo } from './evidence';
import { redactSnippet } from './privacy';
import type { CanvasAuditInput, ChartAuditInput, AuditScope } from './inputs';
import { AUDIT_LIMITS, type AuditAdaptationStatus, type AuditCandidate } from './types';

/**
 * M7 evaluators. A chart is audited from the structure the chart layer already reads: series with
 * their colors and the non-color encodings the *page* gave them (the chart layer ignores its own
 * overlays, patterns and markers when it reads, so ColorAdapt's cues never count as redundancy).
 *
 * - two series whose simulated colors merge and that nothing else tells apart -> CA-CHART-001;
 * - a legend that cannot be paired with the series                           -> CA-CHART-002 (review);
 * - a chart type or paint the layer does not audit                            -> CA-CHART-003 (review);
 * - a canvas that looks like a chart                                          -> CA-CHART-004 (review).
 *
 * A chart is never reported as inaccessible because of what it is made of: a canvas or a heatmap
 * is reported as "needs a human", not as a failure.
 */

/** Reasons for which series colors mean magnitude or are unreadable, not identity: no pair verdict. */
const NO_PAIR_VERDICT: ReadonlySet<ChartUnsupportedReason> = new Set([
  'sequential-palette',
  'too-many-series',
  'too-large',
  'heatmap-sequential',
  'paint-gradient',
]);

const LEGEND_REASONS: ReadonlySet<ChartUnsupportedReason> = new Set([
  'legend-ambiguous',
  'html-legend',
  'pie-without-legend',
]);

function label(series: ChartSeries): string {
  return redactSnippet(series.label ?? '', 24) ?? `series ${series.index + 1}`;
}

function pairsFor(chart: ChartDescriptor, profile: VisionProfile) {
  const byId = new Map(chart.series.map((s) => [s.id, s]));
  const analysis = analyzePairs(chart.series, profile);
  const color = analysis.pairs.filter((pair) => {
    if (!pair.problematic) return false;
    const a = byId.get(pair.a) as ChartSeries;
    const b = byId.get(pair.b) as ChartSeries;
    return !signaturesDistinct(
      existingSignature(a.existing),
      existingSignature(b.existing),
      a.kind,
    );
  });
  return { analysis, color, byId };
}

function statusFor(profile: VisionProfile, scope: AuditScope, status: AuditAdaptationStatus) {
  return profile === scope.activeProfile ? status : 'not-applicable';
}

export function evaluateChart(input: ChartAuditInput, scope: AuditScope): AuditCandidate[] {
  const { analysis, target } = input;
  const out: AuditCandidate[] = [];

  if (analysis.status === 'unsupported') {
    if (analysis.confidence !== 'HIGH') return out; // "an SVG that might be a chart" is just an SVG
    out.push(review('CA-CHART-003', target, analysis.reason, analysis.type, analysis.reason));
    return out;
  }
  if (analysis.status !== 'supported' && analysis.status !== 'limited') return out;

  const chart = analysis.chart;
  const reason = analysis.status === 'limited' ? analysis.reason : null;
  const profiles = simulatedProfiles(scope.profiles);

  if (reason === null || !NO_PAIR_VERDICT.has(reason)) {
    for (const profile of profiles) {
      const { analysis: pairwise, color, byId } = pairsFor(chart, profile);
      if (color.length === 0) continue;
      const worst = [...color]
        .sort((x, y) => x.simulatedDistance - y.simulatedDistance)
        .slice(0, AUDIT_LIMITS.chartPairs);
      const names = worst.map(
        (pair) =>
          `${label(byId.get(pair.a) as ChartSeries)} ↔ ${label(byId.get(pair.b) as ChartSeries)}`,
      );
      const status = statusFor(profile, scope, input.adaptation.status);
      out.push({
        ruleId: 'CA-CHART-001',
        target,
        context: chart.type,
        profile,
        confidence: chart.confidence === 'HIGH' ? 'HIGH' : 'MEDIUM',
        assessment: 'issue',
        summary: `${color.length} pair${color.length === 1 ? '' : 's'} of series in this ${chart.type} chart merge under ${profile} simulation and nothing but color tells them apart.`,
        evidence: [
          evidence.text('chart.type', 'inference', 'Chart type', chart.type),
          evidence.text(
            'chart.confidence',
            'inference',
            'Chart classification confidence',
            chart.confidence,
          ),
          evidence.number('chart.series', 'observed-fact', 'Series', chart.series.length),
          evidence.list(
            `${profile}.chart.pairs`,
            'model-estimate',
            `Series pairs that merge (${profile})`,
            names,
          ),
          evidence.number(
            `${profile}.chart.minDistance`,
            'model-estimate',
            `Smallest simulated color distance (${profile})`,
            worst[0]?.simulatedDistance ?? 0,
          ),
          evidence.text(
            'chart.existing',
            'observed-fact',
            'Non-color encodings the page already has for these series',
            'none that tells them apart (dash, marker, pattern and direct labels were checked)',
          ),
        ],
        factors: {
          functionalImpact: 'moderate',
          informationLoss: chart.series.length === 2 ? 'total' : 'partial',
          interactive: false,
          redundancy: 'absent',
        },
        adaptation: status,
        simulation: simulationInfo(profile, pairwise.model ?? 'identity'),
        recommendation: {
          chartType: chart.type,
          observed: names.slice(0, 3).join('; '),
          adaptation: status,
        },
      });
    }
  }

  if (reason !== null && LEGEND_REASONS.has(reason)) {
    out.push(review('CA-CHART-002', target, reason, chart.type, reason));
  } else if (
    reason !== null &&
    reason !== 'type-not-adapted' &&
    reason !== 'not-applied' &&
    reason !== 'encoding-exhausted'
  ) {
    out.push(review('CA-CHART-003', target, reason, chart.type, reason));
  }
  return out;
}

function review(
  ruleId: 'CA-CHART-002' | 'CA-CHART-003',
  target: ChartAuditInput['target'],
  context: string,
  type: string,
  reason: string,
): AuditCandidate {
  return {
    ruleId,
    target,
    context,
    profile: null,
    confidence: 'HIGH',
    assessment: 'manual-review',
    summary:
      ruleId === 'CA-CHART-002'
        ? `ColorAdapt cannot pair this ${type} chart’s legend with its series (${reason}).`
        : `ColorAdapt does not audit this ${type} chart automatically (${reason}).`,
    evidence: [
      evidence.text('chart.type', 'inference', 'Chart type', type),
      evidence.text('chart.reason', 'observed-fact', 'Why it is not audited', reason),
    ],
    factors: {
      functionalImpact: 'none',
      informationLoss: 'none',
      interactive: false,
      redundancy: 'unknown',
    },
    adaptation: 'unsupported',
    simulation: null,
    recommendation: { chartType: type, reason, adaptation: 'unsupported' },
  };
}

/** CA-CHART-004: a canvas whose name or neighbors say "chart". Other canvases are not reported. */
export function evaluateCanvas(input: CanvasAuditInput): AuditCandidate[] {
  if (input.verdict.kind !== 'canvas-chart') return [];
  return [
    {
      ruleId: 'CA-CHART-004',
      target: input.target,
      context: 'canvas',
      profile: null,
      confidence: 'MEDIUM',
      assessment: 'manual-review',
      summary: 'A canvas that looks like a chart: its series are pixels ColorAdapt cannot read.',
      evidence: [
        evidence.text(
          'canvas.hint',
          'inference',
          'Why it looks like a chart',
          'a chart word in its name, class, role or neighbors',
        ),
      ],
      factors: {
        functionalImpact: 'none',
        informationLoss: 'none',
        interactive: false,
        redundancy: 'unknown',
      },
      adaptation: 'unsupported',
      simulation: null,
      recommendation: { chartType: 'canvas', adaptation: 'unsupported' },
    },
  ];
}
