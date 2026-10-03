import {
  analyzeDocument,
  ELEMENT_ID_ATTRIBUTE,
  toAnalysisResult,
  type AnalyzeDocumentOptions,
} from '@core/analysis';
import { createAdaptationPlan, StylesheetManager } from '@core/adaptation';
import { parseColor } from '@core/color';
import { detectColorConflict } from '@core/conflicts';
import type {
  AdaptationPlan,
  AnalysisResult,
  ColorConflict,
  ElementDescriptor,
  UserSettings,
} from '@domain/models';

/**
 * Development-only, opt-in diagnostics: logs a one-line analysis summary
 * when the page (or a developer, via devtools) sets
 * `data-coloradapt-debug` on `<html>`. Never runs in production builds
 * (`import.meta.env.DEV` is statically false there, so this call tree is
 * dead-code-eliminated) and never sends anything off-device — see
 * docs/PRIVACY.md.
 */
function logDebugSummary(doc: Document, result: AnalysisResult): void {
  const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
  if (!env?.DEV) return;
  if (!doc.documentElement.hasAttribute('data-coloradapt-debug')) return;
  // eslint-disable-next-line no-console -- opt-in development diagnostics only
  console.debug('[ColorAdapt]', {
    elements: result.elements.length,
    conflicts: result.conflicts.length,
    unresolved: result.unresolvedCount,
    truncated: result.truncated,
  });
}

/** Max per-channel difference (0-1) for "effective color == computed `color`". */
const COLOR_MATCH_TOLERANCE = 1.5 / 255;

/**
 * Elements (as `Element`s) that a running animation drives `color` on —
 * CSS `@keyframes` or Web Animations. Their computed color is a snapshot of a
 * moving value, so no color derived from it can be stable (and a
 * `!important` adaptation would silently freeze the page's animation).
 * Environments without `getAnimations` (jsdom) have none.
 */
function colorAnimationTargets(doc: Document): Set<Element> {
  const targets = new Set<Element>();
  if (typeof doc.getAnimations !== 'function') return targets;
  for (const animation of doc.getAnimations()) {
    const effect = animation.effect;
    if (!(effect instanceof KeyframeEffect) || !effect.target || effect.pseudoElement) continue;
    if (effect.getKeyframes().some((keyframe) => 'color' in keyframe)) {
      targets.add(effect.target);
    }
  }
  return targets;
}

function isAnimatedOrInheritsAnimation(node: Element, animated: ReadonlySet<Element>): boolean {
  for (let current: Element | null = node; current; current = current.parentElement) {
    if (animated.has(current)) return true;
  }
  return false;
}

export interface ContentController {
  analyze(url: string, settings: UserSettings): AnalysisResult;
  getLastAnalysis(): AnalysisResult | null;
  enableAdaptation(
    url: string,
    settings: UserSettings,
  ): { analysis: AnalysisResult; adaptation: AdaptationPlan };
  disableAdaptation(): void;
}

/**
 * Ties the DOM Analyzer, Conflict Detection and Adaptation Engine together
 * for a single document/tab. This is the one piece of `features/` that
 * touches the DOM directly — `entrypoints/content.ts` stays a thin
 * message-routing shell around it, and this is unit-testable with jsdom's
 * global `document` without any WebExtension API involved.
 *
 * The page's original styles are always the source of truth: every analysis
 * runs with our stylesheet suspended (see `StylesheetManager.withOriginalStyles`),
 * so re-scanning an adapted page can never compound the adaptation.
 *
 * `analyzerOptions` lets a caller override the analyzer's performance
 * budget (`maxDurationMs`/`now`); production code never passes it, but
 * tests exercising a real fixture page under jsdom's much slower
 * `getComputedStyle` can, instead of fighting production's budget.
 */
