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
pnpm verify          # lint + typecheck + test + build
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
