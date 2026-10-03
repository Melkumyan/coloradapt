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

Known M3 limitations carried forward: pseudo-state colors of adapted elements are
overridden, inline `!important` is not adaptable.

## M4 — Dynamic Sites / Incremental Analysis ✅ (engineering PASS, validated in M4.R1; tag `m4-dynamic-analysis`)

- One `MutationObserver` per document with explicit mutation classification
  (`NODE_ADDED`, `NODE_REMOVED`, `STYLE_AFFECTING_ATTRIBUTE`, `TEXT_CHANGE`,
  `STYLESHEET_CHANGE`, `IRRELEVANT`, `COLORADAPT_INTERNAL`).
- Self-mutation policy: ColorAdapt's own writes never start analysis.
- Per-frame batching with a bounded queue and an `IDLE/SCHEDULED/RUNNING/DIRTY` state machine.
- Affected-root resolution with de-duplication; bounded subtree invalidation for
  ancestor (background/opacity/visibility/CSS-variable) changes.
- Incremental analysis (`analyzeSubtrees`), delta adaptation (`AdaptationDelta`),
  rule-map `StylesheetManager.applyDelta`, stable per-element ids, removal cleanup.
- Controlled, counted full-rescan fallback (stylesheets, `<html>/<body>`, overflow).
- SPA navigation handled through the mutation pipeline (no History API hook).
- Local diagnostics and a deterministic mutation benchmark; 128 real-Chromium scenarios
  (23 in M4, 105 adversarial ones in M4.R1: insertion forms, attribute churn, net-zero
  batches, text, theme switches, stylesheets and links, CSSOM limitation, self-mutation
  and page-fight attacks, exact budget boundaries, reentrancy, lifecycle, retention
  proxies, SPA, infinite scroll, six local real-world fixtures).
- M4.R1 found and fixed six defects jsdom could not see (removed/disabled/`href`-swapped
  `<link>`, a per-frame repair loop against a page that deletes our `<style>`, analyzer
  budget losing the tail of straddling roots and depending on the clock); see
  `docs/DYNAMIC_ANALYSIS.md` ("M4.R1 validation").
- Not in M4: Shadow DOM, iframes, CSSOM-only restyles, SVG. NOT_VERIFIED in a real browser:
  the hidden-tab scheduler path, `dispose()`, actual GC, Firefox runtime (build only).
  See `docs/DYNAMIC_ANALYSIS.md`.

Next: **M5 — SVG** (not started).

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
