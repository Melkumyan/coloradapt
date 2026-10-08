import { expect, type Page } from '@playwright/test';
import type { DynamicDiagnostics } from '../src/domain/models';
import {
  allIds,
  computedColors,
  dynamicDiagnostics,
  flushDynamic,
  hasStylesheet,
  hexToRgb,
  refresh,
  setSettings,
  settle,
  type ExtensionSession,
  type PageServer,
} from './harness';

/**
 * Shared pieces of the M4.R1 real-browser suites. Everything here reads the
 * browser (`getComputedStyle`, the injected `<style>`, the pipeline's own
 * counters); nothing sleeps and nothing reads a wall clock.
 */
export const ORIGINAL_BAD = hexToRgb('#c0392b');
export const SETTINGS = {
  enabled: true,
  visionProfile: 'deuteranopia',
  adaptationStrength: 1,
} as const;

export interface Loaded {
  readonly page: Page;
  readonly diag: () => Promise<DynamicDiagnostics>;
  /** Flushes, lets the page settle, and returns the counters accrued since the previous `step`. */
  readonly step: () => Promise<DynamicDiagnostics>;
  /** Like `step`, but lets the real scheduler do the work (waits for `IDLE` with nothing owed). */
  readonly natural: () => Promise<DynamicDiagnostics>;
}

/** `now - before` for the numeric counters; state and gauges are taken from `now`. */
export function diffCounters(
  now: DynamicDiagnostics,
  before: DynamicDiagnostics,
): DynamicDiagnostics {
  const gauges = new Set([
    'trackedElements',
    'rules',
    'pendingLinks',
    'queuedRecords',
    'deferredRoots',
  ]);
  const out: Record<string, unknown> = { ...now };
  for (const key of Object.keys(now) as Array<keyof DynamicDiagnostics>) {
    const a = now[key];
    const b = before[key];
    if (typeof a === 'number' && typeof b === 'number' && !gauges.has(key)) out[key] = a - b;
  }
  const reasons: Record<string, number> = {};
  for (const [reason, count] of Object.entries(now.fullRescansByReason)) {
    const delta =
      count - (before.fullRescansByReason[reason as keyof typeof before.fullRescansByReason] ?? 0);
    if (delta !== 0) reasons[reason] = delta;
  }
  out['fullRescansByReason'] = reasons;
  return out as unknown as DynamicDiagnostics;
}

/** Loads `pageName` with ColorAdapt ON and the initial adaptation applied and settled. */
export async function load(
  ext: ExtensionSession,
  server: PageServer,
  pageName = 'dynamic.html',
  settings: Record<string, unknown> = SETTINGS,
): Promise<Loaded> {
  await setSettings(ext.worker, settings);
  const page = await ext.context.newPage();
  await page.goto(`${server.origin}/${pageName}`);
  await expect
    .poll(async () => (await dynamicDiagnostics(ext.worker, page).catch(() => null))?.state)
    .toBe('IDLE');
  await flushDynamic(ext.worker, page);
  await settle(page);
  let last = await dynamicDiagnostics(ext.worker, page);
  return {
    page,
    diag: () => dynamicDiagnostics(ext.worker, page),
    step: async () => {
      const now = await flushDynamic(ext.worker, page);
      await settle(page);
      const delta = diffCounters(now, last);
      last = now;
      return delta;
    },
    natural: async () => {
      await expect
        .poll(async () => {
          const d = await dynamicDiagnostics(ext.worker, page);
          return (
            d.state === 'IDLE' &&
            d.queuedRecords === 0 &&
            d.deferredRoots === 0 &&
            d.pendingRescan === null &&
            !d.throttleTimerActive
          );
        })
        .toBe(true);
      await settle(page);
      const now = await dynamicDiagnostics(ext.worker, page);
      const delta = diffCounters(now, last);
      last = now;
      return delta;
    },
  };
}

/**
 * M12.5: the sheet has one rule per distinct declaration; an element is styled when it names such a rule in
 * `data-coloradapt-s` and the sheet has it. Whether the element `id` is styled:
 */
