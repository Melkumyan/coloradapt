# Roadmap

Status markers: ✅ done in this foundation, 🚧 partially scaffolded, ⬜ planned.

## M0 — Foundation ✅

- Repository, WXT, React, TypeScript (strict), ESLint, Prettier, Vitest.
- Domain model for vision profiles, colors, conflicts, adaptation, settings.
- CI (lint, typecheck, test, build).
- Docs: README, ARCHITECTURE, PRODUCT, ROADMAP, PRIVACY, SECURITY,
  PERFORMANCE, DEVELOPMENT.
- Minimal working vertical slice (see below).

## M1 — Basic CSS Analysis ✅

- Bounded DOM scan (`core/analysis`).
- Foreground resolution: computed `color` (browser-resolved inheritance)
  with cumulative element/ancestor `opacity` applied.
- Background resolution: full ancestor traversal with alpha compositing
  (`core/color/composite.ts`), memoized per analysis pass, falling back
  to an opaque white page canvas — see `docs/CSS_ANALYSIS.md`.
- Gradient/image/mixed background detection and classification
  (`BackgroundKind`), with an `AnalysisStatus` (`resolved`/`partial`/
  `unsupported`) that keeps Conflict Detection from drawing contrast
  conclusions on backgrounds it couldn't confidently resolve.
- Per-side border colors, link/button/form-control/disabled coverage,
  nested-text deduplication, `visibility: collapse` handling.
- WCAG contrast calculation (`core/color/contrast.ts`).
- `ColorConflict` detection combining contrast + perceptual distance.

