import { useCallback, useEffect, useState } from 'react';
import { sendToBackground } from '@infrastructure/messaging';
import { SettingsStore, createBrowserStorageBackend } from '@infrastructure/storage';
import type { UserSettings } from '@domain/models';

export interface UseSettingsResult {
  readonly settings: UserSettings | null;
  readonly loading: boolean;
  /** `true` once the background could not be reached (or refused): the page shows that instead of loading forever. */
  readonly failed: boolean;
  /** Resolves `false` when the change was not stored: callers must not act as if it had been. */
  readonly update: (patch: Partial<UserSettings>) => Promise<boolean>;
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
  const [failed, setFailed] = useState(false);
  const live = options.live === true;

  useEffect(() => {
    if (!live) return undefined;
    return new SettingsStore(createBrowserStorageBackend()).onChange(setSettings);
  }, [live]);

  useEffect(() => {
    let cancelled = false;
    sendToBackground('GET_SETTINGS', undefined)
      .then((result) => {
        // A handler that failed answers `undefined` (infrastructure/messaging/router.ts): not settings.
        if (cancelled) return;
        if (result === undefined) setFailed(true);
        else setSettings(result);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback(async (patch: Partial<UserSettings>): Promise<boolean> => {
    try {
      const next = await sendToBackground('UPDATE_SETTINGS', patch);
      if (next === undefined) {
        setFailed(true);
        return false;
      }
      setSettings(next);
      return true;
    } catch {
      setFailed(true);
      return false;
    }
  }, []);

  return { settings, loading: settings === null && !failed, failed, update };
}
