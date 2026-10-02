import { describe, expect, it } from 'vitest';
import { parseColor } from '@core/color';

describe('parseColor', () => {
  it('parses hex colors', () => {
    expect(parseColor('#ff0000')).toMatchObject({ r: 1, g: 0, b: 0, alpha: 1 });
  });

  it('parses rgb() colors', () => {
    expect(parseColor('rgb(0, 128, 255)')).toMatchObject({
      r: 0,
      g: expect.closeTo(128 / 255, 5),
      b: 1,
      alpha: 1,
    });
  });

  it('parses rgba() colors with alpha', () => {
    const color = parseColor('rgba(10, 20, 30, 0.5)');
    expect(color?.alpha).toBeCloseTo(0.5, 5);
  });

  it('parses named colors', () => {
    expect(parseColor('white')).toMatchObject({ r: 1, g: 1, b: 1, alpha: 1 });
  });

  it('parses "transparent" as zero-alpha black', () => {
    expect(parseColor('transparent')).toMatchObject({ r: 0, g: 0, b: 0, alpha: 0 });
  });

  it('returns null for unparseable input', () => {
    expect(parseColor('not-a-color')).toBeNull();
    expect(parseColor('')).toBeNull();
  });
});