Explicit M1 policy (documented limitation, not a silent gap — see
`docs/CSS_ANALYSIS.md`'s "Known limitations"): pseudo-elements,
`::placeholder`, Shadow DOM, and iframes are not analyzed.

## M2 — Color Vision Simulation ✅ (scientific freeze: PARTIAL)

- `core/vision`: sRGB -> linear RGB -> model -> clip -> sRGB pipeline.
- Brettel 1997 (protanopia/deuteranopia/tritanopia, two half-planes),
  Machado 2009 (protanomaly/deuteranomaly), Viénot 1999 as an alternative
  protan/deutan model.
- Tritanomaly (interpolated Brettel) and achromatopsia (luminance) are
  explicit, labeled approximations.
- Validated severity in `[0, 1]`, alpha preserved, explicit clipping policy.
- `simulatePair` -> `VisionAnalysis` (original/simulated distance, loss, model),
  carried on `ColorConflict.vision`; WCAG contrast stays a separate signal.
- Reference vectors cross-validated against DaltonLens (dev-only tooling in
  `scripts/reference/`).
- The M1 heuristic matrices were removed.

M2.R1 (regression stabilization & scientific review): flaky wall-clock tests
made deterministic, constants cross-checked against libDaltonLens, Machado
linear-RGB documented as an engineering convention. Severity stays engine-level;
conflict thresholds stay uncalibrated.

Scientific freeze = PARTIAL: the Machado 2009 paper and the authors' page do
not state the matrix input space (primary review category D; Eq. 8-10 imply
linear RGB, but it is not explicit). Output is "Machado 2009, linear-RGB
interpretation", not canonical Machado output. The Eq. 17/18 erratum does not
affect the precomputed matrices. Resolving this to PASS needs author
confirmation. No PASS tag.

Still open: severity UI/settings field, calibrating conflict thresholds
against the new engine, a custom-profile model.

## M3 — Adaptation Engine ✅ (engineering PASS; upstream scientific confidence PARTIAL)

- Constrained candidate search in OKLCH (`core/adaptation`): lightness/chroma →
  small hue → wide hue, deterministic, structurally bounded, gamut-safe, 8-bit.
- Problem detection and adaptation target from the continuous M2 metrics
  (simulated distance, WCAG contrast) — separate, centralized engineering thresholds.
- Transparent scoring that prefers the smallest sufficient change; WCAG contrast
  regression guard; neutral handling; foreground-only.
- `AdaptationResult` (unchanged / adapted / no-safe-candidate / unsupported) with
  model confidence (`SUPPORTED_MODEL` / `MODEL_ASSUMPTION` / `APPROXIMATION` /
  `UNSUPPORTED`); `adaptationStrength` as OKLab interpolation.
- DOM-free `AdaptationPlan` applied via one stylesheet; analysis always reads the
  original styles (no compounding); only `resolved` elements are adapted;
  per-site overrides respected; popup shows adapted/unresolved counts.
- **M3.R1 (validation & freeze):** verified in real Chromium (Playwright E2E:
  ON/OFF exact restoration, 5 cycles, idempotent re-analysis, profile/strength
  switching, site settings, reload); CSS policy for specificity, `!important`
  (the applied result is read back: `notApplied` instead of a false "adapted"),
  transitions (no fade/flicker), animations (animated `color` skipped),
  pseudo-states (documented), opacity guard; 49-pair deterministic benchmark with
  hard safety assertions; quantization, minimal-change and confidence-propagation
  tests.
- `M3 ENGINEERING STATUS: PASS`; `UPSTREAM SCIENTIFIC CONFIDENCE: PARTIAL` (M2
  stays PARTIAL — Machado linear-RGB assumption). Thresholds remain uncalibrated
  engineering values. Firefox runtime E2E: NOT_RUN. See `docs/ADAPTATION_ENGINE.md`.

Still open: background adaptation (advanced mode), `border-color`/
`background-color`, token-aware (CSS variable) transformations, semantic
constraints (M6).

Known M3 limitations carried forward: pseudo-state colors of adapted elements are
overridden, inline `!important` is not adaptable.

## M4 — Dynamic Sites / Incremental Analysis ✅ (engineering PASS, validated in M4.R1; tag `m4-dynamic-analysis`)

- One `MutationObserver` per document with explicit mutation classification
  (`NODE_ADDED`, `NODE_REMOVED`, `STYLE_AFFECTING_ATTRIBUTE`, `TEXT_CHANGE`,
  `STYLESHEET_CHANGE`, `IRRELEVANT`, `COLORADAPT_INTERNAL`).
- Self-mutation policy: ColorAdapt's own writes never start analysis.
- Per-frame batching with a bounded queue and an `IDLE/SCHEDULED/RUNNING/DIRTY` state machine.
- Affected-root resolution with de-duplication; bounded subtree invalidation for
  ancestor (background/opacity/visibility/CSS-variable) changes.
- Incremental analysis (`analyzeSubtrees`), delta adaptation (`AdaptationDelta`),
  rule-map `StylesheetManager.applyDelta`, stable per-element ids, removal cleanup.
- Controlled, counted full-rescan fallback (stylesheets, `<html>/<body>`, overflow).
- SPA navigation handled through the mutation pipeline (no History API hook).
- Local diagnostics and a deterministic mutation benchmark; 128 real-Chromium scenarios
  (23 in M4, 105 adversarial ones in M4.R1: insertion forms, attribute churn, net-zero
  batches, text, theme switches, stylesheets and links, CSSOM limitation, self-mutation
  and page-fight attacks, exact budget boundaries, reentrancy, lifecycle, retention
  proxies, SPA, infinite scroll, six local real-world fixtures).
- M4.R1 found and fixed six defects jsdom could not see (removed/disabled/`href`-swapped
  `<link>`, a per-frame repair loop against a page that deletes our `<style>`, analyzer
  budget losing the tail of straddling roots and depending on the clock); see
  `docs/DYNAMIC_ANALYSIS.md` ("M4.R1 validation").
- Not in M4: Shadow DOM, iframes, CSSOM-only restyles, SVG. NOT_VERIFIED in a real browser:
  the hidden-tab scheduler path, `dispose()`, actual GC, Firefox runtime (build only).
  See `docs/DYNAMIC_ANALYSIS.md`.

## M5 — SVG & Icons ✅ (M5.R1 PASS)

- `core/svg`: inline `<svg>` as one unit — element roles, an explicit paint model
  (`none` / `solid` / `currentColor` / paint server / context / unsupported), computed
  `fill` and `stroke` (with `stroke-width`, `fill-opacity`, `stroke-opacity`), and
  inheritance through `svg` / `g` / shapes.
- `currentColor` ownership: adapted through `color` on the `<svg>` (never materialized as
  `fill`), found by a style probe that tells `currentColor`, inherited and explicit paint
  apart; one probe per batch.
- SVG text (`text`, `tspan`) analyzed like regular text; monochrome icons fully supported.
- `<use>`/`<symbol>`: per-instance adaptation on the `<use>` element; shared symbol content is
  never mutated (content with its own paint, external and unresolved targets are unsupported).
- Fail-safe classification: multi-paint, complex, chart-like, gradients, patterns, masks,
  filters, blend modes, markers, `foreignObject`, embedded images, animated paints, translucent
  paints (analyzed, not rewritten). Structural thresholds in `SVG_BUDGET`.
- Same optimizer, plan, stylesheet and confidence as M3; rules of one `<svg>` are an owner group,
  verified against the browser's computed paint and applied or dropped together; reversible,
  idempotent.
- Dynamic SVG through the M4 pipeline (no separate observer): paint attributes, `href`, class,
  text, node churn, late sprites; diagnostics `svg*` gauges.
- `adaptSVG` is on by default and has an options checkbox.
- Real-Chromium E2E for computed `fill`/`stroke`/`color`, `<use>` pixels, the cascade, ON/OFF,
  refresh drift, dynamic scenarios and a 500-icon stress. Firefox: build only.
- Not in M5: semantics (M6), charts (M7), Canvas, raster images / `<img src=*.svg>` (M8), external
  sprites, Shadow DOM, iframes. See `docs/SVG_ANALYSIS.md`.

### M5.R1 — SVG real-browser validation & freeze: PASS

- The one non-deterministic M4.R1 test (`120 hostile cycles`, 721 batches instead of 720) is fixed
  structurally: a repair inside the 500 ms spacing is deferred to a timer and costs exactly one
  extra batch, now counted as `stylesheetRepairsDeferred`; the test asserts
  `batches = 6 x cycles + deferred` (no sleep, retry, skip or looser range). Clock and scheduler
  were already injectable; the unit tests drive both regimes.
- New `e2e/svg-validation.spec.ts` (26 tests): `adaptSVG` default with pre-M5 stored settings and
  true/false/true toggle, ON/OFF x10 (computed values and `<use>` pixels), refresh drift,
  multi-paint 2 to 6 colors, paint servers, budget boundaries (limit - 1 / limit / limit + 1),
  retention (5 x 500 SVGs). Settings migration tested in `schema.test.ts`.
- Stability: hostile test 100/100, SVG-focused unit suites 50/50, full unit suite 5/5 (752
  tests), `pnpm verify` 3/3, complete Chromium E2E 5/5 (221 passed, 1 intentional skip: the
  hidden-tab scheduler path, unchanged). No retries.
- Firefox: build PASS, runtime NOT_VERIFIED. Known limitation kept: namespaced `xlink:href`
  mutations are not delivered to the observer; a full refresh corrects the state.
- Upstream M2 scientific status remains PARTIAL.

Next after M6: **M7 — Charts & Data Visualization** (frozen by M7.R1 below).

## M6 — Semantic Accessibility ✅ (M6.R1 PASS)

Details in `docs/SEMANTIC_ACCESSIBILITY.md`.

- A deterministic semantic core (`core/semantics`, DOM-free): evidence with provenance and
  strength, an explicit confidence model (HIGH / MEDIUM / LOW), conflicts that are never guessed,
  `unknown` preferred over a wrong state. **Color alone never classifies** (hard invariant).
- ARIA read as documented; native form semantics (`required`, `disabled`, user-touched validity);
  boundary-aware class / `data-*` tokens; a small English + Russian status vocabulary.
- Color-only detection from DOM/CSS structure (comparable elements, non-color style signature),
  existing-cue detection (icons, symbols, page `::before/::after`, state words, required markers).
- Non-color cues, only at HIGH confidence + confirmed color-only + safe placement: glyph
  (`✓ × ! ℹ * + − ↑ ↓`), underline, outline pattern. Drawn as CSS pseudo-elements with an empty
  alternative text from one attribute (`data-coloradapt-cue`) and one static rule set inside the
  managed `<style>`: no node inserted, fully reversible, idempotent, no observer loop.
- Dynamic through M4 (`SEMANTIC_CHANGE`, no observer of its own) plus one small native-validity
  event bridge; plan == browser behavior (a cue the browser does not render is not claimed).
- `semanticCuesEnabled` (default **true**: HIGH-only, color-only-confirmed, verified, reversible).
- Benchmark: 55 scenarios, 0 false positives. Real-Chromium E2E for forms, tabs, alerts, dots,
  badges, buttons, SPA state changes.
- Not in M6: AI inference (M11), charts, canvas, images, Shadow DOM, iframes, developer audit.
  M2 stays PARTIAL.

### M6.R1 — Semantic Validation & Freeze ✅ PASS

Validation, not new vocabulary. Details in `docs/SEMANTIC_ACCESSIBILITY.md`.

- **Adversarial false-positive benchmark**: 144 scenarios / 172 asserted elements (traps that look
  semantic, token traps, English and Russian negation, conflicts, non-peers, true positives,
  already-accessible, ambiguous), pure data shared by jsdom and real Chromium. **0 automatic cues
  that are wrong, 0 missed curated cues**, 28 automatic cues, 37 already-accessible skips. Together
  with the 55 of M6: 199 scenarios. A real bug found and fixed on the way: `data-state="error-prone"`
  on a `.badge` reached HIGH; a state word must now end an identifier or be followed only by
  component / modifier words.
- **Peer grouping**: peers must be wrapped alike (two lists under one parent are two components).
  **Peer invalidation**: a removed or changed neighbor re-examines the rest of its group (bounded,
  memoized, never a document scan); stale cues after a removal / state switch were a real gap and
  are covered by regression tests and a real-Chromium run (100 flips / insertions / reorders /
  removals: batched, zero full rescans, no duplicate and no stale cue).
- **Accessibility tree**: Chromium's full tree (`Accessibility.getFullAXTree`) and raw accessible
  names, descriptions and states of button, link, tab, checkbox, radio, number input, labelled
  text box, status, alert and dot are identical with and without cues; keyboard order, clicks,
  typing, selection, validation UI, submit and `reset` are identical. **No screen reader was run.**
- **Glyphs and fonts**: `✓` and `ℹ` are drawn as shapes (no font dependence), other glyphs live in
  Latin-1 / WGL4 in an explicit stack; verified with monospace, a missing font, serif, cursive and a
  symbol font. Dark mode, forced colors (emulation), CSS zoom 100-200 % and 9 px / 28 px text.
- **Verified placement**: a cue the browser cannot show (grid host, clipped or ellipsized label, a
  column too narrow for the glyph) is withheld, never claimed.
- **Settings**: default `true` re-validated against the adversarial set; migration (absent → true,
  explicit false kept, non-boolean → default) tested in unit, store and a real profile; ON/OFF x5.
- **Stability** (final tree): semantic suites x50 50/50, full unit suite x5 5/5 (1136 tests),
  `pnpm verify` x3 3/3, Chromium E2E x5 5/5 (290 passed, 1 intentional skip: the hidden-tab
  scheduler path, unchanged; 291 tests), no retries. Firefox: build PASS, runtime NOT_VERIFIED.
- Known at the time (environmental, not an M6 regression; **fixed in M7**, below): `r1-fixtures`
  "R1-5. infinite scroll" asserted that a 100-root batch fits the analyzer's 50 ms budget.
- Upstream M2 scientific status remains PARTIAL.

## M7 — Charts & Data Visualization ✅ (M7.R1 validation & freeze: PASS)

Details in `docs/CHARTS.md`.

- **R1-5 made deterministic first.** Root cause: `analyzeSubtrees` defers every root after the
  first once `now() - startedAt > maxDurationMs` (50 ms), so on a loaded machine a 100-root batch was
  split over two passes and the exact per-pass counters of R1-5 failed. Fix, without touching
  production semantics: the content script reads the build mode, and the E2E build
  (`pnpm build:e2e` = `wxt build --mode e2e`, output `dist/chrome-mv3-e2e`) runs the analyzer on a
  logical clock (`now: () => 0`), so which roots a pass handles depends only on the structural budgets
  (1500 elements, 512 roots). The shipped build (`pnpm build`) is unchanged and keeps the real clock.
  No sleep, retry, larger timeout or looser range. R1-5 x100: **100/100**.
- A DOM-free chart core: facts -> classification (HIGH/MEDIUM/LOW/UNKNOWN, blockers) -> series ->
  SVG legend mapping (key > token > color, else `ambiguous` and nothing is written) -> pairwise M2
  analysis (series against series) -> a deterministic `ChartAdaptationPlan` with identity-stable
  assignment (line style x marker, scatter shape, pattern) and honest `encoding-exhausted`.
- Browser layer: owned `<defs>`, legend sample overlays, attributes + one static CSS portion (scatter shapes are `clip-path` / hollow rings on the points), legend synchronized,
  verified against the browser (a mismatch rolls the whole chart back), reversible, idempotent, no
  observer (M4 regions; self-mutations filtered; budget hand-back).
- Ownership: M5 asks `owns(svg)` before planning; an owned chart is `chart-owned` and gets no color
  rule. Heatmap, area, stacked bars, HTML legends, gradients (sequential/diverging), filters/masks/
  animations: detected, not adapted. Canvas: classified (`canvas-chart` / `canvas-unknown`), never
  touched, never patched.
- `adaptCharts` default **true** (HIGH-confidence only; 0 false-positive claims in the benchmark and
  the Chromium fixtures); migration tested (absent -> default, explicit values never overridden).
- Benchmark: 39 chart scenarios, 0 unresolved pairs after, 0 false-positive claims. Real Chromium:
  pixels, accessibility tree, hover/click/keyboard, dynamic series, CSS specificity, canvas, limits.
- Not in M7: AI chart understanding, OCR, image recoloring, general Canvas interception, Shadow DOM,
  iframes, HTML legend adaptation, data extraction, chart redesign. M2 stays PARTIAL.

### M7.R1 — Chart Validation & Freeze ✅ PASS

Legend correctness over chart coverage: a chart whose marks and legend cannot be kept in step is not
adapted.

- **HTML legend guard**: structural evidence (names, swatches, pseudo-elements, borders, glyphs, text
  colored like a series, toggles, `aria-controls`, relations) near the chart refuses it whole; 15 variants
  x above / below / beside in real Chromium; interactive HTML legends are never touched. A legend that
  comes, goes, is recolored or moves is a change in the chart's neighbourhood and re-reads it (M4 passes
  parents that lost a child, deleted or moved).
