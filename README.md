# ColorAdapt

ColorAdapt is a browser extension that adapts web pages for people with
color vision deficiencies (protanopia, deuteranopia, tritanopia, and their
"anomaly" variants, plus achromatopsia).

Unlike a simple global color filter, ColorAdapt analyzes the structure of a
page, estimates which specific foreground/background combinations are
likely to be hard to distinguish, and adjusts only those elements —
leaving the rest of the page's design untouched.

> **Status: early-stage foundation.** This repository currently implements
> a minimal, real (not mocked) vertical slice: contrast-based conflict
> detection plus a reversible color fix, wired end-to-end through the
> Popup UI. See `docs/ROADMAP.md` for what's planned next.

## Supported browsers

- Google Chrome (Manifest V3)
- Microsoft Edge (Manifest V3)
- Mozilla Firefox (Manifest V2, built from the same source)

## Architecture

```text
Web Page → Content Script → DOM Analyzer → Color Engine →
Conflict Detector → Adaptation Engine (candidate search → AdaptationPlan) →
Injected Stylesheet
              ↑ inline <svg> units: core/svg (paint probe, <use>) feed the same engine
```

The Adaptation Engine (M3) does model-guided accessibility adaptation: for a
selected vision profile it looks for the smallest foreground color change that
raises the _estimated_ distinguishability, keeps WCAG contrast from regressing,
and otherwise leaves the original color alone. It never changes backgrounds
or unresolved (gradient/image) elements, and everything is reversible. See
`docs/ADAPTATION_ENGINE.md`.

M4 keeps the adaptation correct on dynamic sites (React/Vue/Angular/SPA,
infinite scroll): a `MutationObserver` pipeline classifies DOM changes, batches
them per frame, resolves the affected regions and re-adapts only those,
updating the stylesheet by delta; a full rescan is a counted fallback. See
`docs/DYNAMIC_ANALYSIS.md`.

M5 extends the same safety model to inline SVG icons and SVG text: an `<svg>` is
analyzed as one unit and adapted only when it is a single visible paint (`fill`,
`stroke`, `currentColor`, inherited paint, `<use>`/`<symbol>` instances). Multi-color
artwork, gradients, patterns, masks, filters, charts and external sprites are
classified and left alone (`adaptSVG` is on by default; stored settings without the field get the
default). Rules go through the same stylesheet, are verified against
the real computed paint, and are reversible. See `docs/SVG_ANALYSIS.md`.

M7 makes the series of a chart distinguishable **without color**: for confusable pairs under the
selected vision profile (M2 simulation, series against series) it adds a line style, a marker, a
pattern or a point shape, keeps the original colors, and mirrors the same encoding in the chart's
SVG legend. Only high-confidence inline-SVG line, bar, scatter and pie/donut charts with an
unambiguous series-to-legend mapping are touched; heatmaps, area/stacked charts, HTML legends and
Canvas charts are detected and left alone (a chart with, or with possible, an HTML legend is refused whole rather than adapted next to a legend that cannot show the same encoding), and non-charts (logos, illustrations, diagrams) are never
claimed. Everything is reversible, verified against the browser and flows through the M4 pipeline
(`adaptCharts`, on by default). See `docs/CHARTS.md`.

M8 adds a deliberately narrow, **off-by-default** image layer (`adaptImages`): it recolors only small
single-color functional bitmap icons that are classified with high confidence, are readable by the
browser's own same-origin/CORS rules and sit on a known solid background. Photographs, logos,
screenshots, decorative images, status bitmaps, raster charts and anything uncertain are left
exactly as the page made them. Image pixels are read and processed locally and never leave the
browser. Generated bitmaps are shown through object URLs ColorAdapt owns and revokes; everything is
reversible, idempotent and flows through the M4 pipeline. M8.R1 validated it (195 benchmark
scenarios, 0 photographs or logos transformed, a brand-protection rule that requires positive
functional evidence, per-site `adaptImages`, OS-theme invalidation, forced Blob failure and CSP in
real Chromium). See `docs/IMAGE_ADAPTATION.md`.

M6 adds a second, non-color channel where color alone carries a state. Deterministic evidence
(ARIA, native form state, exact class/data tokens, a small English/Russian status vocabulary) is
classified with an explicit confidence; only when the evidence is HIGH, the original page
differs between states by color only, and a safe placement exists, ColorAdapt adds a small cue
(`✓ × ! ℹ * + − ↑ ↓`, an underline, or an outline pattern) as a CSS pseudo-element with an empty
alternative text (`✓` and `ℹ` are drawn as shapes, not as font glyphs). No node is inserted,
ambiguous cases stay `unknown`, color alone never classifies anything, and it is fully reversible
(`semanticCuesEnabled`, on by default). M6.R1 validated it against 144 adversarial scenarios in
jsdom and in real Chromium (0 wrong automatic cues), checked that the browser's accessibility tree,
focus order, clicks, typing and form behavior are identical with and without cues, and made peer
verdicts follow their peers (a removed or changed neighbor takes a stale cue away). No screen reader
was run. See `docs/SEMANTIC_ACCESSIBILITY.md`.

