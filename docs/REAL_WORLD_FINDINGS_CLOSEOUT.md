# Real-world findings closeout (M10.R1)

M10 compared ColorAdapt's developer audit with an independent contrast oracle on 193 live pages and left two
numbers open: **67 false positives and 392 misses** (459 disagreements), "not investigated". This document
classifies every one of them, lists what was a ColorAdapt defect and was fixed, what was a defect of the oracle or
the harness and was fixed, what remains and why, and re-runs the comparison on the fixed code. The harness, the
oracle and the baseline are described in `docs/REAL_WORLD_VALIDATION.md`.

Nothing here weakens a threshold, silences a finding or re-labels a miss as "unsupported" without evidence. A
disagreement is a ColorAdapt defect only when the trace of ColorAdapt's own decision shows its decision is the one
that is wrong.

## Roadmap numbering

From M10.R1 the roadmap is, in this order:

- **M10** Real-World Validation (**M10.R1** is its findings closeout)
- **M11** AI Semantic Engine
- **M12** Production Hardening
- **M13** Store Release
- **M14** Advanced Product

Only future-looking references were changed (`docs/ROADMAP.md`, `README.md`, `docs/PRODUCT.md`,
`docs/PRIVACY.md`, `docs/SEMANTIC_ACCESSIBILITY.md`, `docs/DEVELOPER_AUDIT.md`, `wxt.config.ts`, a label in
`realworld/features.spec.ts`). M0–M9, their tags and the tag `m10-real-world-validation` are untouched.
`tests/realworld/roadmap-numbering.test.ts` fails if a doc pairs a milestone name with another number.

## How a disagreement is judged

### The oracle (`realworld/lib/probe.ts`, `realworld/lib/color.ts`)

Page side (`oracleProbe`, plain reads of what the browser resolved) and Node side (all arithmetic):

- **Discovery**: every text node with a paintable character (not whitespace, not U+200B–200D / U+2060 / U+FEFF)
  under `<body>`, one row per parent element, skipping `script`, `style`, `noscript`, `template`; at most 3000 rows
  in document order (`truncated`). Shadow roots and iframes are not entered. Pseudo-elements have no text node, so
  they have no row.
- **Painted**: `checkVisibility({ checkOpacity, checkVisibilityCSS })` on the element, or on the nearest ancestor
  with a box for `display: contents`; the text node's own `Range` rectangles must be non-empty; a box of no size that
  clips, `clip: rect(0 0 0 0)` and `clip-path: inset(50%)` count as not painted. Reason recorded: `display`,
  `opacity`, `visibility`, `content-visibility`, `zero-size`. Off-screen text with a box is painted (`offscreen`);
  a point probe (`elementFromPoint`) records occlusion in the viewport (information, not a verdict).
- **Foreground**: the computed text fill (`-webkit-text-fill-color` when it differs from `color`).
- **Background**: from the element up to the root, each element's `opacity` and its background (image or gradient →
  unresolved; a color the browser reports as `rgb()`, `rgba()` or `color(srgb …)` is read in Node; any other format
  (`lab`, `oklch`, `display-p3`, …) is converted by the browser's own canvas, which makes the oracle independent of
  both implementations; an unreadable color is _unknown_, never transparent). A background is only skipped when the
  group below it already covers it completely (`coverage`), so an opaque child inside a faded ancestor still shows
  the ancestor's background through.
- **Compositing**: CSS groups. An element's group is its content over its own background, then faded by its
  `opacity`; the result is composed over the page canvas: white, or the browser's dark canvas (Chromium 18/18/18,
  Firefox 28/27/34, measured with pixels) when the _used_ `color-scheme` is dark (`dark`, or `light dark` for a
  visitor who prefers dark).
- **Unresolved, not guessed**: `background-clip: text` on the element or a covered ancestor, blend modes,
  `backdrop-filter`, color-changing `filter` functions (a blur or a drop shadow keeps colors).
- **Large text and thresholds**: computed `font-size` ≥ 24px, or ≥ 18.66px with computed weight ≥ 700; targets 4.5:1
  and 3:1; compared strictly (no tolerance beyond `0.001`, which is rounding, not a verdict).
