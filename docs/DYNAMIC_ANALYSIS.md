# Dynamic sites and incremental analysis (M4)

M1-M3 analyze and adapt a page once. Modern sites (React, Next.js, Vue,
Angular, SPAs, dashboards, infinite scroll) keep rewriting their DOM after
load. M4 keeps the adaptation correct under those changes **without turning
`MutationObserver` into "rescan the page on every mutation"**.

```text
page load      -> full analysis -> adaptation                       (M3, unchanged)
DOM changes    -> MutationObserver
               -> own-mutation filter
               -> batcher (one flush per frame)
               -> classifier
               -> affected roots (de-duplicated, bounded)
               -> incremental analysis of those roots only
               -> stylesheet delta (upsert / remove)
```

Priorities, in order: incremental correctness > loop safety > bounded work >
coverage > raw speed. A full rescan exists, but only as an explicit,
observable fallback.

## Layout

| Module                                                    | Role                                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `core/analysis/dom-analyzer.ts` (`analyzeSubtrees`)       | Bounded analysis of given roots; stable element ids                          |
| `core/adaptation/adaptation-plan.ts` (`planElement`)      | Per-element planning, shared by the full plan and the delta path             |
| `core/adaptation/stylesheet-manager.ts` (`applyDelta`)    | Rule map; upsert / remove without duplicate rules                            |
| `features/page-analysis/incremental-adaptation.ts`        | Region-by-region re-adaptation and bookkeeping (knows no `MutationObserver`) |
| `features/dynamic-analysis/ownership.ts`                  | Self-mutation policy (`isColorAdaptOwnedMutation`)                           |
| `features/dynamic-analysis/mutation-classifier.ts`        | Explicit mutation kinds                                                      |
| `features/dynamic-analysis/affected-roots.ts`             | Root resolution, de-duplication, full-rescan escalation                      |
| `features/dynamic-analysis/mutation-batcher.ts`           | Bounded queue + `IDLE/SCHEDULED/RUNNING/DIRTY` state machine                 |
| `features/dynamic-analysis/mutation-observer.ts`          | The single observer, idempotent `start()/stop()`                             |
| `features/dynamic-analysis/incremental-controller.ts`     | The pipeline: `start / stop / refresh / dispose / flush / diagnostics`       |
| `features/dynamic-analysis/dynamic-content-controller.ts` | M3 `ContentController` + pipeline, used by `entrypoints/content.ts`          |

The M1-M3 core and the M3 `ContentController` do not depend on
`MutationObserver`; `createDynamicContentController` composes them with it.

## Observer lifecycle

- One `MutationObserver` per document (`DocumentMutationObserver`), connected
  by `start()` and disconnected by `stop()`. `start()` while connected is a
  no-op, so ON/OFF/ON cannot stack subscriptions (`observerStarts` counts real
  connections).
- Adaptation ON (`enableAdaptation` with effective `enabled: true`) starts it;
  OFF, or a site/global setting that disables the page, stops it. A disabled
  page therefore costs no observer at all, and mutations while OFF are not
  queued: turning ON again begins with a full pass, which sees the page as it
  is.
- `enableAdaptation` is also the **full refresh** used when the profile,
  strength or site override changes (`REFRESH_ADAPTATION`). It supersedes
  anything queued (`discardPending`), re-plans from the original styles and
  restarts the pipeline. Settings changes are never treated as DOM mutations.
- `refresh()` requests a full rescan through the normal path; `dispose()`
  stops for good (`start()` becomes a no-op).

Subscriptions are deliberately narrow:

- the document subtree: `childList`; `attributes` limited by `attributeFilter`
  to `class`, `style`, `hidden`, `disabled`, `aria-disabled`, `role`, plus
  `href`/`media`/`rel` (used only on `<link>`), the semantic attributes of M6
  (`SEMANTIC_ATTRIBUTES`: `aria-invalid/-selected/-current/-checked/-pressed/-required/-live`,
  `aria-label`, `aria-describedby`, `title`, `required` and the state-carrying `data-state`,
  `data-status`, `data-variant`, `data-type`, `data-severity`, `data-kind`, `data-validity`,
  `data-selected`, `data-active`, `data-invalid`); `characterData` (see below).
  Every other attribute, including every other `data-*`, is never delivered;
- `<html>` and `<body>` themselves for **all** attributes, so a theme switch
  such as `data-theme="dark"` / `data-bs-theme` / `data-color-mode` is seen
  without opening up `data-*` everywhere. Other attributes on them (`lang`,
  scroll-lock data, ...) are classified irrelevant. If `<body>` is replaced the
  subscription follows (`syncRoots`).

`characterData` is observed because React and others update text in place
(`textNode.data = ...`). It is cheap because the classifier keeps only the
empty to non-empty transition (`hasOwnText` is the only text-dependent
eligibility); a ticking counter or clock costs a classification, never a pass.

## Mutation kinds

Every record is classified explicitly (`classifyMutations`), on the **net
change** of the batch (the first record per target and attribute supplies the
old value, so `class A -> B -> C -> A` is nothing):

