import { describe, expect, it } from 'vitest';
import { stateWordsIn } from '@core/semantics';
import {
  INSTRUCTION_VERSION,
  MODEL_CONFIDENCE_THRESHOLD,
  SEMANTIC_LIMITS,
  SemanticCache,
  VALIDATOR_STATUSES,
  buildSemanticQuery,
  cacheKey,
  iconLabelsIn,
  interpretProviderResult,
  parseHypothesis,
  validateHypothesis,
  type Interpreted,
  type SemanticFacts,
} from '@core/semantic-ai';
import { ACTIVE_TAB, CLASS_ONLY_ERROR, answer, bound, queryOf, supporters } from './kit';

/**
 * M11.R1: the validator is the boundary. Whatever a model claims, with whatever confidence, the
 * outcome depends on the packet's deterministic evidence alone (docs/AI_SEMANTIC_ENGINE.md).
 */

const verdict = (
  overrides: Partial<SemanticFacts>,
  label: string,
  confidence: number,
  refs?: readonly string[],
) => {
  const query = queryOf(overrides);
  const cited = refs ?? supporters(query, label);
  const parsed = parseHypothesis(answer(label, confidence, cited), query);
  if (!parsed.ok) throw new Error(`parse: ${parsed.failure}`);
  return validateHypothesis(query, parsed.hypothesis);
};

const SELECTED_TAB = {
  tag: 'li',
  role: 'tab',
  aria: { 'aria-selected': 'true' },
  accessibleName: 'Overview',
};

describe('confidence floor', () => {
  it('is 0.6 and both sides of it behave', () => {
    expect(MODEL_CONFIDENCE_THRESHOLD).toBe(0.6);
    for (const [confidence, status] of [
      [0, 'UNRESOLVED'],
      [0.5, 'UNRESOLVED'],
      [0.5999, 'UNRESOLVED'],
      [0.6, 'ACCEPTED_ADVISORY'],
      [0.6001, 'ACCEPTED_ADVISORY'],
      [0.61, 'ACCEPTED_ADVISORY'],
      [0.9, 'ACCEPTED_ADVISORY'],
      [1, 'ACCEPTED_ADVISORY'],
    ] as const) {
      expect(verdict(SELECTED_TAB, 'selected', confidence).status, String(confidence)).toBe(status);
    }
    expect(verdict(SELECTED_TAB, 'selected', 0.5999).reason).toBe('low-model-confidence');
  });

  it('never substitutes for evidence: full confidence cannot lift an unsupported label', () => {
    for (const confidence of [0.6, 0.6001, 0.9, 1]) {
      // A class word alone, nothing at all, a label the evidence contradicts.
      expect(verdict(CLASS_ONLY_ERROR, 'error', confidence).status).not.toBe('ACCEPTED_ADVISORY');
      const contradicted = verdict(
        { ...SELECTED_TAB, aria: { 'aria-selected': 'false' } },
        'selected',
        confidence,
        ['e1'],
      );
      expect(contradicted.status).toBe('REJECTED');
    }
  });

  it('is applied after every evidence check, not instead of one', () => {
    // Low confidence on a rejected claim stays rejected; it is not downgraded to unresolved.
    const rejected = verdict(
      { ...SELECTED_TAB, aria: { 'aria-selected': 'false' } },
      'selected',
      0.1,
      ['e1'],
    );
    expect(rejected.status).toBe('REJECTED');
  });
});

