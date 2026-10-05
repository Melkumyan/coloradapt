import { describe, expect, it } from 'vitest';
import {
  auditFileName,
  componentClassNames,
  escapeHtml,
  redactSnippet,
  safeName,
  sanitizePageUrl,
  stableHash,
} from '@core/audit';

describe('stableHash', () => {
  it('is deterministic, 16 hex characters, and sensitive to input', () => {
    expect(stableHash('a')).toBe(stableHash('a'));
    expect(stableHash('a')).toMatch(/^[0-9a-f]{16}$/);
    expect(stableHash('a')).not.toBe(stableHash('b'));
    expect(stableHash('ab')).not.toBe(stableHash('ba'));
  });
});

describe('redactSnippet', () => {
  it('collapses whitespace and bounds length', () => {
    expect(redactSnippet('  Save \n\t changes  ')).toBe('Save changes');
    const long = redactSnippet('word '.repeat(50));
    expect(long?.length).toBeLessThanOrEqual(40);
    expect(long?.endsWith('…')).toBe(true);
  });

  it('returns null for nothing', () => {
    expect(redactSnippet('   \n ')).toBeNull();
  });

  it('replaces emails, long numbers and opaque tokens', () => {
    expect(redactSnippet('mail me: jane.doe@example.com')).toBe('mail me: [email]');
    expect(redactSnippet('card 4111 1111 1111 1111 ok')).toBe('card [number] ok');
    expect(redactSnippet('key sk_live_abcdef1234567890abcdef')).toBe('key [token]');
    expect(redactSnippet('id 0123456789abcdef0123')).toBe('id [token]');
  });

  it('keeps short numbers and ordinary words', () => {
    expect(redactSnippet('Step 3 of 5')).toBe('Step 3 of 5');
  });

  it('removes control characters', () => {
    expect(redactSnippet('a\u0000b\u0007c')).toBe('a b c');
  });
});

describe('safeName', () => {
  it('keeps ordinary names and drops anything with unusual characters', () => {
    expect(safeName('btn-primary')).toBe('btn-primary');
    expect(safeName('a b')).toBeNull();
    expect(safeName('x"onload')).toBeNull();
    expect(safeName('')).toBeNull();
    expect(safeName(null)).toBeNull();
  });

  it('replaces names that look like identifiers or secrets', () => {
    expect(safeName('user-48219074')).toBe('[redacted]');
    expect(safeName('3f9a1c2b7d4e8f60a1b2')).toBe('[redacted]');
    expect(safeName('AbCdEf1234567890XyZw')).toBe('[redacted]');
  });

  it('bounds length', () => {
    expect(safeName('z'.repeat(100))?.length).toBe(40);
  });
});

describe('componentClassNames', () => {
  it('drops per-row numbers, hashes and overlong names', () => {
    expect(componentClassNames(['dot', 'row-17', 'css-1x2y3z4', 'x'.repeat(30), 'red'], 3)).toEqual(
      ['dot', 'red'],
    );
  });
});

describe('sanitizePageUrl', () => {
  it('keeps origin and pathname only: no query, no fragment', () => {
    const page = sanitizePageUrl('https://example.test/account?token=SECRET#private');
    expect(page).toEqual({ origin: 'https://example.test', pathname: '/account' });
    expect(JSON.stringify(page)).not.toMatch(/SECRET|private/);
  });

  it('drops credentials', () => {
    const page = sanitizePageUrl('https://user:pass@example.test/x');
    expect(JSON.stringify(page)).not.toMatch(/user|pass/);
  });

  it('keeps a port as part of the origin', () => {
    expect(sanitizePageUrl('http://127.0.0.1:8080/a/b').origin).toBe('http://127.0.0.1:8080');
  });

  it('redacts opaque path segments and path parameters', () => {
    expect(sanitizePageUrl('https://e.test/reset/9f8a7b6c5d4e3f2a1b0c9d8e').pathname).toBe(
      '/reset/:redacted',
    );
    expect(sanitizePageUrl('https://e.test/u/123456789/profile').pathname).toBe(
      '/u/:redacted/profile',
    );
    expect(sanitizePageUrl('https://e.test/p;jsessionid=ABCDEF123456').pathname).toBe('/p');
    expect(sanitizePageUrl('https://e.test/users/jane%40example.com').pathname).toBe(
      '/users/:redacted',
    );
  });

  it('keeps ordinary segments', () => {
    expect(sanitizePageUrl('https://e.test/docs/getting-started/index.html').pathname).toBe(
      '/docs/getting-started/index.html',
    );
  });

  it('gives a neutral page for anything that is not http(s)', () => {
    expect(sanitizePageUrl('file:///C:/secret/report.html')).toEqual({
      origin: 'null',
      pathname: '/',
    });
    expect(sanitizePageUrl('not a url')).toEqual({ origin: 'null', pathname: '/' });
    expect(sanitizePageUrl('data:text/html,<script>')).toEqual({ origin: 'null', pathname: '/' });
  });
});

describe('auditFileName', () => {
  const page = { origin: 'https://Example.test:8443', pathname: '/a?x=1' };

  it('is deterministic and safe', () => {
    expect(auditFileName(page, '2026-10-04T12:00:00.000Z', 'json')).toBe(
      'coloradapt-audit-example.test-2026-10-04.json',
    );
    expect(auditFileName(page, '2026-10-04T12:00:00.000Z', 'html')).toBe(
      'coloradapt-audit-example.test-2026-10-04.html',
    );
  });

  it('never carries a path, query or odd characters', () => {
    expect(auditFileName({ origin: 'null', pathname: '/' }, '2026-01-02T00:00:00Z', 'json')).toBe(
      'coloradapt-audit-page-2026-01-02.json',
    );
    const name = auditFileName(
      { origin: 'https://ex ample/..%2f.test', pathname: '/' },
      '2026-01-02T00:00:00Z',
      'json',
    );
    expect(name).toMatch(/^coloradapt-audit-[a-z0-9.-]+-2026-01-02\.json$/);
  });
});

describe('escapeHtml', () => {
  it('escapes markup, quotes and ampersands', () => {
    expect(escapeHtml('<img src=x onerror="a()"> & \'q\'')).toBe(
      '&lt;img src=x onerror=&quot;a()&quot;&gt; &amp; &#39;q&#39;',
    );
  });
});
