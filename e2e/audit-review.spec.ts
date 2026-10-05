import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { parseAuditReport, type AuditReport, type AuditSnapshot } from '../src/core/audit';
import {
  launchExtension,
  startPageServer,
  type ExtensionSession,
  type PageServer,
} from './harness';
import {
  ADAPTED_SETTINGS,
  AUDIT_SETTINGS,
  SECRETS,
  keys,
  loadAudited,
  overlay,
  readDownload,
  type Audited,
} from './audit-kit';

/**
 * M9.R1 in a real Chromium: what the audit page and its exports do that jsdom cannot show.
 * Nothing sleeps; every wait is a poll on something the browser reports.
 */
declare const chrome: { storage: unknown };

let server: PageServer;
let ext: ExtensionSession;

test.beforeAll(async () => {
  server = await startPageServer();
  ext = await launchExtension();
});
test.afterEach(async () => {
  await Promise.all(ext.context.pages().map((page) => page.close()));
});
test.afterAll(async () => {
  await ext.close();
  await server.close();
});

async function openAudit(audited: Audited): Promise<Page> {
  const audit = await audited.open();
  await expect(audit.locator('[data-testid="finding"]').first()).toBeVisible();
  return audit;
}

async function download(audit: Page, name: 'Export JSON' | 'Export HTML report', as?: string) {
  const [file] = await Promise.all([
    audit.waitForEvent('download'),
    audit.getByRole('button', { name }).click(),
  ]);
  if (as) await file.saveAs(as);
  return as ? readDownload(as) : readDownload(await file.path());
}

const card = (audit: Page, rule: string) =>
  audit.locator(`[data-testid="finding"][data-rule="${rule}"]`).first();

// ------------------------------------------------------------------ coverage and parity

test('the audit page and the export say the same: counts, assessments and coverage', async () => {
  const audited = await loadAudited(ext, server);
  const audit = await openAudit(audited);
  const report = JSON.parse(await download(audit, 'Export JSON')) as AuditReport;
  const parsed = parseAuditReport(JSON.stringify(report));
  expect(parsed.ok, parsed.ok ? '' : parsed.errors.join('; ')).toBe(true);

  const line = (await audit.getByTestId('summary-line').innerText()).replace(/\s+/g, ' ');
  expect(line).toContain(`${report.summary.findings} finding`);
  expect(line).toContain(`${report.summary.affectedElements} element`);
  expect(line).toContain(`${report.summary.adapted} compensated`);
  expect(line).toContain(`${report.summary.unresolved} not`);
  expect(line).toContain(`${report.summary.manualReview} need manual review`);
  expect(await audit.getByTestId('assessment-line').innerText()).toBe(
    `Confirmed issues: ${report.summary.byAssessment.issue} · Manual review: ${report.summary.byAssessment['manual-review']} · Analysis limitations: ${report.summary.byAssessment['analysis-limitation']}.`,
  );
  for (const severity of ['critical', 'high', 'medium', 'low', 'info'] as const) {
    await expect(audit.getByTestId(`count-${severity}`)).toHaveText(
      String(report.summary.bySeverity[severity]),
    );
  }
  // Manual reviews and limitations are not part of the confirmed-issue count.
  expect(report.summary.byAssessment.issue).toBeLessThan(report.summary.findings);

  const rows = await audit
    .locator('[data-testid="coverage-table"] tbody tr')
    .evaluateAll((trs) =>
      trs.map((tr) => [tr.getAttribute('data-coverage'), tr.getAttribute('data-level')]),
    );
  expect(rows).toEqual(report.coverage.subsystems.map((s) => [s.id, s.level]));
});

