# CSS Analysis (M1)

How the DOM Analyzer turns a raw element into a trustworthy (or honestly
untrustworthy) foreground/background pair. This is the detail behind
`core/analysis`'s "Foreground/background extraction" line in
`docs/ARCHITECTURE.md`.

## Pipeline

```text
element
  -> computed style (getComputedStyle)
  -> foreground resolution      (core/analysis/foreground-resolution.ts)
  -> background resolution      (core/analysis/background-resolution.ts)
  -> alpha compositing           (core/color/composite.ts)
  -> ancestor traversal          (background-resolution.ts, memoized)
  -> backgroundKind classification
  -> analysisStatus
  -> ElementDescriptor
```

`core/analysis/colors.ts#resolveColors` is the one function that ties
foreground + background resolution together into the `ColorPair` +
`backgroundKind` an `ElementDescriptor` carries.

## Foreground resolution

`color` inheritance is not something we re-implement: `getComputedStyle`
already returns the browser's fully-inherited "used value" for `color`.

CSS `opacity` is **not** a per-layer alpha multiplier. An element with
`opacity < 1` is composited as a _group_: it and all its descendants are
painted together, and the result is dimmed as one unit. So the text colour
and the element's own background must be composited _first_, and only the
combination is dimmed. Dimming the text separately and flattening it onto
an already-dimmed background double-applies opacity (e.g. red text on a
black `opacity: .5` parent is `(1, .5, .5)`, not red-at-50%-over-gray).

`resolveEffectiveForeground` therefore evaluates the chain **inside-out**
(`composeOverPage`): starting from the text colour (alpha included), for
each element up to the root, `group = opacity × (content over own
background)`, then flattens the result onto the opaque white page. The
foreground it returns is already opaque and final — it must not be
flattened again. The background uses the same walk with nothing painted at
the innermost level.

Colour alpha and `opacity` multiply naturally through this walk
(`opacity: .5` + `rgba(.., .5)` text ⇒ 25 % visibility) without any
separate bookkeeping.

Not modelled (results may differ from the pixels): overlapping siblings,
`mix-blend-mode`, `filter`, `backdrop-filter`. **`opacity < 1` on `<html>`
or `<body>`** is explicitly marked `analysisStatus: 'partial'`, because a
body background propagates to the canvas and is _not_ dimmed by the
body's own opacity, so the group model would misstate it.

## Background resolution

For a target element, the _effective_ background is what you'd see
painted immediately behind its text if you held a color picker at that
pixel: its own `background-color`/`background-image` on top of its
parent's effective background, on top of _its_ parent's, and so on, up
to `<html>`, each layer composited over what's behind it, with `opacity` applied per
element group (see "Foreground resolution").

An ancestor's background (solid or otherwise) stops mattering the moment
a layer _closer to the element_ turns out to be fully opaque — that
layer visually occludes everything behind it, including the fact that it
was a gradient/image. This is tracked precisely, not with a blunt
"first opaque ancestor wins" rule: a fully-opaque solid layer resets any
gradient/image taint accumulated so far, but a layer closer to the
element with a gradient/image after that point still taints the result.

If the chain never reaches full opacity (e.g. every ancestor up to
`<html>` is transparent), the result falls back to **opaque white** —
see "`html`/`body` background" below.

### Memoization

The ancestor walk for `backgroundKind`, truncation and cumulative opacity
is memoized per analysis pass in a `BackgroundResolutionCache`
(`Map<Element, ChainState>`); each element's `getComputedStyle` is read
and parsed once and shared by all descendants. The group-compositing walk
itself is inside-out and so re-folds the (cheap, already-parsed) layers of
the ancestor chain per analysed element: O(depth) arithmetic, but still
only O(elements) `getComputedStyle` calls (see `docs/PERFORMANCE.md`).

## `backgroundKind`

```ts
type BackgroundKind = 'solid' | 'gradient' | 'image' | 'mixed' | 'none';
```

- `solid` — every layer in the visible stack is a plain `background-color`
  (or nothing at all, i.e. page white). The composited color is trustworthy.
- `gradient` — a `linear-gradient()`/`radial-gradient()`/etc. is visible
  somewhere in the stack. We detect its presence; we do not attempt to
  compute actual gradient pixel colors.
- `image` — a `background-image: url(...)` (or another unrecognized
  painted layer, e.g. `paint()`/`cross-fade()`/`image-set()`, treated
  conservatively as "image-like") is visible in the stack.
- `mixed` — both a gradient and an image-like layer are visible, whether
  from the same `background-image` declaration (comma-separated layers)
  or from different elements in the ancestor chain.
- `none` is an internal-only transient state (nothing painted _yet_
  during traversal); it is never returned from `resolveEffectiveBackground`
  — an element with no background anywhere resolves to `solid` (plain
  white).

## `analysisStatus` and conflict detection

```ts
type AnalysisStatus = 'resolved' | 'partial' | 'unsupported';
```

- `resolved` — `backgroundKind === 'solid'`; the color pair is safe to
  run through contrast/conflict math.
- `unsupported` — `backgroundKind` is `gradient`/`image`/`mixed`.
  `ContentController.analyze` excludes these from
  `detectColorConflict` entirely and counts them in
  `AnalysisResult.unresolvedCount` instead. **ColorAdapt never reports a
  confident contrast verdict on a background it could not determine.**
