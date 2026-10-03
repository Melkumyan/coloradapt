import { describe, expect, it } from 'vitest';
import {
  assessColorOnly,
  classifyElement,
  decideCue,
  detectExistingCues,
  selectCue,
  type ColorOnlyInput,
  type ExistingCues,
  type PeerFacts,
  type StyleSnapshot,
} from '@core/semantics';
import { facts } from './helpers';

const NO_CUES: ExistingCues = { cues: [], beforeBusy: false, afterBusy: false };

function style(
  paint: Record<string, string> = {},
  shape: Record<string, string> = {},
): StyleSnapshot {
  return {
    shape: {
      'font-weight': '400',
      'border-top-style': 'none',
      'text-decoration-line': 'none',
      ...shape,
    },
    paint: { color: 'rgb(0, 0, 0)', ...paint },
  };
}

function peer(overrides: Partial<PeerFacts> = {}): PeerFacts {
  return { state: null, style: style(), hasIcon: false, hasText: true, ...overrides };
}

function input(overrides: Partial<ColorOnlyInput> = {}): ColorOnlyInput {
  return {
    state: 'selected',
    style: style({ color: 'rgb(0, 0, 255)' }),
    existing: NO_CUES,
    hasText: true,
    kind: 'text',
    contrastingPeers: [],
    ...overrides,
  };
}

describe('M6 color-only detection', () => {
  it('same component, only color differs: color-only', () => {
    expect(assessColorOnly(input({ contrastingPeers: [peer()] }))).toEqual({
      colorOnly: true,
      basis: 'peer-comparison',
    });
  });

  it('color + icon differs: not color-only', () => {
    expect(assessColorOnly(input({ contrastingPeers: [peer({ hasIcon: true })] }))).toMatchObject({
      colorOnly: false,
      reason: 'structural-difference',
      detail: 'icon',
    });
  });

  it('color + text presence differs: not color-only', () => {
    expect(assessColorOnly(input({ contrastingPeers: [peer({ hasText: false })] }))).toMatchObject({
      colorOnly: false,
      reason: 'structural-difference',
      detail: 'text-presence',
    });
  });

  it('color + underline / weight / border style differs: not color-only', () => {
    for (const [name, value] of [
      ['text-decoration-line', 'underline'],
      ['font-weight', '700'],
      ['border-top-style', 'solid'],
    ] as const) {
      const verdict = assessColorOnly(
        input({
          style: style({ color: 'rgb(0, 0, 255)' }, { [name]: value }),
          contrastingPeers: [peer()],
        }),
      );
      expect(verdict).toMatchObject({
        colorOnly: false,
        reason: 'structural-difference',
        detail: name,
      });
    }
  });

  it('identical presentation: there is nothing to call color-only', () => {
    expect(assessColorOnly(input({ style: style(), contrastingPeers: [peer()] }))).toMatchObject({
      colorOnly: false,
      reason: 'no-visual-difference',
    });
  });

  it('any one peer with a structural difference decides: unknown beats a cue', () => {
    const verdict = assessColorOnly(
      input({ contrastingPeers: [peer(), peer({ style: style({}, { 'font-weight': '700' }) })] }),
    );
    expect(verdict).toMatchObject({ colorOnly: false, reason: 'structural-difference' });
  });

  it('no comparable element: only an empty sized box is color-only by construction', () => {
    expect(assessColorOnly(input({ kind: 'dot', hasText: false }))).toEqual({
      colorOnly: true,
      basis: 'no-content',
    });
    expect(assessColorOnly(input({ kind: 'text' }))).toMatchObject({
      colorOnly: false,
      reason: 'cannot-compare',
    });
    expect(assessColorOnly(input({ kind: 'control' }))).toMatchObject({ reason: 'cannot-compare' });
  });

  it('an existing cue on the element itself ends the question', () => {
    const verdict = assessColorOnly(
      input({
        kind: 'dot',
        hasText: false,
        existing: { cues: ['icon'], beforeBusy: false, afterBusy: false },
      }),
    );
    expect(verdict).toMatchObject({ colorOnly: false, reason: 'existing-cue', detail: 'icon' });
  });
});

describe('M6 existing cue detection', () => {
  const classified = (overrides = {}) => {
    const f = facts({ classTokens: ['badge', 'success'], ...overrides });
    return detectExistingCues(f, classifyElement(f));
  };

  it('nothing on the element: no cue, slots free', () => {
    expect(classified()).toEqual(NO_CUES);
  });

  it('an icon, page-drawn pseudo content, a symbol in the text', () => {
    expect(classified({ hasIcon: true }).cues).toContain('icon');
    expect(classified({ afterContent: true })).toMatchObject({
      cues: ['pseudo-content'],
      afterBusy: true,
      beforeBusy: false,
    });
    expect(classified({ text: '✓ Saved' }).cues).toContain('symbol-text');
    expect(classified({ text: '⚠ Disk almost full' }).cues).toContain('symbol-text');
  });

  it('visible text that names the state is a cue (a badge saying "Success")', () => {
    expect(classified({ text: 'Success' }).cues).toContain('state-text');
    expect(classified({ text: 'Успешно' }).cues).toContain('state-text');
    // Text that does not name the state is not.
    expect(classified({ text: 'Order 1234' }).cues).toEqual([]);
  });

  it('a required marker in a label', () => {
    const f = facts({ tag: 'label', native: { required: true }, text: 'Email *' });
    expect(detectExistingCues(f, classifyElement(f)).cues).toEqual(
      expect.arrayContaining(['marker-text']),
    );
    const plain = facts({ tag: 'label', native: { required: true }, text: 'Email' });
    expect(detectExistingCues(plain, classifyElement(plain)).cues).toEqual([]);
  });
});

