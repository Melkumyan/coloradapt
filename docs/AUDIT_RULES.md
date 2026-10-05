# Audit Rules (M9)

Every rule of the developer audit ([DEVELOPER_AUDIT.md](DEVELOPER_AUDIT.md)), as registered in
`src/core/audit/rules.ts`. A rule says what it detects, on what evidence, how severe it starts, and what
it recommends. Rules never claim WCAG failure; "related to" lists the criteria a rule is near.

Thresholds named here are ColorAdapt's own engineering choices (`core/conflicts/thresholds.ts`,
`CHART_PAIR_DISTANCE`), shown in reports with the basis `engineering-threshold`.

## Rule id stability

- An id (`CA-<AREA>-<NNN>`) is stable: it changes only when the rule's meaning changes.
- An id is never reused. A rule whose semantics change gets a **new** id and the old one is retired.
- Titles, wording and thresholds may be refined without a new id only when what a finding _means_ stays
  the same; a threshold change that alters which pages get a finding is a semantic change.
- Finding ids (`<ruleId>:<hash>`) are derived from the rule id, component signature, context and
  assessment, so they are stable across refreshes while the issue is unchanged.
- `tests/core/audit/rules.test.ts` checks that every registered id has a `## <id>` section in this file;
  `tests/core/audit/review-claims.test.ts` checks that the summary table below and each section agree with
  the registry (category, default severity, assessment, source, simulation, related criteria) and that no
  section names a rule the registry does not have.

## Evidence contract

A finding is **confirmed** (`issue`) only when the rule's deterministic evidence is complete; anything
weaker is a **manual review** or an **analysis limitation**, never a confirmed finding:

| Rule                                                                           | Confirmed requires                                                                                                                         | Otherwise                                                                                |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| CA-COLOR-001                                                                   | visible text, one fully resolved solid background, a measured ratio below the target (4.5:1, 3:1 for large text)                           | unresolved background → CA-COLOR-003 (limitation)                                        |
| CA-COLOR-002                                                                   | normal vision tells the pair apart, the audited profile's simulated distance is below the threshold; M2 model status carried               | normal vision, or no simulation, → nothing                                               |
| CA-SEM-001                                                                     | a state the **page declares** (aria, native validity, live-region role), HIGH confidence, compared with peers, differing by paint alone    | state guessed from names or words → CA-SEM-002 (review); no peers → nothing              |
| CA-SVG-001                                                                     | one effective paint, a resolved solid background, contrast below 3:1 or simulated merge                                                    | several paints, gradients, `<use>` paint, filters → CA-SVG-002                           |
| CA-CHART-001                                                                   | a HIGH-confidence inline-SVG chart, two series whose simulated colors merge, no dash/marker/pattern/direct label distinguishing them       | sequential palettes, heatmaps, unsupported charts → CA-CHART-003; legends → CA-CHART-002 |
| CA-IMG-001                                                                     | the image layer read the pixels (needs adaptation and "Adapt functional images"), a small single-color functional icon, a solid background | unreadable control image → CA-IMG-003; bitmap chart → CA-IMG-002; photos/logos never     |
| CA-CHART-004, CA-IMG-002, CA-IMG-003, CA-CHART-002/003, CA-SEM-002, CA-SVG-002 | never confirmed: "ColorAdapt cannot decide safely", never "the page is inaccessible"                                                       | at most `low`                                                                            |
| CA-COLOR-003, CA-GEN-001                                                       | never confirmed: ColorAdapt could not analyze something                                                                                    | always `info`                                                                            |

Severity never makes a review "confirmed", and the critical level needs HIGH confidence, total information
loss, an interactive element and no non-color redundancy (never with a weaker simulation model).

Summary:

| Rule         | Category                 | Default | Assessment                                       | Source           | Simulation |
| ------------ | ------------------------ | ------- | ------------------------------------------------ | ---------------- | ---------- |
| CA-COLOR-001 | color-contrast           | medium  | issue                                            | M1 (+M3)         | no         |
| CA-COLOR-002 | color-distinguishability | medium  | issue                                            | M2 (+M1, M3)     | yes        |
| CA-COLOR-003 | unsupported-content      | info    | analysis-limitation                              | M1               | no         |
| CA-GEN-001   | unsupported-content      | info    | analysis-limitation                              | M1 (+M4)         | no         |
| CA-SEM-001   | color-only-information   | medium  | issue                                            | M6 (+M3)         | no         |
| CA-SEM-002   | semantic-state           | low     | manual-review                                    | M6               | no         |
| CA-SVG-001   | svg                      | medium  | issue                                            | M5 (+M1, M2, M3) | yes        |
| CA-SVG-002   | svg                      | info    | manual-review (or analysis-limitation, see rule) | M5               | no         |
| CA-CHART-001 | chart                    | medium  | issue                                            | M7 (+M2)         | yes        |
| CA-CHART-002 | chart                    | low     | manual-review                                    | M7               | no         |
| CA-CHART-003 | chart                    | info    | manual-review                                    | M7               | no         |
| CA-CHART-004 | chart                    | info    | manual-review                                    | M7               | no         |
| CA-IMG-001   | image                    | medium  | issue                                            | M8 (+M2, M3)     | yes        |
| CA-IMG-002   | image                    | info    | manual-review                                    | M8               | no         |
| CA-IMG-003   | image                    | info    | manual-review                                    | M8               | no         |

