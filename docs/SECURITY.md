# Security

## Permissions

| Permission                                  | Why it's needed                                                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `storage`                                   | Persisting user settings and per-site profiles locally (`browser.storage.local`). No alternative exists for persisting settings across sessions. |
| `host_permissions: http://*/*, https://*/*` | The content script needs to read computed styles and inject a stylesheet on the pages the user visits, to do its job at all.                     |

**Deliberately not requested:**

- `<all_urls>` — scoped to `http://*/*` and `https://*/*` instead, which
  excludes `file://` pages, `chrome://`/`about:` pages, and other
  extensions' pages. ColorAdapt has no reason to run there.
- `tabs` — not needed; `browser.tabs.query({ active, currentWindow })` and
  `browser.tabs.sendMessage` work without it for an extension's own popup
  interacting with the active tab.
- Any permission related to browsing history, cookies, downloads,
  notifications, geolocation, or network request interception.

Every permission added in the future should be justified in this table
before being merged.

## Content Security Policy

WXT's default MV3 CSP (`script-src 'self'; object-src 'self'`) is used
unmodified. No remote code execution is permitted:

- No `eval`, `new Function(...)`, or remote script loading.
- No loading of JavaScript from external servers — all code ships inside
  the extension package.

## Treating the page as untrusted

The content script reads values out of an arbitrary, untrusted web page
(computed styles, element attributes). Accordingly:

- Parsed color values go through `core/color/parse.ts`, which returns
  `null` for anything it can't confidently parse as a color — no `eval`,
  no dynamic code execution, just `culori`'s parser.
- Adaptation changes are written into a single, scoped `<style>` element
  using attribute-selector targeting and CSS property values the engine
  itself computed (hex colors) — never page-supplied strings interpolated
  unescaped into CSS or HTML.
- Element ids used in CSS selectors are escaped (`escapeAttributeValue` in
  `core/adaptation/stylesheet-manager.ts`) even though they are
  extension-generated, not page-supplied, as defense in depth.
- The content script never uses `innerHTML`/`outerHTML` with page-derived
  strings, and never re-serializes page content into HTML.

## Messaging

- All cross-context messages are tagged (`channel: 'coloradapt'`) and
  validated with `isColorAdaptMessage` before being dispatched
  (`infrastructure/messaging`), so a message from an unrelated extension or
  a malformed payload is ignored rather than crashing a handler or being
  treated as trusted input.
- Message payloads are plain data (settings, analysis results) — never
  functions, class instances, or anything that could enable prototype
  pollution via structured clone.

## Prototype pollution / unsafe parsing

- `infrastructure/storage/schema.ts` parses values read back from
  `browser.storage` field-by-field with type guards (`isRecord`,
  `readBoolean`, `readUnitInterval`, ...), falling back to safe defaults
  rather than doing an unchecked `Object.assign`/spread of untrusted data
  onto trusted defaults.
- No use of `JSON.parse` on page-controlled strings, and no use of
  `Object.assign`/spread with page-supplied keys anywhere in the codebase.

## Reporting a concern

This is an early-stage, local-first project. If you find a security issue,
please open an issue in the repository describing the concern (avoid
posting exploit details in a public issue if the impact could be
significant — use responsible disclosure judgment appropriate to the
project's maturity).
