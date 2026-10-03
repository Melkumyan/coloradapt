import type { AnalyzeDocumentOptions } from '@core/analysis';
import type { UserSettings } from '@domain/models';
import { createContentController, type ContentController } from '../page-analysis';
import { createNativeValidityBridge, type FactsEnvironment } from '../semantics';
import {
  createDynamicPipeline,
  type DynamicPipeline,
  type DynamicPipelineOptions,
} from './incremental-controller';

export interface DynamicContentController extends ContentController {
  /** The mutation pipeline: lifecycle, forced flush and diagnostics. */
  readonly dynamic: DynamicPipeline;
  /** The native-validity event bridge (M6): installed only while semantic cues are on. For leak diagnostics. */
  readonly semanticBridge: { readonly listening: boolean; readonly listeners: number };
}

/**
 * The content controller of M3 plus the dynamic-site pipeline around it.
 * M1-M3 code stays free of MutationObserver: this wrapper only decides when
 * the pipeline runs.
 *
 * - `enableAdaptation` (first run, profile/strength/site-settings change,
 *   manual refresh) is a full refresh: it supersedes whatever was queued, then
 *   (re)starts observing, or stops if the effective settings are disabled.
 * - `disableAdaptation` stops observing: a disabled page costs no observer.
 * - `analyze` only reads, but rewrites our sheet while doing so; the records
 *   that causes are drained.
 */
export function createDynamicContentController(
  doc: Document = document,
  analyzerOptions: Partial<AnalyzeDocumentOptions> = {},
  pipelineOptions: Partial<
    Pick<DynamicPipelineOptions, 'scheduler' | 'now' | 'budget' | 'createObserver'>
  > = {},
  semanticOptions: { readonly env?: FactsEnvironment } = {},
): DynamicContentController {
  const base = createContentController(doc, analyzerOptions, semanticOptions);
  let lastRequest: { url: string; settings: UserSettings } | null = null;

  // Native form validity changes without a mutation; the one event bridge M6 needs.
  const validity = createNativeValidityBridge(doc, (field) => dynamic.invalidate(field));

  const dynamic = createDynamicPipeline({
    doc,
    adaptation: base.incremental,
    fullRescan: () => {
      if (lastRequest) base.enableAdaptation(lastRequest.url, lastRequest.settings);
    },
    ...pipelineOptions,
  });

  return {
    ...base,
    dynamic,
    get semanticBridge() {
      return { listening: validity.listening, listeners: validity.listeners };
    },

    analyze(url, settings) {
      const result = base.analyze(url, settings);
      dynamic.drainOwnMutations();
      return result;
    },

    enableAdaptation(url, settings) {
      dynamic.discardPending();
      const result = base.enableAdaptation(url, settings);
      lastRequest = { url, settings };
      if (settings.enabled) dynamic.start();
      else dynamic.stop();
      if (settings.enabled && settings.semanticCuesEnabled) validity.start();
      else validity.stop();
      dynamic.drainOwnMutations();
      return result;
    },

    disableAdaptation() {
      validity.stop();
      dynamic.stop();
      lastRequest = null;
      base.disableAdaptation();
    },
  };
}
