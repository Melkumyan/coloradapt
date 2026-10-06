import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { parseCsp, splitWhitespace } from '../../realworld/lib/csp';
import {
  onlyForDocument,
  parseDocumentIdentity,
  sameDocument,
} from '../../realworld/lib/document-identity';
import { normalizeError, normalizeErrorSource, toError } from '../../realworld/lib/errors';

/**
 * M10.R1: the bugs the M10 harness already had must never come back. Each one made real-world numbers
 * wrong without any test failing.
 */
const ROOT = path.resolve(import.meta.dirname, '..', '..');

/** Escapes a template literal keeps: everything else (`\s`, `\d`, `\b`, ...) is eaten by the cooked string. */
const HARMLESS = new Set(['n', 't', 'r', 'f', 'v', '0', '\\', '`', '$', "'", '"', 'x', 'u', '\n']);

/** Backslash escapes in the raw text of a template literal that the cooked string would silently drop. */
function eatenEscapes(raw: string): string[] {
  const bad: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '\\') continue;
    const next = raw[i + 1] ?? '';
    if (!HARMLESS.has(next)) bad.push(`\\${next}`);
    i++;
  }
  return bad;
}

/** Untagged template literals of a source text, with their line. `String.raw` and other tags are fine. */
function templates(file: string, text: string): Array<{ where: string; raw: string }> {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const out: Array<{ where: string; raw: string }> = [];
  const tagged = (node: ts.Node): boolean => {
    let current: ts.Node | undefined = node.parent;
    while (current && (ts.isTemplateExpression(current) || ts.isTemplateSpan(current))) {
      current = current.parent;
    }
    return current !== undefined && ts.isTaggedTemplateExpression(current);
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      if (!tagged(node)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
        out.push({ where: `${path.relative(ROOT, file)}:${line + 1}`, raw: node.rawText ?? '' });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name.startsWith('.')) return [];
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

describe('regex escapes inside template strings (the /\\s+/ -> /s+/ bug)', () => {
  it('no harness template string carries an escape that the string itself would eat', () => {
    const files = sources(path.join(ROOT, 'realworld'));
    expect(files.length).toBeGreaterThan(10);
    const bad = files.flatMap((file) =>
      templates(file, readFileSync(file, 'utf8')).flatMap((t) =>
        eatenEscapes(t.raw).map((escape) => `${t.where}: ${escape}`),
      ),
    );
    expect(bad).toEqual([]);
  });

  it('the guard catches the original bug and accepts the right spellings', () => {
    const original = 'const s = `x.split(/' + '\\' + 's+/)`;';
    const escaped = 'const s = `x.split(/' + '\\\\' + 's+/)`;';
    const raw = 'const s = String.raw`x.split(/' + '\\' + 's+/)`;';
    const found = (code: string) =>
      templates('virtual.ts', code).flatMap((t) => eatenEscapes(t.raw));
    expect(found(original)).toEqual(['\\s']);
    expect(found(escaped)).toEqual([]);
    expect(found(raw)).toEqual([]);
  });

  it('page-side source that the harness builds contains no regular expression that can be mangled', () => {
    // the CSP reader is the one that was broken: it must not live in a page string any more
    const pageRun = readFileSync(path.join(ROOT, 'realworld', 'lib', 'page-run.ts'), 'utf8');
    expect(pageRun).not.toContain('split(/');
    expect(pageRun).toContain('parseCsp(');
  });
});

describe('CSP facts are parsed in Node', () => {
  it('splits on any run of whitespace, not on the letter s', () => {
    expect(splitWhitespace("style-src   'self'\t'unsafe-inline'\n")).toEqual([
      'style-src',
      "'self'",
      "'unsafe-inline'",
    ]);
    expect(splitWhitespace('a  s  b')).toEqual(['a', 's', 'b']);
  });

  it('reads directives from the header and from meta policies', () => {
    const facts = parseCsp("default-src 'self'; script-src  'self'", ['img-src data:']);
    expect(facts.cspDirectives).toEqual(['default-src', 'script-src', 'img-src']);
    expect(facts.cspStyleInlineBlocked).toBe(false);
  });

  it('inline styles are blocked only by a style-src without unsafe-inline', () => {
    expect(parseCsp("style-src 'self'", []).cspStyleInlineBlocked).toBe(true);
    expect(parseCsp("style-src 'self' 'unsafe-inline'", []).cspStyleInlineBlocked).toBe(false);
    expect(
      parseCsp("style-src-elem 'self'; style-src 'unsafe-inline'", []).cspStyleInlineBlocked,
    ).toBe(true);
    expect(parseCsp("default-src 'self'", []).cspStyleInlineBlocked).toBe(false);
    expect(parseCsp('', []).cspDirectives).toEqual([]);
  });

  it('a header with several policies is read policy by policy', () => {
    expect(parseCsp("script-src 'self', style-src 'none'", []).cspDirectives).toEqual([
      'script-src',
      'style-src',
    ]);
  });
});

describe('one normalized error model for both browsers', () => {
  it('a Chrome-style Error', () => {
    expect(normalizeError(new Error('boom'))).toMatchObject({ name: 'Error', message: 'boom' });
  });

  it('a Firefox-style error: the stack has frames only, the text comes from `message`', () => {
    const firefox = {
      name: 'TypeError',
      message: 'x is not a function',
      stack: 'f@moz-extension://id/a.js:1:2\ng@moz-extension://id/a.js:3:4',
    };
    const n = normalizeError(firefox);
    expect(n.message).toBe('x is not a function');
    expect(n.name).toBe('TypeError');
    expect(n.stack).toContain('f@moz-extension');
    expect(n.stack).not.toContain('x is not a function');
  });

  it('a rejection that is not an Error (a string, a plain object, null, undefined)', () => {
    expect(normalizeError('plain')).toEqual({ name: 'Error', message: 'plain' });
    expect(normalizeError({ message: 'from runtime' }).message).toBe('from runtime');
    expect(normalizeError({ code: 7 }).message).toBe('{"code":7}');
    expect(normalizeError(null).message).toBe('null');
    expect(normalizeError(undefined).message).toBe('undefined');
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(normalizeError(circular).message).toBe('[object Object]');
  });

  it('only the first line and a bounded length survive', () => {
    expect(normalizeError(new Error('a\nb')).message).toBe('a');
    expect(normalizeError('x'.repeat(1000)).message).toHaveLength(300);
  });

  it('the same source runs in a page: it is self-contained', () => {
    // the page receives this exact source as text; evaluating it here proves it needs nothing from this module
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const inPage = new Function(`return (${normalizeErrorSource})`)() as typeof normalizeError;
    expect(inPage({ name: 'E', message: 'm', stack: 's' })).toEqual({
      name: 'E',
      message: 'm',
      stack: 's',
    });
    expect(inPage('plain').message).toBe('plain');
  });

  it('rebuilds an Error whose message is the normalized one', () => {
    const e = toError({ name: 'TypeError', message: 'bad' });
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe('bad');
    expect(e.name).toBe('TypeError');
  });
});

describe('a measurement never mixes two documents (navigation race)', () => {
  const id = (origin: string, href: string) => parseDocumentIdentity(`${origin}|${href}|complete`);

  it('compares time origin and address', () => {
    expect(sameDocument(id('1', 'https://a/'), id('1', 'https://a/'))).toBe(true);
    expect(sameDocument(id('1', 'https://a/'), id('2', 'https://a/'))).toBe(false);
    expect(sameDocument(id('1', 'https://a/'), id('1', 'https://a/x'))).toBe(false);
  });

  it('keeps the result of a measurement on the same document', async () => {
    const result = await onlyForDocument(
      () => Promise.resolve(id('1', 'https://a/')),
      id('1', 'https://a/'),
      () => Promise.resolve(42),
    );
    expect(result).toEqual({ stale: false, value: 42 });
  });

  it('discards a result when the document was replaced while measuring', async () => {
    let now = id('1', 'https://a/');
    const result = await onlyForDocument(
      () => Promise.resolve(now),
      id('1', 'https://a/'),
      () => {
        now = id('2', 'https://a/');
        return Promise.resolve('audit of the old document');
      },
    );
    expect(result).toEqual({ stale: true });
  });

  it('does not even start when the document is already another one', async () => {
    let started = false;
    const result = await onlyForDocument(
      () => Promise.resolve(id('2', 'https://a/')),
      id('1', 'https://a/'),
      () => {
        started = true;
        return Promise.resolve(1);
      },
    );
    expect(result).toEqual({ stale: true });
    expect(started).toBe(false);
  });
});
