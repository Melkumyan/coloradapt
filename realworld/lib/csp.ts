/**
 * Content-Security-Policy facts the harness records about a page. Parsed in Node from the raw header and
 * `<meta>` text, never in the page: an earlier version built this parser as a template string with `/\s+/`,
 * the backslash was eaten by the string (`/s+/`), and every page's CSP was silently read wrong.
 */
export interface CspFacts {
  readonly cspDirectives: string[];
  readonly cspStyleInlineBlocked: boolean;
}

const isSpace = (ch: string): boolean =>
  ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';

/** Splits on runs of ASCII whitespace; no regular expression. */
export function splitWhitespace(text: string): string[] {
  const out: string[] = [];
  let current = '';
  for (const ch of text) {
    if (isSpace(ch)) {
      if (current !== '') out.push(current);
      current = '';
    } else current += ch;
  }
  if (current !== '') out.push(current);
  return out;
}

export function parseCsp(header: string, metaPolicies: readonly string[]): CspFacts {
  const policies = [header, ...metaPolicies].flatMap((policy) => policy.split(','));
  const directives = policies.flatMap((policy) => policy.split(';')).map((d) => d.trim());
  const names = directives.map((d) => splitWhitespace(d)[0]).filter((n): n is string => !!n);
  const styleSources = directives
    .map((d) => splitWhitespace(d))
    .filter((tokens) => tokens[0] === 'style-src' || tokens[0] === 'style-src-elem')
    // style-src-elem governs a <style> element before style-src does
    .sort((a) => (a[0] === 'style-src-elem' ? -1 : 1))[0];
  return {
    cspDirectives: [...new Set(names.map((n) => n.toLowerCase()))],
    cspStyleInlineBlocked:
      styleSources !== undefined &&
      styleSources.length > 1 &&
      !styleSources.includes("'unsafe-inline'"),
  };
}
