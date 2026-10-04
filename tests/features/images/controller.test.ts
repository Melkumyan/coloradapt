import { describe, expect, it } from 'vitest';
import { IMAGE_LIMITS } from '@shared/constants';
import { GIF_TWO_FRAMES } from './fake-env';
import {
  RED,
  abs,
  fire,
  iconPixels,
  makeImage,
  pageSetsSrc,
  photograph,
  setup,
  setupDynamic,
  type ImageSpec,
} from './kit';
import { blank, disc, hex, rect } from '../../core/images/pixels';

const ICON = abs('/i/alert.png');
const ICON_SPEC: ImageSpec = { src: ICON, attrs: { class: 'icon', alt: 'Alert' } };

/** Lets promise continuations run until `condition` holds (no timers, no sleeping). */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !condition(); i += 1) await Promise.resolve();
  expect(condition()).toBe(true);
}

function host(): HTMLElement {
  return document.getElementById('host')!;
}

/** Attributes of an element, without M1's own `data-coloradapt-id` (an accepted technical identifier). */
function attributesOf(element: Element): Record<string, string> {
  return Object.fromEntries(
    [...element.attributes]
      .filter((a) => a.name !== 'data-coloradapt-id')
      .map((a) => [a.name, a.value]),
  );
}

const HOST = '<div id="host"></div>';

describe('the layer is off by default', () => {
  it('adaptImages=false reads nothing, touches nothing, reports nothing', async () => {
    const kit = setup(HOST);
    const img = makeImage(ICON_SPEC);
    host().append(img);
    kit.env.set(ICON, iconPixels());
    kit.enable({ adaptImages: false });
    await kit.settle();
    expect(kit.env.reads).toHaveLength(0);
    expect(img.getAttribute('src')).toBe(ICON);
    expect(kit.controller.incremental.imageDiagnostics()).toMatchObject({
      imagesDiscovered: 0,
      imagesTracked: 0,
      loadListeners: 0,
      blobsCreated: 0,
    });
  });

  it('normal vision reads nothing even with the layer on', async () => {
    const kit = setup(HOST);
    host().append(makeImage(ICON_SPEC));
    kit.env.set(ICON, iconPixels());
    kit.enable({ visionProfile: 'normal' });
    await kit.settle();
    expect(kit.env.reads).toHaveLength(0);
  });
});

