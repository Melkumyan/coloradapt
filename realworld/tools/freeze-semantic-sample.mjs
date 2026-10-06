// Freezes the packets recorded by realworld/semantic-sample.spec.ts into tests/fixtures/semantic-ai/realworld-packets.json.
// One entry per distinct packet per page (a page with 48 identical chart bars is one case with count 48).
// Packets are already sanitized by the product (bounded, redacted, no form values, no URLs).
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const from = path.join(root, 'realworld', '.artifacts', 'semantic-sample');
const out = path.join(root, 'tests', 'fixtures', 'semantic-ai');
mkdirSync(out, { recursive: true });

const cases = [];
const pages = [];
for (const name of readdirSync(from).sort()) {
  if (!name.endsWith('.json')) continue;
  const page = JSON.parse(readFileSync(path.join(from, name), 'utf8'));
  if (!page.loaded) continue;
  pages.push(page.id);
  const seen = new Map();
  for (const item of page.cases) {
    const query = item.bound.query;
    const key = `${page.id}|${query.context.ruleIds[0]}|${item.bound.inputHash}`;
    const earlier = seen.get(key);
    if (earlier) {
      earlier.count += 1;
      continue;
    }
    const entry = {
      key,
      page: page.id,
      category: page.category,
      script: page.script,
      rule: query.context.ruleIds[0],
      task: item.task,
      inputHash: item.bound.inputHash,
      count: 1,
      query,
    };
    seen.set(key, entry);
    cases.push(entry);
  }
}
const frozen = {
  note:
    'Packets exactly as the AI-assisted review builds them from live pages of the M10 corpus (Chrome 154, deuteranopia audit, adaptation off). ' +
    'They are bounded and redacted by the product; no model was involved in recording them. See docs/AI_SEMANTIC_ENGINE.md.',
  pages: pages.length,
  cases,
};
writeFileSync(path.join(out, 'realworld-packets.json'), `${JSON.stringify(frozen, null, 1)}\n`);
process.stdout.write(`${pages.length} pages, ${cases.length} distinct packets\n`);
