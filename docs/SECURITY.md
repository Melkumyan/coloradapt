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

## Image layer (M8)

- No new permission and no new host access: images are read only through the browser's own
  same-origin/CORS rules. A tainted canvas (`SecurityError`) is respected: no analysis, no change, no
  other route, no proxy. The byte sniff of a cross-origin image is a CORS fetch only when the page
  itself requested that image with a `crossorigin` attribute.
- Only an owned offscreen canvas is used; `CanvasRenderingContext2D.prototype` and the page's canvases
  are never touched. No `innerHTML`, `eval`, dynamic or remote code, and no script is injected into
  the page.
- Generated bitmaps are object URLs created and revoked by ColorAdapt only; a page's own `blob:` URL
  is never revoked. The page's own `src` is kept in memory and restored exactly.
- Validated in Chromium (M8.R1): a bitmap forced to fail (its URL revoked from the page, then the
  image reloaded) is rolled back to the page's `src` without a retry loop; strict page CSP
  (`img-src 'none'`, `default-src 'self'`) leaves a consistent page and no loop (Chromium lets a
  content script's blob URL through `img-src`, observed; no universal CSP compatibility is
  claimed); same-origin redirects to another origin without CORS, cross-origin redirects back,
  wrong-CORS images and malformed/oversized `data:` URLs end unread or unchanged with no escaped
  `SecurityError`. The browser's own decision (canvas taint, CORS) is authoritative, never the
  initial URL. No proxy and no fallback fetch exist. The OS-theme `matchMedia` listener reads no
  page data and sends nothing.
- Bounded work and memory: a decode ceiling, an analysis surface of at most 262 144 pixels, an
  allocation ceiling for transformed bitmaps, bounded queue, concurrency and cache
  (`docs/IMAGE_ADAPTATION.md`).

## Developer audit (M9)

- **Typed messages only.** The audit uses `AUDIT_*` entries of `MessageMap`; the content script validates every
  message with `isColorAdaptMessage` as before. The audit port is accepted only under the name
  `coloradapt-audit` (`AUDIT_PORT_NAME`); any other port is ignored. Port messages carry only a generation
  number; the snapshot travels over the typed channel.
- **No page text as markup.** The audit page is React (text nodes, never `innerHTML`/`dangerouslySetInnerHTML`).
  The standalone HTML report escapes every page-derived string (`escapeHtml`: `& < > " '`), inserts nothing as
  markup, contains no script and no external resource, and sets `Content-Security-Policy: default-src 'none';
style-src 'unsafe-inline'`, so `<script>`, `<img onerror>` and `javascript:` text from a page stay inert.
- **Untrusted page, bounded reads.** Names, text and URLs from the page pass through `core/audit/privacy.ts`
  (length caps, safe characters, redaction) before they can enter a report; text is read through a bounded tree
  walk and a bounded window (no quadratic scan of 100 KB of text); no `JSON.parse` of page strings.
- **Hostile and invisible text.** Control, bidirectional (RTL override, isolates), zero-width, format and
  line/paragraph-separator characters and unpaired surrogates are removed from page-derived strings, in
  the snapshot builder, in `escapeHtml` and again in `createAuditReport`; `parseAuditReport` rejects a
  report that still holds one, an origin with credentials, and a path with `@`, whitespace or a query.
  Verified in a real browser: a hostile page (`<script>`, `<img onerror>`, `</style><script>`, `"><svg onload>`,
  RTL override, 120 000 characters of text) produces a JSON that parses and an HTML report that executes
  nothing, opens no dialog, requests nothing but itself, and holds no `<script>`, `<img>` or `<svg>`.
- **No History API hooks.** Neither the content script nor the audit patches `history.pushState` /
  `replaceState`; the audit page uses the browser's `tabs.onUpdated` (a test scans the source and the built
  bundle for hooks).
- **The highlight is inert.** One `position: fixed`, `pointer-events: none`, `aria-hidden` box on `<html>`; it
  intercepts no click, takes no focus, is never given page content, and is removed when the session ends.
- **No new permission, no network.** The audit adds no permission or host; export is a local Blob download.
- **Read-only.** The audit never writes to the page except the analyzer's own `data-coloradapt-id` and its
  highlight box; both are filtered as ColorAdapt's own mutations.

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
