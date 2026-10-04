# Semantic accessibility (M6)

M6 asks one question of a page:

> Is this interface communicating information primarily or exclusively through color, and can
> ColorAdapt add a safe non-color cue without changing what the page means?

It is **not another recoloring milestone**. M3 changes which colors are used; M6 adds a second,
independent channel (a glyph, an underline, an outline pattern) where color is the _only_ carrier of
a state. The two are separate accessibility channels and work side by side.

The governing rule, in priority order:

```
semantic correctness  >  confidence  >  safe cue  >  coverage
```

`unknown` is always preferred over a wrong semantic conclusion. Color alone is never evidence enough
to classify anything: red is not "error", green is not "success".

## Non-goals

No LLM / AI inference (M10), no charts (M7), canvas, image recoloring or OCR (M8), no Shadow DOM or
iframes, no developer audit (M9), no interpretation of arbitrary prose. M6 does not repair a page's
screen-reader experience, and it does **not** change the M2 scientific status (still PARTIAL).

## Pipeline

```
DOM / ARIA / attributes / text / role
        │  features/semantics/dom-facts.ts          (the only DOM reads)
        ▼
ElementFacts ──► SemanticEvidence[]  ──► SemanticResult          core/semantics
                 (evidence.ts)           (classifier.ts, confidence.ts)
                                              │
                          ExistingCues + peers │ (color-only.ts)
                                              ▼
                                    ColorOnlyVerdict ──► CueDecision / SemanticCuePlan
                                                         (cue-selector.ts, cue-plan.ts)
                                              │
        ┌─────────────────────────────────────┘
        ▼  features/semantics/cue-controller.ts       (the only DOM writes)
  data-coloradapt-cue="<key>" on the element  +  one static stylesheet of cue rules
        │  verified against the browser's computed output
        ▼
  counted as applied only if it renders as planned
```

`src/core/semantics/` is pure: facts in, decisions out, **no DOM**. It is unit-tested without a
browser. `src/features/semantics/` reads facts, applies decisions and verifies them.

| File (core/semantics) | Role                                                            |
| --------------------- | --------------------------------------------------------------- |
| `types.ts`            | the domain model (states, evidence, results, cues, plans)       |
| `vocabulary.ts`       | the only language-dependent data (tokens, words, symbols)       |
| `evidence.ts`         | facts → evidence with provenance and strength                   |
| `classifier.ts`       | evidence → `SemanticResult`; dimensions, equivalence, conflicts |
| `confidence.ts`       | the one place evidence becomes a confidence level               |
| `color-only.ts`       | existing-cue detection and the color-only verdict               |
| `cue-selector.ts`     | the controlled state → cue mapping                              |
| `cue-plan.ts`         | the automation policy (`decideCue`)                             |

## Semantic states

```
unknown
success error warning info
selected unselected   active inactive   enabled disabled
required invalid valid
positive negative   online offline   increase decrease
```

Most elements stay unclassified; nothing forces a page into these categories. States that can be
true together live in different **dimensions** (status, presence, polarity, highlight, requirement,
availability): a tab can be selected _and_ disabled. Two different answers inside one dimension
contradict each other.

## Evidence

Every piece of evidence records where it came from:

```ts
{ source: 'aria-invalid', value: 'true', supports: 'invalid', strength: 'strong' }
```

| Strength | Examples                                                                                                                                                                         |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| strong   | `aria-invalid="true"`, `aria-selected`, `aria-current`, `aria-disabled`, native `required`/`disabled`, a native invalid field the user has touched, `role="alert"` (family hint) |
| medium   | a class token (`has-error`), a state-carrying `data-*` value, a short status text, `aria-label`, `title`, `aria-describedby` text, `role="status"` (family hint)                 |
| weak     | an `id` token, **a color** (red/green/yellow/blue)                                                                                                                               |

Weak evidence never decides. It is recorded, and can only corroborate (see _Confidence_).

### ARIA support

Read: `role`, `aria-invalid`, `aria-selected`, `aria-current`, `aria-disabled`, `aria-checked`,
`aria-pressed`, `aria-required`, `aria-live`, `aria-expanded`, `aria-label`, `aria-describedby`.
ARIA is used **only as documented**:

- `aria-selected` only on `tab option row gridcell treeitem columnheader rowheader`;
  `aria-checked` only on `checkbox radio switch menuitemcheckbox menuitemradio option treeitem`;
  `aria-pressed` only on `button`. On any other element they are ignored (ARIA defines no meaning).
