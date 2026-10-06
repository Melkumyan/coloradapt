import type { Interpreted } from './interpret';
import { INSTRUCTION_VERSION } from './prompt';
import { SEMANTIC_LIMITS, SEMANTIC_SCHEMA_VERSION } from './taxonomy';

/**
 * Memory-only, bounded, LRU (docs/AI_SEMANTIC_ENGINE.md, "Cache"). It holds interpreted answers
 * (labels, ids, statuses), never a prompt, a packet or raw model output, and it is never written
 * to extension storage. It lives and dies with the audit page.
 */

export function cacheKey(
  provider: string,
  model: string | null,
  task: string,
  inputHash: string,
): string {
  return `${provider}|${model ?? '-'}|${task}|${inputHash}|v${SEMANTIC_SCHEMA_VERSION}|i${INSTRUCTION_VERSION}`;
}

function sizeOf(value: Interpreted): number {
  return JSON.stringify(value).length + 64;
}

export class SemanticCache {
  readonly #entries = new Map<string, { value: Interpreted; size: number }>();
  #bytes = 0;
  readonly #maxEntries: number;
  readonly #maxBytes: number;

  constructor(
    maxEntries: number = SEMANTIC_LIMITS.cacheEntries,
    maxBytes: number = SEMANTIC_LIMITS.cacheBytes,
  ) {
    this.#maxEntries = maxEntries;
    this.#maxBytes = maxBytes;
  }

  get size(): number {
    return this.#entries.size;
  }

  get bytes(): number {
    return this.#bytes;
  }

  get(key: string): Interpreted | undefined {
    const hit = this.#entries.get(key);
    if (!hit) return undefined;
    // Most recently used goes last.
    this.#entries.delete(key);
    this.#entries.set(key, hit);
    return hit.value;
  }

  set(key: string, value: Interpreted): void {
    const size = sizeOf(value);
    if (size > this.#maxBytes) return;
    const old = this.#entries.get(key);
    if (old) {
      this.#bytes -= old.size;
      this.#entries.delete(key);
    }
    this.#entries.set(key, { value, size });
    this.#bytes += size;
    while (this.#entries.size > this.#maxEntries || this.#bytes > this.#maxBytes) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      const evicted = this.#entries.get(oldest.value);
      this.#bytes -= evicted?.size ?? 0;
      this.#entries.delete(oldest.value);
    }
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }
}
