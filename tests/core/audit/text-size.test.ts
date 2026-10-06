import { describe, expect, it } from 'vitest';
import { isLargeTextStyle, parseFontWeight } from '@core/audit';

/** M10.R1: the large-text rule against the computed values a browser reports. */
describe('parseFontWeight', () => {
  it.each([
    ['normal', 400],
    ['bold', 700],
    ['400', 400],
    ['500', 500],
    ['600', 600],
    ['700', 700],
    ['800', 800],
    ['900', 900],
    ['650', 650],
    ['372.5', 372.5],
    [' BOLD ', 700],
  ])('%s -> %s', (value, expected) => {
    expect(parseFontWeight(value)).toBe(expected);
  });

  it.each(['', 'bolder', 'lighter', 'abc', '-1', '0', 'NaN'])(
    '%j is not a computed weight',
    (value) => {
      expect(parseFontWeight(value)).toBeNull();
    },
  );
});

describe('isLargeTextStyle', () => {
  it('24px is large at any weight; just under is not', () => {
    expect(isLargeTextStyle('24px', '400')).toBe(true);
    expect(isLargeTextStyle('24px', 'normal')).toBe(true);
    expect(isLargeTextStyle('23.99px', '400')).toBe(false);
    expect(isLargeTextStyle('23.99px', '600')).toBe(false);
  });

  it('14pt (18.666px) is large only when bold (weight 700 or more)', () => {
    expect(isLargeTextStyle('18.6667px', '700')).toBe(true);
    expect(isLargeTextStyle('18.66px', '700')).toBe(true);
    expect(isLargeTextStyle('18.6667px', '800')).toBe(true);
    expect(isLargeTextStyle('18.6667px', 'bold')).toBe(true);
    expect(isLargeTextStyle('18.6667px', '699')).toBe(false);
    expect(isLargeTextStyle('18.6667px', '600')).toBe(false);
    expect(isLargeTextStyle('18.6667px', '500')).toBe(false);
    expect(isLargeTextStyle('18.6667px', '400')).toBe(false);
    expect(isLargeTextStyle('18.6667px', 'normal')).toBe(false);
    expect(isLargeTextStyle('18.6px', '700')).toBe(false);
    expect(isLargeTextStyle('18px', '700')).toBe(false);
  });

  it('a variable font weight counts by its computed number', () => {
    expect(isLargeTextStyle('19px', '650')).toBe(false);
    expect(isLargeTextStyle('19px', '700.5')).toBe(true);
  });

  it('an unreadable size is never large', () => {
    expect(isLargeTextStyle('', '700')).toBe(false);
    expect(isLargeTextStyle('normal', '700')).toBe(false);
  });

  it('uses CSS px: a device pixel ratio or zoom is not an input', () => {
    // the function has no access to either; this pins the policy (docs/AUDIT_RULES.md)
    expect(isLargeTextStyle.length).toBe(2);
  });
});
