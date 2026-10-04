# Charts and data visualization (M7)

M7 makes the **series of a chart distinguishable without relying on color alone**. It is not
`red series -> blue series`. The identity of a series is

```text
series identity = color + line style + marker + pattern + legend consistency   (where appropriate)
```

and M7 adds the missing redundant channels, keeping the original colors, so that a chart stays
understandable even when its series colors become indistinguishable for a viewer.

Priority, in this order:

```text
data meaning > series identity > visual distinguishability > preservation of original style > coverage
```

When a graphical mark cannot be mapped to a data series with confidence, the right answer is
**not to adapt** (`limited` / `unsupported`). Never altering the meaning of a chart beats covering
one more chart.

Not in M7: AI chart understanding, OCR, image recoloring, general Canvas interception, Shadow DOM,
iframes, data extraction, chart redesign, HTML legends (a chart with, or with possible, an HTML legend is
**refused whole**: see "HTML legend guard").

M7.R1 (validation and freeze) added the guard, the resize / geometry bridge, ordered-palette detection,
tighter axis evidence and a 149-scenario benchmark; the contracts above did not move: HIGH-confidence
ownership only, M5 never edits a chart-owned SVG, M7 never recolors a series, non-color redundancy first,
the legend mapping deterministic, Canvas detect-only. The section "M7.R1 validation" at the end has the
numbers.

## Layout

```text
src/core/charts/          pure, DOM-free (the same model for jsdom, Chromium and tests)
  types.ts                facts, series, legend, encoding, analysis and plan (discriminated unions)
  constants.ts            the data-coloradapt-chart-* attribute names
  util.ts                 paint identity, neutrality, boxes, tick text
  path.ts                 vertices / arcs / closure / rectilinearity of a path's `d`
  legend.ts               swatch + text pairs, clustered into legends
  series.ts               structure detectors (pie, heatmap, bars, lines, scatter, area), series, direct labels
  mapping.ts              series <-> legend mapping (key > token > color), or "ambiguous"
  classification.ts       analyzeChart(): supported | limited | unsupported | unknown; ownsChart()
  palette.ts              pairwise M2 simulation; non-color signatures
  line-style.ts marker.ts pattern.ts   the encoding catalogs as data
  adaptation.ts           planChart(): the ChartAdaptationPlan; deterministic assignment
  canvas.ts               <canvas> classification (never adaptation)
src/features/charts/      the browser layer
  chart-facts.ts          <svg> -> ChartFacts (computed styles, boxes), bounded
  chart-apply.ts          plan -> owned nodes, attributes and CSS (builds, inserts nothing)
  chart-controller.ts     ChartController: ownership, apply, verify, roll back, reverse, diagnostics
  chart-watch.ts          the resize / geometry bridge: one ResizeObserver + one scoped MutationObserver (signals only)
  html-legend.ts          the HTML legend guard: evidence of a legend M7 cannot synchronize near a chart
src/shared/constants/charts.ts   every structural limit, in one place
```

`core/charts` never mutates the DOM. `features/charts` never decides what a chart means.

## Pipeline

```text
M4 (the only observer)  ->  incremental pass  ->  M3 colors + M5 SVG units + M6 cues
                                              ->  ChartController.update(roots)
```

- **No document observer of its own.** The chart layer receives the regions M4 already chose
  (`update(roots, anchors)` in the incremental session, `scanDocument()` on a full refresh). M4 observes
  the attributes charts change (`stroke-dasharray`, `marker-*`, `data-series` in addition to fill, stroke,
  opacity, class, style...). Two things M4 cannot see are signalled by the **bounded bridge** (below) and
  turned into M4 passes (`invalidate`), never into work of the chart layer's own.
- **A neighbourhood is a region.** A legend that appears, leaves, is recolored or moves next to a tracked
  chart is a change in that chart's _legend neighbourhood_ (the parent and the grandparent of its `<svg>`;
  the siblings of a chart directly in `<body>`). `update(roots, anchors)` re-reads every tracked chart
  whose neighbourhood contains a root or an anchor; M4 supplies the parents that lost a child
  (`departures`: deleted _or moved_) as anchors. So "chart adapted, legend unchanged" cannot appear when a
  legend arrives later, and a refused chart is adapted again when the legend goes.
- **M5 asks before it adapts.** While analyzing an inline SVG, M5 asks `ChartController.owns(svg)`.
  An owned SVG is reported `chart-owned` and gets no color rule. Ownership is decided _before_
  planning, from the same read the chart layer uses, so two layers never edit the same marks.
- **Self-mutations are filtered.** Everything M7 writes carries a `data-coloradapt-*` name; an
  inserted/removed owned node is recognized by `data-coloradapt-chart-node`
  (`isColorAdaptOwnedMutation`). No pass is ever started by M7's own writes.