- **Atomic ownership**: partial or disagreeing legend mapping inside the SVG refuses the chart whole.
- **Resize / geometry bridge**: one `ResizeObserver` and one scoped `MutationObserver` (`d`/`points`) for
  the tracked charts only, signalling M4; hatches and markers keep their pixel size; marker density is
  re-checked; no leak across off / on, removal, `adaptCharts` off.
- **Ordered palettes**: diverging and ordered scales are refused like sequential ones. **False
  positives**: real Chromium found a network diagram, a calendar, an infographic and a timeline claimed
  once they carried a `chart` id; axis evidence tightened (axis-aligned lines, aligned labels outside the
  marks, two-dimensional scatter). 0 false-positive ownership in 23 curated traps (jsdom) and 16 in
  Chromium.
- **Benchmark**: 150 scenarios (143 charts + 7 canvases); 528 problematic pairs, 0 unresolved after,
  0 legend-sync failures. E2E 480 passed / 1 skipped / 0 failed (M7.R1 added 131).
- Investigated and left documented: dashed-line and clipped-point hit areas (no overlay that changes
  event targets).
- Frozen as `m7-charts`. Next: M8 — Image Adaptation (not started).

## M8 — Image Adaptation ✅ (frozen as `m8-image-adaptation` by M8.R1)

