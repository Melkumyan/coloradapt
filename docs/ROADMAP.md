# Roadmap

Status markers: ✅ done in this foundation, 🚧 partially scaffolded, ⬜ planned.

## M0 — Foundation ✅

- Repository, WXT, React, TypeScript (strict), ESLint, Prettier, Vitest.
- Domain model for vision profiles, colors, conflicts, adaptation, settings.
- CI (lint, typecheck, test, build).
- Docs: README, ARCHITECTURE, PRODUCT, ROADMAP, PRIVACY, SECURITY,
  PERFORMANCE, DEVELOPMENT.
- Minimal working vertical slice (see below).

## M1 — Basic CSS Analysis ✅

- Bounded DOM scan (`core/analysis`).
- Foreground resolution: computed `color` (browser-resolved inheritance)
  with cumulative element/ancestor `opacity` applied.
- Background resolution: full ancestor traversal with alpha compositing
  (`core/color/composite.ts`), memoized per analysis pass, falling back
  to an opaque white page canvas — see `docs/CSS_ANALYSIS.md`.
- Gradient/image/mixed background detection and classification
  (`BackgroundKind`), with an `AnalysisStatus` (`resolved`/`partial`/
  `unsupported`) that keeps Conflict Detection from drawing contrast
  conclusions on backgrounds it couldn't confidently resolve.
- Per-side border colors, link/button/form-control/disabled coverage,
  nested-text deduplication, `visibility: collapse` handling.
- WCAG contrast calculation (`core/color/contrast.ts`).
- `ColorConflict` detection combining contrast + perceptual distance.

