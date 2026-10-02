/**
 * Minimal key-value storage contract. Keeps the rest of the app from
 * depending directly on `browser.storage`, so it can be swapped for an
 * in-memory fake in tests or a different backend later.
 */
export interface StorageBackend {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
  onChange(key: string, callback: (newValue: unknown) => void): () => void;
}
