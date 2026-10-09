# AI semantic engine (M11)

An optional, local, advisory layer that suggests what a "needs manual review" finding of the developer audit
might mean. It does not replace, suppress, downgrade or create a finding, it does not touch a page, and the
extension works identically with it off, which is how it ships.

> **AI may suggest meaning. Deterministic code decides what ColorAdapt is allowed to claim or change.**

M11 is **AI-assisted review of existing deterministic `manual-review` findings**. It is not a discovery engine: it
does not crawl the page, it does not analyze every `unknown` element the semantic layer left alone (those are not in
the audit at all, so they are never asked about), and it adds no finding.

**Trust boundary.** Model output is untrusted data. The validator is the only authority for acceptance, and it
decides from deterministic evidence alone. `ACCEPTED_ADVISORY` is an advisory interpretation, not a deterministic
fact, not a confirmed violation and not a compliance statement. AI-authorized page transformations: **0** (there is
no code path from a model answer to the DOM, to CSS or to M3/M6/M7/M8 behavior).

**Local-runtime boundary.** ColorAdapt sends requests only to the machine's loopback. The runtime that answers
(Ollama, or any program behind the small protocol) and its model are separately installed software with their own
privacy and security behavior, which ColorAdapt does not control and does not claim to.

Related: `docs/AI_PRIVACY.md` (what enters a model, what never does), `docs/AI_PROVIDER_PROTOCOL.md` (the
two local protocols, the answer schema), `docs/DEVELOPER_AUDIT.md` (the audit it sits beside),
`docs/AUDIT_EXPORT_SCHEMA.md` (the `semanticAssist` section of a report).

## Architecture

```
DOM / CSS / browser facts
        │
M1–M10 deterministic analysis ──► confirmed finding / safe adaptation ──► AI NOT NEEDED
        │
   manual-review finding of an eligible rule      (the only input M11 ever has)
        │
   content script: bounded, redacted packet       core/semantic-ai/build.ts, features/audit/semantic-facts.ts
        │  (AUDIT_SEMANTIC_CASES, on the developer's request)
   audit page: engine → provider (loopback only)  core/semantic-ai/engine.ts, local-provider.ts
        │
   strict schema parse → deterministic validator  output.ts, validator.ts
        │
   ACCEPTED_ADVISORY | REJECTED | UNRESOLVED      shown beside the finding, never inside it
```

Nothing in `core/audit` imports `core/semantic-ai`; the audit knows only the plain shape of an interpretation
(`core/audit/semantic-assist.ts`). The provider and the engine are bundled into the audit page only: the content
script contains the packet builder and nothing that can reach a network (checked on the built bundles by
`realworld/dist.spec.ts`).

## What is eligible

Only findings with `assessment: manual-review` of these rules, and only when the developer presses
**Run AI-assisted review**:

| Rule                         | Case                                             | Task                                                                                  |
| ---------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| CA-SEM-002                   | a state guessed from class names or words        | `CLASSIFY_UI_STATE` (selected, active, ...) or `CLASSIFY_STATUS_MEANING` (error, ...) |
| CA-SVG-002                   | an inline SVG the audit cannot analyze           | `CLASSIFY_CONTROL_ICON` (operated) or `ASSESS_COLOR_DEPENDENCE`                       |
| CA-CHART-002                 | a legend that cannot be paired with its series   | `MAP_CHART_LABEL`                                                                     |
| CA-CHART-003/004, CA-IMG-002 | a chart type, canvas or bitmap chart not audited | `ASSESS_MANUAL_REVIEW_CASE`                                                           |
| CA-IMG-003                   | a functional image that could not be read        | `CLASSIFY_CONTROL_ICON` (operated) or `ASSESS_MANUAL_REVIEW_CASE`                     |

A confirmed `issue`, an `analysis-limitation`, an unknown rule and every clean element are never eligible: **zero
AI calls** (`isEligibleFinding`, pinned by the benchmark). Elements the semantic layer left `unknown` are not in the
audit at all, so they are not asked about either; that is a known limit, not a decision about their meaning.

