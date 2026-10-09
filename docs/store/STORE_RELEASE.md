# Store release (M13)

The release candidate of ColorAdapt for the Chrome Web Store and Mozilla Add-ons (AMO). M13 prepares and validates
everything that can be prepared without a publisher account; nothing was uploaded, submitted or published, and nothing
was committed, tagged or pushed. The submission itself is M13.R1.

Machine-checked by `pnpm release:package` (builds `release/m13/`) and `pnpm release:validate` (reads it, never changes
it). Evidence for the browser behavior is in `realworld/m13/` (real Chrome and Firefox).

## 1. Policy snapshot (2026-10-08)

| Store   | Source (official)                                                                                            | What it requires of ColorAdapt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Chrome  | https://developer.chrome.com/docs/webstore/program-policies/policies                                         | Single purpose "narrow and easy to understand"; "narrowest permissions necessary"; an accurate privacy policy and prominent disclosure if user data is handled; collect/use/transmit only what the single purpose needs; no remotely hosted logic ("the full functionality of an extension must be easily discernible from its submitted code"); accurate listing and privacy fields that match the policy and the behavior                                                                                                                |
| Chrome  | https://developer.chrome.com/docs/webstore/images                                                            | 128x128 PNG icon; one 440x280 small promo image (required); screenshots 1280x800 (or 640x400), 1 to 5; marquee 1400x560 optional                                                                                                                                                                                                                                                                                                                                                                                                           |
| Chrome  | https://developer.chrome.com/docs/webstore/cws-dashboard-privacy                                             | Privacy tab: single purpose text, one justification per permission, remote-code declaration, data-usage checkboxes and certifications, privacy policy link                                                                                                                                                                                                                                                                                                                                                                                 |
| Firefox | https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/                            | `browser_specific_settings.gecko.data_collection_permissions` with `required` and `optional` lists; `required: ["none"]` declares no collection; `websiteContent` ("anything visible on a website") is a valid category; optional data is requested with `permissions.request({data_collection: [...]})` from a user action; built-in consent exists from Firefox 140 (desktop) and 142 (Android); older versions must not collect without a custom experience, so set `strict_min_version`, disable collection, or build a custom consent |
| Firefox | https://extensionworkshop.com/documentation/publish/source-code-submission/                                  | Source is required for minified or generated code; reviewers rebuild and diff ("there must be no differences"); README with OS, tool versions, install and build commands; lockfile; build tools open source and local; default reviewer environment Ubuntu 24.04 ARM64, Node 24.14.0, npm 11.9.0 unless the README says otherwise; source up to 200 MB                                                                                                                                                                                    |
| Firefox | https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_security_policy | Extension-page CSP rules: script sources `'self'` only (no `unsafe-eval`, no remote scripts); non-script directives are unrestricted by the platform. The page does not say whether IPv6 hosts are valid in `connect-src`: this was tested in the browsers (section 8)                                                                                                                                                                                                                                                                     |

### 1b. Policy refresh (2026-10-09, M13.R1)

All eight sources were re-read from the official pages on 2026-10-09. **Material change from the first snapshot: NO** for
every item.

| Item                                                      | Official source                                                                   | Material change |
| --------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------- |
| Chrome single purpose                                     | developer.chrome.com/docs/webstore/program-policies/policies (updated 2025-05-22) | NO              |
| Chrome permissions, privacy, limited use, policy URL      | same page; developer.chrome.com/docs/webstore/cws-dashboard-privacy               | NO              |
| Chrome remote code (MV3)                                  | same pages                                                                        | NO              |
| Chrome listing assets (128 icon, 440x280, 1-5 x 1280x800) | developer.chrome.com/docs/webstore/images                                         | NO              |
| Firefox `gecko.id` syntax, `strict_min_version`           | developer.mozilla.org .../manifest.json/browser_specific_settings                 | NO              |
| Firefox `data_collection_permissions`                     | extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/         | NO              |
| Firefox runtime consent API                               | same page (`permissions.request({data_collection})` from a user action)           | NO              |
| AMO source and build requirements                         | extensionworkshop.com/documentation/publish/source-code-submission/               | NO              |

