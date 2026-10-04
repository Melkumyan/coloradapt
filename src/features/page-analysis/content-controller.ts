import { analyzeDocument, toAnalysisResult, type AnalyzeDocumentOptions } from '@core/analysis';
import { createDetailedAdaptationPlan, StylesheetManager } from '@core/adaptation';
import { detectColorConflict } from '@core/conflicts';
import type { AdaptationPlan, AnalysisResult, ColorConflict, UserSettings } from '@domain/models';
import { ChartController, type ChartEnvironment } from '../charts';
import { findNotAdaptable } from './adaptability';
import {
  SemanticCueController,
  type FactsEnvironment,
  type SemanticInspection,
} from '../semantics';
import { IncrementalAdaptationSession, type IncrementalAdaptation } from './incremental-adaptation';

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

export interface ContentController {
  analyze(url: string, settings: UserSettings): AnalysisResult;
  getLastAnalysis(): AnalysisResult | null;
  enableAdaptation(
    url: string,
    settings: UserSettings,
  ): { analysis: AnalysisResult; adaptation: AdaptationPlan };
  disableAdaptation(): void;
  /**
   * Region-by-region re-adaptation, used by the dynamic pipeline
   * (features/dynamic-analysis). Inactive until `enableAdaptation` has run.
   */
  readonly incremental: IncrementalAdaptation;
  /** What the semantic layer makes of one element (read-only; for tests and debugging). */
  inspectSemantics(element: Element): SemanticInspection;
  /**
   * Lets the chart layer ask for a pass over one chart whose size or path structure changed (docs/CHARTS.md,
   * "Resize and geometry"). The dynamic pipeline binds it while it runs; `null` unbinds.
   */
  bindChartInvalidation(invalidate: ((svg: Element) => void) | null): void;
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
  semanticOptions: { readonly env?: FactsEnvironment; readonly chartEnv?: ChartEnvironment } = {},
): ContentController {
  const stylesheetManager = new StylesheetManager(doc);
  // The chart layer (M7) decides which SVGs are its own; the SVG analyzer asks it before adapting one.
  const charts = new ChartController({
    doc,
    sheet: stylesheetManager,
    ...(semanticOptions.chartEnv ? { env: semanticOptions.chartEnv } : {}),
  });
  // Analysis reads the page's own styles through the stylesheet manager; inline SVGs are told
  // apart (currentColor / inherited / explicit) by a probe that goes through the same <style>.
  analyzerOptions = {
    ...analyzerOptions,
    probeStyles:
      analyzerOptions.probeStyles ?? ((css, read) => stylesheetManager.withProbe(css, read)),
    isChartOwned: analyzerOptions.isChartOwned ?? ((svg: Element) => charts.owns(svg)),
  };
  let lastAnalysis: AnalysisResult | null = null;
  /** Elements whose effective foreground cannot be reproduced by a plain `color` rule. */
  let notAdaptable = new Set<string>();
  const semantic = new SemanticCueController({
    doc,
    sheet: stylesheetManager,
    ...(semanticOptions.env ? { env: semanticOptions.env } : {}),
  });
  const session = new IncrementalAdaptationSession(
    doc,
    stylesheetManager,
    analyzerOptions,
    semantic,
    charts,
  );
  const getStyle = analyzerOptions.getStyle ?? ((el: Element) => getComputedStyle(el));

  function analyze(url: string, settings: UserSettings): AnalysisResult {
    charts.configure(settings);
    const { pass, unsafe } = stylesheetManager.withOriginalStyles(() => {
      const analysisPass = analyzeDocument({ ...analyzerOptions, root: doc });
      return {
        pass: analysisPass,
        unsafe: findNotAdaptable(
          doc,
          analysisPass.elements.filter((element) => element.analysisStatus === 'resolved'),
          getStyle,
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
    const { plan: planned, outcomes } = createDetailedAdaptationPlan(planningInput, settings);
    // The browser has the last word: a change whose computed color is not the
    // planned one (e.g. an inline `!important`) is dropped, never reported as adapted.
    const { applied, notApplied } = stylesheetManager.apply(planned.changes);
    // One element (or one inline SVG, whose rules share an owner) counts once, however many rules it has.
    const notAppliedIds = new Set(notApplied.map((change) => change.ownerId ?? change.elementId));
    const adaptation: AdaptationPlan =
      notApplied.length === 0
        ? planned
        : {
            ...planned,
            changes: applied,
            summary: {
              ...planned.summary,
              adapted: planned.summary.adapted - notAppliedIds.size,
              notApplied: notAppliedIds.size,
            },
          };
    if (settings.enabled) {
      session.begin(settings, outcomes, notAppliedIds, analysis.elements);
    } else {
      session.end();
    }
    return { analysis, adaptation };
  }

  function disableAdaptation(): void {
    session.end();
    stylesheetManager.restore();
  }

  return {
    analyze(url, settings) {
      try {
        return analyze(url, settings);
      } finally {
        charts.endPass();
      }
    },
    getLastAnalysis: () => lastAnalysis,
    enableAdaptation,
    disableAdaptation,
    incremental: session,
    inspectSemantics: (element) => semantic.inspect(element),
    bindChartInvalidation: (invalidate) => charts.bindInvalidation(invalidate),
  };
}
