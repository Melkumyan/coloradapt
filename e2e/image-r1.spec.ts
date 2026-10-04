import { expect, test, type Page } from '@playwright/test';
import {
  IMAGE_SETTINGS,
  OLIVE,
  RED,
  blank,
  disc,
  displayedPixels,
  hex,
  imageCounters,
  jpegPhotograph,
  monoIcon,
  openImages,
  png,
  serveImage,
  shown,
  whenIdle,
} from './image-kit';
import {
  disable,
  flushDynamic,
  launchExtension,
  refresh,
  setSettings,
  settle,
  startPageServer,
  type ExtensionSession,
  type PageServer,
} from './harness';
import { load } from './r1-kit';

/**
 * M8.R1 in a real Chromium: per-site precedence, a forced Blob load failure, strict CSP, source
 * races through three sources, a profile switch, OS theme changes with no DOM change, redirects
 * and CORS, the brand/icon boundary and the structural size thresholds.
 */
let server: PageServer;
let other: PageServer;
let ext: ExtensionSession;

test.beforeAll(async () => {
  server = await startPageServer();
  other = await startPageServer();
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

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

const ICON_IMG = '<img id="i" class="icon" alt="Alert" src="/alert.png">';

/** The same server under another hostname: another site as far as per-site settings go. */
const asLocalhost = (s: PageServer): PageServer => ({
  ...s,
  origin: s.origin.replace('127.0.0.1', 'localhost'),
});

test.describe('per-site adaptImages', () => {
  const site = (hostname: string, adaptImages: boolean) => ({
    hostname,
    enabled: true,
    visionProfile: 'deuteranopia',
    intensity: 1,
    adaptUI: true,
    adaptCharts: false,
    adaptImages,
  });

  async function openAt(
    s: PageServer,
    name: string,
    settings: Record<string, unknown>,
    background = '#2ca02c',
  ) {
    s.serve(
      name,
      `<!doctype html><html><head><meta charset="utf-8"><title>site</title></head><body style="margin:0;padding:8px;background:${background}"><div id="host">${ICON_IMG}</div></body></html>`,
    );
    return load(ext, s, name, settings);
  }

  test('effective = global AND site: the four cases, and no override means the global value', async () => {
    serveImage(server, 'alert.png', monoIcon(24, RED, false));
    const cases: Array<[boolean, boolean | null, boolean]> = [
      [false, true, false],
      [true, false, false],
      [true, true, true],
      [false, false, false],
      [true, null, true],
      [false, null, false],
    ];
    for (const [global, override, expected] of cases) {
      const settings = {
        ...IMAGE_SETTINGS,
        adaptImages: global,
        siteOverrides: override === null ? {} : { '127.0.0.1': site('127.0.0.1', override) },
      };
      const view = await openAt(server, `site-${global}-${override}.html`, settings);
      if (expected) {
        await whenIdle(ext, view, (c) => c.imagesAdapted === 1);
        expect((await shown(view.page, '#i')).adapted).toBe(true);
      } else {
        await flushDynamic(ext.worker, view.page);
        await settle(view.page);
        expect((await shown(view.page, '#i')).adapted).toBe(false);
        expect(await imageCounters(view)).toMatchObject({
          imagesDiscovered: 0,
          imagesReadable: 0,
          loadListeners: 0,
          themeListeners: 0,
          blobsCreated: 0,
        });
      }
      await view.page.close();
    }
  });

  test('site A on, site B off, open together: no state or cached bitmap leaks between them', async () => {
    serveImage(server, 'alert.png', monoIcon(24, RED, false));
    const settings = {
      ...IMAGE_SETTINGS,
      adaptImages: true,
      siteOverrides: {
        '127.0.0.1': site('127.0.0.1', true),
        localhost: site('localhost', false),
      },
    };
    const a = await openAt(server, 'site-a.html', settings);
    const b = await openAt(asLocalhost(server), 'site-b.html', settings);
    await whenIdle(ext, a, (c) => c.imagesAdapted === 1);
    await flushDynamic(ext.worker, b.page);
    await settle(b.page);
    expect((await shown(a.page, '#i')).adapted).toBe(true);
    expect((await shown(b.page, '#i')).adapted).toBe(false);
    expect((await shown(b.page, '#i')).src).toBe('/alert.png');
    expect(await imageCounters(b)).toMatchObject({ imagesDiscovered: 0, blobsCreated: 0 });
    expect((await imageCounters(a)).ownedUrls).toBe(1);
  });
});

test.describe('a bitmap the browser cannot load (forced in a real Chromium)', () => {
  test('its URL is revoked behind our back and the image reloads: original restored, no retry, nothing owned', async () => {
    serveImage(server, 'alert.png', monoIcon(24, RED, false));
    const view = await openImages(ext, server, ICON_IMG);
    const errors = watchErrors(view.page);
    await whenIdle(ext, view, (c) => c.imagesAdapted === 1);
    const ours = (await shown(view.page, '#i')).src!;
    expect(ours).toMatch(/^blob:/);

    // Same-origin blob URLs are shared with the page: revoke ours, then make the image load it again.
    await view.page.evaluate((url) => {
      URL.revokeObjectURL(url);
      const img = document.getElementById('i') as HTMLImageElement;
      img.setAttribute('src', img.getAttribute('src')!); // same value: the browser loads it again
    }, ours);
    await whenIdle(ext, view, (c) => c.loadFailures === 1);
    await flushDynamic(ext.worker, view.page);
    await settle(view.page);

    const state = await shown(view.page, '#i');
    expect(state.src).toBe('/alert.png');
    expect(state.adapted).toBe(false);
    expect(state.naturalWidth).toBe(24); // the original loads again: no broken image is left
    const counters = await imageCounters(view);
    expect(counters).toMatchObject({
      loadFailures: 1,
      imagesAdapted: 1,
      imageOwners: 0,
      ownedUrls: 0,
      queuedImages: 0,
      pendingReads: 0,
    });
    // No retry loop: more passes change nothing and create nothing.
    for (let i = 0; i < 3; i += 1) await flushDynamic(ext.worker, view.page);
    const later = await imageCounters(view);
    expect(later.blobsCreated).toBe(counters.blobsCreated);
    expect(later.blobsCreated).toBe(later.blobsRevoked);
    expect(later.loadFailures).toBe(1);
    expect(errors).toEqual([]);
  });
});

test.describe('strict CSP', () => {
  async function cspPage(name: string, csp: string) {
    serveImage(server, 'csp.png', monoIcon(24, RED, false));
    server.serve(
      name,
      `<!doctype html><html><head><meta charset="utf-8"><title>csp</title></head><body style="background:#2ca02c;margin:0;padding:8px"><div id="host"><img id="i" class="icon" alt="Alert" src="/csp.png"></div></body></html>`,
      { 'content-security-policy': csp },
    );
    const view = await load(ext, server, name, IMAGE_SETTINGS);
    return { view, errors: watchErrors(view.page) };
  }

  test("img-src 'none': the page's own image is blocked; nothing is read, built or looped", async () => {
    const { view, errors } = await cspPage(
      'csp-none.html',
      "default-src 'none'; img-src 'none'; style-src 'unsafe-inline'",
    );
    await flushDynamic(ext.worker, view.page);
    await settle(view.page);
    for (let i = 0; i < 3; i += 1) await flushDynamic(ext.worker, view.page);
    const state = await shown(view.page, '#i');
    expect(state.adapted).toBe(false);
    expect(state.src).toBe('/csp.png');
    const counters = await imageCounters(view);
    expect(counters).toMatchObject({
      imagesAdapted: 0,
      blobsCreated: 0,
      ownedUrls: 0,
      pendingReads: 0,
    });
    expect(errors).toEqual([]);
  });

  test("default-src 'self': the image works, and the page ends in a consistent state either way", async () => {
    const { view, errors } = await cspPage(
      'csp-default-self.html',
      "default-src 'self'; style-src 'unsafe-inline'",
    );
    await whenIdle(ext, view, (c) => c.imagesAdapted === 1 || c.loadFailures === 1);
    const state = await shown(view.page, '#i');
    expect(state.naturalWidth).toBe(24);
    const counters = await imageCounters(view);
    if (state.adapted)
      expect(counters).toMatchObject({ imageOwners: 1, ownedUrls: 1, loadFailures: 0 });
    else expect(counters).toMatchObject({ imageOwners: 0, ownedUrls: 0, loadFailures: 1 });
    expect(counters.blobsCreated - counters.blobsRevoked).toBe(counters.ownedUrls);
    expect(errors).toEqual([]);
  });
});

test.describe('source races (real network)', () => {
  test('A -> B -> C while A and B are still downloading: only C ends up shown', async () => {
    const mask = (radius: number) => {
      const buffer = blank(24, 24);
      disc(buffer, 12, 12, radius, RED);
      return buffer;
    };
    serveImage(server, 'ra.png', mask(4));
    serveImage(server, 'rb.png', mask(7));
    serveImage(server, 'rc.png', monoIcon(24, RED, false));
    const releaseA = server.hold('ra.png');
    const releaseB = server.hold('rb.png');
    const view = await openImages(
      ext,
      server,
      '<img id="i" class="icon" alt="Alert" src="/rc.png">',
    );
    await whenIdle(ext, view, (c) => c.imagesAdapted === 1);
    await view.page.evaluate(() => document.getElementById('i')!.setAttribute('src', '/ra.png'));
    await expect.poll(() => server.hits('ra.png')).toBeGreaterThan(0);
    await view.page.evaluate(() => document.getElementById('i')!.setAttribute('src', '/rb.png'));
    await expect.poll(() => server.hits('rb.png')).toBeGreaterThan(0);
    await view.page.evaluate(() => document.getElementById('i')!.setAttribute('src', '/rc.png'));
    releaseB(); // the late answers arrive in reverse order
    releaseA();
    await whenIdle(ext, view, (c) => c.imagesAdapted >= 1);
    await settle(view.page);
    await flushDynamic(ext.worker, view.page);

    const alpha = (data: number[]) => data.filter((_, i) => i % 4 === 3);
    const finalAlpha = alpha(await displayedPixels(view.page, '#i'));
    const cAlpha = alpha(
      await view.page.evaluate(async (src) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const context = canvas.getContext('2d')!;
        context.drawImage(img, 0, 0);
        return [...context.getImageData(0, 0, canvas.width, canvas.height).data];
      }, '/rc.png'),
    );
    expect(finalAlpha).toEqual(cAlpha);
    const counters = await imageCounters(view);
    expect(counters.ownedUrls).toBe(1);
    expect(counters.blobsCreated - counters.blobsRevoked).toBe(1);
    await disable(ext.worker, view.page);
    expect((await shown(view.page, '#i')).src).toBe('/rc.png');
    const after = await imageCounters(view);
    expect(after.blobsCreated).toBe(after.blobsRevoked);
  });

  test('the page changes src while ours is shown: the page wins, and OFF restores the page value, not the old one', async () => {
    serveImage(server, 'p1.png', monoIcon(24, RED, false));
    serveImage(server, 'p2.png', monoIcon(24, hex('#cc3333'), false));
    const view = await openImages(
      ext,
      server,
      '<img id="i" class="icon" alt="Alert" src="/p1.png">',
    );
    await whenIdle(ext, view, (c) => c.imagesAdapted === 1);
    const ours = (await shown(view.page, '#i')).src!;
    await view.page.evaluate(() => document.getElementById('i')!.setAttribute('src', '/p2.png'));
    await whenIdle(ext, view, (c) => c.imagesAdapted === 2);
    expect((await shown(view.page, '#i')).src).not.toBe(ours);
    await disable(ext.worker, view.page);
    expect((await shown(view.page, '#i')).src).toBe('/p2.png');
    const counters = await imageCounters(view);
    expect(counters.blobsCreated).toBe(counters.blobsRevoked);
  });
});

test.describe('responsive sources chosen by the browser', () => {
  test('a srcset added to an adapted image: the page candidate is shown, our bitmap and owner are gone', async () => {
    serveImage(server, 'alert.png', monoIcon(24, RED, false));
    serveImage(server, 'alt2x.png', monoIcon(24, hex('#2255aa'), false));
    const view = await openImages(ext, server, ICON_IMG);
    await whenIdle(ext, view, (c) => c.imagesAdapted === 1);
    await view.page.evaluate(() => {
      document.getElementById('i')!.setAttribute('srcset', '/alt2x.png 1x, /alt2x.png 2x');
    });
    await expect.poll(async () => (await shown(view.page, '#i')).adapted).toBe(false);
    const state = await shown(view.page, '#i');
    expect(state.currentSrc).toMatch(/alt2x\.png$/);
    expect(state.src).toBe('/alert.png');
    await whenIdle(ext, view);
    const counters = await imageCounters(view);
    expect(counters).toMatchObject({ imageOwners: 0, ownedUrls: 0 });
    expect(counters.blobsCreated).toBe(counters.blobsRevoked);
  });
});

test.describe('profile change', () => {
  test("protanopia -> deuteranopia: the old bitmap is revoked and the shown one is the current profile's", async () => {
    serveImage(server, 'alert.png', monoIcon(24, hex('#e03131'), false));
    const base = { ...IMAGE_SETTINGS, visionProfile: 'protanopia' as const };
    const view = await openImages(ext, server, ICON_IMG, { background: '#5c7c2b', settings: base });
    await whenIdle(ext, view, (c) => c.imagesAdapted === 1);
    const protan = await displayedPixels(view.page, '#i');
    const protanUrl = (await shown(view.page, '#i')).src!;

    await setSettings(ext.worker, { ...base, visionProfile: 'deuteranopia' });
    await refresh(ext.worker, view.page);
    await whenIdle(ext, view, (c) => c.imagesAdapted === 2);
    const deutan = await displayedPixels(view.page, '#i');
    expect((await shown(view.page, '#i')).src).not.toBe(protanUrl);
    expect(deutan).not.toEqual(protan);
    const counters = await imageCounters(view);
    expect(counters.ownedUrls).toBe(1);
    expect(counters.blobsCreated - counters.blobsRevoked).toBe(1);
    await disable(ext.worker, view.page);
    const after = await imageCounters(view);
    expect(after.blobsCreated).toBe(after.blobsRevoked);
  });
});

test.describe('OS theme change with no DOM change', () => {
  test('a prefers-color-scheme ground flips: the adapted icon is re-evaluated both ways, nothing is left stale', async () => {
    serveImage(server, 'alert.png', monoIcon(24, RED, false));
    const view = await openImages(ext, server, ICON_IMG, {
      head: '<style>@media (prefers-color-scheme: dark){ body{ background:#ffffff !important } }</style>',
    });
    await view.page.emulateMedia({ colorScheme: 'light' });
    await whenIdle(ext, view, (c) => c.imagesAdapted === 1);
    expect((await shown(view.page, '#i')).adapted).toBe(true);
    expect((await imageCounters(view)).themeListeners).toBe(1);

    await view.page.emulateMedia({ colorScheme: 'dark' }); // ground becomes white: no conflict any more
    await expect.poll(async () => (await shown(view.page, '#i')).adapted).toBe(false);
    expect((await shown(view.page, '#i')).src).toBe('/alert.png');
    expect((await imageCounters(view)).themeReevaluations).toBeGreaterThan(0);

    await view.page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(async () => (await shown(view.page, '#i')).adapted).toBe(true);
    await whenIdle(ext, view);
    const counters = await imageCounters(view);
    expect(counters.ownedUrls).toBe(1);
    expect(counters.blobsCreated - counters.blobsRevoked).toBe(1);
    expect(counters.themeListeners).toBe(1);
    await disable(ext.worker, view.page);
    const off = await imageCounters(view);
    expect(off.themeListeners).toBe(0);
    expect(off.blobsCreated).toBe(off.blobsRevoked);
  });
});

test.describe('redirects and CORS: the browser decides, we follow', () => {
  const lastCounters = async (view: Awaited<ReturnType<typeof openImages>>) => imageCounters(view);

  test('same-origin URL redirecting to another origin without CORS: unreadable, untouched, no error', async () => {
    other.serveRaw('far-target.png', png(monoIcon(24, RED, false)), 'image/png');
    server.serveRaw(
      'hop.png',
      '',
      'text/plain',
      { location: `${other.origin}/far-target.png` },
      302,
    );
    const view = await openImages(
      ext,
      server,
      '<img id="i" class="icon" alt="Alert" src="/hop.png">',
    );
    const errors = watchErrors(view.page);
    await whenIdle(ext, view, (c) => c.imagesUnreadable >= 1);
    const state = await shown(view.page, '#i');
    expect(state.adapted).toBe(false);
    expect(state.naturalWidth).toBe(24);
    expect(await lastCounters(view)).toMatchObject({ imagesAdapted: 0, blobsCreated: 0 });
    expect(errors).toEqual([]);
  });

  test('another origin redirecting back to a same-origin file: whatever the browser allows is consistent', async () => {
    serveImage(server, 'home-target.png', monoIcon(24, RED, false));
    other.serveRaw(
      'back.png',
      '',
      'text/plain',
      { location: `${server.origin}/home-target.png` },
      302,
    );
    const view = await openImages(
      ext,
      server,
      `<img id="i" class="icon" alt="Alert" src="${other.origin}/back.png">`,
    );
    const errors = watchErrors(view.page);
    await whenIdle(ext, view, (c) => c.imagesAdapted === 1 || c.imagesUnreadable >= 1);
    const state = await shown(view.page, '#i');
    const counters = await lastCounters(view);
    if (state.adapted) expect(counters.imagesReadable).toBeGreaterThan(0);
    else expect(counters).toMatchObject({ imagesAdapted: 0, blobsCreated: 0 });
    expect(state.naturalWidth).toBe(24);
    expect(counters.blobsCreated - counters.blobsRevoked).toBe(counters.ownedUrls);
    expect(errors).toEqual([]);
  });

  test('CORS for a different origin only (incorrect): the browser refuses the image; nothing is built, nothing thrown', async () => {
    other.serveRaw('wrong-cors.png', png(monoIcon(24, RED, false)), 'image/png', {
      'access-control-allow-origin': 'http://example.invalid',
    });
    const view = await openImages(
      ext,
      server,
      `<img id="i" class="icon" alt="Alert" crossorigin="anonymous" src="${other.origin}/wrong-cors.png">`,
    );
    const errors = watchErrors(view.page);
    await flushDynamic(ext.worker, view.page);
    await settle(view.page);
    const state = await shown(view.page, '#i');
    expect(state.adapted).toBe(false);
    expect(state.naturalWidth).toBe(0);
    expect(await lastCounters(view)).toMatchObject({
      imagesAdapted: 0,
      blobsCreated: 0,
      ownedUrls: 0,
    });
    expect(errors).toEqual([]);
  });

  test('malformed and oversized data: URLs fail safely; nothing is thrown', async () => {
    const view = await openImages(
      ext,
      server,
      `<img id="a" class="icon" alt="Alert" src="data:image/png;base64,!!!not-base64!!!">
       <img id="b" class="icon" alt="Alert" src="data:image/png;base64,${'A'.repeat(4000)}">`,
    );
    const errors = watchErrors(view.page);
    await flushDynamic(ext.worker, view.page);
    await settle(view.page);
    for (const id of ['#a', '#b']) expect((await shown(view.page, id)).adapted).toBe(false);
    expect(await lastCounters(view)).toMatchObject({ imagesAdapted: 0, blobsCreated: 0 });
    expect(errors).toEqual([]);
  });
});

test.describe('brand and icon boundary (real pixels)', () => {
  test('brand marks, however they are marked up, keep their pixels; named control icons are adapted', async () => {
    const mark = png(monoIcon(32, RED, false));
    for (const name of ['mark.png', 'favicon.png', 'sponsor.png', 'control.png']) {
      server.serveRaw(name, mark, 'image/png');
    }
    server.serveRaw('brand-asset.png', mark, 'image/png');
    const view = await openImages(
      ext,
      server,
      `<img id="b1" alt="Acme" src="/mark.png">
       <button style="background:none;border:0;padding:0"><img id="b2" alt="Acme" src="/mark.png"></button>
       <nav><img id="b3" class="icon" alt="Acme" src="/mark.png"></nav>
       <a href="/about"><img id="b4" class="icon" alt="Acme" src="/mark.png"></a>
       <a href="/"><img id="b5" alt="Acme" src="/mark.png"></a>
       <img id="b6" class="sponsor" alt="Sponsor" src="/mark.png">
       <img id="b7" class="icon" alt="Acme avatar" src="/mark.png" role="img">
       <img id="b8" alt="x" src="/favicon.png">
       <button aria-label="Acme" style="background:none;border:0;padding:0"><img id="b9" class="icon" src="/mark.png"></button>
       <button style="background:none;border:0;padding:0"><img id="f1" alt="Delete item" src="/control.png"></button>
       <a href="#more"><img id="f2" class="btn-icon" src="/control.png"></a>`,
    );
    await whenIdle(ext, view, (c) => c.imagesAdapted === 2);
    for (const id of ['#b1', '#b2', '#b3', '#b4', '#b5', '#b6', '#b7', '#b8', '#b9']) {
      const state = await shown(view.page, id);
      expect(state.adapted, id).toBe(false);
      expect(state.currentSrc, id).not.toMatch(/^blob:/);
    }
    for (const id of ['#f1', '#f2']) expect((await shown(view.page, id)).adapted, id).toBe(true);
    const counters = await imageCounters(view);
    expect(counters.ownedUrls).toBe(1); // both control icons share one bitmap
  });

  test('photographs with few colors, cut-outs and duotone art are never recolored', async () => {
    const view = await openImages(ext, server, '<div id="stage"></div>');
    const lowColor = await view.page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 120;
      canvas.height = 90;
      const context = canvas.getContext('2d')!;
      const gradient = context.createLinearGradient(0, 0, 120, 90);
      gradient.addColorStop(0, '#be3c32');
      gradient.addColorStop(1, '#7a4a38');
      context.fillStyle = gradient;
      context.fillRect(0, 0, 120, 90);
      return canvas.toDataURL('image/png').split(',')[1]!;
    });
    server.serveRaw('low.png', Buffer.from(lowColor, 'base64'), 'image/png');
    server.serveRaw('cut.jpg', await jpegPhotograph(view.page, 96, 96), 'image/jpeg');
    const duotone = blank(128, 128, hex('#d62728'));
    disc(duotone, 64, 64, 40, hex('#2ca02c'));
    serveImage(server, 'duo.png', duotone);
    const page = await openImages(
      ext,
      server,
      `<img id="p1" alt="Sunset" src="/low.png"><img id="p2" class="icon" alt="Sneaker" src="/cut.jpg">
       <img id="p3" alt="Album cover" src="/duo.png"><img id="p4" class="icon" alt="Poster" src="/duo.png">`,
    );
    await whenIdle(ext, page, (c) => c.imagesClassified >= 4);
    for (const id of ['#p1', '#p2', '#p3', '#p4']) {
      const state = await shown(page.page, id);
      expect(state.adapted, id).toBe(false);
      expect(state.currentSrc, id).not.toMatch(/^blob:/);
    }
    expect(await imageCounters(page)).toMatchObject({ imagesAdapted: 0, blobsCreated: 0 });
  });
});

