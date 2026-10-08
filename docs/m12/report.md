# M12 — Production Hardening: report

## M12.R1 RESULT (final formal sequence, supersedes the first-freeze result below)

**M12 = PASS / FROZEN** on candidate `669548fcc158d88c7331f80d9be9c413ded4949e777145cd317e192dccabb48d` (550 files, START HEAD
`4c777c2`). The whole `docs/m12/protocol.md` §9/§11/§13 sequence ran once, from the top, with no retry; the candidate hash
was identical before the run, after every stage and at the end (0 mismatches). The first-freeze text further down
(P25, P27, P33 as FAIL, PARTIAL) is the history of the first sequence; the three criteria it names were closed by the
amendments of protocol §11, and the one blocker found afterwards (P04 in Firefox) by §12 and §13.

| Gate                               | Result on the frozen candidate                                                                                                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm verify` (start and end)      | PASS both times: 144 files, 3410 tests, build, `audit:dist` (surface = golden, manifest parity)                                                                                           |
| Build, zips, audit-dist, repro     | PASS. Folders and zips byte-identical across two builds. chrome zip 224,587 B `7e791b4b…8309`; firefox zip 224,635 B `36073e19…f616`                                                      |
| M12 suites, Chrome + Firefox       | lifecycle 7 passed (1 skipped by design), state 26, messaging 14, navigation 8, crash 5 (1 skipped by design), ai-lifecycle 20, ui-a11y 16, upgrade 4 (Chrome), resource 4 (Chrome)       |
| **P04** (Firefox restart)          | **PASS**, four sessions, one readiness attempt per round (`[1,1,1,1]`)                                                                                                                    |
| **P11** (upgrade, Chrome)          | **PASS**, 4/4; preflight recorded before the run (`M12_PREVIOUS_DIR`, both previous builds present)                                                                                       |
| M10 regression, Chrome + Firefox   | runtime 16, interaction 4, dynamic 8, security 18, ai-provider 13, dist 9 passed; **spa 3 passed, 1 failed: the declared 1.1014 warm-up ratio against 1.1 (§8.3, open debt, unchanged)**  |
| Chromium E2E                       | 595 passed, 2 skipped, 14.4 min, `retries: 0`                                                                                                                                             |
| **P25** idle CPU, relative control | OFF median 0.588 %, ON 0.738 %, **delta 0.15 pp against 1.0 pp: PASS**                                                                                                                    |
| **P25** 120-minute soak            | PASS: 499 cycles, 122 samples, 0 errors, no disconnect, 0 dirty-queue / duplicate / overflow samples; heap ratio 1.044 (3.1 %/h), nodes 1.001, listeners 1.000, browser working set 1.042 |
| **P27**                            | PASS: `pnpm audit` 0 known vulnerabilities; Knip new findings 0 against the m11 baseline (192 now, 202 then); lint, typecheck, format clean                                               |
| **P33**                            | PASS: 634 files scanned, 0 findings, 13 classified reviewed false positives                                                                                                               |
| Final `pnpm verify`                | PASS on the unchanged candidate (the last gate)                                                                                                                                           |

**P04 history and root cause.** P04 failed in Firefox in two earlier formal sequences with "An unexpected error occurred" from
`storage.local.get` after a restart. Phase A could not reproduce it (72 rounds). The evidence harness (§12) captured the
third failure: a 10.9 s stall, then a generic error, with the extension, WebDriver session, background and profile healthy
and the data intact. Root-cause experiments (outside the repository) read Firefox's own console and showed that the
generic message hides a storage-layer file-lock error: QuotaManager `NS_ERROR_FILE_IS_LOCKED` renaming
`.metadata-v2-tmp` while initializing the extension's origin, or `BEGIN IMMEDIATE` returning `STORAGE_BUSY`, which IndexedDB
retries for 10 s before failing (Firefox 151.0.3 source: `dom/quota/ActorsParent.cpp`, `dom/indexedDB/ActorsParent.cpp`,
`ExtensionStorageIDB.sys.mjs`). It affected 8 of 27 first writes on a fresh profile and 2 of 78 first reads after a
restart on this host; the next access succeeded at once. **Who holds the lock is not established** (Restart Manager showed
only Firefox; a Firefox-free rename loop of 20,000 cycles did not fail; Kaspersky is installed and is a hypothesis only).
Classification: the mechanism is a Firefox storage-layer first-access refusal (HIGH confidence); the external cause is
UNKNOWN. **Fix layer: harness.** `FirefoxDriver.awaitStorageReady()` is a bounded precondition (at most 6 attempts, 90 s, cancelled
on close, every attempt recorded and annotated) before the P04 assertions, which are unchanged; no product file was
changed. Pre-freeze validation: P04 x20 20/20, 10 sequences x 10 restarts 10/10 (one natural refusal of 10.98 s recovered
on the second attempt, 19 ms, data intact). In the final sequence P04 needed no second attempt.

**Product behavior on a refused read (unchanged, already safe):** the read rejects, nothing is written, the popup and
options show an alert, the content script leaves the page unadapted. A product-side recovery after a refused first read
was not built and is open debt.

**Open debt (not criteria):** the burst-scalability limit (M12.5, before M13), the M10 SPA warm-up ratio 1.1014 against
1.1, per-site `adaptCharts` has no runtime effect, Firefox's orphaned stylesheet after an extension reload, Firefox
upgrade and resource evidence, the unidentified holder of the Firefox storage-file lock, a product-side recovery after a
refused first storage read, and the upstream scientific status (M2 PARTIAL). The P04 evidence harness stays in the
project for future Firefox regressions.

## M12 RESULT (first freeze, superseded by M12.R1 above)

**M12 = PARTIAL.** The hardened candidate behaves like a production extension in every area that was tested: no unsafe,
corrupting, leaking or looping behavior was found, every lifecycle, storage, upgrade, messaging, AI-failure, crash,
accessibility and security check passed in the browsers it ran in, and the builds are byte-reproducible. Three REQUIRED
criteria are **not met on the frozen candidate**, and this report does not move any of them:

- **P25 (soak):** the 120-minute soak missed its frozen **idle-CPU budget** (median 2.06 % against 2.0 %). Every growth,
  error and queue budget passed with wide margins, the idle-CPU windows show no trend, and a control run shows the
  browser alone idles at the same level with the extension off (median 2.06 %) and lower with it on (1.33 %). The budget
  was set on the browser's own noise floor and cannot tell the extension from the browser; it is still the frozen rule.
- **P27 (Knip):** 2 new findings against the m11 baseline: `scripts/release/candidate-hash.mjs` and
  `scripts/release/repro-check.mjs` are release scripts that no `package.json` script references. Adding them to
  `package.json` clears it, but that changes the candidate and, under the protocol, voids every formal result.
- **P33 (secret scan):** 0 findings in both bundles, both zips, `src/` and `docs/`; **1 unclassified finding** in a test
  file written after the allowlist: `realworld/m12/messaging.spec.ts` names the LAN address 192.168.1.10 (port 8080), the LAN address
  that its CSP test proves is blocked. It is a reviewed false positive; classifying it means adding one entry to
  `docs/m12/secret-scan-allowlist.json`, which is part of the candidate hash, so it is not done here.

**P34 (tree clean) is also not met, by design:** a PARTIAL gets no commit and no tag (protocol §10), so the working tree
is left uncommitted for the owner. Nothing was pushed or published. The decision this needs is at the end of the report.

|                         |                                                                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| START HEAD              | `4c777c22b62cd26ecebd97216b7cbcdbac3c0325` (tag `m11-ai-semantic-engine`)                                                                                                         |
| CERTIFICATION FREEZE    | candidate hash `c55519a6b4b9099a5893e88480623dbc1bb742068baf78ee4437b28260489913` (543 files), 2026-10-07 07:54 UTC                                                               |
| PRODUCT HEAD / END HEAD | the milestone commit tagged `m12-production-hardening` (a report cannot contain the hash of the commit that contains it; `git rev-parse m12-production-hardening`). Only on PASS. |
| BRANCH                  | `main`                                                                                                                                                                            |
| TREE                    | uncommitted: the M12 changes and new files on top of `4c777c2`; identified by the candidate hash, not by a commit                                                                 |
| PUSH / TAG / PUBLISH    | nothing pushed, nothing published. No `m12-production-hardening` tag and no commit were created (PARTIAL).                                                                        |

The frozen protocol is `docs/m12/protocol.md`; this report cites it and changes none of its criteria, budgets or limits.

## BASELINE

| Item                   | Value                                                                                                                                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tools                  | Node v22.17.1, pnpm 11.9.0, WXT 0.21.4, TypeScript 5.9.3, Playwright 1.63.0, Vitest 5.0.3                                                                                                                                    |
| Browsers               | Chrome 154.0.8037.98, Firefox 151.0.3, geckodriver 0.37.1                                                                                                                                                                    |
| Host                   | Windows 11 10.0.26300, Intel i5-12500H, 15.7 GB; no user browser running, 7.2 to 7.4 GB free at every inventory (before, between and after each campaign), no orphan browser, geckodriver or Ollama process at any inventory |
| Baseline `pnpm verify` | PASS before any change: 135 files, 3312 tests                                                                                                                                                                                |
| Baseline Chromium E2E  | PASS before any change: 595 passed, 2 skipped, 13.7 min                                                                                                                                                                      |
| Roadmap conflict       | none: `docs/ROADMAP.md` already named M12 "Production Hardening" and listed the carried items                                                                                                                                |

## PRODUCT CHANGES

Each change names the failure mode it closes. There is no new feature, no new permission and no new algorithm.

| #   | Change                                                                                                                                                                                                 | Failure mode closed                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| 1   | `entrypoints/content.ts`: `ctx.onInvalidated` removes the router, the audit port listener, closes the audit session and calls `disableAdaptation()`; a 5 s `ctx.isInvalid` check detects an orphan     | D1: after an extension reload or update an open page kept its stylesheet for the life of the tab              |
| 2   | `infrastructure/messaging/router.ts`: returns an unregister function; a handler that throws or rejects still answers (`undefined`); messages must carry this extension's id                            | D8: a failing handler left the sender's channel open; a content script could not stop answering               |
| 3   | `content.ts`: the initial settings read has a `catch` (diagnostic, page left unadapted)                                                                                                                | D10: an unhandled promise rejection and an undefined state when the background is unreachable                 |
| 4   | `features/settings/use-settings.ts`, popup and options: `failed` state, an alert instead of "Loading" forever; `update` resolves `false` on failure and callers do not act on a refused change         | D7: "Loading…" forever, an unhandled rejection, and acting as if a refused write had been stored              |
| 5   | `infrastructure/storage/settings-store.ts`: the merged value is parsed before it is written                                                                                                            | D9: any context could persist out-of-range, wrong-typed or extra fields                                       |
| 6   | `infrastructure/storage/schema.ts` and `features/settings/site-settings.ts`: hostname keys defined as own properties, read with `Object.hasOwn`                                                        | D6: `http://__proto__/` replaced the overrides' prototype; `http://constructor/` read a function as a profile |
| 7   | `schema.ts`: a recovery report (field names only) and one local diagnostic `storage-recovered`; `content.ts` diagnostics `content-script-orphaned`, `initial-settings-unavailable`                     | no signal told "storage was recovered" or "the page was orphaned" apart from other failures                   |
| 8   | `src/shared/ui/error-boundary.tsx` on popup, options and audit roots                                                                                                                                   | a render or effect error left a blank page                                                                    |
| 9   | `entrypoints/audit/App.tsx` (`tabId` limited to digits and 2,147,483,647) and `use-audit-session.ts` (a connect the browser rejects is a disconnected session)                                         | D2: `?tabId=99999999999999999999` crashed the audit page to blank                                             |
| 10  | `entrypoints/popup/App.css`: `--ca-link`, a lighter blue for text in dark mode                                                                                                                         | D4: link-style buttons were 3.62:1 in dark mode (AA needs 4.5:1)                                              |
| 11  | `wxt.config.ts`: extension-page CSP `script-src 'self'; object-src 'self'; connect-src 'self' http://127.0.0.1:* http://localhost:* http://[::1]:*`                                                    | the loopback-only AI client was code-enforced only; the carried M11.R1 item                                   |
| 12  | `pnpm audit:dist` added to `pnpm verify`; release tooling in `scripts/release/` (`audit-dist`, `secret-scan`, `knip-diff`, `repro-check`, `candidate-hash`); `docs/m12/permission-surface.json` golden | a widened surface, a stray file, a secret or unsafe code could ship unnoticed; no secret scanner existed      |

