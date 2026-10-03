import { meetsAutoCueThreshold } from './confidence';
import { selectCue } from './cue-selector';
import type {
  CueDecision,
  ColorOnlyVerdict,
  ElementKind,
  ExistingCues,
  SemanticResult,
} from './types';

export interface CueDecisionInput {
  readonly result: SemanticResult;
  readonly kind: ElementKind;
  /** Length of the element's visible text (an underline is only drawn under short labels). */
  readonly textLength: number;
  readonly existing: ExistingCues;
  /** Evaluated lazily: comparing styles with peers is the expensive step. */
  readonly assessColorOnly: () => ColorOnlyVerdict;
  /** `settings.semanticCuesEnabled` */
  readonly enabled: boolean;
}

/**
 * The automation policy (docs/SEMANTIC_ACCESSIBILITY.md, "Automation policy"):
 *
 * ```
 * HIGH confidence + color-only confirmed + a safe placement   -> cue
 * MEDIUM / LOW                                                -> reported (colorOnly), no cue
 * unknown / conflict                                          -> no cue
 * ```
 *
 * It decides; it never touches the DOM.
 */
export function decideCue(input: CueDecisionInput): CueDecision {
  const { result } = input;
  if (!input.enabled) return { action: 'none', reason: 'disabled-by-settings' };
  if (result.status === 'conflict') return { action: 'none', reason: 'conflict' };
  if (result.status === 'unknown') return { action: 'none', reason: 'unknown' };

  const selection = selectCue(result.state, input.kind, input.existing, input.textLength);
  if (selection.kind === 'none') return { action: 'none', reason: selection.reason };

  const verdict = input.assessColorOnly();
  if (!meetsAutoCueThreshold(result.confidence)) {
    return {
      action: 'none',
      reason: 'below-threshold',
      detail: result.confidence,
      colorOnly: verdict.colorOnly,
    };
  }
  if (!verdict.colorOnly) {
    return {
      action: 'none',
      reason: 'not-color-only',
      detail: `${verdict.reason}${verdict.detail ? `:${verdict.detail}` : ''}`,
      colorOnly: false,
    };
  }
  return {
    action: 'cue',
    plan: {
      owner: 'coloradapt-semantic',
      state: result.state,
      confidence: result.confidence,
      cue: selection.spec,
      reason: `${result.state} (${result.confidence}); color-only by ${verdict.basis}`,
    },
  };
}