export function createContentController(
  doc: Document = document,
  analyzerOptions: Partial<AnalyzeDocumentOptions> = {},
): ContentController {
  const stylesheetManager = new StylesheetManager(doc);
  let lastAnalysis: AnalysisResult | null = null;
  /** Elements whose effective foreground cannot be reproduced by a plain `color` rule. */
  let notAdaptable = new Set<string>();

  /**
   * The effective foreground already folds in `opacity` and color alpha.
   * Writing that composite into `color` would apply them twice, so any
   * element whose computed `color` differs from its effective foreground is
   * left alone (fail-safe), as is every element whose `color` is animated.
   */
  function findNotAdaptable(elements: readonly ElementDescriptor[]): Set<string> {
    const nodes = new Map<string, Element>();
    for (const node of doc.querySelectorAll(`[${ELEMENT_ID_ATTRIBUTE}]`)) {
      const id = node.getAttribute(ELEMENT_ID_ATTRIBUTE);
      if (id) nodes.set(id, node);
    }

    const getStyle = analyzerOptions.getStyle ?? ((el: Element) => getComputedStyle(el));
    const animated = colorAnimationTargets(doc);
    const unsafe = new Set<string>();
    for (const element of elements) {
      const node = nodes.get(element.id);
      if (node && animated.size > 0 && isAnimatedOrInheritsAnimation(node, animated)) {
        unsafe.add(element.id);
        continue;
      }
      const computed = node ? parseColor(getStyle(node).color || '') : null;
      const fg = element.colorPair.foreground;
      const matches =
        computed !== null &&
        computed.alpha >= 0.999 &&
        Math.abs(computed.r - fg.r) <= COLOR_MATCH_TOLERANCE &&
        Math.abs(computed.g - fg.g) <= COLOR_MATCH_TOLERANCE &&
        Math.abs(computed.b - fg.b) <= COLOR_MATCH_TOLERANCE;
      if (!matches) unsafe.add(element.id);
    }
    return unsafe;
  }

  function analyze(url: string, settings: UserSettings): AnalysisResult {
    const { pass, unsafe } = stylesheetManager.withOriginalStyles(() => {
      const analysisPass = analyzeDocument({ ...analyzerOptions, root: doc });
      return {
        pass: analysisPass,
        unsafe: findNotAdaptable(
          analysisPass.elements.filter((element) => element.analysisStatus === 'resolved'),
        ),
      };
    });
    notAdaptable = unsafe;

    const conflicts: ColorConflict[] = [];
    let unresolvedCount = 0;

    for (const element of pass.elements) {
      // Only draw contrast conclusions on confidently-resolved backgrounds
      // (see docs/CSS_ANALYSIS.md) — a gradient/image background must never
      // produce a false confident conflict.
      if (element.analysisStatus !== 'resolved') {
        unresolvedCount += 1;
        continue;
      }
      const conflict = detectColorConflict(element.id, element.colorPair, settings.visionProfile);
      if (conflict) conflicts.push(conflict);
    }

    const result = toAnalysisResult(url, pass, conflicts, unresolvedCount);
    lastAnalysis = result;
    logDebugSummary(doc, result);
    return result;
  }

  function enableAdaptation(
    url: string,
    settings: UserSettings,
  ): { analysis: AnalysisResult; adaptation: AdaptationPlan } {
    const analysis = analyze(url, settings);
    const planningInput: AnalysisResult = {
      ...analysis,
      elements: analysis.elements.map((element) =>
        notAdaptable.has(element.id) ? { ...element, analysisStatus: 'partial' } : element,
      ),
    };
    const planned = createAdaptationPlan(planningInput, settings);
    // The browser has the last word: a change whose computed color is not the
    // planned one (e.g. an inline `!important`) is dropped, never reported as adapted.
    const { applied, notApplied } = stylesheetManager.apply(planned.changes);
    const adaptation: AdaptationPlan =
      notApplied.length === 0
        ? planned
        : {
            ...planned,
            changes: applied,
            summary: {
              ...planned.summary,
              adapted: planned.summary.adapted - notApplied.length,
              notApplied: notApplied.length,
            },
          };
    return { analysis, adaptation };
  }

  function disableAdaptation(): void {
    stylesheetManager.restore();
  }

  return {
    analyze,
    getLastAnalysis: () => lastAnalysis,
    enableAdaptation,
    disableAdaptation,
  };
}
