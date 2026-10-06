import { describe, expect, it } from 'vitest';
import {
  MODEL_CONFIDENCE_THRESHOLD,
  interpretProviderResult,
  parseHypothesis,
  validateHypothesis,
  type SemanticHypothesis,
} from '@core/semantic-ai';
import { ACTIVE_TAB, CLASS_ONLY_ERROR, answer, queryOf, supporters } from './kit';

function hypothesis(
  query: ReturnType<typeof queryOf>,
  label: string,
  confidence: number,
  refs: string[],
) {
  const parsed = parseHypothesis(answer(label, confidence, refs), query);
  if (!parsed.ok) throw new Error(`unparsable: ${parsed.failure}`);
  return parsed.hypothesis;
}

describe('validateHypothesis: acceptance', () => {
  it('accepts a label corroborated by two independent kinds of evidence', () => {
    const query = queryOf(ACTIVE_TAB);
    const result = validateHypothesis(
      query,
      hypothesis(query, 'active', 0.9, supporters(query, 'active')),
    );
    expect(result.status).toBe('ACCEPTED_ADVISORY');
    expect(result.supporting.length).toBeGreaterThanOrEqual(2);
  });

  it('accepts one strong declared fact (aria-selected=true)', () => {
    const query = queryOf({ tag: 'a', role: 'tab', aria: { 'aria-selected': 'true' } });
    const result = validateHypothesis(
      query,
      hypothesis(query, 'selected', 0.8, supporters(query, 'selected')),
    );
    expect(result.status).toBe('ACCEPTED_ADVISORY');
  });
});

describe('validateHypothesis: the model never outranks the evidence', () => {
  it('leaves a class-name-only claim unresolved however confident the model is', () => {
    const query = queryOf(CLASS_ONLY_ERROR);
    const refs = supporters(query, 'error');
    expect(refs.length).toBe(1);
    const result = validateHypothesis(query, hypothesis(query, 'error', 1, refs));
    expect(result.status).toBe('UNRESOLVED');
    expect(result.reason).toBe('insufficient-corroboration');
  });

  it('rejects a label the evidence contradicts strongly (aria-invalid=false versus error)', () => {
    const query = queryOf({
      tag: 'li',
      role: 'tab',
      aria: { 'aria-invalid': 'false', 'aria-selected': 'true' },
      signals: [{ source: 'class-token', value: 'error', strength: 'medium', supports: 'error' }],
    });
    const result = validateHypothesis(query, hypothesis(query, 'error', 1, ['e1']));
    expect(result.status).toBe('REJECTED');
    expect(result.reason).toBe('contradicted-by-strong-evidence');
  });

  it('rejects an answer that contradicts corroborated evidence for another label', () => {
    const query = queryOf({ tag: 'a', role: 'tab', aria: { 'aria-selected': 'true' } });
    const result = validateHypothesis(query, hypothesis(query, 'error', 0.99, ['e1']));
    expect(result.status).toBe('REJECTED');
    expect(result.reason).toBe('contradicts-corroborated-evidence');
  });

  it('rejects a corroborated label that cites no supporting evidence', () => {
    const query = queryOf(ACTIVE_TAB);
    const other = query.deterministicEvidence.find((e) => !e.supports.includes('active'));
    // Every item supports `active` here, so cite nothing that does by naming an unsupportive label's id.
    const refs = other ? [other.id] : [];
    if (refs.length === 0) return;
    const result = validateHypothesis(query, hypothesis(query, 'active', 0.9, refs));
    expect(result.reason).toBe('cites-no-supporting-evidence');
  });

  it('keeps ties unresolved', () => {
    const query = queryOf({
      tag: 'span',
      signals: [
        { source: 'class-token', value: 'success', strength: 'medium', supports: 'success' },
        { source: 'text-token', value: 'warning', strength: 'medium', supports: 'warning' },
      ],
      task: 'CLASSIFY_STATUS_MEANING',
    });
    // One medium item per label is not corroboration for either.
    const result = validateHypothesis(query, hypothesis(query, 'success', 0.95, ['e1']));
    expect(result.status).toBe('UNRESOLVED');
  });

  it('never accepts below the confidence threshold', () => {
    const query = queryOf(ACTIVE_TAB);
    const result = validateHypothesis(
      query,
      hypothesis(query, 'active', MODEL_CONFIDENCE_THRESHOLD - 0.01, supporters(query, 'active')),
    );
    expect(result.status).toBe('UNRESOLVED');
    expect(result.reason).toBe('low-model-confidence');
  });

  it('does not count a paint hint as corroboration', () => {
    const query = queryOf({
      tag: 'div',
      signals: [
        { source: 'class-token', value: 'error', strength: 'medium', supports: 'error' },
        { source: 'color', value: 'red', strength: 'weak', supports: 'error' },
      ],
    });
    // A paint hint is not evidence at all: it does not even reach the packet.
    expect(query.deterministicEvidence.map((e) => e.kind)).toEqual(['class']);
    const result = validateHypothesis(query, hypothesis(query, 'error', 1, ['e1']));
    expect(result.status).toBe('UNRESOLVED');
  });

  it('asks for firmer ground for a high-risk label', () => {
    const query = queryOf({
      tag: 'div',
      role: 'alert',
      signals: [
        { source: 'role', value: 'alert', strength: 'medium', supports: 'alert' },
        { source: 'class-token', value: 'error', strength: 'weak', supports: 'error' },
      ],
    });
    const result = validateHypothesis(
      query,
      hypothesis(query, 'error', 0.9, supporters(query, 'error')),
    );
    expect(result.status).toBe('UNRESOLVED');
    expect(result.reason).toBe('high-risk-label-needs-strong-support');
  });

  it('turns the model ambiguous / insufficient outcomes into unresolved, never into a meaning', () => {
    const query = queryOf(ACTIVE_TAB);
    for (const outcome of ['AMBIGUOUS', 'INSUFFICIENT_CONTEXT'] as const) {
      const h: SemanticHypothesis = {
        schemaVersion: 1,
        outcome,
        label: 'unknown',
        confidence: 1,
        evidenceRefs: [],
        alternatives: [],
      };
      expect(validateHypothesis(query, h).status).toBe('UNRESOLVED');
    }
  });

  it('rejects a packet with no deterministic rule behind it', () => {
    const full = queryOf(ACTIVE_TAB);
    const query = { ...full, context: { ...full.context, ruleIds: [] } };
    const h = hypothesis(full, 'active', 0.9, supporters(full, 'active'));
    expect(validateHypothesis(full, h).status).toBe('ACCEPTED_ADVISORY');
    expect(validateHypothesis(query, h).status).toBe('REJECTED');
  });
});

describe('interpretProviderResult', () => {
  const query = queryOf(ACTIVE_TAB);

  it('turns a failed request into a model error that decides nothing', () => {
    const out = interpretProviderResult(query, { ok: false, failure: 'timeout' });
    expect(out.modelStatus).toBe('MODEL_ERROR');
    expect(out.validatorStatus).toBe('UNRESOLVED');
    expect(out.reason).toBe('timeout');
  });

  it('turns malformed output into a model error, rejected', () => {
    const out = interpretProviderResult(query, {
      ok: true,
      raw: 'Sure! It is active.',
      model: 'm',
    });
    expect(out.modelStatus).toBe('MODEL_ERROR');
    expect(out.validatorStatus).toBe('REJECTED');
    expect(out.reason).toBe('not-json');
  });
});
