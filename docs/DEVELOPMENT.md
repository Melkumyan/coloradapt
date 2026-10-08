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

## Release checks (M12)

```bash
pnpm audit:dist       # the built bundles against the frozen permission surface and the artifact rules (in `pnpm verify`)
pnpm scan:secrets     # tracked files, both bundles and both zips; reviewed fixtures are in docs/m12/secret-scan-allowlist.json
pnpm knip:diff a.json b.json    # new Knip findings between two `knip --reporter json` reports (Knip itself runs through `pnpm dlx knip`)
pnpm release:repro                      # (node scripts/release/repro-check.mjs --zip) builds and packages twice, compares folders and archives
pnpm release:hash                       # (node scripts/release/candidate-hash.mjs) the identity of the tree a certification run is about
```

The production-hardening suites drive the real Chrome and Firefox against the production builds (`pnpm build` and
`pnpm build:firefox` first):

```bash
pnpm exec playwright test -c playwright.realworld.config.ts realworld/m12/<spec>.spec.ts
RW_BROWSERS=chrome ...                          # one browser (default: chrome,firefox)
M12_SOAK_MINUTES=120 M12_SOAK_LABEL=soak ...    # realworld/m12/soak.spec.ts (default 120 minutes, a sample per minute)
```

`realworld/m12/upgrade.spec.ts` needs the previous builds: add a worktree of each tag (for example
`git worktree add --detach <dir>/wt-m11-ai-semantic-engine m11-ai-semantic-engine`), link `node_modules` into it,
set its `package.json` version below the current one, build it with `node node_modules/wxt/bin/wxt.mjs build`, and
point `M12_PREVIOUS_DIR` at `<dir>`. Method and results: `docs/m12/protocol.md`, `docs/m12/report.md`.

The Firefox restart test (P04) records failure evidence to `realworld/.artifacts/m12-p04/<run>/` (geckodriver trace and
browser console, every BiDi log entry, a correlated timeline, the raw extension-side error, process and profile state;
`failure.json` only on failure). It is test-side only and is described in `docs/m12/protocol.md` section 12.

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

`pnpm test:e2e` builds the **E2E variant** (`pnpm build:e2e` = `wxt build --mode e2e` ->
`dist/chrome-mv3-e2e`) and loads it into Chromium
(new headless mode, `channel: 'chromium'`) and drives it through the extension's
service worker (settings via `chrome.storage.local`, adaptation via the same
typed messages the popup sends). One-time browser install:
`pnpm exec playwright install chromium`. Pages are served from `e2e/pages/` on
`127.0.0.1` (content scripts only match http/https). Rules:

- the E2E variant differs from the shipped build in one thing of ours: the content script runs the
  analyzer on a logical clock (`now: () => 0`, `features/page-analysis/build-mode.ts`), so the 50 ms
  analysis budget cannot split a batch on a slow machine; structural budgets (elements, roots) still
  apply. Production keeps the real clock. (`wxt.config.ts` pins `DEV=false`, `PROD=true` and
  `NODE_ENV=production` for this mode; WXT's own runtime still logs slightly more in a non-production
  mode.) Why: the old `R1-5` test asserted exact per-pass counters that the 50 ms budget could split
  on a loaded machine (docs/ROADMAP.md, M7);
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

### Semantic accessibility (M6)

`e2e/semantic-cues.spec.ts` and `e2e/semantic-dynamic.spec.ts` (helpers in `e2e/semantic-kit.ts`,
fixture `e2e/pages/semantic.html`, which also defines `window.sem` / `window.counters` for the SPA
scenarios). They read the browser: cue attributes per id, the computed style of `::after`, rendered
pixels, bounding boxes, `ariaSnapshot()` with and without cues, the page structure with
`data-coloradapt-*` stripped, Tab order (two fresh pages: focus position carries over otherwise),
and the pipeline counters through `load` / `step` / `diffCounters`.

