import { expect, test } from '@playwright/test';
import {
  IMAGE_SETTINGS,
  OLIVE,
  RED,
  ariaTree,
  blank,
  disc,
  displayedPixels,
  imageCounters,
  monoIcon,
  openImages,
  pixelsOfUrl,
  serveImage,
  shown,
  whenIdle,
} from './image-kit';
import {
  launchExtension,
  disable,
  enable,
  flushDynamic,
  refresh,
  setSettings,
  settle,
  startPageServer,
  type ExtensionSession,
  type PageServer,
} from './harness';

/**
 * The one thing M8 recolors, in a real Chromium: a functional monochrome icon, shown as a generated
 * bitmap in place of the original, with the page otherwise exactly as it was (docs/IMAGE_ADAPTATION.md).
 */
let server: PageServer;
let ext: ExtensionSession;

test.beforeAll(async () => {
  server = await startPageServer();
  ext = await launchExtension();
});
test.afterEach(async () => {
  await Promise.all(ext.context.pages().map((page) => page.close()));
});
test.afterAll(async () => {
  await ext.close();
  await server.close();
});

const ICON = '<img id="icon" class="icon" alt="Alert" src="/alert.png">';

test.describe('a functional monochrome icon', () => {
  test('is shown as a generated bitmap: same size, same alpha mask, different color; OFF restores it exactly', async () => {
    serveImage(server, 'alert.png', monoIcon(24, RED, true));
    const view = await openImages(ext, server, ICON, {
      settings: { ...IMAGE_SETTINGS, adaptImages: false },
    });
    const before = await shown(view.page, '#icon');
    expect(before.adapted).toBe(false);
    const originalPixels = await pixelsOfUrl(view.page, `${server.origin}/alert.png`);
    const screenshotBefore = await view.page.locator('#icon').screenshot();
    expect(await imageCounters(view)).toMatchObject({ imagesDiscovered: 0, blobsCreated: 0 });

    await setSettings(ext.worker, IMAGE_SETTINGS);
    await refresh(ext.worker, view.page);
    await whenIdle(ext, view, (c) => c.imagesAdapted === 1);
    const after = await shown(view.page, '#icon');
    expect(after.adapted).toBe(true);
    expect(after.currentSrc).toMatch(/^blob:/);
    expect(after.src).toBe(after.currentSrc);
    expect([after.naturalWidth, after.naturalHeight]).toEqual([24, 24]);
    expect(after.box).toEqual(before.box);

    const adaptedPixels = await displayedPixels(view.page, '#icon');
    expect(adaptedPixels).toHaveLength(originalPixels.length);
    let colorChanged = 0;
    for (let i = 0; i < originalPixels.length; i += 4) {
      expect(adaptedPixels[i + 3]).toBe(originalPixels[i + 3]); // alpha mask identical
      const same =
        adaptedPixels[i] === originalPixels[i] &&
        adaptedPixels[i + 1] === originalPixels[i + 1] &&
        adaptedPixels[i + 2] === originalPixels[i + 2];
      if (!same && originalPixels[i + 3] === 255) colorChanged += 1;
      // The white dot (neutral) keeps its color exactly.
      if (
        originalPixels[i + 3] === 255 &&
        originalPixels[i] === 255 &&
        originalPixels[i + 1] === 255 &&
        originalPixels[i + 2] === 255
      ) {
        expect(same).toBe(true);
      }
    }
    expect(colorChanged).toBeGreaterThan(100);
    expect(
      Buffer.compare(await view.page.locator('#icon').screenshot(), screenshotBefore),
    ).not.toBe(0);

    await disable(ext.worker, view.page);
    await settle(view.page);
    const restored = await shown(view.page, '#icon');
    expect(restored.src).toBe('/alert.png');
    expect(restored.currentSrc).toBe(`${server.origin}/alert.png`);
    expect(restored.adapted).toBe(false);
    expect(Buffer.compare(await view.page.locator('#icon').screenshot(), screenshotBefore)).toBe(0);
    expect(
      await view.page.evaluate(() => document.getElementById('icon')!.getAttributeNames()),
    ).toEqual(expect.not.arrayContaining(['data-coloradapt-image']));
  });

  test('five refreshes: one bitmap, one object URL, nothing compounded', async () => {
    serveImage(server, 'alert.png', monoIcon(24, RED, true));
    const view = await openImages(ext, server, ICON);
    await whenIdle(ext, view, (c) => c.imagesAdapted === 1);
    const first = await shown(view.page, '#icon');
    const pixels = await displayedPixels(view.page, '#icon');
    for (let i = 0; i < 5; i += 1) {
      await refresh(ext.worker, view.page);
      await flushDynamic(ext.worker, view.page);
    }
    const counters = await whenIdle(ext, view);
    const last = await shown(view.page, '#icon');
    expect(last.src).toBe(first.src);
    expect(await displayedPixels(view.page, '#icon')).toEqual(pixels);
    expect(counters).toMatchObject({
      blobsCreated: 1,
      ownedUrls: 1,
      imageOwners: 1,
      imagesAdapted: 1,
    });
    expect(counters.blobsRevoked).toBe(0);
  });

  test('toggling OFF and ON revokes the old bitmap and never accumulates', async () => {
    serveImage(server, 'alert.png', monoIcon(24, RED, true));
    const view = await openImages(ext, server, ICON);
    await whenIdle(ext, view, (c) => c.imagesAdapted === 1);
    for (let i = 0; i < 3; i += 1) {
      await disable(ext.worker, view.page);
      expect(await imageCounters(view)).toMatchObject({ ownedUrls: 0, imagesTracked: 0 });
      await enable(ext.worker, view.page);
      await whenIdle(ext, view, (c) => c.imagesAdapted >= 1);
    }
    const counters = await imageCounters(view);
    expect(counters.ownedUrls).toBe(1);
    expect(counters.blobsCreated - counters.blobsRevoked).toBe(1);
    await disable(ext.worker, view.page);
    expect(
      await view.page.evaluate(() => document.getElementById('icon')!.getAttribute('src')),
    ).toBe('/alert.png');
  });

  test('a theme change re-adapts it for the new background; a ground it no longer conflicts with restores it', async () => {
    serveImage(server, 'alert.png', monoIcon(24, RED, true));
    const view = await openImages(ext, server, ICON);
    await whenIdle(ext, view, (c) => c.imagesAdapted === 1);
    const onGreen = (await shown(view.page, '#icon')).src;

    await view.page.evaluate((color) => (document.body.style.background = color), OLIVE);
    await whenIdle(ext, view, (c) => c.imagesAdapted === 2);
    const onOlive = await shown(view.page, '#icon');
    expect(onOlive.adapted).toBe(true);
    expect(onOlive.src).not.toBe(onGreen);
    expect((await imageCounters(view)).ownedUrls).toBe(1);

    await view.page.evaluate(() => (document.body.style.background = '#ffffff'));
    await whenIdle(ext, view, (c) => c.ownedUrls === 0);
    const onWhite = await shown(view.page, '#icon');
    expect(onWhite.adapted).toBe(false);
    expect(onWhite.src).toBe('/alert.png');
  });

  test('the same file on a light and a dark ground gets different treatments (context is part of the key)', async () => {
    serveImage(server, 'alert.png', monoIcon(24, RED, false));
    const view = await openImages(
      ext,
      server,
      `<div id="a" style="background:${OLIVE};padding:4px"><img id="one" class="icon" alt="Alert" src="/alert.png"></div>
       <div id="b" style="background:#2ca02c;padding:4px"><img id="two" class="icon" alt="Alert" src="/alert.png"></div>
       <div id="c" style="background:#ffffff;padding:4px"><img id="three" class="icon" alt="Alert" src="/alert.png"></div>`,
    );
    await whenIdle(ext, view, (c) => c.imagesTracked === 3 && c.imagesAdapted === 2);
    const [one, two, three] = await Promise.all(
      ['#one', '#two', '#three'].map((s) => shown(view.page, s)),
    );
    expect(one!.adapted && two!.adapted).toBe(true);
    expect(one!.src).not.toBe(two!.src);
    expect(three!.adapted).toBe(false); // red on white is fine
    expect((await imageCounters(view)).ownedUrls).toBe(2);
  });
});

