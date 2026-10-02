import { describe, expect, it } from 'vitest';
import { createMemoryStorageBackend, SettingsStore } from '@infrastructure/storage';
import { DEFAULT_USER_SETTINGS } from '@domain/models';

describe('SettingsStore', () => {
  it('returns defaults when nothing has been stored yet', async () => {
    const store = new SettingsStore(createMemoryStorageBackend());
    await expect(store.get()).resolves.toEqual(DEFAULT_USER_SETTINGS);
  });

  it('persists partial updates merged onto the current settings', async () => {
    const store = new SettingsStore(createMemoryStorageBackend());
    await store.update({ enabled: false });
    const updated = await store.update({ visionProfile: 'tritanopia' });

    expect(updated.enabled).toBe(false);
    expect(updated.visionProfile).toBe('tritanopia');
    await expect(store.get()).resolves.toEqual(updated);
  });

  it('adds and removes a site profile override', async () => {
    const store = new SettingsStore(createMemoryStorageBackend());
    await store.setSiteProfile({
      hostname: 'example.com',
      enabled: true,
      visionProfile: 'deuteranopia',
      intensity: 0.5,
      adaptUI: true,
      adaptCharts: false,
      adaptImages: false,
    });

    let settings = await store.get();
    expect(settings.siteOverrides['example.com']?.visionProfile).toBe('deuteranopia');

    await store.removeSiteProfile('example.com');
    settings = await store.get();
    expect(settings.siteOverrides['example.com']).toBeUndefined();
  });

  it('notifies subscribers on change', async () => {
    const backend = createMemoryStorageBackend();
    const store = new SettingsStore(backend);
    const seen: boolean[] = [];
    const unsubscribe = store.onChange((settings) => seen.push(settings.enabled));

    await store.update({ enabled: false });
    unsubscribe();
    await store.update({ enabled: true });

    expect(seen).toEqual([false]);
  });
});
