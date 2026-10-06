# Audit Export Schema (v1)

The developer audit ([DEVELOPER_AUDIT.md](DEVELOPER_AUDIT.md)) exports a JSON report and a standalone HTML
report. The JSON is a documented, versioned format of its own — not a dump of internal objects.
`src/core/audit/export.ts` (`createAuditReport`, `serializeAuditReport`, `parseAuditReport`,
`renderAuditHtml`) and `src/core/audit/types.ts` are the source of truth; this file describes them.

Both exports are made in the audit page from the snapshot it is showing, so the export always matches the
visible audit (one coherent generation; filters only change the view, the export holds every finding).

## Versioning

- `schemaVersion` is an integer, currently `1` (`AUDIT_SCHEMA_VERSION`).
- Adding an optional field does not bump it; renaming, removing or changing the meaning of a field does.
- A reader must reject a `schemaVersion` it does not know (`parseAuditReport` does): a missing, older or
  future version is an error, not a guess. M9 freezes version **1**; version 1 was never released before
  M9.R1, so the coverage fields below are part of it, not an addition to it.
- Compatibility rule for later milestones: new optional fields are ignored by a v1 reader; anything a v1
  reader would misread (a field renamed or removed, an enum value whose meaning changes, a changed summary
  rule) needs `schemaVersion: 2` and a new section here.
- The report is described here, not by the TypeScript types: types may change without a schema change.

## Determinism

For identical page state the JSON is byte-identical apart from `generatedAt`:

- `canonicalJson`: every object's keys sorted alphabetically, `undefined` dropped, 2-space indent, a trailing newline;
- arrays keep a fixed order: findings by severity (critical first), then issue → manual-review → analysis-limitation,
  rule id, affected count (larger first), finding id; `affected` by severity, then path, then instance id;
  `visionProfiles`/`simulation` in profile order; `evidence` in construction order;
- ids are hashes of structure, never random; no `generation` or timestamp other than `generatedAt` is exported.

## Top level