Details: `coloradapt@melkumyan` matches `^[a-zA-Z0-9-._]*@[a-zA-Z0-9-._]+$` (80 characters at most); the
`data_collection_permissions` key is mandatory for new AMO submissions since 2025-11-03 and is declared; the reviewer
default image is Ubuntu 24.04 with Node 24.14.0 and no pnpm, so `AMO_BUILD.md` states Node 22.17.1 and the pnpm install
command. AMO also asks for a privacy policy when data leaves the device (ours is declared optional, loopback only), a license
selection, and recommends support contact fields.

The dashboard category list and the exact wording of the Chrome data checkboxes are not published in the pages above
and could not be read without a developer account: they are re-checked in the dashboard at M13.R1
(`docs/store/chrome-privacy-practices.md`).

## 2. Single purpose

> ColorAdapt improves the readability and distinguishability of web interfaces for people with color-vision
> deficiencies by adapting color-dependent visual information in the browser.

Feature audit (does it directly serve that purpose?):

| Feature                                            | Serves the purpose | Note                                                                                          |
| -------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------- |
| Color adaptation of text and UI colors             | Yes                | The core                                                                                      |
| Color-vision simulation (estimates, per profile)   | Yes                | Drives which combinations are adapted; not a medical model                                    |
| Semantic non-color cues (status marks, underlines) | Yes                | Adds a second channel where color alone carries a state                                       |
| Chart series differentiation                       | Yes                | Line styles, markers, patterns in supported SVG charts                                        |
| SVG icon and (opt-in) image icon adaptation        | Yes                | Recolors single-color icons only                                                              |
| Developer accessibility audit                      | Yes                | Reports color-dependent problems in a page to the person who can fix the source               |
| Optional local AI-assisted review                  | Yes, subordinate   | Optional advice on audit findings that need manual review; no effect on pages; off by default |

Nothing fails the audit, so nothing is removed and no broader purpose is invented.

## 3. Release version

`0.1.0` is the first public version, kept deliberately: it is the version in `package.json` and both generated manifests,
no stable version had been designated, and a `1.0.0` would suggest a maturity the scientific status does not support
(M2, the color-vision model, is PARTIAL). One value is used everywhere; `release:validate` fails if any differ:
`package.json`, Chrome manifest, Firefox manifest, `release-manifest.json`, the source archive's `package.json`,
`RELEASE_NOTES.md`, `AMO_BUILD.md`.

## 4. Manifests (generated by `wxt.config.ts`; never edited after the build)

|                          | Chrome                                                                                           | Firefox                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Manifest version         | **3** (hard gate; no MV2 fallback)                                                               | 2 (unchanged: no migration is needed for release compliance) |
| Permissions              | `storage`                                                                                        | `storage`                                                    |
| Host access              | `http://*/*`, `https://*/*`                                                                      | the same two patterns (listed under `permissions` in MV2)    |
| Optional permissions     | none                                                                                             | none (the optional item is data collection, below)           |
| Content scripts          | the two patterns, top frame only                                                                 | the same                                                     |
| Web-accessible resources | none                                                                                             | none                                                         |
| Externally connectable   | none                                                                                             | none                                                         |
| Background               | service worker                                                                                   | background script                                            |
| Extension-page CSP       | `script-src 'self'; object-src 'self'; connect-src 'self' http://127.0.0.1:* http://localhost:*` | the same string                                              |
| Add-on id                | not applicable                                                                                   | `coloradapt@melkumyan` (permanent, see section 12)           |
| Minimum browser          | none set (no API requires one)                                                                   | `strict_min_version` 140.0                                   |
| Data collection          | not applicable (no such key)                                                                     | `required: ["none"]`, `optional: ["websiteContent"]`         |
| Icons                    | 16, 32, 48, 96, 128 PNG                                                                          | the same                                                     |

`release/m13/permission-inventory.json` (generated) lists, for each package, every permission with the feature that needs
it, why, whether it could be optional, and the store-review text; `scripts/release/store-data.mjs` is the single source
of those texts. The validator fails on a permission without an entry and on an entry without a permission.

### Broad host access

`http://*/*` and `https://*/*` are broad and are described as such. ColorAdapt must inspect and adapt page presentation
on websites where the user enables or uses the extension; a person cannot name those sites in advance. Page data is
processed in the browser and is not transmitted. This is a core-function requirement, not a convenience: without it
there is no adaptation. There is no `<all_urls>`, no `tabs`, `webRequest`, `cookies`, `history`, `scripting` or
`activeTab`; a static gate (`audit-dist`) fails on any addition.