- **Disabled, inert, SVG, shadow, sensitive** are flags on the row; SVG text and shadow content are out of the
  comparison, disabled text is scope.
- **Timing**: the probe and the in-page trace of ColorAdapt's decision run back to back in the same page state,
  after a bounded readiness wait (complete document, answering content script, 1.5 s unchanged; at most 25 s).
  A document that replaced itself while it was measured (`performance.timeOrigin` or address changed) is measured
  again once and, if it still moves, left out of the denominator.

### Independence

`realworld/lib/color.ts` and the probe import nothing from `src/`. The decision under test is read by a _separate_
path: `src/features/audit/trace.ts` replays the audit's own decision functions (`decideElement`, `isRendered`, the
large-text rule, the contrast comparison) in the page and names the stage that ends an element's path
(`NOT_A_CANDIDATE`, `NO_OWN_TEXT`, `SKIP_NOT_RENDERED`, `SKIP_DISABLED`, `PARTIAL_BACKGROUND`,
`UNRESOLVED_BACKGROUND`, `PASS_CONTRAST`, `REPORTED`, …). It is bundled by `realworld/tools/build-trace.mjs` and
injected by the harness only; nothing in `src/` imports it, so the production bundle does not contain it (checked
by `grep` of `dist/`), no verbose trace reaches the UI, and nothing is sent anywhere. Check of the trace itself:
every element the trace says is reported appears in the audit's own finding list, except where an animation moved
between the trace and the audit a moment later (`crossCheck` in `docs/validation/m10r1-runs.json`: 3, 3 and 2 elements per run are not
listed, each a fade-in or color transition that moved between the trace and the audit a moment later).

### Ground truth (Tier A)

`realworld/ground-truth.spec.ts` renders 21 fixtures (a huge bold "I" on a known background), reads the background
pixel and the glyph's solid core from a **screenshot**, and requires the oracle _and_ ColorAdapt's decision to be
within 4% of the ratio of those two pixels, in **Chrome and Firefox**: plain, rgba foreground and background, a
group at opacity .5, nested opacity, own opacity with a background, transparent ancestors, `color-mix`, `oklch`,
`display-p3`, `lab`, `display: contents`, `-webkit-text-fill-color`, a dark canvas, `light dark`, an `html`
background over a dark scheme, an opaque background over a gradient, an opaque background inside a faded ancestor
over a gradient (unresolved), a gradient (unresolved) and a color filter (unresolved). All pass in both browsers.
Tier B: the independent oracle agrees with an exact code fact. Tier C: depends on page state, not reproducible.

## The 459 baseline disagreements, classified

Frozen as `docs/validation/m10-discrepancies.json` (ids `RW-FP-0001…0067`, `RW-FN-0001…0392`, never renumbered;
sanitized origin and path, structural locator, tag, colors, oracle numbers, no page text). Classified by
replaying the same pages (`realworld/classify.spec.ts`, `realworld/lib/classify.ts`) into
`docs/validation/m10r1-classification.json`. Each record has one primary class, a reason code, an evidence tier
and the evidence line.

| Primary class                                                                      |     FP |      FN |   Total | What                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------- | -----: | ------: | ------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PRODUCT_BUG                                                                        |      6 |     281 | **287** | text discovery 281 (`time` 139, `div` 86, `abbr` 18, `code` 10, `b` 9, `var` 6, `kbd` 6, `blockquote` 3, `dd` 3, `i` 1); `background-clip: text` 5; text under a `display: none` ancestor 1 |
| ORACLE_BUG                                                                         |     12 |     102 | **114** | a computed color written as `color(srgb …)` (a `color-mix()` or relative color) was read as transparent, so the background became white                                                     |
| HARNESS_BUG                                                                        |     42 |       0 |  **42** | the judge's 0.06 tolerance called "4.478:1 against 4.5" a pass (`blog-joel` 18, `doc-nextjs` 14, …)                                                                                         |
| TIMING_STATE_DIFFERENCE                                                            |      7 |       9 |  **16** | colors that were in transition or changed state (`fin-yahoo`, `fin-tradingview`, `dash-observable`), elements the page replaced                                                             |
| SCOPE_DIFFERENCE, INTENTIONAL_EXCLUSION, UNSUPPORTED_RENDERING, BROWSER_DIFFERENCE |      0 |       0 |       0 |                                                                                                                                                                                             |
| AMBIGUOUS                                                                          |      0 |       0 |   **0** |                                                                                                                                                                                             |
| **Total**                                                                          | **67** | **392** | **459** | Tier A 432, B 18, C 9                                                                                                                                                                       |