M9 adds a **developer audit**: a read-only report that turns what M1–M8 know into findings with a
severity, a separate confidence, the evidence, the affected elements, a deterministic recommendation and
whether ColorAdapt already compensated for it. It is opened from the popup ("Developer audit") in its own
tab, works with adaptation off, always describes the **original** page (ColorAdapt's own recoloring, cues,
chart encodings and generated images never hide a source problem), keeps "needs manual review" and "could not
analyze" apart from real issues, highlights the affected element on the page (a temporary outline, no layout
change) and exports a versioned JSON report and a standalone HTML report with no form values, query strings
or fragments. There is no accessibility score and no WCAG conformance claim. Local only, on demand. See
`docs/DEVELOPER_AUDIT.md`, `docs/AUDIT_RULES.md` and `docs/AUDIT_EXPORT_SCHEMA.md`. M9 status: **engineering PASS**
(validated by M9.R1: benchmark of 342 scenarios with no false confirmed finding, privacy and hostile-content
checks in a real browser, explicit coverage disclosure, stability repeats); upstream scientific confidence
stays PARTIAL (M2). The audit's image pixel analysis needs image adaptation (otherwise it is reported as
disabled, not as "no image issues"); shadow DOM, frames, borders and focus rings are not audited; Firefox
runtime is NOT_VERIFIED.

Status: **M3 engineering PASS** (validated in real Chromium); **upstream
scientific confidence PARTIAL** (M2 model assumption). Known limitations:
a page's own `:hover`/`:focus` colors are
overridden on adapted elements; inline `!important` text colors cannot be adapted
(reported, never faked); animated colors are skipped; Firefox is build-verified
but not runtime-tested; CSSOM-only restyles (`insertRule`, `adoptedStyleSheets`),
Shadow DOM and iframes are not tracked (`docs/DYNAMIC_ANALYSIS.md`). SVG: multi-paint,
gradient/pattern/mask/filter, translucent and `<use>` content with its own paint are
analyzed but never adapted (`docs/SVG_ANALYSIS.md`).

`pnpm verify` runs lint, typecheck, format check, unit tests and the build;
`pnpm test:e2e` additionally runs the real-browser (Chromium) suite.

Popup and Options talk to a Background service worker (settings) and to
the active tab's Content Script (analysis/adaptation) over a fully typed
messaging layer — see `docs/ARCHITECTURE.md` for the full breakdown and a
diagram.

## Requirements

- Node.js 20+
- pnpm 9+

## Install

```bash
git clone <repo-url>
cd coloradapt
pnpm install
```

## Development

```bash
pnpm dev             # Chrome/Edge, hot reload
pnpm dev:firefox     # Firefox, hot reload
```

## Build

```bash
pnpm build           # dist/chrome-mv3
pnpm build:firefox   # dist/firefox-mv2
```

## Tests, lint, typecheck

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm verify          # lint + typecheck + format:check + test + build
pnpm test:e2e        # build the E2E variant (build:e2e) + real-Chromium tests
```

See `docs/DEVELOPMENT.md` for more (adding a vision profile, a conflict
rule, an adaptation strategy, etc.).

## Project structure

```text
src/
  domain/           Pure types (VisionProfile, ColorConflict, UserSettings, ...)
  core/             Color engine, DOM analyzer, SVG layer, semantic core, conflict detection, adaptation engine
  infrastructure/   Storage and messaging abstractions over the WebExtension API
  features/         React hooks + content-script controller
  entrypoints/      background, content, popup, options (WXT entrypoints)
  shared/           Cross-cutting utils/constants
tests/              Vitest unit tests, mirroring src/
docs/               Architecture, CSS/SVG analysis, semantic accessibility, dynamic sites, product, roadmap, privacy, security, performance, development
```

## Privacy principles

- Local-first: all analysis happens in your browser.
- No backend, no telemetry, no account, no cloud API.
- Settings are stored with `browser.storage.local` only.

Full policy: `docs/PRIVACY.md`. Security posture and permission rationale:
`docs/SECURITY.md`.

## Roadmap

M0 (this repository) through M10 (optional AI-assisted semantic
understanding) are tracked in `docs/ROADMAP.md`.

## Scientific accuracy note

Vision simulations use published color vision deficiency models
(Brettel 1997, Machado 2009) plus two explicitly labeled approximations
(tritanomaly, achromatopsia), applied in linear RGB. They are estimates for
accessibility purposes — not a medical model of any individual's actual
perception, and not a diagnostic tool. See `docs/COLOR_VISION_SIMULATION.md`
for sources, policies, and limitations.
