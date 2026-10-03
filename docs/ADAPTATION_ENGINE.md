# Adaptation Engine (M3)

`core/adaptation` answers one question:

> How can the original colors of an interface be changed as little as
> possible to raise their estimated distinguishability for the selected
> vision profile, without breaking ordinary contrast, visual hierarchy or the
> site's design?

It is **model-guided accessibility adaptation**: it uses estimated
distinguishability from the M2 simulation (`docs/COLOR_VISION_SIMULATION.md`).
It does not "correct" color vision, restore normal vision, or make a page look
normal, and nothing here is a medical claim.

Pure TypeScript: no React, WebExtension API, DOM, storage or popup code.

**Status (M3.R1).** `M3 ENGINEERING STATUS: PASS` — validated in a real Chromium
(see "Real-browser validation"). `UPSTREAM SCIENTIFIC CONFIDENCE: PARTIAL` — M2
stays `PARTIAL` (Machado linear-RGB assumption), and every result keeps its
`ModelConfidence`. The engineering pass does not upgrade the science.

## Goals

- Smallest perceptual change that is still enough.
- Improve **simulated** distinguishability (M2), not raw RGB distance.
- No material WCAG contrast regression.
- Deterministic, bounded, fail-safe: when nothing safe exists the answer is
  `no-safe-candidate` and the original color stays.
- Reversible, per-element, and never compounding.

## Non-goals (M3)

MutationObserver / SPA lifecycle (M4), Shadow DOM, iframes, SVG (M5, see below), Canvas, charts,
image recoloring, semantic meaning (red = error is **not** preserved
artificially; that is M6), developer audit, cloud services, background
adaptation, global CSS-token rewriting.

## Pipeline

```text
analysis (M1) → eligibility → findAdaptation (per color pair)
   problem detection → candidate generation → evaluation → scoring
   → safe selection → strength → AdaptationResult
→ AdaptationPlan (data only) → content layer → one <style> element
```

| File                     | Role                                                                          |
| ------------------------ | ----------------------------------------------------------------------------- |
| `constraints.ts`         | All engineering thresholds, score weights, contrast floor.                    |
| `candidate-generator.ts` | Deterministic OKLCH search stages.                                            |
| `gamut.ts`               | OKLCH/OKLab → valid 8-bit sRGB (chroma-reducing gamut mapping).               |
| `candidate-evaluator.ts` | Simulates a candidate (M2), measures contrast and change, checks constraints. |
| `candidate-score.ts`     | Transparent score and weighted design-change distance.                        |
| `optimizer.ts`           | `findAdaptation`: the search itself, strength, statuses.                      |
| `adaptation-plan.ts`     | `createAdaptationPlan`: eligibility + per-element changes + summary.          |
| `stylesheet-manager.ts`  | Applies a plan as one stylesheet; restores; suspends for analysis.            |

## `findAdaptation`

```ts
findAdaptation({ foreground, background, profile, severity?, strength?, constraints?,
                 originalVisionAnalysis? }): AdaptationResult
```

`AdaptationResult` is a discriminated union (`src/domain/models/adaptation.ts`):

| `status`            | Meaning                                                | Extra fields                                                                                                             |
| ------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `unchanged`         | Nothing to do (see reasons below).                     | `originalContrast`, `originalVisionAnalysis`                                                                             |
| `adapted`           | A safe candidate was found.                            | `optimizedColor`, `adaptedVisionAnalysis`, `adaptedContrast`, `changeDistance`, `score` (+ the unchanged-variant fields) |
| `no-safe-candidate` | Candidates exist but none satisfies the constraints.   | `originalContrast`, `originalVisionAnalysis`                                                                             |
| `unsupported`       | Refused (custom profile, non-opaque/non-finite input). | —                                                                                                                        |

Every variant carries `originalColor`, `background`, `profile`, `severity`,
`confidence`, `stats` and `outputColor`. `outputColor` is the only color that
is safe to apply: it equals the original for every status except `adapted`, so
callers cannot accidentally apply a rejected candidate.

`unchanged` reasons: `normal-vision`, `strength-zero`, `already-distinguishable`,
`below-visible-change` (strength so small the 8-bit color does not change).
`no-safe-candidate` reasons: `no-candidate-meets-constraints`,
`search-budget-exhausted`, `strength-interpolation-unsafe`.

