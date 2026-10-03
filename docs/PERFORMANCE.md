# Performance

## Principles

- Never walk the entire DOM. The DOM Analyzer only queries a narrow,
  explicit CSS selector (`core/analysis/constants.ts#ANALYZER_SELECTOR`) of
  tags/roles/classes likely to carry meaningful color information.
- Never run a full analysis pass on every mutation. Dynamic re-analysis
  (M4, not yet wired up) is designed to go through a debounce, not a
  per-mutation handler.
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

| Budget               | Default | Rationale                                                                                                   |
| -------------------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `maxElements`        | 1500    | Upper bound on elements inspected in one pass; large enough for most real pages, small enough to stay fast. |
| `maxDurationMs`      | 50 ms   | A single analysis pass should not visibly block the page.                                                   |
| `mutationDebounceMs` | 500 ms  | Planned (M4): minimum gap between `MutationObserver`-triggered re-analyses.                                 |

These are tuning knobs, not hard architectural constraints — revisit them
with real profiling data as the analyzer grows (SVG, charts, images).

## Incremental analysis (planned, M4)

The `ELEMENT_ID_ATTRIBUTE` (`data-coloradapt-id`) that the analyzer already
assigns is the hook for future incremental analysis: a re-analysis pass can
skip elements that already carry this attribute and haven't changed,
instead of reprocessing the whole page.

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
