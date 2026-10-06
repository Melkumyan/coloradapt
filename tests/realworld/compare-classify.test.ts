import { describe, expect, it } from 'vitest';
import { compareRow, comparePage, isBorderline, oracleLow } from '../../realworld/lib/compare';
import { classifyRecord, type FrozenRecord } from '../../realworld/lib/classify';
import type { OracleRow, TraceCompact } from '../../realworld/lib/page-run';

/** M10.R1: the comparison and the classification are deterministic rules; each is pinned here. */
const trace = (over: Partial<TraceCompact> = {}): TraceCompact => ({
  stage: 'EVALUATED',
  reason: 'PASS_CONTRAST',
  reported: false,
  foreground: '#000000',
  background: '#ffffff',
  ratio: 21,
  target: 4.5,
  largeText: false,
  fontSizePx: 16,
  fontWeight: '400',
  backgroundKind: 'solid',
  ...over,
});
const row = (over: Partial<OracleRow> = {}): OracleRow => ({
  path: '#a',
  full: 'html>body>div:nth-of-type(1)',
  tag: 'div',
  status: 'RESOLVED',
  ratio: 21,
  target: 4.5,
  flags: '',
  chars: 5,
  fg: '#000000',
  bg: '#ffffff',
  opacity: 1,
  trace: trace(),
  ...over,
});
const reported = (over: Partial<TraceCompact> = {}) =>
  trace({ stage: 'FAILED_THRESHOLD', reason: 'REPORTED', reported: true, ratio: 3, ...over });

describe('compareRow', () => {
  it('agreement is not a discrepancy', () => {
    expect(compareRow(row({ ratio: 3, trace: reported() }))).toBeNull();
    expect(compareRow(row())).toBeNull();
  });

  it('a ratio within 0.001 of the target is rounding, not a verdict', () => {
    expect(isBorderline(row({ ratio: 4.4995 }))).toBe(true);
    expect(oracleLow(row({ ratio: 4.4995 }))).toBe(false);
    expect(oracleLow(row({ ratio: 4.478 }))).toBe(true);
  });

  it('the old judge tolerance (0.06) is gone: 4.478 is low', () => {
    expect(compareRow(row({ ratio: 4.478, trace: trace() }))?.side).toBe('FALSE_NEGATIVE');
  });

  it('text the browser does not paint but ColorAdapt reports is a product bug', () => {
    const d = compareRow(row({ flags: 'hidden:display', ratio: 1, trace: reported() }));
    expect(d).toMatchObject({ side: 'FALSE_POSITIVE', primary: 'PRODUCT_BUG', tier: 'A' });
  });

  it('hidden text nobody reports agrees', () => {
    expect(compareRow(row({ flags: 'hidden:display', ratio: 1 }))).toBeNull();
  });

  it('low contrast in an unanalyzed tag is a discovery bug; in a form control it is scope', () => {
    const miss = trace({ reason: 'NOT_A_CANDIDATE', stage: 'DISCOVERED' });
    expect(compareRow(row({ ratio: 2, trace: miss, tag: 'time' }))?.code).toBe(
      'TEXT_DISCOVERY/time',
    );
    expect(compareRow(row({ ratio: 2, trace: miss, flags: 'sensitive' }))?.primary).toBe(
      'SCOPE_DIFFERENCE',
    );
  });

  it('disabled, unresolved background and precision boundary are not product bugs', () => {
    expect(compareRow(row({ ratio: 2, trace: trace({ reason: 'SKIP_DISABLED' }) }))?.primary).toBe(
      'SCOPE_DIFFERENCE',
    );
    expect(
      compareRow(row({ ratio: 2, trace: trace({ reason: 'UNRESOLVED_BACKGROUND' }) }))?.primary,
    ).toBe('INTENTIONAL_EXCLUSION');
    const boundary = row({ ratio: 2.99, target: 3, trace: trace({ ratio: 3.004, target: 3 }) });
    expect(compareRow(boundary)?.primary).toBe('PRECISION_BOUNDARY');
  });

  it('colors that differ with no known cause stay AMBIGUOUS, with the evidence', () => {
    const d = compareRow(
      row({ ratio: 2, fg: '#111111', trace: trace({ foreground: '#222222', ratio: 9 }) }),
    );
    expect(d).toMatchObject({ primary: 'AMBIGUOUS', tier: 'C' });
    expect(d?.note).toContain('#222222');
  });

  it('rows outside the scope (SVG, shadow, no text) are never compared', () => {
    expect(compareRow(row({ flags: 'svg', ratio: 2 }))).toBeNull();
    expect(compareRow(row({ chars: 0, ratio: 2 }))).toBeNull();
  });

  it('comparePage counts agreement and discrepancies', () => {
    const page = comparePage('p', [
      row({ ratio: 3, trace: reported() }),
      row({ ratio: 2, trace: trace({ reason: 'NOT_A_CANDIDATE' }), tag: 'abbr', full: 'x' }),
      row({ flags: 'hidden:display', ratio: 1, trace: reported(), full: 'y' }),
    ]);
    expect(page).toMatchObject({ agreeLow: 1, oracleLow: 2, renderedRows: 2 });
    expect(page.discrepancies.map((d) => d.side).sort()).toEqual([
      'FALSE_NEGATIVE',
      'FALSE_POSITIVE',
    ]);
  });
});