| Field            | Type                                      | Meaning                                                                                                                                          |
| ---------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schemaVersion`  | `1`                                       | format version                                                                                                                                   |
| `generatedAt`    | string (ISO 8601)                         | when the export was made (the only intentionally variable field)                                                                                 |
| `tool`           | `{ name: "ColorAdapt", version: string }` | extension and version                                                                                                                            |
| `page`           | `{ origin, pathname }`                    | sanitized address (see below)                                                                                                                    |
| `audit`          | object                                    | `basis: "original-page-state"`, `visionProfile` (the user's active profile), `auditedProfiles` (profiles audited), `adaptationEnabled` (boolean) |
| `summary`        | object                                    | counts, never a score (below)                                                                                                                    |
| `coverage`       | object                                    | what the pass looked at                                                                                                                          |
| `findings`       | array of finding                          | see below                                                                                                                                        |
| `semanticAssist` | object, optional                          | the AI-assisted review (M11): a section of its own, see below                                                                                    |

### `summary`

`findings` (groups), `affectedElements` (summed over findings), `bySeverity` (critical, high, medium, low,
info), `byCategory`, `byConfidence` (HIGH, MEDIUM, LOW), `byAssessment`, `byAdaptation` (every adaptation status),
`adapted` (issue findings ColorAdapt compensated for), `unresolved` (issue findings nothing compensates for),
`manualReview`. All numbers. It always equals what `findings` add up to.

### `coverage`

`elementsAnalyzed`, `analysisTruncated` (boolean), `semanticCandidates`, `svgUnits`, `charts`, `canvases`,
`images`, `truncatedFindings` (finding groups beyond the 1000-group cap, counted not listed),
`budgetsReached` (sorted names of the budgets a pass hit, empty when none) and `subsystems`.

`subsystems` has one entry per area, always all of them, in this order: `color-contrast`, `semantic-cues`,
`svg`, `charts`, `image-pixels`, `findings`, `shadow-dom`, `iframes`, `borders-focus`. Each is
`{ id, name, level, note }` with `level` one of `complete` | `partial` | `disabled` | `unsupported` and
`note` one fixed sentence about what was and was not looked at (see
[DEVELOPER_AUDIT.md](DEVELOPER_AUDIT.md#coverage)). A global limit is stated here once, never as one
finding per element. In particular `image-pixels` is `disabled` unless adaptation and image adaptation are
both on: a report without image findings then says nothing about the images.

## Finding

| Field                 | Type                                            | Meaning                                                                                                                                                                                        |
| --------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                  | string                                          | `CA-XXX-NNN:` + 16 hex characters; stable across refreshes while the issue is unchanged                                                                                                        |
| `ruleId`              | string                                          | a registered rule ([AUDIT_RULES.md](AUDIT_RULES.md))                                                                                                                                           |
| `category`            | enum                                            | `color-contrast`, `color-distinguishability`, `color-only-information`, `semantic-state`, `svg`, `chart`, `image`, `dynamic-content`, `unsupported-content` (matches the rule's)               |
| `subcategory`         | enum                                            | the rule's subcategory                                                                                                                                                                         |
| `severity`            | enum                                            | `critical` `high` `medium` `low` `info`                                                                                                                                                        |
| `severityReasons`     | string[]                                        | one line per step of the severity algorithm                                                                                                                                                    |
| `confidence`          | enum                                            | `HIGH` `MEDIUM` `LOW`: how sure the audit is (separate from severity)                                                                                                                          |
| `assessment`          | enum                                            | `issue`, `manual-review`, `analysis-limitation`                                                                                                                                                |
| `title`, `summary`    | string                                          | deterministic text                                                                                                                                                                             |
| `evidence`            | evidence[]                                      | of the most severe affected element                                                                                                                                                            |
| `affectedCount`       | integer ≥ 1                                     | exact number of elements covered                                                                                                                                                               |
| `affected`            | affected[]                                      | first 50, most severe first (all of them when `affectedCount` ≤ 50)                                                                                                                            |
| `recommendation`      | object                                          | `summary`, `actions[]`, `observed` (string/null), `coloradapt` (string/null), `suggestedColor` (null or `{ hex, origin: "coloradapt-generated", note }`)                                       |
| `source`              | object                                          | `primary` (M1–M8), `contributing[]`, `subsystem`                                                                                                                                               |
| `visionProfiles`      | profile[]                                       | profiles the problem exists under; empty when not profile-specific                                                                                                                             |
| `simulation`          | object[]                                        | per profile: `profile`, `model`, `fidelity` (`published`/`approximation`/`none`), `modelConfidence` (`SUPPORTED_MODEL`/`MODEL_ASSUMPTION`/`APPROXIMATION`/`UNSUPPORTED`, M2's, never upgraded) |
| `adaptationStatus`    | enum                                            | worst status among the elements: `not-applicable`, `not-needed`, `adapted`, `not-applied`, `no-safe-candidate`, `unsupported`, `not-enabled`                                                   |
| `adaptationBreakdown` | object                                          | element count per status                                                                                                                                                                       |
| `sourceNote`          | string                                          | fixed: the finding is measured on the original page; adaptation does not remove it                                                                                                             |
| `wcag`                | `{ criterion, name, relation: "related-to" }[]` | criteria the rule is near; never a claim                                                                                                                                                       |

### `evidence[]` item

`{ key, basis, label, value }`. `key` is unique within a finding. `basis` is `observed-fact`, `inference`,
`engineering-threshold` or `model-estimate`. `value` is one of: `{ kind: "color", hex }`,
`{ kind: "colors", foreground, background }`, `{ kind: "number", value, unit? }` (rounded to 3 decimals),
`{ kind: "text", text }`, `{ kind: "list", items[] }`.

### `affected[]` item

`{ instanceId, locator, severity, adaptationStatus, evidence[] }` with `instanceId` =
`<ruleId>/<16 hex>` and `locator`:

| Field       | Type           | Notes                                                                                                                             |
| ----------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `tag`       | string         | local name                                                                                                                        |
| `id`        | string / null  | safe characters only; identifier-like values become `[redacted]`                                                                  |
| `classes`   | string[] (≤ 3) | safe class names; identifier-like ones are dropped                                                                                |
| `role`      | string / null  | ARIA role                                                                                                                         |
| `inputType` | string / null  | for `<input>` only, from a known list (else `other`); never the value                                                             |
| `text`      | string / null  | ≤ 40 characters of the element's own visible text, redacted; `null` for form controls and editable regions; the `alt` for `<img>` |
| `path`      | string         | at most the last six steps of a structural path (`#app>ul:nth-of-type(1)>li:nth-of-type(3)`), prefixed `…>` when cut              |

## `semanticAssist` (optional, M11)

Added without a version bump: it is an optional top-level key, absent from a report made without it, and a
report with it removed is byte-identical to one that never had it (tested). It never changes, adds or removes a
finding, and no finding refers to it. The audit page always includes it (`coverage: "disabled"` when the setting
is off), so an absent interpretation never looks like a clean result. Rules and wording: `docs/AI_SEMANTIC_ENGINE.md`.

