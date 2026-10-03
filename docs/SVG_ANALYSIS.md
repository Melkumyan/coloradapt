# Inline SVG analysis and adaptation (M5)

M5 answers one question: **can ColorAdapt detect and safely adapt the visible
colors of inline SVG UI elements, with the same safety model as M1–M4?**

It does that for the simple, common case — one visible paint on a transparent
background: icons, chevrons, hamburger/search/close glyphs, toolbar and social
icons, and SVG text — and it classifies everything else instead of guessing.

> Safe SVG adaptation > coverage > aggressive recoloring. If an SVG is too
> complex to adapt safely, `unsupported` is the correct answer.

Not in M5: semantic interpretation (M6), charts and data visualization (M7),
Canvas, raster images (M8), AI, developer audit, Shadow DOM, iframes. M5 is an
engineering milestone; M2 stays PARTIAL, M3 and M4 stay PASS.

## Layout

```text
src/core/svg/
  classification.ts   element roles, SVG namespace, outermost <svg>
  paint.ts            SvgPaint / RawPaint, computed fill/stroke parsing, paint servers
  inheritance.ts      the style probe: told-apart currentColor / inherited / explicit
  scan.ts             one bounded walk over a unit; <use> targets; blockers
  analyzer.ts         batch analysis -> one ElementDescriptor per <svg>
  verify.ts           "does every visible paint read the planned color?"
  animation.ts        elements a CSS / Web animation drives a paint property on
src/domain/models/svg.ts   SvgUnitInfo, reasons, SvgDiagnostics (plain data)
src/shared/constants/svg.ts SVG_BUDGET (structural thresholds)
```

The SVG layer is isolated: the generic DOM analyzer only decides _which_
elements are SVG units and hands them over as one batch; there are no SVG
conditionals in the HTML path. The optimizer, `AdaptationPlan`, the stylesheet
manager and the M4 pipeline are reused.

```text
outermost <svg>
  -> scan (bounded walk, <use> content)            core/svg/scan.ts
  -> paint parsing + classification                core/svg/paint.ts
  -> one style probe for the batch                 core/svg/inheritance.ts
  -> effective paint over the page background      core/analysis/background-resolution.ts (M1.R1)
  -> ElementDescriptor { colorPair, svg: SvgUnitInfo }
  -> M2 simulation + M3 optimizer (unchanged)      core/adaptation
  -> AdaptationPlan (one rule per paint owner)
  -> injected stylesheet, read back from the browser, verified as a group
```

## The unit: one outermost `<svg>`

Analysis works on **outermost inline `<svg>` elements**. Everything inside —
shapes, text, groups, nested `<svg>`, `<use>` — belongs to the unit and is never
a separate descriptor (a shape whose class says `tag` or `badge` is not a badge).
An `<svg>` inside HTML inside a `<foreignObject>` is its own unit.

A standalone SVG document (the browser showing `icon.svg` itself) is not inline
SVG: it has no `<head>` for our `<style>` and is skipped.

A hidden `<svg>` (`display: none`, `visibility: hidden|collapse`, `opacity: 0`) and
an `<svg>` that paints nothing are not units.

### Element roles

`classifySvgElement` gives each element a coarse role. It describes what the
element does in the paint model, never what it _means_.

| Role           | Elements                                                           |
| -------------- | ------------------------------------------------------------------ |
| `icon`         | an outermost `<svg>`                                               |
| `container`    | nested `<svg>`, `g`, `a`, `switch`                                 |
| `shape`        | `path`, `circle`, `ellipse`, `rect`, `line`, `polyline`, `polygon` |
| `text`         | `text`, `tspan`, `textPath`                                        |
| `use-instance` | `use`                                                              |
| `unknown`      | everything else (`defs`, `symbol`, `foreignObject`, HTML, …)       |

`defs`, `symbol`, `clipPath`, `mask`, `pattern`, `marker`, gradients, `filter`,
`style`, `title`, `desc`, `metadata`, `script` and `stop` are never painted where
they stand and are not walked (a `<symbol>` is walked only as the target of a
`<use>`). Descriptor roles are `icon` (shapes, or shapes and text) or `text`
(only text).

`aria-hidden`, `role="img"`, `aria-label` and `<title>` are metadata. They do not
make an icon skip adaptation (a decorative-looking icon still carries UI
affordance) and they do not make one eligible; M6 will use them.

