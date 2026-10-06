import { createDetailedAdaptationPlan, type ElementOutcome } from '@core/adaptation';
import {
  evaluateCanvas,
  evaluateChart,
  evaluateCoverage,
  evaluateImage,
  evaluateSemantic,
  evaluateSvg,
  evaluateText,
  findingIdFor,
  instanceIdFor,
  isLargeTextStyle,
  type AdaptationInfo,
  type AuditAdaptationStatus,
  type AuditCandidate,
  type AuditProfileScope,
  type AuditScope,
  type AuditTargetInput,
} from '@core/audit';
import { ownsChart, type ChartAnalysis, type ChartFacts } from '@core/charts';
import type { SemanticResult } from '@core/semantics';
import { ELIGIBLE_RULES, chooseTask, type SemanticFacts } from '@core/semantic-ai';
import {
  VISION_PROFILES,
  type AnalysisResult,
  type ElementDescriptor,
  type UserSettings,
  type VisionProfile,
} from '@domain/models';
import type { AuditSources } from '../page-analysis';
import { SEMANTIC_LIMITS } from '../semantics';
import { isRendered } from './rendered';
import { readChartFacts, readGraphicFacts, readStateFacts } from './semantic-facts';
import {
  INTERACTIVE_SELECTOR as INTERACTIVE,
  LocatorContext,
  isFieldElement,
  isInteractiveElement,
  readTextSnippet,
} from './element-locator';

export const MAJOR_PROFILES: readonly VisionProfile[] = [
  'protanopia',
  'deuteranopia',
  'tritanopia',
];

const SIMULATED = (profile: VisionProfile) => profile !== 'normal' && profile !== 'custom';

/**
 * - `active`: the user's profile (nothing to simulate for normal vision);
 * - `major`:  protanopia, deuteranopia, tritanopia, plus the active profile when it is another one;
 * - `auto`:   `active` for a simulated profile, `major` when the user has normal vision selected
 *             (a developer with normal vision still wants to know how the page fares).
 */
export function resolveProfiles(scope: AuditProfileScope, active: VisionProfile): VisionProfile[] {
  const chosen =
    scope === 'active' || (scope === 'auto' && SIMULATED(active))
      ? SIMULATED(active)
        ? [active]
        : []
      : [...MAJOR_PROFILES, ...(SIMULATED(active) ? [active] : [])];
  return VISION_PROFILES.filter((profile) => chosen.includes(profile));
}

export interface CollectInput {
  readonly doc: Document;
  readonly sources: AuditSources;
  /** The effective settings (global merged with the site's). */
  readonly settings: UserSettings;
  readonly scope: AuditProfileScope;
}

/**
 * What the AI-assisted review needs of one finding, read while the page was audited: plain data of
 * one representative element (no node), so a later pass of the page cannot change what was asked.
 */
export interface AssistCase {
  readonly findingId: string;
  readonly instanceId: string;
  /**
   * Reads the facts when the review asks (never during the pass, so an audit without the AI-assisted
   * review pays nothing for it). `null` when the element is gone. Holds the element weakly, like the store.
   */
  readonly read: () => SemanticFacts | null;
  /**
   * The same for the first {@link ASSIST_SAMPLES} elements of the finding, the representative first. A
   * finding groups elements by rule, component and context, not by what they mean: the review asks about
   * the group only while every sampled element gives the same packet (docs/AI_SEMANTIC_ENGINE.md, "Groups").
   */
  readonly samples: readonly (() => SemanticFacts | null)[];
}

/** Elements of one finding whose packets are compared before a group is asked about. */
export const ASSIST_SAMPLES = 4;

/** Reads the facts of one element for one rule; takes the element so a closure never has to hold it. */
type FactsReader = (ruleId: string, element: Element) => SemanticFacts | null;