- **Budget hand-back.** `ChartController.update` returns how many regions it handled; when its
  per-pass mark budget is spent, M4 receives the rest as deferred roots, whole. The first region of a
  pass is always finished.

## Chart types

| Type            | Detected | Adapted                        | Why                                                            |
| --------------- | -------- | ------------------------------ | -------------------------------------------------------------- |
| `line`          | yes      | **yes**                        | series = colored open paths; line style + marker               |
| `bar` (grouped) | yes      | **yes**                        | series = fill color of baseline-aligned rects; pattern         |
| `scatter`       | yes      | **yes**                        | series = colored points; silhouette (clip) or hollow ring      |
| `pie`/`donut`   | yes      | **yes** (with a mapped legend) | slices = series; pattern                                       |
| `stacked-bar`   | yes      | no                             | `type-not-adapted`: classified, owned, left alone              |
| `area`          | yes      | no                             | `type-not-adapted`                                             |
| `heatmap`       | yes      | no                             | `heatmap-sequential`: color there is _magnitude_, not identity |
| `unknown`       | -        | no                             | mixed families, nothing characteristic                         |

## Detecting a chart (conservative)

The browser layer reads an `<svg>` into plain **facts** (one `MarkFacts` per painted shape: tag,
computed fill/stroke, dash, marker reference, vertices, arcs, closure, rectilinearity, box, class
tokens, `data-series`; one `TextFacts` per `<text>`). `analyzeChart(facts)` is pure.

1. **Legend swatches** are removed from the data first (a repeated swatch + text pair of one size,
   one kind and _distinct paints_ — ticks, data labels and axis titles do not qualify).
2. **Backgrounds, axes and gridlines** are removed: a mark covering most of the chart; a neutral
   (gray, chroma < 0.04) straight or axis-aligned stroke.
3. **Structure** (precedence: pie/donut, heatmap, bars, lines with their own point markers, scatter,
   area; mixed families are `unknown`):
   - pie/donut: >= 2 closed arc paths whose union is a circle; wedges meet in the center, ring
     segments (two arcs each) are a donut;
   - heatmap: >= 9 equal cells in a >= 3x3 grid;
   - bars: >= 3 rects whose lowest edge per column (or leftmost per row) is one baseline, lengths
     varying; several rects stacked in one column is `stacked-bar`;
   - line: open paths/polylines with >= 4 vertices; points that share a line's color are its vertex
     markers; points of other colors make it `unknown`;
   - scatter: >= 6 small closed shapes that spread over >= 3 rows and >= 3 columns (a row of dots is a
     timeline, a stepper, a rating: not a scatter).
4. **Axis evidence** (0-3): a long neutral axis/gridline; a row of >= 3 short neutral ticks; >= 3
   tick labels (numbers, years, month/day names, `Q1`) **in line** or a row of >= 4 aligned labels. An
   axis, a gridline and a tick run along x or y (a diagonal link, a connector or a hand-drawn stroke is
   not an axis; a path of right angles, like D3's domain with its end ticks, is). A number that sits on a
   data mark (a calendar day in its cell, a percentage on an infographic bar) is a value, not a tick:
   labels whose center is inside a data mark are not counted.
5. **Confidence** `HIGH / MEDIUM / LOW / UNKNOWN`. A Cartesian chart is HIGH with axis evidence >= 2,
   or >= 1 together with a chart word (`chart`, `plot`, `series`, `axis`, `legend`, ...) in a
   class/id/role/aria-label of the SVG or two ancestors (generic UI words such as `top-bar`,
   `progress-bar` or `header-line` are not chart words). A pie/donut is HIGH **only** with a legend
   entry per slice: arcs in a circle are a logo or a gauge as often as a pie. A hint alone is never
   enough; neither is a chart-shaped set of lines.
6. **Blockers**: `animated`, `filter`, `mask` (on the SVG or any element), `foreign-object`,
   `embedded-image`, a gradient on any data mark (it may be a sequential encoding), an over-budget
   walk (`too-large`), nothing laid out (hidden / detached: `unknown`).

```ts
type ChartAnalysis =
  | { status: 'supported'; chart: ChartDescriptor }
  | { status: 'limited'; reason; chart } // recognized, refused (HTML legend, ambiguous legend, pie without legend, > 12 series)
  | { status: 'unsupported'; reason; type; confidence } // chart-like but not ours (type, blocker, low confidence)
  | { status: 'unknown' };
```

**Ownership** (`ownsChart`): M7 owns every HIGH-confidence chart of any type, adapted or not. M5 then
skips its marks. `data-coloradapt-chart-owned` on the `<svg>` records it (informational: the decision
is the callback, taken before M5 plans).

**False positives.** Logos, illustrations, map-like SVGs, diagrams and icons are not owned: without
axis evidence or a legend they stay at `LOW`/`MEDIUM` and are never claimed. The benchmark has 0
false-positive claims (below).

## Series

```ts
interface ChartSeries {
  id;
  index;
  kind: 'line' | 'point' | 'bar' | 'slice';
  label;
  color;
  paintKey;
  classTokens;
  dataSeries;
  marks: number[];
  existing: ExistingEncoding;
  maxVertices;
  memberPoints;
}
```

- `id` is stable for the chart's life: `k:<data-series>` when the author wrote one, else `c:#rrggbb`
  (lines of one color but different dashes: `c:#rrggbb|d:<dash>`); slices of one color get `o:<n>`.
- Same color, same dash, no key: one series (nothing visual tells them apart anyway).
- A mark with a pattern fill identifies by `ref:url(#id)`.

## Legend detection and mapping

Legends are searched **inside the SVG**: a small swatch (box <= 40, dot, or a 8-90 long line sample)
immediately followed, in the same parent, by its text; >= 2 and <= 12 such pairs of one kind and size
with pairwise distinct paints form a legend.

`mapSeriesToLegend` pairs every series with exactly one entry. Evidence, strongest first:
**key** (`data-series`), **token** (a class token naming one series and one swatch; shared tokens like
`legend-swatch` name none), **color** (unique on both sides). Nearest text is never evidence and
order never counts alone. Anything else — two entries for one series, evidence that disagrees, a
legend matching no series, a legend listing only some series — is `ambiguous`, and **nothing is
written**. An entry without a series (a hidden series) is harmless.

Small marks that look like a series' legend swatch (same paint, swatch-sized: a short line, a small
box) but belong to neither the series nor a detected legend — a legend whose swatch and text are not
adjacent in one parent, say — make the chart `limited: legend-ambiguous`: adapting it would leave
that legend as it was. (Swatches of bars and points join their series and are adapted with it.)

