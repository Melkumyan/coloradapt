# Image Adaptation (M8)

M8 adds a safe image-analysis layer. It recognizes when a raster image is likely to carry
color-dependent functional information and, in one narrow case, provides an accessibility
adaptation. It is **not** "apply a daltonism filter to every image".

```
photograph                          → unchanged
decorative image                    → unchanged
logo / artwork                      → unchanged
screenshot                          → unchanged
raster chart / diagram              → detected, unsupported (never recolored)
status graphic (red/green bitmap)   → pixels unchanged; M6 owns the non-color cue
functional monochrome icon (HIGH)   → recolored (M3 optimizer), reversibly
anything uncertain or unreadable    → unchanged
```

> Modifying a photograph unnecessarily is worse than leaving it untouched. Every rule below breaks
> ties toward "leave it".

M8.R1 (validation) tightened the one risky boundary, a small single-color transparent bitmap that
may be a brand mark (see [Logo protection](#logo-protection-and-the-functional-icon-evidence)),
added per-site precedence, an OS-theme listener and a real-browser validation suite.

M8 is OFF by default (`adaptImages = false`, see [Settings and default](#settings-and-default)).
Not in M8: OCR, AI image understanding, object or face recognition, photograph recoloring,
backend/proxy/upload, canvas monkey-patching, video, animated-image rewriting, Shadow DOM,
iframes.

## Privacy contract

Image bytes and pixels never leave the browser. There is no upload, no telemetry, no remote
inference, no external API and no proxy. The layer reads pixels only to analyze and transform
them locally; the results (statistics, a generated bitmap) stay in memory and are never written
to extension storage. With `adaptImages` off no image is read at all. A real-browser test
(`e2e/image-policy.spec.ts`, "privacy") checks that adapting an image contacts no host that the
same page does not contact with the layer off. See also [PRIVACY.md](PRIVACY.md).

## Architecture

```
src/core/images/            pure, DOM-free
  types.ts                  PixelBuffer, PixelStats, ColorCluster, ImageFacts, ImageClassification
  oklab.ts                  fast sRGB-byte → OKLab for pixel loops
  sampling.ts               deterministic analysis size, source/transform budgets
  clusters.ts               deterministic dominant-color clustering over an OKLab histogram
  palette.ts                analyzePixels(): clusters, entropy, flat/edge share, transparency
  distinguishability.ts     pairwise M2 analysis of the significant clusters
  classification.ts         vocabulary, classifyImage(): kind + confidence + evidence
  policy.ts                 gateBeforeRead(), decideImage(): what may happen to an image
  adaptation.ts             planMonochromeIcon(): cluster-aware remap, M3, verification
  format.ts                 sniffImage() (PNG/APNG, GIF, WebP, AVIF, JPEG), formatFromUrl()
src/features/images/        browser
  discovery.ts              find <img>/<input type=image>/CSS backgrounds; read DOM facts
  readability.ts            ImageEnvironment (the browser's side), ReadResult
  raster-reader.ts          default environment: offscreen canvas, fetch, object URLs
  image-apply.ts            GeneratedImageCache (owns every object URL), show/restore a source
  image-controller.ts       ImageController: states, queue, races, load bridge, ownership
src/shared/constants/images.ts   IMAGE_LIMITS, IMAGE_THRESHOLDS
src/domain/models/image.ts       ImageKind, ImageAction, ImageReason, ImageDiagnostics
```

`ImageController` is owned by `createContentController` and driven by
`IncrementalAdaptationSession` (after colors, semantics and charts: it reads the settled page).

## The pipeline

```
M4 region (or document scan)
  → find images
  → quick key: source + natural size + load state (+ background, if the decision depends on it)
      unchanged since the last look → nothing
  → gate before any pixel is read          (policy.gateBeforeRead)
  → read pixels, bounded                    (readability / raster-reader)
  → statistics + clusters                   (palette / clusters)
  → classify                                (classification)
  → decide                                  (policy.decideImage)
  → only a HIGH monochrome icon continues:
       resolve the opaque background → sniff the bytes → plan (M3 + remap + verify)
       → encode PNG → cache entry (object URL) → show it in place of the page's source
```

Every step can end the pipeline with a recorded `action` + `reason`:

| action          | meaning                                                               |
| --------------- | --------------------------------------------------------------------- |
| `unchanged`     | looked at and deliberately left alone                                 |
| `not-needed`    | functional image whose colors already tell apart under the profile    |
| `unsupported`   | cannot be handled safely (unreadable, animated, masked, a chart, ...) |
| `pixel-adapted` | recolored; a generated bitmap is shown                                |
| `pending`       | waiting for the page's image to load                                  |
| `overlay-cue`   | reserved; **never produced** (M6 owns non-color cues, see below)      |

## Image sources

| source                        | policy                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `<img>`                       | analyzed; the only source that can be adapted                                  |
| `<input type="image">`        | recognized, `unsupported` / `input-image` (not adapted in M8)                  |
| CSS `background-image: url()` | recognized, **detect only**: `unsupported` / `css-background`, nothing is read |
| inline SVG                    | M5/M7, not this layer                                                          |
| `<canvas>`                    | M7 detect-only; never touched here                                             |
| video, iframe, object/embed   | not examined                                                                   |
| CSS gradients                 | not images for this layer                                                      |

CSS backgrounds have layers, position, size, repeat and blend modes; a replaced bitmap cannot
honor all of that, so they are counted (`backgroundImages`) and left to the page. The scan is
bounded (`maxScannedPerRoot` elements per region).

## Readability: same-origin, CORS, taint

Pixels are read through an offscreen canvas that M8 owns; `CanvasRenderingContext2D.prototype`
and page canvases are never touched. The read uses a **fresh `Image` of the page's own source**
with the page's own `crossorigin` attribute, so it never asks for more access than the page did:

- same-origin, `data:` and (where the browser allows) `blob:` images are readable;
- a **cross-origin image without CORS** taints the canvas: `getImageData` throws `SecurityError`,
  which is caught and recorded as `unreadable`. No analysis, no transformation, no exception
  escapes, nothing is fetched on another route;
- a **cross-origin image the page requested with CORS** (`crossorigin="anonymous"` and a server
  that allows it) is readable like any other. Cross-origin does not mean forbidden; tainted does.
  The byte sniff for such an image is a CORS fetch with the page's own credentials mode;
- there is no proxy, no extra host permission and no CORS circumvention. Permissions are
  unchanged by M8.

## Classification

Kinds (`ImageKind`): `unknown`, `photograph`, `decorative`, `logo`, `illustration`, `ui-raster`,
`monochrome-icon`, `status-graphic`, `diagram`, `chart-raster`, `screenshot`, `complex-artwork`.
Confidence: `HIGH`, `MEDIUM`, `LOW`, `UNKNOWN`. **Only `monochrome-icon` + `HIGH` can lead to a
pixel transformation.**

Evidence is deterministic and listed in `classification.evidence`:

- DOM: natural and rendered size, `alt` (absence vs explicit `""`), `role`, `aria-hidden`,
  `aria-label`, `title`, class/id tokens, file-name tokens, ancestor tokens, interactive
  container, link to the site root, `srcset`/`<picture>`, `usemap`, CSS effects;
- pixels: transparent share, neutral share, distinct histogram cells, color entropy, flat and
  edge share, dominant clusters, noise.

Order of decisions: decorative → logo → screenshot token → (unreadable: text only) → photographic
statistics → chart token/structure → diagram token → status token → icon-sized → flat artwork.

**Vocabulary** (`IMAGE_VOCABULARY`, one place): whole tokens after splitting on non-letters, never
substrings or sentences. `chart graph plot histogram sparkline график диаграмма` · `diagram
flowchart scheme schematic legend схема легенда` · `status warning error success danger failed
online offline статус ошибка предупреждение успех` · `logo logotype wordmark brand branding
favicon emblem trademark sponsor(s) partner(s) лого логотип бренд спонсор партнер` · `icon ico glyph pictogram иконка значок` · `screenshot screengrab скриншот` · `photo
photograph portrait landscape avatar hero фото`. Text is secondary evidence and can only point
an image toward _not_ being touched, or toward being a functional icon: `alt="icon"` on a
photograph does not make it an icon, `alt="photo"` is not needed to know a photograph.

### Logo protection and the functional-icon evidence

The riskiest boundary is a small, transparent, single-color `<img>` that looks like a functional
icon and is actually a brand mark. A button around it, a non-empty `alt` or a class `icon` is not
evidence of function (logos are put in buttons and given `class="icon"` all the time), so M8.R1
requires **positive functional evidence** for `HIGH`:

- the image has a name (`alt`, `aria-label`, `title`, or the same on the control around it) and a
  word of that name is in the `action` vocabulary (search, close, menu, download, settings,
  notification, arrow, delete, help, alert, ...); or
- it has no name and its class, id or URL path says `icon`/`ico`/`glyph`/`pictogram`.

An icon named anything else ("Acme", "Account", "Wishlist") is `MEDIUM` and stays untouched: a
documented, intentional loss of recall (`functional-miss-*` benchmark rows). Brand evidence beats
everything: a logo-family token on the image, its path (all segments, `/brand/mark.png`) or its
ancestors; a link to the site root (`/`, `/index.html`, absolute same-origin); a sponsor/partner/
favicon/avatar marker. An avatar or photo token also caps an icon at `MEDIUM`. Everything
is deterministic and listed in `classification.evidence` (`no functional name: could be a brand
mark`).

## Policy by kind

- **Photographs** (people, landscapes, products, food, animals, architecture, covers, ads, memes,
  textures): unchanged, always. Recognized by color entropy / distinct cells, before any text is
  considered. No automatic color correction.
- **Decorative** (`alt=""`, `role="presentation"|"none"`, `aria-hidden`): unchanged, **not even
  read**. M8 is about information accessibility, not restyling.
- **Logos and branding**: unchanged. A `logo`/`brand`/`wordmark` token on the image, in its alt or
  file name (HIGH), or around it, or a link to the site root (MEDIUM). Brand fidelity outweighs
  speculative adaptation, even for a red/green logo.
- **Screenshots**: unchanged (they hold text, icons, photos, charts and UI at once). No OCR.
- **Raster charts and diagrams**: detected (`rasterCharts`), `unsupported`, untouched. Series
  identity and legend mapping cannot be reconstructed without OCR/computer vision. M7 does not
  own them either: structured SVG charts are M7's. A chart that carries no chart word and has
  thin lines may be seen only as an `illustration`; the outcome (untouched) is the same.
- **Status graphics** (small bitmap with a status word on or around it): pixels unchanged,
  `status-defers-to-semantics`. See the next section.
- **Two-region diagrams without semantics**: even if the pair would merge under the profile,
  M8 does not invent which region means what; `unchanged`/`unsupported`.
- **Functional monochrome icons**: adapted. See [Pixel adaptation](#pixel-adaptation).
- **Everything else** (illustrations, complex artwork, multi-paint UI bitmaps, anything
  `MEDIUM`/`LOW`): unchanged.

### Status graphics: overlay cue vs. pixel replacement

Both options were weighed for a red/green indicator bitmap:

| option                           | result                                                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| recolor the pixels               | invents a color for a meaning only the page knows; duplicates M6's cue; cannot be verified against the page's text            |
| add an overlay marker (✓ / !)    | needs a layer over the image (pointer/accessibility risk) and duplicates what M6 already does for images (an outline pattern) |
| **leave the pixels, M6 owns it** | chosen. One cue, from the layer that has the semantic evidence                                                                |

So `overlay-cue` exists in the action vocabulary but M8 never produces it, and ownership is
unambiguous: **semantic non-color cue > pixel recolor**. A real-browser test checks that a status
bitmap is untouched with every layer on.

## Sampling and thresholds

All limits are structural (`src/shared/constants/images.ts`); nothing depends on the wall clock.
They are engineering thresholds, not standards.

| budget                                | value          | meaning                                                           |
| ------------------------------------- | -------------- | ----------------------------------------------------------------- |
| `maxAnalysisPixels`                   | 262 144        | analysis surface (large images are downsampled deterministically) |
| `maxAnalysisDimension`                | 512            | longest side of the analysis surface                              |
| `maxSourcePixels`                     | 64 000 000     | above this the image is not decoded onto any canvas (`too-large`) |
| `maxTransformPixels`                  | 1 000 000      | hard allocation ceiling for a transformed bitmap                  |
| `maxIconDimension`                    | 128            | only images this small can be recolored (and are analyzed 1:1)    |
| `maxClusters`                         | 8              | dominant clusters kept                                            |
| `maxCachedImages` / `maxCachedPixels` | 32 / 2 000 000 | generated bitmaps held                                            |
| `maxConcurrentReads`                  | 3              | images read at once                                               |
| `maxQueuedImages`                     | 400            | beyond this an image is skipped (`queue-full`)                    |
| `maxImagesPerPass`                    | 500            | images taken from one region                                      |

Pixel thresholds (`IMAGE_THRESHOLDS`, OKLab units): visible alpha ≥ 0.5; histogram cell 0.04;
cluster merge distance 0.09; noise share 1.2 %; neutral chroma 0.04; flat < 0.012; edge > 0.1;
remap radius 0.14; photographic: ≥ 140 cells or ≥ 6.2 bits of entropy.

Sampling preserves dominant colors and major regions for simple images. It is not pixel-perfect
and nothing claims it is. A downsampled large image is only ever classified, then left alone; no
huge canvas is allocated (a 12-megapixel photo is analyzed on a ≤ 512×512 surface).
No Worker is used: the work is batched and bounded, and measured fixtures stay small.

## Color clusters and M2

`clusterCells` merges histogram cells greedily from the heaviest down: an antialiasing shade within
the merge distance of an existing cluster joins it instead of becoming a "color". Clusters below
the noise share (fringes, JPEG artifacts) are dropped and reported as `noiseShare`. Fully
transparent pixels are never colors. No randomness, no iteration to convergence: the same pixels
always give the same clusters (tested).

`analyzeClusterPairs` simulates every pair of significant (non-neutral-pair) clusters with M2
(`simulatePair`) under the profile and reports which pairs are confusable. The model provenance
(`SUPPORTED_MODEL` / `MODEL_ASSUMPTION` / `APPROXIMATION`) is carried unchanged; custom profiles
produce nothing. M2 is not upgraded or reinterpreted.

## Pixel adaptation

The only transformation: `planMonochromeIcon`, for a **functional monochrome icon** that is

- classified `monochrome-icon` with `HIGH` confidence (≤ 128 px, one chromatic cluster, ≥ 15 %
  transparent, clean histogram, with functional context: an `icon` token, an interactive
  container, or a non-empty `alt`; never decorative, a logo, a status graphic or a chart);
- an `<img>` with a replaceable source (no `srcset`/`<picture>`/`sizes`, no `usemap`, not SVG, not
  animated, no CSS filter/blend/mask on it or its nearest ancestors, no `opacity < 1` on it);
- over a **known, solid, opaque background** (otherwise `insufficient-context`).

Steps: take the paint's color → M3 `findAdaptation` against the background (same optimizer,
same constraints, same strength; no second optimizer) → remap **only the pixels that belong to
that paint**:

- alpha is copied byte for byte: geometry, coverage and edge smoothness are untouched;
- neutral pixels (white, black, gray) and everything farther than the remap radius are untouched;
- pixels inside the paint's cluster get the full OKLab shift, pixels in the ring around it a
  linearly fading part, so shading and antialiased edges keep their relative structure and no
  halo appears; every output is gamut-mapped (lightness and hue kept) and quantized to 8 bits;
- the result is verified on the output: same size, same alpha, at least one pixel changed, and the
  simulated distance to the background **strictly better** than before. Otherwise the plan is
  declined and the original stays.

Semi-transparent paints (fewer than half of the paint's pixels nearly opaque, alpha ≥ 0.95) are declined: their visible color depends on
alpha and background together, and false precision is worse than no change. Alpha compositing
follows M1: transparent pixels are never read as black, and visible color is only judged against
a known opaque background.

Not changed by the transformation: dimensions, alpha mask, text layout (there is none),
`alt`/`aria-label`/`title`, box, `object-fit`/`object-position`, `border-radius`, `clip-path`.

### Why a cluster-aware remap and not a global matrix

A global color matrix would shift white, gray and any second color along with the target. The
remap changes the paint and its shading and nothing else; the design change is bounded by M3's
own cap (`maxDesignChange`) and strength.

## Applying: generated bitmaps, object URLs, ownership

A generated bitmap is shown by setting the `<img>`'s `src` to an object URL; the page's own `src`
is remembered in memory, and `data-coloradapt-image="adapted"` marks the element while it is ours.
`src`/`srcset` are never overwritten permanently, original bytes are never touched.

- **Cache** (`GeneratedImageCache`, memory only, never persisted): keyed by
  `source + natural size + background + profile + strength`. Images that show the same bitmap
  share one entry and one URL; an entry lives exactly as long as something shows it, and the last
  release revokes the URL. Bounded by entry count and pixels, oldest first. It is the only owner
  and the only revoker of object URLs. A page's own `blob:` URL is never revoked.
- **One image, one adaptation**: a state per element; a re-evaluation replaces the previous bitmap
  (releasing it) or keeps it if the key is unchanged.
- **Idempotent**: the original source is always what is read, never an adapted bitmap. Five
  refreshes create one bitmap, read the source once and change nothing (tested, unit and real
  browser).
- **Reversible**: OFF restores the page's `src` exactly (and removes the marker), revokes every
  URL, forgets everything. A real-browser test compares element screenshots before and after
  ON/OFF byte for byte.
- **The page wins**: if the page sets a new `src` while ours is shown, ownership is dropped
  without touching the page's value, the page's new source is evaluated, and our bitmap is
  released.
- **Load failure**: if the browser reports an error for our bitmap, the original `src` is put
  back, the same bitmap is not retried (`loadFailures`), and nothing leaks. In Chromium a content
  script's blob URL was observed to pass even a strict page `img-src` (including one allowing
  only the page's own file), so this path is a safety net for other browsers (unit-tested;
  Firefox runtime is not verified).

### `src`, `srcset`, `<picture>`, responsive images

An image with `srcset`, `sizes` or a `<picture>` parent follows the browser's own candidate
choice, and replacing it would either break that choice or freeze one candidate. Initial policy:
**`unsupported` / `responsive-source`** (still analyzed, so a responsive raster chart is still
detected). Nothing is replaced, so there is no stale processed image when `currentSrc` changes.

## Dynamic images (M4)

M8 owns **no DOM observer**. M4 hands it the regions it already re-analyzes (`update(roots)`);
removed images are released on the same passes (parents that lost a child). The one thing M4 cannot
see is an image finishing to load or changing `src`/`srcset`, which mutates no observed
attribute but always fires `load` or `error`: a **single capture-phase `load`/`error` listener on
the document** (installed only while the layer is active, removed on OFF) re-checks that image.
Work is queued (3 concurrent reads, 400 queued), shared per source, and guarded:

- every image has a generation; a result is discarded (and its URL revoked) if the image changed
  (`src`, background), was removed, or the layer was reset while it was computed
  (`staleResultsDiscarded`). Late `src A` can never overwrite `src B` (tested with a real held
  download);
- unloaded images are `pending` until `load`; broken ones (`naturalWidth === 0`) are
  `unavailable` and cause no loop;
- one image that throws or is unreadable never stops the others;
- a page background change (theme) re-evaluates the images in the affected regions, and a full
  rescan re-evaluates all; the cache key includes the background, so a light and a dark ground
  never share a result;
- the OS color scheme can flip an image's ground (`@media (prefers-color-scheme)`) with no DOM
  mutation at all. M8.R1 adds **one** `matchMedia('(prefers-color-scheme: dark)')` `change`
  listener, present only while the layer is active (`themeListeners` 0 or 1). On a change only the
  images whose decision depends on a background are looked at (`themeReevaluations`): an image
  whose ground did not change costs one style read; one whose ground changed is re-adapted, or
  restored if it no longer conflicts. Verified in Chromium with `emulateMedia`;
- if the page gives an adapted image another choice (`srcset`, `<picture>`) the browser loads
  that candidate while our `src` is still in place; the `load` shows `currentSrc` is no longer
  ours, the image is re-evaluated (`responsive-source`) and our bitmap and owner are released.

## Safety properties (verified in Chromium)

Layout (box, `object-fit` contain/cover/fill/none/scale-down, `object-position`,
`border-radius`, `clip-path`), accessibility tree (`ariaSnapshot` before/after), focus, click and
keyboard behaviour of buttons and links containing images, image maps, and the absence of any
layer, wrapper or sibling added over the image are checked in `e2e/image-adapt.spec.ts` and
`e2e/image-policy.spec.ts`. No screen-reader claim is made. No `innerHTML`, `eval`, dynamic code,
remote code or new permission is used; no script is injected into the page.

CSS that changes how an image's pixels look (`filter`, `mix-blend-mode`, `mask-image`
on the image or its nearest ancestors, and `opacity < 1` on the image itself) means raw pixels are not the rendered
appearance: `unsupported` / `css-effects`.

## Settings and default

`adaptImages` (already in the schema) is now live. **Default: `false`.** Decision after the
benchmark: although the supported case is narrow and gated twice (HIGH classification and
verification), image changes are higher-risk than SVG or chart cues, an extra analysis pass reads
image pixels, and an unreviewed `true` would change what every user sees. The Options page offers
"Adapt functional images (small single-color bitmap icons only; photos, logos, screenshots and
charts are never changed)". An explicit stored `true`/`false` is never overridden; an absent or
invalid value is `false` (tested).

**Per-site precedence (M8.R1)**: `resolveEffectiveSettings` computes
`effective adaptImages = global adaptImages AND site override (when one exists)`, the same
narrowing as `improveUIColors && site.adaptUI`; no override means the global value. A site can
switch the layer off for itself, but cannot switch it on behind a global "off" (images are the
costly error). Settings reach each page's content script already resolved for its hostname, so two
sites never share a decision or a bitmap (Chromium: site A on, site B off, open together). The
Options page has no per-site editor yet, so no visible control is ignored; per-site `adaptCharts`
is still not consulted (M7, frozen).

**OFF**: turning the layer off (global, site or normal vision) puts every page `src` back, revokes
every ColorAdapt object URL, clears the cache and the analyses, and removes both listeners; turning
it on rebuilds. Nothing is kept "just in case".

## Source ownership

Two sources are kept apart: the **page's** (what the page last set) and **ours** (the generated
object URL). While ours is shown the image's identity is the page's source. If the page sets a new
`src` (or `srcset`) the page wins: our URL is revoked, the new source is analyzed on its own, and OFF
restores the new value, never the old one (tested in jsdom and Chromium). ColorAdapt revokes only
URLs the cache created: a page-owned `blob:` URL is never revoked. No attribute other than `src`
and our `data-coloradapt-image` marker is written (tested over `alt`, `title`, `aria-*`, `width`,
`height`, `loading`, `decoding`, `fetchpriority`, `referrerpolicy`, `crossorigin`).

## Diagnostics

`ImageDiagnostics` (counts and gauges, no telemetry, in `DynamicDiagnostics.images`):
`imagesDiscovered`, `imagesReadable`, `imagesUnreadable`, `imagesClassified`, `imagesFunctional`,
`imagesAdapted`, `imagesUnsupported`, `pixelsSampled`, `blobsCreated`, `blobsRevoked`,
`cacheHits`, `cacheMisses`, `staleResultsDiscarded`, `loadFailures`, `rasterCharts`,
`photographs`, `backgroundImages`, and gauges `imagesTracked`, `imageOwners`, `ownedUrls`,
`cachedImages`, `pendingReads`, `queuedImages`, `loadListeners`, `themeListeners`,
`themeReevaluations`.

## Benchmark and validation

`tests/benchmarks/image-benchmark.test.ts` (scenarios in `image-scenarios.ts` and
`image-scenarios-r1.ts`, report written to `benchmark-report/images.json`): **195 synthetic
scenarios** (protan, deutan and tritan profiles) through the real controller. By category:
photographs 30 (portrait, landscape, food, product, architecture, night, saturated, low-color,
duotone, cut-out, minimal, avatar, album cover, ...), logos 12, **brand/icon ambiguity 20** (small
mono brand mark, favicon-like, company mark in a button, brand icon in `<nav>`, sponsor and partner
marks, brand avatar, app logo, non-empty alt, in a home link, in a non-home link, `class="icon"`,
`role="img"`, `aria-label` on the button, `/brand/` path), decorative 8, artwork 7 (poster, album
cover, pixel art, sticker, ad creative), screenshots 12 (small settings, status panel, cropped UI),
raster charts 15, diagrams 6, status graphics 9, monochrome icons 20, **functional icons 14**
(search, close, download, menu, settings, notifications, arrow, info, delete, help, unnamed
`btn-icon`, three conservative misses, a status icon), cross-origin 8, animated/SVG 4, large 4,
transparent PNGs 6, presentation 7, responsive 4, **boundaries 9** (127/128/129 px, 10/15/20 %
transparency, two meaningful colors, noise-only second cluster, antialiasing shades).

Report (one run): **photos transformed 0, logos/brand traps transformed 0, any protected category
transformed 0, false-positive transformations 0 of 124 curated cases, classification conflicts 0**.
Supported: **36 of 36 adapted** (all `monochrome-icon`/`HIGH`, all with strictly better simulated
distinguishability, identical dimensions and alpha), functional icons adapted 11, supported misses
3 (documented, `functional-miss-*`: real icons named "Account", "Wishlist", "Dark mode"),
unsupported 42, unchanged 112, not needed 5. A second and third full pass change nothing, and OFF
leaves no URL and no marker. The protected categories (photograph, logo, brand ambiguity,
artwork, screenshot, raster chart, animated, cross-origin unreadable, status graphic, decorative,
diagram) are a hard gate: any transform there fails the suite.

Real Chromium (`e2e/image-adapt.spec.ts`, `e2e/image-policy.spec.ts`): real PNG, a real JPEG
photograph, logo, status bitmap, raster chart, responsive images, broken image, data URL,
page-owned blob URL, same-origin, tainted cross-origin and CORS-enabled cross-origin images,
GIF/APNG/SVG, filters/masks, image map, CSS background, strict CSP, rendered-pixel and screenshot
checks, accessibility tree, interaction, races, retention (100 images replaced/removed/restored),
privacy. M8.R1 adds `e2e/image-r1.spec.ts` (per-site, a forced Blob load failure, CSP, A to B to C,
profile change, `emulateMedia` theme change, redirects, wrong CORS, malformed data URLs, brand
fixtures, 127/128/129 px and 15 % transparency in a real decoder).

## Known limitations

- Only functional monochrome `<img>` icons are recolored; multi-paint UI bitmaps, status
  graphics, diagrams, charts and everything uncertain are left as they are by design.
- `srcset`/`<picture>` images, `<input type="image">`, CSS backgrounds, SVG through `<img>`,
  animated images, masked/filtered images and image maps are not adapted.
- Classification is engineering heuristics. A small single-color transparent bitmap with a `alt`
  text and no brand evidence can be a logo the page did not label; the policy treats missing
  evidence as "unchanged" only where it can see the doubt (`MEDIUM`), not for a perfect
  look-alike.
- Thin-line raster charts with no chart word may be called `illustration`; they stay untouched.
- Only an opaque, solid background (through ancestors) is a known context; gradients, images and
  `opacity` on html/body are `insufficient-context`.
- An OS color-scheme change is observed only through the `matchMedia` listener (no other media
  query, e.g. `prefers-contrast`/`forced-colors`, is watched).
- Firefox: the build passes; the runtime is not verified (object-URL and CSP behavior included).
- Per-site `adaptImages` can only narrow the global value; per-site `adaptCharts` is still not consulted.
- Recall is deliberately low: a real icon whose name has no functional word ("Account") is left unchanged.
- Animated WebP/AVIF are recognized from their bytes in unit tests; there is no real animated-WebP fixture in Chromium (GIF and APNG are).
- Blob load failure is forced in Chromium by revoking the URL from the page; a browser-enforced CSP refusal of a content-script blob could not be reproduced (Chromium allows it), so that exact path stays unit-tested.
- At most 500 images are taken from one region per pass and 400 wait in the queue; images beyond that
  are not examined (or marked `queue-full`) and stay as the page made them.
