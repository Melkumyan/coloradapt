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
Conflict Detector → Adaptation Engine → Injected Stylesheet
```

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
  core/             Color engine, DOM analyzer, conflict detection, adaptation engine
  infrastructure/   Storage and messaging abstractions over the WebExtension API
  features/         React hooks + content-script controller
  entrypoints/      background, content, popup, options (WXT entrypoints)
  shared/           Cross-cutting utils/constants
tests/              Vitest unit tests, mirroring src/
docs/               Architecture, CSS analysis, product, roadmap, privacy, security, performance, development
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

Vision simulations here are simplified, heuristic estimates for
accessibility purposes — not a medical model of any individual's actual
perception, and not a diagnostic tool. See `docs/PRODUCT.md`.
