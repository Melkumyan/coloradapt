import { describe, expect, it } from 'vitest';
import {
  createAuditReport,
  renderAuditHtml,
  serializeAuditReport,
  type AuditSemanticAssistEntry,
} from '@core/audit';
import {
  LocalSemanticProvider,
  MockSemanticProvider,
  SemanticAssistEngine,
  assistReport,
  buildProviderRequest,
  canonicalPacket,
  entryOf,
  type AssistOutcome,
  type FetchLike,
  type ProviderRequest,
  type SemanticQuery,
} from '@core/semantic-ai';
import { DEUTAN, mountAudit } from './kit';

/**
 * M11.R1 input-privacy fuzzing (docs/AI_PRIVACY.md). Page content that looks private (an address, a
 * number, a token, a value the user typed) must not reach a packet, a request body, the cache, an
 * export or a log. Every secret here is a unique canary, so a leak anywhere is a plain string match.
 */

const PII: [string, string][] = [
  ['email', 'jane.canary+tag@example-canary.org'],
  ['phone', '+7 (916) 555-01-42'],
  ['account', '4111 1111 1111 1111'],
  ['long-number', '1234567890123456'],
  ['uuid', '3f2b8c1e-9d4a-4e6b-8a7c-1d2e3f4a5b6c'],
  ['api-token', 'sk-live-AbCdEf0123456789AbCdEf0123456789'],
  [
    'jwt',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1rwW1gFWFOEjXk',
  ],
  ['opaque', 'a8Fk29xQmZ4rT7vB1nL0pW3yC6hD'],
  ['hex-hash', '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'],
];
const RAW = PII.map(([, value]) => value);
/** Fragments that identify the secret even when partly redacted. */
const FRAGMENTS = [
  'jane.canary',
  'example-canary',
  '555-01-42',
  '4111',
  '1234567890123456',
  '3f2b8c1e',
  'sk-live',
  'eyJhbGci',
  'a8Fk29xQ',
  '9f86d081',
];

const TYPED = {
  email: 'typed.canary@example-typed.org',
  password: 'P4ssw0rd-CANARY-typed',
  address: '221B Baker Street CANARY-ADDRESS',
  search: 'search-CANARY-query',
  textarea: 'textarea-CANARY-body private',
  editable: 'editable-CANARY-text',
  hidden: 'hidden-CANARY-token-7788',
  select: 'select-CANARY-option',
  number: 'number-CANARY-4242',
};
const TYPED_VALUES = Object.values(TYPED);
const TYPED_FRAGMENTS = ['CANARY', 'typed.canary', 'P4ssw0rd', 'Baker Street'];

const INVISIBLE = ['‮', '‭', '⁦', '⁩', '​', '‌', '‍', '⁠', '﻿'];

const CSS = `
  .pill { display: inline-block; width: 12px; height: 12px; border-radius: 6px; }
  .pill.is-error { background: #c62828; }
  .pill.is-success { background: #2e7d32; }
  body { margin: 0; background: #fff; color: #111; }
`;

/** Ambiguous pills with a private-looking name each, in the middle of a form full of private values. */
function markup(): string {
  const pills = PII.map(
    ([key, value], i) =>
      `<li><span id="pii-${key}" class="pill ${i % 2 ? 'is-error' : 'is-success'}" aria-label="Status ${value}"></span> <span>${value}</span></li>`,
  ).join('');
  const bidi = `<li><span id="bidi" class="pill is-error" aria-label="${INVISIBLE.join('')}Deploy${INVISIBLE.join('')}ok"></span> <span>Bid${INVISIBLE[0]}i</span></li>`;
  return `
    <form id="f" action="https://example.test/post?token=URLCANARY#frag-CANARY">
      <label for="e">Email</label><input id="e" type="email" value="${TYPED.email}">
      <label for="p">Password</label><input id="p" type="password" value="${TYPED.password}">
      <label for="a">Address</label><input id="a" type="text" autocomplete="street-address" value="${TYPED.address}">
      <input type="search" value="${TYPED.search}" aria-label="Search">
      <input type="hidden" name="csrf" value="${TYPED.hidden}">
      <input type="number" value="${TYPED.number}">
      <select><option selected>${TYPED.select}</option></select>
      <textarea>${TYPED.textarea}</textarea>
      <div contenteditable="true" role="textbox">${TYPED.editable}</div>
      <input id="err" class="pill is-error" type="text" aria-label="Token ${TYPED.email}" value="${TYPED.password}">
      <ul aria-label="Services">${pills}${bidi}</ul>
    </form>`;
}

function pageCases() {
  const rig = mountAudit(markup(), { css: CSS, settings: DEUTAN });
  const snapshot = rig.run();
  const response = rig.audit.semanticCases({ includeIds: [] });
  return { rig, snapshot, response };
}

function scan(text: string, secrets: readonly string[], where: string): void {
  for (const secret of secrets) expect(text, `${where}: ${secret}`).not.toContain(secret);
}

