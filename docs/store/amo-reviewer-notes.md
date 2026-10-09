# AMO "Notes for Reviewers": paste-ready

Paste the text block below into the "Notes for Reviewers" field of the version. It is the single source for that field
(`docs/store/firefox-listing.md` points here). Facts are checked by `pnpm release:validate`; nothing here has been submitted.

```text
SOURCE AND BUILD
The source archive is supplied for review and reproducibility only; the add-on is proprietary (All Rights Reserved, see LICENSE
in the archive). Add-on id: coloradapt@melkumyan.
This add-on is written in TypeScript and React and bundled/minified with Vite through WXT (https://wxt.dev). The source
archive (coloradapt-source-0.1.0.zip) contains everything needed; AMO_BUILD.md at its root gives exact steps:
  OS: any (verified on Windows 11 x64); Node.js 22.17.1; pnpm 11.9.0
  pnpm install --frozen-lockfile
  pnpm build:firefox            -> dist/firefox-mv2/
  node scripts/release/package.mjs --no-source --out ../out
The resulting coloradapt-firefox-0.1.0.zip is byte-identical to the uploaded file (SHA-256 in SHA256SUMS). No
commercial or web-based tool, no private registry, no network access other than downloading the locked npm dependencies.
Run "pnpm audit:dist" to check the bundle (permissions, CSP, no eval, no remote code).

THIRD-PARTY LIBRARIES (bundled, unmodified, all MIT; license texts in THIRD_PARTY_NOTICES.txt inside the add-on)
react 19.3.0 and react-dom 19.3.0 (https://github.com/facebook/react), scheduler 0.28.0 (same repository),
culori 4.0.2 (https://github.com/Evercoder/culori). Exact versions and sources: pnpm-lock.yaml; sbom.json in the release.

PERMISSIONS
"storage": saves the user's settings. Host access http://*/* and https://*/*: the content script must inspect and adapt
page presentation on websites where the user uses the add-on; processing is local. No other permission.
Manifest V2 is kept for Firefox (browser_action, background script); strict_min_version 140.0.

DATA COLLECTION
data_collection_permissions: required ["none"], optional ["websiteContent"]. By default nothing is sent anywhere.
An optional, disabled-by-default "AI-assisted review" in the developer audit can send a small sanitized semantic summary
(short visible labels, accessible names, ARIA state values; never form values, URLs, cookies or page text) to a model
runtime on the USER'S OWN COMPUTER (127.0.0.1 or localhost, enforced by the extension CSP connect-src, by an endpoint
allowlist, and by "redirect: error"). Because Firefox counts that as data leaving the add-on, the add-on requests the
optional "websiteContent" permission through Firefox's own prompt, only when the user presses "Run AI-assisted review";
without it no request is made; withdrawing it cancels the run and sends nothing further. No cloud endpoint exists, there
is no fallback, no model or WebAssembly is bundled, and model output is parsed as a closed data schema and validated: it is
never executed and cannot call tools or change a page.

NO REMOTE CODE
All logic is in the package. There is no eval, new Function, remote import or downloaded script. Model output is DATA ONLY:
it must match a closed schema, is parsed as data and deterministically validated, cannot execute code or invoke tools and
cannot modify the page directly.

KNOWN LIMITATION (Firefox)
After an add-on update or reload Firefox destroys the old content script without cleanup, so a tab that was already open
keeps its previous adaptation until reloaded (cosmetic; nothing else breaks).

HOW TO TEST (no account, key or paid service)
See REVIEWER_GUIDE.md (in the source archive under docs/store/). Short version: serve docs/store/reviewer-fixture/ over
http (python3 -m http.server 8080 in that folder), open http://localhost:8080/, open the ColorAdapt toolbar popup, choose
"Deuteranopia", turn Protection on, then open "Developer audit". Ollama is NOT needed to review the add-on.
```
