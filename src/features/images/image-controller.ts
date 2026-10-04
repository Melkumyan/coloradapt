import {
  createBackgroundResolutionCache,
  resolveEffectiveBackground,
  type AnalysisRoot,
} from '@core/analysis';
import { toHex } from '@core/color';
import {
  analysisSize,
  analyzePixels,
  classifyImage,
  decideImage,
  gateBeforeRead,
  isDecorative,
  planMonochromeIcon,
  sniffImage,
  type ImageClassification,
  type PixelStats,
  type SniffedImage,
} from '@core/images';
import {
  EMPTY_IMAGE_DIAGNOSTICS,
  type ColorValue,
  type ImageAction,
  type ImageConfidence,
  type ImageDiagnostics,
  type ImageKind,
  type ImageReadability,
  type ImageReason,
  type VisionProfile,
} from '@domain/models';
import { IMAGE_LIMITS } from '@shared/constants';
import {
  currentSource,
  findBackgroundImages,
  findImages,
  isImageElement,
  loadStateOf,
  readImageFacts,
} from './discovery';
import {
  GeneratedImageCache,
  IMAGE_OWNED_ATTRIBUTE,
  captureOriginal,
  restoreOriginal,
  showGenerated,
  showsGenerated,
  type GeneratedImage,
  type OriginalSource,
} from './image-apply';
import { defaultImageEnvironment } from './raster-reader';
import type { ImageEnvironment, ReadResult } from './readability';

/** What the image layer needs from the stylesheet. */
export interface ImageSheetHost {
  /** Runs `read` with the page's own styles in effect (our rules suspended). */
  withOriginalStyles<T>(read: () => T): T;
}

export interface ImageControllerOptions {
  readonly doc: Document;
  readonly sheet: ImageSheetHost;
  readonly env?: ImageEnvironment;
  readonly getStyle?: (element: Element) => CSSStyleDeclaration;
}

export interface ImageSettings {
  readonly enabled: boolean;
  readonly adaptImages: boolean;
  readonly visionProfile: VisionProfile;
  readonly adaptationStrength?: number;
}

/** What the image layer decided about one image (for tests and debugging). */
export interface ImageInfo {
  readonly action: ImageAction;
  readonly reason: ImageReason;
  readonly kind: ImageKind;
  readonly confidence: ImageConfidence;
  readonly readability: ImageReadability;
  /** The page's own source while a generated bitmap is shown; `null` otherwise. */
  readonly originalSource: string | null;
}

interface Applied {
  readonly entry: GeneratedImage;
  readonly original: OriginalSource;
  /** The page's own resolved source, which stays the identity of the image while ours is shown. */
  readonly source: string;
  readonly width: number;
  readonly height: number;
  readonly key: string;
}

interface ImageState {
  readonly element: Element;
  generation: number;
  queued: boolean;
  /** Identity of what was last evaluated; a different one means the image changed. */
  key: string | null;
  action: ImageAction;
  reason: ImageReason;
  kind: ImageKind;
  confidence: ImageConfidence;
  readability: ImageReadability;
  /** Background the decision depends on (hex), or `null` when it does not depend on one. */
  background: string | null;
  applied: Applied | null;
  /** A generated bitmap the browser refused to show: not tried again for the same key. */
  blocked: string | null;
}

interface AnalysisEntry {
  readonly readability: ImageReadability;
  readonly stats: PixelStats | null;
}

type BuildResult =
  | { readonly entry: GeneratedImage }
  | { readonly action: ImageAction; readonly reason: ImageReason };

interface BuildJob {
  waiters: number;
  readonly promise: Promise<BuildResult>;
}

type Counters = {
  -readonly [K in keyof ImageDiagnostics]: ImageDiagnostics[K];
};

const FUNCTIONAL_KINDS: ReadonlySet<ImageKind> = new Set([
  'monochrome-icon',
  'ui-raster',
  'status-graphic',
  'diagram',
  'chart-raster',
]);

