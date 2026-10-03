import { expect, type Page } from '@playwright/test';
import { enable, setSettings, settle, type ExtensionSession, type PageServer } from './harness';

/**
 * Shared pieces of the M6 real-browser suites. Everything reads the browser (computed styles,
 * pseudo-element styles, bounding boxes, the accessibility tree, rendered pixels); nothing
 * sleeps.
 */
export const SETTINGS = {
  enabled: true,
  visionProfile: 'deuteranopia',
  adaptationStrength: 1,
  semanticCuesEnabled: true,
} as const;

/** The cues `semantic.html` gets on load, by element id (kind of cue, as the attribute states it). */
export const INITIAL_CUES: Readonly<Record<string, RegExp>> = {
  d1: /^inner:2713:/, // online ✓
  d2: /^inner:d7:/, // offline ×
  d3: /^inner:21:/, // warning !
  b1: /^after:2713$/, // success ✓
  b2: /^after:d7$/, // error ×
  b3: /^after:21$/, // warning !
  tab1: /^underline$/,
  'nav-home': /^underline$/,
  'lbl-email': /^after:2a$/, // required *
  al1: /^after:d7$/,
  al2: /^after:2139$/,
  v1: /^after:2b$/, // positive +
  v2: /^after:2212$/, // negative −
};

/** Everything on `semantic.html` that must never get a cue. */
export const NEVER_CUED = [
  'b4',
  'b5',
  'al3',
  'v3',
  'tab2',
  'tab3',
  'nav-about',
  'email',
  'name',
  'nemail',
  'nname',
  'logo',
  'star',
  'sale',
  'regular',
  'eco',
  'delete',
  'cancel',
  'red',
  'save',
  'docs-link',
] as const;

/** Opens the page with ColorAdapt OFF, for recording how the page looks on its own. */
export async function openOff(
  ext: ExtensionSession,
  server: PageServer,
  pageName = 'semantic.html',
): Promise<Page> {
  await setSettings(ext.worker, { ...SETTINGS, enabled: false });
  const page = await ext.context.newPage();
  await page.goto(`${server.origin}/${pageName}`);
  return page;
}

/** Turns ColorAdapt ON for an already open page (the settings are read from storage by the content script). */
export async function turnOn(ext: ExtensionSession, page: Page): Promise<void> {
  await setSettings(ext.worker, SETTINGS);
  await enable(ext.worker, page);
  await settle(page);
}

/** `{ id: cue key }` for every element that carries a cue right now. */
export function cues(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('[data-coloradapt-cue]')].map((el) => [
        el.id || el.tagName,
        el.getAttribute('data-coloradapt-cue') ?? '',
      ]),
    ),
  );
}

export interface PseudoStyle {
  readonly content: string;
  readonly color: string;
  readonly display: string;
  readonly pointerEvents: string;
  readonly backgroundColor: string;
  readonly clipPath: string;
  readonly fontFamily: string;
  readonly width: string;
  readonly height: string;
}

export function pseudo(page: Page, id: string, which: '::before' | '::after' = '::after') {
  return page.evaluate(
    ({ id: target, which: pseudoName }): PseudoStyle => {
      const el = document.getElementById(target);
      if (!el) throw new Error(`#${target} missing`);
      const style = getComputedStyle(el, pseudoName);
      return {
        content: style.content,
        color: style.color,
        display: style.display,
        pointerEvents: style.pointerEvents,
        backgroundColor: style.backgroundColor,
        clipPath: style.clipPath,
        fontFamily: style.fontFamily,
        width: style.width,
        height: style.height,
      };
    },
    { id, which },
  );
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Bounding boxes (page coordinates, unrounded) of `ids`. */
export function boxes(page: Page, ids: readonly string[]): Promise<Record<string, Box>> {
  return page.evaluate(
    (list) =>
      Object.fromEntries(
        list.map((id) => {
          const el = document.getElementById(id);
          if (!el) throw new Error(`#${id} missing`);
          const r = el.getBoundingClientRect();
          return [id, { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }];
        }),
      ),
    ids,
  );
}

/** The body as the page wrote it: ColorAdapt's technical attributes and stylesheet removed. */
export function pageStructure(page: Page): Promise<string> {
  return page.evaluate(() => {
    const clone = document.body.cloneNode(true) as HTMLElement;
    for (const el of [clone, ...clone.querySelectorAll('*')]) {
      for (const name of el.getAttributeNames()) {
        if (name.startsWith('data-coloradapt-')) el.removeAttribute(name);
      }
    }
    return clone.innerHTML;
  });
}

export const hasCueSheet = (page: Page): Promise<boolean> =>
  page.evaluate(() =>
    (document.getElementById('coloradapt-stylesheet')?.textContent ?? '').includes(
      'data-coloradapt-cue',
    ),
  );

/** What the browser's accessibility tree says about the page (names, roles, states). */
export const accessibilityTree = (page: Page): Promise<string> =>
  page.locator('body').ariaSnapshot();

/** The ids of the elements that receive focus on successive Tab presses. */
export async function tabOrder(page: Page, presses = 14): Promise<string[]> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const order: string[] = [];
  for (let i = 0; i < presses; i += 1) {
    await page.keyboard.press('Tab');
    order.push(
      await page.evaluate(
        () => document.activeElement?.id || document.activeElement?.tagName || '',
      ),
    );
  }
  return order;
}

/** Pixels of `id` as rendered (PNG bytes as base64): different bytes mean a different picture. */
export async function pixels(page: Page, id: string): Promise<string> {
  return (await page.locator(`#${id}`).screenshot()).toString('base64');
}

export async function expectCues(
  page: Page,
  expected: Readonly<Record<string, RegExp>>,
): Promise<void> {
  const actual = await cues(page);
  expect(Object.keys(actual).sort(), 'which elements carry a cue').toEqual(
    Object.keys(expected).sort(),
  );
  for (const [id, pattern] of Object.entries(expected)) {
    expect(actual[id], `cue of #${id}`).toMatch(pattern);
  }
}

declare global {
  interface Window {
    /** Defined by `e2e/pages/semantic.html`. */
    counters: { save: number; del: number; submitted: number; nativeSubmitted: number };
    /** Defined by `e2e/pages/semantic-a11y.html`. */
    log: {
      clicks: { b1: number; tab2: number; link: number; seg2: number; chk2: number; rad2: number };
      submitted: number;
      invalid: number;
      events: string[];
    };
    sem: {
      setClass(id: string, cls: string): void;
      setText(id: string, text: string): void;
      add(html: string, parentId?: string): void;
      remove(id: string): void;
      rows(count: number, state: string): void;
      flipRows(state: string): void;
    };
  }
}
