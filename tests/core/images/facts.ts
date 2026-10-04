import type { ImageFacts } from '@core/images';

/** A plain `<img>` of 24x24: no tokens, not interactive, a same-origin PNG. */
export function makeFacts(overrides: Partial<ImageFacts> = {}): ImageFacts {
  return {
    source: 'img',
    naturalWidth: 24,
    naturalHeight: 24,
    renderedWidth: 24,
    renderedHeight: 24,
    alt: null,
    role: null,
    ariaHidden: false,
    labelTokens: [],
    ownTokens: [],
    contextTokens: [],
    interactive: false,
    linksHome: false,
    srcKind: 'http',
    format: 'png',
    responsive: false,
    imageMap: false,
    cssEffects: false,
    ...overrides,
  };
}

export const sized = (w: number, h: number) => ({
  naturalWidth: w,
  naturalHeight: h,
  renderedWidth: w,
  renderedHeight: h,
});