| Kind                        | Meaning                                                                                                                                                                                                                                               | Consequence                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `NODE_ADDED`                | An element entered the document                                                                                                                                                                                                                       | Its subtree is analyzed                                                                   |
| `NODE_REMOVED`              | An element left the document                                                                                                                                                                                                                          | Its owned ids are dropped                                                                 |
| `STYLE_AFFECTING_ATTRIBUTE` | `class` (token set changed), `style` (a property ColorAdapt reads changed), `hidden`, `disabled`, `aria-disabled`, `role`; theme attributes on `<html>/<body>`                                                                                        | The target's subtree is invalidated                                                       |
| `TEXT_CHANGE`               | Text added/removed, or a text node flipped between empty and non-empty                                                                                                                                                                                | The element alone is re-analyzed                                                          |
| `SEMANTIC_CHANGE` (M6)      | A change of `aria-invalid/-selected/-current/-checked/-pressed/-required/-live`, `aria-label`, `aria-describedby`, `title`, `required` or a state-carrying `data-*` (net change); or the words of a short status text changing ("Pending" → "Failed") | The element alone is re-examined (the semantic layer also looks at its nearest ancestors) |
| `STYLESHEET_CHANGE`         | `<style>`/`<link rel=stylesheet>` added, removed, edited, or their `href/media/rel/disabled` changed                                                                                                                                                  | Full rescan (see below)                                                                   |
| `IRRELEVANT`                | Scripts/templates/meta, unrelated attributes, no net change, class reorder, `transform`/`top`-style writes, coalesced duplicates                                                                                                                      | Counted, nothing else                                                                     |
| `COLORADAPT_INTERNAL`       | ColorAdapt's own writes                                                                                                                                                                                                                               | Ignored                                                                                   |

`style` relevance is decided on declarations **normalized by the engine** (a
detached probe element parses both values): the first time a script touches
`el.style`, the browser reserializes the whole attribute (`#c0392b` becomes
`rgb(192, 57, 43)`), which must not look like a color change. Relevant
properties: `color`, `color-scheme`, `opacity`, `visibility`, `display`,
`content-visibility`, `filter`, `mix-blend-mode`, `all`, custom properties
(`--*`), `background*`, `border*` and `outline*` colors/widths/styles. Animation
loops writing `transform`/`top` never wake the analyzer.

## Self-mutation filtering

**M6 note.** The semantic cues are written as one attribute, `data-coloradapt-cue`, which carries the
`data-coloradapt-` prefix and so falls under the first rule below; the cue CSS lives in the same
managed `<style>`. No node is ever inserted, so there is nothing else to filter. Cue writes happen
inside the incremental pass and are drained with the rest; a regression test asserts that a settled
page does exactly zero further work and another that the records are classified as ColorAdapt's own.
A page deleting a `<style>` that holds only cue CSS is repaired like any other (`hasInjectedContent`).

**M7 chart layer.** There is no second observer: `ChartController.update(roots)` is called by the
incremental session with the roots M4 resolved, and a region inside an inline SVG is treated as the
SVG it belongs to. What M7 writes is covered by the self-mutation filter: every attribute starts with
`data-coloradapt-`, and a child-list record whose every added/removed node is ColorAdapt's `<style>`
or carries `data-coloradapt-chart-node` (the owned `<defs>` and decorative overlays) is ColorAdapt's
own. The observer subscription grew by `stroke-dasharray`, `marker-start/mid/end`, `data-series`
and `data-series-name` (`SVG_PAINT_ATTRIBUTES`), and `stroke-dasharray` joined the relevant inline
style properties: a dash is one of the channels that tell series apart. `ChartController.update`
returns how many regions it handled; the session reports the smaller of that and the color pass's
`rootsConsumed`, so a chart-heavy region goes back to the batcher whole (budget hand-back). When only
elements left the page, `updatePeers` also lets the chart layer drop the artifacts of a removed chart.
M7.R1 adds two things to the same flow. `ResolvedBatch.departures` lists the parents that lost a child,
deleted _or moved_ (bounded to 64 per batch); `update(roots, anchors)` / `updatePeers(seeds, departures)`
hand them to the chart layer, which re-reads every tracked chart whose legend neighbourhood (the parent and
grandparent of its `<svg>`) contains a root or an anchor - a legend that appears, goes, is recolored or moves
cannot leave an adapted chart behind. And `invalidate(element, 'chart')` is how the chart layer's resize /
geometry bridge (`ResizeObserver` for the tracked charts, a `MutationObserver` scoped to them for `d` and
`points`) asks for a pass over one chart: the same batched path as every other pass, counted by the chart
diagnostics (`resizeSignals`, `geometrySignals`), not by `semanticInvalidations`. `d` and `points` are
deliberately not in `OBSERVED_ATTRIBUTES`: a page animating them would flood the page-wide observer.

**M6 observer subscription.** The attribute filter grew by the semantic attributes (`SEMANTIC_ATTRIBUTES`);
every other `data-*` is still not delivered. Native form validity changes without any mutation, so
`features/semantics/native-validity-bridge.ts` installs five passive capture listeners (`input`,
`change`, `focusout`, `invalid`, `reset`) while the pipeline runs and `semanticCuesEnabled` is on;
they only call `DynamicPipeline.invalidate(field)`, which queues the field through the normal batch
(`reset` names the fields of the reset form, up to 200). With the setting off there is no listener
and no work; a refresh keeps exactly one set.

