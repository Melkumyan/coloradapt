import { describe, expect, it } from 'vitest';
import { IMAGE_LIMITS } from '@shared/constants';
import { abs, iconPixels, makeImage, pageSetsSrc, photograph, setupDynamic } from './kit';

const HOST = '<div id="host"></div>';
const host = (): HTMLElement => document.getElementById('host')!;
const ICON_ATTRS = { class: 'icon', alt: 'Alert' };

describe('representative page: 100 small icons, 20 medium images, 1 large photo', () => {
  it('does bounded work: one analysis per distinct source, every surface within the structural budget', async () => {
    const kit = setupDynamic(HOST);
    const icons = Array.from({ length: 10 }, (_, i) => abs(`/i/icon-${i}.png`));
    for (const url of icons) kit.env.set(url, iconPixels());
    for (let i = 0; i < 100; i += 1) {
      host().append(makeImage({ src: icons[i % icons.length]!, attrs: ICON_ATTRS }));
    }
    for (let i = 0; i < 20; i += 1) {
      const url = abs(`/i/medium-${i}.jpg`);
      kit.env.set(url, photograph(96, 96, 100 + i));
      host().append(makeImage({ src: url, width: 96, height: 96, attrs: { alt: `Photo ${i}` } }));
    }
    const big = abs('/i/large.jpg');
    kit.env.set(big, photograph(160, 120, 7));
    host().append(
      makeImage({ src: big, width: 4000, height: 3000, attrs: { alt: 'A 12 megapixel photo' } }),
    );

    kit.enable();
    await kit.settle();

    for (const read of kit.env.reads) {
      expect(read.width * read.height).toBeLessThanOrEqual(IMAGE_LIMITS.maxAnalysisPixels);
      expect(Math.max(read.width, read.height)).toBeLessThanOrEqual(
        IMAGE_LIMITS.maxAnalysisDimension,
      );
    }
    // Ten distinct icons: one analysis and one transform read each. Twenty photos and one big one: one analysis each.
    expect(kit.env.reads.length).toBeLessThanOrEqual(10 * 2 + 21);
    expect(kit.env.created).toHaveLength(10);
    const diagnostics = kit.controller.incremental.imageDiagnostics();
    expect(diagnostics.imagesAdapted).toBe(100);
    expect(diagnostics.imageOwners).toBe(100);
    expect(diagnostics.photographs).toBe(21);
    expect(diagnostics.pixelsSampled).toBeLessThanOrEqual(
      10 * 24 * 24 + 20 * 96 * 96 + IMAGE_LIMITS.maxAnalysisPixels,
    );
    expect(diagnostics.ownedUrls).toBe(10);
    // The photos were left alone, the big one included.
    for (const image of [...host().children].slice(100)) {
      expect(image.getAttribute('src')).toMatch(/\.jpg$/);
    }
  });
});

describe('100 image nodes that load, change src, are removed and come back', () => {
  it('batches the work and leaves no stale bitmap and no stale owner', async () => {
    const kit = setupDynamic(HOST);
    kit.enable();
    const images: HTMLImageElement[] = [];
    for (let i = 0; i < 100; i += 1) {
      const url = abs(`/i/a-${i}.png`);
      kit.env.set(url, iconPixels());
      kit.env.set(abs(`/i/b-${i}.png`), iconPixels());
      images.push(makeImage({ src: url, attrs: ICON_ATTRS, complete: false }));
    }
    host().append(...images);
    kit.controller.dynamic.flush();
    await kit.settle();
    expect(kit.controller.incremental.imageDiagnostics()).toMatchObject({
      imageOwners: 0,
      imagesTracked: 100,
    }); // nothing is decided before the page's own images have loaded

    for (const [i, image] of images.entries()) pageSetsSrc(image, abs(`/i/a-${i}.png`));
    await kit.settle();
    expect(kit.controller.incremental.imageDiagnostics().imageOwners).toBe(100);

    for (const [i, image] of images.entries()) pageSetsSrc(image, abs(`/i/b-${i}.png`));
    await kit.settle();
    let diagnostics = kit.controller.incremental.imageDiagnostics();
    expect(diagnostics.imageOwners).toBe(100);
    expect(diagnostics.ownedUrls).toBe(100); // the a-bitmaps were revoked as the b-bitmaps replaced them
    expect(kit.env.live).toHaveLength(100);

    for (const image of images) image.remove();
    kit.controller.dynamic.flush();
    await kit.settle();
    diagnostics = kit.controller.incremental.imageDiagnostics();
    expect(diagnostics).toMatchObject({ imagesTracked: 0, imageOwners: 0, ownedUrls: 0 });
    expect(kit.env.live).toEqual([]);

    host().append(...images);
    kit.controller.dynamic.flush();
    await kit.settle();
    diagnostics = kit.controller.incremental.imageDiagnostics();
    expect(diagnostics.imageOwners).toBe(100);
    expect(diagnostics.pendingReads).toBe(0);
    expect(diagnostics.queuedImages).toBe(0);

    kit.controller.disableAdaptation();
    expect(kit.env.live).toEqual([]);
    const final = kit.controller.incremental.imageDiagnostics();
    expect(final.ownedUrls).toBe(0);
    expect(final.blobsCreated).toBe(final.blobsRevoked);
  });
});
