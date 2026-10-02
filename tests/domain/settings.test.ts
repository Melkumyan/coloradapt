import { describe, expect, it } from 'vitest';
import { createDefaultSiteProfile, DEFAULT_USER_SETTINGS } from '@domain/models';

describe('DEFAULT_USER_SETTINGS', () => {
  it('starts enabled with no site overrides', () => {
    expect(DEFAULT_USER_SETTINGS.enabled).toBe(true);
    expect(Object.keys(DEFAULT_USER_SETTINGS.siteOverrides)).toHaveLength(0);
  });

  it('keeps adaptationStrength within 0-1', () => {
    expect(DEFAULT_USER_SETTINGS.adaptationStrength).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_USER_SETTINGS.adaptationStrength).toBeLessThanOrEqual(1);
  });
});

describe('createDefaultSiteProfile', () => {
  it('builds an enabled profile for the given hostname', () => {
    const profile = createDefaultSiteProfile('example.com');
    expect(profile.hostname).toBe('example.com');
    expect(profile.enabled).toBe(true);
    expect(profile.visionProfile).toBe('normal');
  });
});
