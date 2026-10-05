import { describe, expect, it } from 'vitest';
import {
  LOCATOR_LIMITS,
  createAuditReport,
  parseAuditReport,
  renderAuditHtml,
  serializeAuditReport,
  type AuditSnapshot,
} from '@core/audit';
import { LocatorContext, isSensitiveElement, readTextSnippet } from '@features/audit';
import { DEUTAN, URL_OF_PAGE, mountAudit } from './kit';

const CSS = `
  .f { border-top-style: solid; border-top-width: 1px; border-top-color: #888888; }
  .f[aria-invalid="true"] { border-top-color: #c0392b; }
  .low { color: #aaaaaa; background-color: #ffffff; }
`;

/** Every kind of thing that belongs to the user, next to elements that do produce findings. */
const MARKUP = `
  <input id="pw" class="f" type="password" value="hunter2-SECRET" aria-invalid="true" aria-label="Password">
  <input id="em" class="f" type="email" value="jane.doe@example.com" aria-label="Email">
  <input id="se" class="f" type="search" value="my private search" aria-label="Search">
  <textarea id="ta" class="f" aria-label="Notes">dear diary SECRET-NOTE</textarea>
  <p id="ce" class="low" contenteditable="true">typed by the user SECRET-EDIT</p>
  <p id="mail" class="low" data-user-id="USER-998877" data-token="TOKEN-ABCDEF" data-state="error">Write to jane.doe@example.com or call 4111 1111 1111 1111</p>
  <p id="long" class="low">${'lorem ipsum '.repeat(5000)}</p>
  <p id="tokenish" class="low">session=9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c</p>
`;

const FORBIDDEN = [
  'hunter2',
  'SECRET',
  'jane.doe',
  'example.com/',
  'my private search',
  'dear diary',
  'typed by the user',
  'USER-998877',
  'TOKEN-ABCDEF',
  '4111',
  '9f8a7b6c5d4e3f2a1b0c9d8e',
  'token=',
  '#private',
  'private',
];

function everything(snapshot: AuditSnapshot): string {
  const report = createAuditReport(snapshot, 1);
  return [JSON.stringify(snapshot), serializeAuditReport(report), renderAuditHtml(report)].join(
    '\n',
  );
}

describe('what an audit may contain', () => {
  const rig = () => mountAudit(MARKUP, { css: CSS, settings: DEUTAN, svgEngine: false });

  it('has findings for these elements (the test below is not vacuous)', () => {
    const snapshot = rig().run();
    const paths = snapshot.findings.flatMap((f) => f.affected.map((a) => a.locator.path));
    expect(paths).toEqual(expect.arrayContaining(['#pw', '#mail', '#ce']));
  });

  it('contains no form value, no editable text, no data-* value, no token, no query or fragment', () => {
    const text = everything(rig().run());
    for (const needle of FORBIDDEN) expect(text, needle).not.toContain(needle);
  });

  it('gives a form control no text and an input only its type', () => {
    const snapshot = rig().run();
    for (const finding of snapshot.findings) {
      for (const { locator } of finding.affected) {
        if (['input', 'textarea', 'select'].includes(locator.tag)) expect(locator.text).toBeNull();
      }
    }
    const pw = snapshot.findings.flatMap((f) => f.affected).find((a) => a.locator.id === 'pw');
    expect(pw?.locator.inputType).toBe('password');
    expect(pw?.locator.tag).toBe('input');
  });

  it('gives an editable region no text', () => {
    const snapshot = rig().run();
    const ce = snapshot.findings.flatMap((f) => f.affected).find((a) => a.locator.id === 'ce');
    expect(ce).toBeDefined();
    expect(ce?.locator.text).toBeNull();
  });

  it('redacts emails, numbers and tokens in the visible text it does quote', () => {
    const snapshot = rig().run();
    const quoted = snapshot.findings.flatMap((f) => f.affected).map((a) => a.locator.text ?? '');
    expect(quoted.some((t) => t.includes('[email]'))).toBe(true);
    expect(quoted.join('\n')).not.toMatch(/@|4111/);
  });

  it('bounds every snippet, even for an element holding a huge text', () => {
    const snapshot = rig().run();
    for (const { locator } of snapshot.findings.flatMap((f) => f.affected)) {
      expect((locator.text ?? '').length).toBeLessThanOrEqual(LOCATOR_LIMITS.textLength);
      expect(locator.classes.length).toBeLessThanOrEqual(LOCATOR_LIMITS.classes);
    }
  });

  it('keeps only the origin and the pathname of the page address', () => {
    const snapshot = rig().run();
    expect(snapshot.page).toEqual({ origin: 'https://example.test', pathname: '/account' });
    expect(URL_OF_PAGE).toContain('token=SECRET');
  });

  it('exports a report that passes its own validator', () => {
    const report = createAuditReport(rig().run(), 1);
    expect(parseAuditReport(serializeAuditReport(report)).ok).toBe(true);
  });

  it('never reads a value attribute: a poisoned `value` property changes nothing', () => {
    const mounted = rig();
    for (const field of document.querySelectorAll<HTMLInputElement>('input')) {
      Object.defineProperty(field, 'value', {
        get: () => {
          throw new Error('read a value');
        },
      });
    }
    expect(() => mounted.run()).not.toThrow();
  });
});

describe('the locator', () => {
  it('treats form controls and editable regions as sensitive', () => {
    document.body.innerHTML =
      '<input id="i"><textarea id="t"></textarea><select id="s"><option id="o">x</option></select><div contenteditable="true"><span id="in">x</span></div><div contenteditable="false"><span id="out">x</span></div><p id="p">x</p>';
    for (const id of ['i', 't', 's', 'o', 'in'])
      expect(isSensitiveElement(document.getElementById(id)!), id).toBe(true);
    for (const id of ['out', 'p'])
      expect(isSensitiveElement(document.getElementById(id)!), id).toBe(false);
  });

  it('reads a bounded snippet without walking the whole text', () => {
    document.body.innerHTML = `<p id="p">${'abc '.repeat(100_000)}</p>`;
    expect(readTextSnippet(document.getElementById('p')!).length).toBeLessThanOrEqual(
      LOCATOR_LIMITS.textRead,
    );
  });

  it('skips script and style text', () => {
    document.body.innerHTML = '<p id="p">visible<script>secret()</script><style>.x{}</style></p>';
    expect(readTextSnippet(document.getElementById('p')!)).not.toMatch(/secret|\.x/);
  });

  it('never quotes ids or class names that look like identifiers or secrets', () => {
    document.body.innerHTML =
      '<p id="user-48219074" class="ok row-12 AbCdEf1234567890XyZw 3f9a1c2b7d4e8f60a1b2">x</p>';
    const { locator } = new LocatorContext(document).describe(
      document.getElementById('user-48219074')!,
    );
    expect(JSON.stringify(locator)).not.toMatch(/48219074|AbCdEf|3f9a1c2b/);
  });

  it('reads no attribute but id, class, role, type, alt and the visible text', () => {
    document.body.innerHTML =
      '<p id="p" class="a" role="note" data-secret="S3CRET" title="T1TLE" aria-label="L4BEL" href="/h" style="color:red">x</p>';
    const text = JSON.stringify(
      new LocatorContext(document).describe(document.getElementById('p')!),
    );
    for (const needle of ['S3CRET', 'T1TLE', 'L4BEL', '/h']) expect(text).not.toContain(needle);
  });
});
