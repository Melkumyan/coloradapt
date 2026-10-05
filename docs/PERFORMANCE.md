# Performance

## Principles

- Never walk the entire DOM. The DOM Analyzer only queries a narrow,
  explicit CSS selector (`core/analysis/constants.ts#ANALYZER_SELECTOR`) of
  tags/roles/classes likely to carry meaningful color information.
- Never run a full analysis pass on every mutation. Dynamic re-analysis (M4)
  batches mutations per frame, re-analyzes only the affected regions, and treats
  a full rescan as a counted fallback (`docs/DYNAMIC_ANALYSIS.md`).
- Hard budgets, not best-effort: every analysis pass is bounded by both an
  element count and a wall-clock duration, and stops early (reporting
  `truncated: true`) rather than running unbounded.
- Skip invisible elements cheaply (computed `display`/`visibility`/
  `opacity` only — no layout-forcing reads like `getBoundingClientRect` in
  the hot path).
- Adaptation is applied via a single injected stylesheet, not per-element
  inline style writes, which keeps DOM mutation cost constant regardless of
  how many elements are adapted.
- The Adaptation Engine is bounded structurally, not by wall clock: early exit
  (no search) for pairs that are already distinguishable, at most
  `maxCandidateEvaluations` (800) candidate evaluations per _distinct_ color
  pair (a plan memoizes by foreground/background, so shared pairs cost once),
  and progressive stages that stop at the first feasible one — typically
  20–70 evaluations. Each evaluation is a handful of color conversions. The
  analysis pass additionally reads each resolved element's computed `color`
  once more (to refuse opacity/alpha cases) and runs with the adaptation
  stylesheet suspended.
- Background resolution (`core/analysis/background-resolution.ts`) memoizes
  per-element ancestor state for the duration of one analysis pass, in a
  `Map<Element, ChainState>` created fresh by `analyzeDocument`. Resolving
  N elements that share common ancestors (nearly always true — think rows
  in a table, or items in a list) costs roughly one `getComputedStyle` per
  _unique_ element in the combined ancestor chains, not N times the
  average ancestor depth. (The opacity-group composite is an inside-out
  arithmetic fold over those already-parsed layers: O(depth) per element,
  no extra style reads.)
- Ancestor traversal is capped at a fixed depth (`MAX_ANCESTOR_DEPTH`, 200) so a pathologically deep DOM can't make a single element's
  resolution unbounded; beyond that depth resolution reports `partial`
  rather than continuing to walk.

## Current budget

Defined in `src/shared/constants/performance.ts`:

| Budget          | Default | Rationale                                                                                                   |
| --------------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `maxElements`   | 1500    | Upper bound on elements inspected in one pass; large enough for most real pages, small enough to stay fast. |
| `maxDurationMs` | 50 ms   | A single analysis pass should not visibly block the page.                                                   |

These are tuning knobs, not hard architectural constraints — revisit them
with real profiling data as the analyzer grows (charts, images; SVG has its own table above).

## Dynamic pipeline budgets (M4)

Defined in `DYNAMIC_BUDGET` (`src/shared/constants/performance.ts`). All are
structural; none changes what is computed, only how it is batched or escalated:

| Budget                          | Default | Meaning                                                                                                   |
| ------------------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `maxQueuedRecords`              | 5000    | Queued mutation records; more than this and the queue is coalesced into one full rescan (5001 = overflow) |
| `maxAffectedRoots`              | 512     | Distinct regions per batch; more than this and the batch becomes one full rescan (513 = rescan)           |
| `fullRescanMinIntervalMs`       | 500 ms  | Spacing between mutation-driven full rescans. Throttle only: a rescan is postponed, never dropped         |
| `stylesheetRepairMinIntervalMs` | 500 ms  | Spacing between repairs of our `<style>` the page deleted. Throttle only: postponed, never dropped        |
| `maxPassesPerFlush`             | 64      | Safety bound for a forced flush                                                                           |

(`ANALYSIS_BUDGET.mutationDebounceMs` from M0 was removed: nothing is debounced by time;
batching is per animation frame.)