- `aria-invalid` (`true`, `grammar`, `spelling`) is read everywhere (its meaning does not depend on
  the role); `aria-invalid="false"` is _not_ evidence of `valid`.
- `aria-current` (anything except `false`) → the current item (`active`).
- `aria-checked="mixed"` and `aria-expanded` carry no state in the M6 vocabulary (inspected, no claim).
- `role="alert"` and `aria-live="assertive"` point at the _alert family_ (error, warning, invalid);
  `role="status"` and `aria-live="polite"` at the _status family_ (success, info, valid). A family
  hint corroborates a state of its family and never picks one by itself.

### Native form semantics

Read from the browser, not guessed: `required`, `disabled`, a button's `disabled`, a multi-select's
selected `<option>`, and validity.

- An untouched required input is **required**, not invalid. A field is "invalid" evidence only when
  `validity.valid === false` **and** the user has interacted with it: `:user-invalid` where the
  engine implements it, otherwise (jsdom, old engines) "it holds a value".
- A `<label>` carries the requirement of the control it labels (that is where "required" is drawn).
- Native checkboxes, radios and `<select>` draw their state with a shape already; they get no cue.

### Text and token policy

Language-neutral evidence (ARIA, native state, roles, exact identifier tokens) is primary. Visible
text is secondary and deliberately small:

- Identifiers are split into **whole segments** (`has-error`, `badgeSuccess`, `is_invalid`), so
  `terror`, `successor`, `errorless` never match. A negating segment (`no-error`, `non-active`,
  `not-valid`) cancels the token. `btn-*` / `button-*` and any status-family class on a button or
  link are control _variants_ (`btn-danger` is a red button, not a failed one).
- **A state word must end the identifier, or be followed only by component / modifier words**
  (`STATE_SUFFIX_WORDS`: `error-message`, `alert-danger-subtle`, `active-tab`, `info-box`).
  Anything else after it makes the word a _topic_, not a state: `error-prone`, `success-stories`,
  `online-users`, `inactiveUser`, `warning-yellow`, `danger-zone` are not evidence (M6.R1; before
  this a `data-state="error-prone"` on a `.badge` reached HIGH).
- Only the `data-*` attributes listed in `STATE_DATA_ATTRIBUTES` are read (`data-state`,
  `data-status`, `data-variant`, `data-type`, `data-severity`, `data-kind`, `data-validity`,
  `data-selected`, `data-active`, `data-invalid`). `data-theme="warning-yellow"` is not one, and a
  value is read with the same segment rules, so `not-error` is nothing.
- Text names a state only if it is a **short status label** (≤ 6 words), has no negator
  ("no errors", "без ошибок"), and contains a vocabulary word. Prose that mentions an error is not
  an error state.
- Vocabulary lives in `vocabulary.ts`, per locale, **English and Russian**
  (`error / ошибка`, `success / успешно`, `warning / предупреждение`, `invalid / недопустимо`,
  `online / онлайн`, `offline / офлайн`, `required / обязательно`, ...). No translation service is
  called; adding a language is adding a table.

## Confidence

One function (`rateConfidence`) turns evidence into a level; nothing else compares scores.

| Level  | When                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------- |
| HIGH   | any strong evidence for the state; **or** medium evidence from two independent _groups_           |
| MEDIUM | one group of token evidence (class and `data-*` are one group: two spellings of one author habit) |
| LOW    | text / accessible-name / title evidence alone (language-dependent, uncorroborated)                |
| —      | no deciding evidence → `unknown`                                                                  |

Groups: token (class, data), words (text, label, title, describedby), role, context, aria, native.
**Context** is a component class (`badge`, `alert`, `status`, `tab`, `nav`, `delta`, ...) in the
element's or its parent's classes: `class="badge success"` is HIGH, a bare `class="success"` is MEDIUM.

Color corroboration lifts LOW to MEDIUM. **Color never makes anything HIGH**, and a result with no
non-color evidence is `unknown`, whatever its color. This is a hard invariant with a regression test
(including a property test over every combination of weak evidence).

## Conflicts

Contradicting evidence in one dimension is a `conflict`: nothing is picked, no cue is added.

```html
<div class="success" aria-invalid="true">
  <!-- conflict -->
  <span class="badge success">Failed</span>
  <!-- conflict: the class and the words disagree -->
</div>
```

