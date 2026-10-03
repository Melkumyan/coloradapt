import { describe, expect, it } from 'vitest';
import { collectEvidence, identifierSegments, stateWordsIn, tokenStates } from '@core/semantics';
import { facts } from './helpers';

const supports = (f = facts()) =>
  collectEvidence(f).map((e) => `${e.source}:${e.supports}:${e.strength}`);

describe('M6 evidence: ARIA', () => {
  it('aria-invalid="true" is strong evidence for invalid; "false" is no evidence at all', () => {
    expect(supports(facts({ aria: { 'aria-invalid': 'true' } }))).toEqual([
      'aria-invalid:invalid:strong',
    ]);
    expect(supports(facts({ aria: { 'aria-invalid': 'false' } }))).toEqual([]);
    expect(supports(facts({ aria: { 'aria-invalid': 'spelling' } }))).toEqual([
      'aria-invalid:invalid:strong',
    ]);
  });

  it('aria-selected is read only on roles where ARIA defines it', () => {
    expect(supports(facts({ role: 'tab', aria: { 'aria-selected': 'true' } }))).toEqual([
      'aria-selected:selected:strong',
    ]);
    expect(supports(facts({ role: 'tab', aria: { 'aria-selected': 'false' } }))).toEqual([
      'aria-selected:unselected:strong',
    ]);
    // A <div aria-selected> has no defined meaning: not claimed.
    expect(supports(facts({ role: null, aria: { 'aria-selected': 'true' } }))).toEqual([]);
  });

  it('aria-current (anything but false) is strong evidence for the current item', () => {
    expect(supports(facts({ aria: { 'aria-current': 'page' } }))).toEqual([
      'aria-current:active:strong',
    ]);
    expect(supports(facts({ aria: { 'aria-current': 'true' } }))).toEqual([
      'aria-current:active:strong',
    ]);
    expect(supports(facts({ aria: { 'aria-current': 'false' } }))).toEqual([]);
  });

  it('aria-disabled, aria-checked, aria-pressed, aria-required', () => {
    expect(supports(facts({ aria: { 'aria-disabled': 'true' } }))).toEqual([
      'aria-disabled:disabled:strong',
    ]);
    expect(supports(facts({ role: 'checkbox', aria: { 'aria-checked': 'true' } }))).toEqual([
      'aria-checked:selected:strong',
    ]);
    expect(supports(facts({ role: 'checkbox', aria: { 'aria-checked': 'mixed' } }))).toEqual([]);
    expect(supports(facts({ role: 'button', aria: { 'aria-pressed': 'true' } }))).toEqual([
      'aria-pressed:active:strong',
    ]);
    expect(supports(facts({ role: 'div', aria: { 'aria-pressed': 'true' } }))).toEqual([]);
    expect(supports(facts({ aria: { 'aria-required': 'true' } }))).toEqual([
      'aria-required:required:strong',
    ]);
  });

  it('role=alert is a strong hint of the alert family, role=status a medium hint of the status family', () => {
    expect(supports(facts({ role: 'alert' }))).toEqual(['role:alert:strong']);
    expect(supports(facts({ role: 'status' }))).toEqual(['role:status:medium']);
    expect(supports(facts({ aria: { 'aria-live': 'assertive' } }))).toEqual([
      'aria-live:alert:medium',
    ]);
  });
});

describe('M6 evidence: native form state', () => {
  it('required, disabled, an interacted-with invalid field, a selected multi-select option', () => {
    expect(supports(facts({ native: { required: true } }))).toEqual([
      'native-required:required:strong',
    ]);
    expect(supports(facts({ native: { disabled: true } }))).toEqual([
      'native-disabled:disabled:strong',
    ]);
    expect(supports(facts({ native: { invalid: true, nonPristine: true } }))).toEqual([
      'native-invalid:invalid:strong',
    ]);
    expect(supports(facts({ native: { selectedOption: true } }))).toEqual([
      'native-selected:selected:strong',
    ]);
  });

  it('a pristine invalid field (an untouched required input) is not evidence of invalid', () => {
    expect(supports(facts({ native: { invalid: true, nonPristine: false } }))).toEqual([]);
  });
});

describe('M6 evidence: class / data tokens', () => {
  it('matches whole identifier segments only', () => {
    expect(identifierSegments('has-error')).toEqual(['has', 'error']);
    expect(identifierSegments('badgeSuccess')).toEqual(['badge', 'success']);
    expect(supports(facts({ classTokens: ['has-error'] }))).toEqual(['class-token:error:medium']);
    expect(
      supports(facts({ classTokens: ['terror', 'successor', 'errorless', 'validate'] })),
    ).toEqual([]);
  });

  it('a control variant (btn-danger) and a negation (no-error, non-active) are not states', () => {
    expect(supports(facts({ classTokens: ['btn-danger'] }))).toEqual([]);
    expect(supports(facts({ classTokens: ['no-error', 'non-active', 'not-valid'] }))).toEqual([]);
    expect(
      supports(facts({ tag: 'a', role: 'link', isInteractive: true, classTokens: ['danger'] })),
    ).toEqual([]);
  });

  it('data-state / data-status values are tokenized the same way', () => {
    expect(supports(facts({ dataValues: [{ name: 'data-state', value: 'error' }] }))).toEqual([
      'data-token:error:medium',
    ]);
    expect(supports(facts({ dataValues: [{ name: 'data-selected', value: 'true' }] }))).toEqual([
      'data-token:selected:medium',
    ]);
    expect(supports(facts({ dataValues: [{ name: 'data-selected', value: 'false' }] }))).toEqual(
      [],
    );
  });

  it('an id token is weak evidence', () => {
    expect(supports(facts({ idTokens: ['form-error'] }))).toEqual(['id-token:error:weak']);
  });
});