## Paint model

Computed styles are the source of truth, so the cascade (presentation
attributes, class rules, ids, inline styles) is respected exactly.

```ts
type SvgPaint =
  | { kind: 'none' }
  | { kind: 'solid'; color: ColorValue }
  | { kind: 'currentColor'; color: ColorValue }
  | { kind: 'paint-server'; reference: string }
  | { kind: 'context'; value: 'context-fill' | 'context-stroke' }
  | { kind: 'unsupported'; value: string };
```

- `none` (including a fully transparent color) paints nothing.
- A **missing `fill` is not transparent**: the default is black, and it is a real
  paint. A missing `stroke` is `none`.
- `url(#id)` is a paint server; `parsePaint` accepts quoted/unquoted forms and a
  fallback color (`url(#g) red` is still a paint server).
- `context-fill` / `context-stroke` and anything unparseable are named, not guessed.

### fill and stroke

Both are read per painting element. A stroke counts only when `stroke-width > 0`
and `stroke-opacity > 0`; a fill only when `fill-opacity > 0`. Elements with
`visibility: hidden`, `display: none`, or `opacity: 0` (own or on an SVG ancestor)
paint nothing. A stroke-only icon (`fill: none`) is an ordinary single paint.

### currentColor

Computed styles resolve `currentColor` to plain `rgb(...)`: `fill="currentColor"`,
`fill="rgb(200,0,0)"` and a `fill` inherited from the `<svg>` all read the same.
Which declaration _owns_ the paint decides which rule can change it, so it is
found by experiment, not by comparing values — the **style probe**.

For one synchronous style flush the probed element (an outermost `<svg>`, or the
parent of a `<use>` target) gets three distinct sentinel colors for `fill`,
`stroke` and `color`. A descendant whose computed `fill` then reads

| it reads …           | meaning                                    |
| -------------------- | ------------------------------------------ |
| the `fill` sentinel  | it inherits `fill` from the probed element |
| the `color` sentinel | it paints with `currentColor`              |
| anything else        | it declares its own paint ("explicit")     |

(`stroke` likewise.) The probe is added to the injected `<style>` on top of the
page's original styles, read, and removed within the same task; nothing is
painted in between, and transitions are suppressed on the probed subtree so a
page's own `transition: fill` can neither blur the reading nor start fading when
the probe leaves. **One probe serves a whole batch** of SVGs (one style flush in,
one out), and none is applied when no unit can use one.

"Inherits `fill` from the `<svg>`" is not yet an owner: the `<svg>`'s own paint may
itself be `currentColor` — `<svg fill="none" stroke="currentColor">` is the usual
icon-library pattern (Heroicons, Lucide, Feather), as is `.icon { fill: currentColor }`
or the same declared on an ancestor. A **second, color-only probe** (run only when some
paint inherited, again once per batch) replaces just `color` on the `<svg>` (or on the
`<use>`): an inherited paint that then reads the `color` sentinel follows
`currentColor`, one that keeps its own value does not (an explicit `fill="#c0392b"` on
the `<svg>` that merely equals the current color stays a `fill` rule). So these icons
are adapted through `color` as well, not by materializing `stroke`/`fill`. Without a probe
(`probeStyles` absent) nothing can be told apart, so SVGs are analyzed as
`partial` (`derivation-unknown`) and never adapted.

### Inheritance

Paint inherits through `svg`, `g` and shapes like any inherited CSS property; it
is **not** background inheritance. The unit's _background_ is the page behind the
`<svg>` (its own CSS background and its ancestors, M1.R1); inner shapes never
form each other's background, and no vector scene is composited.

## Ownership: which rule changes a paint

One paint can be reached through several declarations, so M5 defines exactly one
owner per use of it. An adaptation never edits a source attribute or `style`; it
is an injected rule that is removed to restore the page.

| The paint is …                                                                          | The rule is …                                    |
| --------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `currentColor` (fill or stroke or both, any shapes)                                     | `color` on the **`<svg>`**                       |
| inherited `fill`/`stroke` that is itself `currentColor` (`<svg stroke="currentColor">`) | `color` on the **`<svg>`**, once                 |
| inherited `fill`/`stroke` with a literal color (`<svg fill="#c0392b">`)                 | `fill`/`stroke` on the **`<svg>`**, once         |
| declared on a shape, its group, a class, an id, inline                                  | `fill`/`stroke` on **each such shape**           |
| inside a `<use>` instance, via `currentColor`                                           | `color` on the **`<use>`** element               |
| inside a `<use>` instance, inherited from the `<use>`                                   | `fill`/`stroke` on the **`<use>`** element       |
| declared by the `<use>` content itself                                                  | **none**: shared by every instance → unsupported |

