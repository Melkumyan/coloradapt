# M12 — Production Hardening: certification protocol

**Status: FROZEN at the candidate below.** Written before any formal run. After the freeze nothing in this document
changes except the _Results_ column of the final report (`docs/m12/report.md`), which cites it.

## 1. Authority and scope

- Authorized by the owner: M11 PASS, M11.R1-E2E PASS, M11 FINAL PASS / FROZEN (commit `4c777c2`, tag
  `m11-ai-semantic-engine`, unpushed). M11 is not reopened unless M12 finds a regression caused by M11 behavior.
- `docs/ROADMAP.md` already defines M12 as "Production Hardening" and carries these items to it: the per-site
  `adaptCharts` setting the chart runtime does not consult, the slow heap growth of route changes, the SPA heap
  exception (1.1014 against 1.1), the extension `connect-src` pinned to loopback, Firefox full-extension parity,
  and residual animation-state items. The roadmap and the owner's prompt agree; there is no conflict to report.
- Non-goals (unchanged from the prompt): no new AI feature, accessibility mode, heuristic or color algorithm, no
  cloud, telemetry, account, payment or sync, no new browser target, no new host permission. No push, no store
  publication, no next milestone, no automatic remediation of a PARTIAL or FAIL.

## 2. Baseline (recorded before any change)

| Item                   | Value                                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| START HEAD             | `4c777c22b62cd26ecebd97216b7cbcdbac3c0325`                                                                                   |
| Tag at START HEAD      | `m11-ai-semantic-engine`                                                                                                     |
| Branch / tree          | `main` / clean                                                                                                               |
| Push / publish status  | nothing pushed, nothing published (`origin` is configured; no push was made by M12)                                          |
| Node / pnpm            | v22.17.1 / 11.9.0                                                                                                            |
| WXT / TypeScript       | 0.21.4 / 5.9.3                                                                                                               |
| Playwright / Vitest    | 1.63.0 / 5.0.3                                                                                                               |
| Browsers               | Chrome 154.0.8037.98 (branded, headless=new); Firefox 151.0.3 with geckodriver 0.37.1                                        |
| Host                   | Windows 11 (10.0.26300), 12th Gen Intel Core i5-12500H, 15.7 GB RAM                                                          |
| Baseline `pnpm verify` | PASS: 135 test files, 3312 tests, build. Log: `E:\temp\claude\m12\baseline-verify.log`                                       |
| Baseline E2E           | PASS: `pnpm test:e2e` 595 passed, 2 skipped, 13.7 min, `retries: 0`, `workers: 1`. Host clean (0 user browsers, 7.4 GB free) |

## 3. The certification candidate

The candidate is the working tree at the freeze, identified by `node scripts/release/candidate-hash.mjs` (SHA-256 over
the path and content of every tracked or untracked, non-ignored file except Markdown and run artifacts).

```
CANDIDATE HASH   c55519a6b4b9099a5893e88480623dbc1bb742068baf78ee4437b28260489913
FILES            543
FROZEN AT        2026-10-07T07:54Z (UTC), on START HEAD 4c777c2 with the uncommitted M12 working tree
```

The hash is checked before and after every formal run; a run on a different hash is not evidence. A defect found by a
formal run is reported, not silently fixed: fixing it changes the candidate, which voids every earlier formal result
and starts the formal sequence again from the top, with the finding and the change recorded in the report.

## 4. Matrices

**Browsers.** Chromium-family: branded Chrome 154, production build `dist/chrome-mv3` (MV3, service worker), run
headless-new, extension loaded with the DevTools `Extensions.loadUnpacked` (branded Chrome ignores `--load-extension`).
Firefox 151, production build `dist/firefox-mv2` (MV2, persistent background page), installed as a temporary add-on
through geckodriver. A signed, store-installed extension is out of scope (M13).

**Packages.** `coloradapt-0.1.0-chrome.zip`, `coloradapt-0.1.0-firefox.zip` (`wxt zip`, `wxt zip -b firefox`) and the
unpacked `dist/chrome-mv3` and `dist/firefox-mv2` they are made from. The `-sources.zip` Firefox store companion is
generated and recorded, not audited as a product artifact.

**Upgrade sources.** ColorAdapt has never been published, so there is no public previous release. The previous builds
are the frozen milestones, built from git worktrees: `m11-ai-semantic-engine` (the predecessor; built as version
0.0.9 so that the browser sees a version change) and `m7-charts` (the oldest settings shape in the range:
before audit, AI settings; built as 0.0.8). Upgrade is certified in Chrome only: Firefox's temporary add-on cannot be
updated in place by the harness.