/** A key for an arbitrary URL; long ones (data URLs) are reduced by two independent 32-bit hashes. */
function urlKey(url: string): string {
  if (url.length <= 200) return url;
  let a = 0x811c9dc5;
  let b = 5381;
  for (let i = 0; i < url.length; i += 1) {
    const code = url.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = (Math.imul(b, 33) + code) >>> 0;
  }
  return `${url.slice(0, 24)}#${url.length}:${a.toString(16)}:${b.toString(16)}`;
}

/**
 * The raster-image layer (M8, docs/IMAGE_ADAPTATION.md). It finds `<img>` elements, reads their
 * pixels where the browser allows it, classifies them, and recolors exactly one kind: functional
 * monochrome icons classified with HIGH confidence. Everything else (photographs, logos,
 * screenshots, charts, status graphics, anything uncertain or unreadable) is left byte-for-byte as
 * the page made it.
 *
 * It owns no DOM observer. M4 hands it the regions it re-analyzes (`update`); the one thing M4
 * cannot see, an image finishing to load or changing `src`/`srcset` (no mutation of an observed
 * attribute), arrives through a single capture-phase `load`/`error` listener on the document.
 *
 * Work is asynchronous (decoding is) and therefore guarded: every image has a generation, and a
 * result that arrives after the image changed, was removed, or the layer was reset is discarded
 * and its URL revoked. Originals are never overwritten: the page's own `src` is restored exactly
 * (or left to the page if the page changed it). Generated bitmaps live in a memory-only cache that
 * owns and revokes every object URL.
 */
export class ImageController {
  readonly #doc: Document;
  readonly #sheet: ImageSheetHost;
  readonly #env: ImageEnvironment;
  readonly #getStyle: (element: Element) => CSSStyleDeclaration;
  readonly #cache: GeneratedImageCache;
  readonly #states = new Map<Element, ImageState>();
  readonly #queue: ImageState[] = [];
  readonly #analyses = new Map<string, AnalysisEntry>();
  readonly #reading = new Map<string, Promise<AnalysisEntry>>();
  readonly #sniffs = new Map<string, Promise<SniffedImage | null>>();
  readonly #building = new Map<string, BuildJob>();
  readonly #waiters: Array<() => void> = [];
  readonly #counters: Counters = { ...EMPTY_IMAGE_DIAGNOSTICS };
  #settings: ImageSettings | null = null;
  #signature = '';
  #active = false;
  #epoch = 0;
  #running = 0;
  #listening = false;
  #scheme: MediaQueryList | null = null;

  constructor(options: ImageControllerOptions) {
    this.#doc = options.doc;
    this.#sheet = options.sheet;
    this.#env = options.env ?? defaultImageEnvironment;
    this.#getStyle = options.getStyle ?? ((element) => getComputedStyle(element));
    this.#cache = new GeneratedImageCache(this.#env);
  }

  get active(): boolean {
    return this.#active;
  }

