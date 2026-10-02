import { browser } from 'wxt/browser';
import type { StorageBackend } from './storage-backend';

/** {@link StorageBackend} backed by `browser.storage.local` (Chrome/Edge/Firefox). */
export function createBrowserStorageBackend(): StorageBackend {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const result = await browser.storage.local.get(key);
      return result[key] as T | undefined;
    },

    async set<T>(key: string, value: T): Promise<void> {
      await browser.storage.local.set({ [key]: value });
    },

    async remove(key: string): Promise<void> {
      await browser.storage.local.remove(key);
    },

    onChange(key: string, callback: (newValue: unknown) => void): () => void {
      const listener = (
        changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
        areaName: string,
      ): void => {
        if (areaName !== 'local') return;
        const change = changes[key];
        if (change) callback(change.newValue);
      };
      browser.storage.onChanged.addListener(listener);
      return () => browser.storage.onChanged.removeListener(listener);
    },
  };
}
