import { describe, expect, it } from 'vitest';
import { parseUserSettings } from '@infrastructure/storage';
import { DEFAULT_USER_SETTINGS } from '@domain/models';

describe('parseUserSettings', () => {
  it('returns defaults for undefined/null/non-object input', () => {
    expect(parseUserSettings(undefined)).toEqual(DEFAULT_USER_SETTINGS);
    expect(parseUserSettings(null)).toEqual(DEFAULT_USER_SETTINGS);
    expect(parseUserSettings('nonsense')).toEqual(DEFAULT_USER_SETTINGS);
  });

  it('round-trips a fully valid settings object', () => {
    const valid = {
      ...DEFAULT_USER_SETTINGS,
      enabled: false,
      visionProfile: 'deuteranopia' as const,
    };
    expect(parseUserSettings(valid)).toEqual(valid);
  });

  it('falls back field-by-field for invalid values instead of rejecting the whole object', () => {
    const result = parseUserSettings({
      enabled: 'yes', // invalid type
      visionProfile: 'not-a-real-profile',
      adaptationStrength: 5, // out of 0-1 range
      improveLinks: false,
    });

    expect(result.enabled).toBe(DEFAULT_USER_SETTINGS.enabled);
    expect(result.visionProfile).toBe(DEFAULT_USER_SETTINGS.visionProfile);
    expect(result.adaptationStrength).toBe(1);
    expect(result.improveLinks).toBe(false);
  });

  describe('adaptSVG (M5.R1 migration)', () => {
    it('is true on a fresh install', () => {
      expect(DEFAULT_USER_SETTINGS.adaptSVG).toBe(true);
      expect(parseUserSettings(undefined).adaptSVG).toBe(true);
    });

    it('settings stored before M5 (no adaptSVG field) load with the product default, true', () => {
      const { adaptSVG: _omitted, ...beforeM5 } = DEFAULT_USER_SETTINGS;
      const old = { ...beforeM5, visionProfile: 'protanopia', improveLinks: false };
      const result = parseUserSettings(old);
      expect(result.adaptSVG).toBe(true);
      // ...and nothing else about the stored settings changed.
      expect(result).toMatchObject({ visionProfile: 'protanopia', improveLinks: false });
    });

    it('an explicitly stored value is never overridden, true or false', () => {
      expect(parseUserSettings({ adaptSVG: false }).adaptSVG).toBe(false);
      expect(parseUserSettings({ adaptSVG: true }).adaptSVG).toBe(true);
    });

    it('a non-boolean stored value falls back to the default instead of rejecting the object', () => {
      const result = parseUserSettings({ adaptSVG: 'no', enabled: false });
      expect(result.adaptSVG).toBe(true);
      expect(result.enabled).toBe(false);
    });
  });

  it('drops malformed site overrides but keeps valid ones', () => {
    const result = parseUserSettings({
      siteOverrides: {
        'good.example': { enabled: true, visionProfile: 'tritanopia', intensity: 0.4 },
        'bad.example': 'not-an-object',
      },
    });

    expect(result.siteOverrides['good.example']).toMatchObject({
      hostname: 'good.example',
      visionProfile: 'tritanopia',
      intensity: 0.4,
    });
    expect(result.siteOverrides['bad.example']).toBeUndefined();
  });
});