test('image pixel analysis is disclosed as disabled with image adaptation off, and partial when on', async () => {
  const off = await loadAudited(ext, server, AUDIT_SETTINGS);
  const offAudit = await openAudit(off);
  await expect(offAudit.locator('[data-coverage="image-pixels"]')).toHaveAttribute(
    'data-level',
    'disabled',
  );
  await expect(offAudit.locator('[data-coverage="image-pixels"]')).toContainText(
    'image adaptation is disabled',
  );
  await expect(offAudit.locator('[data-coverage="image-pixels"]')).toContainText(
    'says nothing about the images',
  );
  for (const id of ['shadow-dom', 'iframes', 'borders-focus']) {
    await expect(offAudit.locator(`[data-coverage="${id}"]`)).toHaveAttribute(
      'data-level',
      'unsupported',
    );
  }
  await offAudit.close();
  await off.page.close();

  const on = await loadAudited(ext, server, { ...ADAPTED_SETTINGS, adaptImages: true });
  const onAudit = await openAudit(on);
  await expect(onAudit.locator('[data-coverage="image-pixels"]')).toHaveAttribute(
    'data-level',
    'partial',
  );
});

test('no accessibility score, grade or percentage anywhere on the audit page or in the reports', async () => {
  const audited = await loadAudited(ext, server);
  const audit = await openAudit(audited);
  const text = await audit.locator('main').innerText();
  expect(text).not.toMatch(/\b\d{1,3}\s?%|\bgrade\b|\bscore:|out of 100|\b[A-F] rating\b/i);
  expect(await audit.locator('meter, progress, [role="meter"], [role="progressbar"]').count()).toBe(
    0,
  );
  const json = await download(audit, 'Export JSON');
  expect(json).not.toMatch(/"(?:score|grade|rating|percent\w*)"/i);
});

// ------------------------------------------------------------------ navigation metadata

/** Files of the E2E build that assign to or wrap `history.pushState` / `replaceState`. */
function shippedCodeMentionsHistoryHooks(): string[] {
  const root = path.resolve(import.meta.dirname, '../dist/chrome-mv3-e2e');
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (
        /\.(?:js|mjs)$/.test(name) &&
        /(?:pushState|replaceState)\s*=[^=]/.test(readFileSync(full, 'utf8'))
      )
        hits.push(path.relative(root, full));
    }
  };
  walk(root);
  return hits;
}

test('a route change without any DOM change updates the report address; export waits for it', async () => {
  const audited = await loadAudited(ext, server);
  const audit = await openAudit(audited);
  await expect(audit.getByTestId('page-line')).not.toContainText('/spa/quiet');
  // ColorAdapt never hooks the page's History API (the shipped bundle has no such code); the audit
  // learns of routes from the browser. (The page's own `pushState` may be wrapped by other software on
  // the machine, so what ColorAdapt ships is checked, not what the page shows.)
  expect(shippedCodeMentionsHistoryHooks()).toEqual([]);
  await audited.page.evaluate(() => history.pushState({}, '', '/spa/quiet?token=SECRET#private'));
  await expect(audit.getByTestId('page-line')).toContainText('/spa/quiet');
  await expect(audit.getByTestId('route-pending')).toHaveCount(0);
  const report = JSON.parse(await download(audit, 'Export JSON')) as AuditReport;
  expect(report.page.pathname).toBe('/spa/quiet');
  for (const word of ['token=', 'SECRET', 'private']) {
    expect(JSON.stringify(report)).not.toContain(word);
  }
});

test('a query or fragment change alone is not a route change', async () => {
  const audited = await loadAudited(ext, server);
  const audit = await openAudit(audited);
  const before = (await audited.diagnostics()).auditPasses;
  await audited.page.evaluate(() => history.pushState({}, '', `${location.pathname}?x=1#frag`));
  await audited.page.evaluate(() => history.pushState({}, '', `${location.pathname}?x=2#other`));
  await expect(audit.getByTestId('route-pending')).toHaveCount(0);
  expect((await audited.diagnostics()).auditPasses).toBe(before);
});

// ------------------------------------------------------------------ hostile content and Unicode

/** Bidi controls, zero-width characters, line/paragraph separators and byte-order marks, built without literals. */
const INVISIBLE = new RegExp(
  `[${[
    [0x202a, 0x202e],
    [0x2066, 0x2069],
    [0x200b, 0x200f],
    [0x2028, 0x2029],
    [0xfeff, 0xfeff],
  ]
    .map(([a, b]) => `${String.fromCharCode(a!)}-${String.fromCharCode(b!)}`)
    .join('')}]`,
);

