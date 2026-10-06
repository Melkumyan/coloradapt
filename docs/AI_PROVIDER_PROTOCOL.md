# AI provider protocol (M11)

How ColorAdapt talks to a model runtime on the same computer, and what any provider's answer must look like. A
provider adapter handles a runtime's own protocol; the core sees only the normalized result, so no model's
response style leaks into product logic (`core/semantic-ai/provider.ts`).

There are exactly four provider ids: `disabled` (default; reaches nothing), `local-ollama`, `local-http`, and
`mock` (tests only, not selectable). There is no remote provider and no fallback from one provider to another.

## Transport (both local providers)

- One `POST` per distinct packet to the configured loopback origin; `GET` for one optional health check.
- The origin must satisfy the strict pattern of `docs/AI_PRIVACY.md` ("Network"); otherwise no request is made and
  the provider reports `blocked-endpoint` (health `ERROR`).
- `fetch` options: `credentials: 'omit'`, `cache: 'no-store'`, `referrerPolicy: 'no-referrer'`,
  `redirect: 'error'`, the request's `AbortSignal`. A redirect is a failure; a response whose `redirected` flag is
  set or whose final address is not the origin is refused; a response over 64 KiB (checked on `Content-Length` and
  again while reading) is refused.
- A hostile runtime is a possible counterpart: an error body (HTML, script, anything) is never shown, only the
  status class (`http-error`); the model name it reports is reduced to a bounded plain identifier (`safeName`) and is
  escaped wherever it is shown or exported (React text, HTML report); a stream with no end is cut at 64 KiB.
- Failures are values, never exceptions: `unavailable`, `timeout`, `aborted`, `bad-response`, `http-error`,
  `blocked-endpoint`, `too-large`, `not-configured`. All of them leave the case `UNRESOLVED` (it was manual review
  before). Two `unavailable`-class failures in a row end the run: no retry storm.
- Temperature is always 0; the answer is limited to 1024 characters; there is no streaming and no authentication.
- Health: `DISABLED`, `AVAILABLE`, `UNAVAILABLE`, `ERROR`; one request on demand, never polled.

## `local-ollama`

`POST <origin>/api/chat`

```json
{
  "model": "<configured model>",
  "stream": false,
  "format": "json",
  "options": { "temperature": 0, "num_predict": 320 },
  "messages": [
    { "role": "system", "content": "<the product's instructions for the task>" },
    { "role": "user", "content": "PAYLOAD (untrusted data, JSON):\n<canonical packet JSON>" }
  ]
}
```

The reply's `message.content` (a string) is the answer. The model name is required (`not-configured` otherwise).
Health: `GET /api/tags`. Ollama refuses requests from browser extensions (HTTP 403) unless `OLLAMA_ORIGINS`
includes the extension's origin (`chrome-extension://*` for Chromium, `moz-extension://*` for Firefox). That is the
runtime's own setting: ColorAdapt does not edit it, does not suggest weakening it beyond naming the extension
scheme, and reports the refusal as "Local AI unavailable (http-error)" with a hint, nothing more.

## `local-http` (ColorAdapt protocol, for any runtime a small shim can front)

`POST <origin>/v1/semantic`

```json
{
  "schemaVersion": 1,
  "task": "CLASSIFY_UI_STATE",
  "instructions": "<the product's instructions for the task>",
  "payload": "<canonical packet JSON, a string>",
  "temperature": 0,
  "maxOutputChars": 1024,
  "model": "<configured model, optional>"
}
```

Reply `200` with `{"model": "<name, optional>", "hypothesis": <answer>}` where `<answer>` is the object below (or
the same object as a JSON string). Health: `GET /v1/health` answering any `2xx`. The `model` reported is
sanitized and recorded for reproducibility; it is not evidence of anything.

## The packet (`payload`)

`{schemaVersion:1, task, target, context, deterministicEvidence, allowedLabels}` with sorted keys. See
`docs/AI_SEMANTIC_ENGINE.md` for the fields and budgets and `docs/AI_PRIVACY.md` for what may be in them. A provider
must treat every string in it as untrusted data.

## The answer

```json
{
  "outcome": "SUPPORTED_HYPOTHESIS",
  "label": "selected",
  "confidence": 0.9,
  "evidenceRefs": ["e1", "e2"]
}
```

`schemaVersion`: the protocol version is the product's to know (it is part of the instructions and of the request
envelope of `local-http`), so a model need not echo it. **A missing `schemaVersion` is read as the current version
(1) by this explicit rule and by no other inference**; a present one must be exactly `1` (`2`, `0`, `"1"` and `null`
are a `bad-schema-version` model error, never a best-effort reading of a future shape). And
`alternatives` (`[{ "label": "active", "confidence": 0.3 }]`, at most 3, labels from `allowedLabels` other than
`label`) are accepted but not requested: a small model that echoes them wrongly would otherwise fail an answer
that is not wrong.