## 5. Required criteria

Every criterion is REQUIRED unless marked otherwise. A criterion passes only if every named piece of evidence passes
on the frozen candidate.

| ID  | Criterion                                  | Evidence (all on the frozen candidate)                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P01 | Baseline valid                             | §2: `pnpm verify` and the Chromium E2E at START HEAD passed before any change.                                                                                                                                                                                                         |
| P02 | Clean Chromium install                     | `realworld/m12/lifecycle.spec.ts` "P02/P03" in Chrome: fresh profile, manifest surface, background answers, defaults valid, popup and options render without fatal log, first adaptation, no request but the page's own.                                                               |
| P03 | Clean Firefox install                      | Same spec in Firefox (temporary add-on). Disposition: certified as a clean temporary-add-on install; signed-store install is M13.                                                                                                                                                      |
| P04 | Browser restart recovery                   | `state.spec.ts` "P04": four sessions on one profile, settings identical, one stylesheet, one observer, identical rule count and color every time, in both browsers.                                                                                                                    |
| P05 | Extension reload recovery                  | `lifecycle.spec.ts` "P05": Chrome removes the orphan's stylesheet; five consecutive reloads leave one instance. Firefox: the orphan's stylesheet staying is a documented browser limit (§8), not a pass condition.                                                                     |
| P06 | MV3 service-worker restart                 | `lifecycle.spec.ts` "P06" and `crash.spec.ts`, Chrome: the worker is stopped by the browser's own `ServiceWorker.stopWorker` five times plus once with messages in flight; every message is answered; nothing depends on worker memory. Firefox: not applicable (MV2).                 |
| P07 | Tab and navigation lifecycle               | `navigation.spec.ts`, both browsers: push, replace, pop, back, forward, hash, same-origin, cross-origin; duplicate, discard and restore, background; work pending when the tab closes or the document is replaced.                                                                     |
| P08 | SPA / dynamic DOM churn                    | `navigation.spec.ts` P08 (nodes removed between detection and adaptation), `resource.spec.ts` (5,000 route changes against a control), the soak, and `realworld/dynamic.spec.ts` + `realworld/spa.spec.ts` (M10).                                                                      |
| P09 | Self-mutation bounded                      | The E2E campaign (M4/M6 self-mutation suites, unchanged), `realworld/dynamic.spec.ts`, and the soak (`selfMutationsIgnored` grows, queues empty at every sample, no loop).                                                                                                             |
| P10 | Storage corruption recovery                | `tests/infrastructure/storage/storage-corruption.test.ts` (unit) and `state.spec.ts` "P10" (12 malformed shapes in both browsers).                                                                                                                                                     |
| P11 | Migration / upgrade                        | `upgrade.spec.ts`, Chrome, from both previous builds, and over invalid state. There is no schema version and no migration code: §9 documents why none is needed. Firefox upgrade: NOT VERIFIED (disclosed).                                                                            |
| P12 | Downgrade disposition                      | `upgrade.spec.ts` "P12" documents what happens; the disposition is "unsupported, read-compatible only" (§9). Nothing claims rollback support.                                                                                                                                          |
| P13 | Permission surface frozen                  | `docs/m12/permission-surface.json` golden, enforced by `pnpm audit:dist` (part of `pnpm verify`) and its unit tests: widening of permissions, host permissions, content-script matches, web-accessible resources, CSP fails.                                                           |
| P14 | CSP / remote-code review                   | `audit-dist` (no `eval`, `new Function`, remote import/script, `importScripts`, inline script or handler), `realworld/dist.spec.ts`, and `messaging.spec.ts` "P14/P17": the browser blocks remote fetch, LAN fetch, remote WebSocket, inline and remote script on extension pages.     |
| P15 | Production artifact audit                  | `audit-dist`: only `.js .css .html .json`, no source maps, tests, fixtures, notes, env files, absolute host paths, credentials, files over 600 KB; both zips read and scanned.                                                                                                         |
| P16 | Manifest parity                            | `audit-dist` parity check: the two manifests differ only in manifest version, where host patterns are listed, the background form, the action key and the Firefox add-on id; same CSP, matches, name, version.                                                                         |
| P17 | Network surface and privacy                | `audit-dist` (network literals on an allowlist; the three `fetch` sites), no unexpected request in `lifecycle.spec.ts`, `realworld/security.spec.ts` (M10 privacy), local diagnostics carry names and codes only (unit), one persisted key and no page text in storage after the soak. |
| P18 | AI failure handling                        | `ai-lifecycle.spec.ts`, both browsers: engine down, hung, garbage / empty / off-schema / 2 MB output, many regions, cancelled, adaptation independent of the AI.                                                                                                                       |
| P19 | AI stale-result protection                 | `ai-lifecycle.spec.ts` "P19": an answer for document A is not shown for document B (reload with other content, other route); unit tests of M11 binding unchanged.                                                                                                                      |
| P20 | Crash recovery                             | `crash.spec.ts`: browser killed with writes in flight and a page waiting (both browsers), extension reload with work pending (both), worker stopped with messages in flight and a tab crash (Chrome).                                                                                  |
| P21 | Internal messaging robustness              | `messaging.spec.ts` P21, both browsers; `router.test.ts`; `settings-failure.test.tsx`.                                                                                                                                                                                                 |
| P22 | ColorAdapt UI accessibility                | `ui-a11y.spec.ts`, both browsers, light and dark: names, roles, keyboard path, visible focus, no trap, WCAG AA text contrast, 200 % and 400 % reflow; focus kept on a live update.                                                                                                     |
| P23 | Site non-interference                      | `realworld/interaction.spec.ts` (M10: a scripted real-input session identical with ColorAdapt off and on; disabled controls; pointer events) plus the E2E campaign.                                                                                                                    |
| P24 | Resource baseline and leak test            | `resource.spec.ts` (Chrome): steady state after warm-up, extension on and off, 5,000 route changes; baseline on/off; idle CPU.                                                                                                                                                         |
| P25 | Long soak                                  | `soak.spec.ts`, Chrome, **120 minutes**, §6 budgets, no retry; idle CPU by the relative control `idle-cpu.spec.ts` (§6, M12.R1 amendment §11).                                                                                                                                         |
| P26 | Security review                            | `docs/m12/security-review.md` (static review of every injection sink, message surface, URL and privilege) plus the runtime evidence it cites; 0 unresolved findings of severity high or critical.                                                                                      |
| P27 | Dependency, Knip, type, lint, format gates | `pnpm audit` (0 known vulnerabilities); Knip: **new findings = 0** against the m11 baseline (`scripts/release/knip-diff.mjs`; Knip had never been configured, defaults, 202 baseline findings); `tsc` strict; `eslint`; `prettier`.                                                    |
| P28 | Production Chromium certification          | One complete real-browser campaign after the freeze: `pnpm test:e2e` (the E2E build) and the M12 and M10 production-build suites in Chrome.                                                                                                                                            |
| P29 | Production Firefox evidence                | The M12 suites and the M10 runtime, dynamic, interaction, security and AI-provider suites in Firefox 151. Scope statement in §8; no claim of production support beyond what ran.                                                                                                       |
| P30 | Final canonical verify                     | `pnpm verify` (lint, typecheck, format, test, build, `audit:dist`) on the final tree, all attempts recorded.                                                                                                                                                                           |
| P31 | Unsafe or security-critical failures = 0   | No finding of the security review, no sink, no widened surface, no cross-document application, no persistent corruption in any formal result.                                                                                                                                          |
| P32 | Release artifacts                          | Both zips and both folders generated; size, SHA-256, manifest version, extension version and build HEAD recorded; `repro-check`: folders and zip contents identical across two builds.                                                                                                 |
| P33 | Secret scan = 0                            | `pnpm scan:secrets` over tracked files, both folders and both zips; only the reviewed fixture allowlist (`docs/m12/secret-scan-allowlist.json`) is classified.                                                                                                                         |
| P34 | Tree clean                                 | `git status` clean after the milestone commit; nothing pushed.                                                                                                                                                                                                                         |

