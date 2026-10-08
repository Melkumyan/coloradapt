import { expect, test, type Page } from '@playwright/test';
import {
  disable,
  enable,
  launchExtension,
  setSettings,
  settle,
  startPageServer,
  type ExtensionSession,
  type PageServer,
} from './harness';
import {
  ADAPTED_SETTINGS,
  AUDIT_SETTINGS,
  EXPECTED_ISSUES,
  EXPECTED_REVIEWS,
  SECRETS,
  keys,
  loadAudited,
} from './audit-kit';

/**
 * M9 in a real Chromium, from the page's side: what the audit finds on a page that has something of
 * everything, that it finds the same with ColorAdapt on and off, that it writes nothing to the page,
 * and that nothing of the user's leaks into it.
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

const sorted = (list: readonly string[]) => [...list].sort();

/** Everything ColorAdapt may have written, found by its names in the document. */
const owned = (page: Page) =>
  page.evaluate(() => ({
    sheet: document.getElementById('coloradapt-stylesheet') !== null,
    cues: document.querySelectorAll('[data-coloradapt-cue]').length,
    chart: document.querySelectorAll(
      '[data-coloradapt-chart-node],[data-coloradapt-chart-mark],[data-coloradapt-chart-owned]',
    ).length,
    overlay: document.querySelectorAll('[data-coloradapt-audit-overlay]').length,
    attributes: [...document.querySelectorAll('*')]
      .flatMap((el) => el.getAttributeNames())
      .filter(
        (name) =>
          name.startsWith('data-coloradapt-') &&
          name !== 'data-coloradapt-id' &&
          name !== 'data-coloradapt-s' &&
          !name.startsWith('data-coloradapt-chart'),
      ),
  }));

/** The page's markup as the page wrote it: ColorAdapt's ids and chart nodes removed. */
const pristine = (page: Page) =>
  page.evaluate(() => {
    const clone = document.documentElement.cloneNode(true) as Element;
    for (const node of clone.querySelectorAll(
      '[data-coloradapt-chart-node],#coloradapt-stylesheet',
    ))
      node.remove();
    for (const el of [clone, ...clone.querySelectorAll('*')]) {
      for (const name of el.getAttributeNames())
        if (name.startsWith('data-coloradapt-id') || name === 'data-coloradapt-s') {
          el.removeAttribute(name);
        }
    }
    return clone.outerHTML;
  });

test('finds exactly what a reviewer would find on the page, with adaptation off', async () => {
  const audited = await loadAudited(ext, server);
  const snapshot = await audited.run('auto');
  expect(keys(snapshot, 'issue')).toEqual(sorted(EXPECTED_ISSUES));
  expect(keys(snapshot, 'manual-review')).toEqual(sorted(EXPECTED_REVIEWS));
  expect(keys(snapshot, 'analysis-limitation')).toEqual([]);
  expect(snapshot.settings).toEqual({
    activeProfile: 'deuteranopia',
    auditedProfiles: ['deuteranopia'],
    adaptationEnabled: false,
  });
  expect(snapshot.page).toEqual({ origin: server.origin, pathname: '/charts.html' });
});

test('leaves the safe and the accessible alone', async () => {
  const audited = await loadAudited(ext, server);
  const snapshot = await audited.run('auto');
  const flagged = snapshot.findings.flatMap((f) => f.affected.map((a) => a.locator.id));
  for (const id of [
    'fine',
    'brand',
    'ok-badge',
    'bad-badge',
    'deco-icon',
    'game',
    'photo',
    'logo',
    'good-chart',
    'pw',
    'email-b',
    'notes',
    'edit',
    'data',
  ]) {
    expect(flagged, id).not.toContain(id);
  }
});

test('rates the color-only invalid field above everything else and reviews at most low', async () => {
  const audited = await loadAudited(ext, server);
  const snapshot = await audited.run('auto');
  expect(snapshot.findings[0]?.ruleId).toBe('CA-SEM-001');
  expect(snapshot.findings[0]?.severity).toBe('critical');
  for (const finding of snapshot.findings.filter((f) => f.assessment !== 'issue')) {
    expect(['low', 'info']).toContain(finding.severity);
  }
});