- `partial` — resolution hit the ancestor-depth budget
  (`MAX_ANCESTOR_DEPTH`, 200) before reaching a definitive answer. Also
  excluded from conflict detection, for the same reason.

Because `AdaptationEngine.computeAdaptation` only ever looks at
`AnalysisResult.conflicts`, and unresolved/partial elements never produce
a conflict, adaptation automatically inherits this safety — there was no
need to add a separate guard there (see "M1 principle" below).

## `html`/`body` background

Real browsers have a quirky rule here: if `<body>`'s background is
transparent, `<html>`'s background is used to paint the _entire canvas_,
not just the `<html>` box. M1 does **not** implement that canvas-painting
special case. Instead, the ancestor walk naturally reaches `<html>` like
any other ancestor, and if _that_ is also transparent, falls back to a
hardcoded opaque white "page canvas" default. This is a known
simplification — most real pages set an opaque `body` background and
never hit the fallback — documented here rather than silently assumed.

## Borders

`readBorders` reports a `BorderColors` (`{ top?, right?, bottom?, left? }`)
with a side omitted — not defaulted to some guessed color — whenever that
side has zero width or `border-style: none`/`hidden`, since that side
renders nothing. No attempt is made to merge adjacent equal sides into a
single "uniform border" representation; four independent optional colors
is enough for M1's conflict-adjacent uses (inputs, buttons, alerts).

## Element roles & disabled state

Role classification (`core/analysis/roles.ts`) is unchanged in shape from
M0; M1 adds `isElementDisabled`, which checks the native `disabled`
property on form controls (`<button>`, `<input>`, `<select>`,
`<textarea>`, `<option>`, `<fieldset>`) and falls back to
`aria-disabled="true"` for anything else. Disabled controls are still
fully analyzed — their rendered colors are real — `ElementDescriptor`
just carries `disabled: true` so a future milestone can choose to
deprioritize UA-styled disabled-state conflicts the page author didn't
choose and often can't override with CSS alone.

## Avoiding duplicate text conflicts

`<p><span>Hello</span></p>` should not produce two near-identical
conflicts for the same visible text. `hasOwnText` (`core/analysis/text.ts`)
checks whether an element has a non-whitespace **direct** text-node
child, as opposed to text that only exists inside a nested element. For
roles classified as `'text'`/`'generic'` (the catch-all wrapper
categories — not `link`/`button`/`badge`/`status`/`form-control`/`svg`/
`image`, which are always analyzed on their own terms even when their
text lives in a nested element, e.g. `<button><span>Go</span></button>`),
the analyzer skips elements with no own text: their visible text is
identical to a nested element's, which is (or will be) independently
analyzed.

## Visibility

Unchanged from M0's approach and still deliberately cheap: `display`,
`visibility` (now including `collapse`, used by table rows/columns), and
`opacity: 0`. **Does not** use `getClientRects()`/`getBoundingClientRect()`
— those are more accurate in a real browser (and were considered for
M1), but jsdom has no layout engine and always reports zero client rects
for every element, which would make the entire test suite's visibility
filtering vacuously false. Using a layout-based check here would mean
either an untestable analyzer or test-only behavior diverging from
production — both worse than the current cheap, honest approximation.

Also unchanged: an element that is merely scrolled out of view (or below
the fold) is **not** treated as hidden. It has a real layout box and may
become visible later; conflating "not currently visible" with "not
rendered at all" would cause ColorAdapt to silently skip content a user
will actually see.

## Known limitations (explicit M1 policy, not silent gaps)

- **Pseudo-elements** (`::before`/`::after`): not analyzed. Real
  browsers support `getComputedStyle(element, '::before')`, but jsdom
  does not (`Not implemented: Window's getComputedStyle() method: with
pseudo-elements`), which would make this both untestable here and a
  guess as to real-browser-only behavior. Deferred to a future milestone
  with a plan for either feature-detection or browser-only test
  tooling.
- **`::placeholder`**: same reasoning as pseudo-elements generally;
  not analyzed in M1.
- **Shadow DOM**: not pierced, open or closed. `querySelectorAll` from
  `analyzeDocument`'s root does not see into shadow trees. Deferred.
- **Iframes**: never analyzed, same-origin or cross-origin. The content
  script only ever sees its own document; no additional host permissions
  are requested to change this. Deferred.
- **Gradients/images**: detected and classified, never pixel-sampled.
  See `backgroundKind` above.
- **Ancestor depth**: capped at 200 levels per resolution
  (`MAX_ANCESTOR_DEPTH` in `background-resolution.ts`); beyond that,
  resolution reports `partial` rather than guessing. No real page should
  realistically hit this.

## M1 principle

> ColorAdapt should not say "contrast is bad" when the actual background
> cannot be determined. The correct result in that case is `unsupported`
> (surfaced to the user as "N elements skipped"), not a guess.

Concretely: `correctness > confidence > safety > coverage > performance

> feature count`. Every design decision above that looks conservative
(stopping at `unsupported` rather than guessing a gradient's "average"
> color, not pretending pseudo-elements/Shadow DOM/iframes work when we
> can't verify they do) follows from that ordering.