Details in `docs/IMAGE_ADAPTATION.md`. Principle: **a safe unchanged image beats a speculative
correction.**

- A dedicated pure core (`core/images`: bounded sampling, deterministic OKLab clusters, pairwise M2
  analysis, classification with confidence and evidence, a leave-it-alone policy, the monochrome-icon
  plan) and a browser layer (`features/images`: discovery, readability, an offscreen-canvas reader,
  a memory-only cache that owns and revokes every object URL, the controller).
- Recolored: only a functional **monochrome `<img>` icon** classified HIGH (small, one chromatic
  cluster, transparent, with functional context), over a known solid background, with a replaceable
  source. M3 `findAdaptation` + a cluster-aware OKLab remap (alpha copied byte for byte, neutrals
  untouched, no halo) + verification (same size and alpha, M2 distance strictly better).
- Never recolored: photographs, logos, screenshots, decorative images, status bitmaps (pixels stay,
  M6 owns the non-color cue: semantic cue > recolor), raster charts and diagrams (detected,
  untouched), multi-paint UI bitmaps, anything MEDIUM/LOW. Unsupported: `srcset`/`<picture>`,
  `<input type=image>`, CSS backgrounds (detect-only), SVG through `<img>`, animated images (by URL
  and by bytes), image maps, CSS filter/blend/mask/opacity, cross-origin without CORS (tainted canvas
  respected, nothing worked around).