describe('what is recolored: a functional monochrome icon', () => {
  it('shows a generated bitmap, keeps every attribute but src, and puts the page back exactly on OFF', async () => {
    const kit = setup(HOST);
    const img = makeImage(ICON_SPEC);
    host().append(img);
    const original = iconPixels();
    kit.env.set(ICON, original);
    const before = attributesOf(img);

    kit.enable();
    await kit.settle();

    const shown = img.getAttribute('src')!;
    expect(shown).toMatch(/^blob:fake\//);
    expect(attributesOf(img)).toEqual({
      ...before,
      src: shown,
      'data-coloradapt-image': 'adapted',
    });
    expect(kit.controller.inspectImage(img)).toMatchObject({
      action: 'pixel-adapted',
      reason: 'adapted',
      kind: 'monochrome-icon',
      confidence: 'HIGH',
      originalSource: ICON,
    });
    const generated = kit.env.pixelsOf(shown)!;
    expect([generated.width, generated.height]).toEqual([original.width, original.height]);
    for (let i = 3; i < original.data.length; i += 4) {
      expect(generated.data[i]).toBe(original.data[i]); // alpha mask identical
    }
    expect(generated.data).not.toEqual(original.data);
    // The original resource is never overwritten: the fake network still holds the original pixels.
    expect(kit.env.resources.get(ICON)).toBe(original);

    kit.controller.disableAdaptation();
    expect(attributesOf(img)).toEqual(before);
    expect(kit.env.live).toEqual([]);
    expect(kit.controller.incremental.imageDiagnostics().loadListeners).toBe(0);
  });

  it('is idempotent: five refreshes create one bitmap, read the source once, and never compound', async () => {
    const kit = setup(HOST);
    const img = makeImage(ICON_SPEC);
    host().append(img);
    kit.env.set(ICON, iconPixels());
    kit.enable();
    await kit.settle();
    const first = img.getAttribute('src');
    const reads = kit.env.reads.length;
    for (let i = 0; i < 5; i += 1) {
      kit.enable();
      await kit.settle();
    }
    expect(img.getAttribute('src')).toBe(first);
    expect(kit.env.created).toHaveLength(1);
    expect(kit.env.reads).toHaveLength(reads);
    expect(kit.controller.incremental.imageDiagnostics()).toMatchObject({
      imagesAdapted: 1,
      blobsCreated: 1,
      imageOwners: 1,
      ownedUrls: 1,
    });
  });

  it('shares one bitmap between images that show the same source, and revokes it with the last one', async () => {
    const kit = setup(HOST);
    kit.env.set(ICON, iconPixels());
    const images = Array.from({ length: 40 }, () => makeImage(ICON_SPEC));
    host().append(...images);
    kit.enable();
    await kit.settle();
    expect(new Set(images.map((i) => i.getAttribute('src'))).size).toBe(1);
    expect(kit.env.created).toHaveLength(1);
    expect(kit.env.reads.length).toBeLessThanOrEqual(2); // one analysis, one transform read
    kit.controller.disableAdaptation();
    expect(kit.env.live).toEqual([]);
    expect(kit.env.revoked).toHaveLength(1);
    for (const image of images) expect(image.getAttribute('src')).toBe(ICON);
  });

  it('re-adapts when the page background changes, and the old bitmap is revoked', async () => {
    const kit = setupDynamic(HOST);
    const img = makeImage(ICON_SPEC);
    host().append(img);
    kit.env.set(ICON, iconPixels());
    kit.enable();
    await kit.settle();
    const onGreen = img.getAttribute('src')!;

    document.body.style.backgroundColor = '#6b8e23';
    kit.enable(); // what M4's full rescan does when the page theme changes
    await kit.settle();
    const onDark = img.getAttribute('src')!;
    expect(onDark).not.toBe(onGreen);
    expect(kit.env.revoked).toContain(onGreen);
    expect(kit.controller.incremental.imageDiagnostics().ownedUrls).toBe(1);
    expect(kit.controller.incremental.imageDiagnostics().imageOwners).toBe(1);

    // On a ground where the icon is no longer confusable, the page's own image is back and nothing leaks.
    document.body.style.backgroundColor = '#ffffff';
    kit.enable();
    await kit.settle();
    expect(img.getAttribute('src')).toBe(ICON);
    expect(kit.controller.inspectImage(img)?.action).toBe('not-needed');
    expect(kit.env.live).toEqual([]);
  });
});

describe('what is never touched', () => {
  const CASES: Array<{ name: string; spec: ImageSpec; reason: string; action: string }> = [
    {
      name: 'a decorative image (alt="")',
      spec: { src: ICON, attrs: { alt: '', class: 'icon' } },
      reason: 'decorative',
      action: 'unchanged',
    },
    {
      name: 'a presentation role',
      spec: { src: ICON, attrs: { role: 'presentation' } },
      reason: 'decorative',
      action: 'unchanged',
    },
    {
      name: 'a logo',
      spec: { src: abs('/i/site-logo.png'), attrs: { alt: 'Acme' } },
      reason: 'logo',
      action: 'unchanged',
    },
    {
      name: 'a responsive image',
      spec: { src: ICON, attrs: { class: 'icon', alt: 'Alert', srcset: `${ICON} 1x, ${ICON} 2x` } },
      reason: 'responsive-source',
      action: 'unsupported',
    },
    {
      name: 'an image map',
      spec: { src: ICON, attrs: { class: 'icon', alt: 'Alert', usemap: '#m' } },
      reason: 'image-map',
      action: 'unsupported',
    },
    {
      name: 'an animated GIF',
      spec: { src: abs('/i/spin.gif'), attrs: { class: 'icon', alt: 'Alert' } },
      reason: 'animated',
      action: 'unsupported',
    },
    {
      name: 'an SVG loaded through <img>',
      spec: { src: abs('/i/icon.svg'), attrs: { class: 'icon', alt: 'Alert' } },
      reason: 'svg-source',
      action: 'unsupported',
    },
    {
      name: 'a status graphic (M6 owns its cue)',
      spec: { src: ICON, attrs: { class: 'status error', alt: 'x' } },
      reason: 'status-defers-to-semantics',
      action: 'unchanged',
    },
  ];

  for (const { name, spec, reason, action } of CASES) {
    it(`${name} keeps its source`, async () => {
      const kit = setup(HOST);
      const img = makeImage(spec);
      host().append(img);
      kit.env.set(spec.src, iconPixels());
      kit.enable();
      await kit.settle();
      expect(img.getAttribute('src')).toBe(spec.src);
      expect(img.hasAttribute('data-coloradapt-image')).toBe(false);
      expect(kit.controller.inspectImage(img)).toMatchObject({ reason, action });
      expect(kit.env.created).toHaveLength(0);
    });
  }

  it('a photograph is left untouched and counted', async () => {
    const kit = setup(HOST);
    const url = abs('/i/portrait.jpg');
    const img = makeImage({
      src: url,
      width: 96,
      height: 96,
      attrs: { alt: 'Portrait of a woman' },
    });
    host().append(img);
    kit.env.set(url, photograph(96, 96, 21));
    kit.enable();
    await kit.settle();
    expect(img.getAttribute('src')).toBe(url);
    expect(kit.controller.inspectImage(img)).toMatchObject({
      kind: 'photograph',
      action: 'unchanged',
    });
    expect(kit.controller.incremental.imageDiagnostics()).toMatchObject({
      photographs: 1,
      imagesAdapted: 0,
      blobsCreated: 0,
    });
  });

  it('a photograph is untouched even if every token says "icon" and the page says it is small', async () => {
    const kit = setup(HOST);
    const url = abs('/i/icon-looking.png');
    const img = makeImage({
      src: url,
      width: 96,
      height: 96,
      attrs: { class: 'icon', alt: 'icon' },
    });
    host().append(img);
    kit.env.set(url, photograph(96, 96, 22));
    kit.enable();
    await kit.settle();
    expect(img.getAttribute('src')).toBe(url);
  });

  it('a raster chart is detected and left alone', async () => {
    const kit = setup(HOST);
    const url = abs('/i/sales-chart.png');
    const chart = blank(240, 140, hex('#ffffff'));
    rect(chart, 20, 8, 1, 120, hex('#3c3c3c'));
    rect(chart, 20, 123, 210, 1, hex('#3c3c3c'));
    rect(chart, 30, 60, 30, 63, hex('#d62728'));
    rect(chart, 80, 40, 30, 83, hex('#2ca02c'));
    rect(chart, 130, 80, 30, 43, hex('#1f77b4'));
    const img = makeImage({ src: url, width: 240, height: 140, attrs: { alt: 'Sales chart' } });
    host().append(img);
    kit.env.set(url, chart);
    kit.enable();
    await kit.settle();
    expect(img.getAttribute('src')).toBe(url);
    expect(kit.controller.inspectImage(img)).toMatchObject({
      kind: 'chart-raster',
      action: 'unsupported',
      reason: 'chart-raster',
    });
    expect(kit.controller.incremental.imageDiagnostics().rasterCharts).toBe(1);
  });

  it('a multi-colored UI bitmap is left alone (what each color means is unknown)', async () => {
    const kit = setup(HOST);
    const two = iconPixels();
    disc(two, 12, 12, 5, hex('#2b6cb0'));
    host().append(makeImage(ICON_SPEC));
    kit.env.set(ICON, two);
    kit.enable();
    await kit.settle();
    expect(kit.env.created).toHaveLength(0);
    expect(kit.controller.inspectImage(host().firstElementChild!)?.action).not.toBe(
      'pixel-adapted',
    );
  });
});

describe('what the browser does not allow', () => {
  it('a tainted canvas (cross-origin without CORS): no analysis, no transformation, no throw', async () => {
    const kit = setup(HOST);
    const url = 'http://other.example/icon.png';
    const img = makeImage({ src: url, attrs: { class: 'icon', alt: 'Alert' } });
    host().append(img);
    kit.env.set(url, 'tainted');
    kit.enable();
    await kit.settle();
    expect(img.getAttribute('src')).toBe(url);
    expect(kit.controller.inspectImage(img)).toMatchObject({
      action: 'unsupported',
      reason: 'unreadable',
      readability: 'tainted',
    });
    expect(kit.controller.incremental.imageDiagnostics()).toMatchObject({
      imagesUnreadable: 1,
      imagesReadable: 0,
      pixelsSampled: 0,
    });
    expect(kit.env.sniffed).toHaveLength(0); // not even the bytes are asked for
  });

  it('a CORS-enabled cross-origin image the browser lets us read is analyzed like any other', async () => {
    const kit = setup(HOST);
    const url = 'http://cdn.example/icon.png';
    const img = makeImage({
      src: url,
      attrs: { class: 'icon', alt: 'Alert', crossorigin: 'anonymous' },
    });
    host().append(img);
    kit.env.set(url, iconPixels());
    kit.enable();
    await kit.settle();
    expect(kit.env.reads[0]!.crossOrigin).toBe('anonymous');
    expect(kit.controller.inspectImage(img)?.readability).toBe('readable');
  });

  it('a broken image is unavailable: no loop, no exception', async () => {
    const kit = setup(HOST);
    const img = makeImage({ src: abs('/i/missing.png'), width: 0, height: 0, attrs: { alt: 'x' } });
    host().append(img);
    kit.enable();
    await kit.settle();
    expect(kit.controller.inspectImage(img)).toMatchObject({
      action: 'unsupported',
      reason: 'unavailable',
    });
    expect(kit.env.reads).toHaveLength(0);
    fire(img, 'error');
    await kit.settle();
    expect(kit.env.reads).toHaveLength(0);
  });

  it('an image that is still loading is decided only once it has loaded', async () => {
    const kit = setup(HOST);
    const img = makeImage({ ...ICON_SPEC, complete: false });
    host().append(img);
    kit.env.set(ICON, iconPixels());
    kit.enable();
    await kit.settle();
    expect(kit.controller.inspectImage(img)).toMatchObject({ action: 'pending' });
    expect(kit.env.reads).toHaveLength(0);
    pageSetsSrc(img, ICON);
    await kit.settle();
    expect(kit.controller.inspectImage(img)?.action).toBe('pixel-adapted');
  });

  it('a page whose policy refuses our bitmap (CSP) gets the original back and is not retried', async () => {
    const kit = setup(HOST);
    const img = makeImage(ICON_SPEC);
    host().append(img);
    kit.env.set(ICON, iconPixels());
    kit.enable();
    await kit.settle();
    expect(img.getAttribute('src')).toMatch(/^blob:/);
    fire(img, 'error'); // the browser reports the generated bitmap was blocked
    expect(img.getAttribute('src')).toBe(ICON);
    expect(img.hasAttribute('data-coloradapt-image')).toBe(false);
    pageSetsSrc(img, ICON);
    kit.enable();
    await kit.settle();
    expect(img.getAttribute('src')).toBe(ICON);
    expect(kit.controller.incremental.imageDiagnostics()).toMatchObject({
      loadFailures: 1,
      ownedUrls: 0,
    });
    expect(kit.controller.inspectImage(img)?.reason).toBe('load-failed');
  });

  it('one image that throws does not stop the others', async () => {
    const kit = setup(HOST);
    const bad = abs('/i/bad.png');
    host().append(
      makeImage({ src: bad, attrs: { class: 'icon', alt: 'Alert' } }),
      makeImage(ICON_SPEC),
    );
    kit.env.failing.add(bad);
    kit.env.set(bad, iconPixels()).set(ICON, iconPixels());
    kit.enable();
    await kit.settle();
    expect(host().children[0]!.getAttribute('src')).toBe(bad);
    expect(host().children[1]!.getAttribute('src')).toMatch(/^blob:/);
    expect(kit.controller.inspectImage(host().children[0]!)?.reason).toBe('load-failed');
  });

  it('an animated image is recognized from its bytes, not only from the URL', async () => {
    const kit = setup(HOST);
    const url = abs('/i/looks-still.png');
    const img = makeImage({ src: url, attrs: { class: 'icon', alt: 'Alert' } });
    host().append(img);
    kit.env.set(url, iconPixels());
    kit.env.bytes.set(url, GIF_TWO_FRAMES);
    kit.enable();
    await kit.settle();
    expect(img.getAttribute('src')).toBe(url);
    expect(kit.controller.inspectImage(img)).toMatchObject({
      action: 'unsupported',
      reason: 'animated',
    });
  });

  it('a page background that is not a plain color is "insufficient context", never guessed', async () => {
    const kit = setup(HOST);
    document.body.style.backgroundImage = 'linear-gradient(red, blue)';
    const img = makeImage(ICON_SPEC);
    host().append(img);
    kit.env.set(ICON, iconPixels());
    kit.enable();
    await kit.settle();
    expect(img.getAttribute('src')).toBe(ICON);
    expect(kit.controller.inspectImage(img)).toMatchObject({
      action: 'unsupported',
      reason: 'insufficient-context',
    });
  });

  it('an already distinguishable icon is "not needed"', async () => {
    const kit = setup(HOST, { background: '#ffffff' });
    host().append(makeImage(ICON_SPEC));
    kit.env.set(ICON, iconPixels(hex('#1f4aa8')));
    kit.enable();
    await kit.settle();
    expect(kit.controller.inspectImage(host().firstElementChild!)).toMatchObject({
      action: 'not-needed',
    });
    expect(kit.env.created).toHaveLength(0);
  });
});

describe('races', () => {
  it('src A -> src B before A is analyzed: the late A result never replaces B', async () => {
    const kit = setup(HOST);
    const A = abs('/i/a.png');
    const B = abs('/i/b.png');
    const img = makeImage({ src: A, attrs: { class: 'icon', alt: 'Alert' } });
    host().append(img);
    kit.env.set(A, iconPixels(hex('#d62728'))).set(B, iconPixels(hex('#c0392b')));
    kit.env.hold(A);
    kit.enable();
    await until(() => kit.env.reads.some((r) => r.url === A));

    pageSetsSrc(img, B);
    await until(() => kit.controller.inspectImage(img)?.action === 'pixel-adapted');
    const shown = img.getAttribute('src');
    expect(kit.controller.inspectImage(img)?.originalSource).toBe(B);

    kit.env.release(A);
    await kit.settle();
    expect(img.getAttribute('src')).toBe(shown);
    expect(kit.controller.inspectImage(img)?.originalSource).toBe(B);
    expect(kit.controller.incremental.imageDiagnostics().staleResultsDiscarded).toBeGreaterThan(0);
    expect(kit.env.created).toHaveLength(1);
  });

  it('src changes while the transform of A is being built: the finished A bitmap is revoked, not shown', async () => {
    const kit = setup(HOST);
    const A = abs('/i/a.png');
    const B = abs('/i/b.png');
    const img = makeImage({ src: A, attrs: { class: 'icon', alt: 'Alert' } });
    host().append(img);
    kit.env.set(A, iconPixels()).set(B, iconPixels(hex('#c0392b')));
    kit.env.hold(A, 1); // the analysis read passes, the transform read waits
    kit.enable();
    await until(() => kit.env.reads.filter((r) => r.url === A).length === 2);

    pageSetsSrc(img, B);
    await until(() => kit.controller.inspectImage(img)?.originalSource === B);
    kit.env.release(A);
    await kit.settle();

    expect(kit.controller.inspectImage(img)?.originalSource).toBe(B);
    expect(kit.env.live).toEqual([img.getAttribute('src')]);
    expect(kit.controller.incremental.imageDiagnostics().ownedUrls).toBe(1);
  });

  it('removed while its read is in flight: nothing is applied and nothing leaks', async () => {
    const kit = setupDynamic(HOST);
    const img = makeImage(ICON_SPEC);
    host().append(img);
    kit.env.set(ICON, iconPixels());
    kit.env.hold(ICON);
    kit.enable();
    await until(() => kit.env.reads.length === 1);
    img.remove();
    kit.controller.dynamic.flush();
    kit.env.release(ICON);
    await kit.settle();
    expect(img.getAttribute('src')).toBe(ICON);
    expect(kit.env.live).toEqual([]);
    expect(kit.controller.incremental.imageDiagnostics()).toMatchObject({
      imagesTracked: 0,
      pendingReads: 0,
      queuedImages: 0,
    });
  });

  it('the page replaces our bitmap with its own: that choice stands and nothing of the page is revoked', async () => {
    const kit = setup(HOST);
    const img = makeImage(ICON_SPEC);
    host().append(img);
    const NEXT = abs('/i/next.png');
    const PAGE_BLOB = 'blob:page/owned-by-the-page';
    kit.env.set(ICON, iconPixels()).set(NEXT, iconPixels()).set(PAGE_BLOB, iconPixels());
    kit.enable();
    await kit.settle();
    const ours = img.getAttribute('src')!;

    pageSetsSrc(img, PAGE_BLOB);
    await kit.settle();
    expect(kit.env.revoked).toContain(ours);
    expect(kit.env.revoked).not.toContain(PAGE_BLOB);
    expect(kit.controller.inspectImage(img)?.originalSource).toBe(PAGE_BLOB);
    expect(img.getAttribute('src')).not.toBe(PAGE_BLOB); // adapted again, from the page's new source

    pageSetsSrc(img, NEXT);
    await kit.settle();
    expect(kit.controller.inspectImage(img)?.originalSource).toBe(NEXT);
    kit.controller.disableAdaptation();
    expect(img.getAttribute('src')).toBe(NEXT);
    expect(kit.env.revoked).not.toContain(PAGE_BLOB);
  });
});

describe('dynamic pages (M4)', () => {
  it('an image added later is analyzed through the pipeline and the load bridge', async () => {
    const kit = setupDynamic(HOST);
    kit.env.set(ICON, iconPixels());
    kit.enable();
    const img = makeImage(ICON_SPEC);
    host().append(img);
    kit.controller.dynamic.flush();
    await kit.settle();
    expect(img.getAttribute('src')).toMatch(/^blob:/);
    expect(kit.controller.dynamic.diagnostics().images.imagesAdapted).toBe(1);
  });

  it('an image moved within the page keeps its adaptation; one removed gives its bitmap back', async () => {
    const kit = setupDynamic(`${HOST}<div id="other"></div>`);
    kit.env.set(ICON, iconPixels());
    const img = makeImage(ICON_SPEC);
    host().append(img);
    kit.enable();
    await kit.settle();
    const shown = img.getAttribute('src');
    document.getElementById('other')!.append(img);
    kit.controller.dynamic.flush();
    await kit.settle();
    expect(img.getAttribute('src')).toBe(shown);
    expect(kit.env.created).toHaveLength(1);

    img.remove();
    kit.controller.dynamic.flush();
    await kit.settle();
    expect(kit.env.live).toEqual([]);
    expect(img.getAttribute('src')).toBe(ICON); // restored even though it is detached
  });

  it('a theme change seen by M4 (no enable call) re-evaluates the image against its new background', async () => {
    const kit = setupDynamic(HOST);
    const img = makeImage(ICON_SPEC);
    host().append(img);
    kit.env.set(ICON, iconPixels());
    kit.enable();
    await kit.settle();
    const onGreen = img.getAttribute('src');
    expect(onGreen).toMatch(/^blob:/);

    document.body.style.backgroundColor = '#6b8e23';
    kit.controller.dynamic.flush();
    await kit.settle();
    expect(img.getAttribute('src')).toMatch(/^blob:/);
    expect(img.getAttribute('src')).not.toBe(onGreen);
    expect(kit.env.revoked).toContain(onGreen);

    document.body.style.backgroundColor = '#ffffff';
    kit.controller.dynamic.flush();
    await kit.settle();
    expect(img.getAttribute('src')).toBe(ICON);
    expect(kit.env.live).toEqual([]);
  });

  it('own writes do not wake the pipeline: applying a bitmap causes no analysis of its own', async () => {
    const kit = setupDynamic(HOST);
    kit.env.set(ICON, iconPixels());
    kit.enable();
    host().append(makeImage(ICON_SPEC));
    kit.controller.dynamic.flush();
    await kit.settle();
    const before = kit.controller.dynamic.diagnostics();
    kit.controller.dynamic.flush();
    const after = kit.controller.dynamic.flush();
    expect(after.batches).toBe(before.batches);
    expect(after.fullRescans).toBe(before.fullRescans);
  });
});

describe('background images', () => {
  it('a CSS background-image is recognized and given an explicit policy: detect only', async () => {
    const kit = setup('<div id="host" style="background-image: url(/i/hero.png)"></div>');
    kit.enable();
    await kit.settle();
    expect(kit.controller.inspectImage(host())).toMatchObject({
      action: 'unsupported',
      reason: 'css-background',
    });
    expect(kit.controller.incremental.imageDiagnostics().backgroundImages).toBe(1);
    expect(kit.env.reads).toHaveLength(0);
    expect(host().style.backgroundImage).toContain('/i/hero.png');
  });
});

describe('structural bounds', () => {
  it('more images than the queue holds are skipped, not half-processed', async () => {
    const kit = setup(HOST);
    const total = IMAGE_LIMITS.maxQueuedImages + IMAGE_LIMITS.maxConcurrentReads + 25;
    const urls: string[] = [];
    for (let i = 0; i < total; i += 1) {
      const url = abs(`/i/many-${i}.png`);
      urls.push(url);
      kit.env.set(url, iconPixels());
      host().append(makeImage({ src: url, attrs: { class: 'icon', alt: 'Alert' } }));
    }
    kit.enable();
    await kit.settle();
    const skipped = [...host().children].filter(
      (child) => kit.controller.inspectImage(child)?.reason === 'queue-full',
    );
    expect(skipped).toHaveLength(25);
    for (const child of skipped) expect(child.getAttribute('src')).toMatch(/many-/);
    expect(kit.controller.incremental.imageDiagnostics()).toMatchObject({
      pendingReads: 0,
      queuedImages: 0,
    });
  });

  it('never keeps more bitmaps than the cache bound while all of them are shown', async () => {
    const kit = setup(HOST);
    for (let i = 0; i < 40; i += 1) {
      const url = abs(`/i/distinct-${i}.png`);
      kit.env.set(url, iconPixels());
      host().append(makeImage({ src: url, attrs: { class: 'icon', alt: 'Alert' } }));
    }
    kit.enable();
    await kit.settle();
    const diagnostics = kit.controller.incremental.imageDiagnostics();
    expect(diagnostics.cachedImages).toBeLessThanOrEqual(IMAGE_LIMITS.maxCachedImages);
    expect(diagnostics.ownedUrls).toBe(diagnostics.imageOwners);
    kit.controller.disableAdaptation();
    expect(kit.env.live).toEqual([]);
  });

  it('retention: images created, adapted and removed over several cycles leave nothing behind', async () => {
    const kit = setupDynamic(HOST);
    kit.enable();
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const batch: HTMLImageElement[] = [];
      for (let i = 0; i < 100; i += 1) {
        const url = abs(`/i/c${cycle}-${i % 20}.png`);
        kit.env.set(url, iconPixels());
        batch.push(makeImage({ src: url, attrs: { class: 'icon', alt: 'Alert' } }));
      }
      host().append(...batch);
      kit.controller.dynamic.flush();
      await kit.settle();
      expect(kit.controller.incremental.imageDiagnostics().imageOwners).toBe(100);
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
      expect(kit.env.live).toEqual([]);
    }
    const final = kit.controller.incremental.imageDiagnostics();
    expect(final.blobsCreated).toBe(final.blobsRevoked);
  });
});

