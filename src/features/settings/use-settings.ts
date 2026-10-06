import { useCallback, useEffect, useState } from 'react';
import { sendToBackground } from '@infrastructure/messaging';
import { SettingsStore, createBrowserStorageBackend } from '@infrastructure/storage';
import type { UserSettings } from '@domain/models';

export interface UseSettingsResult {
  readonly settings: UserSettings | null;
  readonly loading: boolean;
  readonly update: (patch: Partial<UserSettings>) => Promise<void>;
}

export interface UseSettingsOptions {
  /**
   * Follow changes made elsewhere (the options page, another window) while this page is open. The audit
   * page needs it: turning the AI-assisted review off must stop a review already running there.
   */
  readonly live?: boolean;
}

/** Loads settings from the background script and exposes a typed updater. React/UI-only concern. */
export function useSettings(options: UseSettingsOptions = {}): UseSettingsResult {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const live = options.live === true;

  useEffect(() => {
    if (!live) return undefined;
    return new SettingsStore(createBrowserStorageBackend()).onChange(setSettings);
  }, [live]);

  useEffect(() => {
    let cancelled = false;
    void sendToBackground('GET_SETTINGS', undefined).then((result) => {
      if (!cancelled) setSettings(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback(async (patch: Partial<UserSettings>) => {
    const next = await sendToBackground('UPDATE_SETTINGS', patch);
    setSettings(next);
  }, []);

  return { settings, loading: settings === null, update };
}