- No own observer: M4 regions + one capture-phase `load`/`error` listener; `src` stays out of
  `OBSERVED_ATTRIBUTES`. Generations discard stale async results; one image, one adaptation; OFF restores
  the page's `src` exactly; refresh is idempotent (the original is always what is read).
- `adaptImages` default **false** (live in the Options page; explicit stored values never overridden,
  tested). Per-site `adaptImages` is consulted since M8.R1 (narrowing, see below).
- Benchmark: 119 scenarios, 72 curated false-positive cases, **0 transformations**; 19/19 supported
  icons adapted with better simulated distinguishability and identical geometry/alpha.
- Validation at M8: 1711 unit tests; image-focused tests x50 **50/50**; full suite x5 **5/5**; `pnpm
verify` x3 **3/3**; Chromium E2E **509 passed / 1 skipped / 0 failed**, x5 **5/5** (M7.R1: 480 / 1 / 0;
  M8 added 29). Firefox: build passes, runtime NOT_VERIFIED.
- Observed in Chromium: an extension's blob URL is not blocked by a strict page `img-src` (the
  rollback on a load error is therefore unit-tested only); the privacy test compares the hosts with the
  layer on and off because antivirus software injects its own requests into pages.
- Not in M8: OCR, AI image understanding, object/face recognition, photograph recoloring, backend or
  upload, canvas patching, video, animated-image rewriting, Shadow DOM, iframes. M2 stays PARTIAL.

### M8.R1 — Image Validation & Freeze ✅

- **Timeout investigation**: the M7 300-chart retention test takes ~12.4 s alone on both the frozen M7
  commit and M8 (same structural work); ~30 s only when every worker is busy. Contention, not a
  regression. The global `testTimeout` went back to 30 s; that one test has its own 90 s guard.
- **Per-site `adaptImages`** is now live: `effective = global AND site override`, no override = global
  (a site can narrow, never widen); tested for the four cases + no override, and in Chromium with two
  hostnames open together.
- **Brand protection**: `HIGH` needs positive functional evidence (a control-like name or, when
  unnamed, an `icon` class/path); button/link/non-empty alt are no longer evidence. Logo vocabulary,
  path tokens, container labels and index home links widened. Real icons named without a functional
  word are deliberate misses.
- **Benchmark**: 195 scenarios (was 119): 124 curated false-positive cases, **0 transformations**,
  photos/logos/brand traps transformed **0**, 36/36 supported icons adapted with better distinguishability
  and identical geometry/alpha, 3 documented conservative misses, 0 classification conflicts.
- **OS theme**: one `matchMedia` listener while active, bounded re-evaluation of background-dependent
  images; a page choice of `srcset`/`<picture>` over an adapted image releases our bitmap.
- **Real Chromium**: forced Blob load failure (page revokes our URL and reloads the image: rollback, no
  loop, 0 owners), strict CSP fixtures, A to B to C races with reversed answers, profile switch, theme
  switch with `emulateMedia`, redirects both ways, wrong CORS, malformed/oversized data URLs, brand and
  low-color-photo fixtures, 127/128/129 px and 15 % transparency boundaries.
- **Unit**: staged races (remove/OFF/profile change in flight), cache 31/32/33 and the pixel line,
  queue boundary 402/403/404 (400 queued + 3 reading), concurrency never above 3, 500 images x 3 cycles,
  ObjectURL invariant (`created - revoked == live`, 0 after OFF), listener lifecycle, attribute
  preservation.
- `adaptImages` stays **false** by default.
- Validation: 1748 unit tests; image-focused tests x50 **50/50**; full suite x5 **5/5**; the 300-chart test
  x20 isolated **20/20**; `pnpm verify` x3 **3/3**; Chromium E2E **526 passed / 1 skipped / 0 failed**, x5
  **5/5** (M8: 509 / 1 / 0; R1 added 17). Firefox: build passes, runtime NOT_VERIFIED. M2 stays PARTIAL.
- Next: M9 — Developer Audit (done: see M9 and M9.R1 below).

## M9 — Developer Audit ✅ (M9 + M9.R1 PASS; upstream M2 scientific status stays PARTIAL)

- `core/audit`: a pure, DOM-free pipeline — rule registry (stable ids `CA-COLOR-001/002/003`, `CA-GEN-001`,
  `CA-SEM-001/002`, `CA-SVG-001/002`, `CA-CHART-001..004`, `CA-IMG-001..003`), candidate → instance →
  dedupe → group → snapshot, one centralized severity model, separate finding confidence and M2
  scientific (model) confidence, evidence with an explicit basis, deterministic recommendations (M3
  suggestions labeled ColorAdapt-generated), no score, "related to" WCAG mapping only.