An **HTML legend** cannot be synchronized (see "HTML legend guard"): the chart is `limited: html-legend`.

Mapping evidence that disagrees is ambiguous too: a series and a legend entry that both carry a
`data-series` key whose keys differ are never paired by color or token, whatever else matches.

## HTML legend guard

M7 synchronizes a chart with the legend drawn _inside_ its `<svg>`. A legend in HTML cannot be re-skinned
without editing the page's DOM or CSS, which M7 does not do, so a chart that has - or may have - one is
**refused whole**: `limited: html-legend`, nothing written, the chart still owned (M5 keeps off). The one
state this layer must never create is marks with a dash or pattern next to a legend that still shows
plain colors. The guard errs towards refusing: a refused chart that had no legend costs a missing
redundancy cue; an adapted chart with a stale legend costs a wrong one.

Evidence is structural only (never prose next to the chart), found in the _neighbourhood_ - the parent
and the grandparent of the `<svg>` (the siblings of a chart directly in `<body>`), at most
`maxLegendScan` (300) elements per scope - or through `aria-describedby` / `aria-labelledby` /
`aria-owns` / `aria-details` on the chart:

| Evidence                                                                                                     | Counts when                    |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| a name: `legend`, `swatch`, `keyline` (class, id, role, aria-label); `key` or `series` as a class token      | one is enough                  |
| small boxes with their own background (4-24 px), thin colored rules, bordered marks (`border-left` ...)      | >= 2 with distinct colors      |
| `::before` / `::after` boxes or glyph bullets                                                                | >= 2 with distinct colors      |
| colored glyph bullets (a bullet, a square, colored emoji squares); small inline `<svg>` swatches             | >= 2 (distinct colors / count) |
| a label, swatch or rule wearing exactly a series color (text-colored legends have no swatch at all)          | >= 2 distinct series colors    |
| toggle buttons (`aria-pressed` / `-checked` / `-selected`) carrying colors; checkboxes with `accent-color`   | >= 2 distinct                  |
| controls whose `aria-controls` names the chart                                                               | >= 2                           |
| a relation from the chart (`aria-describedby` ...) to an element that is itself a legend by any of the above | one is enough                  |

Not evidence: one swatch (a status dot), gray-only glyphs, the same swatch color twice, status words that
are not series colors, plain buttons, `key-metric` / `monkey` / `keyboard` class names, prose.

HTML legend **mapping** is deliberately not implemented: synchronizing it would mean writing into page
elements M7 does not own, so every variant is refused (real Chromium: 15 variants x above / below /
beside, interactive ones included). Interactive HTML legends (buttons, checkboxes, links, focusable
controls) are therefore never touched: role, name, focus, click and keyboard behavior stay the page's. A
legend three or more ancestors away from the chart is outside the neighbourhood (a documented bound; chart
and legend are in different components there).

Partial mapping inside the SVG is refused whole too (5 series, 4 legend items: `legend-ambiguous`): chart
ownership is atomic.

## Resize and geometry

M4 sees mutations; two things change a chart's encoding without one:

- **Size.** Hatch scale, marker size and layout-based direct labels depend on the rendered size; a CSS
  breakpoint, a resizing container or a `display: none` panel becoming visible mutates nothing.
- **A path's `d` / a polyline's `points`.** The marker-density policy depends on the vertex count.
  Subscribing M4 to `d` for the whole page would flood it with every SVG animation that writes `d`.

`ChartWatch` (`features/charts/chart-watch.ts`) is the bridge: **one `ResizeObserver` and one
`MutationObserver` (`attributeFilter: ['d', 'points']`, `subtree`, scoped to the charts it watches) for all of
them**, never the document. It only signals: `ChartController` binds an invalidation
(`bindChartInvalidation`, wired to `dynamic.invalidate(svg, 'chart')` by the dynamic pipeline) and the pass
is M4's, so work is frame-coalesced and budgeted like any other.

- _Watched_: every chart the layer tracks (owned, adapted or not) and charts whose shapes are not laid out
  (hidden: so showing them - by a media query alone - is noticed), at most `maxWatched` (128). Nothing
  else: not logos, not icons, not the page.
- _Resize_: a size different from the one last read (rounded px) is one invalidation. The first callback
  of an observation, an equal size, and a change that leaves the chart's scale alone cost nothing (the
  idempotent re-application is `chartPassesSkipped`).
- _Geometry_: a `d`/`points` change whose structure (vertex count, arcs, closure, rectilinearity) changed
  is one invalidation; coordinates that move without changing the structure (a transition, a live refresh)
  are not signalled: they cannot change what is written, and the next pass for any reason reads the new
  geometry. A change on one of M7's own nodes is dropped.
- _Lifecycle_: `end()` (adaptation off, `adaptCharts` off, a `normal`/`custom` profile) disconnects both
  observers; a removed chart is released at the next `update`; off -> on again never duplicates a
  subscription (tested: one resize after three cycles is one pass). Gauge `chartWatched`, counters
  `watchSubscriptions`, `resizeSignals`, `geometrySignals`.
- _Loop safety_: nothing M7 writes changes a chart's rendered size or a `d`/`points` attribute.

After a resize the pattern tile is the same number of screen pixels (tested in Chromium: 8 px from 160 to
480 px wide), markers keep their pixel size, legends stay in step, and going back gives byte-identical
`<defs>`. A page that animates a chart's `d` with a _changing vertex count_ every frame gets the chart
re-read once per frame at most (M4 coalesces); that is the known cost of the bridge.

## Existing non-color distinction

Before adding anything, M7 reads what the page already does: dash arrays, marker references, pattern
fills, point shapes (tag, vertex count), direct labels (a text outside the legend, near the series,
in its color or reading as its name — geometry needed, never guessed), and stroke widths differing by

> = 2x. A pair already told apart by one of these is not a conflict. `mixed` (a series whose own marks
> disagree) is never evidence.

## Categorical policy (colors)

The objective is **pairwise** distinguishability, not each series against the background:

1. all series colors are simulated with M2 (protanopia/deuteranopia/tritanopia: Brettel 1997,
   `SUPPORTED_MODEL`; anomalies: Machado/interpolated, `MODEL_ASSUMPTION`/`APPROXIMATION`;
   achromatopsia: luminance, `APPROXIMATION`; `custom`/`normal`: no simulation). M7 passes M2's status
   through and never upgrades it;
2. a pair is **problematic** when the simulated OKLab distance is below `CHART_PAIR_DISTANCE = 0.12`
   (a tuning knob, like the M1 thresholds);
3. a **conflict** is a problematic pair the page does not already tell apart;
4. only series in a conflict are written to; the first of a cluster keeps what the page drew.

Redundancy is preferred to recoloring: **colors are never changed** (`colorAdjustment` is always
`null` in M7; an M3-based minimal adjustment is deliberately not done).

## Encodings and assignment

| Chart      | Channel                    | Catalog (preference order; the first is "as drawn")                                                                                                               |
| ---------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| line       | style, then style x marker | solid, dashed, dotted, dash-dot, long-dash; then 5 styles x 5 markers (circle, square, triangle, diamond, cross) offset so neighbours differ in both              |
| scatter    | silhouette                 | filled circle (as drawn), diamond, triangle, plus, cross, hollow ring - CSS on the point itself (`clip-path` in its own box, or `fill: none` + a stroke), no node |
| bar, slice | pattern                    | solid, diagonal, cross-hatch, dots, horizontal, vertical, diagonal-reverse                                                                                        |

Dash arrays are multiples of the stroke width (`dashed 5:2`, `dotted 1.5:1.5`, `dash-dot 6:2:1.5:2`,
`long-dash 10:3`, minimum unit 1.5): the painted share is kept at 50-77 % because the gaps of a
dashed stroke are not hit-testable (see "Interaction safety").

Assignment (`planChart`, pure and deterministic):

- an encoding is **valid** for a series if it differs, in some non-color channel, from every
  neighbour's effective signature (existing + ours);
