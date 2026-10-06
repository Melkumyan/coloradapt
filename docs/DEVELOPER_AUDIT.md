# Developer Audit (M9)

M9 turns what M1–M8 already know about a page into findings a developer can act on. It is
**analysis, reporting and diagnostics**: it never transforms the page (the only thing it ever draws is
a temporary highlight outline). For each finding it answers: what is wrong, where, why it matters, for
which color vision profile, how severe it is, what evidence supports it, what to change, and whether
ColorAdapt already compensated for it.

```
observed fact  ·  inference  ·  engineering threshold  ·  simulation-model estimate  ·  recommendation
```

are kept apart on purpose, and so are _severity_ (how bad), _confidence_ (how sure the audit is) and
the _scientific confidence_ of the simulation behind a number (M2). An engineering heuristic is never presented as a
formal accessibility violation (see "WCAG wording policy").

Not in M9: AI recommendations, cloud reporting, remote analytics, a team dashboard, accounts, a
backend, automatic issue creation, WCAG certification, PDF export, a 0–100 "score".

Related: [AUDIT_RULES.md](AUDIT_RULES.md) (every rule), [AUDIT_EXPORT_SCHEMA.md](AUDIT_EXPORT_SCHEMA.md)
(the report format), [PRIVACY.md](PRIVACY.md), [SECURITY.md](SECURITY.md).

## Main principles

```
evidence                    >  claim
manual review               >  a finding confirmed in error
source accessibility        >  post-adaptation appearance
```

