import { describe, expect, it } from 'vitest';
import { computeAdaptation } from '@core/adaptation';
import { DEFAULT_USER_SETTINGS } from '@domain/models';
import type { AnalysisResult, ColorConflict } from '@domain/models';

function makeConflict(overrides: Partial<ColorConflict> = {}): ColorConflict {
  const lightGray = { r: 0.85, g: 0.85, b: 0.85, alpha: 1 };
  const white = { r: 1, g: 1, b: 1, alpha: 1 };
  return {
    elementId: 'el-1',
    foreground: lightGray,
    background: white,
    simulatedForeground: lightGray,
    simulatedBackground: white,
    perceptualDistance: 0.02,
    contrast: 1.3,
    severity: 'critical',
    reason: 'test conflict',
    ...overrides,
  };
}

function makeAnalysis(conflicts: ColorConflict[]): AnalysisResult {
  return {
    url: 'https://example.com',
    timestamp: Date.now(),
    elements: [],
    conflicts,
    truncated: false,
    unresolvedCount: 0,
  };
}

describe('computeAdaptation', () => {
  it('produces no changes when adaptation is disabled', () => {
    const analysis = makeAnalysis([makeConflict()]);
    const result = computeAdaptation(analysis, 'normal', {
      ...DEFAULT_USER_SETTINGS,
      enabled: false,
    });
    expect(result.changes).toHaveLength(0);
  });

  it('produces no changes when there are no conflicts', () => {
    const result = computeAdaptation(makeAnalysis([]), 'normal', DEFAULT_USER_SETTINGS);
    expect(result.changes).toHaveLength(0);
  });

  it('leaves low-severity conflicts untouched', () => {
    const analysis = makeAnalysis([makeConflict({ severity: 'low' })]);
    const result = computeAdaptation(analysis, 'normal', DEFAULT_USER_SETTINGS);
    expect(result.changes).toHaveLength(0);
  });

  it('proposes a color change for a critical, low-contrast conflict', () => {
    const analysis = makeAnalysis([makeConflict()]);
    const result = computeAdaptation(analysis, 'normal', DEFAULT_USER_SETTINGS);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ elementId: 'el-1', property: 'color' });
    expect(result.changes[0]?.adaptedValue).not.toBe(result.changes[0]?.originalValue);
  });
});