describe('interactive images', () => {
  it('an icon inside a button or link keeps role, name, focusability and the handlers', async () => {
    const kit = setup(
      `<div id="host"><button id="b" type="button"></button><a id="a" href="#x"></a></div>`,
    );
    const inButton = makeImage({ src: ICON, attrs: { alt: 'Delete', class: 'icon' } });
    const inLink = makeImage({ src: ICON, attrs: { alt: 'Open', class: 'icon' } });
    document.getElementById('b')!.append(inButton);
    document.getElementById('a')!.append(inLink);
    let clicks = 0;
    document.getElementById('b')!.addEventListener('click', () => (clicks += 1));
    kit.env.set(ICON, iconPixels());
    const snapshot = ['b', 'a'].map((id) => attributesOf(document.getElementById(id)!));
    kit.enable();
    await kit.settle();
    expect(inButton.getAttribute('src')).toMatch(/^blob:/);
    expect(inButton.getAttribute('alt')).toBe('Delete');
    expect(inLink.getAttribute('alt')).toBe('Open');
    expect(['b', 'a'].map((id) => attributesOf(document.getElementById(id)!))).toEqual(snapshot);
    document.getElementById('b')!.click();
    expect(clicks).toBe(1);
    document.getElementById('b')!.focus();
    expect(document.activeElement?.id).toBe('b');
    // No pointer layer, no wrapper, no sibling was added.
    expect(document.getElementById('b')!.children).toHaveLength(1);
    expect(document.getElementById('a')!.children).toHaveLength(1);
  });
});

describe('diagnostics are counts, never content', () => {
  it('reports what happened without any pixel or URL in it', async () => {
    const kit = setup(HOST);
    host().append(makeImage(ICON_SPEC));
    kit.env.set(ICON, iconPixels());
    kit.enable();
    await kit.settle();
    const diagnostics = kit.controller.incremental.imageDiagnostics();
    expect(diagnostics).toMatchObject({
      imagesDiscovered: 1,
      imagesReadable: 1,
      imagesClassified: 1,
      imagesFunctional: 1,
      imagesAdapted: 1,
      pixelsSampled: 24 * 24,
      blobsCreated: 1,
    });
    for (const value of Object.values(diagnostics)) expect(typeof value).toBe('number');
    void RED;
  });
});
