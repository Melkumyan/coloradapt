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
with real profiling data as the analyzer grows (SVG, charts, images).

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