Consequences:

- **`currentColor` is never materialized as `fill`.** The page's `color` stays the
  source; the `<svg>` gets one `color` rule (fill and stroke both `currentColor`
  are one rule, not two). A path with its _own_ `color` cannot follow the `<svg>`:
  it is classified explicit and owns a `fill` rule on the shape.
- **Icon buttons.** `<button style="color:red"><svg><path fill="currentColor"/></svg>Label</button>`:
  the button's text is adapted by M3 (`color` on the button), the icon by M5
  (`color` on the `<svg>`). Both run the same optimizer on the same pair and
  produce the same color (they are memoized on the pair); the rules target
  different elements, so they cannot fight. If the icon sits on a different
  background than the text, each gets its own, correct answer.
- **Deduplication.** Rules are keyed by (target element, property). Shapes that
  inherit one `fill` produce one rule on the `<svg>`; two paths with the same
  explicit color produce two rules with the same value.
- **Group semantics.** All rules of one SVG share an _owner_ (the `<svg>`). They
  are replaced, verified and dropped together (see Application).

## Opacity

M1.R1's group-compositing model applies unchanged. The visible color of a paint
is its color alpha × `fill-opacity`/`stroke-opacity` × the `opacity` of the
element and each SVG ancestor up to (not including) the `<svg>`, composited as
one group over the `<svg>`'s own chain (its `opacity`, its background, the page).
Nothing is applied twice.

Adaptation writes one opaque color and cannot reproduce a composite, so — as for
HTML text whose `color` differs from its effective foreground (M3) — a
**translucent unit is analyzed but not rewritten**: `partialReason:
'translucent-paint'`, status `partial`, outcome `unresolved`. Its effective color
is still reported (so conflicts are detected), and `opacity`, `fill-opacity`,
`stroke-opacity`, group opacity, alpha colors and a translucent page ancestor are
all covered. Two paints that differ only by opacity are two paints.

## Single paint, multi-paint, complexity

Automatic adaptation requires **exactly one distinct effective paint**
(`paintCount === 1`), counted over fills, strokes, text and `<use>` instances
after compositing. Everything else is `unsupported`, with a reason:

| Reason             | When                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `multi-paint`      | 2 … `maxDistinctPaints` distinct paints                                                          |
| `complex-svg`      | > `maxDistinctPaints` paints, > `maxPaintedElements`, > `maxDescendants`, deeper than `maxDepth` |
| `chart-like`       | ≥ 2 paints with ≥ 3 text elements and ≥ 3 shapes (label only; M7 owns charts)                    |
| `paint-gradient`   | `fill`/`stroke` is a linear/radial gradient                                                      |
| `paint-pattern`    | `fill`/`stroke` is a `<pattern>`                                                                 |
| `paint-server`     | any other `url(...)` (missing, external, mesh gradient) or unparseable paint                     |
| `paint-context`    | `context-fill` / `context-stroke`                                                                |
| `filter`           | `filter` on the `<svg>` or any rendered element in it                                            |
| `mask`             | `mask` / `mask-image`                                                                            |
| `blend-mode`       | `mix-blend-mode` ≠ `normal`                                                                      |
| `marker`           | `marker-start/mid/end`                                                                           |
| `foreign-object`   | `<foreignObject>` (its HTML is analyzed as HTML)                                                 |
| `embedded-image`   | `<image>`                                                                                        |
| `animated`         | SMIL (`animate`, `set`, `animateColor`) or a CSS/Web animation of a paint property               |
| `use-external`     | `<use href="file.svg#id">`, `data:` …                                                            |
| `use-unresolved`   | missing target, reference cycle, nested `<use>`                                                  |
| `use-shared-paint` | the referenced content declares its own paint                                                    |

When several apply, the first of this list (top to bottom, with the blockers
before the paint-server reasons, `use-*`, then complexity, then `multi-paint`)
is reported, deterministically.

