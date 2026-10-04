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
- **No telemetry.** There is no analytics or crash-reporting SDK in this
  project, and none is planned as a default-on feature.
- **No account, no registration, no login.** The extension works
  immediately after installation.

## If this ever changes

Any future feature that would send data off-device (for example, an
opt-in AI-assisted semantic module — see `docs/ROADMAP.md` M10) must:

1. Be strictly opt-in, off by default.
2. Clearly disclose what is sent and why, before enabling it.
3. Never be required for the core extension to function.

This document reflects the current, foundation-stage policy and will be
updated if/when such a feature is built.