### Permission to code

| Permission    | Where it is used                                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `storage`     | `src/infrastructure/storage/browser-storage-backend.ts` (`browser.storage.local`)                                          |
| host patterns | `src/entrypoints/content.ts` content-script `matches`; `tabs.sendMessage` to those pages from the popup and the audit page |

A unit test (`tests/release/store-policy.test.ts`) fails if a permission has no call site or a call site needs a
permission the manifest lacks.

## 5. Network inventory

Static and runtime classification of every network-capable primitive in the shipped code (`release/m13/network-inventory.json`;
counts are checked per package):

| Primitive                                                                   | In the packages | Classification                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetch`                                                                     | 3 call sites    | (1) the optional AI client, audit page only, to the user's loopback runtime; (2) and (3) the same image-reading helper in the content script and a shared chunk (opt-in image layer: re-reads an image the page already shows, same origin or CORS-enabled, nothing is sent) |
| `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, `importScripts` | 0               | none                                                                                                                                                                                                                                                                         |
| remote `import()`, `eval`, `new Function`                                   | 0               | none; model output is parsed as data and validated, never executed                                                                                                                                                                                                           |

Normal operation has no telemetry, no analytics, no cloud backend, no advertising and no third-party tracking. The only
inference path is the optional loopback runtime. Runtime evidence: with AI off the audit page makes no request
(Chromium, E2E), with it on every request goes to the configured loopback server and a redirect is never followed
(`realworld/m13/loopback.spec.ts`, Chrome and Firefox).

## 6. Remote code

0 remote scripts, 0 CDN-loaded code, 0 `eval`, 0 `new Function`, 0 downloaded WebAssembly or code used as logic. Chrome
and Firefox pages have `script-src 'self'`. `audit-dist` and `release:validate` fail on any of these. No model weights,
inference library or WebAssembly is in either package.

**Local AI is not remote executable code.** ColorAdapt sends a bounded structured semantic query to an explicitly
configured local loopback inference runtime. The response is parsed as a closed structured schema, validated
deterministically, cannot execute JavaScript, cannot call tools, cannot modify the page and remains advisory only.

## 7. Firefox data collection (decision)

Firefox defines data transmission as data handled outside the add-on or the local browser. The optional AI-assisted
review may send sanitized, page-derived semantic context (short visible labels, accessible names, nearby labels) to a
loopback runtime, so the earlier `required: ["none"]` alone would have been inaccurate.

- Classification: **`websiteContent`**, narrowest category that fits. Not `browsingActivity`, `websiteActivity`,
  `searchTerms` or `technicalAndInteraction`: no URLs, history, searches or interaction data are collected.
- **Required:** `none`. **Optional:** `websiteContent`. The AI is off by default and not needed by anything else.
- Consent: requested only from the click on **Run AI-assisted review** (`requestWebsiteContentConsent`), shown by Firefox
  itself. Denied: no request, short explanation, no repeated prompt. Granted: loopback only, checked before every
  request. Withdrawn: cancels the run in flight, no further request.
- Older Firefox: **strategy A, `strict_min_version` 140.0.** It is the simplest defensible policy: the built-in consent
  exists from 140, so no installable Firefox can transmit without it, and no custom consent code exists to maintain.
  Impact: Firefox 139 and older, and Firefox for Android (no `gecko_android` entry; not tested), cannot install it.
- Verified in real Firefox 151 (`realworld/m13/consent.spec.ts`, native prompt answered through the browser's
  privileged context): fresh install nothing granted and 0 requests; deny 0; allow loopback; withdraw then deny 0;
  withdraw during a held request: run ends, 0 further.

## 8. CSP and IPv6 loopback (decision)

M12 carried a Firefox warning for `http://[::1]:*`. Tested with a loopback server on `[::1]`, from a page whose CSP
used each of `http://[::1]:*`, `http://[::1]:<port>`, `http://[::1]`, `[::1]:*`, `http://[0:0:0:0:0:0:0:1]:*`: **in
both Chrome and Firefox every one blocked the request**; only a wildcard host (`http://*:*`) allowed it. So IPv6
loopback cannot be expressed safely in either browser, and the earlier policy accepted an address in settings that the
browser then blocked.

