# Privacy

ColorAdapt is local-first and privacy-first by design, not by policy
alone — there is no backend for it to send data to.

- **All analysis happens on-device.** Page content (DOM structure, computed
  styles, colors) is read and processed entirely within the browser, in the
  content script injected into that page. It never leaves the device.
- **No data is sent to a server.** ColorAdapt has no backend. There is no
  network request in the codebase that transmits page content, settings, or
  usage data anywhere.
- **No API keys, no third-party services.** ColorAdapt does not call any
  external API.
- **Settings are stored locally.** User settings and per-site profiles are
  stored using `browser.storage.local`, which stays on-device (and, if the
  browser's own sync feature is separately enabled by the user at the OS/
  browser level, is subject to that browser's own sync privacy terms — not
  anything ColorAdapt adds).
- **Image pixels stay in the browser.** With the optional image layer (`adaptImages`, off by
  default) ColorAdapt reads the pixels of images the page already displays, locally, to analyze and
  recolor a few kinds of icons. Pixels, statistics and generated bitmaps are never uploaded, never
  stored in extension storage, never sent to a proxy or an API; generated bitmaps live in memory only
  and are revoked when no longer shown. See `docs/IMAGE_ADAPTATION.md`. M8.R1 re-checked it: the manifest permissions are unchanged since
  `m7-charts` (`storage`, `http(s)` host access), the image layer adds no host, no upload and no
  analytics, and with it on the set of hosts the page contacts is the same as with it off (E2E).
- **Developer audit (M9) is local and on demand.** The audit page asks the content script of one tab for a
  report; nothing is sent to a server, it makes no network request, and there is no telemetry (counters such
  as `auditExports` stay in memory). With no audit page open it does nothing. It reads the same page data as
  the rest of the extension (computed styles, structure) plus a few attributes it needs (`aria-*`, `role`,
  `alt`, class and id names, the `type` of an `input`). It never reads or exports values of `input`,
  `textarea`, `select`, `contenteditable` or password fields, cookies, storage, headers, `href`/`src` or
  `data-*` attributes, and no full HTML. Visible text appears only as a snippet of at most 40 characters of an
  element's own text with emails, long numbers and opaque tokens replaced, and never for form controls or
  editable regions. A report keeps the page's origin and pathname (opaque path segments redacted) and never the
  query, fragment or credentials. Exports (JSON; standalone HTML with no script or remote resource) are made in
  the audit page and saved through the browser's download; ColorAdapt does not store or upload them. The
  highlight is a temporary overlay box that reads and sends nothing. Page text also loses every control,
  bidirectional, zero-width and line-separator character and unpaired surrogate (they cannot reorder or
  hide text in a report); only a bounded window of an element's text is ever read (a 100 KB element adds one
  40-character snippet). **Nothing of an audit is persisted**: findings, locators, page text and exports live
  in memory (page and audit tab) and are gone when either closes; no `chrome.storage` key, `localStorage`,
  IndexedDB or cache holds any of it (checked in a real browser). The audit page learns the tab's address
  from the browser only to compare its sanitized origin and path with the snapshot's; the raw address is
  neither stored nor exported. A report is always the whole snapshot, whatever the audit page's filters
  show. See `docs/DEVELOPER_AUDIT.md` and `docs/AUDIT_EXPORT_SCHEMA.md`.
- **No telemetry.** There is no analytics or crash-reporting SDK in this
  project, and none is planned as a default-on feature.
- **No account, no registration, no login.** The extension works
  immediately after installation.

## If this ever changes

Any future feature that would send data off-device (for example, an
opt-in AI-assisted semantic module — see `docs/ROADMAP.md` M11) must:

1. Be strictly opt-in, off by default.
2. Clearly disclose what is sent and why, before enabling it.
3. Never be required for the core extension to function.

This document reflects the current, foundation-stage policy and will be
updated if/when such a feature is built.