describe('high-risk labels (error, unavailable, delete)', () => {
  const ICON = {
    task: 'CLASSIFY_CONTROL_ICON' as const,
    ruleId: 'CA-SVG-002',
    tag: 'button',
    interactive: true,
    colorRelation: 'not-compared' as const,
  };

  it('are not accepted on one medium fact, whatever the confidence', () => {
    for (const confidence of [0.6, 1]) {
      expect(verdict({ ...ICON, title: 'Delete this item' }, 'delete', confidence).status).toBe(
        'UNRESOLVED',
      );
      expect(verdict(CLASS_ONLY_ERROR, 'error', confidence).status).toBe('UNRESOLVED');
      expect(
        verdict(
          {
            tag: 'button',
            interactive: true,
            signals: [
              {
                source: 'class-token',
                value: 'is-disabled',
                strength: 'medium',
                supports: 'disabled',
              },
            ],
          },
          'unavailable',
          confidence,
        ).status,
      ).toBe('UNRESOLVED');
    }
  });

  it('are not accepted on a medium fact plus a weak one', () => {
    const result = verdict(
      {
        ...CLASS_ONLY_ERROR,
        role: 'alert',
        signals: [
          { source: 'class-token', value: 'error', strength: 'medium', supports: 'error' },
          { source: 'role', value: 'alert', strength: 'weak', supports: 'alert' },
        ],
      },
      'error',
      1,
    );
    expect(result.status).toBe('UNRESOLVED');
    expect(result.reason).toBe('high-risk-label-needs-strong-support');
  });

  it('are accepted on two independent medium facts, or one firm one', () => {
    expect(
      verdict(
        { ...ICON, title: 'Delete this item', classSegments: ['icon', 'delete'] },
        'delete',
        0.9,
      ).status,
    ).toBe('ACCEPTED_ADVISORY');
    expect(
      verdict({ tag: 'input', isField: true, aria: { 'aria-invalid': 'true' } }, 'error', 0.9)
        .status,
    ).toBe('ACCEPTED_ADVISORY');
  });

  it('are rejected when the page declares the opposite, at any confidence', () => {
    for (const confidence of [0.6, 1]) {
      const result = verdict(
        {
          role: 'tab',
          aria: { 'aria-invalid': 'false', 'aria-selected': 'true' },
          signals: [
            { source: 'class-token', value: 'is-error', strength: 'medium', supports: 'error' },
          ],
        },
        'error',
        confidence,
        ['e1', 'e2'],
      );
      expect(result.status).toBe('REJECTED');
    }
  });
});

describe('evidence independence and strength', () => {
  const sig = (
    source: string,
    value: string,
    supports: string,
    strength: 'strong' | 'medium' | 'weak' = 'medium',
  ) => ({
    source,
    value,
    supports,
    strength,
  });

  it('counts a class and a data-* token of the same word as one author habit', () => {
    const result = verdict(
      {
        task: 'CLASSIFY_STATUS_MEANING',
        tag: 'span',
        signals: [
          sig('class-token', 'is-success', 'success'),
          sig('data-token', 'state=success', 'success'),
        ],
      },
      'success',
      1,
    );
    expect(result.status).toBe('UNRESOLVED');
    expect(result.reason).toBe('insufficient-corroboration');
  });

  it('counts the visible words and the accessible name as one set of words', () => {
    const result = verdict(
      {
        task: 'CLASSIFY_STATUS_MEANING',
        tag: 'span',
        accessibleName: 'Error',
        signals: [sig('text-token', 'error', 'error')],
      },
      'error',
      1,
    );
    expect(result.status).toBe('UNRESOLVED');
  });

  it('counts a class and the words of the page as two groups', () => {
    const result = verdict(
      {
        task: 'CLASSIFY_STATUS_MEANING',
        tag: 'span',
        signals: [
          sig('class-token', 'is-success', 'success'),
          sig('text-token', 'success', 'success'),
        ],
      },
      'success',
      0.9,
    );
    expect(result.status).toBe('ACCEPTED_ADVISORY');
  });

  it('does not let weak page text become medium evidence in a packet', () => {
    const query = queryOf({
      task: 'CLASSIFY_STATUS_MEANING',
      tag: 'span',
      nearbyLabels: ['Error', 'Failed', 'Danger'],
      signals: [
        sig('class-token', 'is-error', 'error', 'weak'),
        sig('text-token', 'error', 'error', 'weak'),
      ],
    });
    for (const item of query.deterministicEvidence) {
      expect(item.strength, `${item.source}`).toBe('weak');
    }
    expect(
      verdict(
        { task: 'CLASSIFY_STATUS_MEANING', tag: 'span', nearbyLabels: ['Error', 'Failed'] },
        'error',
        1,
      ).status,
    ).not.toBe('ACCEPTED_ADVISORY');
  });

  it('keeps an M6 strength as it was: weak stays weak, medium stays medium', () => {
    for (const strength of ['weak', 'medium', 'strong'] as const) {
      const query = queryOf({
        task: 'CLASSIFY_STATUS_MEANING',
        tag: 'span',
        signals: [sig('class-token', 'is-error', 'error', strength)],
      });
      const item = query.deterministicEvidence.find((e) => e.source === 'class-token');
      expect(item?.strength).toBe(strength);
    }
  });

  it('never accepts an answer that cites no supporting evidence', () => {
    const query = queryOf(SELECTED_TAB);
    const other = query.deterministicEvidence.find((e) => !e.supports.includes('selected'));
    if (other) {
      const parsed = parseHypothesis(answer('selected', 1, [other.id]), query);
      if (parsed.ok) expect(validateHypothesis(query, parsed.hypothesis).status).toBe('REJECTED');
    }
    // evidenceRefs: [] is a parse failure for a supported hypothesis.
    expect(parseHypothesis(answer('selected', 1, []), query)).toEqual({
      ok: false,
      failure: 'bad-evidence-refs',
    });
  });
});

