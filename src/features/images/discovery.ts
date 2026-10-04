import type { AnalysisRoot } from '@core/analysis';
import { formatFromUrl, tokenize, type ImageFacts, type SourceFormat } from '@core/images';
import { IMAGE_LIMITS } from '@shared/constants';

/** Elements whose raster pixels M8 looks at. Inline SVG, canvas, video, iframe, object: not ours. */
const IMAGE_SELECTOR = 'img, input[type="image" i]';

export function isImageElement(element: Element): boolean {
  return (
    element.localName === 'img' ||
    (element.localName === 'input' && element.getAttribute('type')?.toLowerCase() === 'image')
  );
}

/** Images inside (or being) `root`, in document order, never more than `limit`. */
export function findImages(root: AnalysisRoot, limit: number): Element[] {
  const found: Element[] = [];
  const { element, scope } = root;
  if (isImageElement(element)) found.push(element);
  if (scope === 'subtree') {
    for (const image of element.querySelectorAll(IMAGE_SELECTOR)) {
      if (found.length >= limit) break;
      if (image !== element) found.push(image);
    }
  }
  return found;
}

/** Elements under `root` that paint a CSS `background-image` with a `url(...)`; bounded scan. */
export function findBackgroundImages(
  root: AnalysisRoot,
  getStyle: (element: Element) => CSSStyleDeclaration,
  limit: number,
): Element[] {
  const found: Element[] = [];
  const { element, scope } = root;
  const consider = (candidate: Element): void => {
    if (isImageElement(candidate)) return;
    const value = getStyle(candidate).backgroundImage;
    if (value && value !== 'none' && value.includes('url(')) found.push(candidate);
  };
  consider(element);
  if (scope === 'subtree') {
    let scanned = 0;
    for (const candidate of element.querySelectorAll('*')) {
      if (scanned >= IMAGE_LIMITS.maxScannedPerRoot || found.length >= limit) break;
      scanned += 1;
      consider(candidate);
    }
  }
  return found;
}

/** Where the displayed resource is (`currentSrc` follows `srcset`/`<picture>`). */
export function currentSource(element: Element): string {
  if (element instanceof HTMLImageElement) return element.currentSrc || element.src || '';
  return element.getAttribute('src') ?? '';
}

function srcKindOf(url: string): ImageFacts['srcKind'] {
  if (url === '') return 'none';
  if (url.startsWith('data:')) return 'data';
  if (url.startsWith('blob:')) return 'blob';
  if (/^https?:/i.test(url)) return 'http';
  return 'other';
}

/** Path tokens of an http(s) URL (`/brand/chart_sales.png?x=1` -> brand, chart, sales, png). */
function fileTokens(url: string): string[] {
  if (!/^https?:/i.test(url)) return [];
  try {
    return tokenize(new URL(url).pathname);
  } catch {
    return [];
  }
}

const EFFECT_PROPERTIES = ['filter', 'mixBlendMode', 'maskImage', 'webkitMaskImage'] as const;

function hasEffects(style: CSSStyleDeclaration): boolean {
  for (const property of EFFECT_PROPERTIES) {
    const value = (style as unknown as Record<string, string | undefined>)[property];
    if (value && value !== 'none' && value !== 'normal') return true;
  }
  return false;
}

/** True when the page itself changes how the image's pixels look (filter, blend, mask, opacity). */
function cssChangesAppearance(
  element: Element,
  getStyle: (element: Element) => CSSStyleDeclaration,
): boolean {
  let current: Element | null = element;
  for (let level = 0; current && level <= IMAGE_LIMITS.contextLevels + 2; level += 1) {
    const style = getStyle(current);
    if (hasEffects(style)) return true;
    if (level === 0 && Number.parseFloat(style.opacity || '1') < 1) return true;
    current = current.parentElement;
  }
  return false;
}

function linksToSiteRoot(link: Element | null, doc: Document): boolean {
  if (!link || link.localName !== 'a') return false;
  const href = link.getAttribute('href');
  if (!href) return false;
  try {
    const url = new URL(href, doc.baseURI);
    // `#top` or `?tab=2` on the root page are not the way home.
    return (
      url.origin === new URL(doc.baseURI).origin &&
      /^\/(index\.(html?|php|aspx?))?$/i.test(url.pathname) &&
      !url.search &&
      !href.trim().startsWith('#')
    );
  } catch {
    return false;
  }
}

export interface FactsOptions {
  readonly doc: Document;
  readonly getStyle: (element: Element) => CSSStyleDeclaration;
  /** Overrides the displayed source (while our generated bitmap is shown, the original). */
  readonly source?: string;
}

/** Everything the policy may know about one image from the DOM alone (no pixel is read). */
export function readImageFacts(element: Element, options: FactsOptions): ImageFacts {
  const { doc, getStyle } = options;
  const source = options.source ?? currentSource(element);
  const image = element instanceof HTMLImageElement ? element : null;
  const alt = element.getAttribute('alt');
  // The name of the control around the image counts as the image's own: `<button aria-label="Acme">`.
  const control = element.closest('a[href], button, [role="button"], [role="link"], summary');
  const labelTokens = [
    ...tokenize(alt ?? ''),
    ...tokenize(element.getAttribute('aria-label') ?? ''),
    ...tokenize(element.getAttribute('title') ?? ''),
    ...(control
      ? [
          ...tokenize(control.getAttribute('aria-label') ?? ''),
          ...tokenize(control.getAttribute('title') ?? ''),
        ]
      : []),
  ];
  const ownTokens = [
    ...tokenize(element.getAttribute('class') ?? ''),
    ...tokenize(element.id),
    ...fileTokens(source),
  ];
  const contextTokens: string[] = [];
  let ancestor = element.parentElement;
  for (let level = 0; ancestor && level < IMAGE_LIMITS.contextLevels; level += 1) {
    contextTokens.push(
      ...tokenize(ancestor.getAttribute('class') ?? ''),
      ...tokenize(ancestor.id),
      ...tokenize(ancestor.getAttribute('role') ?? ''),
    );
    ancestor = ancestor.parentElement;
  }
  const format: SourceFormat = formatFromUrl(source);
  const link = control;
  const rect = element.getBoundingClientRect();
  return {
    source: element.localName === 'input' ? 'input-image' : 'img',
    naturalWidth: image?.naturalWidth ?? 0,
    naturalHeight: image?.naturalHeight ?? 0,
    renderedWidth: rect.width,
    renderedHeight: rect.height,
    alt,
    role: element.getAttribute('role')?.trim().toLowerCase() ?? null,
    ariaHidden: element.closest('[aria-hidden="true"]') !== null,
    labelTokens,
    ownTokens,
    contextTokens,
    interactive: link !== null,
    linksHome: linksToSiteRoot(element.closest('a[href]'), doc),
    srcKind: srcKindOf(source),
    format,
    responsive:
      element.hasAttribute('srcset') ||
      element.hasAttribute('sizes') ||
      element.parentElement?.localName === 'picture',
    imageMap: element.hasAttribute('usemap'),
    cssEffects: cssChangesAppearance(element, getStyle),
  };
}

/** The page's load state of an image: decoded, still loading, or broken. */
export function loadStateOf(element: Element): 'loaded' | 'loading' | 'broken' {
  if (!(element instanceof HTMLImageElement)) return 'loaded';
  const src = element.currentSrc || element.getAttribute('src') || '';
  if (!element.complete) return 'loading';
  if (src === '' || element.naturalWidth === 0) return 'broken';
  return 'loaded';
}
