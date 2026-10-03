import { describe, expect, it } from 'vitest';
import {
  AUTO_CUE_MIN_CONFIDENCE,
  classifyElement,
  meetsAutoCueThreshold,
  resolveSemantics,
  type SemanticEvidence,
} from '@core/semantics';
import { facts } from './helpers';

const classify = (f = facts()) => classifyElement(f);

describe('M6 classification: confidence boundaries', () => {
  it('strong evidence alone is HIGH', () => {
    expect(classify(facts({ aria: { 'aria-invalid': 'true' } }))).toMatchObject({
      status: 'classified',
      state: 'invalid',
      confidence: 'high',
    });
  });

  it('one class token is MEDIUM; one data token is MEDIUM', () => {
    expect(classify(facts({ classTokens: ['error'] }))).toMatchObject({
      state: 'error',
      confidence: 'medium',
    });
    expect(
      classify(facts({ dataValues: [{ name: 'data-state', value: 'success' }] })),
    ).toMatchObject({ state: 'success', confidence: 'medium' });
  });

  it('a class and a data token are one author habit: still MEDIUM', () => {
    expect(
      classify(
        facts({ classTokens: ['error'], dataValues: [{ name: 'data-state', value: 'error' }] }),
      ),
    ).toMatchObject({ confidence: 'medium' });
  });

  it('two independent kinds of evidence (class + visible word) are HIGH', () => {
    expect(classify(facts({ classTokens: ['error'], text: 'Failed' }))).toMatchObject({
      state: 'error',
      confidence: 'high',
    });
  });

  it('a component class next to a state class is HIGH (badge success), a bare state class is not', () => {
    expect(classify(facts({ classTokens: ['badge', 'success'] }))).toMatchObject({
      state: 'success',
      confidence: 'high',
    });
    expect(classify(facts({ classTokens: ['success'] }))).toMatchObject({ confidence: 'medium' });
    expect(classify(facts({ classTokens: ['status', 'online'] }))).toMatchObject({
      state: 'online',
      confidence: 'high',
    });
  });

  it('role=alert corroborates error/warning only', () => {
    expect(classify(facts({ role: 'alert', classTokens: ['error'] }))).toMatchObject({
      state: 'error',
      confidence: 'high',
    });
    expect(classify(facts({ role: 'alert', classTokens: ['success'] }))).toMatchObject({
      state: 'success',
      confidence: 'medium',
    });
    expect(classify(facts({ role: 'status', classTokens: ['success'] }))).toMatchObject({
      state: 'success',
      confidence: 'high',
    });
  });

  it('text alone is LOW; color corroboration lifts LOW to MEDIUM and never to HIGH', () => {
    expect(classify(facts({ text: 'Error' }))).toMatchObject({ state: 'error', confidence: 'low' });
    expect(classify(facts({ text: 'Error', colorHint: 'red' }))).toMatchObject({
      confidence: 'medium',
    });
    expect(classify(facts({ classTokens: ['error'], colorHint: 'red' }))).toMatchObject({
      confidence: 'medium',
    });
  });

  it('the automation threshold is HIGH, defined in one place', () => {
    expect(AUTO_CUE_MIN_CONFIDENCE).toBe('high');
    expect(meetsAutoCueThreshold('high')).toBe(true);
    expect(meetsAutoCueThreshold('medium')).toBe(false);
    expect(meetsAutoCueThreshold('low')).toBe(false);
  });
});

describe('M6 classification: color alone never classifies (hard invariant)', () => {
  it.each(['red', 'green', 'yellow', 'blue'])('%s alone is unknown', (hint) => {
    const result = classify(facts({ colorHint: hint }));
    expect(result.status).toBe('unknown');
    expect(result).toMatchObject({ reason: 'weak-evidence-only' });
  });

  it('weak evidence from several sources is still unknown', () => {
    expect(classify(facts({ colorHint: 'red', idTokens: ['error'] })).status).toBe('unknown');
  });

  it('no evidence at all is unknown', () => {
    expect(classify(facts())).toMatchObject({ status: 'unknown', reason: 'no-evidence' });
  });

  it('a family hint alone (role=alert) does not pick a state', () => {
    expect(classify(facts({ role: 'alert' }))).toMatchObject({
      status: 'unknown',
      reason: 'family-only',
    });
  });

  it('property: for every combination of weak evidence the result is never classified', () => {
    const weak: SemanticEvidence[] = [
      { source: 'color', value: 'red', supports: 'error', strength: 'weak' },
      { source: 'color', value: 'green', supports: 'success', strength: 'weak' },
      { source: 'id-token', value: 'error', supports: 'error', strength: 'weak' },
      { source: 'id-token', value: 'success', supports: 'success', strength: 'weak' },
    ];
    for (let mask = 0; mask < 1 << weak.length; mask += 1) {
      const subset = weak.filter((_, i) => (mask & (1 << i)) !== 0);
      expect(resolveSemantics(subset).status).not.toBe('classified');
    }
  });
});

describe('M6 classification: conflicts are never guessed', () => {
  it('class=success with aria-invalid=true is a conflict, not a pick', () => {
    const result = classify(facts({ classTokens: ['success'], aria: { 'aria-invalid': 'true' } }));
    expect(result.status).toBe('conflict');
    expect(result).toMatchObject({ states: expect.arrayContaining(['success', 'invalid']) });
  });

  it('error and warning evidence together conflict; error and invalid agree', () => {
    expect(classify(facts({ classTokens: ['error', 'warning'] })).status).toBe('conflict');
    expect(
      classify(facts({ classTokens: ['error'], aria: { 'aria-invalid': 'true' } })),
    ).toMatchObject({ status: 'classified', confidence: 'high' });
  });

  it('online and offline conflict; selected and unselected conflict', () => {
    expect(classify(facts({ classTokens: ['online', 'offline'] })).status).toBe('conflict');
    expect(
      classify(
        facts({ role: 'tab', aria: { 'aria-selected': 'false' }, classTokens: ['selected'] }),
      ).status,
    ).toBe('conflict');
  });

  it('text that contradicts the class is a conflict', () => {
    expect(classify(facts({ classTokens: ['success'], text: 'Failed' })).status).toBe('conflict');
  });

  it('evidence in different dimensions does not conflict: the stronger one is the answer', () => {
    // A selected tab whose title happens to be "Information": the tab state wins (strong > medium).
    expect(
      classify(facts({ role: 'tab', aria: { 'aria-selected': 'true' }, text: 'Information' })),
    ).toMatchObject({ status: 'classified', state: 'selected', confidence: 'high' });
  });

  it('invalid beats required when a required field is also invalid', () => {
    expect(
      classify(facts({ aria: { 'aria-invalid': 'true' }, native: { required: true } })),
    ).toMatchObject({ state: 'invalid' });
  });
});
