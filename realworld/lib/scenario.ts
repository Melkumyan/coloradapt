/**
 * Shared kit of the M10 scenario suites: which browsers to run, a recorder that keeps one line per check (the
 * raw material of docs/COMPATIBILITY.md and docs/REAL_WORLD_VALIDATION.md), and small helpers over the
 * extension's typed messages.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { AuditSnapshot } from '../../src/core/audit';
import { ROOT, startChrome, startFirefox, type BrowserName, type Driver, type Tab } from './driver';

export const BROWSERS: BrowserName[] = (process.env['RW_BROWSERS'] ?? 'chrome,firefox')
  .split(',')
  .filter((b): b is BrowserName => b === 'chrome' || b === 'firefox');

export type Verdict = 'PASS' | 'FAIL' | 'INFO' | 'NOT_VERIFIED';

export interface ScenarioRecord {
  readonly area: string;
  readonly check: string;
  readonly browser: BrowserName;
  readonly browserVersion: string;
  readonly verdict: Verdict;
  readonly detail: string;
  readonly at: string;
}

const OUT = path.join(ROOT, 'realworld', '.artifacts');

export function record(
  driver: Pick<Driver, 'name' | 'version'>,
  area: string,
  check: string,
  verdict: Verdict,
  detail = '',
): void {
  mkdirSync(OUT, { recursive: true });
  const line: ScenarioRecord = {
    area,
    check: process.env['RW_LABEL'] ? `[${process.env['RW_LABEL']}] ${check}` : check,
    browser: driver.name,
    browserVersion: driver.version,
    verdict,
    detail: detail.slice(0, 600),
    at: new Date().toISOString(),
  };
  appendFileSync(path.join(OUT, 'scenarios.jsonl'), `${JSON.stringify(line)}\n`);
}

export function launch(name: BrowserName): Promise<Driver> {
  return name === 'chrome' ? startChrome() : startFirefox();
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Polls `read` until it returns a truthy value (never a fixed sleep as the only signal). */
export async function until<T>(
  read: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  what: string | (() => string),
  timeoutMs = 12_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  for (;;) {
    try {
      const value = await read();
      if (value) return value;
      last = value;
    } catch (e) {
      last = (e as Error).message;
    }
    if (Date.now() > deadline) {
      const label = typeof what === 'function' ? what() : what;
      throw new Error(`timed out waiting for ${label} (last: ${String(last)})`);
    }
    await sleep(150);
  }
}

export const SETTINGS_OFF = {
  enabled: false,
  visionProfile: 'deuteranopia',
  adaptationStrength: 1,
  semanticCuesEnabled: true,
  adaptCharts: true,
  adaptSVG: true,
  adaptImages: false,
} as const;

export const SETTINGS_ON = { ...SETTINGS_OFF, enabled: true } as const;

export const auditRun = (tab: Tab, scope = 'auto'): Promise<AuditSnapshot> =>
  tab.ext<AuditSnapshot>('AUDIT_RUN', { scope });

/** `rule:assessment` of every finding, sorted. */
export function ruleList(snapshot: AuditSnapshot): string[] {
  return snapshot.findings.map((f) => `${f.ruleId}:${f.assessment}`).sort();
}

/** `rule@path` of every affected element of every finding of a rule. */
export function affected(snapshot: AuditSnapshot, rule: string): string[] {
  return snapshot.findings
    .filter((f) => f.ruleId === rule)
    .flatMap((f) => f.affected.map((a) => (a.locator.id ? `#${a.locator.id}` : a.locator.path)))
    .sort();
}

export function coverageLevel(snapshot: AuditSnapshot, id: string): string {
  return snapshot.coverage.subsystems.find((s) => s.id === id)?.level ?? 'missing';
}

export const hasStylesheet = (tab: Tab): Promise<boolean> =>
  tab.evaluate<boolean>(`!!document.getElementById('coloradapt-stylesheet')`);

export const colorOf = (tab: Tab, selector: string, property = 'color'): Promise<string> =>
  tab.evaluate<string>(
    `getComputedStyle(document.querySelector(${JSON.stringify(selector)})).getPropertyValue(${JSON.stringify(property)})`,
  );

/** Waits for the dynamic pipeline to be idle (the content script's own signal). */
export async function settled(tab: Tab): Promise<void> {
  await until(
    async () => (await tab.ext<{ state: string }>('GET_DYNAMIC_DIAGNOSTICS')).state === 'IDLE',
    'dynamic pipeline idle',
  );
  await tab.ext('FLUSH_DYNAMIC');
}