- series are processed in order; encodings a series wore before (`prior`, kept per chart) are kept if
  the series is still in a conflict and the encoding is still valid, which is what keeps A and C
  unchanged when B is removed and A, B unchanged when C is appended; a series that no longer needs
  one goes back to what the page drew (so red/green dashed for a deuteranope is not dashed for a
  tritanope); `prior` starts over when the vision profile changes; the rest take the first valid
  catalog entry;
- if some conflict has none left, the whole chart is `limited: encoding-exhausted`: nothing is
  written, and nothing pretends all series are distinguishable;
- post-condition (checked, not assumed): no problematic pair is left without a non-color
  difference.

**Density policy.** A line with more than `maxMarkerVertices` (60) vertices, or one that already has
point markers drawn on it, gets dash styles only. Per chart: <= 500 marker instances
(`maxMarkerVertices x paths`), <= 500 overlay nodes (legend samples only), <= 12 patterns; over any of them the chart is
`limited: too-large`, never half-adapted.

## Application (the browser layer)

Everything of one chart is written together, checked, and kept or rolled back together:

| What                                                 | Where / how                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `data-coloradapt-chart-mark="<chart>.<slot>"`        | the series' marks (lines/bars/slices/...)                                                                                                                                                                                                                                                                          |
| `data-coloradapt-chart-legend="<chart>.<slot>"`      | the legend swatch (a line sample, a box or dot swatch for patterns)                                                                                                                                                                                                                                                |
| one owned `<defs data-coloradapt-chart-node="defs">` | `<marker>`s and `<pattern>`s with ids `coloradapt-<chart>-...`, appended to the `<svg>`; ids never collide with a page id                                                                                                                                                                                          |
| decorative overlays                                  | only a line sample drawn over a box/dot legend swatch of a line series (a swatch cannot show a dash); `aria-hidden`, `pointer-events: none`, `data-coloradapt-chart-node="overlay"`, inserted right after the swatch with its `transform`. Without a box to place it in the chart is not applied (all or nothing). |
| one static CSS portion                               | in the single managed `<style>`: `stroke-dasharray`, `marker-*`, `fill:url(#pattern)`, `clip-path`, ring `fill`/`stroke` per slot, all `!important`                                                                                                                                                                |

- **Legend synchronization (hard requirement).** A line sample takes the same dash array (scaled to
  its own stroke width) and a marker of the same shape; a box/dot swatch of a line series gets a line
  sample drawn over it in the ink that reads on its color; a bar/slice swatch takes the same
  pattern fill; a scatter legend dot gets the same clip or ring as the points. Mark and legend carry the same slot.
- **The browser has the last word.** After the CSS is committed, the first mark of every adapted
  series and every legend swatch is checked against `getComputedStyle` (dash array, marker
  reference, pattern reference). One mismatch (a page `!important` rule or inline `!important`
  that out-ranks ours) rolls the **whole chart** back: `chartNotApplied`, status `limited:
not-applied`, nothing left.
- **Reversible.** Turning adaptation off, the profile to normal, `adaptCharts` off, removing the
  chart: every node, tag, ownership mark and rule is removed, the page's chart is byte-identical
  (tested on the DOM and in real Chromium).
- **Idempotent.** A chart whose plan, targets and artifacts are unchanged is skipped
  (`chartPassesSkipped`); a re-application reuses its own ids. No duplicate patterns, markers,
  overlays or longer dash arrays after refresh x3 or re-render x50.
- **Specificity.** Ours are attribute rules with `!important`: they beat a page's normal class, id
  and inline rules; page `!important` rules/inline `!important` that win are detected, not fought.
- **Pattern/marker geometry** is in user units scaled by the element's screen scale, so hatches
  and markers are the same size in pixels in a scaled viewBox.

## Libraries

Detection is generic DOM/SVG structure; there is no Chart.js, D3, ECharts, Highcharts, Recharts or
Plotly code in M7. D3-style charts (axis groups, `g.legend > g.item > swatch + text`, `data-series`)
are covered by the generic path; Chart.js (Canvas) is reported `canvas-chart` and not adapted. A library
that draws a chart as several `<svg>`s, or legends in HTML, is outside M7.

## Pie, donut, heatmap, sequential and diverging palettes

- **Pie/donut**: adapted only with a complete legend mapping (every slice <-> one entry). Slice
  angles, order and data are never touched; patterns follow the slice across chart and legend.
- **Heatmap**: detected (`heatmap-sequential`) and left alone. Color encodes magnitude; categorical
  redundancy would be wrong, and there is no defensible ordering-preserving alternative encoding in M7.