- `features/audit`: collector over read-only `auditScan` hooks of M6/M7/M8 and `auditSources()` of the
  content controller (everything read under `withOriginalStyles`, ColorAdapt-owned nodes ignored), element
  locator (structural identity, bounded redacted text, no form values), one-box highlighter, snapshot store
  with generations, controller with a debounced live session and SPA-aware re-audit.
- Audit page (`audit.html?tabId=N`, from the popup): summary, filters (severity, category, confidence,
  ColorAdapt status, kind, search), expandable cards, element highlight and next/previous, JSON and
  standalone HTML export (CSP, escaped, offline). Typed `AUDIT_*` messages and a `coloradapt-audit` port.
- Works with adaptation off (audit-only); source findings are the same with adaptation on or off.
- **M9.R1 — Developer Audit Validation & Freeze: PASS.** Validated, not extended; what it changed:
  - claims: a WCAG wording invariant over rule metadata, recommendations, UI source, JSON, HTML and the audit
    docs (only "related to", never conformance or non-conformance); no score; registry ↔ docs consistency
    (`AUDIT_RULES.md` summary table and per-rule sections); critical also needs "no non-color redundancy";
  - privacy and export: invisible/bidi/zero-width/line-separator characters and unpaired surrogates removed from
    page text (and refused by the parser); text read through a bounded window (no quadratic scan); strict
    parser (origin without credentials, path without `@`/query, locator bounds, `related-to` only); hostile
    markup and Unicode checked through a real export opened in Chromium (no script, dialog, request or
    navigation); nothing persisted in extension storage or the audit origin; no network beyond the page's;
  - coverage: `coverage.subsystems` (complete / partial / disabled / unsupported) in the snapshot, the audit
    page and both reports; M8 pixel analysis disclosed as disabled unless adaptation and image adaptation
    are on; truncation says "Audit truncated: coverage limited"; shadow DOM, frames, borders and focus rings
    stay explicitly unsupported; confirmed issues, manual reviews and limitations are counted apart;
  - identity: finding id = rule + component + region scope + context (so two landmarks with the same
    component are two findings), stable across refresh x20, open/close, adaptation on/off, reorder, same-tag
    insertion, node replacement and reparenting within a region; instance ids stay structural best effort
    (class- or text-based ids rejected: they change exactly when a problem is fixed); contract in
    `DEVELOPER_AUDIT.md`;
  - fixes found by the validation: a highlight on a hidden element drew a box in the page corner; a
    highlight stayed on an element that was no longer part of any finding; keyboard focus fell to `<body>`
    when the focused card disappeared; a route change without DOM changes left the report address stale (now
    updated from `tabs.onUpdated`, with export paused while pending; the History API is still never hooked);
  - benchmark: 342 scenarios (144 before), 193 expected = 193 actual confirmed findings, 32 manual reviews,
    2 analysis limitations, 0 false confirmed, 0 false negatives, 0 source differences with adaptation on
    (the color-vision pairs are regression-locked against the M2 simulation, not independently validated);
  - stability: audit-focused tests x50 **50/50**, privacy/export/id tests x100 **100/100**, full suite x5
    **5/5** (2489 tests), `pnpm verify` x3 **3/3**, Chromium E2E x5 **5/5** (582 passed / 1 skipped / 0
    failed). Firefox: build passes, runtime NOT_VERIFIED. The 90 s hang guard on one M4 benchmark is
    test-local: the same structural work and the same isolated time as at M8 (~11 s), so it never hid a regression.
- Known technical debt, carried to **M12 Production Hardening**: the per-site `adaptCharts` setting is stored
  but the chart runtime does not consult it (frozen M7 behavior; not changed in M9, not exposed in the audit UI).
  M2 stays PARTIAL and is propagated into every simulation-based finding.
- See `docs/DEVELOPER_AUDIT.md`.

## M10 — Real-World Validation ✅ (engineering PASS; product validation closed by M10.R1)

- A live-page harness (`realworld/`, `pnpm test:realworld`, not part of `pnpm verify`): 193 public pages, Chrome
  154 and Firefox 151, an independent contrast oracle, privacy and source-integrity checks, scenario suites.
- Tag `m10-real-world-validation`. See `docs/REAL_WORLD_VALIDATION.md`.

## M10.R1 — Real-World Findings Closeout ✅ (PASS; tag `m10-real-world-validation-closeout`)

- Classifies every discrepancy between the audit and the independent oracle (67 false positives, 392 misses
  in the M10 baseline), fixes the genuine ColorAdapt defects and the genuine harness/oracle defects, and
  quantifies what remains.
- Roadmap numbering is canonical from here: M10 real-world validation, M11 AI Semantic Engine, M12 Production
  Hardening, M13 Store Release, M14 Advanced Product. M0–M9 and the tag `m10-real-world-validation` are unchanged.
- Result: all 459 baseline disagreements classified (287 ColorAdapt defects, 114 oracle, 42 harness, 16 page state,
  0 ambiguous) and the defects fixed: text in any element (not a tag list) is now analyzed; the audit judges only
  painted text (about half of its findings were on text the browser does not paint); the dark canvas,
  `-webkit-text-fill-color`, `background-clip: text` and color-changing effects are modeled or listed as limits.
  Final comparison: 3290–3636 text elements below target per run, 3284–3629 agree, 5 + 3 raw disagreements in
  Chrome, 5 + 1 in Firefox, all explained. Gates: tests 2646, audit tests x50 50/50, discrepancy suite x50 50/50,
  full x5 5/5, verify x3 3/3, Chromium E2E x5 5/5 (582 passed / 1 skipped).
