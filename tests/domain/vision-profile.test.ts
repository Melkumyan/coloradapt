import { describe, expect, it } from 'vitest';
import { VISION_PROFILES, VISION_PROFILE_CONFIDENCE, VISION_PROFILE_INFO } from '@domain/models';

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

describe('vision profile model confidence', () => {
  it('mirrors the M2 scientific status of every profile', () => {
    expect(VISION_PROFILE_CONFIDENCE.protanopia).toBe('SUPPORTED_MODEL');
    expect(VISION_PROFILE_CONFIDENCE.deuteranopia).toBe('SUPPORTED_MODEL');
    expect(VISION_PROFILE_CONFIDENCE.tritanopia).toBe('SUPPORTED_MODEL');
    expect(VISION_PROFILE_CONFIDENCE.protanomaly).toBe('MODEL_ASSUMPTION');
    expect(VISION_PROFILE_CONFIDENCE.deuteranomaly).toBe('MODEL_ASSUMPTION');
    expect(VISION_PROFILE_CONFIDENCE.tritanomaly).toBe('APPROXIMATION');
    expect(VISION_PROFILE_CONFIDENCE.achromatopsia).toBe('APPROXIMATION');
    expect(VISION_PROFILE_CONFIDENCE.custom).toBe('UNSUPPORTED');
  });

  it('has an entry for every profile', () => {
    for (const profile of VISION_PROFILES) expect(VISION_PROFILE_CONFIDENCE[profile]).toBeDefined();
  });
});
