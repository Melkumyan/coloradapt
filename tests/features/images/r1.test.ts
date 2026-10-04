import { afterEach, describe, expect, it } from 'vitest';
import { IMAGE_LIMITS } from '@shared/constants';
import { GeneratedImageCache } from '@features/images';
import { FakeImageEnvironment } from './fake-env';
import { abs, iconPixels, makeImage, pageSetsSrc, setup, setupDynamic } from './kit';
import { hex } from '../../core/images/pixels';

/**
 * M8.R1: the asynchronous and lifecycle guarantees, staged with held reads (no sleeping, no
 * timers). Every test ends with the same invariant: object URLs created - revoked == live.
 */
const HOST = '<div id="host"></div>';
const host = (): HTMLElement => document.getElementById('host')!;
const ATTRS = { class: 'icon', alt: 'Alert' };

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 4000 && !condition(); i += 1) await Promise.resolve();
  expect(condition()).toBe(true);
}

function accounted(env: FakeImageEnvironment, owned: number): void {
  expect(env.created.length - env.revoked.length).toBe(env.live.length);
  expect(env.live).toHaveLength(owned);
}

describe('source races', () => {
  it('A -> B -> C with the late answers arriving in reverse: only C is shown, nothing of A or B is built', async () => {
    const kit = setup(HOST);
    const [A, B, C] = ['a', 'b', 'c'].map((n) => abs(`/i/${n}.png`)) as [string, string, string];
    const img = makeImage({ src: A, attrs: ATTRS });
    host().append(img);
    kit.env
      .set(A, iconPixels())
      .set(B, iconPixels(hex('#c0392b')))
      .set(C, iconPixels(hex('#d62728')));
    kit.env.hold(A);
    kit.env.hold(B);
    kit.enable();
    await until(() => kit.env.reads.some((r) => r.url === A));
    pageSetsSrc(img, B);
    await until(() => kit.env.reads.some((r) => r.url === B));
    pageSetsSrc(img, C);
    await until(() => kit.controller.inspectImage(img)?.originalSource === C);
    const shown = img.getAttribute('src');

    kit.env.release(B); // B answers first (late), A is still outstanding
    await until(() => kit.controller.incremental.imageDiagnostics().staleResultsDiscarded >= 1);
    kit.env.release(A);
    await kit.settle();

    expect(img.getAttribute('src')).toBe(shown);
    expect(kit.controller.inspectImage(img)?.originalSource).toBe(C);
    expect(kit.env.created).toHaveLength(1);
    accounted(kit.env, 1);
    kit.controller.disableAdaptation();
    expect(img.getAttribute('src')).toBe(C);
    accounted(kit.env, 0);
  });

  it('removed while its bitmap is being built: nothing is shown and the built URL is revoked', async () => {
    const kit = setupDynamic(HOST);
    const A = abs('/i/a.png');
    const img = makeImage({ src: A, attrs: ATTRS });
    host().append(img);
    kit.env.set(A, iconPixels());
    kit.env.hold(A, 1); // analysis passes, the transform read waits
    kit.enable();
    await until(() => kit.env.reads.filter((r) => r.url === A).length === 2);
    img.remove();
    kit.controller.dynamic.flush();
    kit.env.release(A);
    await kit.settle();
    expect(img.getAttribute('src')).toBe(A);
    expect(kit.controller.incremental.imageDiagnostics()).toMatchObject({
      imagesTracked: 0,
      imageOwners: 0,
      pendingReads: 0,
      queuedImages: 0,
    });
    accounted(kit.env, 0);
  });

  it('the setting goes OFF while the transform is in flight: the result is discarded, the original stays', async () => {
    const kit = setup(HOST);
    const A = abs('/i/a.png');
    const img = makeImage({ src: A, attrs: ATTRS });
    host().append(img);
    kit.env.set(A, iconPixels());
    kit.env.hold(A, 1);
    kit.enable();
    await until(() => kit.env.reads.filter((r) => r.url === A).length === 2);
    kit.enable({ adaptImages: false }); // the user switched the layer off
    kit.env.release(A);
    await kit.settle();
    expect(img.getAttribute('src')).toBe(A);
    expect(img.hasAttribute('data-coloradapt-image')).toBe(false);
    expect(kit.controller.incremental.imageDiagnostics()).toMatchObject({
      imageOwners: 0,
      ownedUrls: 0,
      loadListeners: 0,
      themeListeners: 0,
    });
    accounted(kit.env, 0);
  });

  it('the profile changes while the old profile is being processed: only the current profile is applied', async () => {
    const A = abs('/i/a.png');
    const ground = { background: '#5c7c2b' };
    const red = () => iconPixels(hex('#e03131'));
    /** What a fresh start under `profile` shows for this icon. */
    const reference = async (profile: 'protanopia' | 'deuteranopia') => {
      const fresh = setup(HOST, ground);
      const image = makeImage({ src: A, attrs: ATTRS });
      host().append(image);
      fresh.env.set(A, red());
      fresh.enable({ visionProfile: profile });
      await fresh.settle();
      const pixels = fresh.env.pixelsOf(image.getAttribute('src')!);
      fresh.controller.disableAdaptation();
      document.body.innerHTML = '';
      return pixels ? Array.from(pixels.data) : null;
    };
    const wanted = await reference('protanopia');
    const stale = await reference('deuteranopia');
    expect(wanted).not.toBeNull();
    expect(stale).not.toBeNull();
    expect(wanted).not.toEqual(stale); // otherwise the race below proves nothing

    const kit = setup(HOST, ground);
    const img = makeImage({ src: A, attrs: ATTRS });
    host().append(img);
    kit.env.set(A, red());
    kit.env.hold(A, 1);
    kit.enable({ visionProfile: 'deuteranopia' });
    await until(() => kit.env.reads.filter((r) => r.url === A).length === 2);
    kit.enable({ visionProfile: 'protanopia' });
    kit.env.release(A);
    await kit.settle();

    expect(img.getAttribute('src')).toMatch(/^blob:/);
    expect(Array.from(kit.env.pixelsOf(img.getAttribute('src')!)!.data)).toEqual(wanted);
    accounted(kit.env, 1);
    kit.controller.disableAdaptation();
    accounted(kit.env, 0);
  });

  it('the page sets a new source while ours is shown: the page wins, ours is revoked, OFF restores the page value', async () => {
    const kit = setup(HOST);
    const A = abs('/i/a.png');
    const B = abs('/i/b.png');
    const img = makeImage({ src: A, attrs: ATTRS });
    host().append(img);
    kit.env.set(A, iconPixels()).set(B, 'tainted');
    kit.enable();
    await kit.settle();
    const ours = img.getAttribute('src')!;
    expect(ours).toMatch(/^blob:/);
    pageSetsSrc(img, B);
    await kit.settle();
    expect(kit.env.revoked).toContain(ours);
    expect(img.getAttribute('src')).toBe(B);
    expect(kit.controller.inspectImage(img)?.originalSource).toBeNull();
    kit.controller.disableAdaptation();
    expect(img.getAttribute('src')).toBe(B);
    accounted(kit.env, 0);
  });

  it('a page-owned blob: URL is never revoked, ours always are', async () => {
    const kit = setup(HOST);
    const PAGE_BLOB = 'blob:https://example.com/page-owned';
    const img = makeImage({ src: PAGE_BLOB, attrs: ATTRS });
    host().append(img);
    kit.env.set(PAGE_BLOB, iconPixels());
    kit.enable();
    await kit.settle();
    expect(img.getAttribute('src')).not.toBe(PAGE_BLOB);
    kit.controller.disableAdaptation();
    expect(img.getAttribute('src')).toBe(PAGE_BLOB);
    expect(kit.env.revoked).not.toContain(PAGE_BLOB);
    expect(kit.env.revoked.every((url) => url.startsWith('blob:fake/'))).toBe(true);
    accounted(kit.env, 0);
  });
});