Why multi-paint is unsupported: recoloring A and B independently can make them
the same color under a vision profile (a two-tone status icon), and keeping them
apart needs a pairwise optimization M5 does not have. Safety over coverage.

**Thresholds** are centralized, structural engineering thresholds in
`shared/constants/svg.ts` (`SVG_BUDGET`) — not standards, not wall-clock values:

| Constant                   | Value | Meaning                                                    |
| -------------------------- | ----- | ---------------------------------------------------------- |
| `maxDescendants`           | 200   | elements visited in one `<svg>` (plus its `<use>` content) |
| `maxPaintedElements`       | 24    | painted shapes + text + `<use>` instances per `<svg>`      |
| `maxUseContentElements`    | 24    | painted elements inside one `<use>` target                 |
| `maxDistinctPaints`        | 4     | beyond this: `complex-svg` (2–4: `multi-paint`)            |
| `chartLikeMinTextElements` | 3     | label threshold for `chart-like`                           |
| `chartLikeMinShapes`       | 3     | label threshold for `chart-like`                           |
| `maxDepth`                 | 32    | nesting depth followed                                     |

A walk that hits a limit says so (`complex-svg`); a partial scan is never
returned as if it were whole. Worst-case work is bounded structurally:
`maxElements` (1500, M1) units per pass × `maxDescendants` per unit.

### Gradients and patterns

Detected and classified, **never recolored**: a gradient or pattern paint makes
the whole unit unsupported, even next to solid shapes. A gradient is not a solid
color and is never treated as one. `clipPath` alone does not change color and does
not block a simple paint; `mask` does.

## `<use>` and `<symbol>`

The key architectural test: **per-instance adaptation must never touch the
shared `<symbol>`.** Instance trees are not part of the DOM and
`getComputedStyle` cannot reach them; a computed style read on the symbol's own
shapes describes the _definition's_ context (a hidden sprite), not the instance.
So instances are analyzed from the `<use>` element's context:

1. `use` is resolved: `#id` in the same document only (`href`, or legacy
   `xlink:href`). `file.svg#id`, absolute URLs and `data:` URIs are
   `use-external` — no host permission is added for them. Missing targets,
   reference cycles (a target that contains its own `<use>`) and a `<use>` nested
   in referenced content are `use-unresolved`.
2. The referenced content is walked as content; the **probe goes on the target's
   parent** and tells, per shape and per property, whether the paint is
   _inherited from the `<use>`_, follows _`currentColor`_ (through the instance's
   `color`), or is _declared by the content_.
3. Inherited / `currentColor` paints take their color from the `<use>` element's
   computed `fill`/`stroke`/`color` (that is what the instance inherits), and the
   rule goes on that `<use>` element: per-instance by construction. The shared
   symbol and its content are never tagged, never targeted by a rule, never mutated.
   (The probe needs a handle on the target's parent — typically `<defs>` — and tags it with
   the same inert `data-coloradapt-id` attribute every analyzed element gets. No rule ever
   targets it.)
4. Content that declares its own paint (an attribute or a CSS rule — the probe sees
   both) is shared by every instance. M5 does not mutate it and does not try to
   fork it: `use-shared-paint`, unsupported.

Instances on different backgrounds therefore get different, correct answers from
the same symbol. Because instances are invisible to `getComputedStyle`, the real
browser tests verify them from rendered pixels.

An SVG that defines referenceable content is re-analyzed together with the SVGs
that instantiate it when it changes (see Dynamic integration).

## Application

Same strategy as M3: injected stylesheet rules, never source edits.

```css
[data-coloradapt-id='ca-1b']:not(#coloradapt-specificity) {
  fill: #a1150b !important;
}
```

- Specificity (1,1,0) + `!important`: out-ranks presentation attributes, class
  and id rules (normal or `!important`) and inline styles without `!important`.
  An inline `!important` wins and is detected, not fought.
- A rule is identified by (element, property): one shape may carry both `fill` and
  `stroke`. The sheet is regenerated from a rule map; no rule is ever duplicated.
- Shapes are tagged (`data-coloradapt-id`) only when they are rule targets of an
  adaptable unit. Shapes of unsupported units, and every `<symbol>` with its content,
  stay untagged.