describe('M6 cue selection', () => {
  const kinds = (
    state: Parameters<typeof selectCue>[0],
    kind: Parameters<typeof selectCue>[1] = 'text',
  ) => selectCue(state, kind, { afterBusy: false, beforeBusy: false }, 8);

  it('maps states to a controlled set of cues (type, not just "something")', () => {
    expect(kinds('error')).toEqual({
      kind: 'cue',
      spec: { type: 'suffix-symbol', placement: 'after', glyph: '×' },
    });
    expect(kinds('success')).toMatchObject({ spec: { glyph: '✓', placement: 'after' } });
    expect(kinds('warning')).toMatchObject({ spec: { glyph: '!' } });
    expect(kinds('required')).toMatchObject({ spec: { glyph: '*' } });
    expect(kinds('positive')).toMatchObject({ spec: { glyph: '+' } });
    expect(kinds('negative')).toMatchObject({ spec: { glyph: '−' } });
    expect(kinds('increase')).toMatchObject({ spec: { glyph: '↑' } });
    expect(kinds('decrease')).toMatchObject({ spec: { glyph: '↓' } });
    expect(kinds('selected')).toEqual({
      kind: 'cue',
      spec: { type: 'underline', placement: 'underline' },
    });
    expect(kinds('active')).toMatchObject({ spec: { type: 'underline' } });
  });

  it('a dot gets its glyph inside the box; online and offline differ', () => {
    expect(kinds('online', 'dot')).toEqual({
      kind: 'cue',
      spec: { type: 'marker', placement: 'inner', glyph: '✓' },
    });
    expect(kinds('offline', 'dot')).toMatchObject({ spec: { glyph: '×' } });
    expect(kinds('warning', 'dot')).toMatchObject({ spec: { glyph: '!' } });
  });

  it('controls get an outline pattern, never a pseudo-element; states without a pattern get nothing', () => {
    expect(kinds('invalid', 'control')).toEqual({
      kind: 'cue',
      spec: { type: 'border-style', placement: 'outline', outline: 'dashed' },
    });
    expect(kinds('warning', 'control')).toMatchObject({ spec: { outline: 'dotted' } });
    expect(kinds('success', 'control')).toMatchObject({ spec: { outline: 'double' } });
    expect(kinds('online', 'control')).toEqual({ kind: 'none', reason: 'no-safe-placement' });
  });

  it('no cue is defined for unselected, inactive, enabled, disabled', () => {
    for (const state of ['unselected', 'inactive', 'enabled', 'disabled'] as const) {
      expect(kinds(state)).toEqual({ kind: 'none', reason: 'no-cue-for-state' });
    }
  });

  it('never draws over the page: a busy ::after falls back to ::before, both busy to nothing', () => {
    expect(selectCue('error', 'text', { afterBusy: true, beforeBusy: false })).toMatchObject({
      spec: { placement: 'before', type: 'prefix-symbol' },
    });
    expect(selectCue('error', 'text', { afterBusy: true, beforeBusy: true })).toEqual({
      kind: 'none',
      reason: 'no-safe-placement',
    });
  });

  it('an underline is for short labels only', () => {
    expect(selectCue('selected', 'text', NO_CUES, 200)).toEqual({
      kind: 'none',
      reason: 'no-safe-placement',
    });
    expect(selectCue('selected', 'other', NO_CUES, 8)).toMatchObject({ kind: 'none' });
  });
});

describe('M6 cue decision (automation policy)', () => {
  const colorOnly = () => ({ colorOnly: true as const, basis: 'peer-comparison' as const });
  const decide = (f = facts({ classTokens: ['badge', 'success'] }), overrides = {}) => {
    const result = classifyElement(f);
    return decideCue({
      result,
      kind: f.kind,
      textLength: f.text.length,
      existing: detectExistingCues(f, result),
      assessColorOnly: colorOnly,
      enabled: true,
      ...overrides,
    });
  };

  it('HIGH + color-only + safe placement: a cue with a reason', () => {
    const decision = decide();
    expect(decision).toMatchObject({
      action: 'cue',
      plan: {
        owner: 'coloradapt-semantic',
        state: 'success',
        confidence: 'high',
        cue: { glyph: '✓' },
      },
    });
  });

  it('MEDIUM confidence is reported (colorOnly) and not applied', () => {
    expect(decide(facts({ classTokens: ['success'] }))).toEqual({
      action: 'none',
      reason: 'below-threshold',
      detail: 'medium',
      colorOnly: true,
    });
  });

  it('LOW confidence: no cue', () => {
    expect(decide(facts({ text: 'Error' }))).toMatchObject({
      action: 'none',
      reason: 'below-threshold',
    });
  });

  it('unknown and conflict: no cue, and color-only is not even assessed', () => {
    let assessed = 0;
    const spy = () => {
      assessed += 1;
      return colorOnly();
    };
    expect(decide(facts({ colorHint: 'red' }), { assessColorOnly: spy })).toMatchObject({
      reason: 'unknown',
    });
    expect(
      decide(facts({ classTokens: ['success'], aria: { 'aria-invalid': 'true' } }), {
        assessColorOnly: spy,
      }),
    ).toMatchObject({ reason: 'conflict' });
    expect(assessed).toBe(0);
  });

  it('not color-only: nothing is added', () => {
    expect(
      decide(undefined, {
        assessColorOnly: () => ({ colorOnly: false, reason: 'existing-cue', detail: 'icon' }),
      }),
    ).toMatchObject({ action: 'none', reason: 'not-color-only', detail: 'existing-cue:icon' });
  });

  it('the setting turns the whole thing off', () => {
    expect(decide(undefined, { enabled: false })).toEqual({
      action: 'none',
      reason: 'disabled-by-settings',
    });
  });
});