describe('the browser is given another choice (srcset, picture)', () => {
  it('a srcset added to an adapted image: the candidate of the page wins, our bitmap and owner are released', async () => {
    const kit = setup(HOST);
    const A = abs('/i/a.png');
    const img = makeImage({ src: A, attrs: ATTRS });
    host().append(img);
    kit.env.set(A, iconPixels());
    kit.enable();
    await kit.settle();
    expect(img.getAttribute('src')).toMatch(/^blob:/);

    img.setAttribute('srcset', `${A} 1x, ${A} 2x`);
    // The browser now loads a srcset candidate: currentSrc is no longer our bitmap.
    Object.defineProperty(img, 'currentSrc', { value: A, configurable: true });
    img.dispatchEvent(new Event('load'));
    await kit.settle();

    expect(img.getAttribute('src')).toBe(A);
    expect(img.hasAttribute('data-coloradapt-image')).toBe(false);
    expect(kit.controller.inspectImage(img)).toMatchObject({
      action: 'unsupported',
      reason: 'responsive-source',
    });
    expect(kit.controller.incremental.imageDiagnostics()).toMatchObject({
      imageOwners: 0,
      ownedUrls: 0,
    });
    accounted(kit.env, 0);
  });

  it('a responsive image that stops being one (srcset removed) is classified again from its new resource', async () => {
    const kit = setup(HOST);
    const A = abs('/i/a.png');
    const B = abs('/i/b.png');
    const img = makeImage({ src: A, attrs: { ...ATTRS, srcset: `${A} 1x, ${A} 2x` } });
    host().append(img);
    kit.env.set(A, iconPixels()).set(B, iconPixels());
    kit.enable();
    await kit.settle();
    expect(kit.controller.inspectImage(img)).toMatchObject({ reason: 'responsive-source' });
    expect(kit.env.created).toHaveLength(0);

    img.removeAttribute('srcset');
    pageSetsSrc(img, B);
    await kit.settle();
    expect(kit.controller.inspectImage(img)).toMatchObject({
      action: 'pixel-adapted',
      originalSource: B,
    });
    accounted(kit.env, 1);
  });
});