Test and harness work: 7 new unit-test files (+73 tests: router, storage corruption and diagnostics, hostname keys,
settings failure in popup and options, error boundary, release gate with 30 cases, soak statistics) and the
`realworld/m12/` suites (lifecycle, state, upgrade, messaging, navigation, crash, ai-lifecycle, ui-a11y, resource, soak).
One earlier M10 assertion was changed on purpose: `realworld/dist.spec.ts` no longer pins "no CSP override" but the
frozen policy (the M11.R1 note said that is what would change).

## CLEAN INSTALL (P02, P03)

`lifecycle.spec.ts`, fresh profile, no storage, no earlier extension state: **PASS in Chrome and Firefox.** The runtime
manifest and granted permissions equal the frozen surface (`storage`; origins `http://*/*`, `https://*/*`); the
background answers `GET_SETTINGS` with valid defaults (adaptation on, `adaptImages` off, AI off, endpoint on the
loopback); popup and options render without a fatal log; after choosing a vision profile the first page adapts, with
one stylesheet and no duplicate ids; the only request the fixture server saw was the page itself. Finding: the default
vision profile is `normal`, which has nothing to adapt, so a brand-new install changes nothing until the user picks a
profile (existing, intended behavior; recorded, not changed). Firefox: a temporary add-on; a signed store install is M13.

