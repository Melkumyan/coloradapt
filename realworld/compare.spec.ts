/**
 * The M10.R1 comparison over a finished crawl (`RW_JUDGE_DIR`, default `RW_BROWSER`): for every comparable page,
 * every oracle row against ColorAdapt's own decision, with each disagreement classified (`lib/compare.ts`).
 * Writes `.artifacts/compare-<dir>.json` and prints the totals. No browser involved.
 *
 * Only comparable pages enter the denominator: loaded, audited, oracle completed, and the document did not
 * replace itself while it was measured. Pages that did not load (network, bot protection, geography, rate
 * limit) are counted separately; they are not audit failures.
 */
import { test } from '@playwright/test';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/driver';
import { comparePage, type PageComparison } from './lib/compare';
import { displayKey } from './lib/judge';
import type { PageResult } from './lib/page-run';

const name = process.env['RW_JUDGE_DIR'] ?? process.env['RW_BROWSER'] ?? 'chrome';
const dir = path.join(ROOT, 'realworld', '.artifacts', name);

const bump = (map: Record<string, number>, key: string, by = 1) => {
  map[key] = (map[key] ?? 0) + by;
};

test(`compare ${name}`, () => {
  const results = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as PageResult);
  const funnel = {
    attempted: results.length,
    loaded: 0,
    audited: 0,
    oracleCompleted: 0,
    comparable: 0,
  };
  const notLoaded: Record<string, number> = {};
  const staleDocument: string[] = [];
  const pages: PageComparison[] = [];
  const crossCheck = {
    tracedReported: 0,
    listedByAudit: 0,
    notListedGroupsTruncated: 0,
    notListedOther: 0,
  };
  const notListedExamples: string[] = [];

  for (const r of results) {
    if (!r.load.loaded) {
      bump(notLoaded, r.load.error?.split(':')[0]?.slice(0, 60) ?? 'unknown');
      continue;
    }
    funnel.loaded++;
    if (!r.auditOff?.ok) continue;
    funnel.audited++;
    if (!r.oracle) continue;
    funnel.oracleCompleted++;
    if (r.documentStable === false) {
      staleDocument.push(r.id);
      continue;
    }
    funnel.comparable++;
    const page = comparePage(r.id, r.oracle.rows);
    pages.push(page);

    // does the audit list what the trace says it reports? (a consistency check of trace vs audit output)
    const printed = new Set<string>();
    let truncated = false;
    for (const g of r.auditOff.findings) {
      if (g.rule !== 'CA-COLOR-001') continue;
      if (g.count > g.sample.length) truncated = true;
      for (const e of g.sample) printed.add(e.path);
    }
    for (const row of r.oracle.rows) {
      if (!row.trace?.reported || row.chars === 0 || row.flags.split(',').includes('svg')) continue;
      crossCheck.tracedReported++;
      if (printed.has(displayKey(row.path))) crossCheck.listedByAudit++;
      else if (truncated) crossCheck.notListedGroupsTruncated++;
      else {
        crossCheck.notListedOther++;
        if (notListedExamples.length < 15)
          notListedExamples.push(`${r.id} ${row.tag} ${row.full.slice(-80)}`);
      }
    }
  }

  const totals = {
    pages: pages.length,
    rowsInScope: 0,
    renderedRows: 0,
    oracleLow: 0,
    productReported: 0,
    agreeLow: 0,
    borderline: 0,
    falsePositives: 0,
    falseNegatives: 0,
  };
  const byClass: Record<string, number> = {};
  const byCode: Record<string, number> = {};
  const byTier: Record<string, number> = {};
  const sites: Record<string, { fp: number; fn: number; product: number; ambiguous: number }> = {};
  for (const p of pages) {
    totals.rowsInScope += p.rowsInScope;
    totals.renderedRows += p.renderedRows;
    totals.oracleLow += p.oracleLow;
    totals.productReported += p.productReported;
    totals.agreeLow += p.agreeLow;
    totals.borderline += p.borderline;
    for (const d of p.discrepancies) {
      if (d.side === 'FALSE_POSITIVE') totals.falsePositives++;
      else totals.falseNegatives++;
      bump(byClass, `${d.side} ${d.primary}`);
      bump(byCode, `${d.side} ${d.primary} / ${d.code}`);
      bump(byTier, d.tier);
      const s = (sites[p.page] ??= { fp: 0, fn: 0, product: 0, ambiguous: 0 });
      if (d.side === 'FALSE_POSITIVE') s.fp++;
      else s.fn++;
      if (d.primary === 'PRODUCT_BUG') s.product++;
      if (d.primary === 'AMBIGUOUS') s.ambiguous++;
    }
  }
  const sorted = (m: Record<string, number>) =>
    Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
  const top = (key: 'fp' | 'fn' | 'product' | 'ambiguous') =>
    Object.entries(sites)
      .filter(([, v]) => v[key] > 0)
      .sort((a, b) => b[1][key] - a[1][key])
      .slice(0, 8)
      .map(([page, v]) => `${page}: ${v[key]}`);
  const summary = {
    funnel,
    notLoaded,
    staleDocument,
    totals,
    byClass: sorted(byClass),
    byCode: sorted(byCode),
    byTier,
    crossCheck,
    notListedExamples,
    topSites: {
      falsePositives: top('fp'),
      falseNegatives: top('fn'),
      productBugs: top('product'),
      ambiguous: top('ambiguous'),
    },
  };
  writeFileSync(
    path.join(ROOT, 'realworld', '.artifacts', `compare-${name}.json`),
    JSON.stringify({ summary, pages }, null, 1),
  );
  console.log(`COMPARE ${JSON.stringify(summary, null, 1)}`);
});