The incremental-analysis hook anticipated here turned out to be different from
"skip tagged elements": ids are only identity; what bounds the work is _which
regions_ are analyzed. `analyzeSubtrees` takes explicit roots. The element budget
(`maxElements`, 1500) is structural: a root that does not fit next to the others is left
whole for the next pass, and only a single root above 1500 is cut. The 50 ms
`maxDurationMs` only decides whether a _further_ root is started in a pass; it never cuts a
root short (M4.R1: it used to, which made the result depend on how long the first forced
style recalculation took). The M3 full analysis keeps its original 50 ms/1500 budget. Model,
counters and benchmark: `docs/DYNAMIC_ANALYSIS.md` ("Performance model").

The benchmark (`tests/benchmarks/dynamic-benchmark.test.ts`, report in
`benchmark-report/dynamic-benchmark.json`) asserts counters only: 500 synchronous
inserts = 1 pass; 1000 inserts = 1 full rescan; 1 insert into a 1000-row page = 1 element
analyzed. Wall-clock is recorded for information and never asserted.

### Repair cadence is not a performance claim about time

`stylesheetRepairMinIntervalMs` only bounds how _often_ the page-deleted `<style>` is put back.
The tests do not assert wall-clock outcomes of it: they assert the structural equation
`batches = real-work batches + stylesheetRepairsDeferred` and that deferrals never exceed
repairs (`docs/DYNAMIC_ANALYSIS.md`, "Determinism of the repair cadence").

## Inline SVG budgets (M5)

Defined in `SVG_BUDGET` (`src/shared/constants/svg.ts`). They are structural engineering
thresholds, never wall-clock values, and exceeding one makes the SVG `complex-svg`
(unsupported) instead of half-analyzed:

| Budget                  | Default | Meaning                                                             |
| ----------------------- | ------- | ------------------------------------------------------------------- |
| `maxDescendants`        | 200     | elements visited in one outermost `<svg>` (and its `<use>` content) |
| `maxPaintedElements`    | 24      | painted shapes + text + `<use>` instances in one `<svg>`            |
| `maxUseContentElements` | 24      | painted elements in one `<use>` target                              |
| `maxDistinctPaints`     | 4       | more distinct paints than this: `complex-svg`                       |
| `maxDepth`              | 32      | nesting followed                                                    |

Boundaries are asserted in real Chromium at limit - 1 / limit / limit + 1 (`e2e/svg-validation.spec.ts`):
24 painted elements adapt and 25 do not; an `<svg>` with 200 elements in total (itself included)
adapts and 201 do not; a path nested in 31 `<g>` adapts and in 32 does not; a `<use>` target with 24
painted shapes adapts and 25 do not; 4 distinct paints are multi-paint and 5 are complex. All of it
is structural and deterministic.

Structural metrics of the 500-icon scenario (informational; recorded in Chromium, wall-clock is never
asserted): appending 500 `currentColor` icons is **1 incremental pass**, 0 rescans, 1000 elements
processed (wrapper + `<svg>` each), 500 rules added, `svgAnalyzed = svgAdapted = 500`; 100 following
replacements are 100 passes, 0 rescans, 100 rules added and 100 removed, 200 elements processed in
total, and the settled state is again 500 rules, 500 tracked elements, 0 unsupported. Five cycles of
create 500 / adapt / remove leave 0 rules, 0 SVG units, the baseline tracked count and an idle,
empty queue.

An `<svg>` is **one element** of the analysis (it counts once against `maxElements`); what
is inside it is bounded by the table, so the worst case of a pass is
`maxElements x maxDescendants` style reads, and a typical icon (a few elements) costs a few
reads. The `<use>` walk shares the same visit budget.

The style probe is the one extra cost of SVG analysis: **one** stylesheet write and style flush in,
one out, for the whole batch of SVGs of a pass (not per icon), and none at all when no SVG in the
pass can use it (hidden, already unsupported, nothing painted). A second, color-only probe of the
same shape runs only when some paint inherited `fill`/`stroke` (to tell `<svg stroke="currentColor">`
from a literal color). So a pass over 500 icons performs at most two probes. Verification of an
applied unit re-walks that unit (bounded by the same table); it runs only for rules that are new or
re-submitted.

