import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AdaptationPlan, DynamicDiagnostics, UserSettings } from '../src/domain/models';

/**
 * The slice of the extension API used inside `worker.evaluate` callbacks. Those
 * run in the extension's service worker, where `chrome` is a runtime global.
 */
declare const chrome: {
  storage: { local: { set(items: Record<string, unknown>): Promise<void> } };
  tabs: {
    query(query: { url: string }): Promise<Array<{ id?: number }>>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
  };
};

const ROOT = path.resolve(import.meta.dirname, '..');
const EXTENSION_PATH = path.join(ROOT, 'dist', 'chrome-mv3-e2e');
const PAGES_DIR = path.join(import.meta.dirname, 'pages');
const DEMO_PAGE = path.join(ROOT, 'demo', 'index.html');
const SETTINGS_KEY = 'coloradapt:settings';

export interface PageServer {
  readonly origin: string;
  /**
   * `/slow-<name>.css` is answered only once `release(name)` is called (or
   * with a 404 after `fail(name)`), so tests control exactly when a
   * `<link rel=stylesheet>` loads without sleeping.
   */
  release(name: string, css?: string): void;
  fail(name: string): void;
  /** Requests for `/slow-<name>.css` that are still waiting. */
  waiting(name: string): number;
  /** Serves `html` at `/<name>` (a `.html` name), for pages a test generates itself. */
  serve(name: string, html: string): void;
  close(): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css',
  '.js': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

/** Serves `e2e/pages/*` (and `/demo.html` = the repo's demo page) on 127.0.0.1 (content scripts only match http(s)). */
export async function startPageServer(): Promise<PageServer> {
  const held = new Map<string, ServerResponse[]>();
  const generated = new Map<string, string>();
  const server: Server = createServer((req, res) => {
    const name = (req.url ?? '/').split('?')[0]!.replace(/^\/+/, '') || 'index.html';
    const made = generated.get(name);
    if (made !== undefined) {
      res.writeHead(200, { 'content-type': CONTENT_TYPES['.html']! });
      res.end(made);
      return;
    }
    const slow = /^slow-([\w-]+)\.css$/.exec(name);
    if (slow) {
      held.set(slow[1]!, [...(held.get(slow[1]!) ?? []), res]);
      return;
    }
    try {
      const file = name === 'demo.html' ? DEMO_PAGE : path.join(PAGES_DIR, path.basename(name));
      const body = readFileSync(file);
      res.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(file)] ?? 'text/plain' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no server address');
  const settle = (name: string, respond: (res: ServerResponse) => void) => {
    for (const res of held.get(name) ?? []) respond(res);
    held.delete(name);
  };
  return {
    origin: `http://127.0.0.1:${address.port}`,
    release: (name, css = '.themed { color: #c0392b; background-color: #27ae60; }') =>
      settle(name, (res) => {
        res.writeHead(200, { 'content-type': 'text/css' });
        res.end(css);
      }),
    fail: (name) => settle(name, (res) => res.writeHead(404).end('not found')),
    waiting: (name) => held.get(name)?.length ?? 0,
    serve: (name, html) => {
      generated.set(name, html);
    },
    close: () => {
      for (const name of [...held.keys()]) settle(name, (res) => res.destroy());
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface ExtensionSession {
  readonly context: BrowserContext;
  readonly worker: Worker;
  close(): Promise<void>;
}

/** Launches Chromium (new headless) with the built extension loaded. */
export async function launchExtension(): Promise<ExtensionSession> {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  return { context, worker, close: () => context.close() };
}

/** Replaces the stored settings (the storage schema fills defaults field-by-field). */
export async function setSettings(
  worker: Worker,
  settings: Partial<UserSettings> | Record<string, unknown>,
): Promise<void> {
  await worker.evaluate(
    async ({ key, value }) => {
      await chrome.storage.local.set({ [key]: value });
    },
    { key: SETTINGS_KEY, value: settings },
  );
}

type TabMessage =
  | 'ANALYZE_PAGE'
  | 'GET_ANALYSIS'
  | 'ENABLE_ADAPTATION'
  | 'DISABLE_ADAPTATION'
  | 'REFRESH_ADAPTATION'
  | 'GET_DYNAMIC_DIAGNOSTICS'
  | 'FLUSH_DYNAMIC';

/** Sends a ColorAdapt message to the content script of `page`'s tab. */
export async function sendToPage<T = unknown>(
  worker: Worker,
  page: Page,
  type: TabMessage,
): Promise<T> {
  const url = page.url();
  return worker.evaluate(
    async ({ url: tabUrl, type: messageType }) => {
      const tabs = await chrome.tabs.query({ url: tabUrl });
      const tab = tabs[0];
      if (tabs.length !== 1 || !tab?.id) {
        throw new Error(`expected exactly one tab for ${tabUrl}, found ${tabs.length}`);
      }
      return await chrome.tabs.sendMessage(tab.id, {
        channel: 'coloradapt',
        type: messageType,
        payload: undefined,
      });
    },
    { url, type },
  ) as Promise<T>;
}

export const enable = (worker: Worker, page: Page): Promise<AdaptationPlan> =>
  sendToPage<AdaptationPlan>(worker, page, 'ENABLE_ADAPTATION');
export const disable = (worker: Worker, page: Page): Promise<null> =>
  sendToPage<null>(worker, page, 'DISABLE_ADAPTATION');
/** Dynamic-pipeline counters, as they are right now. */
export const dynamicDiagnostics = (worker: Worker, page: Page): Promise<DynamicDiagnostics> =>
  sendToPage<DynamicDiagnostics>(worker, page, 'GET_DYNAMIC_DIAGNOSTICS');
/** Processes every pending mutation right now, then returns the counters. */
export const flushDynamic = (worker: Worker, page: Page): Promise<DynamicDiagnostics> =>
  sendToPage<DynamicDiagnostics>(worker, page, 'FLUSH_DYNAMIC');
export const refresh = (worker: Worker, page: Page): Promise<AdaptationPlan> =>
  sendToPage<AdaptationPlan>(worker, page, 'REFRESH_ADAPTATION');

/**
 * Settles the page's style state: two animation frames after any pending
 * style recalculation, with transitions given the chance to finish
 * (`getAnimations()` is awaited, not slept on).
 */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const transitions = document
      .getAnimations()
      .filter((a) => a instanceof CSSTransition)
      .map((a) => a.finished.catch(() => undefined));
    await Promise.all(transitions);
  });
}

/** Computed `color` of every `[id]` element in `ids`, as the browser reports it. */
export async function computedColors(
  page: Page,
  ids: readonly string[],
  property = 'color',
): Promise<Record<string, string>> {
  return page.evaluate(
    ({ ids: list, property: prop }) =>
      Object.fromEntries(
        list.map((id) => {
          const el = document.getElementById(id);
          if (!el) throw new Error(`#${id} missing`);
          return [id, getComputedStyle(el).getPropertyValue(prop)];
        }),
      ),
    { ids, property },
  );
}

/** `rgb(r, g, b)` for a `#rrggbb` string, as computed styles report it. */
export function hexToRgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

/** Whether the injected ColorAdapt stylesheet is currently in the document. */
export function hasStylesheet(page: Page): Promise<boolean> {
  return page.evaluate(() => document.getElementById('coloradapt-stylesheet') !== null);
}

/** Maps the plan's changes to DOM ids: `{ [dom id]: adapted value as 'rgb(r, g, b)' }`. */
export async function plannedColors(
  page: Page,
  plan: AdaptationPlan,
): Promise<Record<string, string>> {
  const idMap = await page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('[data-coloradapt-id]')].map((e) => [
        e.getAttribute('data-coloradapt-id') ?? '',
        e.id,
      ]),
    ),
  );
  return Object.fromEntries(
    plan.changes.map((c) => [idMap[c.elementId] ?? c.elementId, hexToRgb(c.adaptedValue)]),
  );
}

