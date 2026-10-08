# Architecture

ColorAdapt is a WXT-based WebExtension (Manifest V3 on Chrome/Edge, MV2 on
Firefox, generated from one source tree). It has no backend: every module
below runs inside the browser, either in the background service worker, a
content script injected into the page, or an extension page (Popup/Options).

## Layering

```text
src/
  domain/          Pure types and constants. No dependencies on anything else.
  core/             Pure(ish) business logic: color math, DOM analysis,
                    conflict detection, adaptation decisions. Depends only
                    on domain/ and shared/. The DOM Analyzer and the
                    Adaptation Engine's StylesheetManager are the two places
                    core/ touches the real DOM — everything else is
                    deterministic and unit-testable without a browser.
  infrastructure/   WebExtension API access: storage, messaging, browser
                    utilities. This is the ONLY layer allowed to import
                    `wxt/browser`.
  features/         Glues core/ + infrastructure/ into something an
                    entrypoint can call: React hooks for the UI, and the
                    content-script controller that ties the DOM Analyzer /
                    Conflict Detector / Adaptation Engine together for one
                    document.
  entrypoints/      Thin WXT entrypoints (background, content script,
                    popup, options). Should contain almost no logic.
  shared/           Cross-cutting utilities/constants with no opinion about
                    domain, browser, or UI.
```

The rule that matters most: **core logic never imports React or
`wxt/browser`**, and **UI code never implements color math**. If a color
algorithm needs to change, only `core/color` changes.

## Modules

