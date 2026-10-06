import { describe, expect, it } from 'vitest';
import {
  compositeOver,
  contrastRatio,
  contrastTarget,
  parseCssColor,
  relativeLuminance,
  resolveContrast,
  type ChainEntry,
  type OracleInput,
  type Rgba,
} from '../../realworld/lib/color';

const rgb = (r: number, g: number, b: number, a = 1): Rgba => ({ r, g, b, a });

describe('M10 independent contrast oracle', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio(rgb(0, 0, 0), rgb(255, 255, 255))).toBeCloseTo(21, 10);
    expect(contrastRatio(rgb(255, 255, 255), rgb(255, 255, 255))).toBeCloseTo(1, 10);
    // #767676 on white is the well-known 4.54:1 boundary of AA.
    expect(contrastRatio(rgb(0x76, 0x76, 0x76), rgb(255, 255, 255))).toBeCloseTo(4.542, 2);
    // #777777 on white is just under 4.5 (4.48).
    expect(contrastRatio(rgb(0x77, 0x77, 0x77), rgb(255, 255, 255))).toBeCloseTo(4.478, 2);
    expect(relativeLuminance(rgb(255, 0, 0))).toBeCloseTo(0.2126, 6);
  });

  it('is symmetric', () => {
    expect(contrastRatio(rgb(10, 80, 200), rgb(250, 240, 10))).toBeCloseTo(
      contrastRatio(rgb(250, 240, 10), rgb(10, 80, 200)),
      12,
    );
  });

  it('parses computed colors in both syntaxes and refuses the rest', () => {
    expect(parseCssColor('rgb(1, 2, 3)')).toEqual(rgb(1, 2, 3));
    expect(parseCssColor('rgba(1, 2, 3, 0.5)')).toEqual(rgb(1, 2, 3, 0.5));
    expect(parseCssColor('rgb(1 2 3 / 25%)')).toEqual(rgb(1, 2, 3, 0.25));
    expect(parseCssColor('color(display-p3 1 0 0)')).toBeNull();
    expect(parseCssColor('transparent')).toBeNull();
  });

  it('reads color(srgb ...), which Chrome reports for color-mix() and friends (M10.R1)', () => {
    const c = parseCssColor('color(srgb 0.0235294 0.0431373 0.0627451)')!;
    expect(Math.round(c.r)).toBe(6);
    expect(Math.round(c.g)).toBe(11);
    expect(Math.round(c.b)).toBe(16);
    expect(c.a).toBe(1);
    expect(parseCssColor('color(srgb 1 1 1)')).toEqual(rgb(255, 255, 255));
    expect(parseCssColor('color(srgb 0 0 0 / 0.5)')).toEqual(rgb(0, 0, 0, 0.5));
    expect(parseCssColor('color(srgb 100% 0% 0% / 25%)')).toEqual(rgb(255, 0, 0, 0.25));
    expect(parseCssColor('color(srgb 2 -1 0.5)')).toEqual(rgb(255, 0, 127.5));
    expect(parseCssColor('color(srgb 1 1)')).toBeNull();
    expect(parseCssColor('oklch(0.5 0.1 200)')).toBeNull();
  });

  it('composites source-over', () => {
    const c = compositeOver(rgb(255, 0, 0, 0.5), rgb(0, 0, 255, 1));
    expect(c.a).toBe(1);
    expect(c.r).toBeCloseTo(127.5, 6);
    expect(c.b).toBeCloseTo(127.5, 6);
  });

  it('picks the large-text target by size and weight', () => {
    expect(contrastTarget(16, 400)).toBe(4.5);
    expect(contrastTarget(24, 400)).toBe(3);
    expect(contrastTarget(18.66, 700)).toBe(3);
    expect(contrastTarget(18.66, 400)).toBe(4.5);
    expect(contrastTarget(18, 700)).toBe(4.5);
  });

  describe('resolveContrast', () => {
    const base = { darkCanvas: false, effects: false, clipText: false };
    const solid = (color: string, opacity = 1): ChainEntry => ({
      opacity,
      paint: { kind: 'color', color },
    });
    const bare = (opacity = 1): ChainEntry => ({ opacity, paint: null });
    const resolve = (color: string, chain: ChainEntry[], more: Partial<OracleInput> = {}) =>
      resolveContrast({ ...base, color, chain, ...more });

    // --- known values (the fixtures of the M10.R1 oracle regression suite) ---------------------------------

    it('black on white is 21:1', () => {
      const r = resolve('rgb(0, 0, 0)', [solid('rgb(255, 255, 255)')]);
      expect(r.status).toBe('RESOLVED');
      expect(r.ratio).toBeCloseTo(21, 10);
      expect(contrastTarget(16, 400)).toBe(4.5);
    });

    it('gray #777 on white is 4.478:1, just under the 4.5 target (no tolerance hides it)', () => {
      const r = resolve('rgb(119, 119, 119)', [solid('rgb(255, 255, 255)')]);
      expect(r.ratio!).toBeCloseTo(4.478, 3);
      expect(r.ratio!).toBeLessThan(contrastTarget(16, 400));
    });

    it('large text has the 3:1 target: #767676 passes at any size, #959595 only when large', () => {
      const gray = resolve('rgb(149, 149, 149)', [solid('rgb(255, 255, 255)')]);
      expect(gray.ratio!).toBeCloseTo(2.99, 1);
      expect(contrastTarget(24, 400)).toBe(3);
      expect(contrastTarget(18.66, 700)).toBe(3);
      expect(contrastTarget(18.66, 600)).toBe(4.5);
    });

    it('an rgba foreground is composited over the background', () => {
      const r = resolve('rgba(0, 0, 0, 0.5)', [solid('rgb(255, 255, 255)')]);
      expect(r.foreground!.r).toBeCloseTo(127.5, 6);
      expect(r.ratio!).toBeCloseTo(contrastRatio(rgb(127.5, 127.5, 127.5), rgb(255, 255, 255)), 6);
    });

    it('an rgba background is composited over the next layer, child first', () => {
      const r = resolve('rgb(0, 0, 0)', [
        solid('rgba(255, 255, 255, 0.5)'),
        solid('rgb(0, 0, 0)'),
        solid('rgb(255, 0, 0)'),
      ]);
      // 50% white over black = #808080; the red layer behind the black one is never seen
      expect(r.background?.r).toBeCloseTo(127.5, 6);
      expect(r.ratio).toBeCloseTo(5.2808, 3);
    });

    it('opacity is a group: an ancestor at 50% fades its own background with the text', () => {
      // white text on a black ancestor, the ancestor at opacity .5, over the white canvas
      const r = resolve('rgb(255, 255, 255)', [bare(), solid('rgb(0, 0, 0)', 0.5)]);
      expect(r.background?.r).toBeCloseTo(127.5, 6);
      expect(r.foreground?.r).toBeCloseTo(255, 6);
      expect(r.ratio!).toBeCloseTo(contrastRatio(rgb(255, 255, 255), rgb(127.5, 127.5, 127.5)), 6);
      // the old flat model (text x 0.5 over the unfaded black) would have said 1.0 : 1
      expect(r.ratio!).toBeGreaterThan(3.9);
    });

    it('nested opacity: each group is faded once, over what its own background paints', () => {
      // child: black at .5, parent: black at .5. The child group (a .5 black) is painted over the parent's
      // black (-> opaque black), then the parent group is faded to .5 over the white canvas: #808080 (not .25).
      const r = resolve('rgb(0, 0, 0)', [solid('rgb(0, 0, 0)', 0.5), solid('rgb(0, 0, 0)', 0.5)]);
      expect(r.background?.r).toBeCloseTo(127.5, 6);
    });

    it('nested opacity on bare wrappers multiplies', () => {
      const r = resolve('rgb(0, 0, 0)', [bare(0.5), bare(0.5)]);
      expect(r.foreground?.r).toBeCloseTo(191.25, 6); // black at .25 over white
    });

    it('opacity on an ancestor above an opaque background still fades the whole group', () => {
      const r = resolve('rgb(0, 0, 0)', [solid('rgb(255, 255, 255)'), bare(0.5)]);
      // black text on white, the group at .5 over white canvas: text becomes #808080, background stays white
      expect(r.foreground?.r).toBeCloseTo(127.5, 6);
      expect(r.background?.r).toBeCloseTo(255, 6);
    });

    it('a fully transparent element has no contrast: text equals background', () => {
      const r = resolve('rgb(0, 0, 0)', [bare(0)]);
      expect(r.ratio).toBeCloseTo(1, 10);
    });

    it('falls back to the white canvas, or the dark one', () => {
      expect(resolve('rgb(255, 255, 255)', []).ratio).toBeCloseTo(1, 10);
      expect(resolve('rgb(255, 255, 255)', [], { darkCanvas: true }).ratio!).toBeGreaterThan(15);
    });

    it('refuses gradients, images, text clipping and effects instead of guessing', () => {
      const color = 'rgb(0, 0, 0)';
      expect(resolve(color, [{ opacity: 1, paint: { kind: 'gradient' } }]).status).toBe(
        'UNRESOLVED_GRADIENT',
      );
      expect(
        resolve(color, [solid('rgba(0, 0, 0, 0.1)'), { opacity: 1, paint: { kind: 'image' } }])
          .status,
      ).toBe('UNRESOLVED_IMAGE');
      expect(resolve(color, [], { clipText: true }).status).toBe('UNRESOLVED_TEXT_CLIP');
      expect(resolve(color, [], { effects: true }).status).toBe('UNRESOLVED_EFFECT');
    });

    it('a dark layer written as color(srgb ...) is the background (the netlify code blocks)', () => {
      const r = resolve('rgb(137, 221, 255)', [
        solid('color(srgb 0.0235294 0.0431373 0.0627451)'),
        solid('color(srgb 1 1 1)'),
      ]);
      expect(r.status).toBe('RESOLVED');
      expect(r.ratio!).toBeGreaterThan(12);
    });

    it('a color it cannot read is unknown, never transparent', () => {
      expect(resolve('rgb(255, 255, 255)', [solid('oklch(0.2 0.02 250)')]).status).toBe(
        'UNRESOLVED_COLOR_FORMAT',
      );
      expect(resolve('lab(50 10 10)', []).status).toBe('UNRESOLVED_COLOR_FORMAT');
    });
  });
});