describe('rival readings', () => {
  it('does not accept selected while a firm declaration says unavailable', () => {
    const result = verdict(
      {
        ...SELECTED_TAB,
        aria: { 'aria-selected': 'true', 'aria-disabled': 'true' },
        interactive: true,
      },
      'selected',
      1,
    );
    expect(['UNRESOLVED', 'REJECTED']).toContain(result.status);
  });

  it('does not accept a softer reading over a firm one', () => {
    const result = verdict({ ...ACTIVE_TAB, aria: { 'aria-selected': 'true' } }, 'active', 1);
    expect(result.status).not.toBe('ACCEPTED_ADVISORY');
  });
});

describe('parser strictness', () => {
  const query = queryOf(SELECTED_TAB);
  const ref = query.deterministicEvidence[0]?.id ?? 'e1';
  const base = {
    schemaVersion: 1,
    outcome: 'SUPPORTED_HYPOTHESIS',
    label: 'selected',
    confidence: 0.9,
    evidenceRefs: [ref],
  };

  it('rejects everything that is not exactly the schema', () => {
    const bad: [string, unknown][] = [
      ['prose', 'The label is selected.'],
      ['prose around JSON', `Sure! ${JSON.stringify(base)}`],
      ['markdown fence', '```json\n' + JSON.stringify(base) + '\n```'],
      ['trailing prose', JSON.stringify(base) + ' Hope this helps'],
      ['array', [base]],
      ['unknown field', { ...base, reasoning: 'because' }],
      [
        '__proto__ field',
        JSON.parse(
          '{"__proto__":{"x":1},"outcome":"AMBIGUOUS","label":"unknown","confidence":0,"evidenceRefs":[]}',
        ),
      ],
      ['unknown label', { ...base, label: 'compliant' }],
      ['label of another task', { ...base, label: 'close' }],
      ['uppercase label', { ...base, label: 'SELECTED' }],
      ['unknown outcome', { ...base, outcome: 'CONFIRMED' }],
      ['duplicate refs', { ...base, evidenceRefs: [ref, ref] }],
      ['unknown ref', { ...base, evidenceRefs: [ref, 'e999'] }],
      ['ref with markup', { ...base, evidenceRefs: ['e1<script>'] }],
      ['numeric ref', { ...base, evidenceRefs: [1] }],
      [
        'too many refs',
        { ...base, evidenceRefs: Array.from({ length: 9 }, (_, i) => `e${i + 1}`) },
      ],
      ['negative confidence', { ...base, confidence: -0.0001 }],
      ['confidence above 1', { ...base, confidence: 1.0001 }],
      ['string confidence', { ...base, confidence: '0.9' }],
      ['null confidence', { ...base, confidence: null }],
      ['schema 2', { ...base, schemaVersion: 2 }],
      ['schema 0', { ...base, schemaVersion: 0 }],
      ['schema as string', { ...base, schemaVersion: '1' }],
      ['schema null', { ...base, schemaVersion: null }],
      ['abstention with a label', { ...base, outcome: 'AMBIGUOUS' }],
      [
        'alternative outside the labels',
        { ...base, alternatives: [{ label: 'compliant', confidence: 0.1 }] },
      ],
      [
        'alternative equal to the label',
        { ...base, alternatives: [{ label: 'selected', confidence: 0.1 }] },
      ],
      [
        'too many alternatives',
        {
          ...base,
          alternatives: Array.from({ length: 4 }, () => ({ label: 'active', confidence: 0.1 })),
        },
      ],
      [
        'alternative with extra field',
        { ...base, alternatives: [{ label: 'active', confidence: 0.1, why: 'x' }] },
      ],
      ['empty string', ''],
      ['null', 'null'],
      ['number', '7'],
    ];
    for (const [name, raw] of bad) {
      expect(parseHypothesis(raw, query).ok, name).toBe(false);
    }
  });

  it('treats a missing schemaVersion as the current one (the product owns the version), and only that', () => {
    const { schemaVersion: _omitted, ...without } = base;
    const parsed = parseHypothesis(without, query);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.hypothesis.schemaVersion).toBe(1);
    expect(parseHypothesis({ ...without, schemaVersion: 2 }, query)).toEqual({
      ok: false,
      failure: 'bad-schema-version',
    });
    // A provider answering "version 2" is an error, never a best-effort reading of version 1.
    const interpreted = interpretProviderResult(query, {
      ok: true,
      raw: { ...base, schemaVersion: 2 },
      model: 'm',
    });
    expect(interpreted).toMatchObject({ modelStatus: 'MODEL_ERROR', reason: 'bad-schema-version' });
  });

  it('bounds the output at exactly 1024 characters', () => {
    const pad = (n: number): string => {
      const core = JSON.stringify(base);
      return core + ' '.repeat(n - core.length);
    };
    expect(SEMANTIC_LIMITS.outputChars).toBe(1024);
    expect(parseHypothesis(pad(1023), query).ok).toBe(true);
    expect(parseHypothesis(pad(1024), query).ok).toBe(true);
    expect(parseHypothesis(pad(1025), query)).toEqual({ ok: false, failure: 'too-large' });
    expect(parseHypothesis('x'.repeat(10_000_000), query)).toEqual({
      ok: false,
      failure: 'too-large',
    });
    // A structured value is measured by its serialization.
    expect(parseHypothesis({ ...base, alternatives: [], filler: 'x'.repeat(2000) }, query).ok).toBe(
      false,
    );
  });

  it('fails closed on a value that cannot be serialized', () => {
    const cyclic: Record<string, unknown> = { ...base };
    cyclic.self = cyclic;
    expect(parseHypothesis(cyclic, query).ok).toBe(false);
    expect(parseHypothesis(undefined, query).ok).toBe(false);
    expect(parseHypothesis(() => 1, query).ok).toBe(false);
  });
});