| Field                   | Type            | Meaning                                                                                                                                |
| ----------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`         | `1`             | version of this section                                                                                                                |
| `aiAssisted`            | boolean         | `true` when the section lists interpretations a model produced                                                                         |
| `coverage`              | string          | `disabled` \| `unavailable` \| `not-run` \| `partial` \| `completed`                                                                   |
| `provider`              | `{ id, model }` | `disabled` \| `mock` \| `local-http` \| `local-ollama`; the model name as reported (or `null`)                                         |
| `semanticSchemaVersion` | integer         | version of the packet and answer schema                                                                                                |
| `instructionVersion`    | integer         | version of the fixed instructions                                                                                                      |
| `note`                  | string          | fixed sentence: advisory, never a finding                                                                                              |
| `stats`                 | object          | `eligible`, `queried`, `deduped`, `cacheHits`, `accepted`, `rejected`, `unresolved`, `modelErrors`, `timeouts`, `notQueued` (integers) |
| `entries`               | array           | one per interpreted finding, sorted by finding id                                                                                      |

An entry: `findingId` (an id of this report), `task`, `modelStatus` (`SUPPORTED_HYPOTHESIS` \| `AMBIGUOUS` \|
`INSUFFICIENT_CONTEXT` \| `MODEL_ERROR`), `validatorStatus` (`ACCEPTED_ADVISORY` \| `REJECTED` \| `UNRESOLVED`),
`validatorReason` (a stable code such as `accepted`, `insufficient-corroboration`, `timeout`), `hypothesis` (the
label the model proposed, or `null`), `modelConfidence` (the model's own number in [0, 1], or `null`; not a
finding confidence), `evidenceRefs` (ids it cited), `supportingEvidence` (`{ id, source, value }`, the
deterministic evidence that supports the label, value at most 160 characters) and `inputFingerprint` (16 hex
characters: a hash of the sanitized packet, so a result can be tied to its input without exporting the input),
`instances` (how many elements the finding covers) and `sampled` (how many of them had their evidence compared; at
least 1 and at most `instances`). An entry of a finding with `instances > 1` is an interpretation of its representative
element, offered only because every sampled element gave the same evidence; the HTML report says so. The provider
type, model, schema version and instruction version are in the section header; the task, fingerprint, model
confidence, validator result and cited evidence ids are in each entry.

Never in it: the prompt, the instructions, the packet, the raw model answer or any reasoning, provider logs, the
endpoint. The HTML report shows the same coverage, counts, provider, model, task and verdicts as the JSON, apart from the
deterministic findings, with every string escaped (tested by parsing the HTML and checking there is no script,
image, frame or event attribute and every link is an in-page anchor). `parseAuditReport` checks the section when
present: every field is in the schema, `instances` and `sampled` are consistent, enums and bounds hold,
every `findingId` is a finding of the report and appears once, an accepted entry has a label and a supported
hypothesis, ids are well formed, and no string holds an invisible character.

## Example (abridged)

```json
{
  "audit": {
    "adaptationEnabled": false,
    "auditedProfiles": ["deuteranopia"],
    "basis": "original-page-state",
    "visionProfile": "deuteranopia"
  },
  "coverage": {
    "analysisTruncated": false,
    "canvases": 0,
    "charts": 0,
    "elementsAnalyzed": 12,
    "images": 0,
    "semanticCandidates": 3,
    "svgUnits": 0,
    "truncatedFindings": 0
  },
  "findings": [
    {
      "adaptationBreakdown": { "not-enabled": 1 },
      "adaptationStatus": "not-enabled",
      "affected": [
        {
          "adaptationStatus": "not-enabled",
          "evidence": [],
          "instanceId": "CA-SEM-001/0123456789abcdef",
          "locator": {
            "classes": ["f"],
            "id": "email",
            "inputType": "email",
            "path": "#email",
            "role": null,
            "tag": "input",
            "text": null
          },
          "severity": "critical"
        }
      ],
      "affectedCount": 1,
      "assessment": "issue",
      "category": "color-only-information",
      "confidence": "HIGH",
      "id": "CA-SEM-001:fedcba9876543210",
      "ruleId": "CA-SEM-001",
      "severity": "critical",
      "title": "State communicated by color only",
      "visionProfiles": []
    }
  ],
  "generatedAt": "2026-10-04T12:00:00.000Z",
  "page": { "origin": "https://example.test", "pathname": "/account" },
  "schemaVersion": 1,
  "summary": { "adapted": 0, "findings": 1, "manualReview": 0, "unresolved": 1 },
  "tool": { "name": "ColorAdapt", "version": "0.1.0" }
}
```

(Findings and summary are shortened here; a real report carries every field above.)

## What an export contains (scope)

An export is always the **whole snapshot** it was made from: the filters and the search box of the audit
page change what is shown, never what is exported. The report is built from one immutable snapshot (one
generation); a newer pass that lands while an export is being made cannot mix into it.

## Page address policy

Only `page.origin` and `page.pathname` are exported:

- credentials, the query string and the fragment are never exported (`https://example.test/account?token=SECRET#private`
  becomes `https://example.test` + `/account`);