Measured structurally, never by time: `e2e/svg-dynamic.spec.ts` appends 500 icons in one batch
(0 full rescans, 500 rules) and then performs 100 replacements (each bounded to one icon,
`elementsProcessed <= 3`, 0 full rescans, 500 rules and 500 tracked units afterwards, no stale or
duplicate rule). No millisecond threshold is asserted.

## Semantic cue budgets (M6)

Defined in `SEMANTIC_LIMITS` (`src/features/semantics/cue-controller.ts`). Structural, never
wall-clock; the semantic layer has no observer and no scan of its own, it reuses the regions M4
resolved (`docs/SEMANTIC_ACCESSIBILITY.md`).

| Budget                 | Default | Meaning                                                   |
| ---------------------- | ------- | --------------------------------------------------------- |
| `maxWalkedPerRoot`     | 5000    | elements walked per subtree root                          |
| `maxCandidatesPerPass` | 1500    | elements examined (computed styles read) per pass         |
| `maxPeers`             | 24      | comparable elements looked at per candidate               |
| `maxContrastingPeers`  | 4       | differently-stated peers whose styles are compared        |
| `ancestorLevels`       | 3       | ancestors of a changed node that may be the semantic unit |
| `peerLevels`           | 4       | how far up comparable elements are searched               |
| `expansionPeers`       | 100     | members of one peer group re-examined when one changes    |
| `maxPeerSearches`      | 300     | peer groups searched per pass (one per changed element)   |
| `maxPeerExtras`        | 400     | peers added to a pass on top of the candidates M4 named   |
| `maxPeerScan`          | 6000    | elements looked at in total by one pass's peer searches   |
| `peerSourcesPerRoot`   | 24      | plain elements of an added region that name their group   |

Cost model: a cheap attribute pre-filter (ARIA, role, state `data-*`, a class-name substring test,
form fields, labels) decides which elements are examined; only those pay for a computed-style read.
Each element is examined once per pass (peers are cached within it). A cue is one attribute write;
the stylesheet is rewritten only when the _set of cue kinds_ changes, so 100 status rows flipping
state in one batch cost one batch, one incremental pass, one stylesheet write, no full rescan.
Native form events (`input`, `change`, `focusout`, `invalid`, `reset`) are coalesced by the
batcher: a burst of keystrokes is one pass.

M6.R1 (peer invalidation) adds structural counters, not timings: `semanticPeerSearches`,
`semanticPeersReexamined`, `elementsProcessed`, `incrementalPasses`, `batches`, `fullRescans`. The
real-Chromium stress asserts, for 100 simultaneous state flips, 100 insertions, 100 reorders and 100
removals of status dots: one batch and one incremental pass for each of flips / insertions /
removals, **zero** full rescans, every cue present exactly once and none stale. 500 components
created, cued and removed five times leave no cue attribute, no queued or deferred work and no
cue rule behind. Wall time stays informational. In jsdom the numbers mean nothing for time (see below); the E2E suite
asserts the counters.

## Chart bridge and legend guard (M7.R1)

Structural, never wall-clock. The resize / geometry bridge is one `ResizeObserver` and one
`MutationObserver` for at most `maxWatched` (128) charts, nothing else; a `d`/`points` change that keeps the
path's structure costs the structure comparison of that one attribute and no pass; a size change costs one
M4 pass over one chart (`chartPassesSkipped` when nothing in the scale changed). The HTML legend guard runs
only for an SVG that could be adapted (at least two distinct colored paints, something laid out), reads at
most `maxLegendScan` (300) elements per scope (the parent and the grandparent, or the siblings of a chart
directly in `<body>`) and is part of the chart's one read per pass. The benchmark of 150 scenarios reads
7657 marks, evaluates 511 series and 389 legend items in 184 chart passes.

## Chart budgets (M7)

Defined in `CHART_LIMITS` (`src/shared/constants/charts.ts`; full table in `docs/CHARTS.md`).
Structural, never wall-clock; the chart layer has no observer and no scan of its own: it reuses the
regions M4 resolved and hands back what its budget could not cover.

