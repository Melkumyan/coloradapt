/**
 * Writes `docs/validation/m10r1-runs.json`: the totals and every residual discrepancy of the final M10.R1 runs
 * (`compare-<run>.json`, produced by `compare.spec.ts`), without page content. Structural locators only.
 *
 *   node realworld/tools/summarize-runs.mjs chrome-g1 chrome-g2 firefox-g1
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const runs = process.argv.slice(2);
const out = { schema: 'coloradapt.m10r1-runs/1', runs: {} };
const keys = new Map();
for (const run of runs) {
  const compare = JSON.parse(
    readFileSync(path.join(root, 'realworld', '.artifacts', `compare-${run}.json`), 'utf8'),
  );
  const residual = compare.pages.flatMap((p) =>
    p.discrepancies.map((d) => ({
      page: p.page,
      side: d.side,
      primary: d.primary,
      code: d.code,
      tier: d.tier,
      tag: d.tag,
      locator: d.full.split('>').slice(-4).join('>'),
      note: d.note,
    })),
  );
  keys.set(
    run,
    new Set(compare.pages.flatMap((p) => p.discrepancies.map((d) => `${p.page}|${d.full}`))),
  );
  out.runs[run] = { ...compare.summary, residual };
}
const names = [...keys.keys()];
if (names.length >= 2) {
  const [a, b] = [keys.get(names[0]), keys.get(names[1])];
  out.stability = {
    compared: [names[0], names[1]],
    discrepanciesA: a.size,
    discrepanciesB: b.size,
    inBoth: [...a].filter((k) => b.has(k)).length,
  };
}
writeFileSync(
  path.join(root, 'docs', 'validation', 'm10r1-runs.json'),
  `${JSON.stringify(out, null, 1)}\n`,
);
console.log(JSON.stringify(out.stability ?? {}));