Replay sources: Chrome final runs `g1`, `g2` (a page that moved is read from the run that still has the element;
`dash-observable`, whose structure changed between runs, from `f1`). The rules are in `classify.ts` and
unit-tested (`tests/realworld/compare-classify.test.ts`).

### False-positive root causes (67)

- **42 HARNESS_BUG / JUDGE_TOLERANCE** — ColorAdapt was right. Both sides computed a ratio below the target
  (4.478, 4.444, 4.468, 4.476, 4.448, 2.965, 2.9998 for large text) and `judge.ts` accepted anything within 0.06.
  Tolerance removed; strict comparison with a `0.001` rounding band (`realworld/lib/compare.ts`).
- **12 ORACLE_BUG / COLOR_FORMAT** — the corrected oracle now measures the same pair the audit printed
  (`dash-observable` `#22863a` on `#f9fafb` = 4.427:1 below 4.5; `saas-jsfiddle` `#ffffff` on `#e9a530` = 2.12:1);
  the baseline oracle had skipped an unreadable layer and answered 4.626 and 16.1.
- **7 TIMING_STATE_DIFFERENCE** — the audit measured a state (`#ffffff` on `#919598`) that is not the page's
  settled state (`#ffffff` on `#1967d2`): a transition or a loading state.
- **5 PRODUCT_BUG / `background-clip: text`** and **1 PRODUCT_BUG / ancestor `display: none`** — see below.

### False-negative root causes (392)

- **281 PRODUCT_BUG / TEXT_DISCOVERY** — the analyzer listed tags; text directly inside `<time>`, `<div>`,
  `<abbr>`, `<code>`, `<b>`, `<var>`, `<kbd>`, `<blockquote>`, `<dd>`, `<i>` was never looked at. Not a budget
  truncation, not a hidden element, not a threshold: the element was never **discovered** (`traceLegacy`:
  `NOT_A_CANDIDATE` for every one that is still in the replay, 272 of 281; the other 9 are gone from the replay and are in tags the old
  selector did not contain, Tier B). Measured, not assumed: of the pipeline stages `DISCOVERED → VISIBLE → RESOLVED →
EVALUATED → FAILED_THRESHOLD → EMITTED`, they stopped at the first.
- **102 ORACLE_BUG / COLOR_FORMAT** — 101 of them on one site (`saas-netlify-app`, dark code blocks): the baseline
  ratio of each is _exactly_ that text against a white canvas (`1.516` = `#89ddff` on white) while the browser
  paints it on `#060b10` (13.0:1). Verified in the page (`getComputedStyle` returns `color(srgb 0.0235 0.0431
0.0627)`) and by a pixel fixture (`color-mix-background`).
- **9 TIMING_STATE_DIFFERENCE** — the oracle's low value belongs to a state that no longer exists (price flashes,
  `fin-jpx`).

## Defects fixed

### ColorAdapt (product)

