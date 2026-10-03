# Product Vision

> ColorAdapt does not just recolor the screen. Its job is to detect
> situations where color is an insufficient or inaccessible way to convey
> information, and adapt the interface — without breaking the site's design.

## The problem

Many sites encode meaning in color alone: a red/green status dot, a chart
legend, a "sold out" badge that's only distinguishable by hue. For someone
with a color vision deficiency, that information is partially or fully
lost. A blanket color filter (the common "colorblind mode" approach) either
does too little (filters that don't account for the specific page) or too
much (breaks branding, images, and carefully designed UI for no benefit).

ColorAdapt instead tries to find the _specific_ elements where a color
combination is likely to be a problem, and make a minimal, targeted,
reversible adjustment there.

## What "done" looks like, eventually

ColorAdapt should be able to reason about:

- Foreground/background contrast and color-distance under a simulated
  vision profile (M1-M2 — implemented; M2 uses published CVD models, see `docs/COLOR_VISION_SIMULATION.md`).
- Reversible UI color adaptation (M3 — implemented in this foundation as a
  minimal lightness-based fix).
- Dynamic pages / SPAs (M4).
- SVG icons and vector graphics (M5).
- Semantic roles — success/error/warning/active/buy/sell/status — so that
  color-only meaning can be reinforced with icons, shapes, or text, not
  just recolored (M6).
- Charts (M7) and images (M8), which need fundamentally different
  detection strategies than flat UI color.
- A developer-facing accessibility audit/report (M9).
- An optional, isolated AI-assisted semantic understanding module (M10) —
  explicitly not a dependency of the core engine.

See `docs/ROADMAP.md` for the milestone breakdown.

## Design principles

- **Local-first, privacy-first.** No backend, no telemetry, no account.
  Everything runs in the browser. See `docs/PRIVACY.md`.
- **Targeted, not global.** Prefer fixing the specific conflicting element
  over a page-wide filter.
- **Reversible.** Every adaptation can be turned off and the page returns
  to exactly its original state.
- **Replaceable algorithms.** Vision simulation, contrast calculation, and
  conflict severity are all isolated behind small pure functions
  (`core/color`, `core/conflicts`) specifically so they can be swapped for
  more accurate models later without touching the rest of the app.

## Scientific framing — what ColorAdapt is not

ColorAdapt's vision simulations are model-based estimates (published
models plus labeled approximations) used for accessibility analysis. They
are:

- **Not** a medical diagnosis or assessment tool.
- **Not** a precise reproduction of any individual's actual perception —
  color vision deficiency varies significantly between people even within
  the same named category.
- **Not** a treatment of any kind.

Use language like "simulation", "accessibility adaptation", and "estimated
distinguishability" — never "corrects your vision" or "exact perception".