describe('input privacy: packets', () => {
  const { response } = pageCases();
  const packets = response.cases.map((c) => canonicalPacket(c.bound.query));
  const all = packets.join('\n');

  it('asks about the ambiguous pills (so the checks below are not vacuous)', () => {
    expect(response.cases.length).toBeGreaterThan(0);
    expect(all.length).toBeGreaterThan(100);
  });

  it('carries no typed value, hidden value, URL or query, whatever sits next to the target', () => {
    scan(all, TYPED_VALUES, 'packet');
    scan(all, TYPED_FRAGMENTS, 'packet');
    scan(
      all,
      ['URLCANARY', 'example.test', 'https://', 'http://', 'frag-', 'csrf', 'street-address'],
      'packet',
    );
  });

  it('redacts private-looking page text: addresses, numbers, tokens, JWTs, opaque ids', () => {
    scan(all, RAW, 'packet');
    scan(all, FRAGMENTS, 'packet');
  });

  it('strips bidirectional and zero-width characters', () => {
    for (const ch of INVISIBLE) expect(all.includes(ch), JSON.stringify(ch)).toBe(false);
  });

  it('never reads the peers of a form field as text', () => {
    for (const c of response.cases) {
      const q = c.bound.query;
      if (q.target.tag === 'input') {
        expect(q.target.accessibleName).toBeNull();
        for (const peer of q.context.peers) expect(peer.name).toBeNull();
      }
    }
  });

  it('keeps every private-looking name out of the packet it describes, not only out of the corpus', () => {
    for (const c of response.cases) {
      const text = canonicalPacket(c.bound.query);
      for (const secret of [...RAW, ...TYPED_VALUES]) expect(text).not.toContain(secret);
    }
  });
});

describe('input privacy: request bodies, caches, exports', () => {
  /** A model that answers with a label and cites what it was shown. */
  const answerFor = (request: ProviderRequest): string => {
    const query = JSON.parse(request.payload) as SemanticQuery;
    const label = query.allowedLabels[0] ?? 'unknown';
    return JSON.stringify({
      schemaVersion: 1,
      outcome: 'SUPPORTED_HYPOTHESIS',
      label,
      confidence: 0.95,
      evidenceRefs: query.deterministicEvidence.slice(0, 2).map((e) => e.id),
    });
  };

  async function runAll() {
    const { snapshot, response } = pageCases();
    const provider = new MockSemanticProvider({ respond: answerFor, model: 'canary-check' });
    const engine = new SemanticAssistEngine(provider);
    const queries = new Map(response.cases.map((c) => [c.findingId, c]));
    const entries: AuditSemanticAssistEntry[] = [];
    const outcomes: AssistOutcome[] = [];
    const summary = await engine.run(
      response.cases.map((c) => ({ id: c.findingId, bound: c.bound, priority: c.priority })),
      {
        isCurrent: () => true,
        onResult: (outcome) => {
          outcomes.push(outcome);
          const asked = queries.get(outcome.id);
          const entry = asked && entryOf(outcome, asked.bound.query, asked);
          if (entry) entries.push(entry);
        },
      },
    );
    const report = assistReport({
      coverage: summary.coverage,
      provider: provider.identity(),
      stats: summary.stats,
      entries,
    });
    return { snapshot, response, provider, outcomes, report };
  }

  it('sends the provider only sanitized packets (mock requests)', async () => {
    const { provider } = await runAll();
    expect(provider.requests.length).toBeGreaterThan(0);
    for (const request of provider.requests) {
      const text = `${request.instructions}\n${request.payload}`;
      scan(text, [...RAW, ...TYPED_VALUES, ...FRAGMENTS, ...TYPED_FRAGMENTS], 'request');
      scan(text, ['URLCANARY', 'https://', 'http://', 'cookie', 'localStorage'], 'request');
    }
  });

  it('puts only sanitized packets on the wire of both protocols (captured POST bodies)', async () => {
    const { response } = await runAll();
    const bodies: string[] = [];
    const capture: FetchLike = (_input, init) => {
      if (init.body) bodies.push(init.body);
      return Promise.resolve(new Response('{}'));
    };
    for (const protocol of ['local-http', 'local-ollama'] as const) {
      const provider = new LocalSemanticProvider({
        protocol,
        endpoint: 'http://127.0.0.1:11434',
        model: 'm',
        fetch: capture,
      });
      for (const c of response.cases)
        await provider.infer(buildProviderRequest(c.bound.query), new AbortController().signal);
    }
    expect(bodies.length).toBe(response.cases.length * 2);
    for (const body of bodies)
      scan(
        body,
        [...RAW, ...TYPED_VALUES, ...FRAGMENTS, ...TYPED_FRAGMENTS, 'URLCANARY', 'example.test'],
        'body',
      );
  });

  it('keeps interpreted outcomes (what the cache holds) free of page text', async () => {
    const { outcomes } = await runAll();
    for (const outcome of outcomes) {
      scan(
        JSON.stringify(outcome.interpreted),
        [...RAW, ...TYPED_VALUES, ...FRAGMENTS],
        'cache entry',
      );
    }
  });

  it('exports no page secret, in JSON or HTML, and no prompt or raw answer', async () => {
    const { snapshot, report } = await runAll();
    const json = serializeAuditReport(createAuditReport(snapshot, 1, report));
    const html = renderAuditHtml(createAuditReport(snapshot, 1, report));
    for (const [name, text] of [
      ['json', json],
      ['html', html],
    ] as const) {
      scan(text, [...RAW, ...TYPED_VALUES, ...FRAGMENTS, ...TYPED_FRAGMENTS], name);
      scan(
        text,
        ['URLCANARY', 'PAYLOAD (untrusted', 'You are a classifier', 'allowedLabels'],
        name,
      );
    }
    const section = (JSON.parse(json) as { semanticAssist: object }).semanticAssist;
    expect(JSON.stringify(section)).not.toMatch(/instructions|payload|rawResponse|prompt/i);
  });
});