describe('a bitmap the browser refuses', () => {
  it('error on our URL: the original is back, the URL is revoked, and the same bitmap is never retried', async () => {
    const kit = setup(HOST);
    const A = abs('/i/a.png');
    const img = makeImage({ src: A, attrs: ATTRS });
    host().append(img);
    kit.env.set(A, iconPixels());
    kit.enable();
    await kit.settle();
    const ours = img.getAttribute('src')!;
    img.dispatchEvent(new Event('error'));
    await kit.settle();
    expect(img.getAttribute('src')).toBe(A);
    expect(kit.env.revoked).toContain(ours);
    // The restore makes the browser load A again: that load must not start a retry loop.
    img.dispatchEvent(new Event('load'));
    await kit.settle();
    expect(img.getAttribute('src')).toBe(A);
    expect(kit.env.created).toHaveLength(1);
    const reads = kit.env.reads.length;
    for (let i = 0; i < 5; i += 1) {
      img.dispatchEvent(new Event('load'));
      await kit.settle();
    }
    expect(kit.env.created).toHaveLength(1);
    expect(kit.env.reads.length).toBeLessThanOrEqual(reads + 5);
    expect(kit.controller.incremental.imageDiagnostics()).toMatchObject({
      loadFailures: 1,
      imageOwners: 0,
    });
    accounted(kit.env, 0);
  });
});