test('with adaptation off the audit writes nothing the page can see (audit-only mode)', async () => {
  const audited = await loadAudited(ext, server);
  const before = await pristine(audited.page);
  await audited.run('auto');
  await audited.run('major');
  expect(await owned(audited.page)).toEqual({
    sheet: false,
    cues: 0,
    chart: 0,
    overlay: 0,
    attributes: [],
  });
  expect(await pristine(audited.page)).toBe(before);
});

test('finds the same source problems with ColorAdapt on, whatever it did to the page', async () => {
  const audited = await loadAudited(ext, server, ADAPTED_SETTINGS);
  // ColorAdapt really adapted the page: recolored text, a cue next to the invalid field, a chart encoding.
  const adapted = await owned(audited.page);
  expect(adapted.sheet).toBe(true);
  expect(adapted.cues).toBeGreaterThan(0);
  expect(adapted.chart).toBeGreaterThan(0);
  const cvdColor = await audited.page.evaluate(
    () => getComputedStyle(document.getElementById('cvd')!).color,
  );
  expect(cvdColor).not.toBe('rgb(214, 39, 40)'); // the page's own #d62728 is no longer what is shown

  const on = await audited.run('auto');
  expect(keys(on, 'issue')).toEqual(sorted(EXPECTED_ISSUES));
  expect(keys(on, 'manual-review')).toEqual(sorted(EXPECTED_REVIEWS));

  await disable(ext.worker, audited.page);
  await settle(audited.page);
  expect(await owned(audited.page)).toMatchObject({ sheet: false, cues: 0 });
  const off = await audited.run('auto');
  const fingerprint = (s: typeof on) =>
    s.findings
      .map((f) =>
        JSON.stringify([
          f.id,
          f.ruleId,
          f.severity,
          f.confidence,
          f.assessment,
          f.affectedCount,
          f.visionProfiles,
          f.evidence,
        ]),
      )
      .sort();
  expect(fingerprint(on)).toEqual(fingerprint(off));
  expect(on.findings.map((f) => f.id)).toEqual(off.findings.map((f) => f.id));
});

test('says what ColorAdapt did: adapted with it on, not enabled with it off, the problem unchanged', async () => {
  const audited = await loadAudited(ext, server, ADAPTED_SETTINGS);
  const on = await audited.run('auto');
  const status = (s: typeof on, rule: string, id: string) =>
    s.findings.find((f) => f.ruleId === rule && f.affected.some((a) => a.locator.id === id))
      ?.adaptationStatus;
  expect(status(on, 'CA-COLOR-002', 'cvd')).toBe('adapted');
  expect(status(on, 'CA-SEM-001', 'email-a')).toBe('adapted');
  expect(status(on, 'CA-CHART-001', 'bad-chart')).toBe('adapted');
  expect(on.summary.adapted).toBeGreaterThan(0);
  await disable(ext.worker, audited.page);
  const off = await audited.run('auto');
  expect(status(off, 'CA-COLOR-002', 'cvd')).toBe('not-enabled');
  expect(off.summary.adapted).toBe(0);
  expect(off.summary.unresolved).toBe(on.summary.adapted + on.summary.unresolved);
});

test('an audit changes nothing in an adapted page: markup, injected style and cues stay as they were', async () => {
  const audited = await loadAudited(ext, server, ADAPTED_SETTINGS);
  const before = {
    html: await pristine(audited.page),
    css: await audited.page.evaluate(
      () => document.getElementById('coloradapt-stylesheet')?.textContent,
    ),
    owned: await owned(audited.page),
  };
  await audited.run('auto');
  await audited.run('major');
  expect(await pristine(audited.page)).toBe(before.html);
  expect(
    await audited.page.evaluate(
      () => document.getElementById('coloradapt-stylesheet')?.textContent,
    ),
  ).toBe(before.css);
  expect(await owned(audited.page)).toEqual(before.owned);
});

test('re-adapting after an audit leaves the adaptation exactly as it was', async () => {
  const audited = await loadAudited(ext, server, ADAPTED_SETTINGS);
  const css = () =>
    audited.page.evaluate(
      () => document.getElementById('coloradapt-stylesheet')?.textContent ?? '',
    );
  const before = await css();
  await audited.run('auto');
  await enable(ext.worker, audited.page);
  await settle(audited.page);
  expect(await css()).toBe(before);
});