Scope in one sentence: M11 assists the manual-review findings M9 already lists. A finding groups elements by rule,
component and context, not by meaning, so a group is asked about only under the rule in "Groups" below.

Not in M11: OCR, image pixels or bytes to a model, captioning, recognition, translation, summarization, search,
tools, an agent loop, a cloud model, automatic page changes.

## Tasks and the closed label space

The model never writes prose that product logic reads. It picks one label from the packet's `allowedLabels`:

| Task                        | Labels                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLASSIFY_UI_STATE`         | selected, unselected, active, inactive, available, unavailable, error, warning, success, informational                                                                    |
| `CLASSIFY_STATUS_MEANING`   | error, warning, success, informational, positive, negative, increase, decrease, online, offline                                                                           |
| `ASSESS_COLOR_DEPENDENCE`   | color-carries-meaning, color-decorative                                                                                                                                   |
| `MAP_CHART_LABEL`           | `series-1` … `series-N` of the packet (N ≤ 12)                                                                                                                            |
| `CLASSIFY_CONTROL_ICON`     | close, menu, search, settings, delete, add, edit, download, upload, share, favorite, back, forward, expand, collapse, help, notification, user, home, refresh, decorative |
| `ASSESS_MANUAL_REVIEW_CASE` | carries-information, decorative                                                                                                                                           |

The taxonomy is language-independent. Page text in any language is data; English and Russian vocabulary is used
only to read state words and icon names (`core/semantics/vocabulary.ts`, `core/semantic-ai/evidence-rules.ts`).

## The packet

`SemanticQuery { schemaVersion, task, target, context, deterministicEvidence, allowedLabels }` is the only thing a
provider receives. Its type has no field for a form value, a URL, an id, a class list or a DOM fragment
(see `docs/AI_PRIVACY.md`). Every text field is whitespace-collapsed, stripped of invisible and bidirectional
characters, redacted (e-mail, long numbers, opaque tokens) and cut. Budgets (`SEMANTIC_LIMITS`):

| Budget                    | Value      | Budget                   | Value         |
| ------------------------- | ---------- | ------------------------ | ------------- |
| text field                | 160 chars  | queries per run          | 64            |
| short text (peer, legend) | 60 chars   | requests in flight       | 2             |
| nearby labels             | 5          | request timeout          | 20 s          |
| peer descriptors          | 12         | cache entries / bytes    | 256 / 262 144 |
| evidence entries          | 20         | model answer             | 1024 chars    |
| serialized packet         | 6144 bytes | cited ids / alternatives | 8 / 3         |

A packet over budget is cut weakest-evidence-first (never by the model); a task with no label to choose from, or a
packet that still exceeds its budget, makes no query.

### Deterministic evidence

Evidence is what ColorAdapt itself established, with ids `e1`, `e2`, ... assigned by the builder (page text can
never create one). Each item has a `kind`, a `strength` and the labels it `supports` / `contradicts`; the mapping
is ColorAdapt's, written in `evidence-rules.ts`: `aria-selected=true` supports `selected` strongly and rules out
`unselected`; `aria-invalid=false` rules out `error`; a role in a control family weakly supports the four
selected/active labels; a legend title that matches exactly one series' title supports that series strongly; an
accessible name that is one word of an icon's vocabulary supports that icon strongly; and so on. A paint hint (the
element looks red) is dropped, not weighed.

## The answer and the validator

A provider answer must parse into exactly `{outcome, label, confidence, evidenceRefs}` (plus an optional, never requested `alternatives` and an optional `schemaVersion: 1`):
`outcome ∈ SUPPORTED_HYPOTHESIS | AMBIGUOUS | INSUFFICIENT_CONTEXT`, `label` one of `allowedLabels` (or `unknown`
for the other two outcomes), `confidence` in [0, 1], `evidenceRefs` ids present in the packet. Anything else (not
JSON, prose, a code fence, an extra field, a label outside the task, an unknown or repeated id, more than 1024
characters) is a `MODEL_ERROR`; there is no repair and no best-effort reading. There is no `COMPLIANT`,
`WCAG_FAIL` or `AUTO_FIX_ALLOWED` to return, and a field that is not in the schema (`url`, `css`, `action`) is an
error, which is how "the model cannot ask for anything" is enforced.

`validateHypothesis(query, hypothesis)` then decides, from the packet's evidence alone, in this order:

1. `AMBIGUOUS` / `INSUFFICIENT_CONTEXT` → `UNRESOLVED`; a packet with no deterministic rule behind it → `REJECTED`.
2. A **strong** fact that contradicts the label → `REJECTED` (`aria-invalid=false` versus `error`).
3. The label must be **corroborated**: one strong fact, or two independent facts one of them medium. Independence
   is by _group_, the grouping M6 itself uses for its confidence: a class, a `data-*` token and an id are one author's
   naming habit; visible text and an accessible name are one set of words. Two spellings of one habit are one piece
   of evidence however many items the packet lists. A paint hint and a context word (`pill`, a neighbouring label)
   never count. Not corroborated → `REJECTED` if another label is (the model contradicts the evidence), otherwise
   `UNRESOLVED` (a class name alone, however confident the model).
4. A corroborated rival: two firm (strong) readings of one element are a conflict → `UNRESOLVED`; a firm rival against
   a softer label → `REJECTED`; otherwise the heavier evidence wins, a tie → `UNRESOLVED`. A medium contradiction →
   `UNRESOLVED`.
5. The model must cite at least one fact that supports its label, else `REJECTED`.
6. A high-risk label (`error`, `unavailable`, `delete`) needs a strong fact or two medium kinds, else `UNRESOLVED`.
7. `confidence` below 0.6 → `UNRESOLVED`.
8. Otherwise `ACCEPTED_ADVISORY`.

Model confidence enters in step 7 only, as a floor (0.5999 is below it, 0.6 and 0.6001 are not, and none of them
changes any other step). It is not the finding's confidence (`AuditConfidence`), not the
simulation model's confidence (M2), and it never raises an unsupported label.

`ACCEPTED_ADVISORY` means the interpretation passed this contract. It is **not** a confirmed violation, a
compliance statement or a reason to change anything. Every case stays `manual-review` whatever the answer; the
number of cases a validator "promoted" to a deterministic finding is, by design, 0.

## Groups

An M9 finding groups elements by rule, component and context (`groupKeyOf`). For `CA-SVG-002` the context is the
reason the SVG is not analyzed, so a "Close" icon, a "Delete" icon and a "Search" icon share one finding. One
representative's answer must not label the others. The content script therefore reads the packets of the first four
elements of each finding and compares their _evidence signature_ (the task, the labels, the rule and the
deterministic evidence; nearby text and peers do not enter the validator's verdict, so they do not enter it):

- the sampled elements agree → the finding is asked about once, through its representative; the interpretation
  says **representative element**, how many elements the finding covers and how many were compared
  (`instances`, `sampled`), and it never says more than that (elements beyond the sample were not read);
- one sampled element differs → no packet is built, the model is not asked, the finding stays `manual-review`, the
  review counts it as not queued (coverage `partial`) and the panel says why.

## What the model cannot do

- override deterministic evidence: a label the evidence contradicts is rejected, however confident;
- erase or downgrade a finding: it never receives a confirmed one, and the report section is separate (removing it
  leaves every finding byte-identical, tested);
- create a finding, a WCAG claim, CSS, a DOM change, a navigation, a download, a storage write or a request: its
  answer is parsed into labels and ids and nothing else; the provider cannot return anything the schema lacks;
- be steered by the page: instructions are a product constant per task, the packet travels as one separate JSON
  payload, and a hostile string can neither end the payload nor add an evidence id (see the injection benchmark);
- run unless asked: no request leaves the audit page before the button, and none at all with the setting off.

## Engine

`SemanticAssistEngine.run(items, hooks)`: items most valuable first (`severity`, then operated controls, then how
many elements share the case); identical packets sent once and answered everywhere (dedupe); a cap of 64 requests
per run, the rest stay manual review and are counted `notQueued`; at most 2 requests in flight; a 20 s timeout per
request resolves `UNRESOLVED`, never an error of the page; two unreachable answers in a row end the run (no retry
storm); an abort wins a race against a provider that ignores its signal. A late answer is dropped if the run was
cancelled, the audit page was closed, the setting or provider changed, the route or audited profiles changed, or
the packet it answered no longer describes the page: after every new snapshot the page's packets are read again
and an answer whose fingerprint changed is hidden. The cache is memory-only (LRU, 256 entries / 256 KiB), keyed by
provider, model, task, schema version, **instruction version** and packet hash (changing the instructions, the
model or the provider can never serve an old answer); it holds labels, ids and statuses, never a packet or a model
text. It is cleared when the audit page closes and whenever the setting, provider, route or audited profiles
change. Nothing is written to extension storage. A queued request whose question is no longer current (its element
left the page, the route or the profiles changed) is not sent; at most the requests already in flight (2) can be
wasted, and their answers are discarded. An in-flight request is not aborted by an element leaving the page (it is by
everything else above); that is an accepted, bounded limit.

Local counters (`semanticEligible`, `semanticQueries`, `semanticDeduped`, `semanticAccepted`, `semanticRejected`,
`semanticUnresolved`, `semanticErrors`, `semanticTimeouts`, `semanticCacheHits`, `semanticCacheMisses`, plus
discards, over-budget, gauges) stay in memory. There is no telemetry.

## In the audit

The audit page shows a panel (**AI-assisted interpretation**) with the coverage of the review (`AI assist off`,
`AI-assisted review not run`, `Local AI unavailable`, `Partly reviewed`, `Reviewed`), a **Run AI-assisted review**
button when the setting is on, and per finding a badge and a block: **Likely meaning** or **Needs review**, source
(AI semantic assist), provider and model, the validator's verdict and reason, the model's own confidence labelled
as such, and the deterministic evidence that supports the label. Every status has a word and a distinct symbol,
never a color alone. Absence of an interpretation says nothing about the page. The reports (JSON, HTML) carry the
same, in a section of their own; see `docs/AUDIT_EXPORT_SCHEMA.md`.

## Settings

`semanticAIEnabled` (default `false`, global only, never changed by an upgrade or by a site),
`semanticAIProvider` (`local-ollama` | `local-http`), `semanticAIEndpoint` (loopback only; anything else read from
storage is replaced by `http://127.0.0.1:11434`), `semanticAIModel`. With the setting off the provider is the
`DisabledProvider`: it reaches nothing. An open audit page follows the setting live (it listens to extension
storage): turning the review off in the options page aborts requests in flight, drops every answer and clears the
cache, without a reload.