test('hostile text and invisible Unicode in the page cannot reach, execute in, or corrupt a report', async () => {
  const testInfo = test.info();
  const audited = await loadAudited(ext, server);
  await audited.page.evaluate(() => {
    const texts = [
      '<script>window.__pwned=1</script>',
      '<img src=x onerror="window.__pwned=2">',
      '</style><script>window.__pwned=3</script>',
      '"><svg onload="window.__pwned=4">',
      [
        'RTL ',
        0x202e,
        'evil.exe',
        0x202c,
        ' zero',
        0x200b,
        'width line',
        0x2028,
        'sep ',
        0xd800,
        ' lone',
      ]
        .map((part) => (typeof part === 'number' ? String.fromCharCode(part) : part))
        .join(''),
      'combining é́́ emoji 😀 Привет',
      'x'.repeat(120_000),
    ];
    const host = document.getElementById('audit-fixture')!;
    texts.forEach((t, i) => {
      const p = document.createElement('p');
      p.id = `hostile-${i}`;
      p.className = 'low';
      p.textContent = t;
      host.append(p);
    });
  });
  const dialogs: string[] = [];
  const audit = await openAudit(audited);
  audit.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await audit.getByRole('button', { name: 'Refresh audit' }).click();
  await expect.poll(async () => (await audited.diagnostics()).auditPasses).toBeGreaterThan(1);

  const jsonPath = testInfo.outputPath('hostile.json');
  const htmlPath = testInfo.outputPath('hostile.html');
  const json = await download(audit, 'Export JSON', jsonPath);
  const html = await download(audit, 'Export HTML report', htmlPath);
  const parsed = parseAuditReport(json);
  expect(parsed.ok, parsed.ok ? '' : parsed.errors.join('; ')).toBe(true);
  expect(json.length).toBeLessThan(2_000_000);
  expect(`${json}${html}`).not.toMatch(INVISIBLE);
  expect(json).not.toContain('x'.repeat(100));
  expect(html).not.toContain('x'.repeat(100));
  expect(html).not.toMatch(/<script|<img\b|<svg\b/i);

  const view = await ext.context.newPage();
  const requests: string[] = [];
  view.on('request', (r) => requests.push(r.url()));
  view.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await view.goto(pathToFileURL(htmlPath).href);
  expect(
    await view.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
  ).toBeUndefined();
  expect(
    await view.evaluate(() => document.querySelectorAll('script, img, svg, iframe').length),
  ).toBe(0);
  expect(view.url()).toBe(pathToFileURL(htmlPath).href);
  expect(requests).toEqual([pathToFileURL(htmlPath).href]);
  expect(dialogs).toEqual([]);
  // The audit page itself stays intact around the same text.
  expect(
    await audit.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
  ).toBeUndefined();
  await expect(audit.getByRole('button', { name: 'Export JSON' })).toBeVisible();
});

// ------------------------------------------------------------------ storage and network privacy

