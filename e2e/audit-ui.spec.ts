import { expect, test, type Page } from '@playwright/test';
import {
  launchExtension,
  startPageServer,
  settle,
  type ExtensionSession,
  type PageServer,
} from './harness';
import {
  ADAPTED_SETTINGS,
  AUDIT_SETTINGS,
  loadAudited,
  overlay,
  rectOf,
  type Audited,
} from './audit-kit';

/**
 * The developer audit page in a real Chromium: the findings it lists, the filters, the highlight on
 * the audited page (where it is, that it is click-through and moves nothing, that it follows
 * selection and goes away), live updates, single-page navigation, and keyboard use.
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

const card = (audit: Page, rule: string) =>
  audit.locator(`[data-testid="finding"][data-rule="${rule}"]`).first();

/** The card of the finding of `rule` that covers the page element `#id` (found through the snapshot, not the text). */
async function cardOf(audit: Page, audited: Audited, rule: string, id: string) {
  const snapshot = (await audited.get())!;
  const finding = snapshot.findings.find(
    (f) => f.ruleId === rule && f.affected.some((a) => a.locator.id === id),
  );
  if (!finding) throw new Error(`no ${rule} finding for #${id}`);
  return audit.locator(`[data-testid="finding"][data-finding-id="${finding.id}"]`);
}

const near = (a: { x: number; y: number; w: number; h: number }, b: typeof a, tolerance = 1.5) => {
  expect(Math.abs(a.x - b.x)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(a.w - b.w)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(a.h - b.h)).toBeLessThanOrEqual(tolerance);
};

/** The geometry of the page that a highlight must not disturb. */
const layout = (page: Page) =>
  page.evaluate(() => {
    const rect = (sel: string) => {
      const r = document.querySelector(sel)!.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height];
    };
    return {
      scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
      bodyChildren: document.body.children.length,
      rects: [
        '#low',
        '#cvd',
        '#email-a',
        '#icon',
        '#rows',
        '#bad-chart',
        '#canvas-chart',
        '#raster-chart',
      ].map(rect),
    };
  });

async function openAudit(audited: Audited) {
  const audit = await audited.open();
  await expect(audit.locator('[data-testid="finding"]').first()).toBeVisible();
  return audit;
}

test('lists the findings with severity as a word and a shape, and counts that add up', async () => {
  const audited = await loadAudited(ext, server);
  const audit = await openAudit(audited);
  const snapshot = (await audited.get())!;
  await expect(audit.locator('[data-testid="finding"]')).toHaveCount(snapshot.findings.length);
  for (const severity of ['critical', 'high', 'medium', 'low', 'info'] as const) {
    await expect(audit.getByTestId(`count-${severity}`)).toHaveText(
      String(snapshot.summary.bySeverity[severity]),
    );
  }
  const first = card(audit, 'CA-SEM-001');
  await expect(first).toContainText('Critical');
  await expect(first.locator('.badge__glyph')).toHaveText('⬢');
  await expect(first).toContainText('ColorAdapt: Adaptation off');
  await expect(first).toContainText('High confidence');
  await expect(first).toContainText('Not profile-specific');
  await expect(audit.getByTestId('summary-line')).toContainText(
    `${snapshot.summary.findings} findings`,
  );
  await expect(audit.getByTestId('page-line')).toContainText(`${server.origin}/charts.html`);
  expect(await audit.locator('body').innerText()).not.toMatch(
    /accessibility score:|\d+\s*\/\s*100/i,
  );
});

test('a card opens to evidence, a recommendation, the model confidence and the affected elements', async () => {
  const audited = await loadAudited(ext, server);
  const audit = await openAudit(audited);
  const cvd = card(audit, 'CA-COLOR-002');
  await cvd.getByRole('button', { name: /Foreground and background hard to tell apart/ }).click();
  await expect(cvd.locator('table.evidence')).toContainText('Simulated colors (deuteranopia)');
  await expect(cvd.locator('table.evidence')).toContainText('Model estimate');
  await expect(cvd.locator('table.evidence')).toContainText('Engineering threshold');
  await expect(cvd).toContainText('Recommendation');
  await expect(cvd).toContainText('Simulation model, Deuteranopia');
  await expect(cvd).toContainText('Supported model');
  await expect(cvd).toContainText('#d62728 on #2ca02c');
  await expect(cvd).toContainText('Finding confidence');
  await expect(cvd.locator('.card__targets')).toContainText('#cvd');
});

