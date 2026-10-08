import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_SETTINGS } from '@domain/models';
import { resolveEffectiveSettings } from '@features/settings';
import { parseUserSettings } from '@infrastructure/storage';

/**
 * M12 security review: per-site profiles live in an object keyed by hostname, and a hostname is page-controlled
 * text (`http://__proto__/`, `http://constructor/` and `http://toString/` are valid URLs). A key must never reach
 * the object's prototype, and a host that happens to share its name with an inherited property must not be
 * mistaken for a stored profile.
 */
const profile = (hostname: string) => ({
  hostname,
  enabled: false,
  visionProfile: 'protanopia',
  intensity: 0.1,
  adaptUI: false,
  adaptCharts: false,
  adaptImages: false,
});

describe('hostname keys', () => {
  it('a stored "__proto__" key does not replace the prototype of the overrides', () => {
    const raw = JSON.parse(
      JSON.stringify({ siteOverrides: {} }).replace(
        '{}',
        `{"__proto__": ${JSON.stringify(profile('__proto__'))}, "a.test": ${JSON.stringify(profile('a.test'))}}`,
      ),
    ) as unknown;
    const parsed = parseUserSettings(raw);
    expect(Object.getPrototypeOf(parsed.siteOverrides)).toBe(Object.prototype);
    expect(Object.keys(parsed.siteOverrides).sort()).toEqual(['__proto__', 'a.test']);
    expect(({} as Record<string, unknown>)['visionProfile']).toBeUndefined(); // and nothing leaked globally
  });

  it('a host named like an inherited or own-looking property is not a stored profile', () => {
    for (const host of [
      'constructor',
      'toString',
      'valueOf',
      'hasOwnProperty',
      '__proto__',
      'hostname',
      'enabled',
    ]) {
      const effective = resolveEffectiveSettings({ ...DEFAULT_USER_SETTINGS, enabled: true }, host);
      expect(effective.enabled, host).toBe(true);
      expect(effective.visionProfile, host).toBe(DEFAULT_USER_SETTINGS.visionProfile);
    }
  });

  it('a profile stored for a real host still applies', () => {
    const settings = parseUserSettings({
      enabled: true,
      siteOverrides: { 'a.test': profile('a.test') },
    });
    expect(resolveEffectiveSettings(settings, 'a.test').enabled).toBe(false);
    expect(resolveEffectiveSettings(settings, 'a.test').visionProfile).toBe('protanopia');
  });
});