### Order of decisions (cheapest first)

1. invalid / non-opaque input → `unsupported`; `custom` → `unsupported`;
2. `normal` → `unchanged`; strength 0 → `unchanged` (no search);
3. **detection heuristic:** simulated distance ≥ `problemSimulatedDistance` →
   `unchanged: already-distinguishable` (early exit, no search);
4. search; 5. strength; 6. final safety check.

## Perceptual space and candidate generation

All search happens in **OKLCH** (L lightness, C chroma, H hue), around the
original color, with the **background fixed** (foreground-first policy).
Never random; a pure function of the input.

Stages are tried in order and the search **stops at the first stage that
contains a feasible candidate**, so hue changes only when lightness/chroma
cannot solve the problem:

| Stage              | Hue offsets      | Lightness offsets      | Chroma ×    | Max candidates |
| ------------------ | ---------------- | ---------------------- | ----------- | -------------- |
| `lightness-chroma` | 0                | ±0.45 in steps of 0.03 | 1, 0.6, 1.3 | 93             |
| `small-hue`        | ±10°, ±20°, ±30° | ±0.40 in steps of 0.05 | 1, 0.7, 1.2 | 306            |
| `wide-hue`         | ±45…±150°, 180°  | ±0.40 in steps of 0.05 | 1, 0.7      | 374            |

Candidates are de-duplicated by hex across stages and never equal the original.

**Neutrals:** below chroma 0.02 (white, black, gray) hue is meaningless, so
only `lightness-chroma` runs and no hue is ever invented. **Near-neutrals**
(chroma < 0.04) have an unstable hue, so `wide-hue` is skipped.

**Gamut:** a candidate is converted to sRGB and, if out of gamut, keeps its
L and H and loses chroma (14-step bisection) instead of being clipped
per-channel (clipping would shift the hue and invalidate the score).
Candidates are then **quantized to 8 bits**, so the evaluated color is exactly
the applied color. Non-finite values are dropped; the output is never
NaN/Infinity/out of range.

## Constraints (hard)

A candidate is feasible only if **all** hold:

1. WCAG contrast ≥ `contrastFloor(originalContrast)` (below);
2. OKLab distance from the original ≤ `maxDesignChange`;
3. simulated distance ≥ `targetSimulatedDistance`;
4. simulated distance improved by ≥ `minDistanceImprovement`.

No feasible candidate → `no-safe-candidate`. The engine never forces a
replacement and never changes the background to compensate.

## WCAG contrast policy

CVD distinguishability and WCAG luminance contrast are separate signals; one
never replaces the other. Policy (an engineering regression guard, **not** a
legal or conformance interpretation of WCAG):

```text
contrastFloor(c) = min(c, max(highestTier ≤ c among {7, 4.5, 3}, c × 0.95))
```

So an adaptation never drops below a WCAG ratio tier the pair already met, and
loses at most 5 % otherwise. 7.0 → 2.0 is rejected even if the simulated
distance improves (`tests/core/adaptation/optimizer.test.ts`). The engine does
**not** raise a low contrast to a WCAG minimum on its own; it only does not
make it worse (a pair may gain contrast as a side effect).

## Scoring

Higher is better (`candidate-score.ts`, weights in `SCORE_POLICY`):

```text
benefit        = clamp01((candDist − origDist) / (targetDist − origDist))   // saturates at target
designPenalty  = 1.5 · weightedChange / maxDesignChange
confPenalty    = (confidenceMultiplier − 1) · designPenalty
contrastPenalty= 1.0 · max(0, (origContrast − candContrast) / origContrast)
score          = 1.0 · benefit − designPenalty − confPenalty − contrastPenalty
```

`weightedChange` is the OKLCH distance with the hue term scaled by 1.6, using
the chord `2·√(C₁C₂)·sin(Δh/2)`: a hue shift costs more than an equal-sized
lightness/chroma shift, and the hue term vanishes for neutrals.

Because `benefit` saturates, among candidates that reach the target **the
smallest change wins** — best ≠ maximum distance. Ties break by smaller change,
then hex, so selection is a total order.

Confidence multipliers: `SUPPORTED_MODEL` 1, `MODEL_ASSUMPTION` 1.25,
`APPROXIMATION` 1.5.

## Engineering thresholds

