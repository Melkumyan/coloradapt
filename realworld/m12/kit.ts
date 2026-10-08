/**
 * Shared kit of the M12 production-hardening suites (docs/m12/protocol.md): what ColorAdapt leaves in a page,
 * the dynamic pipeline's gauges, the MV3 service worker's state and a stop that is the browser's own, and the
 * frozen permission surface. Everything runs against the production builds in the real browsers.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ChromeDriver, Driver, Tab } from '../lib/driver';
import { ROOT } from '../lib/driver';
import { until } from '../lib/scenario';

export const SURFACE = JSON.parse(
  readFileSync(path.join(ROOT, 'docs', 'm12', 'permission-surface.json'), 'utf8'),
) as Record<string, Record<string, unknown>>;

export interface Residue {
  /** `<style id="coloradapt-stylesheet">` elements: 0 or 1, never more. */
  readonly sheets: number;
  /** Elements whose id starts with `coloradapt` (our own nodes in the page). */
  readonly ownNodes: number;
  /** Attribute name -> number of elements carrying it, for every `data-coloradapt*` attribute. */
  readonly attributes: Readonly<Record<string, number>>;
  /** `data-coloradapt-id` values used by more than one element. */
  readonly duplicateIds: number;
  /** Rules of our stylesheet as the page sees them (-1: the browser hides a content-script sheet's rules from the page, as Firefox does). */
  readonly styleRules: number;
}

export const residue = (tab: Tab): Promise<Residue> =>
  tab.evaluate<Residue>(`(() => {
    const attributes = {};
    const ids = [];
    for (const el of document.querySelectorAll('*')) {
      for (const a of el.attributes) {
        if (a.name.startsWith('data-coloradapt')) {
          attributes[a.name] = (attributes[a.name] || 0) + 1;
          if (a.name === 'data-coloradapt-id') ids.push(a.value);
        }
      }
    }
    const sheet = document.getElementById('coloradapt-stylesheet');
    return {
      sheets: document.querySelectorAll('#coloradapt-stylesheet').length,
      ownNodes: document.querySelectorAll('[id^="coloradapt"]').length,
      attributes,
      duplicateIds: ids.length - new Set(ids).size,
      styleRules: (() => { try { return sheet && sheet.sheet ? sheet.sheet.cssRules.length : 0; } catch { return -1; } })(),
    };
  })()`);

export interface Gauges {
  readonly state: string;
  readonly queuedRecords: number;
  readonly deferredRoots: number;
  readonly pendingLinks: number;
  readonly pendingRescan: string | null;
  readonly trackedElements: number;
  readonly rules: number;
  readonly observerStarts: number;
  readonly observerCallbacks: number;
  readonly selfMutationsIgnored: number;
  readonly queueOverflows: number;
  readonly fullRescans: number;
  readonly batches: number;
  readonly mutationRecords: number;
  readonly affectedRoots: number;
  readonly elementsProcessed: number;
  readonly throttleTimerActive: boolean;
}

export const gauges = (tab: Tab): Promise<Gauges> => tab.ext<Gauges>('GET_DYNAMIC_DIAGNOSTICS');

/** Quiescent: the pipeline is idle and every queue the diagnostics report is empty. */
export async function quiesce(tab: Tab): Promise<Gauges> {
  await until(async () => (await gauges(tab)).state === 'IDLE', 'idle pipeline', 30_000);
  await tab.ext('FLUSH_DYNAMIC');
  return await until(
    async () => {
      const g = await gauges(tab);
      return g.state === 'IDLE' &&
        g.queuedRecords === 0 &&
        g.deferredRoots === 0 &&
        g.pendingRescan === null &&
        !g.throttleTimerActive
        ? g
        : null;
    },
    'empty queues after quiescence',
    30_000,
  );
}

/**
 * Stops the extension's MV3 service worker the way the browser does when it is idle (ServiceWorker.stopWorker),
 * and waits until the browser lists it as stopped. The next message wakes a fresh one.
 */
export async function stopServiceWorker(driver: ChromeDriver): Promise<void> {
  const page = driver.browserContext.pages()[0];
  if (!page) throw new Error('no page for a DevTools session');
  const session = await driver.browserContext.newCDPSession(page);
  const versions = new Map<
    string,
    { versionId: string; scriptURL: string; runningStatus: string }
  >();
  session.on(
    'ServiceWorker.workerVersionUpdated',
    (e: { versions: Array<{ versionId: string; scriptURL: string; runningStatus: string }> }) => {
      for (const v of e.versions) versions.set(v.versionId, v);
    },
  );
  await session.send('ServiceWorker.enable');
  await until(
    () => [...versions.values()].some((v) => v.scriptURL.startsWith(driver.extensionOrigin)),
    'the extension service worker to be listed',
  );
  for (const v of versions.values()) {
    if (!v.scriptURL.startsWith(driver.extensionOrigin)) continue;
    await session.send('ServiceWorker.stopWorker', { versionId: v.versionId });
  }
  await until(() => {
    const running = [...versions.values()].filter(
      (v) => v.scriptURL.startsWith(driver.extensionOrigin) && v.runningStatus === 'running',
    );
    return running.length === 0;
  }, 'the service worker to stop');
  await session.detach().catch(() => null);
}

/** Number of live service-worker targets of this extension (0 = stopped, 1 = running). */
export async function runningWorkers(driver: ChromeDriver): Promise<number> {
  const session = await driver.newBrowserSession();
  const { targetInfos } = (await session.send('Target.getTargets')) as {
    targetInfos: Array<{ type: string; url: string }>;
  };
  return targetInfos.filter(
    (t) => t.type === 'service_worker' && t.url.startsWith(driver.extensionOrigin),
  ).length;
}

/** A message from an extension page to the background, answered by the background (wakes a stopped worker). */
export const toBackground = <T>(driver: Driver, type: string, payload?: unknown): Promise<T> =>
  driver.extensionEval<T>(
    `(async () => { const api = globalThis.browser ?? globalThis.chrome; return await api.runtime.sendMessage({ channel: 'coloradapt', type: ${JSON.stringify(type)}, payload: ${JSON.stringify(payload)} }); })()`,
  );

export const tabIdOf = (driver: Driver, urlFragment: string): Promise<number> =>
  driver.extensionEval<number>(
    `(async () => { const api = globalThis.browser ?? globalThis.chrome; const t = (await api.tabs.query({})).filter((x) => (x.url || '').includes(${JSON.stringify(urlFragment)})); if (t.length !== 1) throw new Error('tabs: ' + t.length); return t[0].id; })()`,
  );

/** Errors worth failing a lifecycle test on: anything from ColorAdapt or an uncaught exception in an extension world. */
export function fatalLogs(logs: ReadonlyArray<{ level: string; text: string; source: string }>) {
  return logs.filter(
    (l) =>
      (l.level === 'exception' || l.level === 'error') &&
      /coloradapt|chrome-extension|moz-extension|Extension context|runtime\.sendMessage|Receiving end/i.test(
        `${l.text} ${l.source}`,
      ),
  );
}

/** SHA-256 (hex) of a file as the browser serves it from the installed extension. */
export const servedHash = (driver: Driver, file: string): Promise<string> =>
  driver.extensionEval<string>(
    `(async () => { const r = await fetch(${JSON.stringify(`/${file}`)}); const b = await r.arrayBuffer(); const d = await crypto.subtle.digest('SHA-256', b); return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join(''); })()`,
  );

/** SHA-256 (hex) of a file of a build on disk. */
export const diskHash = (dir: string, file: string): string =>
  createHash('sha256')
    .update(readFileSync(path.join(dir, file)))
    .digest('hex');
