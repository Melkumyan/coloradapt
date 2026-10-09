# Privacy

ColorAdapt is local-first and privacy-first by design, not by policy
alone — there is no backend for it to send data to.

- **All analysis happens on-device.** Page content (DOM structure, computed
  styles, colors) is read and processed entirely within the browser, in the
  content script injected into that page. By default it does not leave the browser; the one optional exception
  is the AI-assisted review below, which can send small redacted summaries to a model runtime on this computer.
- **No data is sent to an Internet service.** ColorAdapt has no backend. There is no network request in the
  codebase that transmits page content, settings, or usage data to any server on the Internet. The only network
  calls it can make are listed in `docs/store/STORE_RELEASE.md` ("Network inventory"): requests to the loopback
  model runtime you configure (optional AI review), and, with the optional image layer, a re-read of an image the
  page itself already displays (same origin or CORS-enabled), exactly as the page could.
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
- **AI-assisted review (M11) is optional, off by default, local and advisory.** Off, it does nothing: no code
  path waits for a model and the audit page makes no request. On, and only when the developer presses the
  button, small bounded and redacted summaries of the audit's _manual-review_ findings (a handful of ARIA state
  tokens, a bounded accessible name, up to five nearby labels, same-kind sibling names, the matched state words) are
  sent to a model runtime on this computer's loopback (`127.0.0.1` or `localhost` with a port; the IPv6 loopback is not
  offered because no browser can allow it in the extension's content security policy) and nowhere else; there is no cloud provider and no fallback to one. Form values, text of editable regions, URLs, ids, class
  lists, `data-*`, cookies, storage, full text, HTML and image pixels are never part of a summary. Short visible
  labels (which may include a person's name: M11 does not try to detect names) can be part of one, and go only to
  your own computer. The runtime that receives them is separate software with its own behavior. Prompts and
  answers are never stored or exported; a report may carry labels, ids, statuses and a fingerprint, apart from the
  findings. What the local runtime does with a request is outside ColorAdapt's control. **Firefox** counts this as
  data leaving the add-on, so the add-on declares the optional `websiteContent` data-collection permission and
  Firefox itself asks for it the first time you press the button; without it nothing is sent, and you can withdraw it
  at any time in the add-on's permissions. See `docs/AI_PRIVACY.md` and `docs/store/PRIVACY_POLICY.md`.
- **No telemetry.** There is no analytics or crash-reporting SDK in this
  project, and none is planned as a default-on feature.
- **Local diagnostics only.** When something recovers or fails, ColorAdapt writes one line to the browser's own
  developer console (`[ColorAdapt] diagnostic: <code>`), with at most the _names_ of unusable settings fields or the
  class name of an error. It never includes a stored value, a URL, a page's text or anything you typed, and it is
  never sent anywhere. The only thing ColorAdapt stores is its settings (one key, no page content; `docs/m12/storage.md`).
- **No account, no registration, no login.** The extension works
  immediately after installation.

## If this ever changes

Any future feature that would send data off-device (the M11 AI-assisted review does not: it sends to this
computer's loopback only, `docs/AI_PRIVACY.md`) must:

1. Be strictly opt-in, off by default.
2. Clearly disclose what is sent and why, before enabling it.
3. Never be required for the core extension to function.

This document reflects the current policy and will be updated if/when such a feature is built.