All in `constraints.ts` → `ENGINEERING_THRESHOLDS`. They are tuning knobs for
a safe MVP, **not** scientifically derived or calibrated against M2, and are
deliberately separate from the M1 conflict thresholds
(`core/conflicts/thresholds.ts`), which remain an uncalibrated UI heuristic.

| Name                                  | Value       | Role                                                                  |
| ------------------------------------- | ----------- | --------------------------------------------------------------------- |
| `problemSimulatedDistance`            | 0.12        | **Detection heuristic**: below this, try to adapt.                    |
| `targetSimulatedDistance`             | 0.18        | **Adaptation target**: candidates must reach this.                    |
| `minDistanceImprovement`              | 0.04        | Required simulated-distance gain.                                     |
| `contrastRegressionTolerance`         | 0.05        | Allowed relative contrast loss (inside the tier guard).               |
| `maxDesignChange`                     | 0.30        | Max OKLab distance from the original (0.20 for approximation models). |
| `maxCandidateEvaluations`             | 800         | Structural search budget per color pair.                              |
| `neutralChroma` / `nearNeutralChroma` | 0.02 / 0.04 | Neutral handling.                                                     |

The detection threshold sits below the target (hysteresis), so a color that was
just adapted is never re-detected as a problem. The engine decides from the
continuous M2 metrics (`simulatedDistance`, WCAG contrast); the M1 severity
label is not consulted. `distanceLoss` is reported in `VisionAnalysis` but is
not a decision input in M3.

## Adaptation strength

`adaptationStrength` ∈ [0, 1] (settings / popup slider):

- **0** → original color exactly; no search.
- **1** → the optimizer's candidate.
- **0 < s < 1** → deterministic **OKLab** interpolation original → optimized
  (never gamma-encoded RGB), re-gamut-mapped and re-quantized, then re-checked:
  contrast ≥ floor, change ≤ cap, simulated distance not worse than the original.
  If the intermediate fails (rare) → `no-safe-candidate: strength-interpolation-unsafe`.
  Intermediate results improve distinguishability only partially by design; they
  report their own measured metrics.

The plan clamps strength to [0, 1] and treats a non-finite value as 0.

## Model confidence

`VISION_PROFILE_CONFIDENCE` mirrors the M2 scientific status and is carried
on every result, change and plan (never hidden):

| Profile                              | Confidence                                                   |
| ------------------------------------ | ------------------------------------------------------------ |
| protanopia, deuteranopia, tritanopia | `SUPPORTED_MODEL`                                            |
| protanomaly, deuteranomaly           | `MODEL_ASSUMPTION` (Machado 2009, linear-RGB interpretation) |
| tritanomaly, achromatopsia           | `APPROXIMATION`                                              |
| custom                               | `UNSUPPORTED` → `unsupported`, never adapted                 |

Weaker models stay adaptable but are more conservative: higher design-change
penalty and, for approximations, a tighter change cap. No claim of canonical
or medical correctness is made for `MODEL_ASSUMPTION` results.

## Fail-safe policy

Eligibility (`adaptation-plan.ts`):

- `analysisStatus: resolved` → may adapt; `partial` / `unsupported` (gradient,
  image, mixed, depth-limited) → **never** adapted, counted as `unresolved`;
- out of scope (skipped): `svg`, `image`, `chart`, `icon`, disabled elements,
  elements without own text (unless form controls), and categories turned off in
  settings (`improveLinks`, `improveStatusIndicators`, `improveUIColors`);
- the content layer also refuses elements whose **computed `color` differs from
  the effective foreground** (opacity < 1 on the element or any ancestor, or a
  translucent `color`): the effective foreground already folds opacity in, so
  writing it into `color` would apply opacity twice. They are reported as
  `unresolved`. Verified in Chromium: `opacity: .9` (self, ancestor, nested) and
  `rgba(…, .8)` are skipped; `opacity: 1` and `rgba(…, 1)` are **not** falsely
  skipped;
- elements whose `color` is **animated** (CSS `@keyframes` or Web Animations,
  on the element or an ancestor it inherits from) are also `unresolved` — see
  "CSS application policy".

Master switch off, site disabled, `normal`, strength 0 → no changes.

## Reversibility and idempotency

- Output is one `<style id="coloradapt-stylesheet">` with
  `[data-coloradapt-id="…"]:not(#coloradapt-specificity) { color: … !important }`;
  no inline styles. Disabling removes the element → exact original.
