import { describe, expect, it } from 'vitest';
import {
  PROBE_COLORS,
  buildProbeCss,
  classifyPaintServer,
  derivationOf,
  parseNumber,
  parsePaint,
  withDerivation,
} from '@core/svg';

describe('parsePaint (computed fill/stroke values)', () => {
  it('none and empty are no paint', () => {
    expect(parsePaint('none')).toEqual({ kind: 'none' });
    expect(parsePaint('NONE')).toEqual({ kind: 'none' });
    expect(parsePaint('')).toEqual({ kind: 'none' });
  });

  it('solid colors keep their alpha', () => {
    const red = parsePaint('rgb(255, 0, 0)');
    expect(red.kind).toBe('solid');
    if (red.kind === 'solid') expect(red.color).toMatchObject({ r: 1, g: 0, b: 0, alpha: 1 });
    const half = parsePaint('rgba(255, 0, 0, 0.5)');
    if (half.kind === 'solid') expect(half.color.alpha).toBeCloseTo(0.5, 5);
    else throw new Error('expected solid');
  });

  it('a fully transparent color paints nothing', () => {
    expect(parsePaint('rgba(0, 0, 0, 0)')).toEqual({ kind: 'none' });
    expect(parsePaint('transparent')).toEqual({ kind: 'none' });
  });

  it('url(...) is a paint server, with or without quotes and with a fallback', () => {
    expect(parsePaint('url("#g")')).toEqual({ kind: 'paint-server', reference: '#g' });
    expect(parsePaint("url('#g')")).toEqual({ kind: 'paint-server', reference: '#g' });
    expect(parsePaint('url(#g)')).toEqual({ kind: 'paint-server', reference: '#g' });
    expect(parsePaint('url("#g") rgb(255, 0, 0)')).toEqual({
      kind: 'paint-server',
      reference: '#g',
    });
    expect(parsePaint('url("icons.svg#g")')).toEqual({
      kind: 'paint-server',
      reference: 'icons.svg#g',
    });
  });

  it('context-fill / context-stroke are named, not guessed', () => {
    expect(parsePaint('context-fill')).toEqual({ kind: 'context', value: 'context-fill' });
    expect(parsePaint('context-stroke')).toEqual({ kind: 'context', value: 'context-stroke' });
  });

  it('anything unparseable is unsupported, never a color', () => {
    expect(parsePaint('banana')).toEqual({ kind: 'unsupported', value: 'banana' });
  });
});

describe('withDerivation (currentColor is told apart by derivation, not by value)', () => {
  const solid = parsePaint('rgb(200, 0, 0)');

  it('a solid paint driven by color is currentColor', () => {
    expect(withDerivation(solid, 'currentColor')).toMatchObject({ kind: 'currentColor' });
  });

  it('inherited / explicit / unknown stay solid', () => {
    for (const derivation of ['inherited', 'explicit', 'unknown'] as const) {
      expect(withDerivation(solid, derivation).kind).toBe('solid');
    }
  });

  it('non-solid paints are never currentColor', () => {
    expect(withDerivation({ kind: 'none' }, 'currentColor')).toEqual({ kind: 'none' });
  });
});

describe('classifyPaintServer', () => {
  const doc = document.implementation.createHTMLDocument('x');
  doc.body.innerHTML = `
    <svg>
      <linearGradient id="lg"></linearGradient>
      <radialGradient id="rg"></radialGradient>
      <pattern id="pt"></pattern>
      <meshgradient id="mg"></meshgradient>
      <rect id="r"></rect>
    </svg>`;

  it('gradients, patterns, and everything else', () => {
    expect(classifyPaintServer(doc, '#lg')).toBe('gradient');
    expect(classifyPaintServer(doc, '#rg')).toBe('gradient');
    expect(classifyPaintServer(doc, '#pt')).toBe('pattern');
    expect(classifyPaintServer(doc, '#mg')).toBe('other');
    expect(classifyPaintServer(doc, '#r')).toBe('other');
  });

  it('missing and external references are "other" (still unsupported)', () => {
    expect(classifyPaintServer(doc, '#missing')).toBe('other');
    expect(classifyPaintServer(doc, 'icons.svg#lg')).toBe('other');
  });
});

describe('style probe', () => {
  it('derivationOf reads the sentinels', () => {
    expect(derivationOf('fill', PROBE_COLORS.fill)).toBe('inherited');
    expect(derivationOf('stroke', PROBE_COLORS.stroke)).toBe('inherited');
    expect(derivationOf('fill', PROBE_COLORS.color)).toBe('currentColor');
    expect(derivationOf('stroke', PROBE_COLORS.color)).toBe('currentColor');
    expect(derivationOf('fill', 'rgb(200, 0, 0)')).toBe('explicit');
    // The stroke sentinel is not the fill sentinel.
    expect(derivationOf('fill', PROBE_COLORS.stroke)).toBe('explicit');
  });

  it('the three sentinels are pairwise distinct', () => {
    expect(new Set(Object.values(PROBE_COLORS)).size).toBe(3);
  });

  it('buildProbeCss targets only tagged elements, suppresses transitions, and escapes ids', () => {
    expect(buildProbeCss([])).toBe('');
    const css = buildProbeCss(['ca-1', 'we"ird']);
    expect(css).toContain('[data-coloradapt-id="ca-1"]');
    expect(css).toContain('[data-coloradapt-id="we\\"ird"]');
    expect(css).toContain(':not(#coloradapt-specificity)');
    expect(css).toContain('!important');
    expect(css).toMatch(/transition: none !important/);
    // No blanket rule: every selector is scoped to the probed elements.
    for (const line of css.split('\n')) expect(line).toMatch(/^:is\(\[data-coloradapt-id=/);
  });
});

describe('parseNumber', () => {
  it('parses, and falls back on NaN', () => {
    expect(parseNumber('0.5', 1)).toBe(0.5);
    expect(parseNumber('2px', 1)).toBe(2);
    expect(parseNumber('', 1)).toBe(1);
    expect(parseNumber(undefined, 3)).toBe(3);
    expect(parseNumber('abc', 7)).toBe(7);
  });
});
