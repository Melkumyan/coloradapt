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
