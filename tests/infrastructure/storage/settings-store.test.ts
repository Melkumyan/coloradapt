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

describe('SettingsStore semanticCuesEnabled (M6.R1 migration policy)', () => {
  const SETTINGS_KEY = 'coloradapt:settings';

  it('a profile with nothing stored gets true, and reading does not write anything', async () => {
    const backend = createMemoryStorageBackend();
    const store = new SettingsStore(backend);
    expect((await store.get()).semanticCuesEnabled).toBe(true);
    expect(await backend.get(SETTINGS_KEY)).toBeUndefined();
  });

  it('settings saved before M6 (no field) read as true, and other fields are untouched', async () => {
    const backend = createMemoryStorageBackend();
    const { semanticCuesEnabled: _omitted, ...beforeM6 } = DEFAULT_USER_SETTINGS;
    await backend.set(SETTINGS_KEY, { ...beforeM6, adaptSVG: false, visionProfile: 'protanopia' });
    const loaded = await new SettingsStore(backend).get();
    expect(loaded.semanticCuesEnabled).toBe(true);
    expect(loaded.adaptSVG).toBe(false);
    expect(loaded.visionProfile).toBe('protanopia');
  });

  it('an explicit false survives reads and unrelated updates', async () => {
    const backend = createMemoryStorageBackend();
    const store = new SettingsStore(backend);
    await store.update({ semanticCuesEnabled: false });
    for (const patch of [
      { enabled: false },
      { adaptSVG: false },
      { visionProfile: 'tritanopia' as const },
    ]) {
      expect((await store.update(patch)).semanticCuesEnabled).toBe(false);
    }
    expect((await store.get()).semanticCuesEnabled).toBe(false);
    expect((await new SettingsStore(backend).get()).semanticCuesEnabled).toBe(false);
  });

  it('an explicit true stays true; true -> false -> true round-trips', async () => {
    const store = new SettingsStore(createMemoryStorageBackend());
    expect((await store.update({ semanticCuesEnabled: true })).semanticCuesEnabled).toBe(true);
    expect((await store.update({ semanticCuesEnabled: false })).semanticCuesEnabled).toBe(false);
    expect((await store.update({ semanticCuesEnabled: true })).semanticCuesEnabled).toBe(true);
  });

  it('a stored non-boolean falls back to the default (documented), never to false by accident', async () => {
    const backend = createMemoryStorageBackend();
    for (const junk of ['false', 0, null, 'off', {}, []]) {
      await backend.set(SETTINGS_KEY, { ...DEFAULT_USER_SETTINGS, semanticCuesEnabled: junk });
      expect((await new SettingsStore(backend).get()).semanticCuesEnabled).toBe(true);
    }
  });
});