## 6. Frozen budgets and rules

These numbers were fixed here, before the formal runs. Where a number was chosen after an exploratory measurement, the
measurement is named so a reader can judge the choice.

**Soak (P25).** `M12_SOAK_MINUTES=120`, one sample per 60 s, no retry, no restart. Warm-up: the first 15 % of samples
are excluded from trends. Hard conditions, always: the browser stays up; zero errors from ColorAdapt or the page
(extension-world exceptions, `pageerror`); at every sample the pipeline queues are empty after quiescence
(`queuedRecords`, `deferredRoots`, `pendingLinks` 0, no pending rescan, no throttle timer), no duplicate stylesheet or
id, no queue overflow, tracked elements never above existing nodes; the only persisted key is `coloradapt:settings`,
under 4 KB, with no page text; after close, no process of the browser's tree is left. Trends (median of the last fifth
against the first fifth after warm-up, and the robust Theil-Sen slope per hour relative to the median):

| Series                                   | Budget                                        |
| ---------------------------------------- | --------------------------------------------- |
| JS heap after forced GC (long-lived tab) | ratio <= 1.15 **and** slope <= 10 % per hour  |
| DOM nodes after quiescence               | not (ratio > 1.10 **and** growth > 200 nodes) |
| JS event listeners                       | not (ratio > 1.10 **and** growth > 50)        |
| Browser process-tree working set         | ratio <= 1.25 **and** slope <= 15 % per hour  |
| Extension renderer processes working set | ratio <= 1.25                                 |
| Idle CPU of the browser tree (median)    | reported only; see the relative control below |

