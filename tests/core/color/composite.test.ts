import { describe, expect, it } from 'vitest';
import { compositeColors } from '@core/color';

describe('compositeColors', () => {
  it('composites a 50% red over opaque white (basic alpha blend)', () => {
    const red = { r: 1, g: 0, b: 0, alpha: 0.5 };
    const white = { r: 1, g: 1, b: 1, alpha: 1 };

    const result = compositeColors(red, white);

    expect(result.alpha).toBeCloseTo(1, 5);
    expect(result.r).toBeCloseTo(1, 5);
    expect(result.g).toBeCloseTo(0.5, 5);
    expect(result.b).toBeCloseTo(0.5, 5);
  });

  it('returns the top color unchanged when it is fully opaque', () => {
    const black = { r: 0, g: 0, b: 0, alpha: 1 };
    const white = { r: 1, g: 1, b: 1, alpha: 1 };

    expect(compositeColors(black, white)).toMatchObject({ r: 0, g: 0, b: 0, alpha: 1 });
  });

  it('returns the bottom color unchanged when the top is fully transparent', () => {
    const transparent = { r: 1, g: 0, b: 0, alpha: 0 };
    const blue = { r: 0, g: 0, b: 1, alpha: 1 };

    expect(compositeColors(transparent, blue)).toMatchObject({ r: 0, g: 0, b: 1, alpha: 1 });
  });

  it('combines two semi-transparent colors into a still-semi-transparent result', () => {
    const topHalf = { r: 1, g: 1, b: 1, alpha: 0.5 };
    const bottomHalf = { r: 0, g: 0, b: 0, alpha: 0.5 };

    const result = compositeColors(topHalf, bottomHalf);

    // out alpha = 0.5 + 0.5*(1-0.5) = 0.75
    expect(result.alpha).toBeCloseTo(0.75, 5);
  });

  it('is fully transparent when both inputs are fully transparent', () => {
    const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
    expect(compositeColors(transparent, transparent)).toMatchObject({ alpha: 0 });
  });
});
