import { describe, expect, it } from 'vitest';
import {
  AUDIT_SCHEMA_VERSION,
  buildSnapshot,
  createAuditReport,
  parseAuditReport,
  redactSnippet,
  renderAuditHtml,
  safeName,
  sanitizePageUrl,
  serializeAuditReport,
  componentClassNames,
} from '@core/audit';
import { candidate, target } from './builders';

const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\u2028\u2029\uD800-\uDFFF]/u;

describe('M9.R1 redactSnippet: hostile and Unicode input', () => {
  const cases: Record<string, string> = {
    'RTL override': 'safe \u202Eevil.exe\u202C text',
    'bidi isolates': 'a \u2066b\u2069 \u2067c\u2069',
    'zero width': 'pa\u200Bss\u200Cwo\u200Drd\uFEFF',
    'line separators': 'one\u2028two\u2029three',
    'lone high surrogate': 'bad \uD800 end',
    'lone low surrogate': 'bad \uDC00 end',
    'null and C0': 'a\u0000b\u0007c\u001bd',
    'combining marks': 'e\u0301\u0301\u0301\u0301 text',
  };
  for (const [name, input] of Object.entries(cases)) {
    it(`leaves no control, format or surrogate character: ${name}`, () => {
      const out = redactSnippet(input);
      if (out !== null) expect(out).not.toMatch(UNSAFE_CHARS);
    });
  }

  it('keeps ordinary emoji and Russian text', () => {
    expect(redactSnippet('Привет 😀 мир')).toBe('Привет 😀 мир');
  });

  it('never splits a surrogate pair when it cuts', () => {
    const out = redactSnippet('😀'.repeat(60)) ?? '';
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(out.length).toBeLessThanOrEqual(40);
  });

  it('bounds 100 KB of text, in linear time, whatever its shape', () => {
    const shapes = [
      'a'.repeat(120_000),
      'ab@'.repeat(40_000),
      '1 '.repeat(60_000),
      `${'x'.repeat(100_000)}@${'y'.repeat(100_000)}`,
      'é'.repeat(100_000),
    ];
    const started = Date.now();
    for (const shape of shapes) {
      const out = redactSnippet(shape);
      expect(out === null || out.length <= 40).toBe(true);
    }
    // Structural, generous: a quadratic regex takes minutes here, a linear one milliseconds.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('replaces e-mail, long numbers and opaque tokens', () => {
    expect(redactSnippet('mail me: user@example.com')).toBe('mail me: [email]');
    expect(redactSnippet('acct 1234 5678 9012')).toBe('acct [number]');
    expect(redactSnippet('t=9f8a7b6c5d4e3f2a1b0c')).not.toContain('9f8a7b6c5d4e3f2a1b0c');
  });
});

describe('M9.R1 safeName / class names: locator privacy fuzz', () => {
  const opaque = [
    'user@example.com',
    '123e4567-e89b-12d3-a456-426614174000',
    'tok_9f8a7b6c5d4e3f2a1b0c9d8e',
    'acct-12345678',
    'account_0042424242',
    'A'.repeat(500),
    'Ünïcode',
    '😀',
    'שלום',
    '\u202Eevil',
    'a b',
    '<script>',
  ];
  for (const name of opaque) {
    it(`never copies an identifier-like or unsafe name: ${JSON.stringify(name.slice(0, 24))}`, () => {
      const out = safeName(name);
      expect(out === null || out === '[redacted]' || /^[A-Za-z0-9_\-:.]{1,40}$/.test(out)).toBe(
        true,
      );
      if (out && out !== '[redacted]') {
        expect(out).not.toMatch(/\d{6,}/);
        expect(out).not.toMatch(/[0-9a-f]{16,}/i);
      }
    });
  }

  it('component class names drop generated and per-row names', () => {
    expect(
      componentClassNames(
        ['btn', 'css-1x2y3z4', 'row-17', 'tok_9f8a7b6c5d4e3f2a1b0c9d8e', 'primary'],
        3,
      ),
    ).toEqual(['btn', 'primary']);
  });
});