The workload is `realworld/m12/soak-kit.ts` (cycle of 20 route changes, 500-node churn with 300 mutations, SVG
updates, virtualized-list replacement, 10 modals, a 300-item feed, form-validity events), with adaptation off/on every
3rd cycle, a settings change every 4th, an audit run every 5th, a second tab opened and closed every 6th, an
AI-assisted review against a loopback mock every 8th, a worker stop every 10th, and a fresh document in a second tab
every 2nd cycle. A pre-freeze 4-minute smoke run (not a result) showed the harness works and that DOM nodes rise
while the 300-item feed fills (~8 cycles), which the warm-up covers.

**SPA route changes (P24).** After a warm-up of 2,000 route changes, with the extension on, the post-GC heap grows by
at most **128 bytes per route change** over route changes 2,000 to 5,000, and the part attributable to the extension
(on minus an extension-off control of the same page) is also at most 128; DOM nodes grow by at most 3 and listeners by
at most 2; the growth per route change after 2,000 is below the growth per route change between 500 and 1,500.
_Provenance of the 128:_ pre-freeze measurements (two runs) showed 26.2 and about 29 bytes per route change with the
extension on and 0.8 off; 128 was chosen as roughly 4.5 times the measured value, so that a regression to about 1 KB
per route change (about 10 MB per 10,000 route changes) fails and ordinary noise does not.

**Idle CPU (P24).** A browser that has finished starting (25 s settle) and then idles for 15 s on an adapted page uses
at most 2 % of one core, with the extension off and on (the first attempt measured right after start-up and read 11 %
for the extension-off control; that was a measurement error, corrected before the freeze).

**Mutation bursts (P24).** Up to 1,000 new adaptable elements added to a page at once: longest main-thread task at
most 200 ms (the existing M10 `longTaskMs`). For 2,000, 5,000 and 10,000: no budget; recorded, and every size must end
idle with empty queues and no overflow. This is a known limit (§8).

**M10 budgets** (`realworld/budgets.ts`) apply unchanged to the M10 suites re-run as regression evidence.