Decision: remove `[::1]` from the policy of **both** packages and from the endpoint parser of both browsers. The accepted
endpoints are exactly `http://127.0.0.1:<port>` and `http://localhost:<port>` (port 1024 to 65535), the same as the CSP
permits; the policy did not get broader (no `http:`, `*`, LAN or public sources). Evidence: the old policy still produces
Firefox's "could not parse invalid host http://[::1]:*" message (control test), the new one produces none in Firefox
(browser console) and none in Chrome (`developerPrivate` errors); every accepted endpoint is reached and every refused one
is refused, in both browsers (`realworld/m13/loopback.spec.ts`, 16 checks).

## 9. Packages

`pnpm release:package` writes `release/m13/` (git-ignored; reproducible from source):

```text
chrome/coloradapt-chrome-0.1.0.zip       extension files at the archive root
firefox/coloradapt-firefox-0.1.0.zip     extension files at the archive root (AMO upload)
source/coloradapt-source-0.1.0.zip       reviewer source (AMO_BUILD.md)
listing/  chrome-en.md chrome-ru.md firefox-en.md firefox-ru.md
assets/   icon-128.png screenshot-01..05.png promo-440x280.png
permission-inventory.json  network-inventory.json  sbom.json
SHA256SUMS  release-manifest.json
```

- Archives are written by `scripts/release/lib.mjs` (sorted entries, ZIP-epoch timestamps, no extra fields): the same
  bundle gives the same bytes; no build date is embedded. Source maps are not produced.
- Contents audited by `audit-dist` on the extracted archives: only `.js .css .html .json`, the five icons and
  `THIRD_PARTY_NOTICES.txt`; no tests, fixtures, logs, notes, `.env`, maps, models, or host paths.
- The source archive is the git-tracked and untracked-not-ignored tree minus internal milestone evidence
  (`SOURCE_EXCLUDES`); it contains `AMO_BUILD.md`, the lockfile and everything `pnpm build:firefox` needs.
- Generated archives are not committed (they are reproducible, and `*.zip` is ignored); the scripts, documents and
  icon sources are.

### Reproducibility

`pnpm release:rebuild` extracts the source archive into an empty folder, runs `pnpm install --frozen-lockfile`, builds,
packages and compares: the Chrome and Firefox archives must be byte-identical to the ones in `release/m13/`. Run
twice from the same tree, `release:package` also gives identical bytes.

## 10. Dependencies and licenses

Production dependencies (bundled): `react` 19.3.0, `react-dom` 19.3.0, `scheduler` 0.28.0, `culori` 4.0.2, all MIT.
`release/m13/sbom.json` lists name, version, license and source for each; `public/THIRD_PARTY_NOTICES.txt` (generated by
`node scripts/release/third-party.mjs --write`, checked by the validator) ships in both archives with the license
texts. Build tools (WXT, Vite, TypeScript and their dependencies) are development-only and open source. No font, image
or icon asset from a third party is bundled: the icons are drawn for ColorAdapt (`assets/store/icon.svg`), and the
interface uses the system font stack. ColorAdapt itself is distributed as
**Proprietary / All Rights Reserved** (owner decision, M13.R1): `LICENSE` is in the repository and the AMO source archive
(supplied for review and reproducibility only; it grants no reuse rights). Third-party rights are unchanged
(`THIRD_PARTY_NOTICES.txt`, `sbom.json`). **Decision on shipping `LICENSE` inside the runtime packages: no.** The stores
show the license from the listing, the extension needs no copy of its own terms, and the MIT notice duty for the bundled
libraries is met by `THIRD_PARTY_NOTICES.txt`, which does ship; the source archive carries both files.

## 10b. Runtime evidence (real browsers)

All in `realworld/m13/`, run against the release archives or builds, Chrome 154 and Firefox 151 on Windows 11:

