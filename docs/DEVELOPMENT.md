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
pnpm verify       # lint + typecheck + test + build, in that order
```

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
- `src/core` — pure(ish) business logic (color math, DOM analysis,
  conflict detection, adaptation). No React, no `wxt/browser`.
- `src/infrastructure` — the only layer allowed to import `wxt/browser`
  (storage, messaging).
- `src/features` — React hooks and the content-script controller that wire
  `core` + `infrastructure` together.
- `src/entrypoints` — thin WXT entrypoints (background, content script,
  popup, options).

## Adding a new `VisionProfile`

1. Add the id to `VisionProfile` and `VISION_PROFILES` in
   `src/domain/models/vision-profile.ts`.
2. Add its `VisionProfileInfo` entry (label, description, default
   severity).
3. If it needs its own simulation behavior (not just an interpolation of
   an existing dichromacy), extend `core/color/simulate.ts`.
4. Add a test in `tests/core/color/simulate.test.ts` and
   `tests/domain/vision-profile.test.ts`.

## Adding a new conflict detection rule

Conflict detection lives in `src/core/conflicts/detect-conflict.ts`. To
change how severity is determined, adjust `determineSeverity` and the
thresholds in `src/core/conflicts/thresholds.ts`. Keep the function pure —
it should only read its arguments and return a `ColorConflict | null`.

## Adding a new `AdaptationRule`

The current `computeAdaptation` (`src/core/adaptation/adaptation-engine.ts`)
applies one built-in strategy (lightness-only contrast fix) to every
high/critical conflict. To add a role-specific strategy (e.g. a different
fix for links vs. badges), branch on `ElementDescriptor.role` inside
`computeAdaptation`, or — once there's more than one or two strategies —
extract each into something implementing the `AdaptationRule` interface in
`src/domain/models/adaptation.ts` and compose them.

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