**Idle CPU, relative control (P24/P25; replaces the absolute "<= 2 %" of the first freeze, see §11).** The criterion is
the load ColorAdapt adds: `median(extension on) - median(extension off)` of whole-browser-tree idle CPU, percent of one
core, **at most 1.0 percentage point**. Method: OFF control first, ON candidate second, once, no retry, in
`realworld/m12/idle-cpu.spec.ts`, run immediately before the soak in the formal sequence. Identical in both runs:
measurement window (30 s settle after the page is ready, then 30 windows of 10 s, one every 30 s), browser
configuration (`startChrome()`, one tab, the same 1,500-paragraph page; the only difference is whether the extension
is loaded and adapting), sampling method (CPU time of the browser's process tree from Windows, divided by wall time),
host state (no other browser process before either run, checked). The soak's own idle windows and the resource
spec's are recorded for information only. _Provenance of the 1.0:_ fixed here, before the freeze and before any run of
the new spec, from the M12 control only (off 2.06 %, on 1.33 %; individual 10 s windows 0.15 to 5.17 %): the
extension and the browser alone differed by 0.73 points in the extension's favour, i.e. run-to-run noise of the
median is of that order, so a smaller threshold would fail a clean extension by chance; a larger one would let a
persistent idle cost through (1 % of a core is visible in profilers and on battery). It will not be tuned after a result.

## 7. Failure-injection set (frozen)

| Injected failure                                 | Where                                                                                            | Defined end state                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Storage read failure                             | `storage-corruption.test.ts`, `router.test.ts`, `settings-failure.test.tsx`                      | read rejects; the router answers `undefined`; popup/options show an alert; the content script leaves the page unadapted |
| Storage write failure                            | `storage-corruption.test.ts`                                                                     | nothing is stored; the store keeps the previous value; the popup does not act as if it had been stored                  |
| Corrupt / partial / future / wrong-type state    | unit + `state.spec.ts` (12 shapes)                                                               | valid settings, recoverable fields kept, opt-in layers at their defaults, never a remote AI endpoint                    |
| Background restart (worker stop)                 | `lifecycle.spec.ts`, `crash.spec.ts`, `upgrade.spec.ts`                                          | the next message wakes a fresh worker; no state lost                                                                    |
| Content script disconnect (orphan)               | `lifecycle.spec.ts`, `messaging.spec.ts`                                                         | Chrome: stylesheet removed within the 5 s check; a stale port ends the audit session                                    |
| Browser API rejects                              | `router.test.ts`, `settings-failure.test.tsx`, `messaging.spec.ts` (closed tab, absent receiver) | clean rejection, no hang, no unhandled promise                                                                          |
| AI failure / slow / hung / invalid / huge output | `ai-lifecycle.spec.ts`                                                                           | UNRESOLVED or unavailable; nothing accepted; page and adaptation unaffected                                             |
| DOM node disappears                              | `navigation.spec.ts` P08                                                                         | no error, no stale rule, queues drain                                                                                   |
| Browser killed with writes in flight             | `crash.spec.ts`                                                                                  | restart with valid settings and a working extension                                                                     |
| Hostile or malformed URL parameters              | `messaging.spec.ts` P53, `storage-corruption.test.ts`                                            | the page says it needs the popup; endpoints fall back to the loopback default                                           |

## 8. Known limits declared at the freeze (not hidden, not pass conditions)

1. **Firefox orphan.** After an extension reload or update, Firefox destroys the old content script and does not run
   code in it, so the stylesheet it injected stays until the tab is reloaded. Chrome removes it.
2. **Burst scalability.** The cost of one analysis pass grows with the number of rules already in the stylesheet (the
   browser matches attribute-value selectors against every tagged element on each style recalculation). Adding
   thousands of adaptable elements at once is slow but bounded, always ends idle, and never loops. Measured longest
   task: 90 ms at 1,000 added elements, 213 to 231 ms at 2,000, 878 to 979 ms at 5,000, 3.5 to 3.8 s at 10,000
   (pre-freeze, Chrome 154). Fixing it means changing how rules are emitted: an engine change, outside M12.
3. **M10 SPA heap ratio.** `realworld/spa.spec.ts` "500 route changes" compares the heap after 50 and after 500 route
   changes and still reads about 1.1014 against its 1.1 budget (1.1015 at M11.R1). The control run shows that the
   comparison measures warm-up, not growth (extension off: 1.028; steady state with the extension on: 26 bytes per
   route change). The M10 spec is kept unchanged and its result reported as it is; M12's own steady-state criterion
   (§6) is the leak verdict.
4. **Per-site `adaptCharts`.** The stored per-site value is not consulted by the chart runtime and has no UI. Unchanged
   (frozen M7 behavior); the global setting is the control.
5. **No schema version.** The settings parser is field-by-field and lenient; there is no migration code because no
   previous public state exists and old shapes are read by defaulting (§9 of the report).
6. **Harness: stale service worker.** A Chrome killed and restarted with a _different_ build at the same extension id
   kept answering from the previous build's worker (reproduced; cause not established). Upgrade tests therefore use the
   browser's unload and load in one session and prove which build runs. Real store updates cannot be run offline.
7. **Firefox resource evidence.** CPU, heap and process measurements go through Chrome DevTools and the Windows process
   tree; Firefox has none of them through geckodriver. Firefox gets functional certification, not a soak.
8. **Host.** One host, one Chrome version, one Firefox version. User browsers: none were running at the baseline; the
   historical M11.R1 failures stay "consistent with host-load/browser interference, root cause not proven".

## 9. Formal run procedure

All steps sequential, one heavy job at a time, `retries: 0`, `workers: 1`, no change to Playwright retries, workers or
timeouts, no edit of the tree during a run. Before and after the whole sequence: process inventory (user browsers,
orphan browsers, geckodriver, Ollama) and free memory.

1. Host inventory and candidate hash.
2. `pnpm verify` (lint, typecheck, format check, test, build, `audit:dist`).
3. `pnpm build:firefox`, `pnpm zip`, `pnpm zip:firefox`, `node scripts/release/audit-dist.mjs --require chrome-mv3,firefox-mv2`, `node scripts/release/repro-check.mjs --zip`.
4. M12 suites, both browsers: `lifecycle`, `state`, `upgrade` (Chrome), `messaging`, `navigation`, `crash`, `ai-lifecycle`, `ui-a11y`, `resource` (Chrome).
5. M10 regression suites, both browsers: `runtime`, `interaction`, `dynamic`, `spa`, `security`, `ai-provider`, `dist`.
6. `pnpm test:e2e` (the full Chromium E2E).
7. The 120-minute soak (Chrome).
8. Candidate hash again (must equal §3); host inventory again.
9. Report, then the final `pnpm verify` on the final tree, then the secret scan, Knip diff, dependency audit.

**Classification.** Every failure is classified `PRODUCT_FAILURE`, `TEST_HARNESS_FAILURE` or `HOST_ENVIRONMENT_FAILURE`
with the evidence. A product failure is never rerun to make it pass: it is a result. A harness or host failure that
aborts a step before a usable verdict may be rerun once, once, and both attempts are disclosed. A step that failed
because of a defect in the test (not the product) is corrected in the test, which changes the candidate (§3).

## 10. Verdict rules (from the owner's prompt)

- **PASS** only if every REQUIRED criterion passes: no unresolved production-blocking defect or security-critical
  behavior; clean install, restart and reload recovery work; upgrade safe; storage corruption handled; permissions
  controlled; production builds valid; real Chromium certification passes; Firefox honestly certified or explicitly
  scoped; resource behavior bounded; soak passes; AI fails safely; canonical verify passes; secret scan clean.
- **PARTIAL** when the product is broadly acceptable but a required certification area is not established (for example
  a soak that did not complete, an unverified upgrade, Firefox real-browser execution unavailable).
- **FAIL** for an unresolved data-corruption, crash-loop, permission-widening, cross-page AI application, persistent
  mutation loop, security bypass, uninstallable package, destructive upgrade or major leak. Stop after documenting.
- Tag `m12-production-hardening` only on PASS. Never push. Then stop.

## 11. M12.R1 amendment (formal closeout; second freeze)

The first formal sequence (candidate `c55519a6…9913`) ended PARTIAL on three frozen criteria. The owner ordered a
closeout that changes only those three and documents one limitation; no feature, no algorithm, no adaptation-engine
change. This amendment was written and the changes made before the second freeze, and the first candidate's PASS results
are not inherited: the whole §9 sequence is run again on the new candidate.

1. **P25.** The absolute idle-CPU limit is replaced by the relative control of §6 (threshold 1.0 percentage point,
   fixed before any run). Reason: the first run's own control put the limit inside the host's noise floor. The soak's
   growth, error, queue and process budgets are unchanged.
2. **P27.** `scripts/release/candidate-hash.mjs` and `repro-check.mjs` get documented `package.json` entry points
   (`pnpm release:hash`, `pnpm release:repro`), which are their real invocations (`docs/DEVELOPMENT.md`). Criterion unchanged:
   new Knip findings against the m11 baseline = 0.
3. **P33.** One narrow allowlist entry: file `realworld/m12/messaging.spec.ts`, rule `private-network-endpoint`, exact
   host 192.168.1.10 (a hostile-LAN probe the CSP test proves is blocked). The scanner now supports an exact-host
   `match` per entry; RFC 1918 addresses are not excluded anywhere else. Required: shipped artifacts 0, `src/` 0,
   `docs/` 0, unclassified tests 0.
4. **Documentation.** The burst-scalability limitation is registered in `docs/PERFORMANCE.md` and as milestone M12.5
   (before the M13 Store release candidate); it is open debt, not an M12 criterion.
5. **Sequence.** §9 with one added step before the soak: `realworld/m12/idle-cpu.spec.ts` (OFF then ON). After the freeze:
   no code, test, document or threshold edit, no retry after a failure; any change voids the sequence. The candidate hash
   excludes Markdown; the only writes after the freeze are the freeze record above and the results written into
   `docs/m12/report.md` (R1 section) and the status lines of `docs/ROADMAP.md`, after the last run.
6. **Open debt, never mixed with the criteria:** burst scalability, the M10 SPA warm-up ratio, Firefox limitations, the
   upstream scientific status (M2 PARTIAL).

**M12.R1 freeze record.**

```
CANDIDATE HASH   3ebdf2345bfef65cb0e9f8e61767ed324e8646d3950a1bb38185496c78c91a11
FILES            544
FROZEN AT        2026-10-07 (UTC), on START HEAD 4c777c2 with the uncommitted M12 + M12.R1 working tree
PRE-FREEZE GATES format, lint, typecheck, pnpm verify (142 files, 3385 tests, build, audit:dist) PASS;
                 Knip new findings 0; secret scan 0 findings (13 classified); idle-CPU threshold 1.0 pp
```

## 12. M12.R1-P04 amendment (failure-evidence harness; third freeze)

The second formal sequence (candidate `3ebdf234…1a11`) ended PARTIAL on one criterion: P04 on Firefox failed in a
restart round with `driver.getSettings()` rejecting "An unexpected error occurred", an extension-side rejection
(`storage.local.get` in the extension page) whose real cause was not recorded. A diagnostic phase of 72 instrumented
rounds and three unmodified runs did not reproduce it; the root cause is **UNKNOWN** and is not relabelled.

This amendment changes **test infrastructure only**: no product file, storage semantic, settings model, extension
lifecycle, timeout, retry count, assertion or P04 acceptance criterion. The first future failure must be diagnosable.

- `realworld/lib/evidence.ts` (recorder, sanitizer, raw-error capture, process and profile snapshots) and
  `realworld/m12/p04-evidence.ts` (what is collected on failure); `FirefoxDriver` takes an optional `evidence`
  recorder; `state.spec.ts` P04 creates one for Firefox. Artifacts: `realworld/.artifacts/m12-p04/<run>/` with
  `run.json`, per round `metadata.json`, `timeline.jsonl` (correlated timestamps: geckodriver spawn, session, add-on,
  every WebDriver command's route and outcome, each recorded operation, session delete, process kill),
  `firefox.log` (geckodriver trace plus the browser's stdout/stderr, which geckodriver forwards on the same pipe;
  Firefox's own console is routed there by two evidence-only prefs, `devtools.console.stdout.content` and
  `.chrome`), `geckodriver.log` (geckodriver's stderr), `bidi.log` (every WebDriver BiDi `log.entryAdded`, all levels),
  `process.json` (process tree before close, and on failure) and, only on failure, `failure.json`.
- `getSettings`/`setSettings` are recorded as named operations (`storage.local.get`/`set`): start and finish times,
  round, session, extension id, outcome, the **raw** value the extension page rejected with (type, name, message,
  stack, code, cause, own primitive properties, JSON and string forms; nothing is invented when the browser gives only
  a message) and, for success, value presence and type only. Settings values are never written by the harness.
- On a failure the original error is rethrown unchanged and stays primary. Collected afterwards, each probe isolated and
  none retried: WebDriver health, extension id and manifest, background response (`GET_SETTINGS`, presence and type
  only), an independent read of the storage keys (names and types only), process tree, profile state. A probe failure
  is secondary evidence. `failure.json` has `classification: UNCLASSIFIED`; no root cause is recorded automatically.
- Text from the browser or a page is data (JSON-escaped, control characters made visible, credential-looking text
  redacted, size-capped). The harness is test-side only; `tests/release/p04-evidence.test.ts` pins this, including
  that no source file under `src/` and no built extension contains it. No manifest permission changed.
- Not a gate: a single Firefox P04 run and a self-check that provokes a real extension-side rejection
  (`realworld/m12/p04-evidence.spec.ts`, not in the formal sequence) were run once to prove the harness does not
  break a normal run and does record a failure. P04 was not run repeatedly.
- **Sequence.** §9 and §11 unchanged, run once, from the top, on the new candidate, no retry, no edit after the
  freeze. P11 is not started unless `M12_PREVIOUS_DIR` is set and the previous builds exist (a preflight, recorded).
  If P04 fails again the sequence stops as PARTIAL and the captured evidence is reported before any classification.

**M12.R1-P04 freeze record.**

```
CANDIDATE HASH   dede5512ccad1d676b46f127b28a05a71e63bc48265cb537f3f3e33481beed9b
FILES            548
FROZEN AT        2026-10-07 (UTC), on START HEAD 4c777c2 with the uncommitted M12 + M12.R1 + P04-harness working tree
PRE-FREEZE GATES lint, typecheck, format, pnpm verify (143 files, 3403 tests, build, audit:dist) PASS;
                 Knip new findings 0; secret scan 0 findings (13 classified); dist/chrome-mv3 and dist/firefox-mv2
                 contain no evidence-harness marker; Firefox P04 single validation run PASS (not a gate);
                 failure-path self-check in real Firefox PASS (not a gate)
```

## 13. M12.R1-P04 storage-readiness amendment (fourth freeze)

The third formal sequence (candidate `dede5512…ed9b`, evidence harness) stopped as PARTIAL when P04 failed again in Firefox
restart round 3. The captured evidence, and the root-cause experiments that followed (outside the repository, no project
change during them), established:

- **Mechanism (Firefox 151.0.3 source, `dom/quota/ActorsParent.cpp`, `dom/indexedDB/ActorsParent.cpp`,
  `ExtensionStorageIDB.sys.mjs`).** The extension API reports "An unexpected error occurred" for any storage error that is
  not a quota or data-clone error (`normalizeStorageError`); the underlying error goes to the browser console only. The
  console (read through a chrome-context `nsIConsoleService` listener, diagnostic runs only) showed two forms of one
  failure: (a) QuotaManager `NS_ERROR_FILE_IS_LOCKED` (Windows sharing violation) while renaming `.metadata-v2-tmp` to
  `.metadata-v2` during the first initialization of the extension's origin, retried by Firefox and surfacing as
  `IndexedDB UnknownErr` then `UnknownError` in `ExtensionStorageIDB`; (b) `BEGIN IMMEDIATE` returning
  `NS_ERROR_STORAGE_BUSY`, which IndexedDB retries for up to 10 s (`DatabaseConnection::BeginWriteTransaction`), which is
  the 10.9 s stall of the formal failure, then the same error chain. Every failure observed in the experiments carried
  the file-lock error.
- **Frequency on this host.** 8 of 27 first writes on a fresh profile and 2 of 78 first reads after a restart were
  refused; 8 of 8 runs and 4 of 4 runs of the earlier formal context did not reproduce it. After a refusal the next
  access succeeded at once, and the data was intact where it had been written.
- **Who holds the lock is not established.** Windows Restart Manager sampling showed no process other than Firefox ever
  holding the files, and a Firefox-free create-write-close-rename loop (20,000 cycles, the same step) produced no
  failure, although every file operation on this host costs about 60 ms. Antivirus (Kaspersky is installed) is a
  hypothesis, not a finding. Classification: the mechanism is `FIREFOX_STORAGE_STARTUP_RACE`-class at the browser's
  storage layer with HIGH confidence; the external cause is UNKNOWN (host file locking suspected).
- **Product behavior is already safe.** A refused read rejects; the router answers `undefined`; the popup and options
  show an alert; the content script leaves the page unadapted; nothing is written (section 7, and
  `storage-corruption.test.ts`, `router.test.ts`, `settings-failure.test.tsx`). Product code is unchanged by this
  amendment. Not done, and recorded as debt: a product-side recovery after a refused first read.
- **Fix class: HARNESS_READINESS_FIX.** `realworld/lib/readiness.ts` and `FirefoxDriver.awaitStorageReady()`: before the
  P04 assertions of each restart round the test establishes that the storage backend has answered one read of the settings
  key. Bounded (at most 6 attempts, no new attempt after 90 s, 1 s between attempts, cancelled when the browser closes);
  every attempt is recorded in the evidence timeline and reported as a test annotation when more than one was needed;
  exhausting it fails the test with the last error as the cause. No sleep is a pass condition. The assertions
  (`getSettings()` once, expected values, one stylesheet, one observer, identical rule count and colour every round) are
  unchanged: persistence is still proven by the data read after readiness. Policy unit tests:
  `tests/release/readiness.test.ts` (transient recovered and reported, permanent bounded, budget, cancellation).
- `M12_P04_ROUNDS` (default 4, the protocol) lets the stress validation run 10 restarts per sequence.
- **Pre-freeze validation (not gates):** P04 Firefox x20 and 10 sequences x 10 restarts, each required to pass without
  an internal retry beyond the readiness precondition, with the attempt counts reported.
- **Sequence.** §9 and §11 unchanged, run once from the top on the new candidate; P11 only with `M12_PREVIOUS_DIR` set and
  the previous builds present; the P04 evidence harness stays active.

**M12.R1-P04 storage-readiness freeze record.**

```
CANDIDATE HASH   669548fcc158d88c7331f80d9be9c413ded4949e777145cd317e192dccabb48d
FILES            550
FROZEN AT        2026-10-08 (UTC), on START HEAD 4c777c2 with the uncommitted M12 + M12.R1 + P04 harness + readiness working tree
PRE-FREEZE GATES lint, typecheck, format, pnpm verify (144 files, 3410 tests, build, audit:dist) PASS; Knip new findings 0;
                 secret scan 0 findings (13 classified); no harness or readiness marker in either production bundle;
                 P04 Firefox x20: 20/20 PASS; stress 10 sequences x 10 restarts: 10/10 PASS (180 restart rounds, 1 needed a
                 second readiness attempt: a 10.98 s refusal with the formal failure's signature, ready 19 ms later, data and
                 assertions intact); a final single P04 run after the last lint-only edit PASS.
                 Not run before the freeze: the other Firefox M12/M10 suites (the driver change since their last formal pass
                 is the new awaitStorageReady method and an evidence-only path; they run in the sequence).
```