/** Every `[id]` element on the page. */
export function allIds(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll('body [id]')].map((e) => e.id));
}

declare global {
  interface Window {
    /** Defined by `e2e/pages/dynamic.html`: a fragment of `count` `<p>` rows with ids `prefix + i`. */
    rows(prefix: string, count: number, cls?: string): DocumentFragment;
    /** Defined by `e2e/pages/r1-blank.html`. */
    appendEach(prefix: string, count: number, cls?: string): void;
    appendBig(id: string, count: number): void;
    installSpy(spawn: (spy: HTMLElement) => void): void;
    idLog: Array<{ delivery: number; id: string; value: string | null }>;
    /** Defined by the other `e2e/pages/r1-*.html` fixtures. */
    spa: { go(view: string): void; show(view: string): void; tick(n: number): void; back(): void };
    reorderHome(): void;
    feed: {
      load(n: number): void;
      trim(n: number): void;
      clear(): void;
      count: number;
      next: number;
    };
    dash: { toggleTheme(): void; tick(n: number): void; addRows(n: number, alert?: boolean): void };
    styled: {
      component(id: string, rules: string): string;
      speedyComponent(id: string, rules: string): string;
    };
    addHostile(prefix: string, n: number): void;
    addPlain(prefix: string, n: number): void;
    churn(frames: number): Promise<number>;
  }
}