Unit tests: `tests/core/semantics/` (pure: build facts with `tests/core/semantics/helpers.ts`) and
`tests/features/semantics/`. jsdom cannot compute pseudo-element styles, so
`tests/features/semantics/kit.ts` simulates the browser for exactly that one question (what is in
`::before`/`::after`: the page's, declared with `data-test-before/after`, or a ColorAdapt cue whose
rule is really in the sheet); computed styles, selectors and the cascade stay jsdom's own.
`controller.inspectSemantics(element)` returns the classification and cue decision without side
effects, which is what the benchmark asserts on.

M6.R1 added four more real-Chromium suites and two fixtures:

- `e2e/semantic-adversarial.spec.ts` runs the 144 adversarial scenarios of
  `tests/features/semantics/adversarial-scenarios.ts` (pure data shared with the jsdom benchmark,
  `adversarial.test.ts`), each on its own page served by `server.serve(name, html)`. Add a scenario
  to the data file and both engines pick it up.
- `e2e/semantic-surface.spec.ts` (fixture `e2e/pages/semantic-a11y.html`): the full Chromium
  accessibility tree (`Accessibility.getFullAXTree`) and raw accessible names with and without cues,
  keyboard, pointer, typing / selection / validation / submit, native validity transitions,
  `form.reset()`, a fresh profile (a second extension session with nothing stored), pre-M6 settings,
  an explicit `false`, ON/OFF x5, M3 + M6.
- `e2e/semantic-layout.spec.ts` (fixture `e2e/pages/semantic-layout.html`): layouts, zoom (CSS
  `zoom`: browser UI zoom cannot be driven in headless Chromium), fonts, dark mode, forced colors
  (`page.emulateMedia({ forcedColors: 'active' })`), withheld cues.
- `e2e/semantic-peers.spec.ts`: peer invalidation, the 100-element stress, counters, retention,
  self-mutation.

No screen reader is run anywhere: "accessibility tree verified" means Chromium's tree.

```bash
# the semantic-focused suites, as used for the M6 / M6.R1 stability runs
pnpm vitest run tests/core/semantics tests/features/semantics tests/core/adaptation/stylesheet-cue.test.ts
pnpm exec playwright test e2e/semantic-cues.spec.ts e2e/semantic-dynamic.spec.ts   # after `pnpm build`
pnpm exec playwright test e2e/semantic-adversarial.spec.ts e2e/semantic-surface.spec.ts e2e/semantic-layout.spec.ts e2e/semantic-peers.spec.ts
```

### Charts (M7)

```bash
npx vitest run tests/core/charts tests/features/charts tests/benchmarks/chart-benchmark.test.ts
pnpm build:e2e && npx playwright test e2e/chart-*.spec.ts
```

- `tests/core/charts`: the pure core on hand-built facts (`builders.ts`).
- `tests/features/charts`: the controller and the pipeline in jsdom; `engine.ts` stands in for the
  browser's CSS cascade (inheritance, `!important`, specificity) and layout (`data-box`), and has
  markup generators for line/bar/scatter/pie/heatmap/area/stacked and non-chart SVGs.
- `tests/benchmarks/chart-benchmark.test.ts` (+ `chart-scenarios.ts`, `chart-scenarios-r1.ts`): 150
  scenarios (143 charts + 7 canvases, M7 and M7.R1); writes `benchmark-report/chart-benchmark.json` with
  charts / supported / adapted / already distinguishable / unsupported / ambiguous / false-positive
  ownership / legend-sync failures / encoding-exhausted, pairs before / after by dash / marker / pattern,
  per category and per profile, and the structural counters.
- `tests/features/charts/r1-*.test.ts`, `fixtures-r1.ts`: the M7.R1 jsdom suites (bridge, legends,
  dynamic) and fixtures (non-charts, HTML legend variants, canvases, boundary padding).
- `e2e/chart-r1-*.spec.ts`, `e2e/r1-fixtures.ts`: the M7.R1 real-browser suites (legends, resize and
  geometry, library-shaped output and non-charts, interaction and accessibility); pages are served with
  `server.serve`.