| Module                                    | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Color Engine (`core/color`)               | Parse/convert/compare colors; sRGB transfer functions; alpha-composite; OKLab distance; find accessible alternatives.                                                                                                                                                                                                                                                                                                                                                                                               |
| Vision Engine (`core/vision`)             | Replaceable, DOM-free color vision simulation (Brettel/Viénot/Machado + approximations); pair analysis. Holds no module-level mutable state or caches (M2.R1). See `docs/COLOR_VISION_SIMULATION.md`.                                                                                                                                                                                                                                                                                                               |
| DOM Analyzer (`core/analysis`)            | Bounded traversal of a document, resolving each element's effective foreground/background/role — see `docs/CSS_ANALYSIS.md`.                                                                                                                                                                                                                                                                                                                                                                                        |
| SVG layer (`core/svg`)                    | Isolated analysis of inline `<svg>` units: element roles, paint model, a style probe that tells `currentColor` / inherited / explicit paint apart, `<use>`/`<symbol>`, a bounded scan, verification. See `docs/SVG_ANALYSIS.md`.                                                                                                                                                                                                                                                                                    |
| Semantic core (`core/semantics`)          | DOM-free semantic accessibility: facts → evidence → `SemanticResult` (confidence, conflicts) → color-only verdict → `SemanticCuePlan`. Prefers `unknown` to a wrong state; color alone never classifies. See `docs/SEMANTIC_ACCESSIBILITY.md`.                                                                                                                                                                                                                                                                      |
| Semantic cues (`features/semantics`)      | The only code that reads semantic facts from the DOM and applies cues: one `data-coloradapt-cue` attribute per element plus static cue CSS inside the managed `<style>`, verified against the browser. No observer of its own (M4 drives it).                                                                                                                                                                                                                                                                       |
| Chart core (`core/charts`)                | DOM-free chart semantics (M7): facts -> classification (type, confidence, blockers) -> series -> legend mapping -> pairwise M2 analysis -> `ChartAdaptationPlan` (line style, marker, pattern per series). Prefers `limited`/`unsupported` to a guess. See `docs/CHARTS.md`.                                                                                                                                                                                                                                        |
| Image core (`core/images`)                | DOM-free raster-image logic (M8): bounded sampling, deterministic OKLab color clusters, pairwise M2 analysis, classification (kind + confidence + evidence), policy (default: leave it alone), and the cluster-aware monochrome-icon plan on top of the M3 optimizer. Pixels in, pixels out. See `docs/IMAGE_ADAPTATION.md`.                                                                                                                                                                                        |
| Image layer (`features/images`)           | The only code that reads an image into pixels (offscreen canvas, never the page's canvases), shows a generated bitmap in place of a source and puts it back. A memory-only cache owns and revokes every object URL; generations guard every async result; no document observer (M4 hands it regions, one capture-phase `load`/`error` listener covers loads). Off unless `adaptImages`.                                                                                                                             |
| Chart layer (`features/charts`)           | The only code that reads an `<svg>` into chart facts and applies a plan: owned `<defs>`, decorative overlays, `data-coloradapt-chart-*` attributes and one static CSS portion inside the managed `<style>`; verifies against the browser, rolls back, reverses. No document observer (M4 delivers regions); a bounded `ResizeObserver` + scoped `MutationObserver` bridge (`chart-watch.ts`) only signals M4. The HTML legend guard (`html-legend.ts`) refuses charts that may have a legend M7 cannot synchronize. |
| Audit core (`core/audit`)                 | DOM-free developer audit (M9): rule registry, evaluators over plain data from M1–M8, severity model, dedup, grouping, snapshot, filters, JSON/HTML export, privacy helpers. See `docs/DEVELOPER_AUDIT.md`.                                                                                                                                                                                                                                                                                                          |
| Audit layer (`features/audit`)            | Collector (audit sources → candidates), element locator, one-box highlighter, snapshot store with generations, `AuditController` (on-demand pass, debounced live session, SPA re-audit). Reads only; no analysis of its own.                                                                                                                                                                                                                                                                                        |
| Audit page (`entrypoints/audit`)          | React extension page opened from the popup with `?tabId=N`: summary, filters, finding cards, highlight controls, export. Holds a port to the audited tab.                                                                                                                                                                                                                                                                                                                                                           |
| AI semantic core (`core/semantic-ai`)     | Optional, local, advisory (M11): closed task/label taxonomy, packet builder (allowlist, redaction, budgets), strict answer parser, deterministic hypothesis validator, loopback-only provider, bounded engine (queue, dedupe, cache, timeout, cancellation). Never imported by `core/audit`; never reads the page; never writes anything. See `docs/AI_SEMANTIC_ENGINE.md`.                                                                                                                                         |
| Conflict Detection (`core/conflicts`)     | Decide whether a foreground/background pair is a likely problem for a vision profile.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Adaptation Engine (`core/adaptation`)     | Constrained candidate search (OKLCH) -> `AdaptationResult` -> DOM-free `AdaptationPlan`; the stylesheet manager applies/restores a plan. See `docs/ADAPTATION_ENGINE.md`.                                                                                                                                                                                                                                                                                                                                           |
| Settings Store (`infrastructure/storage`) | The only code that knows the storage schema/keys; validates data read back from `browser.storage`.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Messaging (`infrastructure/messaging`)    | Typed message contracts and a typed router, instead of ad-hoc strings.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Page Analysis / Settings (`features/`)    | Content-script controller; React hooks (`useSettings`, `usePageAnalysis`) for Popup/Options.                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Data flow — analysis & adaptation

```mermaid
flowchart TD
    A[Web Page DOM] --> B[Content Script]
    B --> C[DOM Analyzer]
    C --> D[Color Engine]
    D --> E[Conflict Detection]
    E --> F[Adaptation Engine]
    F --> G[Injected Stylesheet]
    G --> A

    H[Popup] -- "ANALYZE_PAGE / ENABLE_ADAPTATION" --> B
    H -- "GET_SETTINGS / UPDATE_SETTINGS" --> I[Background]
    J[Options] -- "GET_SETTINGS / UPDATE_SETTINGS" --> I
    B -- "GET_SETTINGS" --> I
    I --> K[(browser.storage.local)]
```

## Messaging

See `src/infrastructure/messaging/messages.ts` for the full typed contract.
Two independent channels are used, matching what the WebExtension APIs
actually support:

- **Extension pages → Background** (`browser.runtime.sendMessage`): `GET_SETTINGS`,
  `UPDATE_SETTINGS`. Background is the single writer of settings.
- **Extension pages → Content Script of one tab** (`browser.tabs.sendMessage`):
  `ANALYZE_PAGE`, `GET_ANALYSIS`, `ENABLE_ADAPTATION`, `DISABLE_ADAPTATION`,
  `REFRESH_ADAPTATION`. Only a content script can see/modify the page DOM.
  Two debug-only messages, `GET_DYNAMIC_DIAGNOSTICS` and `FLUSH_DYNAMIC`, expose the
  dynamic pipeline's local counters to the E2E suite (nothing leaves the device).
  The developer audit (M9) adds `AUDIT_RUN`, `AUDIT_GET`, `AUDIT_HIGHLIGHT`, `AUDIT_CLEAR_HIGHLIGHT`,
  `AUDIT_CLOSE`, `AUDIT_NOTE_EXPORT` and the debug-only `AUDIT_DIAGNOSTICS`; payload types live in
  `core/audit/session.ts`. An open audit page also holds a `runtime` port named `coloradapt-audit`
  (`AUDIT_PORT_NAME`) to the content script: while it is open the audit re-runs on page changes (batched),
  and when it drops (tab closed or navigated) the session ends and the highlight is removed.

Every message is validated at the receiving end with `isColorAdaptMessage`
before being dispatched, since both `runtime.onMessage` and
`tabs.onMessage` are untyped `any` channels shared with other code.

## Adaptation lifecycle

1. Content script loads, asks Background for current settings.
2. If enabled, it runs the DOM Analyzer (bounded by
   `docs/PERFORMANCE.md`'s budget) over the page. Each element's
   effective foreground/background is resolved through ancestor
   traversal and nested opacity-group compositing (opacity dims an element
   and its descendants as one group, not per layer; `opacity` on `html`/`body`
   yields `partial`) — see `docs/CSS_ANALYSIS.md`.
3. Elements whose background could not be confidently resolved (a
   gradient/image in the visible stack) are excluded from Conflict
   Detection entirely — see `ElementDescriptor.analysisStatus`. The rest
   go through Conflict Detection for the active vision profile.
4. Every `resolved` element goes through the Adaptation Engine
   (`createAdaptationPlan` -> `findAdaptation`): problem detection from the
   M2 simulated distance, a bounded OKLCH candidate search, scoring, and a
   foreground-only color that is the smallest sufficient change with no
   material WCAG contrast regression — or `no-safe-candidate`. `partial`/
   `unsupported` elements are never adapted. The result is a data-only
   `AdaptationPlan`; the core never writes CSS. See
   `docs/ADAPTATION_ENGINE.md`.
5. Changes are applied as CSS rules in a single injected
   `<style id="coloradapt-stylesheet">`, targeting elements via a
   `data-coloradapt-id` attribute — never inline styles, never direct DOM
   mutation of content. Elements whose `color` is animated are not adapted. Every
   commit suppresses `transition` for one synchronous style flush (no fade or
   flicker), and the browser's computed color is read back: a change the cascade
   did not honor (e.g. inline `!important`) is dropped and counted as
   `notApplied` (`docs/ADAPTATION_ENGINE.md`, "CSS application policy").
6. After the first adaptation, a dynamic-site pipeline (M4,
   `features/dynamic-analysis`) keeps it current: one `MutationObserver` ->
   own-mutation filter -> per-frame batcher -> classifier -> affected roots ->
   incremental analysis of those roots -> stylesheet delta. A full rescan is the
   explicit fallback (stylesheet changes, `<html>/<body>` changes, budget
   overflow). The observer exists only while adaptation is ON. See
   `docs/DYNAMIC_ANALYSIS.md`.
7. Inline `<svg>` elements (M5, `core/svg`) are analyzed as one unit each: a bounded
   walk, one shared style probe per batch, and a single effective paint over the
   page background. A unit that is exactly one visible paint becomes an
   `ElementDescriptor` with `svg` info and goes through the same optimizer and
   `AdaptationPlan`; its rules (`color` on the `<svg>`, `fill`/`stroke` on the `<svg>`,
   shapes, or `<use>` instances) share an owner and are verified and dropped as a
   group. Everything else is classified (`unsupportedReason`) and left alone. M4
   handles dynamic SVG with no separate observer: anything inside an `<svg>` is a
   change of that `<svg>`. See `docs/SVG_ANALYSIS.md`.
8. Raster images (M8, `core/images` + `features/images`; off unless `adaptImages`): an `<img>` is
   read through an offscreen canvas under the browser's own same-origin/CORS rules (a tainted canvas
   is never read around), summarized (clusters, entropy, transparency), classified and decided on
   with "leave it alone" as the default. Only a high-confidence functional monochrome icon over a
   known solid background is recolored (M3 optimizer, cluster-aware remap, verified), by showing a
   generated bitmap through an object URL that a memory-only cache owns and revokes. Photographs,
   logos, screenshots, charts, status graphics and anything uncertain are untouched. M4 supplies the
   regions; one capture-phase `load`/`error` listener covers loads. See `docs/IMAGE_ADAPTATION.md`.
9. The developer audit (M9) is a separate, on-demand consumer: `ContentController.auditSources()` re-reads the
   page once under `withOriginalStyles` (M1/M5 descriptors, M3 outcomes, and read-only `auditScan` hooks of the
   M6/M7/M8 layers), `features/audit` turns that into candidates and `core/audit` into a snapshot. It works
   whether or not adaptation is on, never adapts, and writes only the analyzer's `data-coloradapt-id` and its own
   highlight box. The highlight (`data-coloradapt-audit-overlay`, `position: fixed`, `pointer-events: none`, on
   `<html>`) is a ColorAdapt-owned node: `features/dynamic-analysis/ownership.ts` treats its insertion and
   `style` changes as self-mutations, and the audit skips it. See `docs/DEVELOPER_AUDIT.md`.
10. Disabling adaptation removes that one stylesheet. The page's original
    styles were never touched, so this is an exact restore. Every analysis
    (including re-scans while adapted) runs with the stylesheet suspended, so
    the original styles stay the source of truth and adaptation never compounds.

## Lifecycle and failure behavior (M12)

- **Every context is disposable.** The MV3 service worker holds no state that matters: it reads settings from storage
  on every message, and a stopped worker is woken by the next one (tested: stopped five times in a row, and with
  messages in flight). The only persisted state is the settings key (`docs/m12/storage.md`).
- **A content script owns its page and gives it back.** `ctx.onInvalidated` (WXT) fires when the extension is
  reloaded, updated or disabled, or when a newer copy of the script starts in the same page; a 5-second check of
  `ctx.isInvalid` covers the browser that gives an orphan no event. On invalidation the script removes its message
  listeners, closes the audit session and runs `disableAdaptation()` (stylesheet, observers). Firefox destroys an
  orphan without running it: its stylesheet stays until the tab is reloaded.
- **Fail closed.** If the settings cannot be read, a page stays unadapted; popup and options say so instead of
  loading forever; a handler failure answers `undefined`; the audit page refuses a tab id that cannot name a tab; each
  UI root has an error boundary.
- **No History API hooks, no global patching.** Navigation is learned from the browser (`tabs.onUpdated`) and from the
  DOM the page changes; a static check of the bundles fails on any reference to `pushState` or `replaceState`.
- **Known limit.** The cost of one pass grows with the number of rules already in the stylesheet; adding thousands
  of adaptable elements at once is slow but bounded and always ends idle (`docs/PERFORMANCE.md`, `docs/m12/report.md`).

## Why no `<all_urls>`

Content scripts/host permissions are scoped to `http://*/*` and
`https://*/*` rather than `<all_urls>`, which excludes `file://`,
`chrome://`, extension pages, etc. — surfaces ColorAdapt has no reason to
run on. See `docs/SECURITY.md`.