- Exception carried to M12: the Chrome SPA heap-growth budget (1.1021 against 1.1; the M10 build 1.0969).
- M2 stays PARTIAL.

## M11 — AI Semantic Engine ✅ (implemented; validated and frozen by M11.R1)

- An optional, local, advisory layer that suggests what a `manual-review` finding of the developer audit may mean
  (`CA-SEM-002`, `CA-SVG-002`, `CA-CHART-002/003/004`, `CA-IMG-002/003`), on request, in the audit page. Deterministic
  M1–M10 stays the source of truth: the model cannot override evidence, suppress, downgrade or create a finding,
  change a page or reach anything but the loopback. Off by default. See `docs/AI_SEMANTIC_ENGINE.md`,
  `docs/AI_PRIVACY.md`, `docs/AI_PROVIDER_PROTOCOL.md`.
- Pieces: closed taxonomy (6 tasks, fixed label sets), bounded and redacted packets (6144 bytes, no form values, no
  URLs), a strict answer schema, a deterministic validator (`ACCEPTED_ADVISORY` / `REJECTED` / `UNRESOLVED`; model
  confidence is only a floor), a loopback-only provider (`local-ollama`, `local-http`; no cloud, no fallback), a
  bounded engine (dedupe, 64 requests per run, 2 in flight, timeout, cancellation, stale answers dropped, memory-only
  cache), audit UI and a separate `semanticAssist` export section.
- Provider decision: loopback runtime (no weights or inference library in the package; +49.9 kB of code in the
  extension, +16.6 kB zipped). In-browser inference and browser-native AI APIs were rejected for M11 (package size,
  `wasm-unsafe-eval`, portability, testability).
- Not in M11: AI-authorized page changes (the layer is advisory), OCR or image bytes to a model, a cloud model, tool
  use, per-site AI settings, authentication, Firefox AI runtime verification (done in M11.R1), a `connect-src`
  restricted to loopback (an M12 candidate: M10 pins that the manifest declares no CSP).
- Evidence: 253 curated scenarios (English and Russian) with an adversarial sweep of 8637 claims, 0 incorrect
  accepted; 57 hostile strings in 4 places and 2 fact sets (456 packets); a frozen real-world sample of 159 packets
  from 68 pages of the M10 corpus (26 ground-truthed, 1074 adversarial claims, 0 incorrect accepted); two real local
  models (llama3.2:3b, qwen2.5:7b-instruct) through the real transport, with 0 incorrect accepted.
- M2 stays PARTIAL; AI cannot change scientific evidence. The SPA heap-growth exception carried to M12 is not worse
  (1.1015 against 1.1; 1.1021 at M10.R1).

## M11.R1 — AI Semantic Validation & Freeze ✅ (tag `m11-ai-semantic-engine`; M11.R1 is not a feature milestone)

- Invariant: AI may fail, abstain or stay unresolved; it must not become confidently wrong in a way ColorAdapt
  accepts. AI stays advisory, off by default, loopback-only, with no cloud fallback and **0 AI-authorized page
  transformations**. M11 is AI-assisted review of existing `manual-review` findings; it does not analyze every `unknown`
  element (documented, not broadened).
- Defects found and fixed: (1) a finding groups elements by rule, component and context, so one icon's answer
  (Close) could label the others (Delete, Search): the first four elements are now compared by evidence signature, a
  group that differs is left to a human, and an accepted answer says "representative element" (`instances`,
  `sampled`; live sample: 24 of 243 findings left manual review); (2) an open audit page did not follow the AI setting,
  so turning it off elsewhere did not stop a running review: it now follows storage live; (3) class, `data-*` and id
  (and text and name) counted as independent evidence, unlike M6: they are now one group each, and two firm
  conflicting readings are `UNRESOLVED`; (4) the cache key lacked the instruction version; (5) queued requests for
  vanished elements were still sent: they are skipped.
- Validation: 424 synthetic scenarios (146 511 adversarial claims, 0 incorrect accepted); 109 hostile strings x 5
  places (0 unsafe accepted); 114 ground-truthed real-world packets (0 incorrect accepted; 45 more reported as
  unresolved, not ground truth); ~70 endpoint spellings and 4000 random hosts refused, 35 redirect variants not
  followed, 64 KiB / 1024-character boundaries exact; canary privacy tests (typed values, PII, invisible characters)
  over packets, request bodies, cache and exports; static gates for network, execution and DOM-write sinks and
  authority wording; inert HTML export; deterministic report byte-identical without the AI section.
- Models: `qwen2.5:7b-instruct` and `llama3.2:3b` through Ollama 0.31, 428 synthetic cases and 159 real packets
  each: **0 incorrect accepted**, both `QUALIFIED_FOR_ADVISORY` for that sample (qwen 215 + 11 accepted; llama 64 + 6,
  with 65 model errors that cite ids not in the packet: capability, the parser was not loosened). Other models:
  `NOT_TESTED`. `pnpm qualify:ai` writes a machine-readable result.
- Firefox AI runtime: **PASS** for the provider path (Firefox 151 and Chrome 154, `realworld/ai-provider.spec.ts`, packet
  identical in both). Live Ollama in Firefox was not run; full Firefox extension E2E parity is not claimed.