test('filters by severity, category, confidence and adaptation status, with counts that stay consistent', async () => {
  const audited = await loadAudited(ext, server);
  const audit = await openAudit(audited);
  const snapshot = (await audited.get())!;
  const status = audit.getByTestId('filter-status');
  const cards = audit.locator('[data-testid="finding"]');
  const option = (name: string) =>
    audit.locator('label.filters__option', { hasText: name }).locator('input');

  await option('Critical').check();
  const critical = snapshot.findings.filter((f) => f.severity === 'critical');
  await expect(cards).toHaveCount(critical.length);
  await expect(status).toContainText(
    `Showing ${critical.length} of ${snapshot.findings.length} findings`,
  );

  await option('Critical').uncheck();
  await option('Chart').check();
  const chart = snapshot.findings.filter((f) => f.category === 'chart');
  await expect(cards).toHaveCount(chart.length);
  await expect(status).toContainText(`Showing ${chart.length} of`);
  // Within one field options are alternatives; across fields they narrow.
  await option('Image').check();
  const chartOrImage = snapshot.findings.filter(
    (f) => f.category === 'chart' || f.category === 'image',
  );
  await expect(cards).toHaveCount(chartOrImage.length);
  await option('Needs manual review').check();
  const reviews = chartOrImage.filter((f) => f.assessment === 'manual-review');
  await expect(cards).toHaveCount(reviews.length);
  await audit.getByRole('button', { name: 'Clear filters' }).click();
  await expect(cards).toHaveCount(snapshot.findings.length);

  await option('Medium confidence').check();
  await expect(cards).toHaveCount(
    snapshot.findings.filter((f) => f.confidence === 'MEDIUM').length,
  );
  await option('Medium confidence').uncheck();
  await option('Adaptation off').check();
  await expect(cards).toHaveCount(
    snapshot.findings.filter((f) => f.adaptationStatus === 'not-enabled').length,
  );
  await audit.getByRole('button', { name: 'Clear filters' }).click();

  await audit.getByLabel('Search rule, title or element').fill('canvas');
  await expect(cards).toHaveCount(1);
  await expect(card(audit, 'CA-CHART-004')).toBeVisible();
  await audit.getByLabel('Search rule, title or element').fill('CA-COLOR-001');
  await expect(cards).toHaveCount(
    snapshot.findings.filter((f) => f.ruleId === 'CA-COLOR-001').length,
  );
  await audit.getByLabel('Search rule, title or element').fill('nothing matches this');
  await expect(cards).toHaveCount(0);
});

test('highlights the right element, click-through and without moving anything, and follows the selection', async () => {
  const audited = await loadAudited(ext, server);
  const audit = await openAudit(audited);
  const before = await layout(audited.page);
  expect(await overlay(audited.page)).toBeNull();

  const invalid = card(audit, 'CA-SEM-001');
  await invalid.getByRole('button', { name: /State communicated by color only/ }).click();
  await expect.poll(() => overlay(audited.page).then((o) => o !== null)).toBe(true);
  const box = (await overlay(audited.page))!;
  near(box.rect, await rectOf(audited.page, '#email-a'));
  expect(box).toMatchObject({ position: 'fixed', pointerEvents: 'none', parent: 'html', count: 1 });
  expect(await layout(audited.page)).toEqual(before); // nothing moved, nothing was added to the body
  // A click on the highlighted element goes to the element, not to the box.
  const hit = await audited.page.evaluate(() => {
    const r = document.getElementById('email-a')!.getBoundingClientRect();
    return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.id;
  });
  expect(hit).toBe('email-a');

  // Another card: the box moves, there is still only one.
  const contrast = await cardOf(audit, audited, 'CA-COLOR-001', 'low');
  await contrast.getByRole('button').first().click();
  await expect.poll(async () => (await overlay(audited.page))?.rect.y).not.toBe(box.rect.y);
  near((await overlay(audited.page))!.rect, await rectOf(audited.page, '#low'));
  expect((await overlay(audited.page))!.count).toBe(1);

  // The card that was open closed: collapsing the selected one removes the box.
  await contrast.getByRole('button').first().click();
  await expect.poll(() => overlay(audited.page)).toBeNull();
  expect(await layout(audited.page)).toEqual(before);
});