- **The original page is always the source of truth.** Every analysis runs
  inside `StylesheetManager.withOriginalStyles()`, which swaps the stylesheet
  for a `transition: none` rule for the duration of the synchronous read and
  puts the adaptation back, so re-scanning an adapted page sees the original
  colors and can never compound.
- Covered by tests: repeated enable/disable cycles, repeated analysis and
  refresh, profile switches, fresh controllers — in jsdom **and** in Chromium
  (5 ON/OFF cycles, 4 analyze+refresh rounds, profile switches across 3
  profiles twice, strengths 0/.5/1 in any order; every OFF restores the exact
  computed styles and the page DOM except the `data-coloradapt-id` attribute).

## CSS application policy

Established in a real browser (M3.R1); jsdom cannot model any of this. The plan
is never trusted over the real cascade: **`StylesheetManager.apply` reads the
browser's computed value back for every change.** A change whose computed
`color` is not the planned one is dropped from the stylesheet and from
`plan.changes`, and counted in `plan.summary.notApplied` — the plan can never
say "adapted" while the browser keeps the original.

| Case                                                   | Behavior                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| `.class`, `#id`, selector chains, plain inline style   | adapted                                                            |
| existing `.class { color: … !important }`              | adapted (ours wins: equal specificity band + the bump below)       |
| existing `#id { color: … !important }`                 | adapted (specificity bump)                                         |
| `#a > #b { color: … !important }`, inline `!important` | **not applied** — caught by the read-back, counted in `notApplied` |
| `transition: color …`                                  | no fade in/out, no flicker on re-analysis (see below)              |
| animated `color` (own or inherited)                    | **skipped** (`unresolved`); the page's animation keeps running     |
| animation not touching `color` (e.g. `transform`)      | adapted                                                            |
| `:hover` / `:focus` / `:active` `color` rules          | adapted color **persists** in those states (documented limitation) |

**`!important` policy.** An adaptation has to beat the page's own rules, so it is
`!important`, never an inline style. To keep that from being excessively
aggressive it is the only `!important` we emit, it targets a single tagged
element, and its selector carries a deliberate specificity bump
(`:not(#coloradapt-specificity)` — the argument never matches, but counts as an
id, giving specificity (1,1,0)). That out-ranks a single-id `!important` rule
without an arms race: inline `!important` and multi-id chains still win, and are
_reported_, not fought.

**Transitions.** A page's `transition: color` would otherwise (1) fade the
adaptation in and make `getComputedStyle` report a mid-flight value, (2) fade it
back out on OFF, and (3) flicker on every re-analysis (suspend → original,
restore → fade back to adapted). Every style-state commit therefore writes the
new stylesheet **together with**
`[data-coloradapt-id] { transition: none !important }`, forces one synchronous
style flush, and then rewrites the stylesheet without the suppression — all in
one task. Nothing is painted in between, the suppression is never left in the
document, and no page style is mutated (fully reversible). Verified by sampling
the computed color on every animation frame through apply, 3× analyze + refresh
and OFF: only the original and the adapted color ever occur. (Mutation-checked:
removing the suppression makes the E2E fail.)

**Animations.** Skipping animated `color` is deliberate. The computed color of an
animated element is a snapshot of a moving value, so nothing derived from it can
be stable, and an `!important` rule outranks `@keyframes` — it would silently
freeze the page's animation. Detection uses `document.getAnimations()`
(keyframes containing `color`; target is the element or one of its ancestors;
not a pseudo-element). Skipped elements are `unresolved`. Animations that do not
animate `color` are unaffected.

**Pseudo-states.** M3 adapts the normal state only, and because the rule is
`!important` the adapted color is also shown while hovered/focused/active: a
page's own `:hover { color }` is overridden for adapted elements (non-color hover
feedback such as outline/background is untouched). Adapting pseudo-states is not
in M3; with ColorAdapt OFF the page's own state colors are back exactly. Known
limitation, tested in Chromium so it cannot change unnoticed.

**Quantization.** Candidates are generated on the 8-bit sRGB grid, so the
evaluated color is exactly the color written to CSS. Tests (a) assert the grid
for every generated candidate, (b) re-evaluate adapted outputs after a hex round
trip (metrics identical to 1e-10), and (c) include a pair where a floating-point
color and its 8-bit rounding disagree on feasibility — only the rounded color is
ever judged or applied.