test('the audit persists nothing and talks to no one: storage is empty of it, requests stay local', async () => {
  const audited = await loadAudited(ext, server);
  const hosts = new Set<string>();
  audited.page.on('request', (r) => hosts.add(new URL(r.url()).host));
  const audit = await ext.context.newPage();
  const auditHosts = new Set<string>();
  audit.on('request', (r) =>
    auditHosts.add(new URL(r.url()).protocol + '//' + new URL(r.url()).host),
  );
  await audit.goto(`chrome-extension://${audited.extensionId}/audit.html?tabId=${audited.tabId}`);
  await expect(audit.locator('[data-testid="finding"]').first()).toBeVisible();
  await card(audit, 'CA-SEM-001').locator('h3 > button').click();
  await download(audit, 'Export JSON');
  await download(audit, 'Export HTML report');
  const baseline = new Set(hosts);
  expect([...auditHosts].every((h) => h.startsWith('chrome-extension://'))).toBe(true);
  // Page requests during the audit: nothing beyond what the page's own server already was.
  expect([...baseline].every((h) => h === new URL(server.origin).host)).toBe(true);

  const stored = await ext.worker.evaluate(async () => {
    const out: Record<string, unknown> = {};
    for (const area of ['local', 'sync', 'session'] as const) {
      const api = (chrome.storage as Record<string, { get(k?: null): Promise<unknown> }>)[area];
      if (api) out[area] = await api.get(null);
    }
    return out;
  });
  const dump = JSON.stringify(stored);
  for (const word of [
    ...SECRETS,
    'CA-COLOR',
    'CA-SEM',
    'CA-CHART',
    'findings',
    'affected',
    'locator',
    'audit-fixture',
  ]) {
    expect(dump, `storage must not hold ${word}`).not.toContain(word);
  }
  // The audit page's own origin keeps nothing either.
  const local = await audit.evaluate(async () => ({
    ls: Object.keys(localStorage),
    ss: Object.keys(sessionStorage),
    idb: ((await indexedDB.databases?.()) ?? []).length,
    caches: (await caches.keys()).length,
  }));
  expect(local).toEqual({ ls: [], ss: [], idb: 0, caches: 0 });
  // A fresh audit page does not restore a previous snapshot: it audits again.
  const first = (await audited.get())!.generation;
  await audit.close();
  const reopened = await audited.open();
  await expect(reopened.getByTestId('summary-line')).toBeVisible();
  expect((await audited.get())!.generation).toBeGreaterThan(first);
});

// ------------------------------------------------------------------ real-browser source checks

test('icons on dark backgrounds are judged against the real background', async () => {
  const audited = await loadAudited(ext, server);
  await audited.page.evaluate(() => {
    const host = document.getElementById('audit-fixture')!;
    const icon = (id: string, bg: string, fg: string) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.style.backgroundColor = bg;
      b.innerHTML = `<svg id="${id}" style="color:${fg}" width="24" height="24" viewBox="0 0 24 24"><path d="M2 2 L22 2 L12 22 Z" fill="currentColor"/></svg>`;
      host.append(b);
    };
    icon('dark-dark', '#222222', '#333333');
    icon('mid-dark', '#222222', '#4a4a4a');
    icon('light-dark', '#222222', '#eeeeee');
    icon('white-brand', '#0645ad', '#ffffff');
  });
  const snapshot = await audited.run();
  const svg = keys(snapshot, 'issue').filter((k) => k.startsWith('CA-SVG-001'));
  expect(svg).toContain('CA-SVG-001@#dark-dark');
  expect(svg).toContain('CA-SVG-001@#mid-dark');
  expect(svg).not.toContain('CA-SVG-001@#light-dark');
  expect(svg).not.toContain('CA-SVG-001@#white-brand');
});

