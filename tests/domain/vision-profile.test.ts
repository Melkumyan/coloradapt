import { describe, expect, it } from 'vitest';
import { VISION_PROFILES, VISION_PROFILE_INFO } from '@domain/models';

describe('vision profile config', () => {
  it('has metadata for every declared profile', () => {
    for (const profile of VISION_PROFILES) {
      const info = VISION_PROFILE_INFO[profile];
      expect(info).toBeDefined();
      expect(info.id).toBe(profile);
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.defaultSeverity).toBeGreaterThanOrEqual(0);
      expect(info.defaultSeverity).toBeLessThanOrEqual(1);
    }
  });

  it('gives dichromacies full severity and anomalies partial severity', () => {
    expect(VISION_PROFILE_INFO.protanopia.defaultSeverity).toBe(1);
    expect(VISION_PROFILE_INFO.deuteranopia.defaultSeverity).toBe(1);
    expect(VISION_PROFILE_INFO.tritanopia.defaultSeverity).toBe(1);
    expect(VISION_PROFILE_INFO.protanomaly.defaultSeverity).toBeLessThan(1);
    expect(VISION_PROFILE_INFO.deuteranomaly.defaultSeverity).toBeLessThan(1);
    expect(VISION_PROFILE_INFO.tritanomaly.defaultSeverity).toBeLessThan(1);
  });
});
