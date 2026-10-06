/**
 * M11 real-world semantic sample: opens corpus pages whose M10 audit left manual-review findings,
 * runs the audit and asks the extension for the AI-assisted review's packets (`AUDIT_SEMANTIC_CASES`).
 * Read-only. No model is involved: it records the sanitized packets exactly as a provider would
 * receive them, into `realworld/.artifacts/semantic-sample/<id>.json` (git-ignored); `freeze` turns those
 * into `tests/fixtures/semantic-ai/realworld-packets.json`.
 *
 * `RW_BROWSER=firefox` records into `semantic-sample-firefox/` (a smoke test of the content side only: the AI runtime is not
 * verified in Firefox). `RW_SEMANTIC_IDS` (comma-separated corpus ids) restricts the run; by default every page whose
 * recorded M10 audit holds an eligible manual-review finding is visited.
 */
import { test } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CORPUS } from './corpus';
import { startBrowser, type BrowserName } from './lib/driver';
import { ON_SETTINGS, sleep } from './lib/page-run';
import { ROOT } from './lib/driver';

const ELIGIBLE = [
  'CA-SEM-002',
  'CA-SVG-002',
  'CA-CHART-002',
  'CA-CHART-003',
  'CA-CHART-004',
  'CA-IMG-002',
  'CA-IMG-003',
];
const BROWSER = (process.env['RW_BROWSER'] ?? 'chrome') as BrowserName;
const OUT = path.join(
  ROOT,
  'realworld',
  '.artifacts',
  process.env['RW_SEMANTIC_OUT'] ??
    (BROWSER === 'chrome' ? 'semantic-sample' : `semantic-sample-${BROWSER}`),
);

function candidates(): string[] {
  const only = process.env['RW_SEMANTIC_IDS'];
  if (only) return only.split(',');
  const dir = path.join(ROOT, 'realworld', '.artifacts', 'chrome');
  const ids: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const result = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as {
      id: string;
      auditOff?: { findings?: { rule?: string; assessment?: string }[] };
    };
    const found = (result.auditOff?.findings ?? []).some(
      (f) => f.assessment === 'manual-review' && ELIGIBLE.includes(f.rule ?? ''),
    );
    if (found) ids.push(result.id);
  }
  return ids.sort();
}

test('record the semantic packets of real pages', async () => {
  test.setTimeout(3 * 60 * 60 * 1000);
  mkdirSync(OUT, { recursive: true });
  const driver = await startBrowser(BROWSER);
  try {
    await driver.setSettings({ ...ON_SETTINGS, enabled: false });
    for (const id of candidates()) {
      const file = path.join(OUT, `${id}.json`);
      if (existsSync(file) && !process.env['RW_FORCE']) continue;
      const entry = CORPUS.find((e) => e.id === id);
      if (!entry) continue;
      const tab = await driver.newTab();
      try {
        const opened = await tab.open(entry.url);
        if (!opened.loaded) {
          writeFileSync(file, JSON.stringify({ id, loaded: false, error: opened.error }, null, 1));
          continue;
        }
        await sleep(6000);
        const snapshot = await tab.ext<{
          generation: number;
          findings: { id: string; ruleId: string; assessment: string }[];
        }>('AUDIT_RUN', { scope: 'auto' });
        const response = await tab.ext<{
          eligible: number;
          cases: unknown[];
          heterogeneous?: string[];
        }>('AUDIT_SEMANTIC_CASES', {
          includeIds: [],
        });
        writeFileSync(
          file,
          JSON.stringify(
            {
              id,
              loaded: true,
              category: entry.category,
              script: entry.script,
              findings: snapshot.findings.map((f) => `${f.ruleId}:${f.assessment}`),
              eligible: response.eligible,
              heterogeneous: response.heterogeneous ?? [],
              cases: response.cases,
            },
            null,
            1,
          ),
        );
      } catch (error) {
        writeFileSync(file, JSON.stringify({ id, loaded: false, error: String(error) }, null, 1));
      } finally {
        await tab.close().catch(() => undefined);
      }
    }
  } finally {
    await driver.close();
  }
});
