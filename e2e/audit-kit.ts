import { expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { AuditDiagnostics, AuditProfileScope, AuditSnapshot } from '../src/core/audit';
import { draw, RED_GREEN, DISTINCT } from './chart-kit';
import {
  dynamicDiagnostics,
  flushDynamic,
  setSettings,
  settle,
  type ExtensionSession,
  type PageServer,
} from './harness';

/**
 * Shared pieces of the M9 real-browser suites: a fixture page that has something of everything the
 * audit looks at (and the user data it must never carry away), helpers that talk to the content
 * script with the real typed messages, and helpers that open the audit page. Everything reads the
 * browser; nothing sleeps.
 */
declare const chrome: {
  tabs: {
    query(query: Record<string, unknown>): Promise<Array<{ id?: number; url?: string }>>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
  };
};

export const AUDIT_SETTINGS = {
  enabled: false,
  visionProfile: 'deuteranopia',
  adaptationStrength: 1,
  semanticCuesEnabled: true,
  adaptCharts: true,
  adaptSVG: true,
} as const;

export const ADAPTED_SETTINGS = { ...AUDIT_SETTINGS, enabled: true } as const;

/** What the audit must make of `FIXTURE`, as `rule@#id`, under deuteranopia (the other things on the page are fine). */
export const EXPECTED_ISSUES = [
  'CA-CHART-001@#bad-chart',
  'CA-COLOR-001@#rows>li:nth-of-type(1)',
  'CA-COLOR-001@#rows>li:nth-of-type(2)',
  'CA-COLOR-001@#rows>li:nth-of-type(3)',
  'CA-COLOR-001@#rows>li:nth-of-type(4)',
  'CA-COLOR-001@#rows>li:nth-of-type(5)',
  'CA-COLOR-001@#cvd',
  'CA-COLOR-001@#low',
  'CA-COLOR-002@#cvd',
  'CA-SEM-001@#email-a',
  'CA-SVG-001@#icon',
] as const;

export const EXPECTED_REVIEWS = ['CA-CHART-004@#canvas-chart', 'CA-IMG-002@#raster-chart'] as const;

const CSS = `
  .low { color: #aaaaaa; background-color: #ffffff; }
  .cvd { color: #d62728; background-color: #2ca02c; }
  .fine { color: #000000; background-color: #ffffff; }
  .brand { color: #ffffff; background-color: #d62728; }
  .f { border-top: 1px solid #888888; }
  .f[aria-invalid="true"] { border-top-color: #c0392b; }
  .badge { display: inline-block; padding: 2px 6px; color: #ffffff; }
  .badge.success { background-color: #1a7f37; }
  .badge.error { background-color: #b42318; }
  #audit-fixture { margin: 8px; }
`;

const FIXTURE = `
  <p id="low" class="low">Low contrast paragraph that is hard to read</p>
  <p id="cvd" class="cvd">Red on green text, merges for deuteranopia</p>
  <p id="fine" class="fine">A perfectly readable paragraph</p>
  <p id="brand" class="brand">Brand banner</p>
  <p><input id="email-a" class="f" type="email" aria-invalid="true" aria-label="Email" value="jane.doe@example.com">
  <input id="pw" class="f" type="password" aria-label="Password" value="hunter2-SECRET">
  <input id="email-b" class="f" type="email" aria-label="Other email" value="bob@example.com"></p>
  <textarea id="notes" class="f" aria-label="Notes">dear diary SECRET-NOTE</textarea>
  <p id="edit" class="fine" contenteditable="true">typed by the user SECRET-EDIT</p>
  <p id="data" class="fine" data-user-id="USER-998877" data-token="TOKEN-ABCDEF">Contact jane.doe@example.com</p>
  <span id="ok-badge" class="badge success">✓ Passed</span> <span id="bad-badge" class="badge error">✗ Failed</span>
  <button id="icon-button" type="button"><svg id="icon" style="color: #dddddd" width="24" height="24" viewBox="0 0 24 24"><path d="M2 2 L22 2 L12 22 Z" fill="currentColor"/></svg></button>
  <svg id="deco-icon" aria-hidden="true" style="color: #dddddd" width="24" height="24" viewBox="0 0 24 24"><path d="M2 2 L22 2 L12 22 Z" fill="currentColor"/></svg>
  <canvas id="canvas-chart" class="sales-chart" width="300" height="100"></canvas>
  <canvas id="game" class="game-canvas" width="300" height="100"></canvas>
  <img id="raster-chart" src="/img/quarterly-chart.png" alt="Quarterly chart" width="300" height="100">
  <img id="photo" src="/img/team.jpg" alt="The team at the offsite" width="300" height="100">
  <img id="logo" src="/img/acme-logo.png" alt="Acme logo" width="80" height="32">
  <ul id="rows"><li class="low">row one</li><li class="low">row two</li><li class="low">row three</li><li class="low">row four</li><li class="low">row five</li></ul>
`;

/** Words that must never reach a report, from the fixture's user data and the page address. */
export const SECRETS = [
  'hunter2',
  'SECRET',
  'jane.doe',
  'bob@',
  'dear diary',
  'typed by the user',
  'USER-998877',
  'TOKEN-ABCDEF',
  'token=',
  '#private',
];

export interface Audited {
  readonly page: Page;
  readonly tabId: number;
  readonly extensionId: string;
  /** The audit page, once opened. */
  open(scope?: AuditProfileScope): Promise<Page>;
  /** One pass through the typed message (the page's own view of the audit). */
  run(scope?: AuditProfileScope): Promise<AuditSnapshot>;
  get(): Promise<AuditSnapshot | null>;
  diagnostics(): Promise<AuditDiagnostics>;
}

/** `rule@#id` of every element of every finding of one assessment (the fixture's elements all have ids). */
export function keys(
  snapshot: AuditSnapshot,
  assessment: 'issue' | 'manual-review' | 'analysis-limitation',
): string[] {
  const out = new Set<string>();
  for (const finding of snapshot.findings) {
    if (finding.assessment !== assessment) continue;
    for (const affected of finding.affected) {
      out.add(
        `${finding.ruleId}@${affected.locator.id ? `#${affected.locator.id}` : affected.locator.path}`,
      );
    }
  }
  return [...out].sort();
}

/** The id of the tab showing `page`: found by address (a match pattern cannot hold a query or a fragment). */
async function tabIdOf(ext: ExtensionSession, page: Page): Promise<number> {
  const id = await ext.worker.evaluate(async (url) => {
    const tabs = (await chrome.tabs.query({})).filter((tab) => tab.url === url);
    return tabs.length === 1 ? (tabs[0]?.id ?? -1) : -tabs.length - 2;
  }, page.url());
  if (id < 0) throw new Error(`expected exactly one tab for ${page.url()}, found ${-id - 2}`);
  return id;
}

async function send<T>(
  ext: ExtensionSession,
  page: Page,
  type: string,
  payload: unknown,
): Promise<T> {
  const tabId = await tabIdOf(ext, page);
  return (await ext.worker.evaluate(
    async ({ tabId: id, type: messageType, payload: body }) =>
      await chrome.tabs.sendMessage(id, {
        channel: 'coloradapt',
        type: messageType,
        payload: body,
      }),
    { tabId, type, payload },
  )) as T;
}

/** Loads the chart page, fills it with the audit fixture and two charts, and returns handles on it. */
export async function loadAudited(
  ext: ExtensionSession,
  server: PageServer,
  settings: Record<string, unknown> = AUDIT_SETTINGS,
  query = '',
): Promise<Audited> {
  await setSettings(ext.worker, settings);
  const page = await ext.context.newPage();
  await page.goto(`${server.origin}/charts.html${query}`);
  await page.evaluate(
    ({ css, html }) => {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.append(style);
      const holder = document.createElement('div');
      holder.id = 'audit-fixture';
      holder.innerHTML = html;
      document.body.prepend(holder);
    },
    { css: CSS, html: FIXTURE },
  );
  await draw(page, 'line', { id: 'bad-chart', series: RED_GREEN, legend: 'svg' });
  await draw(page, 'line', { id: 'good-chart', series: DISTINCT, legend: 'svg' });
  if (settings['enabled'] === true) {
    // ColorAdapt is on: let it adapt the page (the fixture and the charts included) before anything is audited.
    await expect
      .poll(async () => (await dynamicDiagnostics(ext.worker, page).catch(() => null))?.state)
      .toBe('IDLE');
    await flushDynamic(ext.worker, page);
  }
  await expect
    .poll(
      async () =>
        (await send<AuditDiagnostics>(ext, page, 'AUDIT_DIAGNOSTICS', undefined).catch(() => null))
          ?.auditPasses,
    )
    .toBe(0);
  await settle(page);
  const tabId = await tabIdOf(ext, page);
  const extensionId = new URL(ext.worker.url()).host;
  return {
    page,
    tabId,
    extensionId,
    run: (scope = 'auto') => send<AuditSnapshot>(ext, page, 'AUDIT_RUN', { scope }),
    get: () => send<AuditSnapshot | null>(ext, page, 'AUDIT_GET', undefined),
    diagnostics: () => send<AuditDiagnostics>(ext, page, 'AUDIT_DIAGNOSTICS', undefined),
    open: async (scope) => {
      const audit = await ext.context.newPage();
      await audit.goto(`chrome-extension://${extensionId}/audit.html?tabId=${tabId}`);
      await expect(audit.getByTestId('summary-line')).toBeVisible();
      if (scope && scope !== 'auto') {
        await audit.getByLabel('Profiles to audit').selectOption(scope);
        await expect(audit.getByTestId('summary-line')).toBeVisible();
      }
      return audit;
    },
  };
}

/** The highlight box of the audit page's session, as the page (not the extension) sees it. */
export async function overlay(page: Page) {
  return page.evaluate(() => {
    const box = document.querySelector('[data-coloradapt-audit-overlay]');
    if (!box) return null;
    const rect = box.getBoundingClientRect();
    const style = getComputedStyle(box);
    return {
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      position: style.position,
      pointerEvents: style.pointerEvents,
      parent: box.parentElement?.localName ?? null,
      count: document.querySelectorAll('[data-coloradapt-audit-overlay]').length,
    };
  });
}

/** Rect of one element of the page, in viewport coordinates. */
export function rectOf(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)!;
    const rect = el.getBoundingClientRect();
    return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
  }, selector);
}

export const readDownload = (path: string | null): string => readFileSync(path ?? '', 'utf8');