describe('the generated-bitmap cache: exact limits', () => {
  function fill(count: number, pixelsEach = 100) {
    const env = new FakeImageEnvironment();
    const cache = new GeneratedImageCache(env);
    const entries = Array.from({ length: count }, (_, i) =>
      cache.insert(`k${i}`, new Blob(['x']), pixelsEach),
    );
    return { env, cache, entries };
  }

  it.each([
    [31, 31, 0],
    [32, 32, 0],
    [33, 32, 1],
  ])(
    '%i entries shown: %i stay looked-up, %i is evicted from the lookup but its URL lives while shown',
    (count, size, evicted) => {
      const { env, cache, entries } = fill(count);
      expect(cache.size).toBe(size);
      expect(entries.filter((entry) => entry.evicted)).toHaveLength(evicted);
      // Shown images keep their URL even when evicted from the lookup: nothing is revoked early.
      expect(cache.liveUrls).toBe(count);
      expect(env.revoked).toHaveLength(0);
      if (evicted) expect(cache.acquire('k0')).toBeNull(); // the oldest is the one that went
      for (const entry of entries) cache.release(entry);
      expect(cache.liveUrls).toBe(0);
      expect(cache.created).toBe(cache.revoked);
      expect(env.created.length - env.revoked.length).toBe(0);
    },
  );

  it('eviction order is least-recently-used: acquiring refreshes', () => {
    const { cache, entries } = fill(32);
    const kept = cache.acquire('k0')!; // refreshes k0 and holds a second reference
    cache.insert('k32', new Blob(['x']), 100);
    expect(cache.acquire('k0')).not.toBeNull();
    expect(cache.acquire('k1')).toBeNull(); // k1 became the oldest
    void entries;
    void kept;
  });

  it('pixel budget: exactly at the limit stays, one pixel over evicts the oldest', () => {
    const env = new FakeImageEnvironment();
    const cache = new GeneratedImageCache(env);
    const half = IMAGE_LIMITS.maxCachedPixels / 2;
    const a = cache.insert('a', new Blob(['x']), half);
    const b = cache.insert('b', new Blob(['x']), half);
    expect(cache.size).toBe(2);
    expect(a.evicted).toBe(false);
    const c = cache.insert('c', new Blob(['x']), 1);
    expect(a.evicted).toBe(true);
    expect(b.evicted).toBe(false);
    expect(cache.size).toBe(2);
    for (const entry of [a, b, c]) cache.release(entry);
    expect(cache.liveUrls).toBe(0);
    expect(env.created.length - env.revoked.length).toBe(0);
  });

  it('clear revokes every URL still alive, the evicted-but-shown ones included', () => {
    const { env, cache } = fill(40);
    cache.clear();
    expect(cache.liveUrls).toBe(0);
    expect(cache.created).toBe(cache.revoked);
    expect(env.live).toEqual([]);
  });
});

describe('reuse', () => {
  it('the same source in the same context is read, analyzed and encoded once (and one URL)', async () => {
    const kit = setup(HOST);
    const A = abs('/i/a.png');
    kit.env.set(A, iconPixels());
    for (let i = 0; i < 12; i += 1) host().append(makeImage({ src: A, attrs: ATTRS }));
    kit.enable();
    await kit.settle();
    expect(kit.env.created).toHaveLength(1);
    expect(kit.env.reads.filter((r) => r.url === A).length).toBeLessThanOrEqual(2);
    for (let i = 0; i < 3; i += 1) {
      kit.enable();
      await kit.settle();
    }
    expect(kit.env.created).toHaveLength(1);
    expect(kit.env.reads.filter((r) => r.url === A).length).toBeLessThanOrEqual(2);
    accounted(kit.env, 1);
  });

  it('the same file on two different grounds gets two different bitmaps', async () => {
    const kit = setup(
      '<div id="a" style="background-color:#6b8e23"></div><div id="b" style="background-color:#2ca02c"></div>',
    );
    const A = abs('/i/a.png');
    kit.env.set(A, iconPixels());
    const one = makeImage({ src: A, attrs: ATTRS });
    const two = makeImage({ src: A, attrs: ATTRS });
    document.getElementById('a')!.append(one);
    document.getElementById('b')!.append(two);
    kit.enable();
    await kit.settle();
    expect(one.getAttribute('src')).toMatch(/^blob:/);
    expect(two.getAttribute('src')).toMatch(/^blob:/);
    expect(one.getAttribute('src')).not.toBe(two.getAttribute('src'));
    expect(kit.env.created).toHaveLength(2);
    accounted(kit.env, 2);
  });

  it('turning the layer OFF releases the whole cache; ON again rebuilds (nothing is kept "just in case")', async () => {
    const kit = setup(HOST);
    const A = abs('/i/a.png');
    kit.env.set(A, iconPixels());
    host().append(makeImage({ src: A, attrs: ATTRS }));
    kit.enable();
    await kit.settle();
    kit.enable({ adaptImages: false });
    expect(kit.controller.incremental.imageDiagnostics()).toMatchObject({ cachedImages: 0 });
    accounted(kit.env, 0);
    kit.enable();
    await kit.settle();
    expect(kit.env.created).toHaveLength(2);
    accounted(kit.env, 1);
  });
});