describe('closed vocabularies: no confirmation, no fix, no verdict', () => {
  it('validator statuses are exactly the advisory ones', () => {
    expect([...VALIDATOR_STATUSES]).toEqual(['ACCEPTED_ADVISORY', 'REJECTED', 'UNRESOLVED']);
  });
});

describe('vocabulary boundaries: a word inside another word is not that word', () => {
  it.each([
    ['closet', []],
    ['Close', ['close']],
    ['disclosed', []],
    ['userland', []],
    ['User Guide', ['user']],
    ['undelete', []],
    ['deleted items', []],
    ['homepage', []],
    ['homeless', []],
    ['search-box', ['search']],
    ['searchable', []],
    ['edited', []],
    ['addition', []],
    ['bin', ['delete']],
    ['binary', []],
    ['starship', []],
    ['like', ['favorite']],
    ['unlike', []],
    ['закрыть', ['close']],
    ['закрытие', ['close']],
    ['закрытый', []],
    ['незакрыть', []],
    ['поиск', ['search']],
    ['поисковик', []],
    ['удалить', ['delete']],
    ['неудалить', []],
    ['удаленный', []],
    ['профиль', ['user']],
    ['профилактика', []],
    ['домой', ['home']],
    ['домовой', []],
    ['корзина', ['delete']],
    ['корзинка', []],
  ])('%j → %j', (text, labels) => {
    expect(iconLabelsIn(text).sort()).toEqual([...labels].sort());
  });

  it.each([
    ['error', ['error']],
    ['errorless', []],
    ['terror', []],
    ['interactive', []],
    ['hyperactive', []],
    ['ошибка', ['error']],
    ['ошибочный', []],
    ['радиоактивный', []],
  ])('state words of %j → %j', (text, states) => {
    const found = stateWordsIn(text) as readonly string[];
    for (const state of states) expect(found).toContain(state);
    if (states.length === 0) expect(found).toEqual([]);
  });
});