## Inline SVG (M5)

SVG reuses this engine unchanged; `docs/SVG_ANALYSIS.md` has the details. What differs is the
**target** of a plan, not the search:

- An inline `<svg>` is one `ElementDescriptor` (`svg` info, one effective paint over the page
  background). `findAdaptation` runs on that pair (memoized on the pair like any other), with
  the same constraints, the same model confidence and the same `no-safe-candidate` outcome.
- `AdaptationChange.property` is `color`, `fill` or `stroke`. `currentColor` paint is adapted
  through `color` on the `<svg>` (never materialized as `fill`); inherited paint through
  `fill`/`stroke` on the `<svg>`; shape-declared paint on each shape; `<use>` instances on the
  `<use>` element. All changes of one SVG carry the same adapted value and an `ownerId`.
- Rules are keyed by (element, property). Rules sharing an `ownerId` are replaced, verified and
  dropped **as a group**: after the read-back of each target, every visible paint of every shape
  in the `<svg>` must read the planned color (`verifySvgPaints`), otherwise none of the unit's
  rules is kept and it counts once in `notApplied`. `AdaptationSummary` counts units, not rules.
- Eligibility is stricter than for text: exactly one distinct visible paint; no filter, mask, blend
  mode, marker, paint server, animation, `foreignObject` or embedded image; no translucent paint
  (an opaque rule cannot reproduce a composite, the same reason `findNotAdaptable` skips text whose
  `color` differs from its effective foreground); resolved background. Gated by `adaptSVG` and
  `improveUIColors`.
- The analysis never sees the adaptation: SVG analysis also runs inside `withOriginalStyles`, and
  its style probe (`StylesheetManager.withProbe`) sits on top of the page's original styles.

## Semantic cues (M6)

M6 is not another recoloring step; `docs/SEMANTIC_ACCESSIBILITY.md` has the details. What it changes
here is only the stylesheet: the one managed `<style>` also holds the static CSS of the cue kinds in
use (`StylesheetManager.setCueCss`), so repair, ownership, restore and the "analysis sees the page's
own styles" rule (`withOriginalStyles`, which suspends the whole sheet including cues) all apply
unchanged. `ruleCount` still counts color rules only; `hasContent` also counts cue CSS. M3 may
recolor an element and M6 still adds its cue: they are independent accessibility channels, and the
cue is added only if the _original_ meaning was color-only.

## Real-browser validation

`pnpm test:e2e` (builds, then Playwright + Chromium with the built extension
loaded, pages served from a local http server — content scripts do not match
`file://`). Chromium only. **Firefox: NOT_RUN** — Playwright cannot load a WXT
Firefox MV3 extension without extra tooling (web-ext/RDP), which would be
brittle; the Firefox _build_ is verified (`pnpm build:firefox`).

Suites (`e2e/`): `lifecycle` (ON/OFF, accessible pair, cycles, re-analysis,
profile and strength switching, model confidence, site settings, reload),
`css-policy` (specificity, `!important`, transitions, animations, pseudo-states,
opacity guard), `demo` (the repo's demo page, 4 profiles, plan == browser
everywhere). Core invariant asserted throughout: **for every element, the
browser's computed color equals the plan's color if the plan changed it, and the
original otherwise.** No sleeps or retries: waits are for style flushes
(`requestAnimationFrame`, `getAnimations().finished`) or `expect.poll` on
asynchronous page-load adaptation.

Informational (never a gate): on the demo page the enable round trip was ~20 ms
in headless Chromium on the development machine.

Defects the real browser found (all fixed, all covered): the plan said ADAPTED
while an `#id !important` rule or inline `!important` kept the original color;
`transition: color` made the adaptation fade in (mid-flight computed value);
an animated `color` was frozen by the `!important` rule.

## Benchmark methodology

`tests/benchmarks/` — deterministic, no randomness/network/screenshots.

- **Palette** (`adaptation-pairs.ts`): 49 fixed hex pairs in 15 categories
  (red/green, green/brown, blue/purple, cyan/gray, yellow/light-green,
  red/black, red/white, green/white, orange/green, purple/blue, muted UI, pastel,
  dark mode, near-neutral, brand-like saturated). Accessible pairs are included
  on purpose.
