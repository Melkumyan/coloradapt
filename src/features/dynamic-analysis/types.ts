import type { AnalysisRoot } from '@core/analysis';
import type { FullRescanReason } from '@domain/models';

/** What a single mutation means for ColorAdapt. */
export type MutationKind =
  | 'NODE_ADDED'
  | 'NODE_REMOVED'
  | 'STYLE_AFFECTING_ATTRIBUTE'
  | 'TEXT_CHANGE'
  | 'STYLESHEET_CHANGE'
  | 'IRRELEVANT'
  | 'COLORADAPT_INTERNAL';

export type ClassifiedMutation =
  | { readonly kind: 'NODE_ADDED'; readonly element: Element }
  | { readonly kind: 'NODE_REMOVED'; readonly element: Element }
  | {
      readonly kind: 'STYLE_AFFECTING_ATTRIBUTE';
      readonly element: Element;
      readonly attribute: string;
    }
  /** The element whose own text eligibility may have changed. */
  | { readonly kind: 'TEXT_CHANGE'; readonly element: Element }
  | {
      readonly kind: 'STYLESHEET_CHANGE';
      /** A stylesheet `<link>` that has not loaded yet: rescan once it does. */
      readonly pendingLink?: HTMLLinkElement;
    }
  | { readonly kind: 'IRRELEVANT'; readonly reason: string }
  | { readonly kind: 'COLORADAPT_INTERNAL'; readonly stylesheetRemoved: boolean };

export interface ResolvedBatch {
  /** De-duplicated regions to re-analyze, in first-seen order. */
  readonly roots: readonly AnalysisRoot[];
  /** Detached elements whose adaptations must be dropped. */
  readonly removed: readonly Element[];
  /** Set when the batch cannot be handled region by region. */
  readonly fullRescan: FullRescanReason | null;
}

export type { DynamicDiagnostics, FullRescanReason, PipelineState } from '@domain/models';
