import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DynamicDiagnostics } from '@domain/models';
import { createDynamicContentController } from '@features/dynamic-analysis';
import { CONFLICT_STYLE, DEUTAN, createManualScheduler } from '../features/dynamic/helpers';

/**
 * Deterministic mutation benchmark (docs/PERFORMANCE.md, "Dynamic pipeline").
 * Every assertion is structural — passes, roots, elements, rescans — never
 * elapsed time. Wall-clock is recorded in the report for information only.
 */

const REPORT_DIR = path.resolve(import.meta.dirname, '../../benchmark-report');

interface Scenario {
  readonly name: string;
  readonly mutations: number;
  readonly initialElements: number;
  readonly mutate: (host: HTMLElement) => void;
}

interface Row {
  readonly scenario: string;
  readonly mutations: number;
  readonly pageElements: number;
  /** Records delivered, excluding ColorAdapt's own writes. */
  readonly mutationRecords: number;
  readonly selfMutationsIgnored: number;
  readonly batches: number;
  readonly analysisPasses: number;
  readonly incrementalPasses: number;
  readonly fullRescans: number;
  readonly affectedRoots: number;
  readonly elementsProcessed: number;
  /** What re-analyzing the whole page after every mutation would have inspected. */
  readonly naiveElementsInspected: number;
  readonly rulesAdded: number;
  readonly rulesUpdated: number;
  readonly rulesRemoved: number;
  /** Rules left in the stylesheet afterwards. */
  readonly finalRules: number;
  readonly wallClockMs: number;
}

const rows: Row[] = [];

function row(p: string): HTMLElement {
  const node = document.createElement('p');
  node.id = p;
  node.setAttribute('style', CONFLICT_STYLE);
  node.textContent = p;
  return node;
}

function run(scenario: Scenario): { diag: DynamicDiagnostics; row: Row } {
  document.head.innerHTML = `<style>
    .bad { ${CONFLICT_STYLE} }
    .alt { color: #000; background-color: #fff; }
  </style>`;
  document.body.innerHTML = `<div id="host">${Array.from(
    { length: scenario.initialElements },
    (_, i) => `<p id="i${i}" class="bad">row</p>`,
  ).join('')}</div>`;
  const controller = createDynamicContentController(
    document,
    { now: () => 0, maxElements: 100_000 },
    { scheduler: createManualScheduler(), now: () => 0 },
  );
  controller.enableAdaptation('https://example.com', DEUTAN);
  const before = controller.dynamic.diagnostics();

  const started = performance.now();
  scenario.mutate(document.getElementById('host')!);
  const diag = controller.dynamic.flush();
  const wallClockMs = performance.now() - started;

  const pageElements = document.body.querySelectorAll('*').length;
  const result: Row = {
    scenario: scenario.name,
    mutations: scenario.mutations,
    pageElements,
    mutationRecords:
      diag.mutationRecords -
      before.mutationRecords -
      (diag.selfMutationsIgnored - before.selfMutationsIgnored),
    selfMutationsIgnored: diag.selfMutationsIgnored - before.selfMutationsIgnored,
    batches: diag.batches - before.batches,
    analysisPasses: diag.incrementalPasses + diag.fullRescans,
    incrementalPasses: diag.incrementalPasses,
    fullRescans: diag.fullRescans,
    affectedRoots: diag.affectedRoots,
    elementsProcessed: diag.elementsProcessed,
    naiveElementsInspected: scenario.mutations * pageElements,
    rulesAdded: diag.rulesAdded,
    rulesUpdated: diag.rulesUpdated,
    rulesRemoved: diag.rulesRemoved,
    finalRules: diag.rules,
    wallClockMs: Math.round(wallClockMs),
  };
  rows.push(result);
  controller.dynamic.dispose();
  controller.disableAdaptation();
  return { diag, row: result };
}