| Budget               | Default | Why this number                                                                                                                 |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `maxMarks`           | 2000    | a chart with more marks is a scatter of data, not a chart a legend can describe; each costs one computed-style read and one box |
| `maxDescendants`     | 6000    | bounds the walk (defs, groups, ticks) of one `<svg>`                                                                            |
| `maxSeries`          | 12      | beyond ~10 categorical encodings no set of dash/marker/pattern stays distinguishable (also the pattern budget)                  |
| `maxLegendItems`     | 12      | a larger swatch + text cluster is data labels                                                                                   |
| `maxMarkerVertices`  | 60      | `marker-mid` draws one marker per vertex: above it the line gets dashes only                                                    |
| `maxMarkerInstances` | 500     | per chart: `vertices x paths` of the lines that wear a marker                                                                   |
| `maxOverlayNodes`    | 500     | the only DOM nodes M7 inserts besides one `<defs>`: legend sample lines (scatter shapes are CSS)                                |
| `maxMarksPerPass`    | 20 000  | summed over regions; later regions return to M4 whole, the first is always finished                                             |

Cost model: an `<svg>` with fewer than 3 shapes is never read (icons, logos pay one selector). A
chart is read once per pass with the page's own styles in effect (one suspended-sheet flush, shared
with M3/M5), classified and planned in pure code, and written only when something changed: the plan,
the targets and everything M7 wrote are compared, so a settled chart costs a read and no write
(`chartPassesSkipped`). One chart's write is one `<defs>` insert, one attribute per adapted mark and
one CSS commit; verification reads the first mark of each adapted series. Real-Chromium evidence is
structural: 10 series x 100 points reads under 200 marks and is stable over refreshes; 100 charts
created, adapted and removed leave no owner, def, rule or pending work; 30 charts on one page are
adapted in two flushes; a 2200-point scatter is refused after a bounded read.

## What to measure before optimizing further

- Time spent in `analyzeDocument` on a real, large page (e.g. a dense
  table or social feed).
- Number of `getComputedStyle` calls per pass (the single most expensive
  operation the analyzer performs) — and the ancestor-cache hit rate
  specifically, since that's the lever most likely to matter as
  `backgroundKind`/gradient/border analysis adds more calls per element.
- Stylesheet rule count vs. render/reflow cost when many elements are
  adapted at once.

Tests that touch the analyzer inject `now: () => 0` (M2.R1): the real
50 ms budget in jsdom made results machine-speed dependent. The budget
itself is tested with an injected clock.

## Adaptation search and application (M3)

- **Structural bounds, not clocks.** The optimizer is bounded by
  `maxCandidateEvaluations` (800 per color pair; stage grids are ≤ 93 / 306 / 374
  candidates), and results are memoized per distinct foreground/background pair
  per page. No wall-clock gate exists or is wanted.
- Benchmark (49 pairs × 3 dichromat profiles, strength 1): per searched pair the
  candidate evaluations were median 58, p95 84, max 86; 86 of 147 rows needed no
  search at all (already distinguishable).
- Applying costs two forced style flushes (one with transitions suppressed) plus
  one `getComputedStyle` read per change to verify it — the read-back is what
  makes "adapted" mean "the browser shows it".
- Informational only: on the demo page in headless Chromium the enable round trip
  (analysis + planning + apply + verify) was ~20 ms on the development machine.
  Machine-specific; do not turn it into a threshold.

## A note on jsdom vs. real browsers

`tests/smoke/demo-fixture.test.ts` and `tests/core/analysis/performance.test.ts`
measure against the _configured budget_, never wall-clock time directly,
because jsdom's `getComputedStyle` is measurably slower (tens of
milliseconds, vs. a real browser's sub-millisecond) than any real
browser's — a budget tuned for production would truncate almost
immediately under jsdom for reasons that have nothing to do with the
analyzer's own cost. Don't use jsdom timing to tune `ANALYSIS_BUDGET`;
profile in an actual browser instead.

## Images (M8)

Structural bounds, no wall-clock gates (`docs/IMAGE_ADAPTATION.md`, "Sampling and thresholds"):

- an analysis surface of at most 262 144 pixels and 512 px per side, however large the image
  (a 12-megapixel photo is analyzed on a ≤ 512×512 surface); images over 64 megapixels are not
  decoded at all; a transformed bitmap never exceeds 1 000 000 pixels and only ≤ 128 px icons are
  transformed;
- at most 3 concurrent reads, 400 queued images (the rest `queue-full`), 500 images taken per
  region, 5000 elements scanned per region for CSS backgrounds;
