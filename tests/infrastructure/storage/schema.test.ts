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

  describe('adaptImages (M8)', () => {
    it('is false on a fresh install: image changes are opt-in', () => {
      expect(DEFAULT_USER_SETTINGS.adaptImages).toBe(false);
      expect(parseUserSettings(undefined).adaptImages).toBe(false);
    });

    it('settings stored before M8 (no field) load with false and nothing else changes', () => {
      const { adaptImages: _omitted, ...beforeM8 } = DEFAULT_USER_SETTINGS;
      const result = parseUserSettings({ ...beforeM8, visionProfile: 'protanopia' });
      expect(result.adaptImages).toBe(false);
      expect(result.visionProfile).toBe('protanopia');
    });

    it('an explicit value is never overridden, true or false', () => {
      expect(parseUserSettings({ adaptImages: true }).adaptImages).toBe(true);
      expect(parseUserSettings({ adaptImages: false }).adaptImages).toBe(false);
    });

    it('an invalid value falls back to false instead of rejecting the object', () => {
      for (const invalid of ['yes', 1, null, {}, []]) {
        const result = parseUserSettings({ adaptImages: invalid, enabled: false });
        expect(result.adaptImages).toBe(false);
        expect(result.enabled).toBe(false);
      }
    });
  });

  describe('semanticCuesEnabled (M6 migration)', () => {
    it('is true on a fresh install: high confidence, color-only and safe placement are required anyway', () => {
      expect(DEFAULT_USER_SETTINGS.semanticCuesEnabled).toBe(true);
      expect(parseUserSettings(undefined).semanticCuesEnabled).toBe(true);
    });

    it('settings stored before M6 (no field) load with the product default and nothing else changes', () => {
      const { semanticCuesEnabled: _omitted, ...beforeM6 } = DEFAULT_USER_SETTINGS;
      const old = { ...beforeM6, visionProfile: 'tritanopia', adaptSVG: false };
      const result = parseUserSettings(old);
      expect(result.semanticCuesEnabled).toBe(true);
      expect(result).toMatchObject({ visionProfile: 'tritanopia', adaptSVG: false });
    });

    it('an explicitly stored value is never overridden, true or false', () => {
      expect(parseUserSettings({ semanticCuesEnabled: false }).semanticCuesEnabled).toBe(false);
      expect(parseUserSettings({ semanticCuesEnabled: true }).semanticCuesEnabled).toBe(true);
    });

    it('a non-boolean stored value falls back to the default instead of rejecting the object', () => {
      const result = parseUserSettings({ semanticCuesEnabled: 'off', enabled: false });
      expect(result.semanticCuesEnabled).toBe(true);
      expect(result.enabled).toBe(false);
    });
  });

  describe('adaptCharts (M7 migration)', () => {
    it('is true on a fresh install: only HIGH-confidence, mappable charts are ever written to', () => {
      expect(DEFAULT_USER_SETTINGS.adaptCharts).toBe(true);
      expect(parseUserSettings(undefined).adaptCharts).toBe(true);
    });

    it('field absent: the product default, and nothing else about the stored settings changes', () => {
      const { adaptCharts: _omitted, ...beforeM7 } = DEFAULT_USER_SETTINGS;
      const result = parseUserSettings({
        ...beforeM7,
        visionProfile: 'tritanopia',
        semanticCuesEnabled: false,
      });
      expect(result.adaptCharts).toBe(true);
      expect(result).toMatchObject({ visionProfile: 'tritanopia', semanticCuesEnabled: false });
    });

    it('explicit true and explicit false are never overridden (settings saved by M1-M6 hold false)', () => {
      expect(parseUserSettings({ adaptCharts: true }).adaptCharts).toBe(true);
      expect(parseUserSettings({ adaptCharts: false }).adaptCharts).toBe(false);
    });

    it('an invalid value falls back to the default instead of rejecting the object', () => {
      for (const invalid of ['no', 0, 1, null, {}, []]) {
        const result = parseUserSettings({ adaptCharts: invalid, enabled: false });
        expect(result.adaptCharts).toBe(true);
        expect(result.enabled).toBe(false);
      }
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