// ---------------------------------------------------------------------------------------------------------
// HTML kit
// ---------------------------------------------------------------------------------------------------------

export const CSS = `
  body { font: 16px/1.4 sans-serif; margin: 12px; background: #ffffff; color: #111111; }
  .low { color: #aaaaaa; background-color: #ffffff; }
  .cvd { color: #d62728; background-color: #2ca02c; }
  .fine { color: #000000; background-color: #ffffff; }
`;

export function html(body: string, head = '', attrs = 'lang="en"'): string {
  return `<!doctype html><html ${attrs}><head><meta charset="utf-8"><title>fixture</title><style>${CSS}</style>${head}</head><body>${body}</body></html>`;
}

/** The standard small fixture: a low-contrast and a color-vision conflict, plus a readable control. */
export const BASIC = html(`
  <p id="low" class="low">Low contrast paragraph that is hard to read</p>
  <p id="cvd" class="cvd">Red on green text, merges for deuteranopia</p>
  <p id="fine" class="fine">A perfectly readable paragraph</p>
`);

// ---------------------------------------------------------------------------------------------------------
// Real downloads: a browser that saves what the audit page exports into a temp folder
// ---------------------------------------------------------------------------------------------------------

import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

export interface DownloadingBrowser {
  readonly driver: Driver;
  readonly dir: string;
  /** What the browser itself reported about downloads (Chrome: DevTools events), for explaining a missing file. */
  readonly events: string[];
}

/** A browser whose downloads land in a fresh temp folder (the audit's JSON/HTML exports are real files). */
export async function launchWithDownloads(name: BrowserName): Promise<DownloadingBrowser> {
  const dir = mkdtempSync(path.join(tmpdir(), 'coloradapt-dl-'));
  const events: string[] = [];
  if (name === 'chrome') {
    const driver = await startChrome();
    const session = await driver.newBrowserSession();
    const started = new Map<string, number>();
    session.on('Browser.downloadWillBegin', (e) => {
      started.set(String(e.guid), Date.now());
      events.push(`begin ${String(e.guid).slice(0, 8)} ${String(e.suggestedFilename)}`);
    });
    session.on('Browser.downloadProgress', (e) => {
      if (e.state !== 'inProgress')
        events.push(
          `${String(e.state)} ${String(e.guid).slice(0, 8)} after ${Date.now() - (started.get(String(e.guid)) ?? Date.now())} ms`,
        );
    });
    await session.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: dir,
      eventsEnabled: true,
    });
    return { driver, dir, events };
  }
  const driver = await startFirefox({
    prefs: {
      'browser.download.folderList': 2,
      'browser.download.dir': dir,
      'browser.download.useDownloadDir': true,
      'browser.helperApps.neverAsk.saveToDisk': 'application/json,text/html',
    },
  });
  return { driver, dir, events };
}

/** The newest complete file with `extension` in `dir` (a download can be visible before it is whole). */
export async function waitForFile(
  dir: string,
  extension: string,
  isComplete: (text: string) => boolean,
  known: ReadonlySet<string> = new Set(),
  explain: () => string = () => '',
  timeoutMs = 45_000,
): Promise<{ name: string; text: string }> {
  return until(
    () => {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(extension) || known.has(name)) continue;
        const text = readFileSync(path.join(dir, name), 'utf8');
        if (isComplete(text)) return { name, text };
      }
      return null;
    },
    () =>
      `a complete ${extension} download in ${dir} [${readdirSync(dir).join(', ')}] ${explain()}`,
    timeoutMs,
  );
}

// ---------------------------------------------------------------------------------------------------------
// Export content without depending on the disk
// ---------------------------------------------------------------------------------------------------------

/**
 * Records every Blob the audit page hands to `URL.createObjectURL` (the exact bytes of an export). The click that
 * triggers the export stays a real user click; only the *reading* of the result does not depend on the browser's
 * download folder, which on a machine with antivirus scanning can stall for reasons that have nothing to do with the
 * extension (a locked `downloads.htm` in the folder was observed). A separate scenario checks the real download.
 */
export const CAPTURE_EXPORTS = `(() => {
  if (window.__exports) return true;
  window.__exports = [];
  const original = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (blob) => { window.__exports.push(blob); return original(blob); };
  return true;
})()`;

/** The text of every captured export so far, oldest first (`type` is the Blob's MIME type). */
export const READ_EXPORTS = `Promise.all(window.__exports.map(async (b) => ({ type: b.type, text: await b.text() })))`;
