import { createBackgroundResolutionCache, decideElement, isCandidateTag } from '@core/analysis';
import { calculateContrast } from '@core/color';
import { CONTRAST_THRESHOLDS } from '@core/conflicts';
import { hexOf, isLargeTextStyle } from '@core/audit';
import { isSvgElement } from '@core/svg';
import { isRendered } from './rendered';

export { CORE_ANALYZER_SELECTOR } from '@core/analysis';

/**
 * Debug-only: why does (or does not) the text of one element become a CA-COLOR-001 finding?
 *
 * It replays the *same* decision functions the audit uses (`decideElement` for discovery, visibility, own
 * text, colors; the collector's disabled and large-text rules; `evaluateText`'s ratio comparison) and names the
 * first stage that ends the element's path. Nothing in the product calls it: it exists for the real-world
 * harness (M10.R1, bundled and injected into a page) and for tests, so production pays nothing and no verbose
 * trace reaches the UI. It reads the page only through `getComputedStyle` and never writes.
 */
export type TraceStage = 'DISCOVERED' | 'VISIBLE' | 'RESOLVED' | 'EVALUATED' | 'FAILED_THRESHOLD';

export type TraceReason =
  | 'NOT_A_CANDIDATE'
  | 'INSIDE_SVG_UNIT'
  | 'NO_OWN_TEXT'
  | 'SKIP_HIDDEN'
  | 'SKIP_NOT_RENDERED'
  | 'NO_PARSEABLE_COLOR'
  | 'SKIP_DISABLED'
  | 'UNRESOLVED_BACKGROUND'
  | 'PARTIAL_BACKGROUND'
  | 'PASS_CONTRAST'
  | 'REPORTED';

export interface TextTrace {
  /** The last stage the element reached. */
  readonly stage: TraceStage;
  readonly reason: TraceReason;
  /** `true` only for `REPORTED`: the audit emits CA-COLOR-001 for this element. */
  readonly reported: boolean;
  readonly tag: string;
  readonly foreground: string | null;
  readonly background: string | null;
  readonly ratio: number | null;
  readonly target: number | null;
  readonly largeText: boolean | null;
  readonly fontSizePx: number | null;
  readonly fontWeight: string | null;
  readonly backgroundKind: string | null;
}

const EMPTY = {
  foreground: null,
  background: null,
  ratio: null,
  target: null,
  largeText: null,
  fontSizePx: null,
  fontWeight: null,
  backgroundKind: null,
} as const;

export function traceTextElement(
  element: Element,
  getStyle: (el: Element) => CSSStyleDeclaration = (el) => getComputedStyle(el),
  /** The pre-M10.R1 selector replays the old decision (the real-world harness); `null`: the current rule. */
  selector: string | null = null,
): TextTrace {
  const tag = element.localName;
  const stop = (
    stage: TraceStage,
    reason: TraceReason,
    extra: Partial<TextTrace> = {},
  ): TextTrace => ({
    stage,
    reason,
    reported: reason === 'REPORTED',
    tag,
    ...EMPTY,
    ...extra,
  });
  if (isSvgElement(element)) return stop('DISCOVERED', 'INSIDE_SVG_UNIT');
  if (selector === null ? !isCandidateTag(element) : !element.matches(selector)) {
    return stop('DISCOVERED', 'NOT_A_CANDIDATE');
  }

  const decision = decideElement(element, getStyle, createBackgroundResolutionCache(), () => '');
  if (typeof decision === 'string') {
    switch (decision) {
      case 'wrapper-without-own-text':
        return stop('DISCOVERED', 'NO_OWN_TEXT');
      case 'not-visible':
        return stop('DISCOVERED', 'SKIP_HIDDEN');
      case 'no-parseable-color':
        return stop('VISIBLE', 'NO_PARSEABLE_COLOR');
    }
  }
  // the collector's order: a descriptor, then "is it painted", then text and disabled
  if (!isRendered(element, getStyle)) return stop('VISIBLE', 'SKIP_NOT_RENDERED');
  if (!decision.hasTextContent) return stop('RESOLVED', 'NO_OWN_TEXT');
  const style = getStyle(element);
  const largeText = isLargeTextStyle(style.fontSize, style.fontWeight);
  const details = {
    foreground: hexOf(decision.colorPair.foreground),
    background: hexOf(decision.colorPair.background),
    largeText,
    fontSizePx: Number.parseFloat(style.fontSize),
    fontWeight: style.fontWeight,
    backgroundKind: decision.backgroundKind,
  };
  if (decision.disabled) return stop('RESOLVED', 'SKIP_DISABLED', details);
  if (decision.analysisStatus !== 'resolved') {
    return stop(
      'RESOLVED',
      decision.analysisStatus === 'partial' ? 'PARTIAL_BACKGROUND' : 'UNRESOLVED_BACKGROUND',
      details,
    );
  }
  const ratio = calculateContrast(decision.colorPair.foreground, decision.colorPair.background);
  const target = largeText ? CONTRAST_THRESHOLDS.aaLargeText : CONTRAST_THRESHOLDS.aaNormalText;
  const evaluated = { ...details, ratio, target };
  return ratio < target
    ? stop('FAILED_THRESHOLD', 'REPORTED', evaluated)
    : stop('EVALUATED', 'PASS_CONTRAST', evaluated);
}
