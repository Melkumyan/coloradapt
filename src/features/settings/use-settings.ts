import { useCallback, useEffect, useState } from 'react';
import { sendToBackground } from '@infrastructure/messaging';
import type { UserSettings } from '@domain/models';

export interface UseSettingsResult {
  readonly settings: UserSettings | null;
  readonly loading: boolean;
  readonly update: (patch: Partial<UserSettings>) => Promise<void>;
}

/** Loads settings from the background script and exposes a typed updater. React/UI-only concern. */
export function useSettings(): UseSettingsResult {
  const [settings, setSettings] = useState<UserSettings | null>(null);

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
