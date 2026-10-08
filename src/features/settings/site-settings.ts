import type { UserSettings } from '@domain/models';

/**
 * Resolves the settings that actually apply on `hostname`: a stored
 * per-site override (if any) narrows or replaces the global ones. A site
 * that is disabled — or while the global switch is off — never adapts.
 * Pure; the storage schema is unchanged.
 */
export function resolveEffectiveSettings(
  settings: UserSettings,
  hostname: string | null,
): UserSettings {
  // Own properties only: a host named `constructor` or `toString` is not a stored profile.
  const site =
    hostname && Object.hasOwn(settings.siteOverrides, hostname)
      ? settings.siteOverrides[hostname]
      : undefined;
  if (!site) return settings;

  return {
    ...settings,
    enabled: settings.enabled && site.enabled,
    visionProfile: site.visionProfile,
    adaptationStrength: site.intensity,
    improveUIColors: settings.improveUIColors && site.adaptUI,
    // Narrowing only, like adaptUI: a site can switch image adaptation off, never on behind the
    // global opt-in (the layer is off by default and a wrongly changed image is the costly error).
    adaptImages: settings.adaptImages && site.adaptImages,
  };
}