export interface Collected {
  readonly candidates: readonly AuditCandidate[];
  /** One case per eligible manual-review finding, by finding id. */
  readonly assist: ReadonlyMap<string, AssistCase>;
  /** The element behind every instance id, for navigation and highlighting. */
  readonly elements: ReadonlyMap<string, Element>;
  readonly profiles: readonly VisionProfile[];
  readonly coverage: {
    readonly elementsAnalyzed: number;
    readonly analysisTruncated: boolean;
    readonly semanticCandidates: number;
    readonly svgUnits: number;
    readonly charts: number;
    readonly canvases: number;
    readonly images: number;
    /** Budgets this pass hit; a global limit is coverage, not a finding per element. */
    readonly budgetsReached: readonly string[];
    /** Pixels are read only while adaptation and “Adapt functional images” are both on. */
    readonly imagePixelAudit: boolean;
  };
}

/**
 * An element's target, described only when something reads it. Almost every analyzed element has no
 * finding, and describing one (identity path, text snippet) is the expensive part of a candidate.
 */
class LazyTarget implements AuditTargetInput {
  readonly #locators: LocatorContext;
  readonly #element: Element;
  #value: AuditTargetInput | null = null;

  constructor(locators: LocatorContext, element: Element) {
    this.#locators = locators;
    this.#element = element;
  }

  #described(): AuditTargetInput {
    this.#value ??= this.#locators.describe(this.#element);
    return this.#value;
  }

  get key(): string {
    return this.#described().key;
  }

  get locator(): AuditTargetInput['locator'] {
    return this.#described().locator;
  }

  get component(): string {
    return this.#described().component;
  }
}

/** ColorAdapt's own nodes: never a source of findings. */
const OWNED = '[data-coloradapt-chart-node], [data-coloradapt-audit-overlay]';

/**
 * An SVG the page hides from assistive technology is decoration, unless it is the only thing a
 * control has to say (an icon-only button with no name of its own).
 */
function isDecorativeSvg(node: Element): boolean {
  const hidden = node.closest('[aria-hidden="true"]') !== null;
  const role = node.getAttribute('role');
  if (!hidden && role !== 'presentation' && role !== 'none') return false;
  const control = node.closest(INTERACTIVE);
  if (!control) return true;
  const named =
    control.hasAttribute('aria-label') ||
    control.hasAttribute('aria-labelledby') ||
    control.hasAttribute('title');
  return named || readTextSnippet(control, 40).trim() !== '';
}

function isLargeText(node: Element, getStyle: (element: Element) => CSSStyleDeclaration): boolean {
  const style = getStyle(node);
  return isLargeTextStyle(style.fontSize, style.fontWeight);
}

function planOutcomes(
  elements: readonly ElementDescriptor[],
  notAdaptable: ReadonlySet<string>,
  settings: UserSettings,
): ReadonlyMap<string, ElementOutcome> {
  if (!SIMULATED(settings.visionProfile)) return new Map();
  const analysis: AnalysisResult = {
    url: '',
    timestamp: 0,
    elements: elements.map((element) =>
      notAdaptable.has(element.id) ? { ...element, analysisStatus: 'partial' } : element,
    ),
    conflicts: [],
    truncated: false,
    unresolvedCount: 0,
  };
  // Adaptation may be off; the audit still asks what the engine would do, to offer its suggestion.
  return createDetailedAdaptationPlan(analysis, { ...settings, enabled: true }).outcomes;
}

function suggestionOf(outcome: ElementOutcome | undefined): string | undefined {
  if (outcome?.kind !== 'adapted') return undefined;
  const value = outcome.changes[0]?.adaptedValue;
  return value && /^#[0-9a-f]{6}$/i.test(value) ? value : undefined;
}

/**
 * Reads one audit pass's sources into candidates (the evaluators in `core/audit` decide what is a
 * finding; this only translates the page into the data they take). Everything here refers to the
 * page as authored: the sources were read with ColorAdapt's rules suspended.
 */