test('the finding ids are the same on every refresh', async () => {
  const audited = await loadAudited(ext, server);
  const ids = async () => {
    const snapshot = await audited.run('auto');
    return JSON.stringify([
      snapshot.findings.map((f) => f.id),
      snapshot.findings.flatMap((f) => f.affected.map((a) => a.instanceId)),
    ]);
  };
  const first = await ids();
  for (let i = 0; i < 4; i += 1) expect(await ids()).toBe(first);
});

test('audits the three major profiles for a developer with normal vision and groups them in one card', async () => {
  const audited = await loadAudited(ext, server, { ...AUDIT_SETTINGS, visionProfile: 'normal' });
  const snapshot = await audited.run('auto');
  expect(snapshot.settings.auditedProfiles).toEqual(['protanopia', 'deuteranopia', 'tritanopia']);
  const cvd = snapshot.findings.filter((f) => f.ruleId === 'CA-COLOR-002');
  expect(cvd).toHaveLength(1); // one card, not one per profile
  expect(cvd[0]?.visionProfiles).toContain('deuteranopia');
  const chart = snapshot.findings.filter((f) => f.ruleId === 'CA-CHART-001');
  expect(chart).toHaveLength(1);
  expect(chart[0]?.simulation.map((s) => s.profile)).toEqual(chart[0]?.visionProfiles);
  expect(cvd[0]?.adaptationStatus).toBe('not-applicable'); // ColorAdapt does not adapt for normal vision
});

test('carries M2’s scientific status per profile, apart from the finding confidence', async () => {
  const audited = await loadAudited(ext, server, {
    ...AUDIT_SETTINGS,
    visionProfile: 'deuteranomaly',
  });
  // A pair that normal vision tells apart and a half-strength deuteranomaly simulation merges.
  await audited.page.evaluate(() => {
    const p = document.createElement('p');
    p.id = 'mild';
    p.setAttribute('style', 'color:#b5651d;background-color:#6b8e23');
    p.textContent = 'Brown on olive';
    document.getElementById('audit-fixture')!.append(p);
  });
  const snapshot = await audited.run('active');
  const cvd = snapshot.findings.find((f) => f.ruleId === 'CA-COLOR-002');
  expect(cvd?.affected[0]?.locator.id).toBe('mild');
  expect(cvd?.confidence).toBe('HIGH');
  expect(cvd?.simulation).toEqual([
    expect.objectContaining({ profile: 'deuteranomaly', modelConfidence: 'MODEL_ASSUMPTION' }),
  ]);
  expect(
    snapshot.findings.every((f) => f.severity !== 'critical' || f.simulation.length === 0),
  ).toBe(true);
});

test('holds no value, no query, no fragment, no data attribute of the page', async () => {
  const audited = await loadAudited(ext, server, AUDIT_SETTINGS, '?token=SECRET#private');
  const snapshot = await audited.run('auto');
  const text = JSON.stringify(snapshot);
  for (const secret of SECRETS) expect(text, secret).not.toContain(secret);
  expect(snapshot.page).toEqual({ origin: server.origin, pathname: '/charts.html' });
  for (const { locator } of snapshot.findings.flatMap((f) => f.affected)) {
    if (['input', 'textarea', 'select'].includes(locator.tag)) expect(locator.text).toBeNull();
    expect((locator.text ?? '').length).toBeLessThanOrEqual(40);
  }
  const field = snapshot.findings
    .flatMap((f) => f.affected)
    .find((a) => a.locator.id === 'email-a');
  expect(field?.locator).toMatchObject({ tag: 'input', inputType: 'email', text: null });
});

test('after the audit nothing of it is left on the page, and the page reports no stale session', async () => {
  const audited = await loadAudited(ext, server);
  await audited.run('auto');
  expect(await audited.diagnostics()).toMatchObject({
    auditWatching: false,
    auditHighlightVisible: false,
    auditPasses: 1,
  });
  await setSettings(ext.worker, AUDIT_SETTINGS);
});