test('walks through the elements of a repeated finding with next and previous', async () => {
  const audited = await loadAudited(ext, server);
  const audit = await openAudit(audited);
  const rows = audit
    .locator('[data-testid="finding"][data-rule="CA-COLOR-001"]')
    .filter({ hasText: '5 elements' });
  await rows.getByRole('button').first().click();
  const position = rows.getByTestId('element-position');
  await expect(position).toHaveText('Element 1 of 5');
  near(
    (await overlay(audited.page))!.rect,
    await rectOf(audited.page, '#rows > li:nth-of-type(1)'),
  );
  await rows.getByRole('button', { name: 'Next element' }).click();
  await expect(position).toHaveText('Element 2 of 5');
  near(
    (await overlay(audited.page))!.rect,
    await rectOf(audited.page, '#rows > li:nth-of-type(2)'),
  );
  await rows.getByRole('button', { name: 'Previous element' }).click();
  await rows.getByRole('button', { name: 'Previous element' }).click();
  await expect(position).toHaveText('Element 5 of 5'); // wraps around
  near(
    (await overlay(audited.page))!.rect,
    await rectOf(audited.page, '#rows > li:nth-of-type(5)'),
  );
  expect((await overlay(audited.page))!.count).toBe(1);
  await rows.getByRole('button', { name: 'Show on page' }).nth(2).click();
  await expect(position).toHaveText('Element 3 of 5');
});

test('closing the audit page removes the highlight and ends the session on the page', async () => {
  const audited = await loadAudited(ext, server);
  const audit = await openAudit(audited);
  await card(audit, 'CA-SEM-001').getByRole('button').first().click();
  await expect.poll(() => overlay(audited.page).then((o) => o !== null)).toBe(true);
  await expect.poll(async () => (await audited.diagnostics()).auditWatching).toBe(true);
  await audit.close();
  await expect.poll(() => overlay(audited.page)).toBeNull();
  await expect.poll(async () => (await audited.diagnostics()).auditWatching).toBe(false);
  expect((await audited.diagnostics()).auditHighlightVisible).toBe(false);
});

test('follows the page while it is open: a new problem appears and a fixed one goes, without a refresh', async () => {
  const audited = await loadAudited(ext, server);
  const audit = await openAudit(audited);
  const lowCount = async () =>
    (await audited.get())!.findings.find(
      (f) => f.ruleId === 'CA-COLOR-001' && f.affected.some((a) => a.locator.id === 'low'),
    )?.affectedCount;
  expect(await lowCount()).toBe(1);

  await audited.page.evaluate(() => {
    const p = document.createElement('p');
    p.id = 'late';
    p.className = 'low';
    p.textContent = 'added later';
    document.getElementById('audit-fixture')!.append(p);
  });
  await expect.poll(lowCount).toBe(2);
  await expect(
    audit.locator('[data-testid="finding"]').filter({ hasText: '2 elements' }).first(),
  ).toBeVisible();
  expect((await audited.diagnostics()).auditLivePasses).toBeGreaterThan(0);

  await audited.page.evaluate(() => {
    document.getElementById('late')!.className = 'fine';
  });
  await expect.poll(lowCount).toBe(1);
  await audited.page.evaluate(() => document.getElementById('low')!.remove());
  await expect.poll(lowCount).toBeUndefined();
  expect((await audited.diagnostics()).auditWatching).toBe(true);
});

test('a highlight whose element is removed is cleared, and a card whose finding is gone closes', async () => {
  const audited = await loadAudited(ext, server);
  const audit = await openAudit(audited);
  await (await cardOf(audit, audited, 'CA-COLOR-001', 'low')).getByRole('button').first().click();
  await expect.poll(() => overlay(audited.page).then((o) => o !== null)).toBe(true);
  await audited.page.evaluate(() => document.getElementById('low')!.remove());
  await expect.poll(() => overlay(audited.page)).toBeNull();
  await expect(audit.locator('button[aria-expanded="true"]')).toHaveCount(0);
});

test('after a route change in a single-page app the old route’s findings are gone', async () => {
  const audited = await loadAudited(ext, server);
  const audit = await openAudit(audited);
  await audited.page.evaluate(() => {
    history.pushState({}, '', '/spa/next');
    document.body.innerHTML =
      '<p id="fresh" style="color:#000;background:#fff">A readable new page</p>';
  });
  await expect(audit.getByTestId('page-line')).toContainText('/spa/next');
  await expect(audit.locator('[data-testid="finding"]')).toHaveCount(0);
  await expect(audit.getByText('No findings.')).toBeVisible();
});

test('works with the keyboard: every card is reachable, Enter opens it, focus is visible', async () => {
  const audited = await loadAudited(ext, server);
  const audit = await openAudit(audited);
  const toggle = card(audit, 'CA-SEM-001').locator('h3 > button');
  await toggle.focus();
  const outline = await toggle.evaluate((el) => getComputedStyle(el).outlineWidth);
  expect(Number.parseFloat(outline)).toBeGreaterThanOrEqual(2);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await audit.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await audit.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  // Tab order reaches a card's toggle after the filters, in document order, with no keyboard trap.
  await audit.getByRole('button', { name: 'Refresh audit' }).focus();
  let reached = false;
  for (let i = 0; i < 80 && !reached; i += 1) {
    await audit.keyboard.press('Tab');
    reached = await audit.evaluate(
      () => document.activeElement?.closest('[data-testid="finding"]') !== null,
    );
  }
  expect(reached).toBe(true);
});