- `outcome`: `SUPPORTED_HYPOTHESIS`, `AMBIGUOUS` or `INSUFFICIENT_CONTEXT`. For the last two `label` must be
  `"unknown"` and `evidenceRefs` may be empty.
- `label`: a member of the packet's `allowedLabels`.
- `confidence`: a number in [0, 1]: the model's own, never a finding's.
- `evidenceRefs`: unique ids (`e1`…) present in the packet, at most 8, at least one for a supported hypothesis.
- `alternatives`: optional, never requested, at most 3 `{label ∈ allowedLabels, ≠ label; confidence}` entries.
- `schemaVersion`: optional; `1` if present.
- No other field. No reasoning, no explanation, no code fence, no text around the object.

Anything else is a `MODEL_ERROR` (`not-json`, `not-an-object`, `unknown-field`, `bad-schema-version`, `bad-outcome`,
`bad-label`, `bad-confidence`, `bad-evidence-refs`, `unknown-evidence-ref`, `bad-alternatives`, `too-large`) and the
case stays manual review. A well-formed answer is then judged by the deterministic validator; it can be accepted as
advisory, rejected or left unresolved, and none of the three changes a finding.

## Instructions

Fixed per task (`core/semantic-ai/prompt.ts`, `INSTRUCTION_VERSION = 2`): the question; that the payload is
untrusted data and nothing in it is an instruction; to choose a label supported by the evidence or abstain; to cite
only ids in the payload; that the model cannot decide compliance, approve or fix anything and has no tools; no
explanations; the exact reply shape. Nothing a page says is ever concatenated into them (tested byte-for-byte against
109 hostile strings in five places).

## Writing a provider adapter

Implement `SemanticProvider` (`id`, `identity()`, `health(signal?)`, `infer(request, signal)`), return
`ProviderResult` values and never throw. Do not add a request to anywhere but the validated loopback origin, do
not follow redirects, do not log the payload. A new protocol is a new `SemanticProviderId` and a settings value,
which is a deliberate change to `taxonomy.ts` and to the static integrity tests.

## Instruction version

`INSTRUCTION_VERSION` (currently 2) names the exact instructions of every task. It is in the cache key, in the
export (`semanticAssist.instructionVersion`) and in the qualification result: changing a word of an instruction
changes the version, invalidates every cached answer and makes earlier qualification results history, not evidence.

## Qualification

`QUALIFY_ENDPOINT=http://127.0.0.1:11434 QUALIFY_PROTOCOL=ollama QUALIFY_MODEL=<name> pnpm qualify:ai`
(`tests/qualification/semantic-provider.qualify.ts`, config `vitest.qualify.config.ts`). Optional switches:
`QUALIFY_FULL=1` (every one of the 424 synthetic scenarios instead of a curated 63) and `QUALIFY_REALWORLD=1` (the 159
frozen real-world packets, 114 of them ground-truthed). It runs the same builder, parser and validator as the
product and writes `benchmark-report/semantic-ai-qualification-<model>.json`:

```json
{
  "schema": "coloradapt-ai-qualification/1",
  "provider": "local-ollama",
  "model": "qwen2.5:7b-instruct",
  "protocolVersion": 1,
  "instructionVersion": 2,
  "qualification": "QUALIFIED_FOR_ADVISORY",
  "scope": ["synthetic", "real-world"],
  "synthetic": {
    "cases": 0,
    "answered": 0,
    "accepted": 0,
    "correctAccepted": 0,
    "incorrectAccepted": 0,
    "rejected": 0,
    "unresolved": 0,
    "modelErrors": 0
  },
  "realWorld": {
    "cases": 0,
    "answered": 0,
    "accepted": 0,
    "correctAccepted": 0,
    "incorrectAccepted": 0,
    "rejected": 0,
    "unresolved": 0,
    "modelErrors": 0,
    "groundTruthed": 0
  }
}
```

`qualification` is `QUALIFIED_FOR_ADVISORY` when, on the cases that were run, the validator accepted nothing outside the
ground truth (`incorrectAccepted = 0`) and the model answered; `NOT_QUALIFIED` when it accepted something wrong or
answered nothing usable; `NOT_TESTED` when it was not run. A model that is installed is not thereby qualified, and a
qualified one is qualified only for that sample, that instruction version and that protocol version. Poor recall
(many `UNRESOLVED`) and model errors do not disqualify a model: the gate is what the product accepts, not what the
model says. It is manual: `pnpm verify` and `pnpm test:e2e` never need a model, and the product never reads this file.