describe('limits', () => {
  /** Images the layer can take in one pass without skipping: the queue plus the reads in flight. */
  const CAPACITY = IMAGE_LIMITS.maxQueuedImages + IMAGE_LIMITS.maxConcurrentReads;

  async function crowd(count: number) {
    const kit = setup(HOST);
    const images: HTMLImageElement[] = [];
    for (let i = 0; i < count; i += 1) {
      const url = abs(`/i/q-${i}.png`);
      kit.env.set(url, iconPixels());
      images.push(makeImage({ src: url, attrs: ATTRS }));
    }
    host().append(...images);
    kit.enable();
    await kit.settle();
    const skipped = images.filter(
      (image) => kit.controller.inspectImage(image)?.reason === 'queue-full',
    );
    return { kit, images, skipped };
  }

  it.each([
    [CAPACITY - 1, 0],
    [CAPACITY, 0],
    [CAPACITY + 1, 1],
  ])('%i images in one pass: %i skipped with queue-full', async (count, skipped) => {
    const result = await crowd(count);
    expect(result.skipped).toHaveLength(skipped);
    expect(result.kit.controller.incremental.imageDiagnostics().imageOwners).toBe(count - skipped);
    result.kit.controller.disableAdaptation();
    accounted(result.kit.env, 0);
  });

  it('at most maxImagesPerPass images are looked at in one pass; the rest are not tracked', async () => {
    const { kit } = await crowd(IMAGE_LIMITS.maxImagesPerPass + 1);
    expect(kit.controller.incremental.imageDiagnostics().imagesTracked).toBe(
      IMAGE_LIMITS.maxImagesPerPass,
    );
    kit.controller.disableAdaptation();
    accounted(kit.env, 0);
  });

  it('never more than maxConcurrentReads reads at once, however many images; a removed image frees its slot', async () => {
    const kit = setupDynamic(HOST);
    const images: HTMLImageElement[] = [];
    for (let i = 0; i < 60; i += 1) {
      const url = abs(`/i/c-${i}.png`);
      kit.env.set(url, iconPixels());
      images.push(makeImage({ src: url, attrs: ATTRS }));
    }
    host().append(...images);
    kit.env.hold(abs('/i/c-0.png'));
    kit.enable();
    await until(() => kit.env.reads.length >= IMAGE_LIMITS.maxConcurrentReads);
    expect(kit.controller.incremental.imageDiagnostics().pendingReads).toBe(
      IMAGE_LIMITS.maxConcurrentReads,
    );
    images[0]!.remove(); // its read is still held; the slot frees when the read ends
    kit.controller.dynamic.flush();
    kit.env.release(abs('/i/c-0.png'));
    await kit.settle();
    expect(kit.env.maxInflight).toBeLessThanOrEqual(IMAGE_LIMITS.maxConcurrentReads);
    expect(kit.controller.incremental.imageDiagnostics()).toMatchObject({
      pendingReads: 0,
      queuedImages: 0,
      imageOwners: 59,
    });
    kit.controller.disableAdaptation();
    accounted(kit.env, 0);
  });

  it('500 images x 3 cycles: every settled checkpoint has no pending read, queue, owner, URL or cache entry', async () => {
    const kit = setupDynamic(HOST);
    kit.enable();
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const batch: HTMLImageElement[] = [];
      for (let i = 0; i < 480; i += 1) {
        const url = abs(`/i/r${cycle}-${i % 40}.png`);
        kit.env.set(url, iconPixels());
        batch.push(makeImage({ src: url, attrs: ATTRS }));
      }
      host().append(...batch);
      kit.controller.dynamic.flush();
      await kit.settle();
      accounted(kit.env, kit.controller.incremental.imageDiagnostics().ownedUrls);
      for (const image of batch) image.remove();
      kit.controller.dynamic.flush();
      await kit.settle();
      expect(kit.controller.incremental.imageDiagnostics()).toMatchObject({
        imagesTracked: 0,
        imageOwners: 0,
        ownedUrls: 0,
        cachedImages: 0,
        pendingReads: 0,
        queuedImages: 0,
      });
      accounted(kit.env, 0);
    }
    const final = kit.controller.incremental.imageDiagnostics();
    expect(final.blobsCreated).toBe(final.blobsRevoked);
    expect(kit.env.maxInflight).toBeLessThanOrEqual(IMAGE_LIMITS.maxConcurrentReads);
  });
});