test.describe('structural thresholds (decoded by a real browser)', () => {
  test('127 and 128 px icons are adapted, 129 px is not; 15% transparency is the line', async () => {
    const block = (rows: number) => {
      const buffer = blank(25, 20);
      for (let y = rows; y < 20; y += 1)
        for (let x = 0; x < 25; x += 1) {
          buffer.data.set([214, 39, 40, 255], (y * 25 + x) * 4);
        }
      return buffer;
    };
    for (const size of [127, 128, 129])
      serveImage(server, `s${size}.png`, monoIcon(size, RED, false));
    for (const rows of [2, 3, 4]) serveImage(server, `t${rows}.png`, block(rows));
    const view = await openImages(
      ext,
      server,
      `${[127, 128, 129].map((n) => `<img id="s${n}" class="icon" alt="Alert" src="/s${n}.png">`).join('')}
       ${[2, 3, 4].map((n) => `<img id="t${n}" class="icon" alt="Alert" src="/t${n}.png">`).join('')}`,
      { background: OLIVE },
    );
    await whenIdle(ext, view, (c) => c.imagesClassified >= 6);
    const adapted = async (id: string) => (await shown(view.page, id)).adapted;
    expect(await adapted('#s127')).toBe(true);
    expect(await adapted('#s128')).toBe(true);
    expect(await adapted('#s129')).toBe(false);
    expect(await adapted('#t2')).toBe(false); // 10% transparent: not an icon
    expect(await adapted('#t3')).toBe(true); // exactly 15%: the line
    expect(await adapted('#t4')).toBe(true);
    // Geometry: bitmaps have the natural size of the originals.
    for (const [id, size] of [
      ['#s127', 127],
      ['#s128', 128],
    ] as const) {
      const state = await shown(view.page, id);
      expect([state.naturalWidth, state.naturalHeight]).toEqual([size, size]);
    }
  });
});