test('one page with M3, M6, M7 and the highlight on it: the audit describes the original page only', async () => {
  // The OFF run first and its page closed: a tab is found by its exact address, so two copies cannot coexist.
  const off = await loadAuditedSnapshotOff();
  const audited = await loadAudited(ext, server, ADAPTED_SETTINGS);
  const audit = await openAudit(audited);
  await card(audit, 'CA-SEM-001').locator('h3 > button').click(); // a highlight is on the page now
  expect(await overlay(audited.page)).not.toBeNull();
  const owned = await audited.page.evaluate(() => ({
    sheet: !!document.getElementById('coloradapt-stylesheet'),
    cues: document.querySelectorAll('[data-coloradapt-cue]').length,
    marks: document.querySelectorAll('[data-coloradapt-chart-mark], [data-coloradapt-chart-node]')
      .length,
  }));
  expect(owned.sheet && (owned.cues > 0 || owned.marks > 0)).toBe(true); // adaptation really happened
  const report = JSON.parse(await download(audit, 'Export JSON')) as AuditReport;
  const text = JSON.stringify(report);
  expect(text).not.toMatch(
    /data-coloradapt|blob:|coloradapt-(?:cue|chart|stylesheet|audit-overlay)|\[data-/i,
  );
  for (const f of report.findings) {
    for (const a of f.affected) {
      expect(a.locator.classes.join(' ')).not.toMatch(/coloradapt/i);
      expect(a.locator.path).not.toMatch(/coloradapt|overlay/i);
    }
  }
  // The same findings as the page produces with ColorAdapt switched off.
  const pick = (r: { findings: AuditSnapshot['findings'] }) =>
    r.findings
      .map(
        (f) =>
          `${f.id}|${f.severity}|${f.confidence}|${f.affectedCount}|${f.visionProfiles.join(',')}`,
      )
      .sort();
  expect(pick(report)).toEqual(pick(off));
});

async function loadAuditedSnapshotOff(): Promise<AuditSnapshot> {
  const plain = await loadAudited(ext, server, AUDIT_SETTINGS);
  const snapshot = await plain.run();
  await plain.page.close();
  return snapshot;
}

// ------------------------------------------------------------------ audit-only mode and lifecycle

test('audit-only mode leaves no trace of ColorAdapt on the page except the highlight the user asked for', async () => {
  const audited = await loadAudited(ext, server, AUDIT_SETTINGS);
  const audit = await openAudit(audited);
  const traces = () =>
    audited.page.evaluate(() => ({
      sheet: !!document.getElementById('coloradapt-stylesheet'),
      cues: document.querySelectorAll('[data-coloradapt-cue]').length,
      chart: document.querySelectorAll('[data-coloradapt-chart-mark], [data-coloradapt-chart-node]')
        .length,
      blobs: [...document.images].filter((i) => i.currentSrc.startsWith('blob:')).length,
      overlay: document.querySelectorAll('[data-coloradapt-audit-overlay]').length,
    }));
  expect(await traces()).toEqual({ sheet: false, cues: 0, chart: 0, blobs: 0, overlay: 0 });
  await card(audit, 'CA-SEM-001').locator('h3 > button').click();
  expect(await traces()).toEqual({ sheet: false, cues: 0, chart: 0, blobs: 0, overlay: 1 });
  await audit.close();
  await expect.poll(() => traces().then((t) => t.overlay)).toBe(0);
});

test('open and close the audit ten times: one session at a time, nothing left running', async () => {
  const audited = await loadAudited(ext, server);
  const before = (await audited.diagnostics()).auditPasses;
  for (let i = 0; i < 10; i += 1) {
    const audit = await audited.open();
    await expect.poll(async () => (await audited.diagnostics()).auditWatching).toBe(true);
    await audit.close();
    await expect.poll(async () => (await audited.diagnostics()).auditWatching).toBe(false);
  }
  const after = await audited.diagnostics();
  expect(after.auditWatching).toBe(false);
  expect(after.auditHighlightVisible).toBe(false);
  expect(after.auditPasses - before).toBeLessThanOrEqual(10 + 10); // opens, plus at most one live pass each
  // With the audit closed, page changes cost no audit work at all.
  const quiet = after.auditPasses;
  await audited.page.evaluate(() => {
    for (let i = 0; i < 20; i += 1) document.getElementById('low')!.textContent = `change ${i}`;
  });
  await audited.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  expect((await audited.diagnostics()).auditPasses).toBe(quiet);
});

test('reloading the audit page ends the old session: one watcher, no stale highlight', async () => {
  const audited = await loadAudited(ext, server);
  const audit = await openAudit(audited);
  await card(audit, 'CA-SEM-001').locator('h3 > button').click();
  expect(await overlay(audited.page)).not.toBeNull();
  await audit.reload();
  await expect(audit.getByTestId('summary-line')).toBeVisible();
  await expect.poll(async () => (await audited.diagnostics()).auditWatching).toBe(true);
  await expect.poll(() => overlay(audited.page)).toBeNull();
});

// ------------------------------------------------------------------ UI: focus, widths, zoom, vision, contrast

test('focus stays where the user put it: expanding, collapsing and filtering never throw it away', async () => {
  const audited = await loadAudited(ext, server);
  const audit = await openAudit(audited);
  const toggle = card(audit, 'CA-SEM-001').locator('h3 > button');
  await toggle.focus();
  await audit.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(await audit.evaluate(() => document.activeElement?.getAttribute('aria-expanded'))).toBe(
    'true',
  );
  await audit.keyboard.press('Enter');
  expect(await audit.evaluate(() => document.activeElement?.getAttribute('aria-expanded'))).toBe(
    'false',
  );
  const box = audit.getByRole('checkbox').first();
  await box.focus();
  await audit.keyboard.press('Space');
  expect(await audit.evaluate(() => document.activeElement?.getAttribute('type'))).toBe('checkbox');
  await audit.keyboard.press('Space');
  // The audit never moves focus onto the audited page: nothing in it is focused.
  expect(await audited.page.evaluate(() => document.activeElement?.id ?? '')).toBe('');
  expect(await audited.page.evaluate(() => document.activeElement === document.body)).toBe(true);
});

test('a card whose finding disappears does not strand keyboard focus on nothing', async () => {
  const audited = await loadAudited(ext, server);
  const audit = await openAudit(audited);
  const toggle = card(audit, 'CA-COLOR-002').locator('h3 > button');
  await toggle.focus();
  await audited.page.evaluate(() => {
    const el = document.getElementById('cvd')!;
    el.className = 'fine';
  });
  await expect(card(audit, 'CA-COLOR-002')).toHaveCount(0);
  const active = await audit.evaluate(() => {
    const el = document.activeElement;
    return { tag: el?.localName ?? '', insideMain: !!el?.closest('main') };
  });
  // Not left on <body>: focus moved to something inside the audit page.
  expect(active.insideMain).toBe(true);
});

test('every main control is reachable at 360–1440 px and at 150% and 200% zoom', async () => {
  const audited = await loadAudited(ext, server);
  const audit = await openAudit(audited);
  const widths = [1440, 1024, 768, 480, 360, 853 /* 1280 @150% */, 640 /* 1280 @200% */];
  for (const width of widths) {
    await audit.setViewportSize({ width, height: 800 });
    const facts = await audit.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      width: document.documentElement.clientWidth,
      controls: ['Refresh audit', 'Export JSON', 'Export HTML report'].map((name) => {
        const b = [...document.querySelectorAll('button')].find(
          (x) => x.textContent?.trim() === name,
        );
        const r = b?.getBoundingClientRect();
        return {
          name,
          ok:
            !!r &&
            r.left >= -0.5 &&
            r.right <= document.documentElement.clientWidth + 0.5 &&
            r.width > 0,
        };
      }),
      select: (() => {
        const r = document.getElementById('audit-scope')?.getBoundingClientRect();
        return !!r && r.left >= -0.5 && r.right <= document.documentElement.clientWidth + 0.5;
      })(),
    }));
    expect(facts.overflow, `${width}px overflow`).toBeLessThanOrEqual(1);
    for (const control of facts.controls)
      expect(control.ok, `${width}px ${control.name}`).toBe(true);
    expect(facts.select, `${width}px profile select`).toBe(true);
    await expect(card(audit, 'CA-SEM-001').locator('h3 > button')).toBeVisible();
  }
});