- SPA heap (M12 debt): 1.1015 against 1.1, not worse than M11 (1.1014–1.1015) or M10.R1 (1.1021); budget unchanged.
  Package +54.5 kB unpacked / +18.0 kB zipped over M10.R1.
- Carried to M12: SPA heap budget; extension `connect-src` pinned to loopback (the restriction is code-enforced and
  statically gated, not CSP-enforced); per-site `adaptCharts` runtime debt; Firefox full E2E parity; an in-flight AI
  request is not aborted when only its element leaves the page (queued ones are skipped; the wasted ones are bounded
  by the concurrency of 2); ground truth is small and written by one person.
- M2 stays PARTIAL; AI cannot change scientific evidence.

## M12 — Production Hardening ✅ (M12.R1 PASS / FROZEN; tag `m12-production-hardening`)

- Turns the frozen feature set into a production-hardened extension without adding a feature, a permission or an
  algorithm. Protocol (frozen before any formal run): `docs/m12/protocol.md`; result: `docs/m12/report.md`.
- Product changes: an orphaned content script gives its page back (Chrome); a failing message handler still answers and
  messages must come from the extension; settings writes are validated; hostname keys are own properties only (a host
  named `__proto__` or `constructor` is no longer special); popup and options fail visibly instead of loading forever;
  error boundaries; the audit page rejects a `tabId` that cannot name a tab; dark-mode link contrast; an extension-page
  CSP that keeps scripts `'self'` and the network on the loopback; local diagnostics that carry codes, not content.
- New gates: `pnpm audit:dist` (in `pnpm verify`) freezes the permission surface and audits the built artifacts;
  `pnpm scan:secrets`; Knip diff; reproducible-build check. New suites: `realworld/m12/` (clean install, restart,
  extension reload, MV3 worker restart, navigation and tab lifecycle, storage corruption, upgrade and downgrade,
  messaging and forged messages, crash recovery, AI failure and stale results, UI accessibility in both color schemes,
  resource and 120-minute soak).
- **M12.R1 final result: PASS.** Candidate `669548fc…b48d`, one full formal sequence, no retry: `pnpm verify` 144 files /
  3410 tests, E2E 595 passed / 2 skipped, 120-minute soak and the relative idle-CPU control (0.15 pp against 1.0) pass,
  Knip new findings 0, secret scan 0, audit 0 vulnerabilities, byte-reproducible builds, P04 and P11 pass. The Firefox P04
  blocker was a storage-layer first-access refusal (Firefox file-lock error hidden behind "An unexpected error occurred"),
  closed by a bounded readiness precondition in the test harness; no product change. See `docs/m12/report.md`.
- First-freeze result, kept as history: both browsers' suites pass on the frozen candidate; E2E 595 passed / 2 skipped; `pnpm verify` 142 files, 3385
  tests; builds and archives byte-reproducible. **Not met:** P25, the soak's frozen idle-CPU budget (median 2.06 % against
  2.0 %; every growth, error and queue budget passed, and a control shows the browser alone idles at the same level) and
  P27, Knip (2 new findings: two release scripts not referenced from `package.json`). Decision for the owner in the report.
- Known limits carried on: the cost of a pass grows with the rules in the sheet (thousands of adaptable elements added at
  once: seconds, bounded; `docs/PERFORMANCE.md`), Firefox's orphaned stylesheet after an extension reload, downgrade is
  unsupported, the M10 SPA warm-up ratio (1.1014 against 1.1; the control shows warm-up, steady state is 18.6 bytes per
  route change), per-site `adaptCharts`.

## M12.5 — Burst Scalability Remediation ⬜ (must close before the M13 Store release candidate)

- Registered by M12.R1 from M12 measurements: ~1,000 adaptable elements added at once: longest task ~100 ms; ~10,000:
  longest task ~3.9 s, time to idle ~15 to 28 s (`docs/PERFORMANCE.md`). Cause: the cost of a pass grows with the rules
  already in the stylesheet. Remedy is an engine change (fewer rules than elements, or selectors the browser can index);
  it needs its own protocol and a regression run of M4, M10 and M12. Not an M12 acceptance criterion.

## M13 — Store Release ⬜

- Precondition: M12.5 closed.

- Store listings, the final Firefox add-on id (the current one is a placeholder), review submissions.

## M14 — Advanced Product ⬜

- Features beyond the validated core; scope to be decided after M13.

## Minimal working vertical slice (proves the architecture)

Implemented in this foundation:

1. User toggles "Protection" on in the Popup.
2. Content script (`features/page-analysis/content-controller.ts`) runs
   the DOM Analyzer over the page.
3. Each element whose background was confidently resolved to a solid
   color goes through contrast + simulated-vision distance checks
   (`core/conflicts`); gradient/image backgrounds are counted as
   unresolved instead of guessed.
4. Resolved elements are checked by the Adaptation Engine (`core/adaptation`),
   which may produce a reversible, minimal foreground color change, applied via
   one injected stylesheet.
5. Popup's "Analyse page" button reports the conflict count back from the
   content script via the typed messaging layer.
6. Toggling "Protection" off calls `DISABLE_ADAPTATION`, which removes the
   stylesheet and returns the page to its original state.