- **Verification is the browser's.** After a commit the computed `fill`/`stroke`/
  `color` of every rule target is read back; then the _unit_ is verified: every
  visible solid paint of every shape in the `<svg>` must read the planned color
  (so a shape with a local declaration the `<svg>` rule cannot reach is caught).
  A unit with any failure is **not applied as a whole**: all of its rules are
  dropped and it is counted once in `notApplied`. `<use>` instances are covered by
  the rule-level check on the `<use>` element (the probe established that the
  content follows it).
- Reversible: OFF removes the one `<style>`; original computed `fill`, `stroke` and
  `color` return exactly. Idempotent: analysis always runs with the stylesheet
  suspended (`withOriginalStyles`); refreshing never compounds.
- Model confidence (`SUPPORTED_MODEL` … `UNSUPPORTED`) is carried from the vision
  profile into every SVG change unchanged, as for HTML.
- `no-safe-candidate` is propagated as is: no replacement is forced.

Adaptation is gated by `settings.adaptSVG` (default **on** since M5, with a
checkbox in the options page) and `improveUIColors`; with either off the SVG is
analyzed and left alone.

## Dynamic integration (M4)

There is no SVG observer. Everything goes through the M4 mutation pipeline:

- `fill`, `stroke`, `fill-opacity`, `stroke-opacity`, `stroke-width`, `opacity`,
  `color`, `display`, `visibility`, `filter`, `mask`, `mix-blend-mode` are
  observed attributes, style-affecting **only on SVG elements** (on HTML
  elements they are not delivered work). `href` on SVG elements (a `<use>` target)
  counts. Inline `style` changes to `fill`/`stroke`/`mask`/`marker`… are relevant;
  `transform` and the like are not.
- A change **anywhere inside an inline SVG** — added or removed child, class, paint
  attribute, `<use>` href, `<text>` content becoming empty/non-empty — resolves to
  one region: the outermost `<svg>`, analyzed whole (`self` scope; `subtree` only
  when the `<svg>` itself was added or restyled, since a `foreignObject` may hold
  HTML). Removing a child needs the parent, so `NODE_REMOVED` records it.
- An SVG that defines ids (a sprite, a symbol library) also queues the SVGs whose
  `<use>` points into it, so a late-arriving sprite brings its instances to life
  and a restyled symbol re-derives every instance. An SVG without ids inside costs
  no document-wide lookup.
- Changing the page-level `color` source (a class or style on a button or ancestor)
  is an ordinary subtree invalidation; the icon below it is re-derived.
- A replaced SVG (old removed, new inserted) leaves exactly one rule: removing an
  SVG forgets its unit and every shape id tagged under it, and an owner's rules
  are replaced as a group, so what a unit no longer needs is pruned.
- The observer cannot see namespaced attributes: a legacy `xlink:href` change is
  never delivered (documented limitation); the next full refresh picks it up.
  `:hover`/`:focus` source changes are not DOM mutations (as in M3).

## The `adaptSVG` setting (M5.R1)

`adaptSVG` defaults to **true** (`DEFAULT_USER_SETTINGS`): a fresh install adapts simple, safe
monochrome SVGs and skips everything else. Turning it on does not widen what is safe: multi-paint,
paint servers, masks, filters, charts, translucent paints and shared `<use>` content stay
unsupported regardless (real-Chromium checks with 2 to 6 distinct colors and the five paint-server
kinds). Off, SVGs are still analyzed and reported but never adapted; HTML inside a
`<foreignObject>` is HTML and keeps adapting as such. Toggling off and on again re-analyzes from
the original colors and yields byte-identical rules (no stale rule, no duplicate owner state).

**Stored settings and migration.** `parseUserSettings` reads every field independently
(`src/infrastructure/storage/schema.ts`):

| Stored value of `adaptSVG`                  | Effective value                        |
| ------------------------------------------- | -------------------------------------- |
| absent (settings saved before M5)           | `true` (the product default)           |
| `true` / `false`                            | exactly that; never overridden         |
| anything else (string, number, `null`, ...) | `true`; the rest of the object is kept |

The consequence worth knowing: before M5 the field existed as an unused `false`, so a user whose
settings were already persisted _with_ that field keeps `false` until they tick the options
checkbox; users who never saved it get SVG adaptation. No schema version bump was needed, and no
stored setting is rewritten on load.

## Diagnostics