test.describe('the page keeps working', () => {
  const MARKUP = `
    <button id="btn" type="button" style="padding:4px;background:#2ca02c;border:0"><img id="inbtn" class="icon" alt="Delete item" src="/alert.png"></button>
    <a id="lnk" href="#target" style="display:inline-block;padding:4px;background:#2ca02c"><img id="inlnk" class="icon" alt="Open details" src="/alert.png"></a>
    <div id="target" tabindex="-1">target</div>`;

  test('role, name, focus, click and keyboard behave exactly as before; no layer is added over the image', async () => {
    serveImage(server, 'alert.png', monoIcon(24, RED, true));
    const view = await openImages(ext, server, MARKUP);
    await view.page.evaluate(() => {
      (window as unknown as { __clicks: string[] }).__clicks = [];
      document
        .getElementById('btn')!
        .addEventListener('click', () =>
          (window as unknown as { __clicks: string[] }).__clicks.push('btn'),
        );
    });
    const treeBefore = await ariaTree(view.page, '#host');
    const boxBefore = await shown(view.page, '#inbtn');
    await whenIdle(ext, view, (c) => c.imagesAdapted === 2);
    expect((await shown(view.page, '#inbtn')).adapted).toBe(true);

    expect(await ariaTree(view.page, '#host')).toBe(treeBefore);
    expect((await shown(view.page, '#inbtn')).box).toEqual(boxBefore.box);
    expect(await view.page.evaluate(() => document.getElementById('btn')!.children.length)).toBe(1);
    expect(
      await view.page.evaluate(() => {
        const rect = document.getElementById('inbtn')!.getBoundingClientRect();
        return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.id;
      }),
    ).toBe('inbtn');

    await view.page.locator('#btn').click();
    await view.page.locator('#btn').focus();
    await view.page.keyboard.press('Enter');
    await view.page.keyboard.press('Space');
    expect(
      await view.page.evaluate(() => (window as unknown as { __clicks: string[] }).__clicks),
    ).toEqual(['btn', 'btn', 'btn']);
    await view.page.locator('#lnk').click();
    expect(await view.page.evaluate(() => location.hash)).toBe('#target');
    await view.page.locator('#lnk').focus();
    expect(await view.page.evaluate(() => document.activeElement?.id)).toBe('lnk');
    // alt, class and every other attribute are the page's own.
    expect(
      await view.page.evaluate(() => {
        const img = document.getElementById('inbtn')!;
        return [img.getAttribute('alt'), img.getAttribute('class'), img.getAttribute('title')];
      }),
    ).toEqual(['Delete item', 'icon', null]);
  });

  test('object-fit, object-position, border-radius, clip-path and the box are untouched', async () => {
    serveImage(server, 'alert.png', monoIcon(24, RED, true));
    const fits = ['contain', 'cover', 'fill', 'none', 'scale-down'];
    const view = await openImages(
      ext,
      server,
      fits
        .map(
          (fit, i) =>
            `<img id="f${i}" class="icon" alt="Alert" src="/alert.png" style="width:48px;height:32px;object-fit:${fit};object-position:25% 75%;border-radius:8px;clip-path:inset(2px 2px 2px 2px round 6px)">`,
        )
        .join(''),
    );
    const read = () =>
      view.page.evaluate(() =>
        [...document.querySelectorAll<HTMLImageElement>('#host img')].map((img) => {
          const style = getComputedStyle(img);
          const box = img.getBoundingClientRect();
          return [
            style.objectFit,
            style.objectPosition,
            style.borderRadius,
            style.clipPath,
            style.width,
            style.height,
            box.width,
            box.height,
          ];
        }),
      );
    const before = await read();
    await whenIdle(ext, view, (c) => c.imagesAdapted === 5); // one source: one bitmap, five images
    expect((await imageCounters(view)).imageOwners).toBe(5);
    expect(await read()).toEqual(before);
    expect((await shown(view.page, '#f0')).naturalWidth).toBe(24);
  });
});