## BROWSER RESTART (P04)

`state.spec.ts`: four sessions on one profile in each browser, an adapted page each time. Settings (profile, strength,
`showWarnings`, a per-site override) identical every time; each session: one stylesheet, no duplicate ids, one observer
start, and the same rule count and computed color as session one. **PASS in both.** One restart does not multiply
anything. (The harness loads the unpacked extension again at each start; that is how an unpacked extension behaves.)

## EXTENSION RELOAD (P05)

`lifecycle.spec.ts`. **Chrome PASS:** the orphaned page removes its stylesheet by itself (before M12 it kept it
forever; D1); a reloaded tab and a new page each get exactly one instance (one stylesheet, one observer start); five
consecutive reloads accumulate nothing. **Firefox: the orphan keeps its stylesheet** (recorded: `orphan keeps
stylesheet: true`): Firefox destroys the old content script and runs no code in it, so the page keeps the last
adaptation until it is reloaded; the page itself stays usable and a reload or a new page is correct. This is a
browser constraint, a stated limit (§Known limitations), not a pass condition. "Disable then enable" was not scripted
(the browser UI toggle is not reachable through the harness); it is the same unload and load of the content script.

## SERVICE WORKER (P06)

Chrome (MV3). The worker is stopped by the browser's own `ServiceWorker.stopWorker`: five times in a row (each time a
message from an extension page wakes a fresh worker that reads storage and answers; the content script keeps working
meanwhile), once with 20 messages in flight (**20 of 20 answered, none hung**), and during a page load (the page's
startup message wakes it). Updating a setting through a freshly started worker reaches storage and the page. **PASS.**
Nothing depends on worker memory: it holds none that matters. Firefox's build is MV2 with a persistent background
page; not applicable.

## TAB / NAVIGATION (P07)

`navigation.spec.ts`, **PASS in both browsers.** After every step the invariants held (at most one stylesheet, no
duplicate ids, one observer start in the current document, no overflow, no pending link, no errors): the page's own
`pushState`, `replaceState`, back, forward through the browser, hash changes (no rescan), a same-origin full
navigation, a cross-origin navigation, and back across the origin boundary. Elements of a new route are adapted like
those of the old one. Tabs: duplicate (two independent documents, each one observer), discard and restore (Chrome:
the restored document runs exactly one pipeline), a tab in the background (50 added elements are processed and
nothing is left queued). A stylesheet that never answers: the tab closing, and the document being replaced while the
pipeline waits for it, leave nothing behind and the next document is correct; 3,000 elements queued and the document
destroyed straight after: the next document is correct. ColorAdapt never wraps the History API (a static check of
the bundles, `audit:dist`; a runtime check is meaningless in branded Chrome, whose built-in Hangouts component
extension wraps `history` in every page).

## SPA / DYNAMIC DOM (P08, P09)

- **Removal races** (`navigation.spec.ts` P08): 300 subtrees (HTML and SVG) inserted and removed in the same task, after
  a microtask and after a frame: no error, tracked elements back to the baseline, queues drained, no overflow.
- **SPA leak test** (`resource.spec.ts`, Chrome, extension off against on, 5,000 route changes): heap after GC, extension
  on, 2.424 MB at 50 route changes, 2.646 at 500, 2.861 at 1,000, 2.886 at 1,500, 2.910 at 2,000, 2.922 at 3,000,
  2.928 at 4,000, 2.966 at 5,000; extension off, 0.951 to 1.010. **Steady state (2,000 to 5,000 route changes): 18.6
  bytes per route change with the extension on, 0.8 off, 17.8 attributable, against a frozen 128.** DOM nodes and
  listeners flat; tracked elements under 20; one observer; empty queues. **PASS.**
- **M10 regression** (`dynamic.spec.ts`: 8 passed in both browsers, the burst, attribute-flip and idle-cost budgets of
  M10 unchanged; `spa.spec.ts`: 3 passed, 1 failed, below).
- **Self-mutation:** the unchanged M4/M6 E2E suites (595 passed), the M10 dynamic suite, and every soak sample
  (`selfMutationsIgnored` grows with the work, queues are empty at every sample, no feedback loop).

**The one failure of the M10 suites, as it is:** `realworld/spa.spec.ts` "500 route changes leave nothing behind",
Chrome: heap 2,423,700 to 2,669,456 bytes, ratio **1.1014 against the 1.1 budget** (M11.R1 recorded 1.1015, M10.R1
1.1021). The spec is unchanged and is reported as it is. M12's control shows the budget measures warm-up rather than
growth: the same page with the extension off has 1.0286 for the same comparison, and with it on the heap stops
growing in the way the budget fears (18.6 bytes per route change after 2,000). The leak verdict is the steady-state
criterion above. Because Playwright stops at the first failed assertion, that spec's node and listener ratio
assertions did not run in Chrome after the heap assertion; `resource.spec.ts` asserts both, more strictly (at most 3
and 2 after warm-up), and passed.

## STORAGE (P10) and MIGRATION (P11)