Explicit M1 policy (documented limitation, not a silent gap — see
`docs/CSS_ANALYSIS.md`'s "Known limitations"): pseudo-elements,
`::placeholder`, Shadow DOM, and iframes are not analyzed.

## M2 — Color Vision Simulation ✅ (scientific freeze: PARTIAL)

- `core/vision`: sRGB -> linear RGB -> model -> clip -> sRGB pipeline.
- Brettel 1997 (protanopia/deuteranopia/tritanopia, two half-planes),
  Machado 2009 (protanomaly/deuteranomaly), Viénot 1999 as an alternative
  protan/deutan model.
- Tritanomaly (interpolated Brettel) and achromatopsia (luminance) are
  explicit, labeled approximations.
- Validated severity in `[0, 1]`, alpha preserved, explicit clipping policy.
- `simulatePair` -> `VisionAnalysis` (original/simulated distance, loss, model),
  carried on `ColorConflict.vision`; WCAG contrast stays a separate signal.
- Reference vectors cross-validated against DaltonLens (dev-only tooling in
  `scripts/reference/`).
- The M1 heuristic matrices were removed.

M2.R1 (regression stabilization & scientific review): flaky wall-clock tests
made deterministic, constants cross-checked against libDaltonLens, Machado
linear-RGB documented as an engineering convention. Severity stays engine-level;
conflict thresholds stay uncalibrated.

Scientific freeze = PARTIAL: the Machado 2009 paper and the authors' page do
not state the matrix input space (primary review category D; Eq. 8-10 imply
linear RGB, but it is not explicit). Output is "Machado 2009, linear-RGB
interpretation", not canonical Machado output. The Eq. 17/18 erratum does not
affect the precomputed matrices. Resolving this to PASS needs author
confirmation. No PASS tag.

Still open: severity UI/settings field, calibrating conflict thresholds
against the new engine, a custom-profile model.

## M3 — Adaptation Engine ✅ (engineering PASS; upstream scientific confidence PARTIAL)

- Constrained candidate search in OKLCH (`core/adaptation`): lightness/chroma →
  small hue → wide hue, deterministic, structurally bounded, gamut-safe, 8-bit.
- Problem detection and adaptation target from the continuous M2 metrics
  (simulated distance, WCAG contrast) — separate, centralized engineering thresholds.
- Transparent scoring that prefers the smallest sufficient change; WCAG contrast
  regression guard; neutral handling; foreground-only.
- `AdaptationResult` (unchanged / adapted / no-safe-candidate / unsupported) with
  model confidence (`SUPPORTED_MODEL` / `MODEL_ASSUMPTION` / `APPROXIMATION` /
  `UNSUPPORTED`); `adaptationStrength` as OKLab interpolation.
- DOM-free `AdaptationPlan` applied via one stylesheet; analysis always reads the
  original styles (no compounding); only `resolved` elements are adapted;
  per-site overrides respected; popup shows adapted/unresolved counts.
- **M3.R1 (validation & freeze):** verified in real Chromium (Playwright E2E:
  ON/OFF exact restoration, 5 cycles, idempotent re-analysis, profile/strength
  switching, site settings, reload); CSS policy for specificity, `!important`
  (the applied result is read back: `notApplied` instead of a false "adapted"),
  transitions (no fade/flicker), animations (animated `color` skipped),
  pseudo-states (documented), opacity guard; 49-pair deterministic benchmark with
  hard safety assertions; quantization, minimal-change and confidence-propagation
  tests.
- `M3 ENGINEERING STATUS: PASS`; `UPSTREAM SCIENTIFIC CONFIDENCE: PARTIAL` (M2
  stays PARTIAL — Machado linear-RGB assumption). Thresholds remain uncalibrated
  engineering values. Firefox runtime E2E: NOT_RUN. See `docs/ADAPTATION_ENGINE.md`.

Still open: background adaptation (advanced mode), `border-color`/
`background-color`, token-aware (CSS variable) transformations, semantic
constraints (M6).

Known M3 limitations carried forward: no dynamic-content handling (M4), pseudo-state
colors of adapted elements are overridden, inline `!important` is not adaptable.

Next: **M4 — Dynamic Sites / Incremental Analysis** (not started).

## M4 — Dynamic Pages ⬜

- `MutationObserver`-driven incremental re-analysis (debounced).
- SPA navigation handling (URL change detection without full reload).

## M5 — SVG ⬜

- SVG fill/stroke color extraction and adaptation.
- Icon-aware handling.

## M6 — Semantic Accessibility ⬜

- Status/role detection beyond the current coarse heuristic
  (success/error/warning/active-inactive/buy-sell).
- Non-color reinforcement: icons, shapes, text labels, line-style variants.

## M7 — Charts ⬜

- SVG chart color/pattern adaptation.
- Canvas investigation (likely requires opt-in, given Canvas content isn't
  introspectable the way DOM/SVG are).

## M8 — Image Adaptation ⬜

- Image color analysis and optional correction.

## M9 — Developer Audit ⬜

- Full-page accessibility report: conflicts found, recommendations,
  exportable output.

## M10 — AI Semantic Engine ⬜

- Optional, isolated module for richer semantic understanding
  (e.g. classifying a badge as "success" vs. "error" when CSS alone is
  ambiguous). Explicitly **not** a dependency of the core engine — the
  extension must keep working fully offline without it.

## Minimal working vertical slice (proves the architecture)

Implemented in this foundation:

1. User toggles "Protection" on in the Popup.
2. Content script (`features/page-analysis/content-controller.ts`) runs
   the DOM Analyzer over the page.
3. Each element whose background was confidently resolved to a solid
   color goes through contrast + simulated-vision distance checks
   (`core/conflicts`); gradient/image backgrounds are counted as
   unresolved instead of guessed.
4. Resolved elements are checked by the Adaptation Engine (`core/adaptation`),
   which may produce a reversible, minimal foreground color change, applied via
   one injected stylesheet.
5. Popup's "Analyse page" button reports the conflict count back from the
   content script via the typed messaging layer.
6. Toggling "Protection" off calls `DISABLE_ADAPTATION`, which removes the
   stylesheet and returns the page to its original state.
