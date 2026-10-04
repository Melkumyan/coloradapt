import { IMAGE_LIMITS } from '@shared/constants';
import type { ImageEnvironment } from './readability';

/** Marks an `<img>` that shows a ColorAdapt-generated bitmap. Removed again on restore. */
export const IMAGE_OWNED_ATTRIBUTE = 'data-coloradapt-image';

/** One generated bitmap held in memory: its object URL and how many images show it. */
export interface GeneratedImage {
  readonly key: string;
  readonly url: string;
  readonly pixels: number;
  refs: number;
  /** Dropped from the cache while still shown; revoked when the last image lets go. */
  evicted: boolean;
}

/**
 * Memory-only registry of generated bitmaps, keyed by `source + context + profile + strength`
 * (docs/IMAGE_ADAPTATION.md, "Cache"). It owns every object URL ColorAdapt creates and is the only
 * place that revokes them. Images that show the same bitmap share one entry and one URL; an entry
 * lives exactly as long as something shows it (the last release revokes it), so nothing is kept
 * "just in case" and no URL can outlive its images. Bounded by entry count and by pixels: past the
 * bound the oldest entries are dropped from the lookup (their images keep showing them; the last
 * release revokes). Nothing here is persisted anywhere.
 */
export class GeneratedImageCache {
  readonly #env: ImageEnvironment;
  readonly #entries = new Map<string, GeneratedImage>();
  /** Every URL created and not yet revoked (cached or evicted-but-shown). */
  readonly #live = new Set<string>();
  #created = 0;
  #revoked = 0;
  #hits = 0;
  #misses = 0;

  constructor(env: ImageEnvironment) {
    this.#env = env;
  }

  get created(): number {
    return this.#created;
  }
  get revoked(): number {
    return this.#revoked;
  }
  get hits(): number {
    return this.#hits;
  }
  get misses(): number {
    return this.#misses;
  }
  get size(): number {
    return this.#entries.size;
  }
  /** Object URLs created by ColorAdapt and not revoked yet. */
  get liveUrls(): number {
    return this.#live.size;
  }

  /** An entry for `key` with a reference taken for the caller, or `null` on a miss. */
  acquire(key: string): GeneratedImage | null {
    const entry = this.#entries.get(key);
    if (!entry) {
      this.#misses += 1;
      return null;
    }
    this.#hits += 1;
    // Refresh recency: the Map keeps insertion order, so re-insert.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    entry.refs += 1;
    return entry;
  }

  /** Stores a new bitmap and returns it with one reference held. */
  insert(key: string, blob: Blob, pixels: number): GeneratedImage {
    const url = this.#env.createObjectURL(blob);
    this.#created += 1;
    this.#live.add(url);
    const entry: GeneratedImage = { key, url, pixels, refs: 1, evicted: false };
    this.#entries.set(key, entry);
    this.#enforceLimits();
    return entry;
  }

  /** Gives back a reference; an entry nothing shows any more is dropped and its URL revoked. */
  release(entry: GeneratedImage): void {
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs > 0) return;
    if (this.#entries.get(entry.key) === entry) this.#entries.delete(entry.key);
    entry.evicted = true;
    this.#revoke(entry);
  }

  /** Drops everything and revokes every URL still alive (adaptation switched off). */
  clear(): void {
    for (const entry of this.#entries.values()) {
      entry.evicted = true;
      entry.refs = 0;
      this.#revoke(entry);
    }
    this.#entries.clear();
    for (const url of [...this.#live]) {
      this.#env.revokeObjectURL(url);
      this.#revoked += 1;
    }
    this.#live.clear();
  }

  #enforceLimits(): void {
    let pixels = 0;
    for (const entry of this.#entries.values()) pixels += entry.pixels;
    for (const entry of [...this.#entries.values()]) {
      if (
        this.#entries.size <= IMAGE_LIMITS.maxCachedImages &&
        pixels <= IMAGE_LIMITS.maxCachedPixels
      ) {
        break;
      }
      // The newest entry (the one just inserted) always stays: it is about to be shown.
      if (this.#entries.size === 1) break;
      this.#entries.delete(entry.key);
      pixels -= entry.pixels;
      entry.evicted = true;
      if (entry.refs === 0) this.#revoke(entry);
    }
  }

  #revoke(entry: GeneratedImage): void {
    if (!this.#live.delete(entry.url)) return;
    this.#env.revokeObjectURL(entry.url);
    this.#revoked += 1;
  }
}

/** What had to be remembered to put an `<img>` back exactly as the page had it. */
export interface OriginalSource {
  /** The `src` attribute value, or `null` if the page had none. */
  readonly src: string | null;
}

export function captureOriginal(image: Element): OriginalSource {
  return { src: image.getAttribute('src') };
}

/** Shows `url` in place of the image's own bytes. Nothing else about the element changes. */
export function showGenerated(image: Element, url: string): void {
  image.setAttribute('src', url);
  image.setAttribute(IMAGE_OWNED_ATTRIBUTE, 'adapted');
}

/** True while `image` still shows exactly the bitmap we put there. */
export function showsGenerated(image: Element, url: string): boolean {
  return image.getAttribute('src') === url;
}

/**
 * Puts the page's own source back, but only if the element still shows our bitmap: if the page
 * has set a source of its own meanwhile, that is the page's choice and is left alone.
 */
export function restoreOriginal(image: Element, original: OriginalSource, url: string): void {
  if (showsGenerated(image, url)) {
    if (original.src === null) image.removeAttribute('src');
    else image.setAttribute('src', original.src);
  }
  image.removeAttribute(IMAGE_OWNED_ATTRIBUTE);
}