describe('cache', () => {
  const sample = (n = 0): Interpreted => ({
    modelStatus: 'AMBIGUOUS',
    validatorStatus: 'UNRESOLVED',
    reason: 'model-ambiguous',
    hypothesis: null,
    validation: null,
    ...(n < 0 ? {} : {}),
  });

  it('holds 256 entries and evicts the least recently used at 257', () => {
    const cache = new SemanticCache();
    for (let i = 0; i < 255; i += 1) cache.set(`k${i}`, sample());
    expect(cache.size).toBe(255);
    cache.set('k255', sample());
    expect(cache.size).toBe(256);
    expect(cache.get('k0')).toBeDefined(); // touched: now most recent
    cache.set('k256', sample());
    expect(cache.size).toBe(256);
    expect(cache.get('k1')).toBeUndefined();
    expect(cache.get('k0')).toBeDefined();
  });

  it('never exceeds its byte budget and refuses one entry larger than it', () => {
    const cache = new SemanticCache(256, 1000);
    const big: Interpreted = { ...sample(), reason: 'x'.repeat(2000) as never };
    cache.set('big', big);
    expect(cache.size).toBe(0);
    for (let i = 0; i < 50; i += 1) cache.set(`k${i}`, sample());
    expect(cache.bytes).toBeLessThanOrEqual(1000);
    expect(SEMANTIC_LIMITS.cacheBytes).toBe(262_144);
    expect(SEMANTIC_LIMITS.cacheEntries).toBe(256);
  });

  it('is keyed by provider, model, task, packet, schema and instruction version', () => {
    const base = cacheKey('local-ollama', 'llama3.2:3b', 'CLASSIFY_UI_STATE', 'abc');
    expect(cacheKey('local-http', 'llama3.2:3b', 'CLASSIFY_UI_STATE', 'abc')).not.toBe(base);
    expect(cacheKey('local-ollama', 'qwen2.5:7b-instruct', 'CLASSIFY_UI_STATE', 'abc')).not.toBe(
      base,
    );
    expect(cacheKey('local-ollama', null, 'CLASSIFY_UI_STATE', 'abc')).not.toBe(base);
    expect(cacheKey('local-ollama', 'llama3.2:3b', 'CLASSIFY_STATUS_MEANING', 'abc')).not.toBe(
      base,
    );
    expect(cacheKey('local-ollama', 'llama3.2:3b', 'CLASSIFY_UI_STATE', 'abd')).not.toBe(base);
    expect(base).toContain(`|i${INSTRUCTION_VERSION}`);
    expect(base).toMatch(/\|v1\|/);
  });

  it('holds interpretations only: no prompt, no packet, no raw answer, no URL', () => {
    const cache = new SemanticCache();
    const built = bound(ACTIVE_TAB);
    const interpreted = interpretProviderResult(built.query, {
      ok: true,
      raw: answer('active', 0.9, supporters(built.query, 'active')),
      model: 'm',
    });
    cache.set('k', interpreted);
    const text = JSON.stringify(cache.get('k'));
    for (const forbidden of [
      'instructions',
      'PAYLOAD',
      'allowedLabels',
      'http://',
      'https://',
      'deterministicEvidence',
    ])
      expect(text).not.toContain(forbidden);
    expect(buildSemanticQuery).toBeTypeOf('function');
  });
});
