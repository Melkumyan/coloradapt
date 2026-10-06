import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * M11.R1 static gates over the whole of the AI-assisted review's code: the network sink is one place,
 * nothing it does can execute text or write the page, and no wording claims an authority it does not
 * have (docs/SECURITY.md, "M11"). Scoped to the AI modules: other systems legitimately use some APIs.
 */
const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src');

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...files(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const rel = (file: string): string => path.relative(SRC, file).replace(/\\/g, '/');
const read = (name: string) => ({ file: name, text: readFileSync(path.join(SRC, name), 'utf8') });

/** Every file that is part of the AI-assisted review. */
const REVIEW_FILES = [
  ...files(path.join(SRC, 'core', 'semantic-ai')).map(rel),
  'core/audit/semantic-assist.ts',
  'features/audit/semantic-facts.ts',
  'entrypoints/audit/use-semantic-assist.ts',
  'entrypoints/audit/assist-components.tsx',
];
const REVIEW = REVIEW_FILES.map(read);
/** The part that reads the page: it must be read-only. */
const PAGE_SIDE = [read('features/audit/semantic-facts.ts')];
/** The part that renders: React escapes; nothing may opt out. */
const RENDER = [
  read('entrypoints/audit/assist-components.tsx'),
  read('core/audit/semantic-assist.ts'),
];

const find = (pattern: RegExp, among = REVIEW): string[] =>
  among.filter(({ text }) => pattern.test(text)).map(({ file }) => file);

describe('network sinks', () => {
  it('has exactly one network call, in the loopback provider', () => {
    expect(find(/\bfetch\s*\(/)).toEqual(['core/semantic-ai/local-provider.ts']);
    expect(
      find(/XMLHttpRequest|\bWebSocket\b|\bEventSource\b|sendBeacon|\bnew\s+Image\s*\(/),
    ).toEqual([]);
    expect(find(/importScripts|\bimport\s*\(|navigator\.serviceWorker|\bpostMessage\b/)).toEqual(
      [],
    );
    expect(find(/browser\.(runtime|tabs)\.(connect|sendMessage)|chrome\.(runtime|tabs)/)).toEqual(
      [],
    );
  });

  it('reaches the provider only through the loopback validator', () => {
    const provider = read('core/semantic-ai/local-provider.ts').text;
    // The only place an origin is built from configuration is the parsed endpoint.
    expect([...provider.matchAll(/\$\{origin\}/g)]).toHaveLength(1);
    expect(provider).toMatch(/const origin = this\.#endpoint\.origin/);
    expect(provider).toMatch(/if \(!this\.#endpoint\.ok\) return/);
    // No other code constructs a URL for a request.
    expect(find(/new\s+URL\s*\(/)).toEqual(['core/semantic-ai/endpoint.ts']);
  });

  it('constructs the provider from the audit page only, never from a content script or a service worker', () => {
    const users = files(SRC)
      .map(rel)
      .filter((file) =>
        /\bLocalSemanticProvider\b|\bcreateSemanticProvider\b/.test(read(file).text),
      )
      .filter((file) => !file.startsWith('core/semantic-ai/'));
    expect(users).toEqual(['entrypoints/audit/use-semantic-assist.ts']);
  });
});

describe('execution and DOM-write sinks', () => {
  it('never evaluates text or loads code', () => {
    expect(
      find(/\beval\s*\(|new\s+Function\s*\(|setTimeout\s*\(\s*['"`]|setInterval\s*\(\s*['"`]/),
    ).toEqual([]);
    expect(find(/createElement\s*\(\s*['"`]script|\.src\s*=|document\.write/)).toEqual([]);
  });

  it('never writes the page: the page-side reader is read-only', () => {
    expect(
      find(
        /innerHTML|outerHTML|insertAdjacentHTML|setAttribute|removeAttribute|classList\.(add|remove|toggle)|\.style\.|setProperty|appendChild|\.append\(|\.prepend\(|\.remove\(\)|replaceWith|dispatchEvent|\.click\(\)|\.focus\(\)|scrollIntoView/,
        PAGE_SIDE,
      ),
    ).toEqual([]);
  });

  it('never opts out of escaping when it renders', () => {
    expect(find(/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML/, RENDER)).toEqual([]);
    // The HTML report escapes every interpolated value.
    const html = read('core/audit/semantic-assist.ts').text;
    const body = html.slice(html.indexOf('export function semanticAssistHtml'));
    const interpolations = [...body.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1] ?? '');
    for (const expression of interpolations) {
      expect(
        /escapeHtml\(|ASSIST_COVERAGE_LABEL\[|ASSIST_STATUS_LABEL\[|^rows$|^support === ''|^s\.\w+$|^scope$|^meaning$|^entry\.(sampled|instances)$|^assist\.entries\.length === 0|^assist\.provider\.(model|id)|\.toFixed\(2\)|^support$|^titles\.get|^entry\.modelConfidence/.test(
          expression.trim(),
        ),
        expression,
      ).toBe(true);
    }
  });
});

describe('authority wording', () => {
  const WORDING = [
    /\bAI (confirmed|proved|proves|verified|determined|certified|detected (a |an )?(violation|failure|issue))\b/i,
    /\bconfirmed by (the )?AI\b/i,
    /\bAI[- ]confirmed\b/i,
    /\bAUTO_FIX\b|\bCONFIRMED_BY_AI\b|\bWCAG_FAIL\b|\bWCAG_PASS\b/,
    /\bAI (fixes|fixed|repairs|repaired)\b/i,
  ];

  it('claims no confirmation, proof, failure or fix in code, UI text or exports', () => {
    for (const pattern of WORDING) expect(find(pattern), String(pattern)).toEqual([]);
  });

  it('claims none in the documents either', () => {
    const docs = [
      'AI_SEMANTIC_ENGINE.md',
      'AI_PRIVACY.md',
      'AI_PROVIDER_PROTOCOL.md',
      'DEVELOPER_AUDIT.md',
    ];
    for (const name of docs) {
      const text = readFileSync(path.join(ROOT, 'docs', name), 'utf8')
        // Documents quote the forbidden words in order to forbid them.
        .split('\n')
        .filter(
          (line) =>
            !/never|not |no |forbid|must not|without|instead of|refus|reject|rather than|are not|is not/i.test(
              line,
            ),
        )
        .join('\n');
      for (const pattern of WORDING) expect(pattern.test(text), `${name} ${pattern}`).toBe(false);
    }
  });

  it('has no status that confirms, fixes or fails anything', () => {
    const taxonomy = read('core/semantic-ai/taxonomy.ts').text;
    expect(taxonomy).toMatch(
      /VALIDATOR_STATUSES = \['ACCEPTED_ADVISORY', 'REJECTED', 'UNRESOLVED'\]/,
    );
    expect(taxonomy).toMatch(
      /MODEL_OUTCOMES = \[\s*'SUPPORTED_HYPOTHESIS',\s*'AMBIGUOUS',\s*'INSUFFICIENT_CONTEXT',?\s*\]/,
    );
  });
});

describe('authority boundary', () => {
  it('the deterministic engine (M1–M10 cores) never imports the AI layer', () => {
    const deterministic = files(path.join(SRC, 'core'))
      .map(rel)
      .filter((file) => !file.startsWith('core/semantic-ai/'))
      .map(read);
    expect(find(/@core\/semantic-ai|semantic-ai\//, deterministic)).toEqual([]);
    const features = files(path.join(SRC, 'features'))
      .map(rel)
      // The audit's own AI bridge (the case collector) is the only feature that knows the AI layer.
      .filter(
        (file) =>
          ![
            'features/audit/collector.ts',
            'features/audit/controller.ts',
            'features/audit/semantic-facts.ts',
            'features/audit/store.ts',
          ].includes(file),
      )
      .map(read);
    expect(find(/@core\/semantic-ai|semantic-ai\//, features)).toEqual([]);
  });

  it('the adaptation, semantics, chart and image pipelines never read an AI setting or result', () => {
    const pipelines = files(SRC)
      .map(rel)
      .filter((file) =>
        /^(features\/(adaptation|semantics|charts|images|page-analysis|dynamic-analysis)|core\/(color|vision|adaptation|semantics|charts|images|simulation|svg))/.test(
          file,
        ),
      )
      .map(read);
    expect(find(/semanticAI|SemanticAssist|semanticAssist|ACCEPTED_ADVISORY/, pipelines)).toEqual(
      [],
    );
  });

  it('the content script answers the AI question with data only: it never applies one', () => {
    const content = read('entrypoints/content.ts').text;
    expect(content).toMatch(/AUDIT_SEMANTIC_CASES/);
    expect(content).not.toMatch(
      /ACCEPTED_ADVISORY|validateHypothesis|parseHypothesis|SemanticAssistEngine/,
    );
  });
});
