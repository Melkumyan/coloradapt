import { analyzeDocument, toAnalysisResult, type AnalyzeDocumentOptions } from '@core/analysis';
import { computeAdaptation, StylesheetManager } from '@core/adaptation';
import { detectColorConflict } from '@core/conflicts';
import type { AdaptationResult, AnalysisResult, ColorConflict, UserSettings } from '@domain/models';

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
  ): { analysis: AnalysisResult; adaptation: AdaptationResult };
  disableAdaptation(): void;
}

/**
 * Ties the DOM Analyzer, Conflict Detection and Adaptation Engine together
 * for a single document/tab. This is the one piece of `features/` that
 * touches the DOM directly — `entrypoints/content.ts` stays a thin
 * message-routing shell around it, and this is unit-testable with jsdom's
 * global `document` without any WebExtension API involved.
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

  function analyze(url: string, settings: UserSettings): AnalysisResult {
    const pass = analyzeDocument({ ...analyzerOptions, root: doc });
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
  ): { analysis: AnalysisResult; adaptation: AdaptationResult } {
    const analysis = analyze(url, settings);
    const adaptation = computeAdaptation(analysis, settings.visionProfile, settings);
    stylesheetManager.apply(adaptation.changes);
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