- **Source page first.** Every finding describes the page as its author wrote it. ColorAdapt's own
  recoloring, cues, chart encodings and generated images are ignored, so adapting a page can never make
  its source problems disappear from the audit (see [Source vs. adapted](#source-page-vs-adapted-appearance)).
- **Unknown beats wrong.** What cannot be established is reported as `manual-review` or
  `analysis-limitation`, never as a confirmed defect.
- **Conservative.** A missed heuristic issue is preferred to wrong developer guidance; the curated
  benchmark has a hard gate of zero false confirmed findings.

## Architecture

```
src/core/audit/              pure, DOM-free, clock-free
  types.ts                   model: categories, severities, confidence, assessment, evidence,
                             targets, AuditCandidate, AuditFinding, AuditSnapshot, limits
  rules.ts                   the rule registry (id, title, category, default severity, text, source, WCAG)
  severity.ts                the only place a severity is decided; adaptation precedence
  privacy.ts                 stableHash, redactSnippet, safeName, sanitizePageUrl, auditFileName, escapeHtml
  evidence.ts                evidence builders, simulationInfo()
  recommendation.ts          deterministic recommendation templates
  inputs.ts                  plain-data inputs of the evaluators
  evaluate-color.ts          M1/M2/M3/M5: text contrast, color distinguishability, SVG icons
  evaluate-semantic.ts       M6: color-only states
  evaluate-chart.ts          M7: series conflicts, legends, unsupported charts, canvas charts
  evaluate-image.ts          M8: raster icons, raster charts, unreadable control images
  evaluate-coverage.ts       CA-GEN-001: budgets ended a pass
  finding.ts                 candidate -> instance (registry + severity), ids and group keys
  dedupe.ts                  one problem on one element = one instance
  grouping.ts                instances -> findings (exact count + bounded sample)
  snapshot.ts                buildSnapshot(), summarize()
  filter.ts                  AuditFilters (severity/category/confidence/adaptation/kind/profile/search)
  labels.ts                  every word the UI and the HTML report show (text + shape per severity)
  session.ts                 plain-data shapes of the page <-> content-script exchange
  export.ts                  createAuditReport, canonical JSON, parseAuditReport, renderAuditHtml
src/features/audit/          browser
  element-locator.ts         LocatorContext: identity key, display path, bounded text snippet
  collector.ts               collectAudit(): audit sources -> candidates (+ element per instance)
  controller.ts              AuditController: run, live session, highlight, diagnostics
  highlighter.ts             the one outline box
  store.ts                   AuditStore: current snapshot + weak element refs, generation guard
src/entrypoints/audit/       the audit page (React): App, components, use-audit-session, download
```

Hooks into the existing layers (all read-only, all under the page's own styles):

| Layer                                    | Addition                                                                                                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `features/page-analysis` (M1/M3/M5)      | `ContentController.auditSources()`: one `analyzeSubtrees` pass (up to `AUDIT_MAX_ELEMENTS`), plus the scans below; `trackedKind(id)` on the incremental session |
| `features/semantics` (M6)                | `SemanticCueController.auditScan(root)`: the layer's own decision for every candidate, with the color-only verdict, whether or not cues are on                  |
| `features/charts` (M7)                   | `ChartController.auditScan(root)`: every chart and canvas under `root`, read like a normal pass, no state kept                                                  |
| `features/images` (M8)                   | `ImageController.auditScan(root)`: DOM facts, the page's own source, the layer's decision when it ran; no pixel is read                                         |
| `features/dynamic-analysis/ownership.ts` | the highlight box is a ColorAdapt-owned node: its insertion and `style` changes never start analysis                                                            |

The collector does not rediscover anything: it consumes the descriptors, plan outcomes, semantic
results, chart analyses and image records the layers already produce.

### Data flow

```
Audit page (extension tab) ── AUDIT_RUN {scope} ──────────────▶ content script
                                                                   │
                      ContentController.auditSources()  (all under withOriginalStyles)
                        ├─ analyzeSubtrees(body)            M1 descriptors, M5 svg units
                        ├─ findNotAdaptable + plan outcomes M3 status / suggested color
                        ├─ semantic.auditScan               M6
                        ├─ charts.auditScan                 M7
                        └─ images.auditScan                 M8
                                   │
                      collectAudit()   locators, adaptation status per element
                                   │  AuditCandidate[]
                      buildSnapshot()  severity -> dedupe -> group -> summary
                                   │
                      AuditStore.commit(generation)  (older generations refused)
                                   ▼
Audit page ◀── AuditSnapshot ── filters, cards, highlight, export (JSON / HTML, client side)
```

### Typed messages and the port

All traffic uses the typed `MessageMap` (`infrastructure/messaging/messages.ts`); no ad-hoc strings:

| Message                 | Request                        | Response           | Purpose                                          |
| ----------------------- | ------------------------------ | ------------------ | ------------------------------------------------ |
| `AUDIT_RUN`             | `{ scope }`                    | `AuditSnapshot`    | one pass now, with the page's effective settings |
| `AUDIT_GET`             | –                              | snapshot / null    | the current snapshot                             |
| `AUDIT_HIGHLIGHT`       | `{ findingId, index, scroll }` | `HighlightResult`  | outline one element of one finding               |
| `AUDIT_CLEAR_HIGHLIGHT` | –                              | `null`             | remove the outline                               |
| `AUDIT_CLOSE`           | –                              | `null`             | end the session (watching stops, highlight goes) |
| `AUDIT_NOTE_EXPORT`     | –                              | `null`             | local counter `auditExports`                     |
| `AUDIT_DIAGNOSTICS`     | –                              | `AuditDiagnostics` | debug/test channel, local only                   |

While an audit page is open it holds a `runtime` port named `coloradapt-audit` (`AUDIT_PORT_NAME`) to
the content script of the audited tab. The content script accepts only that name. Connecting opens a live
session; the content script pushes `{ type: 'snapshot', generation }` after each live pass and the page
fetches the snapshot with `AUDIT_GET`. When the audit tab closes or navigates, the port drops and the
content script ends the session (`close()`: observer disconnected, timers cleared, highlight removed);
the page also sends `AUDIT_CLOSE` on `pagehide`, best effort.

### The audit page

A dedicated extension page (`audit.html?tabId=N`, opened from the popup's "Developer audit" button in a
new tab) so it can stay open beside the audited page without rewriting the popup or options surfaces. It
shows the summary (counts by severity, adapted/unresolved/manual review), filters, and one card per finding.

- Cards show severity (text + shape), title, category, affected count, confidence, kind, ColorAdapt's
  status, profiles and rule id. Expanded: summary, evidence table (value + basis), recommendation, how
  sure (finding confidence, simulation model confidence, source milestones, "related to" WCAG), affected
  elements with "Show on page", previous/next, and a technical-details section.
- Filters: severity, category, confidence, ColorAdapt status, kind (assessment), plus local text search
  over rule id, title and element locators. Option counts are over the whole snapshot; the status line
  reports filtered counts.
- The UI follows the rule it audits: severity is a word, a distinct shape and a distinct border style,
  never a hue alone; controls are real buttons, `aria-expanded`, visible focus rings.
- At most 200 findings are drawn at a time ("Show more"); none is discarded.

## The finding model

A **candidate** is one problem on one element, as an evaluator emits it. The pipeline is
`candidate → instance (registry + severity) → dedupe → group → finding`.

- **Instance**: one rule's problem on one element. `instanceId = <ruleId>/<hash(ruleId | element
identity key | context)>` (`context`: the state, trigger or reason that makes two problems on one
  element different).
- **Finding** (what the UI lists): a group of instances of the same rule, component signature and
  context, with the same assessment. `id = <ruleId>:<hash(groupKey)>`, 16 hex characters of a
  deterministic two-lane FNV-1a hash. Not a UUID, not random: identical on every refresh while the
  underlying issue is unchanged.

**Deliberate deviation from "ruleId + target + profile + context".** The vision profile is an
_attribute_ of an instance, not part of its identity. Auditing the same defect under protanopia and
deuteranopia would otherwise produce two cards for one problem; instead the instance is merged and
lists both profiles. Consequence: switching the active profile changes `visionProfiles` (and may add or
remove findings that depend on a profile) but never renames a finding that persists.

A finding carries: `ruleId`, `category`, `subcategory`, `severity` + `severityReasons`, `confidence`,
`assessment`, `title`, `summary`, representative `evidence`, `affectedCount` (exact) and `affected`
(a sample), `recommendation`, `source` (primary + contributing milestones), `visionProfiles`,
`simulation[]` (per profile), `adaptationStatus` + `adaptationBreakdown`, a fixed `sourceNote`, and
`wcag` ("related to" entries). The full field list is in [AUDIT_EXPORT_SCHEMA.md](AUDIT_EXPORT_SCHEMA.md).

### Categories

`color-contrast`, `color-distinguishability`, `color-only-information`, `semantic-state`, `svg`,
`chart`, `image`, `unsupported-content`, and `dynamic-content` (reserved, see [Limitations](#limitations)).
Subcategories name the specific case (`text-contrast`, `foreground-background-conflict`,
`series-color-conflict`, `missing-non-color-cue`, `ambiguous-semantic-color`, `unreadable-image`,
`unsupported-raster-chart`, `unsupported-canvas-chart`, `unsupported-chart`, `legend-ambiguous`,
`analysis-incomplete`, `coverage-limited`, `icon-conflict`).

### Rules

`core/audit/rules.ts` is the registry: id, title, category, subcategory, default severity, default
assessment, description, summary, recommendation template, source subsystem, related WCAG criteria and
whether the rule is simulation-based. No rule text lives in the UI. Ids are stable (see
[AUDIT_RULES.md](AUDIT_RULES.md#rule-id-stability)).

### Assessment

| Assessment            | Meaning                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `issue`               | ColorAdapt established a defect from deterministic rules over the page's own data                   |
| `manual-review`       | may matter, ColorAdapt cannot decide (canvas chart, raster chart, unanalyzable SVG) — not a failure |
| `analysis-limitation` | ColorAdapt could not analyze this; says nothing about the page                                      |

### Evidence bases

Every evidence item (`key`, `basis`, `label`, `value`) states why it is in the report:

- `observed-fact` — read from the page or computed from what was read (a color pair, a contrast ratio);
- `inference` — concluded by a heuristic (a class name that says "error"; a chart classification);
- `engineering-threshold` — a cutoff ColorAdapt chose (contrast target, distance threshold), not a standard;
- `model-estimate` — the output of a color vision simulation model; carries that model's confidence.

### Severity

`critical > high > medium > low > info`. Severity answers "how much would this hurt a user who cannot
rely on the color". It is decided in `core/audit/severity.ts` and nowhere else, from the rule's default
and documented steps; every step is returned as a reason and shown under "Technical details". Red/green
is never critical by itself.

```
analysis-limitation               -> info, always
manual-review                     -> at most low (rule default capped at low)
issue:
  start from the rule's default severity
  information loss total          +1        information loss none  -1
  functional impact major         +1        functional impact none -1
  non-color redundancy present    -1
  ColorAdapt found no safe fix    +1   (adaptation status no-safe-candidate)
  confidence LOW    -> at most medium
  confidence MEDIUM -> at most high
  simulation model other than SUPPORTED_MODEL -> at most high
  critical only when: confidence HIGH, information loss total, element is interactive
  (otherwise capped at high)
  an issue is never below low
```

Frequency is not severity: a hundred repeated mediums are one finding that affects 100 elements, still
medium. A finding's severity is the most severe member's; it is never summed.

### Confidence, scientific confidence

- **Finding confidence** (`HIGH`/`MEDIUM`/`LOW`): how sure the audit is that the finding is true of the
  page. Deterministic computations over resolved colors and structure are `HIGH`; a semantic state
  guessed from a class name is `MEDIUM`/`LOW`. A group takes its lowest member's confidence.
- **Scientific confidence** (`simulation[]`): for simulation-based rules, M2's `ModelConfidence`
  (`SUPPORTED_MODEL`, `MODEL_ASSUMPTION`, `APPROXIMATION`, `UNSUPPORTED`) and the model/fidelity used,
  passed through unchanged. "Finding confidence HIGH, simulation MODEL_ASSUMPTION" is a normal result.
  It also caps severity at high. **M2 stays PARTIAL**; the audit shows that limitation rather than hiding it.

Both are separate from severity and from each other.

### Adaptation status

What ColorAdapt did about a finding right now. It never changes the finding: the source page still has
the problem.

| Status              | Meaning                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `not-applicable`    | ColorAdapt does not address this kind of problem / this profile                              |
| `not-needed`        | ColorAdapt looked and found no change needed                                                 |
| `adapted`           | ColorAdapt changed what the user sees (recolor, cue, encoding)                               |
| `not-applied`       | planned, but the browser did not render it                                                   |
| `no-safe-candidate` | searched, found no change it can make safely ("could not safely correct this automatically") |
| `unsupported`       | content ColorAdapt does not support                                                          |
| `not-enabled`       | adaptation (or that layer) is off                                                            |

For color rules the status comes from the M3 session's tracked outcome for the element; semantic
findings use the presence of the cue attribute; charts use the chart layer's info; adaptation exists only
for the active profile, so instances under other profiles are `not-applicable`. A finding's overall
status is the least resolved among its members (`no-safe-candidate` > `not-applied` > `unsupported` >
`not-enabled` > `not-applicable` > `adapted` > `not-needed`), with the full `adaptationBreakdown` kept.

### Profiles scope

`AuditProfileScope`: `active` (the user's profile), `major` (protanopia, deuteranopia, tritanopia, plus
the active profile when it is another one) or `auto` (the default: `active` for a simulated profile,
`major` when normal vision is selected — a developer with normal vision still wants to know). `normal`
and `custom` simulate nothing. Contrast and semantic rules do not depend on a profile.

## Source page vs. adapted appearance

All sources are read inside `StylesheetManager.withOriginalStyles`, which suspends ColorAdapt's recolor
rules, cue CSS, chart CSS and anything else in the managed `<style>`; the analyzer, the semantic and
chart facts and the image facts all go through it. In addition:

- elements inside ColorAdapt-owned nodes (`data-coloradapt-chart-node`, the highlight box) are skipped;
- M7's overlays, defs and `data-coloradapt-chart-*` markers are skipped by the chart reader, so
  ColorAdapt's dashes/markers/patterns never count as "existing non-color redundancy";
- M6's cues are pseudo-elements that vanish under suspended styles, so a ColorAdapt cue never counts as a
  page cue (`existing-cue`);
- M8 reports the page's original source while a generated bitmap is shown, so a generated Blob is never
  the "source" of an image finding;
- M5/M3 rules are suspended, so original paint and colors are measured.

Equivalence is tested: the same page audited with adaptation ON and OFF gives the same source findings
(same ids, severity, evidence) and differs only in adaptation status. A finding that ColorAdapt
compensated for stays in the audit, status `adapted`.

## Deduplication and grouping

- Instances with the same id (a persistent element analyzed repeatedly, or under several profiles) merge:
  profiles and simulations united (profile order), evidence united by key, severity from the most severe,
  confidence the lowest, adaptation status the least resolved ignoring `not-applicable`.
- Instances group by rule, **component signature** (tag, role, input type, up to three class names with
  generated hashes and per-row numbers dropped), **region scope**, context and assessment. A hundred
  identical status dots in one table are one finding with `affectedCount: 100`.
- **Region scope** is the chain (at most three) of landmarks and named regions the element sits in
  (`header>nav`, `main`, `form#login`, `section` with an `aria-label`; the kind, a `role`, and an `id` only if
  it reads like a component name, never an ordinal or per-row id). So the same component in a header and in
  a footer, or in two named forms, is two findings, while the rows of one table stay one. Two regions of the
  same kind with no `id` or role to tell them apart (two bare `<nav>`s) are not told apart: that is a
  documented limit, not a claim that they are one component. Classes and state never enter the scope.
- A finding lists the first 50 affected elements (most severe first); the count is exact. Navigation
  (previous/next, wraps around) addresses all of them, not only the sample.
- Findings sort by severity, then issue before review before limitation, rule id, size, id.
- Beyond 1000 finding groups, the least severe are counted in `coverage.truncatedFindings`, never silently dropped.

### Element identity

An element's identity key is its place in the page structure: `tag:nth-of-type(n)` steps from the nearest
ancestor with a unique, safe `id` (or from `<html>`), independent of classes, text and state. The same
element in the same place has the same key on every run; an equivalent node that replaces it takes its
place. The path shown to developers is the last six steps. Component signatures drive grouping.

### Identity contract

|                            | Id                                                                  | Stable across                                                                                                                                                                                                                                                    | Not stable across                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Finding** (group)        | `<ruleId>:hash(rule, component, region scope, context, assessment)` | refresh, open/close, adaptation on/off, profile scope, filter changes, reorder, insertion or removal of other elements, a change of how many elements are affected, an equivalent node replacing another, moving a component between wrappers of the same region | a change of the component's tag, role, input type or first three component classes; moving it into another region; a change of the rule's context (state, reason) |
| **Instance** (one element) | `<ruleId>/hash(structural path, context)`                           | refresh, adaptation on/off, class/text/state changes, a replacement node in the same place; with a unique component-like `id` on the element or an ancestor: reorder and sibling insertion too                                                                   | **best effort**: without such an `id`, inserting or reordering same-tag siblings before it changes its position and therefore its id                              |

Why instance ids do not use classes or text to survive insertion: those change exactly when a problem
appears or is fixed (a `selected` class, an error message), so an id built from them would change at the
moments a developer most needs it to hold. Position is the one thing a problem does not change. A
finding id never depends on position, so the card a developer is looking at stays the same card; the list
of affected elements inside it is re-read on every pass. Highlighting always resolves the current element
from the current snapshot, never from a stored reference.

## Snapshots, generations, the live session

- `AuditSnapshot`: `schemaVersion`, `generation`, `timestamp`, `page` (origin + redacted pathname),
  `extensionVersion`, `settings`, `coverage`, `findings`, `summary`. A snapshot is replaced whole, never
  patched; a reader always sees one coherent pass.
- Every pass reserves a generation; `AuditStore.commit` refuses one that is not newer than the committed
  generation, so an old result never overwrites a newer one. The audit page applies the same rule.
- The audit costs nothing until asked: no observer, no timer, no work. A pass runs on `AUDIT_RUN`
  ("Refresh audit"); no reload is needed.
- A live session (port open) watches the page with one `MutationObserver`; mutations that are all
  ColorAdapt's own (`data-coloradapt-*`, its `<style>`, chart nodes, the highlight box) are ignored. Others
  schedule one pass: it starts `debounceMs` (400 ms) after the first mutation of a burst, and never sooner
  than `minIntervalMs` (1200 ms) after the previous pass started. The timer is not pushed back by later
  mutations; the pass reads the page as it is when the timer fires, so every mutation up to then is in it and
  a mutation after it schedules the next one: the last change is never lost, and a burst is one pass.
  Because a snapshot is rebuilt from the current DOM, findings of a problem that was fixed, of an element
  that was removed, or of the previous route simply are not in the next snapshot: the audit is a
  current-state report, with no history.
- When a pass commits, a highlight whose element is no longer part of any finding (fixed, removed) is
  removed; one whose element is still affected is re-placed over it.

### Address of the page (single-page apps)

The report holds the sanitized origin and path of the page that was analyzed. A single-page app can change
its route without touching the DOM, and the extension deliberately never patches `history.pushState` or
`replaceState` (a frozen M4 rule, kept by M9). Instead the **audit page** listens to the browser's
`tabs.onUpdated` for its tab (it carries `url` for pushState navigations, and needs no permission beyond
the host access the extension already has). Only the sanitized origin and path are compared, so a change of
query or fragment alone is nothing: the report never held them. A different route:

1. marks the metadata **pending** (a visible status; the export buttons are disabled);
2. after 600 ms (so the app's own DOM updates settle) asks the page for a fresh pass, which reads the
   address and the DOM together;
3. clears the pending state when that snapshot arrives.

So a report never pairs a new route with findings of the old one, and the raw address is never stored or
sent: it is sanitized (no credentials, query, fragment; opaque segments redacted) before it is compared or
kept.

## Coverage

Every snapshot carries `coverage.subsystems`: one entry per area, in a fixed order, each `complete`,
`partial`, `disabled` or `unsupported`, with one fixed sentence about what was and was not looked at. A
global limit is said once here, not as one analysis limitation per element:

| Area                            | Level                                                                        | Meaning                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Text and color analysis (M1–M3) | `complete`, or `partial` when the element budget hit                         | text over gradients and images is listed as not analyzed, never judged                                                       |
| Color-only state (M6)           | `complete`, or `partial` when the candidate budget hit                       | guessed states are reviews, not defects                                                                                      |
| Inline SVG (M5)                 | `partial`                                                                    | only single-paint SVG is judged                                                                                              |
| Charts (M7)                     | `partial`                                                                    | only readable SVG charts are audited; canvas and bitmap charts are manual review                                             |
| Image pixels (M8)               | `disabled` unless adaptation **and** image adaptation are on, then `partial` | with it disabled no pixel is read, so icon colors are not checked; **having no image finding says nothing about the images** |
| Finding list                    | `complete`, or `partial` when more than 1000 groups                          | the cut groups are counted in `truncatedFindings`, never dropped silently                                                    |
| Shadow DOM, frames              | `unsupported`                                                                | not audited                                                                                                                  |
| Borders and focus indicators    | `unsupported`                                                                | not audited (M9 does not expand its scope: a source analyzer for them does not exist yet)                                    |

The audit page and the HTML report show the table, and when any area is truncated they say "Audit
truncated: coverage limited". "No findings" is always worded as "nothing was found in what was audited".
`parseAuditReport` refuses a report that shows a truncated analysis or a cut finding list as `complete`, or
shows an unsupported area as audited.

## Confirmed issue vs. manual review

- **Confirmed issue** (`assessment: issue`): ColorAdapt established it with the deterministic evidence the
  rule documents (a measured contrast, a declared state compared with peers, a simulated pair below the
  threshold, a chart whose series differ by color alone). It is ColorAdapt's finding, labeled with the
  basis of each number; it is not a statement of conformance.
- **Manual review** (`assessment: manual-review`): ColorAdapt cannot decide safely (a canvas or bitmap
  chart, an ambiguous legend, an SVG with several paints, an unreadable control image, a state guessed
  from a class name). It never means the page is inaccessible, is never above `low`, and never offers a
  replacement color.
- **Analysis limitation**: ColorAdapt could not analyze something; always `info`; says nothing about the page.
- The summary counts the three apart (`byAssessment`), and the UI and the HTML report print
  "Confirmed issues: N · Manual review: N · Analysis limitations: N." so a review prompt never inflates the
  issue count. Export always contains the whole snapshot; the filters of the audit page change the view only.

### Highlight

One `position: fixed`, `pointer-events: none` box appended to `<html>` (`data-coloradapt-audit-overlay`,
`aria-hidden`), z-index maximal, a dashed light inner border and a solid dark outline: visible on any
background and not told apart by hue. The page's own nodes get no class, style or attribute; layout is
untouched; clicks pass through. At most one exists. It follows the element on scroll/resize (one update per
frame, plus a `ResizeObserver`), refreshes on every live pass, and is removed on request, when the element
leaves the document or is no longer part of any finding, on route change, and when the session ends. A
hidden element (`display: none`, `visibility: hidden`) draws no box (it would sit at the page corner with
nothing under it); the box returns when the element is shown again. `scroll: true` scrolls the element into
view; focus is never moved. Selecting another finding or element moves it. M4, the audit, M3, M5, M7 and M8
ignore it as ColorAdapt-owned.

## Privacy contract (summary)

Everything is local; nothing is sent anywhere. A report is not a DOM dump. See [PRIVACY.md](PRIVACY.md)
and [AUDIT_EXPORT_SCHEMA.md](AUDIT_EXPORT_SCHEMA.md).

- Text: a snippet of at most 40 characters of the element's own visible text, whitespace-collapsed, with
  emails, long numbers and opaque tokens replaced; read through a bounded tree walk (200 characters),
  never the whole text of a big element; always `null` for `input`, `textarea`, `select`, `option`,
  `datalist` and anything inside `contenteditable`. For `<img>`, the `alt` instead.
- Names (ids, classes, roles, input types): short, safe characters only; anything that looks like an
  identifier or secret is dropped or replaced. `input` types are limited to a known list.
- No `value`, `href`, `src`, `data-*`, cookies, storage, headers or HTML. Evidence values that quote
  page tokens are sanitized and bounded.
- Page address: `origin` + pathname with opaque segments redacted; no query, hash or credentials.

## Recommendations

Deterministic templates from the rule registry, plus the observed values (`#aabbcc on #ffffff`), plus a
fixed sentence about what ColorAdapt did. Never generated text, never an invented color. A suggested color
appears only when the M3 optimizer found and validated one for that element; it is labeled
`coloradapt-generated` with a note that it is not a standard. For `required`/`invalid`/`error` states the
recommendation says to make the state visible without color without prescribing a glyph; ambiguous states
get no state-specific advice.

## WCAG wording policy

Rules may list criteria they are **related to** (1.4.1 Use of Color, 1.4.3 Contrast (Minimum), 1.4.11
Non-text Contrast) and the UI says "related to … — not a conformance statement". ColorAdapt never says a page
"fails" a criterion: it does not know that text is inactive, decorative, incidental or a logotype, or the
true size of a graphic. Many rules map to nothing.

Allowed: "related to WCAG 1.4.1", "potential issue", "confirmed ColorAdapt finding", "manual review
required", "engineering target". Not allowed anywhere in rule text, recommendations, UI, JSON, HTML or
these docs (as a claim): violates / fails WCAG, WCAG failure or violation, non-compliant, compliant,
passes WCAG, accessibility violation, inaccessible. `relation` is always `related-to` and the parser rejects
anything else. `tests/core/audit/review-claims.test.ts` scans rule metadata, every export, the UI source
and these docs for the prohibited language.

## No score

There is no accessibility score. Counts by severity, category, confidence, assessment and adaptation
status, plus adapted / unresolved / manual-review totals, are what the summary shows.

## Audit-only mode

The audit works with adaptation off (`enabled: false`) and does not need any layer to be active:
`auditSources()` reads the document directly, and statuses become `not-enabled`. The only things it writes
are the analyzer's own `data-coloradapt-id` attributes (filtered as self-mutations) and, on request, the
highlight box. No ColorAdapt stylesheet, cue or chart node appears.

## HTML report

Implemented. `renderAuditHtml(report)` returns one standalone file: inline CSS, no script, no external
font, image or link that loads anything, a `<meta http-equiv="Content-Security-Policy" content="default-src
'none'; style-src 'unsafe-inline'">`, and every page-derived string passed through `escapeHtml`; nothing from
the page is ever inserted as markup. It works offline and contains no tracking. See
[AUDIT_EXPORT_SCHEMA.md](AUDIT_EXPORT_SCHEMA.md#standalone-html-report).

## Performance

- `AUDIT_MAX_ELEMENTS = 5000` elements per pass (`analyzeSubtrees` on `<body>`; the single root is never
  cut by the clock, only by this structural budget). Semantic candidates: 1500; chart marks 20 000 per pass,
  canvases 500; images 500. When any budget ends a pass, CA-GEN-001 says which.
- Locators are memoized per pass (a path from its parent's, a sibling index once per parent): linear.
- Dedup and grouping are single linear passes; at most 50 targets per finding are kept in a snapshot (the
  weak element registry holds all); at most 1000 findings; the page draws 200 at a time.
- With no audit page open the cost is zero.

See [PERFORMANCE.md](PERFORMANCE.md).

## Diagnostics

`AUDIT_DIAGNOSTICS` (local, never sent): `auditFindings` (affected elements), `auditGroups`,
`auditManualReview`, `auditHigh` (critical + high), `auditMedium`, `auditLow` (low + info),
`auditExports`, `auditPasses`, `auditLivePasses`, `auditWatching`, `auditHighlightVisible`,
`auditStaleDiscarded`.

## Limitations

- **Images.** CA-IMG-001 needs "Adapt functional images" (`adaptImages`): pixels are only ever read with the
  user's opt-in, so without it the audit reports raster charts and unreadable control images from DOM facts
  only. CSS background images are not audited.
- **Semantics.** A state is reported only when it can be classified with evidence _and_ compared with peers
  (or is an empty sized box). Elements without peers, or whose state ColorAdapt has no cue for, produce no
  finding. A defect (CA-SEM-001) is only claimed when the page itself _declares_ the state (aria-*, native
  validity, a live-region role); a state guessed from class names, data tokens or words is an inference
  and is a manual-review finding (CA-SEM-002) however well corroborated: `class="badge error"` is rated HIGH
  by M6 (and gets its cue), but the audit does not call it a confirmed defect.
- **Contrast.** Only resolved solid backgrounds; text size class comes from computed font size/weight;
  disabled elements and elements in aria-hidden decorative SVG are skipped. Gradient/image backgrounds are
  an analysis limitation (CA-COLOR-003).
- **`dynamic-content`** is a reserved category. Dynamic pages are reported through the other categories from
  their current state; being dynamic is never a finding.
- **Identity.** Instance ids use position among same-tag siblings: inserting a same-tag sibling _before_ an
  element shifts the ids of the elements after it (finding ids, which group by component and region, survive).
  See "Identity contract" for why classes and text are deliberately not used.
- **Regions.** Two bare landmarks of the same kind and no `id` or `role` (two `<nav>`s) are one region for
  grouping purposes.
- **Per-site chart setting.** The per-site `adaptCharts` setting is not consulted by the chart runtime (a frozen
  M7 behavior, recorded as technical debt for M12); the audit UI does not expose it as a working control.
- **Firefox.** The audit ran in a Firefox 151 runtime during the M10 real-world validation (a full 193-page
  crawl, the scenario suites, the ground-truth pixel fixtures). What was _not_ run there: the full 582-test
  Chromium E2E suite. Firefox full extension E2E parity is therefore `NOT_VERIFIED`; see
  `docs/REAL_WORLD_FINDINGS_CLOSEOUT.md`.
- **Charts.** Only HIGH-confidence inline-SVG charts get series verdicts; canvases and heatmaps are manual
  review. Charts with sequential palettes or gradient fills get no pair verdict.
- **Borders.** M1 reads border colors, but borders and focus rings are not audited (no finding for a
  border-only state distinction yet; M6 covers the state cases it recognizes).
- **Shadow DOM and iframes** are not audited (as in M1–M8).
- **Known technical debt (M12, Production Hardening):** the per-site `adaptCharts` setting is stored but the
  chart runtime does not consult it (frozen M7 behavior; the audit reports what the layer actually does and
  the UI does not expose the setting). M2 scientific status stays PARTIAL and is propagated into every
  simulation-based finding.
- Firefox: build only; runtime NOT_VERIFIED.