- **Sequential / diverging / ordered** palettes: a gradient on any data mark is `paint-gradient`; bars or
  slices (4 or more) whose colors read as one ramp are `limited: sequential-palette`. Three shapes: one
  hue (the clearly colored members within a 25-degree spread, or all grays); a _diverging_ palette (two
  hue arms at least 90 degrees apart, each within 40, joined by a pale midpoint - white or a pale yellow -
  or, with five or more colors, two lightness ramps); an _ordered scale_ (lightness rises, or falls, in
  series order _and_ the hue turns one way: viridis, yellow-orange-red, a temperature scale). Categorical
  palettes are sorted by neither. All are left alone: ordering and midpoint semantics are not modelled,
  and categorical patterns on a ramp would suggest categories where the colors mean magnitude. Lines in
  the same colors are categorical by nature and keep the normal policy.
- **Semantic color** (green = good, red = bad): colors, labels and values are never swapped; M7 does
  not interpret the meaning (M6 does not look inside charts either).

## Interaction safety and accessibility

- Original geometry, data, attributes, event handlers and focusability are never edited. Overlays are
  `pointer-events: none`, `aria-hidden`, not focusable, carry no title/text (the one kind of overlay is
  a legend sample line); scatter shapes are CSS on the points, so they follow the points when the page
  moves, fades, hides or removes them; legend controls are
  neither wrapped nor replaced (click, Enter/Space and focus stay the page's).
- Real Chromium: hover + tooltip, click handlers, legend toggle by mouse and keyboard, focus order,
  pattern-filled bars and clipped points still receive the pointer; a series toggled off and on
  keeps its identity; the accessibility tree (`ariaSnapshot`) is identical with and without M7.
- **Known limitation:** the gaps of a dashed stroke are not hit-testable (browser behavior, as for any
  dashed line). A tooltip bound to a thin line is slightly harder to point at where M7 added a dash
  (painted share 50-77 %; measured in Chromium: between 45 % and 95 %). The same holds for a legend line
  sample that took a dash: a click on a gap misses the sample; the label and the rest of the item are
  untouched. Bars and slices keep their full hit area; a clipped scatter point loses the corners it was cut
  from.
- **Investigated in M7.R1 and left as a limitation** (improve only without overlays that change
  semantics): a transparent wider stroke _behind_ the visible one would be a new node that is the event
  target instead of the page's path (`event.target`, `:hover` rules, handlers bound on the path, the
  accessibility tree and `elementFromPoint` would all differ). `pointer-events: bounding-box` is not
  implemented by Chromium, and a solid hit stroke on the page's own element would undo the dash. A clipped
  scatter point's missing corners follow the same argument. Nothing in M7 changes pointer behavior for
  cosmetic completeness.

## Canvas

Canvas charts (Chart.js, most ECharts) are **detected and never adapted**:

- `classifyCanvas` reads names (class, id, role, aria-label, data-* names, two ancestors): chart words
  -> `canvas-chart`; game / drawing / signature / editor / video / map ... words or no evidence ->
  `canvas-unknown`. Counters `canvasCharts` / `canvasUnknown`.
- No `CanvasRenderingContext2D` patching, no pixel reading, no overlay. Games, editors, maps and
  video draw through it. A canvas is untouched byte for byte (tested: pixel hashes, native
  prototype functions).

## Dynamic behavior

Through M4 only: a series added/removed (regions inside the SVG are re-analyzed as the SVG), a data
refresh (`d` changes do not wake M7; identities do not depend on data), a recolor/theme change
(`stroke`, `fill`, class, style), `stroke-dasharray`/marker changes by the page (a chart the page now
tells apart itself loses ours), a replaced chart (the old one's artifacts and rules go with it; the
new one is adapted the same way — encodings are deterministic), a legend update, a chart that becomes
visible later (nothing laid out means nothing is said). A series hidden by the page leaves the
analysis and its encoding is remembered for when it returns. A chart that is resized, whose path
structure changes, or whose legend neighbourhood changes is re-read through the bridge and the
neighbourhood rule above. A page that deletes our `<defs>`
gets the chart re-applied; a page that deletes our `<style>` gets it back (M4's repair, with chart
CSS included).

Identity drift is bounded: `prior` is per `<svg>` element (up to 64 series ids). A series whose color
changes is a new series (its id is its paint); a series with a `data-series` key keeps its encoding
through any change of color or geometry.

Identity policy, deterministic and tested (unit and Chromium): `A B -> A B C`: A and B keep what they
wore, C takes the first valid catalog entry. `A B C -> A C`: A and C keep theirs. `A C -> A B C`: B returns
to the identity it had (remembered), as long as the chart lives and the profile is the same. The profile
changing starts over (`protanopia -> deuteranopia -> tritanopia -> protanopia` gives, at each step, what a
fresh start would give; nothing of the previous profile is left). A path growing past the marker density
limit loses its marker and takes the first valid dash; shrinking back keeps that dash (a valid encoding
is never changed for preference): the same input and history always give the same output. **M7
encodings are independent of the M3 adaptation strength** (`adaptationStrength` is never read; tested in
jsdom and Chromium).

