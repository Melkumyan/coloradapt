# Real-world validation (M10)

> Findings closeout (M10.R1): `docs/REAL_WORLD_FINDINGS_CLOSEOUT.md`. The oracle described there replaces the
> one this document's baseline numbers were measured with.

Proof that ColorAdapt works in the two real browsers it ships for, on the live web and on hostile local
fixtures. It is a harness plus its recorded results; it changes no product behaviour. The only product change is
in `wxt.config.ts` (see "Firefox manifest").

Run it with `pnpm build && pnpm build:firefox && pnpm test:realworld`. It is **not** part of `pnpm test:e2e` or
`pnpm verify`: it needs the installed Chrome and a Firefox binary, depends on the network, and takes about two
hours. Its pure logic (the colour oracle, source integrity) is covered by `tests/realworld/` and does run in
`pnpm verify`.

## Environment

|                 |                                                                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chrome          | installed branded Chrome 154, started headless; the extension is loaded with the DevTools `Extensions.loadUnpacked` call (branded Chrome ignores `--load-extension`) and driven through Playwright `connectOverCDP` |
| Firefox         | Firefox 151.0.3 through geckodriver (fetched by `realworld/tools/fetch-geckodriver.mjs` into the git-ignored `realworld/.tools/`), temporary add-on install, fixed extension UUID                                   |
| Firefox build   | `dist/firefox-mv2` (WXT builds Firefox as MV2 by default)                                                                                                                                                           |
| Extension calls | made from an extension page (`popup.html`) with `browser ?? chrome`, so the same code drives both browsers                                                                                                          |

Caveat: the machine runs Kaspersky web protection, which injects into pages (its hosts appear in page CSPs).
Pages are flagged `injectedByAntivirus` in the data; this affects which sites load, not the verdicts.

## What is measured

- `corpus.ts`: 193 live URLs: news, e-commerce, documentation, SaaS, government, education, finance, forums,
  blogs, dashboards, landing pages, portfolios and accessibility sites, including pages in right-to-left and CJK
  scripts (for example the Arabic, Hebrew and Japanese Wikipedia).
- `corpus-run.spec.ts` crawls it once per browser (`RW_BROWSER`, `RW_ONLY`, `RW_FORCE`, resumable) and writes one
  JSON per page to `realworld/.artifacts/<browser>/` (git-ignored). Per page: features, an independent WCAG contrast
  oracle (`lib/color.ts`, not the product's own code) before and after adaptation, DOM and attribute integrity
  against a no-op noise control, form values, title, URL and history, a privacy check of the audit export against
  the page's own secrets, a visual diff, console logs and timings.
- Scenario specs (local servers, hostile fixtures): `features` (hostile CSP, shadow DOM, iframes, forms, RTL...),
  `security`, `runtime` (popup, options, audit UI, downloads, reload), `interaction` (keyboard, focus),
  `dynamic` (mutation bursts), `spa` (500 route changes), `compare-builds`, `dist` (static checks of the two
  production bundles). `judge.spec.ts` compares the audit with the independent oracle over the crawl.
- `budgets.ts` holds the wall-clock budgets, fixed before measuring and never loosened to pass.

## Results (2026-10-05, Chrome 154 and Firefox 151.0.3)

Scenario specs: 73 tests, all pass (`dist` 7, `features` 14, `security` 18, `runtime` 16, `interaction` 4,
`dynamic` 8, `spa` 4, `compare-builds` 1, `judge` 1). Recorded checks: Chrome 30 PASS / 11 INFO, Firefox 29 PASS /
10 INFO / 1 NOT_VERIFIED.

Crawl: 193 of 193 pages ran in both browsers. Pages that did not load at all (network, bot walls): Chrome
`a11y-digital-gov`, `fin-ecb`, `fin-nasdaq`, `forum-lobsters`, `news-nhk`, `news-spiegel` (187 measured); Firefox
`a11y-digital-gov`, `fin-ecb`, `news-spiegel`, `saas-jsfiddle`, `shop-rozetka` (188 measured). On every measured
page, in both browsers:

- the audit and the adaptation completed, and the injected stylesheet was removed after disabling;
- no change of title, URL or history length; no form value changed by the extension (the one Firefox page with
  form-value changes, `fin-coinmarketcap`, had `changes: 0`, so the page changed them itself);
- the audit export contained none of the page's secrets (the single hit, `a11y-contrast-ratio`, is a hex colour
  held in one of the page's colour inputs, which the audit reports by design as a colour).

Contrast got worse on a few elements of live pages. Every case was either a page that the extension did not change
(`changes: 0`: `dash-highcharts-demo`, `fin-coinmarketcap`, `edu-codecademy`) or an element that stayed far above its
target (`fin-tradingview`, `edu-edx`), and the number of elements below target did not grow where the extension
acted, except `land-tesla` (Firefox), where the two affected links belong to a hero carousel: the "before" ratio of
the same elements varies between runs from 1.9 to 11.0 with 47 to 66 mutations in 2 s. That is page animation, not
proven independent of the extension.

Audit versus the independent oracle (Chrome, 186 pages, the M10 baseline): of the findings that could be decided,
4767 were CONFIRMED, 67 FALSE_POSITIVE and 392 FALSE_NEGATIVE, on 28 pages. **M10.R1 classified every one of the
459** (287 ColorAdapt defects, 114 oracle defects, 42 harness defects, 16 page-state differences, 0 ambiguous),
fixed the defects, corrected the oracle and re-ran the comparison: see `docs/REAL_WORLD_FINDINGS_CLOSEOUT.md`. The
baseline numbers above are kept as measured; do not compare them with a later run without that document.

## Firefox

Runtime is verified for what the scenario specs cover (popup, options, audit export, adaptation, dynamic pages,
SPA, hostile CSP). Not verified: heap, DOM-node and listener counters of the 500-route SPA run (geckodriver does not
expose them; the pipeline's own counters were flat: tracked 4 to 4, rules 1 to 1, one observer start).

Firefox manifest: `wxt.config.ts` gives only the Firefox manifest `browser_specific_settings.gecko` with the id
`coloradapt@coloradapt.invalid` (a placeholder until publication) and `data_collection_permissions: none`. The
permissions are unchanged and identical in both browsers; `tests/core/audit/review-architecture.test.ts` checks it.

## Findings that changed the harness

These were bugs of the harness, found by reading the data, and are fixed. They matter if the numbers are compared
with an earlier run:

- Regular expressions inside the page-side template strings lost their backslashes (`/\s+/` ran as `/s+/`), so
  the CSP of a page was never parsed (empty directive list everywhere). Now `gov-uk` and `gov-data` report an
  inline-style block in both browsers; the extension had nothing to change there (`changes: 0`).
- Firefox reported the first line of a JS stack instead of the error message.
- Some pages replace themselves once after load (a bot check that reloads into the real page, `tesla.com`): the
  audit then ran in the gap with no content script. The crawl now waits for a complete document, an answering
  content script and 1.5 s of an unchanged state (bounded to 25 s).