- `e2e/pages/charts.html` + `e2e/chart-kit.ts`: deterministic plain-SVG fixtures built by
  `window.chartKit` (line, bar, stacked, scatter, pie/donut, heatmap, area, logo, map-like,
  diagram, icon, canvas) with hover/click/legend-toggle handlers. Pixels are read from screenshots,
  never OCR.

### Images (M8)

```bash
npx vitest run tests/core/images tests/features/images tests/benchmarks/image-benchmark.test.ts
pnpm build:e2e && npx playwright test e2e/image-*.spec.ts
```

- `tests/core/images`: the pure core on synthetic pixels (`pixels.ts` painters: discs, flat logos,
  photograph-like noise, raster charts, screenshot-like text strokes) and hand-built facts
  (`facts.ts`).
- `tests/features/images`: the controller and the M4 pipeline in jsdom. jsdom decodes nothing, so
  `fake-env.ts` is the browser's side (URL table, object-URL registry, gates that hold a read to stage
  races) and `kit.ts` gives images `naturalWidth`/`complete` with `defineProperty`. `stress.test.ts`
  has the representative page (100 icons + 20 medium + 1 large) and the 100-node replace/remove/
  reinsert cycle.
- `tests/benchmarks/image-benchmark.test.ts` (+ `image-scenarios.ts`): 119 scenarios through the real
  controller per profile; writes `benchmark-report/images.json` (gitignored). Hard gate: 0
  transformations in the false-positive group.
- `tests/features/images/r1.test.ts` (M8.R1): staged races (A to B to C, remove/OFF/profile change in
  flight), cache and queue boundaries, ObjectURL accounting, listeners, theme change.
  `tests/benchmarks/image-scenarios-r1.ts` adds the brand-trap, functional-icon, photograph, artwork,
  screenshot and threshold scenarios (195 in total).
- `e2e/image-r1.spec.ts` (M8.R1): per-site precedence, a forced Blob load failure (the page revokes
  our URL and reloads the image), CSP, races, profile change, `emulateMedia` theme change, redirects
  and CORS (`server.serveRaw(..., status)` serves a 302), brand/photo/threshold fixtures.
