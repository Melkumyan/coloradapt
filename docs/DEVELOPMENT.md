# Development

## Setup

```bash
pnpm install
```

## Run in Chrome/Edge (dev mode, hot reload)

```bash
pnpm dev
```

This opens a Chrome instance with the extension loaded and auto-reloading
wired up via WXT.

## Run in Firefox

```bash
pnpm dev:firefox
```

## Production build

```bash
pnpm build            # Chrome/Edge (Manifest V3) -> dist/chrome-mv3
pnpm build:firefox    # Firefox (Manifest V2)     -> dist/firefox-mv2
```

To package a zip for store submission:

```bash
pnpm zip
pnpm zip:firefox
```

## Tests, lint, typecheck

```bash
pnpm test         # vitest run
pnpm test:watch   # vitest watch mode
pnpm lint         # eslint .
pnpm typecheck    # tsc --noEmit
pnpm format:check # prettier --check .
pnpm verify       # lint + typecheck + format:check + test + build, in that order
pnpm test:e2e     # build, then real-Chromium E2E (Playwright) — not part of verify
```

### Real-browser E2E

`pnpm test:e2e` loads the built extension (`dist/chrome-mv3`) into Chromium
(new headless mode, `channel: 'chromium'`) and drives it through the extension's
service worker (settings via `chrome.storage.local`, adaptation via the same
typed messages the popup sends). One-time browser install:
`pnpm exec playwright install chromium`. Pages are served from `e2e/pages/` on
`127.0.0.1` (content scripts only match http/https). Rules:

- no sleeps, retries, skips or loosened timeouts — wait for style flushes
  (`settle()`), or `expect.poll` for page-load adaptation;
- one tab per test (messages address a tab by URL; the harness refuses to guess
  between several);
- assert on **computed** colors, and always against the plan: the browser must
  match what the plan says.

Firefox is build-verified only (`pnpm build:firefox`); its E2E is NOT_RUN.

### Dynamic sites (M4)

`e2e/dynamic.spec.ts` drives `e2e/pages/dynamic.html` like a framework would
(`replaceWith`, `replaceChildren`, appends, class/style changes) and asserts on
computed colors plus the pipeline's structural counters. Two typed debug messages
make it deterministic: `FLUSH_DYNAMIC` processes every pending mutation now and
returns the counters; `GET_DYNAMIC_DIAGNOSTICS` only reads them. Prefer
`expectEquivalentToFullRescan` (the incremental result must equal a full rescan)
over hand-computed colors. One test (`N`) leaves the real scheduler running with
`expect.poll`. Never add sleeps.

M4.R1 adds four more Chromium suites (`e2e/r1-*.spec.ts`, shared helpers in
`e2e/r1-kit.ts`): `r1-mutations` (insertion forms, attribute churn, net-zero batches, text,
theme switches), `r1-stylesheets` (`<style>`/`<link>` in every way they change, the CSSOM
limitation, the rescan throttle), `r1-pipeline` (self-mutation attack, page fights, budget
boundaries, reentrancy, lifecycle, retention proxies, scheduler) and `r1-fixtures` (SPA,
infinite scroll, and local React-style/feed/dashboard/CSS-in-JS/hostile-CSS/churn fixtures,
`e2e/pages/r1-*.html`). Techniques worth knowing:

- the test server answers `/slow-<name>.css` only when the test calls `server.release(name)`
  (or `fail`), so a `<link>` loads exactly when asserted, with no sleeping;
- `load(...).natural()` waits for the _real_ scheduler to go quiet (`state` IDLE, nothing
  queued, deferred, owed or on a timer) instead of forcing `FLUSH_DYNAMIC`;
- a page custom element (`<x-spy>` in `r1-blank.html`) whose `attributeChangedCallback`
  runs synchronously when ColorAdapt tags it is the way to mutate the page _while a pass is
  RUNNING_ (`idLog` shows which pass wrote which id);
- counters worth quoting are attached to the report with `test.info().annotations`
  (`counters`), not logged.

Not reachable in headless Chromium, so unit-tested only: the hidden-tab scheduler path
(`document.visibilityState` is never `hidden`).

Unit tests (`tests/features/dynamic/`) inject a manual scheduler
(`createManualScheduler`) and call `controller.dynamic.flush()`; mutation
records come from a real jsdom `MutationObserver`. See `docs/DYNAMIC_ANALYSIS.md`.