export function collectAudit(input: CollectInput): Collected {
  const { doc, sources, settings } = input;
  const active = settings.visionProfile;
  const profiles = resolveProfiles(input.scope, active);
  const scope: AuditScope = { profiles, activeProfile: active };
  const locators = new LocatorContext(doc);
  const candidates: AuditCandidate[] = [];
  const elements = new Map<string, Element>();
  const outcomes = planOutcomes(sources.elements, sources.notAdaptable, settings);

  const assist = new Map<string, AssistCase>();
  // A manual-review case of an eligible rule keeps the facts of its first element (one per finding).
  const add = (found: readonly AuditCandidate[], element: Element, facts?: FactsReader): void => {
    for (const candidate of found) {
      candidates.push(candidate);
      elements.set(instanceIdFor(candidate), element);
      if (
        facts &&
        candidate.assessment === 'manual-review' &&
        ELIGIBLE_RULES.includes(candidate.ruleId)
      ) {
        const findingId = findingIdFor(candidate);
        const ref = new WeakRef(element);
        const ruleId = candidate.ruleId;
        const read = (): SemanticFacts | null => {
          const live = ref.deref();
          return live?.isConnected ? facts(ruleId, live) : null;
        };
        const known = assist.get(findingId);
        if (!known) {
          assist.set(findingId, {
            findingId,
            instanceId: instanceIdFor(candidate),
            read,
            samples: [read],
          });
        } else if (known.samples.length < ASSIST_SAMPLES) {
          assist.set(findingId, { ...known, samples: [...known.samples, read] });
        }
      }
    }
  };
  const stateReader =
    (result: SemanticResult, colorOnly: boolean | null): FactsReader =>
    (_ruleId, element) => {
      const state = result.status === 'classified' ? result.state : undefined;
      const task = chooseTask('CA-SEM-002', {
        ...(state ? { state } : {}),
        interactive: isInteractiveElement(element),
      });
      return task ? readStateFacts(element, task, result, colorOnly) : null;
    };
  const chartReader =
    (analysis: ChartAnalysis, facts: ChartFacts): FactsReader =>
    (ruleId, element) =>
      ruleId === 'CA-CHART-002'
        ? readChartFacts(element, analysis, facts)
        : graphic(null)(ruleId, element);
  const graphic =
    (image: { classification: string; small: boolean } | null): FactsReader =>
    (ruleId, element) => {
      const task = chooseTask(ruleId, { interactive: isInteractiveElement(element) });
      return task ? readGraphicFacts(element, task, ruleId, image) : null;
    };

  const colorAdaptation = (id: string): AdaptationInfo => {
    const suggestionHex = suggestionOf(outcomes.get(id));
    const withSuggestion = (status: AuditAdaptationStatus): AdaptationInfo =>
      suggestionHex ? { status, suggestionHex } : { status };
    if (!sources.adaptationActive) return withSuggestion('not-enabled');
    switch (sources.trackedKind(id)) {
      case 'adapted':
        return withSuggestion('adapted');
      case 'notApplied':
        return withSuggestion('not-applied');
      case 'noSafeCandidate':
        return withSuggestion('no-safe-candidate');
      case 'unresolved':
        return withSuggestion('unsupported');
      default:
        return withSuggestion('not-applicable');
    }
  };

  const ownedCharts = new Set<Element>();
  for (const chart of sources.charts.charts)
    if (ownsChart(chart.analysis)) ownedCharts.add(chart.svg);

  // M1 / M2 / M3 / M5: text and SVG, from the CSS analysis.
  let svgUnits = 0;
  for (const descriptor of sources.elements) {
    const node = sources.nodes.get(descriptor.id);
    if (!node?.isConnected || !descriptor.isVisible || node.closest(OWNED)) continue;
    // text that is not painted (a closed menu, a collapsed panel) is not judged; see rendered.ts
    if (!isRendered(node, sources.getStyle)) continue;
    const target = new LazyTarget(locators, node);
    if (descriptor.svg) {
      svgUnits += 1;
      if (ownedCharts.has(node) || isDecorativeSvg(node)) continue;
      add(
        evaluateSvg(
          {
            target,
            svg: descriptor.svg,
            foreground: descriptor.colorPair.foreground,
            background: descriptor.colorPair.background,
            analysisStatus: descriptor.analysisStatus,
            interactive: isInteractiveElement(node),
            adaptation: colorAdaptation(descriptor.id),
          },
          scope,
        ),
        node,
        graphic(null),
      );
      continue;
    }
    if (!descriptor.hasTextContent || descriptor.disabled) continue;
    add(
      evaluateText(
        {
          target,
          foreground: descriptor.colorPair.foreground,
          background: descriptor.colorPair.background,
          analysisStatus: descriptor.analysisStatus,
          interactive: isInteractiveElement(node),
          largeText: isLargeText(node, sources.getStyle),
          adaptation: colorAdaptation(descriptor.id),
        },
        scope,
      ),
      node,
    );
  }

  // M6: states carried by color only.
  const cuesWanted = sources.semantic.enabled;
  for (const record of sources.semantic.records) {
    if (!record.element.isConnected || record.element.closest(OWNED)) continue;
    if (!isRendered(record.element, sources.getStyle)) continue;
    let status: AuditAdaptationStatus = 'not-applicable';
    if (record.decision.action === 'cue') {
      status = record.hasCue ? 'adapted' : cuesWanted ? 'not-applied' : 'not-enabled';
    } else if (record.verdict?.colorOnly && record.decision.reason === 'no-safe-placement') {
      status = 'unsupported';
    }
    add(
      evaluateSemantic({
        target: new LazyTarget(locators, record.element),
        result: record.result,
        decision: record.decision,
        verdict: record.verdict,
        interactive: isInteractiveElement(record.element),
        field: record.kind === 'control' && isFieldElement(record.element),
        adaptation: { status },
      }),
      record.element,
      stateReader(record.result, record.verdict?.colorOnly ?? null),
    );
  }

  // M7: charts and canvases.
  for (const chart of sources.charts.charts) {
    if (!chart.svg.isConnected || chart.svg.closest(OWNED)) continue;
    let status: AuditAdaptationStatus;
    // Inactive although the profile is simulated: the setting is off, or adaptation never started. Nothing was attempted.
    if (!sources.charts.active) status = SIMULATED(active) ? 'not-enabled' : 'not-applicable';
    else if (chart.info.status === 'supported')
      status = chart.info.adapted > 0 ? 'adapted' : 'not-applicable';
    else if (chart.info.status === 'limited') {
      status =
        chart.info.reason === 'encoding-exhausted'
          ? 'no-safe-candidate'
          : chart.info.reason === 'not-applied'
            ? 'not-applied'
            : 'unsupported';
    } else if (chart.info.status === 'unsupported') status = 'unsupported';
    else status = 'not-applicable';
    add(
      evaluateChart(
        {
          target: new LazyTarget(locators, chart.svg),
          analysis: chart.analysis,
          adaptation: { status },
        },
        scope,
      ),
      chart.svg,
      chartReader(chart.analysis, chart.facts),
    );
  }
  for (const canvas of sources.charts.canvases) {
    if (!canvas.canvas.isConnected) continue;
    add(
      evaluateCanvas({ target: new LazyTarget(locators, canvas.canvas), verdict: canvas.verdict }),
      canvas.canvas,
      graphic(null),
    );
  }

  // M8: raster images.
  for (const record of sources.images.records) {
    if (!record.element.isConnected) continue;
    add(
      evaluateImage({
        target: new LazyTarget(locators, record.element),
        kind: record.kind,
        confidence: record.confidence,
        layer: record.layer
          ? {
              action: record.layer.action,
              reason: record.layer.reason,
              readability: record.layer.readability,
            }
          : null,
        interactive: record.interactive,
        small: record.small,
        crossOrigin: record.crossOrigin,
        adaptation: { status: 'not-applicable' },
      }),
      record.element,
      graphic({ classification: record.kind, small: record.small }),
    );
  }

  const limits: string[] = [];
  if (sources.truncated) limits.push('analyzed elements');
  if (sources.semantic.candidates >= SEMANTIC_LIMITS.maxCandidatesPerPass)
    limits.push('semantic candidates');
  if (sources.charts.truncated) limits.push('chart marks');
  if (sources.images.truncated) limits.push('images');
  const root: AuditTargetInput = new LazyTarget(locators, doc.documentElement);
  add(evaluateCoverage(limits, sources.elements.length, root), doc.documentElement);

  return {
    candidates,
    assist,
    elements,
    profiles,
    coverage: {
      elementsAnalyzed: sources.elements.length,
      analysisTruncated: sources.truncated,
      semanticCandidates: sources.semantic.candidates,
      svgUnits,
      charts: sources.charts.charts.length,
      canvases: sources.charts.canvases.length,
      images: sources.images.records.length,
      budgetsReached: limits,
      imagePixelAudit: sources.adaptationActive && settings.adaptImages,
    },
  };
}