`invalid`/`error`, `valid`/`success`, `selected`/`active`, `unselected`/`inactive`,
`positive`/`increase`, `negative`/`decrease` are _equivalent_ answers, not conflicts. Evidence in
different dimensions does not conflict; the strongest wins (a selected tab titled "Information" is
`selected`: strong beats medium), ties go to the more informative dimension.

## Color-only detection

Decided from DOM and CSS structure, never pixels (`color-only.ts`).

1. **The element already carries a non-color cue** → not color-only. Detected: an icon (inline
   SVG, `<img>`, `role="img"`, an icon-font class), a `::before` / `::after` the page already draws,
   a symbol in the text (`✓ ⚠ × ! * ↑ ↓ + − -`), a leading sign (`+12%`, `-8%`), a required marker
   (`*`, "required", "обязательно"), or visible text that itself names the state ("Success").
2. **Comparable elements** (same tag, role, input kind, and at least one class name in common once
   state words are set aside; siblings first, then outward ≤ 4 levels; ≤ 24 peers; never the whole
   page; and **wrapped alike**: the same number of wrappers between element and group, each of the
   same tag / role / component class, so `ul.nav > li > a` is not compared with
   `ul.footer > li > a`) **in a different state**: any non-color difference between them (geometry, weight, style,
   text decoration, border width/style, radius, shadow, opacity, transform, an icon, presence of
   text) → not color-only. The focus ring is the browser's: a focused element's outline is left out
   of the comparison.
3. Only paint differs (`color`, `background-color`, border/outline/decoration color) → **color-only**.
4. Paint identical → `no-visual-difference` (there is nothing "color-only" to fix).
5. **No comparable element**: only an empty, sized box (a status dot) is color-only by construction;
   everything else is `cannot-compare` → no cue.

If anything is ambiguous the answer is "not color-only".

## Cues

| Type                              | Drawn as                                     | Used for                                    |
| --------------------------------- | -------------------------------------------- | ------------------------------------------- |
| `suffix-symbol` / `prefix-symbol` | `::after` / `::before` glyph                 | status, sign, trend, required on text hosts |
| `marker`                          | glyph (or shape) inside an empty sized box   | status dots (online / offline / warning)    |
| `border-style`                    | `outline` pattern (dashed / dotted / double) | inputs and replaced elements                |
| `underline`                       | `text-decoration-line: underline` (2 px)     | selected / current tabs, links, items       |

Mapping (an accessibility _presentation choice_, fixed, not configurable by a page):

```
error ×     invalid ×  / outline dashed        warning !  / outline dotted
success ✓   valid ✓    / outline double        info ℹ
online ✓    offline ×                          required *   (on the <label>)
positive +  negative −   increase ↑  decrease ↓
selected / active → underline (labels ≤ 48 characters only)
unselected inactive enabled disabled → no cue (natively evident)
```

`+`/`−` for positive/negative rather than arrows: a sign says "positive" without claiming a
change. Arrows are for `increase` / `decrease`.

### Glyph and font policy (M6.R1)

A cue must not depend on a font having a rare glyph, and must not inherit the page's font (an icon
font on the host would turn `×` into a blank).

- `✓` (U+2713) and `ℹ` (U+2139) are in few fonts, so **they are never drawn as text**. `✓` is a CSS
  shape (`clip-path: polygon(...)` filled with `currentColor`, or with the dot's glyph tone inside a
  dot); `ℹ` is an ASCII `i` in a ring (`border-radius: 50%`). `renderedGlyph()` is the one place that
  says what is drawn. The cue _key_ still names the semantic glyph (`after:2713`).
- Every glyph drawn as text (`× ! * + − ↑ ↓` and the ASCII `i`) is in Latin-1 / WGL4, which every
  UI font covers, and is drawn in an explicit stack (`CUE_FONT_FAMILY`:
  `system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", "DejaVu Sans", sans-serif`),
  never the page's, with `line-height: 0` so a glyph never makes its line taller.
- Verified in Chromium: pages that force `monospace`, a font that does not exist, a serif, a cursive
  and a symbol font (`Webdings`) all get the same cue; a canvas rendering test checks that each
  text glyph is a real glyph (not the missing-glyph box) in the stack.
