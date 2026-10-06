import { describe, expect, it } from 'vitest';
import { SEMANTIC_LIMITS, parseHypothesis } from '@core/semantic-ai';
import { ACTIVE_TAB, answer, queryOf, supporters } from './kit';

const query = queryOf(ACTIVE_TAB);
const refs = supporters(query, 'active');
const good = (extra: Record<string, unknown> = {}) => answer('active', 0.9, refs, extra);

describe('parseHypothesis', () => {
  it('accepts exactly the documented shape', () => {
    const parsed = parseHypothesis(good(), query);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.hypothesis.label).toBe('active');
      expect(parsed.hypothesis.alternatives).toEqual([]);
    }
  });

  it('does not require the model to echo the schema version, but refuses a wrong one', () => {
    const { schemaVersion: _version, ...bare } = JSON.parse(good()) as Record<string, unknown>;
    expect(parseHypothesis(JSON.stringify(bare), query).ok).toBe(true);
    const parsed = parseHypothesis(JSON.stringify(bare), query);
    if (parsed.ok) expect(parsed.hypothesis.schemaVersion).toBe(1);
    expect(parseHypothesis(JSON.stringify({ ...bare, schemaVersion: '1' }), query).ok).toBe(false);
  });

  it('accepts alternatives within the label space', () => {
    const parsed = parseHypothesis(
      good({ alternatives: [{ label: 'selected', confidence: 0.3 }] }),
      query,
    );
    expect(parsed.ok).toBe(true);
  });

  const reject: [string, unknown, string][] = [
    ['prose', 'It is probably active.', 'not-json'],
    ['a fenced block', '```json\n' + good() + '\n```', 'not-json'],
    ['an array', '[1]', 'not-an-object'],
    ['null', 'null', 'not-an-object'],
    ['an executable field', good({ action: 'applyCss' }), 'unknown-field'],
    ['a compliance verdict', good({ compliant: true }), 'unknown-field'],
    ['a polluting key', '{"__proto__":{"x":1},"schemaVersion":1}', 'unknown-field'],
    [
      'a wrong version',
      JSON.stringify({ ...JSON.parse(good()), schemaVersion: 2 }),
      'bad-schema-version',
    ],
    [
      'a forged outcome',
      JSON.stringify({ ...JSON.parse(good()), outcome: 'WCAG_FAIL' }),
      'bad-outcome',
    ],
    ['a label outside the task', answer('compliant', 0.9, refs), 'bad-label'],
    ['a label of another task', answer('close', 0.9, refs), 'bad-label'],
    ['unknown with a supported outcome', answer('unknown', 0.9, refs), 'bad-label'],
    ['confidence above 1', answer('active', 1.5, refs), 'bad-confidence'],
    ['negative confidence', answer('active', -0.1, refs), 'bad-confidence'],
    [
      'string confidence',
      JSON.stringify({ ...JSON.parse(good()), confidence: '1' }),
      'bad-confidence',
    ],
    ['an invented evidence id', answer('active', 0.9, ['e99']), 'unknown-evidence-ref'],
    ['an out-of-range evidence id', answer('active', 0.9, ['e999']), 'bad-evidence-refs'],
    ['a malformed evidence id', answer('active', 0.9, ['x1']), 'bad-evidence-refs'],
    [
      'a repeated evidence id',
      answer('active', 0.9, [refs[0] ?? 'e1', refs[0] ?? 'e1']),
      'bad-evidence-refs',
    ],
    ['no evidence for a supported label', answer('active', 0.9, []), 'bad-evidence-refs'],
    [
      'an alternative outside the space',
      good({ alternatives: [{ label: 'close', confidence: 0.1 }] }),
      'bad-alternatives',
    ],
    [
      'an alternative equal to the label',
      good({ alternatives: [{ label: 'active', confidence: 0.1 }] }),
      'bad-alternatives',
    ],
    [
      'an alternative with extra fields',
      good({ alternatives: [{ label: 'selected', confidence: 0.1, why: 'x' }] }),
      'bad-alternatives',
    ],
    [
      'too many alternatives',
      good({
        alternatives: Array.from({ length: 4 }, () => ({ label: 'selected', confidence: 0.1 })),
      }),
      'bad-alternatives',
    ],
    [
      'an oversized answer',
      good({ padding: 'x'.repeat(SEMANTIC_LIMITS.outputChars) }),
      'too-large',
    ],
  ];
  it.each(reject)('rejects %s', (_name, raw, failure) => {
    const parsed = parseHypothesis(raw, query);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.failure).toBe(failure);
  });

  it('requires the unknown label for a non-supported outcome', () => {
    const ambiguous = JSON.stringify({
      schemaVersion: 1,
      outcome: 'AMBIGUOUS',
      label: 'unknown',
      confidence: 0.2,
      evidenceRefs: [],
    });
    expect(parseHypothesis(ambiguous, query).ok).toBe(true);
    const bad = JSON.stringify({ ...JSON.parse(ambiguous), label: 'active' });
    expect(parseHypothesis(bad, query).ok).toBe(false);
  });

  it('accepts an already-parsed object under the same rules', () => {
    expect(parseHypothesis(JSON.parse(good()), query).ok).toBe(true);
    expect(parseHypothesis({ ...JSON.parse(good()), extra: 1 }, query).ok).toBe(false);
    expect(parseHypothesis(undefined, query).ok).toBe(false);
  });
});
