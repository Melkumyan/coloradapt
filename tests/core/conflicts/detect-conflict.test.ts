import { describe, expect, it } from 'vitest';
import { detectColorConflict } from '@core/conflicts';
import type { ColorValue } from '@domain/models';

const WHITE: ColorValue = { r: 1, g: 1, b: 1, alpha: 1 };
const BLACK: ColorValue = { r: 0, g: 0, b: 0, alpha: 1 };
const LIGHT_GRAY: ColorValue = { r: 0.92, g: 0.92, b: 0.92, alpha: 1 };

describe('detectColorConflict', () => {
  it('returns null for high-contrast, clearly distinguishable pairs', () => {
    expect(
      detectColorConflict('el-1', { foreground: BLACK, background: WHITE }, 'normal'),
    ).toBeNull();
  });

  it('flags low-contrast pairs as a conflict', () => {
    const conflict = detectColorConflict(
      'el-2',
      { foreground: LIGHT_GRAY, background: WHITE },
      'normal',
    );
    expect(conflict).not.toBeNull();
    expect(conflict?.elementId).toBe('el-2');
    expect(['low', 'medium', 'high', 'critical']).toContain(conflict?.severity);
  });

  it('flags a typical red/green status pair as a conflict for deuteranopia', () => {
    const red: ColorValue = { r: 0.8, g: 0.1, b: 0.1, alpha: 1 };
    const green: ColorValue = { r: 0.1, g: 0.6, b: 0.1, alpha: 1 };
    const conflict = detectColorConflict(
      'el-3',
      { foreground: red, background: green },
      'deuteranopia',
    );
    expect(conflict).not.toBeNull();
  });

  it('includes both contrast and perceptual distance in the result', () => {
    const conflict = detectColorConflict(
      'el-4',
      { foreground: LIGHT_GRAY, background: WHITE },
      'protanopia',
    );
    expect(conflict?.contrast).toBeGreaterThan(0);
    expect(conflict?.perceptualDistance).toBeGreaterThanOrEqual(0);
    expect(conflict?.reason.length).toBeGreaterThan(0);
  });
});
