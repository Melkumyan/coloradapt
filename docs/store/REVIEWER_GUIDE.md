# Reviewer guide

Verify ColorAdapt's core behavior in a few minutes. No account, password, API key or paid service is needed, and the
optional AI feature (and Ollama) is **not** needed.

## What you need

- Chrome (desktop) or Firefox 140+ (desktop).
- The extension package you were given (Chrome: `coloradapt-chrome-0.1.0.zip`, unpacked; Firefox: `coloradapt-firefox-0.1.0.zip`).
- A way to serve the test page over `http` (the extension runs only on `http://` and `https://` pages, not `file://`):
  in the folder `docs/store/reviewer-fixture/` of the source archive run `python3 -m http.server 8080` (or
  `npx serve .`), then open `http://localhost:8080/`. The fixture is a self-contained "sample dashboard" with
  no accounts, no personal data and no third-party content.

## Steps (about 5 minutes)

1. **Install.** Chrome: `chrome://extensions`, Developer mode, Load unpacked. Firefox: `about:debugging`, This
   Firefox, Load Temporary Add-on, select the zip. The install prompt lists one data-related permission: access to
   websites. Nothing else is requested; Firefox's add-on page shows "required data collection: none" and the optional
   "website content" item (used only by the AI feature, see step 8).
2. **Open the fixture** `http://localhost:8080/`. It shows messages, a status table, a form, icon buttons.
3. **Open the ColorAdapt popup** (toolbar button). Protection is ON by default; the vision profile is "Normal vision",
   which adapts nothing. This is the baseline.
4. **Select "Deuteranopia"** in the popup's Vision profile list. The page is adapted for that profile.
5. **See the non-color cues.** In the Services table the green "Online" and red "Offline" badges and the status dots
   gain a small check mark / cross; the invalid email field gets a dashed outline. These are added as CSS
   pseudo-elements; the page's own markup is unchanged.
6. **Charts.** Click the "Weekly visits chart" link (`chart.html`). Series that were told apart only by red/green/olive
   color gain different line styles (solid, dashed, dotted), and the legend mirrors them.
7. **Turn it off.** Set Protection OFF in the popup: the page returns exactly to the original (no check marks, no dashes).
8. **Developer audit.** In the popup press **Developer audit**. A read-only report opens in a tab: findings with severity,
   confidence, evidence, a coverage table that says what was and was not audited, and exports (JSON and HTML). Scroll to
   **AI-assisted interpretation**: it reads "AI assist off ... Optional and off by default". You do not need to enable it.
   If you want to see the permission flow in Firefox, see "Optional AI review" below.

## What to check against the policy

- **Network:** open the browser's network panel or run a proxy while doing steps 2 to 8: ColorAdapt makes no request of
  its own (the only requests are the fixture's). There is no telemetry or analytics.
- **Permissions:** `storage` and website access (`http://*/*`, `https://*/*`) only. Website access is required because the
  content script adapts the page the user is viewing.
- **No remote code:** the package has no `eval`, no remote script and no WebAssembly; Chrome's manifest is Manifest V3.
  `pnpm audit:dist` (from the source archive) verifies this on the built bundles.
- **Defaults:** `semanticAIEnabled` is `false`; an upgrade never changes it.

## Optional AI review (only if you want to see it)

The AI-assisted review sends a small sanitized summary to a model runtime **on your own computer**; it is off by default.
To exercise it without a model you can run any local server on `127.0.0.1` that answers `POST /v1/semantic`
(ColorAdapt's own minimal protocol, `docs/AI_PROVIDER_PROTOCOL.md`), or install Ollama and follow the setup in
`docs/store/SUPPORT.md`. Then: Settings, enable AI-assisted review, provider and address (`127.0.0.1` or `localhost`
only), then press **Run AI-assisted review** in the audit page. In Firefox the browser shows its own permission prompt for
"website content" first: Deny sends nothing; Allow lets requests reach only that local address. Revoke it in the add-on's
permissions page and the next request is refused. There is no cloud endpoint. Model answers must match a closed
schema, are parsed as data and deterministically validated; they cannot execute code, invoke tools or modify the page
directly. The Firefox add-on id is `coloradapt@melkumyan` (permanent). Ollama must allow the extension origin
(`OLLAMA_ORIGINS` with `chrome-extension://*` or `moz-extension://*`; Firefox gives each installation a random internal
address, so use the wildcard rather than a fixed address).

## Screenshots

Captions of the five store screenshots (all from the real extension on the fixture above):

1. Original page and the same page with ColorAdapt (deuteranopia profile) side by side.
2. The toolbar popup: Protection, vision profile, adaptation strength.
3. Small non-color cues (check, cross, dots) where color alone carried a state.
4. A chart whose series are told apart by line style, not only color.
5. The developer audit and the optional local AI-assisted review panel (off by default).

## Fixture files

`docs/store/reviewer-fixture/index.html` and `chart.html`: static HTML with inline CSS, no script, no external request.