describe('M6 evidence: words (English and Russian)', () => {
  it('short status texts name a state, in either language', () => {
    expect(stateWordsIn('Payment failed')).toEqual(['error']);
    expect(stateWordsIn('Success')).toEqual(['success']);
    expect(stateWordsIn('Ошибка')).toEqual(['error']);
    expect(stateWordsIn('Успешно')).toEqual(['success']);
    expect(stateWordsIn('Предупреждение')).toEqual(['warning']);
    expect(stateWordsIn('Недопустимо')).toEqual(['invalid']);
    expect(stateWordsIn('Online')).toEqual(['online']);
    expect(stateWordsIn('Офлайн')).toEqual(['offline']);
  });

  it('prose, negations and cut-off text name nothing', () => {
    expect(
      stateWordsIn('There was an error while saving your changes to the server today'),
    ).toEqual([]);
    expect(stateWordsIn('No errors')).toEqual([]);
    expect(stateWordsIn('Без ошибок')).toEqual([]);
    expect(stateWordsIn('Error', true)).toEqual([]);
  });

  it('text, accessible name, title and described-by text become evidence with their own source', () => {
    expect(supports(facts({ text: 'Failed' }))).toEqual(['text-token:error:medium']);
    expect(supports(facts({ labelText: 'Warning' }))).toEqual(['aria-label:warning:medium']);
    expect(supports(facts({ title: 'Ошибка' }))).toEqual(['title-token:error:medium']);
    expect(supports(facts({ describedByText: 'Invalid' }))).toEqual([
      'aria-describedby:invalid:medium',
    ]);
  });
});

describe('M6 evidence: color', () => {
  it('a color hint is recorded as weak evidence and nothing else', () => {
    expect(supports(facts({ colorHint: 'red' }))).toEqual(['color:error:weak']);
    expect(supports(facts({ colorHint: 'green' }))).toEqual(['color:success:weak']);
    expect(supports(facts({ colorHint: 'yellow' }))).toEqual(['color:warning:weak']);
  });

  it('every item carries its provenance', () => {
    const [item] = collectEvidence(facts({ aria: { 'aria-invalid': 'true' } }));
    expect(item).toEqual({
      source: 'aria-invalid',
      value: 'true',
      supports: 'invalid',
      strength: 'strong',
    });
  });
});

describe('M6.R1 token boundaries and attribute-token safety', () => {
  it('words that merely contain a state word, or use it as a topic, are not evidence', () => {
    for (const token of [
      'terror',
      'successor',
      'inactiveUser',
      'warningly',
      'invalidated',
      'errorless',
      'error-prone',
      'error-free-zone',
      'success-stories',
      'online-users',
      'warning-yellow',
      'danger-zone',
      'infographic',
      'valid8',
      'selectedness',
    ]) {
      expect(tokenStates(token), token).toEqual([]);
    }
  });

  it('a state word that ends the identifier, or is followed by a component word, is evidence', () => {
    expect(tokenStates('badge-success')).toEqual(['success']);
    expect(tokenStates('is-active')).toEqual(['active']);
    expect(tokenStates('hasError')).toEqual(['error']);
    expect(tokenStates('badgeSuccess')).toEqual(['success']);
    expect(tokenStates('alert--danger')).toEqual(['error']);
    expect(tokenStates('bg-danger-subtle')).toEqual(['error']);
    expect(tokenStates('error-message')).toEqual(['error']);
    expect(tokenStates('active-tab')).toEqual(['active']);
    expect(tokenStates('status:online')).toEqual(['online']);
  });

  it('a negated token is not evidence either way', () => {
    for (const token of ['not-error', 'non-active', 'no-error', 'un-valid', 'without-warning']) {
      expect(tokenStates(token), token).toEqual([]);
    }
  });

  it('only the intended data attributes carry state, and only an exact state word counts', () => {
    const evidence = (dataValues: { name: string; value: string }[]) =>
      collectEvidence(facts({ dataValues })).map((e) => `${e.source}:${e.supports}`);
    expect(evidence([{ name: 'data-state', value: 'error' }])).toEqual(['data-token:error']);
    expect(evidence([{ name: 'data-status', value: 'successful' }])).toEqual([
      'data-token:success',
    ]);
    expect(evidence([{ name: 'data-state', value: 'not-error' }])).toEqual([]);
    expect(evidence([{ name: 'data-state', value: 'error-prone' }])).toEqual([]);
    expect(evidence([{ name: 'data-theme', value: 'warning-yellow' }])).toEqual([]);
    expect(evidence([{ name: 'data-color', value: 'success' }])).toEqual([]);
    expect(evidence([{ name: 'data-selected', value: 'false' }])).toEqual([]);
  });

  it('negation in English and Russian cancels the state word; prose is not a status', () => {
    for (const text of [
      'No error',
      'No errors',
      'Without errors',
      'Never failed',
      'Не ошибка',
      'Без ошибок',
      'Нет ошибок',
      'Не удалось? Нет, успешно',
    ]) {
      expect(stateWordsIn(text), text).toEqual([]);
    }
    expect(stateWordsIn('Ошибка')).toEqual(['error']);
    expect(stateWordsIn('Успешно')).toEqual(['success']);
    expect(stateWordsIn('Error')).toEqual(['error']);
    expect(stateWordsIn('Error handling guide')).toEqual(['error']); // a title: LOW evidence, never applied
    expect(
      stateWordsIn('К сожалению, при загрузке страницы произошла ошибка, попробуйте позже'),
    ).toEqual([]);
  });
});