See `docs/m12/storage.md`. One persisted key, `coloradapt:settings`; no other store. **Corruption: PASS** — 12 malformed
shapes in both browsers (`state.spec.ts`: a string, a number, `null`, an array, an empty object, wrong types, unknown
enums, out-of-range numbers, a remote AI endpoint, a future schema version, site overrides of the wrong shape, cleared
storage with junk keys) and 17 shapes plus failure injection in unit tests: always valid settings, recoverable fields
kept, opt-in layers and the AI endpoint at safe defaults, popup renders, page adapts, no crash loop. **Migration:**
there is no schema version and no migration code, deliberately: no public previous state exists, every change so far
added optional fields, and the field-by-field reader is itself idempotent, deterministic and restart-safe; nothing
rewrites the stored value until the user changes a setting. A partially migrated or interrupted state cannot exist.

## UPGRADE (P11) and ROLLBACK / DOWNGRADE (P12)

`upgrade.spec.ts`, Chrome, 4 passed. ColorAdapt was never published, so the "previous versions" are the frozen
milestones built from tags in git worktrees: `m11-ai-semantic-engine` (0.0.9) and `m7-charts` (0.0.8, the oldest
shape). Each creates its own state, the candidate replaces it at the same extension id, and: settings, per-site
profiles and the semantic cue settings are intact; newer settings (AI, images) come in at their defaults; the
permission surface is unchanged (`storage`; the same hosts); one instance adapts the page to the same color; a worker
restart right after the update changes nothing. Every step proves which build runs (version, the served files hashed
against the build on disk, and a behavioral probe that only the candidate passes). An upgrade over invalid state
recovers across three worker restarts. **Downgrade is not supported and nothing here claims it:** the older build
starts, reads the newer state and adapts, but its next write drops the fields it does not know (the four AI settings,
for the m7 build), and going forward again restores them at their defaults. Storage is read-compatible, not
write-compatible, backwards. The two previous builds used here are kept outside the repository at `E:	emp\claude\m12\previous` (run the suite with `M12_PREVIOUS_DIR=E:/temp/claude/m12/previous`); the temporary worktrees they were built in were removed. Firefox upgrade: **not verified** (a temporary add-on cannot be updated in place by the
harness). A real store update cannot be run offline.

## PERMISSIONS (P13, P16)

Frozen in `docs/m12/permission-surface.json`, enforced by `audit:dist` in `pnpm verify`; 30 unit cases prove the gate
fails on widening.

| Key                                                   | Value (both browsers)                                                                                           | Why it is needed                                                                                                               |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `permissions`                                         | `storage` (Firefox MV2 also lists the hosts here)                                                               | persisting settings and per-site profiles locally; there is no alternative                                                     |
| `optional_permissions`                                | none                                                                                                            | nothing is requested at run time                                                                                               |
| `host_permissions`                                    | `http://*/*`, `https://*/*`                                                                                     | reading computed styles and injecting one stylesheet on the pages the user visits; no `<all_urls>`, `file://`, extension pages |
| `content_scripts[0].matches`                          | `http://*/*`, `https://*/*`; top frame; default `run_at`                                                        | the adaptation itself                                                                                                          |
| `web_accessible_resources`                            | none                                                                                                            | no page can load a file of the extension or probe for it                                                                       |
| `externally_connectable`                              | none                                                                                                            | no page or other extension can message the extension                                                                           |
| `content_security_policy` (extension pages)           | `script-src 'self'; object-src 'self'; connect-src 'self' http://127.0.0.1:* http://localhost:* http://[::1]:*` | scripts only from the package; network only to itself and the loopback (the optional local AI client)                          |
| `background`, `action`/`browser_action`, `options_ui` | service worker / background page, popup, options                                                                | the extension's own pages                                                                                                      |
| Firefox only: `browser_specific_settings.gecko`       | id `coloradapt@coloradapt.invalid`, `data_collection_permissions: none`                                         | a stable id for MV2 and signing; a placeholder until M13                                                                       |

Nothing was removable: every entry is used. **Manifest parity (P16):** the two manifests differ only in manifest
version, where host patterns are listed, the background form, the action key and the Firefox add-on id; name,
description, version, hosts, API permissions, content scripts, options page and the extension-page policy are equal
(`audit:dist`, with failing cases).

## CSP (P14)

Production bundles: no `eval`, `new Function`, `importScripts`, remote import or remote script, no inline script or
handler in any extension page, no History API reference, no `document.write`, no `localStorage`/`sessionStorage`/
IndexedDB, no `XMLHttpRequest`, `WebSocket`, `EventSource` or `sendBeacon`. Enforced by the browser, not only by the
bundle: on the popup and the audit page, in both browsers, a remote fetch, a LAN fetch, a remote WebSocket, an inline
script and a remote script are blocked (with `connect-src` violations reported), while the loopback, `localhost` and
the extension's own origin work. The AI provider suites still pass under the policy (13 passed in both browsers).

## NETWORK (P17)

