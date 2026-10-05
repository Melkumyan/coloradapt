import { describe, expect, it } from 'vitest';
import {
  compositeOver,
  contrastRatio,
  contrastTarget,
  parseCssColor,
  relativeLuminance,
  resolveContrast,
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
    const base = { opacity: 1, darkCanvas: false, effects: false, clipText: false };

    it('resolves a solid pair', () => {
      const r = resolveContrast({
        ...base,
        color: 'rgb(0, 0, 0)',
        layers: [{ kind: 'color', color: 'rgb(255, 255, 255)' }],
      });
      expect(r.status).toBe('RESOLVED');
      expect(r.ratio).toBeCloseTo(21, 10);
    });

    it('falls back to the white canvas, or the dark one', () => {
      const light = resolveContrast({ ...base, color: 'rgb(255, 255, 255)', layers: [] });
      expect(light.ratio).toBeCloseTo(1, 10);
      const dark = resolveContrast({
        ...base,
        darkCanvas: true,
        color: 'rgb(255, 255, 255)',
        layers: [],
      });
      expect(dark.ratio).toBeGreaterThan(15);
    });

    it('composites translucent layers child-first until an opaque one', () => {
      const r = resolveContrast({
        ...base,
        color: 'rgb(0, 0, 0)',
        layers: [
          { kind: 'color', color: 'rgba(255, 255, 255, 0.5)' },
          { kind: 'color', color: 'rgb(0, 0, 0)' },
          { kind: 'color', color: 'rgb(255, 0, 0)' },
        ],
      });
      expect(r.status).toBe('RESOLVED');
      // 50% white over black = #808080; text is black on it.
      expect(r.background?.r).toBeCloseTo(127.5, 6);
      expect(r.ratio).toBeCloseTo(5.2808, 3);
    });

    it('applies element/ancestor opacity to the text', () => {
      const half = resolveContrast({
        ...base,
        opacity: 0.5,
        color: 'rgb(0, 0, 0)',
        layers: [{ kind: 'color', color: 'rgb(255, 255, 255)' }],
      });
      expect(half.ratio).toBeLessThan(21);
      expect(half.ratio).toBeCloseTo(
        contrastRatio(rgb(127.5, 127.5, 127.5), rgb(255, 255, 255)),
        6,
      );
    });

    it('refuses gradients, images, text clipping and effects instead of guessing', () => {
      const color = 'rgb(0, 0, 0)';
      expect(resolveContrast({ ...base, color, layers: [{ kind: 'gradient' }] }).status).toBe(
        'UNRESOLVED_GRADIENT',
      );
      expect(
        resolveContrast({
          ...base,
          color,
          layers: [{ kind: 'color', color: 'rgba(0, 0, 0, 0.1)' }, { kind: 'image' }],
        }).status,
      ).toBe('UNRESOLVED_IMAGE');
      expect(resolveContrast({ ...base, color, clipText: true, layers: [] }).status).toBe(
        'UNRESOLVED_TEXT_CLIP',
      );
      expect(resolveContrast({ ...base, color, effects: true, layers: [] }).status).toBe(
        'UNRESOLVED_EFFECT',
      );
    });

    it('does not look below an opaque layer (an image under it is hidden)', () => {
      const r = resolveContrast({
        ...base,
        color: 'rgb(0, 0, 0)',
        layers: [{ kind: 'color', color: 'rgb(255, 255, 255)' }, { kind: 'image' }],
      });
      expect(r.status).toBe('RESOLVED');
    });
  });
});
