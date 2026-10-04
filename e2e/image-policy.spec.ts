import { expect, test, type Page, type Request } from '@playwright/test';
import {
  IMAGE_SETTINGS,
  OLIVE,
  RED,
  TWO_FRAME_GIF,
  apng,
  blank,
  disc,
  displayedPixels,
  hex,
  imageCounters,
  jpegPhotograph,
  monoIcon,
  openImages,
  pixelsOfUrl,
  png,
  rasterChartPixels,
  serveImage,
  shown,
  whenIdle,
} from './image-kit';
import {
  disable,
  flushDynamic,
  launchExtension,
  settle,
  startPageServer,
  type ExtensionSession,
  type PageServer,
} from './harness';

/**
 * What M8 does NOT touch, and what the browser does not allow, in a real Chromium: photographs,
 * logos, screenshots, charts, decorative and status images, animated and vector sources, responsive
 * and masked images, and anything the same-origin policy keeps unreadable (docs/IMAGE_ADAPTATION.md).
 */
let server: PageServer;
let other: PageServer;
let ext: ExtensionSession;

test.beforeAll(async () => {
  server = await startPageServer();
  other = await startPageServer(); // another port: another origin
  ext = await launchExtension();
});
test.afterEach(async () => {
  await Promise.all(ext.context.pages().map((page) => page.close()));
});
test.afterAll(async () => {
  await ext.close();
  await other.close();
  await server.close();
});