describe('classifyRecord', () => {
  const fn: FrozenRecord = {
    id: 'RW-FN-0001',
    kind: 'FALSE_NEGATIVE',
    page: 'p',
    tag: 'time',
    fullPath: 'html>body>div:nth-of-type(1)',
    sharedLocatorCount: 1,
    colorAdapt: { reported: false },
    oracle: { status: 'RESOLVED', ratio: 2, target: 4.5, flags: [] },
  };

  it('a baseline miss in an unanalyzed tag, low in the replay, is a discovery bug', () => {
    const replay = [
      row({ ratio: 2, trace: reported(), traceLegacy: trace({ reason: 'NOT_A_CANDIDATE' }) }),
    ];
    expect(classifyRecord(fn, replay)).toMatchObject({
      primary: 'PRODUCT_BUG',
      tier: 'A',
      fixedInR1: true,
    });
  });

  it('a baseline ratio that is the text on a white canvas, where the browser paints another background, is the oracle', () => {
    // #89ddff on white is 1.516; the replay sees #060b10 behind it
    const record = {
      ...fn,
      tag: 'span',
      oracle: { status: 'RESOLVED', ratio: 1.516, target: 4.5, flags: [] },
    };
    const replay = [row({ ratio: 13.0, fg: '#89ddff', bg: '#060b10' })];
    expect(classifyRecord(record, replay)).toMatchObject({
      primary: 'ORACLE_BUG',
      code: 'COLOR_FORMAT',
    });
  });

  it('an element that is gone, in an analyzed tag, is a page-state difference, never a product bug', () => {
    expect(classifyRecord({ ...fn, tag: 'span' }, [])).toMatchObject({
      primary: 'TIMING_STATE_DIFFERENCE',
    });
  });

  it('a false positive whose baseline oracle ratio was below the target was a harness tolerance', () => {
    const record: FrozenRecord = {
      ...fn,
      id: 'RW-FP-0001',
      kind: 'FALSE_POSITIVE',
      tag: 'a',
      colorAdapt: { reported: true, foreground: '#777777', background: '#ffffff' },
      oracle: { status: 'RESOLVED', ratio: 4.478, target: 4.5, flags: [] },
    };
    const replay = [
      row({
        ratio: 4.478,
        fg: '#777777',
        bg: '#ffffff',
        trace: reported({ ratio: 4.478, target: 4.5 }),
        traceLegacy: reported(),
      }),
    ];
    expect(classifyRecord(record, replay)).toMatchObject({
      primary: 'HARNESS_BUG',
      code: 'JUDGE_TOLERANCE',
    });
  });

  it('no replay row for a false positive is AMBIGUOUS, never silently a verdict', () => {
    const record: FrozenRecord = {
      ...fn,
      id: 'RW-FP-0002',
      kind: 'FALSE_POSITIVE',
      colorAdapt: { reported: true },
    };
    expect(classifyRecord(record, null)).toMatchObject({ primary: 'AMBIGUOUS' });
  });
});