### Inline SVG (M5)

`e2e/svg-paint.spec.ts` and `e2e/svg-dynamic.spec.ts` (helpers in `e2e/svg-kit.ts`, pages
`e2e/pages/svg-cases.html`, `svg-use.html`, `svg-dynamic.html`). Everything is read from
the browser: computed `fill`/`stroke`/`color` per rule target (`plannedByOwner` maps the
plan's changes to DOM ids, grouped by owning `<svg>`), the injected `<style>`
(`sheetRules`, `expectOnlyOwnRules`), the last analysis (`svgUnits`, per-unit
`unsupportedReason` / `partialReason`), and **rendered pixels** (`pixelAt`) for `<use>`
instances, which are not part of the DOM and invisible to `getComputedStyle`. Give every
fixture element an `id`; sample the middle of a solid area (antialiasing makes edges
useless). Dynamic scenarios reuse the M4 kit (`load`, `step`, `expectConsistent`,
`expectNoWork`).

Unit tests for the SVG layer (`tests/core/svg/`) cannot use jsdom's `getComputedStyle`
(it knows no SVG inheritance, and resolves `currentColor` wrongly), so they run on a
miniature CSS engine, `tests/core/svg/fake-engine.ts`: presentation attributes, rules,
inline style, the inheritance of `fill`/`stroke`/`color`, `currentColor`, the style
probe, ColorAdapt's own sheet rules and `installFakeComputedStyle` for the controller
tests. If you add an SVG feature, extend the engine rather than mocking per test.

```bash
# the SVG-focused suites, as used for the M5 stability runs
pnpm vitest run tests/core/svg tests/core/adaptation/svg-plan.test.ts \
  tests/core/adaptation/stylesheet-owner.test.ts tests/core/analysis/svg-integration.test.ts \
  tests/features/svg-controller.test.ts tests/features/dynamic/svg-dynamic.test.ts
pnpm exec playwright test e2e/svg-paint.spec.ts e2e/svg-dynamic.spec.ts e2e/svg-validation.spec.ts   # after `pnpm build`
```

`e2e/svg-validation.spec.ts` (M5.R1) holds the cross-cutting checks: the `adaptSVG` default and
toggle, ON/OFF x10, refresh drift, multi-paint, paint servers, budget boundaries, retention.

### Stability runs and the hostile-cycle test

Nothing in the E2E suites may depend on wall-clock timing. The one place where the pipeline itself
reads a clock, the spaced repair of ColorAdapt's `<style>`, is asserted through counters
(`batches = 6 x cycles + stylesheetRepairsDeferred`) in `e2e/r1-pipeline.spec.ts`, and at unit level
with an injected clock/scheduler (`createDynamicContentController(..., { scheduler, now })`).
One `120 hostile cycles` run takes about 1.7 minutes because every deferred repair waits for its real
timer. Run stability loops one at a time, never concurrently:

```bash
pnpm exec playwright test e2e/r1-pipeline.spec.ts -g "120 hostile" --repeat-each=100
pnpm test:e2e    # the whole Chromium suite; repeat it sequentially for a stability run
```

### Adaptation benchmark

`tests/benchmarks/` runs as part of `pnpm test` and writes
`benchmark-report/adaptation-benchmark.{json,html}` (gitignored) for inspection.
Add a pair in `adaptation-pairs.ts`; a hard-safety violation fails the suite.
`dynamic-benchmark.test.ts` likewise writes `dynamic-benchmark.json` (mutation counters;
wall-clock informational only).

## Debugging the analyzer on a real page

Set `data-coloradapt-debug` on `<html>` (e.g. via devtools:
`document.documentElement.dataset.coloradaptDebug = '1'`) before running
"Analyse page" from the Popup. In a dev build, this logs a one-line
summary (`console.debug('[ColorAdapt]', ...)`) with element/conflict/
unresolved counts — see `logDebugSummary` in
`src/features/page-analysis/content-controller.ts`. It's a no-op in
production builds and never sends anything off-device.

## Project structure

See `docs/ARCHITECTURE.md` for the full layering rationale, and
`docs/CSS_ANALYSIS.md` for how foreground/background colors are actually
resolved. In short:

- `src/domain` — pure types, no logic.
- `src/core` — pure(ish) business logic (color math, DOM analysis, the isolated
  SVG layer `core/svg`, conflict detection, adaptation). No React, no `wxt/browser`.
- `src/infrastructure` — the only layer allowed to import `wxt/browser`
  (storage, messaging).
- `src/features` — React hooks and the content-script controllers that wire
  `core` + `infrastructure` together; `features/dynamic-analysis` is the only
  place that uses `MutationObserver`.
- `src/entrypoints` — thin WXT entrypoints (background, content script,
  popup, options).

## Adding a new `VisionProfile`

1. Add the id to `VisionProfile` and `VISION_PROFILES` in
   `src/domain/models/vision-profile.ts`.
2. Add its `VisionProfileInfo` entry (label, description, default
   severity).
3. Map it to a model family in `src/core/vision/simulator.ts`
   (`PROFILE_FAMILY` and `DEFAULT_VISION_MODEL_POLICY`). A new model is a
   `LinearVisionModel` registered in the same file; give it a `VisionModel`
   id and `VISION_MODEL_INFO` entry (with honest `fidelity`).
4. Add reference vectors (never generated by the code under test) and tests
   in `tests/core/vision/` and `tests/domain/vision-profile.test.ts`.

## Deterministic tests

Never assert on wall-clock time. Anything with a time budget (e.g.
`analyzeDocument`, `createContentController`) takes an injectable `now`;
tests pass `now: () => 0`, or an advancing fake clock to exercise the
budget. Don't "fix" flakiness with sleeps, retries or longer timeouts; find
the shared state or timing dependency. To check, run the suite next to CPU
load (a few busy-loop `node` processes) and repeat it. See
`docs/COLOR_VISION_SIMULATION.md` ("Determinism and flakiness").

## Regenerating vision reference data

Normal development never needs Python. To regenerate
`tests/fixtures/vision/reference-vectors.json` and
`src/core/vision/machado2009-data.ts`, follow the instructions in
`scripts/reference/generate_reference.py` (DaltonLens-Python in a throwaway
venv, pinned to a commit). Do not add Python dependencies to the product.

## Adding a new conflict detection rule

Conflict detection lives in `src/core/conflicts/detect-conflict.ts`. To
change how severity is determined, adjust `determineSeverity` and the
thresholds in `src/core/conflicts/thresholds.ts`. Keep the function pure —
it should only read its arguments and return a `ColorConflict | null`.

## Changing the Adaptation Engine

All optimizer tuning lives in `src/core/adaptation/constraints.ts`
(`ENGINEERING_THRESHOLDS`, `SCORE_POLICY`, `CONFIDENCE_DESIGN_MULTIPLIER`) — do
not inline numbers elsewhere. Search stages are in `candidate-generator.ts`, the
score in `candidate-score.ts`, the search/strength logic in `optimizer.ts`
(`findAdaptation`) and eligibility in `adaptation-plan.ts`. Keep all of it pure and
deterministic (no randomness, no wall-clock budgets, no DOM). Any change to the
thresholds should be justified in `docs/ADAPTATION_ENGINE.md` and covered by
property-style tests (distance improved, contrast floor, valid output).
Per-role strategies can branch on `ElementDescriptor.role` in
`createAdaptationPlan`; the `AdaptationRule` interface in
`src/domain/models/adaptation.ts` is reserved for composing them later.

## How messaging is structured

See `src/infrastructure/messaging/messages.ts` for the full typed message
map, and `docs/ARCHITECTURE.md`'s "Messaging" section for which message
goes over which channel (`runtime.sendMessage` vs. `tabs.sendMessage`).
Never add a new ad-hoc string message — add an entry to `MessageMap`
instead so both ends stay type-checked.

## How storage is structured

`src/infrastructure/storage/settings-store.ts` (`SettingsStore`) is the
only code that knows the storage key (`coloradapt:settings`) and shape. It
sits on top of a `StorageBackend` interface, implemented by
`createBrowserStorageBackend()` (real `browser.storage.local`) or
`createMemoryStorageBackend()` (used in tests). Values read back from
storage are always passed through `parseUserSettings`
(`src/infrastructure/storage/schema.ts`), which validates and falls back to
defaults field-by-field — never trust storage content to already match the
current `UserSettings` shape (it may be from an older version).