- **Profiles:** protanopia, deuteranopia, tritanopia (published models, strength
  1, 147 rows); protanomaly, deuteranomaly (98 rows; results depend on the M2
  `MODEL_ASSUMPTION`); `custom` (must never adapt); strengths .25/.5/.75/0.
- **Per row:** foreground, background, profile, original/adapted simulated
  distance and improvement, original/adapted WCAG contrast, design change
  (OKLab), hue/lightness shift, candidate count, stages searched, selected stage,
  status.
- **Hard assertions (fail the suite, independent of any average):** contrast ≥
  floor, simulated distance ≥ target (strength 1) / not below the original
  (partial strength), design change ≤ cap, finite numbers, 8-bit in-gamut opaque
  output, candidates ≤ configured max, unsupported model never adapted,
  non-adapted output byte-identical to the input.
- **Diagnostics (loose bounds, not product KPIs):** wide-hue ≤ half of adapted;
  median design change < 0.2; ≤ 10% of adapted outputs pushed to a lightness
  extreme or a > 45° hue shift; p95 candidates ≤ 400.
- **Report:** `benchmark-report/adaptation-benchmark.{json,html}` (gitignored)
  with before/after and simulated before/after swatches. Visual sanity was
  checked by eye on a sample; the report never grades "pretty".

Results (current thresholds, strength 1):

| set                                         | rows | adapted | unchanged | no-safe |
| ------------------------------------------- | ---- | ------- | --------- | ------- |
| protan + deutan + tritan                    | 147  | 61      | 86        | 0       |
| protanomaly + deuteranomaly (M2 assumption) | 98   | 41      | 57        | 0       |

For the 61 dichromat adaptations: simulated-distance improvement median 0.135
(min 0.069, max 0.183); design change median 0.157, p95 0.193, max 0.215 (cap
0.3); WCAG contrast improved in all 61 (≥ 1.28× the original); contrast-floor
violations 0; candidate evaluations per searched row median 58, p95 84, max 86
(budget 800); hue shift ≈ 0° (all in the lightness/chroma stage).

**Search stages: all 61 were solved in stage 1; stages 2–3 never ran on this
palette**, so hue search is exercised only by unit tests (the palette is
solvable by lightness alone) and "systematic extreme hue shifts" cannot occur
here by construction. Adaptations are mostly lightness shifts within the
original hue family; distinguishability, not WCAG AA, is the target (e.g.
red/green 1.20:1 → 1.70:1).

## Limitations

- **Per-element, not global.** A foreground used on several backgrounds, or a
  CSS variable (`--brand-color`), is adapted per element against its own
  resolved background; nothing is optimized jointly and tokens are never rewritten.
- **Foreground only.** Background adaptation is architecturally possible but off;
  if the foreground cannot be fixed the result is `no-safe-candidate`.
- Only foreground paint: `color` for text, and (M5) `color`/`fill`/`stroke` for single-paint inline
  SVG. `border-color`, `background-color` are not adapted; multi-color SVG, gradients and patterns
  are classified and left alone (`docs/SVG_ANALYSIS.md`).
- Not a WCAG fixer (see contrast policy). A low-contrast pair that is already
  "distinguishable" under the profile is left alone.
- No semantic awareness: an adapted "error red" may no longer look like the
  site's red. Semantic constraints are M6; the result/plan types leave room for them.
- Thresholds and weights are uncalibrated engineering values; the M2
  Machado/linear-RGB question remains open (`MODEL_ASSUMPTION`).
- Quantized to 8-bit sRGB; wide-gamut/`color()` inputs are adapted in sRGB.
- **Hover/focus/active colors of adapted elements are overridden** (see "CSS
  application policy"); inline `!important` and multi-id `!important` rules are
  not adaptable (reported as `notApplied`); animated `color` is skipped.
- **Dynamic content** is handled from M4 on, outside this engine (the engine has no
  `MutationObserver`): `docs/DYNAMIC_ANALYSIS.md`. Its per-element planning is exposed
  as `planElement` for the incremental path.
- Chromium only in E2E; Firefox is build-verified but its runtime behavior is
  `NOT_RUN`.
- The benchmark palette is hand-picked and solvable by lightness alone; it says
  nothing about real-page distributions or about hue-search quality.