| Defect                                                                                                                                                        | Evidence                                                                     | Fix                                                                                                                                                                                                                                                                             | Regression coverage                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Text inside any element but a fixed tag list never analyzed (281 misses; in Firefox 204 rows inside an unknown `<d>` element on one page; custom elements)    | `traceLegacy.NOT_A_CANDIDATE`                                                | every element is a query result; a candidate is an element with paintable own text or a structural role; metadata, scripts, `option` never; wrappers are rejected before style and budget (`core/analysis/constants.ts`, `dom-analyzer.ts`, `roles.ts`, `text.ts`)              | `tests/features/audit/trace.test.ts`, `tests/core/analysis/*`, benchmark scenario `m6-brand-colors` now expects the real 3.40:1 finding |
| About **half of all reported contrast findings** were on text the browser does not paint (`display: none` subtrees, 2887 + 954 rows in the first full replay) | oracle `hidden:*` rows reported by the trace                                 | the audit asks `isRendered` (`features/audit/rendered.ts`): `checkVisibility`, `display: contents`, `font-size: 0`, 0×0 clipping box, `clip: rect(0 0 0 0)`, `clip-path: inset(50%)`, `<video>`/`<audio>`/`<canvas>` fallback content; adaptation still prepares hidden content | `tests/features/audit/real-world-regressions.test.ts`                                                                                   |
| Page canvas assumed white; a `color-scheme: dark` page was judged against white (219 misses on one site; `#6a7282` read as 4.8:1, really 3.9:1)               | pixel fixture `dark-canvas-transparent`: Chromium 18/18/18, Firefox 28/27/34 | `core/analysis/canvas.ts` (used scheme via `matchMedia`, one query object per window)                                                                                                                                                                                           | `tests/core/analysis/canvas.test.ts`, ground truth                                                                                      |
| `-webkit-text-fill-color` ignored                                                                                                                             | pixel fixture `text-fill-color`                                              | foreground is the computed fill                                                                                                                                                                                                                                                 | regressions test                                                                                                                        |
| `background-clip: text` read as a solid background (a legible link as a confirmed 1:1)                                                                        | `RW-FP-0034…0038`                                                            | an image-like layer for the element and what is inside it                                                                                                                                                                                                                       | regressions test                                                                                                                        |
| A color-changing `filter`, a blend mode or `backdrop-filter` reported as an exact ratio                                                                       | oracle refuses (`EFFECT_ON_STACK`, 39 rows)                                  | `partial` (a limit, CA-COLOR-003)                                                                                                                                                                                                                                               | regressions test                                                                                                                        |
| Zero-width characters counted as text                                                                                                                         | U+200B in icon buttons                                                       | `hasOwnText` needs a paintable character                                                                                                                                                                                                                                        | regressions test                                                                                                                        |
| Coverage note said "every element up to the budget was analyzed"                                                                                              | the above                                                                    | text corrected (`core/audit/coverage.ts`)                                                                                                                                                                                                                                       | —                                                                                                                                       |

Not changed: the adaptation's treatment of hidden content, thresholds (4.5:1 / 3:1, 0.1 OKLab), the CVD
simulation (M2 stays PARTIAL).

### Oracle and harness