test('is a page assistive technology can read: landmarks, headings in order, every control named', async () => {
  const audited = await loadAudited(ext, server);
  const audit = await openAudit(audited);
  await card(audit, 'CA-SEM-001').locator('h3 > button').click();
  const facts = await audit.evaluate(() => {
    const names = [...document.querySelectorAll('button, input, select')].map((el) => {
      const labelled =
        el.getAttribute('aria-label') ??
        el.closest('label')?.textContent ??
        (el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent : '') ??
        '';
      return (el.textContent ?? '').trim() || labelled.trim();
    });
    const levels = [...document.querySelectorAll('h1,h2,h3,h4')].map((h) => Number(h.tagName[1]));
    return {
      main: document.querySelectorAll('main').length,
      h1: levels.filter((l) => l === 1).length,
      jumps: levels.filter((level, i) => i > 0 && level - levels[i - 1]! > 1).length,
      unnamed: names.filter((name) => name === '').length,
      lang: document.documentElement.lang,
    };
  });
  expect(facts).toEqual({ main: 1, h1: 1, jumps: 0, unnamed: 0, lang: 'en' });
});

test('tells the developer when the audited page went away', async () => {
  const audited = await loadAudited(ext, server);
  const audit = await openAudit(audited);
  await audited.page.close();
  await expect(audit.getByRole('alert')).toContainText('closed or navigated away');
});

test('with ColorAdapt on, the page shows the audit what it adapted and what it did not', async () => {
  const audited = await loadAudited(ext, server, ADAPTED_SETTINGS);
  const audit = await openAudit(audited);
  await expect(card(audit, 'CA-SEM-001')).toContainText('ColorAdapt: Adapted by ColorAdapt');
  await card(audit, 'CA-COLOR-002').getByRole('button').first().click();
  await expect(card(audit, 'CA-COLOR-002')).toContainText('compensates on the page');
  await settle(audited.page);
});

test('audit-only settings still work from the audit page (adaptation off)', async () => {
  const audited = await loadAudited(ext, server, AUDIT_SETTINGS);
  const audit = await openAudit(audited);
  await expect(card(audit, 'CA-CHART-004')).toContainText('Needs manual review');
  await expect(audit.getByTestId('summary-line')).toContainText('need manual review');
});

test('stays usable at common widths: no horizontal scrolling from a wide window to a narrow one', async () => {
  const audited = await loadAudited(ext, server);
  const audit = await openAudit(audited);
  await card(audit, 'CA-SEM-001').locator('h3 > button').click();
  for (const width of [1440, 1024, 768, 480, 360]) {
    await audit.setViewportSize({ width, height: 800 });
    const overflow = await audit.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${width}px`).toBeLessThanOrEqual(1);
    await expect(card(audit, 'CA-SEM-001').locator('h3 > button')).toBeVisible();
  }
});

test('does not tell severities apart by color: one text color, a different shape and outline for each', async () => {
  const audited = await loadAudited(ext, server);
  const audit = await openAudit(audited);
  const badges = await audit.evaluate(() =>
    [...document.querySelectorAll('.summary__severity .badge')].map((badge) => {
      const style = getComputedStyle(badge);
      return {
        label: badge.textContent?.trim() ?? '',
        color: style.color,
        borderColor: style.borderTopColor,
        borderStyle: style.borderTopStyle,
        borderWidth: style.borderTopWidth,
      };
    }),
  );
  expect(badges).toHaveLength(5);
  expect(new Set(badges.map((b) => b.color)).size).toBe(1);
  expect(new Set(badges.map((b) => b.borderColor)).size).toBe(1);
  expect(new Set(badges.map((b) => b.label)).size).toBe(5); // a word and a glyph each
  expect(
    new Set(badges.map((b) => `${b.borderStyle}/${b.borderWidth}`)).size,
  ).toBeGreaterThanOrEqual(4);
});

test('the popup offers the developer audit and opens it for the active tab in a tab of its own', async () => {
  const extensionId = new URL(ext.worker.url()).host;
  const popup = await ext.context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const button = popup.getByRole('button', { name: 'Developer audit' });
  await expect(button).toBeVisible();
  const [opened] = await Promise.all([ext.context.waitForEvent('page'), button.click()]);
  await opened.waitForLoadState();
  expect(opened.url()).toMatch(/^chrome-extension:\/\/[a-p]{32}\/audit\.html\?tabId=\d+$/);
  // The popup was itself the active tab here, so there is no page to audit: the audit page says so.
  await expect(opened.getByRole('alert')).toBeVisible();
});