- one analysis per distinct source (shared by every image that shows it, 256 kept), one generated
  bitmap per source + context + profile (32 entries / 2 000 000 pixels), pixel buffers released as
  soon as statistics or a bitmap are made (no `ImageData` is retained);
- representative page (`tests/features/images/stress.test.ts`): 100 small icons over 10 sources, 20
  medium images and 1 large photo cause at most 10 transform reads and 21 analysis reads, 10
  bitmaps, every read within the surface budget; 100 images replaced, removed and put back end with
  0 owned URLs, 0 pending reads, 0 queued images.
- With `adaptImages` off the layer costs nothing: no listener, no scan, no read.
- M8.R1 limits, exact: one pass takes 403 images (400 queued + 3 reading) and marks the next
  `queue-full`; at most 500 images are tracked per pass; reads never exceed 3 at once (instrumented,
  also under 60-image and 500-image stress); the cache holds 32 entries / 2 000 000 pixels with LRU
  eviction (31/32/33 entries and the pixel line are tested; a shown bitmap evicted from the lookup
  keeps its URL until its last image lets go); `created - revoked` equals the live owned URLs at
  every settled point, and equals 0 after OFF. 500 images x 3 cycles end with 0 owners, URLs, cache
  entries, reads and queue.
- The OS-theme listener costs one style read per background-dependent image on an actual scheme
  change, and nothing otherwise.
- **Test timeout**: the 300-chart retention test (`tests/features/charts/r1-dynamic.test.ts`) takes
  ~12.4 s alone on both M7 (`3a3e8d4`) and M8 (the same structural work), and ~30 s only when all
  workers are busy: contention, not a regression. The global Vitest `testTimeout` stays 30 s; only
  that test has its own 90 s hang guard.

## Developer audit (M9)

- **Closed audit = zero cost.** No observer, timer or work exists until an audit page asks. A pass runs on
  `AUDIT_RUN`; a live session (audit page open) adds one `MutationObserver` that ignores ColorAdapt's own
  mutations.
- **Live session spacing**: a pass starts 400 ms after the first mutation of a burst and at least 1200 ms
  after the previous one started (`AUDIT_WATCH`; the timer is not pushed back, the pass reads the page when it
  fires, so the last mutation is always in it); a burst is one pass. A route change reported by the browser
  (`tabs.onUpdated`, sanitized origin/path differ) schedules one pass 600 ms later from the audit page; a
  query/fragment-only change schedules none.
- **Budget boundaries are exact and deterministic** (`tests/core/audit/review-coverage.test.ts`,
  `tests/features/audit/budgets.test.ts`): 999 / 1000 / 1001 groups keep 999 / 1000 / 1000 and count 0 / 0 /
  1 as truncated; an affected count stays exact at 49 / 50 / 51 / 500 / 5000 while 50 are sampled; reaching
  a budget is stated in `coverage` ("Audit truncated: coverage limited"), never silent.
- **Recorded per pass, structurally** (no wall-clock threshold): `elementsAnalyzed`, instances, groups
  (`summary.findings`), `affectedElements`, `budgetsReached`, passes and live passes (`AUDIT_DIAGNOSTICS`).
- **Budgets (structural, no wall clock)**: `AUDIT_MAX_ELEMENTS` = 5000 elements per pass (the single `<body>`
  root is cut only by this count), 1500 semantic candidates, chart marks 20 000 per pass and 500 canvases,
  500 images. When one ends a pass, CA-GEN-001 says which. A pass reads each layer's facts once with the layers'
  own read code; it does not run adaptation.
- **Linear work**: element locators are memoized per pass (a path is built from its parent's, a sibling index is
  computed once per parent); dedup and grouping are single passes over the candidates; M3 plan outcomes are
  memoized per color pair.
- **Bounded output**: 50 affected elements kept per finding (the count is exact; a weak element registry holds
  the rest for highlighting), at most 1000 finding groups per snapshot (the rest counted in
  `coverage.truncatedFindings`), 200 findings drawn at a time in the audit page; exports are made from the
  snapshot already in the page.
- **Highlight**: one fixed box; position updates are batched to one per frame and run only while it is shown.