test.describe('races (real decoder, real network)', () => {
  test('src A -> src B while A is still downloading: the late A never replaces B', async () => {
    const small = blank(24, 24);
    disc(small, 12, 12, 6, RED);
    serveImage(server, 'a.png', small); // a small disc: another alpha mask than B's
    serveImage(server, 'b.png', monoIcon(24, RED, false));
    const release = server.hold('a.png');
    const view = await openImages(
      ext,
      server,
      '<img id="icon" class="icon" alt="Alert" src="/b.png">',
    );
    await whenIdle(ext, view, (c) => c.imagesAdapted === 1);

    await view.page.evaluate(() => {
      document.getElementById('icon')!.setAttribute('src', '/a.png'); // A starts downloading, held
    });
    await expect.poll(() => server.hits('a.png')).toBeGreaterThan(0);
    await view.page.evaluate(() => {
      document.getElementById('icon')!.setAttribute('src', '/b.png'); // back to B before A arrives
    });
    release();
    await whenIdle(ext, view, (c) => c.imagesAdapted >= 1);
    await settle(view.page);

    const finalState = await shown(view.page, '#icon');
    const pixels = await displayedPixels(view.page, '#icon');
    const bPixels = await pixelsOfUrl(view.page, `${server.origin}/b.png`);
    const aPixels = await pixelsOfUrl(view.page, `${server.origin}/a.png`);
    // Whatever is shown derives from B (same alpha mask as B, which differs from A's).
    const alphaOf = (data: number[]) => data.filter((_, i) => i % 4 === 3);
    expect(alphaOf(pixels)).toEqual(alphaOf(bPixels));
    expect(alphaOf(pixels)).not.toEqual(alphaOf(aPixels));
    expect(finalState.adapted).toBe(true);
    const counters = await imageCounters(view);
    expect(counters.ownedUrls).toBe(1);
  });
});