Severity in a report is computed from the default and the factors listed in
[DEVELOPER_AUDIT.md](DEVELOPER_AUDIT.md#severity); manual-review findings are never above low and
analysis limitations are always info.

## CA-COLOR-001 — Text contrast below the engineering target

- **Category**: `color-contrast` / `text-contrast`. **Default severity**: medium. **Assessment**: issue. **Source**: M1 CSS analysis (M3 for status/suggestion). **Simulation-based**: no.
- **Detection**: a visible, enabled, text-bearing element (not an SVG unit) whose background was resolved
  to one solid color (`analysisStatus: resolved`) and whose WCAG contrast ratio between foreground and
  background is below 4.5:1, or below 3:1 when the text is "large" (computed font size ≥ 24px, or ≥ 18.66px
  with weight ≥ 700). One finding per element.
- **Evidence**: `colors.pair`, `contrast.ratio`, `contrast.target` (engineering threshold),
  `text.size`.
- **Severity inputs**: information loss `total` below 1.5:1, else `partial`; functional impact `major`
  for an interactive element below 3:1, `moderate` above, `minor` for non-interactive text. Critical needs
  an interactive element below 1.5:1 with HIGH confidence.
- **Confidence**: HIGH (deterministic over resolved colors).
- **Limitations**: ColorAdapt cannot know text is decorative, incidental, a logotype or inactive in a way
  other than `disabled`; unresolved backgrounds are CA-COLOR-003. Pseudo-elements, Shadow DOM and iframes
  are not analyzed.
- **Recommendation**: increase the foreground/background contrast to at least the target shown; check every
  state (hover, focus, disabled, selected). The observed pair is shown; a suggested color appears only if M3
  validated one for the active profile (labeled ColorAdapt-generated).
- **Related to**: WCAG 1.4.3 Contrast (Minimum). Not a conformance claim.

## CA-COLOR-002 — Foreground and background hard to tell apart under a simulated profile

- **Category**: `color-distinguishability` / `foreground-background-conflict`. **Default severity**: medium. **Assessment**: issue. **Source**: M2 color vision simulation (with M1, M3). **Simulation-based**: yes.
- **Detection**: same element eligibility as CA-COLOR-001 (resolved background, text, enabled). For each
  audited simulated profile (`normal` and `custom` simulate nothing): the OKLab distance between the
  original colors is ≥ 0.1 (normal vision tells them apart) and the distance between the simulated colors is
  below 0.1. A pair that is already close in normal vision is a contrast problem, not this rule.
- **Evidence** (per profile `<p>`): `colors.pair`, `<p>.colors.simulated` (model estimate),
  `<p>.distance.original` (observed), `<p>.distance.simulated` (model estimate),
  `<p>.distance.threshold` (engineering threshold).
- **Severity inputs**: information loss `total` when the simulated distance is below 0.05, else `partial`;
  functional impact `major` if interactive, else `minor`. Because the rule is simulation-based, the model
  confidence of the profile caps severity at high unless it is `SUPPORTED_MODEL`.
- **Confidence**: HIGH; the simulation's own weight is reported separately (`simulation[]`).
- **Limitations**: depends on M2 (PARTIAL: Machado linear-RGB assumption; tritanomaly and achromatopsia are
  approximations). Estimates, not diagnoses. Profile is an attribute: the same element under several
  profiles is one finding.
- **Recommendation**: add a luminance difference; where color carries meaning, add a text label, icon,
  underline or shape. M3's validated suggestion is shown for the active profile when available.
- **Related to**: none.

## CA-COLOR-003 — Background could not be resolved

- **Category**: `unsupported-content` / `analysis-incomplete`. **Default severity**: info. **Assessment**: analysis-limitation. **Source**: M1. **Simulation-based**: no.
- **Detection**: a visible, enabled, text-bearing element whose analysis status is `partial` or
  `unsupported` (gradient, image or mixed background, or a resolution depth limit). Context: the status.
- **Evidence**: `analysis.status`.
- **Limitations**: says nothing about the page; no contrast conclusion is drawn. Adaptation status is
  `unsupported`.
- **Recommendation**: check the text manually against the lightest and darkest parts of its background;
  consider a solid or semi-opaque backing behind text over images.
- **Related to**: none.

## CA-GEN-001 — Analysis stopped at a size budget

- **Category**: `unsupported-content` / `coverage-limited`. **Default severity**: info. **Assessment**: analysis-limitation. **Source**: M1 (with M4 budgets). **Simulation-based**: no.
- **Detection**: one finding on `<html>` when any pass budget ended: analyzed elements (5000), semantic
  candidates (1500), chart marks (per-pass cap), images (500).
- **Evidence**: `coverage.analyzed`, `coverage.limits` (which budgets).
- **Limitations**: part of the page was not audited; the rest of the report is unaffected.
- **Recommendation**: audit the page in parts or narrow the region, then refresh.
- **Related to**: none.

## CA-SEM-001 — State communicated by color only

- **Category**: `color-only-information` / `missing-non-color-cue`. **Default severity**: medium. **Assessment**: issue. **Source**: M6 semantic cues (M3 status). **Simulation-based**: no.
- **Detection**: the semantic layer classifies the element as carrying a state (e.g. `error`, `invalid`,
  `required`, `selected`, `active`) with **high** confidence _and at least one piece of strong, declared
  evidence_ (`aria-invalid`, `aria-selected`, `aria-current`, `aria-pressed`, `aria-checked`, `aria-disabled`,
  `aria-required`, native validity/required/disabled/selected, `role="alert"`). A state that is only guessed
  from class names, data tokens, ids or words is an inference and is reported as CA-SEM-002 instead, however
  well corroborated (ColorAdapt may still add its cue, which is an adaptation, not a claim). The color-only check ran and returned
  color-only: no existing cue (icon, symbol or state text, pseudo-content) and, against comparable peers in
  another state, only paint differs (no geometry, weight, decoration, border style, shadow, icon or text
  difference) — or the element is an empty sized box (a dot). Elements without peers (other than dots) are
  `cannot-compare` and produce nothing. Context: the state.
- **Evidence**: `semantic.state`, `semantic.confidence`, `semantic.signals` (inference; at most six, sanitized
  `source: value (strength)`), `semantic.colorOnly` (observed).
- **Severity inputs**: `error`/`invalid`/`required`: information loss total, impact major on an interactive
  element or field (else moderate); `selected`/`active`/`disabled` family: partial, major if interactive;
  `positive`/`negative`/`increase`/`decrease`: partial, minor; others partial, moderate. Redundancy `absent`.
  Critical needs an interactive element in a total-loss state.
- **Confidence**: HIGH.
- **Adaptation status**: `adapted` when the element carries M6's cue; `not-applied` if cues are on but none
  rendered; `not-enabled` if cues are off; `unsupported` when no safe placement exists (already underlined,
  grid host).
- **Limitations**: needs evidence for the state and a peer to compare with; vocabulary is a small English/Russian
  set plus ARIA/native state. Does not prove the state is communicated _only_ visually (assistive technology may
  get it through ARIA).
- **Recommendation**: do not use color as the only indicator; add an icon, text label, underline, border style
  or shape that changes with the state; expose the state with ARIA if missing. For required/invalid/error the
  wording says to make the state visible without color, without prescribing a glyph.
- **Related to**: WCAG 1.4.1 Use of Color.

## CA-SEM-002 — Possible color-only state: needs review

- **Category**: `semantic-state` / `ambiguous-semantic-color`. **Default severity**: low. **Assessment**: manual-review. **Source**: M6. **Simulation-based**: no.
- **Detection**: as CA-SEM-001, but the state rests on an **inference**: the semantic confidence is medium or
  low, or it is high only because several guessed signals (a class name plus a context token, ...) agree and
  nothing strong, declared by the page, supports it.
- **Evidence**: same keys as CA-SEM-001.
- **Confidence**: LOW when the semantic confidence is low, otherwise MEDIUM (never HIGH: it is an inference).
  Adaptation status `not-applicable` (the finding is a review prompt; M6's own cue, if any, is an adaptation).
- **Limitations**: a review prompt, never a defect claim; never above low severity.
- **Recommendation**: check whether the element shows a state by color alone; add a non-color indicator, or
  expose the state with a real attribute (`aria-invalid`, `aria-selected`).
- **Related to**: WCAG 1.4.1 Use of Color.

## CA-SVG-001 — Inline SVG paint hard to see against its background

- **Category**: `svg` / `icon-conflict`. **Default severity**: medium. **Assessment**: issue. **Source**: M5 SVG analysis (M1, M2, M3). **Simulation-based**: yes.
- **Detection**: an outermost inline SVG that is not decorative (not `aria-hidden`/`role=presentation|none`
  outside an interactive control), is not owned by the chart layer or classified chart-like, has one effective
  paint (no unsupported or partial reason) over a resolved solid background, and either (context
  `contrast`) the contrast is below 3:1, or (context `distinguishability`, per profile) the pair is
  distinguishable for normal vision (≥ 0.1) but simulated below 0.1.
- **Evidence**: `colors.pair`, then `contrast.ratio` and `contrast.target` (3:1, engineering) for contrast, or the
  per-profile distance evidence of CA-COLOR-002.
- **Severity inputs**: information loss total below 1.5:1 or simulated distance below 0.05; impact major if
  interactive, else minor. Model confidence caps severity as in CA-COLOR-002.
- **Limitations**: the SVG's meaning (decorative or not) is inferred only from ARIA; icons whose color carries
  meaning are better served by a label.
- **Recommendation**: raise the contrast to at least 3:1; pair meaningful colors with a text label or shape.
  M3's suggestion for the active profile is shown when validated.
- **Related to**: WCAG 1.4.11 Non-text Contrast.

## CA-SVG-002 — Inline SVG cannot be analyzed automatically

- **Category**: `svg` / `analysis-incomplete`. **Default severity**: info. **Assessment**: manual-review for reasons that mean "the colors may carry meaning and cannot be modeled" (`paint-gradient`, `paint-pattern`, `paint-server`, `paint-context`, `multi-paint`, `use-shared-paint`, `use-unresolved`, `use-external`); analysis-limitation for the rest (e.g. `complex-svg`, `animated`, `filter`, `mask`, partial reasons, unresolved background). **Source**: M5. **Simulation-based**: no.
- **Detection**: a non-decorative, non-chart outermost inline SVG with an unsupported reason, a partial reason, or
  an unresolved background. Context: the reason.
- **Evidence**: `svg.reason`, `svg.paints`, `svg.shapes`.
- **Limitations**: no conclusion about the SVG; adaptation status `unsupported`. Severity is never above info
  (a manual-review is capped at low by the default anyway).
- **Recommendation**: review manually if the colors carry meaning; tell different colors apart by shape, label
  or pattern; mark decorative SVG `aria-hidden="true"`.
- **Related to**: none.

## CA-CHART-001 — Chart series told apart by color alone

- **Category**: `chart` / `series-color-conflict`. **Default severity**: medium. **Assessment**: issue. **Source**: M7 charts (with M2). **Simulation-based**: yes.
- **Detection**: a chart recognized with HIGH confidence (status `supported`, or `limited` for a legend or
  encoding reason) in which, for an audited simulated profile, at least one pair of series has simulated colors
  closer than `CHART_PAIR_DISTANCE` (0.12 OKLab) **and** the page's own non-color encodings (dash, marker,
  pattern, point shape, direct label, read with ColorAdapt's changes ignored) do not tell the pair apart. No
  verdict for `sequential-palette`, `too-many-series`, `too-large`, heatmaps or gradient fills (colors there
  mean magnitude or are unreadable). One finding per chart per profile set; context: the chart type.
- **Evidence**: `chart.type`, `chart.confidence`, `chart.series`, `<p>.chart.pairs` (at most six pairs),
  `<p>.chart.minDistance` (model estimate), `chart.existing`.
- **Severity inputs**: information loss `total` for a two-series chart, else `partial`; impact moderate;
  non-interactive (so never critical). Redundancy `absent`.
- **Confidence**: HIGH when the classification is HIGH, otherwise MEDIUM.
- **Adaptation status**: from the chart layer for the active profile: `adapted` when it wrote an encoding,
  `no-safe-candidate` (`encoding-exhausted`), `not-applied`, `unsupported`, `not-enabled`.
- **Limitations**: depends on M2 (PARTIAL). Inline SVG only. The finding stays after M7 adapts the chart,
  because the page's own SVG still relies on color.
- **Recommendation**: give each series a distinct dash/marker/pattern and mirror it in the legend; or label
  series directly.
- **Related to**: WCAG 1.4.1 Use of Color.

## CA-CHART-002 — Chart legend cannot be paired with its series

- **Category**: `chart` / `legend-ambiguous`. **Default severity**: low. **Assessment**: manual-review. **Source**: M7. **Simulation-based**: no.
- **Detection**: a HIGH-confidence chart that M7 refused for `legend-ambiguous`, `html-legend` or
  `pie-without-legend`. Context: the reason.
- **Evidence**: `chart.type`, `chart.reason`.
- **Limitations**: a review prompt, not a defect; adaptation status `unsupported`.
- **Recommendation**: give each series a unique key (`data-series`, a title or aria-label) that the legend
  repeats; reflect non-color encodings in the legend entry.
- **Related to**: WCAG 1.4.1 Use of Color.

## CA-CHART-003 — Chart type not audited automatically

- **Category**: `chart` / `unsupported-chart`. **Default severity**: info. **Assessment**: manual-review. **Source**: M7. **Simulation-based**: no.
- **Detection**: a HIGH-confidence chart that is `unsupported` (heatmap, area/stacked types, gradient fill,
  animated, filter, mask, foreign object, embedded image, too large) or `limited` for `sequential-palette` or
  `too-many-series`. An SVG that merely _might_ be a chart (MEDIUM/LOW confidence) is not reported.
- **Evidence**: `chart.type`, `chart.reason`.
- **Limitations**: says nothing about the chart; "not audited" is not "inaccessible".
- **Recommendation**: review under a color vision simulator; for sequential data make sure lightness (not only
  hue) carries the order.
- **Related to**: WCAG 1.4.1 Use of Color.

## CA-CHART-004 — Canvas chart detected: manual review required

- **Category**: `chart` / `unsupported-canvas-chart`. **Default severity**: info. **Assessment**: manual-review. **Source**: M7. **Simulation-based**: no.
- **Detection**: a `<canvas>` classified `canvas-chart` (a chart word in its class, id, role, aria-label or
  data-* names or two ancestors, and no "other" word such as game, map or video). Canvases classified otherwise
  are not reported.
- **Evidence**: `canvas.hint`.
- **Confidence**: MEDIUM. **Limitations**: a canvas has no structure to read; being a canvas is never a failure.
- **Recommendation**: review manually; consider different line styles, markers or patterns and a text
  alternative for the data.
- **Related to**: WCAG 1.4.1 Use of Color.

## CA-IMG-001 — Functional raster icon hard to tell from its background

- **Category**: `image` / `icon-conflict`. **Default severity**: medium. **Assessment**: issue. **Source**: M8 image adaptation (M2, M3). **Simulation-based**: yes.
- **Detection**: the image layer (active only with `adaptImages`) read a small functional single-color icon
  (HIGH-confidence `monochrome-icon`, on a known solid background) and either recolored it (`pixel-adapted`,
  status `adapted`) or found no safe recoloring (`no-safe-candidate`).
- **Evidence**: `image.kind`, `image.layer`.
- **Severity inputs**: impact major if interactive, else minor; information loss partial.
- **Limitations**: needs `adaptImages` (pixel reading is opt-in); never reported without it. The simulation
  weight is M8's; the audit does not repeat the pixel analysis. The page's original source is what is judged,
  not the generated bitmap.
- **Recommendation**: use a higher-contrast icon color or an SVG; pair the icon with a visible text label.
- **Related to**: WCAG 1.4.11 Non-text Contrast.

## CA-IMG-002 — Raster chart detected: manual review required

- **Category**: `image` / `unsupported-raster-chart`. **Default severity**: info. **Assessment**: manual-review. **Source**: M8. **Simulation-based**: no.
- **Detection**: a non-decorative image classified `chart-raster` with HIGH or MEDIUM confidence (a chart word
  in its name, or — when the layer ran — the structure of one). Photographs, logos, illustrations and decorative
  images are never findings.
- **Evidence**: `image.kind`, `image.confidence`.
- **Limitations**: its series are pixels; ColorAdapt never changes the image and cannot audit it.
- **Recommendation**: review manually; offer the data as text or an SVG chart; use direct labels or patterns.
- **Related to**: WCAG 1.4.1 Use of Color.

## CA-IMG-003 — Functional image could not be read

- **Category**: `image` / `unreadable-image`. **Default severity**: info. **Assessment**: manual-review. **Source**: M8. **Simulation-based**: no.
- **Detection**: a non-decorative image inside a link or button, rendered at most 64px, whose pixels cannot be
  read: the layer reports `tainted`, or (without the layer) it is `http(s)` from another origin without a
  `crossorigin` attribute.
- **Evidence**: `image.readability`, `image.context`.
- **Confidence**: MEDIUM. **Limitations**: ColorAdapt cannot tell whether the color carries meaning.
- **Recommendation**: serve the image with CORS and a `crossorigin` attribute, or inline it as SVG; give the
  control a visible text label.
- **Related to**: none.
