#!/usr/bin/env node
/**
 * M12 (P27): compares two Knip JSON reports (`knip --reporter json`) and prints the findings that are in the
 * second and not in the first. Knip had no configuration in this repository before M12; "new findings = 0" is
 * measured against the report of the last frozen build (m11-ai-semantic-engine), run with the same defaults.
 *
 * Usage: node scripts/release/knip-diff.mjs <baseline.json> <candidate.json>
 */
import { readFileSync } from 'node:fs';

function load(path) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const out = new Set();
  for (const item of data.issues ?? []) {
    const file = String(item.file).replaceAll('\\', '/');
    for (const [kind, value] of Object.entries(item)) {
      if (kind === 'file' || !Array.isArray(value)) continue;
      for (const entry of value)
        out.add(
          `${file} | ${kind} | ${typeof entry === 'object' && entry !== null ? entry.name : String(entry)}`,
        );
    }
  }
  for (const f of Array.isArray(data.files) ? data.files : [])
    out.add(`${String(f).replaceAll('\\', '/')} | files | `);
  return out;
}

const [basePath, candPath] = process.argv.slice(2);
const base = load(basePath);
const cand = load(candPath);
const added = [...cand].filter((x) => !base.has(x)).sort();
const gone = [...base].filter((x) => !cand.has(x)).sort();
const byKind = (set) => {
  const counts = {};
  for (const line of set) counts[line.split(' | ')[1]] = (counts[line.split(' | ')[1]] ?? 0) + 1;
  return counts;
};
console.log(`baseline findings: ${base.size} ${JSON.stringify(byKind(base))}`);
console.log(`candidate findings: ${cand.size} ${JSON.stringify(byKind(cand))}`);
console.log(`NEW findings in the candidate: ${added.length}`);
for (const line of added) console.log(`  + ${line}`);
console.log(`findings of the baseline that are gone: ${gone.length}`);
for (const line of gone) console.log(`  - ${line}`);
process.exit(added.length === 0 ? 0 : 1);