- **Forced colors**: backgrounds are replaced in forced-colors mode, so a drawn shape would vanish.
  Each shape rule has an `@media (forced-colors: active)` block (`forced-color-adjust: none`,
  `background-color: CanvasText`); text glyphs, underlines and outline patterns follow the forced
  colors natively. Verified with Chromium's `forcedColors: 'active'` emulation (computed styles
  only; no claim about every OS high-contrast theme).

### Why CSS pseudo-elements and not inserted nodes

A cue is **one attribute on the element** (`data-coloradapt-cue="after:2713"`) plus a static rule in
ColorAdapt's own stylesheet. No node is ever inserted. Consequences, all by construction:

- OFF = remove the attribute and the stylesheet. The page's DOM is byte-identical afterwards.
- No text node, so no copy/paste, `textContent`, form or selector change, and no layout change from
  new elements.
- `content: "✓" / ""` gives the glyph an **empty alternative text**: assistive technology reads
  nothing extra, and the accessible name of buttons and links is untouched. (A `content` fallback
  without the alternative text precedes it for engines that do not know the syntax.)
- `pointer-events: none; user-select: none`: a glyph can neither be clicked nor selected, and a
  pseudo-element is never a focus stop.
- Glyph color is `currentColor` (so light and dark themes just work); the only fixed colors are the
  black/white glyph inside a dot, chosen at the WCAG equal-contrast luminance (0.179).

### Safe placement

Placement is **decided** before anything is written and **verified** after the browser has laid it
out (`#renders`): a cue that does not render as planned is taken back and never counted as applied.

- `input select textarea option img video canvas iframe svg ...` cannot carry a pseudo-element: they
  get an outline pattern (only for states that have one) or nothing.
- A dot gets its glyph _inside_ its box; the box is `overflow: hidden` so it keeps its baseline and
  size. Verified in the browser: width, height and position must not change.
- Table rows, `display: contents`, hidden elements and prose-sized containers are never decorated.
- The page's own `::before` / `::after` are never overwritten: a busy `::after` falls back to
  `::before`; both busy → no cue.
- An underline is not added to text the page already underlines (most links).
- A **grid host** (`display: grid | inline-grid`) gets no `::before` / `::after` glyph: the pseudo
  element becomes a grid item and lands in a new row. Decided up front (`no-safe-placement`,
  `grid-host`); a flex host is fine.
- A glyph beside text is **verified**: the host must not get taller (a glyph that wraps onto a new
  line is taken back), and a host that clips its overflow must still have room (an ellipsized label
  would hide the glyph, so none is applied). The layout is read _before_ the cue's attribute is
  written (with a replaced cue removed first), then after. Sideways movement of a host is not its
  own doing (a neighbor's glyph pushes it) and is not checked; a dot is checked on size and vertical
  position.
- The pseudo-element must exist with the planned content and a `display` other than `none`; a drawn
  shape and an in-box glyph must have a non-zero box (`pseudoBox`, skipped only where the engine has
  no pseudo-element layout, i.e. jsdom).
- The outline pattern gives the browser's focus ring back while the element is focused.

## Automation policy

```
HIGH confidence  +  color-only confirmed  +  a safe placement   →  cue
MEDIUM / LOW                                                    →  detected and counted (colorOnlyDetected), no cue
unknown / conflict                                              →  no cue (color-only is not even assessed)
```

`AUTO_CUE_MIN_CONFIDENCE = 'high'`, defined once in `confidence.ts`.

**Default: `semanticCuesEnabled = true`.** The decision rests on validation, not enthusiasm: a cue
needs HIGH confidence, confirmed color-only and a safe placement, every cue is verified against the
browser, it is fully reversible, it costs no DOM nodes, and the false-positive benchmarks found
**0** false positives (55 + 144 scenarios, jsdom and real Chromium). M6.R1 re-examined the default
against the adversarial set and kept it; had any wrong automatic cue survived, the default would
have gone to `false`.

Migration (`parseUserSettings`, `SettingsStore`, tested at both levels and in a real profile):

| Stored                                     | Effective | Notes                                              |
| ------------------------------------------ | --------- | -------------------------------------------------- |
| nothing (fresh profile)                    | `true`    | reading writes nothing                             |
| object without the field (saved before M6) | `true`    | other fields untouched                             |
| `true`                                     | `true`    |                                                    |
| `false`                                    | `false`   | never overwritten by a read or an unrelated update |
| anything that is not a boolean             | `true`    | the default, not `false` by accident; documented   |

The options page has a checkbox.

## Screen-reader policy

A cue exists to help _color perception_. Pages that already expose their state to assistive
technology correctly (ARIA, native state) must not get a duplicate announcement, so cues are
decorative: empty alternative text, no new attributes, no children, no focus stops. If a page lacks
accessible semantics, M6 does **not** pretend to repair its screen-reader experience: that is a
different scope (M9). The browser's accessibility tree is asserted identical with and without cues. This is **not** a
screen-reader validation: no assistive technology was run.

Verified in Chromium (`e2e/semantic-surface.spec.ts`, fixture `e2e/pages/semantic-a11y.html`):

- the **full** tree (`Accessibility.getFullAXTree`: role, ignored, name, description, value,
  properties of every node) and `ariaSnapshot` are equal with and without cues;
- the raw (not normalized) role / accessible name / description / properties of a button, link, tab,
  checkbox, radio, number input, labelled text box (name from its `<label>`, which carries the `*`
  cue), status, alert (with `aria-describedby`) and a dot;
- `aria-label`, `aria-describedby`, `title` and the page's whole markup are byte-identical (only
  `data-coloradapt-*` differ; no node is added);
