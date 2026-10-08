import { DEFAULT_USER_SETTINGS } from '@domain/models';
import type { SiteProfile, UserSettings } from '@domain/models';
import { parseUserSettings } from './schema';
import type { RecoveryReport } from './schema';
import type { StorageBackend } from './storage-backend';

const SETTINGS_KEY = 'coloradapt:settings';

/**
 * The only place in the app that knows the storage key/shape for user
 * settings. UI code calls this instead of touching `browser.storage`
 * (or a {@link StorageBackend}) directly.
 */
export class SettingsStore {
  #backend: StorageBackend;
  #lastRecovery = '';

  constructor(backend: StorageBackend) {
    this.#backend = backend;
  }

  async get(): Promise<UserSettings> {
    const raw = await this.#backend.get<unknown>(SETTINGS_KEY);
    if (raw === undefined) return DEFAULT_USER_SETTINGS;
    const report: RecoveryReport = [];
    const settings = parseUserSettings(raw, report);
    // A diagnostic, once per worker/page lifetime and per distinct damage: which stored fields were unusable
    // (names only, never values). The settings that come back are valid either way.
    const signature = report.join(',');
    if (signature !== '' && signature !== this.#lastRecovery) {
      this.#lastRecovery = signature;
      console.warn('[ColorAdapt] diagnostic: storage-recovered', signature);
    }
    return settings;
  }

  async update(patch: Partial<UserSettings>): Promise<UserSettings> {
    const current = await this.get();
    // What is stored is always what the schema accepts (clamped numbers, known enums, loopback endpoints only):
    // a patch from any context cannot persist a shape the readers would have to defend against.
    const next: UserSettings = parseUserSettings({ ...current, ...patch });
    await this.#backend.set(SETTINGS_KEY, next);
    return next;
  }

  async setSiteProfile(profile: SiteProfile): Promise<UserSettings> {
    const current = await this.get();
    return this.update({
      siteOverrides: { ...current.siteOverrides, [profile.hostname]: profile },
    });
  }

  async removeSiteProfile(hostname: string): Promise<UserSettings> {
    const current = await this.get();
    const { [hostname]: _removed, ...rest } = current.siteOverrides;
    return this.update({ siteOverrides: rest });
  }

  onChange(callback: (settings: UserSettings) => void): () => void {
    return this.#backend.onChange(SETTINGS_KEY, (value) => callback(parseUserSettings(value)));
  }
}