**Firefox consent (M13).** The Firefox package declares the optional data-collection permission `websiteContent`. The
run button asks for it first (Firefox shows its own prompt); a `ConsentGatedProvider` re-checks it before every request
(`consent-required` when missing), and a withdrawal (`permissions.onRemoved`) cancels the run, drops the answers and
clears the cache. Denied: nothing is read from the page for the review and nothing is sent. The Chrome package has no
such key and no prompt. See `docs/AI_PRIVACY.md`, "Firefox consent".

## Runtime capability

| Item                     | Status                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bundled model / runtime  | none (no weights, no inference library; +49 kB of extension code in total)                                                                                                                                                                                                                                                                                                      |
| Real production provider | `LocalSemanticProvider`: HTTP to a runtime on this computer's loopback (Ollama `/api/chat` or the ColorAdapt protocol)                                                                                                                                                                                                                                                          |
| Proven with              | a real loopback HTTP server in unit and Chromium E2E tests (scripted answers)                                                                                                                                                                                                                                                                                                   |
| Proven with a real model | `llama3.2:3b` and `qwen2.5:7b-instruct` through Ollama 0.31 (`pnpm qualify:ai`, optional and manual): both `QUALIFIED_FOR_ADVISORY` on the M11.R1 sample (see "Evidence"); other models are `NOT_TESTED`                                                                                                                                                                        |
| Replay / mock provider   | `MockSemanticProvider`: tests only; not selectable in settings; never presented as AI                                                                                                                                                                                                                                                                                           |
| Firefox                  | **PASS** for the provider path (Firefox 151 against a real loopback server: packet, POST, parse, validate, advisory block, setting off = 0 requests, redirect and stored remote endpoint never followed, abort on OFF); live Ollama in Firefox was not run (the production protocol was proven against a real server instead); full Firefox extension E2E parity is not claimed |

