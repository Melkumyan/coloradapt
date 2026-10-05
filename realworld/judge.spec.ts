/**
 * Runs the ground-truth judge over a finished crawl (`RW_JUDGE_DIR`, default `.artifacts/<RW_BROWSER>`) and writes
 * `judge-<name>.json`: every candidate with its verdict and cause, and the totals. No browser involved.
 */
import { test } from '@playwright/test';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/driver';
import { judgePage, type Candidate } from './lib/judge';
import type { PageResult } from './lib/page-run';

const name = process.env['RW_JUDGE_DIR'] ?? process.env['RW_BROWSER'] ?? 'chrome';
const dir = path.join(ROOT, 'realworld', '.artifacts', name);

test(`judge ${name}`, () => {
  const results = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as PageResult)
    .filter((r) => r.load.loaded);
  const all: Candidate[] = [];
  const perPage: unknown[] = [];
  const totals = {
    auditContrastIssues: 0,
    oracleLowContrast: 0,
    confirmedIndependent: 0,
    manualReviewFindings: 0,
    analysisLimitationFindings: 0,
    colorVisionFindings: 0,
    pages: 0,
    truncatedGroupPages: 0,
    oracleCapPages: 0,
  };
  for (const r of results) {
    const j = judgePage(r);
    if (!j) continue;
    totals.pages++;
    totals.auditContrastIssues += j.counts.auditContrastIssues;
    totals.oracleLowContrast += j.counts.oracleLowContrast;
    totals.confirmedIndependent += j.counts.confirmedIndependent;
    totals.manualReviewFindings += j.counts.manualReviewFindings;
    totals.analysisLimitationFindings += j.counts.analysisLimitationFindings;
    totals.colorVisionFindings += j.counts.colorVisionFindings;
    if (j.counts.sampleTruncatedGroups > 0) totals.truncatedGroupPages++;
    if (j.counts.oracleCapReached) totals.oracleCapPages++;
    all.push(...j.candidates);
    perPage.push({ page: j.page, ...j.counts });
  }
  const by = (f: (c: Candidate) => string) => {
    const m = new Map<string, number>();
    for (const c of all) m.set(f(c), (m.get(f(c)) ?? 0) + 1);
    return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
  };
  const summary = {
    totals,
    byVerdict: by((c) => c.verdict),
    fpCauses: by((c) => (c.verdict === 'FALSE_POSITIVE' ? c.cause.replace(/[\d.]+/g, '#') : '')),
    fnCauses: by((c) => (c.verdict === 'FALSE_NEGATIVE' ? c.cause : '')),
    manualCauses: by((c) => (c.verdict === 'MANUAL_REVIEW' ? c.cause : '')),
    pagesWithFP: [...new Set(all.filter((c) => c.verdict === 'FALSE_POSITIVE').map((c) => c.page))],
    pagesWithFN: [...new Set(all.filter((c) => c.verdict === 'FALSE_NEGATIVE').map((c) => c.page))],
  };
  mkdirSync(path.join(ROOT, 'realworld', '.artifacts'), { recursive: true });
  writeFileSync(
    path.join(ROOT, 'realworld', '.artifacts', `judge-${name}.json`),
    JSON.stringify({ summary, perPage, candidates: all }, null, 1),
  );
  console.log(`JUDGE ${JSON.stringify(summary, null, 1)}`);
});
