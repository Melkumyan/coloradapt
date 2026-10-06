/**
 * Classifies every frozen M10 discrepancy (`docs/validation/m10-discrepancies.json`) against a replay crawl
 * (`RW_JUDGE_DIR`, default `chrome-r2`) and writes `docs/validation/m10r1-classification.json`: one primary
 * class, a reason code, an evidence tier and a one-line evidence per record id. The ids never change; this file
 * is the only thing that does. No browser involved.
 */
import { test, expect } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/driver';
import { classifyRecord, type Classification, type FrozenRecord } from './lib/classify';
import type { PageResult } from './lib/page-run';

// one or more replay crawls, comma separated: a page that did not load in the first (network, bot check) is read from the next
const replayNames = (process.env['RW_JUDGE_DIR'] ?? 'chrome-g1,chrome-g2').split(',');
const replayName = replayNames.join('+');
const corpusFile = path.join(ROOT, 'docs', 'validation', 'm10-discrepancies.json');
const outFile = path.join(ROOT, 'docs', 'validation', 'm10r1-classification.json');

test(`classify the frozen discrepancies against ${replayName}`, () => {
  const corpus = JSON.parse(readFileSync(corpusFile, 'utf8')) as { records: FrozenRecord[] };
  const cache = new Map<string, PageResult | null>();
  const load = (name: string, page: string): PageResult | null => {
    const key = `${name}/${page}`;
    if (!cache.has(key)) {
      const file = path.join(ROOT, 'realworld', '.artifacts', name, `${page}.json`);
      const result = existsSync(file)
        ? (JSON.parse(readFileSync(file, 'utf8')) as PageResult)
        : null;
      cache.set(key, result?.oracle?.rows.some((r) => r.trace) ? result : null);
    }
    return cache.get(key)!;
  };
  /** The first replay that still has the element; a dynamic page that changed shape falls back to an earlier one. */
  const replayOf = (record: FrozenRecord): PageResult | null => {
    let first: PageResult | null = null;
    for (const name of replayNames) {
      const result = load(name, record.page);
      if (!result) continue;
      first ??= result;
      if (record.fullPath && result.oracle?.rows.some((r) => r.full === record.fullPath))
        return result;
    }
    return first;
  };
  const results: Classification[] = corpus.records.map((r) =>
    classifyRecord(r, replayOf(r)?.oracle?.rows ?? null),
  );
  const count = (f: (c: Classification) => string) => {
    const m: Record<string, number> = {};
    for (const c of results) m[f(c)] = (m[f(c)] ?? 0) + 1;
    return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
  };
  const kindOf = new Map(corpus.records.map((r) => [r.id, r.kind]));
  const summary = {
    replay: replayName,
    total: results.length,
    byPrimary: count((c) => c.primary),
    byPrimaryAndKind: count((c) => `${kindOf.get(c.id)} ${c.primary}`),
    byCode: count((c) => `${kindOf.get(c.id)} ${c.primary} / ${c.code}`),
    byTier: count((c) => c.tier),
    fixedInR1: results.filter((c) => c.fixedInR1).length,
  };
  writeFileSync(
    outFile,
    `${JSON.stringify({ schema: 'coloradapt.m10r1-classification/1', summary, classifications: results }, null, 1)}\n`,
  );
  console.log(`CLASSIFY ${JSON.stringify(summary, null, 1)}`);
  expect(results).toHaveLength(459);
  expect(new Set(results.map((c) => c.id)).size).toBe(459);
});