| Spec                         | What it proves                                                                                                                                                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `consent.spec.ts` (Firefox)  | native `websiteContent` prompt: fresh install nothing granted; deny gives 0 requests; allow reaches the loopback; withdrawn then denied gives 0 new requests; withdrawn while a request is held open ends the run with 0 further requests                                      |
| `loopback.spec.ts`           | `127.0.0.1` and `localhost` accepted and reached; `[::1]`, public, LAN, https and numeric spellings refused by the settings page and never saved; a redirect from the endpoint is not followed                                                                                 |
| `csp-console.spec.ts`        | the release build produces no CSP or manifest warning in either browser; the control (old policy with `[::1]`) is reported by Firefox, so the detector can see it                                                                                                              |
| `fresh-install.spec.ts`      | the extracted release archives, fresh profile: nothing stored, AI and image layer off, popup, AI-off audit with 0 requests, adaptation, profile switch, OFF restores the page, dynamic page, cues, charts, image layer opt-in, audit, browser restart and reload keep settings |
| `network.spec.ts`            | normal mode: 0 requests attributable to ColorAdapt beyond the local pages (Chrome: compared with a browser without the extension; Firefox: request observer by triggering principal); AI mode: the only extension request goes to the configured loopback runtime              |
| `ui-accessibility.spec.ts`   | popup, options and audit (with the AI panel notice): every control named, keyboard reaches all and shows a focus indicator, contrast at least 4.5:1, no horizontal scroll at 320 px                                                                                            |
| `permission-prompts.spec.ts` | the permissions as the browsers report them: Chrome `hasAllHosts` and no other warning; Firefox `storage` plus the two patterns, data collection as declared                                                                                                                   |

What the install dialogs say is the browsers' own wording (Chrome: "Read and change all your data on all websites";
Firefox: "Access your data for all websites"): the listing's sentence "ColorAdapt needs access to the websites you use in order
to adapt them" is what explains it. No other prompt appears.

## 11. Readiness states

| State                  | Value                                              |
| ---------------------- | -------------------------------------------------- |
| ENGINEERING_READY      | see the M13 report                                 |
| CHROME_PACKAGE_READY   | see the M13 report                                 |
| FIREFOX_PACKAGE_READY  | see the M13 report                                 |
| CHROME_METADATA_READY  | listing text, privacy answers, assets: see report  |
| FIREFOX_METADATA_READY | listing text, reviewer notes, source: see report   |
| PRIVACY_READY          | policy text and disclosures consistent: see report |
| PUBLIC_URLS_READY      | **NO** (external)                                  |
| EXTERNAL_ACCOUNT_READY | **UNKNOWN** (external)                             |

The values are stated in the M13 final report, derived from `release:validate` and the browser runs, not from this file.

## 12. External submission requirements (not invented, not faked)

- Chrome Web Store and AMO developer accounts, publisher identity and any account verification.
- **Firefox add-on id** `coloradapt@melkumyan` (owner decision, M13.R1; permanent once published). Syntax is valid for the
  signing flow; uniqueness on AMO can only be confirmed by the first upload (`ID_AMO_UNIQUENESS:
EXTERNAL_VERIFICATION_REQUIRED`). The `moz-extension://` origin uses a per-profile random UUID, not the id, so
  `OLLAMA_ORIGINS` uses the `moz-extension://*` wildcard.
- **Public privacy policy URL** (`PUBLIC_PRIVACY_POLICY_URL`: REQUIRED_EXTERNALLY). The content is
  `docs/store/PRIVACY_POLICY.md`; it must be hosted at an address the publisher controls.
- Public support URL or email; the repository contains no real contact and none was invented.
- Selecting the license option in the AMO form ("All Rights Reserved" / custom; text in `LICENSE`).
- Promotional video: not provided (optional).
- Confirmation of the Chrome dashboard category and data-usage checkboxes in the live dashboard (section 1).

## 13. Browser support matrix

| Browser                           | Declared                            | Tested in M13                                                                          |
| --------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------- |
| Google Chrome (desktop)           | Manifest V3; no minimum version set | 154.0.8037.98 (Windows 11, branded Chrome, fresh profile, E2E and real-browser suites) |
| Microsoft Edge and other Chromium | not listed by the store package     | not tested; not claimed                                                                |
| Mozilla Firefox (desktop)         | 140.0 and later                     | 151.0.3 (Windows 11, fresh profile, temporary add-on install of the release build)     |
| Firefox for Android               | not declared                        | not tested; not claimed                                                                |

No claim is made for "all" Chrome or Firefox versions.