const insertScenario = (mutations: number): Scenario => ({
  name: `insert-${mutations}`,
  mutations,
  initialElements: 50,
  mutate: (host) => {
    for (let i = 0; i < mutations; i += 1) host.appendChild(row(`n${i}`));
  },
});

afterAll(() => {
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(
    path.join(REPORT_DIR, 'dynamic-benchmark.json'),
    JSON.stringify(
      {
        generatedBy: 'tests/benchmarks',
        note: 'Structural counters are the result; wallClockMs is informational only.',
        rows,
      },
      null,
      2,
    ),
  );
});

describe('dynamic benchmark: synchronous inserts', () => {
  it('100 inserts: one incremental pass, no full scan', () => {
    const { row: r } = run(insertScenario(100));
    expect(r.analysisPasses).toBe(1);
    expect(r.fullRescans).toBe(0);
    expect(r.affectedRoots).toBe(100);
    expect(r.elementsProcessed).toBe(100);
    expect(r.rulesAdded).toBe(100);
    expect(r.elementsProcessed).toBeLessThan(r.naiveElementsInspected / 50);
  });

  it('500 inserts: still one incremental pass (not 500 scans)', () => {
    const { row: r } = run(insertScenario(500));
    expect(r.analysisPasses).toBe(1);
    expect(r.incrementalPasses).toBe(1);
    expect(r.fullRescans).toBe(0);
    expect(r.elementsProcessed).toBe(500);
    expect(r.elementsProcessed).toBeLessThan(r.naiveElementsInspected / 500);
  });

  it('1000 inserts: exceeds the root budget, so exactly one controlled full rescan', () => {
    const { row: r } = run(insertScenario(1000));
    expect(r.analysisPasses).toBe(1);
    expect(r.fullRescans).toBe(1);
    expect(r.incrementalPasses).toBe(0);
    expect(r.mutationRecords).toBe(1000);
  });
});

describe('dynamic benchmark: attribute storms', () => {
  it.each([100, 500])('%i class flips on distinct rows: bounded work', (count) => {
    const { row: r } = run({
      name: `class-flips-${count}`,
      mutations: count,
      initialElements: count,
      mutate: (host) => {
        for (const child of host.children) child.className = 'alt';
      },
    });
    expect(r.analysisPasses).toBe(1);
    expect(r.batches).toBe(1); // our own stylesheet removal must not cause a second batch
    expect(r.finalRules).toBe(0); // every row became accessible
    expect(r.rulesRemoved).toBe(count);
    expect(r.elementsProcessed).toBeLessThanOrEqual(count);
  });

  it('1000 class flips on one element in one frame: one pass over one element', () => {
    const { row: r } = run({
      name: 'one-element-1000-flips',
      mutations: 1000,
      initialElements: 100,
      mutate: (host) => {
        const target = host.firstElementChild!;
        for (let i = 0; i < 1000; i += 1) target.className = i % 2 === 0 ? 'alt' : 'other';
      },
    });
    expect(r.analysisPasses).toBe(1);
    expect(r.elementsProcessed).toBe(1);
    expect(r.mutationRecords).toBe(1000);
  });
});

describe('dynamic benchmark: efficiency property', () => {
  it('one small mutation on a 1000-element page does not scan the document', () => {
    const { row: r } = run({
      name: 'single-insert-large-page',
      mutations: 1,
      initialElements: 1000,
      mutate: (host) => host.appendChild(row('only-one')),
    });
    expect(r.fullRescans).toBe(0);
    expect(r.incrementalPasses).toBe(1);
    expect(r.elementsProcessed).toBe(1);
    expect(r.pageElements).toBeGreaterThan(1000);
  });

  it('is deterministic: the same scenario yields the same counters', () => {
    const a = run(insertScenario(100)).row;
    const b = run(insertScenario(100)).row;
    expect({ ...a, wallClockMs: 0 }).toEqual({ ...b, wallClockMs: 0 });
  });
});
