import { describe, expect, it } from 'vitest';
import { resolveEffectiveSettings } from '@features/settings';
import { createDefaultSiteProfile, DEFAULT_USER_SETTINGS } from '@domain/models';

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
});