**M6.R1 peer invalidation.** Whether color is the only difference between two elements depends on
both, so the dynamic pipeline hands the semantic layer more than the roots: `ResolvedBatch.peerSeeds`
(`{ anchor: parent, template: removed node }`, one per parent and kind of element, at most 200 per
batch) tells it where elements left, and the layer re-examines the former peers of the removed node
and of what was inside it. A changed element, a candidate and the first 24 elements of an added
region name their peer group the same way. All of it is bounded (<= 300 peer searches, <= 400 extra
peers per pass, <= 100 peers per group) and never a document scan; a pass that only removed things
still runs and prunes cue rules nobody carries (`docs/SEMANTIC_ACCESSIBILITY.md`, "Peer
invalidation").

ColorAdapt writes exactly two things to a page: the `data-coloradapt-id`
attribute and one `<style id="coloradapt-stylesheet">` element (inserted,
rewritten, removed; also rewritten around every analysis). The policy
`isColorAdaptOwnedMutation(record)`: a record is ColorAdapt's own if it is

- an attribute change to `data-coloradapt-*`;
- anything inside, or an attribute of, the `<style id="coloradapt-stylesheet">` element;
- a child-list change whose every added/removed node is that `<style>`.

Layers that stop `adapt -> mutate -> analyze -> adapt`:

1. the attribute filter never delivers `data-coloradapt-id` in the first place;
2. the observer callback drops owned records before they reach the queue
   (`selfMutationsIgnored`), so ColorAdapt's own stylesheet writes do not even
   schedule a flush;
3. after every pass (incremental or full) the records the pass produced are
   drained with `takeRecords()`, so nothing from a pass is delivered later;
4. the classifier applies the same policy again for records that reach it.

The one owned record that is **not** ignored is the removal of our `<style>`
while rules still exist: that was the page's doing (a framework re-rendering
`<head>`), and the rules are put back (`stylesheetRepairs`). With no rules the
removal is our own `restore()` and is ignored. The first repair is immediate; repairs
are then spaced by `stylesheetRepairMinIntervalMs` (one timer, never dropped; a forced
`flush()` skips the wait): a page that deletes the sheet again every time would
otherwise cost a repair per frame, forever (measured before the fix: 90 repairs in 90
frames; after: 3). While such a fight lasts the page wins the cascade anyway; when it
stops, the sheet is back within one interval.

**Determinism of the repair cadence (M5.R1).** The spacing is the only place where the
pipeline's work depends on a clock, so it is made observable instead of being left to
timing. A repair that falls inside the interval is _deferred_ (`stylesheetRepairsDeferred`
counts each timer armed); the timer then costs exactly one extra batch, because the owed
repair makes its wake-up a batch of its own. Hence, for any run,
`batches = (batches of real work) + stylesheetRepairsDeferred`, and
`stylesheetRepairsDeferred <= stylesheetRepairs`. Whether one particular cycle was fast
enough to be deferred is wall-clock luck; that every deferral costs exactly one batch, that
nothing is dropped and that deferrals never exceed repairs is the invariant. The clock and
the scheduler are injectable (`now`, `scheduler`; production passes neither), and the unit
tests (`repair scheduler`, `tests/features/dynamic/pipeline.test.ts`) drive both regimes
with a manual clock: coalescing of rapid deletions into one timer, OFF and `dispose()`
cancelling the pending timer, ON-after-OFF arming at most one, no observer feedback after a
repair. The previous E2E assertion `batches === 6 * cycles` assumed no cycle was ever
faster than 500 ms and failed (721 instead of 720) when one was; it now asserts the
equation above.