Oracle: unreadable colors skipped as transparent (`color(srgb …)`), flat opacity model (text × opacity over an
unfaded background), `done` rule that ignored faded ancestors, `light dark` read as dark, a white canvas for
every dark page, text-clip checked on the element only, over-refusal on any `filter` (blur, drop shadow),
`display: contents` rows reported hidden, a clipped 0×0 box reported painted, measured at a different moment than
the product (trace and oracle now back to back), ratio rounded to 3 decimals, the judge's 0.06 tolerance.
Harness (regressions in `tests/realworld/harness-regressions.test.ts`): CSP parsing moved out of a page-side
template string (the `/\s+/` → `/s+/` bug) into `realworld/lib/csp.ts`, with a static guard that fails on any
template string that carries an escape its cooked value would eat; one normalized error model for both browsers
(`realworld/lib/errors.ts`; Firefox's stack has frames only, the message comes from `message`); stale-document
detection (`realworld/lib/document-identity.ts`).

## Policies decided

- **Large text**: computed px and weight only (`core/audit/text-size.ts`): `normal` 400, `bold` 700, a variable
  font's computed number; 500/600 are not bold; `18.66px` boundary; CSS px, so browser zoom and the device pixel
  ratio are not inputs and no screenshot is.
- **Foreground**: text fill, own alpha and every ancestor's opacity as nested groups (M1.R1 rules intact).
- **Background**: first opaque layer, translucent layers composed, the canvas of the used color scheme; gradients,
  images, text clipping, blend modes, color filters and backdrop filters are _never_ turned into a ratio.
- **Visibility**: painted text is judged; text that is off screen or below the fold is painted; not-painted text
  gets no finding.
- **Occlusion**: not part of the scope. A point probe records whether another element covers the middle of the
  text in the viewport; it is data for review, not a verdict (covered text is still text with a measurable
  contrast).
- **Disabled**: out of scope for CA-COLOR-001, in both the product and the comparison (`SCOPE_DIFFERENCE`).
- **Pseudo-elements** (`::before`, `::after`): not analyzed; there is no node to read and the oracle has no row
  either, so no miss was caused by it. Documented in `docs/CSS_ANALYSIS.md`.
- **SVG text**: judged by the SVG rules (M5), excluded from this comparison; the SVG paint model is unchanged.
- **`display: contents`**: painted in the parent's box; judged on its own text (tests).
- **Shadow DOM and iframes**: still outside the audit (`INTENTIONAL_EXCLUSION`); not implemented here.
- **Dynamic pages**: no global animation freeze; oracle and trace read the same moment; a state that changes
  within the window is a `TIMING_STATE_DIFFERENCE`.

## Tesla (Firefox), the two links whose contrast "dropped to 1"

Not a ColorAdapt or browser difference. The hero module holds two slides (three links each) stacked at the same
position; the visible slide's links are at `opacity: 1`, the other slide's at `opacity: 0` with `visibility:
hidden`, and a cross-fade animation (5 running animations, 10 state changes in 30 s, `opacity` passing
1 → 0.69 → … → 0) swaps them. The oracle gives `1:1` for an element at `opacity: 0` (text equals background), and
the extension's "before" and "after" probes were seconds apart. Classified `TIMING_STATE_DIFFERENCE / CAROUSEL`,
Tier A (observed deterministic cycle).

## Final runs (code frozen for the candidate)

All numbers from `docs/validation/m10r1-runs.json`. A page is _comparable_ when it loaded, the audit answered,
the oracle completed and the document did not replace itself. Pages that did not load (network, bot protection,
geography) are counted apart, not as audit failures: Chrome `g1` 8, `g2` 9, Firefox 7 (names in the file).

|                                       |       Chrome g1 |       Chrome g2 |      Firefox g1 |
| ------------------------------------- | --------------: | --------------: | --------------: |
| attempted / loaded / comparable pages | 193 / 185 / 184 | 193 / 184 / 183 | 193 / 186 / 186 |
| text rows in scope (HTML)             |          76 075 |          76 736 |          85 974 |
| painted rows                          |          43 154 |          43 432 |          48 280 |
| oracle: below target                  |           3 343 |           3 286 |           3 630 |
| ColorAdapt: reports                   |           3 347 |           3 290 |           3 636 |
| agree (both below)                    |           3 340 |           3 284 |           3 629 |
| raw false positives / false negatives |           5 / 3 |           4 / 2 |           5 / 1 |
| product-bug FP / FN                   |           1 / 0 |           0 / 0 |           2 / 0 |
| ambiguous                             |               2 |               1 |               1 |

(The M10 baseline's raw numbers were 67 / 392 against 4767 confirmed on 186 pages.) Residual rows, all of them:

- **Form-control text rectangle (ORACLE_BUG, 3 per run, same three elements)** — a `<textarea>` whose text the
  browser paints itself has no text-node rectangle: the oracle calls it unpainted, ColorAdapt reports its colors
  (`land-linear`, `dash-chartjs-samples`, `doc-wikipedia-he`).
- **Disabled (SCOPE_DIFFERENCE, 1)** — `a11y-apple`, a disabled control; out of scope by policy.
- **Precision boundary (PRECISION_BOUNDARY, 1)** — `blog-overreacted` `h2`: the same two colors `#f0649e` /
  `#ffffff` (a wide-gamut source), oracle 2.9908 (8-bit, as painted) and ColorAdapt 3.0039 (unrounded) on a 3:1
  target. Neither is wrong; the target falls between them. Recorded in `docs/AUDIT_RULES.md`.
- **Transition / animation (AMBIGUOUS, tier C, 1–2 per run)** — `fin-tradingview`, one element whose text color
  moves between `#06806b` and `#0f0f0f`; and, once in Chrome `g1`, `land-linear` at `opacity` 0 during a fade-in.
  Not reproducible deterministically, not a harmful behaviour (no finding is hidden or invented in a settled
  state); listed for M12.
- **Firefox only** — `a11y-apple` cart badge `0` (a collapsing badge, zero text rectangle in Firefox, one
  element, Tier C) and `fin-nasdaq` `<video>` fallback text (a ColorAdapt defect: fixed afterwards by the
  `<video>`/`<audio>`/`<canvas>` rule and re-checked on that page with the final build).

**No unexplained systematic cluster and no PRODUCT_BUG miss remains.** Raw FP/FN are not zero and are not
claimed to be.

### Run-to-run stability

Chrome `g1` and `g2` on the same code: 8 and 6 residual disagreements; the 6 of `g2` are all in `g1`; the 2 extra in
`g1` are animation states. Counts of rows differ by under 2% (the pages are live). The 7–9 pages that did not load
differ by one or two between runs (network).

### Chrome versus Firefox

Same 193 pages, same code. Painted rows 43 154 (Chrome) vs 48 280 (Firefox); the pages are live and the two
automations differ (for instance the default `prefers-color-scheme`, which is why the canvas fixture
`light-dark-scheme-follows-preference` has different pixels in the two browsers and the same verdict). The unknown
`<d>` element of `blog-danluu` exposed the tag-list defect in Firefox (204 rows with a near-white text color
there). No finding family is browser-specific except the Firefox-only rows above; per-browser outliers are in the
run file (`topSites`). `BROWSER_DIFFERENCE` count: 0.

### Firefox, what was and was not run

- Firefox 151 real-world validation: **performed** (full 193-page crawl on the final code, scenario suites,
  ground-truth pixel fixtures). Manifest: the Firefox-only `browser_specific_settings.gecko` keeps its id and
  `data_collection_permissions: none`; permissions and the Chrome manifest are unchanged.
- Firefox full extension E2E parity (the 582-test Chromium E2E suite): **not run** (`NOT_VERIFIED`).
- SPA lifecycle: Chrome — see below. Firefox — `NOT_MEASURABLE_WITH_CURRENT_HARNESS` for heap and listener
  counters (geckodriver); structural proxies **PASS**: ColorAdapt-owned DOM artifacts 4 → 4, owned `<style>` nodes
  1 → 1, page node count 14 → 14, tracked elements 4 → 4, rules 1 → 1, observer starts 1, over 500 route changes.

### Scenario suites on the candidate (Chrome and Firefox)

72 tests ran on the final build (`features`, `interaction`, `dynamic`, `runtime`, `security`, `spa`, `dist`): 70
passed, 1 skipped (as in M10), 1 failed: **Chrome SPA, 500 route changes, heap ratio 1.1021 against the pre-set
budget of 1.1** (heap after a forced GC 2.403 → 2.648 MB; the DOM-node and listener counters, the pipeline counters,
and everything in Firefox pass). Honest reading: the M10 build, run on the same machine and test, measures
2.384 → 2.615 MB = **1.0969**, a pass with a 0.3% margin. The heap keeps growing by about 0.2 MB per 1000 route
changes on **both** builds (500 → 1500 route changes: 2.615 → 2.826 MB for the M10 build, 2.648 → 2.884 MB for this
one; a slightly steeper slope, 0.236 against 0.211, inside the spread between my own repeated runs), so M10.R1
added no new leak; it is the same slow retention, with +16 KB at the start (a larger content script) and +15 KB of
growth. The budget was not raised, the test was not retried to a pass, and the one candidate I could name and
remove (a `matchMedia` object per analysis pass, now one per window) did not change the number. It stays failing and
is the first item of M12: find the ~0.2 KB per route change both builds retain. The 500 → 1500 measurement is now
recorded by the spec (`INFO`) so warm-up and leak can be told apart.

## Quality gates and stability (final code)

| Gate                                                                                                      | Result                                                                                  |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck`                                                        | PASS                                                                                    |
| `pnpm build` (Chrome), `pnpm build:firefox`                                                               | PASS                                                                                    |
| `pnpm test` (unit, jsdom)                                                                                 | 2646 passed / 0 failed (116 files; 2507 at M10)                                         |
| Discrepancy regression suite (`tests/realworld`, discovery, trace, regressions, analysis, large text) ×50 | **50 / 50**                                                                             |
| Audit-focused tests (`tests/features/audit`, `tests/core/audit`, the M9 benchmark) ×50                    | **50 / 50**                                                                             |
| Full `pnpm test` ×5                                                                                       | **5 / 5**                                                                               |
| `pnpm verify` ×3                                                                                          | **3 / 3**                                                                               |
| Chromium E2E (`pnpm test:e2e`) ×5                                                                         | **5 / 5**; reference run 582 passed / 1 skipped / 0 failed                              |
| Ground truth (22 pixel fixtures)                                                                          | PASS in Chrome and Firefox                                                              |
| M9 audit benchmark                                                                                        | 0 false confirmed, 0 deterministic misses; one scenario's expectation corrected (below) |

Two earlier campaign attempts found problems that were then fixed, not retried: the 30 s limit of the 2000-mark chart
benchmark failed twice under load (it takes 7 s alone; the limit is a hang guard and is now 90 s for that suite,
like the other benchmarks), and the first E2E run found three real regressions of my own change (the region's own
element, which must still be inspected after it lost its text; the inside of an SVG unit counted as candidates),
fixed in `dom-analyzer.ts`. The M9 benchmark scenario `m6-brand-colors` expected no CA-COLOR-001 for white text on
`#2ca02c`; that text is 3.40:1 (computed by hand from the WCAG formula, not from ColorAdapt), a real finding that was
invisible while `<div>` text was not analyzed: the expectation was corrected, the markup was not touched.

Privacy: nothing stored holds page text, form values, cookies or storage; the harness stores origin, path,
structural locators, tags, colors and numbers. No new permission; the extension adds no network access
(`tests/realworld/source-integrity.test.ts`, unchanged and green).

Performance: the production analysis path only gained cheap work (a child-node scan per wrapper before any style
read; three more property reads per ancestor, once per pass; `checkVisibility` per judged element in the audit).
The audit-time budget tests (`tests/features/audit/budgets.test.ts`) and the M4 dynamic benchmark are unchanged and
green; per-page audit times of the real-world runs are in the run files.

## Known limitations carried to M12

- The slow heap growth above (both builds).
- The ratio is computed from unrounded colors while evidence prints hex (wide-gamut precision boundary).
- Text of form controls, pseudo-element text, Shadow DOM, iframes: not audited (documented).
- `a11y-apple` / `fin-tradingview` style single-element animation states cannot be separated from a settled state
  by a single probe; a two-sample probe would remove them.
- The per-site `adaptCharts` debt of M9 is unchanged.
- M2 scientific status: **PARTIAL** (unchanged; contrast closeout does not touch the Machado question).

## Final status

**M10.R1: PASS** with one recorded exception. Every one of the 459 disagreements has one class and evidence (287
ColorAdapt defects, all fixed and covered; 114 oracle defects; 42 harness defects; 16 page-state differences; 0
ambiguous); the oracle is documented, independent and checked against browser pixels in both browsers; the repeated
comparison leaves 5 raw false positives and 3 raw false negatives in Chrome (4 and 2 on the repeat) and 5 and 1 in
Firefox out of about 3300–3600 decided elements per run, every one explained above; the stability gates are met.
The exception is the SPA heap budget of the Chrome scenario suite (1.1021 against 1.1, the M10 build 1.0969),
explained above and carried to M12, not hidden. M2 scientific status: **PARTIAL**, unchanged. Firefox full extension
E2E parity: `NOT_VERIFIED`.

## Reproducing

```sh
node realworld/tools/freeze-discrepancies.mjs         # only once; refuses to overwrite the frozen corpus
pnpm build && pnpm build:firefox
RW_BROWSER=chrome  RW_OUT=chrome-g1  pnpm test:realworld corpus-run     # ~55 min
RW_BROWSER=firefox RW_OUT=firefox-g1 pnpm test:realworld corpus-run     # ~60 min
RW_JUDGE_DIR=chrome-g1 pnpm test:realworld compare.spec                 # row-level comparison
RW_JUDGE_DIR=chrome-g1,chrome-g2 pnpm test:realworld classify.spec      # the frozen 459
node realworld/tools/summarize-runs.mjs chrome-g1 chrome-g2 firefox-g1
pnpm test:realworld ground-truth                                        # pixels, both browsers
RW_BROWSER=firefox RW_INSPECT=land-tesla RW_INSPECT_JS=script.js pnpm test:realworld inspect.spec
```

Use `compare.spec` (not `compare`, which also matches the 2-minute `compare-builds.spec`). Nothing stored holds
page text, form values, cookies, storage or HTML: origin, path, structural locators, tags, colors and numbers.