/** Collects page errors for the length of a test: nothing may escape into the page. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function scratchPage(): Promise<Page> {
  const page = await ext.context.newPage();
  await page.goto('about:blank');
  return page;
}

async function untouched(page: Page, selector: string, src: string): Promise<void> {
  const state = await shown(page, selector);
  expect(state.adapted).toBe(false);
  expect(state.src).toBe(src);
  expect(state.currentSrc).not.toMatch(/^blob:/);
}

test.describe('never recolored', () => {
  test('a JPEG photograph: untouched, byte for byte, and recognized as one', async () => {
    const scratch = await scratchPage();
    server.serveRaw('portrait.jpg', await jpegPhotograph(scratch, 128, 128), 'image/jpeg');
    await scratch.close();
    const view = await openImages(
      ext,
      server,
      '<img id="p" alt="Portrait of a woman in a red coat" src="/portrait.jpg" width="128" height="128">',
    );
    await whenIdle(ext, view, (c) => c.photographs === 1);
    await untouched(view.page, '#p', '/portrait.jpg');
    expect(await displayedPixels(view.page, '#p')).toEqual(
      await pixelsOfUrl(view.page, `${server.origin}/portrait.jpg`),
    );
    expect(await imageCounters(view)).toMatchObject({
      imagesAdapted: 0,
      blobsCreated: 0,
      imageOwners: 0,
    });
  });

  test('a photograph whose alt and class both say "icon" is still a photograph', async () => {
    const scratch = await scratchPage();
    server.serveRaw('trick.jpg', await jpegPhotograph(scratch, 64, 64), 'image/jpeg');
    await scratch.close();
    const view = await openImages(
      ext,
      server,
      '<img id="p" class="icon" alt="icon" src="/trick.jpg" width="64" height="64">',
    );
    await whenIdle(ext, view, (c) => c.photographs === 1);
    await untouched(view.page, '#p', '/trick.jpg');
  });

  test('a logo (by token, by home link, by brand container) is never recolored', async () => {
    serveImage(server, 'mark.png', monoIcon(32, RED, false));
    const view = await openImages(
      ext,
      server,
      `<img id="a" class="site-logo" alt="Acme" src="/mark.png">
       <a href="/"><img id="b" alt="Acme home" src="/mark.png"></a>
       <div class="navbar-brand"><img id="c" class="icon" alt="Acme" src="/mark.png"></div>`,
    );
    await whenIdle(ext, view, (c) => c.imagesTracked === 3 && c.imagesClassified === 3);
    for (const id of ['a', 'b', 'c']) await untouched(view.page, `#${id}`, '/mark.png');
    expect(await imageCounters(view)).toMatchObject({ imagesAdapted: 0, blobsCreated: 0 });
  });

  test('a raster chart is detected and left alone', async () => {
    serveImage(server, 'sales.png', rasterChartPixels());
    const view = await openImages(
      ext,
      server,
      '<img id="c" alt="Quarterly sales chart" src="/sales.png" width="240" height="140">',
      { background: '#ffffff' },
    );
    await whenIdle(ext, view, (c) => c.rasterCharts === 1);
    await untouched(view.page, '#c', '/sales.png');
    expect(await displayedPixels(view.page, '#c')).toEqual(
      await pixelsOfUrl(view.page, `${server.origin}/sales.png`),
    );
  });

  test('a simple red/green status bitmap: pixels untouched, nothing duplicated (M6 owns the cue)', async () => {
    const dot = disc(blank(20, 20), 10, 10, 9, RED);
    serveImage(server, 'dot.png', dot);
    const view = await openImages(
      ext,
      server,
      '<img id="s" class="status error" alt="Offline" src="/dot.png">',
      {
        settings: { ...IMAGE_SETTINGS, semanticCuesEnabled: true },
      },
    );
    await whenIdle(ext, view, (c) => c.imagesClassified === 1);
    await untouched(view.page, '#s', '/dot.png');
    expect(await imageCounters(view)).toMatchObject({
      imagesAdapted: 0,
      imageOwners: 0,
      blobsCreated: 0,
    });
  });

  test('decorative images (alt="", role=presentation, aria-hidden) are not even read', async () => {
    serveImage(server, 'deco.png', monoIcon(24, RED, false));
    const view = await openImages(
      ext,
      server,
      `<img id="a" alt="" class="icon" src="/deco.png">
       <img id="b" role="presentation" class="icon" src="/deco.png">
       <img id="c" aria-hidden="true" alt="Alert" class="icon" src="/deco.png">`,
    );
    await whenIdle(ext, view, (c) => c.imagesTracked === 3);
    for (const id of ['a', 'b', 'c']) await untouched(view.page, `#${id}`, '/deco.png');
    expect(await imageCounters(view)).toMatchObject({
      imagesReadable: 0,
      imagesUnreadable: 0,
      pixelsSampled: 0,
      imagesAdapted: 0,
    });
  });

  test('a screenshot-like image and a flat illustration stay as they are', async () => {
    const shot = blank(480, 320, hex('#fafafa'));
    for (let row = 0; row < 20; row += 1) {
      for (let x = 12; x < 440; x += 1)
        if ((x * 7 + row * 13) % 11 < 7)
          shot.data.set(hex('#555560'), ((12 + row * 14) * 480 + x) * 4);
    }
    shot.data.set(hex('#2b6cb0'), 0);
    serveImage(server, 'shot.png', shot);
    const view = await openImages(
      ext,
      server,
      '<img id="s" alt="Screenshot of the dashboard" src="/shot.png" width="480" height="320">',
      { background: '#ffffff' },
    );
    await whenIdle(ext, view, (c) => c.imagesClassified === 1);
    await untouched(view.page, '#s', '/shot.png');
  });
});

test.describe('presentations M8 does not replace', () => {
  test('srcset and <picture>: untouched; an image map keeps working', async () => {
    serveImage(server, 'r1.png', monoIcon(24, RED, false));
    serveImage(server, 'r2.png', monoIcon(48, RED, false));
    const view = await openImages(
      ext,
      server,
      `<img id="a" class="icon" alt="Alert" src="/r1.png" srcset="/r1.png 1x, /r2.png 2x">
       <picture><source srcset="/r2.png"><img id="b" class="icon" alt="y" src="/r1.png"></picture>
       <img id="m" class="icon" alt="map" src="/r1.png" usemap="#map">
       <map name="map"><area id="area" shape="rect" coords="0,0,24,24" href="#clicked" alt="whole"></map>`,
    );
    await whenIdle(ext, view, (c) => c.imagesTracked === 3 && c.imagesClassified === 3);
    for (const id of ['a', 'b', 'm'])
      expect((await shown(view.page, `#${id}`)).adapted).toBe(false);
    expect((await shown(view.page, '#m')).src).toBe('/r1.png');
    expect(await imageCounters(view)).toMatchObject({ imagesAdapted: 0 });
    await view.page.locator('#m').click({ position: { x: 12, y: 12 } });
    expect(await view.page.evaluate(() => location.hash)).toBe('#clicked');
  });

  test('CSS that changes how the pixels look (filter, mask, blend, opacity) is respected: untouched', async () => {
    serveImage(server, 'icon.png', monoIcon(24, RED, false));
    const view = await openImages(
      ext,
      server,
      [
        'filter: grayscale(1)',
        'mask-image: linear-gradient(#000, transparent)',
        'mix-blend-mode: multiply',
        'opacity: .5',
      ]
        .map((css, i) => `<img id="i${i}" class="icon" alt="Alert" src="/icon.png" style="${css}">`)
        .join(''),
    );
    await whenIdle(ext, view, (c) => c.imagesTracked === 4 && c.imagesClassified === 4);
    for (let i = 0; i < 4; i += 1) expect((await shown(view.page, `#i${i}`)).adapted).toBe(false);
  });

  test('animated sources: a GIF, an APNG, an SVG through <img>: untouched', async () => {
    server.serveRaw('spin.gif', TWO_FRAME_GIF, 'image/gif');
    server.serveRaw('moving.png', apng(monoIcon(24, RED, false)), 'image/png');
    server.serveRaw(
      'vector.svg',
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="#d62728"/></svg>',
      'image/svg+xml',
    );
    const view = await openImages(
      ext,
      server,
      `<img id="g" class="icon" alt="Loading" src="/spin.gif">
       <img id="a" class="icon" alt="Loading" src="/moving.png">
       <img id="v" class="icon" alt="Alert" src="/vector.svg">`,
    );
    await whenIdle(ext, view, (c) => c.imagesTracked === 3 && c.imagesUnsupported >= 2);
    for (const [id, src] of [
      ['g', '/spin.gif'],
      ['a', '/moving.png'],
      ['v', '/vector.svg'],
    ] as const) {
      await untouched(view.page, `#${id}`, src);
    }
    expect((await imageCounters(view)).imagesAdapted).toBe(0);
  });

  test('a CSS background-image is recognized and left to the page', async () => {
    serveImage(server, 'hero.png', monoIcon(24, RED, false));
    const view = await openImages(
      ext,
      server,
      '<div id="hero" style="width:60px;height:30px;background-image:url(/hero.png)"></div><img id="x" class="icon" alt="Alert" src="/hero.png">',
    );
    await whenIdle(ext, view, (c) => c.backgroundImages === 1 && c.imagesAdapted === 1);
    expect(
      await view.page.evaluate(() => document.getElementById('hero')!.getAttribute('style')),
    ).toBe('width:60px;height:30px;background-image:url(/hero.png)');
  });
});

test.describe('what the browser allows is respected, not worked around', () => {
  test('a cross-origin image without CORS: tainted canvas, no analysis, no change, no error', async () => {
    other.serveRaw('far.png', png(monoIcon(24, RED, false)), 'image/png');
    const view = await openImages(
      ext,
      server,
      `<img id="far" class="icon" alt="Alert" src="${other.origin}/far.png">`,
    );
    const errors = watchErrors(view.page);
    await whenIdle(ext, view, (c) => c.imagesUnreadable === 1);
    await untouched(view.page, '#far', `${other.origin}/far.png`);
    expect(await imageCounters(view)).toMatchObject({
      imagesReadable: 0,
      pixelsSampled: 0,
      imagesAdapted: 0,
      blobsCreated: 0,
    });
    expect(errors).toEqual([]);
  });

  test('a cross-origin image the server shares with CORS, requested with crossorigin, is analyzed and adapted', async () => {
    other.serveRaw('cors.png', png(monoIcon(24, RED, false)), 'image/png', {
      'access-control-allow-origin': '*',
    });
    const view = await openImages(
      ext,
      server,
      `<img id="cors" class="icon" alt="Alert" crossorigin="anonymous" src="${other.origin}/cors.png">`,
    );
    await whenIdle(ext, view, (c) => c.imagesAdapted === 1);
    expect((await shown(view.page, '#cors')).currentSrc).toMatch(/^blob:/);
    expect((await imageCounters(view)).imagesReadable).toBe(1);
    await disable(ext.worker, view.page);
    expect((await shown(view.page, '#cors')).src).toBe(`${other.origin}/cors.png`);
  });

  test('a broken image does not stop the next one, and nothing is thrown', async () => {
    serveImage(server, 'ok.png', monoIcon(24, RED, false));
    const view = await openImages(
      ext,
      server,
      '<img id="bad" class="icon" alt="Alert" src="/does-not-exist.png"><img id="ok" class="icon" alt="Alert" src="/ok.png">',
    );
    const errors = watchErrors(view.page);
    await whenIdle(ext, view, (c) => c.imagesAdapted === 1);
    expect((await shown(view.page, '#bad')).adapted).toBe(false);
    expect((await shown(view.page, '#ok')).adapted).toBe(true);
    expect(errors).toEqual([]);
  });

  test('data: URLs are read like any same-origin image; a page-owned blob: URL is never revoked by us', async () => {
    const dataUrl = `data:image/png;base64,${png(monoIcon(24, RED, false)).toString('base64')}`;
    serveImage(server, 'for-blob.png', monoIcon(24, RED, false));
    const view = await openImages(
      ext,
      server,
      `<img id="d" class="icon" alt="Alert" src="${dataUrl}"><img id="b" class="icon" alt="Alert">`,
    );
    await whenIdle(ext, view, (c) => c.imagesAdapted === 1);
    expect((await shown(view.page, '#d')).currentSrc).toMatch(/^blob:/);

    const pageBlob = await view.page.evaluate(async () => {
      const blob = await (await fetch('/for-blob.png')).blob();
      const url = URL.createObjectURL(blob);
      document.getElementById('b')!.setAttribute('src', url);
      return url;
    });
    await whenIdle(ext, view, (c) => c.imagesAdapted === 2);
    expect((await shown(view.page, '#b')).currentSrc).toMatch(/^blob:/);
    expect((await shown(view.page, '#b')).currentSrc).not.toBe(pageBlob);
    await disable(ext.worker, view.page);
    expect((await shown(view.page, '#b')).src).toBe(pageBlob);
    // The page's blob still loads: it was never revoked.
    expect(
      await view.page.evaluate(async (url) => {
        const image = new Image();
        image.src = url;
        await image.decode();
        return image.naturalWidth;
      }, pageBlob),
    ).toBe(24);
  });

  async function cspPage(name: string, csp: string) {
    serveImage(server, 'csp.png', monoIcon(24, RED, false));
    server.serve(
      name,
      `<!doctype html><html><head><meta charset="utf-8"><title>csp</title></head><body style="background:#2ca02c;margin:0;padding:8px"><div id="host"><img id="i" class="icon" alt="Alert" src="/csp.png"></div></body></html>`,
      { 'content-security-policy': csp },
    );
    const { load } = await import('./r1-kit');
    const view = await load(ext, server, name, IMAGE_SETTINGS);
    return { view, errors: watchErrors(view.page) };
  }

  test('a strict page CSP that allows same-origin images: no script and no style is injected, and the adaptation works', async () => {
    const { view, errors } = await cspPage(
      'csp-self.html',
      "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    );
    await whenIdle(ext, view, (c) => c.imagesAdapted === 1);
    expect((await shown(view.page, '#i')).currentSrc).toMatch(/^blob:/);
    expect((await shown(view.page, '#i')).naturalWidth).toBe(24);
    await disable(ext.worker, view.page);
    expect((await shown(view.page, '#i')).src).toBe('/csp.png');
    expect(errors).toEqual([]);
  });

  test('even a CSP that allows only the own page file does not block the bitmap in Chromium (the rollback is for browsers that do)', async () => {
    // Observed, not assumed: Chromium lets a content script's blob URL through a page's `img-src`. The
    // rollback on a load error (unit-tested: tests/features/images/controller.test.ts) is the safety net for
    // any browser that applies the page policy to it; Firefox is not verified (docs/IMAGE_ADAPTATION.md).
    const { view, errors } = await cspPage(
      'csp-path-only.html',
      `default-src 'none'; img-src ${server.origin}/csp.png; style-src 'unsafe-inline'`,
    );
    await whenIdle(ext, view, (c) => c.imagesAdapted === 1 || c.loadFailures === 1);
    const state = await shown(view.page, '#i');
    const counters = await imageCounters(view);
    // Whichever way the browser decides, the page ends in a consistent, displayable state.
    if (state.adapted) {
      expect(state.currentSrc).toMatch(/^blob:/);
      expect(counters).toMatchObject({ imageOwners: 1, ownedUrls: 1, loadFailures: 0 });
    } else {
      expect(state.src).toBe('/csp.png');
      expect(counters).toMatchObject({ imageOwners: 0, ownedUrls: 0, loadFailures: 1 });
    }
    expect(state.naturalWidth).toBe(24);
    expect(errors).toEqual([]);
  });
});

test.describe('privacy', () => {
  test('adapting an image contacts no host that the same page does not contact without ColorAdapt reading images', async () => {
    serveImage(server, 'alert.png', monoIcon(24, RED, true));
    const ours = new URL(server.origin).host;
    // Only requests that can carry data out count. Other software on a machine (antivirus products inject
    // their own XHRs into pages) shows up the same way with the layer off, so the layer is compared with itself off.
    const carries = ['fetch', 'xhr', 'ping', 'websocket', 'eventsource', 'image', 'media', 'other'];
    const foreignHosts = async (adaptImages: boolean): Promise<Set<string>> => {
      const hosts = new Set<string>();
      const listener = (request: Request): void => {
        const url = new URL(request.url());
        if (
          url.protocol.startsWith('http') &&
          carries.includes(request.resourceType()) &&
          url.host !== ours
        ) {
          hosts.add(url.host);
        }
      };
      ext.context.on('request', listener);
      const view = await openImages(
        ext,
        server,
        '<img id="i" class="icon" alt="Alert" src="/alert.png">',
        {
          settings: { ...IMAGE_SETTINGS, adaptImages },
        },
      );
      if (adaptImages) await whenIdle(ext, view, (c) => c.imagesAdapted === 1);
      else await flushDynamic(ext.worker, view.page);
      expect(await shown(view.page, '#i').then((state) => state.adapted)).toBe(adaptImages);
      ext.context.off('request', listener);
      await view.page.close();
      return hosts;
    };
    const without = await foreignHosts(false);
    const withLayer = await foreignHosts(true);
    expect([...withLayer].filter((host) => !without.has(host))).toEqual([]);
  });

  test('with the layer off, no image is read at all', async () => {
    serveImage(server, 'alert.png', monoIcon(24, RED, true));
    const view = await openImages(
      ext,
      server,
      '<img id="i" class="icon" alt="Alert" src="/alert.png">',
      {
        settings: { ...IMAGE_SETTINGS, adaptImages: false },
      },
    );
    await flushDynamic(ext.worker, view.page);
    expect(await imageCounters(view)).toMatchObject({
      imagesDiscovered: 0,
      imagesReadable: 0,
      pixelsSampled: 0,
      loadListeners: 0,
    });
    expect((await shown(view.page, '#i')).adapted).toBe(false);
  });
});

test.describe('a busy page', () => {
  test('100 icons that are replaced, removed and put back leave nothing behind', async () => {
    for (let i = 0; i < 100; i += 1) {
      serveImage(server, `bulk-a-${i}.png`, monoIcon(24, RED, i % 2 === 0));
      serveImage(server, `bulk-b-${i}.png`, monoIcon(24, RED, i % 2 === 1));
    }
    const view = await openImages(ext, server, '');
    await flushDynamic(ext.worker, view.page);
    await view.page.evaluate(() => {
      const host = document.getElementById('host')!;
      for (let i = 0; i < 100; i += 1) {
        const img = document.createElement('img');
        img.id = `bulk${i}`;
        img.className = 'icon';
        img.alt = 'Alert';
        img.src = `/bulk-a-${i}.png`;
        host.append(img);
      }
    });
    await whenIdle(ext, view, (c) => c.imageOwners === 100);

    await view.page.evaluate(() => {
      for (let i = 0; i < 100; i += 1)
        document.getElementById(`bulk${i}`)!.setAttribute('src', `/bulk-b-${i}.png`);
    });
    await whenIdle(
      ext,
      view,
      (c) => c.imageOwners === 100 && c.ownedUrls <= 100 && c.blobsRevoked >= 100,
    );
    expect((await imageCounters(view)).ownedUrls).toBe(100);

    await view.page.evaluate(() => {
      const host = document.getElementById('host')!;
      (window as unknown as { stash: Element[] }).stash = [...host.children];
      host.replaceChildren();
    });
    await whenIdle(ext, view, (c) => c.imagesTracked === 0 && c.ownedUrls === 0);
    expect(await imageCounters(view)).toMatchObject({
      imageOwners: 0,
      ownedUrls: 0,
      pendingReads: 0,
      queuedImages: 0,
      cachedImages: 0,
    });

    await view.page.evaluate(() => {
      document.getElementById('host')!.append(...(window as unknown as { stash: Element[] }).stash);
    });
    await whenIdle(ext, view, (c) => c.imageOwners === 100);
    await disable(ext.worker, view.page);
    const final = await imageCounters(view);
    expect(final.ownedUrls).toBe(0);
    expect(final.blobsCreated).toBe(final.blobsRevoked);
    await settle(view.page);
    expect(
      await view.page.evaluate(() => document.querySelectorAll('[data-coloradapt-image]').length),
    ).toBe(0);
  });

  test('with every layer on, an adapted icon and a status image coexist: one cue each at most, no duplicate', async () => {
    serveImage(server, 'alert.png', monoIcon(24, RED, true));
    serveImage(server, 'dot.png', disc(blank(20, 20), 10, 10, 9, RED));
    const view = await openImages(
      ext,
      server,
      `<img id="icon" class="icon" alt="Alert" src="/alert.png"><img id="dot" class="status error" alt="Offline" src="/dot.png">`,
      {
        settings: {
          enabled: true,
          visionProfile: 'deuteranopia',
          adaptationStrength: 1,
          adaptImages: true,
        },
        background: OLIVE,
      },
    );
    await whenIdle(ext, view, (c) => c.imagesClassified === 2);
    expect((await shown(view.page, '#dot')).adapted).toBe(false);
    expect((await shown(view.page, '#dot')).src).toBe('/dot.png');
  });
});