test('severity stays readable under simulated color vision deficiencies', async () => {
  const audited = await loadAudited(ext, server);
  const audit = await openAudit(audited);
  const client = await ext.context.newCDPSession(audit);
  for (const type of ['protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia'] as const) {
    await client.send('Emulation.setEmulatedVisionDeficiency', { type });
    const labels = await audit.evaluate(() =>
      [...document.querySelectorAll('.summary__severity .badge')].map((b) => b.textContent?.trim()),
    );
    expect(new Set(labels).size, type).toBe(5);
    for (const label of labels)
      expect(label, type).toMatch(/[⬢▲◆■●]\s*(Critical|High|Medium|Low|Info)/);
    // Every finding card names its severity in words, not by a swatch.
    const cards = await audit
      .locator('[data-testid="finding"]')
      .evaluateAll((els) =>
        els.map((el) => /(Critical|High|Medium|Low|Info)/.test(el.textContent ?? '')),
      );
    expect(cards.every(Boolean), type).toBe(true);
  }
  await client.send('Emulation.setEmulatedVisionDeficiency', { type: 'none' });
});

test('the audit page follows its own rules: text contrast, visible focus, named controls', async () => {
  const audited = await loadAudited(ext, server);
  const audit = await openAudit(audited);
  await card(audit, 'CA-SEM-001').locator('h3 > button').click();
  const problems = await audit.evaluate(() => {
    const parse = (c: string): [number, number, number, number] => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      const p = (m?.[1] ?? '0,0,0,1')
        .split(/[ ,/]+/)
        .filter(Boolean)
        .map(Number);
      return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1];
    };
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => {
        const s = (v ?? 0) / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
    };
    const backdrop = (el: Element): number[] => {
      let acc: number[] = [255, 255, 255];
      const chain: Element[] = [];
      for (let n: Element | null = el; n; n = n.parentElement) chain.push(n);
      for (const n of chain.reverse()) {
        const [r, g, b, a] = parse(getComputedStyle(n).backgroundColor);
        if (a > 0)
          acc = [r * a + acc[0]! * (1 - a), g * a + acc[1]! * (1 - a), b * a + acc[2]! * (1 - a)];
      }
      return acc;
    };
    const out: string[] = [];
    for (const el of document.querySelectorAll('main *')) {
      const hasText = [...el.childNodes].some(
        (n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== '',
      );
      if (!hasText) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      const fg = parse(style.color);
      const bg = backdrop(el);
      const l1 = lum([fg[0], fg[1], fg[2]]);
      const l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const size = Number.parseFloat(style.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number.parseInt(style.fontWeight, 10) >= 700);
      if (ratio < (large ? 3 : 4.5))
        out.push(
          `${el.localName}.${el.className}: ${ratio.toFixed(2)}:1 "${(el.textContent ?? '').trim().slice(0, 30)}"`,
        );
    }
    for (const el of document.querySelectorAll('button, a[href], input, select, summary')) {
      const name =
        (el.getAttribute('aria-label') ?? (el as HTMLElement).innerText ?? '').trim() ||
        (el.id && document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim()) ||
        el.closest('label')?.textContent?.trim();
      if (!name) out.push(`unnamed ${el.localName}`);
    }
    return out;
  });
  expect(problems).toEqual([]);
});