## Settings

`adaptCharts` (default **true** after validation; see below). Migration (tested in unit, store and
Chromium): field absent -> default; explicit `true`/`false` -> never overridden (settings saved by
M1-M6 hold `false`, so upgrading users keep charts off until they enable it in the options page);
non-boolean -> default. Inactive for `normal` and `custom` profiles. The per-site profile does not
carry `adaptCharts` into the effective settings in M7.

## Limits (all structural, in `shared/constants/charts.ts`)

| Constant             | Value  | Meaning                                                              |
| -------------------- | ------ | -------------------------------------------------------------------- |
| `maxMarks`           | 2000   | shapes + texts read per `<svg>`; 2000 fit, the 2001st is `too-large` |
| `maxDescendants`     | 6000   | elements walked per `<svg>`; 6000 fit, the 6001st is `too-large`     |
| `maxSeries`          | 12     | more is `limited: too-many-series` (also the pattern budget)         |
| `maxLegendItems`     | 12     | a larger swatch + text cluster is data labels, not a legend          |
| `maxMarkerVertices`  | 60     | above it a line gets dash styles only                                |
| `maxMarkerInstances` | 500    | per-vertex marker draws one chart may request                        |
| `maxOverlayNodes`    | 500    | overlay nodes (legend samples) per chart                             |
| `maxMarksPerPass`    | 20 000 | summed over regions; the rest is handed back to M4 whole             |
| `maxCanvasPerPass`   | 50     | canvases classified per pass                                         |
| `maxLegendScan`      | 300    | elements the HTML legend guard looks at, per scope around one chart  |
| `maxWatched`         | 128    | charts the resize / geometry bridge watches at once                  |

Boundaries are exact and tested (no timing involved): 12 series fit and 13 are `too-many-series`; 500
marker instances fit and 510 are `too-large`; 2000 / 2001 marks; 6000 / 6001 descendants.

Thresholds are engineering choices (why these numbers: docs/PERFORMANCE.md), not standards. Nothing
is a wall-clock value; correctness never depends on time. An SVG with fewer than 3 shapes is never
read.

## Diagnostics (no telemetry; never leave the device)

`DynamicDiagnostics.charts`: gauges `chartsDetected`, `chartsSupported`, `chartsUnsupported`
(including `limited`), `seriesAnalyzed`, `seriesAdapted`, `legendsMapped` (of the charts tracked right
now); counters `patternsCreated`, `markersCreated`, `overlaysCreated`, `chartNotApplied`,
`canvasCharts`, `canvasUnknown`, `chartPasses`, `chartPassesSkipped`, `marksScanned`; leak gauges
`chartOwners`, `chartDefs`, `chartOverlays`, `chartRules` (read from the document, so a leak cannot
hide), `chartPending` (always 0 once a pass finished). M7.R1 added the bridge's gauge `chartWatched` and
counters `watchSubscriptions`, `resizeSignals`, `geometrySignals`, and the structural counters
`legendItemsScanned` and `seriesEvaluated`; the incremental passes and full rescans a chart caused are
M4's own (`incrementalPasses`, `fullRescans`).

## Validation

| Suite                                      | What                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/core/charts` (111)                  | classification (supported, policy types, confidence, non-chart shapes), legend/mapping, pairwise, plan, collisions, capacity, identity stability; R1: append / remove / return, profile cycle, exhaustion, an invariants grid (3 types x 6 palettes x 3 profiles), exact boundaries, ordered palettes, pie / donut traps, axis evidence                                                          |
| `tests/features/charts` (170)              | controller + pipeline in jsdom with a CSS/layout stand-in: reversibility, idempotency, retention, rollback, ownership, M4 flow, canvas; R1: the bridge (fake `ResizeObserver`, real `MutationObserver`), 63 HTML-legend cases (21 variants x 3 placements), dynamic legends, 100 charts x 3 cycles, the pipeline around the bridge                                                               |
| `tests/benchmarks/chart-benchmark.test.ts` | 150 scenarios (see "M7.R1 validation")                                                                                                                                                                                                                                                                                                                                                           |
| `e2e/chart-*.spec.ts` (190)                | real Chromium: pixels (dashes, markers, patterns, glyphs, legend), reversibility, idempotency, accessibility tree, hover / click / legend / keyboard, dynamic series, CSS specificity matrix, canvas, profiles, limits; R1: 15 HTML-legend variants x 3 placements, resize / lifecycle / geometry / identity / profiles, library-shaped output, 16 curated non-charts, interaction after resizes |

## M7.R1 validation

What R1 changed in the code (everything else it found was a test):

1. **HTML legend guard** (`html-legend.ts`): wider evidence (pseudo-elements, borders, glyphs, text colored
   like a series, toggles, `aria-controls`, relations), the legend neighbourhood as a re-read region, and
   `departures` from M4 so a legend that is moved away is noticed too.
2. **Resize / geometry bridge** (`chart-watch.ts`) and `d`/`points` structure invalidation.
3. **Mapping**: keys that disagree are ambiguous.
4. **Ordered palettes**: diverging and ordered ramps are refused like sequential ones.
5. **False positives found in real Chromium and fixed**: a network diagram (diagonal links counted as an
   axis, node labels as ticks), a calendar grid (day numbers in cells counted as tick labels) and an
   infographic (percentages above bars counted as ticks) were claimed once their `<svg>` carried a `chart`
   id; a timeline (a row of dots) was a "scatter". Axis evidence now needs axis-aligned lines, labels in
   line and outside the marks; a scatter needs two dimensions.
6. **Exact budgets**: `maxMarks` counted one shape too many.

Benchmark (`tests/benchmarks/chart-benchmark.test.ts`, structural only, with the jsdom engine; report in
`benchmark-report/chart-benchmark.json`, git-ignored):

```text
scenarios                        150   (143 charts + 7 canvases)
supported                         69   54 adapted, 15 already distinguishable (nothing added)
refused (unsupported / limited)   51   32 legend-ambiguous / html-legend, 2 encoding-exhausted, the rest by policy
false-positive traps              23   0 owned, 0 adapted
legend-sync failures               0
series analyzed                  377
problematic pairs before         528   355 in charts M7 had a plan for, 173 in charts it refuses (left as drawn)
  resolved by dash               272
  resolved by marker              32
  resolved by pattern             32
  already distinguishable         19   by the page's own channels
