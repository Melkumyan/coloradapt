import { parseHypothesis, type ParseFailure, type SemanticHypothesis } from './output';
import type { ProviderFailure, ProviderResult } from './provider';
import type { SemanticQuery } from './query';
import type { SemanticModelStatus, ValidatorStatus } from './taxonomy';
import { validateHypothesis, type ValidationResult, type ValidatorReason } from './validator';

/**
 * One provider answer, turned into what the product may know about it: pure, so a recorded answer
 * replays through exactly the code a live one takes (docs/AI_SEMANTIC_ENGINE.md, "Replay").
 */

export type InterpretedReason = ValidatorReason | ParseFailure | ProviderFailure;

export interface Interpreted {
  readonly modelStatus: SemanticModelStatus;
  readonly validatorStatus: ValidatorStatus;
  readonly reason: InterpretedReason;
  /** Present when the answer parsed. */
  readonly hypothesis: SemanticHypothesis | null;
  /** Present when the answer parsed and was validated. */
  readonly validation: ValidationResult | null;
}

export function interpretProviderResult(query: SemanticQuery, result: ProviderResult): Interpreted {
  if (!result.ok) {
    // No answer is not a wrong answer: the case stays exactly as unresolved as it was.
    return {
      modelStatus: 'MODEL_ERROR',
      validatorStatus: 'UNRESOLVED',
      reason: result.failure,
      hypothesis: null,
      validation: null,
    };
  }
  const parsed = parseHypothesis(result.raw, query);
  if (!parsed.ok) {
    return {
      modelStatus: 'MODEL_ERROR',
      validatorStatus: 'REJECTED',
      reason: parsed.failure,
      hypothesis: null,
      validation: null,
    };
  }
  const validation = validateHypothesis(query, parsed.hypothesis);
  return {
    modelStatus: parsed.hypothesis.outcome,
    validatorStatus: validation.status,
    reason: validation.reason,
    hypothesis: parsed.hypothesis,
    validation,
  };
}