export const rule = (page: Page, id: string): Promise<boolean> =>
  page.evaluate((elementId) => {
    const tokens = document.getElementById(elementId)?.getAttribute('data-coloradapt-s') ?? '';
    const text = document.getElementById('coloradapt-stylesheet')?.textContent ?? '';
    return tokens.split(' ').some((t) => t !== '' && text.includes(`[data-coloradapt-s~="${t}"]`));
  }, id);

/** Ids of the elements the sheet styles, once per rule that styles them. */
export const ruleSelectors = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const text = document.getElementById('coloradapt-stylesheet')?.textContent ?? '';
    const ids: string[] = [];
    for (const el of document.querySelectorAll('[data-coloradapt-s]')) {
      const id = el.getAttribute('data-coloradapt-id') ?? '';
      for (const t of (el.getAttribute('data-coloradapt-s') ?? '').split(' ')) {
        if (t !== '' && text.includes(`[data-coloradapt-s~="${t}"]`)) ids.push(id);
      }
    }
    return ids;
  });

export const ruleTotal = async (page: Page): Promise<number> => (await ruleSelectors(page)).length;

/** Elements carrying a `data-coloradapt-id` that another element also carries. */
export const duplicateIds = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const ids = [...document.querySelectorAll('[data-coloradapt-id]')].map((e) =>
      e.getAttribute('data-coloradapt-id'),
    );
    return ids.length - new Set(ids).size;
  });

/** Rules appearing more than once in the sheet. */
export async function duplicateRules(page: Page): Promise<number> {
  const ids = await ruleSelectors(page);
  return ids.length - new Set(ids).size;
}

/**
 * Stale rules: a token on an element that the sheet has no rule for, or a rule of the sheet that no element in
 * the document names any more (its elements are gone).
 */
export const staleRules = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const text = document.getElementById('coloradapt-stylesheet')?.textContent ?? '';
    const used = new Set<string>();
    let orphans = 0;
    for (const el of document.querySelectorAll('[data-coloradapt-s]')) {
      for (const t of (el.getAttribute('data-coloradapt-s') ?? '').split(' ')) {
        if (t === '') continue;
        used.add(t);
        if (!text.includes(`[data-coloradapt-s~="${t}"]`)) orphans += 1;
      }
    }
    const declared = [...text.matchAll(/\[data-coloradapt-s~="([^"]+)"\]:not/g)].map((m) => m[1]!);
    return orphans + declared.filter((t) => !used.has(t)).length;
  });

/** The full invariant set every settled state must satisfy. */
export async function expectConsistent(page: Page): Promise<void> {
  expect(await duplicateIds(page), 'duplicate data-coloradapt-id').toBe(0);
  expect(await duplicateRules(page), 'duplicate rules').toBe(0);
  expect(await staleRules(page), 'stale rules (target gone)').toBe(0);
}

/** The incremental result must equal what a full rescan of the same page produces. */
export async function expectEquivalentToFullRescan(
  ext: ExtensionSession,
  page: Page,
): Promise<void> {
  const ids = await allIds(page);
  const incremental = await computedColors(page, ids);
  const rulesBefore = [...(await ruleSelectors(page))].length;
  const sheetBefore = await hasStylesheet(page);
  await refresh(ext.worker, page);
  await settle(page);
  expect(await computedColors(page, ids)).toEqual(incremental);
  expect(await ruleTotal(page)).toBe(rulesBefore);
  expect(await hasStylesheet(page)).toBe(sheetBefore);
}

/** Zero everything except `keep` (used to assert "no work happened"). */
export function expectNoWork(delta: DynamicDiagnostics): void {
  expect(
    {
      incrementalPasses: delta.incrementalPasses,
      fullRescans: delta.fullRescans,
      elementsProcessed: delta.elementsProcessed,
      affectedRoots: delta.affectedRoots,
      rulesAdded: delta.rulesAdded,
      rulesUpdated: delta.rulesUpdated,
      rulesRemoved: delta.rulesRemoved,
    },
    'work was done',
  ).toEqual({
    incrementalPasses: 0,
    fullRescans: 0,
    elementsProcessed: 0,
    affectedRoots: 0,
    rulesAdded: 0,
    rulesUpdated: 0,
    rulesRemoved: 0,
  });
}