describe('M9.R1 URL privacy fuzz', () => {
  const urls: Array<[string, string]> = [
    ['https://example.test/a?token=SECRET', 'SECRET'],
    ['https://example.test/a?email=user@example.com', 'user@example.com'],
    ['https://example.test/a?session=abcdef0123456789', 'abcdef0123456789'],
    ['https://example.test/a#private-fragment', 'private-fragment'],
    ['https://user:p4ssw0rd@example.test/a', 'p4ssw0rd'],
    ['https://user@example.test/a', 'user@'],
    ['https://example.test/reset/9f8a7b6c5d4e3f2a1b0c9d8e', '9f8a7b6c5d4e3f2a'],
    ['https://example.test/u/123e4567-e89b-12d3-a456-426614174000', '123e4567'],
    ['https://example.test/account/00424242424', '00424242424'],
    ['https://example.test/a;jsessionid=SECRETSESSION', 'SECRETSESSION'],
    ['https://example.test/%75ser@example.com/x', 'example.com'],
    ['https://example.test:8443/a?x=1#y', 'x=1'],
  ];
  for (const [url, secret] of urls) {
    it(`keeps no secret from ${url}`, () => {
      const page = sanitizePageUrl(url);
      const text = `${page.origin}${page.pathname}`;
      expect(text).not.toContain(secret);
      expect(text).not.toMatch(/[?#]/);
      expect(page.origin).not.toMatch(/@/);
      expect(page.pathname.startsWith('/')).toBe(true);
    });
  }

  it('reports non-web pages as an opaque null origin', () => {
    for (const url of ['file:///C:/secret/report.html', 'data:text/html,<b>x', 'not a url', '']) {
      expect(sanitizePageUrl(url)).toEqual({ origin: 'null', pathname: '/' });
    }
  });

  it('keeps ordinary readable paths', () => {
    expect(sanitizePageUrl('https://example.test/docs/guide/intro').pathname).toBe(
      '/docs/guide/intro',
    );
  });
});

const hostileStrings = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '</style><script>alert(1)</script>',
  '"><svg onload=alert(1)>',
  '&lt;script&gt;alert(1)&lt;/script&gt;',
  '&#60;script&#62;alert(1)',
  '%3Cscript%3Ealert(1)%3C/script%3E',
  '\\u003cscript\\u003e',
  'javascript:alert(1)',
  '<!--',
  ']]>',
  "' onmouseover='alert(1)",
  '\u202E<script>',
  '<scr\u200Bipt>alert(1)</scr\u200Bipt>',
];

function hostileSnapshot(text: string) {
  return buildSnapshot({
    candidates: [
      candidate({
        summary: text,
        target: target(`html>body>p:nth-of-type(1)`, 'p', {
          text: redactSnippet(text),
          classes: componentClassNames([text], 3),
          id: safeName(text),
        }),
        evidence: [
          { key: 'x', basis: 'observed-fact', label: text, value: { kind: 'text', text } },
        ],
      }),
    ],
    generation: 1,
    timestamp: 1,
    page: sanitizePageUrl(`https://example.test/${encodeURIComponent(text)}?q=${text}#${text}`),
    extensionVersion: '0.1.0',
    settings: {
      activeProfile: 'deuteranopia',
      auditedProfiles: ['deuteranopia'],
      adaptationEnabled: false,
    },
    coverage: {
      elementsAnalyzed: 1,
      analysisTruncated: false,
      semanticCandidates: 0,
      svgUnits: 0,
      charts: 0,
      canvases: 0,
      images: 0,
    },
  }).snapshot;
}

describe('M9.R1 hostile page-derived strings in the exports', () => {
  for (const text of hostileStrings) {
    it(`JSON stays data and HTML stays inert: ${JSON.stringify(text.slice(0, 28))}`, () => {
      const report = createAuditReport(hostileSnapshot(text), 1);
      const json = serializeAuditReport(report);
      expect(() => {
        JSON.parse(json);
      }).not.toThrow();
      const html = renderAuditHtml(report);
      // No element or attribute can be created by page text: every `<` of the page is escaped.
      const tags = [...html.matchAll(/<([a-zA-Z!][^\s>/]*)/g)].map((m) => m[1]?.toLowerCase());
      const allowed = new Set([
        '!doctype',
        'html',
        'head',
        'meta',
        'title',
        'style',
        'body',
        'h1',
        'h2',
        'h3',
        'p',
        'table',
        'thead',
        'tbody',
        'tr',
        'th',
        'td',
        'span',
        'details',
        'summary',
        'dl',
        'dt',
        'dd',
        'code',
        'ul',
        'li',
      ]);
      for (const tag of tags) expect(allowed.has(tag ?? '')).toBe(true);
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/<[^>]*\son[a-z]+\s*=/i);
      expect(html).not.toMatch(/<[^>]*\b(?:src|href|srcset|action|formaction)\s*=/i);
      // The markup itself has newlines; the page's text may not add any invisible character.
      expect(html.replace(/[\n\r\t]/g, ' ')).not.toMatch(UNSAFE_CHARS);
    });
  }
});