- path segments that look opaque are replaced by `:redacted`: 16+ hex characters, 6+ digits, 20+ character
  mixed letter/digit tokens, anything containing `@`, and anything with unusual characters; `;params` are dropped;
- a non-`http(s)` or unparsable address becomes origin `null`, pathname `/`.

## File names

`coloradapt-audit-<host>-<yyyy-mm-dd>.json` (or `.html`): host lower-cased, characters outside `a-z0-9.-`
replaced by `-`, at most 60 characters, `page` when empty; the date comes from `generatedAt`. Never a query or
path.

## Never exported

Values of `input`, `textarea`, `select`, `option` and `contenteditable` content (including password fields);
cookies; `localStorage`/`sessionStorage`; authorization data; headers; query/hash; full page HTML; `href`/`src`
values; `data-*` attributes (only vocabulary tokens a rule consumed, sanitized and bounded, appear in evidence);
unbounded page text. Hard regression tests assert that `type="password" value="secret"`, email/search/textarea/
contenteditable values and query tokens never appear in an export.

## Validation (`parseAuditReport`)

`parseAuditReport(text)` returns `{ ok: true, report }` or `{ ok: false, errors[] }`. It checks:

- valid JSON object; `schemaVersion` is 1; `generatedAt` is a date; `tool.name` is `ColorAdapt`;
- `page.origin` is `null` or a plain `http(s)` origin (no credentials, query or fragment); `page.pathname`
  starts with `/`, has no `?`, `#`, `@`, whitespace or backslash and is at most 2048 characters;
- no string anywhere in the report (or key) holds a control, bidirectional, zero-width, line/paragraph
  separator or unpaired-surrogate character;
- `audit.basis` is `original-page-state`, `visionProfile` is a known profile, `auditedProfiles` is an array,
  `adaptationEnabled` is boolean; `coverage`, `summary`, `findings` exist;
- for each finding: id matches `CA-XXX-NNN:<16 hex>` and is unique; `ruleId` is registered and `category` matches
  its rule; severity, confidence, assessment, adaptation status and profiles are valid enums;
  `title`, `summary`, `sourceNote` non-empty; `affectedCount` is an integer ≥ 1; at most 50 affected listed, never
  more than `affectedCount`, and every element listed when `affectedCount` ≤ 50; form-control locators carry
  no text and text is at most 40 characters; locator `path` (at most 400 characters), `id` and at most
  three `classes` stay within their bounds; evidence items are well formed with unique keys; `wcag`
  lists only `{ criterion, name, relation: "related-to" }`;
  `recommendation`, `source` and `simulation` exist;
- `summary` equals what the findings add up to (recomputed, canonical comparison);
- `coverage.subsystems` lists every area once, never shows a truncated analysis or a cut finding list as
  `complete`, and never shows `shadow-dom`, `iframes` or `borders-focus` as audited.

There is no import feature in M9; the parser exists to keep the format honest and testable.
`tests/core/audit/review-privacy.test.ts` feeds it a missing/future `schemaVersion`, wrong summary counts,
duplicate ids, invalid enums, a page address with credentials, query or fragment, text on a form control and
invisible characters, and expects a rejection for each.

## Standalone HTML report

`renderAuditHtml(report)` produces one file for reading offline: inline CSS (light and dark), no script, no
font, image or link that loads anything, and `<meta http-equiv="Content-Security-Policy" content="default-src
'none'; style-src 'unsafe-inline'">`. It shows the page, the generation time, the audited profiles, a counts
table (severity as text and shape), and one `<details>` per finding with summary, rule, assessment,
confidence, profiles, simulation model confidence, ColorAdapt's status, source, related WCAG criteria,
evidence with basis, recommendation, and affected elements. Every page-derived string goes through
`escapeHtml`; nothing is ever inserted as markup, so `<script>`, `<img onerror>` and `javascript:` text in a
page stay inert text.
