import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * M10 static source integrity. ColorAdapt must not change how a page navigates or runs, and must not reach the
 * network beyond what the page itself loads. These checks read the source, not the built bundle (the built
 * bundles are checked by `realworld/dist.spec.ts`), and they say *where* a match is when one appears.
 *
 * The History API is deliberately checked statically: a runtime check such as `Function.prototype.toString()`
 * cannot say whose wrapper a patched `pushState` is.
 */
const SRC = path.resolve(import.meta.dirname, '..', '..', 'src');

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...files(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const SOURCES = files(SRC).map((file) => ({
  file: path.relative(SRC, file).replace(/\\/g, '/'),
  text: readFileSync(file, 'utf8'),
}));

function find(pattern: RegExp): string[] {
  return SOURCES.filter(({ text }) => pattern.test(text)).map(({ file }) => file);
}

describe('M10 static source integrity', () => {
  it('has source files to scan', () => {
    expect(SOURCES.length).toBeGreaterThan(50);
  });

  it('never patches, wraps or calls the History API', () => {
    expect(find(/\b(pushState|replaceState)\b/)).toEqual([]);
    expect(find(/history\s*\.\s*(back|forward|go)\s*\(/)).toEqual([]);
    expect(find(/History\.prototype/)).toEqual([]);
    expect(find(/\b(browser|chrome)\.history\b/)).toEqual([]);
  });

  it('never evaluates strings as code', () => {
    expect(find(/\beval\s*\(/)).toEqual([]);
    expect(find(/new\s+Function\s*\(/)).toEqual([]);
    expect(find(/setTimeout\s*\(\s*['"`]/)).toEqual([]);
    expect(find(/document\s*\.\s*write(ln)?\s*\(/)).toEqual([]);
  });

  it('uses the network only to read the page’s own images (M8) and to reach the loopback model (M11)', () => {
    expect(find(/\bXMLHttpRequest\b/)).toEqual([]);
    expect(find(/\bWebSocket\b/)).toEqual([]);
    expect(find(/\bEventSource\b/)).toEqual([]);
    expect(find(/sendBeacon/)).toEqual([]);
    // M11: the local provider's transport is the only other place a request is made (loopback only,
    // enforced there and pinned by tests/core/semantic-ai/*.test.ts and m11-integrity.test.ts).
    expect(find(/\bfetch\s*\(/)).toEqual([
      'core/semantic-ai/local-provider.ts',
      'features/images/raster-reader.ts',
    ]);
  });

  it('keeps nothing in page-visible storage and never touches cookies', () => {
    expect(find(/\b(localStorage|sessionStorage|indexedDB)\b/)).toEqual([]);
    expect(find(/document\s*\.\s*cookie/)).toEqual([]);
    expect(find(/\bcookies\b\s*\./)).toEqual([]);
  });

  it('does not rewrite the page’s accessibility attributes', () => {
    // ColorAdapt adds its own `data-coloradapt-*` attributes only. It must not set ARIA, roles, ids, tab order or names.
    const writes =
      /\.(setAttribute|removeAttribute)\s*\(\s*['"`](aria-[a-z]+|role|id|tabindex|name|alt|title|lang|dir)['"`]/g;
    const hits = SOURCES.flatMap(({ file, text }) =>
      [...text.matchAll(writes)].map((m) => `${file}: ${m[0]}`),
    );
    // The one allowed write labels the audit's own highlight box (a node ColorAdapt creates, hidden from
    // assistive technology on purpose), never an element of the page.
    const highlighter = SOURCES.find(({ file }) => file === 'features/audit/highlighter.ts')!;
    expect(highlighter.text).toMatch(
      /const box = this\.#doc\.createElement\('div'\);\s*box\.setAttribute\(AUDIT_OVERLAY_ATTRIBUTE/,
    );
    expect(hits.filter((hit) => !hit.startsWith('features/audit/highlighter.ts'))).toEqual([]);
  });
});