describe('M9.R1 report page and text bounds', () => {
  it('a 100 KB element text adds at most one bounded snippet to a report', () => {
    const big = 'lorem ipsum '.repeat(10_000);
    const small = hostileSnapshot('x');
    const huge = buildSnapshot({
      candidates: [
        candidate({
          target: target('html>body>p:nth-of-type(1)', 'p', { text: redactSnippet(big) }),
        }),
      ],
      generation: 1,
      timestamp: 1,
      page: small.page,
      extensionVersion: '0.1.0',
      settings: small.settings,
      coverage: { ...small.coverage },
    }).snapshot;
    const bytes = serializeAuditReport(createAuditReport(huge, 1)).length;
    const baseline = serializeAuditReport(
      createAuditReport(
        buildSnapshot({
          candidates: [candidate({ target: target('html>body>p:nth-of-type(1)', 'p') })],
          generation: 1,
          timestamp: 1,
          page: small.page,
          extensionVersion: '0.1.0',
          settings: small.settings,
          coverage: { ...small.coverage },
        }).snapshot,
        1,
      ),
    ).length;
    expect(bytes - baseline).toBeLessThan(120);
  });
});

describe('M9.R1 parser strictness (schema fuzz)', () => {
  const base = () =>
    JSON.parse(serializeAuditReport(createAuditReport(hostileSnapshot('plain'), 5))) as Record<
      string,
      any
    >;
  const reject = (mutate: (data: Record<string, any>) => unknown): string => {
    const data = base();
    mutate(data);
    const result = parseAuditReport(JSON.stringify(data));
    expect(result.ok).toBe(false);
    return result.ok ? '' : result.errors.join('|');
  };

  it('accepts the unmodified report', () => {
    expect(parseAuditReport(JSON.stringify(base())).ok).toBe(true);
  });
  it('rejects a missing or future schemaVersion', () => {
    expect(reject((d) => delete d.schemaVersion)).toContain('schemaVersion');
    expect(reject((d) => (d.schemaVersion = AUDIT_SCHEMA_VERSION + 1))).toContain('schemaVersion');
  });
  it('rejects credentials, queries and fragments in the page address', () => {
    expect(reject((d) => (d.page.origin = 'https://user:pw@example.test'))).toContain('page');
    expect(reject((d) => (d.page.origin = 'https://example.test?x=1'))).toContain('page');
    expect(reject((d) => (d.page.pathname = '/a#frag'))).toContain('page');
    expect(reject((d) => (d.page.pathname = '/a/user@example.com'))).toContain('page');
    expect(reject((d) => (d.page.origin = 'javascript:alert(1)'))).toContain('page');
  });
  it('rejects control, bidi, zero-width and surrogate characters anywhere', () => {
    for (const bad of ['\u202E', '\u200B', '\u0007', '\u2028', '\uD800']) {
      expect(reject((d) => (d.findings[0].affected[0].locator.text = `a${bad}b`))).toContain(
        'unsafe character',
      );
    }
  });
  it('rejects a wrong summary, invalid enums and duplicate ids', () => {
    expect(reject((d) => (d.summary.bySeverity.high += 1))).toContain('summary');
    expect(reject((d) => (d.findings[0].confidence = 'CERTAIN'))).toContain('confidence');
    expect(reject((d) => (d.findings[0].severity = 'blocker'))).toContain('severity');
    expect(reject((d) => d.findings.push(structuredClone(d.findings[0])))).toContain('duplicate');
  });
  it('rejects a WCAG relation that claims anything but relatedness', () => {
    expect(
      reject((d) => (d.findings[0].wcag = [{ criterion: '1.4.3', name: 'x', relation: 'fails' }])),
    ).toContain('wcag');
  });
  it('rejects oversized locator fields', () => {
    expect(reject((d) => (d.findings[0].affected[0].locator.path = 'a>'.repeat(500)))).toContain(
      'locator',
    );
    expect(
      reject((d) => (d.findings[0].affected[0].locator.classes = ['a', 'b', 'c', 'd'])),
    ).toContain('locator');
  });
});
