import type { StorageBackend } from './storage-backend';

/** In-memory {@link StorageBackend}, used in tests and wherever no browser is available. */
export function createMemoryStorageBackend(): StorageBackend {
  const store = new Map<string, unknown>();
  const listeners = new Map<string, Set<(value: unknown) => void>>();

  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async get<T>(key: string): Promise<T | undefined> {
      return store.get(key) as T | undefined;
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async set<T>(key: string, value: T): Promise<void> {
      store.set(key, value);
      for (const listener of listeners.get(key) ?? []) listener(value);
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async remove(key: string): Promise<void> {
      store.delete(key);
    },

    onChange(key: string, callback: (newValue: unknown) => void): () => void {
      const set = listeners.get(key) ?? new Set();
      set.add(callback);
      listeners.set(key, set);
      return () => set.delete(callback);
    },
  };
}
