/**
 * Freezes the M10 contrast discrepancies (FALSE_POSITIVE / FALSE_NEGATIVE of `judge-chrome.json`) into the
 * machine-readable regression corpus `docs/validation/m10-discrepancies.json` with stable ids
 * (RW-FP-0001.., RW-FN-0001..). The ids are assigned once, by (page, locator) order, and are never reassigned:
 * running this again refuses to overwrite an existing corpus.
 *
 *   node realworld/tools/freeze-discrepancies.mjs
 *
 * Only structural data is kept: sanitized origin + pathname, the printed structural locator, tag, colors the
 * audit printed, the oracle's numbers. No query, hash, form value, text content or HTML.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const artifacts = path.join(root, 'realworld', '.artifacts');
const out = path.join(root, 'docs', 'validation', 'm10-discrepancies.json');
if (existsSync(out)) {
  console.error('refusing to overwrite the frozen corpus');
  process.exit(1);
}

const judge = JSON.parse(readFileSync(path.join(artifacts, 'judge-chrome.json'), 'utf8'));
const pages = new Map();
const page = (id) => {
  if (!pages.has(id)) {
    pages.set(id, JSON.parse(readFileSync(path.join(artifacts, 'chrome', `${id}.json`), 'utf8')));
  }
  return pages.get(id);
};
const display = (p) => {
  const s = p.split('>');
  return s.length > 6 ? `…>${s.slice(-6).join('>')}` : p;
};
const byOrder = (a, b) =>
  a.page + a.path < b.page + b.path ? -1 : a.page + a.path > b.page + b.path ? 1 : 0;

const records = [];
const take = (verdict, prefix) => {
  const list = judge.candidates.filter((c) => c.verdict === verdict).sort(byOrder);
  list.forEach((c, i) => {
    const run = page(c.page);
    const rows = run.oracle.rows.filter((r) => display(r.path) === display(c.path));
    const row = rows.find((r) => r.path === c.path) ?? rows[0] ?? null;
    let pair = null;
    for (const f of run.auditOff.findings) {
      const hit = f.sample.find((s) => s.path === display(c.path));
      if (hit && f.rule === 'CA-COLOR-001') pair = hit.pair ? JSON.parse(hit.pair) : null;
    }
    const flags = row ? row.flags.split(',').filter(Boolean) : [];
    records.push({
      id: `${prefix}-${String(i + 1).padStart(4, '0')}`,
      kind: prefix === 'RW-FP' ? 'FALSE_POSITIVE' : 'FALSE_NEGATIVE',
      page: c.page,
      browser: run.browser,
      browserVersion: run.browserVersion,
      runAt: run.ranAt,
      origin: run.auditOff.origin,
      pathname: run.auditOff.pathname,
      locator: display(c.path),
      fullPath: row ? row.full : null,
      tag: row ? row.tag : null,
      sharedLocatorCount: rows.length,
      colorAdapt:
        prefix === 'RW-FP'
          ? {
              reported: true,
              rule: 'CA-COLOR-001',
              ratio: c.auditRatio,
              foreground: pair?.foreground ?? null,
              background: pair?.background ?? null,
            }
          : { reported: false },
      oracle: row
        ? { status: row.status, ratio: row.ratio, target: row.target, flags, chars: row.chars }
        : null,
      largeText: row ? row.target === 3 : null,
      visibility:
        flags.find((f) => f.startsWith('hidden')) ??
        (flags.includes('offscreen') ? 'offscreen' : 'visible'),
      // not captured by the M10 probe; filled by the M10.R1 enrichment run (enrichment.json)
      fontSizePx: null,
      fontWeight: null,
      opacity: null,
      reason: c.cause,
      classification: null,
    });
  });
};
take('FALSE_POSITIVE', 'RW-FP');
take('FALSE_NEGATIVE', 'RW-FN');

mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify(
    {
      schema: 'coloradapt.m10-discrepancies/1',
      baseline: { commit: '8a83212', tag: 'm10-real-world-validation' },
      note: 'Frozen M10 baseline. ids never change; classification lives in m10r1-classification.json',
      counts: {
        falsePositives: records.filter((r) => r.kind === 'FALSE_POSITIVE').length,
        falseNegatives: records.filter((r) => r.kind === 'FALSE_NEGATIVE').length,
      },
      records,
    },
    null,
    1,
  ) + '\n',
);
console.log(`frozen ${records.length} records`);