describe('listeners and self-mutation', () => {
  it('one load/error bridge while ON, none while OFF, one again (never duplicated)', () => {
    const kit = setup(HOST);
    const added: string[] = [];
    const removed: string[] = [];
    const add = document.addEventListener.bind(document);
    const remove = document.removeEventListener.bind(document);
    document.addEventListener = ((type: string, ...rest: unknown[]) => {
      added.push(type);
      return (add as (...args: unknown[]) => void)(type, ...rest);
    }) as typeof document.addEventListener;
    document.removeEventListener = ((type: string, ...rest: unknown[]) => {
      removed.push(type);
      return (remove as (...args: unknown[]) => void)(type, ...rest);
    }) as typeof document.removeEventListener;
    try {
      for (let i = 0; i < 4; i += 1) kit.enable(); // refreshes never add listeners
      expect(added.filter((t) => t === 'load')).toHaveLength(1);
      expect(added.filter((t) => t === 'error')).toHaveLength(1);
      expect(kit.controller.incremental.imageDiagnostics().loadListeners).toBe(1);
      kit.enable({ adaptImages: false });
      expect(removed.filter((t) => t === 'load')).toHaveLength(1);
      expect(kit.controller.incremental.imageDiagnostics().loadListeners).toBe(0);
      kit.enable();
      expect(added.filter((t) => t === 'load')).toHaveLength(2);
      expect(kit.controller.incremental.imageDiagnostics().loadListeners).toBe(1);
    } finally {
      document.addEventListener = add;
      document.removeEventListener = remove;
    }
  });

  it('adapt / restore x100 through the pipeline: our own writes never start another pass', async () => {
    const kit = setupDynamic(HOST);
    const A = abs('/i/a.png');
    kit.env.set(A, iconPixels());
    host().append(makeImage({ src: A, attrs: ATTRS }));
    kit.enable();
    kit.controller.dynamic.flush();
    await kit.settle();
    const before = kit.controller.dynamic.diagnostics();
    for (let i = 0; i < 100; i += 1) {
      kit.controller.disableAdaptation();
      kit.enable();
      kit.controller.dynamic.flush();
      await kit.settle();
      expect(host().firstElementChild!.getAttribute('src')).toMatch(/^blob:/);
    }
    const after = kit.controller.dynamic.diagnostics();
    // One full rescan per enable at most; the generated src never queues an incremental pass of its own.
    expect(after.incrementalPasses - before.incrementalPasses).toBeLessThanOrEqual(0);
    expect(after.fullRescans - before.fullRescans).toBeLessThanOrEqual(100);
    expect(kit.controller.incremental.imageDiagnostics().staleResultsDiscarded).toBe(0);
    kit.controller.disableAdaptation();
    accounted(kit.env, 0);
  });

  it('attributes other than src (and our marker while shown) are never written', async () => {
    const kit = setup(HOST);
    const A = abs('/i/a.png');
    kit.env.set(A, iconPixels());
    const attrs = {
      class: 'icon',
      alt: 'Alert',
      title: 'T',
      'aria-label': 'L',
      width: '24',
      height: '24',
      loading: 'lazy',
      decoding: 'async',
      fetchpriority: 'low',
      referrerpolicy: 'no-referrer',
      crossorigin: 'anonymous',
    };
    const img = makeImage({ src: A, attrs });
    host().append(img);
    const before = Object.fromEntries([...img.attributes].map((a) => [a.name, a.value]));
    kit.enable();
    await kit.settle();
    const during = Object.fromEntries(
      [...img.attributes]
        .filter((a) => a.name !== 'data-coloradapt-id')
        .map((a) => [a.name, a.value]),
    );
    for (const [name, value] of Object.entries(before)) {
      if (name !== 'src') expect(during[name]).toBe(value);
    }
    expect(Object.keys(during).sort()).toEqual(
      [...Object.keys(before), 'data-coloradapt-image'].sort(),
    );
    kit.controller.disableAdaptation();
    const after = Object.fromEntries(
      [...img.attributes]
        .filter((a) => a.name !== 'data-coloradapt-id')
        .map((a) => [a.name, a.value]),
    );
    expect(after).toEqual(before);
  });
});