Three `fetch` call sites exist in the bundles, all expected: the module preload helper (own chunks), the M8 page-image
reader in the content script (same-origin, `data:`, `blob:`, or cross-origin only with the page's own CORS opt-in,
credentials omitted) and the M11 loopback model client in the audit chunk (redirects and credentials refused). Network
literals in the bundles are on an allowlist (XML namespaces, React's error-message URL, loopback). Core flows make no
request: in the clean install and in every lifecycle test the fixture server saw only the pages themselves.

## PRIVACY (P17)

One persisted key, under 4 KB, no page content (checked after the soak: only `coloradapt:settings`, 424
bytes, none of the workload's page text). Diagnostics are `[ColorAdapt] diagnostic: <code>` lines with at most field
names or an error class name; tests prove a stored value planted in a damaged field is not logged. The M10 privacy
suite (secrets planted in a page reach neither the audit, the exports, the logs, the storage nor the network) passed in
both browsers on the candidate (`security.spec.ts`, 18 passed).

## AI SEMANTIC HARDENING (P18, P19, P42)

`ai-lifecycle.spec.ts` against a loopback server that plays a model, **20 passed (10 per browser).** Engine down: the
review says unavailable. Garbage, empty, off-taxonomy and 2 MB output: nothing accepted, the page untouched. A hung
engine: the review ends after **40 s** (two 20 s timeouts, then it stops), 3 requests, at most 2 in flight (the declared
concurrency), while the audited page keeps adapting, its main thread stays free (a 2-million-iteration loop ran in
under 5 s) and the audit page stays usable. Many eligible regions: 10 requests (at most the declared 64), packets under
20 KB. Cancelled by closing the audit page: the request is aborted and no late answer is sent on. **Stale results:**
reloading the audited tab with different content under the same URL leaves the audit page showing the _old_ report
(3 findings) with the explicit notice that the audited page was closed or navigated away, and with the answers that
were given for that old report; nothing of it is attached to the new document. Another route: every answer is dropped.
Core adaptation is independent of the setting and of the provider: with the AI on and a hung runtime a page adapts the
same, and adaptation alone sends the model nothing.

## CRASH RECOVERY (P20)

`crash.spec.ts`: **5 passed, 1 skipped (Firefox, where the MV3 worker and CDP tab crash do not exist).** The browser is
killed (process tree, no shutdown) with 300 settings writes in flight and a page waiting on a stylesheet: in both
browsers the restart reads valid settings (the profile written before the crash intact, the strength one of the
values written), the page adapts, one observer, no fatal log. An extension reload while a page waits: a new page is
correct (both). A worker stopped while 20 messages are in flight: none hangs; a crashed tab leaves the others, the
background and new tabs working (Chrome).

## MESSAGING (P21) and SECURITY REVIEW (P26)

`messaging.spec.ts`, **14 passed (7 per browser).** Absent receiver and closed tab: a clean rejection, never a hang;
28 duplicated and concurrent messages: one stylesheet, empty queues, a duplicate disable is harmless; 10 malformed or
unknown message forms and malformed settings patches: the content script and background keep working, patches are
sanitized; a message after a worker restart works; an audit port left by a navigated page leaves nothing behind;
pages that forge every message they can (`postMessage`, `MessageEvent`, `CustomEvent`) change nothing, and have no
`chrome.runtime.sendMessage` or `browser` to try (asserted); 16 hostile `tabId` forms (D2) leave the audit page
standing. Security review: `docs/m12/security-review.md`; 0 open findings of any severity; F1 (prototype key), F2
(unvalidated write) and F3 (CSP) were found and addressed in M12.

## RESOURCE TEST (P24)

`resource.spec.ts`, Chrome, 4 passed. Besides the leak verdict above: on a 1,500-element page, extension off against
on, heap 0.906 to 3.463 MB (+2.56 MB), DOM nodes 3,010 to 3,012, listeners 19 to 28, browser process-tree working set
658 to 755 MB (+97 MB), extension renderer processes 94 to 166 MB, idle CPU after quiescence 1.1 % (off) and 0.1 %
(on) of one core, one observer, no queued record, no deferred root. **Bursts of new adaptable elements** (new tab each;
the page is 300 elements): 1,000 added: longest main-thread task 100 ms, idle after 0.19 s (M10 budget 200 ms,
**held**); 2,000: 214 ms, 0.4 s; 5,000: 875 ms, 3.0 s; 10,000: 3,856 ms with 12 tasks over 200 ms, idle after 28.5 s.
Every size ends idle with empty queues and no overflow. Above about 2,000 elements added at once this is a known
limit (§Known limitations).

## SOAK (P25)

`soak.spec.ts`, Chrome 154, production build, **120 minutes, 498 cycles, 121 samples, one attempt, no retry**, exit 1 on one
budget only. Workload: the soak page (20 route changes, 500-node churn with 300 mutations, SVG updates, virtualized-list
replacement, 10 modals, a 300-item feed, form-validity events) every cycle, plus about 249 fresh-document navigations in a
second tab, 166 adaptation off/on toggles, 124 settings changes, 99 audit runs, 83 extra tabs opened and closed, 62
AI-assisted reviews against a loopback mock, and 49 service-worker stops.

**Hard conditions: all met.** Browser stayed up (no disconnect); 0 errors from ColorAdapt or the page; 0 samples with a
non-empty queue, pending link, rescan or throttle timer; 0 samples with a duplicate stylesheet or id, a queue overflow or
more tracked elements than nodes; 0 failed worker probes; the only persisted key `coloradapt:settings`, 424 bytes, no
page text; after the browser was closed, no process of its tree was left.

**Trends (after the 15 % warm-up, 103 samples):**

| Series                                   | First fifth | Last fifth | Ratio | Slope per hour | Frozen budget                   | Result |
| ---------------------------------------- | ----------- | ---------- | ----- | -------------- | ------------------------------- | ------ |
| JS heap after forced GC (long-lived tab) | 5.761 MB    | 5.927 MB   | 1.029 | 2.2 %          | ratio <= 1.15 and slope <= 10 % | pass   |
| DOM nodes after quiescence               | 3,211       | 3,209      | 0.999 | 0 %            | not (ratio > 1.10 and +200)     | pass   |
| JS event listeners                       | 29          | 29         | 1.000 | 0 %            | not (ratio > 1.10 and +50)      | pass   |
| Browser process-tree working set         | 1,063 MB    | 1,106 MB   | 1.040 | 2.7 %          | ratio <= 1.25 and slope <= 15 % | pass   |
| Extension renderer processes working set | 198.3 MB    | 200.8 MB   | 1.013 | 0.7 %          | ratio <= 1.25                   | pass   |
| (information) private bytes              | 571 MB      | 610 MB     | 1.069 | 4.7 %          | none                            | -      |

**Idle CPU (the miss).** Twelve 10-second windows after quiescence, as a percentage of one core, for the whole browser
process tree: 1.03, 4.71, 2.50, 2.81, 4.43, 1.47, 0.74, 1.23, 2.36, 2.06, 1.77, 1.03. **Median 2.063 % against the frozen
2 %: fail.** The range is 0.74 to 4.71 %, six times wider than the distance to the budget, with no growth (the first six
windows average 2.8 %, the last six 1.5 %).

**Attribution control (after the formal sequence; not a re-run of the soak and not part of the verdict).** The same
workload page and the same sampling for 20 minutes each, back to back, extension off then on, a temporary spec that was
deleted afterwards (the tree hash was re-verified as the frozen candidate): extension **off**, 10 windows, median
**2.06 %** (0.15 to 3.38 %); extension **on**, 10 windows, median **1.33 %** (0.15 to 5.17 %). With the extension off the
browser alone idles at the same median the soak measured with it on. The baseline in `resource.spec.ts` (1.1 % off, 0.1 %
on, on a quiet page) says the same. ColorAdapt adds no measurable idle CPU.

**P25 outcome: FAIL by the frozen rule**, with everything about leaks, stability and errors passing. The budget was not
changed and the soak was not repeated: the number above is the result of the run that was frozen. What this says about
the product is encouraging; what it says about the protocol is that an absolute whole-browser threshold of 2 % cannot
separate the extension from the browser on this host. Whether to accept the control as discharging that item, or to
re-run with a budget relative to a control, is the owner's decision (see _M12 FINAL STATUS_).

## DEPENDENCY REVIEW, KNIP, TYPECHECK, LINT (P27)

- **Dependencies.** Runtime: `culori` 4.0.2, `react` 19.3.0, `react-dom` 19.3.0 (3 packages). Development: the toolchain
  in `package.json` (WXT, TypeScript, ESLint, Prettier, Vitest, Playwright, jsdom and type packages). `pnpm audit` and
  `pnpm audit --prod`: **no known vulnerabilities**. No upgrade was done, no lockfile change.
- **Knip. Not met.** Knip had never been configured here; with its defaults the m11 build has 202 findings (17 files,
  116 exports, 69 types) and the frozen candidate 195 (17 files, 113 exports, 65 types). 9 baseline findings are gone
  (the router and settings hooks are now used by tests). **2 are new** (both "unused file"): `scripts/release/candidate-hash.mjs`
  and `scripts/release/repro-check.mjs`, two command-line tools no `package.json` script references (an earlier clean
  run predates their being added). No ignore rule was used. The fix is two lines in `package.json` (`"release:hash"`,
  `"release:repro"`); not applied, because it changes the frozen candidate.
- **Typecheck.** `tsc --noEmit` strict, clean on the frozen candidate; `tsconfig.json` unchanged; no `any`,
  `@ts-ignore` or `@ts-expect-error` added (the six `eslint-disable` comments in the tree all predate M12).
- **Lint and format.** `eslint .` (type-aware) and `prettier --check .` clean inside the formal `pnpm verify`. M12's new
  tooling is under `scripts/release/` (excluded from the type-aware lint like `realworld/tools/`, but formatted by
  Prettier); the specs and tests are linted like all others. Pre-freeze, the full lint found 11 errors in M12's own new
  code; all were fixed in the code, none suppressed.

## CHROMIUM (P28)

All of the following ran on the frozen candidate in Chrome 154: the full E2E (595 passed, 2 skipped), the M12 suites
(lifecycle 4, state 13, messaging 7, navigation 4, crash 3, ai-lifecycle 10, ui-a11y 8, upgrade 4, resource 4, plus the
soak) and the M10 suites (runtime, interaction, dynamic, security, ai-provider, dist, and spa with its known exception).
The M11 5/5 campaign stays historical evidence and was not repeated; the E2E ran once, in the candidate's final form,
`retries: 0`, `workers: 1`.

## FIREFOX (P29)

**Scope: functional certification of the Firefox 151 MV2 build installed as a temporary add-on; not production
certification as a store product, and not resource-certified.** Passed in Firefox on the candidate: clean install and
UI (lifecycle), four restarts on one profile, corruption (12 shapes), messaging and forged-message resistance, the CSP
(remote and LAN fetch, WebSocket, inline and remote script blocked), every navigation kind and tab lifecycle (discard
included), pending work vs closed or replaced documents, AI lifecycle (10 tests), UI accessibility in light and dark
(8 tests), crash recovery (kill, reload with pending work), and the M10 runtime, interaction, dynamic, spa,
security, ai-provider and dist suites. **Not verified in Firefox:** in-place upgrade, the MV3 worker lifecycle (not
applicable), a tab crash, CPU/heap/process measurements and the soak (geckodriver exposes none of them), a store
install. Known difference: an orphaned page keeps its stylesheet until reloaded.

## E2E (P28) and FINAL VERIFY (P30)

- **E2E (P28).** `pnpm test:e2e` on the frozen candidate, once, `retries: 0`, `workers: 1`: **595 passed, 2 skipped, exit 0,
  13.6 min**, the same counts as the baseline at `4c777c2` (the CSP and the other changes did not disturb any E2E).
- **Final verify (P30).** `pnpm verify` = `eslint .` + `tsc --noEmit` + `prettier --check .` + `vitest run` + `wxt build`
  - `audit:dist`. Attempt 1 on the frozen candidate (inside the formal sequence): **PASS**, exit 0, 321 s, **142 test
    files, 3385 tests** (baseline 135 / 3312; +7 files, +73 tests), both bundles audited, manifest parity ok. No other
    attempt was needed before the report. Attempt 2, on the tree that contains this report: **PASS**, exit 0, 142 test files, 3385 tests, both bundles audited, manifest parity ok (this one line was edited after attempt 2 had run, which Prettier checks and the candidate hash, which excludes Markdown, both tolerate).

## RELEASE ARTIFACTS (P32) and SHA-256

Generated by `pnpm zip` and `pnpm zip:firefox` on the frozen candidate (version 0.1.0). **Not published.**

| Artifact                                                           | Size (bytes) | SHA-256                                                            |
| ------------------------------------------------------------------ | ------------ | ------------------------------------------------------------------ |
| `dist/coloradapt-0.1.0-chrome.zip` (MV3)                           | 224,587      | `7e791b4bb73b38533dbb8e9506f62850c3dbcdc42fc84a040a1492a500d58309` |
| `dist/coloradapt-0.1.0-firefox.zip` (MV2)                          | 224,635      | `36073e190df4db979191496aa5ed95be686a53ff8126eb2d4efed5c2b056f616` |
| `dist/coloradapt-0.1.0-sources.zip` (store companion, not audited) | 2,102,943    | `7c1301dbac2deb44d479dc0194bd472caab6aa59b99d2c985db21ee073d21062` |

`dist/chrome-mv3`: 14 files, 674,312 bytes, manifest v3; `dist/firefox-mv2`: 14 files, 674,404 bytes, manifest v2;
extension version 0.1.0 in both. Build HEAD: the candidate is the uncommitted tree on `4c777c2`, identified by the
candidate hash above (the commit that contains it is the tagged milestone commit). **Reproducibility (P32):** two builds
and two packagings of the same tree produced identical folders (file by file, SHA-256) and identical archives, as bytes
and as contents, for both browsers; the archives have zeroed entry timestamps, so there is no archive metadata to
differ. Artifact audit: only `.js`, `.css`, `.html` and `manifest.json`; no source map or `sourceMappingURL`, test,
fixture, note, environment file, absolute host path, credential or file over 600 KB. **Source-map policy:** public
builds ship none, and the gate fails if one appears.

## SECRET SCAN (P33)

`pnpm scan:secrets` (`scripts/release/secret-scan.mjs`; ColorAdapt had no secret scanner before M12) over every tracked
and untracked-not-ignored file, every file of `dist/chrome-mv3` and `dist/firefox-mv2`, and every file inside
`coloradapt-0.1.0-chrome.zip` and `coloradapt-0.1.0-firefox.zip` (read in memory): rules for AWS keys, private-key blocks,
GitHub, Slack, Google and LLM-provider tokens, JWTs, assigned secrets, private-network endpoints, local user folders and
personal e-mail addresses. **627 files scanned.**

- **Shipped artifacts (both folders, both zips): 0 findings.** `src/` and `docs/`: 0 findings.
- **12 classified false positives**, all test files that plant fake canaries or LAN URLs on purpose (reviewed in
  `docs/m12/secret-scan-allowlist.json`, each with its reason).
- **1 unclassified finding: `realworld/m12/messaging.spec.ts:288`**, the LAN address 192.168.1.10 (port 8080), which the
  CSP test uses as the LAN destination that must be blocked. It is not a secret or a real endpoint. Rule
  `private-network-endpoint`. The allowlist entry that would classify it was not added, because the allowlist is part of the
  frozen candidate; **P33 is therefore not met** on the frozen candidate, for this administrative reason only.

## DEFECTS

| ID  | Defect                                                                                                                        | Found by                      | Status                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------- |
| D1  | an orphaned content script kept its stylesheet after an extension reload (Chrome)                                             | probe in real Chrome          | fixed (product change 1)      |
| D2  | audit page blank for an out-of-range `?tabId=`                                                                                | messaging suite (hostile URL) | fixed (9)                     |
| D4  | popup link buttons 3.62:1 in dark mode                                                                                        | UI accessibility suite        | fixed (10)                    |
| D6  | hostname-keyed overrides: `__proto__` key, host named `constructor`                                                           | security review               | fixed (6)                     |
| D7  | popup and options: "Loading…" forever and unhandled rejection when the background fails                                       | failure injection             | fixed (4)                     |
| D8  | a failing message handler left the sender's channel open                                                                      | code review of the router     | fixed (2)                     |
| D9  | settings writes were not parsed before storing                                                                                | security review               | fixed (5)                     |
| D10 | initial settings read had no `catch` in the content script                                                                    | failure injection             | fixed (3)                     |
| D5  | the cost of a pass grows with the rules in the sheet: seconds-long main-thread tasks above about 2,000 elements added at once | resource test                 | **open: known limit** (below) |

(D3 was a suspected stale-answer defect in the AI review that investigation showed to be consistent behavior; it is
recorded in `ai-lifecycle.spec.ts` as the assertion about the notice. There is no D3 to fix.)

## INCIDENTS

- **A wrong diagnosis, corrected.** When the first upgrade test failed I concluded the previous build's service worker
  was surviving the update. The real cause was that `dist/chrome-mv3` was stale (not rebuilt after a source change):
  the behavioral probe I had added caught it. After rebuilding, I tested the stale-worker idea on its own and it _is_ real
  for a kill-and-restart with a different build at the same extension id (m7 killed, candidate started: the m7 worker
  kept answering across three launches), so the upgrade suite uses the browser's unload and load in one session and
  proves which build runs. Cause of that behavior not established.
- **A test that measured the wrong thing.** The first idle-CPU reading of the extension-off control was 11 %: the
  browser was still starting. The measurement now waits for start-up. Not a product result; corrected before the freeze.
- **A runtime check that cannot work.** Checking that the History API is native fails in branded Chrome because its
  built-in Hangouts component extension wraps `history` in every page; replaced by the static bundle check.
- **Accidental repeats.** One `-g baseline` selected a whole file and re-ran 5 minutes of tests; several heredoc
  escapes were mangled and caught immediately. No effect on results.
- **Pre-freeze lint.** The first full type-aware lint found 9 errors, and the next full `verify` 2 more: 10 in the new
  tests and tooling, 1 in a React effect; all fixed properly (no suppression) before the freeze, which is why the formal
  `verify` passed first time.
- **Host.** Free memory 7.1 to 7.4 GB and no foreign browser or orphan process at any inventory; nothing needed a rerun.
  No formal step was rerun; there were no HOST_ENVIRONMENT_FAILURE or TEST_HARNESS_FAILURE during the formal sequence
  (one PRODUCT_FAILURE-class result, the carried M10 heap ratio, is reported as it is).

## KNOWN LIMITATIONS

1. **Firefox orphan.** After an extension reload or update an open page keeps its stylesheet until reloaded (Firefox
   destroys the old script without running it). Cosmetic; no functional hazard.
2. **D5, burst scalability.** One analysis pass costs more as the stylesheet grows (the browser matches
   attribute-value selectors against every tagged element on each style recalculation). Bounded and recovering, never
   a loop: 1,000 added elements 100 ms; 2,000 about 214 ms; 5,000 about 0.9 s; 10,000 about 3.9 s longest task and
   28 s until idle (Chrome 154, this host). Fixing it needs fewer rules than elements or index-friendly selectors: an
   engine change, outside M12 ("no new color algorithms"). **This is the main open item.**
3. **M10 SPA heap-ratio exception**, 1.1014 against 1.1, unchanged from M11.R1; the control shows warm-up.
4. **Per-site `adaptCharts`** is stored and ignored by the chart runtime; there is no UI for it; the global setting
   is the control. Unchanged (frozen M7 behavior); not fixed in M12 because changing it would switch charts off for
   every existing per-site profile.
5. **No schema version.** Fine today; the first rename or reinterpretation of a field must add one.
6. **Downgrade is unsupported** (read-compatible, not write-compatible).
7. **Upgrade** was exercised from frozen milestones, never from a published release, and only in Chrome.
8. **Harness limits.** Stale worker across kill-and-restart with another build; unpacked loading by DevTools; no
   Firefox resource measurements; one host, one version of each browser; the soak ran on Windows 11 only.
9. **Knip** had never been configured; the baseline carries 202 findings (unused exports and files), not fixed in M12.
10. **First-run behavior:** a new install changes nothing until a vision profile is chosen.

## M12 FINAL STATUS

**M12 = PARTIAL.** Outcome of every REQUIRED criterion of the frozen protocol on the frozen candidate:

| ID  | Criterion                                  | Outcome     | Note                                                                                                                                                        |
| --- | ------------------------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P01 | Baseline valid                             | PASS        | verify 135 / 3312, E2E 595 / 2 skipped, before any change                                                                                                   |
| P02 | Clean Chromium install                     | PASS        |                                                                                                                                                             |
| P03 | Clean Firefox install                      | PASS        | scoped: temporary add-on; store install is M13                                                                                                              |
| P04 | Browser restart recovery                   | PASS        | both browsers, four sessions                                                                                                                                |
| P05 | Extension reload recovery                  | PASS        | Chrome removes the orphan; Firefox keeps its stylesheet until reload (declared limit, not a pass condition)                                                 |
| P06 | MV3 worker restart                         | PASS        | Chrome; not applicable to Firefox MV2                                                                                                                       |
| P07 | Tab / navigation lifecycle                 | PASS        | both browsers                                                                                                                                               |
| P08 | SPA / dynamic churn                        | PASS        | with the declared M10 warm-up-ratio exception (1.1014 against 1.1), reported as it is                                                                       |
| P09 | Self-mutation bounded                      | PASS        | E2E, M10 dynamic, every soak sample                                                                                                                         |
| P10 | Storage corruption recovery                | PASS        |                                                                                                                                                             |
| P11 | Migration / upgrade                        | PASS        | Chrome, from m11 and m7; no migration mechanism needed (documented); Firefox upgrade not verified (disclosed)                                               |
| P12 | Downgrade disposition                      | PASS        | documented: unsupported, read-compatible only                                                                                                               |
| P13 | Permission surface frozen                  | PASS        |                                                                                                                                                             |
| P14 | CSP / remote-code review                   | PASS        | enforced by the browser, tested in both                                                                                                                     |
| P15 | Production artifact audit                  | PASS        |                                                                                                                                                             |
| P16 | Manifest parity                            | PASS        |                                                                                                                                                             |
| P17 | Network surface and privacy                | PASS        |                                                                                                                                                             |
| P18 | AI failure handling                        | PASS        |                                                                                                                                                             |
| P19 | AI stale-result protection                 | PASS        |                                                                                                                                                             |
| P20 | Crash recovery                             | PASS        | kill with writes in flight in both; worker and tab crash in Chrome                                                                                          |
| P21 | Messaging robustness                       | PASS        |                                                                                                                                                             |
| P22 | ColorAdapt UI accessibility                | PASS        | both browsers, light and dark                                                                                                                               |
| P23 | Site non-interference                      | PASS        | M10 interaction suite on the candidate, both browsers, plus E2E                                                                                             |
| P24 | Resource baseline and leak test            | PASS        | steady state 18.6 bytes per route change (budget 128); idle CPU 1.1 % off / 0.1 % on (budget 2 %)                                                           |
| P25 | Long soak                                  | **FAIL**    | all growth, error, queue and process budgets pass; **idle-CPU median 2.06 % against the frozen 2 %**; control: browser alone 2.06 %, with ColorAdapt 1.33 % |
| P26 | Security review                            | PASS        | 0 open findings; F1, F2, F3 found and addressed                                                                                                             |
| P27 | Dependency, Knip, type, lint, format gates | **FAIL**    | audit 0 vulnerabilities, strict tsc, eslint, prettier pass; **Knip: 2 new findings** (two unreferenced release scripts)                                     |
| P28 | Production Chromium certification          | PASS        |                                                                                                                                                             |
| P29 | Production Firefox evidence                | PASS        | scoped as functional certification (see FIREFOX); no resource or upgrade evidence                                                                           |
| P30 | Final canonical verify                     | PASS        | attempt 1 on the frozen candidate; attempt 2 on the final tree: see FINAL VERIFY                                                                            |
| P31 | Unsafe / security-critical failures = 0    | PASS        |                                                                                                                                                             |
| P32 | Release artifacts generated                | PASS        | byte-reproducible; hashes above                                                                                                                             |
| P33 | Secret scan = 0                            | **FAIL**    | artifacts, `src/`, `docs/`: 0; **1 unclassified false positive** (a test's blocked-LAN URL), see SECRET SCAN                                                |
| P34 | Tree clean                                 | **NOT MET** | by design: no commit on PARTIAL                                                                                                                             |

**Why PARTIAL and not FAIL.** Nothing in the FAIL list happened: no data corruption, crash loop, permission widening,
cross-page AI application, persistent mutation loop, security bypass, uninstallable package, destructive upgrade or
leak. **Why not PASS.** The owner's rule is that PASS needs every required frozen criterion, and two are not met; the
rule against retroactive criteria changes forbids raising the idle-CPU budget or dropping the Knip finding now that the
results are known.

## NEXT MILESTONE

No next milestone was started and nothing was remediated automatically. Decisions for the owner, in order of weight:

1. **P25.** Either (a) accept the attribution control (browser alone 2.06 %, with ColorAdapt 1.33 %, windows 0.15 to
   5.17 %) as discharging the idle-CPU item, which is an owner-approved amendment of a frozen criterion, or (b) authorize
   a re-run of the 120-minute soak with a budget relative to a same-host control (for example "median idle CPU with
   ColorAdapt no more than 1 percentage point above the extension-off control"), which needs the formal sequence from the
   top because the soak spec is part of the candidate.
2. **P27 and P33.** Add two script entries to `package.json` so Knip finds the two release tools, and one entry to
   `docs/m12/secret-scan-allowlist.json` for the blocked-LAN URL in `messaging.spec.ts` (both change the candidate). If (1b)
   is chosen, do all three in the same re-freeze, so one formal sequence closes everything.
3. **If both are accepted or fixed:** commit (`feat: harden and certify production readiness`), tag
   `m12-production-hardening`, still without pushing; then M13 (store release) is unblocked by M12.
4. **Independent of M12's status, the open engineering item** is D5, the burst scalability of the adaptation engine (rules
   grow with elements, and the cost of a pass with rules): a remediation milestone before store release, since a page that
   renders thousands of adaptable elements at once can stutter for seconds. Everything else in the known limits is
   either a browser constraint or a documented choice.

The uncommitted tree can be reviewed with `git status`; the candidate is reproducible with
`node scripts/release/candidate-hash.mjs` (expected `c55519a6b4b9099a5893e88480623dbc1bb742068baf78ee4437b28260489913`).
