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

## M3 — Adaptation 🚧

- `AdaptationEngine.computeAdaptation` proposes lightness-only color fixes
  for high/critical conflicts.
- Reversible application via one injected stylesheet (`StylesheetManager`).
- `adaptationStrength` setting influences target contrast.

Still open: hue-aware alternatives, adapting more than `color`
(`border-color`, `background-color`), smarter per-role strategies (link
underlines vs. badge backgrounds, etc.).

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
4. High/critical conflicts get a reversible color fix
   (`core/adaptation`), applied via one injected stylesheet.
5. Popup's "Analyse page" button reports the conflict count back from the
   content script via the typed messaging layer.
6. Toggling "Protection" off calls `DISABLE_ADAPTATION`, which removes the
   stylesheet and returns the page to its original state.