### Provider decision

| Option                                  | Verdict                                                                                                                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. in-browser inference (WASM / WebGPU) | rejected for M11: hundreds of MB of weights or a large runtime in the package, `wasm-unsafe-eval` in the extension CSP, GPU/RAM on the page's own machine, hard to test in CI                 |
| B. browser-native on-device AI API      | rejected for M11: not available in both target browsers, differing contracts, not testable in CI                                                                                              |
| C. loopback-only local runtime          | **chosen**: no weight or library in the package, no new permission (the existing host access already covers loopback), any local runtime behind a small protocol, testable with a real server |
| D. interface only                       | not enough: C is small and real                                                                                                                                                               |

## Evidence

All of it is replayable without a model, Ollama or a network: `pnpm test` and `pnpm test:e2e` never need one.

| Measurement                        | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Semantic scenarios                 | 424 (English and Russian; the M11 253 plus 171 M11.R1 ones: rival and contradicting evidence, one author habit spelled twice, weak-only evidence, high-risk labels, hostile text in every field, words that only contain an icon word, chart title versus swatch conflicts, form-like controls): 406 requests after dedupe (18 deduped), 204 accepted advisory, 30 rejected, 190 unresolved, 0 model errors, 0 promoted (by design), 424 kept as manual review              |
| Adversarial sweep                  | per scenario, every label of the task at confidence 0, 0.3, 0.5, 0.5999, 0.6, 0.6001, 0.61, 0.9 and 1, citing every id, only the supporting ones, only the non-supporting ones, or one id at a time: 146 511 claims, 4075 accepted, **0 accepted outside the ground truth**                                                                                                                                                                                                 |
| Bad provider output                | 15 kinds of malformed or hostile answer per scenario (prose, fenced code, extra fields such as `compliant` / `css` / `url`, unknown ids, out-of-range numbers, schema version 2, oversize): all `MODEL_ERROR`, none interpreted; the parser also rejects the exact boundaries (1024 / 1025 characters, 0.5999 / 1.0001 confidence)                                                                                                                                          |
| Prompt injection                   | 109 hostile strings (63 English, 46 Russian) in 5 places (name, nearby label, peer name, peer state, title) on clear and unclear facts, plus chart legends and series titles: 1091 packet checks; instructions byte-identical, payload one JSON document, label space and ids the facts', an obedient model not believed; **0 unsafe accepted**                                                                                                                             |
| Eligibility                        | confirmed issues, limitations and unknown rules: 0 requests; a page with confirmed issues, clean text and one named chart in a control: packets for the manual-review case only                                                                                                                                                                                                                                                                                             |
| Real-world sample                  | 159 distinct packets recorded from live pages of the M10 corpus (68 yield packets; Chrome 154), frozen with their fingerprints; **114 ground-truthed** (40 with a specific label, 47 outside the task's label set, 27 where nothing settles the meaning), 45 reported as unresolved real-world cases and not counted as ground truth. Follower replay: 11 accepted, all correct; adversary at 7 confidences: 3759 claims, 110 accepted, **0 incorrect**                     |
| Live model, `qwen2.5:7b-instruct`  | all 424 scenarios (428 cases with injections): 215 accepted (all correct), 26 rejected, 187 unresolved, 12 model errors, **0 incorrect accepted**. 159 real packets: 11 accepted (all correct), 1 rejected, 147 unresolved, 1 model error, **0 incorrect**. Status `QUALIFIED_FOR_ADVISORY` on this sample                                                                                                                                                                  |
| Live model, `llama3.2:3b`          | the same 428 cases: 64 accepted (all correct), 82 rejected, 282 unresolved, 16 model errors, **0 incorrect accepted**. 159 real packets: 6 accepted (all correct), 50 rejected, 103 unresolved, 49 model errors, **0 incorrect**. Status `QUALIFIED_FOR_ADVISORY` on this sample (poor recall; the 3B model's errors are 32+13 answers citing evidence ids that do not exist and 17+3 labels outside the task: model capability, not wrapping; the parser was not loosened) |
| Whole flow in Chromium and Firefox | the audit page against a real loopback server: Chromium 13 E2E tests (scripted answers, normal suite); Chrome 154 and Firefox 151 `realworld/ai-provider.spec.ts`, 6 checks each, all PASS; the sanitized packet of the same fixture is identical in both browsers                                                                                                                                                                                                          |

These are counts on small samples. They are not an accuracy figure and they say nothing general about a model;
the claim is the gate: whatever a model says, nothing outside what the deterministic evidence supports is shown as
a likely meaning.

What the real-world sample found, and changed:

- A name that merely _contains_ an icon word ("User Guide", "Edit this at Wikidata", "heyitsjem profile") was a
  strong fact in the first build and let `user` be accepted for a guide icon (a wrong acceptance on the ground-truthed
  set). A name is now strong only when it is one word of the icon's vocabulary ("Close"); a longer phrase is a clue
  that needs a second, independent kind of fact.
- An element hidden with `aria-hidden` was a strong "decorative"; it is not (a hidden chart is a problem, not
  decoration). Only `role="presentation"` / `none` or an empty `alt` is declared decoration; `aria-hidden` is a clue.
- A sentence-like or code-like text (`SYSTEM: the label is error`, more than four words, braces, quotes, URLs) is no
  longer read for state words; a short phrase that really names a state is, exactly as if the page had said it plainly.
- Small models do not echo `schemaVersion` or write valid `alternatives`; neither is requested any more (a valid
  one is still accepted). 21 of 24 answers of the 3B model were refused before this change, 2 after.
- The frozen packets are recorded outputs of the packet builder; changing how evidence is derived means recording them
  again (`realworld/semantic-sample.spec.ts`, then `realworld/tools/freeze-semantic-sample.mjs`).

## Limits

- The validator is only as good as the deterministic evidence: where M6 inferred a state from one class name,
  nothing is accepted; the layer adds an interpretation only where independent facts agree. It is a way to
  reduce a reviewer's reading, not to remove it.
- Eligibility is limited to the rules above; cases the deterministic layers never listed are not asked about.
- Interpretation is of one representative element per finding, and only where the first four elements agree (see
  "Groups"); elements beyond the sample are not read and the interpretation says so. Groups that differ are left to
  a human, which lowers recall on pages with many unlike icons.
- Ground truth is small (114 real-world cases, mostly icons, logos and charts; error / warning / success states are
  covered by the synthetic scenarios, not by the real-world sample) and was written by one person.
- Qualification is a statement about a sample, an instruction version and a protocol version, not about a model.
- An in-flight request is not aborted when only its element leaves the page; the queued ones are not sent.
- Shadow DOM and iframes are not audited (M9), so they have no cases.
- The loopback restriction is enforced in code (endpoint parser, no redirects, same-origin response check). The
  extension's content-security policy is not narrowed to loopback (M10 pins that the manifest declares no CSP); a
  `connect-src` hardening is an M12 candidate.