- `e2e/image-adapt.spec.ts`, `e2e/image-policy.spec.ts`, `e2e/image-kit.ts`: real Chromium with real
  PNG/APNG/GIF/SVG/JPEG fixtures (the PNG encoder is in `image-kit.ts`; the JPEG is made by the
  browser's canvas). `server.serveRaw` serves binaries with headers, `server.hold(name)` stages a slow
  download, a second `startPageServer()` is another origin. Rendered pixels are read through a canvas
  and element screenshots; take any "before" screenshot with `adaptImages: false` (the layer is
  asynchronous, a "before" taken after loading may already be adapted). Wait with `whenIdle`, never
  sleep.

### Developer audit (M9)

```bash
npx vitest run tests/core/audit tests/features/audit tests/benchmarks/audit-benchmark.test.ts
pnpm build:e2e && npx playwright test e2e/audit-*.spec.ts
```

- `tests/core/audit`: the pure core on hand-built candidates (severity table, rules registry vs.
  `docs/AUDIT_RULES.md`, dedup, grouping, snapshot, filters, export schema, privacy, determinism).
- `tests/features/audit`: the collector, controller, locator, highlighter and store in jsdom.
  `kit.ts` (`mountAudit`) builds the controllers as the content script does (`simulatedBrowser`, the chart
  engine and the fake image environment can be passed in), with a manual audit scheduler; `run()` is one audit
  pass, `adapt()` turns adaptation on, `sourceFingerprint()` compares what two audits found minus adaptation
  status (the ON/OFF equivalence tests).
- `tests/benchmarks/audit-benchmark.test.ts`: 100+ audit scenarios across M1–M8, hard gate of zero false
  confirmed findings in the deterministic rules; severity calibration cases.
- `e2e/audit-*.spec.ts`: real Chromium. The audit page is `chrome-extension://<id>/audit.html?tabId=N`
  (the id from the service worker's URL, the tab id from `chrome.tabs.query`); the page opens its port to that tab
  and fetches snapshots over the typed messages. Highlight, filters, JSON export (parse + schema + privacy) are
  covered there. `e2e/audit-kit.ts` sends the `AUDIT_*` messages to a tab directly (it finds the tab by
  address, because a `chrome.tabs.query` match pattern cannot hold a query or a fragment) and loads the fixture
  into `e2e/pages/charts.html`. To open an exported HTML report in the browser, save the download under its own
  name first (`download.saveAs`): Chromium shows a download's extension-less temporary file as plain text.
- The E2E build compiles JSX for the production React runtime (`oxc.jsx.development: false` in `wxt.config.ts`);
  without it the extension pages (audit, popup, options) fail with `jsxDEV is not a function`. The setting
  sits inside the `mode === 'e2e'` branch only: the production build is unchanged (`tests/core/audit/review-architecture.test.ts`
  checks that `vite({ mode: 'production' })` has no `oxc` or `define` override).
- `tsconfig.json` includes `.wxt/wxt.d.ts` (generated by `wxt prepare`) so `browser.runtime.getURL('/audit.html')`
  is typed. It holds only the WXT `import.meta.env` flags, typed public paths, i18n keys and auto-import
  declarations: no `any`, no wildcard module, and every strict flag stays on (`pnpm typecheck` is strict; a test
  guards both).
- `e2e/audit-review.spec.ts` (M9.R1) covers what jsdom cannot: UI/export parity, coverage disclosure, route
  changes without DOM changes, hostile and invisible text through a real export, storage and network privacy,
  icons on dark backgrounds, the ownership-contamination page, focus, widths and zoom, vision-deficiency
  emulation and the audit page's own contrast. On this machine `history.pushState` shows an injected wrapper
  from other software, so "ColorAdapt never hooks History" is checked statically (source and built bundle).
- Never leave scratch specs behind; wait on state (a snapshot generation), never on sleeps.

### AI semantic engine (M11)

```bash
npx vitest run tests/core/semantic-ai tests/features/audit/semantic-*.test.ts tests/benchmarks/semantic-ai-*.test.ts
pnpm build:e2e && npx playwright test e2e/semantic-assist.spec.ts
# real browsers, Chrome and Firefox (after pnpm build and pnpm build:firefox; not part of verify):
RW_BROWSERS=firefox,chrome npx playwright test -c playwright.realworld.config.ts realworld/ai-provider.spec.ts
# optional, manual, needs a local model runtime (never part of verify or E2E); writes
# benchmark-report/semantic-ai-qualification-<model>.json (machine-readable, with QUALIFIED_FOR_ADVISORY / NOT_QUALIFIED):
OLLAMA_ORIGINS="chrome-extension://*,moz-extension://*" ollama serve
QUALIFY_ENDPOINT=http://127.0.0.1:11434 QUALIFY_PROTOCOL=ollama QUALIFY_MODEL=llama3.2:3b QUALIFY_FULL=1 QUALIFY_REALWORLD=1 pnpm qualify:ai
```

- No test needs a model, Ollama, WebGPU, a browser AI API or the Internet. Answers come from scripted replay
  (`MockSemanticProvider`) or from a real **loopback HTTP server the test starts** (`tests/core/semantic-ai/local-provider.test.ts`,
  `e2e/semantic-assist.spec.ts`), so the transport, redirect refusal and size bounds are exercised for real.
- `tests/core/semantic-ai`: packet privacy and budgets (`build`), the strict parser (`output`), the validator
  (`validator`), the endpoint parser against a hostile list (`endpoint`), the engine (`engine`: dedupe, caps,
  concurrency, timeouts, cancellation, staleness, 100 open/close cycles), and static boundaries
  (`m11-integrity`: one `fetch`, no storage, no permission, no import from the audit core, defaults off).
- `tests/features/audit/semantic-*.test.ts`: the content-side packets on real DOM (no form value or URL in any
  packet, eligible rules only, deterministic fingerprints) and the report section (parse, escape, byte-identical
  findings).
- M11.R1 adds `m11r1-network` (endpoint corpus, redirects, size limits, no ambient authority), `m11r1-validator`
  (confidence floor, high-risk labels, independence, rivals, strict parser, EN/RU vocabulary boundaries, cache),
  `m11r1-engine` (churn, removal, cancellation, lifecycle, coverage), `m11r1-static` (network, execution and DOM-write
  sinks, authority wording), and in `tests/features/audit` `m11r1-privacy` (canaries) and `m11r1-report` (provenance,
  inert HTML, parity); `tests/entrypoints/audit-assist-ui.test.tsx` covers the panel's accessibility.
- `tests/benchmarks/semantic-ai-benchmark.test.ts` (424 scenarios from `semantic-ai-scenarios.ts` and
  `semantic-ai-scenarios-r1.ts`, English and Russian, with an adversarial sweep of every label at nine confidences and five
  ways of citing) and `semantic-ai-injection.test.ts` (109 hostile strings in five places) write
  `benchmark-report/semantic-ai-*.json`. The hard gate in both: no accepted label outside the scenario's ground truth.
- `tests/realworld/semantic-sample.test.ts` replays the frozen real-world packets (`tests/fixtures/semantic-ai/`);
  `realworld/semantic-sample.spec.ts` records them from the live corpus (`pnpm test:realworld`-style, not in verify).
- To add a task: a label set in `taxonomy.ts`, its evidence rules in `evidence-rules.ts`, its fixed question in
  `prompt.ts`, its choice in `eligibility.ts`, scenarios in `tests/benchmarks/semantic-ai-scenarios.ts`. To add a
  provider: see `docs/AI_PROVIDER_PROTOCOL.md`; the static integrity tests will (rightly) fail until they are updated.

### Stability runs and the hostile-cycle test

Stress tests that are slow only under contention get their own `{ timeout }` (the 300-chart
retention test: 90 s); the global Vitest timeout stays 30 s. See `docs/PERFORMANCE.md`.

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

### Real-world validation (M10)

A harness drives the installed Chrome and Firefox against 193 live pages and hostile local fixtures:

```sh
pnpm build && pnpm build:firefox
pnpm test:realworld                         # everything, about two hours
RW_BROWSER=firefox RW_ONLY=gov-uk pnpm test:realworld corpus-run   # one page, one browser
```

It is not part of `pnpm verify`. Layout, environment and results are in `docs/REAL_WORLD_VALIDATION.md`; the
M10.R1 comparison tools (`compare.spec`, `classify.spec`, `ground-truth`, `inspect.spec`, the frozen discrepancy
corpus in `docs/validation/`) and how to reproduce them are in `docs/REAL_WORLD_FINDINGS_CLOSEOUT.md`. Select
specs by their full name (`compare.spec`, not `compare`, which also matches the slow `compare-builds.spec`).

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
  SVG layer `core/svg`, the semantic core `core/semantics`, the chart core `core/charts`,
  conflict detection, adaptation).
  No React, no `wxt/browser`.
- `src/infrastructure` — the only layer allowed to import `wxt/browser`
  (storage, messaging).
- `src/features` — React hooks and the content-script controllers that wire
  `core` + `infrastructure` together; `features/dynamic-analysis` is the only
  place that uses `MutationObserver`; `features/charts` (M7) reads chart SVGs and applies
  chart plans (no observer of its own).
- `src/core/audit` and `src/features/audit` — the developer audit (M9): pure pipeline and the browser
  collector/controller/highlighter.
- `src/core/semantic-ai` — the optional AI-assisted review (M11): packets, parser, validator, local provider,
  engine; DOM-free and storage-free. Its only browser-facing pieces are `features/audit/semantic-facts.ts`
  (reads the allowlisted facts) and the audit page's `use-semantic-assist.ts` (the only user of the provider).
- `src/entrypoints` — thin WXT entrypoints (background, content script,
  popup, options, audit page).

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
