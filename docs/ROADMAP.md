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

## M2 — Vision Simulation 🚧

- Protanopia/deuteranopia/tritanopia/achromatopsia simulated via simplified
  matrices; anomaly variants via severity interpolation.
- OKLab perceptual distance.

Still open: replacing the simplified matrices with a more rigorous model
(e.g. Brettel/Viénot/Machado) — the architecture (`core/color/simulate.ts`)
is isolated specifically so this swap doesn't ripple outward.

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
