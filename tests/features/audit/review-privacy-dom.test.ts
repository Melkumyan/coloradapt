import { describe, expect, it } from 'vitest';
import {
  NO_FILTERS,
  createAuditReport,
  filterFindings,
  parseAuditReport,
  renderAuditHtml,
  serializeAuditReport,
  type AuditSnapshot,
} from '@core/audit';
import { AUDIT_MAX_ELEMENTS } from '@features/page-analysis';
import { LocatorContext } from '@features/audit';
import { DEUTAN, findingsOf, mountAudit } from './kit';

const CSS = `
  .low { color: #aaaaaa; background-color: #ffffff; }
  .fine { color: #000000; background-color: #ffffff; }
  .f { border-top-style: solid; border-top-width: 1px; border-top-color: #888888; }
  .f[aria-invalid="true"] { border-top-color: #c0392b; }
`;

const text = (snapshot: AuditSnapshot) => {
  const report = createAuditReport(snapshot, 1);
  return `${serializeAuditReport(report)}\n${renderAuditHtml(report)}`;
};

describe('M9.R1 sensitive controls: every kind, with a finding on each, no value in any export', () => {
  const SECRET = 'S3CR3T-VALUE-1234567';
  const peers = (type: string) =>
    `<input class="f" type="${type}" aria-label="Other 1"><input class="f" type="${type}" aria-label="Other 2">`;
  const page = `
    <input id="pw" class="f" type="password" aria-invalid="true" aria-label="Password" value="${SECRET}-password">${peers('password')}
    <input id="em" class="f" type="email" aria-invalid="true" aria-label="Email" value="${SECRET}@example.com">${peers('email')}
    <input id="ph" class="f" type="tel" aria-invalid="true" aria-label="Phone" value="+1 555 0100 ${SECRET}">${peers('tel')}
    <input id="se" class="f" type="search" aria-invalid="true" aria-label="Search" value="${SECRET}-search">${peers('search')}
    <textarea id="ta" class="f low" aria-invalid="true" aria-label="Notes">${SECRET}-textarea</textarea><textarea class="f" aria-label="N2"></textarea><textarea class="f" aria-label="N3"></textarea>
    <input id="hid" type="hidden" name="csrf" value="${SECRET}-hidden">
    <input id="tok" type="hidden" name="session" value="eyJhbGciOiJIUzI1NiJ9.${SECRET}.abc">
    <p id="ce" class="low" contenteditable="true">${SECRET}-editable</p>
    <p id="data" class="low" data-token="${SECRET}-data" data-user="${SECRET}-user">visible text</p>
    <p id="card" class="low">Card 4111 1111 1111 1111 for ${SECRET}@example.com</p>`;

  it('has a finding on the sensitive controls (the check below is not vacuous)', () => {
    const snapshot = mountAudit(page, { css: CSS, settings: DEUTAN }).run('active');
    const ids = snapshot.findings.flatMap((f) => f.affected.map((a) => a.locator.id));
    for (const id of ['pw', 'em', 'ph', 'se', 'ta', 'ce']) expect(ids, id).toContain(id);
  });

  it('exports contain none of their values, hidden fields, data attributes, or personal data in text', () => {
    const snapshot = mountAudit(page, { css: CSS, settings: DEUTAN }).run('active');
    const out = text(snapshot);
    expect(out).not.toContain('S3CR3T');
    expect(out).not.toContain('4111');
    expect(out).not.toMatch(/eyJhbGci|555 0100|@example\.com/);
    expect(parseAuditReport(serializeAuditReport(createAuditReport(snapshot, 1))).ok).toBe(true);
  });

  it('searching a private value finds nothing: it never entered the audit', () => {
    const snapshot = mountAudit(page, { css: CSS, settings: DEUTAN }).run('active');
    for (const query of ['S3CR3T', 'hunter', 'eyJhbGci', '4111', '@example.com', '555 0100']) {
      expect(filterFindings(snapshot.findings, { ...NO_FILTERS, query }), query).toEqual([]);
    }
    // Searching what is legitimately in a report still works.
    expect(
      filterFindings(snapshot.findings, { ...NO_FILTERS, query: 'CA-SEM-001' }).length,
    ).toBeGreaterThan(0);
  });
});

