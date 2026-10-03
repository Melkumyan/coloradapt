import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AdaptationPlan, UserSettings } from '../src/domain/models';

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
const EXTENSION_PATH = path.join(ROOT, 'dist', 'chrome-mv3');
const PAGES_DIR = path.join(import.meta.dirname, 'pages');
const DEMO_PAGE = path.join(ROOT, 'demo', 'index.html');
const SETTINGS_KEY = 'coloradapt:settings';

export interface PageServer {
  readonly origin: string;
  close(): Promise<void>;
}

/** Serves `e2e/pages/*` (and `/demo.html` = the repo's demo page) on 127.0.0.1 (content scripts only match http(s)). */
export async function startPageServer(): Promise<PageServer> {
  const server: Server = createServer((req, res) => {
    const name = (req.url ?? '/').split('?')[0]!.replace(/^\/+/, '') || 'index.html';
    try {
      const file = name === 'demo.html' ? DEMO_PAGE : path.join(PAGES_DIR, path.basename(name));
      const body = readFileSync(file);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no server address');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
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
  | 'REFRESH_ADAPTATION';

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