A page that writes to our private `data-coloradapt-id` attribute (copying, erasing or
forging it) is not observed at all (the attribute is outside the observer's filter),
which keeps this loop-free; the incremental path does not repair that tampering, a
full refresh does.

Tests: one external mutation yields one pass and then silence, in jsdom
(manual scheduler, no timers) and in Chromium (`incrementalPasses` unchanged
across further frames, state `IDLE`).

## Batching

`MutationBatcher` is a bounded queue with a state machine:

```text
STOPPED -start-> IDLE -enqueue/request-> SCHEDULED -flush-> RUNNING -> IDLE
                              RUNNING -enqueue/request-> DIRTY -> SCHEDULED
```

- **When**: `requestAnimationFrame` while the page is visible, a zero-delay
  timeout otherwise (rAF is paused in background tabs). Why a frame: observer
  callbacks already arrive once per microtask checkpoint, so a microtask adds
  no coalescing; a frame merges whatever a framework does across several tasks
  into one pass and runs **before that frame is painted**, so newly inserted
  content is adapted before it is shown. There is no arbitrary delay.
  (`ANALYSIS_BUDGET.mutationDebounceMs` from the M0 plan is gone; nothing is
  debounced by time.)
- **Reentrancy**: passes never overlap. A mutation during a pass makes the
  machine `DIRTY`; it is handled by the next, separately scheduled flush.
- **Structural budgets** (`DYNAMIC_BUDGET`, `shared/constants/performance.ts`);
  no correctness depends on a clock:

  | Budget                          | Default | On exceeding                                                                                  |
  | ------------------------------- | ------- | --------------------------------------------------------------------------------------------- |
  | `maxQueuedRecords`              | 5000    | More than 5000 queued records: queue dropped; next batch is one `queue-overflow` rescan       |
  | `maxAffectedRoots`              | 512     | More than 512 distinct roots: the batch becomes one `too-many-roots` rescan                   |
  | `maxElements` (analyzer)        | 1500    | One root alone over 1500 is cut (the cap on what a region covers; unchanged by M12.5)         |
  | `SLICE_BUDGET.maxElements`      | 600     | A root that does not fit in what is left of a slice is left whole for the next slice (M12.5)  |
  | `maxPassesPerFlush`             | 64      | Safety bound for a forced `flush()`                                                           |
  | `stylesheetRepairMinIntervalMs` | 500 ms  | Spacing between repairs of our `<style>` after the page deleted it (postponed, never dropped) |

  Exact boundaries (all verified in real Chromium, M4.R1): 511, 512 roots = one
  incremental pass; **513** = one `too-many-roots` rescan. 4999, 5000 queued records =
  incremental; **5001** = one `queue-overflow` rescan. A single root with 1499 or 1500
  candidate elements is complete; **1501** is truncated at 1500 (the 1501st and later are
  never adapted by the incremental path; the next full refresh has the same cap, as in M3).

- **Overflow** is never silent: the dropped records release their DOM
  references, the batch carries `overflowed`, and a full rescan reconciles the
  page (`queueOverflows`, `fullRescansByReason['queue-overflow']`).

## Affected roots

`resolveAffectedRoots` turns classified mutations into regions
(`AnalysisRoot = { element, scope: 'subtree' | 'self' }`):

- added element: its **subtree** (an appended `newContent` is analyzed, not
  the document);
- style-affecting attribute on `T`: `T`'s **subtree**. A parent's background,
  opacity, color, visibility or CSS variable changes what its descendants
  resolve to, so descendants are invalidated; siblings and `:has()` effects are
  not (see limitations). This is a pragmatic bounded invalidation, not a
  browser dependency graph;
- anything **inside an inline `<svg>`** (M5): the outermost `<svg>` as a `self` region, analyzed
  whole as one unit (`subtree` only when the `<svg>` itself was added or restyled); an `<svg>`
  that defines ids (a sprite) additionally queues the `<svg>`s whose `<use>` points into it;
  a child removed from an `<svg>` re-analyzes that `<svg>` (`NODE_REMOVED` records its parent).
  See `docs/SVG_ANALYSIS.md`;
- text change: the element alone (`self`);
- removed element: nothing to analyze. If the node is really detached its
  owned ids are collected for cleanup; a node that is connected again was
  moved, and appears as an added root instead;
- nodes that are detached or outside `<body>` are skipped.

`normalizeRoots` de-duplicates: a `subtree` root swallows its descendants and
any `self` root inside it, and beats a `self` root on the same element
(`parent / child / grandchild -> parent`). Order of first appearance is kept.

## Incremental analysis

`IncrementalAdaptationSession.update({ roots, removedIds })`:

1. forget the ids of removed elements;
2. with the stylesheet suspended (`withOriginalStyles`, exactly as in M3 so
   analysis reads the page's own colors and **never drifts**), run
   `analyzeSubtrees(roots)` and the same "computed color must equal effective
   foreground" safety check (`findNotAdaptable`, now given the analyzed nodes
   instead of searching the document);
3. elements tracked inside a fully re-analyzed region that did not qualify this
   time (hidden, text gone, no longer a candidate) lose their adaptation;
4. plan each element with `planElement` (the same function the full plan uses,
   so fail-safe rules for gradients/images/partial analysis, disabled controls
   and animated colors are identical);
5. hand the stylesheet only the difference.

Result: `AdaptationDelta { added, updated, removed, notApplied, unresolved }`
plus rule counts. An element previously `notApplied` is retried whenever its
region is re-analyzed, and an adapted element that a page later out-ranks (an
inline `!important`) is re-verified against the browser and moves to
`notApplied`.

**Slices (M12.5).** A pass is a _slice_: one scheduled flush. Within the analysis cap above, how many roots share
a slice is decided by the slice budget (`sliceElements`, with `sliceWeight` giving an inline SVG unit and an
element the semantic layer will examine a larger share than a plain element, from measured per-unit costs); the
first root of a slice is taken whole whatever its weight, so the budget changes the number of passes of a burst and
never what is analyzed. The roots left over are `deferredRoots`, in order, ahead of anything that arrives later
(no starvation), re-validated when their turn comes (`staleRoots` counts the ones that left the page meanwhile) and
cancelled by `stop`, `discardPending` and a full refresh (`cancelledRoots`). Local counters: `slices`, `maxSliceMs`,
`totalSliceMs`, `peakQueuedRecords`, `peakDeferredRoots`. See `docs/PERFORMANCE.md`, "Burst model".

Budgets (`analyzeSubtrees`): the first root of a pass is always started and always
finished, up to `maxElements`. **The clock never cuts a root short** (a forced style
recalculation on its first element can take longer than the whole 50 ms; dropping the
tail of a root for that would make the result depend on the machine). A later root is
started only if the time budget has not run out _and_ its candidates fit in what is left
of the element budget; otherwise it is left, whole, for the next pass (`rootsDeferred`),
where it is the first root. So every pass makes progress, no root starves, and a root
that fits the budget is analyzed completely however it is batched with others. Only a
single root with more candidates than `maxElements` is `truncated` (as a full page
already is in M3); it is consumed, not retried forever. (The M3 full analysis,
`analyzeDocument`, keeps its own 50 ms/1500-element budget unchanged; full rescans use it.)

## Stylesheet delta

`StylesheetManager` keeps a rule map keyed by element id. `applyDelta({ upsert,
remove }, nodes?)` updates entries individually, rewrites the sheet text from
the map **only if something changed**, then verifies every upserted rule
against the real cascade (unchanged rules are verified too, without a
rewrite). Consequences: one current rule per element however often it is
updated (tested 100x in jsdom); removing the last rule removes the `<style>`;
a `<style>` deleted by the page is recovered by `reattach()` or the next delta.
The sheet text is regenerated, not patched: that is O(rules) string work, but
analysis, planning and verification stay proportional to the delta.

## Stable element ids

`data-coloradapt-id` values come from a module counter and are kept in a
`WeakMap<Element, id>`. The attribute is trusted only if the registry agrees,
so a `cloneNode` copy (or an attribute the page wrote) gets a **fresh id** and
two elements can never share a rule. The registry is weak: removed elements
and their bookkeeping are collectable; the counter is a plain number. The
controller's own maps hold only id strings and outcome kinds, never DOM nodes,
and removal cleanup deletes them. Removal cleanup uses owned ids only.

## Full rescan policy

A full rescan is the M3 path (`enableAdaptation`), so it also refreshes
`getLastAnalysis`. It is used only for what no bounded region can describe, and
every use is counted by reason in `DynamicDiagnostics.fullRescansByReason`:

| Reason           | Trigger                                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `stylesheet`     | A page `<style>`/`<link rel=stylesheet>` added, removed or edited; its `href/media/rel/disabled` changed; a `<style>` inside an added subtree |
| `document-root`  | A relevant attribute on `<html>`/`<body>` (class, style, theme attributes) or either element replaced                                         |
| `too-many-roots` | More than `maxAffectedRoots` distinct roots in one batch                                                                                      |
| `queue-overflow` | More than `maxQueuedRecords` records between flushes                                                                                          |
| `manual`         | `refresh()`                                                                                                                                   |

- A `<link rel=stylesheet>` that will fetch something (non-empty `href`, not
  `disabled`) changes nothing until it has: the pipeline waits for its
  `load`/`error` event (one-shot listener), then rescans once. This applies when it
  has no sheet yet (inserted, `rel` switched to `stylesheet`, re-enabled), **and when
  its `href` changes** (Chromium keeps the old sheet in `link.sheet`, and applying,
  until the new one arrives, so rescanning at once would read the old one). Other
  changes are immediate: a link **removed** from the document or **disabled** has no
  sheet either, but that is the removal of its rules, not a load to wait for
  (waiting would leave them stale), and a `media` change is evaluated by the browser
  at once. Every stylesheet in an added subtree gets its own wait, and the rest of the
  subtree's content is analyzed without waiting for them. Listeners are removed when
  the link leaves the document or is disabled, on `stop()` (OFF) and on `dispose()`;
  `pendingLinks` is the live count. Removing a link that never loaded is, like any
  removed link, one (harmless) rescan. A link the browser never fetches (for example an
  unsupported `type`) is waited on until it is removed or ColorAdapt is turned OFF.
- Full rescans are **throttled, never dropped**: a mutation-driven rescan that
  would start less than `fullRescanMinIntervalMs` (500 ms) after the previous
  one is postponed with a single timer (`fullRescansThrottled`). This is the
  only time-based value in the design and affects only how soon a rescan
  happens, not whether or what it computes. Forced `flush()` and `manual`
  requests bypass it.
- CSS variables: a `--x` change in an inline `style` is a style-affecting
  attribute, so it invalidates the target's subtree; on `<html>`/`<body>` that
  is a full rescan.

## Diagnostics

`DynamicDiagnostics` (domain type; local only, never transmitted, never
logged): `mutationRecords`, `batches`, `incrementalPasses`, `fullRescans`,
`fullRescansByReason`, `affectedRoots`, `elementsProcessed`,
`selfMutationsIgnored`, `irrelevantMutations`, `rulesAdded/Updated/Removed`,
`queueOverflows`, `rootsDeferred`, `truncatedPasses`, `stylesheetRepairs`,
`stylesheetRepairsDeferred`,
`observerStarts`, `fullRescansThrottled`, `observerCallbacks`, and the live gauges
`state`, `trackedElements`, `rules`, `pendingLinks`, `queuedRecords`, `deferredRoots`,
`pendingRescan` (a rescan owed but not yet run) and `throttleTimerActive` (a postponed
rescan or repair is waiting on its timer). The gauges exist so retention and
settling can be asserted from outside: after a flush everything but `state: IDLE`,
`trackedElements` and `rules` is zero/null/false.

M7 adds `charts` (the chart-layer counters and leak gauges of `docs/CHARTS.md`: `chartsDetected`, `chartsSupported`, `chartsUnsupported`, `seriesAnalyzed`, `seriesAdapted`, `legendsMapped`, `patternsCreated`, `markersCreated`, `overlaysCreated`, `chartNotApplied`, `canvasCharts`, `canvasUnknown`, `chartPasses`, `chartPassesSkipped`, `marksScanned`, and the gauges `chartOwners`, `chartDefs`, `chartOverlays`, `chartRules`, `chartPending`; M7.R1: `chartWatched`, `watchSubscriptions`, `resizeSignals`, `geometrySignals`, `legendItemsScanned`, `seriesEvaluated`).

M6 adds `semantic` (the cue counters of `docs/SEMANTIC_ACCESSIBILITY.md`: candidates, classified,
unknown, conflicts, color-only detected, cues planned/applied/not applied/removed, passes, roots, and
the `cuesActive` gauge, plus `semanticPeerSearches` / `semanticPeersReexamined` from M6.R1) and
`semanticInvalidations` (elements named by the native-form-validity event bridge).

Available through `controller.dynamic.diagnostics()` and, for the E2E suite,
through two typed debug messages: `GET_DYNAMIC_DIAGNOSTICS` and
`FLUSH_DYNAMIC` (process everything pending now, synchronously, then report).
Nothing is printed to the console.

## Behaviour summary

| Scenario                                        | Result                                                          |
| ----------------------------------------------- | --------------------------------------------------------------- |
| Append content to an existing container         | Only the new subtree is analyzed                                |
| Remove an adapted node                          | Rule, bookkeeping removed; `<style>` removed with the last rule |
| `replaceWith` / `replaceChildren` / re-render   | Old rules out, new in, one rule per live element                |
| Class / inline style change                     | Target subtree re-analyzed                                      |
| Parent background / opacity / visibility change | Descendants re-analyzed (subtree of the parent)                 |
| `display:none` / `hidden` and back              | Rule removed / re-applied                                       |
| `disabled` toggled                              | Eligibility updated                                             |
| 500 synchronous inserts                         | One pass (not 500)                                              |
| 1000 inserts                                    | One `too-many-roots` rescan                                     |
| Rapid class changes in one frame                | One pass, final state                                           |
| Dynamically added `<style>` / `<link>`          | One full rescan (after load for links)                          |
| Gradient/image/animated content added later     | Same fail-safe as the initial scan                              |
| Profile / strength / site settings change       | Full refresh from original styles (no compounding)              |
| ON -> mutate -> OFF -> mutate -> ON             | No ghost observer; ON starts with a full pass                   |
| SPA route change                                | Handled as DOM mutations; no History API listener needed        |

## Limitations (documented, not hidden)

- **CSSOM changes are invisible to `MutationObserver`.** `CSSStyleSheet.insertRule`
  / `deleteRule` / `replaceSync`, `adoptedStyleSheets`, a `:root` custom
  property changed through `style.setProperty` on a rule, and CSS-in-JS
  "speedy" mode (which inserts rules instead of text nodes) do not produce
  mutations. M4 does not observe the CSSOM. A restyle that arrives with a
  `class`/`style` mutation is caught; one that arrives only through the CSSOM
  is picked up at the next full refresh (settings change, popup "refresh", ON).
  Verified in Chromium: after `insertRule`, `deleteRule`, `adoptedStyleSheets = [...]`
  and `replaceSync` no record is delivered and no work is done (a rule added this way
  leaves an existing element unadapted, a rule deleted this way leaves our now-stale
  rule in place), and `REFRESH_ADAPTATION` makes the state correct. Narrower than it
  sounds: an **element inserted** after a speedy `insertRule` is adapted (its insertion
  is a mutation, and the analysis reads the CSSOM as it is then).
- **SVG (M5).** The observer is attribute-filtered: the SVG paint attributes (`fill`, `stroke`,
  `fill-opacity`, `stroke-opacity`, `stroke-width`, `opacity`, `color`, `display`, `visibility`,
  `filter`, `mask`, `mix-blend-mode`) and `href` count only on SVG elements. A legacy namespaced
  `xlink:href` change is never delivered by a `MutationObserver` `attributeFilter` (verified in
  Chromium: no record, no work; `svg-dynamic.spec.ts` asserts both that and that
  `REFRESH_ADAPTATION` then yields the correct state); M5 deliberately adds no compatibility
  layer for it. Everything else about SVG
  limits is in `docs/SVG_ANALYSIS.md`.
- **Sibling and structural selectors.** A `class` change can restyle siblings
  (`.a + .b`, `:nth-child`) or ancestors (`:has()`). Only the target subtree is
  invalidated.
- **Pseudo-state and media queries.** `:hover`/`:focus`, `prefers-color-scheme`
  and viewport media-query changes are not DOM mutations (hover/focus colors of
  adapted elements are still overridden, as in M3).
- **CSS-in-JS churn.** Each added `<style>` is a full rescan, throttled to one
  per 500 ms; heavy runtime style injection can keep ColorAdapt in rescan mode.
- **Shadow DOM and iframes** are not entered (separate milestones). Content
  added inside an open shadow root is not seen.
- **Popup statistics** (`getLastAnalysis`, the numbers behind "Analyse page") are
  refreshed by full scans; between them the page is kept adapted but the
  conflict list may lag. `IncrementalAdaptation.summary()` stays current.
- A single root larger than `maxElements` (1500) is truncated, as a whole page
  already is; its tail stays unadapted until a restructure splits it (a full refresh
  has the same cap). M12.5 bounds the time of a slice, not this coverage: ten thousand elements under one
  container, or as thousands of flat siblings (more than 512 regions: one full rescan), are adapted up to the cap.
- **Theme switches on `<html>`/`<body>` are recognised by attribute name**
  (`/theme|color-?mode|color-?scheme|^data-mode$/`, plus `class`, `style`, `hidden`,
  `role`, `disabled`, `aria-disabled`). `data-theme`, `data-bs-theme`,
  `data-color-mode`, `data-mode` and custom `data-*-theme` are seen; an attribute with
  an unrelated name (for example `data-skin`) is not, until the next full refresh
  (verified in Chromium).
- **Text.** An in-place text change (`nodeValue`/`data`) costs a pass only when it
  switches between empty and non-empty. Replacing text through `textContent` is a
  `childList` mutation and is one `self`-root pass by contract.
- **Page tampering** with `data-coloradapt-id` is not repaired incrementally (see
  "Self-mutation filtering").
- **Page fights.** A page that deletes our `<style>` repeatedly keeps the page's own
  colors most of the time (repairs are spaced out, see above); an inline `!important`
  or a deeper id chain with `!important` out-ranks the adaptation and is reported as
  `notApplied`, never fought, and is retried when that element's region is next
  analyzed.
- Timers: if the tab is hidden the zero-delay timeout is used; if the browser
  throttles it, adaptation of that hidden page is delayed, never skipped. **This path
  is unit-tested only (`tests/features/dynamic/scheduler.test.ts`): headless Chromium
  never reports a page as hidden, so the real-browser case is NOT_VERIFIED.**
- `dispose()` is not reachable from the shipped content script (it lives as long as
  the page); it is unit-tested, and OFF (`stop()`) is verified in Chromium.
- Memory is checked through retention proxies (`rules`, `trackedElements`,
  `pendingLinks`, queue/roots/timers back to baseline after 5000 created and removed
  nodes) and a code audit (maps hold element ids and outcome kinds; the only strong
  references to nodes are the transient queue records, `deferredRoots` and
  `pendingLinks`, all released by the next flush or on removal). Actual garbage
  collection is **not** measured.
- M4 is validated in Chromium; Firefox is build-verified only (`pnpm build:firefox`),
  its runtime behaviour is NOT_RUN.

## Performance model

Per pass: work is proportional to the affected roots, not the page.

- classification: O(records);
- root resolution: O(roots x depth);
- analysis: one `getComputedStyle` per unique element in the roots and their
  ancestor chains (shared background cache), plus one read for the safety check;
- planning: one optimizer search per distinct color pair (memoized per session,
  capped at 2048 pairs);
- applying: one sheet text regeneration and two forced style flushes (analysis
  suspends and restores the sheet) per non-empty pass, plus one
  `getComputedStyle` per upserted rule.

Deterministic counters from `tests/benchmarks/dynamic-benchmark.test.ts`
(written to `benchmark-report/dynamic-benchmark.json`; wall-clock is recorded
there but never asserted):

| Scenario (50-150 element page) | Records | Batches | Passes | Full rescans | Roots | Elements | Naive (every mutation scans the page) |
| ------------------------------ | ------: | ------: | -----: | -----------: | ----: | -------: | ------------------------------------: |
| 100 synchronous inserts        |     100 |       1 |      1 |            0 |   100 |      100 |                                15,100 |
| 500 synchronous inserts        |     500 |       1 |      1 |            0 |   500 |      500 |                               275,500 |
| 1000 synchronous inserts       |    1000 |       1 |      1 |            1 |     - |        - |                             1,051,000 |
| 100 class flips (100 rows)     |     100 |       1 |      1 |            0 |   100 |      100 |                                10,100 |
| 500 class flips (500 rows)     |     500 |       1 |      1 |            0 |   500 |      500 |                               250,500 |
| 1000 flips of one element      |    1000 |       1 |      1 |            0 |     1 |        1 |                               101,000 |
| 1 insert into a 1000-row page  |       1 |       1 |      1 |            0 |     1 |        1 |                                 1,002 |

(`Passes` = incremental passes + full rescans; the 1000-insert row is the
`too-many-roots` rescan.) Both key properties hold: one small mutation is not a
document scan, and 500 synchronous inserts are not 500 scans.

## Testing

- Unit / integration (jsdom, no timers, manual scheduler): classifier, ownership
  policy, style relevance, root normalization and escalation, batcher state
  machine, observer lifecycle, scheduler (visible and hidden paths), subtree
  analysis, stable ids, stylesheet delta, and the whole pipeline
  (`tests/features/dynamic/`, `tests/core/...`).
- Real Chromium, `e2e/dynamic.spec.ts` (23 scenarios, M4) and the M4.R1 suites
  `e2e/r1-*.spec.ts` (105 scenarios, below). Assertions use `getComputedStyle`,
  structural counters, and "incremental result equals a full rescan of the same
  page" (`expectEquivalentToFullRescan`). Nothing sleeps.

## M4.R1 validation (real Chromium, local deterministic fixtures)

M4 was validated again in a real browser against the built extension, with
adversarial pages. No public website decides any PASS/FAIL. Defects the browser found
that jsdom could not, all fixed and covered by both a Chromium and a unit test:

| #   | Defect                                                                                                                                                                                                                                                             | Fix                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | A `<link rel=stylesheet>` **removed** from the document looked like "still loading" (a removed link has no sheet): no rescan, stale rules, and the detached node kept in `pendingLinks`                                                                            | Removed links are a plain stylesheet change; only connected, fetching links are pending                                              |
| 2   | **Disabling** a loaded link (`link.sheet` becomes `null`) was waited on for a `load` that never comes: rules stayed stale                                                                                                                                          | A disabled link is a plain stylesheet change (re-enabling is pending; Chromium fires `load` again); pruned if disabled while pending |
| 3   | An `href` change rescanned at once, against the **old** sheet (Chromium keeps it in `link.sheet`), and never again when the new one loaded                                                                                                                         | `href` changes are pending, rescanned once after `load`/`error`                                                                      |
| 4   | A page that deletes our `<style>` every time cost one repair per frame, forever (90 in 90 frames)                                                                                                                                                                  | Repairs spaced by `stylesheetRepairMinIntervalMs` (3 in 90 frames), one timer, never dropped                                         |
| 5   | Analyzer budget: a root that straddled `maxElements` was cut and its tail lost (4 roots x 600 elements lost 300); the 50 ms clock cut the first root after one element when a forced style recalculation was slow (3001 of 4500 rules on one run, 4500 on another) | A root that does not fit is left whole for the next pass; the clock only gates starting a further root, never cuts one               |
| 6   | An added subtree holding only pending links was not analyzed until they loaded                                                                                                                                                                                     | The content gets its own region now; each pending link its own wait                                                                  |

Also added: diagnostics gauges (`pendingLinks`, `queuedRecords`, `deferredRoots`,
`pendingRescan`, `throttleTimerActive`, `observerCallbacks`) so retention and settling are
assertable. One existing unit test asserted the old time-cut behaviour of
`analyzeSubtrees` ("respects the time budget with an injected clock": a single root cut by
the clock); it encoded defect 5 and is replaced by two tests of the new contract. No other
M1-M4 assertion was changed or weakened.

What each suite proves (all in Chromium):

- **Insertion** (`appendChild`, `prepend`, `insertBefore`, `insertAdjacentHTML`,
  `replaceWith`, `replaceChildren`, fragment, nested, `cloneNode`): one incremental pass over
  only the new region, no rescan, no duplicate ids or rules, stable afterwards, equal to a
  full rescan; a clone gets its own id and rule.
- **Attributes / net zero / text / theme**: relevant attributes cost exactly one pass over the
  target subtree; `title`, `name`, `value`, `data-*` are never delivered; transform/top/left/
  layout-only inline styles are delivered and classified away; `A -> B -> C -> A`,
  `X -> Y -> X`, add -> remove and text round trips are no work; empty <-> non-empty text
  triggers, non-empty -> different does not; theme switches on `<html>`/`<body>` are exactly
  one rescan per logical switch.
- **Stylesheets**: the table above, plus `media`, `rel`, `disabled`, link load/error, and
  the CSSOM limitation (`insertRule`, `deleteRule`, `adoptedStyleSheets`, `replaceSync`:
  not detected; `REFRESH_ADAPTATION` corrects).
- **Feedback loops**: 120 hostile cycles (insert, page deletes our `<style>`, insert,
  rule out/in, remove last rule) = 600 passes, 120 repairs, 0 rescans, 840 observer
  callbacks, then silence; page writes to `data-coloradapt-id` are never delivered. The
  batch total is asserted as `6 x cycles + stylesheetRepairsDeferred` (see "Determinism of the
  repair cadence"), not as a wall-clock-dependent constant.
- **Page fights** (the page mutates right after every ColorAdapt write): inline `!important`
  (`notApplied`, no stale rule, recovered when released), class change, replacing, moving,
  cloning and style deletion all converge to the full-rescan result.
- **Budgets**: 511/512/513 roots, 4999/5000/5001 records, 1499/1500/1501 elements behave
  exactly as the table says; unstarted and straddling roots are retried whole and all
  complete; three roots over the budget take one pass each.
- **Reentrancy**: with a page element that mutates the DOM from inside a pass, the state goes
  RUNNING -> DIRTY -> a separate later flush; the two passes' id writes reach the page in
  different observer deliveries; chains and a 25-spy burst resolve in sequential passes with
  nothing lost.
- **Lifecycle**: ON/OFF/ON, 100 ON/OFF cycles (100 observer starts, still one pass per
  mutation), mutations while OFF never queued, nothing running after the last OFF.
- **SPA / infinite scroll**: route changes by DOM replacement (with and without
  `pushState`, `popstate`): old rules out, new in, the shell untouched, no rescan; the
  extension has no History API code. Feed: 100 + 20 x 100 + 500 rows = 2100 + 500 elements
  processed in 22 incremental passes, 0 rescans; trimming 1000 and clearing leaves 0 rules,
  baseline tracking, no `<style>`.
- **Throttle**: bursts coalesce, causes in consecutive frames end in a consistent state with
  nothing owed, and mutations before, during (via the mid-pass page element) and after a
  rescan are not lost.
- **Retention proxies**: 5000 nodes created, adapted and removed in cycles return `rules`,
  `trackedElements`, `pendingLinks`, queue, roots and timers to baseline; 300 pending links
  created and removed leave none.

NOT_VERIFIED in a real browser: the hidden-tab scheduler path (headless Chromium never
reports `hidden`; unit-tested), `dispose()` (not reachable from the content script;
unit-tested), actual garbage collection (proxies and a code audit only), Firefox (build only).

## Images (M8)

The image layer has no observer of its own. The regions M4 re-analyzes are also handed to
`ImageController.update` (images in them are re-checked by a cheap key: source, natural size, load
state, and the background if the decision depends on it); images that left the page are released on
the same passes (the parents that lost a child). Two things M4 cannot see are covered without a
second observer:

- an image finishing to load, failing, or changing `src`/`srcset`/`<picture>` (none of those is an
  observed attribute, but each fires `load` or `error`): one capture-phase listener on the
  document, installed only while the layer is active;
- a page theme change: a style-affecting mutation of an ancestor re-analyzes the images in that
  region; a full rescan re-evaluates all of them. The cache key includes the background.

- an OS color-scheme change that flips a page ground through CSS (no mutation): one
  `matchMedia` `change` listener while the layer is active, re-checking only the background-dependent
  images (M8.R1);
- an adapted image that the page gives a `srcset`/`<picture>` choice: the next `load` shows a
  `currentSrc` other than ours and the image is re-evaluated (our bitmap released).

`src` is deliberately not in `OBSERVED_ATTRIBUTES`: the image layer's own `src` writes therefore
produce no mutation records and cannot wake the pipeline (and `data-coloradapt-image` is an own
attribute, filtered like the others). `DynamicDiagnostics.images` carries the image counters.