- focus order and focusable count are identical, a cue host never gains `tabindex`.

One observable difference, by browser design and not a cue effect: the _static text_ node of a block
host whose markup is indented ends with a space once an inline `::after` follows it (`"Something
went wrong"` becomes `"Something went wrong "`); whitespace is collapsed in the full-tree comparison.
No accessible name of a control changes (names are compared raw above).

## Ownership, reversibility, idempotency

- Ownership: the `data-coloradapt-cue` attribute (prefix `data-coloradapt-`, already ColorAdapt's by
  M4's ownership rule) and the cue rules inside the **single** managed `<style>`
  (`StylesheetManager.setCueCss`).
- The cue CSS is a pure function of the _set of cue keys in use_ (sorted, deterministic); the sheet
  is rewritten only when that set changes.
- Reading happens inside `withOriginalStyles`, i.e. with cues and recoloring suspended, so analysis
  always sees the page's own styles, never ColorAdapt's.
- Repeated analyze/refresh leaves one attribute value per element; re-asserting an unchanged cue is
  not an "application" (`cuesApplied` does not climb).

## Dynamic updates (M4)

M6 has **no observer of its own**. It receives the regions M4 already decided to look at.

| Change                                                                                                                                     | Path                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `aria-invalid/-selected/-current/-checked/-pressed/-required/-live`, `aria-label`, `aria-describedby`, `title`, `required`, state `data-*` | new mutation kind `SEMANTIC_CHANGE` → that element (`self`)           |
| `class`, `hidden`, `disabled`, `role` (already observed)                                                                                   | `STYLE_AFFECTING_ATTRIBUTE` → subtree                                 |
| node added / removed                                                                                                                       | `NODE_ADDED` / `NODE_REMOVED`                                         |
| text change of a short status text (`Pending` → `Failed`)                                                                                  | `SEMANTIC_CHANGE` (characterData whose old or new text names a state) |
| native form validity (no DOM mutation)                                                                                                     | the event bridge below                                                |

The semantic unit may be an ancestor of the changed node (`<b>` inside `.badge`), so a pass also
considers the nearest 3 ancestors of every root.

**Native validity bridge** (`native-validity-bridge.ts`): typing flips `:invalid` without any attribute
or child-list mutation, so five passive capture listeners (`input`, `change`, `focusout`, `invalid`,
`reset`) exist on the document _while the pipeline runs and the setting is on_. They only name the
field; `DynamicPipeline.invalidate(element)` queues it for the normal batch. A burst of keystrokes is
one batch. `reset` names the fields of the reset form (≤ 200; the event fires before the values
change, the batch runs after). Lifecycle: `start()` is idempotent, `stop()` removes exactly what was
added, a refresh keeps one set, `semanticCuesEnabled = false` and `disableAdaptation` leave none
(`semanticBridge.listeners`, tested by counting `addEventListener` / `removeEventListener`). While
off, form events cause no work at all. Not covered: a script that sets `value` or `setCustomValidity`
without dispatching an event (documented limitation).

### Peer invalidation (M6.R1)

Whether color is the _only_ difference between two elements depends on both, so a change at one
(or its removal) re-examines the rest of its group, bounded, never by scanning the document:

- **A changed element** (a root, a candidate, the first 24 elements of an added region) names its
  peer group; up to 100 peers of the group (hinted ones; plain ones are only compared with) join the
  pass. One search per group (members found are not searched again; the groups found are
  memoized for the pass, and each peer is judged once however many searches find it);
  ≤ 300 searches, ≤ 6000 elements looked at in total and ≤ 400 extra peers per pass. A
  whole-document pass already holds every candidate and searches nothing. Measured on a 2000-row
  feed with no semantic element at all: 1-3 ms of semantic work per 100-row batch (it was 10-16 ms
  before the memo; the page's own cost per batch is several times that).
- **A removed element** (`NODE_REMOVED` with a live parent) becomes a `PeerSeed`
  (`{ anchor: parent, template: removed node }`, one per parent and kind of element). Its former
  peers are found from the _template_ (only tag, role, input type and class names are read; the
  detached subtree still hangs from `anchor` for the walk upward), for the removed node and its first
  descendants, so a removed `<li>` holding a badge re-examines the other badges.
- A pass that only removed things still runs the semantic layer and prunes cue rules nobody carries.

Regression tests: two badges that differ by color only, one removed → the other's cue goes; a peer
that changes class (only it touched) → the other's cue goes and comes back; a contrasting peer
inserted next to a lone element gives it its cue; a plain `<li><a>` joining or leaving a list with
a lone `aria-current` link; selected A / unselected B switching in one cycle (one incremental pass);
insert / remove / reorder / replace; two status dots (a dot is color-only by construction, so the
remaining dot keeps its cue); a group of 300 re-examines ≤ 100; 80 removals of one kind are one
search.

Known bounds: a group larger than 100 is re-examined only in its first 100 members; a class change
on a _wrapper_ that merges or splits two components (`ul.aside` → `ul.main`) is re-examined only
inside the changed subtree (the other list when it next changes): the failure is a missed or a
redundant cue, never a wrong one.

**No self-mutation loop.** Cue attribute writes are ColorAdapt-owned mutations (never classified as
work); the cue stylesheet is the same managed `<style>` as the colors and shares its repair path
(`hasInjectedContent`; a page deleting a sheet that holds only cues gets it back). Regression tests
check both that the records are owned and that a settled page does exactly zero further work.

## Interaction with M3 and M5

- M3 may recolor an element and M6 still adds its cue: recoloring and the second channel are
  independent. The cue is added only if the _original_ meaning was color-only.
- Page-provided SVG icons (M5 territory) are existing cues: red text plus a warning triangle gets
  nothing. M5's logic is not touched.

## Diagnostics

`DynamicDiagnostics.semantic` (counters; no telemetry, never leaves the device):
`semanticCandidates`, `semanticClassified`, `semanticUnknown`, `semanticConflicts`,
`colorOnlyDetected`, `cuesPlanned`, `cuesApplied`, `cuesNotApplied`, `cuesRemoved`,
`semanticPasses`, `semanticRoots`, `semanticPeerSearches`, `semanticPeersReexamined`, gauge
`cuesActive`; plus `semanticInvalidations` (form events). Once a page settles they describe it:
`cuesActive` = elements carrying a cue, `cuesApplied − cuesRemoved = cuesActive`,
`cuesApplied + cuesNotApplied = cuesPlanned`, `classified + unknown + conflicts = candidates`
(asserted in jsdom and Chromium). `DynamicContentController.semanticBridge` reports the event
bridge's listener count.
A planned cue the browser does not render as planned is taken back and counted `cuesNotApplied`,
never `cuesApplied` (plan == actual browser behavior).

## Performance and structural limits

No wall-clock gates. Limits are structural (`SEMANTIC_LIMITS`): ≤ 5000 elements walked per subtree
root, ≤ 1500 candidates per pass, ≤ 24 peers per candidate, ≤ 4 contrasting peers read, ≤ 3 ancestor
levels, ≤ 4 peer levels; for invalidation ≤ 100 peers per group, ≤ 300 peer searches, ≤ 6000
elements scanned by them, ≤ 400 extra peers, ≤ 24 plain elements per added region and ≤ 5000
elements walked inside removed subtrees. A cheap attribute pre-filter decides which elements are examined at all;
only those pay for a computed-style read. Each element is examined once per pass (peers are cached).
100 status rows flipping state in one batch cost one batch and one incremental pass, no full
rescan (E2E).

## False-positive policy

M6 PASS requires good false-positive behavior. The benchmark's false-positive set: a red brand logo,
a green decorative box, a yellow star, a red sale price, a green navigation link, a red delete
button (`btn-danger`), `terror` / `successor` / `errorless`, plain red text, prose that mentions an
error, "No errors", an untouched required input, a disabled button. All must be `unknown` (or
classified without a cue). A cue on anything below HIGH confidence, or on a false-positive scenario,
counts as a false positive and fails the pinned summary test.

## Benchmark

`tests/features/semantics/benchmark.test.ts` (M6): 55 scenarios / 76 asserted elements across
success, error, warning, info, selected, active, invalid, required, presence, sign, ambiguous,
conflict, already-accessible and false-positive cases. Expectations are properties (classified /
unknown / conflict, confidence, cue or none, cue kind). Pinned result: 55 classified, 17 unknown, 4
conflicts, 19 automatic cues, **0 false positives**.

### Adversarial benchmark (M6.R1)

`tests/features/semantics/adversarial-scenarios.ts` is pure data: **144 scenarios / 172 asserted
elements**, biased towards things that _look_ semantic but are not. The same HTML, CSS and
expectations run in jsdom (`adversarial.test.ts`) and in real Chromium
(`e2e/semantic-adversarial.spec.ts`, each scenario on its own page with the extension running).

- `trap`: red/green brand logos, yellow star and rating, red sale price, ticker, nav link,
  username, avatar border, progress bar, heart, decorative check, blue "info" badge, a red/green
  word in prose, swatches, a palette, a green button, a red table cell, decorative SVGs, a `+` in
  arithmetic, `SKU-4411`, general underline, a bold heading.
- `token`: `terror`, `successor`, `invalidated`, `warningly`, `errorless`, `inactiveUser`,
  `error-prone`, `success-stories`, `online-users`, `warning-yellow`, `danger-zone`, `btn-danger`,
  `data-state="error-prone"` / `"not-error"`, `data-theme`, id-only evidence.
- `true-negative`: "No errors", "Error handling guide", "Successful examples", a product named
  "Warning", a brand named "Success", prose; Russian "Не ошибка", "Без ошибок", "Нет ошибок", a long
  sentence, a title.
- `conflict`: `success` + `aria-invalid`, `warning` + `data-state="success"`, `aria-selected` +
  `inactive`, `role="alert"` + `success`, online + offline, class vs. text (English and Russian),
  pressed + inactive.
- `peers`: same parent but different component, same class but different role, two lists under one
  parent, nested repeated components, a lone element.
- `true-positive`: tabs, status dots, repeated badges, segmented control, nav items, list rows with a
  status cell, an invalid field among valid ones, required label, deltas, alerts; selected +
  disabled, required + invalid, active + selected.
- `accessible`: state in the text (EN/RU), symbols, a page-drawn `::after`, size / weight /
  underline / thickness as a second channel, SVG / `img` / icon-font icons, required markers,
  signed deltas.
- `ambiguous`: one class, `role=alert` / `role=status` / `aria-live` alone, `aria-invalid="false"`,
  `aria-current="false"`, a word in a colored box.

Result (identical in both engines for the cues; jsdom also pins the classification): **144 scenarios,
172 elements, 94 classified / 10 conflicts / 68 unknown, 28 automatic cues, 0 false positives, 0
false negatives among the curated high-confidence cases, 37 already-accessible skips.** A false
positive is a cue the scenario does not expect, a cue without HIGH confidence, or a cue on a
scenario that expects none. A _false negative_ is counted only where a high-confidence semantic is
explicitly curated.

Notable conservative misses (accepted by policy): a lone selected tab, a lone current link, a lone
invalid field or success badge (nothing to compare with); `role="img"` dots (treated as icons: the
page gave them an accessible name, so no visual cue is added); `data-kind="info-box"` (MEDIUM, one
group of evidence); a Russian negation outside the small negator list is not recognized, but a
state word in a short title is only LOW evidence and is never applied.

## Limitations (documented, not hidden)

- Vocabulary is small and English/Russian only. A page in another language gets language-neutral
  evidence (ARIA, native, tokens) and no word evidence.
- A class like `badge-pending` is not a state word; only what is in the vocabulary is known.
- No peer, no cue (except dots): a lone invalid field, a lone selected tab, a lone success badge
  cannot be compared and get nothing. That is the safe side of an unavoidable trade-off.
- Peers are looked for in a bounded neighborhood and must be wrapped alike; a contrasting peer far
  away, or in a differently wrapped list, is not found.
- Peer invalidation is bounded (see "Peer invalidation"): groups over 100 members and class changes
  on a wrapper that regroups components are re-examined lazily; the failure is a missed or
  redundant cue, never a wrong one.
- Native validity changed by a script without an event (`value =`, `setCustomValidity`) is not seen.
- A cue is not applied where the glyph cannot be shown (grid hosts, ellipsized or clipped hosts, a
  column too narrow for the glyph): decided or verified, never faked.
- `role="img"` elements and elements containing an icon are existing cues: no visual cue is added.
- Clipping is verified through the host's own box; an ancestor that clips is not examined.
- The `aria-*` attributes are the only attributes observed for semantics; state expressed through
  other attributes or through JS-only state is invisible.
- Pseudo-elements cannot be attached to inputs, images, `select`, tables rows; those get an outline
  pattern for error/invalid/warning/success/valid, nothing for other states.
- Shadow DOM, iframes, canvas, charts, background images: not examined. (M7: the semantic layer skips every inline SVG, so a chart legend is never given a state cue from its colors; chart marks are the chart layer's, `docs/CHARTS.md`.)
- Firefox: built and packaged; **runtime not verified** in M6 (as in M5).
- Screen-reader behavior was checked through the browser's accessibility tree only, with no
  assistive technology.
- Glyph font coverage: `✓` and `ℹ` are drawn as shapes; the other glyphs are Latin-1 / WGL4 in an
  explicit stack. A system with none of those families gets the browser's fallback font.
- Forced colors were verified through Chromium's emulation (computed styles), dark mode through
  `prefers-color-scheme: dark` and a dark container, zoom through CSS `zoom` and font-size fixtures
  (browser UI zoom cannot be automated reliably in headless Chromium). No claim about every OS
  high-contrast theme.

## Testing

- `tests/core/semantics/*`: evidence, classification, confidence boundaries, the color-alone
  invariant, conflicts, color-only detection, existing cues, cue selection and the automation policy.
- `tests/features/semantics/*`: the DOM facts reader, cue CSS, the 55-scenario benchmark, lifecycle
  (idempotency, ON/OFF ×10, no feedback loop, a11y surface, M3 interplay, repair), dynamics through
  M4 (ARIA, class, text, inserted/removed nodes, native validity, 100-row batch, budgets) and
  "plan == browser".
- `tests/features/dynamic/*`: `SEMANTIC_CHANGE` classification, affected roots, observed attributes.
- M6.R1: `tests/features/semantics/adversarial*.ts` (144 scenarios), `peers.test.ts` (peer removal,
  state change, insert / remove / reorder / replace, wrapper parity, bounded invalidation, bridge
  lifecycle by counting listeners, native validity transitions, `form.reset()`, 500-component
  retention, 60-cycle self-mutation, scripted layout answers for verified placement, grid host),
  `tests/core/semantics/evidence.test.ts` (token boundaries, attribute-token safety, EN/RU
  negation), `tests/infrastructure/storage/*` (migration policy).
- M6.R1 E2E (real Chromium): `semantic-adversarial.spec.ts` (all 144 scenarios),
  `semantic-surface.spec.ts` (full accessibility tree, raw names, keyboard, pointer, typing /
  selection / blur / validation / submit identical with and without cues, native validity
  transitions and reset, the bridge, fresh profile, pre-M6 settings, explicit false, ON/OFF x5, M3 +
  M6), `semantic-layout.spec.ts` (inline / block / flex / inline-flex / grid / positioned /
  overflow-hidden / small / large / dark, zoom 100-200 %, fonts, dark mode, forced colors, withheld
  cues), `semantic-peers.spec.ts` (peer invalidation, 100 flips / insertions / reorders / removals,
  counters, retention, self-mutation).
- `e2e/semantic-cues.spec.ts`, `e2e/semantic-dynamic.spec.ts` (real Chromium, fixture
  `e2e/pages/semantic.html`): cue existence and count, computed pseudo-element style, rendered
  pixels, light/dark, click / typing / submit / link navigation / Tab order / Enter on a tab, layout
  boxes, the accessibility tree, DOM restoration, ON/OFF ×10, refresh ×5, no feedback loop, SPA
  state changes, native validity, 100 rows, M3 interplay.