unresolved pairs after             0
```

Categories: safe adaptation, supported, multi-profile (protanopia 9, tritanopia 5, deuteranopia 124,
anomalies 5), already distinguishable (13), external legend (25: 21 HTML-legend variants, placements, a
neutral control), ambiguous legend (6), false positive: SVG (19), pie / donut traps (4), sequential (7),
dense (8: the exact limits), responsive (10), dynamic (11), interactive legend (3), unsupported complex
chart (7), canvas (7). Structural counters of the run: 7657 marks scanned, 511 series evaluated, 389
legend items scanned, 184 chart passes, 46 patterns and 35 markers created.

Real Chromium (`e2e/chart-*.spec.ts`, 190 tests): HTML-legend variants refuse the chart whole and leave the
legend byte-identical; resize keeps hatches and markers at their pixel size (8 px tiles from 160 to 480 px
wide), a size change is exactly one incremental pass and a repeat is none; 20 -> 200 -> 20 vertices is
replanned deterministically; off / on three times leaves one subscription; 100 charts x 3 cycles leave 0
owners, defs, markers, patterns, rules and subscriptions; profile cycles give what a fresh start gives;
M3 strength changes nothing; D3-shaped output is adapted with its legend in step, Recharts-, Highcharts-
and Plotly-shaped output (HTML legend; legend text before its swatch) is claimed and left whole; 16
curated non-charts are never owned; the accessibility tree and tab order are identical with and without M7.

What the library-shaped fixtures say: generic structure survives nested groups, margins, clip paths,
transforms, generated classes and a separate legend group; the refusals are the policy working (an HTML
legend; a legend whose text precedes its swatch is not a swatch + text pair, so the swatches are
"orphans" and the chart is `legend-ambiguous`). No library is imported by production code, and none by the
fixtures.

## Known limitations

- Dashed lines have unhittable gaps (above).
- HTML legends (any variant: the chart is refused whole), area, stacked bars, heatmaps,
  sequential / diverging / ordered charts, Canvas charts, charts with filters / masks / animations:
  detected, not adapted. A legend three or more ancestors away from the chart is outside the guard's
  neighbourhood.
- Libraries whose legend text precedes its swatch (Highcharts, Plotly shapes) or whose legend is HTML
  (Recharts) are claimed and refused, never half-adapted; a chart drawn as several `<svg>`s is outside M7.
- A chart whose series colors are all gray or all identical cannot be told from a pattern-filled one
  by color; identity then relies on keys and existing channels (`encoding-exhausted` when none is left).
- Legend entries matching ticks (neutral series with ticks of the same color) are ambiguous by
  design: the chart is left alone.
- A `d` change that keeps the path's structure (same vertex count, arcs, closure) is not signalled: the
  chart is re-read at the next pass for any other reason. A chart that was never visible while ColorAdapt
  looked, and was never a tracked chart, is only seen when a pass reaches it.
- A dashed legend line sample misses clicks on its gaps (the label is the reliable target).
- At most 128 charts are watched for resize / geometry at once.
- Direct-label detection needs layout; without it no series is called labelled.
- One SVG is one chart: a dashboard drawn in one `<svg>` with several plots is `unknown`/mixed.
- Chromium only is verified; Firefox runtime is NOT_VERIFIED.
