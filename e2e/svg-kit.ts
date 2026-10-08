import { expect, type Page } from '@playwright/test';
import type { AdaptationPlan, AnalysisResult, ElementDescriptor } from '../src/domain/models';
import {
  computedColors,
  enable,
  hexToRgb,
  sendToPage,
  setSettings,
  settle,
  type ExtensionSession,
  type PageServer,
} from './harness';

/**
 * Shared pieces of the M5 real-browser suites. Everything reads the browser
 * (`getComputedStyle`, rendered pixels, the injected `<style>`); nothing sleeps.
 */
export const RED = hexToRgb('#c0392b');
export const SETTINGS = {
  enabled: true,
  visionProfile: 'deuteranopia',
  adaptationStrength: 1,
  adaptSVG: true,
} as const;

/** Opens `pageName` with ColorAdapt OFF, so the page's own colors can be recorded first. */
export async function openPristine(
  ext: ExtensionSession,
  server: PageServer,
  pageName: string,
  settings: Record<string, unknown> = SETTINGS,
): Promise<Page> {
  await setSettings(ext.worker, { ...settings, enabled: false });
  const page = await ext.context.newPage();
  await page.goto(`${server.origin}/${pageName}`);
  await setSettings(ext.worker, settings);
  return page;
}

/** Computed `fill` / `stroke` / `color` of `[id]` elements, as the browser reports them. */
export const paints = {
  fill: (page: Page, ids: readonly string[]) => computedColors(page, ids, 'fill'),
  stroke: (page: Page, ids: readonly string[]) => computedColors(page, ids, 'stroke'),
  color: (page: Page, ids: readonly string[]) => computedColors(page, ids, 'color'),
};

/** `data-coloradapt-id` -> DOM id, for every tagged element. */
export function idMap(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('[data-coloradapt-id]')].map((e) => [
        e.getAttribute('data-coloradapt-id') ?? '',
        e.id,
      ]),
    ),
  );
}

export interface PlannedPaint {
  /** DOM id of the element a rule targets. */
  readonly target: string;
  readonly property: string;
  /** `rgb(r, g, b)` */
  readonly rgb: string;
}

/** The plan's changes grouped by the SVG (or element) that owns them, with DOM ids. */
export async function plannedByOwner(
  page: Page,
  plan: AdaptationPlan,
): Promise<Record<string, PlannedPaint[]>> {
  const ids = await idMap(page);
  const out: Record<string, PlannedPaint[]> = {};
  for (const change of plan.changes) {
    const owner = ids[change.ownerId ?? change.elementId] ?? change.ownerId ?? change.elementId;
    (out[owner] ??= []).push({
      target: ids[change.elementId] ?? change.elementId,
      property: change.property,
      rgb: hexToRgb(change.adaptedValue),
    });
  }
  return out;
}

/** The SVG units of the last analysis, by DOM id. */
export async function svgUnits(
  ext: ExtensionSession,
  page: Page,
): Promise<Record<string, ElementDescriptor>> {
  const analysis = await sendToPage<AnalysisResult | null>(ext.worker, page, 'GET_ANALYSIS');
  const ids = await idMap(page);
  const out: Record<string, ElementDescriptor> = {};
  for (const element of analysis?.elements ?? []) {
    if (element.svg) out[ids[element.id] ?? element.id] = element;
  }
  return out;
}

/** The injected stylesheet's text (empty when there is none). */
export const sheetText = (page: Page): Promise<string> =>
  page.evaluate(() => document.getElementById('coloradapt-stylesheet')?.textContent ?? '');

/** Adapts the page and waits for the style state to settle. */
export async function adapt(ext: ExtensionSession, page: Page): Promise<AdaptationPlan> {
  const plan = await enable(ext.worker, page);
  await settle(page);
  return plan;
}

/**
 * The color the browser actually paints at (`dx`, `dy`) inside `[id]`, read from a
 * screenshot — the only way to see what a `<use>` instance really shows, since the
 * instance tree is not part of the DOM. Antialiasing makes edges useless: aim at
 * the middle of a solid area.
 */
export async function pixelAt(page: Page, id: string, dx: number, dy: number): Promise<string> {
  const point = await page.evaluate(
    ({ elementId, x, y }) => {
      const el = document.getElementById(elementId);
      if (!el) throw new Error(`#${elementId} missing`);
      const rect = el.getBoundingClientRect();
      return { x: rect.left + window.scrollX + x, y: rect.top + window.scrollY + y };
    },
    { elementId: id, x: dx, y: dy },
  );
  const png = await page.screenshot({
    type: 'png',
    fullPage: true,
    clip: { x: Math.floor(point.x), y: Math.floor(point.y), width: 1, height: 1 },
  });
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(1, 1);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2d context');
    context.drawImage(bitmap, 0, 0);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return `rgb(${r}, ${g}, ${b})`;
  }, png.toString('base64'));
}

/** Rules in the sheet, as `[target id, property, value]`. */
export async function sheetRules(page: Page): Promise<Array<[string, string, string]>> {
  return page.evaluate(() => {
    const text = document.getElementById('coloradapt-stylesheet')?.textContent ?? '';
    const declared = new Map<string, [string, string]>();
    for (const m of text.matchAll(
      /\[data-coloradapt-s~="([^"]+)"\]:not\(#coloradapt-specificity\) \{ ([a-z-]+): (#[0-9a-f]{6}) !important; \}/g,
    )) {
      declared.set(m[1]!, [m[2]!, m[3]!]);
    }
    const rules: Array<[string, string, string]> = [];
    for (const el of document.querySelectorAll('[data-coloradapt-s]')) {
      for (const token of (el.getAttribute('data-coloradapt-s') ?? '').split(' ')) {
        const rule = declared.get(token);
        if (rule) rules.push([el.getAttribute('data-coloradapt-id') ?? '', rule[0], rule[1]]);
      }
    }
    return rules;
  });
}

/** Every rule of the sheet is one of ours: a tagged target, one property, a hex color. */
export async function expectOnlyOwnRules(page: Page): Promise<void> {
  const css = await sheetText(page);
  const lines = css.split('\n').filter(Boolean);
  for (const line of lines) {
    expect(line).toMatch(
      /^\[data-coloradapt-s~="(color|fill|stroke):#[0-9a-f]{6}"\]:not\(#coloradapt-specificity\) \{ \1: #[0-9a-f]{6} !important; \}$/,
    );
  }
  expect(css).not.toContain('transition');
  expect(css).not.toContain('fill: rgb(1, 2, 3)'); // never leave a probe behind
}