describe('OS theme changes with no DOM mutation', () => {
  type Listener = () => void;

  afterEach(() => {
    // jsdom has no matchMedia: a test that stubs one removes it again.
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  function stubScheme() {
    const listeners = new Set<Listener>();
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: (_: string, fn: Listener) => listeners.add(fn),
      removeEventListener: (_: string, fn: Listener) => listeners.delete(fn),
    })) as unknown as typeof window.matchMedia;
    return { listeners, fire: () => [...listeners].forEach((fn) => fn()) };
  }

  it('the page CSS flips the ground: the adapted icon is re-evaluated, the stale bitmap revoked', async () => {
    const scheme = stubScheme();
    const kit = setup(HOST);
    const A = abs('/i/a.png');
    kit.env.set(A, iconPixels());
    const img = makeImage({ src: A, attrs: ATTRS });
    host().append(img);
    kit.enable();
    await kit.settle();
    const onGreen = img.getAttribute('src')!;
    expect(onGreen).toMatch(/^blob:/);
    expect(scheme.listeners.size).toBe(1);
    expect(kit.controller.incremental.imageDiagnostics().themeListeners).toBe(1);

    // Same ground: the event costs a style read and changes nothing.
    scheme.fire();
    await kit.settle();
    expect(img.getAttribute('src')).toBe(onGreen);

    document.body.style.backgroundColor = '#ffffff'; // what `@media (prefers-color-scheme)` would do
    scheme.fire();
    await kit.settle();
    expect(img.getAttribute('src')).toBe(A); // no longer conflicts: the page's own image again
    expect(kit.env.revoked).toContain(onGreen);
    accounted(kit.env, 0);

    kit.controller.disableAdaptation();
    expect(scheme.listeners.size).toBe(0);
  });

  it('only images whose decision depends on a ground are looked at; OFF and ON never duplicate the listener', async () => {
    const scheme = stubScheme();
    const kit = setup(HOST);
    const A = abs('/i/a.png');
    kit.env.set(A, iconPixels());
    host().append(makeImage({ src: A, attrs: ATTRS }));
    host().append(makeImage({ src: A, attrs: { alt: '' } })); // decorative: no ground involved
    kit.enable();
    await kit.settle();
    scheme.fire();
    expect(kit.controller.incremental.imageDiagnostics().themeReevaluations).toBe(1);
    for (let i = 0; i < 3; i += 1) {
      kit.enable({ adaptImages: false });
      expect(scheme.listeners.size).toBe(0);
      kit.enable();
      expect(scheme.listeners.size).toBe(1);
    }
    await kit.settle();
  });
});