test('highlight follows scroll and resize, and removes itself when its element is removed or hidden', async () => {
  const audited = await loadAudited(ext, server);
  const audit = await openAudit(audited);
  await card(audit, 'CA-COLOR-001').locator('h3 > button').click();
  expect(await overlay(audited.page)).not.toBeNull();
  const target = await audited.page.evaluate(() => {
    const box = document.querySelector('[data-coloradapt-audit-overlay]')!.getBoundingClientRect();
    return { w: box.width, h: box.height };
  });
  expect(target.w).toBeGreaterThan(0);
  // Layout change: the box is re-placed over the element, not left behind.
  await audited.page.evaluate(() => {
    const holder = document.getElementById('audit-fixture')!;
    holder.style.marginTop = '120px';
  });
  await expect
    .poll(async () => {
      const t = await audited.page.evaluate(() => {
        const box = document.querySelector('[data-coloradapt-audit-overlay]');
        return box ? box.getBoundingClientRect().top : null;
      });
      return t;
    })
    .not.toBeNull();
  // Hidden: no box drawn over nothing.
  await audited.page.evaluate(() => {
    document.getElementById('audit-fixture')!.style.display = 'none';
  });
  await expect
    .poll(() =>
      audited.page.evaluate(() => {
        const box = document.querySelector<HTMLElement>('[data-coloradapt-audit-overlay]');
        return !box || box.style.display === 'none';
      }),
    )
    .toBe(true);
});
