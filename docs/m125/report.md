# M12.5 — Burst Scalability Closeout: report

**RESULT: PASS.** Protocol: `docs/m125/protocol.md` (third freeze, candidate `eee4efe159e7d78584733a7a32485ae87fc4f6294b4dfcd10ca4d56b672892c0`,
555 files, unchanged at every check of the formal sequence; 0 mismatches). Start head `36b908969e0195a8e81e5c515b5c4b1e9b239b44`
(tag `m12-production-hardening`). Host: Windows 11, i5-12500H, 15.7 GB; Chrome 154, Firefox 151; the owner's Brave was open for the
sequence except `soak` and `idle-cpu`, which ran with it closed. Nothing pushed; M13 not started.

## Architecture

The M4 pipeline is unchanged (one observer, no History API hook). Behind it: one stylesheet rule per distinct declaration
(`data-coloradapt-s` token on each element) instead of one per element; delta commits that write attributes only while the sheet
text is unchanged (transitions suppressed for just the changed elements); no sheet suspension for a read of fresh elements;
a slice budget (`SLICE_BUDGET`: 600 units, SVG `12 + 3 x descendants`, semantic candidate 5, 10 ms analysis clock guard;
first region always whole) over the existing one-callback-per-frame scheduler and ordered work queue; local counters.
Root cause (measured): Chrome does not index attribute-value selectors, so every style recalculation cost
(tagged elements x rules); chunking the analysis alone could not have helped.

## Before and after (Chrome 154, median of 5 runs, hosts of 100 text elements, same fixture through the M12 build)

| Added  | M12: longest task / idle | M12.5: longest ColorAdapt slice | longest page task | idle   | slices |
| ------ | ------------------------ | ------------------------------- | ----------------- | ------ | ------ |
| 1,000  | 92 ms / 0.20 s           | 22 ms                           | none over 50 ms   | 0.19 s | 2      |
| 5,000  | 996 ms / 4.2 s           | 21 ms                           | none over 50 ms   | 0.24 s | 9      |
| 10,000 | 3,185 ms / 15.2 s        | 21 ms                           | 56-59 ms (1)      | 0.42 s | 18     |

10k gate (slice <= 50 ms median, <= 100 ms worst run; idle <= 2 s): **PASS**. Throughput about 23,700 elements/s (M12 build 660).
Firefox 151: 10k longest slice 34 ms, idle 1.2 s (M12 build 15 s). Other sets (Chrome, slice / M12 task): mixed 10k 22 / 3,616;
nested 5k 29 / 980; icons 2k 51 / 761; semantic rows 86 / 348; charts 59 / 492; one region 55 / 170; flat 10k (full rescan) 67 / 168 ms;
for icons, semantic rows and charts the total time to idle is longer (1.8-2.1 s) because the work is spread over 32-50 frames.

## Results by item

- Interaction: 30 real clicks during a 10k burst, worst delay far under 100 ms (Chrome) / 150 ms (Firefox); worst frame gap inside budget; page renders between slices.
- Continuous 10 s stream (about 60,000 elements): queue never above 2 records, no overflow, settles in under 0.1 s after it stops.
- Chunk-boundary parity: slice sizes 1, 2, 3, 7, 16, 64, 256, unbounded identical; 60 seeded pages x 4 sizes identical; randomized weights identical; fresh full analysis equals incremental.
- Mutation interleaving (operations after 0-3 slices at 4 slice sizes), 1,000 mutations of one element, ancestor/descendant dedupe: converge to the one-pass state.
- Cancellation: OFF mid-burst (message answered in about 20 ms, no rule/attribute/work left), profile change mid-burst (ends where the new profile alone ends; at 10k only new-profile declarations remain), route replacement, navigation: pass in both browsers; `staleRoots` and `cancelledRoots` counted.
- Queue/retention: queue and deferred roots 0 after every settle; 20 x 1k bursts: rules, tracked, nodes constant, heap +4 %; virtualized churn bounded.
- Parity with the unchanged M12 build: per-element computed color, background and cue identical in 10 of 10 gated sets in Chrome and Firefox. Not gated: inline-flow semantic cues (the cue check measures layout; 3,580 vs 4,018 of 5,000 applied, valid either way).
- No network request besides the page during bursts; AI off; no permission, dependency or telemetry added.
- Regressions: M12 suites in both browsers (lifecycle, state/P04, messaging, navigation, crash, ai-lifecycle, ui-a11y) green; upgrade, resource green; idle CPU relative control OFF 0.441 % / ON 0.737 %, delta 0.30 pp (<= 1); 30-minute soak green; M10 runtime, interaction, dynamic, security, ai-provider, dist green; Chromium E2E x3: 595 passed, 2 skipped each.
- Stability: scheduler 50/50, dynamic 50/50, semantic 50/50, charts 50/50, full suite 5/5 (146 files, 3,457 tests), `verify` 3/3, Firefox canonical burst 10/10; no retries.
- Gates: lint, typecheck, format PASS; builds PASS; reproducible (folders and zips byte-identical); `audit-dist` PASS; secret scan 0 findings; `pnpm audit` clean; Knip new findings 0.
- Bundle: content script 314,359 -> 318,281 bytes (+3.9 kB); Chrome folder +4.1 kB, zip 224,610 -> 225,892.

## Attempts and test corrections (disclosed)

Two earlier formal attempts were stopped and re-frozen (protocol section 11): a Chrome corpus gate read from one noisy sample (now median of runs) and a serial spec that hid later tests; a Firefox parity and a profile-change test that depended on M3's wall-clock-limited full analysis; a long-task recorder that saw nothing. No product budget number was loosened. Test expectations that pinned the old sheet format or batch size were updated (protocol section 10).

## Open debt (unchanged unless stated)

M10 SPA warm-up ratio: 1.1004 against 1.1 (M12 build 1.1014; not worse), product-side Firefox storage recovery, unidentified Firefox storage lock holder, per-site `adaptCharts`, Firefox orphan stylesheet, Firefox upgrade/resource evidence, M2 scientific PARTIAL, Firefox `http://[::1]:*` CSP warning (for M13). Limits of this milestone: M3 caps on what one region or full rescan covers are unchanged (very large pages are adapted up to them); a region is indivisible, so semantic-, icon- and chart-heavy regions are slices of 50-90 ms; the full analysis keeps its own 50 ms clock.

M13 is unblocked by M12.5.