`DynamicDiagnostics.svg` (local, never sent anywhere) holds gauges of the tracked
units: `svgAnalyzed`, `svgAdapted`, `svgUnsupported`, `svgNotApplied`,
`svgPaintServers`. The last analysis (`GET_ANALYSIS`) carries each unit's
`SvgUnitInfo` (reason, paint count, targets).

## Semantic cues (M6)

A page-provided inline SVG next to a state (a warning triangle beside red text) is an _existing
non-color cue_ for the semantic layer: it sees the `<svg>` (or `<img>`, `role="img"`, an icon-font
class) among the element's descendants and adds nothing. M6 does not change this module's logic;
`<svg>` subtrees are skipped by the semantic walker (M5 owns them). See
`docs/SEMANTIC_ACCESSIBILITY.md`.

## Limitations (documented, not hidden)

- **Multi-color artwork is never adapted**, and neither are gradients, patterns,
  masks, filters, blend modes, markers, embedded images, `foreignObject`,
  animated paints, charts. Two-tone icons are unsupported on purpose.
- **Translucent paints are analyzed, not adapted.**
- **`<use>` content that declares its own paint is unsupported** (no per-instance
  fork of shared content). Its instance pixels are untouched.
- **External sprites** (`<use href="icons.svg#x">`), **`<img src="x.svg">`** and
  **CSS `background-image: url(x.svg)`** are not inline SVG: classified or left to
  M1/M8; no host permissions are added.
- **Shadow DOM and iframes** are not analyzed.
- **Pseudo-states.** An adapted icon keeps its adapted color on `:hover`/`:focus`
  (as for M3 text); inline `!important` on a paint is not adaptable.
- **Per-icon, not per-context optimization.** Each unit is optimized against its
  own resolved background; an icon drawn over a photo or a gradient is
  `unsupported` by M1's background policy.
- **Firefox.** The build is verified; the runtime is not automated. Firefox
  serializes some computed SVG values differently (for example paint servers and
  `context-*`), which would fall into the unsupported/unparseable paths rather than
  misbehave, but this is **not verified** and must be checked in the next browser
  validation round.
- **Legacy `xlink:href`** on a `<use>` resolves like `href` during analysis, but a _mutation_ of
  the namespaced attribute is not delivered by the observer's `attributeFilter` (verified in
  Chromium). It is not incrementally detected; a full `REFRESH_ADAPTATION` produces the correct
  state. Both facts are asserted in `svg-dynamic.spec.ts`; no compatibility layer is planned.
- **Standalone SVG documents** are skipped.

## Testing

- `tests/core/svg/*` — paint parsing, probe, classification, the analyzer on a
  miniature CSS engine (`fake-engine.ts`) that models inheritance, `currentColor`,
  the probe and ColorAdapt's own rules: fill, stroke, `currentColor`, inheritance,
  opacity of every kind, text, paint servers, filters/masks/blends, multi-paint,
  complexity thresholds, `<use>`/`<symbol>`, probe batching, ids, idempotency.
- `tests/core/adaptation/svg-plan.test.ts`, `stylesheet-owner.test.ts` — planning,
  confidence propagation, owner groups, atomic verification, the probe in the sheet.
- `tests/core/analysis/svg-integration.test.ts`, `tests/features/svg-controller.test.ts`,
  `tests/features/dynamic/svg-dynamic.test.ts` — the unit inside the generic analyzer,
  the controller and the incremental session, mutation classification and regions.
- `e2e/svg-validation.spec.ts` (M5.R1) — real Chromium: the `adaptSVG` default with settings
  stored before M5 and the true/false/true toggle, ON/OFF x10 for fill, stroke, `currentColor` and
  `<use>` instances (computed values and pixels back to the original every cycle),
  analyze/refresh x4 without drift, multi-paint (2 to 6 colors) and the five paint-server kinds,
  budget boundaries at limit - 1 / limit / limit + 1 for painted elements, visited elements,
  nesting, distinct paints and `<use>` content, and retention (5 cycles of 500 SVGs).
- `e2e/svg-paint.spec.ts`, `e2e/svg-dynamic.spec.ts` — real Chromium: computed
  `fill`/`stroke`/`color`, rendered pixels for `<use>`, the cascade
  (attribute/class/id/inline/`!important`), `currentColor` ownership, ON/OFF,
  refresh drift, dynamic scenarios and a 500-icon / 100-replacement stress.