  /**
   * Starts (or reconfigures) the layer. Only `enabled && adaptImages` makes it active, and then
   * only for a profile that needs anything: a refresh with the same settings keeps what is
   * applied (idempotent), a different profile or strength starts over (cached bitmaps survive,
   * keyed by their parameters).
   */
  begin(settings: ImageSettings): void {
    if (!settings.enabled || !settings.adaptImages) {
      this.end();
      return;
    }
    const signature = `${settings.visionProfile}|${settings.adaptationStrength ?? 1}`;
    if (this.#active && signature !== this.#signature) this.#reset();
    this.#settings = settings;
    this.#signature = signature;
    this.#active = true;
    this.#listen(true);
  }

  /** Stops: every image is put back, every object URL revoked, nothing is kept. */
  end(): void {
    this.#listen(false);
    this.#reset();
    this.#cache.clear();
    this.#analyses.clear();
    this.#sniffs.clear();
    this.#active = false;
    this.#settings = null;
    this.#signature = '';
    this.#notifyIdle();
  }

  diagnostics(): ImageDiagnostics {
    let owners = 0;
    for (const state of this.#states.values()) if (state.applied) owners += 1;
    return {
      ...this.#counters,
      blobsCreated: this.#cache.created,
      blobsRevoked: this.#cache.revoked,
      cacheHits: this.#counters.cacheHits + this.#cache.hits,
      cacheMisses: this.#counters.cacheMisses + this.#cache.misses,
      imagesTracked: this.#states.size,
      imageOwners: owners,
      ownedUrls: this.#cache.liveUrls,
      cachedImages: this.#cache.size,
      pendingReads: this.#running,
      queuedImages: this.#queue.length,
      loadListeners: this.#listening ? 1 : 0,
      themeListeners: this.#scheme ? 1 : 0,
    };
  }

  /** What the layer made of one image; `null` for an element it does not track. */
  inspect(element: Element): ImageInfo | null {
    const state = this.#states.get(element);
    if (!state) return null;
    return {
      action: state.action,
      reason: state.reason,
      kind: state.kind,
      confidence: state.confidence,
      readability: state.readability,
      originalSource: state.applied?.source ?? null,
    };
  }

  /** Resolves once no read, build or queued evaluation is outstanding. For tests and flushes. */
  settle(): Promise<void> {
    if (this.#idle()) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  scanDocument(): void {
    if (!this.#active) return;
    const root = this.#doc.documentElement;
    if (root) this.#visit({ element: root, scope: 'subtree' });
    this.#prune();
  }

  /**
   * M4 re-analyzed these regions: look at the images in them. Images beyond the per-pass cap, or
   * beyond the queue bound, are skipped (`queue-full`), never half-processed. Returns the roots
   * consumed (all of them: this layer keeps its own queue).
   */
  update(roots: readonly AnalysisRoot[]): number {
    if (!this.#active) return roots.length;
    for (const root of roots) this.#visit(root);
    this.#prune();
    return roots.length;
  }

  // -- discovery -----------------------------------------------------------------------------

  #visit(root: AnalysisRoot): void {
    for (const image of findImages(root, IMAGE_LIMITS.maxImagesPerPass)) this.#touch(image);
    for (const element of findBackgroundImages(root, this.#getStyle, 200)) {
      if (this.#states.has(element)) continue;
      const state = this.#create(element);
      this.#counters.backgroundImages += 1;
      this.#settle(state, 'unsupported', 'css-background', 'unknown', 'UNKNOWN', 'unknown', null);
    }
  }

  #create(element: Element): ImageState {
    const state: ImageState = {
      element,
      generation: 0,
      queued: false,
      key: null,
      action: 'pending',
      reason: 'not-loaded',
      kind: 'unknown',
      confidence: 'UNKNOWN',
      readability: 'unknown',
      background: null,
      applied: null,
      blocked: null,
    };
    this.#states.set(element, state);
    this.#counters.imagesDiscovered += 1;
    return state;
  }

  /** Queues an evaluation if (and only if) something the decision depends on changed. */
  #touch(element: Element): void {
    if (!isImageElement(element)) return;
    let state = this.#states.get(element);
    if (!state) state = this.#create(element);
    if (state.queued) return;
    if (this.#keyOf(state) === state.key && !this.#contextChanged(state)) return;
    this.#enqueue(state);
  }

  #keyOf(state: ImageState): string {
    const { element, applied } = state;
    if (applied && showsGenerated(element, applied.entry.url)) {
      const responsive =
        element.hasAttribute('srcset') ||
        element.hasAttribute('sizes') ||
        element.parentElement?.localName === 'picture';
      return `${urlKey(applied.source)}|${applied.width}x${applied.height}|loaded${responsive ? '|responsive' : ''}`;
    }
    const image = element as HTMLImageElement;
    return `${urlKey(currentSource(element))}|${image.naturalWidth ?? 0}x${image.naturalHeight ?? 0}|${loadStateOf(element)}`;
  }

  #contextChanged(state: ImageState): boolean {
    if (state.background === null) return false;
    return this.#background(state.element)?.key !== state.background;
  }

  #enqueue(state: ImageState): void {
    if (this.#queue.length >= IMAGE_LIMITS.maxQueuedImages) {
      this.#unapply(state);
      this.#settle(state, 'unsupported', 'queue-full', 'unknown', 'UNKNOWN', 'unknown', null);
      return;
    }
    state.queued = true;
    this.#queue.push(state);
    this.#pump();
  }

  #prune(): void {
    for (const [element, state] of this.#states) {
      if (element.isConnected) continue;
      state.generation += 1;
      this.#unapply(state);
      this.#states.delete(element);
    }
  }

  // -- scheduling ----------------------------------------------------------------------------

  #pump(): void {
    while (this.#running < IMAGE_LIMITS.maxConcurrentReads && this.#queue.length > 0) {
      const state = this.#queue.shift()!;
      this.#running += 1;
      void this.#run(state).finally(() => {
        this.#running -= 1;
        this.#pump();
        this.#notifyIdle();
      });
    }
  }

  async #run(state: ImageState): Promise<void> {
    state.queued = false;
    state.generation += 1;
    const generation = state.generation;
    const epoch = this.#epoch;
    try {
      await this.#evaluate(state, generation, epoch);
    } catch {
      // One broken image must never stop the others (and never escape into the page).
      if (this.#fresh(state, generation, epoch)) {
        this.#unapply(state);
        this.#settle(state, 'unsupported', 'load-failed', 'unknown', 'UNKNOWN', 'unknown', null);
      }
    }
  }

  #idle(): boolean {
    return (
      this.#queue.length === 0 &&
      this.#running === 0 &&
      this.#building.size === 0 &&
      this.#reading.size === 0
    );
  }

  #notifyIdle(): void {
    if (!this.#idle()) return;
    for (const resolve of this.#waiters.splice(0)) resolve();
  }

  #fresh(state: ImageState, generation: number, epoch: number): boolean {
    return (
      this.#active &&
      epoch === this.#epoch &&
      state.generation === generation &&
      state.element.isConnected &&
      this.#states.get(state.element) === state
    );
  }

  // -- evaluation ----------------------------------------------------------------------------

  async #evaluate(state: ImageState, generation: number, epoch: number): Promise<void> {
    const settings = this.#settings;
    if (!settings) return;
    const element = state.element;
    this.#dropForeignOwnership(state);
    const key = this.#keyOf(state);
    state.key = key;
    const source = state.applied?.source ?? currentSource(element);
    const loaded = state.applied ? 'loaded' : loadStateOf(element);
    const facts = readImageFacts(element, {
      doc: this.#doc,
      getStyle: this.#getStyle,
      source,
    });
    const profile = settings.visionProfile;
    const decorative = isDecorative(facts);

    const gate = gateBeforeRead(facts, settings.adaptImages, profile, loaded, decorative);
    if (gate) {
      this.#unapply(state);
      const kind: ImageKind = decorative ? 'decorative' : 'unknown';
      this.#settle(
        state,
        gate.action,
        gate.reason,
        kind,
        decorative ? 'HIGH' : 'UNKNOWN',
        'unknown',
        null,
      );
      return;
    }

    const width = state.applied?.width ?? facts.naturalWidth;
    const height = state.applied?.height ?? facts.naturalHeight;
    const analysis = await this.#analysisOf(source, element, width, height);
    if (!this.#fresh(state, generation, epoch) || this.#keyOf(state) !== key) {
      this.#counters.staleResultsDiscarded += 1;
      return;
    }

    const classification: ImageClassification = classifyImage(facts, analysis.stats);
    this.#counters.imagesClassified += 1;
    if (FUNCTIONAL_KINDS.has(classification.kind)) this.#counters.imagesFunctional += 1;
    if (classification.kind === 'photograph') this.#counters.photographs += 1;
    if (classification.kind === 'chart-raster') this.#counters.rasterCharts += 1;

    const decision = decideImage({
      facts,
      classification,
      readability: analysis.readability,
      adaptImages: settings.adaptImages,
      profile,
    });
    const finish = (action: ImageAction, reason: ImageReason, background: string | null): void => {
      if (action !== 'pixel-adapted') this.#unapply(state);
      this.#settle(
        state,
        action,
        reason,
        classification.kind,
        classification.confidence,
        analysis.readability,
        background,
      );
    };
    if (!decision.candidate) {
      finish(decision.action, decision.reason, null);
      return;
    }

    // A functional monochrome icon: it needs a known, solid background to be judged against.
    const background = this.#background(element);
    if (!background) {
      finish('unsupported', 'insufficient-context', 'unresolved');
      return;
    }
    const generatedKey = `${urlKey(source)}|${width}x${height}|${background.key}|${profile}|${settings.adaptationStrength ?? 1}`;
    if (state.blocked === generatedKey) {
      finish('unsupported', 'load-failed', background.key);
      return;
    }
    if (state.applied?.key === generatedKey && showsGenerated(element, state.applied.entry.url)) {
      finish('pixel-adapted', 'adapted', background.key); // already showing exactly this
      return;
    }

    const result = await this.#generate(
      generatedKey,
      source,
      element,
      width,
      height,
      background.color,
      settings,
    );
    if (!this.#fresh(state, generation, epoch) || this.#keyOf(state) !== key) {
      this.#counters.staleResultsDiscarded += 1;
      if ('entry' in result) this.#cache.release(result.entry);
      return;
    }
    if (!('entry' in result)) {
      finish(result.action, result.reason, background.key);
      return;
    }
    this.#unapply(state);
    state.applied = {
      entry: result.entry,
      original: captureOriginal(element),
      source,
      width,
      height,
      key: generatedKey,
    };
    showGenerated(element, result.entry.url);
    this.#counters.imagesAdapted += 1;
    finish('pixel-adapted', 'adapted', background.key);
  }

  /** The effective, opaque, solid background behind an image, or `null` if it is not knowable. */
  #background(element: Element): { color: ColorValue; key: string } | null {
    const resolved = this.#sheet.withOriginalStyles(() =>
      resolveEffectiveBackground(element, this.#getStyle, createBackgroundResolutionCache()),
    );
    if (
      (resolved.kind !== 'solid' && resolved.kind !== 'none') ||
      resolved.truncated ||
      resolved.approximate
    ) {
      return null;
    }
    return { color: resolved.color, key: toHex(resolved.color) };
  }

  /** Pixel statistics of one source, shared by every image that shows it. */
  async #analysisOf(
    source: string,
    element: Element,
    naturalWidth: number,
    naturalHeight: number,
  ): Promise<AnalysisEntry> {
    const crossOrigin = element.getAttribute('crossorigin');
    const size = analysisSize(naturalWidth, naturalHeight);
    const key = `${urlKey(source)}|${crossOrigin ?? ''}|${size.width}x${size.height}`;
    const cached = this.#analyses.get(key);
    if (cached) {
      this.#counters.cacheHits += 1;
      return cached;
    }
    this.#counters.cacheMisses += 1;
    const inflight = this.#reading.get(key);
    if (inflight) return inflight;
    const job = (async (): Promise<AnalysisEntry> => {
      const read: ReadResult = await this.#env.readPixels({
        url: source,
        crossOrigin,
        width: size.width,
        height: size.height,
      });
      if (read.status === 'readable') {
        this.#counters.imagesReadable += 1;
        this.#counters.pixelsSampled += read.buffer.width * read.buffer.height;
        return { readability: 'readable', stats: analyzePixels(read.buffer) };
      }
      this.#counters.imagesUnreadable += 1;
      return {
        readability: read.status === 'tainted' ? 'tainted' : 'unavailable',
        stats: null,
      };
    })();
    this.#reading.set(key, job);
    try {
      const entry = await job;
      this.#analyses.set(key, entry);
      while (this.#analyses.size > IMAGE_LIMITS.maxCachedAnalyses) {
        const oldest = this.#analyses.keys().next().value;
        if (oldest === undefined) break;
        this.#analyses.delete(oldest);
      }
      return entry;
    } finally {
      this.#reading.delete(key);
      this.#notifyIdle();
    }
  }

  /**
   * The generated bitmap for `key`: from the cache, or built once and shared by every image that
   * asks for it while it is being built. Each caller gets one reference (released on failure).
   */
  async #generate(
    key: string,
    source: string,
    element: Element,
    width: number,
    height: number,
    background: ColorValue,
    settings: ImageSettings,
  ): Promise<BuildResult> {
    const hit = this.#cache.acquire(key);
    if (hit) return { entry: hit };
    let job = this.#building.get(key);
    if (!job) {
      const created: BuildJob = {
        waiters: 0,
        promise: this.#build(key, source, element, width, height, background, settings).then(
          (result) => {
            if ('entry' in result) result.entry.refs = created.waiters;
            return result;
          },
          (): BuildResult => ({ action: 'unsupported', reason: 'load-failed' }),
        ),
      };
      job = created;
      this.#building.set(key, job);
      void job.promise.finally(() => {
        this.#building.delete(key);
        this.#notifyIdle();
      });
    }
    job.waiters += 1;
    return job.promise;
  }

  async #build(
    key: string,
    source: string,
    element: Element,
    width: number,
    height: number,
    background: ColorValue,
    settings: ImageSettings,
  ): Promise<BuildResult> {
    // The bytes settle what the URL only hints at: format, and whether it animates.
    const sniffed = await this.#sniff(source, element.getAttribute('crossorigin'));
    if (!sniffed || sniffed.animated === null || sniffed.format === 'unknown') {
      return { action: 'unsupported', reason: 'format-unknown' };
    }
    if (sniffed.format === 'svg') return { action: 'unsupported', reason: 'svg-source' };
    if (sniffed.animated) return { action: 'unsupported', reason: 'animated' };

    const read = await this.#env.readPixels({
      url: source,
      crossOrigin: element.getAttribute('crossorigin'),
      width,
      height,
    });
    if (read.status !== 'readable') {
      return {
        action: 'unsupported',
        reason: read.status === 'tainted' ? 'unreadable' : 'unavailable',
      };
    }
    const plan = planMonochromeIcon({
      buffer: read.buffer,
      background,
      profile: settings.visionProfile,
      strength: settings.adaptationStrength ?? 1,
    });
    if (plan.status === 'declined') return { action: plan.action, reason: plan.reason };
    const blob = await this.#env.encode({ width, height, data: plan.pixels });
    // Inserted holding the builder's own reference; `#generate` swaps it for one per caller waiting.
    const entry = this.#cache.insert(key, blob, width * height);
    return { entry };
  }

  #sniff(source: string, crossOrigin: string | null): Promise<SniffedImage | null> {
    const key = urlKey(source);
    let job = this.#sniffs.get(key);
    if (!job) {
      job = this.#env
        .fetchBytes(source, IMAGE_LIMITS.maxSniffBytes, crossOrigin)
        .then((bytes) => (bytes ? sniffImage(bytes) : null))
        .catch(() => null);
      this.#sniffs.set(key, job);
      while (this.#sniffs.size > IMAGE_LIMITS.maxCachedAnalyses) {
        const oldest = this.#sniffs.keys().next().value;
        if (oldest === undefined) break;
        this.#sniffs.delete(oldest);
      }
    }
    return job;
  }

  // -- ownership -----------------------------------------------------------------------------

  /** The page replaced the source we put there: its choice stands, our bitmap is let go. */
  #dropForeignOwnership(state: ImageState): void {
    const applied = state.applied;
    if (!applied || showsGenerated(state.element, applied.entry.url)) return;
    state.element.removeAttribute(IMAGE_OWNED_ATTRIBUTE);
    this.#cache.release(applied.entry);
    state.applied = null;
  }

  #unapply(state: ImageState): void {
    const applied = state.applied;
    if (!applied) return;
    restoreOriginal(state.element, applied.original, applied.entry.url);
    this.#cache.release(applied.entry);
    state.applied = null;
  }

  #settle(
    state: ImageState,
    action: ImageAction,
    reason: ImageReason,
    kind: ImageKind,
    confidence: ImageConfidence,
    readability: ImageReadability,
    background: string | null,
  ): void {
    state.action = action;
    state.reason = reason;
    state.kind = kind;
    state.confidence = confidence;
    state.readability = readability;
    state.background = background;
    if (action === 'unsupported') this.#counters.imagesUnsupported += 1;
  }

  /** Every image back to the page's own source; states, queue and in-flight work forgotten. */
  #reset(): void {
    this.#epoch += 1;
    for (const state of this.#states.values()) {
      state.generation += 1;
      this.#unapply(state);
    }
    this.#states.clear();
    this.#queue.length = 0;
  }

  // -- load / error bridge -------------------------------------------------------------------

  readonly #onLoadEvent = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element) || target.localName !== 'img' || !this.#active) return;
    const state = this.#states.get(target);
    if (state?.applied && showsGenerated(target, state.applied.entry.url)) {
      // Our own bitmap: loaded is expected; an error means the page refused it (strict CSP). A load
      // of something else while our `src` is still in place means the page gave the browser another
      // choice (`srcset`, `<picture>`): that choice is the page's, ours must let go.
      if (event.type === 'error') this.#rollback(state);
      else if (currentSource(target) !== state.applied.entry.url) this.#touch(target);
      return;
    }
    if (!target.isConnected) return;
    this.#touch(target);
  };

  #rollback(state: ImageState): void {
    const applied = state.applied;
    if (!applied) return;
    state.blocked = applied.key;
    state.generation += 1;
    this.#unapply(state);
    this.#counters.loadFailures += 1;
    this.#settle(
      state,
      'unsupported',
      'load-failed',
      state.kind,
      state.confidence,
      state.readability,
      state.background,
    );
  }

  /**
   * The OS color scheme can change an image's ground (`@media (prefers-color-scheme)` in the
   * page's CSS) with no DOM mutation for M4 to see. One listener, only while the layer is
   * active, re-checks only the images whose decision depends on a background; an image whose
   * ground did not change costs one style read and no work.
   */
  readonly #onSchemeChange = (): void => {
    if (!this.#active) return;
    for (const state of this.#states.values()) {
      if (state.background === null) continue;
      this.#counters.themeReevaluations += 1;
      this.#touch(state.element);
    }
  };

  #watchScheme(on: boolean): void {
    if (on) {
      if (this.#scheme) return;
      const query = this.#doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)') ?? null;
      query?.addEventListener('change', this.#onSchemeChange);
      this.#scheme = query;
    } else if (this.#scheme) {
      this.#scheme.removeEventListener('change', this.#onSchemeChange);
      this.#scheme = null;
    }
  }

  #listen(on: boolean): void {
    this.#watchScheme(on);
    if (on === this.#listening) return;
    this.#listening = on;
    const method = on ? 'addEventListener' : 'removeEventListener';
    this.#doc[method]('load', this.#onLoadEvent, true);
    this.#doc[method]('error', this.#onLoadEvent, true);
  }
}
