import { describe, expect, it } from 'vitest';
import { resolveEffectiveSettings } from '@features/settings';
import { createDefaultSiteProfile, DEFAULT_USER_SETTINGS, type UserSettings } from '@domain/models';

describe('resolveEffectiveSettings', () => {
  it('returns the global settings when the site has no override', () => {
    expect(resolveEffectiveSettings(DEFAULT_USER_SETTINGS, 'example.com')).toBe(
      DEFAULT_USER_SETTINGS,
    );
    expect(resolveEffectiveSettings(DEFAULT_USER_SETTINGS, null)).toBe(DEFAULT_USER_SETTINGS);
  });

  it('applies a site override on top of the global settings', () => {
    const settings = {
      ...DEFAULT_USER_SETTINGS,
      siteOverrides: {
        'example.com': {
          ...createDefaultSiteProfile('example.com'),
          visionProfile: 'deuteranopia' as const,
          intensity: 0.4,
        },
      },
    };
    const effective = resolveEffectiveSettings(settings, 'example.com');
    expect(effective.visionProfile).toBe('deuteranopia');
    expect(effective.adaptationStrength).toBe(0.4);
    expect(effective.enabled).toBe(true);
    expect(resolveEffectiveSettings(settings, 'other.com')).toBe(settings);
  });

  it('a disabled site (or a disabled global switch) never adapts', () => {
    const site = { ...createDefaultSiteProfile('example.com'), enabled: false };
    const withSiteOff = {
      ...DEFAULT_USER_SETTINGS,
      siteOverrides: { 'example.com': site },
    };
    expect(resolveEffectiveSettings(withSiteOff, 'example.com').enabled).toBe(false);

    const globalOff = {
      ...DEFAULT_USER_SETTINGS,
      enabled: false,
      siteOverrides: { 'example.com': createDefaultSiteProfile('example.com') },
    };
    expect(resolveEffectiveSettings(globalOff, 'example.com').enabled).toBe(false);
  });

  describe('adaptImages precedence: effective = global AND site (no override = global)', () => {
    const withImages = (global: boolean, site: boolean | null): UserSettings => ({
      ...DEFAULT_USER_SETTINGS,
      adaptImages: global,
      siteOverrides:
        site === null
          ? {}
          : { 'a.com': { ...createDefaultSiteProfile('a.com'), adaptImages: site } },
    });

    it.each([
      [false, true, false],
      [true, false, false],
      [true, true, true],
      [false, false, false],
      [true, null, true],
      [false, null, false],
    ])('global %s + site %s -> %s', (global, site, expected) => {
      expect(resolveEffectiveSettings(withImages(global, site), 'a.com').adaptImages).toBe(
        expected,
      );
    });

    it('is decided per hostname: site A on, site B off, no shared state', () => {
      const settings = {
        ...DEFAULT_USER_SETTINGS,
        adaptImages: true,
        siteOverrides: {
          'a.com': { ...createDefaultSiteProfile('a.com'), adaptImages: true },
          'b.com': { ...createDefaultSiteProfile('b.com'), adaptImages: false },
        },
      };
      expect(resolveEffectiveSettings(settings, 'a.com').adaptImages).toBe(true);
      expect(resolveEffectiveSettings(settings, 'b.com').adaptImages).toBe(false);
      expect(resolveEffectiveSettings(settings, 'a.com').adaptImages).toBe(true);
      expect(resolveEffectiveSettings(settings, 'c.com').adaptImages).toBe(true);
    });
  });
});
