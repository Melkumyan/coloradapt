import { pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { parseAuditReport, type AuditReport } from '../src/core/audit';
import {
  launchExtension,
  startPageServer,
  type ExtensionSession,
  type PageServer,
} from './harness';
import { ADAPTED_SETTINGS, SECRETS, loadAudited, readDownload, type Audited } from './audit-kit';

/**
 * Exports from the real audit page: the JSON report is valid, consistent with what is on screen,
 * deterministic, and free of everything private; the HTML report is standalone, makes no request,
 * runs no script and cannot be turned into markup by the page it describes.
 */
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

async function exportAs(audit: Page, button: 'Export JSON' | 'Export HTML report') {
  const [download] = await Promise.all([
    audit.waitForEvent('download'),
    audit.getByRole('button', { name: button }).click(),
  ]);
  return { name: download.suggestedFilename(), text: readDownload(await download.path()) };
}

async function openWith(audited: Audited) {
  const audit = await audited.open();
  await expect(audit.locator('[data-testid="finding"]').first()).toBeVisible();
  return audit;
}

test('exports a JSON report that validates, is named safely and says where it came from', async () => {
  const audited = await loadAudited(ext, server, undefined, '?token=SECRET#private');
  const audit = await openWith(audited);
  const { name, text } = await exportAs(audit, 'Export JSON');
  expect(name).toMatch(/^coloradapt-audit-127\.0\.0\.1-\d{4}-\d{2}-\d{2}\.json$/);
  expect(name).not.toMatch(/token|SECRET|private|\?|#/);
  const parsed = parseAuditReport(text);
  expect(parsed.ok, parsed.ok ? '' : parsed.errors.join('; ')).toBe(true);
  const report = (parsed as { report: AuditReport }).report;
  expect(report.schemaVersion).toBe(1);
  expect(report.tool.name).toBe('ColorAdapt');
  expect(report.page).toEqual({ origin: server.origin, pathname: '/charts.html' });
  expect(report.audit).toMatchObject({
    basis: 'original-page-state',
    visionProfile: 'deuteranopia',
    adaptationEnabled: false,
  });
  expect(report).not.toHaveProperty('score');
});

test('the export agrees with what the audit page shows', async () => {
  const audited = await loadAudited(ext, server);
  const audit = await openWith(audited);
  const { text } = await exportAs(audit, 'Export JSON');
  const report = JSON.parse(text) as AuditReport;
  const snapshot = (await audited.get())!;
  expect(report.summary).toEqual(snapshot.summary);
  expect(report.findings.map((f) => f.id).sort()).toEqual(
    snapshot.findings.map((f) => f.id).sort(),
  );
  await expect(audit.getByTestId('summary-line')).toContainText(
    `${report.summary.findings} findings affecting ${report.summary.affectedElements} elements`,
  );
  for (const severity of ['critical', 'high', 'medium', 'low', 'info'] as const) {
    await expect(audit.getByTestId(`count-${severity}`)).toHaveText(
      String(report.summary.bySeverity[severity]),
    );
  }
  expect(report.summary.findings).toBe(report.findings.length);
  expect(report.summary.affectedElements).toBe(
    report.findings.reduce((n, f) => n + f.affectedCount, 0),
  );
});

test('holds nothing private: no value, no query token, no fragment, no data attribute, no password', async () => {
  const audited = await loadAudited(ext, server, undefined, '?token=SECRET#private');
  const audit = await openWith(audited);
  for (const kind of ['Export JSON', 'Export HTML report'] as const) {
    const { text } = await exportAs(audit, kind);
    for (const secret of SECRETS) expect(text, `${kind}: ${secret}`).not.toContain(secret);
  }
  const report = JSON.parse((await exportAs(audit, 'Export JSON')).text) as AuditReport;
  const targets = report.findings.flatMap((f) => f.affected);
  const field = targets.find((t) => t.locator.id === 'email-a');
  expect(field?.locator).toMatchObject({ tag: 'input', inputType: 'email', text: null });
  for (const { locator } of targets) {
    if (['input', 'textarea', 'select'].includes(locator.tag)) expect(locator.text).toBeNull();
  }
});

test('is deterministic: two exports of an unchanged page differ only in generatedAt', async () => {
  const audited = await loadAudited(ext, server);
  const audit = await openWith(audited);
  const strip = (text: string) => text.replace(/"generatedAt": "[^"]+"/, '"generatedAt": ""');
  const first = (await exportAs(audit, 'Export JSON')).text;
  await audit.getByRole('button', { name: 'Refresh audit' }).click();
  await expect.poll(async () => (await audited.diagnostics()).auditPasses).toBeGreaterThan(1);
  const second = (await exportAs(audit, 'Export JSON')).text;
  expect(strip(second)).toBe(strip(first));
  // And keys are sorted, so a diff of two reports shows what changed.
  const keys = Object.keys(JSON.parse(first) as object);
  expect(keys).toEqual([...keys].sort());
});

test('counts every export (a local counter, nothing is sent anywhere)', async () => {
  const audited = await loadAudited(ext, server);
  const audit = await openWith(audited);
  await exportAs(audit, 'Export JSON');
  await exportAs(audit, 'Export HTML report');
  await expect.poll(async () => (await audited.diagnostics()).auditExports).toBe(2);
});

test('the HTML report is one offline page: no script, no request, a CSP that forbids both', async () => {
  const testInfo = test.info();
  const audited = await loadAudited(ext, server);
  const audit = await openWith(audited);
  const [download] = await Promise.all([
    audit.waitForEvent('download'),
    audit.getByRole('button', { name: 'Export HTML report' }).click(),
  ]);
  const name = download.suggestedFilename();
  // Saved under its own name: Chromium shows a download's temporary file (no extension) as plain text.
  const path = testInfo.outputPath(name);
  await download.saveAs(path);
  const text = readDownload(path);
  expect(name).toMatch(/^coloradapt-audit-127\.0\.0\.1-\d{4}-\d{2}-\d{2}\.html$/);
  expect(text).toContain(`default-src 'none'; style-src 'unsafe-inline'`);
  const view = await ext.context.newPage();
  const requests: string[] = [];
  view.on('request', (request) => requests.push(request.url()));
  await view.goto(pathToFileURL(path).href);
  const facts = await view.evaluate(() => ({
    scripts: document.querySelectorAll('script').length,
    external: document.querySelectorAll(
      'link[href], img[src], iframe, object, embed, video, audio, source',
    ).length,
    handlers: [...document.querySelectorAll('*')]
      .flatMap((el) => el.getAttributeNames())
      .filter((n) => n.startsWith('on')).length,
    details: document.querySelectorAll('details').length,
    text: document.body.innerText,
  }));
  expect(facts.text).not.toContain('<!doctype html>'); // rendered as a page, not shown as source
  expect(facts).toMatchObject({ scripts: 0, external: 0, handlers: 0 });
  expect(facts.text).toContain('not a conformance statement and there is no score');
  expect(requests).toEqual([pathToFileURL(path).href]);
  const snapshot = (await audited.get())!;
  expect(facts.details).toBe(snapshot.findings.length);
});

test('a page cannot turn its own text into markup or script in the HTML report', async () => {
  const testInfo = test.info();
  const audited = await loadAudited(ext, server);
  await audited.page.evaluate(() => {
    const p = document.createElement('p');
    p.id = 'xss';
    p.className = 'low';
    p.textContent = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
    document.getElementById('audit-fixture')!.append(p);
  });
  const audit = await openWith(audited);
  await audit.getByRole('button', { name: 'Refresh audit' }).click();
  await expect.poll(async () => (await audited.diagnostics()).auditPasses).toBeGreaterThan(1);
  const [download] = await Promise.all([
    audit.waitForEvent('download'),
    audit.getByRole('button', { name: 'Export HTML report' }).click(),
  ]);
  const file = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(file);
  const text = readDownload(file);
  expect(text).toContain('&lt;img src=x');
  expect(text).not.toMatch(/<img\b/i);
  const view = await ext.context.newPage();
  await view.goto(pathToFileURL(file).href);
  expect(
    await view.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
  ).toBeUndefined();
  expect(await view.evaluate(() => document.querySelectorAll('img, script').length)).toBe(0);
  // The same text on the audit page itself is only text.
  const onAuditPage = await audit.evaluate(() => ({
    imgs: document.querySelectorAll('img').length,
    pwned: (window as unknown as { __pwned?: number }).__pwned,
  }));
  expect(onAuditPage).toEqual({ imgs: 0, pwned: undefined });
});

test('exports the page as authored when ColorAdapt is on', async () => {
  const audited = await loadAudited(ext, server, ADAPTED_SETTINGS);
  const audit = await openWith(audited);
  const report = JSON.parse((await exportAs(audit, 'Export JSON')).text) as AuditReport;
  expect(report.audit.adaptationEnabled).toBe(true);
  const cvd = report.findings.find((f) => f.ruleId === 'CA-COLOR-002');
  expect(cvd?.evidence.find((e) => e.key === 'colors.pair')?.value).toEqual({
    kind: 'colors',
    foreground: '#d62728',
    background: '#2ca02c',
  });
  expect(cvd?.adaptationStatus).toBe('adapted');
  expect(cvd?.sourceNote).toMatch(/original page/);
});