describe('M9.R1 locator privacy fuzz on real elements', () => {
  const FUZZ: Array<[string, string]> = [
    ['email-like id', 'user@example.com'],
    ['uuid id', '123e4567-e89b-12d3-a456-426614174000'],
    ['token id', 'tok_9f8a7b6c5d4e3f2a1b0c9d8e7f'],
    ['account id', 'account-0042424242'],
    ['unicode id', 'Ünï-çødé'],
    ['emoji id', 'smile-😀'],
    ['rtl id', 'שלום-עולם'],
    ['bidi override id', 'a-' + String.fromCharCode(0x202e) + 'txt'],
    ['very long id', 'x'.repeat(5000)],
    ['markup id', '"><script>alert(1)</script>'],
  ];
  for (const [name, id] of FUZZ) {
    it(`${name}: the locator keeps nothing identifying, and the export stays bounded and inert`, () => {
      document.body.innerHTML = '';
      const rig = mountAudit(
        `<p class="low ${id.replace(/\s/g, '')}" id="${'a'}" data-x="${id}">Text for ${id}</p>`,
        { css: CSS, settings: DEUTAN },
      );
      const el = document.querySelector('p');
      if (el) el.id = id;
      const described = new LocatorContext(document).describe(el as Element);
      expect(described.locator.path.length).toBeLessThanOrEqual(400);
      expect(
        described.locator.id === null || /^[A-Za-z0-9_\-:.[\]#]+$/.test(described.locator.id),
      ).toBe(true);
      expect((described.locator.id ?? '').length).toBeLessThanOrEqual(40);
      expect(described.locator.classes.every((c) => c.length <= 40)).toBe(true);
      expect(described.locator.text === null || described.locator.text.length <= 40).toBe(true);
      expect(described.locator.path).not.toContain('@example.com');
      expect(described.locator.path).not.toMatch(/<|script/);
      const out = text(rig.run('active'));
      expect(out).not.toMatch(/user@example\.com|123e4567|9f8a7b6c5d4e3f2a1b0c|0042424242/);
      expect(out).not.toMatch(/<script|<img|onerror/i);
      expect(out.length).toBeLessThan(150_000);
    });
  }
});

describe('M9.R1 dynamic audit stress: issues appear, are fixed, removed and inserted in bulk', () => {
  const markup = (n: number) =>
    `<ul id="rows">${Array.from({ length: n }, (_, i) => `<li id="r${i}" class="low">row ${i}</li>`).join('')}</ul>`;
  const total = (s: AuditSnapshot) =>
    findingsOf(s, 'CA-COLOR-001').reduce((sum, f) => sum + f.affectedCount, 0);

  it('converges after 100 fixes, 100 removals and 100 insertions, with no stale finding', () => {
    const rig = mountAudit(markup(100), { css: CSS, settings: DEUTAN });
    expect(total(rig.run('active'))).toBe(100);
    for (const li of document.querySelectorAll('li')) li.className = 'fine'; // 100 fixes
    expect(total(rig.run('active'))).toBe(0);
    expect(rig.run('active').findings.filter((f) => f.ruleId === 'CA-COLOR-001')).toEqual([]);
    const list = document.getElementById('rows') as HTMLElement;
    for (let i = 0; i < 100; i += 1) {
      const li = document.createElement('li');
      li.id = `n${i}`;
      li.className = 'low';
      li.textContent = `new ${i}`;
      list.append(li); // 100 insertions
    }
    const afterInsert = rig.run('active');
    expect(total(afterInsert)).toBe(100);
    expect(
      findingsOf(afterInsert, 'CA-COLOR-001')[0]?.affected.every((a) =>
        /^n\d+$/.test(a.locator.id ?? ''),
      ),
    ).toBe(true);
    for (let i = 0; i < 100; i += 1) document.getElementById(`n${i}`)?.remove(); // 100 removals
    const end = rig.run('active');
    expect(total(end)).toBe(0);
    expect(end.summary.findings).toBe(0);
  });

  it('a live session reaches the same final state as a fresh pass', async () => {
    const rig = mountAudit(markup(100), { css: CSS, settings: DEUTAN });
    rig.run('active');
    const seen: AuditSnapshot[] = [];
    rig.audit.open((s) => seen.push(s));
    for (const li of [...document.querySelectorAll('li')].slice(0, 50)) li.className = 'fine';
    for (let i = 0; i < 30; i += 1) document.getElementById(`r${50 + i}`)?.remove();
    const { microtasks } = await import('../dynamic/helpers');
    await microtasks();
    rig.audited.fire();
    const live = seen[seen.length - 1] as AuditSnapshot;
    const fresh = rig.run('active');
    expect(findingsOf(live, 'CA-COLOR-001').map((f) => [f.id, f.affectedCount])).toEqual(
      findingsOf(fresh, 'CA-COLOR-001').map((f) => [f.id, f.affectedCount]),
    );
    expect(total(live)).toBe(20);
  });
});

describe('M9.R1 the element budget at its exact boundary is deterministic and disclosed', () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => `<p class="low" id="p${i}">row ${i}</p>`).join('');
  const overhead = (() => {
    const probe = mountAudit(rows(10), {
      css: CSS,
      settings: DEUTAN,
      auditMaxElements: 100_000,
    }).run('active');
    return probe.coverage.elementsAnalyzed - 10;
  })();

  for (const delta of [-1, 0, 1]) {
    const limit = 120;
    it(`${limit + delta} elements against a budget of ${limit}`, () => {
      document.body.innerHTML = '';
      const n = limit + delta - overhead;
      const snapshot = mountAudit(rows(n), {
        css: CSS,
        settings: DEUTAN,
        auditMaxElements: limit,
      }).run('active');
      const truncated = delta > 0;
      expect(snapshot.coverage.analysisTruncated).toBe(truncated);
      expect(snapshot.coverage.elementsAnalyzed).toBe(Math.min(limit, limit + delta));
      expect(findingsOf(snapshot, 'CA-GEN-001').length).toBe(truncated ? 1 : 0);
      const color = snapshot.coverage.subsystems.find((s) => s.id === 'color-contrast');
      expect(color?.level).toBe(truncated ? 'partial' : 'complete');
    });
  }

  for (const delta of [-1, 0, 1]) {
    it(`${AUDIT_MAX_ELEMENTS + delta} elements against the product budget of ${AUDIT_MAX_ELEMENTS}`, () => {
      document.body.innerHTML = '';
      const n = AUDIT_MAX_ELEMENTS + delta - overhead;
      const snapshot = mountAudit(rows(n), { css: CSS, settings: DEUTAN }).run('active');
      const truncated = delta > 0;
      expect(snapshot.coverage.analysisTruncated).toBe(truncated);
      expect(snapshot.coverage.elementsAnalyzed).toBe(
        Math.min(AUDIT_MAX_ELEMENTS, AUDIT_MAX_ELEMENTS + delta),
      );
      const color = snapshot.coverage.subsystems.find((s) => s.id === 'color-contrast');
      expect(color?.level).toBe(truncated ? 'partial' : 'complete');
      expect(createAuditReport(snapshot, 1).coverage.analysisTruncated).toBe(truncated);
    }, 180_000);
  }
});
